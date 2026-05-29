// Persistent state for the morning-mvp skill. Tracks first-seen / last-seen
// / closed timestamps per item so we can compute slow-burn (aging) signals
// and detect when something has been resolved without polling the source.
//
// State lives in data/state.json relative to the skill root. Schema:
//   {
//     version: 1,
//     items: {
//       "<id>": {
//         id: "...",
//         kind: "waiting_mail" | "promise_made" | "basecamp_todo" | "decision",
//         title: "...",
//         counterparty: "...",
//         first_seen_at: "2026-05-03T...",
//         last_seen_at: "2026-05-10T...",
//         closed_at: null | "...",
//         source_date: "..."
//       }
//     }
//   }

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, "..", "data", "state.json");

const SCHEMA_VERSION = 1;

export function stableId(parts) {
  // Hash an array of strings to a stable item id. Order matters.
  const h = createHash("sha1");
  for (const p of parts) h.update(String(p ?? "")).update("");
  return h.digest("hex").slice(0, 16);
}

export async function loadState() {
  if (!existsSync(STATE_PATH)) return { version: SCHEMA_VERSION, items: {} };
  try {
    const raw = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (!raw.items) raw.items = {};
    if (!raw.version) raw.version = SCHEMA_VERSION;
    return raw;
  } catch {
    return { version: SCHEMA_VERSION, items: {} };
  }
}

export async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// Reconcile current run's surfaced items with stored state. Mutates state.items.
//
// `currentItems` is an array of {id, kind, title, counterparty, source_date, ...payload}.
// Items already in state get last_seen_at bumped.
// Items NOT in current set get marked closed (closed_at = now) on first absence.
// New items get first_seen_at = now.
export function reconcile(state, currentItems, now = new Date()) {
  const isoNow = now.toISOString();
  const currentIds = new Set(currentItems.map((i) => i.id));

  for (const item of currentItems) {
    const prev = state.items[item.id];
    if (prev) {
      prev.last_seen_at = isoNow;
      prev.closed_at = null; // reappeared after closure: reopen
      prev.title = item.title;
      prev.counterparty = item.counterparty;
      prev.payload = item.payload ?? prev.payload;
    } else {
      state.items[item.id] = {
        id: item.id,
        kind: item.kind,
        title: item.title,
        counterparty: item.counterparty,
        source_date: item.source_date ?? null,
        first_seen_at: isoNow,
        last_seen_at: isoNow,
        closed_at: null,
        payload: item.payload ?? null,
      };
    }
  }

  // Close anything we tracked previously that didn't appear this run.
  for (const [id, item] of Object.entries(state.items)) {
    if (currentIds.has(id)) continue;
    if (!item.closed_at) item.closed_at = isoNow;
  }
  return state;
}

const HOURS = 60 * 60 * 1000;

// Compute slow-burn items. Per-kind thresholds. Returns items aged past
// their threshold, sorted oldest-first, only items not currently closed.
export function slowBurn(state, now = new Date()) {
  const thresholds = {
    waiting_mail: 3 * 24,        // 3 days for direct mail waiting
    promise_made: 5 * 24,        // 5 days for a promise Robby made
    basecamp_todo: 7 * 24,       // 7 days for a Basecamp todo without movement
    decision: 4 * 24,            // 4 days for a pending decision
    default: 7 * 24,
  };
  const out = [];
  for (const item of Object.values(state.items)) {
    if (item.closed_at) continue;
    const ageH = (now.getTime() - new Date(item.first_seen_at).getTime()) / HOURS;
    const threshold = thresholds[item.kind] ?? thresholds.default;
    if (ageH >= threshold) {
      out.push({
        ...item,
        age_hours: Math.round(ageH),
        age_days: Math.round(ageH / 24),
        threshold_hours: threshold,
      });
    }
  }
  out.sort((a, b) => b.age_hours - a.age_hours);
  return out;
}
