import { describe, it, expect, vi } from "vitest";
import { CanvasClient, CanvasApiError, parseNextLink } from "./canvasClient.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function jsonResponse(body: unknown, init: { status?: number; link?: string } = {}) {
  const headers = new Headers();
  if (init.link) headers.set("Link", init.link);
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

describe("parseNextLink", () => {
  it("extracts the next-page URL from a Link header", () => {
    const link = '<https://school.instructure.com/api/v1/courses?page=2>; rel="next", <https://school.instructure.com/api/v1/courses?page=5>; rel="last"';
    expect(parseNextLink(link)).toBe("https://school.instructure.com/api/v1/courses?page=2");
  });

  it("returns null when there is no next link", () => {
    const link = '<https://school.instructure.com/api/v1/courses?page=5>; rel="last"';
    expect(parseNextLink(link)).toBeNull();
  });

  it("returns null for a null header", () => {
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("CanvasClient.listCourses", () => {
  it("sends a bearer token and returns parsed courses", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://school.instructure.com/api/v1/courses?enrollment_state=active");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      return jsonResponse([{ id: 1, name: "Biology 101", course_code: "BIO101" }]);
    }) as typeof fetch;

    const client = new CanvasClient({ domain: "school.instructure.com", token: "test-token", fetchImpl });
    const courses = await client.listCourses();

    expect(courses).toEqual([{ id: 1, name: "Biology 101", course_code: "BIO101" }]);
  });

  it("follows pagination via the Link header", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse([{ id: 1, name: "Biology 101", course_code: "BIO101" }], {
          link: '<https://school.instructure.com/api/v1/courses?page=2>; rel="next"',
        });
      }
      return jsonResponse([{ id: 2, name: "Chemistry 201", course_code: "CHEM201" }]);
    }) as typeof fetch;

    const client = new CanvasClient({ domain: "school.instructure.com", token: "test-token", fetchImpl });
    const courses = await client.listCourses();

    expect(courses).toHaveLength(2);
    expect(courses.map((c) => c.id)).toEqual([1, 2]);
  });

  it("throws a readable CanvasApiError on a 401", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unauthorized", { status: 401 })) as typeof fetch;
    const client = new CanvasClient({ domain: "school.instructure.com", token: "bad-token", fetchImpl });

    await expect(client.listCourses()).rejects.toThrow(CanvasApiError);
    await expect(client.listCourses()).rejects.toThrow(/token/i);
  });

  it("throws a readable CanvasApiError on a 429", async () => {
    const fetchImpl = vi.fn(async () => new Response("Rate limited", { status: 429 })) as typeof fetch;
    const client = new CanvasClient({ domain: "school.instructure.com", token: "test-token", fetchImpl });

    await expect(client.listCourses()).rejects.toThrow(/rate.?limit/i);
  });

  it("throws a CanvasApiError when fetchImpl rejects (network failure)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Network timeout");
    }) as typeof fetch;
    const client = new CanvasClient({ domain: "school.instructure.com", token: "test-token", fetchImpl });

    await expect(client.listCourses()).rejects.toThrow(CanvasApiError);
    await expect(client.listCourses()).rejects.toThrow(/Could not reach Canvas/i);
  });

  it("throws a CanvasApiError when response body is not valid JSON", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("Not JSON at all", { status: 200 });
    }) as typeof fetch;
    const client = new CanvasClient({ domain: "school.instructure.com", token: "test-token", fetchImpl });

    await expect(client.listCourses()).rejects.toThrow(CanvasApiError);
    await expect(client.listCourses()).rejects.toThrow(/unexpected.*response/i);
  });
});

describe("CanvasClient.listAssignments", () => {
  it("requests assignments with submission info included", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://school.instructure.com/api/v1/courses/10/assignments?include[]=submission"
      );
      return jsonResponse([
        { id: 100, name: "Essay 1", due_at: "2026-09-10T23:59:00Z", submission: { workflow_state: "unsubmitted", submitted_at: null } },
      ]);
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const assignments = await client.listAssignments(10);

    expect(assignments).toHaveLength(1);
    expect(assignments[0].name).toBe("Essay 1");
  });
});

describe("CanvasClient.getAssignment", () => {
  it("fetches a single assignment by id", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://school.instructure.com/api/v1/courses/10/assignments/100?include[]=submission"
      );
      return jsonResponse({ id: 100, name: "Essay 1", due_at: "2026-09-10T23:59:00Z" });
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const assignment = await client.getAssignment(10, 100);

    expect(assignment.id).toBe(100);
  });
});

describe("CanvasClient.listGrades", () => {
  it("returns grades for all enrolled courses when no courseId is given", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://school.instructure.com/api/v1/users/self/enrollments?type[]=StudentEnrollment"
      );
      return jsonResponse([
        { course_id: 10, grades: { current_score: 92, current_grade: "A-" } },
        { course_id: 20, grades: { current_score: 78, current_grade: "C+" } },
      ]);
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const grades = await client.listGrades();

    expect(grades).toHaveLength(2);
  });

  it("filters to one course when courseId is given", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        { course_id: 10, grades: { current_score: 92, current_grade: "A-" } },
        { course_id: 20, grades: { current_score: 78, current_grade: "C+" } },
      ])
    );

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const grades = await client.listGrades(10);

    expect(grades).toEqual([{ course_id: 10, grades: { current_score: 92, current_grade: "A-" } }]);
  });
});

describe("CanvasClient.listDiscussionTopics", () => {
  it("lists discussion topics for a course", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://school.instructure.com/api/v1/courses/10/discussion_topics");
      return jsonResponse([{ id: 500, title: "Week 1 Discussion" }]);
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const topics = await client.listDiscussionTopics(10);

    expect(topics[0].title).toBe("Week 1 Discussion");
  });
});

describe("CanvasClient.postDiscussionReply", () => {
  it("POSTs a message to the topic's entries endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://school.instructure.com/api/v1/courses/10/discussion_topics/500/entries");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ message: "Great point!" });
      return jsonResponse({ id: 9001 });
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const reply = await client.postDiscussionReply(10, 500, "Great point!");

    expect(reply.id).toBe(9001);
  });
});

describe("CanvasClient.submitAssignment", () => {
  it("submits a text entry", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://school.instructure.com/api/v1/courses/10/assignments/100/submissions");
      expect(JSON.parse(init?.body as string)).toEqual({
        submission: { submission_type: "online_text_entry", body: "My essay text" },
      });
      return jsonResponse({ id: 7001 });
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const result = await client.submitAssignment(10, 100, { text: "My essay text" });

    expect(result.id).toBe(7001);
  });

  it("submits a URL", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({
        submission: { submission_type: "online_url", url: "https://example.com/project" },
      });
      return jsonResponse({ id: 7002 });
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const result = await client.submitAssignment(10, 100, { url: "https://example.com/project" });

    expect(result.id).toBe(7002);
  });

  it("submits a file via the three-step Canvas upload flow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-test-"));
    const filePath = join(dir, "essay.txt");
    writeFileSync(filePath, "file contents");

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === "https://school.instructure.com/api/v1/courses/10/assignments/100/submissions/self/files") {
        const body = JSON.parse(init?.body as string);
        expect(body.name).toBe("essay.txt");
        return jsonResponse({
          upload_url: "https://upload.example.com/put",
          upload_params: { key: "abc", policy: "xyz" },
        });
      }
      if (url === "https://upload.example.com/put") {
        return jsonResponse({ id: 555 });
      }
      if (url === "https://school.instructure.com/api/v1/courses/10/assignments/100/submissions") {
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({
          submission: { submission_type: "online_upload", file_ids: [555] },
        });
        return jsonResponse({ id: 7003 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const result = await client.submitAssignment(10, 100, { filePath });

    expect(result.id).toBe(7003);
    expect(calls).toHaveLength(3);
  });

  it("throws CanvasApiError when file upload endpoint is unreachable (network failure)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-test-"));
    const filePath = join(dir, "essay.txt");
    writeFileSync(filePath, "file contents");

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://school.instructure.com/api/v1/courses/10/assignments/100/submissions/self/files") {
        return jsonResponse({
          upload_url: "https://upload.example.com/put",
          upload_params: { key: "abc", policy: "xyz" },
        });
      }
      if (url === "https://upload.example.com/put") {
        throw new Error("Network timeout");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });

    await expect(client.submitAssignment(10, 100, { filePath })).rejects.toThrow(CanvasApiError);
    await expect(client.submitAssignment(10, 100, { filePath })).rejects.toThrow(/Could not reach the Canvas file upload endpoint/i);
  });

  it("throws CanvasApiError when file upload endpoint returns non-JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-test-"));
    const filePath = join(dir, "essay.txt");
    writeFileSync(filePath, "file contents");

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://school.instructure.com/api/v1/courses/10/assignments/100/submissions/self/files") {
        return jsonResponse({
          upload_url: "https://upload.example.com/put",
          upload_params: { key: "abc", policy: "xyz" },
        });
      }
      if (url === "https://upload.example.com/put") {
        return new Response("Not JSON at all", { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });

    await expect(client.submitAssignment(10, 100, { filePath })).rejects.toThrow(CanvasApiError);
    await expect(client.submitAssignment(10, 100, { filePath })).rejects.toThrow(/unexpected.*response/i);
  });
});

describe("CanvasClient.addSubmissionComment", () => {
  it("PUTs a comment onto the user's own submission", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://school.instructure.com/api/v1/courses/10/assignments/100/submissions/self");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init?.body as string)).toEqual({ comment: { text_comment: "Sorry this is late!" } });
      return jsonResponse({ id: 8001 });
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const result = await client.addSubmissionComment(10, 100, "Sorry this is late!");

    expect(result.id).toBe(8001);
  });
});
