// Tests for scripts/lib/cli.mjs parseArgs + flagEnabled. The boolean-flag bug
// these fix was real: a trailing valueless `--dry-run` used to parse to
// undefined, turning a requested dry-run into a real write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, flagEnabled } from "../scripts/lib/cli.mjs";

test("CLI-1: parses --key value pairs", () => {
  assert.deepEqual(parseArgs(["--ranked", "a.json", "--days", "7"]), {
    ranked: "a.json",
    days: "7",
  });
});

test("CLI-2: a trailing valueless flag becomes boolean true (the bug fix)", () => {
  assert.deepEqual(parseArgs(["--ranked", "a.json", "--dry-run"]), {
    ranked: "a.json",
    "dry-run": true,
  });
});

test("CLI-3: a valueless flag followed by another flag becomes true (not the next flag)", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--date", "2026-06-02"]), {
    "dry-run": true,
    date: "2026-06-02",
  });
});

test("CLI-4: explicit --dry-run false stays the string 'false'", () => {
  assert.deepEqual(parseArgs(["--dry-run", "false"]), { "dry-run": "false" });
});

test("CLI-5: empty argv yields empty object", () => {
  assert.deepEqual(parseArgs([]), {});
});

test("CLI-6: non-flag tokens are ignored", () => {
  assert.deepEqual(parseArgs(["positional", "--k", "v"]), { k: "v" });
});

test("CLI-7: flagEnabled treats boolean true and truthy strings as enabled", () => {
  assert.equal(flagEnabled(true), true);
  assert.equal(flagEnabled("true"), true);
  assert.equal(flagEnabled("1"), true);
  assert.equal(flagEnabled("yes"), true);
  assert.equal(flagEnabled("TRUE"), true);
});

test("CLI-8: flagEnabled treats false/undefined/other as disabled", () => {
  assert.equal(flagEnabled("false"), false);
  assert.equal(flagEnabled(undefined), false);
  assert.equal(flagEnabled("no"), false);
  assert.equal(flagEnabled("0"), false);
  assert.equal(flagEnabled(""), false);
});

test("CLI-9: the original bug scenario now yields dryRun=true", () => {
  // Before: `--dry-run` last arg -> args["dry-run"] === undefined -> dryRun false.
  // After: -> true -> flagEnabled true.
  const args = parseArgs(["--date", "2026-06-02", "--dry-run"]);
  const dryRun = flagEnabled(args["dry-run"]);
  assert.equal(dryRun, true);
});
