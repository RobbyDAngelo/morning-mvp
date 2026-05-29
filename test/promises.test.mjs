import { test } from "node:test";
import assert from "node:assert/strict";
import { extractNotionPromises, extractSentMailPromises, extractAllPromises } from "../scripts/promises.mjs";

test("extractNotionPromises catches 'Robby to ...' commitments", () => {
  const notion = [
    {
      id: "n1",
      title: "Ellie call",
      date: "2026-05-07",
      people: ["Ellie Black"],
      highlight:
        "Action items. Robby to get evidence from Ellie about Brett's workload. Ellie to do reviews.",
    },
  ];
  const p = extractNotionPromises(notion);
  assert.equal(p.length, 1);
  assert.match(p[0].title, /Robby to get evidence/);
  assert.equal(p[0].counterparty, "Ellie Black");
  assert.equal(p[0].kind, "promise_made");
});

test("extractNotionPromises captures multiple commitments per note", () => {
  const notion = [
    {
      id: "n1",
      title: "Big meeting",
      date: "2026-05-07",
      highlight:
        "Robby to call Dave. Robby to discuss compensation. Robby will follow up Friday.",
    },
  ];
  const p = extractNotionPromises(notion);
  assert.ok(p.length >= 3);
});

test("extractNotionPromises ignores non-Robby actors", () => {
  const notion = [
    {
      id: "n1",
      title: "Big meeting",
      date: "2026-05-07",
      highlight: "Brian to send the deck. Ellie to complete reviews.",
    },
  ];
  const p = extractNotionPromises(notion);
  assert.equal(p.length, 0);
});

test("extractSentMailPromises catches 'I'll' commitments", () => {
  const sent = [
    {
      message_id: "s1",
      subject: "Re: Q3 plan",
      preview: "Sounds good. I'll send you the updated draft by Friday.",
      recipients_to: "brian@example.com",
      date_received: "Friday, May 8, 2026 at 10:00 AM",
    },
  ];
  const p = extractSentMailPromises(sent);
  assert.equal(p.length, 1);
  assert.match(p[0].title, /I'?ll send/);
  assert.equal(p[0].counterparty, "brian@example.com");
});

test("extractSentMailPromises skips OOO and refusal patterns", () => {
  const sent = [
    {
      message_id: "ooo",
      subject: "OOO",
      preview: "I'll be out until Monday.",
      recipients_to: "team@example.com",
    },
    {
      message_id: "refuse",
      subject: "Re: ask",
      preview: "I will not be able to make this work this quarter.",
      recipients_to: "team@example.com",
    },
  ];
  const p = extractSentMailPromises(sent);
  assert.equal(p.length, 0);
});

test("extractAllPromises produces stable IDs across runs", () => {
  const notion = [
    { id: "n1", title: "Call", date: "2026-05-07", highlight: "Robby to send the brief." },
  ];
  const a = extractAllPromises({ notion, sent: [] });
  const b = extractAllPromises({ notion, sent: [] });
  assert.equal(a[0].id, b[0].id);
});

test("extractNotionPromises uses explicit commitments_robby_made when present", () => {
  const notion = [
    {
      id: "n1",
      title: "Team call",
      date: "2026-05-07",
      people: ["Ellie Black"],
      highlight: "Generic prose without a Robby pattern.",
      commitments_robby_made: [
        "Provide Ellie with compensation answer by end of month",
        "Get evidence about Brett's workload",
      ],
    },
  ];
  const p = extractNotionPromises(notion);
  assert.ok(p.length >= 2, `expected 2 explicit commitments, got ${p.length}`);
  assert.ok(p.some((x) => x.title.includes("compensation answer")));
  assert.ok(p.some((x) => x.title.includes("Brett")));
  assert.ok(p[0].payload?.explicit === true, "explicit commitments are flagged");
});

test("extractNotionPromises combines explicit array with regex matches and dedupes", () => {
  const notion = [
    {
      id: "n1",
      title: "Team call",
      date: "2026-05-07",
      highlight: "Robby to discuss compensation with Dave today.",
      commitments_robby_made: ["Discuss compensation with Dave today"],
    },
  ];
  const p = extractNotionPromises(notion);
  // The explicit "Discuss compensation with Dave today" and regex
  // "Robby to discuss compensation with Dave today" are near-duplicates;
  // dedupe should keep the longer one.
  assert.ok(p.length >= 1);
  assert.ok(p.length <= 2);
});

test("extractNotionPromises dedupes near-identical phrases", () => {
  const notion = [
    {
      id: "n1",
      title: "Big meeting",
      date: "2026-05-07",
      highlight: "Robby to discuss compensation. Robby to discuss compensation with Dave.",
    },
  ];
  const p = extractNotionPromises(notion);
  // Both start with "Robby to discuss compensation" so they dedupe by prefix.
  assert.equal(p.length, 1);
});
