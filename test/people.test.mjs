import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPersonAliases, buildPeopleView, __test } from "../scripts/people.mjs";

test("displayName strips angle-bracket email and quotes", () => {
  assert.equal(__test.displayName("Brian Toelle <brian@example.com>"), "Brian Toelle");
  assert.equal(__test.displayName('"Brian Toelle" <brian@example.com>'), "Brian Toelle");
});

test("normalizedName lowercases and removes middle initials", () => {
  assert.equal(__test.normalizedName("Brian J. Toelle <brian@example.com>"), "brian toelle");
  assert.equal(__test.normalizedName("BRIAN  TOELLE <brian@example.com>"), "brian toelle");
});

test("buildPersonAliases collapses three of Brian's emails under most-used", () => {
  const messages = [
    { sender: "Brian Toelle <briantoelle@gmail.com>" },
    { sender: "Brian Toelle <briantoelle@gmail.com>" },
    { sender: "Brian Toelle <briantoelle@gmail.com>" },
    { sender: "Brian Toelle <Brian@narrowgate.group>" },
    { sender: "Brian Toelle <brian@sellformillions.com>" },
  ];
  const a = buildPersonAliases(messages);
  assert.equal(a.get("briantoelle@gmail.com"), "briantoelle@gmail.com");
  assert.equal(a.get("brian@narrowgate.group"), "briantoelle@gmail.com");
  assert.equal(a.get("brian@sellformillions.com"), "briantoelle@gmail.com");
});

test("buildPersonAliases ignores non-personal senders", () => {
  const messages = [
    { sender: "GitHub <noreply@github.com>" },
    { sender: "Notifications <notify@app.com>" },
  ];
  const a = buildPersonAliases(messages);
  assert.equal(a.size, 0);
});

test("buildPeopleView collapses Brian into one row, even with 3 emails", () => {
  const inbound = [
    {
      message_id: "id-1",
      sender: "Brian Toelle <briantoelle@gmail.com>",
      subject: "Re: Notes from today",
      date_received: "Friday, May 8, 2026 at 5:49:32 PM",
      account: "NarrowGate",
      mailbox: "INBOX",
    },
    {
      message_id: "id-2",
      sender: "Brian Toelle <Brian@narrowgate.group>",
      subject: "Re: NorthStar",
      date_received: "Tuesday, May 5, 2026 at 4:03:50 PM",
      account: "NarrowGate",
      mailbox: "INBOX",
    },
    {
      message_id: "id-3",
      sender: "Brian Toelle <brian@sellformillions.com>",
      subject: "NarrowGate Master Business Plan v6",
      date_received: "Thursday, April 30, 2026 at 12:00:10 PM",
      account: "NarrowGate",
      mailbox: "INBOX",
    },
  ];
  const view = buildPeopleView({
    inbound,
    threads: [],
    notion: [],
    basecamp: null,
    vipSet: new Set(["briantoelle@gmail.com"]),
    repliedIndex: new Set(),
  });
  const brian = view.find((p) => p.counterparty_name === "Brian Toelle");
  assert.ok(brian, "Brian should appear as a single person row");
  assert.equal(brian.message_count, 3);
  assert.equal(brian.unreplied_count, 3);
  assert.equal(brian.vip, true);
  assert.equal(brian.is_personal, true);
});

test("buildPeopleView marks replied vs unreplied correctly", () => {
  const inbound = [
    {
      message_id: "id-replied",
      sender: "Chris DuBos <chris@example.com>",
      subject: "Q",
      date_received: "Mon, May 5, 2026 at 9:00 AM",
    },
    {
      message_id: "id-pending",
      sender: "Chris DuBos <chris@example.com>",
      subject: "Q2",
      date_received: "Mon, May 5, 2026 at 10:00 AM",
    },
  ];
  const view = buildPeopleView({
    inbound,
    threads: [],
    notion: [],
    basecamp: null,
    vipSet: new Set(),
    repliedIndex: new Set(["id-replied"]),
  });
  const chris = view[0];
  assert.equal(chris.mail.unreplied.length, 1);
  assert.equal(chris.mail.replied.length, 1);
  assert.equal(chris.mail.unreplied[0].message_id, "id-pending");
});

test("buildPeopleView sorts by activity_score, VIPs surface up", () => {
  const inbound = [
    {
      message_id: "v",
      sender: "Vip Sender <vip@x.com>",
      subject: "Hi",
      date_received: "Mon, May 5, 2026 at 9:00 AM",
    },
    {
      message_id: "x1",
      sender: "Other Person <other@x.com>",
      subject: "Hello",
      date_received: "Mon, May 5, 2026 at 9:00 AM",
    },
    {
      message_id: "x2",
      sender: "Other Person <other@x.com>",
      subject: "Hello2",
      date_received: "Mon, May 5, 2026 at 9:00 AM",
    },
  ];
  const view = buildPeopleView({
    inbound,
    threads: [],
    notion: [],
    basecamp: null,
    vipSet: new Set(["vip@x.com"]),
    repliedIndex: new Set(),
  });
  assert.equal(view[0].counterparty_name, "Vip Sender");
});
