#!/usr/bin/env node
// Pushes morning-mvp items into Apple Reminders via AppleScript.
// Idempotent: same-name same-list reminders aren't duplicated.
//
// Usage:
//   push-reminders.mjs --ranked path/to/ranked.json [--list "Morning MVP"] [--dry-run]
//
// Items pushed:
//   - All slow_burn items (anything aged past per-kind threshold)
//   - All 48h deadlines
//   - All open promises older than 2 days
//
// Why this list and not waiting_on_me: waiting items are already handled
// by the brief's "drafted replies" section (Robby acts on them today).
// Reminders target stuff that's at risk of slipping through cracks.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadSync, saveSync, recordReminder, getDay } from "./sync-state.mjs";
import { parseArgs, flagEnabled } from "./lib/cli.mjs";

const TIMEOUT_MS = 60_000;
const DEFAULT_LIST = "Morning MVP";
const IS_MAC = (process.env.MORNING_MVP_PLATFORM || process.platform) === "darwin";

function runAppleScript(script) {
  return new Promise((resolveP, reject) => {
    const child = spawn("/usr/bin/osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Reminders osascript timed out after ${TIMEOUT_MS}ms`));
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
      reject(new Error(`Reminders osascript ${code}: ${stderr.trim() || "no output"}`));
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

function asString(s) {
  return '"' + String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const args = parseArgs();

if (!args.ranked) {
  process.stderr.write("usage: push-reminders.mjs --ranked path/to/ranked.json [--list NAME] [--dry-run]\n");
  process.exit(2);
}

const dryRun = flagEnabled(args["dry-run"]);
const listName = args.list ?? DEFAULT_LIST;
const today = new Date().toISOString().slice(0, 10);

// Apple Reminders push is macOS-only (osascript). Skip cleanly elsewhere.
if (!IS_MAC && !dryRun) {
  process.stdout.write(
    JSON.stringify({ skipped: true, reason: "Apple Reminders push is macOS-only" }, null, 2),
  );
  process.exit(0);
}

let ranked;
try {
  ranked = JSON.parse(await readFile(args.ranked, "utf8"));
} catch (err) {
  process.stderr.write(`[push-reminders] cannot read ranked file ${args.ranked}: ${err.message}\n`);
  process.exit(1);
}

// Decide what gets pushed.
const items = [];
for (const s of ranked.slow_burn ?? []) {
  items.push({
    name: `[Slow burn ${s.age_days}d] ${s.title}`.slice(0, 200),
    notes: `Aging past threshold (${s.kind}, ${s.age_days}d). Source: ${s.counterparty ?? "?"}`,
  });
}
for (const m of ranked.deadline_48h_mail ?? []) {
  items.push({
    name: `[48h] ${m.subject}`.slice(0, 200),
    notes: `From ${m.sender}. Account: ${m.account}.`,
  });
}
for (const p of ranked.promises_made ?? []) {
  if ((p.days_open ?? 0) < 2) continue; // skip fresh ones; they're in the brief
  items.push({
    name: `[Promise ${p.days_open}d] ${p.title}`.slice(0, 200),
    notes: `Made to ${p.counterparty}. Source: ${p.source ?? "?"}`,
  });
}

if (items.length === 0) {
  process.stdout.write(JSON.stringify({ skipped: true, reason: "no items to push", list: listName }, null, 2));
  process.exit(0);
}

// Idempotency: filter out items already pushed (any day) AND not yet completed.
const sync = await loadSync();
const day = getDay(sync, today);
const alreadyPushedToday = new Set((day?.reminders ?? []).map((r) => r.name));
const fresh = items.filter((i) => !alreadyPushedToday.has(i.name));

if (dryRun) {
  process.stdout.write(
    JSON.stringify(
      { dry_run: true, list: listName, would_push: fresh.length, items: fresh },
      null,
      2,
    ),
  );
  process.exit(0);
}

// AppleScript: ensure list exists, then create each reminder. The script
// creates the list if missing (idempotent) and skips duplicates by name.
const itemsAS = fresh
  .map(
    (i) =>
      `try
  set existing to (first reminder of targetList whose name is ${asString(i.name)})
on error
  make new reminder at end of reminders of targetList with properties {name:${asString(i.name)}, body:${asString(i.notes)}}
end try`,
  )
  .join("\n");

const script = `
tell application "Reminders"
  set targetList to missing value
  try
    set targetList to (first list whose name is ${asString(listName)})
  end try
  if targetList is missing value then
    set targetList to (make new list with properties {name:${asString(listName)}})
  end if
  ${itemsAS}
end tell
return "ok"
`;

try {
  await runAppleScript(script);
  for (const i of fresh) {
    recordReminder(sync, today, { name: i.name, list_name: listName });
  }
  await saveSync(sync);
  process.stdout.write(
    JSON.stringify({ created: fresh.length, list: listName, items: fresh.map((i) => i.name) }, null, 2),
  );
} catch (err) {
  process.stderr.write(`[push-reminders] failed: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ error: err.message, list: listName }, null, 2));
  process.exit(1);
}
