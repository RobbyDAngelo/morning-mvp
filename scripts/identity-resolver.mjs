#!/usr/bin/env node
// Identity resolver. Reads ~/.claude/CLAUDE.md and ~/.claude/projects/-/memory/MEMORY.md
// to extract the user's identity (name, first name, email, role, persona,
// signoff, hard rules) and writes the result to <skill-root>/identity.local.json.
//
// Used as a library by:
//   - scripts/one-thing.mjs  (firstName feeds the commitment-extraction regex)
//   - scripts/enrich-drafts.mjs  (signoff + persona feed the draft composition)
//   - scripts/lib/load-config.mjs (loadIdentity() returns the resolved object)
//
// Used as a CLI by:
//   - install.sh / install.ps1  (one-shot extraction on first run)
//   - npm run resolve-identity  (re-extract after editing CLAUDE.md)
//
// Cross-platform: pure Node, reads from homedir(). No shell calls.

import { readFile, writeFile, access } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, "..");

/**
 * Resolve the user's identity by parsing their Claude Code config and memory
 * files. Returns a structured object with everything the rest of the skill
 * needs to personalize behavior.
 *
 * @param {object} [opts]
 * @param {string} [opts.claudeMdPath]   Override path to CLAUDE.md.
 * @param {string} [opts.memoryMdPath]   Override path to MEMORY.md.
 * @returns {Promise<Identity>}
 */
export async function resolveIdentity(opts = {}) {
  // Claude Code stores the user-level memory in one of two conventions; probe
  // both. Override accepted via opts.claudeMdPath for tests and partners
  // running install.sh with a custom path.
  const claudeMdCandidates = opts.claudeMdPath
    ? [opts.claudeMdPath]
    : [
        join(homedir(), "CLAUDE.md"),
        join(homedir(), ".claude", "CLAUDE.md"),
      ];

  const memoryMdCandidates = opts.memoryMdPath
    ? [opts.memoryMdPath]
    : [
        join(homedir(), ".claude", "projects", "-", "memory", "MEMORY.md"),
        join(homedir(), ".claude", "memory", "MEMORY.md"),
      ];

  let claudeMd = null;
  let claudeMdPath = null;
  for (const p of claudeMdCandidates) {
    const text = await readSafe(p);
    if (text) {
      claudeMd = text;
      claudeMdPath = p;
      break;
    }
  }

  let memoryMd = null;
  let memoryMdPath = null;
  for (const p of memoryMdCandidates) {
    const text = await readSafe(p);
    if (text) {
      memoryMd = text;
      memoryMdPath = p;
      break;
    }
  }

  const identity = {
    name: "",
    first_name: "",
    email: "",
    role: "",
    tagline: "",
    signoff: "",
    hard_rules: [],
    vip_emails: [],
    persona_hints: [],
    resolved_at: "",
    source_files: [],
    missing: [],
  };

  if (claudeMd) {
    identity.source_files.push({ path: claudeMdPath, bytes: claudeMd.length });
    extractFromClaudeMd(claudeMd, identity);
  } else {
    identity.missing.push(
      "CLAUDE.md not found at any of: " + claudeMdCandidates.join(", "),
    );
  }

  if (memoryMd) {
    identity.source_files.push({ path: memoryMdPath, bytes: memoryMd.length });
    extractFromMemoryMd(memoryMd, identity);
  }

  // Fall back chain for email:
  //   1. GIT_AUTHOR_EMAIL env var (CI / scripted installs).
  //   2. EMAIL env var (general convention).
  //   3. `git config --global user.email` (most users have this set).
  if (!identity.email) {
    identity.email =
      process.env.GIT_AUTHOR_EMAIL ||
      process.env.EMAIL ||
      (await readGitConfigEmail()) ||
      "";
  }

  if (!identity.first_name && identity.name) {
    identity.first_name = identity.name.split(/\s+/)[0] ?? "";
  }

  identity.resolved_at = new Date().toISOString();

  // Record what's still missing so install.sh can prompt for it.
  if (!identity.name) identity.missing.push("name");
  if (!identity.email) identity.missing.push("email");
  if (!identity.first_name) identity.missing.push("first_name");

  return identity;
}

async function readSafe(path) {
  try {
    await access(path);
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read `git config --global user.email`. Returns "" if git is unavailable,
 * unconfigured, or if the call errors. Bounded to 3s so a hung git on
 * Windows can't stall the resolver.
 */
function readGitConfigEmail() {
  return new Promise((resolveP) => {
    let stdout = "";
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolveP(val);
    };
    try {
      const child = spawn("git", ["config", "--global", "--get", "user.email"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish("");
      }, 3000);
      child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
      child.on("close", () => {
        clearTimeout(timer);
        finish(stdout.trim());
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish("");
      });
    } catch {
      finish("");
    }
  });
}

/**
 * Extract identity fields from the top-level CLAUDE.md.
 *
 * Patterns recognized:
 *   - First H1 (`# <Name>`) becomes the name. Strip trailing emoji or notes.
 *   - First line after the H1, if not blank and not a heading, becomes the tagline.
 *   - "Founder of X" / "Owner of X" / "CEO at X" patterns become the role.
 *   - "## Hard Rules" section gets parsed for bullet items.
 *   - Plain prose email matches `[\w.+-]+@[\w.-]+\.\w+` become candidate emails;
 *     the first one that does NOT look like a gmail address is preferred (per
 *     Robby's "canonical email" memory), falling back to the first match.
 *   - Optional `## Signoff` or `## Email Signoff` section extracts a multi-line
 *     signoff block.
 */
function extractFromClaudeMd(md, identity) {
  // Name (first H1).
  const h1 = md.match(/^#\s+([^\n#].*)$/m);
  if (h1) {
    identity.name = h1[1].trim().replace(/\s*[\u{1F000}-\u{1FFFF}].*$/u, "").trim();
  }

  // Tagline (first non-blank line after H1, if not a heading).
  if (h1) {
    const afterH1 = md.slice(h1.index + h1[0].length);
    const tagLine = afterH1.match(/^\s*\n+([^\n#].+?)$/m);
    if (tagLine) identity.tagline = tagLine[1].trim();
  }

  // Role: look for "Founder of X" / "CEO of X" / similar patterns near top.
  const rolePatterns = [
    /\b(Founder|Co-Founder|CEO|Owner|President|Director|Principal|Managing Partner)\s+of\s+([^.,\n]+)/i,
    /\b(Founder|Co-Founder|CEO|Owner|President|Director)\s+at\s+([^.,\n]+)/i,
  ];
  for (const re of rolePatterns) {
    const m = md.match(re);
    if (m) {
      identity.role = `${m[1]} of ${m[2].trim()}`;
      break;
    }
  }

  // Email: scan all email-like tokens in the prose. Prefer non-gmail.com per
  // Robby's "canonical email" memory rule. Skip examples that look like
  // placeholder addresses.
  const emails = [...md.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) => m[0]);
  const filtered = emails.filter(
    (e) =>
      !e.includes("example.com") &&
      !e.includes("yourname") &&
      !e.includes("placeholder") &&
      !e.endsWith(".test") &&
      !e.endsWith("@noreply"),
  );
  if (filtered.length > 0) {
    const nonGmail = filtered.find((e) => !/@gmail\.com$/i.test(e));
    identity.email = nonGmail ?? filtered[0];
  }

  // Hard rules: parse the "## Hard Rules" section bullet list.
  const hardRulesMatch = md.match(/##\s+Hard Rules[^\n]*\n([\s\S]+?)(?=^##\s|\Z)/m);
  if (hardRulesMatch) {
    const block = hardRulesMatch[1];
    identity.hard_rules = block
      .split("\n")
      .map((line) => line.match(/^\s*[-*]\s+(.+)$/))
      .filter(Boolean)
      .map((m) => m[1].trim())
      .filter((s) => s.length > 0);
  }

  // Signoff: optional dedicated section.
  const signoffMatch = md.match(/##\s+(Email\s+)?Signoff[^\n]*\n```\n([\s\S]+?)\n```/i);
  if (signoffMatch) {
    identity.signoff = signoffMatch[2].trim();
  }

  // Persona hints: any short value-statement bullets that aren't hard rules.
  const personaSection = md.match(/##\s+(Working Style|Persona|Voice)[^\n]*\n([\s\S]+?)(?=^##\s|\Z)/im);
  if (personaSection) {
    identity.persona_hints = personaSection[2]
      .split("\n")
      .map((line) => line.match(/^\s*[-*]\s+\*?\*?([^*]+?)\*?\*?\s*:\s*(.+)$/))
      .filter(Boolean)
      .map((m) => ({ key: m[1].trim(), value: m[2].trim() }));
  }
}

/**
 * Extract additional fields from MEMORY.md. Today this just adds context the
 * brief can use for "who are you" framing; it does not overwrite anything
 * already set from CLAUDE.md.
 */
function extractFromMemoryMd(md, identity) {
  // Walk the project table; pull project names + paths so identity has a
  // sense of what the user is working on.
  const projectsSection = md.match(/##\s+Projects[^\n]*\n([\s\S]+?)(?=^##\s|\Z)/m);
  if (projectsSection) {
    const projects = projectsSection[1]
      .split("\n")
      .map((line) => line.match(/^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s+--\s+(.+)$/))
      .filter(Boolean)
      .map((m) => ({ name: m[1].trim(), path: m[2].trim(), summary: m[3].trim() }))
      .slice(0, 20);
    identity.projects = projects;
  }
}

/**
 * Write the resolved identity to <skill-root>/identity.local.json. The file
 * is gitignored. Returns the path written.
 */
export async function writeIdentity(identity, opts = {}) {
  const path = opts.path ?? resolve(SKILL_ROOT, "identity.local.json");
  await writeFile(path, JSON.stringify(identity, null, 2));
  return path;
}

/**
 * Lazily load the resolved identity from disk. Returns {} if not yet
 * resolved (the skill falls back to anonymous behavior in that case).
 *
 * Re-exported here so callers can `import { loadIdentity } from "./identity-resolver.mjs"`
 * without having to know about lib/load-config.mjs.
 */
export async function loadResolvedIdentity() {
  try {
    const path = resolve(SKILL_ROOT, "identity.local.json");
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// CLI entry point.
const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("identity-resolver.mjs");

if (isCli) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, arg, i, arr) => {
      if (arg.startsWith("--")) {
        // Boolean flag if next arg is also a flag or end of list.
        const next = arr[i + 1];
        if (!next || next.startsWith("--")) acc.push([arg.replace(/^--/, ""), true]);
        else acc.push([arg.replace(/^--/, ""), next]);
      }
      return acc;
    }, []),
  );

  const identity = await resolveIdentity({
    claudeMdPath: typeof args["claude-md"] === "string" ? args["claude-md"] : undefined,
    memoryMdPath: typeof args["memory-md"] === "string" ? args["memory-md"] : undefined,
  });

  if (args.check) {
    const missingRequired = identity.missing.filter((m) =>
      ["name", "email", "first_name"].includes(m),
    );
    if (missingRequired.length > 0) {
      process.stderr.write(
        `[identity-resolver] missing required fields: ${missingRequired.join(", ")}\n`,
      );
      process.exit(1);
    }
    process.stderr.write(`[identity-resolver] OK: name="${identity.name}" email="${identity.email}"\n`);
    process.exit(0);
  }

  if (args.print) {
    process.stdout.write(JSON.stringify(identity, null, 2) + "\n");
    process.exit(0);
  }

  // Default: write to disk and report.
  const path = await writeIdentity(identity, {
    path: typeof args.out === "string" ? args.out : undefined,
  });
  process.stderr.write(
    `[identity-resolver] wrote ${path}: name="${identity.name}" email="${identity.email}"` +
      (identity.missing.length > 0 ? ` (missing: ${identity.missing.join(", ")})` : "") +
      "\n",
  );
  process.stdout.write(
    JSON.stringify(
      {
        path,
        name: identity.name,
        email: identity.email,
        first_name: identity.first_name,
        role: identity.role,
        missing: identity.missing,
      },
      null,
      2,
    ),
  );
}
