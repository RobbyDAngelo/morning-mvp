// Tracks what got pushed where on which day. Drives idempotency for the
// Tier 5 sync layer: same-day re-runs update rather than duplicate, and
// unsync.mjs uses these records to roll back.
//
// State at data/sync-state.json. Shape:
//   {
//     version: 1,
//     days: {
//       "2026-05-11": {
//         notion: { page_id, url, pushed_at } | null,
//         calendar: [{ event_id, calendar_name, title, start, end, pushed_at }],
//         reminders: [{ list_name, name, pushed_at }]
//       }
//     }
//   }

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNC_PATH = resolve(__dirname, "..", "data", "sync-state.json");
const VERSION = 1;

export async function loadSync() {
  if (!existsSync(SYNC_PATH)) return { version: VERSION, days: {} };
  try {
    const raw = JSON.parse(await readFile(SYNC_PATH, "utf8"));
    if (!raw.days) raw.days = {};
    if (!raw.version) raw.version = VERSION;
    return raw;
  } catch {
    return { version: VERSION, days: {} };
  }
}

export async function saveSync(state) {
  await mkdir(dirname(SYNC_PATH), { recursive: true });
  await writeFile(SYNC_PATH, JSON.stringify(state, null, 2));
}

export function ensureDay(state, date) {
  if (!state.days[date]) state.days[date] = { notion: null, calendar: [], reminders: [] };
  return state.days[date];
}

export function recordNotion(state, date, { page_id, url }, now = new Date()) {
  const d = ensureDay(state, date);
  d.notion = { page_id, url, pushed_at: now.toISOString() };
  return state;
}

export function recordCalendarEvent(state, date, event, now = new Date()) {
  const d = ensureDay(state, date);
  d.calendar = d.calendar.filter((e) => e.title !== event.title); // idempotency
  d.calendar.push({ ...event, pushed_at: now.toISOString() });
  return state;
}

export function recordReminder(state, date, reminder, now = new Date()) {
  const d = ensureDay(state, date);
  d.reminders = d.reminders.filter(
    (r) => !(r.name === reminder.name && r.list_name === reminder.list_name),
  );
  d.reminders.push({ ...reminder, pushed_at: now.toISOString() });
  return state;
}

export function getDay(state, date) {
  return state.days[date] ?? null;
}

export function clearDay(state, date) {
  delete state.days[date];
  return state;
}
