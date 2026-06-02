// Shared CLI helpers used across the scripts. Two jobs:
//
// 1. parseArgs: a boolean-aware --flag parser. The naive reducer that used to
//    be copy-pasted everywhere dropped a valueless trailing flag, so
//    `--dry-run` (last arg) parsed to `undefined` and a requested dry-run
//    silently became a REAL write. This version treats a flag with no value
//    (next token is another --flag, or end of list) as boolean `true`.
//
// 2. openExternal: cross-platform "open this URL/file in the default app".
//    On Windows `start` is a cmd builtin, not an executable, so
//    spawn("start", ...) throws ENOENT. This routes through `cmd /c start`
//    and always attaches an error handler so a missing launcher never
//    crashes the caller.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * Read and parse a JSON file with a clear, actionable error instead of an
 * uncaught stack trace when the file is missing or truncated (e.g. a
 * half-written run-output from an interrupted collect-all).
 *
 * @param {string} path
 * @param {{ label?: string }} [opts]
 * @returns {Promise<any>}
 * @throws {Error} with a human-readable message
 */
export async function readJson(path, { label } = {}) {
  const what = label ?? path;
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${what} (${path}): ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${what} (${path}) is not valid JSON, it may be corrupt or truncated from an ` +
        `interrupted run; re-run the prior step. (${err.message})`,
    );
  }
}

/**
 * Parse `--key value` and `--flag` arguments into an object.
 *
 *   parseArgs(["--ranked", "a.json", "--dry-run"])
 *     => { ranked: "a.json", "dry-run": true }
 *   parseArgs(["--dry-run", "false"])
 *     => { "dry-run": "false" }
 *
 * A flag with no value (next token starts with "--", or it is the last token)
 * becomes boolean `true`. Values are always strings otherwise.
 *
 * @param {string[]} [argv] defaults to process.argv.slice(2)
 * @returns {Record<string, string|true>}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  return Object.fromEntries(
    argv.reduce((acc, arg, i, arr) => {
      if (arg.startsWith("--")) {
        const key = arg.replace(/^--/, "");
        const next = arr[i + 1];
        if (next === undefined || next.startsWith("--")) acc.push([key, true]);
        else acc.push([key, next]);
      }
      return acc;
    }, []),
  );
}

/**
 * Interpret a parsed flag as a boolean. Treats `true` (valueless flag) and the
 * strings "true"/"1"/"yes" as true; everything else (including "false",
 * undefined) as false.
 */
export function flagEnabled(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Open a URL or file path with the OS default handler. Never throws or
 * crashes the caller; on failure it calls onError (or logs to stderr).
 * Honors MORNING_MVP_PLATFORM so the Windows/Linux path can be exercised on
 * a Mac for tests and remote support.
 *
 * @param {string} target URL or absolute file path
 * @param {{ onError?: (err: Error) => void }} [opts]
 * @returns {import("node:child_process").ChildProcess}
 */
export function openExternal(target, { onError } = {}) {
  const platform = process.env.MORNING_MVP_PLATFORM || process.platform;
  let cmd;
  let args;
  if (platform === "darwin") {
    cmd = "open";
    args = [target];
  } else if (platform === "win32") {
    // start is a cmd builtin; the empty "" is its (required) title argument.
    cmd = "cmd";
    args = ["/c", "start", "", target];
  } else {
    cmd = "xdg-open";
    args = [target];
  }
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", (err) => {
    if (onError) onError(err);
    else process.stderr.write(`[open] could not open ${target}: ${err.message}\n`);
  });
  child.unref();
  return child;
}
