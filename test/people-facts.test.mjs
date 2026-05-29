import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addFact,
  getFacts,
  extractFactsFromMessage,
  harvestFactsFromMessages,
  pruneFacts,
} from "../scripts/people-facts.mjs";

test("addFact stores fact and returns true on first add", () => {
  const state = { version: 1, facts: {} };
  const added = addFact(state, "brian@example.com", "Paid you $520", "mail");
  assert.equal(added, true);
  assert.equal(state.facts["brian@example.com"].length, 1);
  assert.equal(state.facts["brian@example.com"][0].text, "Paid you $520");
});

test("addFact returns false on duplicate and bumps last_confirmed_at", () => {
  const state = { version: 1, facts: {} };
  addFact(state, "brian@example.com", "Paid you $520", "mail", new Date("2026-05-01T00:00:00Z"));
  const added2 = addFact(state, "brian@example.com", "Paid you $520", "mail", new Date("2026-05-10T00:00:00Z"));
  assert.equal(added2, false);
  assert.equal(state.facts["brian@example.com"].length, 1);
  assert.equal(
    state.facts["brian@example.com"][0].last_confirmed_at,
    "2026-05-10T00:00:00.000Z",
  );
});

test("addFact normalizes email case", () => {
  const state = { version: 1, facts: {} };
  addFact(state, "Brian@Example.COM", "Hello", "mail");
  assert.ok(state.facts["brian@example.com"]);
});

test("addFact caps per-person facts at MAX_FACTS_PER_PERSON (25)", () => {
  const state = { version: 1, facts: {} };
  for (let i = 0; i < 30; i++) {
    addFact(state, "brian@example.com", `Fact ${i}`, "mail");
  }
  assert.equal(state.facts["brian@example.com"].length, 25);
});

test("getFacts returns most-recently-confirmed first, limited", () => {
  const state = { version: 1, facts: {} };
  addFact(state, "brian@example.com", "Old", "mail", new Date("2026-05-01T00:00:00Z"));
  addFact(state, "brian@example.com", "New", "mail", new Date("2026-05-10T00:00:00Z"));
  const facts = getFacts(state, "brian@example.com", 1);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].text, "New");
});

test("extractFactsFromMessage catches Venmo payment language", () => {
  const facts = extractFactsFromMessage({ body: "Brian Toelle paid you $520.00 via Venmo." });
  assert.ok(facts.some((f) => f.text.includes("Paid you $520")));
});

test("extractFactsFromMessage catches weekly meeting cadence", () => {
  const facts = extractFactsFromMessage({ body: "Set up our weekly Toelle sync starting Tuesday." });
  assert.ok(facts.some((f) => /Weekly Toelle/i.test(f.text)));
});

test("extractFactsFromMessage catches accepted calendar invitations", () => {
  const facts = extractFactsFromMessage({ subject: "Accepted: Tech Talk @ Mon Mar 23" });
  assert.ok(facts.some((f) => /Accepted meeting/i.test(f.text)));
});

test("extractFactsFromMessage returns empty for benign text", () => {
  const facts = extractFactsFromMessage({ body: "Just checking in, no rush." });
  assert.equal(facts.length, 0);
});

test("harvestFactsFromMessages adds facts and reports count", () => {
  const state = { version: 1, facts: {} };
  const messages = [
    { sender: "Brian Toelle <brian@example.com>", body: "Brian paid you $520 via Venmo" },
    { sender: "Chris DuBos <chris@example.com>", body: "We have weekly Tech sync starting next week" },
    { sender: "Other <other@example.com>", body: "no facts here" },
  ];
  const added = harvestFactsFromMessages(state, messages);
  assert.ok(added >= 2);
  assert.ok(state.facts["brian@example.com"]);
  assert.ok(state.facts["chris@example.com"]);
  assert.ok(!state.facts["other@example.com"]);
});

test("harvestFactsFromMessages dedupes across runs", () => {
  const state = { version: 1, facts: {} };
  const messages = [
    { sender: "Brian Toelle <brian@example.com>", body: "Brian paid you $520 via Venmo" },
  ];
  const added1 = harvestFactsFromMessages(state, messages);
  const added2 = harvestFactsFromMessages(state, messages);
  assert.equal(added1, 1);
  assert.equal(added2, 0); // dedupe
});

test("pruneFacts drops facts past ttl", () => {
  const state = { version: 1, facts: {} };
  const old = new Date("2024-01-01T00:00:00Z");
  addFact(state, "brian@example.com", "Ancient fact", "mail", old);
  addFact(state, "brian@example.com", "Fresh fact", "mail", new Date());
  const removed = pruneFacts(state, 30); // 30-day TTL
  assert.equal(removed, 1);
  assert.equal(state.facts["brian@example.com"].length, 1);
  assert.equal(state.facts["brian@example.com"][0].text, "Fresh fact");
});
