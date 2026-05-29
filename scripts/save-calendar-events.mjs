#!/usr/bin/env node
// Merges Fantastical-format calendar events into raw-DATE.json under
// raw.calendar.events. Called by the skill workflow AFTER Claude pulls
// events via mcp__Fantastical__queryCalendarItems.
//
// Why this exists: MCP tools live in Claude's tool space, not Node's. Claude
// calls Fantastical, gets a JSON payload, then runs this script to commit
// the events into the same shape filter-rank expects.
//
// Usage:
//   save-calendar-events.mjs --raw path/to/raw.json --json '<JSON string>'
//   save-calendar-events.mjs --raw path/to/raw.json --file events.json
//
// Accepts both Fantastical and AppleScript shapes; normalizes to:
//   { calendar, title, start, end, location, attendees[], notes_preview }

import { readFile, writeFile } from "node:fs/promises";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);
if (!args.raw || (!args.json && !args.file)) {
  process.stderr.write(
    "usage: save-calendar-events.mjs --raw raw.json (--json '<json>' | --file events.json)\n",
  );
  process.exit(2);
}

let payload;
try {
  const text = args.file ? await readFile(args.file, "utf8") : args.json;
  payload = JSON.parse(text);
} catch (err) {
  process.stderr.write(`[save-calendar-events] could not parse input: ${err.message}\n`);
  process.exit(1);
}

// Accept any of:
//   - Fantastical:        { items: [...], timezone }
//   - AppleScript:        { events: [...], window_hours, generated_at }
//   - Google Calendar:    { items: [{summary, start: {dateTime|date}, end, ...}] }
//   - Pre-flattened MCP:  { events: [...] }
//   - Bare array:         [...]
const events = Array.isArray(payload)
  ? payload
  : payload.items ?? payload.events ?? payload.data ?? [];

/**
 * Normalize a Google Calendar attendee object ({email, displayName,
 * responseStatus}) or a bare-string-email into a flat email string. The rest
 * of the pipeline expects an array of strings under `attendees`.
 */
function normalizeAttendees(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => {
      if (typeof a === "string") return a;
      if (a?.email) return a.email;
      return "";
    })
    .filter(Boolean);
}

// Normalize each event into the canonical morning-mvp shape. Source-aware:
//   - Google Calendar: `summary`, `start.dateTime`/`start.date`, `end.dateTime`,
//                      `attendees: [{email}]`, `organizer.email`, `description`,
//                      `htmlLink`, no `calendarId` (caller must pass it).
//   - Fantastical:     `startDate` / `endDate` (ISO with TZ) and `calendarId`.
//   - AppleScript:     `start` / `end` (Apple-locale strings) and `calendar` (name).
const normalized = events
  .map((ev) => {
    // Google Calendar shape: `summary` + `start.dateTime` is the strongest marker.
    if (ev.summary !== undefined && ev.start && (ev.start.dateTime || ev.start.date)) {
      return {
        source: "google-calendar",
        calendar: ev.calendarId || ev.organizer?.email || "",
        title: ev.summary || "",
        start: ev.start.dateTime || ev.start.date || "",
        end: ev.end?.dateTime || ev.end?.date || "",
        location: ev.location || "",
        attendees: normalizeAttendees(ev.attendees),
        notes_preview: (ev.description || "").slice(0, 300),
        google_id: ev.id || "",
        html_link: ev.htmlLink || "",
        status: ev.status || "confirmed",
      };
    }
    if (ev.startDate || ev.calendarId) {
      // Fantastical shape.
      return {
        source: "fantastical",
        calendar: ev.calendarId || "",
        title: ev.title || "",
        start: ev.startDate || "",
        end: ev.endDate || "",
        location: ev.location || "",
        attendees: normalizeAttendees(ev.attendees),
        notes_preview: ev.notes || ev.description || "",
        fantastical_id: ev.id || "",
      };
    }
    // AppleScript / pre-normalized shape; pass through.
    return {
      source: ev.source || "applescript",
      calendar: ev.calendar || "",
      title: ev.title || "",
      start: ev.start || "",
      end: ev.end || "",
      location: ev.location || "",
      attendees: normalizeAttendees(ev.attendees),
      notes_preview: ev.notes_preview || "",
    };
  })
  .filter((ev) => ev.title && ev.title !== "(no title)")
  // Drop declined invites; matches the existing skip-declined behavior.
  .filter((ev) => ev.status !== "declined");

const raw = JSON.parse(await readFile(args.raw, "utf8"));
raw.calendar = {
  generated_at: new Date().toISOString(),
  source: normalized[0]?.source || "fantastical",
  window_hours: args.hours ? Number(args.hours) : 36,
  events: normalized,
};
await writeFile(args.raw, JSON.stringify(raw, null, 2));
process.stderr.write(
  `[save-calendar-events] merged ${normalized.length} event(s) into ${args.raw}\n`,
);
process.stdout.write(
  JSON.stringify({ merged: normalized.length, source: raw.calendar.source }, null, 2),
);
