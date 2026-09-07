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
