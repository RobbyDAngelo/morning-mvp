import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDecisionOrResponse, tagItemsWithKind } from "../scripts/decisions.mjs";

test("classifies 'should we switch' as decision", () => {
  const c = classifyDecisionOrResponse({
    subject: "Phone carrier",
    body: "Should we switch back to the previous carrier?",
  });
  assert.equal(c.kind, "decision");
});

test("classifies 'approval needed' as decision", () => {
  const c = classifyDecisionOrResponse({
    subject: "Q3 plan",
    body: "Approval needed before Friday.",
  });
  assert.equal(c.kind, "decision");
});

test("classifies 'quick question' as response", () => {
  const c = classifyDecisionOrResponse({
    subject: "RE: Plan",
    body: "Quick question, what time on Friday?",
  });
  assert.equal(c.kind, "response");
});

test("classifies status-update style as response", () => {
  const c = classifyDecisionOrResponse({
    subject: "Status",
    body: "Any update on the deck?",
  });
  assert.equal(c.kind, "response");
});

test("returns low-confidence response when neither pattern hits", () => {
  const c = classifyDecisionOrResponse({
    subject: "FYI",
    body: "Just sending this over.",
  });
  assert.equal(c.kind, "response");
  assert.equal(c.confidence, "low");
});

test("tagItemsWithKind attaches kind + confidence to each item", () => {
  const items = [
    { subject: "Decide", body: "Should we move forward?", message_id: "a" },
    { subject: "FYI", body: "Just sharing.", message_id: "b" },
  ];
  const tagged = tagItemsWithKind(items);
  assert.equal(tagged[0].decision_or_response, "decision");
  assert.equal(tagged[1].decision_or_response, "response");
  assert.equal(tagged.length, 2);
  assert.ok(tagged[0].classification_confidence);
});
