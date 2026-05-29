import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreOneThingCandidates, pickDraftTargets } from "../scripts/one-thing.mjs";

test("scoreOneThingCandidates produces categorized candidates", () => {
  const waiting = [
    {
      message_id: "m1",
      sender: "Brian <brian@example.com>",
      sender_email: "brian@example.com",
      subject: "TPA question",
      date_received: "Friday, May 8, 2026 at 5:49:32 PM",
      priority: 10,
      urgency_score: 1,
    },
  ];
  const cands = scoreOneThingCandidates({
    rankedMessages: [],
    waiting_on_me: waiting,
    deadline_48h_mail: [],
    basecamp_48h: [],
    notion: [],
    vipSet: new Set(["brian@example.com"]),
  });
  assert.ok(cands.length >= 1);
  assert.equal(cands[0].category, "waiting_on_me");
  assert.ok(cands[0].impact_signal.includes("VIP"));
});

test("scoreOneThingCandidates surfaces 48h deadlines above older waiting-on-me", () => {
  const cands = scoreOneThingCandidates({
    rankedMessages: [],
    waiting_on_me: [
      {
        message_id: "old",
        sender: "Someone <s@x>",
        sender_email: "s@x",
        subject: "FYI",
        date_received: "Mon, May 5, 2026 at 9:00 AM",
        priority: 3,
      },
    ],
    deadline_48h_mail: [
      {
        message_id: "urgent",
        sender: "Boss <b@x>",
        sender_email: "b@x",
        subject: "today",
        date_received: "Sun, May 10, 2026 at 9:00 AM",
        deadline_hours_ahead: 6,
      },
    ],
    basecamp_48h: [],
    notion: [],
    vipSet: new Set(),
  });
  assert.equal(cands[0].category, "deadline_48h");
});

test("scoreOneThingCandidates extracts Robby commitments from Notion text", () => {
  const cands = scoreOneThingCandidates({
    rankedMessages: [],
    waiting_on_me: [],
    deadline_48h_mail: [],
    basecamp_48h: [],
    notion: [
      {
        id: "n1",
        title: "Team call",
        date: "2026-05-07",
        highlight:
          "Action items. Robby to provide Ellie with compensation answer by end of month.",
      },
    ],
    vipSet: new Set(),
  });
  const promises = cands.filter((c) => c.category === "promise_made");
  assert.ok(promises.length >= 1, "should detect Robby commitments");
  assert.ok(promises[0].title.toLowerCase().includes("compensation"));
});

test("scoreOneThingCandidates returns at most 10", () => {
  const waiting = Array.from({ length: 20 }, (_, i) => ({
    message_id: `m${i}`,
    sender: `S <s${i}@x>`,
    sender_email: `s${i}@x`,
    subject: `t${i}`,
    date_received: "Mon, May 5, 2026 at 9:00 AM",
    priority: i,
  }));
  const cands = scoreOneThingCandidates({
    rankedMessages: [],
    waiting_on_me: waiting,
    deadline_48h_mail: [],
    basecamp_48h: [],
    notion: [],
    vipSet: new Set(),
  });
  assert.equal(cands.length, 10);
});

test("pickDraftTargets returns top N by priority", () => {
  const waiting = [
    { message_id: "low", priority: 1 },
    { message_id: "mid", priority: 5 },
    { message_id: "high", priority: 10 },
    { message_id: "mid2", priority: 4 },
  ];
  const targets = pickDraftTargets(waiting, 3);
  assert.equal(targets.length, 3);
  assert.equal(targets[0].message_id, "high");
  assert.equal(targets[1].message_id, "mid");
});

test("pickDraftTargets handles empty input", () => {
  assert.deepEqual(pickDraftTargets([], 3), []);
  assert.deepEqual(pickDraftTargets(undefined, 3), []);
});
