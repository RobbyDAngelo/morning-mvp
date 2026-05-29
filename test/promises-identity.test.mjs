// Verifies promises.mjs honors identity.first_name and the multiple
// commitment-field-name conventions.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractAllPromises,
  extractNotionPromises,
} from "../scripts/promises.mjs";

test("PI-1: extractNotionPromises default firstName=Robby still works (back-compat)", () => {
  const got = extractNotionPromises([
    {
      id: "n1",
      title: "Robby + Brian sync",
      date: "2026-05-01",
      highlight: "Robby to send the contract by Tuesday.",
    },
  ]);
  assert.equal(got.length, 1);
  assert.match(got[0].title, /Robby to send/);
});

test("PI-2: extractNotionPromises scopes regex to identity.first_name", () => {
  const got = extractNotionPromises(
    [
      {
        id: "n2",
        title: "Bryan strategy call",
        date: "2026-05-01",
        highlight: "Bryan to share the deck by Friday.",
      },
    ],
    { first_name: "Bryan" },
  );
  assert.equal(got.length, 1);
  assert.match(got[0].title, /Bryan to share/);
});

test("PI-3: with identity=Bryan, 'Robby to ...' prose is NOT picked up", () => {
  const got = extractNotionPromises(
    [
      {
        id: "n3",
        title: "Bryan call",
        date: "2026-05-01",
        highlight: "Robby to follow up with sales (third-party action item).",
      },
    ],
    { first_name: "Bryan" },
  );
  assert.equal(got.length, 0);
});

test("PI-4: curated commitments_<first>_made array is preferred", () => {
  const got = extractNotionPromises(
    [
      {
        id: "n4",
        title: "Bryan + Dana",
        date: "2026-05-01",
        commitments_bryan_made: ["Email Dana with revised numbers."],
        highlight: "Bryan to send the report.",
      },
    ],
    { first_name: "Bryan" },
  );
  assert.ok(got.some((p) => p.title.includes("Email Dana")));
  assert.ok(got.some((p) => p.payload?.explicit === true));
});

test("PI-5: generic commitments_made field works for any user", () => {
  const got = extractNotionPromises(
    [
      {
        id: "n5",
        title: "Generic note",
        date: "2026-05-01",
        commitments_made: ["Draft the proposal by Friday."],
      },
    ],
    { first_name: "Anyone" },
  );
  assert.equal(got.length, 1);
  assert.match(got[0].title, /Draft the proposal/);
  assert.equal(got[0].payload.explicit, true);
});

test("PI-6: my_commitments alias works", () => {
  const got = extractNotionPromises(
    [
      {
        id: "n6",
        title: "Notes",
        date: "2026-05-01",
        my_commitments: ["Call the client Monday."],
      },
    ],
    {},
  );
  assert.equal(got.length, 1);
});

test("PI-7: handles hyphenated firstName safely in regex", () => {
  const got = extractNotionPromises(
    [
      {
        id: "n7",
        title: "Anne-Marie meeting",
        date: "2026-05-01",
        highlight: "Anne-Marie to lead the next standup.",
      },
    ],
    { first_name: "Anne-Marie" },
  );
  assert.equal(got.length, 1);
  assert.match(got[0].title, /Anne-Marie to lead/);
});

test("PI-8: extractAllPromises threads identity through to Notion extractor", () => {
  const got = extractAllPromises({
    notion: [
      {
        id: "ag",
        title: "Aggregate",
        date: "2026-05-01",
        highlight: "Sarah to ship the migration today.",
      },
    ],
    sent: [],
    identity: { first_name: "Sarah" },
  });
  assert.equal(got.length, 1);
  assert.match(got[0].title, /Sarah to ship/);
});

test("PI-9: extractAllPromises without identity still works (back-compat)", () => {
  const got = extractAllPromises({
    notion: [
      {
        id: "ag2",
        title: "Aggregate",
        date: "2026-05-01",
        highlight: "Robby to update the brief.",
      },
    ],
    sent: [],
  });
  assert.equal(got.length, 1);
});

test("PI-10: SentMail first-person extractor is identity-agnostic (unchanged)", () => {
  const got = extractAllPromises({
    notion: [],
    sent: [
      {
        message_id: "<m1>",
        subject: "Re: proposal",
        date_received: "Mon, May 5, 2026 at 10:00 AM",
        preview: "Thanks for the note. I'll send the revised draft tomorrow.",
        recipients_to: "dana@example.com",
      },
    ],
    identity: { first_name: "Bryan" },
  });
  assert.equal(got.length, 1);
  assert.match(got[0].title, /I'll send the revised draft/);
});
