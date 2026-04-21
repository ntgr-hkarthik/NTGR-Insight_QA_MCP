## Learned User Preferences

- Keep changes scoped to this hackathon repo tree; do not edit a sibling or separate `playwright` project unless explicitly requested.
- When using MCP for account creation, use Cursor **AskQuestion** before `insight_qa_nav_accounts_create` so the user chooses all-defaults vs custom; for custom, surface the full configuration (defaults + field list) before calling create.
- For `dashboard/presentation.html`, prefer full-width layout, logo before the “QA Automation Dashboard” title on the left, and a cleanly aligned top navigation bar.

## Learned Workspace Facts

- The Insight QA Workbench MCP registers as **NTGR-Insight_QA**; code lives under `mcps/NTGR-Insight_QA/` (`index.js`, `README.md`, `cursor-mcp.example.json`).
- Running `node dashboard/server.js` serves the workbench; Navigator UI is at `/navigator/`; the pitch deck is `dashboard/presentation.html`. MCP is a stdio process in the IDE—it does not execute inside that static HTML page.
- Account automation is implemented at `POST /api/accounts` in `tools/account-navigator/server.js`; MCP tools include `insight_qa_nav_accounts_create` and `insight_qa_nav_account_defaults` (defaults, mandatory AskQuestion spec, and payload field reference).
- **AskQuestion** is for AI assistants in Cursor on the account-create path; browser Navigator users use normal forms, and other MCP tools (e.g. tests, health) do not imply AskQuestion by themselves.
- Hackathon submission should be the **full repository root** (e.g. `dashboard/`, `tools/account-navigator/`, `mcps/`, `tests/`, Playwright config, `setup.sh`) so judges can run the dashboard and wire MCP—not the MCP subfolder alone.
