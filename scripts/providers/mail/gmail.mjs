// Gmail provider (cross-platform, MCP-via-workflow).
//
// Reaches Gmail through a Claude-Code-installed plugin MCP (the Pipedream
// Gmail integration). The standalone Node script can't make MCP calls,
// so this provider returns `skipped: true, requires_mcp: true` with a
// detailed `mcp_calls` hint that SKILL.md (or Claude reading raw.json)
// uses to fetch the actual data, then runs scripts/save-mail.mjs to
// merge results.
//
// First-run setup on the partner's machine:
//   1. Install a Gmail-capable Claude Code plugin (the bootstrap that
//      exposes mcp__plugin_small-business_gmail__* or
//      mcp__pipedream-gmail__* tools).
//   2. Run /mcp__plugin_small-business_gmail__authenticate to OAuth the
//      account on first use. The auth lives in the plugin, not in this
//      skill.
//   3. Re-run the morning brief; this provider's mcp_calls hint becomes
//      executable.

export async function collectMail({ days, config: _config = {} } = {}) {
  const windowDays = Math.max(1, Math.min(Number(days ?? 7), 30));

  // The actual MCP tool name varies by which plugin pack the partner has
  // installed (small-business, productivity, or pipedream-gmail). The
  // skill workflow probes the loaded tool space at runtime; we just
  // describe the data we need in source-agnostic terms.
  return {
    provider: "gmail",
    skipped: true,
    requires_mcp: true,
    accounts: [],
    unread: [],
    recent_inbox: [],
    sent_in_window: [],
    errors: [],
    window_days: windowDays,
    mcp_hint: {
      strategy: "fetch_via_claude_session",
      reason:
        "Gmail data lives behind a Claude-Code plugin MCP. Standalone Node " +
        "cannot reach it. Claude must fetch and save via save-mail.mjs.",
      data_needed: {
        unread: {
          intent: "Last N days of unread messages across all Gmail accounts the user has authorized.",
          gmail_query: `is:unread newer_than:${windowDays}d`,
          limit: 300,
          target_field: "unread",
        },
        recent_inbox: {
          intent: "Last N days of inbox messages (read + unread).",
          gmail_query: `in:inbox newer_than:${windowDays}d`,
          limit: 200,
          target_field: "recent_inbox",
        },
        sent_in_window: {
          intent: "Last N days of sent messages, for reply cross-reference.",
          gmail_query: `in:sent newer_than:${windowDays}d`,
          limit: 200,
          target_field: "sent_in_window",
        },
      },
      candidate_mcp_tools: [
        // Tried in order; whichever is loaded gets used.
        "mcp__plugin_small-business_gmail__*",
        "mcp__pipedream-gmail__*",
        "mcp__apple-mail__search_messages",
      ],
      save_command: "node scripts/save-mail.mjs --raw <raw-DATE.json> --file <gmail-response.json>",
    },
  };
}
