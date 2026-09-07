import { describe, it, expect, vi } from "vitest";
import { buildServer } from "./server.js";
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
