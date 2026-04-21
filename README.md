# NETGEAR Insight — QA Automation Workbench

A hackathon submission that bundles **Playwright end-to-end tests**, a **live dashboard** to run and monitor them, an embedded **Account Navigator** for staging signup and billing flows, and an optional **MCP server** so AI assistants in Cursor can call the same APIs as the UI.

---

## What’s in this project

| Piece | What it does |
|--------|----------------|
| **Dashboard** | Start runs, watch live logs and status, browse history — one place to drive the suite. |
| **Account Navigator** | Browser UI for test accounts: signup, onboarding, devices, Stripe checkout previews, QA Mongo helpers (where your network allows). |
| **Playwright** | Automated tests against Insight staging (e.g. Stripe subscription flows), configured in `playwright.stripe.config.ts`. |
| **NTGR-Insight_QA (MCP)** | Optional Model Context Protocol server so agents can trigger runs and navigator actions via HTTP — same backend as the dashboard. |

Technical architecture and API details are in **`MCP.md`**. MCP installation and tool list are in **`mcps/NTGR-Insight_QA/README.md`**.

Each major folder also has a short **`README.md`** describing what is inside (`dashboard/`, `tools/`, `tests/`, `scripts/`, `docs/`, `mcps/`, and nested paths where helpful).

---

## Requirements

- **OS**: `setup.sh` auto-detects your OS and installs Node.js 20+ for you — **macOS 13+**, **Ubuntu 20.04+ / Debian** (apt/dnf/pacman), and **Windows 10/11** (Git Bash or WSL). Windows users without Git Bash can run `setup.ps1` in PowerShell instead.
- **Network**: Staging Insight hosts and QA Mongo endpoints may require **VPN** or internal access — expected for a NETGEAR QA toolchain.
- **Secrets**: Do not commit API keys or passwords. Use local config or environment variables as described in the MCP README.

---

## Quick start

From the repository root:

```bash
# macOS / Linux / Windows-Git-Bash / WSL — auto-detects OS and installs Node 20 + deps
chmod +x setup.sh && ./setup.sh

# Windows PowerShell alternative:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#   .\setup.ps1

# Start dashboard
node dashboard/server.js
```

`setup.sh` handles the OS-specific package install: **Homebrew** on macOS, **apt/dnf/pacman** on Linux/WSL, **winget/choco/nvm-windows** on Windows. After Node 20 is ready it runs `npm install` in the root, `tools/account-navigator`, and `mcps/NTGR-Insight_QA`, then installs Playwright Chromium.

Then open:

| URL | Purpose |
|-----|---------|
| http://localhost:9324 | **Dashboard** — run tests and watch progress |
| http://localhost:9324/presentation.html | **Overview / demo narrative** (pitch-style page) |
| http://localhost:9324/navigator/ | **Account Navigator** |

The dashboard listens on port **9324** by default (`DASHBOARD_PORT` overrides it).

---

## Running tests

- **From the dashboard:** open the main UI and use the controls to start a run (see on-screen labels).
- **From the terminal** (examples):

  ```bash
  npx playwright test --config=playwright.stripe.config.ts
  ```

  Other scripts are defined in `package.json` (e.g. subscription or onboarding targets).

Reports and artifacts land under the usual Playwright paths (e.g. `test-results/`, `playwright-report/` depending on configuration).

---

## Optional: MCP (Cursor / AI assistants)

If you use **Cursor** or another MCP client, you can register the server **`NTGR-Insight_QA`** pointing at `mcps/NTGR-Insight_QA/index.js`. The MCP proxies to the **same** dashboard you run locally — start `node dashboard/server.js` first.

See **`mcps/NTGR-Insight_QA/cursor-mcp.example.json`** and **`mcps/NTGR-Insight_QA/README.md`** for registration, defaults, and behavior (including recommended prompts when creating accounts via an agent).

---

## CAPTCHA and email flows

Disposable email providers sometimes show challenges. Chrome is launched with automation-mitigation flags only; **no third-party CAPTCHA extension** is bundled. Tests may wait for the page to become usable or use fallback paths (see code and presentation notes).

---

## Platform note

`setup.sh` has been tested on **macOS 13+**, **Ubuntu 22.04 / Debian 12**, and **Windows 11 (Git Bash + WSL2)**. It detects the OS automatically and installs Node.js 20 via the native package manager (Homebrew / apt / dnf / pacman / winget / choco / nvm-windows). Windows users who prefer native PowerShell can run `setup.ps1`. If your distro is unsupported, install Node 20+ manually, then re-run `setup.sh` — it will skip the install step and proceed with `npm install` + Playwright Chromium.
