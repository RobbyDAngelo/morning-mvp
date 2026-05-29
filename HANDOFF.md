# Morning-MVP Session Handoff

Last updated: 2026-05-16

A future Claude session should read this first to pick up morning-MVP work without re-deriving context. Pair with `SKILL.md` (operational workflow) and `README.md` (user-facing summary).

## TL;DR

Morning-MVP is a personal-productivity skill at `~/.claude/skills/morning-mvp/`. Each morning it:

1. Collects from Apple Mail (7 accounts), Basecamp (Childcare Elevated Group), Fantastical, and Notion call notes.
2. Filters noise, ranks by waiting-on-me + 48h deadlines.
3. Renders a printable HTML brief at `~/morning-brief/<DATE>.html`.
4. Quits Calendar.app + Fantastical UI after the brief is on screen.
5. Optionally syncs back to Notion / Calendar / Reminders (flags default OFF).

140+ tests, all green. Production-ready and in daily use by Robby.

## Paste this into a new session

Copy the block below verbatim into the first message of a fresh Claude Code session to spin it up with full morning-MVP context. The block points the new Claude at the source-of-truth docs in the skill directory and primes it on the standing rules. Replace `<WHAT_I_WANT_TODAY>` with the actual ask (or delete that line if you just want it ready to run the routine).

```
We are picking up work on the morning-MVP skill. Read these four files in order, then confirm you have the state of the system before doing anything else:

1. ~/.claude/skills/morning-mvp/HANDOFF.md      (start here, fastest path to context)
2. ~/.claude/skills/morning-mvp/SKILL.md        (operational workflow, 12 numbered steps)
3. ~/.claude/skills/morning-mvp/README.md       (user-facing feature summary)
4. ~/.claude/skills/morning-mvp/SECURITY-REVIEW.md (adversarial review findings)

Key facts for this session:
- Skill root: ~/.claude/skills/morning-mvp/
- Real config (gitignored): ~/.claude/skills/morning-mvp/config.local.json
- Persistent state: ~/.claude/skills/morning-mvp/state/*.json
- Per-day data (gitignored): ~/.claude/skills/morning-mvp/data/raw-<DATE>.json, ranked-<DATE>.json, notion-<DATE>.json
- Brief output: ~/morning-brief/<DATE>.md and .html
- Apple Mail MCP lives at ~/apple-mail-mcp/ (separate package, already wired)
- Prefer Fantastical MCP (mcp__Fantastical__*) over Apple Calendar AppleScript
- After the brief renders, scripts/cleanup-apps.mjs quits Calendar.app + Fantastical UI; the Fantastical MCP server keeps running

Standing rules (per ~/CLAUDE.md, do not violate):
- No em dashes anywhere. Use commas, colons, or rephrase. Covers all 8 Unicode variants (U+2012, U+2013, U+2014, U+2015, U+2053, U+FE58, U+FE63, U+FF0D).
- No "brother" in any drafted text.
- Never commit literal credential strings, even after rotation. Redact to `prefix...REDACTED (rotated YYYY-MM-DD)`.
- Boil the ocean: production-grade, tested, documented. No half-measures.

To run the routine: invoke the morning-mvp skill (user phrase "run morning MVP" or similar). The 12-step workflow in SKILL.md is the contract.

To extend or debug: tests live in test/, run `npm test` from the skill root. 140+ tests must stay green.

My ask for this session: <WHAT_I_WANT_TODAY>

Before you touch anything, summarize back to me in 5 bullet points: (1) what the routine does end-to-end, (2) where state lives, (3) what the most recent change was, (4) what the open watch-list items are, (5) what you understood my ask to be. Then wait for my go-ahead.
```

The "summarize back to me in 5 bullets" closer is the quality gate. If the new session can't fill those bullets accurately, it hasn't actually loaded the context, and you'll catch it before any work starts.

## Invoke the routine

User typically asks "Run morning MVP" or similar phrase. Workflow is in `SKILL.md` (12 numbered steps). End-to-end timing roughly 90s to 3min depending on inbox volume.

## Pipeline (high-level stages, not 1:1 with SKILL.md numbering)

1. `scripts/collect-all.mjs --days 7` runs `collect-mail.mjs` + `collect-basecamp.mjs` in parallel. Writes `data/raw-<DATE>.json`.
2. Fantastical MCP query (`mcp__Fantastical__queryCalendarItems`) plus `save-calendar-events.mjs` normalizes events into `raw.calendar.events[]`.
3. Notion MCP `notion-search` + `notion-fetch` pulls last-7-day call notes. Writes `data/notion-<DATE>.json`.
4. `scripts/filter-rank.mjs` drops noise, builds replied-index, scores survivors. Writes `data/ranked-<DATE>.json`.
5. `scripts/enrich-summaries.mjs` fills richer descriptions. 90s wall-clock budget so it never blocks the brief.
6. `scripts/enrich-drafts.mjs` produces optional reply drafts.
7. `scripts/enforce-rules.mjs` strips em dashes (all 8 Unicode variants U+2012, U+2013, U+2014, U+2015, U+2053, U+FE58, U+FE63, U+FF0D), "brother", EOS / D&I terminology.
8. Brief markdown written to `~/morning-brief/<DATE>.md`.
9. `scripts/render-print.mjs` emits the print HTML alongside and opens it in the browser.
10. `scripts/cleanup-apps.mjs` quits Calendar.app + Fantastical. The Fantastical MCP server (FantasticalMCP.app) and the macOS widget keep running.
11. (Optional, sync flags on) `push-all.mjs` writes back to Notion, Calendar, Reminders. State recorded in `state/sync-state.json` so `unsync.mjs` can roll back.

## Where everything lives

- Skill root: `~/.claude/skills/morning-mvp/`
- Scripts: `~/.claude/skills/morning-mvp/scripts/`
- Tests: `~/.claude/skills/morning-mvp/test/`
- Per-day data (gitignored): `~/.claude/skills/morning-mvp/data/`
- Persistent state: `~/.claude/skills/morning-mvp/state/`
  - `state.json`: items + `first_seen_at` timestamps. Drives slow-burn aging.
  - `week-state.json`: weekly mission + Sunday recap continuity.
  - `people-facts.json`: long-running per-person memory (Tier 4).
  - `trends.json`: rolling metrics (Tier 4).
  - `sync-state.json`: Notion / Calendar / Reminders push targets for rollback.
- Brief output: `~/morning-brief/<DATE>.md` and `~/morning-brief/<DATE>.html`
- Real config (gitignored): `~/.claude/skills/morning-mvp/config.local.json`
- Example config: `~/.claude/skills/morning-mvp/config.example.json`

## Dependencies

### Apple Mail MCP

Separate package at `~/apple-mail-mcp/`. 14 tools exposed. Key fixes baked in:

- INBOX lookup uses `mailbox "INBOX" of acct`, NOT `inbox of acct` (Mail.app dictionary doesn't expose `inbox` as a property).
- Date filter pushed into AS `whose` clause (otherwise Mail returns non-chronological after re-syncs).
- `content of msg` removed from bulk loops, bodies fetched on demand.
- Custom Apple-locale date parser at `src/utils/dates.ts`. Inlined into morning-mvp `rank.mjs` + `one-thing.mjs`.

Mail.app needs Automation permission granted in System Settings. Failure mode is `osascript` error -1743.

### Basecamp 3

OAuth credentials in `config.local.json` under `basecamp`:
- `account_id`: 4152236
- `user_id`: 52039567 (auto-discovered via `/my/profile.json` on first run)
- Project: Childcare Elevated Group

### Fantastical

Prefer `mcp__Fantastical__*` tools over Apple Calendar AppleScript. `save-calendar-events.mjs` normalizes both Fantastical and AppleScript event shapes into a unified `raw.calendar.events[]` so downstream code is source-agnostic.

After `cleanup-apps.mjs` quits the Fantastical UI, the FantasticalMCP.app server keeps running so the next morning's brief can query immediately.

### Notion

Call notes must include explicit `commitments_robby_made: [...]` arrays for clean promise extraction in `promises.mjs`. Old search-highlight extraction is the fallback but sparse. Edit the Notion call-notes template to keep that array filled.

## Tests

```bash
cd ~/.claude/skills/morning-mvp
npm test                  # standard 14-file suite
npm run test:adversarial  # security-style edge cases
npm run test:all          # both
```

All tests run on Node 20+ via `node --test --import tsx`.

## Sync flags (default OFF)

In `config.local.json` under `sync`:
- `notion_writeback`
- `calendar_block`
- `reminders_push`

Each opt-in independently. Rollback via `unsync.mjs` reads `state/sync-state.json`.

## Recent changes

- **2026-05-16:** `scripts/cleanup-apps.mjs` shipped. Quits Calendar.app + Fantastical after the brief is on screen. SKILL.md step 12 + README.md step 6 document it. Idempotent, 8s per-app timeout, errors logged + swallowed so cleanup never blocks the rendered brief. Supports `--dry-run` and `--only <AppName>`.
- Fantastical migration completed earlier this session. `save-calendar-events.mjs` + `record-calendar-event.mjs` added.
- `enrich-summaries.mjs` runtime bounded to 90s wall-clock after a 224s outlier on a 15-item brief.
- Unicode dash variants extended in `enforce-rules.mjs`.
- `promises.mjs` migrated to explicit `commitments_robby_made` arrays.
- `SECURITY-REVIEW.md` filed after a 25-test self-audit (Codex quota was exceeded during the formal adversarial review). One real defect (Unicode dashes) found and fixed.

## Known gotchas

- **Fantastical MCP server**: not auto-restarted by `cleanup-apps.mjs`. If absent, relaunch with `open -a FantasticalMCP`. Once running it persists across the UI being quit.
- **Apple Mail Automation**: must be granted in System Settings, otherwise all collection fails with osascript -1743.
- **Notion sparseness**: missing `commitments_robby_made` arrays produce empty Promise sections. Fix at the template level, not the parser.
- **Em dashes**: `enforce-rules.mjs` runs in step 7. If any slip through, check the codepoint against the 8-variant regex.
- **Promise age**: computed from `source_date` with `first_seen_at` fallback, not from `state.first_seen` directly. Bug was fixed earlier this session.
- **Secrets policy**: never commit literal credential strings, even after rotation. Redact to `prefix...REDACTED (rotated YYYY-MM-DD)` before any `git add`. Memory files included.

## Open items / watch list

None blocking. Routine is stable. Likely next work:
- Scoring tuning based on accumulated field use.
- Adding a new source (Slack? GHL inbox?).
- Tightening `enrich-summaries.mjs` budget further.

## Quick troubleshooting

- **Brief looks empty.** Inspect `data/raw-<DATE>.json` for `mail.errors[]` or empty `accounts[]`. Usually Mail.app Automation permission or Mail crashed.
- **Today's meetings missing.** Confirm Fantastical MCP server is running. Check `data/raw-<DATE>.json` for `calendar.events[]`.
- **Em dashes leaking through.** Confirm `enforce-rules.mjs` ran (it's step 7). Check the codepoint of the offender.
- **Drafts quote wrong text.** `enrich-drafts.mjs` reads Apple Mail bodies directly, not the ranked summary. Re-collect if Mail.app was out of sync.
- **Basecamp shows 0 todos but you know there are some.** Verify `user_id` in `config.local.json` matches the per-account Basecamp identity, not the launchpad identity_id. Auto-discovery happens on first run.

## Reference docs in the skill

- `SKILL.md`: operational workflow Claude follows when invoked.
- `README.md`: user-facing summary of features and tiers.
- `SECURITY-REVIEW.md`: adversarial review findings + fixes.
- `HANDOFF.md`: this file.

## Philosophy

"Boil the ocean" was the standing instruction: production-grade, tested, documented, no half-measures. Maintain that bar.
