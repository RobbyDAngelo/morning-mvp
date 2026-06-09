// Apple Mail provider (macOS only).
//
// Wraps the local apple-mail-mcp modules to pull unread, recent, and sent
// messages in a window. Same battle-tested logic the MCP server uses; we
// import directly because the standalone scripts can't reach MCP tools.
//
// Cross-platform note: this provider hard-fails on non-Darwin systems by
// design. The dispatcher in scripts/collect-mail.mjs picks the right
// provider based on OS + config.local.json `providers.mail`.

import { resolve } from "node:path";
import { homedir, platform } from "node:os";

const APPLE_MAIL_ROOT = resolve(homedir(), "apple-mail-mcp");

/**
 * Collect mail for the morning brief.
 *
 * @param {object} opts
 * @param {number} opts.days   Window in days, 1-30.
 * @param {object} [opts.config]   Parsed config.local.json (unused here today,
 *                                 reserved for per-user account filters).
 * @returns {Promise<MailResult>}
 *
 * MailResult shape (contract every mail provider must honor):
 *   {
 *     accounts: [{name, type, emails: [string]}],
 *     unread: [Message],
 *     recent_inbox: [Message],
 *     sent_in_window: [Message],
 *   }
 */
export async function collectMail({ days, config: _config = {} } = {}) {
  if (platform() !== "darwin") {
    throw new Error(
      `apple-mail provider requires macOS, current platform is ${platform()}. ` +
        `Switch to a cross-platform provider in config.local.json providers.mail ` +
        `(e.g. "gmail").`,
    );
  }

  // Allow tsx to resolve TypeScript modules from apple-mail-mcp.
  process.env.APPLE_MAIL_MCP_TIMEOUT_MS = process.env.APPLE_MAIL_MCP_TIMEOUT_MS ?? "180000";

  let listAccounts, getRecentMessages, getUnreadMessages, searchMessages;
  try {
    ({ listAccounts } = await import(`${APPLE_MAIL_ROOT}/src/mail/accounts.ts`));
    ({ getRecentMessages, getUnreadMessages } = await import(
      `${APPLE_MAIL_ROOT}/src/mail/messages.ts`
    ));
    ({ searchMessages } = await import(`${APPLE_MAIL_ROOT}/src/mail/search.ts`));
  } catch (err) {
    throw new Error(
      `apple-mail provider cannot load apple-mail-mcp modules from ${APPLE_MAIL_ROOT}. ` +
        `Make sure ${APPLE_MAIL_ROOT} exists (run install.sh to clone it). Cause: ${err.message}`,
    );
  }

  const windowDays = Math.max(1, Math.min(Number(days ?? 7), 30));

  // Per-call safety wrapper. We never want one failed account to break the
  // whole collection; we log and continue.
  const errors = [];
  async function safe(label, fn) {
    try {
      return await fn();
    } catch (err) {
      const msg = err.message?.split("\n")[0] ?? String(err);
      errors.push({ label, error: msg });
      process.stderr.write(`[apple-mail] ${label} FAILED: ${msg}\n`);
      return null;
    }
  }

  const accounts = (await safe("listAccounts", () => listAccounts())) ?? [];
  process.stderr.write(`[apple-mail] ${accounts.length} accounts, window ${windowDays}d\n`);

  // 1. Unread per account inbox, within the window. Split per-account (was a
  //    single all-accounts call that timed out and fell back to zero unread).
  //    Per-account isolates a wedged account and keeps each scan small.
  const unreadSeen = new Set();
  const unread = [];
  for (const acct of accounts) {
    const r = await safe(`getUnreadMessages(${acct.name})`, () =>
      getUnreadMessages({ account: acct.name, limit: 100, since_days: windowDays }),
    );
    for (const m of r ?? []) {
      const key = m.message_id || `${m.account}|${m.subject}|${m.date_received}`;
      if (unreadSeen.has(key)) continue;
      unreadSeen.add(key);
      unread.push(m);
    }
  }

  // 2. Recent inbox (read + unread) per account inbox. Limit per call to avoid
  //    Mail.app stalls; aggregate in Node.
  const recentByAccount = [];
  for (const acct of accounts) {
    const r = await safe(`getRecentMessages(${acct.name})`, () =>
      getRecentMessages({ account: acct.name, limit: 50, since_days: windowDays }),
    );
    if (r) recentByAccount.push(...r);
  }

  // 3. Sent items per account, for reply cross-reference. The apple-mail-mcp
  //    search exposes mailbox scope; "Sent" / "Sent Messages" / "Sent Mail"
  //    naming varies by provider, so we probe each account.
  const sentByAccount = [];
  for (const acct of accounts) {
    const candidates = ["Sent", "Sent Messages", "Sent Mail", "Sent Items"];
    for (const mboxName of candidates) {
      const r = await safe(`sent[${acct.name}/${mboxName}]`, () =>
        searchMessages({
          account: acct.name,
          mailbox: mboxName,
          since_days: windowDays,
          limit: 200,
        }),
      );
      if (r && r.length > 0) {
        sentByAccount.push(...r);
        break;
      }
    }
  }

  return {
    provider: "apple-mail",
    accounts: accounts.map((a) => ({
      name: a.name,
      type: a.account_type,
      emails: a.email_addresses,
    })),
    unread,
    recent_inbox: recentByAccount,
    sent_in_window: sentByAccount,
    errors,
  };
}
