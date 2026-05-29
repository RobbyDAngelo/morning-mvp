// Weekly recap data assembly. On Sunday (or any day, when called), produce
// the data structure the LLM workflow synthesizes into a one-paragraph
// recap and renders into the brief.
//
// The recap is data-rich and opinionated: what closed, what's still open,
// what's new, what aged into slow-burn, mission vs actuals.

import { loadState } from "./state.mjs";
import { loadTrends, previousWeek, sparkline } from "./trends.mjs";
import { loadWeekState } from "./weekly-arc.mjs";

const HOURS = 60 * 60 * 1000;

// Build the data dossier for a recap of the week ending today.
export async function buildRecapData(now = new Date()) {
  const state = await loadState();
  const trends = await loadTrends();
  const weekState = await loadWeekState();

  const weekMission = weekState.current?.mission ?? null;
  const weekStart = weekState.current?.week_start ?? null;

  // Bucket items by closed-this-week vs still-open vs new-this-week.
  const weekStartMs = weekStart ? new Date(weekStart + "T00:00:00Z").getTime() : now.getTime() - 7 * 24 * HOURS;
  const items = Object.values(state.items);

  const closed_this_week = items.filter((i) => {
    if (!i.closed_at) return false;
    const t = new Date(i.closed_at).getTime();
    return t >= weekStartMs;
  });
  const still_open = items.filter((i) => !i.closed_at);
  const new_this_week = items.filter((i) => {
    const t = new Date(i.first_seen_at).getTime();
    return t >= weekStartMs;
  });

  // Bucket by kind for both closed and open.
  function byKind(list) {
    const out = {};
    for (const i of list) {
      const k = i.kind || "other";
      if (!out[k]) out[k] = [];
      out[k].push(i);
    }
    return out;
  }

  // Trend deltas vs previous week.
  let trend_delta = null;
  if (weekStart) {
    const cur = trends.weeks.find((w) => w.week_start === weekStart);
    const prev = previousWeek(trends, weekStart);
    if (cur && prev) {
      trend_delta = {};
      for (const k of Object.keys(cur.metrics)) {
        trend_delta[k] = {
          this_week: cur.metrics[k],
          last_week: prev.metrics[k] ?? 0,
          delta: (cur.metrics[k] ?? 0) - (prev.metrics[k] ?? 0),
        };
      }
    }
  }

  return {
    week_start: weekStart,
    mission: weekMission,
    closed_this_week: byKind(closed_this_week),
    still_open: byKind(still_open),
    new_this_week: byKind(new_this_week),
    counts: {
      closed: closed_this_week.length,
      open: still_open.length,
      new: new_this_week.length,
    },
    trend_delta,
    sparklines: {
      waiting_count: sparkline(trends, "waiting_count"),
      promises_open: sparkline(trends, "promises_open"),
      slow_burn: sparkline(trends, "slow_burn"),
    },
  };
}
