// Cross-platform OS detection and provider defaults.
// Used by collect-mail.mjs, collect-calendar.mjs, and the install scripts to
// pick sensible defaults without forcing the user to configure providers
// at first run.

import { platform } from "node:os";

// MORNING_MVP_PLATFORM overrides the detected platform. Production never sets
// it; it exists so the Windows / Linux provider path can be exercised on a
// macOS box (tests, and remote support of a Windows user).
export const OS = process.env.MORNING_MVP_PLATFORM || platform(); // "darwin" | "win32" | "linux"
export const IS_MAC = OS === "darwin";
export const IS_WIN = OS === "win32";
export const IS_LINUX = OS === "linux";

/**
 * Default providers per OS. Users can override in config.local.json's
 * `providers` block. The mac defaults preserve the original behavior of the
 * skill before the provider abstraction landed.
 */
export const DEFAULT_PROVIDERS = {
  darwin: {
    mail: "apple-mail",
    calendar: "fantastical",
    calendar_fallback: "apple-calendar",
    tasks: "apple-reminders",
  },
  win32: {
    mail: "gmail",
    calendar: "google-calendar",
    calendar_fallback: null,
    tasks: "basecamp-only",
  },
  linux: {
    mail: "gmail",
    calendar: "google-calendar",
    calendar_fallback: null,
    tasks: "basecamp-only",
  },
};

/**
 * Resolve which provider to use for a given source, honoring config overrides
 * but falling back to OS defaults.
 *
 * @param {string} source One of "mail", "calendar", "tasks"
 * @param {object} config Parsed config.local.json (may be {})
 * @returns {string} Provider name
 */
export function resolveProvider(source, config) {
  const override = config?.providers?.[source];
  if (override) return override;
  const defaults = DEFAULT_PROVIDERS[OS] ?? DEFAULT_PROVIDERS.linux;
  return defaults[source];
}

/**
 * Resolve calendar fallback (used by collect-calendar.mjs when the primary
 * provider returns a 'skipped' result).
 */
export function resolveCalendarFallback(config) {
  const override = config?.providers?.calendar_fallback;
  if (override !== undefined) return override; // explicit null disables fallback
  const defaults = DEFAULT_PROVIDERS[OS] ?? DEFAULT_PROVIDERS.linux;
  return defaults.calendar_fallback;
}
