import { describe, it, expect, vi } from "vitest";
import { buildServer } from "./server.js";
import { CanvasApiError } from "../canvasClient.js";
import type { CanvasClient } from "../canvasClient.js";

function fakeClient(overrides: Partial<CanvasClient> = {}): CanvasClient {
  return overrides as CanvasClient;
}

async function callTool(server: ReturnType<typeof buildServer>, name: string, args: Record<string, unknown>) {
  // registerTool stores handlers internally; the SDK exposes them for direct invocation in tests
  // via server's internal request handling. We call the handler we captured at registration time.
  const handler = (server as any)._testHandlers[name];
  if (!handler) throw new Error(`No handler registered for tool ${name}`);
  return handler(args);
}

describe("list_courses tool", () => {
  it("returns course names as text", async () => {
    const client = fakeClient({
      listCourses: vi.fn(async () => [{ id: 1, name: "Biology 101", course_code: "BIO101" }]),
    });
    const server = buildServer(client);

    const result = await callTool(server, "list_courses", {});

    expect(result.content[0].text).toContain("Biology 101");
  });

  it("propagates a CanvasApiError from the client rather than swallowing or mangling it", async () => {
    const apiError = new CanvasApiError(401, "Canvas rejected the API token — check CANVAS_API_TOKEN.");
    const client = fakeClient({
      listCourses: vi.fn(async () => {
        throw apiError;
      }),
    });
    const server = buildServer(client);

    await expect(callTool(server, "list_courses", {})).rejects.toBe(apiError);
    await expect(callTool(server, "list_courses", {})).rejects.toThrow(CanvasApiError);
    await expect(callTool(server, "list_courses", {})).rejects.toThrow(/token/i);
  });
});

describe("buildServer tool registration", () => {
  it("registers exactly the 9 expected tools (6 read + 3 write)", () => {
    const client = fakeClient({});
    const server = buildServer(client);

    const registered = Object.keys((server as any)._testHandlers).sort();
    const expected = [
      "list_courses",
      "list_assignments",
      "get_assignment",
      "list_grades",
      "list_discussion_topics",
      "list_calendar_events",
      "submit_assignment",
      "post_discussion_reply",
      "add_submission_comment",
    ].sort();

    expect(registered).toEqual(expected);
  });
});

describe("list_assignments tool", () => {
  it("passes course_id through to the client", async () => {
    const listAssignments = vi.fn(async () => [
      { id: 100, name: "Essay 1", due_at: "2026-09-10T23:59:00Z" },
    ]);
    const client = fakeClient({ listAssignments });
    const server = buildServer(client);

    const result = await callTool(server, "list_assignments", { course_id: 10 });

    expect(listAssignments).toHaveBeenCalledWith(10);
    expect(result.content[0].text).toContain("Essay 1");
  });
});

describe("get_assignment tool", () => {
  it("returns assignment name and due date", async () => {
    const getAssignment = vi.fn(async () => ({
      id: 5,
      name: "Midterm",
      due_at: "2026-10-01T23:59:00Z",
    }));
    const client = fakeClient({ getAssignment });
    const server = buildServer(client);

    const result = await callTool(server, "get_assignment", { course_id: 10, assignment_id: 5 });

    expect(getAssignment).toHaveBeenCalledWith(10, 5);
    expect(result.content[0].text).toContain("Midterm");
  });
});

describe("list_grades tool", () => {
  it("returns formatted grades", async () => {
    const listGrades = vi.fn(async () => [
      { course_id: 10, grades: { current_grade: "A", current_score: 95 } },
    ]);
    const client = fakeClient({ listGrades });
    const server = buildServer(client);

    const result = await callTool(server, "list_grades", { course_id: 10 });

    expect(listGrades).toHaveBeenCalledWith(10);
    expect(result.content[0].text).toContain("A");
  });
});

describe("list_discussion_topics tool", () => {
  it("returns discussion topic titles", async () => {
    const listDiscussionTopics = vi.fn(async () => [{ id: 1, title: "Week 1 Discussion" }]);
    const client = fakeClient({ listDiscussionTopics });
    const server = buildServer(client);

    const result = await callTool(server, "list_discussion_topics", { course_id: 10 });

    expect(listDiscussionTopics).toHaveBeenCalledWith(10);
    expect(result.content[0].text).toContain("Week 1 Discussion");
  });
});

describe("list_calendar_events tool", () => {
  it("passes start_date and end_date through to the client", async () => {
    const listCalendarEvents = vi.fn(async () => [
      { id: 1, title: "Office Hours", start_at: "2026-09-10T15:00:00Z", end_at: null },
    ]);
    const client = fakeClient({ listCalendarEvents });
    const server = buildServer(client);

    const result = await callTool(server, "list_calendar_events", {
      start_date: "2026-09-01",
      end_date: "2026-09-30",
    });

    expect(listCalendarEvents).toHaveBeenCalledWith("2026-09-01", "2026-09-30");
    expect(result.content[0].text).toContain("Office Hours");
  });
});

describe("submit_assignment tool", () => {
  it("previews instead of submitting when confirm is not true", async () => {
    const submitAssignment = vi.fn();
    const client = fakeClient({ submitAssignment });
    const server = buildServer(client);

    const result = await callTool(server, "submit_assignment", {
      course_id: 10,
      assignment_id: 100,
      text: "My essay",
    });

    expect(submitAssignment).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/confirm/i);
  });

  it("submits when confirm is true", async () => {
    const submitAssignment = vi.fn(async () => ({ id: 7001 }));
    const client = fakeClient({ submitAssignment });
    const server = buildServer(client);

    const result = await callTool(server, "submit_assignment", {
      course_id: 10,
      assignment_id: 100,
      text: "My essay",
      confirm: true,
    });

    expect(submitAssignment).toHaveBeenCalledWith(10, 100, { text: "My essay" });
    expect(result.content[0].text).toContain("7001");
  });

  it("does not submit when confirm is explicitly false", async () => {
    const submitAssignment = vi.fn();
    const client = fakeClient({ submitAssignment });
    const server = buildServer(client);

    const result = await callTool(server, "submit_assignment", {
      course_id: 10,
      assignment_id: 100,
      text: "My essay",
      confirm: false,
    });

    expect(submitAssignment).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/confirm/i);
  });

  it("submits a url when confirmed", async () => {
    const submitAssignment = vi.fn(async () => ({ id: 7002 }));
    const client = fakeClient({ submitAssignment });
    const server = buildServer(client);

    const result = await callTool(server, "submit_assignment", {
      course_id: 10,
      assignment_id: 100,
      url: "https://example.com/essay",
      confirm: true,
    });

    expect(submitAssignment).toHaveBeenCalledWith(10, 100, { url: "https://example.com/essay" });
    expect(result.content[0].text).toContain("7002");
  });

  it("submits a file_path when confirmed", async () => {
    const submitAssignment = vi.fn(async () => ({ id: 7003 }));
    const client = fakeClient({ submitAssignment });
    const server = buildServer(client);

    const result = await callTool(server, "submit_assignment", {
      course_id: 10,
      assignment_id: 100,
      file_path: "/tmp/essay.txt",
      confirm: true,
    });

    expect(submitAssignment).toHaveBeenCalledWith(10, 100, { filePath: "/tmp/essay.txt" });
    expect(result.content[0].text).toContain("7003");
  });

  it("rejects a call with none of text, url, or file_path set", async () => {
    const submitAssignment = vi.fn();
    const client = fakeClient({ submitAssignment });
    const server = buildServer(client);

    await expect(
      callTool(server, "submit_assignment", { course_id: 10, assignment_id: 100, confirm: true })
    ).rejects.toThrow();
    expect(submitAssignment).not.toHaveBeenCalled();
  });

  it("rejects a call with more than one of text, url, or file_path set", async () => {
    const submitAssignment = vi.fn();
    const client = fakeClient({ submitAssignment });
    const server = buildServer(client);

    await expect(
      callTool(server, "submit_assignment", {
        course_id: 10,
        assignment_id: 100,
        text: "My essay",
        url: "https://example.com/essay",
        confirm: true,
      })
    ).rejects.toThrow();
    expect(submitAssignment).not.toHaveBeenCalled();
  });

  it("rejects an empty text submission", async () => {
    const submitAssignment = vi.fn();
    const client = fakeClient({ submitAssignment });
    const server = buildServer(client);

    await expect(
      callTool(server, "submit_assignment", { course_id: 10, assignment_id: 100, text: "", confirm: true })
    ).rejects.toThrow();
    expect(submitAssignment).not.toHaveBeenCalled();
  });
});

describe("post_discussion_reply tool", () => {
  it("requires confirm before posting", async () => {
    const postDiscussionReply = vi.fn();
    const client = fakeClient({ postDiscussionReply });
    const server = buildServer(client);

    await callTool(server, "post_discussion_reply", { course_id: 10, topic_id: 500, message: "hi" });

    expect(postDiscussionReply).not.toHaveBeenCalled();
  });

  it("posts when confirmed", async () => {
    const postDiscussionReply = vi.fn(async () => ({ id: 9001 }));
    const client = fakeClient({ postDiscussionReply });
    const server = buildServer(client);

    await callTool(server, "post_discussion_reply", { course_id: 10, topic_id: 500, message: "hi", confirm: true });

    expect(postDiscussionReply).toHaveBeenCalledWith(10, 500, "hi");
  });

  it("preview includes both course_id and topic_id", async () => {
    const postDiscussionReply = vi.fn();
    const client = fakeClient({ postDiscussionReply });
    const server = buildServer(client);

    const result = await callTool(server, "post_discussion_reply", { course_id: 10, topic_id: 500, message: "hi" });

    expect(result.content[0].text).toContain("10");
    expect(result.content[0].text).toContain("500");
  });

  it("rejects an empty message", async () => {
    const postDiscussionReply = vi.fn();
    const client = fakeClient({ postDiscussionReply });
    const server = buildServer(client);

    await expect(
      callTool(server, "post_discussion_reply", { course_id: 10, topic_id: 500, message: "", confirm: true })
    ).rejects.toThrow();
    expect(postDiscussionReply).not.toHaveBeenCalled();
  });
});

describe("add_submission_comment tool", () => {
  it("requires confirm before commenting", async () => {
    const addSubmissionComment = vi.fn();
    const client = fakeClient({ addSubmissionComment });
    const server = buildServer(client);

    await callTool(server, "add_submission_comment", { course_id: 10, assignment_id: 100, comment: "sorry, late" });

    expect(addSubmissionComment).not.toHaveBeenCalled();
  });

  it("comments when confirmed", async () => {
    const addSubmissionComment = vi.fn(async () => ({ id: 8001 }));
    const client = fakeClient({ addSubmissionComment });
    const server = buildServer(client);

    await callTool(server, "add_submission_comment", {
      course_id: 10,
      assignment_id: 100,
      comment: "sorry, late",
      confirm: true,
    });

    expect(addSubmissionComment).toHaveBeenCalledWith(10, 100, "sorry, late");
  });

  it("preview includes both course_id and assignment_id", async () => {
    const addSubmissionComment = vi.fn();
    const client = fakeClient({ addSubmissionComment });
    const server = buildServer(client);

    const result = await callTool(server, "add_submission_comment", {
      course_id: 10,
      assignment_id: 100,
      comment: "sorry, late",
    });

    expect(result.content[0].text).toContain("10");
    expect(result.content[0].text).toContain("100");
  });

  it("rejects an empty comment", async () => {
    const addSubmissionComment = vi.fn();
    const client = fakeClient({ addSubmissionComment });
    const server = buildServer(client);

    await expect(
      callTool(server, "add_submission_comment", { course_id: 10, assignment_id: 100, comment: "", confirm: true })
    ).rejects.toThrow();
    expect(addSubmissionComment).not.toHaveBeenCalled();
  });
});
