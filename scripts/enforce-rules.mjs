#!/usr/bin/env node
// Final-pass enforcement of Robby's writing rules. Reads a markdown file,
// applies safe rewrites for the highest-frequency violations, and writes the
// cleaned file in place. Reports each rewrite to stderr for auditability.
//
// Rules enforced (triple-anchored from CLAUDE.md):
//   - No em dashes (— or –). Replace with ", ", ": ", or ". " based on context.
//   - No "isn't just X" / "is more than X" framing.
//   - No "brother" diction.
//   - No EOS / Intrapreneurship terminology.
//   - No Diversity and Inclusion / DEI / D&I references.
//
// Usage: enforce-rules.mjs path/to/brief.md
//
// Exit codes: 0 if zero violations (or all rewritten), 2 if a rule could not be
// safely rewritten and human review is required.

import { readFile, writeFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: enforce-rules.mjs path/to/brief.md\n");
  process.exit(2);
}

const src = await readFile(file, "utf8");
const violations = [];
let out = src;

// 1. All Unicode dash variants. Earlier version only covered em (U+2014) and
//    en (U+2013) dashes; the adversarial test ADV-E1 found that figure dash
//    (U+2012), horizontal bar (U+2015), small em dash (U+FE58), small hyphen-
//    minus (U+FE63), and fullwidth hyphen-minus (U+FF0D) slipped through.
//    Replace any of them with a comma in space-bounded mid-sentence context.
const DASH_CLASS = "[\\u2012\\u2013\\u2014\\u2015\\u2053\\uFE58\\uFE63\\uFF0D]";
const dashCount = (out.match(new RegExp(DASH_CLASS, "g")) ?? []).length;
if (dashCount > 0) {
  out = out.replace(new RegExp(`\\s*${DASH_CLASS}\\s*`, "g"), ", ");
  violations.push({ rule: "em_dash", count: dashCount, mode: "auto-replaced with comma" });
}

// 2. "isn't just X" / "is more than X" framing. Hard to auto-rewrite cleanly,
//    so we flag and require manual rewrite.
const ijMatches = [...out.matchAll(/\b(is(?:n['']?t)?|are(?:n['']?t)?)\s+(just|more than)\b/gi)];
if (ijMatches.length > 0) {
  violations.push({
    rule: "contract_framing",
    count: ijMatches.length,
    mode: "flagged for manual rewrite",
    samples: ijMatches.slice(0, 3).map((m) => m[0]),
  });
}

// 3. "brother" diction.
const brotherMatches = [...out.matchAll(/\bbrother(s)?\b/gi)];
if (brotherMatches.length > 0) {
  // Swap to "man" / "men" depending on plurality.
  out = out.replace(/\bbrothers\b/gi, "men").replace(/\bbrother\b/gi, "man");
  violations.push({ rule: "brother_diction", count: brotherMatches.length, mode: "auto-replaced" });
}

// 4. EOS / Intrapreneurship. Just flag; safe replacement requires context.
const eosMatches = [
  ...out.matchAll(/\b(EOS|Entrepreneurial Operating System|Intrapreneurship)\b/g),
];
if (eosMatches.length > 0) {
  violations.push({ rule: "eos_language", count: eosMatches.length, mode: "flagged for manual rewrite" });
}

// 5. D&I references.
const diMatches = [
  ...out.matchAll(/\b(Diversity\s+and\s+Inclusion|DEI|D&I)\b/g),
];
if (diMatches.length > 0) {
  violations.push({ rule: "di_reference", count: diMatches.length, mode: "flagged for manual rewrite" });
}

await writeFile(file, out);

if (violations.length === 0) {
  process.stderr.write(`[enforce-rules] clean: ${file}\n`);
  process.exit(0);
}

process.stderr.write(`[enforce-rules] ${file}:\n`);
for (const v of violations) {
  process.stderr.write(`  - ${v.rule}: ${v.count} (${v.mode})`);
  if (v.samples) process.stderr.write(` samples: ${v.samples.join(", ")}`);
  process.stderr.write("\n");
}
// Hard fail only on flagged-for-manual rules.
const needsManual = violations.some(
  (v) => v.mode.includes("manual rewrite") && !["em_dash"].includes(v.rule),
);
process.exit(needsManual ? 2 : 0);
