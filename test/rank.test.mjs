import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recencyScore,
  vipBoost,
  buildVipSet,
  buildRepliedIndex,
  scoreMessage,
  rankMessages,
} from "../scripts/rank.mjs";

const now = Date.parse("2026-05-10T18:00:00Z");

test("recencyScore returns 2 for messages within 24h", () => {
  const yesterday = new Date(now - 5 * 60 * 60 * 1000).toString();
  assert.equal(recencyScore(yesterday, now), 2);
});

test("recencyScore returns 0 for messages older than 72h", () => {
  const old = new Date(now - 96 * 60 * 60 * 1000).toString();
  assert.equal(recencyScore(old, now), 0);
});

test("recencyScore returns 0 for unparseable date", () => {
  assert.equal(recencyScore("not a date", now), 0);
});

test("vipBoost returns 1 when sender is in VIP set (case-insensitive)", () => {
  assert.equal(vipBoost("brian@example.com", new Set(["brian@example.com"])), 1);
  // Emails are case-insensitive; the function lowercases before lookup.
  assert.equal(vipBoost("BRIAN@example.com", new Set(["brian@example.com"])), 1);
  assert.equal(vipBoost("stranger@example.com", new Set(["brian@example.com"])), 0);
});

test("buildVipSet picks up personal-name senders past threshold", () => {
  const inbound = [
    { sender: "Brian Toelle <brian@example.com>" },
    { sender: "Brian Toelle <brian@example.com>" },
    { sender: "Brian Toelle <brian@example.com>" },
    { sender: "Newby <newby@example.com>" },
  ];
  const sent = [];
  const vips = buildVipSet(inbound, sent, 3);
  assert.ok(vips.has("brian@example.com"), "personal-name sender with 3+ messages is VIP");
  assert.equal(vips.has("newby@example.com"), false, "single-token sender is not personal");
});

test("buildVipSet promotes anyone Robby has replied to (reciprocity wins)", () => {
  const inbound = [{ sender: "Some Person <person@example.com>" }];
  const sent = [{ recipients_to: "person@example.com" }];
  const vips = buildVipSet(inbound, sent, 3);
  assert.ok(vips.has("person@example.com"), "one inbound + one outbound = VIP");
});

test("buildVipSet rejects bulk marketing despite high count", () => {
  // Simulates Walmart sending 12 emails Robby never replied to.
  const inbound = Array.from({ length: 12 }, () => ({ sender: "Walmart.com <noreply@walmart.com>" }));
  const sent = [];
  const vips = buildVipSet(inbound, sent, 3);
  assert.equal(vips.has("noreply@walmart.com"), false, "single-token bulk sender is not VIP");
});

test("buildRepliedIndex matches Re: subject from sent later than inbound", () => {
  const inbound = [
    { message_id: "id-1", subject: "Q3 deck", date_received: "Mon, May 5, 2026 at 9:00 AM" },
    { message_id: "id-2", subject: "FYI", date_received: "Mon, May 5, 2026 at 10:00 AM" },
  ];
  const sent = [
    { subject: "Re: Q3 deck", date_received: "Mon, May 5, 2026 at 11:00 AM" },
  ];
  const replied = buildRepliedIndex(inbound, sent);
  assert.ok(replied.has("id-1"));
  assert.equal(replied.has("id-2"), false);
});

test("buildRepliedIndex uses was_replied_to even with NO sent data (the Mail \\Answered fix)", () => {
  // The real-world case: Sent folder is empty/unsynced, but Mail's per-message
  // reply flag is set because the user replied from web/phone.
  const inbound = [
    { message_id: "id-1", subject: "Contract", date_received: "Mon, May 5, 2026 at 9:00 AM", was_replied_to: true },
    { message_id: "id-2", subject: "FYI", date_received: "Mon, May 5, 2026 at 10:00 AM", was_replied_to: false },
    { message_id: "id-3", subject: "No flag field", date_received: "Mon, May 5, 2026 at 11:00 AM" },
  ];
  const replied = buildRepliedIndex(inbound, []); // empty sent
  assert.ok(replied.has("id-1"), "was_replied_to:true should mark replied without any sent data");
  assert.equal(replied.has("id-2"), false, "was_replied_to:false stays unreplied");
  assert.equal(replied.has("id-3"), false, "missing flag is treated as unreplied");
});

test("buildRepliedIndex combines was_replied_to with the sent cross-reference", () => {
  const inbound = [
    { message_id: "a", subject: "Deck", date_received: "Mon, May 5, 2026 at 9:00 AM", was_replied_to: true },
    { message_id: "b", subject: "Invoice", date_received: "Mon, May 5, 2026 at 9:00 AM" },
  ];
  const sent = [{ subject: "Re: Invoice", date_received: "Mon, May 5, 2026 at 11:00 AM" }];
  const replied = buildRepliedIndex(inbound, sent);
  assert.ok(replied.has("a"), "flag signal");
  assert.ok(replied.has("b"), "sent cross-reference signal");
});

test("scoreMessage flags waiting_on_me when unreplied + asks", () => {
  const m = {
    message_id: "id-1",
    sender: "Brian Toelle <brian@example.com>",
    subject: "quick question",
    preview: "Can you review by tomorrow?",
    date_received: new Date(now - 2 * 60 * 60 * 1000).toString(),
  };
  const scored = scoreMessage(m, { repliedIndex: new Set(), vipSet: new Set() });
  assert.equal(scored.waiting_on_me, true);
  assert.ok(scored.priority >= 3);
});

test("scoreMessage does NOT flag waiting_on_me when already replied", () => {
  const m = {
    message_id: "id-1",
    sender: "Brian Toelle <brian@example.com>",
    subject: "quick question",
    preview: "Can you review by tomorrow?",
    date_received: new Date(now - 2 * 60 * 60 * 1000).toString(),
  };
  const scored = scoreMessage(m, { repliedIndex: new Set(["id-1"]), vipSet: new Set() });
  assert.equal(scored.waiting_on_me, false);
});

test("scoreMessage flags has_deadline_48h on 'today'/'tomorrow'", () => {
  const m = {
    message_id: "id-x",
    sender: "Boss <boss@example.com>",
    subject: "Need this today",
    preview: "Can you send the report by EOD?",
    date_received: new Date(now - 60 * 60 * 1000).toString(),
  };
  const scored = scoreMessage(m, { repliedIndex: new Set(), vipSet: new Set() });
  assert.equal(scored.has_deadline_48h, true);
});

test("rankMessages orders by priority descending", () => {
  const msgs = [
    {
      message_id: "low",
      sender: "Sender One <one@example.com>",
      subject: "fyi",
      preview: "no rush",
      date_received: new Date(now - 80 * 60 * 60 * 1000).toString(),
    },
    {
      message_id: "high",
      sender: "Sender Two <two@example.com>",
      subject: "URGENT today",
      preview: "Please respond ASAP",
      date_received: new Date(now - 60 * 60 * 1000).toString(),
    },
  ];
  const ranked = rankMessages(msgs, { repliedIndex: new Set(), vipSet: new Set() });
  assert.equal(ranked[0].message_id, "high");
  assert.equal(ranked[1].message_id, "low");
});
