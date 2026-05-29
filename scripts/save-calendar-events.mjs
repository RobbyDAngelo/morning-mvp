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

// Fantastical returns either { items: [...], timezone } or a bare events array.
// AppleScript collector returns { events: [...], window_hours, generated_at }.
const events = Array.isArray(payload)
  ? payload
  : payload.items ?? payload.events ?? [];

// Normalize each event into the canonical morning-mvp shape. Source-aware:
//   - Fantastical events have `startDate` / `endDate` (ISO with TZ) and `calendarId`.
//   - AppleScript events have `start` / `end` (Apple-locale strings) and `calendar` (name).
const normalized = events
  .map((ev) => {
    if (ev.startDate || ev.calendarId) {
      // Fantastical shape.
      return {
        source: "fantastical",
        calendar: ev.calendarId || "",
        title: ev.title || "",
        start: ev.startDate || "",
        end: ev.endDate || "",
        location: ev.location || "",
        attendees: ev.attendees || [], // Fantastical query doesn't include attendees by default
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
      attendees: Array.isArray(ev.attendees) ? ev.attendees : [],
      notes_preview: ev.notes_preview || "",
    };
  })
  .filter((ev) => ev.title && ev.title !== "(no title)");

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
