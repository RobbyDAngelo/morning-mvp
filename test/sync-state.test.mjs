import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureDay,
  recordNotion,
  recordCalendarEvent,
  recordReminder,
  getDay,
  clearDay,
} from "../scripts/sync-state.mjs";

test("ensureDay creates a clean day record", () => {
  const state = { version: 1, days: {} };
  const day = ensureDay(state, "2026-05-11");
  assert.deepEqual(day, { notion: null, calendar: [], reminders: [] });
});

test("ensureDay is idempotent", () => {
  const state = { version: 1, days: {} };
  const a = ensureDay(state, "2026-05-11");
  a.calendar.push({ title: "x" });
  const b = ensureDay(state, "2026-05-11");
  assert.equal(b.calendar.length, 1);
});

test("recordNotion sets the notion record", () => {
  const state = { version: 1, days: {} };
  recordNotion(state, "2026-05-11", { page_id: "p1", url: "http://x" });
  assert.equal(state.days["2026-05-11"].notion.page_id, "p1");
  assert.equal(state.days["2026-05-11"].notion.url, "http://x");
});

test("recordCalendarEvent appends and dedupes by title", () => {
  const state = { version: 1, days: {} };
  recordCalendarEvent(state, "2026-05-11", { event_id: "e1", title: "Deep work" });
  recordCalendarEvent(state, "2026-05-11", { event_id: "e2", title: "Deep work" });
  assert.equal(state.days["2026-05-11"].calendar.length, 1);
  assert.equal(state.days["2026-05-11"].calendar[0].event_id, "e2");
});

test("recordCalendarEvent keeps different-title events", () => {
  const state = { version: 1, days: {} };
  recordCalendarEvent(state, "2026-05-11", { event_id: "e1", title: "Deep work" });
  recordCalendarEvent(state, "2026-05-11", { event_id: "e2", title: "Other block" });
  assert.equal(state.days["2026-05-11"].calendar.length, 2);
});

test("recordReminder dedupes by name+list", () => {
  const state = { version: 1, days: {} };
  recordReminder(state, "2026-05-11", { name: "Foo", list_name: "A" });
  recordReminder(state, "2026-05-11", { name: "Foo", list_name: "A" });
  recordReminder(state, "2026-05-11", { name: "Foo", list_name: "B" });
  assert.equal(state.days["2026-05-11"].reminders.length, 2);
});

test("clearDay removes the day", () => {
  const state = { version: 1, days: { "2026-05-11": { notion: null, calendar: [], reminders: [] } } };
  clearDay(state, "2026-05-11");
  assert.equal(getDay(state, "2026-05-11"), null);
});
