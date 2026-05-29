#!/usr/bin/env node
// Pulls Apple Mail data for the morning brief. Reuses the local apple-mail-mcp
// modules so we get the same battle-tested logic the MCP server uses.
//
// Output: JSON to stdout with shape:
//   {
//     accounts: [...],
//     unread: [...],            // last N days unread, all accounts
//     recent_inbox: [...],      // last N days inbox, all accounts (includes read)
//     sent_in_window: [...]     // last N days of outgoing messages, for reply x-ref
//   }

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLE_MAIL_ROOT = resolve(homedir(), "apple-mail-mcp");

// Allow tsx to resolve TypeScript modules from apple-mail-mcp.
process.env.APPLE_MAIL_MCP_TIMEOUT_MS = process.env.APPLE_MAIL_MCP_TIMEOUT_MS ?? "180000";

const { listAccounts } = await import(`${APPLE_MAIL_ROOT}/src/mail/accounts.ts`);
const { getRecentMessages, getUnreadMessages } = await import(`${APPLE_MAIL_ROOT}/src/mail/messages.ts`);
const { searchMessages } = await import(`${APPLE_MAIL_ROOT}/src/mail/search.ts`);

// Per-call safety wrapper.
async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    process.stderr.write(`[collect-mail] ${label} FAILED: ${err.message?.split("\n")[0]}\n`);
    return null;
  }
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);
const days = Math.max(1, Math.min(Number(args.days ?? 7), 30));

const accounts = (await safe("listAccounts", () => listAccounts())) ?? [];
process.stderr.write(`[collect-mail] ${accounts.length} accounts, window ${days}d\n`);

// 1. Unread across all account inboxes (newest first), within the window.
const unread =
  (await safe("getUnreadMessages", () => getUnreadMessages({ limit: 300, since_days: days }))) ?? [];

// 2. Recent inbox (read + unread) per account inbox. Limit per call to avoid
//    Mail.app stalls; aggregate in Node.
const recentByAccount = [];
for (const acct of accounts) {
  const r = await safe(`getRecentMessages(${acct.name})`, () =>
    getRecentMessages({ account: acct.name, limit: 50, since_days: days }),
  );
  if (r) recentByAccount.push(...r);
}

// 3. Sent items in the window per account, for reply cross-reference. The
//    apple-mail-mcp search exposes mailbox scope; "Sent" / "Sent Messages" /
//    "Sent Mail" naming varies by provider, so we probe each account.
const sentByAccount = [];
for (const acct of accounts) {
  const candidates = ["Sent", "Sent Messages", "Sent Mail", "Sent Items"];
  for (const mboxName of candidates) {
    const r = await safe(`sent[${acct.name}/${mboxName}]`, () =>
      searchMessages({
        account: acct.name,
        mailbox: mboxName,
        since_days: days,
        limit: 200,
      }),
    );
    if (r && r.length > 0) {
      sentByAccount.push(...r);
      break;
    }
  }
}

const out = {
  generated_at: new Date().toISOString(),
  window_days: days,
  accounts: accounts.map((a) => ({ name: a.name, type: a.account_type, emails: a.email_addresses })),
  unread,
  recent_inbox: recentByAccount,
  sent_in_window: sentByAccount,
};

process.stdout.write(JSON.stringify(out, null, 2));
process.stderr.write(
  `[collect-mail] done: ${unread.length} unread, ${recentByAccount.length} recent, ${sentByAccount.length} sent\n`,
);
