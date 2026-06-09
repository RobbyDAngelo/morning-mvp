// Apple Calendar provider (macOS only).
//
// Pulls events from Calendar.app via AppleScript. Same permission model as
// apple-mail-mcp: Automation > Calendar. This is the fallback path; the
// preferred path is the Fantastical provider (see fantastical.mjs).
//
// Cross-platform note: hard-fails on non-Darwin. Windows / Linux installs
// should use google-calendar.mjs or outlook-graph.mjs.

import { spawn } from "node:child_process";
import { platform } from "node:os";

// Calendar.app's per-calendar date scan is slow on large histories; 60s was
// timing out. Default 120s, dedicated override knob. Fantastical MCP is the
// preferred fast path; this is the fallback.
const TIMEOUT_MS = Number(
  process.env.MORNING_MVP_CALENDAR_TIMEOUT_MS ?? process.env.APPLE_MAIL_MCP_TIMEOUT_MS ?? 120_000,
);
const REC_SEP = "";
const FIELD_SEP = "";

function runAppleScript(script) {
  return new Promise((resolveP, reject) => {
    const child = spawn("/usr/bin/osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`calendar osascript timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolveP(stdout);
      reject(new Error(`calendar osascript ${code}: ${stderr.trim() || "no output"}`));
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

/**
 * Collect calendar events from Calendar.app.
 *
 * @param {object} opts
 * @param {number} opts.hours   Window forward in hours, 1-168.
 * @param {object} [opts.config]   Parsed config (unused).
 * @returns {Promise<CalendarResult>}
 *
 * CalendarResult shape (contract every calendar provider must honor):
 *   {
 *     provider: string,         // "apple-calendar"
 *     window_hours: number,
 *     events: [Event],
 *     source: "apple-calendar",
 *   }
 *
 * Event shape:
 *   { calendar, title, start, end, location, attendees: [string], notes_preview }
 */
export async function collectCalendar({ hours, config: _config = {} } = {}) {
  if (platform() !== "darwin") {
    throw new Error(
      `apple-calendar provider requires macOS, current platform is ${platform()}. ` +
        `Switch to a cross-platform provider in config.local.json providers.calendar.`,
    );
  }

  const windowHours = Math.max(1, Math.min(Number(hours ?? 36), 168));

  const script = `
set recSep to (character id 30)
set fldSep to (character id 31)
set windowHours to ${windowHours}
set startDate to (current date)
set endDate to startDate + (windowHours * hours)
set output to ""
tell application "Calendar"
  repeat with cal in calendars
    try
      set calName to name of cal
      set evs to (every event of cal whose start date >= startDate and start date <= endDate)
      repeat with ev in evs
        try
          set evTitle to summary of ev
        on error
          set evTitle to "(no title)"
        end try
        try
          set evLoc to location of ev as string
        on error
          set evLoc to ""
        end try
        try
          set evNotes to description of ev as string
          if (length of evNotes) > 300 then set evNotes to (text 1 thru 300 of evNotes)
        on error
          set evNotes to ""
        end try
        try
          set evStart to (start date of ev) as string
        on error
          set evStart to ""
        end try
        try
          set evEnd to (end date of ev) as string
        on error
          set evEnd to ""
        end try
        try
          set attendList to attendees of ev
          set attEmails to {}
          repeat with a in attendList
            try
              set end of attEmails to (email of a) as string
            end try
          end repeat
          set AppleScript's text item delimiters to ","
          set attStr to attEmails as string
          set AppleScript's text item delimiters to ""
        on error
          set attStr to ""
        end try
        set evTitle to my flatten(evTitle)
        set evLoc to my flatten(evLoc)
        set evNotes to my flatten(evNotes)
        set output to output & calName & fldSep & evTitle & fldSep & evStart & fldSep & evEnd & fldSep & evLoc & fldSep & attStr & fldSep & evNotes & recSep
      end repeat
    on error errMsg
      -- skip calendars that error (shared calendars sometimes do)
    end try
  end repeat
end tell
return output

on flatten(s)
  set AppleScript's text item delimiters to {return, linefeed, tab}
  set parts to text items of s
  set AppleScript's text item delimiters to " "
  set j to parts as string
  set AppleScript's text item delimiters to ""
  return j
end flatten
`;

  let raw;
  try {
    raw = await runAppleScript(script);
  } catch (err) {
    return {
      provider: "apple-calendar",
      skipped: true,
      reason: err.message,
      window_hours: windowHours,
      events: [],
      source: "apple-calendar",
    };
  }

  const events = raw
    .replace(/\s+$/, "")
    .split(REC_SEP)
    .filter((s) => s.length > 0)
    .map((row) => {
      const [calendar, title, start, end, location, attendees, notes_preview] = row.split(FIELD_SEP);
      return {
        calendar: calendar ?? "",
        title: title ?? "",
        start: start ?? "",
        end: end ?? "",
        location: location ?? "",
        attendees: attendees ? attendees.split(",").filter(Boolean) : [],
        notes_preview: notes_preview ?? "",
      };
    });

  // Drop events without a title (Apple sometimes returns empty placeholders).
  const cleaned = events.filter((e) => e.title.trim() && e.title !== "(no title)");

  return {
    provider: "apple-calendar",
    window_hours: windowHours,
    events: cleaned,
    source: "apple-calendar",
  };
}
