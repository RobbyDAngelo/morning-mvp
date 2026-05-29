// Persistent person-facts memory. Each counterparty accumulates short factual
// statements over time, so the morning brief can ground its "Where it stands"
// line in real history instead of one-shot LLM guesses.
//
// State at data/people-facts.json. Shape:
//   {
//     version: 1,
//     facts: {
//       "briantoelle@gmail.com": [
//         { text: "Paid you $520 via Venmo Mar 5", source: "mail",
//           added_at: "2026-05-10T...", last_confirmed_at: "2026-05-10T...",
//           hash: "..." },
//         ...
//       ]
//     }
//   }
//
// Why a separate file: state.json tracks ITEMS (single events), people-facts
// tracks DURABLE TRUTHS about people (relationships, recurring patterns,
// financial history). Different semantics, different cadence, different
// expiry rules. Mixing them would muddy both.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FACTS_PATH = resolve(__dirname, "..", "data", "people-facts.json");
const VERSION = 1;
const MAX_FACTS_PER_PERSON = 25;
const RENDER_FACTS_PER_PERSON = 5;

function factHash(email, text) {
  return createHash("sha1").update(email).update("").update(text).digest("hex").slice(0, 12);
}

function normalizeEmail(e) {
  return (e ?? "").toLowerCase().trim();
}

export async function loadFacts() {
  if (!existsSync(FACTS_PATH)) return { version: VERSION, facts: {} };
  try {
    const raw = JSON.parse(await readFile(FACTS_PATH, "utf8"));
    if (!raw.facts) raw.facts = {};
    if (!raw.version) raw.version = VERSION;
    return raw;
  } catch {
    return { version: VERSION, facts: {} };
  }
}

export async function saveFacts(state) {
  await mkdir(dirname(FACTS_PATH), { recursive: true });
  await writeFile(FACTS_PATH, JSON.stringify(state, null, 2));
}

// Add a fact, deduping by exact text per email. If the fact already exists,
// bumps `last_confirmed_at`. Returns true if the fact is new, false if it
// already existed (so callers can log net-new additions).
export function addFact(state, email, text, source, now = new Date()) {
  const e = normalizeEmail(email);
  if (!e || !text) return false;
  if (!state.facts[e]) state.facts[e] = [];
  const hash = factHash(e, text);
  const isoNow = now.toISOString();
  const existing = state.facts[e].find((f) => f.hash === hash);
  if (existing) {
    existing.last_confirmed_at = isoNow;
    return false;
  }
  state.facts[e].unshift({
    text,
    source,
    added_at: isoNow,
    last_confirmed_at: isoNow,
    hash,
  });
  if (state.facts[e].length > MAX_FACTS_PER_PERSON) {
    state.facts[e] = state.facts[e].slice(0, MAX_FACTS_PER_PERSON);
  }
  return true;
}

export function getFacts(state, email, limit = RENDER_FACTS_PER_PERSON) {
  const e = normalizeEmail(email);
  if (!state.facts[e]) return [];
  // Sort by last_confirmed_at descending (most recently relevant first).
  return [...state.facts[e]]
    .sort((a, b) => (b.last_confirmed_at ?? "").localeCompare(a.last_confirmed_at ?? ""))
    .slice(0, limit);
}

export function getAllFactedEmails(state) {
  return Object.keys(state.facts);
}

// Heuristic extraction patterns. These catch the high-signal recurring facts
// users explicitly mention: payments, recurring meetings, agreements,
// commitments. The LLM step in the workflow handles narrative facts beyond
// these patterns.
const EXTRACT_PATTERNS = [
  // Payments via Venmo, PayPal, etc.
  { re: /paid you\s+\$(\d[\d,.]*)/i, template: (m) => `Paid you $${m[1]}` },
  { re: /sent you\s+\$(\d[\d,.]*)/i, template: (m) => `Sent you $${m[1]}` },
  // Scheduled recurring meetings
  { re: /weekly\s+([A-Z][\w ]+?)(?:\s+sync|\s+meeting|\s+call)\b/i, template: (m) => `Weekly ${m[1]} sync` },
  // Agreements / confirmations
  { re: /\b(?:agreed|confirmed|signed off)\s+(?:on|to)\s+([^.\n;]+)/i, template: (m) => `Agreed to ${m[1].trim()}` },
  // Calendar invitations Robby received that were accepted
  { re: /\bAccepted:\s*(.+?)(?:\s*@|$)/i, template: (m) => `Accepted meeting: ${m[1].trim()}` },
];

// Extract candidate facts from a message body. Returns array of {text, source}.
export function extractFactsFromMessage(msg) {
  const out = [];
  const body = msg.body || msg.preview || msg.subject || "";
  if (!body) return out;
  for (const { re, template } of EXTRACT_PATTERNS) {
    const m = body.match(re);
    if (m) {
      const text = template(m).slice(0, 160).trim();
      if (text.length >= 6) out.push({ text, source: "mail" });
    }
  }
  return out;
}

// Apply extractions across a set of messages, deduping per email.
export function harvestFactsFromMessages(state, messages, now = new Date()) {
  let added = 0;
  for (const m of messages ?? []) {
    const senderEmail = extractEmail(m.sender ?? m.from ?? "");
    if (!senderEmail) continue;
    const candidates = extractFactsFromMessage(m);
    for (const c of candidates) {
      if (addFact(state, senderEmail, c.text, c.source, now)) added += 1;
    }
  }
  return added;
}

function extractEmail(senderRaw) {
  if (!senderRaw) return "";
  const m = senderRaw.match(/<([^>]+)>/);
  return (m ? m[1] : senderRaw).trim().toLowerCase();
}

// Maintenance: clear facts older than ttl_days for a given email or all.
export function pruneFacts(state, ttlDays = 365, now = new Date()) {
  const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [email, list] of Object.entries(state.facts)) {
    const kept = list.filter((f) => {
      const t = new Date(f.last_confirmed_at ?? f.added_at).getTime();
      if (t >= cutoff) return true;
      removed += 1;
      return false;
    });
    if (kept.length === 0) delete state.facts[email];
    else state.facts[email] = kept;
  }
  return removed;
}
