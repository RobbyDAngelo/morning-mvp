#!/usr/bin/env node
// Enriches the ranked JSON's draft_reply_targets with full message bodies
// fetched via apple-mail-mcp's getMessage. The LLM step in the skill workflow
// uses these bodies to compose 3-sentence replies in Robby's voice.
//
// Reads ranked-DATE.json, mutates it in place by replacing draft_reply_targets
// with body-enriched entries plus a prior_thread excerpt where possible.

import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./lib/cli.mjs";
import { homedir } from "node:os";

const APPLE_MAIL_ROOT = process.env.APPLE_MAIL_MCP_ROOT ?? resolve(homedir(), "apple-mail-mcp");
process.env.APPLE_MAIL_MCP_TIMEOUT_MS = process.env.APPLE_MAIL_MCP_TIMEOUT_MS ?? "60000";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);
if (!args.ranked) {
  process.stderr.write("usage: enrich-drafts.mjs --ranked path/to/ranked.json [--body-limit 2500]\n");
  process.exit(2);
}
const bodyLimit = Math.max(500, Math.min(Number(args["body-limit"] ?? 2500), 20000));

// The apple-mail bridge is macOS-only. On Windows/Linux (Gmail provider) full
// draft bodies are fetched by Claude via the mail MCP in the workflow
// (SKILL.md step 5). Skip gracefully here so the brief never breaks. The
// draft targets keep their message_id/sender/subject so the workflow knows
// exactly what to fetch. Set MORNING_MVP_NO_APPLE_MAIL=1 to force this path.
const APPLE_MAIL_AVAILABLE =
  process.platform === "darwin" &&
  existsSync(APPLE_MAIL_ROOT) &&
  process.env.MORNING_MVP_NO_APPLE_MAIL !== "1";
if (!APPLE_MAIL_AVAILABLE) {
  process.stderr.write(
    `[enrich-drafts] apple-mail-mcp not in use (platform=${process.platform}); ` +
      `skipping. Fetch draft-target bodies via the mail MCP in the workflow.\n`,
  );
  process.stdout.write(
    JSON.stringify({
      skipped: true,
      reason: "apple-mail-mcp unavailable",
      platform: process.platform,
      fetch_via: "mail MCP per SKILL.md step 5 (Windows/Gmail path)",
    }) + "\n",
  );
  process.exit(0);
}

const { getMessage } = await import(`${APPLE_MAIL_ROOT}/src/mail/messages.ts`);

let ranked;
try {
  ranked = await readJson(args.ranked, { label: "ranked file" });
} catch (err) {
  process.stderr.write(`[enrich-drafts] ${err.message}\n`);
  process.exit(1);
}
const targets = ranked.draft_reply_targets ?? [];
if (targets.length === 0) {
  process.stderr.write("[enrich-drafts] no draft_reply_targets to enrich, nothing to do\n");
  process.exit(0);
}

process.stderr.write(`[enrich-drafts] fetching bodies for ${targets.length} draft targets...\n`);
const enriched = [];
for (const t of targets) {
  try {
    const full = await getMessage({
      message_id: t.message_id,
      account: t.account,
      mailbox: t.mailbox,
      body_limit: bodyLimit,
    });
    if (!full) {
      enriched.push({ ...t, error: "message_not_found" });
      continue;
    }
    enriched.push({
      ...t,
      sender_full: full.sender,
      recipients_to: full.recipients_to,
      recipients_cc: full.recipients_cc,
      date_received: full.date_received,
      date_sent: full.date_sent,
      body: full.body,
      body_truncated: full.body_truncated,
      body_bytes: full.body_bytes,
      attachments: full.attachments,
    });
  } catch (err) {
    enriched.push({ ...t, error: err.message?.split("\n")[0] });
  }
}

ranked.draft_reply_targets = enriched;
ranked.draft_reply_targets_enriched_at = new Date().toISOString();
await writeFile(args.ranked, JSON.stringify(ranked, null, 2));

const ok = enriched.filter((e) => !e.error).length;
process.stderr.write(`[enrich-drafts] enriched ${ok}/${enriched.length} (full bodies pulled)\n`);
