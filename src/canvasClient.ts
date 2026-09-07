import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

export interface CanvasClientConfig {
  domain: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface Course {
  id: number;
  name: string;
  course_code: string;
}

export interface Assignment {
  id: number;
  name: string;
  due_at: string | null;
  submission?: {
    workflow_state: string;
    submitted_at: string | null;
  };
}

export interface Enrollment {
  course_id: number;
  grades: {
    current_score: number | null;
    current_grade: string | null;
  };
}

export interface DiscussionTopic {
  id: number;
  title: string;
}

export type SubmissionInput = { text: string } | { url: string } | { filePath: string };

export class CanvasApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "CanvasApiError";
  }
}

function mapErrorMessage(status: number, body: string): string {
  switch (status) {
    case 401:
      return "Canvas rejected the API token — check CANVAS_API_TOKEN.";
    case 403:
      return "Canvas denied permission for this action.";
    case 404:
      return "Canvas couldn't find that (check the course/assignment id).";
    case 429:
      return "Canvas is rate-limiting requests — try again shortly.";
    default:
      return `Canvas API error ${status}: ${body.slice(0, 200)}`;
  }
}

export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export class CanvasClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(config: CanvasClientConfig) {
    this.baseUrl = `https://${config.domain}/api/v1`;
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async requestPage<T>(url: string, init: RequestInit = {}): Promise<{ data: T; nextUrl: string | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new CanvasApiError(0, `Could not reach Canvas: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CanvasApiError(res.status, mapErrorMessage(res.status, body));
    }

    let data: T;
    try {
      data = (await res.json()) as T;
    } catch (err) {
      throw new CanvasApiError(res.status, "Canvas returned an unexpected (non-JSON) response.");
    }

    const nextUrl = parseNextLink(res.headers.get("Link"));
    return { data, nextUrl };
  }

  protected async requestOne<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { data } = await this.requestPage<T>(`${this.baseUrl}${path}`, init);
    return data;
  }

  protected async requestAllPages<T>(path: string, init: RequestInit = {}): Promise<T[]> {
    let url: string | null = `${this.baseUrl}${path}`;
    const results: T[] = [];
    while (url) {
      const response: { data: T[]; nextUrl: string | null } = await this.requestPage<T[]>(url, init);
      const { data } = response;
      const { nextUrl } = response;
      results.push(...data);
      url = nextUrl;
    }
    return results;
  }

  async listCourses(): Promise<Course[]> {
    return this.requestAllPages<Course>("/courses?enrollment_state=active");
  }

  async listAssignments(courseId: number): Promise<Assignment[]> {
    return this.requestAllPages<Assignment>(`/courses/${courseId}/assignments?include[]=submission`);
  }

  async getAssignment(courseId: number, assignmentId: number): Promise<Assignment> {
    return this.requestOne<Assignment>(`/courses/${courseId}/assignments/${assignmentId}?include[]=submission`);
  }

  async listGrades(courseId?: number): Promise<Enrollment[]> {
    const all = await this.requestAllPages<Enrollment>("/users/self/enrollments?type[]=StudentEnrollment");
    return courseId === undefined ? all : all.filter((e) => e.course_id === courseId);
  }

  protected async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestOne<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async listDiscussionTopics(courseId: number): Promise<DiscussionTopic[]> {
    return this.requestAllPages<DiscussionTopic>(`/courses/${courseId}/discussion_topics`);
  }

  async postDiscussionReply(courseId: number, topicId: number, message: string): Promise<{ id: number }> {
    return this.postJson(`/courses/${courseId}/discussion_topics/${topicId}/entries`, { message });
  }

  private async uploadFile(courseId: number, assignmentId: number, filePath: string): Promise<number> {
    const name = basename(filePath);
    const size = statSync(filePath).size;

    const { upload_url, upload_params } = await this.postJson<{
      upload_url: string;
      upload_params: Record<string, string>;
    }>(`/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`, {
      name,
      size,
    });

    const form = new FormData();
    for (const [key, value] of Object.entries(upload_params)) {
      form.append(key, value);
    }
    form.append("file", new Blob([readFileSync(filePath)]), name);

    const res = await this.fetchImpl(upload_url, { method: "POST", body: form });
    if (!res.ok) {
      throw new CanvasApiError(res.status, `File upload to Canvas failed with status ${res.status}`);
    }
    const uploaded = (await res.json()) as { id: number };
    return uploaded.id;
  }

  async submitAssignment(
    courseId: number,
    assignmentId: number,
    submission: SubmissionInput
  ): Promise<{ id: number }> {
    const path = `/courses/${courseId}/assignments/${assignmentId}/submissions`;

    if ("text" in submission) {
      return this.postJson(path, { submission: { submission_type: "online_text_entry", body: submission.text } });
    }
    if ("url" in submission) {
      return this.postJson(path, { submission: { submission_type: "online_url", url: submission.url } });
    }
    const fileId = await this.uploadFile(courseId, assignmentId, submission.filePath);
    return this.postJson(path, { submission: { submission_type: "online_upload", file_ids: [fileId] } });
  }

  async addSubmissionComment(courseId: number, assignmentId: number, comment: string): Promise<{ id: number }> {
    return this.requestOne(`/courses/${courseId}/assignments/${assignmentId}/submissions/self`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment: { text_comment: comment } }),
    });
  }
}
