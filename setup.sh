#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  QA Automation Dashboard — Cross-OS Setup Script
#  NETGEAR Insight · Next Gear Unleashed 2026
#
#  Supported: macOS 13+ · Ubuntu 20.04+ / Debian · Windows (Git Bash / WSL)
#  Run: chmod +x setup.sh && ./setup.sh
#
#  Detects OS, installs Node.js 20+ and npm if missing, then runs
#  the common `npm install` / Playwright Chromium / scaffolding steps.
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

# ── Detect OS ──
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
OS_KIND="unknown"
case "$UNAME_S" in
  Darwin*)                       OS_KIND="macos" ;;
  Linux*)
    if grep -qi microsoft /proc/version 2>/dev/null; then OS_KIND="wsl"; else OS_KIND="linux"; fi ;;
  MINGW*|MSYS*|CYGWIN*)          OS_KIND="windows" ;;
  *)                             OS_KIND="unknown" ;;
esac

echo -e "${BOLD}"
echo "  ╔═══════════════════════════════════════════════════╗"
echo "  ║    QA Automation Dashboard — Setup                ║"
echo "  ║    NETGEAR Insight · Next Gear Unleashed 2026     ║"
echo "  ║    macOS · Ubuntu · Windows · Node 20+            ║"
echo "  ╚═══════════════════════════════════════════════════╝"
echo -e "${RESET}"
info "Detected OS: ${OS_KIND} (${UNAME_S})"

have() { command -v "$1" &>/dev/null; }

# ─────────────────────────────────────────────────────────
section "1 / 6  Package manager + Node.js 20"
# ─────────────────────────────────────────────────────────

install_node_macos() {
  if ! have brew; then
    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [[ -f /opt/homebrew/bin/brew ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
      grep -q "brew shellenv" "$HOME/.zprofile" 2>/dev/null || \
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
    fi
    ok "Homebrew installed"
  else
    ok "Homebrew already installed ($(brew --version | head -1))"
  fi

  info "Installing Node.js 20 LTS via Homebrew..."
  brew install node@20 || brew upgrade node@20 || true
  NODE_BIN="$(brew --prefix node@20)/bin"
  export PATH="$NODE_BIN:$PATH"
  if ! grep -q "node@20" "$HOME/.zshrc" 2>/dev/null; then
    echo "export PATH=\"$NODE_BIN:\$PATH\"" >> "$HOME/.zshrc"
    info "Added Node.js 20 to ~/.zshrc PATH"
  fi
}

install_node_linux() {
  # Ubuntu / Debian. Use NodeSource repo for Node 20 LTS — official & works on WSL.
  if have apt-get; then
    info "Using apt-get + NodeSource (Node 20)..."
    SUDO=""; [[ $EUID -ne 0 ]] && SUDO="sudo"
    $SUDO apt-get update -y
    $SUDO apt-get install -y curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  elif have dnf; then
    info "Using dnf + NodeSource (Node 20)..."
    SUDO=""; [[ $EUID -ne 0 ]] && SUDO="sudo"
    curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
    $SUDO dnf install -y nodejs
  elif have pacman; then
    info "Using pacman..."
    SUDO=""; [[ $EUID -ne 0 ]] && SUDO="sudo"
    $SUDO pacman -Sy --noconfirm nodejs-lts-iron npm
  else
    fail "No supported Linux package manager (apt/dnf/pacman) found. Install Node 20 manually from https://nodejs.org and re-run."
  fi
}

install_node_windows() {
  # Git Bash / MSYS / Cygwin: prefer winget, then choco, then nvm-windows, else bail with instructions.
  if have winget; then
    info "Installing Node.js 20 LTS via winget..."
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements || \
      warn "winget install returned non-zero; verifying whether node is now on PATH..."
  elif have choco; then
    info "Installing Node.js 20 LTS via Chocolatey..."
    choco install nodejs-lts -y
  elif have nvm; then
    info "Installing Node.js 20 via nvm-windows..."
    nvm install 20
    nvm use 20
  else
    fail "No Windows package manager (winget / choco / nvm) found.
  Install one of the following and re-run:
    • winget   (built into Windows 11 / modern Windows 10)
    • choco    (https://chocolatey.org/install)
    • nvm-windows (https://github.com/coreybutler/nvm-windows)
  Or install Node 20 LTS directly: https://nodejs.org/en/download"
  fi
  # winget installs land under %ProgramFiles%\nodejs — make sure current shell sees it.
  if ! have node; then
    for P in "/c/Program Files/nodejs" "/c/Program Files (x86)/nodejs"; do
      [[ -d "$P" ]] && export PATH="$P:$PATH"
    done
  fi
}

NODE_MAJOR=0
if have node; then
  NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo 0)
fi

if [[ "$NODE_MAJOR" -ge 20 ]]; then
  ok "Node.js $(node -v) already installed"
else
  case "$OS_KIND" in
    macos)           install_node_macos ;;
    linux|wsl)       install_node_linux ;;
    windows)         install_node_windows ;;
    *)               fail "Unsupported OS: $UNAME_S. Install Node 20 LTS manually from https://nodejs.org and re-run." ;;
  esac
  have node || fail "Node.js not found after install. Restart your shell and re-run setup.sh"
  ok "Node.js $(node -v) installed"
fi

have npm || fail "npm not found after Node.js install. Restart your shell and re-run setup.sh"
ok "npm $(npm -v)"

# ─────────────────────────────────────────────────────────
section "2 / 6  Project npm dependencies"
# ─────────────────────────────────────────────────────────
info "Running 'npm install' in project root..."
npm install
ok "Root dependencies installed"

# ─────────────────────────────────────────────────────────
section "3 / 6  Playwright Chromium browser"
# ─────────────────────────────────────────────────────────
info "Installing Playwright-managed Chromium binary..."
if [[ "$OS_KIND" == "linux" || "$OS_KIND" == "wsl" ]]; then
  # Linux needs system libs; --with-deps pulls them.
  npx playwright install --with-deps chromium || npx playwright install chromium
else
  npx playwright install chromium
fi
ok "Chromium installed (version pinned by @playwright/test)"

# ─────────────────────────────────────────────────────────
section "4 / 6  Account Navigator dependencies"
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
section "5 / 6  MCP server dependencies (NTGR-Insight_QA)"
# ─────────────────────────────────────────────────────────
MCP_DIR="$SCRIPT_DIR/mcps/NTGR-Insight_QA"
if [[ -d "$MCP_DIR" ]]; then
  info "Installing NTGR-Insight_QA MCP dependencies..."
  (cd "$MCP_DIR" && npm install)
  ok "MCP server dependencies installed"
else
  warn "mcps/NTGR-Insight_QA not found — skipping (optional component)"
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

OPEN_CMD="open"
case "$OS_KIND" in
  linux|wsl) OPEN_CMD="xdg-open" ;;
  windows)   OPEN_CMD="start" ;;
esac

echo -e "${BOLD}Quick start:${RESET}"
echo ""
echo "  1. Start the dashboard server:"
echo "     ${CYAN}node dashboard/server.js${RESET}"
echo ""
echo "  2. Open the dashboard in your browser:"
echo "     ${CYAN}${OPEN_CMD} http://localhost:9324${RESET}"
echo ""
echo "  3. Open the presentation:"
echo "     ${CYAN}${OPEN_CMD} http://localhost:9324/presentation.html${RESET}"
echo ""
echo "  4. Click ▶ Run Tests — 10 TCs across 2 environments,"
echo "     2 Playwright workers running in parallel."
echo ""
echo -e "${YELLOW}Note:${RESET} On first run, the browser will open a NETGEAR login page."
echo "If you see a CAPTCHA on a mail provider page, wait for it to clear or the flow will try a fallback inbox."
echo ""
echo -e "${GREEN}Detected: ${OS_KIND}${RESET} — setup auto-handled OS-specific package install."
echo ""
