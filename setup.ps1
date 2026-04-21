# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  QA Automation Dashboard — Windows Setup (PowerShell)
#  NETGEAR Insight · Next Gear Unleashed 2026
#
#  Supported: Windows 10 / 11 (PowerShell 5.1+ or pwsh 7+)
#  Run:
#    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#    .\setup.ps1
#
#  Installs Node.js 20 LTS via winget / choco / nvm-windows if missing,
#  then runs the common npm install / Playwright / scaffolding steps.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

$ErrorActionPreference = "Stop"

function Section($t) { Write-Host "`n━━━ $t ━━━" -ForegroundColor Cyan }
function Ok($t)      { Write-Host "✓  $t" -ForegroundColor Green }
function Info($t)    { Write-Host "ℹ  $t" -ForegroundColor Cyan }
function Warn($t)    { Write-Host "⚠  $t" -ForegroundColor Yellow }
function Fail($t)    { Write-Host "✗  $t" -ForegroundColor Red; exit 1 }
function Have($c)    { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "  ╔═══════════════════════════════════════════════════╗" -ForegroundColor White
Write-Host "  ║    QA Automation Dashboard — Setup (Windows)      ║" -ForegroundColor White
Write-Host "  ║    NETGEAR Insight · Next Gear Unleashed 2026     ║" -ForegroundColor White
Write-Host "  ╚═══════════════════════════════════════════════════╝" -ForegroundColor White

Section "1 / 6  Node.js 20"
$nodeOk = $false
if (Have "node") {
  $v = (node -v) -replace "v",""
  $maj = [int]($v.Split(".")[0])
  if ($maj -ge 20) { Ok "Node.js v$v already installed"; $nodeOk = $true }
}

if (-not $nodeOk) {
  if (Have "winget") {
    Info "Installing Node.js 20 LTS via winget..."
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
  } elseif (Have "choco") {
    Info "Installing Node.js 20 LTS via Chocolatey..."
    choco install nodejs-lts -y
  } elseif (Have "nvm") {
    Info "Installing Node.js 20 via nvm-windows..."
    nvm install 20
    nvm use 20
  } else {
    Fail @"
No Windows package manager (winget / choco / nvm) found.
Install one of:
  • winget   (built into Windows 11 / modern Windows 10)
  • choco    https://chocolatey.org/install
  • nvm-windows https://github.com/coreybutler/nvm-windows
Or install Node 20 LTS directly: https://nodejs.org/en/download
"@
  }
  # Refresh PATH in current session
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  if (-not (Have "node")) { Fail "Node not on PATH after install. Open a new PowerShell window and re-run." }
  Ok "Node.js $(node -v) installed"
}
if (-not (Have "npm")) { Fail "npm missing after Node install." }
Ok "npm $(npm -v)"

Section "2 / 6  Project npm dependencies"
Info "Running 'npm install' in project root..."
npm install
Ok "Root dependencies installed"

Section "3 / 6  Playwright Chromium browser"
Info "Installing Playwright-managed Chromium binary..."
npx playwright install chromium
Ok "Chromium installed"

Section "4 / 6  Account Navigator dependencies"
$anv = Join-Path $ScriptDir "tools\account-navigator"
if (Test-Path $anv) {
  Push-Location $anv
  npm install
  Pop-Location
  Ok "Account Navigator dependencies installed"
} else { Warn "tools/account-navigator not found — skipping" }

Section "5 / 6  MCP server dependencies (NTGR-Insight_QA)"
$mcp = Join-Path $ScriptDir "mcps\NTGR-Insight_QA"
if (Test-Path $mcp) {
  Push-Location $mcp
  npm install
  Pop-Location
  Ok "MCP server dependencies installed"
} else { Warn "mcps/NTGR-Insight_QA not found — skipping" }

Section "6 / 6  Directory scaffolding"
New-Item -ItemType Directory -Force -Path ".auth" | Out-Null
New-Item -ItemType Directory -Force -Path "test-results\evidence" | Out-Null
New-Item -ItemType Directory -Force -Path "dashboard\history" | Out-Null
Ok ".auth\, test-results\evidence\, dashboard\history\ created"

Write-Host ""
Write-Host "  ╔═══════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║   Setup complete! Ready to run.                   ║" -ForegroundColor Green
Write-Host "  ╚═══════════════════════════════════════════════════╝" -ForegroundColor Green

Write-Host ""
Write-Host "Quick start:" -ForegroundColor White
Write-Host "  1. node dashboard/server.js"
Write-Host "  2. start http://localhost:9324"
Write-Host "  3. start http://localhost:9324/presentation.html"
Write-Host "  4. Click Run Tests."
Write-Host ""
