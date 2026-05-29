#!/usr/bin/env node
// Records that Claude successfully created a calendar event via the
// Fantastical MCP. Updates sync-state.json so unsync.mjs can remove it
// later, and so same-day reruns are idempotent.
//
// Usage:
//   record-calendar-event.mjs --date YYYY-MM-DD --title "..." \
//                             --event-id "<fantastical id>" \
//                             [--calendar "<calendar id or name>"] \
//                             [--start ISO] [--end ISO]

import { loadSync, saveSync, recordCalendarEvent } from "./sync-state.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);

if (!args.date || !args.title || !args["event-id"]) {
  process.stderr.write(
    "usage: record-calendar-event.mjs --date YYYY-MM-DD --title '...' --event-id ID [--calendar X] [--start ISO] [--end ISO]\n",
  );
  process.exit(2);
}

const sync = await loadSync();
recordCalendarEvent(sync, args.date, {
  event_id: args["event-id"],
  calendar_name: args.calendar || "(Fantastical default)",
  title: args.title,
  start: args.start || "",
  end: args.end || "",
  source: "fantastical",
});
await saveSync(sync);
process.stdout.write(
  JSON.stringify({ recorded: true, date: args.date, title: args.title }, null, 2),
);
