# Canvas MCP Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `canvas-mcp`, a local MCP server giving Claude Code read access to the user's Canvas LMS courses/assignments/grades/discussions/calendar, plus the ability to submit assignments and post discussion replies/comments, guarded by an explicit confirmation.

**Architecture:** A `CanvasClient` module wraps the Canvas REST API (auth, pagination, error mapping) with no MCP-specific code in it. An MCP stdio server built on `@modelcontextprotocol/server` registers one tool per operation; each tool handler is a thin wrapper that calls `CanvasClient` and formats the result as MCP tool content. Write-tool handlers additionally enforce a `confirm: true` input before calling through.

**Tech Stack:** TypeScript, Node.js 20+, `@modelcontextprotocol/server`, `zod` (v4) for input schemas, native `fetch`, `vitest` for tests.

**Spec:** `docs/superpowers/specs/2026-09-06-canvas-connector-design.md` — this plan covers only the `canvas-mcp` half of that spec. The `canvas-reminder` scheduled routine is a separate follow-up plan, built after this one is working, since it depends on the still-open question of how the `schedule` skill stores secrets for a cloud-scheduled agent.

## Global Constraints

- Repo root: `~/projects/canvas-connector` (already initialized as a git repo).
- Language: TypeScript, Node.js 20+.
- Auth: `CANVAS_API_TOKEN` and `CANVAS_DOMAIN` read from environment variables (loaded from a local `.env`, gitignored).
- All Canvas API errors (401/403/404/429/other) must be caught and re-thrown as `CanvasApiError` with a human-readable message — never let a raw fetch/HTTP error or stack trace reach the MCP client.
- Every write tool (`submit_assignment`, `post_discussion_reply`, `add_submission_comment`) requires an explicit `confirm: true` input parameter. Without it, the tool must return a preview of the action instead of performing it.
- No instructor/admin functionality — student-facing operations only.

---

## Task 1: Project scaffold + CanvasClient core (auth, pagination, error handling) + `listCourses`

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/canvasClient.ts`
- Test: `src/canvasClient.test.ts`

**Interfaces:**
- Produces: `class CanvasClient { constructor(config: CanvasClientConfig); listCourses(): Promise<Course[]> }`, `interface CanvasClientConfig { domain: string; token: string; fetchImpl?: typeof fetch }`, `class CanvasApiError extends Error { status: number }`, `interface Course { id: number; name: string; course_code: string }`, `export function parseNextLink(linkHeader: string | null): string | null`

- [ ] **Step 1: Create project scaffold**

`package.json`:
```json
{
  "name": "canvas-connector",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start:mcp": "node dist/mcp/server.js"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^20.14.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src"]
}
```

`.gitignore`:
```
node_modules/
dist/
.env
```

`.env.example`:
```
CANVAS_API_TOKEN=your_canvas_personal_access_token
CANVAS_DOMAIN=school.instructure.com
```

Run: `cd ~/projects/canvas-connector && npm install`
Expected: installs without errors, creates `package-lock.json` and `node_modules/`.

- [ ] **Step 2: Write the failing test for the core plumbing**

```typescript
// src/canvasClient.test.ts
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
    });

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
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "test-token", fetchImpl });
    const courses = await client.listCourses();

    expect(courses).toHaveLength(2);
    expect(courses.map((c) => c.id)).toEqual([1, 2]);
  });

  it("throws a readable CanvasApiError on a 401", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const client = new CanvasClient({ domain: "school.instructure.com", token: "bad-token", fetchImpl });

    await expect(client.listCourses()).rejects.toThrow(CanvasApiError);
    await expect(client.listCourses()).rejects.toThrow(/token/i);
  });

  it("throws a readable CanvasApiError on a 429", async () => {
    const fetchImpl = vi.fn(async () => new Response("Rate limited", { status: 429 }));
    const client = new CanvasClient({ domain: "school.instructure.com", token: "test-token", fetchImpl });

    await expect(client.listCourses()).rejects.toThrow(/rate.?limit/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: FAIL — `src/canvasClient.ts` does not exist yet (module not found).

- [ ] **Step 4: Implement `src/canvasClient.ts`**

```typescript
// src/canvasClient.ts

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
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CanvasApiError(res.status, mapErrorMessage(res.status, body));
    }

    const data = (await res.json()) as T;
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
      const { data, nextUrl } = await this.requestPage<T[]>(url, init);
      results.push(...data);
      url = nextUrl;
    }
    return results;
  }

  async listCourses(): Promise<Course[]> {
    return this.requestAllPages<Course>("/courses?enrollment_state=active");
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/canvas-connector
git add package.json tsconfig.json .gitignore .env.example src/canvasClient.ts src/canvasClient.test.ts package-lock.json
git commit -m "feat: scaffold project and add CanvasClient core with listCourses"
```

---

## Task 2: `listAssignments` and `getAssignment`

**Files:**
- Modify: `src/canvasClient.ts`
- Test: `src/canvasClient.test.ts`

**Interfaces:**
- Consumes: `CanvasClient.requestAllPages`, `CanvasClient.requestOne` (from Task 1)
- Produces: `interface Assignment { id: number; name: string; due_at: string | null; submission?: { workflow_state: string; submitted_at: string | null } }`, `CanvasClient.listAssignments(courseId: number): Promise<Assignment[]>`, `CanvasClient.getAssignment(courseId: number, assignmentId: number): Promise<Assignment>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/canvasClient.test.ts

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: FAIL — `listAssignments is not a function`.

- [ ] **Step 3: Implement**

Add to `src/canvasClient.ts`, above the closing brace of `CanvasClient`:

```typescript
export interface Assignment {
  id: number;
  name: string;
  due_at: string | null;
  submission?: {
    workflow_state: string;
    submitted_at: string | null;
  };
}
```

Add methods to `CanvasClient`:

```typescript
  async listAssignments(courseId: number): Promise<Assignment[]> {
    return this.requestAllPages<Assignment>(`/courses/${courseId}/assignments?include[]=submission`);
  }

  async getAssignment(courseId: number, assignmentId: number): Promise<Assignment> {
    return this.requestOne<Assignment>(`/courses/${courseId}/assignments/${assignmentId}?include[]=submission`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/canvasClient.ts src/canvasClient.test.ts
git commit -m "feat: add listAssignments and getAssignment to CanvasClient"
```

---

## Task 3: `listGrades`

**Files:**
- Modify: `src/canvasClient.ts`
- Test: `src/canvasClient.test.ts`

**Interfaces:**
- Consumes: `CanvasClient.requestAllPages` (from Task 1)
- Produces: `interface Enrollment { course_id: number; grades: { current_score: number | null; current_grade: string | null } }`, `CanvasClient.listGrades(courseId?: number): Promise<Enrollment[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/canvasClient.test.ts

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: FAIL — `listGrades is not a function`.

- [ ] **Step 3: Implement**

Add to `src/canvasClient.ts`:

```typescript
export interface Enrollment {
  course_id: number;
  grades: {
    current_score: number | null;
    current_grade: string | null;
  };
}
```

Add method to `CanvasClient`:

```typescript
  async listGrades(courseId?: number): Promise<Enrollment[]> {
    const all = await this.requestAllPages<Enrollment>("/users/self/enrollments?type[]=StudentEnrollment");
    return courseId === undefined ? all : all.filter((e) => e.course_id === courseId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/canvasClient.ts src/canvasClient.test.ts
git commit -m "feat: add listGrades to CanvasClient"
```

---

## Task 4: `listDiscussionTopics` and `postDiscussionReply`

**Files:**
- Modify: `src/canvasClient.ts`
- Test: `src/canvasClient.test.ts`

**Interfaces:**
- Consumes: `CanvasClient.requestAllPages`, `CanvasClient.requestOne` (from Task 1)
- Produces: `interface DiscussionTopic { id: number; title: string }`, `CanvasClient.listDiscussionTopics(courseId: number): Promise<DiscussionTopic[]>`, `CanvasClient.postDiscussionReply(courseId: number, topicId: number, message: string): Promise<{ id: number }>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/canvasClient.test.ts

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement**

Add to `src/canvasClient.ts`:

```typescript
export interface DiscussionTopic {
  id: number;
  title: string;
}
```

Add a shared JSON-POST helper and the two methods to `CanvasClient`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/canvasClient.ts src/canvasClient.test.ts
git commit -m "feat: add listDiscussionTopics and postDiscussionReply to CanvasClient"
```

---

## Task 5: `submitAssignment` (text, URL, and file) and `addSubmissionComment`

**Files:**
- Modify: `src/canvasClient.ts`
- Test: `src/canvasClient.test.ts`

**Interfaces:**
- Consumes: `CanvasClient.requestOne`, `CanvasClient.postJson` (from Tasks 1 and 4)
- Produces: `type SubmissionInput = { text: string } | { url: string } | { filePath: string }`, `CanvasClient.submitAssignment(courseId: number, assignmentId: number, submission: SubmissionInput): Promise<{ id: number }>`, `CanvasClient.addSubmissionComment(courseId: number, assignmentId: number, comment: string): Promise<{ id: number }>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/canvasClient.test.ts
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: FAIL — `submitAssignment` / `addSubmissionComment` not defined.

- [ ] **Step 3: Implement**

Add to `src/canvasClient.ts` (near the top, with the other imports):

```typescript
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
```

Add the type and methods to `CanvasClient`:

```typescript
export type SubmissionInput = { text: string } | { url: string } | { filePath: string };
```

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/canvasClient.ts src/canvasClient.test.ts
git commit -m "feat: add submitAssignment (text/url/file) and addSubmissionComment to CanvasClient"
```

---

## Task 6: `listCalendarEvents`

**Files:**
- Modify: `src/canvasClient.ts`
- Test: `src/canvasClient.test.ts`

**Interfaces:**
- Consumes: `CanvasClient.requestAllPages` (from Task 1)
- Produces: `interface CalendarEvent { id: number; title: string; start_at: string; end_at: string | null }`, `CanvasClient.listCalendarEvents(startDate: string, endDate: string): Promise<CalendarEvent[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/canvasClient.test.ts

describe("CanvasClient.listCalendarEvents", () => {
  it("requests events in the given date range", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://school.instructure.com/api/v1/calendar_events?type=event&start_date=2026-09-06&end_date=2026-09-13&per_page=50"
      );
      return jsonResponse([{ id: 1, title: "Study group", start_at: "2026-09-08T18:00:00Z", end_at: null }]);
    });

    const client = new CanvasClient({ domain: "school.instructure.com", token: "t", fetchImpl });
    const events = await client.listCalendarEvents("2026-09-06", "2026-09-13");

    expect(events[0].title).toBe("Study group");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: FAIL — `listCalendarEvents` not defined.

- [ ] **Step 3: Implement**

Add to `src/canvasClient.ts`:

```typescript
export interface CalendarEvent {
  id: number;
  title: string;
  start_at: string;
  end_at: string | null;
}
```

Add method to `CanvasClient`:

```typescript
  async listCalendarEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
    return this.requestAllPages<CalendarEvent>(
      `/calendar_events?type=event&start_date=${startDate}&end_date=${endDate}&per_page=50`
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/canvasClient.test.ts`
Expected: PASS — full `canvasClient.test.ts` suite green (all tasks so far).

- [ ] **Step 5: Commit**

```bash
git add src/canvasClient.ts src/canvasClient.test.ts
git commit -m "feat: add listCalendarEvents to CanvasClient"
```

---

## Task 7: MCP server scaffold + read-only tools

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/mcp/config.ts`
- Test: `src/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `CanvasClient` and all its methods/types from Tasks 1-6
- Produces: `export function buildServer(client: CanvasClient): McpServer` (exported so tests can register tools against a fake `CanvasClient` without spawning a real stdio process)

- [ ] **Step 1: Write the failing test**

```typescript
// src/mcp/tools.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/tools.test.ts`
Expected: FAIL — `src/mcp/server.ts` does not exist.

- [ ] **Step 3: Implement `src/mcp/config.ts`**

```typescript
// src/mcp/config.ts
export function loadConfigFromEnv(): { domain: string; token: string } {
  const domain = process.env.CANVAS_DOMAIN;
  const token = process.env.CANVAS_API_TOKEN;
  if (!domain || !token) {
    throw new Error("CANVAS_DOMAIN and CANVAS_API_TOKEN must be set (see .env.example).");
  }
  return { domain, token };
}
```

- [ ] **Step 4: Implement `src/mcp/server.ts`**

This wires read-only tools. To keep tests able to call handlers directly without going through the stdio transport, `buildServer` stashes each handler in a plain object on the returned server instance (`_testHandlers`) alongside registering it normally with the SDK — the SDK call is what makes it work for real over stdio; the stash is purely a test seam.

```typescript
// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { CanvasClient } from "../canvasClient.js";

type ToolHandler = (args: any) => Promise<{ content: { type: "text"; text: string }[] }>;

export function buildServer(client: CanvasClient) {
  const server = new McpServer({ name: "canvas-mcp", version: "0.1.0" }) as InstanceType<typeof McpServer> & {
    _testHandlers: Record<string, ToolHandler>;
  };
  server._testHandlers = {};

  function register(name: string, description: string, inputSchema: z.ZodObject<any>, handler: ToolHandler) {
    server._testHandlers[name] = handler;
    server.registerTool(name, { description, inputSchema }, handler);
  }

  register(
    "list_courses",
    "List the student's active Canvas courses.",
    z.object({}),
    async () => {
      const courses = await client.listCourses();
      const text = courses.map((c) => `${c.id}: ${c.name} (${c.course_code})`).join("\n") || "No active courses.";
      return { content: [{ type: "text", text }] };
    }
  );

  register(
    "list_assignments",
    "List assignments for a course, including due date and submission status.",
    z.object({ course_id: z.number() }),
    async ({ course_id }) => {
      const assignments = await client.listAssignments(course_id);
      const text =
        assignments
          .map((a) => `${a.id}: ${a.name} — due ${a.due_at ?? "no due date"} — ${a.submission?.workflow_state ?? "unknown"}`)
          .join("\n") || "No assignments found.";
      return { content: [{ type: "text", text }] };
    }
  );

  register(
    "get_assignment",
    "Get details for a single assignment.",
    z.object({ course_id: z.number(), assignment_id: z.number() }),
    async ({ course_id, assignment_id }) => {
      const a = await client.getAssignment(course_id, assignment_id);
      return { content: [{ type: "text", text: `${a.name} — due ${a.due_at ?? "no due date"}` }] };
    }
  );

  register(
    "list_grades",
    "List current grades, optionally filtered to one course.",
    z.object({ course_id: z.number().optional() }),
    async ({ course_id }) => {
      const grades = await client.listGrades(course_id);
      const text =
        grades
          .map((g) => `Course ${g.course_id}: ${g.grades.current_grade ?? "N/A"} (${g.grades.current_score ?? "N/A"})`)
          .join("\n") || "No grades found.";
      return { content: [{ type: "text", text }] };
    }
  );

  register(
    "list_discussion_topics",
    "List discussion topics for a course.",
    z.object({ course_id: z.number() }),
    async ({ course_id }) => {
      const topics = await client.listDiscussionTopics(course_id);
      const text = topics.map((t) => `${t.id}: ${t.title}`).join("\n") || "No discussion topics found.";
      return { content: [{ type: "text", text }] };
    }
  );

  register(
    "list_calendar_events",
    "List calendar events between two dates (YYYY-MM-DD).",
    z.object({ start_date: z.string(), end_date: z.string() }),
    async ({ start_date, end_date }) => {
      const events = await client.listCalendarEvents(start_date, end_date);
      const text = events.map((e) => `${e.title} — ${e.start_at}`).join("\n") || "No calendar events found.";
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/mcp/tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/mcp/config.ts src/mcp/tools.test.ts
git commit -m "feat: add MCP server with read-only Canvas tools"
```

---

## Task 8: MCP write tools with `confirm` guard

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `src/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `CanvasClient.submitAssignment`, `CanvasClient.postDiscussionReply`, `CanvasClient.addSubmissionComment` (from Tasks 4-5), the `register` helper and `buildServer` (from Task 7)
- Produces: three new tools — `submit_assignment`, `post_discussion_reply`, `add_submission_comment` — each requiring `confirm: true`

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/mcp/tools.test.ts

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp/tools.test.ts`
Expected: FAIL — no handler registered for `submit_assignment` / `post_discussion_reply` / `add_submission_comment`.

- [ ] **Step 3: Implement**

Add to `src/mcp/server.ts`, inside `buildServer`, before `return server;`:

```typescript
  register(
    "submit_assignment",
    "Submit assignment work (text, a URL, or a local file path). Requires confirm: true to actually submit.",
    z.object({
      course_id: z.number(),
      assignment_id: z.number(),
      text: z.string().optional(),
      url: z.string().optional(),
      file_path: z.string().optional(),
      confirm: z.boolean().optional(),
    }),
    async ({ course_id, assignment_id, text, url, file_path, confirm }) => {
      const submission = text !== undefined ? { text } : url !== undefined ? { url } : { filePath: file_path! };
      if (!confirm) {
        return {
          content: [
            {
              type: "text",
              text: `This would submit to course ${course_id}, assignment ${assignment_id}: ${JSON.stringify(
                submission
              )}. Call again with confirm: true to actually submit.`,
            },
          ],
        };
      }
      const result = await client.submitAssignment(course_id, assignment_id, submission as any);
      return { content: [{ type: "text", text: `Submitted. Submission id: ${result.id}` }] };
    }
  );

  register(
    "post_discussion_reply",
    "Post a reply to a Canvas discussion topic. Requires confirm: true to actually post.",
    z.object({ course_id: z.number(), topic_id: z.number(), message: z.string(), confirm: z.boolean().optional() }),
    async ({ course_id, topic_id, message, confirm }) => {
      if (!confirm) {
        return {
          content: [
            { type: "text", text: `This would post "${message}" to topic ${topic_id}. Call again with confirm: true to actually post.` },
          ],
        };
      }
      const result = await client.postDiscussionReply(course_id, topic_id, message);
      return { content: [{ type: "text", text: `Posted. Entry id: ${result.id}` }] };
    }
  );

  register(
    "add_submission_comment",
    "Add a comment to the student's own submission for an assignment. Requires confirm: true to actually post.",
    z.object({ course_id: z.number(), assignment_id: z.number(), comment: z.string(), confirm: z.boolean().optional() }),
    async ({ course_id, assignment_id, comment, confirm }) => {
      if (!confirm) {
        return {
          content: [{ type: "text", text: `This would add the comment "${comment}". Call again with confirm: true to actually post.` }],
        };
      }
      const result = await client.addSubmissionComment(course_id, assignment_id, comment);
      return { content: [{ type: "text", text: `Comment added. Id: ${result.id}` }] };
    }
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp/tools.test.ts`
Expected: PASS — all tool tests green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/tools.test.ts
git commit -m "feat: add confirm-guarded write tools (submit, post reply, add comment)"
```

---

## Task 9: Server entrypoint, Claude Code registration, and manual smoke test

**Files:**
- Modify: `src/mcp/server.ts` (add a `main()` entrypoint)
- Create: `README.md`

**Interfaces:**
- Consumes: `buildServer` (Task 7), `loadConfigFromEnv` (Task 7), `CanvasClient` (Task 1)
- Produces: a runnable `dist/mcp/server.js` that speaks MCP over stdio when launched

- [ ] **Step 1: Add the stdio entrypoint**

Add to the bottom of `src/mcp/server.ts`:

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CanvasClient } from "../canvasClient.js";
import { loadConfigFromEnv } from "./config.js";

async function main() {
  const config = loadConfigFromEnv();
  const client = new CanvasClient(config);
  const server = buildServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Build and verify it starts without crashing**

```bash
cd ~/projects/canvas-connector
cp .env.example .env   # then edit .env with your real CANVAS_API_TOKEN and CANVAS_DOMAIN
npm run build
CANVAS_DOMAIN=$(grep CANVAS_DOMAIN .env | cut -d= -f2) CANVAS_API_TOKEN=$(grep CANVAS_API_TOKEN .env | cut -d= -f2) timeout 2 node dist/mcp/server.js
```

Expected: the process starts and waits on stdio (a `timeout 2` exit with no error output is a pass — an MCP stdio server blocks waiting for JSON-RPC input, so silence is success; a stack trace is a failure).

- [ ] **Step 3: Register the server with Claude Code**

```bash
claude mcp add canvas -- node ~/projects/canvas-connector/dist/mcp/server.js
```

Then edit the resulting config entry (or use `claude mcp add` env flags per your Claude Code version) to set `CANVAS_DOMAIN` and `CANVAS_API_TOKEN` for the server process — do not commit the token anywhere.

- [ ] **Step 4: Manual smoke test from a Claude Code session**

In a new Claude Code session, ask: "using the canvas connector, list my courses." Confirm it returns your real active courses. Then ask for assignments in one course and confirm due dates look right. Then try `submit_assignment` on a real low-stakes assignment (or a sandbox course) without `confirm: true` first — confirm you get a preview, not an actual submission — then re-run with `confirm: true` and verify it shows up as submitted in Canvas.

- [ ] **Step 5: Write `README.md`**

```markdown
# canvas-connector

An MCP server giving Claude Code access to Canvas LMS: courses, assignments,
grades, discussions, calendar, plus submitting assignments and posting
discussion replies/comments (both guarded by a `confirm: true` parameter).

## Setup

1. Generate a Canvas personal access token: Canvas → Account → Settings →
   New Access Token.
2. `cp .env.example .env` and fill in `CANVAS_API_TOKEN` and `CANVAS_DOMAIN`.
3. `npm install && npm run build`
4. Register with Claude Code:
   `claude mcp add canvas -- node $(pwd)/dist/mcp/server.js`
   (configure `CANVAS_DOMAIN` / `CANVAS_API_TOKEN` as env vars on that
   registration per your Claude Code version's `mcp add` flags)

## Tools

Read: `list_courses`, `list_assignments`, `get_assignment`, `list_grades`,
`list_discussion_topics`, `list_calendar_events`.

Write (require `confirm: true`, otherwise return a preview):
`submit_assignment`, `post_discussion_reply`, `add_submission_comment`.

## Tests

`npm test`
```

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts README.md
git commit -m "feat: add stdio entrypoint, Claude Code registration steps, and README"
```

---

## After this plan

The `canvas-reminder` scheduled routine (daily email of upcoming/unsubmitted work) is a separate follow-up plan, to be written once this connector is confirmed working end-to-end — it reuses `CanvasClient` from this repo but needs the `schedule` skill invoked first to resolve how its cloud-scheduled environment gets `CANVAS_API_TOKEN`/`CANVAS_DOMAIN`.
