# Cursor hooks

Optional **hook scripts** and **state** used by Cursor automation (for example continual-learning or custom workflows).

| Path | Role |
|------|------|
| **`state/`** | JSON state files created by hooks — safe to delete if you reset local hook history; not used by the Playwright dashboard. |

Hooks are **not** required to run **`node dashboard/server.js`** or the **`NTGR-Insight_QA`** MCP.
