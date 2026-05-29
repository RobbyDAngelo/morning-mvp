// Centralized config loader. Reads config.local.json (real config) and falls
// back to config.example.json (template) so the skill works on a fresh
// install before identity-resolver runs.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

/**
 * Load the active configuration. Tries config.local.json first; falls back to
 * config.example.json if missing. Returns parsed JSON or {} on parse error so
 * downstream callers always have an object.
 */
export async function loadConfig() {
  const localPath = resolve(ROOT, "config.local.json");
  const examplePath = resolve(ROOT, "config.example.json");
  for (const p of [localPath, examplePath]) {
    try {
      const raw = await readFile(p, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      // Parse error or other read error: log and try next path.
      process.stderr.write(`[load-config] ${p}: ${err.message}\n`);
    }
  }
  return {};
}

/**
 * Load the resolved identity (name, email, persona, signoff). Read by
 * enrich-drafts.mjs and one-thing.mjs. Returns {} if identity-resolver has
 * not been run yet (the skill falls back to anonymous voice in that case).
 */
export async function loadIdentity() {
  const path = resolve(ROOT, "identity.local.json");
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
