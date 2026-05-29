#!/usr/bin/env node
// Enriches ranked.json with body previews so the LLM workflow can write
// real one-sentence summaries per unreplied item.
//
// Why a separate script from enrich-drafts.mjs:
//   - drafts need the FULL body (~2500 chars) for 3 messages so Claude can
//     compose a real reply.
//   - summaries need a SHORTER preview (~600 chars) for ~25 messages so
//     Claude can write "what this email is about" in one sentence.
//
// The two needs read from the same getMessage() function but with different
// limits and different concurrency. Keeping them separate makes each one
// fast, tuneable, and independently cacheable.
//
// Parallelism: cap of 4 concurrent osascript calls. Higher numbers risk
// wedging Mail.app's AppleEvent queue (observed during earlier integration
// tests). Lower numbers stretch runtime past 30s.
//
// Usage:
//   enrich-summaries.mjs --ranked path/to/ranked.json
//                        [--max 25] [--body-limit 600] [--concurrency 4]

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
  process.stderr.write("usage: enrich-summaries.mjs --ranked path/to/ranked.json [--max 25] [--body-limit 600] [--concurrency 4]\n");
  process.exit(2);
}
const MAX_ITEMS = Math.max(1, Math.min(Number(args.max ?? 25), 100));
const BODY_LIMIT = Math.max(200, Math.min(Number(args["body-limit"] ?? 600), 5000));
const CONCURRENCY = Math.max(1, Math.min(Number(args.concurrency ?? 4), 8));

const { getMessage } = await import(`${APPLE_MAIL_ROOT}/src/mail/messages.ts`);

const ranked = JSON.parse(await readFile(args.ranked, "utf8"));

// Collect unique message_ids across every bucket that benefits from a summary.
// Priority order: waiting_on_me, decisions_waiting, responses_waiting, then
// the unreplied lists inside people_view rows. We stop at MAX_ITEMS unique
// ids to bound runtime.
const ids = new Map(); // message_id -> { account, mailbox } hint for fast lookup
function consider(items) {
  for (const m of items ?? []) {
    if (!m?.message_id) continue;
    if (ids.has(m.message_id)) continue;
    if (ids.size >= MAX_ITEMS) return;
    ids.set(m.message_id, { account: m.account, mailbox: m.mailbox });
  }
}
consider(ranked.waiting_on_me);
consider(ranked.decisions_waiting);
consider(ranked.responses_waiting);
for (const p of ranked.people_view ?? []) {
  consider((p.mail?.unreplied ?? []).slice(0, 5));
}

const ENRICH_KEYS = [...ids.keys()];
// Wall-clock budget. Mail.app's `messages of mb whose message id is X` scan
// is expensive on huge mailboxes; under load each call can take 30-60s. We
// don't want enrichment to block the brief by more than this. Items not
// fetched in time will render with subject-only fallback summaries.
const BUDGET_MS = Math.max(15_000, Math.min(Number(args["budget-ms"] ?? 90_000), 600_000));
process.stderr.write(
  `[enrich-summaries] fetching previews for ${ENRICH_KEYS.length} unique messages (concurrency=${CONCURRENCY}, body_limit=${BODY_LIMIT}, budget=${BUDGET_MS}ms)...\n`,
);

const tStart = Date.now();
const budgetReached = () => Date.now() - tStart >= BUDGET_MS;

// Promise pool: keep at most CONCURRENCY in flight at any time, AND stop
// taking new work once the wall-clock budget is reached.
const previews = new Map();
async function pump() {
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < ENRICH_KEYS.length && !budgetReached()) {
      const i = nextIdx++;
      const id = ENRICH_KEYS[i];
      const hint = ids.get(id);
      try {
        const full = await getMessage({
          message_id: id,
          account: hint.account,
          mailbox: hint.mailbox,
          body_limit: BODY_LIMIT,
        });
        if (full?.body) previews.set(id, { body_preview: full.body, body_truncated: full.body_truncated });
      } catch (err) {
        previews.set(id, { error: err.message?.split("\n")[0] });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}
const t0 = Date.now();
await pump();
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// Merge previews into every place the message_id appears.
function mergeInto(items) {
  if (!items) return 0;
  let count = 0;
  for (const m of items) {
    const p = previews.get(m.message_id);
    if (p?.body_preview) {
      m.body_preview = p.body_preview;
      m.body_truncated = p.body_truncated;
      count += 1;
    }
  }
  return count;
}
let touched = 0;
touched += mergeInto(ranked.waiting_on_me);
touched += mergeInto(ranked.decisions_waiting);
touched += mergeInto(ranked.responses_waiting);
for (const p of ranked.people_view ?? []) {
  touched += mergeInto(p.mail?.unreplied);
}
ranked.summaries_enriched_at = new Date().toISOString();
ranked.summaries_enriched_count = previews.size;

await writeFile(args.ranked, JSON.stringify(ranked, null, 2));
const ok = [...previews.values()].filter((v) => v.body_preview).length;
process.stderr.write(
  `[enrich-summaries] enriched ${ok}/${ENRICH_KEYS.length} in ${elapsed}s, merged into ${touched} occurrences\n`,
);
