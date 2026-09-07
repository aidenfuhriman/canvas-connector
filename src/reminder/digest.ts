import { CanvasClient, type Course, type Assignment, type CalendarEvent } from "../canvasClient.js";

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
