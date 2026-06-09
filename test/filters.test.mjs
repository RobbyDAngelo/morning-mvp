import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLikelyNewsletter,
  isPersonalSender,
  urgencyScore,
  asksForReply,
  detectDeadlineHoursAhead,
} from "../scripts/filters.mjs";

test("isLikelyNewsletter catches noreply senders", () => {
  const v = isLikelyNewsletter({
    sender: "Acme <noreply@acme.com>",
    subject: "Your weekly digest",
  });
  assert.equal(v.drop, true);
  assert.ok(v.reasons.some((r) => r.startsWith("sender_pattern")));
});

test("isLikelyNewsletter catches Mailchimp domain", () => {
  const v = isLikelyNewsletter({ sender: "Foo <campaign@mailchimp.com>", subject: "Hi" });
  assert.equal(v.drop, true);
});

test("isLikelyNewsletter catches auto-reply local parts (USPS-style)", () => {
  // Regression: auto-reply@ was slipping through (automated? did not match it).
  for (const addr of [
    "auto-reply@tracking.usps.com",
    "autoreply@example.com",
    "auto.reply@example.com",
    "auto_reply@example.com",
  ]) {
    const v = isLikelyNewsletter({ sender: `Notice <${addr}>`, subject: "Your package" });
    assert.equal(v.drop, true, `${addr} should be dropped`);
    assert.ok(v.reasons.some((r) => r.startsWith("sender_pattern")));
  }
});

test("isLikelyNewsletter catches Stripe payment confirmations", () => {
  const v = isLikelyNewsletter({
    sender: "Stripe <receipts@stripe.com>",
    subject: "Your receipt from Foo",
  });
  assert.equal(v.drop, true);
});

test("isLikelyNewsletter catches calendar invites already accepted", () => {
  const v = isLikelyNewsletter({
    sender: "Brian Toelle <brian@narrowgate.group>",
    subject: "Accepted: Tech Talk @ Mon Mar 23",
  });
  assert.equal(v.drop, true);
});

test("isLikelyNewsletter keeps personal email from real sender", () => {
  const v = isLikelyNewsletter({
    sender: "Brian Toelle <briantoelle@gmail.com>",
    subject: "tpa-partner-directory",
  });
  assert.equal(v.drop, false);
  assert.deepEqual(v.reasons, []);
});

test("isLikelyNewsletter keeps personal email even from gmail", () => {
  const v = isLikelyNewsletter({
    sender: "Some Person <some.person@gmail.com>",
    subject: "quick question",
  });
  assert.equal(v.drop, false);
});

test("isPersonalSender accepts First Last <email>", () => {
  assert.equal(isPersonalSender("Brian Toelle <brian@example.com>"), true);
  assert.equal(isPersonalSender("Mary Ann O'Brien <mary@example.com>"), true);
});

test("isPersonalSender rejects single-word or bot senders", () => {
  assert.equal(isPersonalSender("noreply <noreply@github.com>"), false);
  assert.equal(isPersonalSender("GitHub <noreply@github.com>"), false);
  assert.equal(isPersonalSender("Notifications <notifications@app.com>"), false);
});

test("urgencyScore counts urgent keywords", () => {
  assert.ok(urgencyScore("URGENT: please review", "this is urgent and we need ASAP") >= 2);
  assert.equal(urgencyScore("Catch up sometime", "no rush"), 0);
});

test("asksForReply detects question marks", () => {
  assert.equal(asksForReply("Re: thoughts?", ""), true);
  assert.equal(asksForReply("Re: Notes", "any update on the deck"), true);
  assert.equal(asksForReply("FYI", "just sharing the latest version"), false);
});

test("detectDeadlineHoursAhead spots 'today'", () => {
  assert.equal(detectDeadlineHoursAhead("", "needs to ship today"), 8);
});

test("detectDeadlineHoursAhead spots 'by EOD'", () => {
  assert.equal(detectDeadlineHoursAhead("", "send over by EOD please"), 8);
});

test("detectDeadlineHoursAhead spots 'tomorrow'", () => {
  assert.equal(detectDeadlineHoursAhead("", "review tomorrow"), 24);
});

test("detectDeadlineHoursAhead returns null when no deadline cue", () => {
  assert.equal(detectDeadlineHoursAhead("FYI", "just letting you know"), null);
});
