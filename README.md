# morning-mvp

One printable page each morning. Who is waiting on Robby. What is due in the next 48 hours. Nothing else.

## What it pulls

| Source | What it does | Auth |
|---|---|---|
| **Apple Mail** (all accounts) | Unread + recent inbox + sent (for reply cross-reference) across every configured account, last N days | None. Uses the local `apple-mail-mcp` modules through Mail.app's Automation permission. |
| **Notion** | Pages edited in the last N days that look like call notes, meeting notes, 1-on-1 syncs | Notion MCP (already authenticated for Robby). |
| **Basecamp 3/4** | Active todos assigned to Robby with due dates in window | Personal access token in `config.local.json`. Optional. Skill skips Basecamp cleanly when unconfigured. |
| **Fantastical** (preferred) | Today + tomorrow's events, all 32 calendars across 7 accounts (iCloud, Gmail x4, RD NG, RD.com, TBL, Childcare Elevated, Square Appointments, Facebook for Biohacked Life, more) | Fantastical MCP via the Claude Desktop extension. Fantastical must be running (the skill auto-launches it via `open -ga Fantastical` if needed). |
| **Apple Calendar** (fallback) | Same data but via AppleScript when Fantastical is unavailable | Calendar.app Automation permission (one-time grant in System Settings). |

**Why Fantastical over Apple Calendar**: it reads the SAME underlying CalDAV calendars but via MCP it's faster, more reliable, has no permission prompt, and exposes calendars Apple Calendar may not surface (Square Appointments, Facebook for Biohacked Life, Childcare Elevated work calendar, four separate Gmail accounts). Same data flow for both: events land in `raw.calendar.events[]` and downstream pre-meeting cards work identically.

## What it does NOT do

- It does not poll on a schedule. Robby runs `/morning-mvp` (or types "morning brief") when he wants the brief.
- It does not send mail or reply on Robby's behalf. Read + classify only.
- It does not act as a CRM. Items live in their source system.
- It does not duplicate `anthropic-skills:morning-extraction` (Gmail-only, Notion-write). Different sources, different output, different surface.

## How it runs

The skill workflow is in [SKILL.md](./SKILL.md). When invoked, Claude:

1. Runs `scripts/collect-all.mjs --days 7`. That kicks off `collect-mail.mjs` and `collect-basecamp.mjs` in parallel and writes `data/raw-<DATE>.json`.
2. Calls Notion MCP `notion-search` for last-7-day call notes and writes `data/notion-<DATE>.json`.
3. Runs `scripts/filter-rank.mjs` over the raw + notion JSONs to drop noise, build the replied index, score every survivor, and write `data/ranked-<DATE>.json`.
4. Writes the human brief at `~/morning-brief/<DATE>.md`.
5. Runs `scripts/render-print.mjs` to write the print HTML alongside and open it in the browser.
6. Runs `scripts/cleanup-apps.mjs` to quit Calendar.app and Fantastical now that the brief is on screen. Idempotent: a no-op if either app is already closed. The Fantastical MCP server (FantasticalMCP.app) and the macOS widget keep running so tomorrow's brief can query Fantastical immediately.

## What the brief looks like (all four tiers live)

Top to bottom:

0. **Headline metrics** (T1 + T3). Blockquote line per metric. Derived (people waiting, open commitments, slow-burn count) from ranked data plus any custom external metric wired in `config.local.json` `metrics[]`.
1. **`# The One Thing`** (T1). Single highest-impact action of the day with the WHY.
2. **`## This week's mission`** (T3). Monday prompts for it, other days display it with "day N" tag, Sunday offers a recap. State at `data/week-state.json`.
3. **`## Who is waiting on me`**, ranked.
4. **`## Decisions waiting`** + **`## Responses waiting`** (T2). Each waiting item classified by heuristic.
5. **`## Due in the next 48 hours`**, mail + Basecamp + calendar deadlines.
6. **`## Today's meetings (next 36h)`** (T2). Per-event card with attendees, prior context, outcome, key question. Needs Calendar.app Automation permission.
7. **`## Promises you made`** (T2). Open commitments extracted from Notion call notes + Sent folder. Age from source_date.
8. **`## Slow burn (aging past threshold)`** (T3). Persistent first_seen dates; items past per-kind threshold (3d mail, 5d promise, 7d basecamp).
9. **`## Today, by person`** (T1 + T4). One canonical row per counterparty. **Per-person facts (T4)** rendered as `**What I know:**` sub-list: payments received, recurring meetings, agreements, LLM-narrative observations. Facts persist at `data/people-facts.json`, deduped exactly, aging via TTL.
10. **`## Active conversation threads`**, multi-round-trip threads.
11. **`## Notion call notes`**, last 7 days.
12. **`## Basecamp`**, assigned todos.
13. **`## Drafted replies (ready to copy-paste)`** (T1). Up to 3 fenced markdown blocks in Robby's voice.
14. **`## This week's recap`** (T4, Sunday only). Mission vs actuals, what closed, still open, new commitments, week-over-week sparklines (`▁▂▃▄▅▆▇█`). Driven by `data/trends.json` with rolling 12-week history.

## Tier 4 memory layer

Three new persistent stores feed the longevity of the brief:

- **`data/people-facts.json`** — per-counterparty truths that accumulate over runs. Rule-extracted: payments (`paid you $X`), recurring meetings (`weekly X sync`), accepted invitations, agreements. LLM-added during workflow: cross-source observations Claude writes after generating the brief. Up to 25 facts per person, top 5 rendered, TTL-prunable.
- **`data/trends.json`** — weekly snapshot of headline counts (waiting, decisions, promises, slow-burn, mail volume, VIP touchpoints) with rolling 12-week history. Powers Sunday recaps and week-over-week deltas.
- **`scripts/recap.mjs`** — assembles Sunday recap data: items closed this week, still-open inventory, new this week, mission vs actuals, sparkline visualizations.

## Tier 5 sync and share

Three sync targets, all idempotent, all opt-in via `config.local.json`:

```json
"sync": {
  "notion":    { "enabled": true, "parent_page_id": "abc..." },
  "calendar":  { "enabled": true, "calendar_name": "Work", "minutes": 90 },
  "reminders": { "enabled": true, "list_name": "Morning MVP" }
}
```

- **Notion**: pushes the brief as a markdown page (or database row) into a configured parent. Same-day re-runs update rather than duplicate. Properties auto-set: Date, Day of week, One Thing, People waiting, Open commitments. Actual MCP call happens during the skill workflow (because Notion MCP lives in Claude's tool space); the prepare-script + record-script bracket it for idempotency.
- **Calendar**: creates a `Deep work: <One Thing>` event today via AppleScript. Defaults to the next 25-minute slot, 90 minutes long, in the first writable calendar. Override calendar / start / minutes per config.
- **Reminders**: pushes slow-burn items, 48h deadlines, and aged promises (>=2d open) into a "Morning MVP" reminders list (auto-created). Same name = no duplicate.

Per-day records stored at `data/sync-state.json`. Rollback any day with:

```bash
node ~/.claude/skills/morning-mvp/scripts/unsync.mjs --date 2026-05-11
```

Dry-run anything via `--dry-run true` on the individual script or `push-all.mjs`. All three default OFF so the skill is safe to run on a fresh install without touching shared state.

## Install

The skill is installed at `~/.claude/skills/morning-mvp/`. Install its lone dev dep (used to run the TypeScript modules from `apple-mail-mcp`):

```bash
cd ~/.claude/skills/morning-mvp
npm install
npm test
```

Tests should pass with zero failures.

## Configure Basecamp (optional)

If you don't use Basecamp, skip this. The skill renders `Basecamp not configured` and moves on.

1. Get a personal access token. The cleanest path is the Basecamp API docs: https://github.com/basecamp/api/blob/master/sections/authentication.md. Generate an OAuth app or use an existing token from Launchpad: https://launchpad.37signals.com/integrations.
2. Find your **account_id**: log into Basecamp, look at your URL. `https://3.basecamp.com/4567890/...` => `4567890`.
3. Find your **user_id**: go to your Basecamp profile. The numeric id is in the URL.
4. Copy and edit the config:

   ```bash
   cp ~/.claude/skills/morning-mvp/config.example.json ~/.claude/skills/morning-mvp/config.local.json
   # then edit config.local.json
   ```

5. Verify it works:

   ```bash
   node ~/.claude/skills/morning-mvp/scripts/collect-basecamp.mjs --days 7
   ```

   If the token is good you'll see `{ "todos": [...] }`. If not, you'll see a 401 error message.

The config file is in `.gitignore`, so the token never leaks into any repo.

## How to run

Once installed, in Claude Code:

```
/morning-mvp
```

or just say "morning brief", "what's on my plate", or "who's waiting on me".

You can pass a window in days:

```
morning-mvp 14
```

When the skill finishes, your browser opens a printable one-pager. `Cmd+P` to print.

## Architecture

```
scripts/
├── collect-all.mjs        ← Orchestrator. Spawns mail + basecamp in parallel.
├── collect-mail.mjs       ← Loads apple-mail-mcp modules. Pulls unread/recent/sent.
├── collect-basecamp.mjs   ← Basecamp 3 REST. Skips gracefully if unconfigured.
├── filters.mjs            ← Newsletter / notification rules. Pure functions.
├── rank.mjs               ← Priority scoring, VIP set, replied index. Pure functions.
├── filter-rank.mjs        ← Glue. Reads raw + notion + basecamp JSON, writes ranked.
└── render-print.mjs       ← Markdown to print HTML, opens in browser.

test/
├── filters.test.mjs       ← Unit tests for filter rules.
└── rank.test.mjs          ← Unit tests for scoring + ranking + replied-index.

data/
└── (gitignored output)    ← raw-<DATE>.json, notion-<DATE>.json, ranked-<DATE>.json.

SKILL.md                   ← The skill prompt Claude reads.
README.md                  ← This file.
config.example.json        ← Copy to config.local.json and fill in.
package.json               ← `npm test`, `npm run collect`, etc.
```

## How filtering works

`filters.mjs` drops a message when ANY of these match:

| Rule | Catches |
|---|---|
| Sender email matches `noreply / no-reply / notifications / newsletter / digest / marketing / mailer-daemon / postmaster / automated / alerts / bounce` | Most automated systems |
| Sender domain is in the built-in blocklist | Mailchimp, SendGrid, Stripe, HubSpot, GitHub, Notion, Vercel, LinkedIn, YouTube, etc. |
| Subject matches an automated pattern | "Your receipt", "Payment received", "Accepted: ...", "Updated invitation:", "Build status", etc. |
| Subject is "Delivery Status Notification" | Bounces |

What survives goes to scoring. Everything dropped is logged in `data/ranked-<DATE>.json` under `dropped[]` so you can audit decisions.

## How ranking works

For each surviving message:

```
priority =
  (waiting_signal      * 3)     // unreplied AND personal sender AND asks for reply OR urgent
+ (deadline_signal     * 4)     // explicit deadline cue in next 48h
+ (vip_signal          * 2)     // sender exchanged 3+ messages with Robby in window
+ recency_score                 // 2 if <24h old, 1 if <72h, 0 otherwise
+ urgency_score * 0.5           // count of urgent keywords, capped at 5
```

Higher = higher in the brief. The render section keeps the top items per bucket.

## How "unreplied" works

Apple Mail's AppleScript surface doesn't cheaply expose RFC 822 In-Reply-To / References. The replied-index uses a conservative heuristic:

> An inbound message is "replied" if any Sent message in the window has a subject equal to `Re: <inbound subject>` (case insensitive) AND a later date.

This is conservative: a true-replied message can be missed (false unreplied), but a true-unreplied message is almost never marked replied. False unreplied is noise. False replied would silently drop work, which is worse. The tradeoff is intentional.

## Why each part exists

- **Why filters as a separate pure module**: filter rules change weekly. They have to be unit-testable in isolation. Embedded in the orchestrator they would never get tested.
- **Why scripts emit JSON, not text**: every stage is composable. Tests verify shape. Claude reads the JSON for the synthesis pass without re-parsing prose.
- **Why HTML + Markdown**: markdown is what Claude writes well. HTML is what prints well. Two artifacts, one source of truth.
- **Why Basecamp is optional**: most users don't have it. Hard-requiring it would block the skill for everyone else.

## Troubleshooting

**Mail collector hangs or returns empty**
Mail.app is wedged. Restart it:

```bash
osascript -e 'tell application "Mail" to quit'
sleep 5
osascript -e 'tell application "Mail" to activate'
```

Then retry.

**`Cannot find module .../apple-mail-mcp/src/...`**
`apple-mail-mcp` isn't installed at `~/apple-mail-mcp/`. Install it or update the path in `scripts/collect-mail.mjs` (`APPLE_MAIL_ROOT`).

**Basecamp 401**
Token expired or invalid. Regenerate at https://launchpad.37signals.com/integrations.

**Notion returns nothing**
Notion MCP isn't connected, or there are no recently edited pages matching "call notes / meeting / 1-on-1 / sync". The Notion section renders `(none in last N days)`. Not an error.

**HTML opens but looks wrong on print**
The print CSS targets US Letter at 0.45in margins. If you're on A4, override in your browser's print dialog or edit `scripts/render-print.mjs`.

## Memory hygiene

`data/` is purged manually. To clean older briefs:

```bash
find ~/.claude/skills/morning-mvp/data -mtime +30 -delete
find ~/morning-brief -mtime +90 -delete
```

## Related skills

- `apple-mail-mcp` (the MCP server this depends on for mail access)
- `anthropic-skills:morning-extraction` (Gmail-only, writes to Notion, no ranking)
- `/gsd-progress` (project status, not personal triage)
- `/gsd-check-todos` (claude-managed todos, not external sources)
