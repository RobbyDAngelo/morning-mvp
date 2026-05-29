import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mondayOf,
  dayOfWeekName,
  isMonday,
  isSunday,
  decideAction,
  setMission,
} from "../scripts/weekly-arc.mjs";

test("mondayOf rolls a Wednesday back to the Monday", () => {
  // 2026-05-13 is a Wednesday
  const m = mondayOf(new Date("2026-05-13T14:00:00Z"));
  // The Monday on or before is 2026-05-11
  assert.equal(m.toISOString().slice(0, 10), "2026-05-11");
});

test("mondayOf rolls a Sunday back to the previous Monday", () => {
  // 2026-05-17 is a Sunday
  const m = mondayOf(new Date("2026-05-17T14:00:00Z"));
  assert.equal(m.toISOString().slice(0, 10), "2026-05-11");
});

test("mondayOf on a Monday returns same date", () => {
  // 2026-05-11 is a Monday
  const m = mondayOf(new Date("2026-05-11T14:00:00Z"));
  assert.equal(m.toISOString().slice(0, 10), "2026-05-11");
});

test("dayOfWeekName returns full English day", () => {
  assert.equal(dayOfWeekName(new Date("2026-05-11T12:00:00Z")), "Monday");
  assert.equal(dayOfWeekName(new Date("2026-05-15T12:00:00Z")), "Friday");
});

test("isMonday and isSunday distinguish boundary days", () => {
  assert.equal(isMonday(new Date("2026-05-11T12:00:00Z")), true);
  assert.equal(isSunday(new Date("2026-05-10T12:00:00Z")), true);
  assert.equal(isMonday(new Date("2026-05-10T12:00:00Z")), false);
});

test("decideAction prompts for mission on Monday with no current", () => {
  const state = { version: 1, current: null, history: [] };
  const a = decideAction(state, new Date("2026-05-11T08:00:00Z"));
  assert.equal(a.action, "prompt_new_mission");
});

test("decideAction rotates and prompts when Monday and previous week's mission is stale", () => {
  const state = {
    version: 1,
    current: { week_start: "2026-05-04", mission: "Old mission", set_at: "2026-05-04T08:00:00Z" },
    history: [],
  };
  const a = decideAction(state, new Date("2026-05-11T08:00:00Z"));
  assert.equal(a.action, "rotate_and_prompt");
});

test("decideAction returns display_current mid-week with active mission", () => {
  const state = {
    version: 1,
    current: { week_start: "2026-05-11", mission: "Ship Q2", set_at: "2026-05-11T08:00:00Z" },
    history: [],
  };
  const a = decideAction(state, new Date("2026-05-13T14:00:00Z")); // Wed
  assert.equal(a.action, "display_current");
  assert.equal(a.mission, "Ship Q2");
  assert.equal(a.day_of_week, "Wednesday");
  assert.equal(a.days_in, 3);
});

test("decideAction offers recap on Sunday", () => {
  const state = {
    version: 1,
    current: { week_start: "2026-05-11", mission: "Ship Q2", set_at: "2026-05-11T08:00:00Z" },
    history: [],
  };
  const a = decideAction(state, new Date("2026-05-17T18:00:00Z")); // Sun
  assert.equal(a.action, "offer_recap");
});

test("decideAction returns 'none' on non-Monday with no mission set", () => {
  const state = { version: 1, current: null, history: [] };
  const a = decideAction(state, new Date("2026-05-13T08:00:00Z")); // Wed, no mission
  assert.equal(a.action, "none");
});

test("setMission rotates last week's mission into history", () => {
  const state = {
    version: 1,
    current: { week_start: "2026-05-04", mission: "Old", set_at: "2026-05-04T08:00:00Z" },
    history: [],
  };
  setMission(state, "New mission for the week", new Date("2026-05-11T08:00:00Z"));
  assert.equal(state.current.mission, "New mission for the week");
  assert.equal(state.current.week_start, "2026-05-11");
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].mission, "Old");
});
