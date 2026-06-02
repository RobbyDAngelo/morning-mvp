---
name: morning-mvp
description: Run every morning to produce a single printable brief that ranks who is waiting on a response from Robby and what is due in the next 48 hours. Pulls Apple Mail (every account), Notion call notes from the last 7 days, and Basecamp todos assigned to Robby. Filters out newsletters, automated notifications, and anything that is not business or action. Renders to a print-friendly HTML one-pager and opens it in the browser. Trigger phrases include "morning brief", "what is on my plate today", "who is waiting on me", "morning MVP", "what needs a reply".
argument-hint: "[optional: window in days, default 7]"
disable-model-invocation: false
user-invocable: true
---

# Morning MVP

## Purpose

One printable page each morning. Who is waiting on Robby. What is due in the next 48 hours. Nothing else.

## Use this skill when

- Robby says "run my morning brief", "morning MVP", "what's on my plate", or "who's waiting on me"
- The first conversation of the day on a workday
- Robby is about to start work and wants a triage view

## Do not use this skill when

- Robby asks for a single message lookup (use Apple Mail tools directly)
- Robby asks for a project status report on one workstream (use a project skill)
- Robby asks for a calendar view only (use `/gsd-progress` or the calendar)
- Robby wants a weekly review or retrospective (different cadence, different skill)

## Input format

Optional integer: window in days. Default 7. If Robby says "morning brief 14" the window expands to 14 days. Cap is 30 days.

## Workflow

1. **Determine window.** Default 7 days. If argument is given, use it. Cap at 30.

2. **Collect raw data.** Run the orchestrator script. It produces a single JSON dump at `<skill-root>/data/raw-<YYYY-MM-DD>.json`:

   ```bash
   node <skill-root>/scripts/collect-all.mjs --days <N>
   ```

   The orchestrator pulls each source through a provider dispatcher
   (`scripts/collect-mail.mjs`, `scripts/collect-calendar.mjs`) that picks
   the right module from `scripts/providers/` based on `config.local.json`
   `providers` block and OS defaults:

   | OS | Default mail provider | Default calendar provider |
   |---|---|---|
   | macOS | `apple-mail` (uses local apple-mail-mcp) | `fantastical` with `apple-calendar` fallback |
   | Windows / Linux | `gmail` (MCP-via-workflow) | `google-calendar` (MCP-via-workflow) |

   What lands in `raw.json` depends on the providers picked:
   - **Mail** (any provider): per-account INBOX unread + recent + Sent in window, plus outgoing replies for cross-reference. macOS `apple-mail` returns full data directly. Cross-platform `gmail` returns `{skipped: true, requires_mcp: true, mcp_hint}` so step 2b below can fetch and merge.
   - **Basecamp**: todos assigned to the user with due_on within window. Skips cleanly if `config.local.json` `basecamp` is unconfigured. Cross-platform via REST.
   - **Calendar**: see step 2a for `fantastical` (mac) and the cross-platform `google-calendar` path.
   - **Metrics (Tier 3)**: each metric defined in `config.local.json` `metrics[]` runs (shell command -> single value) and renders as a top-of-brief blockquote.

   The `<skill-root>` placeholder resolves to the install path picked by
   `install.sh` / `install.ps1`, typically `~/.claude/skills/morning-mvp/`
   on macOS / Linux and `%USERPROFILE%\.claude\skills\morning-mvp\` on
   Windows.

2a. **Pull calendar events via the configured provider.** When the dispatcher's `raw.calendar.requires_mcp` is `true`, the calendar provider needs Claude to make the MCP call and merge the result. Two paths today:

   **A) macOS, fantastical provider:** Call `mcp__Fantastical__queryCalendarItems` with `query: ""` (match all) and `when: "<today> to <today+2 days>"`. If Fantastical is not running, launch it via `open -ga Fantastical` and retry once. If it still fails, fall back to the AppleScript Calendar.app data already in `raw.calendar`.

   **B) Windows / Linux, google-calendar provider:** Call whichever Google Calendar MCP tool is loaded in the session. Candidates listed under `raw.calendar.mcp_hint.candidate_mcp_tools`:
   - `mcp__plugin_small-business_google_calendar__list_events`
   - `mcp__pipedream-gmail__google_calendar-list-events`
   - `mcp__d4c8b32a-1328-4483-8a11-e8fa23ade9a4__list_events`

   Use `timeMin: <now ISO>`, `timeMax: <now+36h ISO>`, `singleEvents: true`,
   `orderBy: "startTime"`. Probe each candidate tool name in order;
   first that resolves is the right one.

   **If none of the candidate Google Calendar MCP tools are connected in this session** (first run, plugin not installed yet): do NOT fail the whole brief. Leave `raw.calendar.events` empty and render the meetings section as `Calendar unavailable: connect a Google Calendar MCP plugin in Claude Code, then re-run. See PARTNER-QUICKSTART.md.` Continue with the rest of the brief.

   In either path, save the events back into the raw JSON:

   ```bash
   node <skill-root>/scripts/save-calendar-events.mjs \
     --raw <skill-root>/data/raw-<YYYY-MM-DD>.json \
     --json '<MCP response JSON>'
   ```

   `save-calendar-events.mjs` auto-detects Fantastical / AppleScript / Google Calendar event shapes and normalizes to the canonical morning-mvp event shape. It also drops events with `status: "declined"`.

2b. **Pull mail via the configured provider when MCP-via-workflow.** When `raw.mail.requires_mcp` is `true` (Gmail or Outlook providers), Claude makes the MCP calls and merges via `save-mail.mjs`. For Gmail:

   - Read `raw.mail.mcp_hint.data_needed` to see the three buckets to fetch (unread, recent_inbox, sent_in_window) and the suggested Gmail query for each.
   - For each bucket, call the Gmail MCP's search-or-list tool with the suggested Gmail query (`is:unread newer_than:Nd`, `in:inbox newer_than:Nd`, `in:sent newer_than:Nd`). Candidate MCP tools are under `raw.mail.mcp_hint.candidate_mcp_tools`.
   - For each MCP response, save it into the raw JSON, targeting the right bucket:

     ```bash
     node <skill-root>/scripts/save-mail.mjs \
       --raw <skill-root>/data/raw-<YYYY-MM-DD>.json \
       --json '<MCP response JSON>' \
       --target unread        # or recent_inbox, or sent_in_window
     ```

   - `save-mail.mjs` accepts raw Gmail API shape (with `payload.headers`), pre-flattened Pipedream shape, and bare arrays. It dedupes by `message_id` across multiple invocations so multi-account merges are safe.
   - On macOS with the `apple-mail` provider, this step is skipped (the data is already in `raw.mail`).
   - **If none of the candidate Gmail MCP tools are connected in this session** (first run, plugin not installed or not authenticated yet): do NOT fail the brief. Tell the user plainly at the top of the brief: `Mail unavailable: connect and authenticate a Gmail MCP plugin in Claude Code, then re-run. See PARTNER-QUICKSTART.md.` Then build the brief from whatever other sources DID return data (Notion, Basecamp, calendar). A partial brief with a clear fix-it line beats a silent empty page.

3. **Pull Notion call notes for the window.** Call the Notion MCP search with these parameters:
   - Use `mcp__98a61912-ab1e-47b5-8c60-d7f46d1e3a0e__notion-search`
   - Query for last 7 days of call notes, meeting notes, and recent pages mentioning the user. Specifically search for: "call notes", "meeting", "1-on-1", "sync"
   - Filter results to the last `<window>` days by `last_edited_time`
   - Capture: title, URL, last_edited_time, key bullets if visible in snippets

   Write Notion results to `<skill-root>/data/notion-<YYYY-MM-DD>.json`.

4. **Filter and rank.** Run:

   ```bash
   node <skill-root>/scripts/filter-rank.mjs \
     --raw  <skill-root>/data/raw-<YYYY-MM-DD>.json \
     --notion <skill-root>/data/notion-<YYYY-MM-DD>.json \
     --out  <skill-root>/data/ranked-<YYYY-MM-DD>.json
   ```

   The script applies:
   - **Newsletter filter**: drops senders matching `noreply|no-reply|notifications|newsletter|digest|marketing|do[-_]?not[-_]?reply|mailer-daemon|postmaster`, plus domain blocklist (mailchimp, sendgrid, hubspot, salesforce, intercom, github action runners, etc.). Drops subjects matching automated patterns (receipts, calendar invites already accepted, build status, payment confirmations).
   - **Reply cross-reference**: marks each inbound message as `unreplied: true` if no message in Sent folder has its Message-ID in In-Reply-To or References, AND no Sent message in window has matching `Re: <subject>` to the original sender.
   - **Priority scoring**: each survivor gets `priority = (waiting_signal * 3) + (deadline_48h * 4) + (vip_signal * 2) + (recency_score)`. Higher = higher in the ranked output.

5. **Enrich the draft targets with full bodies.** Run:

   ```bash
   node --import tsx <skill-root>/scripts/enrich-drafts.mjs \
     --ranked <skill-root>/data/ranked-<YYYY-MM-DD>.json \
     --body-limit 2500
   ```

   On macOS (apple-mail provider) this calls `apple-mail-mcp`'s `getMessage` for each of the top 3 `draft_reply_targets` and writes back the full body, recipients, and date headers so step 7 can draft replies with real context.

   **On Windows / Linux (gmail provider)** the script detects that apple-mail-mcp is not available and exits cleanly with `{skipped: true}` (it does NOT crash). The draft-target bodies are instead fetched by you via the mail MCP: for each of the up to 3 entries in `ranked.draft_reply_targets`, call the Gmail MCP get-or-read-message tool with that entry's `message_id`, and use the returned body as the draft context in step 7. The targets always carry `message_id`, `sender`, and `subject`, so you know exactly what to fetch.

5b. **Enrich every other unreplied item with a body preview.** Run:

   ```bash
   node --import tsx <skill-root>/scripts/enrich-summaries.mjs \
     --ranked <skill-root>/data/ranked-<YYYY-MM-DD>.json \
     --max 15 --body-limit 600 --concurrency 4 --budget-ms 90000
   ```

   On macOS this pulls a ~600 character body preview for the top 15 unreplied messages in parallel (4 concurrent osascripts), capped by a 90-second wall-clock budget so Mail.app slowness can never block the brief by more than 90s.

   **On Windows / Linux (gmail provider)** the script seeds `body_preview` directly from the `snippet` the Gmail MCP already wrote onto each message in step 2b, instantly and with no extra fetch. Either way it attaches `body_preview` to each message in `waiting_on_me`, `decisions_waiting`, `responses_waiting`, and to each `people_view[].mail.unreplied[]`. These previews are what makes step 7c (summaries) possible. Items with no snippet fall back to subject-only summaries.

6. **Pick The One Thing.** Read `ranked-<YYYY-MM-DD>.json`. Look only at `one_thing_candidates` (top 10 pre-scored across waiting, deadlines, and promises the user made). Select **exactly one** that has the highest expected impact on the day. Tiebreakers, in order: (a) someone is blocked on the user specifically; (b) the deadline is inside 48 hours; (c) the relationship is high-value (anyone flagged VIP in `people_view`, plus key clients the user corresponds with most); (d) the item has been waiting longest. State the pick in one sentence: "Today's One Thing is X because Y." This becomes the first H1 of the brief.

7. **Draft 3 replies in the user's voice.** The user's identity is in `ranked.identity` (name, first_name, email, role, signoff, persona_hints), resolved from their `CLAUDE.md`. Draft as that person. For each `draft_reply_targets[i]`:
   - Get the full thread body. On macOS it is already on the target (`body`, from step 5). On Windows / Linux, fetch it via the mail MCP using the target's `message_id` (see step 5). Identify the asker's actual question or open loop.
   - Compose a 3-to-5 sentence reply that answers or moves it forward.
   - Voice rules (enforced again by `enforce-rules.mjs`):
     - No em dashes. Use commas, colons, or restructure.
     - No "isn't just X" / "is more than X" framing.
     - Direct, concise, no hedging, no AI filler ("I'd be happy to", "Let me know if").
     - Apply every rule in `ranked.identity.hard_rules` (the user's own writing rules from their CLAUDE.md). For Robby's install these include no "brother" diction and no EOS / Intrapreneurship / D&I terms; other users have their own.
     - Sign off only if `ranked.identity.signoff` is set; use that block verbatim, and only on formal external threads. If no signoff is configured, end with the reply body and no signature.
   - Each draft goes in its own fenced markdown block under `## Drafted replies (ready to copy-paste)`. Label each block with the recipient and subject so the user knows which is which.

7b. **Tier 2: write per-meeting cards from calendar data.** Read `raw-<DATE>.json` → `calendar.events`. For each event in the next 36 hours that is NOT all-day and NOT declined:
   - Card header: `### <Time>, <Title>` (use Apple's locale start-date as is).
   - Attendees: emails from `event.attendees`, cross-referenced with `people_view` to surface what Robby and that person have been discussing this week.
   - Prior context: top 3 most-recent mail subjects with this person, top 1 Notion call note title if present.
   - Desired outcome: ONE sentence. What does Robby want to leave this meeting with?
   - Key question: ONE question Robby should ask in the meeting.

7c. **Tier 2 + summary: handle Decisions vs Responses split with one-sentence descriptions.** The ranked JSON already classifies each waiting item as `decision_or_response`. Render them in two sub-sections: `### Decisions waiting` and `### Responses waiting`.

   **For each item, write a real one-sentence summary using `body_preview`:**
   - Read `m.body_preview` (set by step 5b). It's the first ~600 characters of the actual email body.
   - Distill it into ONE clean sentence answering: "what is this email actually asking or saying?"
   - The sentence is the SECOND line under each entry, after the sender + subject header.
   - Voice rules: no em dashes, no AI filler ("I want to let you know"), present tense, active voice, name the specific topic.
   - If `body_preview` is missing (enrichment couldn't fetch this message), fall back to "(body unavailable, subject: <subject>)" rather than fabricating.

   Example (good):
   ```
   - **Brian Toelle**, Re: Notes from today
     Brian agreed to bring a new partner onto Tuesday's TPA call and wants Robby to confirm the time and ask for a brief on who they are.
   ```

   Example (bad, do not produce):
   ```
   - **Brian Toelle**, Re: Notes from today
     Reply to Brian about the Tuesday call.
   ```
   (Bad because it restates the subject. The summary should add information not in the subject.)

   Apply the same "one-sentence description" treatment to **each unreplied email row inside the `## Today, by person` section**. Under each person's `**Mail**:` line, render a sub-bullet per unreplied message with the summary. Cap at top 3 unreplied per person to keep length manageable.

7d. **Tier 2 + Tier 3: render Promises tracker.** Read `ranked.promises_made`. Each entry has `title`, `counterparty`, `source_date`, `days_open`. Render under `## Promises you made` with one bullet per promise. Sort by `days_open` descending (oldest debt first).

7e. **Tier 3: render Slow burn.** Read `ranked.slow_burn`. Items past their per-kind aging threshold. Render under `## Slow burn (aging past threshold)` with `[kind] title, age_days` for each.

7f. **Tier 3: handle Weekly Arc.**
   - Run a tiny inline check on the day-of-week and current week state. Conceptually:
     ```js
     import { loadWeekState, decideAction, setMission, isMonday } from "./scripts/weekly-arc.mjs";
     const state = await loadWeekState();
     const decision = decideAction(state);
     ```
   - If `decision.action === "prompt_new_mission"` or `"rotate_and_prompt"`:
     - At the top of the brief, render a `## This week's mission` section asking Robby to declare it.
     - Suggest a draft mission for the week by reading the last week's promises and active threads. Then PERSIST the chosen mission via `setMission(state, missionText)` + `saveWeekState(state)` once Robby confirms.
   - If `decision.action === "display_current"`: render the mission as a one-liner immediately below `# The One Thing`, prefixed `## Week of <date>, day <N>: <mission>`.
   - If `decision.action === "offer_recap"` (Sunday): produce a one-paragraph recap of what got done versus the mission, attached to the brief end.

7g. **Tier 3: render Metric line.** Read `raw.metrics.metrics`. Render at the very top of the brief, BEFORE `# The One Thing`, as a single blockquote line per metric:
   ```
   > **<label>**: <formatted>
   ```
   Skip metrics with errors. Also render every entry in `ranked.headline_metrics` (derived from ranked data, not external commands).

7h. **Tier 4: harvest narrative person facts.** `filter-rank.mjs` already rule-harvested obvious facts (payments, recurring meetings, accepted invites) into `people-facts.json`. Add narrative facts the regex can't catch: cross-source observations like "Brian is leading the TPA partner directory and the CashFlowMgt feedback loop with Rik Sprague", "Morgan owns the AT&T phone fix by May 18", or "Shawna shows the sympathy-cycle pattern per Ellie's call note". For each new fact you write into the brief, also call:
   ```js
   import { loadFacts, saveFacts, addFact } from "./scripts/people-facts.mjs";
   const f = await loadFacts();
   addFact(f, "<email>", "<text>", "llm");
   await saveFacts(f);
   ```
   Dedupe is automatic by exact text; safe to over-call.

7i. **Tier 4: render per-person facts** in the People view. Each person row already has `facts[]` attached (top 5 most-recent). Render them as a `**What I know:**` bullet sub-list under each person, before the "Where it stands" line.

7j. **Tier 4: weekly recap (Sunday only).** If `ranked.recap_data` is non-null, render `## This week's recap` at the BOTTOM of the brief, just before the source footer. Use the data to write a one-paragraph recap covering: (a) mission vs actuals, (b) what closed, (c) what's still open, (d) new commitments made, (e) week-over-week deltas. Sparklines from `recap_data.sparklines` render inline (one block per recent week).

8. **Generate the brief.** Write `~/morning-brief/<YYYY-MM-DD>.md` with the format below. Do not pad. Empty sections render as "(none)".

9. **Enforce writing rules.** Run the enforcer over the markdown. It always auto-rewrites every em-dash variant to a comma (universal). Brand-specific rules (rewrite "brother", flag contract framing / EOS / D&I) are OFF by default and only run when enabled per user via `--brand` or `config.local.json` `writing.*` flags; when enabled and a flagged term needs manual rewrite, it exits 2 (fix and re-run before rendering).

   ```bash
   node <skill-root>/scripts/enforce-rules.mjs ~/morning-brief/<YYYY-MM-DD>.md
   ```

10. **Tier 5: sync and share.** After the brief is finalized and enforced, run the sync orchestrator:

    ```bash
    node <skill-root>/scripts/push-all.mjs \
      --ranked <skill-root>/data/ranked-<YYYY-MM-DD>.json \
      --brief ~/morning-brief/<YYYY-MM-DD>.md
    ```

    Each target gated by `config.local.json` `sync.<target>.enabled`. Defaults are OFF until user opts in:
    - **calendar (macOS, PREFERRED via Fantastical)**: instead of running `push-calendar.mjs`, call `mcp__Fantastical__createCalendarItem` with a natural-language `description` like `"Deep work: <One Thing> tomorrow 6am for 90 minutes"`. Pick the right `calendarId` from `mcp__Fantastical__queryCalendars` (use the user's preferred work calendar, or `config.local.json` `sync.calendar.calendar_name` if set, else the first writable one). On Windows / Linux, create the block via the Google Calendar MCP instead. After it returns, run:

       ```bash
       node <skill-root>/scripts/record-calendar-event.mjs \
         --date <YYYY-MM-DD> --title "Deep work: ..." --event-id <ID> \
         --calendar <calendar_id> --start <ISO> --end <ISO>
       ```

       If Fantastical isn't running OR `sync.calendar.use_applescript: true` in config, fall back to `push-calendar.mjs` (the AppleScript path) instead. Both write to the same `sync-state.json` for idempotency, and `unsync.mjs` rolls back either source.
    - **reminders**: pushes slow-burn + 48h-deadline + aged-promise items into the "Morning MVP" Reminders list (created if missing).
    - **notion**: prints a payload with markdown body + properties. The script does NOT call Notion. Claude in this workflow then calls `mcp__98a61912-...-notion-create-pages` with the payload's `parent`, `title`, `properties`, and `content` (markdown). After Claude gets back the page id and URL, run:

       ```bash
       node <skill-root>/scripts/record-sync.mjs \
         --date <YYYY-MM-DD> --kind notion --page-id <ID> --url <URL>
       ```

    All three are idempotent within a day. To roll back any day's pushes:

    ```bash
    node <skill-root>/scripts/unsync.mjs --date <YYYY-MM-DD>
    ```

11. **Render to print HTML and open.** Run:

    ```bash
    node <skill-root>/scripts/render-print.mjs ~/morning-brief/<YYYY-MM-DD>.md
    ```

    The script writes `~/morning-brief/<YYYY-MM-DD>.html` with embedded print CSS (US Letter, 0.5in margins, 11pt body, 14pt headers, no color requirement) and opens it in the default browser (cross-platform: `open` on macOS, `start` via cmd on Windows, `xdg-open` on Linux). If the browser cannot be launched, the script prints the HTML path so the user can open it manually. The user presses `Cmd+P` (macOS) or `Ctrl+P` (Windows) from there.

12. **Clean up the calendar apps (macOS only).** After the brief is on screen, neither Calendar.app nor Fantastical needs to remain running. Quit them:

    ```bash
    node <skill-root>/scripts/cleanup-apps.mjs
    ```

    On Windows / Linux there are no such apps, so the script is a clean no-op (`{skipped: true}`) and the workflow is complete after step 11. On macOS it is idempotent: quitting an already-closed app is a no-op, and failures are logged to stderr and swallowed so cleanup never blocks the brief. The Fantastical MCP server (separate process) keeps running so tomorrow's brief can query it immediately.

## Output requirements

The morning brief must satisfy ALL of the following. Each maps to a binary check below.

- **R0** (Tier 1, NEW): The very first H1 of the brief is `# The One Thing` (or starts with that text), and the single sentence beneath it names exactly one action with both the WHAT (Today's One Thing is X) and the WHY (because Y).
- **R1**: Contains a section titled `Who is waiting on me` with one ranked list. Each entry shows `[sender name] [their email address] [subject] [received date in plain English]`. Empty section renders as `(none)`.
- **R2**: Contains a section titled `Due in the next 48 hours` listing every item with a deadline before the cutoff. Each entry shows `[source: Mail / Notion / Basecamp] [item] [due date]`. Empty section renders as `(none)`.
- **R3** (Tier 1 + summary, NEW): Contains a section titled `Today, by person` with one row per canonical counterparty (Brian's 3 email addresses collapse to one row). Each row shows: name, VIP flag, source counts (mail / notion / basecamp / threads), a one-line "Where it stands" summary written by Claude. **Under the Mail count, render up to 3 sub-bullets per person, each a one-sentence description of an individual unreplied email** (using each message's `body_preview` from step 5b). The descriptions add information beyond the subject line. Example: instead of "Brian: 2 unreplied" alone, the row also shows "Brian wants you to confirm Tuesday's TPA call and ask about the new partner he's bringing" + "Brian sent NarrowGate Master Business Plan v6 on April 30, awaiting your review feedback."
- **R4**: Contains a section titled `Active conversation threads` covering ongoing business threads from the last 7 days (more than 2 round-trips with a real person, not yet resolved). Each entry shows `[counterparty] [topic] [last activity date]`.
- **R5**: Contains a section titled `Notion call notes (last <window> days)` listing each captured call note with title, date, and one-sentence summary of commitments Robby made.
- **R6**: Contains a section titled `Basecamp` listing assigned todos. If unconfigured, renders `Basecamp not configured. Run setup: see README.md.`
- **R7** (Tier 1, NEW): Contains a section titled `Drafted replies (ready to copy-paste)` with one fenced markdown block per draft target (up to 3). Each block labels the recipient and original subject. Each draft is 3-5 sentences, in Robby's business voice, ready to paste into Mail.app's reply window.
- **R7a** (Tier 2 + summary, NEW): When `decisions_waiting` or `responses_waiting` is non-empty, the brief contains the corresponding section. **Every item is followed by a one-sentence description** written by Claude using the message's `body_preview`. The description states what the email is actually asking or saying, NOT a paraphrase of the subject line. If `body_preview` is missing, the description reads `(body unavailable, subject: <subject>)`.
- **R7b** (Tier 2, NEW): When `promises_made` is non-empty, the brief contains `## Promises you made` with each promise showing the verb phrase, the audience, source date, and days_open.
- **R7c** (Tier 2, NEW): When `raw.calendar.events` has any event in the next 36 hours, the brief contains `## Today's meetings (next 36h)` with one card per event: time, title, attendees, prior context (mail + Notion), desired outcome (1 sentence), key question (1 sentence).
- **R7d** (Tier 3, NEW): When `raw.metrics.metrics` has any successful metric, render each as a blockquote line `> **<label>**: <formatted>` at the very TOP of the brief, ABOVE `# The One Thing`.
- **R7e** (Tier 3, NEW): When the weekly arc decision is `display_current`, render `## Week of <date>, day <N>: <mission>` immediately below The One Thing. When `prompt_new_mission` or `rotate_and_prompt`, render that prompt at the top.
- **R7f** (Tier 3, NEW): When `slow_burn` is non-empty, render `## Slow burn (aging past threshold)` with one bullet per item: `[kind] title — <N>d old, threshold <M>d`.
- **R8**: Contains zero em dashes anywhere in the output. Zero instances of "isn't just" or "is more than" framing. Zero use of "brother" diction. No D&I or EOS terminology.
- **R9**: Total brief fits on two US Letter pages when printed (rough budget: 120 lines of body content with all Tier 2/3 sections active; one page when most sections are empty).
- **R10**: Saves both `~/morning-brief/<YYYY-MM-DD>.md` and `~/morning-brief/<YYYY-MM-DD>.html` and opens the HTML in the default browser.

## Output format

```
# The One Thing

Today's One Thing is <action>, because <reason>. Do this before anything else.

---

# Morning Brief, <day-of-week>, <Month DD, YYYY>

Window: last <N> days · Generated <HH:MM AM/PM>

## Who is waiting on me

1. **<Sender Name>** `<sender@email>`, <subject>
   <one sentence about what they asked, plain English>
   Received <X days/hours> ago. Account: <account>.

2. ...

(If empty: "(none)")

## Due in the next 48 hours

- **<Source>**, <item title>, due <date, time>
- ...

(If empty: "(none)")

## Today, by person

### <Counterparty Name> <VIP-tag-if-applicable>
- **Mail**: <N> unreplied, <N> read. Subjects: <comma list, truncated>.
- **Threads**: <N active>.
- **Notion**: <N call notes touching this person this week>.
- **Basecamp**: <N todos> (or "not in this account").
- **Where it stands**: <one sentence Claude generates from context, plain English>.

(Repeat per person, ranked by activity_score from people_view.)

## Active conversation threads

- **<Counterparty>**, <topic>, last activity <date>
- ...

## Notion call notes (last <N> days)

- **<Date> · <Title>**, <one sentence: commitments Robby made or open questions>
- ...

## Basecamp

- **<Project>**, <todo title>, due <date>
- ...

(If unconfigured: see README to enable Basecamp.)

## Drafted replies (ready to copy-paste)

### To: <Recipient Name> `<email>` — Re: <Original Subject>

```
<3-5 sentence draft in Robby's voice, ready to paste into Mail.app>
```

(Repeat per draft target, up to 3 total. If zero waiting items, omit section.)

---
Source: morning-mvp v1 · `~/.claude/skills/morning-mvp/`
```

## Failure handling

- **If `apple-mail-mcp` modules cannot be loaded**: surface the error path with a clear message, then continue with whatever sources did succeed. Mail items section renders `Mail unavailable: <reason>`.
- **If Mail.app is wedged** (osascript -1712 AppleEvent timed out): suggest `pkill -9 osascript && osascript -e 'tell app "Mail" to activate'`, then retry once. If still failing, render Mail section as `Mail unavailable: AppleEvent timeout. Try restarting Mail.app.`
- **If Notion MCP returns nothing**: render the Notion section as `(none in last <N> days)`. Do not invent entries.
- **If Basecamp config is missing**: render `Basecamp not configured. See README.md to enable.` Do not fail the brief.
- **If filter-rank classifies everything as NOISE** (zero survivors): render `(quiet day, nothing requires action)` under each empty section. Do not pad with fake items.
- **If output would require speculation about what someone wants**: keep their subject line and a quote from the body. Do not invent intent.

## Writing rule enforcement (FINAL PASS)

Before saving the brief, apply the UNIVERSAL rules (every user) and any BRAND rules the user opted into.

```
UNIVERSAL (always)
- em dashes (any variant) → replace with comma, colon, period, or restructure
- AI filler ("I'd be happy to", "Let me know if...", "Here's the rewrite") → cut entirely
- apply every rule the user wrote in ranked.identity.hard_rules

BRAND (only if the user enabled them via config.local.json writing.* or --brand)
- "isn't just" / "is more than" / "not just X but Y" framing → use direct affirmative
- "brother" → use "man", "gents", "my man"
- "EOS", "Intrapreneurship", "Entrepreneurial Operating System" → omit or the user's preferred term
- "Diversity and Inclusion", "DEI", "D&I" → omit
```

`enforce-rules.mjs` runs the universal em-dash pass for everyone and the brand rules only when enabled. The universal rules map to binary check R8.

## Additional resources

- `scripts/collect-all.mjs` — runs all source collectors in parallel
- `scripts/collect-mail.mjs` — Apple Mail collector via `apple-mail-mcp`
- `scripts/collect-basecamp.mjs` — Basecamp 3/4 todos via REST
- `scripts/filter-rank.mjs` — newsletter filter and priority scorer
- `scripts/render-print.mjs` — markdown to print HTML and browser open
- `README.md` — setup, Basecamp token instructions, troubleshooting
- `config.example.json` — config template (copy to `config.local.json`)
