import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { CanvasClient } from "../canvasClient.js";

type ToolHandler = (args: any) => Promise<{ content: { type: "text"; text: string }[] }>;

export function buildServer(client: CanvasClient) {
  const server = new McpServer({ name: "canvas-mcp", version: "0.1.0" }) as InstanceType<typeof McpServer> & {
    _testHandlers: Record<string, ToolHandler>;
  };
  server._testHandlers = {};

  function register(name: string, description: string, inputSchema: z.ZodObject<any>, handler: ToolHandler) {
    // Mirror the real dispatch path (see @modelcontextprotocol/server's `validateStandardSchema`
    // call ahead of `tool.executor(...)`), which parses args against inputSchema before the
    // handler ever runs. Without this, direct-handler tests would bypass schema-level guards
    // (refine/min) that production traffic can never skip.
    server._testHandlers[name] = async (args: unknown) => handler(inputSchema.parse(args));
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

  register(
    "submit_assignment",
    "Submit assignment work (text, a URL, or a local file path). Requires confirm: true to actually submit.",
    z
      .object({
        course_id: z.number(),
        assignment_id: z.number(),
        text: z.string().min(1).optional(),
        url: z.string().min(1).optional(),
        file_path: z.string().min(1).optional(),
        confirm: z.boolean().optional(),
      })
      .refine((data) => [data.text, data.url, data.file_path].filter((v) => v !== undefined).length === 1, {
        message: "Provide exactly one of text, url, or file_path.",
      }),
    async ({ course_id, assignment_id, text, url, file_path, confirm }) => {
      const submission = text !== undefined ? { text } : url !== undefined ? { url } : { filePath: file_path! };
      if (confirm !== true) {
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
    z.object({
      course_id: z.number(),
      topic_id: z.number(),
      message: z.string().min(1),
      confirm: z.boolean().optional(),
    }),
    async ({ course_id, topic_id, message, confirm }) => {
      if (confirm !== true) {
        return {
          content: [
            {
              type: "text",
              text: `This would post "${message}" to course ${course_id}, topic ${topic_id}. Call again with confirm: true to actually post.`,
            },
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
    z.object({
      course_id: z.number(),
      assignment_id: z.number(),
      comment: z.string().min(1),
      confirm: z.boolean().optional(),
    }),
    async ({ course_id, assignment_id, comment, confirm }) => {
      if (confirm !== true) {
        return {
          content: [
            {
              type: "text",
              text: `This would add the comment "${comment}" to course ${course_id}, assignment ${assignment_id}. Call again with confirm: true to actually post.`,
            },
          ],
        };
      }
      const result = await client.addSubmissionComment(course_id, assignment_id, comment);
      return { content: [{ type: "text", text: `Comment added. Id: ${result.id}` }] };
    }
  );

  return server;
}

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
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
