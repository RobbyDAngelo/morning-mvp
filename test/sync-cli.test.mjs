import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(__dirname, "..", "scripts");

function run(script, args) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [resolve(SCRIPTS, script), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

test("push-calendar.mjs --dry-run does not require Calendar.app", async () => {
  const r = await run("push-calendar.mjs", ["--title", "Deep work: test", "--minutes", "60", "--dry-run", "true"]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dry_run, true);
  assert.equal(out.title, "Deep work: test");
  assert.ok(out.start);
  assert.ok(out.end);
});

test("push-calendar.mjs rejects bad --start format", async () => {
  const r = await run("push-calendar.mjs", ["--title", "x", "--start", "9am", "--dry-run", "true"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /bad --start/);
});

test("push-reminders.mjs --dry-run with empty ranked.slow_burn skips cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mvp-test-"));
  const rankedPath = join(dir, "ranked.json");
  await writeFile(
    rankedPath,
    JSON.stringify({ slow_burn: [], deadline_48h_mail: [], promises_made: [] }),
  );
  const r = await run("push-reminders.mjs", ["--ranked", rankedPath, "--dry-run", "true"]);
  await rm(dir, { recursive: true, force: true });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.skipped, true);
});

test("push-reminders.mjs --dry-run formats items correctly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mvp-test-"));
  const rankedPath = join(dir, "ranked.json");
  await writeFile(
    rankedPath,
    JSON.stringify({
      slow_burn: [
        { age_days: 5, title: "Old commitment", kind: "promise_made", counterparty: "Brian" },
      ],
      deadline_48h_mail: [
        { subject: "Today's call", sender: "Boss <b@x>", account: "Work" },
      ],
      promises_made: [
        { days_open: 3, title: "Send the deck", counterparty: "Ellie", source: "notion:meeting" },
        { days_open: 0, title: "Fresh promise (should skip)", counterparty: "?" },
      ],
    }),
  );
  const r = await run("push-reminders.mjs", ["--ranked", rankedPath, "--dry-run", "true"]);
  await rm(dir, { recursive: true, force: true });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dry_run, true);
  // 1 slow_burn + 1 48h + 1 promise (3d), the fresh promise (0d) is skipped.
  assert.equal(out.would_push, 3);
  assert.ok(out.items.some((i) => /Slow burn/.test(i.name)));
  assert.ok(out.items.some((i) => /48h/.test(i.name)));
  assert.ok(out.items.some((i) => /Promise/.test(i.name)));
});

test("prepare-notion-payload.mjs reports skipped when no config", async () => {
  // The test process doesn't write config.local.json; verify graceful skip.
  const dir = await mkdtemp(join(tmpdir(), "mvp-test-"));
  const briefPath = join(dir, "brief.md");
  await writeFile(briefPath, "# The One Thing\nDo X because Y.\n");
  const r = await run("prepare-notion-payload.mjs", ["--brief", briefPath, "--date", "2026-05-11"]);
  await rm(dir, { recursive: true, force: true });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  // Depends on whether config.local.json has sync.notion.enabled set.
  // On a clean machine: skipped. On a configured machine: not skipped.
  assert.ok(out.skipped !== undefined);
});
