#!/usr/bin/env node
// Creates today's "Deep work: <The One Thing>" event in Calendar.app via
// AppleScript. Idempotent within the day: if an event with the same title
// already exists today (verified via sync-state.json), no duplicate is made.
//
// Usage:
//   push-calendar.mjs --title "Deep work: ..." [--start "HH:MM"] [--minutes 90]
//                     [--calendar "Work"] [--dry-run]

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSync, saveSync, recordCalendarEvent, getDay } from "./sync-state.mjs";
import { parseArgs, flagEnabled } from "./lib/cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 60_000;
const IS_MAC = (process.env.MORNING_MVP_PLATFORM || process.platform) === "darwin";

function runAppleScript(script) {
  return new Promise((resolveP, reject) => {
    const child = spawn("/usr/bin/osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Calendar osascript timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolveP(stdout.trim());
      reject(new Error(`Calendar osascript ${code}: ${stderr.trim() || "no output"}`));
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

function asString(s) {
  return '"' + String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const args = parseArgs();

const title = args.title ?? "Deep work";
const minutes = Math.max(15, Math.min(Number(args.minutes ?? 90), 240));
const calendarName = args.calendar ?? null;
const dryRun = flagEnabled(args["dry-run"]);

// Apple Calendar push is macOS-only (osascript). On Windows/Linux the
// calendar deep-work block is created via the Google Calendar MCP in the
// workflow, not this script. Skip cleanly instead of crashing.
if (!IS_MAC && !dryRun) {
  process.stdout.write(
    JSON.stringify({ skipped: true, reason: "Apple Calendar push is macOS-only", title }, null, 2),
  );
  process.exit(0);
}

const today = new Date().toISOString().slice(0, 10);

// Idempotency: if today's sync state already records this title, exit OK.
const sync = await loadSync();
const day = getDay(sync, today);
if (day?.calendar?.some((e) => e.title === title)) {
  process.stdout.write(
    JSON.stringify({ skipped: true, reason: "already pushed today", title }, null, 2),
  );
  process.exit(0);
}

// Compute start time. If --start HH:MM provided, use today at that time.
// Otherwise pick the next quarter-hour at least 5 minutes from now.
let startDate = new Date();
if (args.start) {
  const m = args.start.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    process.stderr.write(`bad --start (expected HH:MM, got ${args.start})\n`);
    process.exit(2);
  }
  startDate.setHours(Number(m[1]), Number(m[2]), 0, 0);
} else {
  startDate.setMinutes(Math.ceil((startDate.getMinutes() + 5) / 15) * 15, 0, 0);
}
const endDate = new Date(startDate.getTime() + minutes * 60 * 1000);

if (dryRun) {
  process.stdout.write(
    JSON.stringify(
      {
        dry_run: true,
        title,
        calendar: calendarName ?? "(default writable)",
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// AppleScript: pick the named calendar if given, else the first writable one.
const pickCalendarScript = calendarName
  ? `set targetCal to first calendar whose name is ${asString(calendarName)}`
  : `set writableCals to (every calendar whose writable is true)
if (count of writableCals) = 0 then error "no writable calendars"
set targetCal to first item of writableCals`;

const startMonth = startDate.getMonth() + 1;
const endMonth = endDate.getMonth() + 1;
const script = `
tell application "Calendar"
  ${pickCalendarScript}
  set startDate to current date
  set year of startDate to ${startDate.getFullYear()}
  set month of startDate to ${startMonth}
  set day of startDate to ${startDate.getDate()}
  set hours of startDate to ${startDate.getHours()}
  set minutes of startDate to ${startDate.getMinutes()}
  set seconds of startDate to 0
  set endDate to current date
  set year of endDate to ${endDate.getFullYear()}
  set month of endDate to ${endMonth}
  set day of endDate to ${endDate.getDate()}
  set hours of endDate to ${endDate.getHours()}
  set minutes of endDate to ${endDate.getMinutes()}
  set seconds of endDate to 0
  set newEvent to make new event at end of events of targetCal with properties {summary:${asString(title)}, start date:startDate, end date:endDate, description:"Created by morning-mvp"}
  return (uid of newEvent) & "|" & (name of targetCal)
end tell
`;

const out = await runAppleScript(script);
const [eventId, calName] = out.split("|");
recordCalendarEvent(sync, today, {
  event_id: eventId,
  calendar_name: calName,
  title,
  start: startDate.toISOString(),
  end: endDate.toISOString(),
});
await saveSync(sync);

process.stdout.write(
  JSON.stringify(
    { created: true, event_id: eventId, calendar: calName, title, start: startDate.toISOString(), end: endDate.toISOString() },
    null,
    2,
  ),
);
