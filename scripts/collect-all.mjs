#!/usr/bin/env node
// Orchestrator: runs collect-mail + collect-basecamp in parallel and writes a
// single raw JSON. Notion data is fetched by Claude during the skill workflow
// (via the Notion MCP) since MCP tools aren't accessible from a standalone
// Node script.

import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA = resolve(ROOT, "data");
await mkdir(DATA, { recursive: true });

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);
const days = Math.max(1, Math.min(Number(args.days ?? 7), 30));
const today = new Date().toISOString().slice(0, 10);

function run(cmd, scriptArgs) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [`--import`, `tsx`, cmd, ...scriptArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

const [mailRes, bcRes, calRes, metricsRes] = await Promise.all([
  run(resolve(__dirname, "collect-mail.mjs"), ["--days", String(days)]),
  run(resolve(__dirname, "collect-basecamp.mjs"), ["--days", String(days)]),
  run(resolve(__dirname, "collect-calendar.mjs"), ["--hours", "36"]),
  run(resolve(__dirname, "collect-metrics.mjs"), []),
]);

process.stderr.write(mailRes.stderr);
process.stderr.write(bcRes.stderr);
process.stderr.write(calRes.stderr);
process.stderr.write(metricsRes.stderr);

function safeJson(label, res) {
  try {
    return JSON.parse(res.stdout || "null");
  } catch {
    return { error: `could not parse ${label} output`, stderr: res.stderr };
  }
}

const mail = safeJson("collect-mail", mailRes);
const basecamp = safeJson("collect-basecamp", bcRes);
const calendar = safeJson("collect-calendar", calRes);
const metrics = safeJson("collect-metrics", metricsRes);

const raw = {
  generated_at: new Date().toISOString(),
  window_days: days,
  mail,
  basecamp,
  calendar,
  metrics,
};

const outPath = resolve(DATA, `raw-${today}.json`);
await writeFile(outPath, JSON.stringify(raw, null, 2));
process.stdout.write(outPath + "\n");
process.stderr.write(`[collect-all] wrote ${outPath}\n`);
