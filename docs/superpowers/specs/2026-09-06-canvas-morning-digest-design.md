# Canvas Morning Digest — Design Spec

Date: 2026-09-06

## Goal

Send the user a single email every morning at 7am (Mountain Time) containing:
1. Canvas assignments due in the next 7 days that aren't yet submitted.
2. Canvas calendar events for today (class meeting times, if BYU syncs them
   into Canvas).
3. Today's personal Google Calendar events.
4. One freshly-written motivational quote themed around a business-minded
   mindset.

This is the `canvas-reminder` piece explicitly deferred as future work in
`docs/superpowers/specs/2026-09-06-canvas-connector-design.md`, now scoped
concretely.

## Non-goals

- Not a general-purpose notification system — one fixed email, one fixed
  time, one recipient (the user's own Gmail).
- Not pulling class schedule from anywhere other than Canvas's own calendar
  (no separate registrar/SIS integration).
- No configurability (time, lookahead window, quote theme) beyond what's
  specified here — those are fixed choices, not settings, for this version.
- No web UI, no reply-to-unsubscribe handling, no digest history/archive.

## Background

Evaluated three approaches (see chat) and chose a hybrid: reuse the
already-built, already-tested `CanvasClient` for the Canvas half (assignments
+ Canvas calendar), and let the scheduled agent itself handle Google
Calendar, the quote, and sending — since those need live MCP tool calls
(Google Calendar and Gmail connectors, already authenticated on this
account) that a standalone script can't make on its own without duplicating
authentication that already exists.

## Architecture

A new script in the existing `canvas-connector` repo, run once daily by a
scheduled cloud agent built with the `schedule` skill:

```
canvas-connector/
  src/
    canvasClient.ts        # existing, unchanged
    reminder/
      digest.ts            # new: Canvas half of the digest
    mcp/                    # existing, unchanged
  docs/superpowers/specs/
```

**`src/reminder/digest.ts`** — a standalone script (not an MCP tool, not
going through `src/mcp/server.ts`). Constructs a `CanvasClient` from
`CANVAS_API_TOKEN`/`CANVAS_DOMAIN` env vars (same pattern as
`src/mcp/config.ts`'s `loadConfigFromEnv`), then:
- Calls `listCourses()`, then `listAssignments(courseId)` for each active
  course, filters to assignments with `due_at` in the next 7 days AND
  `submission?.workflow_state` not `"submitted"` (or missing).
- Calls `listCalendarEvents(todayStart, todayEnd)` for today's Canvas
  calendar events.
- Prints a plain-text formatted block to stdout: an "Upcoming Assignments"
  section and a "Today's Canvas Schedule" section. No email formatting, no
  HTML — just readable plain text the calling agent will fold into the
  final email.
- On any Canvas API failure, prints a one-line error to stderr and exits
  non-zero, rather than a stack trace — the calling agent's prompt is
  responsible for still sending an email noting "couldn't reach Canvas
  today" rather than treating a non-zero exit as a reason to send nothing.

**Scheduled agent** (created via the `schedule` skill, cron at 7am Mountain
Time, daily): a prompt that:
1. Runs `node dist/reminder/digest.ts` and captures stdout (and notes if it
   exited non-zero, per the error-handling note above).
2. Calls the Google Calendar MCP tool for today's personal events. On
   failure, notes "couldn't reach Google Calendar today" rather than
   failing the whole digest.
3. Writes one fresh, short motivational quote in the mindset of a business
   leader (Claude generates this itself — no external quote API or curated
   list).
4. Composes one email combining all of the above into readable sections,
   and sends it via the Gmail MCP tool to the user's connected Gmail
   address.

## Auth / config

`digest.ts` needs the same two values `canvas-mcp` needs:
`CANVAS_API_TOKEN` and `CANVAS_DOMAIN`. Where these live in the scheduled
agent's cloud execution environment (a secret store, an env var configured
through the `schedule` skill, etc.) is an implementation detail to resolve
when setting up the schedule itself — the `schedule` skill will be invoked
for that as part of building this, and is expected to have its own
mechanism for this. Not a blocker for this design.

The Google Calendar and Gmail connectors are already authenticated at the
account level (visible as connected in `claude mcp list`) — no new auth
needed for those.

## Data flow

```
cron trigger (7am MT, daily)
  -> scheduled agent starts
  -> runs `node dist/reminder/digest.ts`
       -> CanvasClient.listCourses()
       -> CanvasClient.listAssignments(courseId) per course
       -> CanvasClient.listCalendarEvents(todayStart, todayEnd)
       -> prints formatted text block (or an error to stderr, exit non-zero)
  -> agent calls Google Calendar MCP tool for today
  -> agent writes one motivational quote
  -> agent composes one email (assignments + Canvas schedule + Google
     Calendar + quote)
  -> agent sends via Gmail MCP tool
```

## Error handling

- Canvas failures: `digest.ts` never lets a raw error escape to stdout —
  same `CanvasApiError` discipline as `canvas-mcp`. A failure there is
  reported on stderr with a human-readable message; the agent still sends
  an email, with that section replaced by a one-line "couldn't reach Canvas
  this morning" note.
- Google Calendar failures: same idea — noted in the email, doesn't block
  sending the rest.
- If literally everything fails (Canvas AND Google Calendar), still send an
  email with just the quote and a note that both data sources were
  unreachable today, rather than sending nothing and leaving the user
  guessing whether the schedule even ran.

## Testing

- `digest.ts` gets unit tests in the same style as `canvasClient.test.ts` —
  mocked `CanvasClient` calls (or mocked fetch, consistent with existing
  test patterns), asserting the formatted text output for: normal case,
  no upcoming assignments, no calendar events today, and a Canvas API
  failure (asserting the non-zero exit + stderr message, not a crash).
- The full email flow (Google Calendar lookup, quote generation, Gmail
  send) is verified with one manual trial run — triggered by hand, not
  waiting for the actual 7am schedule — before the cron schedule is turned
  on for real.

## Defaults

- Send time: 7:00 AM Mountain Time, daily.
- Assignment lookahead: next 7 days, unsubmitted only.
- Canvas calendar scope: today only.
- Google Calendar scope: today only.
- Recipient: the user's connected Gmail address.
- Quote: freshly written by Claude each morning, business-mindset theme.
