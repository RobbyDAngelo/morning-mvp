#!/usr/bin/env node
// Preflight diagnostic. Runs every environment check that commonly blocks a
// first run and prints a green/red checklist. Safe to run anytime:
//
//   node scripts/doctor.mjs
//   npm run doctor
//
// It cannot see which Claude Code MCP plugins are connected (those live in
// Claude's tool space, not Node's), so for mail/calendar it tells you what to
// verify inside Claude. Everything else it checks directly. Always exits 0
// unless --strict is passed, in which case a hard blocker exits 1.

import { readFile, access, writeFile, unlink, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { spawn } from "node:child_process";
import { parseArgs, flagEnabled } from "./lib/cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const args = parseArgs();
const strict = flagEnabled(args.strict);

const OS = process.env.MORNING_MVP_PLATFORM || platform();
const OK = "✓"; // check
const WARN = "!";
const BAD = "✗"; // x

const rows = [];
let blockers = 0;
function ok(label, detail = "") {
  rows.push(`  ${OK} ${label}${detail ? `: ${detail}` : ""}`);
}
function warn(label, detail = "") {
  rows.push(`  ${WARN} ${label}${detail ? `: ${detail}` : ""}`);
}
function bad(label, detail = "") {
  rows.push(`  ${BAD} ${label}${detail ? `: ${detail}` : ""}`);
  blockers += 1;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(p) {
  try {
    return { ok: true, value: JSON.parse(await readFile(p, "utf8")) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function which(cmd) {
  return new Promise((resolveP) => {
    const probe = OS === "win32" ? spawn("where", [cmd]) : spawn("which", [cmd]);
    let out = "";
    probe.stdout?.on("data", (c) => (out += c.toString()));
    probe.on("error", () => resolveP(null));
    probe.on("close", (code) => resolveP(code === 0 ? out.trim().split(/\r?\n/)[0] : null));
  });
}

// 1. Node version.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) ok("Node.js", `v${process.versions.node}`);
else bad("Node.js too old", `need >= 20, found v${process.versions.node}. Upgrade at https://nodejs.org`);

// 2. git present.
const gitPath = await which("git");
if (gitPath) ok("git", gitPath);
else bad("git not found", "install from https://git-scm.com/download/win (Windows) and reopen the terminal");

// 3. node_modules installed (tsx for the TypeScript collectors).
if (await exists(join(ROOT, "node_modules", "tsx"))) ok("dependencies installed", "tsx present");
else bad("dependencies missing", `run "npm install" in ${ROOT}`);

// 4. config.local.json present + valid.
const configPath = join(ROOT, "config.local.json");
if (await exists(configPath)) {
  const c = await readJsonSafe(configPath);
  if (!c.ok) bad("config.local.json invalid", c.error);
  else {
    const providers = c.value.providers ?? {};
    ok("config.local.json", "valid JSON");
    const mail = providers.mail ?? (OS === "darwin" ? "apple-mail (default)" : "gmail (default)");
    const cal = providers.calendar ?? (OS === "darwin" ? "fantastical (default)" : "google-calendar (default)");
    ok("mail provider", mail);
    ok("calendar provider", cal);
    const bc = c.value.basecamp ?? {};
    if (bc.access_token) ok("Basecamp", "configured");
    else warn("Basecamp", "not configured (optional; the brief skips it cleanly)");
  }
} else {
  warn("config.local.json", "missing; defaults will be used. Run install.sh/ps1 or copy config.example.json");
}

// 5. identity.local.json present + has name/email.
const identityPath = join(ROOT, "identity.local.json");
if (await exists(identityPath)) {
  const id = await readJsonSafe(identityPath);
  if (!id.ok) bad("identity.local.json invalid", id.error);
  else {
    const { name, email, first_name } = id.value;
    if (name && first_name) ok("identity", `${name} <${email || "no email"}>`);
    else warn("identity incomplete", "no name resolved; drafts will be generic. Set your name in CLAUDE.md then run: node scripts/identity-resolver.mjs");
  }
} else {
  warn("identity.local.json", "not resolved yet. Run: node scripts/identity-resolver.mjs");
}

// 6. CLAUDE.md exists (identity source).
const claudeCandidates = [join(homedir(), "CLAUDE.md"), join(homedir(), ".claude", "CLAUDE.md")];
let claudeMd = null;
for (const p of claudeCandidates) if (await exists(p)) { claudeMd = p; break; }
if (claudeMd) ok("CLAUDE.md", claudeMd);
else warn("CLAUDE.md", "not found; identity (name/voice) cannot auto-resolve. Create ~/CLAUDE.md with a '# Your Name' heading");

// 7. apple-mail-mcp (macOS mail provider dependency).
if (OS === "darwin") {
  const amRoot = process.env.APPLE_MAIL_MCP_ROOT ?? resolve(homedir(), "apple-mail-mcp");
  if (await exists(amRoot)) ok("apple-mail-mcp", amRoot);
  else warn("apple-mail-mcp", `missing at ${amRoot}; needed for the apple-mail provider. git clone https://github.com/RobbyDAngelo/apple-mail-mcp.git ${amRoot}`);
}

// 8. data/ directory writable. The dir is gitignored and created on first
//    run (collect-all does mkdir -p), so a missing data/ on a fresh install
//    is normal, not a blocker. Create it, then probe a real write.
const dataDir = join(ROOT, "data");
const probe = join(dataDir, ".doctor-write-probe");
try {
  await mkdir(dataDir, { recursive: true });
  await writeFile(probe, "ok");
  await unlink(probe);
  ok("data/ writable", dataDir);
} catch (err) {
  bad("data/ not writable", `${dataDir}: ${err.message}`);
}

// Output.
process.stdout.write("\nmorning-mvp doctor\n");
process.stdout.write(`platform: ${OS}\n\n`);
process.stdout.write(rows.join("\n") + "\n\n");

// MCP reminder (cannot be auto-checked from Node).
process.stdout.write("Inside Claude Code, also confirm (cannot be checked from here):\n");
if (OS === "darwin") {
  process.stdout.write("  - Fantastical is running (or it auto-launches) for calendar.\n");
  process.stdout.write("  - Mail.app Automation permission is granted (System Settings > Privacy > Automation).\n");
} else {
  process.stdout.write("  - A Gmail plugin MCP is installed AND authenticated.\n");
  process.stdout.write("  - A Google Calendar plugin MCP is installed AND authenticated.\n");
}
process.stdout.write("  - The Notion MCP is connected (optional, for call notes).\n\n");

if (blockers > 0) {
  process.stdout.write(`${blockers} blocker(s) found. Fix the ${BAD} items above before running the brief.\n`);
  process.exit(strict ? 1 : 0);
}
process.stdout.write("No blockers. You are ready to run the morning brief.\n");
process.exit(0);
