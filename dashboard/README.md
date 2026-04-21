# Dashboard

Single Node process that serves the **QA control UI**, **WebSocket live updates**, and mounts the **Account Navigator** under `/navigator/`.

## What lives here

| File / folder | Role |
|----------------|------|
| `server.js` | HTTP API (run/stop tests, history, evidence), WebSocket push, spawns Playwright |
| `index.html` | Main dashboard shell |
| `presentation.html` | Hackathon overview / demo page (`/presentation.html`) |
| `reporter.js` | Custom Playwright reporter → writes `status.json` for the UI |
| `env-manager.js` | Shared client helpers for Insight environment lists |
| `status.json` | Live run state (rewritten while tests run) |
| `qa-mongo-db-history.json` | Append-only log of QA Mongo actions from the navigator |
| `history/` | Archived per-run JSON snapshots |

## Run

From the repository root:

```bash
node dashboard/server.js
```

Default URL: **http://localhost:9324** (override with `DASHBOARD_PORT`).

## See also

- Repository root **`README.md`** — full quick start  
- **`MCP.md`** — HTTP routes and architecture  
