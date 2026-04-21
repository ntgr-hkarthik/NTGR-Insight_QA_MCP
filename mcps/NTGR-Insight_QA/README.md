<p align="center">
  <img src="assets/insight-logo.png" alt="NETGEAR Insight" height="56" />
</p>

# NTGR-Insight_QA (Insight QA Workbench MCP)

Stdio [Model Context Protocol](https://modelcontextprotocol.io/) server that registers as **`NTGR-Insight_QA`** and proxies HTTP to **one** running Insight QA dashboard (`node dashboard/server.js`). It is **not** a second dashboard UI and **not** a replacement for full Atlassian/Figma MCPs (this server only stores optional Jira/Figma credentials for `insight_qa_jira_verify` / `insight_qa_figma_verify`).

**Focus — Account Navigator & account creation:** the tools below cover disposable-mail signup, onboarding, saved accounts, devices, Stripe flows, and checkout preview. Everything else (Playwright run control, Mongo QA, interactive reporter, artifacts) is listed briefly at the end; use your client’s tool list or `mcps/NTGR-Insight_QA/index.js` for the full catalog.

---

## How agents surface defaults (MCP)

| Tool | When to use |
|------|-------------|
| **`insight_qa_nav_account_defaults`** | **Preferred** when you only need literal defaults, AskQuestion copy, purchase rules, and follow-on tool names. No dashboard URL / Jira / Figma prompts. |
| **`insight_qa_setup_wizard`** | Same **`accountCreationDefaults`** JSON as above **plus** checklist for `dashboardBaseUrl`, optional Jira, optional Figma, and `insight_qa_setup_set`. |

Both return a structured object including:

- **`mandatoryCursorAskQuestion`** — **required agent behavior:** use Cursor’s **`AskQuestion`** tool before **`insight_qa_nav_accounts_create`**. The user must explicitly pick **all defaults** vs **custom**; includes a ready-made **`step1AskQuestion`** block (title, question id, two options) you can paste into **`AskQuestion`**.
- **`payloadFieldsAll`** — every **`POST /api/accounts`** body field (name, type, default when omitted, notes), including the **`purchase`** object — use this when the user chooses **custom** so they see the full configuration surface.
- **`defaultsWhenOmitted`** — literal Navigator defaults (including **`DEFAULT_PW`** and mail.tm **`Password123!`**).
- **`askQuestionTemplates`** / **`customizeFieldOrder`** — backup copy for prompts and field order.
- **`purchaseWhenEnabled`** — `purchase.enabled` requires `addDevice`, plus default mapping for purchase subfields.
- **`relatedMcpToolsAfterCreate`** — follow-on Navigator tools after a row exists.

**Do not** call **`insight_qa_nav_accounts_create`** until **`AskQuestion`** (or equivalent explicit user confirmation in chat) has recorded default vs custom. Do not invent a **`prefix`** without the user providing or confirming it.

Implementation lives in **`playwright_hackathon/tools/account-navigator/server.js`** at **`POST /api/accounts`**. **`insight_qa_nav_accounts_create`** forwards `arguments.payload` as the JSON body to that route.

---

## Account creation & related Navigator tools

| Tool | Purpose |
|------|---------|
| `insight_qa_nav_accounts_create` | End-to-end create (see **`mandatoryCursorAskQuestion`** — **AskQuestion first**). |
| `insight_qa_nav_account_defaults` | Read-only: **AskQuestion** spec, **`payloadFieldsAll`**, defaults, purchase rules. |
| `insight_qa_nav_accounts_list` | GET saved accounts. |
| `insight_qa_nav_accounts_delete` | DELETE row by index. |
| `insight_qa_nav_accounts_bulk` | POST bulk text/import. |
| `insight_qa_nav_accounts_tag` | PUT tag on a row. |
| `insight_qa_nav_launch` | Open Chromium and log in as a saved email (`insightEnv` optional). |
| `insight_qa_nav_cancel` | Close Navigator browser. |
| `insight_qa_nav_add_devices` | HB/NHB device add on current session (after launch). |
| `insight_qa_nav_acc_purchase` | Stripe hosted checkout on current page. |
| `insight_qa_nav_stripe_preview_matrix` | Country/matrix metadata. |
| `insight_qa_nav_stripe_preview_state` | Preview runner state. |
| `insight_qa_nav_stripe_preview_history` | Past preview runs. |
| `insight_qa_nav_stripe_preview_run` | Start a preview run (POST body in `payload`). |
| `insight_qa_nav_stripe_default_address` | Default address row for an ISO2 country. |

**Minimal create call (all Navigator defaults except a unique mailbox prefix):**

```json
{
  "payload": { "prefix": "yourUniquePrefix123" }
}
```

Optional: add **`insightEnv`** (e.g. `maint-beta`) to the same payload. For every other field, read **`insight_qa_nav_account_defaults`** and quote the literals back to the user before running if they asked for transparency.

**AskQuestion pattern (required):**

1. Call **`insight_qa_nav_account_defaults`** (or **`insight_qa_setup_wizard`** if config is also being set).
2. **Run Cursor `AskQuestion`** using **`mandatoryCursorAskQuestion.step1AskQuestion`** (or equivalent): user chooses **all defaults** vs **custom**.
3. If **all defaults** → **`AskQuestion`** or chat for unique **`prefix`** (required) and optional **`insightEnv`**; then create.
4. If **custom** → show **`payloadFieldsAll`** and **`defaultsWhenOmitted`** (and **`purchaseWhenEnabled`**); collect values; build `payload`; then create.
5. Call **`insight_qa_nav_accounts_create`** only after steps 2–4. Then list / launch / devices / purchase as needed.

---

## Setup & third-party verify (no Playwright run required)

| Tool | Purpose |
|------|---------|
| `insight_qa_setup_wizard` | Human checklist + full **`accountCreationDefaults`**. |
| `insight_qa_setup_get` | Current config (tokens redacted). |
| `insight_qa_setup_set` | Save `dashboardBaseUrl`, optional Jira, optional Figma. |
| `insight_qa_setup_clear` | Clear saved sections. |
| `insight_qa_jira_verify` | `GET /rest/api/3/myself`. |
| `insight_qa_figma_verify` | `GET https://api.figma.com/v1/me`. |

Config file default: `~/.insight-qa-workbench-mcp/config.json` (legacy directory name; keeps existing installs working). Override with **`INSIGHT_QA_MCP_CONFIG_FILE`**. Fallback dashboard URL: **`INSIGHT_QA_BASE_URL`**, else `http://127.0.0.1:9323`.

---

## Other tools (short index)

**Dashboard / Playwright (needs `node dashboard/server.js`):** `insight_qa_health`, `insight_qa_tests_run`, `insight_qa_tests_kill`, `insight_qa_tests_runner_status`, `insight_qa_tests_suites`, `insight_qa_env_resolve`, `insight_qa_dpro_status`, `insight_qa_dpro_snapshot`

**QA Mongo (via dashboard; VPN/server rules apply):** `insight_qa_subscription_state_change`, `insight_qa_mongo_db_history`

**Interactive reporter:** `insight_qa_interactive_init`, `insight_qa_interactive_begin`, `insight_qa_interactive_step`, `insight_qa_interactive_screenshot`, `insight_qa_interactive_end`, `insight_qa_interactive_finish`

**Artifacts (read-only, whitelisted paths, size cap):** `insight_qa_fetch_path`

---

## Prerequisites & install

1. **Node 18+** (global `fetch`).
2. **Dashboard running:** `node dashboard/server.js` from this repo (Navigator is mounted by that process).
3. Install MCP deps: `cd mcps/NTGR-Insight_QA && npm install`.

See **`cursor-mcp.example.json`**, project **`.cursor/mcp.json`**, or user-level MCP settings; point `args` at this **`index.js`**.

---

## Typical agent flow

1. **`insight_qa_nav_account_defaults`** — read **`mandatoryCursorAskQuestion`** + **`payloadFieldsAll`**.
2. **Cursor `AskQuestion`** — default vs custom; then prefix (and optional fields if custom).
3. **`insight_qa_health`** — dashboard reachable (after **`insight_qa_setup_set`** if needed).
4. **`insight_qa_nav_accounts_create`** — only after step 2.
5. **`insight_qa_nav_launch`** / **`insight_qa_nav_add_devices`** / **`insight_qa_nav_acc_purchase`** as needed; **`insight_qa_nav_cancel`** when finished.

---

## Debug

```bash
npm run inspector
```

---

## Security notes

- Jira/Figma tokens and dashboard URL live in the local JSON config (plaintext). Restrict file permissions.
- **`insight_qa_fetch_path`** only allows specific path prefixes and caps response size.
- NETGEAR **`DEFAULT_PW`** and mail.tm **`Password123!`** are QA defaults exposed for automation transparency; do not paste into public channels.

---

## FAQ: Does every user who installs this MCP get AskQuestion?

**No.** **AskQuestion** is a **Cursor chat** feature. It is used when an **AI assistant** follows **`mandatoryCursorAskQuestion`** for **account creation** so the user picks default vs custom before **`insight_qa_nav_accounts_create`**.

- **Browser:** using Account Navigator at **`/navigator/`** does not involve AskQuestion.
- **Other MCP tools** (tests, health, Jira verify): no AskQuestion unless the assistant is also driving account create in the same session.

The dashboard **`presentation.html`** (section **Insight MCP**) explains that static HTML cannot run MCP; it documents repo layout and this distinction for hackathon reviewers.
