#!/usr/bin/env node
// Mail collector dispatcher. Picks a provider from
// providers/mail/<name>.mjs based on config.local.json providers.mail
// (or the OS-aware default in scripts/lib/os-detect.mjs), runs it, and
// writes the result to stdout as JSON.
//
// Output: JSON to stdout matching the mail provider contract (see
// providers/README.md).
//
// Cross-platform: this script itself is OS-agnostic. The OS-specific work
// lives in each provider implementation.

import { loadConfig } from "./lib/load-config.mjs";
import { resolveProvider, OS } from "./lib/os-detect.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);
const days = Math.max(1, Math.min(Number(args.days ?? 7), 30));

const config = await loadConfig();
const providerName = args.provider ?? resolveProvider("mail", config);

process.stderr.write(`[collect-mail] os=${OS} provider=${providerName} days=${days}\n`);

let collectMail;
try {
  ({ collectMail } = await import(`./providers/mail/${providerName}.mjs`));
} catch (err) {
  process.stderr.write(
    `[collect-mail] cannot load provider "${providerName}": ${err.message}\n`,
  );
  process.stdout.write(
    JSON.stringify(
      {
        provider: providerName,
        skipped: true,
        reason: `provider not found: ${err.message}`,
        accounts: [],
        unread: [],
        recent_inbox: [],
        sent_in_window: [],
        errors: [],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

let result;
try {
  result = await collectMail({ days, config });
} catch (err) {
  process.stderr.write(`[collect-mail] provider ${providerName} failed: ${err.message}\n`);
  result = {
    provider: providerName,
    skipped: true,
    reason: err.message,
    accounts: [],
    unread: [],
    recent_inbox: [],
    sent_in_window: [],
    errors: [{ label: "provider-fatal", error: err.message }],
  };
}

result.generated_at = new Date().toISOString();
result.window_days = days;

process.stdout.write(JSON.stringify(result, null, 2));
process.stderr.write(
  `[collect-mail] done: ${result.unread?.length ?? 0} unread, ` +
    `${result.recent_inbox?.length ?? 0} recent, ` +
    `${result.sent_in_window?.length ?? 0} sent\n`,
);
