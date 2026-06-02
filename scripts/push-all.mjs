#!/usr/bin/env node
// Master sync orchestrator. Reads config.local.json `sync.*.enabled` flags
// and runs the enabled targets. Calendar + Reminders run directly here.
// Notion runs as a "prepare" step; the actual MCP call is in SKILL.md.
//
// Usage:
//   push-all.mjs --ranked path/to/ranked.json --brief path/to/brief.md [--dry-run]

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, flagEnabled } from "./lib/cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "config.local.json");

const args = parseArgs();
if (!args.ranked || !args.brief) {
  process.stderr.write("usage: push-all.mjs --ranked X.json --brief Y.md [--dry-run]\n");
  process.exit(2);
}
const dryRun = flagEnabled(args["dry-run"]);

let cfg = {};
if (existsSync(CONFIG_PATH)) {
  try {
    cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    cfg = {};
  }
}
const sync = cfg?.sync ?? {};

function run(scriptName, scriptArgs) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [resolve(__dirname, scriptName), ...scriptArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolveP({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

const today = new Date().toISOString().slice(0, 10);
const results = {};

// Read One Thing from brief for the calendar event title.
const brief = await readFile(args.brief, "utf8");
const oneThingMatch = brief.match(/^# The One Thing\s*\n+([^\n]+)/m);
const oneThingShort = oneThingMatch ? oneThingMatch[1].slice(0, 80) : "Deep work";

if (sync.calendar?.enabled) {
  const cmd = ["--title", `Deep work: ${oneThingShort}`];
  if (sync.calendar.calendar_name) cmd.push("--calendar", sync.calendar.calendar_name);
  if (sync.calendar.start) cmd.push("--start", sync.calendar.start);
  if (sync.calendar.minutes) cmd.push("--minutes", String(sync.calendar.minutes));
  if (dryRun) cmd.push("--dry-run", "true");
  results.calendar = await run("push-calendar.mjs", cmd);
} else {
  results.calendar = { skipped: true, reason: "sync.calendar.enabled not set" };
}

if (sync.reminders?.enabled) {
  const cmd = ["--ranked", args.ranked];
  if (sync.reminders.list_name) cmd.push("--list", sync.reminders.list_name);
  if (dryRun) cmd.push("--dry-run", "true");
  results.reminders = await run("push-reminders.mjs", cmd);
} else {
  results.reminders = { skipped: true, reason: "sync.reminders.enabled not set" };
}

if (sync.notion?.enabled) {
  results.notion = await run("prepare-notion-payload.mjs", ["--brief", args.brief, "--date", today]);
} else {
  results.notion = { skipped: true, reason: "sync.notion.enabled not set" };
}

process.stdout.write(JSON.stringify({ date: today, dry_run: dryRun, results }, null, 2));
