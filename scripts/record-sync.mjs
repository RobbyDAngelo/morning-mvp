#!/usr/bin/env node
// Records a successful sync operation. Used by Claude after calling the
// Notion MCP successfully, so subsequent runs know not to duplicate.
//
// Usage:
//   record-sync.mjs --date YYYY-MM-DD --kind notion --page-id ID --url URL

import { loadSync, saveSync, recordNotion } from "./sync-state.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);

if (!args.date || !args.kind) {
  process.stderr.write("usage: record-sync.mjs --date YYYY-MM-DD --kind notion --page-id ID --url URL\n");
  process.exit(2);
}

const sync = await loadSync();
if (args.kind === "notion") {
  if (!args["page-id"] || !args.url) {
    process.stderr.write("notion record requires --page-id and --url\n");
    process.exit(2);
  }
  recordNotion(sync, args.date, { page_id: args["page-id"], url: args.url });
} else {
  process.stderr.write(`unknown --kind ${args.kind}\n`);
  process.exit(2);
}
await saveSync(sync);
process.stdout.write(JSON.stringify({ recorded: true, date: args.date, kind: args.kind }, null, 2));
