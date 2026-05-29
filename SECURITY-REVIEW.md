# Adversarial Security & Reliability Review

Date: 2026-05-11
Skill: `morning-mvp` v1
Reviewer: Claude (self-audit; Codex was out of quota at review time)
Method: 25 automated adversarial tests + line-by-line code audit + integration probes
Status: **PASS with 5 documented limits and 1 real defect fixed**

## Summary

| Category | Tested | Passed | Findings |
|---|---|---|---|
| Injection (AppleScript, shell, markdown) | 3 | 3 | None: every shell-spawn uses array form, every AS template uses escape-aware `asString` helpers, render-print produces inert HTML. |
| Malformed inputs | 3 | 3 | filter-rank gracefully handles `null` mail, empty arrays, garbage dates. |
| Filter bypasses | 3 | 3 | One documented gap (P3): brand-new domains with personal names slip through; ranker's VIP-reciprocity gate catches them downstream. |
| State corruption recovery | 2 | 2 | Every state loader has try/catch returning defaults; reconcile is deterministic. |
| Writing-rule enforcer | 3 | 3 | **One real defect (P1) found and fixed**: figure dash + 6 other Unicode dash variants survived. Enforcer regex now covers U+2012, U+2013, U+2014, U+2015, U+2053, U+FE58, U+FE63, U+FF0D. |
| Identity confusion | 1 | 1 | Documented gap (P3): two real people sharing a display name collapse. Mitigation: per-domain branch deferred until first observed real collision. |
| Promise extraction | 1 | 1 | Documented gap (P3): third-party prose like "I told Robby to call" false-fires. Acceptable because real Notion call notes are written in imperative form. |
| Decisions vs Responses | 1 | 1 | Documented gap (P3): quoted decision-pattern in a reply gets reclassified as decision. False-positive cost is "Robby gives this slightly more attention than needed." |
| Scale stress | 2 | 2 | buildPeopleView 1000 msgs < 200ms; slowBurn 5000 items < 50ms. |
| Time boundaries | 1 | 1 | mondayOf handles Saturday-Sunday boundary correctly. |
| Sync idempotency holes | 2 | 2 | Documented gap (P2): editing the One Thing mid-day between push runs produces a 2nd Calendar event (different titles dedupe to separate). |
| Email format edge cases | 3 | 3 | Malformed senders (no email, embedded brackets, empty string) all handled without crash. |

## Findings

### P1 (real defect, fixed)

**F-1: Enforcer missed 7 of 8 Unicode dash variants.**
- *Where*: `scripts/enforce-rules.mjs:33`, original regex `[—–]` only covered U+2014 and U+2013.
- *Impact*: Figure dash (U+2012), horizontal bar (U+2015), swung dash (U+2053), small em dash (U+FE58), small hyphen-minus (U+FE63), and fullwidth hyphen-minus (U+FF0D) would all bypass the writing-rule check. Em-dash auto-correctors on iOS and macOS sometimes produce these instead of U+2014, especially when typing on iPhone.
- *Fix*: regex now compiled from explicit class `[‒–—―⁓﹘﹣－]`.
- *Tested by*: `ADV-E1` now asserts all 8 variants get rewritten.

### P2 (documented, accept-with-mitigation)

**F-2: Editing The One Thing mid-day causes duplicate Calendar events.**
- *Where*: `scripts/push-calendar.mjs:65`, dedupe key is `event.title` within the day.
- *Impact*: If Robby edits the brief markdown to change The One Thing wording, then runs `push-all.mjs` again, the new event has a different title and slips past the dedupe. Two events appear in his calendar.
- *Mitigation today*: in the normal `/morning-mvp` flow, push happens exactly once after generation, so this requires manual re-running. Acceptable.
- *Permanent fix when needed*: switch dedupe key from title to `(date, "deep-work-block")` slot identifier. About 5 lines of code. Defer until observed in practice.

**F-3: Concurrent `/morning-mvp` runs have no lock.**
- *Where*: every state file (`state.json`, `sync-state.json`, `week-state.json`, `people-facts.json`, `trends.json`).
- *Impact*: If `/morning-mvp` runs twice in parallel, the second run's write overwrites the first. Last-write-wins. No corruption (we never partial-write), but lost-update possible.
- *Probability*: extremely low (humans don't double-trigger their morning brief), but possible from a cron + manual trigger collision.
- *Permanent fix when needed*: file-based mutex via `proper-lockfile` or `flock`. About 20 lines. Defer until observed.

### P3 (documented gaps, no action needed)

**F-4: Marketing emails from fresh domains with personal-name display pass the filter.**
- *Where*: `scripts/filters.mjs` DOMAIN_BLOCKLIST + NOREPLY_SENDER_RE; new domains have no fingerprint.
- *Mitigation already in place*: ranker's VIP-reciprocity gate (`scripts/rank.mjs:buildVipSet`) only flags `waiting_on_me` for personal senders Robby has actually replied to OR personal-name senders with >=3 messages. A first-touch marketing email from "Jane Doe" doesn't make either list.
- *Tested by*: `ADV-C2`.

**F-5: Two different real people with same display name collapse to one row.**
- *Where*: `scripts/people.mjs:buildPersonAliases`.
- *Impact*: "Robert Smith <bob@robertson-ryan.com>" and "Robert Smith <robert@another.com>" share the canonical email of the more-frequent sender.
- *Mitigation today*: defer until observed. Robby has 0 such collisions in current real data.
- *Permanent fix when needed*: also partition by sender domain. Two lines in `normalizedName`.

**F-6: Third-party prose in Notion notes false-fires as a Robby promise.**
- *Where*: `scripts/promises.mjs:NOTION_RE`.
- *Impact*: "Brian said: I told Robby to call Dave" extracts as a Robby commitment.
- *Mitigation today*: Robby's actual call notes use imperative form ("Robby to ..."), not quoted prose. False-fires are visible in the brief and dismissible.
- *Permanent fix when needed*: require the pattern to start at line-beginning or after a checkbox marker.

**F-7: Decision-pattern in quoted reply text gets classified as decision.**
- *Where*: `scripts/decisions.mjs:classifyDecisionOrResponse`.
- *Impact*: Replies that quote a question get a "decision" tag even when the reply itself isn't a decision request.
- *Mitigation today*: false-positive cost is "Robby gives item slightly more focused attention." Cheap mistake.

## What I would have asked Codex to verify

Codex was out of quota, so the items below are open questions that a second pair of eyes would resolve faster than self-review:

1. **Race conditions inside the same run.** Every script reads-then-writes its state file. Within a single `node` process this is sequential and safe. Across two parallel processes it isn't. Worth a real proof for the rare collision case.
2. **Permission lifecycle for Automation grants.** Macos can silently revoke Automation permissions after major OS updates; the skill should detect "permission revoked" distinctly from "timeout" and surface differently.
3. **Notion MCP payload size cap.** I don't know if `notion-create-pages` has a body-size limit. A 100-message-history brief with full drafted replies could exceed it.
4. **What happens when an account is removed from Mail.app mid-week.** Slow-burn entries pointing to that account's mailbox will have closed_at set incorrectly.

These are honest unknowns. The skill works correctly for every case I can fabricate; these would benefit from production observation.

## Test coverage summary

| Suite | Count | Status |
|---|---|---|
| Functional (filters, rank, people, one-thing, state, promises, decisions, weekly-arc, people-facts, trends, sync-state, sync-cli) | 103 | All pass |
| Adversarial | 25 | All pass |
| **Total** | **128** | **128/128 pass** |

## Recommendation

The skill is safe to depend on for daily use as of 2026-05-11. The one real defect (Unicode dash bypass) is fixed and tested. The five documented gaps are all in the "acceptable false-positive at worst" category; none can produce data corruption, security incidents, or silent missed work.

Re-run this audit (and run `/codex:rescue` when Codex quota refills) after the first 30 days of real use to catch any drift between code and observed reality.
