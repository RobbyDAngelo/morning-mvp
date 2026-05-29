#!/usr/bin/env node
// Calendar collector dispatcher. Picks a provider from
// providers/calendar/<name>.mjs based on config.local.json providers.calendar
// (or the OS-aware default), runs it, and writes the result to stdout as JSON.
//
// Two-stage path: if the primary provider returns `skipped: true` and is
// NOT a "requires_mcp" provider (i.e. it's a real failure, not a deferred
// MCP-via-workflow path), the dispatcher tries the fallback provider
// (typically apple-calendar on macOS).
//
// Cross-platform: dispatcher is OS-agnostic. OS-specific code lives in each
// provider module.

import { loadConfig } from "./lib/load-config.mjs";
import { resolveProvider, resolveCalendarFallback, OS } from "./lib/os-detect.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);
const hours = Math.max(1, Math.min(Number(args.hours ?? 36), 168));

const config = await loadConfig();
const primaryName = args.provider ?? resolveProvider("calendar", config);
const fallbackName = resolveCalendarFallback(config);

process.stderr.write(
  `[collect-calendar] os=${OS} primary=${primaryName} fallback=${fallbackName ?? "(none)"} hours=${hours}\n`,
);

async function tryProvider(name) {
  if (!name) return null;
  let collectCalendar;
  try {
    ({ collectCalendar } = await import(`./providers/calendar/${name}.mjs`));
  } catch (err) {
    process.stderr.write(`[collect-calendar] cannot load "${name}": ${err.message}\n`);
    return {
      provider: name,
      skipped: true,
      reason: `provider not found: ${err.message}`,
      window_hours: hours,
      events: [],
      source: name,
    };
  }
  try {
    return await collectCalendar({ hours, config });
  } catch (err) {
    process.stderr.write(`[collect-calendar] provider ${name} failed: ${err.message}\n`);
    return {
      provider: name,
      skipped: true,
      reason: err.message,
      window_hours: hours,
      events: [],
      source: name,
    };
  }
}

let result = await tryProvider(primaryName);

// Fall back if primary skipped without `requires_mcp` flag.
// `requires_mcp: true` means "the workflow will overwrite this later", which
// is not a real failure, so we still try the fallback to get something
// renderable before the MCP path runs.
const needsFallback =
  result &&
  result.skipped &&
  (!result.events || result.events.length === 0) &&
  fallbackName &&
  fallbackName !== primaryName;

if (needsFallback) {
  process.stderr.write(`[collect-calendar] primary skipped, trying fallback ${fallbackName}\n`);
  const fb = await tryProvider(fallbackName);
  if (fb && !fb.skipped && fb.events?.length > 0) {
    // Preserve the primary's mcp_call hint if present, so the workflow
    // still knows to query Fantastical and overwrite.
    if (result.requires_mcp) {
      fb.requires_mcp = true;
      fb.mcp_call = result.mcp_call;
      fb.primary_provider = result.provider;
    }
    result = fb;
  } else {
    // Fallback also failed or returned no events. Surface its attempt in the
    // primary's result so a partner debugging an empty brief can see both
    // failure paths without re-running.
    result.fallback_tried = {
      name: fallbackName,
      skipped: fb?.skipped ?? true,
      reason: fb?.reason ?? "fallback returned no events",
      event_count: fb?.events?.length ?? 0,
    };
  }
}

result.generated_at = new Date().toISOString();
result.window_hours = hours;

process.stdout.write(JSON.stringify(result, null, 2));
process.stderr.write(
  `[collect-calendar] done: ${result.events?.length ?? 0} events ` +
    `(source=${result.source ?? result.provider})\n`,
);
