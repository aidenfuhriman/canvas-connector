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
