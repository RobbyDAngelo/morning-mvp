# Partner Quickstart

Five-minute setup. Get your first brief by tomorrow morning.

## 0. What you need

- A Windows or macOS machine.
- Claude Code installed and signed in.
- Node.js 20 or newer. Check with `node --version`. If missing, grab it from https://nodejs.org.
- Git installed. On Windows: https://git-scm.com/download/win.

## 1. Run the installer

**Windows (PowerShell, run as your normal user, NOT admin):**
```powershell
iwr -useb https://raw.githubusercontent.com/RobbyDAngelo/morning-mvp/main/install.ps1 | iex
```

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/RobbyDAngelo/morning-mvp/main/install.sh | bash
```

The installer will:
1. Verify Node 20+ and git.
2. Clone the skill to `%USERPROFILE%\.claude\skills\morning-mvp\` (Windows) or `~/.claude/skills/morning-mvp/` (macOS).
3. Run `npm install`.
4. Write a default config (Windows: Gmail + Google Calendar; macOS: Apple Mail + Fantastical).
5. Read your name, email, role, and writing rules from `~/CLAUDE.md` (Windows: `%USERPROFILE%\CLAUDE.md`). If you don't have one yet, create it: see step 2.
6. Run the test suite to confirm everything works.
7. Print a "DONE" banner with the next steps.

Expected output ends with a green `[install] DONE` line and a "Next steps" block.

## 2. Make sure you have a CLAUDE.md

The installer reads your personal Claude Code memory file to learn who you are. If you've used Claude Code before, you probably already have one at `~/CLAUDE.md`. Open it and confirm it has at least:

```markdown
# Your Name

Short tagline about what you do. Optional but useful for voice.

## Hard Rules

- Things you never want in drafted text (e.g. "No em dashes")
- Email rules ("Address me as 'Pat' in any draft", etc.)
```

If you don't have one, create it now and re-run the identity resolver:

```bash
cd ~/.claude/skills/morning-mvp
node scripts/identity-resolver.mjs
```

## 3. Authorize the MCP plugins

The Windows skill needs two Claude Code plugin MCPs to reach Gmail and Google Calendar.

### Gmail plugin

In Claude Code, install a Gmail-capable plugin pack. Anthropic's `small-business` or a Pipedream Gmail integration both work. After install, run the plugin's authenticate command (Claude will surface a slash command in your tool list, typically `/<plugin>__authenticate`). A browser opens, you grant the read scope to your Gmail account, done.

### Google Calendar plugin

Same drill. Install a Google Calendar plugin, run its authenticate command, grant calendar read.

Verify both are loaded by asking Claude: "list my available MCP tools whose name starts with mcp__plugin_". You should see the Gmail and Google Calendar entries.

## 4. Optional: configure Basecamp

If you don't use Basecamp, skip this. The brief renders `Basecamp not configured` and moves on.

If you do:

1. Get a personal access token: https://launchpad.37signals.com/integrations.
2. Find your account_id from your Basecamp URL: `https://3.basecamp.com/<account_id>/...`.
3. Find your user_id from your Basecamp profile URL.
4. Edit `~/.claude/skills/morning-mvp/config.local.json` (or the Windows path equivalent):

```json
"basecamp": {
  "account_id": "<your account id>",
  "user_id": "<your user id>",
  "access_token": "<your token>",
  "user_agent": "morning-mvp"
}
```

5. Verify:
```bash
cd ~/.claude/skills/morning-mvp
node --import tsx scripts/collect-basecamp.mjs --days 7
```
If the token works, you'll see a JSON dump. If not, a 401.

## 5. Check your setup (10 seconds)

Before the first run, let the doctor verify your environment:

```bash
cd ~/.claude/skills/morning-mvp
npm run doctor
```

On Windows: `cd $env:USERPROFILE\.claude\skills\morning-mvp; npm run doctor`

It prints a checklist. Green `✓` means good, `!` is an optional warning, `✗` is a blocker to fix first (it tells you how). It also reminds you which Gmail / Google Calendar plugins to connect inside Claude Code (it cannot check those itself).

## 6. Run your first brief

In any Claude Code session, type:

> Run my morning brief

Claude executes the twelve-step workflow. The first run typically takes 60 to 180 seconds depending on inbox size. When done, your default browser opens a printable HTML page. `Ctrl+P` (Windows) or `Cmd+P` (macOS) to print.

## Where things live

| Thing | Path |
|---|---|
| Skill | `~/.claude/skills/morning-mvp/` |
| Config | `~/.claude/skills/morning-mvp/config.local.json` |
| Identity | `~/.claude/skills/morning-mvp/identity.local.json` |
| Per-day raw data | `~/.claude/skills/morning-mvp/data/raw-<DATE>.json` |
| Per-day ranked data | `~/.claude/skills/morning-mvp/data/ranked-<DATE>.json` |
| Persistent state | `~/.claude/skills/morning-mvp/data/state.json`, `week-state.json`, `people-facts.json`, `trends.json`, `sync-state.json` |
| Brief output | `~/morning-brief/<DATE>.md` and `<DATE>.html` |

On Windows replace `~` with `%USERPROFILE%`.

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Install script fails on `npm install` | Node version too old | Upgrade to Node 20+ |
| Install script fails on `git clone` | git not on PATH | Install Git, restart terminal |
| Brief opens but mail section is empty (Windows) | Gmail plugin not authenticated | Run the plugin's authenticate slash command |
| Brief opens but calendar empty (macOS) | Fantastical not running, or its MCP server missing | `open -a Fantastical` then retry |
| Brief opens but calendar empty (Windows) | Google Calendar plugin not authenticated | Run its authenticate command |
| Drafted replies in someone else's voice | identity.local.json missing or stale | `node scripts/identity-resolver.mjs` to refresh from CLAUDE.md |
| Brief has em dashes in it | enforce-rules.mjs didn't run | Verify step 9 in SKILL.md ran. If yes, the codepoint may not be in the 8-variant set; file an issue. |

## Daily use

Once set up, just type "morning brief" at the start of your day. The skill remembers state across days:

- Items waiting on you accumulate aging timestamps. Old ones surface in "Slow burn".
- Weekly mission you set on Monday displays under "Day N" tag the rest of the week.
- Per-person facts grow over time. You see "What I know about Sarah" build up after a few weeks.
- Sunday gets you a weekly recap with sparklines.

To wipe state and start fresh (removes aging timestamps, weekly mission, and
per-person facts; the per-day cache regenerates next run):

```bash
rm -f ~/.claude/skills/morning-mvp/data/state.json \
      ~/.claude/skills/morning-mvp/data/week-state.json \
      ~/.claude/skills/morning-mvp/data/people-facts.json \
      ~/.claude/skills/morning-mvp/data/trends.json \
      ~/.claude/skills/morning-mvp/data/sync-state.json
```

On Windows (PowerShell): `Remove-Item $env:USERPROFILE\.claude\skills\morning-mvp\data\state.json, ...\week-state.json, ...\people-facts.json, ...\trends.json, ...\sync-state.json -ErrorAction SilentlyContinue`

To remove the skill entirely:

```bash
rm -rf ~/.claude/skills/morning-mvp ~/apple-mail-mcp  # macOS
```

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.claude\skills\morning-mvp  # Windows
```

## Questions

Open an issue at https://github.com/RobbyDAngelo/morning-mvp/issues.
