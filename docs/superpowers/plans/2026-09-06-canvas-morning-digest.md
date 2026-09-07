# Canvas Morning Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/reminder/digest.ts`, a standalone script that fetches upcoming unsubmitted Canvas assignments (next 7 days) and today's Canvas calendar events, and prints a readable plain-text digest — the Canvas half of the daily morning email.

**Architecture:** A small module of pure/async functions (`getUpcomingAssignments`, `getTodayCanvasEvents`, `formatDigest`) built on top of the existing, already-tested `CanvasClient`, plus a thin `main()` entrypoint that wires them together and handles errors without leaking a raw stack trace. No MCP involvement — this runs as a plain Node script.

**Tech Stack:** TypeScript, Node.js 20+, `vitest` (matches the rest of the repo).

**Spec:** `docs/superpowers/specs/2026-09-06-canvas-morning-digest-design.md` — this plan covers only `digest.ts` (the "produces working, testable software on its own" slice). Wiring it into a scheduled cloud agent (via the `schedule` skill, with Google Calendar lookup, quote generation, and email sending) is explicitly out of scope for this plan — it's a one-time, account-touching setup step to do together with the user afterward, not something an automated implementer should do.

## Global Constraints

- Repo root: `~/projects/canvas-connector` (existing git repo, already has `src/canvasClient.ts` and `src/mcp/`).
- Language: TypeScript, Node.js 20+ (matches existing `tsconfig.json`/`package.json`).
- Auth: reuse `loadConfigFromEnv()` from `src/mcp/config.ts` (`CANVAS_API_TOKEN`/`CANVAS_DOMAIN`) — do not duplicate this logic.
- Reuse `CanvasClient` from `src/canvasClient.ts` (`listCourses`, `listAssignments`, `listCalendarEvents`) — do not re-implement Canvas API calls.
- Never let a raw error/stack trace reach stdout or an uncaught exception — `digest.ts`'s `main()` must catch failures and print a human-readable message to stderr, exiting non-zero.
- Assignment lookahead: next 7 days, unsubmitted only (`submission?.workflow_state !== "submitted"`, treating a missing `submission` as unsubmitted).
- Canvas calendar scope: today only.
- Output is plain text to stdout — no HTML, no email formatting (that's the calling agent's job, out of scope here).

---

## Task 1: Digest logic — `getUpcomingAssignments`, `getTodayCanvasEvents`, `formatDigest`

**Files:**
- Create: `src/reminder/digest.ts`
- Test: `src/reminder/digest.test.ts`

**Interfaces:**
- Consumes: `CanvasClient` and its `listCourses(): Promise<Course[]>`, `listAssignments(courseId: number): Promise<Assignment[]>`, `listCalendarEvents(startDate: string, endDate: string): Promise<CalendarEvent[]>`, plus the `Course`, `Assignment`, `CalendarEvent` types — all from `../canvasClient.js` (already built).
- Produces: `interface UpcomingAssignment { courseId: number; courseName: string; assignment: Assignment }`, `getUpcomingAssignments(client: Pick<CanvasClient, "listCourses" | "listAssignments">, lookaheadDays: number, now: Date): Promise<UpcomingAssignment[]>`, `getTodayCanvasEvents(client: Pick<CanvasClient, "listCalendarEvents">, now: Date): Promise<CalendarEvent[]>`, `formatDigest(assignments: UpcomingAssignment[], events: CalendarEvent[]): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/reminder/digest.test.ts
import { describe, it, expect, vi } from "vitest";
import { getUpcomingAssignments, getTodayCanvasEvents, formatDigest } from "./digest.js";
import type { Course, Assignment, CalendarEvent } from "../canvasClient.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/reminder/digest.test.ts`
Expected: FAIL — `src/reminder/digest.ts` does not exist.

- [ ] **Step 3: Implement `src/reminder/digest.ts`**

```typescript
// src/reminder/digest.ts
import type { CanvasClient, Course, Assignment, CalendarEvent } from "../canvasClient.js";

export interface UpcomingAssignment {
  courseId: number;
  courseName: string;
  assignment: Assignment;
}

export async function getUpcomingAssignments(
  client: Pick<CanvasClient, "listCourses" | "listAssignments">,
  lookaheadDays: number,
  now: Date
): Promise<UpcomingAssignment[]> {
  const courses: Course[] = await client.listCourses();
  const cutoff = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
  const results: UpcomingAssignment[] = [];

  for (const course of courses) {
    const assignments = await client.listAssignments(course.id);
    for (const assignment of assignments) {
      if (!assignment.due_at) continue;
      const dueDate = new Date(assignment.due_at);
      if (dueDate < now || dueDate > cutoff) continue;
      if (assignment.submission?.workflow_state === "submitted") continue;
      results.push({ courseId: course.id, courseName: course.name, assignment });
    }
  }

  return results;
}

export async function getTodayCanvasEvents(
  client: Pick<CanvasClient, "listCalendarEvents">,
  now: Date
): Promise<CalendarEvent[]> {
  const start = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const end = tomorrow.toISOString().slice(0, 10);
  return client.listCalendarEvents(start, end);
}

export function formatDigest(assignments: UpcomingAssignment[], events: CalendarEvent[]): string {
  const lines: string[] = [];

  lines.push("Upcoming Assignments (next 7 days):");
  if (assignments.length === 0) {
    lines.push("  Nothing due — you're all caught up.");
  } else {
    for (const { courseName, assignment } of assignments) {
      lines.push(`  - [${courseName}] ${assignment.name} — due ${assignment.due_at}`);
    }
  }

  lines.push("");
  lines.push("Today's Canvas Schedule:");
  if (events.length === 0) {
    lines.push("  No Canvas calendar events today.");
  } else {
    for (const event of events) {
      lines.push(`  - ${event.title} — ${event.start_at}`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/reminder/digest.test.ts`
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/canvas-connector
git add src/reminder/digest.ts src/reminder/digest.test.ts
git commit -m "feat: add Canvas digest logic (upcoming assignments, today's events, formatting)"
```

---

## Task 2: `main()` entrypoint, error handling, and build verification

**Files:**
- Modify: `src/reminder/digest.ts` (add `main()` at the bottom)
- Test: `src/reminder/digest.test.ts` (add error-handling coverage)
- Modify: `package.json` (add a `start:digest` script, matching the existing `start:mcp` pattern)

**Interfaces:**
- Consumes: `getUpcomingAssignments`, `getTodayCanvasEvents`, `formatDigest` (Task 1), `CanvasClient` and `loadConfigFromEnv` (existing, from `../canvasClient.js` and `../mcp/config.js`)
- Produces: a runnable `dist/reminder/digest.js` that prints the digest to stdout, or a clear error to stderr with a non-zero exit code

- [ ] **Step 1: Write the failing test for error handling**

```typescript
// append to src/reminder/digest.test.ts
import { CanvasApiError } from "../canvasClient.js";
import { runDigest } from "./digest.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/reminder/digest.test.ts`
Expected: FAIL — `runDigest` is not exported.

- [ ] **Step 3: Implement `runDigest` and `main()`**

First, change Task 1's `import type { CanvasClient, Course, Assignment, CalendarEvent } from "../canvasClient.js";` line at the top of `src/reminder/digest.ts` into a regular (non-type-only) import, since `main()` needs to construct a real `CanvasClient` instance, not just reference its type:

```typescript
import { CanvasClient, type Course, type Assignment, type CalendarEvent } from "../canvasClient.js";
```

Then add the rest of the new imports and code to `src/reminder/digest.ts`:

```typescript
import { loadConfigFromEnv } from "../mcp/config.js";
import { pathToFileURL } from "node:url";

export async function runDigest(
  client: Pick<CanvasClient, "listCourses" | "listAssignments" | "listCalendarEvents">,
  now: Date
): Promise<string> {
  const assignments = await getUpcomingAssignments(client, 7, now);
  const events = await getTodayCanvasEvents(client, now);
  return formatDigest(assignments, events);
}

export async function main(): Promise<void> {
  try {
    const config = loadConfigFromEnv();
    const client = new CanvasClient(config);
    const text = await runDigest(client, new Date());
    console.log(text);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

(Note the `pathToFileURL` main-module check here, rather than the plain template-literal comparison used in `src/mcp/server.ts` — this is the more robust form; a future cleanup could apply it there too, but that's outside this task's scope.)

Add to `package.json`'s `"scripts"` section (alongside the existing `start:mcp` entry):

```json
"start:digest": "node dist/reminder/digest.js"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/reminder/digest.test.ts`
Expected: PASS — all 12 tests green.

- [ ] **Step 5: Build and verify the script starts cleanly with placeholder config**

Run: `npx tsc --noEmit -p tsconfig.json` — expect 0 errors.
Run: `npm run build`
Run: `CANVAS_DOMAIN=example.instructure.com CANVAS_API_TOKEN=placeholder-token node dist/reminder/digest.js`
Expected: since `example.instructure.com` isn't real, this should print a `CanvasApiError`-derived message to stderr (e.g. a network/DNS failure) and exit non-zero — NOT a raw stack trace. That confirms `main()`'s error handling works. Do not attempt to point this at a real Canvas account or token — that verification happens later, together with the user, when the scheduled agent is set up.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/canvas-connector
git add src/reminder/digest.ts src/reminder/digest.test.ts package.json
git commit -m "feat: add digest main() entrypoint with error handling"
```

---

## After this plan

Wiring `digest.ts` into an actual daily 7am email — Google Calendar lookup, quote generation, and sending via Gmail — happens via the `schedule` skill, together with the user, since it requires configuring `CANVAS_API_TOKEN`/`CANVAS_DOMAIN` as secrets in a cloud execution environment and touches the user's real inbox. Not part of this plan.
