#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  QA Automation Dashboard — macOS Setup Script
#  NETGEAR Insight · Next Gear Unleashed 2026
#
#  Requirements: macOS 13+ (Ventura or later)
#  Run: chmod +x setup.sh && ./setup.sh
#
#  ⚠️  Ubuntu & Windows support — coming soon!
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

# ── Colour helpers ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}ℹ  $1${RESET}"; }
ok()      { echo -e "${GREEN}✓  $1${RESET}"; }
warn()    { echo -e "${YELLOW}⚠  $1${RESET}"; }
fail()    { echo -e "${RED}✗  $1${RESET}"; exit 1; }
section() { echo -e "\n${BOLD}━━━ $1 ━━━${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${BOLD}"
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║    QA Automation Dashboard — Setup                ║"
echo "  ║    NETGEAR Insight · Next Gear Unleashed 2026     ║"
echo "  ║    macOS · Playwright 1.58 · Node.js 20+          ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo -e "${RESET}"

# ── Guard: macOS only ──
if [[ "$(uname)" != "Darwin" ]]; then
  warn "This script targets macOS. Ubuntu & Windows support coming soon."
  warn "For Linux/Windows, install Node 20, run 'npm install', then"
  warn "'npx playwright install chromium' manually."
  exit 1
fi

# ─────────────────────────────────────────────────────────
section "1 / 6  Homebrew"
# ─────────────────────────────────────────────────────────
if command -v brew &>/dev/null; then
  ok "Homebrew already installed ($(brew --version | head -1))"
else
  info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Apple Silicon path fixup
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
  fi
  ok "Homebrew installed"
fi

# ─────────────────────────────────────────────────────────
section "2 / 6  Node.js 20 LTS"
# ─────────────────────────────────────────────────────────
NODE_MAJOR=0
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
fi

if [[ "$NODE_MAJOR" -ge 20 ]]; then
  ok "Node.js $(node -v) already installed"
else
  info "Installing Node.js 20 LTS via Homebrew..."
  brew install node@20 || brew upgrade node@20 || true
  # Ensure the formula is on PATH (Homebrew marks node@20 as keg-only)
  NODE_BIN="$(brew --prefix node@20)/bin"
  export PATH="$NODE_BIN:$PATH"
  if ! grep -q "node@20" "$HOME/.zshrc" 2>/dev/null; then
    echo "export PATH=\"$NODE_BIN:\$PATH\"" >> "$HOME/.zshrc"
    info "Added Node.js 20 to ~/.zshrc PATH"
  fi
  ok "Node.js $(node -v) installed"
fi

if ! command -v npm &>/dev/null; then
  fail "npm not found after Node.js install. Please restart your shell and re-run setup.sh"
fi
ok "npm $(npm -v)"

# ─────────────────────────────────────────────────────────
section "3 / 6  Project npm dependencies"
# ─────────────────────────────────────────────────────────
info "Running 'npm install' in project root..."
npm install
ok "Root dependencies installed"

# ─────────────────────────────────────────────────────────
section "4 / 6  Playwright Chromium browser"
# ─────────────────────────────────────────────────────────
info "Installing Playwright-managed Chromium binary..."
npx playwright install chromium
ok "Chromium installed (version pinned by @playwright/test)"

# ─────────────────────────────────────────────────────────
section "5 / 6  Account Navigator dependencies"
# ─────────────────────────────────────────────────────────
ANV_DIR="$SCRIPT_DIR/tools/account-navigator"
if [[ -d "$ANV_DIR" ]]; then
  info "Installing account-navigator npm dependencies..."
  (cd "$ANV_DIR" && npm install)
  ok "Account Navigator dependencies installed"
else
  warn "tools/account-navigator not found — skipping (optional component)"
fi

# ─────────────────────────────────────────────────────────
section "6 / 6  Directory scaffolding"
# ─────────────────────────────────────────────────────────
mkdir -p .auth
mkdir -p test-results/evidence
mkdir -p dashboard/history
ok ".auth/, test-results/evidence/, dashboard/history/ created"

# ─────────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}"
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║   Setup complete! Ready to run.                  ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo -e "${RESET}"

echo -e "${BOLD}Quick start:${RESET}"
echo ""
echo "  1. Start the dashboard server:"
echo "     ${CYAN}node dashboard/server.js${RESET}"
echo ""
echo "  2. Open the dashboard in your browser:"
echo "     ${CYAN}open http://localhost:9324${RESET}"
echo ""
echo "  3. Open the presentation:"
echo "     ${CYAN}open http://localhost:9324/presentation.html${RESET}"
echo ""
echo "  4. Click ▶ Run Tests — 10 TCs across 2 environments,"
echo "     2 Playwright workers running in parallel."
echo ""
echo -e "${YELLOW}Note:${RESET} On first run, the browser will open a NETGEAR login page."
echo "If you see a CAPTCHA on a mail provider page, wait for it to clear or the flow will try a fallback inbox."
echo ""
echo -e "${YELLOW}⚠️  Ubuntu & Windows support — coming soon!${RESET}"
echo ""
