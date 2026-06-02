#!/usr/bin/env node
// Quits Calendar.app and Fantastical after the morning brief is rendered.
// Why: both apps are pulled in during data collection (step 2 / 2a) but the
// brief itself lives in the browser as printable HTML. Once the brief is on
// screen, neither app needs to stay open eating memory and dock space.
//
// Idempotent: quitting an already-closed app is a no-op. Failures are logged
// to stderr and swallowed so the brief is never blocked by cleanup issues.
//
// Usage:
//   cleanup-apps.mjs                 # quits both Calendar and Fantastical
//   cleanup-apps.mjs --dry-run       # prints what would happen, quits nothing
//   cleanup-apps.mjs --only Calendar # quit one specific app

import { spawn } from "node:child_process";

const TIMEOUT_MS = 8_000;

function quitApp(appName) {
  return new Promise((resolveP) => {
    const child = spawn(
      "/usr/bin/osascript",
      ["-e", `tell application "${appName}" to if it is running then quit`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveP({ ok: false, app: appName, error: `timeout after ${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS);
    // Missing binary (e.g. osascript on Windows) emits 'error', not 'close'.
    // Without this handler Node throws an uncaught exception and crashes.
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ ok: false, app: appName, error: err.message });
    });
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveP({ ok: true, app: appName });
      else resolveP({ ok: false, app: appName, error: stderr.trim() || `exit ${code}` });
    });
  });
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);
const dryRun = args["dry-run"] !== undefined && args["dry-run"] !== "false";
const only = args.only;

const APPS = only ? [only] : ["Calendar", "Fantastical"];

// Calendar.app and Fantastical only exist on macOS. On Windows/Linux there is
// nothing to quit, so this is a clean no-op (the brief is already rendered).
// MORNING_MVP_PLATFORM overrides the detected platform (used by tests).
const PLATFORM = process.env.MORNING_MVP_PLATFORM || process.platform;
if (PLATFORM !== "darwin") {
  process.stderr.write(
    `[cleanup-apps] platform=${PLATFORM}, no macOS calendar apps to quit. Skipping.\n`,
  );
  process.stdout.write(JSON.stringify({ skipped: true, platform: PLATFORM }) + "\n");
  process.exit(0);
}

if (dryRun) {
  process.stdout.write(
    JSON.stringify({ dry_run: true, would_quit: APPS }, null, 2) + "\n",
  );
  process.exit(0);
}

const results = await Promise.all(APPS.map(quitApp));
for (const r of results) {
  if (!r.ok) process.stderr.write(`[cleanup-apps] could not quit ${r.app}: ${r.error}\n`);
  else process.stderr.write(`[cleanup-apps] quit ${r.app}\n`);
}
process.stdout.write(JSON.stringify({ results }, null, 2) + "\n");
