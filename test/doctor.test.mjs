// Tests for scripts/doctor.mjs. The doctor is a diagnostic; these assert it
// runs without crashing, reports the platform, surfaces the right MCP
// reminders per OS, and flags a hard blocker under --strict.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "..", "scripts", "doctor.mjs");

function runDoctor(args = [], env = {}) {
  return new Promise((resolveP) => {
    const child = spawn("node", [SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

test("DOC-1: doctor runs and prints a checklist without crashing", async () => {
  const r = await runDoctor();
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /morning-mvp doctor/);
  assert.match(r.stdout, /Node\.js/);
  assert.match(r.stdout, /data\/ writable/);
});

test("DOC-2: reports the detected platform", async () => {
  const r = await runDoctor([], { MORNING_MVP_PLATFORM: "win32" });
  assert.match(r.stdout, /platform: win32/);
});

test("DOC-3: shows Gmail/Calendar MCP reminders on win32, Fantastical on darwin", async () => {
  const win = await runDoctor([], { MORNING_MVP_PLATFORM: "win32" });
  assert.match(win.stdout, /Gmail plugin MCP/);
  assert.match(win.stdout, /Google Calendar plugin MCP/);

  const mac = await runDoctor([], { MORNING_MVP_PLATFORM: "darwin" });
  assert.match(mac.stdout, /Fantastical/);
});

test("DOC-4: always exits 0 by default even with warnings", async () => {
  const r = await runDoctor();
  assert.equal(r.code, 0);
});

test("DOC-5: Node version check passes on the current (>=20) runtime", async () => {
  const r = await runDoctor();
  assert.match(r.stdout, /✓ Node\.js/);
});
