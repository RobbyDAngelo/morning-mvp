// Google Calendar provider (cross-platform, MCP-via-workflow).
//
// Same pattern as gmail.mjs and fantastical.mjs. Standalone Node returns a
// "needs MCP" marker; Claude in the workflow makes the MCP call and saves
// the result via scripts/save-calendar-events.mjs (which already handles
// the Google Calendar event shape since phase 3).
//
// First-run setup:
//   1. Install a Google-Calendar-capable Claude Code plugin.
//   2. Run the plugin's authenticate command on first use.
//   3. Re-run the morning brief.

export async function collectCalendar({ hours, config: _config = {} } = {}) {
  const windowHours = Math.max(1, Math.min(Number(hours ?? 36), 168));

  return {
    provider: "google-calendar",
    skipped: true,
    requires_mcp: true,
    window_hours: windowHours,
    events: [],
    source: "google-calendar",
    mcp_hint: {
      strategy: "fetch_via_claude_session",
      reason: "Google Calendar data lives behind a Claude-Code plugin MCP.",
      data_needed: {
        events: {
          intent: `All events on the user's primary and shared calendars from now to now+${windowHours} hours.`,
          window_hours: windowHours,
          target_field: "events",
        },
      },
      candidate_mcp_tools: [
        "mcp__plugin_small-business_google_calendar__list_events",
        "mcp__pipedream-gmail__google_calendar-list-events",
        "mcp__d4c8b32a-1328-4483-8a11-e8fa23ade9a4__list_events",
      ],
      save_command:
        "node scripts/save-calendar-events.mjs --raw <raw-DATE.json> --file <gcal-response.json>",
    },
  };
}
