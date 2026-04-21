# Account Navigator

Embedded **Express** application for NETGEAR Insight **staging** workflows: disposable-email signup, onboarding, device registration, Stripe checkout preview, and QA Mongo utilities (grace / expired / active transitions when your network allows).

## How it runs

The dashboard **`dashboard/server.js`** `require()`s this app and mounts it at **`/navigator/`**. You do **not** start a separate process for the navigator when using the standard flow — start the dashboard from the repo root:

```bash
node dashboard/server.js
```

Then open **http://localhost:9324/navigator/**

## Layout

| Area | Purpose |
|------|---------|
| `server.js` | Routes: `/api/accounts`, Stripe preview, Mongo gates, env resolution |
| `public/` | Static UI (HTML, Tailwind, `env-manager.js`) |
| `acc-purchase.js`, `stripe-checkout-preview.js`, … | Checkout and purchase automation helpers |
| `insight-env.js` | Insight environment routing |

## Setup

```bash
cd tools/account-navigator && npm install
```

## API surface

HTTP contracts and how the **NTGR-Insight_QA** MCP forwards to these routes are documented in **`MCP.md`** and **`mcps/NTGR-Insight_QA/README.md`**.
