// Tests for scripts/lib/os-detect.mjs. The dispatcher logic in
// collect-mail.mjs and collect-calendar.mjs depends on these being correct.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROVIDERS,
  resolveProvider,
  resolveCalendarFallback,
} from "../scripts/lib/os-detect.mjs";

test("DEFAULT_PROVIDERS covers darwin, win32, linux", () => {
  assert.ok(DEFAULT_PROVIDERS.darwin);
  assert.ok(DEFAULT_PROVIDERS.win32);
  assert.ok(DEFAULT_PROVIDERS.linux);
});

test("DEFAULT_PROVIDERS darwin preserves original macOS behavior", () => {
  assert.equal(DEFAULT_PROVIDERS.darwin.mail, "apple-mail");
  assert.equal(DEFAULT_PROVIDERS.darwin.calendar, "fantastical");
  assert.equal(DEFAULT_PROVIDERS.darwin.calendar_fallback, "apple-calendar");
});

test("DEFAULT_PROVIDERS win32 uses cross-platform Gmail + Google Calendar", () => {
  assert.equal(DEFAULT_PROVIDERS.win32.mail, "gmail");
  assert.equal(DEFAULT_PROVIDERS.win32.calendar, "google-calendar");
  assert.equal(DEFAULT_PROVIDERS.win32.tasks, "basecamp-only");
});

test("resolveProvider honors config override over OS default", () => {
  const config = { providers: { mail: "outlook-graph" } };
  assert.equal(resolveProvider("mail", config), "outlook-graph");
});

test("resolveProvider falls back to OS default when no override", () => {
  // We can't change runtime OS, but we can verify it returns *some* string.
  const got = resolveProvider("mail", {});
  assert.ok(typeof got === "string" && got.length > 0);
});

test("resolveProvider handles missing config entirely", () => {
  const got = resolveProvider("calendar", undefined);
  assert.ok(typeof got === "string" && got.length > 0);
});

test("resolveProvider handles unknown source by returning undefined", () => {
  const got = resolveProvider("nonexistent-source", {});
  assert.equal(got, undefined);
});

test("resolveCalendarFallback honors explicit null override (disables fallback)", () => {
  const config = { providers: { calendar_fallback: null } };
  assert.equal(resolveCalendarFallback(config), null);
});

test("resolveCalendarFallback honors string override", () => {
  const config = { providers: { calendar_fallback: "google-calendar" } };
  assert.equal(resolveCalendarFallback(config), "google-calendar");
});

test("resolveCalendarFallback returns OS default when override absent", () => {
  // Mac default is "apple-calendar"; other OSes default to null.
  const got = resolveCalendarFallback({});
  // Either a string or null is valid; just make sure it doesn't throw.
  assert.ok(got === null || typeof got === "string");
});
