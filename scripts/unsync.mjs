#!/usr/bin/env node
// Rolls back a day's pushes. Removes Calendar event(s), deletes the
// associated Reminders, flags the Notion page for Claude to delete via MCP
// (since MCP is needed for Notion deletes), and clears the sync-state record.
//
// Usage:
//   unsync.mjs --date YYYY-MM-DD [--dry-run]
//
// Output: JSON describing what was removed (or would be in dry-run).

import { spawn } from "node:child_process";
import { loadSync, saveSync, getDay, clearDay } from "./sync-state.mjs";

const TIMEOUT_MS = 60_000;

function runAppleScript(script) {
  return new Promise((resolveP, reject) => {
    const child = spawn("/usr/bin/osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`osascript timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolveP(stdout.trim());
      reject(new Error(`osascript ${code}: ${stderr.trim() || "no output"}`));
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

function asString(s) {
  return '"' + String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);

if (!args.date) {
  process.stderr.write("usage: unsync.mjs --date YYYY-MM-DD [--dry-run]\n");
  process.exit(2);
}
const dryRun = args["dry-run"] !== undefined && args["dry-run"] !== "false";

const sync = await loadSync();
const day = getDay(sync, args.date);
if (!day) {
  process.stdout.write(JSON.stringify({ found: false, date: args.date }, null, 2));
  process.exit(0);
}

const report = { date: args.date, dry_run: dryRun, calendar_removed: [], reminders_removed: [], notion_flag: null };

if (!dryRun) {
  // Calendar events
  for (const ev of day.calendar ?? []) {
    try {
      await runAppleScript(`
tell application "Calendar"
  set calRef to first calendar whose name is ${asString(ev.calendar_name)}
  set ev to (first event of calRef whose uid is ${asString(ev.event_id)})
  delete ev
end tell
return "ok"
`);
      report.calendar_removed.push(ev.title);
    } catch (err) {
      report.calendar_removed.push({ title: ev.title, error: err.message });
    }
  }
  // Reminders
  for (const r of day.reminders ?? []) {
    try {
      await runAppleScript(`
tell application "Reminders"
  set rList to (first list whose name is ${asString(r.list_name)})
  set rem to (first reminder of rList whose name is ${asString(r.name)})
  delete rem
end tell
return "ok"
`);
      report.reminders_removed.push(r.name);
    } catch (err) {
      report.reminders_removed.push({ name: r.name, error: err.message });
    }
  }
  // Notion page: can't delete from Node (MCP only). Flag for Claude.
  if (day.notion) {
    report.notion_flag = {
      page_id: day.notion.page_id,
      url: day.notion.url,
      instruction:
        "Call Notion MCP to archive this page, then re-run unsync.mjs to clear the sync state.",
    };
  }
  if (!day.notion) {
    clearDay(sync, args.date);
    await saveSync(sync);
  }
} else {
  report.calendar_removed = (day.calendar ?? []).map((ev) => ev.title);
  report.reminders_removed = (day.reminders ?? []).map((r) => r.name);
  if (day.notion) report.notion_flag = day.notion;
}

process.stdout.write(JSON.stringify(report, null, 2));
