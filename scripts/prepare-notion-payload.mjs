#!/usr/bin/env node
// Prepares the Notion writeback payload for the morning brief. Reads the
// generated brief markdown and outputs a JSON envelope Claude can pass
// straight into the Notion MCP `notion-create-pages` tool.
//
// Why a separate prepare step: MCP tools must be called by Claude (they live
// in Claude's tool namespace, not Node's). This script does everything that
// CAN be done outside the MCP boundary so Claude's job is one clean tool call.
//
// Usage:
//   prepare-notion-payload.mjs --brief path/to/brief.md --date YYYY-MM-DD
//
// Output JSON shape (printed to stdout):
//   {
//     skipped: false,
//     parent: { page_id|database_url },
//     title: "Morning Brief, <day-of-week>, <Month DD, YYYY>",
//     properties: { Date, "Day of week", "One Thing", "People waiting", ... },
//     content: "<brief markdown body>"
//   }
//   OR { skipped: true, reason: "notion.parent_id not configured" }

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSync, getDay } from "./sync-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "config.local.json");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);

if (!args.brief || !args.date) {
  process.stderr.write("usage: prepare-notion-payload.mjs --brief path/to/brief.md --date YYYY-MM-DD\n");
  process.exit(2);
}

let cfg = {};
if (existsSync(CONFIG_PATH)) {
  try {
    cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    cfg = {};
  }
}

const notionCfg = cfg?.sync?.notion ?? {};
if (!notionCfg.enabled) {
  process.stdout.write(
    JSON.stringify(
      { skipped: true, reason: "sync.notion.enabled is not true in config.local.json" },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (!notionCfg.parent_page_id && !notionCfg.database_url) {
  process.stdout.write(
    JSON.stringify(
      {
        skipped: true,
        reason: "sync.notion needs either parent_page_id or database_url in config.local.json",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const markdown = await readFile(args.brief, "utf8");

// Pull a few high-signal fields out of the brief for Notion properties.
function pickHeadline(re) {
  const m = markdown.match(re);
  return m ? m[1].trim() : "";
}
const oneThing = pickHeadline(/^# The One Thing\s*\n+([^\n]+)/m);
const peopleWaiting = pickHeadline(/People waiting on you\*\*:\s+([^\n]+)/);
const openCommitments = pickHeadline(/Open commitments you made\*\*:\s+([^\n]+)/);

// Idempotency: if today already has a Notion page recorded, return that URL.
const sync = await loadSync();
const day = getDay(sync, args.date);
const existing_url = day?.notion?.url ?? null;
const existing_page_id = day?.notion?.page_id ?? null;

const dateObj = new Date(args.date + "T12:00:00Z");
const dayOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dateObj.getDay()];
const monthName = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][dateObj.getMonth()];
const title = `Morning Brief, ${dayOfWeek}, ${monthName} ${dateObj.getDate()}, ${dateObj.getFullYear()}`;

process.stdout.write(
  JSON.stringify(
    {
      skipped: false,
      parent: notionCfg.database_url
        ? { data_source_url: notionCfg.database_url }
        : { page_id: notionCfg.parent_page_id },
      title,
      properties: {
        Date: args.date,
        "Day of week": dayOfWeek,
        "One Thing": oneThing.slice(0, 200),
        "People waiting": peopleWaiting,
        "Open commitments": openCommitments,
      },
      content: markdown,
      existing_url,
      existing_page_id,
      action: existing_page_id ? "update" : "create",
    },
    null,
    2,
  ),
);
