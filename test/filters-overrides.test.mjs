// Tests for the per-user filter override mechanism in filters.mjs:
// always_drop_senders / always_drop_domains / always_include_senders /
// always_include_domains. This is the F-4 mitigation from SECURITY-REVIEW.md
// (marketing senders with a personal display name bypass the heuristics).
//
// Generic fixtures only. Real per-user drop lists live in the user's
// gitignored config.local.json, never in the repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isLikelyNewsletter } from "../scripts/filters.mjs";

test("OV-1: always_drop_domains drops a personal-name marketing sender", () => {
  const v = isLikelyNewsletter(
    { sender: "Jane Coach <jane@coaching-brand.com>", subject: "Scale your business" },
    { always_drop_domains: ["coaching-brand.com"] },
  );
  assert.equal(v.drop, true);
  assert.ok(v.reasons.some((r) => r.startsWith("user_drop_domain")));
});

test("OV-2: always_drop_domains matches subdomains (base domain catches reply.*)", () => {
  const v = isLikelyNewsletter(
    { sender: "Jane Coach <jane@reply.coaching-brand.com>", subject: "Newsletter" },
    { always_drop_domains: ["coaching-brand.com"] },
  );
  assert.equal(v.drop, true);
});

test("OV-3: always_drop_domains catches a rotated send address on the same domain", () => {
  const v = isLikelyNewsletter(
    { sender: "Jane Coach <newsletter@coaching-brand.com>", subject: "New cohort" },
    { always_drop_domains: ["coaching-brand.com"] },
  );
  assert.equal(v.drop, true);
});

test("OV-4: always_drop_senders drops an exact email", () => {
  const v = isLikelyNewsletter(
    { sender: "Jane Coach <jane@coaching-brand.com>", subject: "hi" },
    { always_drop_senders: ["jane@coaching-brand.com"] },
  );
  assert.equal(v.drop, true);
  assert.ok(v.reasons.some((r) => r.startsWith("user_drop_sender")));
});

test("OV-5: allowlist WINS over droplist", () => {
  const v = isLikelyNewsletter(
    { sender: "Jane Coach <jane@coaching-brand.com>", subject: "personal note" },
    {
      always_drop_domains: ["coaching-brand.com"],
      always_include_senders: ["jane@coaching-brand.com"],
    },
  );
  assert.equal(v.drop, false);
  assert.deepEqual(v.reasons, ["user_allowlist"]);
});

test("OV-6: allowlist rescues a sender the heuristics would otherwise drop", () => {
  const v = isLikelyNewsletter(
    { sender: "System <noreply@vendor.com>", subject: "Your weekly digest" },
    { always_include_domains: ["vendor.com"] },
  );
  assert.equal(v.drop, false);
});

test("OV-7: a sender not in any list still follows the heuristics", () => {
  // Clean personal sender survives.
  const keep = isLikelyNewsletter(
    { sender: "Real Person <real@somecompany.com>", subject: "Re: our call" },
    { always_drop_domains: ["coaching-brand.com"] },
  );
  assert.equal(keep.drop, false);
});

test("OV-8: domain match respects the dot boundary (no false partial match)", () => {
  // "brand.com" must NOT drop "notbrand.com".
  const v = isLikelyNewsletter(
    { sender: "Someone <x@notbrand.com>", subject: "hi" },
    { always_drop_domains: ["brand.com"] },
  );
  assert.equal(v.drop, false);
});

test("OV-9: leading @ on a domain list entry is tolerated", () => {
  const v = isLikelyNewsletter(
    { sender: "Jane <jane@coaching-brand.com>", subject: "hi" },
    { always_drop_domains: ["@coaching-brand.com"] },
  );
  assert.equal(v.drop, true);
});

test("OV-10: matching is case-insensitive", () => {
  const v = isLikelyNewsletter(
    { sender: "Jane <Jane@Coaching-Brand.COM>", subject: "hi" },
    { always_drop_senders: ["jane@coaching-brand.com"] },
  );
  assert.equal(v.drop, true);
});

test("OV-11: backward compatible, no overrides arg behaves as before", () => {
  const keep = isLikelyNewsletter({
    sender: "Real Person <real@somecompany.com>",
    subject: "Re: our call",
  });
  assert.equal(keep.drop, false);
  const drop = isLikelyNewsletter({ sender: "X <noreply@acme.com>", subject: "digest" });
  assert.equal(drop.drop, true);
});
