import { test } from "node:test";
import assert from "node:assert/strict";
import { stableId, reconcile, slowBurn } from "../scripts/state.mjs";

test("stableId is deterministic and order-sensitive", () => {
  assert.equal(stableId(["a", "b", "c"]), stableId(["a", "b", "c"]));
  assert.notEqual(stableId(["a", "b", "c"]), stableId(["a", "c", "b"]));
});

test("stableId returns a fixed-length hex", () => {
  const id = stableId(["hello", "world"]);
  assert.match(id, /^[0-9a-f]{16}$/);
});

test("reconcile creates first_seen for new items", () => {
  const state = { version: 1, items: {} };
  const now = new Date("2026-05-10T12:00:00Z");
  reconcile(
    state,
    [{ id: "x1", kind: "waiting_mail", title: "hi", counterparty: "Brian" }],
    now,
  );
  assert.equal(state.items.x1.first_seen_at, now.toISOString());
  assert.equal(state.items.x1.last_seen_at, now.toISOString());
  assert.equal(state.items.x1.closed_at, null);
});

test("reconcile bumps last_seen on re-appearance and clears closed_at", () => {
  const state = {
    version: 1,
    items: {
      x1: {
        id: "x1",
        kind: "waiting_mail",
        first_seen_at: "2026-05-05T00:00:00.000Z",
        last_seen_at: "2026-05-05T00:00:00.000Z",
        closed_at: "2026-05-06T00:00:00.000Z",
      },
    },
  };
  const now = new Date("2026-05-10T12:00:00Z");
  reconcile(
    state,
    [{ id: "x1", kind: "waiting_mail", title: "still here", counterparty: "Brian" }],
    now,
  );
  assert.equal(state.items.x1.last_seen_at, now.toISOString());
  assert.equal(state.items.x1.closed_at, null);
  assert.equal(state.items.x1.first_seen_at, "2026-05-05T00:00:00.000Z");
});

test("reconcile closes items not in current set", () => {
  const state = {
    version: 1,
    items: {
      gone: {
        id: "gone",
        kind: "waiting_mail",
        first_seen_at: "2026-05-05T00:00:00.000Z",
        last_seen_at: "2026-05-09T00:00:00.000Z",
        closed_at: null,
      },
    },
  };
  const now = new Date("2026-05-10T12:00:00Z");
  reconcile(state, [], now);
  assert.equal(state.items.gone.closed_at, now.toISOString());
});

test("slowBurn surfaces aged-out waiting_mail past 3 days", () => {
  const old = new Date("2026-05-06T00:00:00Z").toISOString(); // 4d old
  const fresh = new Date("2026-05-09T12:00:00Z").toISOString(); // 0.5d
  const state = {
    version: 1,
    items: {
      old: {
        id: "old",
        kind: "waiting_mail",
        first_seen_at: old,
        last_seen_at: old,
        closed_at: null,
        title: "old",
      },
      fresh: {
        id: "fresh",
        kind: "waiting_mail",
        first_seen_at: fresh,
        last_seen_at: fresh,
        closed_at: null,
        title: "fresh",
      },
    },
  };
  const r = slowBurn(state, new Date("2026-05-10T12:00:00Z"));
  assert.equal(r.length, 1);
  assert.equal(r[0].id, "old");
});

test("slowBurn ignores closed items", () => {
  const old = new Date("2026-05-01T00:00:00Z").toISOString();
  const state = {
    version: 1,
    items: {
      done: {
        id: "done",
        kind: "promise_made",
        first_seen_at: old,
        last_seen_at: old,
        closed_at: new Date().toISOString(),
        title: "done already",
      },
    },
  };
  const r = slowBurn(state, new Date("2026-05-10T12:00:00Z"));
  assert.equal(r.length, 0);
});

test("slowBurn respects per-kind thresholds (promise_made = 5 days)", () => {
  const fourDays = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const state = {
    version: 1,
    items: {
      p: {
        id: "p",
        kind: "promise_made",
        first_seen_at: fourDays,
        last_seen_at: fourDays,
        closed_at: null,
        title: "promise at 4d",
      },
    },
  };
  // 4 days < 5 day threshold for promise_made
  assert.equal(slowBurn(state).length, 0);
});
