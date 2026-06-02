# morning-mvp

[![CI](https://github.com/RobbyDAngelo/morning-mvp/actions/workflows/ci.yml/badge.svg)](https://github.com/RobbyDAngelo/morning-mvp/actions/workflows/ci.yml)

One printable page each morning. Who is waiting on you. What is due in the next 48 hours. Nothing else.

Built as a Claude Code skill. Works on macOS and Windows. Pulls from your mail, calendar, Notion call notes, and Basecamp todos; filters noise, ranks by urgency and relationship; writes a printable HTML one-pager and opens it in your browser.

## Install

**macOS or Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/RobbyDAngelo/morning-mvp/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
iwr -useb https://raw.githubusercontent.com/RobbyDAngelo/morning-mvp/main/install.ps1 | iex
```

The installer clones the skill to `~/.claude/skills/morning-mvp/` (or `%USERPROFILE%\.claude\skills\morning-mvp\` on Windows), installs dependencies, resolves your identity from `~/CLAUDE.md`, writes a default config tuned to your OS, and smoke-tests the install. Takes about 30 seconds.

See [PARTNER-QUICKSTART.md](./PARTNER-QUICKSTART.md) for the five-minute setup walkthrough.

## How to run it

In Claude Code, ask any of:

- "Run my morning brief"
- "What is on my plate today?"
- "Who is waiting on me?"

Or invoke the skill directly. Claude executes a twelve-step workflow defined in [SKILL.md](./SKILL.md), produces a markdown brief at `~/morning-brief/<DATE>.md`, renders the printable HTML alongside, and opens it in your default browser. Press `Cmd+P` (macOS) or `Ctrl+P` (Windows) to print.

## What the brief contains

Top to bottom, depending on the day:

| Section | What it shows |
|---|---|
| Headline metrics | Open commitments, slow-burn count, people waiting on you |
| The One Thing | Single highest-impact action of the day with the why |
| Weekly mission | Monday prompts for it, weekday displays it, Sunday recaps |
| Who is waiting on me | Ranked list of unreplied messages |
| Decisions waiting / Responses waiting | Same messages, classified |
| Due in the next 48 hours | Mail deadlines, Basecamp todos, calendar items |
| Today's meetings | One card per meeting with attendees, prior context, desired outcome |
| Promises you made | Open commitments from Notion call notes + your sent mail |
| Slow burn | Items past per-kind aging threshold |
| Today, by person | One row per counterparty with VIP flag, source counts, what you know about them |
| Active conversation threads | Multi-round-trip ongoing threads |
| Notion call notes | Last seven days, summarized |
| Basecamp | Your assigned todos |
| Drafted replies | Up to three fenced markdown blocks ready to paste into your mail client |
| Weekly recap | Sunday only: mission vs. actuals, what closed, sparklines |

Empty sections render as `(none)`. The brief fits on two US Letter pages when printed.

## What it pulls from, by platform

| Source | macOS provider | Windows provider | Auth model |
|---|---|---|---|
| **Mail** | apple-mail (via [apple-mail-mcp](https://github.com/RobbyDAngelo/apple-mail-mcp)) | gmail (via Claude Code Gmail plugin) | macOS: Mail.app Automation grant. Windows: Gmail MCP OAuth (once at plugin install). |
| **Calendar** | fantastical (with apple-calendar fallback) | google-calendar | macOS: Fantastical MCP. Windows: Google Calendar MCP OAuth. |
| **Notion call notes** | notion-mcp | notion-mcp | Notion MCP, same on both. |
| **Basecamp todos** | REST + personal access token | REST + personal access token | Optional. Skips cleanly if unconfigured. |
| **Custom metrics** | shell commands per `config.local.json` | shell commands | Optional. |

The provider model lives in `scripts/providers/`. Adding a new mail or calendar source means dropping one module that returns a normalized shape; see [ARCHITECTURE.md](./ARCHITECTURE.md) for the contract.

## What it does NOT do

- Does not poll on a schedule. You run it when you want the brief.
- Does not send mail on your behalf. Read and classify only. Drafted replies are markdown blocks you paste into your mail client.
- Does not act as a CRM. Items live in their source system.
- Does not phone home or share data with anyone. Everything runs locally.

## Configuration

The installer writes a working default to `<install-root>/config.local.json`. Edit it to:

- Change provider choices (`providers.mail`, `providers.calendar`, `providers.tasks`).
- Add Basecamp credentials under `basecamp`.
- Add custom shell-command metrics under `metrics[]`.
- Enable Tier 5 sync targets (Notion writeback, calendar block, reminders push) under `sync`. All three default OFF.

Identity (name, email, role, persona hints, hard rules) is auto-resolved from `~/CLAUDE.md` into `<install-root>/identity.local.json`. Edit `~/CLAUDE.md` to refine, then re-run:

```bash
cd <install-root>
node scripts/identity-resolver.mjs
```

## Privacy

Three categories of data the skill creates, all gitignored:

- `data/`: per-day raw and ranked JSON. Auto-generated each morning.
- `state/`: persistent memory (slow-burn aging timestamps, weekly mission, per-person facts, rolling metrics, sync rollback keys). Grows over time per install.
- `config.local.json` + `identity.local.json`: your config and identity. Never commit.

The skill does not transmit your data anywhere. All processing happens locally. The Claude session that runs the skill sees the contents during synthesis, same as any other tool call.

## Tests

```bash
cd <install-root>
npm test                  # standard suite (~170 tests)
npm run test:adversarial  # security-style edge cases (25 tests)
npm run test:all          # both
```

All tests pass on Node 20+.

## Architecture and contract docs

- [SKILL.md](./SKILL.md): the workflow Claude follows when invoked.
- [ARCHITECTURE.md](./ARCHITECTURE.md): provider model, pipeline stages, persistence layout.
- [HANDOFF.md](./HANDOFF.md): future-Claude-session onboarding.
- [SECURITY-REVIEW.md](./SECURITY-REVIEW.md): adversarial audit findings.
- [scripts/providers/README.md](./scripts/providers/README.md): provider contract.

## Troubleshooting

- **Brief empty.** Inspect `data/raw-<DATE>.json` for `mail.errors[]` or empty arrays. Usually Mail.app Automation permission (macOS) or a not-yet-authenticated Gmail plugin (Windows).
- **Calendar empty.** On macOS, confirm Fantastical is running. On Windows, confirm the Google Calendar plugin is authenticated.
- **`Cannot find module .../apple-mail-mcp/src/...`** on macOS: run `git clone https://github.com/RobbyDAngelo/apple-mail-mcp.git ~/apple-mail-mcp && cd ~/apple-mail-mcp && npm install` then re-run.
- **Basecamp 401**: regenerate the token at https://launchpad.37signals.com/integrations.
- **HTML prints wrong on A4**: override in your browser's print dialog or edit `scripts/render-print.mjs` (US Letter is the default).

## License

MIT. See [LICENSE](./LICENSE).
