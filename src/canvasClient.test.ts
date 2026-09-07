import { describe, it, expect, vi } from "vitest";
import { CanvasClient, CanvasApiError, parseNextLink } from "./canvasClient.js";

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
