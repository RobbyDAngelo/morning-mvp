#!/usr/bin/env node
// Enriches the ranked JSON's draft_reply_targets with full message bodies
// fetched via apple-mail-mcp's getMessage. The LLM step in the skill workflow
// uses these bodies to compose 3-sentence replies in Robby's voice.
//
// Reads ranked-DATE.json, mutates it in place by replacing draft_reply_targets
// with body-enriched entries plus a prior_thread excerpt where possible.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const APPLE_MAIL_ROOT = resolve(homedir(), "apple-mail-mcp");
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

const { getMessage } = await import(`${APPLE_MAIL_ROOT}/src/mail/messages.ts`);

const ranked = JSON.parse(await readFile(args.ranked, "utf8"));
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
