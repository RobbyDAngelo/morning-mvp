// Tests for the deduplication and merge semantics of enrich-summaries.mjs.
// The actual osascript / getMessage calls aren't exercised here (those need
// real Mail.app); the merge logic is the part that's worth unit-testing.

import { test } from "node:test";
import assert from "node:assert/strict";

// Mirror the enrichment merge function from enrich-summaries.mjs.
// Kept inline so the test exercises the exact semantics without invoking the
// CLI (which would call apple-mail-mcp's getMessage on real data).
function mergeInto(items, previews) {
  if (!items) return 0;
  let count = 0;
  for (const m of items) {
    const p = previews.get(m.message_id);
    if (p?.body_preview) {
      m.body_preview = p.body_preview;
      m.body_truncated = p.body_truncated;
      count += 1;
    }
  }
  return count;
}

test("mergeInto attaches body_preview to matching items", () => {
  const previews = new Map([
    ["m1", { body_preview: "Hi, can you confirm the Tuesday call?", body_truncated: false }],
  ]);
  const items = [
    { message_id: "m1", subject: "Tuesday" },
    { message_id: "m2", subject: "Other" },
  ];
  const n = mergeInto(items, previews);
  assert.equal(n, 1);
  assert.equal(items[0].body_preview, "Hi, can you confirm the Tuesday call?");
  assert.equal(items[1].body_preview, undefined);
});

test("mergeInto handles empty / missing items array", () => {
  assert.equal(mergeInto(null, new Map()), 0);
  assert.equal(mergeInto(undefined, new Map()), 0);
  assert.equal(mergeInto([], new Map()), 0);
});

test("mergeInto skips entries without body_preview", () => {
  const previews = new Map([["m1", { error: "fetch failed" }]]);
  const items = [{ message_id: "m1", subject: "X" }];
  const n = mergeInto(items, previews);
  assert.equal(n, 0);
  assert.equal(items[0].body_preview, undefined);
});

test("dedupe collects unique message_ids across multiple buckets", () => {
  // Mirror the collection loop in enrich-summaries.mjs.
  const ids = new Map();
  const MAX = 5;
  function consider(items) {
    for (const m of items ?? []) {
      if (!m?.message_id) continue;
      if (ids.has(m.message_id)) continue;
      if (ids.size >= MAX) return;
      ids.set(m.message_id, { account: m.account, mailbox: m.mailbox });
    }
  }
  consider([
    { message_id: "a", account: "Work" },
    { message_id: "b", account: "Personal" },
  ]);
  consider([
    { message_id: "a", account: "Work" }, // duplicate, skipped
    { message_id: "c", account: "Work" },
  ]);
  assert.equal(ids.size, 3);
  assert.deepEqual([...ids.keys()], ["a", "b", "c"]);
});

test("dedupe caps at MAX_ITEMS even with infinite input", () => {
  const ids = new Map();
  const MAX = 3;
  function consider(items) {
    for (const m of items ?? []) {
      if (!m?.message_id) continue;
      if (ids.has(m.message_id)) continue;
      if (ids.size >= MAX) return;
      ids.set(m.message_id, {});
    }
  }
  consider([
    { message_id: "a" },
    { message_id: "b" },
    { message_id: "c" },
    { message_id: "d" },
    { message_id: "e" },
  ]);
  assert.equal(ids.size, 3);
});

test("same message_id in waiting + people_view gets enriched once and merged twice", () => {
  // Realistic shape: one message appears in waiting_on_me AND inside a person's unreplied list.
  // The enrichment should fetch the preview once, but the merge should populate both locations.
  const previews = new Map([
    ["shared-id", { body_preview: "Common context", body_truncated: false }],
  ]);
  const waiting = [{ message_id: "shared-id", subject: "S" }];
  const personUnreplied = [{ message_id: "shared-id", subject: "S" }];

  const a = mergeInto(waiting, previews);
  const b = mergeInto(personUnreplied, previews);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(waiting[0].body_preview, "Common context");
  assert.equal(personUnreplied[0].body_preview, "Common context");
});
