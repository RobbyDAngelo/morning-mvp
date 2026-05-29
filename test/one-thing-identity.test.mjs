// Verifies one-thing.mjs honors identity.first_name for commitment extraction.
// The legacy hard-coded "Robby" regex is now parameterized.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreOneThingCandidates, extractMyCommitments } from "../scripts/one-thing.mjs";

test("ID-1: extractMyCommitments defaults to 'Robby' when no firstName given", () => {
  const got = extractMyCommitments("Robby to call Brian Tuesday.");
  assert.equal(got.length, 1);
  assert.match(got[0], /Robby to call Brian/);
});

test("ID-2: extractMyCommitments respects an arbitrary firstName", () => {
  const got = extractMyCommitments("Bryan to ship the proposal by Thursday.", "Bryan");
  assert.equal(got.length, 1);
  assert.match(got[0], /Bryan to ship/);
});

test("ID-3: extractMyCommitments handles hyphenated first names", () => {
  const got = extractMyCommitments(
    "Anne-Marie to review the contract by Monday.",
    "Anne-Marie",
  );
  assert.equal(got.length, 1);
  assert.match(got[0], /Anne-Marie to review/);
});

test("ID-4: extractMyCommitments handles regex-special characters in firstName safely", () => {
  // Defensive: user with a period or paren in first name (rare but possible).
  const got = extractMyCommitments(
    "J.R. to draft the policy memo this week.",
    "J.R.",
  );
  // Should not throw, regardless of result.
  assert.ok(Array.isArray(got));
});

test("ID-5: scoreOneThingCandidates threads identity.first_name to commitment extractor", () => {
  const cands = scoreOneThingCandidates({
    rankedMessages: [],
    waiting_on_me: [],
    deadline_48h_mail: [],
    basecamp_48h: [],
    notion: [
      {
        id: "n2",
        title: "Strategy call",
        date: "2026-05-07",
        highlight: "Action items. Bryan to draft a Q3 plan by Friday.",
      },
    ],
    vipSet: new Set(),
    identity: { first_name: "Bryan" },
  });
  const promises = cands.filter((c) => c.category === "promise_made");
  assert.equal(promises.length, 1);
  assert.match(promises[0].title, /Bryan to draft/);
});

test("ID-6: scoreOneThingCandidates without identity uses Robby default", () => {
  const cands = scoreOneThingCandidates({
    rankedMessages: [],
    waiting_on_me: [],
    deadline_48h_mail: [],
    basecamp_48h: [],
    notion: [
      {
        id: "n3",
        title: "Robby's solo plan",
        date: "2026-05-07",
        highlight: "Robby to handle invoicing this week.",
      },
    ],
    vipSet: new Set(),
    // identity omitted entirely
  });
  const promises = cands.filter((c) => c.category === "promise_made");
  assert.equal(promises.length, 1);
});

test("ID-7: scoreOneThingCandidates with identity={} falls back to Robby default", () => {
  const cands = scoreOneThingCandidates({
    rankedMessages: [],
    waiting_on_me: [],
    deadline_48h_mail: [],
    basecamp_48h: [],
    notion: [
      {
        id: "n4",
        title: "Empty identity",
        date: "2026-05-07",
        highlight: "Robby to send the contract.",
      },
    ],
    vipSet: new Set(),
    identity: {},
  });
  const promises = cands.filter((c) => c.category === "promise_made");
  assert.equal(promises.length, 1);
});

test("ID-8: scoreOneThingCandidates accepts camelCase firstName too", () => {
  const cands = scoreOneThingCandidates({
    rankedMessages: [],
    waiting_on_me: [],
    deadline_48h_mail: [],
    basecamp_48h: [],
    notion: [
      {
        id: "n5",
        title: "camelCase test",
        date: "2026-05-07",
        highlight: "Sarah to lead the next sprint review.",
      },
    ],
    vipSet: new Set(),
    identity: { firstName: "Sarah" }, // camelCase variant
  });
  const promises = cands.filter((c) => c.category === "promise_made");
  assert.equal(promises.length, 1);
});

test("ID-9: extractMyCommitments cap of 5 commitments per text", () => {
  const text = Array.from({ length: 10 }, (_, i) => `Bryan to do task ${i}.`).join(" ");
  const got = extractMyCommitments(text, "Bryan");
  assert.equal(got.length, 5);
});

test("ID-10: extractMyCommitments returns empty for empty input", () => {
  assert.deepEqual(extractMyCommitments(""), []);
  assert.deepEqual(extractMyCommitments(null), []);
  assert.deepEqual(extractMyCommitments(undefined), []);
});
