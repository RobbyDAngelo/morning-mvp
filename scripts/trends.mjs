// Week-over-week trend tracking. Snapshots key brief metrics at the end of
// each week so Sunday's recap can show deltas and the rest of the week can
// show "this week vs last week" sparklines.
//
// State at data/trends.json. Shape:
//   {
//     version: 1,
//     weeks: [
//       {
//         week_start: "2026-05-04",
//         snapshot_at: "2026-05-10T23:59:00Z",
//         metrics: {
//           waiting_count: 4,
//           decisions: 0,
//           responses: 4,
//           promises_open: 5,
//           slow_burn: 0,
//           mail_volume: 123,
//           active_threads: 2,
//           vip_touchpoints: 7,
//           drafted_replies: 3
//         },
//         mission: "..."
//       },
//       ...
//     ]
//   }

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRENDS_PATH = resolve(__dirname, "..", "data", "trends.json");
const VERSION = 1;
const MAX_WEEKS = 12; // Keep 12 weeks of history (about 3 months).

export async function loadTrends() {
  if (!existsSync(TRENDS_PATH)) return { version: VERSION, weeks: [] };
  try {
    const raw = JSON.parse(await readFile(TRENDS_PATH, "utf8"));
    if (!raw.weeks) raw.weeks = [];
    if (!raw.version) raw.version = VERSION;
    return raw;
  } catch {
    return { version: VERSION, weeks: [] };
  }
}

export async function saveTrends(state) {
  await mkdir(dirname(TRENDS_PATH), { recursive: true });
  await writeFile(TRENDS_PATH, JSON.stringify(state, null, 2));
}

// Record (or update) the snapshot for the current week. If the week already
// has a snapshot, replace it with the more recent metrics (each run within
// the same week refreshes the snapshot).
export function recordSnapshot(state, weekStart, metrics, mission, now = new Date()) {
  const existing = state.weeks.find((w) => w.week_start === weekStart);
  if (existing) {
    existing.snapshot_at = now.toISOString();
    existing.metrics = metrics;
    existing.mission = mission ?? existing.mission;
  } else {
    state.weeks.push({
      week_start: weekStart,
      snapshot_at: now.toISOString(),
      metrics,
      mission: mission ?? null,
    });
  }
  state.weeks.sort((a, b) => a.week_start.localeCompare(b.week_start));
  if (state.weeks.length > MAX_WEEKS) {
    state.weeks = state.weeks.slice(-MAX_WEEKS);
  }
  return state;
}

export function previousWeek(state, currentWeekStart) {
  const idx = state.weeks.findIndex((w) => w.week_start === currentWeekStart);
  if (idx <= 0) return null;
  return state.weeks[idx - 1];
}

// Compute week-over-week deltas for the current week vs previous.
export function deltas(state, currentWeekStart) {
  const cur = state.weeks.find((w) => w.week_start === currentWeekStart);
  const prev = previousWeek(state, currentWeekStart);
  if (!cur || !prev) return null;
  const out = {};
  for (const key of Object.keys(cur.metrics)) {
    out[key] = (cur.metrics[key] ?? 0) - (prev.metrics[key] ?? 0);
  }
  return out;
}

// Build a tiny ASCII sparkline for the LAST N weeks of one metric.
// Uses block characters from low to high. Useful as one inline glance.
export function sparkline(state, metricKey, weeks = 8) {
  const recent = state.weeks.slice(-weeks).map((w) => Number(w.metrics?.[metricKey] ?? 0));
  if (recent.length === 0) return "";
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  const range = max - min || 1;
  return recent
    .map((v) => {
      const idx = Math.min(blocks.length - 1, Math.floor(((v - min) / range) * (blocks.length - 1)));
      return blocks[idx];
    })
    .join("");
}
