#!/usr/bin/env bash
# morning-mvp installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/RobbyDAngelo/morning-mvp/main/install.sh | bash
#
# Or after cloning:
#   ./install.sh
#
# Environment overrides:
#   INSTALL_ROOT       Where to put the skill. Default: $HOME/.claude/skills/morning-mvp
#   REPO_URL           Git URL to clone from. Default: github.com/RobbyDAngelo/morning-mvp
#   BRANCH             Branch to check out. Default: main
#   APPLE_MAIL_REPO    Where to get apple-mail-mcp (macOS only).
#                      Default: github.com/RobbyDAngelo/apple-mail-mcp
#   APPLE_MAIL_DIR     Where apple-mail-mcp lives. Default: $HOME/apple-mail-mcp
#   SKIP_APPLE_MAIL    Set to "1" to skip apple-mail-mcp install (use Gmail provider).

set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.claude/skills/morning-mvp}"
REPO_URL="${REPO_URL:-https://github.com/RobbyDAngelo/morning-mvp.git}"
BRANCH="${BRANCH:-main}"
APPLE_MAIL_REPO="${APPLE_MAIL_REPO:-https://github.com/RobbyDAngelo/apple-mail-mcp.git}"
APPLE_MAIL_DIR="${APPLE_MAIL_DIR:-$HOME/apple-mail-mcp}"
SKIP_APPLE_MAIL="${SKIP_APPLE_MAIL:-0}"

log()  { printf '\033[36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[install]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Detect OS.
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  *) fail "Unsupported OS: $OS. Use install.ps1 for Windows." ;;
esac
log "platform: $PLATFORM"

# 2. Check prerequisites.
command -v git >/dev/null 2>&1 || fail "git not found. Install git first."
command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js 20+ from https://nodejs.org and re-run."
command -v npm >/dev/null 2>&1 || fail "npm not found. Install Node.js 20+ (includes npm)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js 20+ required (found $(node --version)). Upgrade and re-run."
fi
log "node $(node --version) OK"

# 3. Clone or update the skill.
if [ -d "$INSTALL_ROOT/.git" ]; then
  log "updating existing checkout at $INSTALL_ROOT"
  git -C "$INSTALL_ROOT" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_ROOT" reset --hard "origin/$BRANCH"
else
  if [ -d "$INSTALL_ROOT" ] && [ -n "$(ls -A "$INSTALL_ROOT" 2>/dev/null || true)" ]; then
    fail "$INSTALL_ROOT exists and is not empty. Move it aside or set INSTALL_ROOT and re-run."
  fi
  mkdir -p "$(dirname "$INSTALL_ROOT")"
  log "cloning $REPO_URL into $INSTALL_ROOT"
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$INSTALL_ROOT"
fi

# 4. macOS only: clone apple-mail-mcp sibling repo.
if [ "$PLATFORM" = "darwin" ] && [ "$SKIP_APPLE_MAIL" != "1" ]; then
  if [ -d "$APPLE_MAIL_DIR/.git" ]; then
    log "updating apple-mail-mcp at $APPLE_MAIL_DIR"
    git -C "$APPLE_MAIL_DIR" pull --ff-only || warn "apple-mail-mcp pull failed; continuing"
  elif [ -d "$APPLE_MAIL_DIR" ] && [ -n "$(ls -A "$APPLE_MAIL_DIR" 2>/dev/null || true)" ]; then
    warn "$APPLE_MAIL_DIR exists and is not a git repo. Skipping apple-mail-mcp clone."
  else
    log "cloning apple-mail-mcp into $APPLE_MAIL_DIR"
    if git clone --depth 1 "$APPLE_MAIL_REPO" "$APPLE_MAIL_DIR"; then
      (cd "$APPLE_MAIL_DIR" && npm install --silent) || warn "apple-mail-mcp npm install failed; mail provider may not work"
    else
      warn "apple-mail-mcp clone failed; you'll need to install manually or switch to gmail provider"
    fi
  fi
fi

# 5. npm install.
log "running npm install in $INSTALL_ROOT"
(cd "$INSTALL_ROOT" && npm install --silent)

# 6. Write provider defaults if config.local.json is absent.
CONFIG_PATH="$INSTALL_ROOT/config.local.json"
if [ ! -f "$CONFIG_PATH" ]; then
  log "writing default config to $CONFIG_PATH"
  case "$PLATFORM" in
    darwin)
      MAIL_PROVIDER='"apple-mail"'
      CAL_PROVIDER='"fantastical"'
      CAL_FALLBACK='"apple-calendar"'
      ;;
    *)
      MAIL_PROVIDER='"gmail"'
      CAL_PROVIDER='"google-calendar"'
      CAL_FALLBACK='null'
      ;;
  esac
  cat > "$CONFIG_PATH" <<JSON
{
  "providers": {
    "mail": ${MAIL_PROVIDER},
    "calendar": ${CAL_PROVIDER},
    "calendar_fallback": ${CAL_FALLBACK},
    "tasks": "basecamp-only"
  },
  "basecamp": {
    "_comment": "Optional. Get a token from https://launchpad.37signals.com/integrations.",
    "account_id": "0000000",
    "user_id": "0000000",
    "access_token": "",
    "user_agent": "morning-mvp"
  },
  "filters": {
    "_comment": "Per-user overrides on top of the built-in newsletter rules.",
    "always_include_senders": [],
    "always_drop_senders": [],
    "always_include_domains": [],
    "always_drop_domains": []
  },
  "metrics": [],
  "sync": {
    "_comment": "All targets default OFF. Enable by setting enabled: true.",
    "notion":    { "enabled": false, "parent_page_id": "", "database_url": "" },
    "calendar":  { "enabled": false, "calendar_name": null, "start": null, "minutes": 90 },
    "reminders": { "enabled": false, "list_name": "Morning MVP" }
  }
}
JSON
else
  log "config.local.json already exists, leaving it alone"
fi

# 7. Resolve identity from ~/CLAUDE.md.
log "resolving identity from CLAUDE.md"
(cd "$INSTALL_ROOT" && node scripts/identity-resolver.mjs) || warn "identity resolution had warnings; edit identity.local.json manually if needed"

# 8. Smoke test.
log "running smoke test (npm test)"
TEST_LOG="$(mktemp -t morning-mvp-install-test.XXXXXX)"
if ! (cd "$INSTALL_ROOT" && npm test --silent) >"$TEST_LOG" 2>&1; then
  warn "smoke test FAILED. Last lines:"
  tail -20 "$TEST_LOG" >&2
  fail "Install aborted. Full log: $TEST_LOG"
fi
rm -f "$TEST_LOG"
log "smoke test passed"

# 9. Next steps.
printf '\n\033[32m[install] DONE\033[0m\n\n'
printf 'Skill installed at: %s\n' "$INSTALL_ROOT"
printf 'Config:             %s\n' "$CONFIG_PATH"
printf 'Identity:           %s/identity.local.json\n\n' "$INSTALL_ROOT"
cat <<NEXT
Next steps:
  1. In Claude Code, install plugin packs that expose the MCPs you need.
     macOS (Apple Mail, Fantastical): your existing setup already covers this.
     Cross-platform (Gmail, Google Calendar): install a Gmail-capable plugin
       (e.g. small-business or pipedream-gmail) and a Google-Calendar-capable
       plugin. Run each plugin's authenticate command on first use.
  2. To run the routine: ask Claude "run my morning brief", or invoke the
     morning-mvp skill directly.
  3. Optional: configure Basecamp in $CONFIG_PATH.
  4. Optional: edit ~/CLAUDE.md to refine name, role, hard rules, then re-run
     'cd $INSTALL_ROOT && node scripts/identity-resolver.mjs' to refresh
     identity.

NEXT
