import { describe, it, expect, vi } from "vitest";
import { getUpcomingAssignments, getTodayCanvasEvents, formatDigest, runDigest } from "./digest.js";
import { CanvasApiError, type Course, type Assignment, type CalendarEvent } from "../canvasClient.js";

function fakeClient(overrides: Record<string, any>) {
  return overrides as any;
}

describe("getUpcomingAssignments", () => {
  const now = new Date("2026-09-06T12:00:00Z");

  it("includes an unsubmitted assignment due within the lookahead window", async () => {
    const listCourses = vi.fn(async (): Promise<Course[]> => [
      { id: 10, name: "Biology 101", course_code: "BIO101" },
    ]);
    const listAssignments = vi.fn(async (): Promise<Assignment[]> => [
      {
        id: 100,
        name: "Lab Report 3",
        due_at: "2026-09-10T23:59:00Z",
        submission: { workflow_state: "unsubmitted", submitted_at: null },
      },
    ]);
    const client = fakeClient({ listCourses, listAssignments });

    const result = await getUpcomingAssignments(client, 7, now);

    expect(result).toEqual([
      {
        courseId: 10,
        courseName: "Biology 101",
        assignment: {
          id: 100,
          name: "Lab Report 3",
          due_at: "2026-09-10T23:59:00Z",
          submission: { workflow_state: "unsubmitted", submitted_at: null },
        },
      },
    ]);
    expect(listAssignments).toHaveBeenCalledWith(10);
  });

  it("excludes an assignment that's already submitted", async () => {
    const listCourses = vi.fn(async (): Promise<Course[]> => [
      { id: 10, name: "Biology 101", course_code: "BIO101" },
    ]);
    const listAssignments = vi.fn(async (): Promise<Assignment[]> => [
      {
        id: 101,
        name: "Lab Report 2",
        due_at: "2026-09-08T23:59:00Z",
        submission: { workflow_state: "submitted", submitted_at: "2026-09-01T00:00:00Z" },
      },
    ]);
    const client = fakeClient({ listCourses, listAssignments });

    const result = await getUpcomingAssignments(client, 7, now);

    expect(result).toEqual([]);
  });

  it("excludes an assignment with no due date", async () => {
    const listCourses = vi.fn(async (): Promise<Course[]> => [
      { id: 10, name: "Biology 101", course_code: "BIO101" },
    ]);
    const listAssignments = vi.fn(async (): Promise<Assignment[]> => [
      { id: 102, name: "Ongoing Project", due_at: null },
    ]);
    const client = fakeClient({ listCourses, listAssignments });

    const result = await getUpcomingAssignments(client, 7, now);

    expect(result).toEqual([]);
  });

  it("excludes an assignment due outside the lookahead window", async () => {
    const listCourses = vi.fn(async (): Promise<Course[]> => [
      { id: 10, name: "Biology 101", course_code: "BIO101" },
    ]);
    const listAssignments = vi.fn(async (): Promise<Assignment[]> => [
      { id: 103, name: "Final Paper", due_at: "2026-10-01T23:59:00Z" },
    ]);
    const client = fakeClient({ listCourses, listAssignments });

    const result = await getUpcomingAssignments(client, 7, now);

    expect(result).toEqual([]);
  });

  it("excludes an assignment that's already past due", async () => {
    const listCourses = vi.fn(async (): Promise<Course[]> => [
      { id: 10, name: "Biology 101", course_code: "BIO101" },
    ]);
    const listAssignments = vi.fn(async (): Promise<Assignment[]> => [
      { id: 104, name: "Old Homework", due_at: "2026-09-01T23:59:00Z" },
    ]);
    const client = fakeClient({ listCourses, listAssignments });

    const result = await getUpcomingAssignments(client, 7, now);

    expect(result).toEqual([]);
  });

  it("checks every active course", async () => {
    const listCourses = vi.fn(async (): Promise<Course[]> => [
      { id: 10, name: "Biology 101", course_code: "BIO101" },
      { id: 20, name: "Chemistry 201", course_code: "CHEM201" },
    ]);
    const listAssignments = vi.fn(async (courseId: number): Promise<Assignment[]> => {
      if (courseId === 20) {
        return [{ id: 200, name: "Titration Report", due_at: "2026-09-09T23:59:00Z" }];
      }
      return [];
    });
    const client = fakeClient({ listCourses, listAssignments });

    const result = await getUpcomingAssignments(client, 7, now);

    expect(result).toHaveLength(1);
    expect(result[0].courseName).toBe("Chemistry 201");
    expect(listAssignments).toHaveBeenCalledWith(10);
    expect(listAssignments).toHaveBeenCalledWith(20);
  });
});

describe("getTodayCanvasEvents", () => {
  it("requests events for today's date range", async () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const listCalendarEvents = vi.fn(async (): Promise<CalendarEvent[]> => [
      { id: 1, title: "Biology Lecture", start_at: "2026-09-06T14:00:00Z", end_at: null },
    ]);
    const client = fakeClient({ listCalendarEvents });

    const result = await getTodayCanvasEvents(client, now);

    expect(listCalendarEvents).toHaveBeenCalledWith("2026-09-06", "2026-09-07");
    expect(result).toHaveLength(1);
  });
});

describe("formatDigest", () => {
  it("formats assignments and events into readable text", () => {
    const text = formatDigest(
      [
        {
          courseId: 10,
          courseName: "Biology 101",
          assignment: { id: 100, name: "Lab Report 3", due_at: "2026-09-10T23:59:00Z" },
        },
      ],
      [{ id: 1, title: "Biology Lecture", start_at: "2026-09-06T14:00:00Z", end_at: null }]
    );

    expect(text).toContain("Upcoming Assignments");
    expect(text).toContain("Biology 101");
    expect(text).toContain("Lab Report 3");
    expect(text).toContain("Today's Canvas Schedule");
    expect(text).toContain("Biology Lecture");
  });

  it("shows a friendly message when there are no upcoming assignments", () => {
    const text = formatDigest([], []);

    expect(text).toContain("Nothing due");
    expect(text).toContain("No Canvas calendar events today");
  });
});

describe("runDigest", () => {
  it("returns formatted text on success", async () => {
    const client = fakeClient({
      listCourses: vi.fn(async () => []),
      listAssignments: vi.fn(async () => []),
      listCalendarEvents: vi.fn(async () => []),
    });

    const text = await runDigest(client, new Date("2026-09-06T12:00:00Z"));

    expect(text).toContain("Nothing due");
  });

  it("rejects with the underlying CanvasApiError when a Canvas call fails, rather than swallowing it", async () => {
    const apiError = new CanvasApiError(401, "Canvas rejected the API token — check CANVAS_API_TOKEN.");
    const client = fakeClient({
      listCourses: vi.fn(async () => {
        throw apiError;
      }),
      listAssignments: vi.fn(async () => []),
      listCalendarEvents: vi.fn(async () => []),
    });

    await expect(runDigest(client, new Date("2026-09-06T12:00:00Z"))).rejects.toBe(apiError);
  });
});
