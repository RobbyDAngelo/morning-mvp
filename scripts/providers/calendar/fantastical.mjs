// Fantastical provider (macOS only, MCP-via-workflow).
//
// Fantastical does NOT have a standalone API the way Apple Calendar
// AppleScript does. Its data is reached via the Fantastical MCP server
// (Claude Desktop extension). That means this provider can't run from a
// standalone Node script: it requires Claude to call
// `mcp__Fantastical__queryCalendarItems` mid-workflow and then write the
// results back via scripts/save-calendar-events.mjs.
//
// The dispatcher in scripts/collect-calendar.mjs checks `result.skipped`
// and `result.requires_mcp` to decide whether to fall back to
// apple-calendar.mjs or surface a "needs Claude workflow" hint.

import { platform } from "node:os";

export async function collectCalendar({ hours, config: _config = {} } = {}) {
  const windowHours = Math.max(1, Math.min(Number(hours ?? 36), 168));

  if (platform() !== "darwin") {
    return {
      provider: "fantastical",
      skipped: true,
      reason: `fantastical provider requires macOS, current platform is ${platform()}`,
      requires_mcp: false,
      window_hours: windowHours,
      events: [],
      source: "fantastical",
    };
  }

  // The standalone collector returns "needs MCP" so the dispatcher can:
  //  1. Try the fallback provider (apple-calendar) for an immediate result.
  //  2. Emit a hint that the Claude-side workflow will overwrite raw.calendar
  //     once it queries Fantastical via MCP and runs save-calendar-events.mjs.
  return {
    provider: "fantastical",
    skipped: true,
    reason: "fantastical requires MCP-via-workflow path; see SKILL.md step 2a",
    requires_mcp: true,
    mcp_call: {
      tool: "mcp__Fantastical__queryCalendarItems",
      args: { query: "", when: `<today> to <today+${Math.ceil(windowHours / 24)} days>` },
    },
    window_hours: windowHours,
    events: [],
    source: "fantastical",
  };
}
