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
}
