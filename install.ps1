# morning-mvp installer for Windows.
#
# Usage (PowerShell 5.1+ or PowerShell 7+):
#   iwr -useb https://raw.githubusercontent.com/RobbyDAngelo/morning-mvp/main/install.ps1 | iex
#
# Or after cloning:
#   .\install.ps1
#
# Environment overrides:
#   $env:INSTALL_ROOT   Where to put the skill.
#                       Default: $env:USERPROFILE\.claude\skills\morning-mvp
#   $env:REPO_URL       Git URL to clone from.
#                       Default: https://github.com/RobbyDAngelo/morning-mvp.git
#   $env:BRANCH         Branch to check out. Default: main

$ErrorActionPreference = "Stop"

# Configuration with env overrides.
$InstallRoot = if ($env:INSTALL_ROOT) {
  $env:INSTALL_ROOT
} else {
  Join-Path $env:USERPROFILE ".claude\skills\morning-mvp"
}
$RepoUrl = if ($env:REPO_URL) { $env:REPO_URL } else { "https://github.com/RobbyDAngelo/morning-mvp.git" }
$Branch = if ($env:BRANCH) { $env:BRANCH } else { "main" }

function Write-Info($msg)  { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Write-Warn($msg)  { Write-Host "[install] $msg" -ForegroundColor Yellow }
function Write-Fail($msg)  { Write-Host "[install] $msg" -ForegroundColor Red; exit 1 }

Write-Info "starting on Windows"
Write-Info "install root: $InstallRoot"

# 1. Check prerequisites.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Fail "Node.js is not installed. Install Node 20+ from https://nodejs.org and re-run."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Fail "npm is not installed. Install Node 20+ (includes npm)."
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Fail "git is not installed. Install Git for Windows from https://git-scm.com/download/win"
}

$NodeVersionRaw = (& node --version)
$NodeMajor = [int]((& node -p "process.versions.node.split('.')[0]"))
if ($NodeMajor -lt 20) {
  Write-Fail "Node.js 20+ required (found $NodeVersionRaw). Upgrade and re-run."
}
Write-Info "node $NodeVersionRaw OK"

# 2. Clone or update.
if (Test-Path (Join-Path $InstallRoot ".git")) {
  Write-Info "updating existing checkout at $InstallRoot"
  & git -C $InstallRoot fetch --depth 1 origin $Branch
  if ($LASTEXITCODE -ne 0) { Write-Fail "git fetch failed" }
  & git -C $InstallRoot reset --hard "origin/$Branch"
  if ($LASTEXITCODE -ne 0) { Write-Fail "git reset failed" }
} else {
  if (Test-Path $InstallRoot) {
    $items = Get-ChildItem $InstallRoot -ErrorAction SilentlyContinue
    if ($items -and $items.Count -gt 0) {
      Write-Fail "$InstallRoot exists and is not empty. Move it aside or set `$env:INSTALL_ROOT and re-run."
    }
  }
  $parent = Split-Path $InstallRoot -Parent
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Write-Info "cloning $RepoUrl into $InstallRoot"
  & git clone --depth 1 -b $Branch $RepoUrl $InstallRoot
  if ($LASTEXITCODE -ne 0) { Write-Fail "git clone failed" }
}

# 3. npm install.
Write-Info "running npm install"
Push-Location $InstallRoot
try {
  & npm install --silent
  if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed" }
} finally {
  Pop-Location
}

# 4. Write Windows-default config.local.json if absent.
$ConfigPath = Join-Path $InstallRoot "config.local.json"
if (-not (Test-Path $ConfigPath)) {
  Write-Info "writing default config to $ConfigPath"
  $DefaultConfig = @'
{
  "providers": {
    "mail": "gmail",
    "calendar": "google-calendar",
    "calendar_fallback": null,
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
'@
  Set-Content -Path $ConfigPath -Value $DefaultConfig -Encoding UTF8
} else {
  Write-Info "config.local.json already exists, leaving it alone"
}

# 5. Resolve identity from CLAUDE.md.
Write-Info "resolving identity from CLAUDE.md"
Push-Location $InstallRoot
try {
  & node scripts\identity-resolver.mjs
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "identity resolution had warnings (continuing). Edit identity.local.json manually if needed."
  }
} finally {
  Pop-Location
}

# 6. Smoke test.
Write-Info "running smoke test (npm test)"
$TestLogPath = Join-Path $env:TEMP "morning-mvp-install-test.log"
$TestExit = 1
Push-Location $InstallRoot
try {
  # Redirect ALL streams to the log with *> (no trailing cmdlet in the
  # pipeline), then capture $LASTEXITCODE on the very next line so it
  # unambiguously reflects npm's exit code on Windows (npm is npm.cmd).
  & npm test --silent *> $TestLogPath
  $TestExit = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($TestExit -ne 0) {
  Write-Warn "smoke test FAILED (exit $TestExit). Last lines:"
  Get-Content $TestLogPath -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  Write-Fail "Install aborted. Full log: $TestLogPath"
}
Remove-Item $TestLogPath -ErrorAction SilentlyContinue
Write-Info "smoke test passed"

# 7. Next steps.
Write-Host ""
Write-Host "[install] DONE" -ForegroundColor Green
Write-Host ""
Write-Host "Skill installed at: $InstallRoot"
Write-Host "Config:             $ConfigPath"
Write-Host "Identity:           $(Join-Path $InstallRoot 'identity.local.json')"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. In Claude Code, install a Gmail-capable plugin pack"
Write-Host "     (e.g. small-business or pipedream-gmail) and a Google-Calendar"
Write-Host "     plugin. Authenticate each via its slash command on first use."
Write-Host "  2. To run the routine: ask Claude 'run my morning brief' or invoke"
Write-Host "     the morning-mvp skill directly."
Write-Host "  3. Optional: configure Basecamp in $ConfigPath"
Write-Host "  4. Optional: edit your ~\CLAUDE.md (or $env:USERPROFILE\.claude\CLAUDE.md)"
Write-Host "     to refine name / role / hard rules, then re-run"
Write-Host "     ``cd $InstallRoot && node scripts\identity-resolver.mjs`` to refresh."
Write-Host ""
