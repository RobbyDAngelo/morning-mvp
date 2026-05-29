// "One Thing" candidate scoring. Picks the top N items across all categories
// (waiting-on-me, 48h deadline, promise-the-user-made, slow-burn) and emits a
// ranked list with impact_signal text for each. The LLM in the skill workflow
// then chooses exactly one survivor from the top 5.
//
// The point of pre-scoring in code: keep the LLM's job to discrimination, not
// search. The LLM cannot read all 80 messages and find the lever; the code can.
//
// Identity-aware: the commitment extractor needs the user's first name to
// detect "<First> to do X" patterns in Notion call notes. Pass `identity`
// from identity-resolver.mjs (loaded by filter-rank.mjs); defaults to
// `{ first_name: "Robby" }` for backward compatibility with the original
// pre-multi-user code path.

// Inlined to keep morning-mvp self-contained. Same parser as apple-mail-mcp's
// src/utils/dates.ts, covered by tests there. Apple's locale date string
// looks like "Tuesday, March 3, 2026 at 7:54:34 AM"; Date.parse rejects the
// leading weekday and the " at " separator.
const WEEKDAY_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,\s*/i;
function parseAppleDate(input) {
  if (!input) return NaN;
  const cleaned = input.replace(WEEKDAY_RE, "").replace(/\s+at\s+/i, " ").trim();
  const t = Date.parse(cleaned);
  if (!Number.isNaN(t)) return t;
  return Date.parse(input);
}

const HOURS = 60 * 60 * 1000;

export function scoreOneThingCandidates({
  rankedMessages,
  waiting_on_me,
  deadline_48h_mail,
  basecamp_48h,
  notion,
  vipSet,
  identity,
}) {
  const now = Date.now();
  const candidates = [];
  const firstName = identity?.first_name || identity?.firstName || "Robby";

  // Category A: waiting-on-me items, weighted by VIP, urgency, recency.
  for (const m of waiting_on_me ?? []) {
    const ageHours = Math.max(0, (now - (parseAppleDate(m.date_received) || now)) / HOURS);
    const vipBoost = vipSet.has(m.sender_email) ? 6 : 0;
    const urgencyBoost = (m.urgency_score ?? 0) * 1.5;
    // Older waiting-on-me items get a small staleness boost: someone has been
    // waiting longer, the cost of not replying grows. Capped to avoid letting
    // 7-day-old items dominate.
    const staleBoost = Math.min(ageHours / 24, 5);
    candidates.push({
      id: `wait:${m.message_id}`,
      category: "waiting_on_me",
      title: m.subject || "(no subject)",
      counterparty: m.sender,
      date: m.date_received,
      account: m.account,
      mailbox: m.mailbox,
      message_id: m.message_id,
      impact_signal: vipBoost
        ? `VIP correspondent (${m.sender_email}) is waiting; thread is ${Math.round(ageHours)}h old.`
        : `${m.sender_email} is waiting; thread is ${Math.round(ageHours)}h old.`,
      score: vipBoost + urgencyBoost + staleBoost + (m.priority ?? 0),
    });
  }

  // Category B: 48h deadlines from mail.
  for (const m of deadline_48h_mail ?? []) {
    candidates.push({
      id: `deadline:${m.message_id}`,
      category: "deadline_48h",
      title: m.subject || "(no subject)",
      counterparty: m.sender,
      date: m.date_received,
      account: m.account,
      message_id: m.message_id,
      impact_signal: `Explicit ${m.deadline_hours_ahead}h deadline detected in message.`,
      score: 10 + (vipSet.has(m.sender_email) ? 3 : 0),
    });
  }

  // Category C: 48h Basecamp deadlines.
  for (const b of basecamp_48h ?? []) {
    candidates.push({
      id: `bc:${b.id}`,
      category: "deadline_48h",
      title: b.title,
      counterparty: `Basecamp / ${b.project}`,
      date: b.due_on,
      impact_signal: `Basecamp todo due ${b.due_on}.`,
      score: 9,
    });
  }

  // Category D: promises the user made, surfaced from Notion call note action
  // items where the action verb has the user as the subject. We detect this in
  // the Notion `highlight` text via heuristic patterns.
  for (const n of notion ?? []) {
    const text = `${n.title} ${n.highlight ?? ""}`;
    const myCommitments = extractMyCommitments(text, firstName);
    for (const c of myCommitments) {
      candidates.push({
        id: `promise:${n.id}:${c.slice(0, 30)}`,
        category: "promise_made",
        title: c.slice(0, 120),
        counterparty: (n.people ?? []).join(", ") || "team",
        date: n.date,
        impact_signal: `From "${n.title}" (${n.date}): you committed to this.`,
        score: 7 + ageBoostFromDate(n.date, now),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 10);
}

// Find sentences/phrases where the named user is the actor. Identity-driven:
// firstName comes from identity-resolver.mjs (~/CLAUDE.md h1).
//
// Exported for unit testing; production callers go through
// scoreOneThingCandidates which threads `identity` to here.
export function extractMyCommitments(text, firstName = "Robby") {
  if (!text) return [];
  const out = [];
  // Escape the first name for regex inclusion. Almost everyone's first name
  // is plain word chars, but apostrophes (D'Angelo's son, e.g. "Angelo") and
  // hyphens (Anne-Marie) are common enough to guard.
  const safe = firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b(${safe} (?:to |and \\w+ to |will |is going to )[^.\\n;]+)`,
    "gi",
  );
  let m;
  while ((m = re.exec(text))) {
    out.push(m[1].replace(/\s+/g, " ").trim());
    if (out.length >= 5) break;
  }
  return out;
}

function ageBoostFromDate(dateStr, now) {
  const t = parseAppleDate(dateStr) || Date.parse(dateStr);
  if (!t || Number.isNaN(t)) return 0;
  const days = Math.max(0, (now - t) / (24 * HOURS));
  return Math.min(days * 0.5, 4);
}

export function pickDraftTargets(waiting_on_me, n = 3) {
  // Top N by priority. Caller fetches full bodies for these.
  return [...(waiting_on_me ?? [])]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, n)
    .map((m) => ({
      message_id: m.message_id,
      sender: m.sender,
      sender_email: m.sender_email,
      subject: m.subject,
      date: m.date_received,
      account: m.account,
      mailbox: m.mailbox,
      priority: m.priority,
    }));
}
