import { test } from "node:test";
import assert from "node:assert/strict";
import { recordSnapshot, previousWeek, deltas, sparkline } from "../scripts/trends.mjs";

test("recordSnapshot adds a fresh week", () => {
  const state = { version: 1, weeks: [] };
  recordSnapshot(state, "2026-05-04", { waiting_count: 5, slow_burn: 0 }, "Ship Q2");
  assert.equal(state.weeks.length, 1);
  assert.equal(state.weeks[0].week_start, "2026-05-04");
  assert.equal(state.weeks[0].mission, "Ship Q2");
});

test("recordSnapshot replaces same-week entry", () => {
  const state = { version: 1, weeks: [] };
  recordSnapshot(state, "2026-05-04", { waiting_count: 5 });
  recordSnapshot(state, "2026-05-04", { waiting_count: 8 });
  assert.equal(state.weeks.length, 1);
  assert.equal(state.weeks[0].metrics.waiting_count, 8);
});

test("recordSnapshot caps history at MAX_WEEKS (12)", () => {
  const state = { version: 1, weeks: [] };
  for (let i = 0; i < 20; i++) {
    const wk = `2026-${String(Math.floor(i / 4) + 1).padStart(2, "0")}-${String((i % 4) * 7 + 1).padStart(2, "0")}`;
    recordSnapshot(state, wk, { waiting_count: i });
  }
  assert.equal(state.weeks.length, 12);
  // Oldest should drop, newest kept.
  assert.equal(state.weeks[state.weeks.length - 1].metrics.waiting_count, 19);
});

test("previousWeek returns the prior chronological entry", () => {
  const state = { version: 1, weeks: [] };
  recordSnapshot(state, "2026-04-27", { waiting_count: 3 });
  recordSnapshot(state, "2026-05-04", { waiting_count: 5 });
  recordSnapshot(state, "2026-05-11", { waiting_count: 4 });
  const p = previousWeek(state, "2026-05-11");
  assert.ok(p);
  assert.equal(p.week_start, "2026-05-04");
});

test("previousWeek returns null for first week", () => {
  const state = { version: 1, weeks: [] };
  recordSnapshot(state, "2026-05-11", { waiting_count: 4 });
  assert.equal(previousWeek(state, "2026-05-11"), null);
});

test("deltas computes week-over-week changes", () => {
  const state = { version: 1, weeks: [] };
  recordSnapshot(state, "2026-05-04", { waiting_count: 5, promises_open: 3 });
  recordSnapshot(state, "2026-05-11", { waiting_count: 4, promises_open: 5 });
  const d = deltas(state, "2026-05-11");
  assert.equal(d.waiting_count, -1);
  assert.equal(d.promises_open, 2);
});

test("sparkline produces a string of 1 block per week", () => {
  const state = { version: 1, weeks: [] };
  for (let i = 0; i < 5; i++) {
    recordSnapshot(state, `2026-${String(i + 1).padStart(2, "0")}-01`, { waiting_count: i * 2 });
  }
  const s = sparkline(state, "waiting_count", 5);
  assert.equal([...s].length, 5);
});

test("sparkline empty for missing metric", () => {
  const state = { version: 1, weeks: [{ week_start: "2026-05-04", metrics: {} }] };
  const s = sparkline(state, "nonexistent");
  // value is 0 for all; sparkline returns lowest block per entry
  assert.equal([...s].length, 1);
});
