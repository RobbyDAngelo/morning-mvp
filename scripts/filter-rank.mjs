#!/usr/bin/env node
// Reads the raw mail JSON (and optional Notion + Basecamp JSON), applies the
// newsletter filter, builds the replied-index, scores each message, and writes
// a ranked JSON ready for the LLM synthesis pass and for the renderer.

import { writeFile } from "node:fs/promises";
import { isLikelyNewsletter, isPersonalSender } from "./filters.mjs";
import { buildVipSet, buildRepliedIndex, rankMessages } from "./rank.mjs";
import { buildPeopleView } from "./people.mjs";
import { scoreOneThingCandidates, pickDraftTargets } from "./one-thing.mjs";
import { extractAllPromises } from "./promises.mjs";
import { tagItemsWithKind } from "./decisions.mjs";
import { loadState, saveState, reconcile, slowBurn, stableId } from "./state.mjs";
import {
  loadFacts,
  saveFacts,
  harvestFactsFromMessages,
  getFacts,
} from "./people-facts.mjs";
import { loadTrends, saveTrends, recordSnapshot } from "./trends.mjs";
import { loadWeekState, mondayOf, decideAction } from "./weekly-arc.mjs";
import { buildRecapData } from "./recap.mjs";
import { loadResolvedIdentity } from "./identity-resolver.mjs";
import { loadConfig } from "./lib/load-config.mjs";
import { readJson } from "./lib/cli.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);
if (!args.raw || !args.out) {
  process.stderr.write("usage: filter-rank.mjs --raw raw.json [--notion n.json] [--basecamp b.json] --out out.json\n");
  process.exit(2);
}

// Per-user filter overrides (always_drop_senders / always_drop_domains /
// always_include_*) from config.local.json filters block. Empty when
// unconfigured, so behavior is unchanged on a fresh install.
const filterOverrides = (await loadConfig())?.filters ?? {};

let rawRoot;
let notion;
let basecamp;
try {
  rawRoot = await readJson(args.raw, { label: "raw data file" });
  // collect-all wraps mail and basecamp under named keys. Accept both shapes:
  // the orchestrator output `{mail: {...}, basecamp: {...}}` or the raw mail
  // output directly.
  notion = args.notion ? await readJson(args.notion, { label: "notion file" }) : null;
  basecamp = args.basecamp
    ? await readJson(args.basecamp, { label: "basecamp file" })
    : rawRoot.basecamp ?? null;
} catch (err) {
  process.stderr.write(`[filter-rank] ${err.message}\n`);
  process.exit(1);
}
const raw = rawRoot.mail ?? rawRoot;

const inbound = [...(raw.unread || []), ...(raw.recent_inbox || [])];

// Dedupe by message_id (a message can appear in both unread and recent).
const seen = new Set();
const deduped = [];
for (const m of inbound) {
  const key = m.message_id || `${m.account}|${m.subject}|${m.date_received}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(m);
}

// Step 1: drop obvious newsletters / notifications.
const dropped = [];
const survivors = [];
for (const m of deduped) {
  const verdict = isLikelyNewsletter(m, filterOverrides);
  if (verdict.drop) {
    dropped.push({ message_id: m.message_id, subject: m.subject, sender: m.sender, reasons: verdict.reasons });
    continue;
  }
  survivors.push(m);
}

// Step 2: build VIP set + replied index.
const vipSet = buildVipSet(survivors, raw.sent_in_window ?? []);
const repliedIndex = buildRepliedIndex(survivors, raw.sent_in_window ?? []);

// Step 3: score and rank.
const ranked = rankMessages(survivors, { repliedIndex, vipSet });

// Step 4: split into buckets the LLM and renderer consume directly.
const waiting_on_me = ranked.filter((m) => m.waiting_on_me);
const deadline_48h_mail = ranked.filter((m) => m.has_deadline_48h && !m.waiting_on_me);

// Active threads: messages with subjects that have 3+ entries in window AND
// involve a personal sender (rough multi-round-trip heuristic).
const threadCounts = new Map();
for (const m of [...survivors, ...(raw.sent_in_window ?? [])]) {
  const k = (m.subject ?? "").replace(/^(re|fwd):\s*/i, "").trim().toLowerCase();
  if (!k) continue;
  if (!threadCounts.has(k)) threadCounts.set(k, []);
  threadCounts.get(k).push(m);
}
const active_threads = [...threadCounts.entries()]
  .filter(([, msgs]) => msgs.length >= 3 && msgs.some((x) => isPersonalSender(x.sender)))
  .map(([subj, msgs]) => {
    const latest = msgs
      .map((x) => ({ ...x, _t: Date.parse((x.date_received || "").replace(/^[A-Za-z]+,\s*/, "").replace(/\s+at\s+/, " ")) }))
      .sort((a, b) => (b._t || 0) - (a._t || 0))[0];
    return {
      subject: subj,
      messages: msgs.length,
      latest_from: latest.sender,
      latest_date: latest.date_received,
      account: latest.account,
    };
  })
  .sort((a, b) => b.messages - a.messages)
  .slice(0, 8);

// Basecamp 48h deadlines:
const basecamp_48h = (basecamp?.todos ?? []).filter((t) => {
  if (!t.due_on) return false;
  const due = Date.parse(`${t.due_on}T17:00:00`);
  return due - Date.now() <= 48 * 60 * 60 * 1000 && due - Date.now() >= -24 * 60 * 60 * 1000;
});

// Tier 1 additions:
//   - people_view: collapse mail + notion + basecamp by canonical counterparty
//   - one_thing_candidates: pre-scored top 10 across categories for the LLM to pick from
//   - draft_reply_targets: top 3 waiting-on-me items, enriched downstream with full bodies
const people_view = buildPeopleView({
  inbound: ranked,
  threads: active_threads,
  notion: notion?.results ?? [],
  basecamp,
  vipSet,
  repliedIndex,
});

// Load resolved identity once (from <skill-root>/identity.local.json, written
// by scripts/identity-resolver.mjs at install). Threaded into scorers and
// stamped onto the ranked output so SKILL.md's LLM step can compose drafts
// in the right voice.
const identity = await loadResolvedIdentity();
if (!identity.first_name) {
  // Name-anchored commitment extraction ("<First> to do X" in Notion notes)
  // needs the user's first name. Surface it instead of silently defaulting.
  process.stderr.write(
    "[filter-rank] no first_name in identity.local.json; promise extraction from " +
      "Notion notes will be limited. Run `node scripts/identity-resolver.mjs` " +
      "after setting your name in CLAUDE.md.\n",
  );
}

const one_thing_candidates = scoreOneThingCandidates({
  rankedMessages: ranked,
  waiting_on_me,
  deadline_48h_mail,
  basecamp_48h,
  notion: notion?.results ?? [],
  vipSet,
  identity,
});

const draft_reply_targets = pickDraftTargets(waiting_on_me, 3);

// Tier 2: classify each waiting item as decision vs response.
const waiting_classified = tagItemsWithKind(waiting_on_me);
const decisions_waiting = waiting_classified.filter((w) => w.decision_or_response === "decision");
const responses_waiting = waiting_classified.filter((w) => w.decision_or_response === "response");

// Tier 2: extract promises the user made from Notion + Sent mail.
const promises_raw = extractAllPromises({
  notion: notion?.results ?? [],
  sent: raw.sent_in_window ?? [],
  identity,
});

// Tier 3: reconcile persistent state. The reconciliation also captures the
// waiting list (for slow-burn aging) and Basecamp todos as trackable items.
const state = await loadState();
const trackable = [
  ...waiting_classified.map((w) => ({
    id: stableId(["wait", w.message_id || `${w.account}|${w.subject}|${w.date_received}`]),
    kind: w.decision_or_response === "decision" ? "decision" : "waiting_mail",
    title: w.subject || "(no subject)",
    counterparty: w.sender || w.sender_email || "",
    source_date: w.date_received,
    payload: { message_id: w.message_id, account: w.account, mailbox: w.mailbox },
  })),
  ...promises_raw.map((p) => ({
    id: p.id,
    kind: "promise_made",
    title: p.title,
    counterparty: p.counterparty,
    source_date: p.source_date,
    payload: { source: p.source, source_url: p.source_url },
  })),
  ...((basecamp?.todos ?? []).map((t) => ({
    id: stableId(["bc", t.id]),
    kind: "basecamp_todo",
    title: t.title || "(untitled)",
    counterparty: `Basecamp / ${t.project ?? "?"}`,
    source_date: t.due_on,
    payload: { url: t.url, due_on: t.due_on },
  }))),
];
reconcile(state, trackable);
await saveState(state);
const slow_burn_items = slowBurn(state);

// Age each promise from when the commitment was actually made (source_date
// from the Notion call note or sent-mail date), not from when state first
// saw it. Otherwise a freshly-initialized state.json makes everything look
// like a 0-day-old commitment even when it was promised a week ago.
const promises_with_age = promises_raw.map((p) => {
  const tracked = state.items[p.id];
  // Prefer the explicit source_date; fall back to first_seen_at; cap at 365d.
  let baseline = null;
  if (p.source_date) {
    const t = Date.parse(p.source_date);
    if (!Number.isNaN(t)) baseline = t;
  }
  if (baseline === null && tracked?.first_seen_at) {
    baseline = new Date(tracked.first_seen_at).getTime();
  }
  if (baseline === null) baseline = Date.now();
  const days_open = Math.max(0, Math.min(365, Math.floor((Date.now() - baseline) / (24 * 60 * 60 * 1000))));
  return {
    ...p,
    first_seen_at: tracked?.first_seen_at ?? null,
    days_open,
  };
});

// Tier 4: harvest person facts from this week's mail (rule-based patterns).
// LLM-narrative facts get added by the SKILL.md workflow Claude step after
// generating the brief. Both flow into the same people-facts.json.
const facts = await loadFacts();
const factsAdded = harvestFactsFromMessages(facts, [
  ...(raw.recent_inbox ?? []),
  ...(raw.sent_in_window ?? []),
]);
await saveFacts(facts);

// Tier 4: attach facts to each person_view row so the brief renders them
// directly under "Where it stands".
for (const p of people_view) {
  const personFacts = getFacts(facts, p.counterparty_email, 5);
  p.facts = personFacts.map((f) => ({
    text: f.text,
    source: f.source,
    last_confirmed_at: f.last_confirmed_at,
  }));
}

// Tier 4: record this week's trend snapshot (replaces same-week entry on
// each run; rolling 12-week history).
const trends = await loadTrends();
const weekState = await loadWeekState();
const weekStartIso = mondayOf().toISOString().slice(0, 10);
const vip_touchpoints = people_view.filter((p) => p.vip).length;
const trendMetrics = {
  waiting_count: waiting_on_me.length,
  decisions: decisions_waiting.length,
  responses: responses_waiting.length,
  promises_open: promises_with_age.length,
  slow_burn: slow_burn_items.length,
  mail_volume: deduped.length,
  active_threads: active_threads.length,
  vip_touchpoints,
  drafted_replies: draft_reply_targets.length,
};
recordSnapshot(trends, weekStartIso, trendMetrics, weekState.current?.mission);
await saveTrends(trends);

// Tier 4: weekly recap data when arc says it's recap time (Sunday) or when
// explicitly requested.
const arcDecision = decideAction(weekState);
const recap_data = arcDecision.action === "offer_recap" || args["force-recap"]
  ? await buildRecapData()
  : null;

// Derived headline metrics for the top-of-brief blockquote line. These come
// straight from data already computed; no extra system calls. Custom external
// metrics still flow through collect-metrics.mjs.
const headline_metrics = [
  {
    label: "People waiting on you",
    value: String(waiting_on_me.length),
    formatted: `${waiting_on_me.length} ${waiting_on_me.length === 1 ? "person" : "people"} waiting on a reply`,
  },
  {
    label: "Open commitments you made",
    value: String(promises_with_age.length),
    formatted: `${promises_with_age.length} open commitments ${promises_with_age.length > 0 ? `(oldest ${Math.max(...promises_with_age.map((p) => p.days_open))}d)` : ""}`.trim(),
  },
  {
    label: "Slow-burn items",
    value: String(slow_burn_items.length),
    formatted: slow_burn_items.length === 0
      ? `nothing aging past threshold`
      : `${slow_burn_items.length} item${slow_burn_items.length === 1 ? "" : "s"} past aging threshold`,
  },
];

const out = {
  generated_at: new Date().toISOString(),
  window_days: raw.window_days,
  identity: {
    // Stamped from identity.local.json. SKILL.md's LLM step reads this to
    // compose drafts in the user's voice. Hard rules are universal (per
    // README) but persona / signoff vary per user.
    name: identity.name || "",
    first_name: identity.first_name || "",
    email: identity.email || "",
    role: identity.role || "",
    signoff: identity.signoff || "",
    persona_hints: identity.persona_hints || [],
  },
  totals: {
    raw_inbound: deduped.length,
    dropped_as_noise: dropped.length,
    survivors: survivors.length,
    waiting_on_me: waiting_on_me.length,
    decisions_waiting: decisions_waiting.length,
    responses_waiting: responses_waiting.length,
    deadline_48h_mail: deadline_48h_mail.length,
    active_threads: active_threads.length,
    people: people_view.length,
    one_thing_candidates: one_thing_candidates.length,
    draft_targets: draft_reply_targets.length,
    promises_made: promises_with_age.length,
    slow_burn: slow_burn_items.length,
    state_tracked: Object.keys(state.items).length,
    person_facts_added_this_run: factsAdded,
    person_facts_total: Object.values(facts.facts).reduce((n, list) => n + list.length, 0),
    trend_weeks_recorded: trends.weeks.length,
  },
  headline_metrics,
  waiting_on_me,
  decisions_waiting,
  responses_waiting,
  deadline_48h_mail,
  active_threads,
  notion: notion ?? { skipped: true, reason: "no notion file supplied" },
  basecamp: basecamp ?? { skipped: true, reason: "no basecamp file supplied" },
  basecamp_48h,
  people_view,
  one_thing_candidates,
  draft_reply_targets,
  promises_made: promises_with_age,
  slow_burn: slow_burn_items,
  recap_data,
  trends: { weeks: trends.weeks, current_week_start: weekStartIso },
  ranked_all: ranked.slice(0, 80),
  dropped: dropped.slice(0, 200),
  vip_senders: [...vipSet],
};

await writeFile(args.out, JSON.stringify(out, null, 2));
process.stderr.write(
  `[filter-rank] dropped ${dropped.length}/${deduped.length} as noise. ` +
    `waiting=${waiting_on_me.length} (D:${decisions_waiting.length}/R:${responses_waiting.length}), ` +
    `48h=${deadline_48h_mail.length}, threads=${active_threads.length}, ` +
    `promises=${promises_with_age.length}, slow_burn=${slow_burn_items.length}, people=${people_view.length}\n`,
);
