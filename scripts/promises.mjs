// Extracts promises Robby made, from two sources:
//
//   1. Notion call notes: action items where Robby is the actor.
//      Pattern: "Robby to <verb> ..." or "Robby and X to <verb> ..." or
//      "Robby will ..." inside the meeting summary.
//
//   2. Sent mail in the window: messages Robby sent that contain commitment
//      language. "I'll <verb>", "I will <verb>", "By <day>, I'll <verb>",
//      "Sending you <thing>", etc. We capture the commitment text and the
//      recipient as the audience.
//
// Returns array of {kind:"promise_made", title, counterparty, source, source_date}
// suitable for feeding into state.reconcile() and rendering.

import { stableId } from "./state.mjs";

// Notion patterns. The user's call-note summaries use checkbox lists
// "- [ ] Robby to do X" and inline "Robby to do X" prose.
const NOTION_RE = /\b(Robby\s+(?:to\s+|will\s+|is\s+going\s+to\s+|and\s+\w+\s+to\s+)[^.\n;\[\]]+)/gi;

// Sent-mail commitment patterns. First-person commitment language.
const SENT_RE = [
  /\b(I['']?ll\s+[^.\n;]+)/gi,
  /\b(I\s+will\s+[^.\n;]+)/gi,
  /\b(I[''m]+\s+(?:going to|gonna)\s+[^.\n;]+)/gi,
  /\bby\s+(?:tomorrow|today|tonight|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[, ]+(?:I[''l]+l?\s+|I\s+will\s+)([^.\n;]+)/gi,
];

const STOP_PHRASES = [
  /^I['']?ll be\s+(out|away|in)/i,           // OOO not a commitment
  /^I['']?ll let you know\s+(when|if)/i,     // verbal acknowledgment
  /^I will not\b/i,                          // refusal
];

function isCommitment(text) {
  const t = text.trim();
  if (t.length < 8 || t.length > 280) return false;
  for (const re of STOP_PHRASES) if (re.test(t)) return false;
  return true;
}

export function extractNotionPromises(notionResults) {
  const out = [];
  for (const n of notionResults ?? []) {
    // Path 1 (preferred): explicit `commitments_robby_made` array. If the
    // upstream Notion-fetch step curated commitments into a clean list, use
    // those verbatim; they don't need regex extraction and are higher
    // signal than parsing prose.
    if (Array.isArray(n.commitments_robby_made)) {
      for (const phrase of n.commitments_robby_made) {
        const text = String(phrase ?? "").trim();
        if (!isCommitment(text)) continue;
        out.push({
          id: stableId(["notion", n.id, text.slice(0, 60)]),
          kind: "promise_made",
          title: text.slice(0, 200),
          counterparty: (n.people ?? []).join(", ") || n.project || "team",
          source: `notion:${n.title}`,
          source_url: n.url,
          source_date: n.date,
          payload: { notion_id: n.id, notion_title: n.title, explicit: true },
        });
      }
    }
    // Path 2 (fallback): regex-extract "Robby to ..." from highlight prose
    // when no curated array exists. Runs ALWAYS so prose mentions still get
    // captured even alongside an explicit list; prefix-dedup below collapses
    // duplicates.
    const text = `${n.title}\n${n.highlight ?? ""}`;
    let m;
    NOTION_RE.lastIndex = 0;
    while ((m = NOTION_RE.exec(text))) {
      const phrase = m[1].replace(/\s+/g, " ").trim();
      if (!isCommitment(phrase)) continue;
      out.push({
        id: stableId(["notion", n.id, phrase.slice(0, 60)]),
        kind: "promise_made",
        title: phrase.slice(0, 200),
        counterparty: (n.people ?? []).join(", ") || n.project || "team",
        source: `notion:${n.title}`,
        source_url: n.url,
        source_date: n.date,
        payload: { notion_id: n.id, notion_title: n.title },
      });
    }
  }
  // Prefix-aware dedupe: if one commitment phrase is a prefix of another from
  // the SAME source note, keep only the longer (more specific) one.
  // "Robby to discuss compensation" gets dropped in favor of
  // "Robby to discuss compensation with Dave" from the same note.
  out.sort((a, b) => b.title.length - a.title.length);
  const kept = [];
  for (const p of out) {
    const sameSourceLonger = kept.find((k) => {
      const sameSource = k.payload?.notion_id === p.payload?.notion_id;
      const isPrefix = k.title.toLowerCase().startsWith(p.title.toLowerCase());
      return sameSource && isPrefix && k.title !== p.title;
    });
    if (sameSourceLonger) continue;
    kept.push(p);
  }
  return kept;
}

export function extractSentMailPromises(sentMessages) {
  const out = [];
  for (const m of sentMessages ?? []) {
    const body = m.preview || m.body || "";
    if (!body) continue;
    for (const re of SENT_RE) {
      let mm;
      re.lastIndex = 0;
      while ((mm = re.exec(body))) {
        const phrase = mm[1].replace(/\s+/g, " ").trim();
        if (!isCommitment(phrase)) continue;
        out.push({
          id: stableId(["sent", m.message_id || m.subject, phrase.slice(0, 60)]),
          kind: "promise_made",
          title: phrase.slice(0, 200),
          counterparty: m.recipients_to || "(unknown recipient)",
          source: `mail:sent:${m.subject ?? ""}`,
          source_date: m.date_received,
          payload: { message_id: m.message_id, subject: m.subject, account: m.account },
        });
      }
    }
  }
  const seen = new Set();
  return out.filter((p) => {
    const key = `${p.counterparty}::${p.title.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractAllPromises({ notion, sent }) {
  return [...extractNotionPromises(notion), ...extractSentMailPromises(sent)];
}
