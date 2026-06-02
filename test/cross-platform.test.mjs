// Cross-platform safety tests. These exercise the Windows / Linux (non-macOS)
// code paths so a regression that would crash the partner's first brief gets
// caught here, on any OS. The macOS apple-mail path is forced off via
// MORNING_MVP_NO_APPLE_MAIL=1 / MORNING_MVP_PLATFORM so these run identically
// on a Mac CI box and on the partner's Windows machine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(__dirname, "..", "scripts");

function run(script, args, env = {}) {
  return new Promise((resolveP) => {
    const child = spawn(
      "node",
      ["--import", "tsx", join(SCRIPTS, script), ...args],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

async function tmpRanked(obj) {
  const dir = await mkdtemp(join(tmpdir(), "mmvp-xplat-"));
  const p = join(dir, "ranked.json");
  await writeFile(p, JSON.stringify(obj));
  return { dir, p };
}

test("XP-1: enrich-drafts skips gracefully when apple-mail is unavailable (no crash)", async () => {
  const { dir, p } = await tmpRanked({
    draft_reply_targets: [
      { message_id: "<w1>", sender: "Brian <b@x.com>", subject: "Call", account: "gmail", mailbox: "INBOX", priority: 10 },
    ],
  });
  try {
    const r = await run("enrich-drafts.mjs", ["--ranked", p, "--body-limit", "2500"], {
      MORNING_MVP_NO_APPLE_MAIL: "1",
    });
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr: ${r.stderr}`);
    assert.match(r.stdout, /"skipped":\s*true/);
    // The ranked file must remain valid JSON and keep the target intact.
    const ranked = JSON.parse(await readFile(p, "utf8"));
    assert.equal(ranked.draft_reply_targets.length, 1);
    assert.equal(ranked.draft_reply_targets[0].message_id, "<w1>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("XP-2: enrich-summaries seeds body_preview from the mail-provider snippet", async () => {
  const { dir, p } = await tmpRanked({
    waiting_on_me: [
      { message_id: "<w1>", subject: "TPA call", account: "gmail", mailbox: "INBOX", snippet: "Confirm Tuesday 2pm and ask for the brief." },
      { message_id: "<w2>", subject: "Redline", account: "gmail", mailbox: "INBOX", snippet: "Section 4 indemnity needs your sign-off." },
    ],
    decisions_waiting: [],
    responses_waiting: [],
    people_view: [],
  });
  try {
    const r = await run(
      "enrich-summaries.mjs",
      ["--ranked", p, "--max", "15", "--body-limit", "600", "--concurrency", "4", "--budget-ms", "90000"],
      { MORNING_MVP_NO_APPLE_MAIL: "1" },
    );
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr: ${r.stderr}`);
    const ranked = JSON.parse(await readFile(p, "utf8"));
    assert.equal(ranked.waiting_on_me[0].body_preview, "Confirm Tuesday 2pm and ask for the brief.");
    assert.equal(ranked.waiting_on_me[1].body_preview, "Section 4 indemnity needs your sign-off.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("XP-3: enrich-summaries leaves items with no snippet as subject-only (no crash)", async () => {
  const { dir, p } = await tmpRanked({
    waiting_on_me: [{ message_id: "<w3>", subject: "No snippet here", account: "gmail", mailbox: "INBOX" }],
    people_view: [],
  });
  try {
    const r = await run("enrich-summaries.mjs", ["--ranked", p, "--max", "15"], {
      MORNING_MVP_NO_APPLE_MAIL: "1",
    });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const ranked = JSON.parse(await readFile(p, "utf8"));
    assert.equal(ranked.waiting_on_me[0].body_preview, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("XP-4: cleanup-apps no-ops on a non-darwin platform (exit 0, skipped)", async () => {
  const r = await run("cleanup-apps.mjs", [], { MORNING_MVP_PLATFORM: "win32" });
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr: ${r.stderr}`);
  assert.match(r.stdout, /"skipped":\s*true/);
  assert.match(r.stdout, /"platform":\s*"win32"/);
});

test("XP-5: render-print writes the HTML file and exits 0 without a browser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mmvp-render-"));
  const md = join(dir, "brief.md");
  const html = join(dir, "brief.html");
  await writeFile(md, "# The One Thing\n\nShip the thing.\n\n## Who is waiting on me\n\n- **Brian**, call\n");
  try {
    // Force the linux opener (xdg-open), which is absent on both macOS and
    // Windows. That makes spawn emit 'error', so this test verifies the
    // error handler keeps the process alive AND never pops a real browser,
    // including when this suite runs as the install.ps1 smoke test on the
    // partner's Windows machine.
    const r = await run("render-print.mjs", [md], { MORNING_MVP_PLATFORM: "linux" });
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}. stderr: ${r.stderr}`);
    assert.ok(existsSync(html), "expected brief.html to be written");
    const out = await readFile(html, "utf8");
    assert.match(out, /<h1>The One Thing<\/h1>/);
    assert.match(out, /Ship the thing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
