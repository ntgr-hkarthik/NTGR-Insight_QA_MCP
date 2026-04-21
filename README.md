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

- **macOS** (Ventura or later) for the provided `setup.sh` bootstrap. On Linux or Windows, install **Node.js 20+** and **Playwright Chromium** yourself, then follow the same `npm install` steps below.
- **Network**: Staging Insight hosts and QA Mongo endpoints may require **VPN** or internal access — expected for a NETGEAR QA toolchain.
- **Secrets**: Do not commit API keys or passwords. Use local config or environment variables as described in the MCP README.

---

## Quick start

From the repository root:

```bash
chmod +x setup.sh && ./setup.sh   # macOS only — installs Node, Chromium, dependencies
npm install
cd tools/account-navigator && npm install && cd ../..
npx playwright install chromium
node dashboard/server.js
```

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

**macOS** is the primary tested platform for `setup.sh`. Linux and Windows users should install Node 20+, run `npm install` in the root and in `tools/account-navigator`, run `npx playwright install chromium`, then start the dashboard manually.
