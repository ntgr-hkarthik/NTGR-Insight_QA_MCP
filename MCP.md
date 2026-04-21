# NETGEAR Insight · QA Automation Workbench — MCP spec

Source-of-truth architecture + dependency + API doc for the
`playwright_hackathon` toolchain. Written as a spec for exposing the
whole thing as an **MCP (Model Context Protocol) server** so LLM agents
can drive Insight QA flows end-to-end.

---

## 1. Repository layout

```
playwright_hackathon/
├── dashboard/                    HTTP + WebSocket dashboard (port 9324)
│   ├── server.js                 Node http server, process manager, run history
│   ├── index.html                UI shell (Tailwind via CDN + custom CSS)
│   ├── presentation.html         Pitch / overview page (/presentation.html)
│   ├── reporter.js               Playwright reporter → dashboard/status.json
│   ├── env-manager.js            Shared client-side Insight env add/remove
│   ├── status.json               Live run state, rewritten per test event
│   ├── qa-mongo-db-history.json  Append-only Mongo change log
│   └── history/                  Per-run archive (JSON)
│
├── tools/
│   └── account-navigator/        Embedded mini-app (mounted at /navigator/)
│       ├── server.js             Express app: signup, onboarding, device add,
│       │                         Stripe orchestration, QA Mongo endpoints,
│       │                         env-resolve + Mongo unlock gate
│       ├── acc-purchase.js       Stripe hosted checkout automation
│       ├── stripe-checkout-preview.js   Multi-country preview matrix
│       ├── insight-env.js        Env routing helpers
│       └── public/               UI (Tailwind + env-manager.js + modals)
│
├── scripts/
│   ├── db-subscription-grace-expired.js   Grace / Expired / Active Mongo writer
│   └── qa-mongo-history.js       Append-only change log reader/writer
│
├── mcps/
│   ├── NTGR-Insight_QA/          Insight QA Workbench MCP (stdio; MCP server name NTGR-Insight_QA)
│   └── custom-mongodb/node_modules/mongodb   Bundled driver (symlinked from sibling repo)
│
├── tests/stripe-subs/            Playwright specs (Stripe migration, demo, drop5)
├── extensions/                   Chrome extensions auto-loaded by Playwright
│                                 (NopeCHA for CAPTCHA, optional UBlock)
├── countryList.json              Country + currency matrix used across UIs
├── nhb_prefixes.csv              Valid NETGEAR Hard Bundle device prefixes
├── playwright.stripe.config.ts   Playwright config (projects: demo, drop5-*…)
├── setup.sh                      macOS bootstrap (node, deps, perms)
└── docs/                         Additional markdown references
```

---

## 2. Runtime components

| Component | Port / Mount | What it does |
|---|---|---|
| **Dashboard** | `http://localhost:9324` | Live status of Playwright runs, Stripe preview controls, kill button, history viewer, WebSocket push |
| **Account Navigator** | `http://localhost:9324/navigator/` | Mail.tm signup, onboarding, device add, purchase orchestration, Mongo controls (Grace/Expired/Active), Stripe checkout preview |
| **Playwright runner** | spawned by dashboard | `npx playwright test --config=playwright.stripe.config.ts …` child process; stdout piped into dashboard log |
| **Bundled Mongo driver** | `mcps/custom-mongodb/node_modules/mongodb` | Local copy to avoid a global install; symlinked from sibling `playwright/` repo |
| **WebSocket** | `ws://localhost:9324` | Server pushes `status`, `history`, `killed` events to every connected tab |

Process model: everything runs inside **one Node process** (`dashboard/server.js`). It `require()`s the navigator's Express app and mounts it on `/navigator/…`. There is no separate navigator process. Playwright is the only child process the dashboard spawns.

---

## 3. External dependencies

### npm (declared in `package.json`)

| Package | Purpose |
|---|---|
| `@playwright/test` | Test runner / browser automation |
| `playwright-extra` + `puppeteer-extra-plugin-stealth` | Stealth evasion for Stripe / Cloudflare |
| `express` | Navigator HTTP server |
| `ws` | Dashboard WebSocket push |
| `chokidar` | File watchers (status.json, history dir) |
| `dotenv` | Optional `.env` loader |
| `browser-sync` | Live-reload static HTML (unrelated to dashboard) |
| `allure-playwright` | Alternate report format |
| `easy-yopmail` | Legacy Yopmail polling (we use mail.tm instead — keep for fallback) |
| `telegraf` | Telegram bot (optional notifier) |

### Bundled but not in npm

| Path | Purpose |
|---|---|
| `mcps/custom-mongodb/node_modules/mongodb` | MongoDB driver (`require('mongodb')`) — referenced by `scripts/db-subscription-grace-expired.js` |
| `extensions/nopecha/` | CAPTCHA-solving Chrome extension loaded via `--load-extension` |

### External services (hit over the network)

| Service | Purpose |
|---|---|
| `auth-stg.netgear.com` | OC auth signup + login flow |
| `accounts2-stg.netgear.com` | Legacy auth still used by billing-stg |
| `pri-qa.insight.netgear.com` · `maint-beta.insight.netgear.com` · `maint-qa.insight.netgear.com` · `insight.netgear.com` | Insight portal targets |
| `api.mail.tm` | CAPTCHA-free disposable email for fresh accounts |
| `checkout.stripe.com` / `billing.stripe.com` | Stripe hosted checkout + billing portal |
| `mongodb02-qa-pri.netgearcloud.com` · `mongodb02-dev-maint.netgearcloud.com` | Insight Mongo clusters (require VPN) |

---

## 4. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DASHBOARD_PORT` | `9324` | HTTP/WS port of the dashboard |
| `NAVIGATOR_INSIGHT_ENV` | `pri-qa` | Navigator's default portal when localStorage has no preference |
| `BASE_URL` | `https://pri-qa.insight.netgear.com` | Base Insight URL passed to Playwright children |
| `MASTER_MONGO_PASSWORD` | `Netgear123!` | Master password for the Mongo unlock modal |
| `MONGO_URI` | — | Global Mongo URI override for grace/expiry script |
| `MONGO_URI_<SLUG>` | — | Per-env URI; slug uppercased, `-` → `_` (e.g. `MONGO_URI_MAINT_BETA`) |
| `MONGO_PASSWORD_<SLUG>` | — | Password substituted into the template URI for the matching env |
| `MONGO_DB_NAME` | `insight_cloud_4_0` | Database name |
| `DASHBOARD_STATUS_FILE` | `dashboard/status.json` | Override where the reporter writes |
| `EVIDENCE_DIR` | `test-results/evidence` | Where test screenshots land (served at `/evidence/`) |

None of the Mongo credentials are ever persisted. The master password lives
only in `process.env` of the running dashboard; stopping the server erases it.

---

## 5. HTTP API surface (MCP candidates)

Every route below is a candidate for one MCP tool. Grouped by concern.

### Run control — dashboard
- `POST /api/run` — `{suite?, config?, project?, failedOnly?, env?, grep?}` → spawn Playwright child
- `POST /api/kill` — terminate child, patch `status.json` with `aborted` + `endTime`, broadcast `{type:'killed'}`
- `GET  /api/runner-status` — `{running, pid}`
- `GET  /api/suites` — legacy suite keys

### Live status (push)
- `WS /` — server pushes `{type:'status'|'history'|'historyDetail'|'killed', …}` on every change

### Artifacts
- `GET /evidence/<file>` — screenshots/videos under `test-results/evidence/`
- `GET /artifacts/<relPath>` — arbitrary run artifacts resolved under repo root
- `GET /report/<file>` — Playwright HTML report
- `GET /history/<file>` — archived run JSON

### Environment management
- `GET  /api/env/resolve?env=<slug>` → `{key, url}`
  `"prod"` → `https://insight.netgear.com`; otherwise → `https://<slug>.insight.netgear.com`

### Account Navigator — account lifecycle
- `GET  /navigator/api/accounts` — saved mail.tm / auth-stg accounts
- `POST /navigator/api/accounts` — upsert account row
- `POST /navigator/api/launch` — open Chromium via Playwright, log the account into the selected portal
- `POST /navigator/api/cancel` — close the Chromium window
- `POST /navigator/api/add-devices` — bulk CSV device add (HB/NHB)
- `POST /navigator/api/acc-purchase` — run Stripe hosted checkout for a logged-in account
- `GET  /navigator/api/stripe-checkout-preview/*` — country-matrix preview runs + history

### QA Mongo controls
- `POST /navigator/api/mongo/unlock` — `{env, password}` → per-env unlock (memory-only)
- `POST /navigator/api/mongo/unlock-all` — `{password, envs?}` → master unlock with `MASTER_MONGO_PASSWORD`
- `POST /navigator/api/mongo/lock` — `{env}` → re-lock
- `GET  /navigator/api/mongo/unlock-status` — `{unlocked: [...]}`
- `POST /navigator/api/qa/subscription-grace-expired` — `{email, mode:'grace'|'expired'|'active', insightEnv, step?, dryRun?, bypassValidation?}` → writes `licenseKeyInfo` + device docs. **Gated**: requires matching env to be unlocked.
- `GET  /navigator/api/qa/mongo-db-history?insightEnv=<slug>` — filtered change log

### DirectPro / CSV helpers (legacy)
- `GET  /api/dpro-status` — DirectPro purchase status snapshot
- Misc read-only helpers for Stripe preview history + intl-tax runs

---

## 6. Mongo unlock gating (security)

All `POST /navigator/api/qa/subscription-grace-expired` requests pass
through a gate:

```
unlockedMongoEnvs: Set<envSlug>   ← empty at startup
```

Membership is added only by successful unlock calls. The gate returns
`{ok:false, code:'MONGO_LOCKED', insightEnv}` otherwise; the client
opens the unlock modal (password + 👁 visibility toggle) and retries.

Two unlock paths:

1. **Master** (`POST /api/mongo/unlock-all`) — compares against
   `MASTER_MONGO_PASSWORD` (default `Netgear123!`). On match, adds the
   four defaults (`pri-qa`, `maint-beta`, `maint-qa`, `prod`) + any
   client-submitted custom slugs to the set.
2. **Per-env** (`POST /api/mongo/unlock`) — stores the provided
   password into `process.env.MONGO_PASSWORD_<SLUG>` and adds that env
   to the set. Only needed if the master path is disabled.

Shutting down the dashboard wipes the set. There is no disk persistence.

---

## 7. Playwright projects

Defined in `playwright.stripe.config.ts`:

| Project | What it covers |
|---|---|
| `hackathon-demo` / `hackathon-3yr` | Fresh-account end-to-end purchase flow (demo) |
| `demo` / `demo2` | Ad-hoc smoke specs |
| `drop5-release` / `drop5-1yr` / `drop5-3yr` | Drop5 regression |
| `zephyr-ai-hk` | Zephyr-AI linked cases (subset) |
| `explore-dpro` | DirectPro exploration |

All projects load the **stealth plugin** and the **NopeCHA** Chrome extension so Stripe/Cloudflare do not block automation.

---

## 8. Quick start

```bash
# one-time
./setup.sh                       # installs node/npm, playwright browsers, deps

# daily use
node dashboard/server.js         # http://localhost:9324
# (optional) open a browser and log into an account via /navigator/

# run a suite from the dashboard ▶ Launch
# or from CLI:
BASE_URL=https://maint-beta.insight.netgear.com \
  npx playwright test --config=playwright.stripe.config.ts --project=hackathon-demo
```

Mongo work:
1. Open `/navigator/` → expand **QA — Mongo: Grace / Expired / Active**
2. Pick **Mongo env**, click **🔒 Unlock Mongo**, enter `Netgear123!` (or your override)
3. Enter an account email → **Move to Grace / Expired / Active**
4. Change history shows up in the table below; filtered by env

---

## 9. MCP-ification plan

Map from HTTP endpoints above to MCP tools:

| MCP tool name | Backing endpoint | Inputs | Outputs |
|---|---|---|---|
| `tests.run` | `POST /api/run` | `{config, project?, grep?, env?}` | `{pid}` |
| `tests.kill` | `POST /api/kill` | — | `{ok, killed}` |
| `tests.status` | `GET /api/runner-status` | — | `{running, pid}` |
| `tests.live_status` | WS subscription | filter | streamed `status` events |
| `tests.history.list` | FS `dashboard/history/` | `{limit}` | `[{file, startTime, summary}]` |
| `tests.history.detail` | FS / WS `getHistoryDetail` | `{file}` | full run JSON |
| `env.resolve` | `GET /api/env/resolve` | `{env}` | `{key, url}` |
| `nav.account.list` | `GET /api/accounts` | — | `[{email, tag, insightEnv…}]` |
| `nav.account.launch` | `POST /api/launch` | `{email, insightEnv}` | `{ok, url}` |
| `nav.signup` | `POST /api/accounts/create-flow` | `{…}` | `{email, status}` |
| `nav.devices.add` | `POST /api/add-devices` | CSV / list | `{added, errors}` |
| `nav.purchase` | `POST /api/acc-purchase` | `{email, plan, card, country}` | `{invoice}` |
| `nav.stripe.preview` | `POST /api/stripe-checkout-preview` | `{countries, plan}` | `{runDir, rows}` |
| `qa.mongo.unlock_all` | `POST /api/mongo/unlock-all` | `{password, envs?}` | `{unlocked[]}` |
| `qa.mongo.unlock` | `POST /api/mongo/unlock` | `{env, password}` | `{ok}` |
| `qa.mongo.lock` | `POST /api/mongo/lock` | `{env}` | `{ok}` |
| `qa.mongo.status` | `GET /api/mongo/unlock-status` | — | `{unlocked[]}` |
| `qa.subscription.move` | `POST /api/qa/subscription-grace-expired` | `{email, mode, insightEnv, step?, dryRun?}` | `{ok, statusFrom, statusTo, rowsAffected}` |
| `qa.subscription.history` | `GET /api/qa/mongo-db-history` | `{insightEnv?}` | `[{at, email, statusFrom, statusTo, scope, mode}]` |
| `artifact.read` | `GET /artifacts/<path>` | `{path}` | file bytes |
| `artifact.evidence_list` | FS `test-results/evidence/` | — | `[filename]` |
| `dpro.status` | `GET /api/dpro-status` | — | `{…}` |

### Remaining work for MCP server
1. Wrap each endpoint with a typed MCP tool schema (Zod/JSON Schema).
2. Run the existing Express app inside the MCP process; route all tool calls to it via an in-process HTTP client so we don't spin up a second server.
3. Stream WebSocket events as MCP `notifications` (live status, killed, history updates).
4. Publish a single-binary npm package `@netgear/ntgr-insight-qa-mcp` (MCP server name **NTGR-Insight_QA**) that bundles the dashboard server + MCP stdio transport.

---

## 10. Known constraints

- **No credentials on disk.** Mongo passwords must be entered each server start.
- **macOS-first.** `setup.sh` targets macOS 13+. Windows/Linux scripts not yet written.
- **VPN required** for any Mongo call (internal hosts).
- **Stripe test mode.** All purchase flows use Stripe test cards / sandboxes.
- **Account navigator is freeze-guarded.** `tools/account-navigator/BACKUP_POLICY.txt` requires a backup before editing `server.js`. Automation-driven changes should prefer `tests/helpers/*` or spec files where possible.

---

## 11. Alignment with sibling `playwright/` repo

This repo intentionally stays demo-focused (Hackathon Demo suite, simple dashboard controls). The sibling `playwright/` repo carries the broader suite matrix (NTGR, Zephyr-AI, ST-Functional, Single-Tier, IM10 …). Shared artifacts kept byte-for-byte in sync:

- `dashboard/env-manager.js`
- `docs/UI-STYLE.md`
- `scripts/db-subscription-grace-expired.js` + `qa-mongo-history.js`
- `mcps/custom-mongodb/node_modules/mongodb` — symlinked from `playwright/` to avoid a duplicate install.

Keep them in lock-step until the code moves into an `@netgear/insight-qa` workspace that publishes both a CLI and the MCP server.
