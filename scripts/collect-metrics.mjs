#!/usr/bin/env node
// Pluggable metrics collector. Reads metrics config from config.local.json
// (or config.example.json fallback), runs each metric's command, captures
// the value, formats per the template, and outputs JSON.
//
// Config shape:
//   {
//     "metrics": [
//       { "label": "Inbox unread", "command": "...", "format": "${value}" },
//       { "label": "Basecamp open", "command": "...", "format": "${value} open todos" }
//     ]
//   }
//
// Each command should print a single value to stdout (number or short string).
// Commands run with /bin/sh -c so shell features (pipes, env vars) work.
//
// Sample commands ship as runnable defaults:
//   - Inbox unread:    Uses apple-mail-mcp's getUnreadMessages count.
//   - Basecamp open:   Counts active todos via collect-basecamp.
//
// Output:
//   { generated_at, metrics: [{label, value, formatted, error?}] }

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, "..");

async function loadConfig() {
  const local = resolve(SKILL_ROOT, "config.local.json");
  const example = resolve(SKILL_ROOT, "config.example.json");
  const path = existsSync(local) ? local : example;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

function runShell(cmd, timeoutMs = 60_000) {
  return new Promise((resolveP) => {
    // Use the platform's shell so pipes / redirects work on each OS.
    const [shell, shellArgs] =
      process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["/bin/sh", ["-c", cmd]];
    const child = spawn(shell, shellArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveP({ code: 124, stdout, stderr: stderr + `\n(timed out after ${timeoutMs}ms)` });
    }, timeoutMs);
    // A missing shell emits 'error' (not 'close'); handle it so we never throw.
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ code: 127, stdout: "", stderr: err.message });
    });
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

const cfg = await loadConfig();
const metricDefs = cfg?.metrics ?? [];

// Default external metrics. These run only when no user-defined metrics are
// configured. They cover sources that LIVE OUTSIDE ranked.json (which is
// where the "headline_metrics" come from). Keep these CHEAP and ALWAYS
// AVAILABLE: anything that scans all of Mail.app is too slow for a default
// and lives in headline_metrics instead.
// The default metric uses a POSIX pipe (grep, echo) and only runs when the
// user has not defined their own metrics. It is skipped on Windows, where
// that shell syntax is not available; the headline_metrics derived from
// ranked.json still cover the important counts there.
const DEFAULTS =
  process.platform === "win32"
    ? []
    : [
        {
          // Basecamp assigned-to-me todo count. Reuses the collect-basecamp.mjs
          // output and counts only `app_url` entries (one per todo) rather than
          // `id` keys (which appear at many nesting levels).
          label: "Basecamp open todos",
          command: `node ${SKILL_ROOT}/scripts/collect-basecamp.mjs 2>/dev/null | grep -c '"app_url":' || echo 0`,
          format: "${value} Basecamp todos assigned to you",
        },
      ];

const metrics = metricDefs.length > 0 ? metricDefs : DEFAULTS;
const results = [];
for (const m of metrics) {
  if (!m.command) {
    results.push({ label: m.label, error: "no command" });
    continue;
  }
  const r = await runShell(m.command);
  if (r.code !== 0) {
    results.push({ label: m.label, error: r.stderr || `exit ${r.code}`, value: null });
    continue;
  }
  const value = r.stdout.trim().split("\n").pop() || "";
  const formatted = (m.format || "${value}").replace(/\$\{value\}/g, value);
  results.push({ label: m.label, value, formatted });
}

process.stdout.write(
  JSON.stringify({ generated_at: new Date().toISOString(), metrics: results }, null, 2),
);
process.stderr.write(`[collect-metrics] ${results.length} metric(s), ${results.filter(r => !r.error).length} ok\n`);
