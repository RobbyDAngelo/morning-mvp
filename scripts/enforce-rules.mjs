#!/usr/bin/env node
// Final-pass enforcement of writing rules on the brief markdown. Reads a file,
// applies safe rewrites, writes it back in place, and reports each change to
// stderr for auditability.
//
// UNIVERSAL rule (always on, for every user):
//   - No em dashes. Every Unicode dash variant is replaced with a comma.
//     This is just good writing and is safe to auto-apply.
//
// BRAND rules (OFF by default; opt in per user). These are specific to a
// particular brand voice and would mangle or wrongly block another user's
// brief (e.g. rewriting "call my brother" or rejecting a brief that mentions
// the EOS business framework). Enable them with `--brand` or in
// config.local.json:
//
//   "writing": {
//     "no_brother": true,            // rewrite "brother"/"brothers" -> "man"/"men"
//     "no_contract_framing": true,   // flag "isn't just X" / "is more than X"
//     "no_eos": true,                // flag EOS / Intrapreneurship terms
//     "no_di": true                  // flag Diversity and Inclusion / DEI / D&I
//   }
//
// Usage: enforce-rules.mjs path/to/brief.md [--brand]
//
// Exit codes: 0 if clean or all auto-rewritten; 2 if an enabled brand rule
// flagged something that needs manual rewrite.

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs, flagEnabled } from "./lib/cli.mjs";
import { loadConfig } from "./lib/load-config.mjs";

const args = parseArgs();
// parseArgs ignores positionals, so take the first non-flag argv entry as the
// brief file path (e.g. `enforce-rules.mjs brief.md --brand`).
const target = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!target) {
  process.stderr.write("usage: enforce-rules.mjs path/to/brief.md [--brand]\n");
  process.exit(2);
}

// Decide which brand rules are active: --brand turns them all on; otherwise
// read per-rule flags from config.writing. Default: all off.
const cfg = await loadConfig();
const writing = cfg?.writing ?? {};
const brandAll = flagEnabled(args.brand);
const rules = {
  no_brother: brandAll || writing.no_brother === true,
  no_contract_framing: brandAll || writing.no_contract_framing === true,
  no_eos: brandAll || writing.no_eos === true,
  no_di: brandAll || writing.no_di === true,
};

const src = await readFile(target, "utf8");
const violations = [];
let out = src;

// 1. UNIVERSAL: all Unicode dash variants -> comma. Covers figure (U+2012),
//    en (U+2013), em (U+2014), horizontal bar (U+2015), swung (U+2053),
//    small em (U+FE58), small hyphen-minus (U+FE63), fullwidth (U+FF0D).
const DASH_CLASS = "[\\u2012\\u2013\\u2014\\u2015\\u2053\\uFE58\\uFE63\\uFF0D]";
const dashCount = (out.match(new RegExp(DASH_CLASS, "g")) ?? []).length;
if (dashCount > 0) {
  out = out.replace(new RegExp(`\\s*${DASH_CLASS}\\s*`, "g"), ", ");
  violations.push({ rule: "em_dash", count: dashCount, mode: "auto-replaced with comma" });
}

// 2. BRAND: "isn't just X" / "is more than X" framing.
if (rules.no_contract_framing) {
  const ijMatches = [...out.matchAll(/\b(is(?:n['']?t)?|are(?:n['']?t)?)\s+(just|more than)\b/gi)];
  if (ijMatches.length > 0) {
    violations.push({
      rule: "contract_framing",
      count: ijMatches.length,
      mode: "flagged for manual rewrite",
      samples: ijMatches.slice(0, 3).map((m) => m[0]),
    });
  }
}

// 3. BRAND: "brother" diction -> "man" / "men".
if (rules.no_brother) {
  const brotherMatches = [...out.matchAll(/\bbrother(s)?\b/gi)];
  if (brotherMatches.length > 0) {
    out = out.replace(/\bbrothers\b/gi, "men").replace(/\bbrother\b/gi, "man");
    violations.push({ rule: "brother_diction", count: brotherMatches.length, mode: "auto-replaced" });
  }
}

// 4. BRAND: EOS / Intrapreneurship.
if (rules.no_eos) {
  const eosMatches = [...out.matchAll(/\b(EOS|Entrepreneurial Operating System|Intrapreneurship)\b/g)];
  if (eosMatches.length > 0) {
    violations.push({ rule: "eos_language", count: eosMatches.length, mode: "flagged for manual rewrite" });
  }
}

// 5. BRAND: D&I references.
if (rules.no_di) {
  const diMatches = [...out.matchAll(/\b(Diversity\s+and\s+Inclusion|DEI|D&I)\b/g)];
  if (diMatches.length > 0) {
    violations.push({ rule: "di_reference", count: diMatches.length, mode: "flagged for manual rewrite" });
  }
}

await writeFile(target, out);

if (violations.length === 0) {
  process.stderr.write(`[enforce-rules] clean: ${target}\n`);
  process.exit(0);
}

process.stderr.write(`[enforce-rules] ${target}:\n`);
for (const v of violations) {
  process.stderr.write(`  - ${v.rule}: ${v.count} (${v.mode})`);
  if (v.samples) process.stderr.write(` samples: ${v.samples.join(", ")}`);
  process.stderr.write("\n");
}
// Hard fail only on flagged-for-manual rules (never on the auto-fixed em dash).
const needsManual = violations.some(
  (v) => v.mode.includes("manual rewrite") && v.rule !== "em_dash",
);
process.exit(needsManual ? 2 : 0);
