#!/usr/bin/env node
/**
 * Insight QA Workbench MCP — stdio server that proxies to one dashboard
 * + Account Navigator HTTP API (dashboard/server.js).
 *
 * Setup: ask the human for values, then call `insight_qa_setup_set` (or use
 * env INSIGHT_QA_BASE_URL / INSIGHT_QA_MCP_CONFIG_FILE). Only one dashboard
 * base URL is active at a time (last saved value wins over defaults).
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const {
  getConfigPath,
  getDashboardBaseUrl,
  redactedView,
  mergeAndSave,
  clearSections,
  getJiraAuth,
  getFigmaToken,
} = require('./config-store.js');

const ALLOWED_GET_PREFIXES = ['/evidence/', '/artifacts/', '/history/', '/report/', '/setup.sh', '/README.md'];

async function dashboardFetch(path, init = {}) {
  const base = getDashboardBaseUrl();
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = { ...(init.headers || {}) };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (ct.includes('application/json') || ct.includes('text/')) {
    const text = buf.toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      contentType: ct,
      json: parsed,
      text: parsed == null ? text : JSON.stringify(parsed, null, 2),
    };
  }
  return {
    ok: res.ok,
    status: res.status,
    contentType: ct,
    json: null,
    text: buf.toString('base64'),
    base64: true,
  };
}

function toolText(obj, isError = false) {
  return {
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
    isError: !!isError,
  };
}

const SETUP_TOOLS = [
  {
    name: 'insight_qa_setup_wizard',
    description:
      'Returns dashboard/Jira/Figma checklist plus full accountCreationDefaults (Navigator POST /api/accounts defaults + AskQuestion templates). For defaults-only, prefer insight_qa_nav_account_defaults. Then insight_qa_setup_set.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_setup_get',
    description: 'Show current MCP config (secrets redacted) and which dashboard URL is active.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_setup_set',
    description:
      'Save setup after the user provided values in chat. Sets the single dashboard URL and/or Jira Cloud + Figma PAT. Partial updates merge into existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        dashboardBaseUrl: {
          type: 'string',
          description: 'One dashboard root, e.g. http://127.0.0.1:9323 or http://127.0.0.1:9324 (no trailing slash)',
        },
        jira: {
          type: 'object',
          properties: {
            host: { type: 'string', description: 'Jira Cloud base, e.g. https://yourco.atlassian.net' },
            email: { type: 'string', description: 'Atlassian account email' },
            apiToken: { type: 'string', description: 'Jira API token (from id.atlassian.com)' },
          },
        },
        figma: {
          type: 'object',
          properties: {
            accessToken: { type: 'string', description: 'Figma personal access token' },
          },
        },
      },
    },
  },
  {
    name: 'insight_qa_setup_clear',
    description: 'Remove saved settings. Pass sections: ["dashboard"], ["jira"], ["figma"], or omit to clear all.',
    inputSchema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['dashboard', 'jira', 'figma'] },
        },
      },
    },
  },
  {
    name: 'insight_qa_jira_verify',
    description: 'Test Jira credentials (GET /rest/api/3/myself). Requires insight_qa_setup_set jira fields first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_figma_verify',
    description: 'Test Figma token (GET https://api.figma.com/v1/me). Requires insight_qa_setup_set figma first.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const TOOLS = [
  ...SETUP_TOOLS,
  {
    name: 'insight_qa_health',
    description:
      'Ping the QA workbench (GET /api/runner-status). Confirms the configured dashboard is reachable.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_env_resolve',
    description: 'Resolve Insight env slug to canonical { key, url } (GET /api/env/resolve).',
    inputSchema: {
      type: 'object',
      properties: { env: { type: 'string', description: 'e.g. pri-qa, maint-beta, prod' } },
      required: ['env'],
    },
  },
  {
    name: 'insight_qa_tests_run',
    description:
      'Start Playwright via dashboard (POST /api/run). Body: suite?, config?, project?, failedOnly?, env?, grep?',
    inputSchema: {
      type: 'object',
      properties: {
        suite: { type: 'string' },
        config: { type: 'string', description: 'Basename only, e.g. playwright.stripe.config.ts' },
        project: { type: 'string' },
        failedOnly: { type: 'boolean' },
        env: { type: 'string', description: 'Insight env key for BASE_URL' },
        grep: { type: 'string' },
      },
    },
  },
  {
    name: 'insight_qa_tests_kill',
    description: 'Kill Playwright/Chromium child and mark run aborted (POST /api/kill).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_tests_runner_status',
    description: 'Whether a test run is active (GET /api/runner-status).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_tests_suites',
    description: 'Legacy named suite keys (GET /api/suites).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_dpro_status',
    description: 'DirectPro CSV account snapshot (GET /api/dpro-status).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_dpro_snapshot',
    description: 'Static dpro snapshot JSON if present (GET /api/dpro-snapshot).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_nav_accounts_list',
    description: 'List saved Navigator accounts (GET /api/accounts).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_nav_accounts_create',
    description:
      'POST /api/accounts: mail.tm + signup + verify + login + newLogin (org/loc) + optional devices/purchase. AGENT: use Cursor AskQuestion first (see insight_qa_nav_account_defaults.mandatoryCursorAskQuestion); do not call without user default vs custom choice. Payload: { prefix } minimal. Full field list: insight_qa_nav_account_defaults.payloadFieldsAll.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { type: 'object', description: 'Request body forwarded to Navigator' },
      },
      required: ['payload'],
    },
  },
  {
    name: 'insight_qa_nav_account_defaults',
    description:
      'Read-only: mandatoryCursorAskQuestion (AskQuestion before create), payloadFieldsAll (every POST body field), default literals, purchase rules, AskQuestion templates. No dashboard/Jira/Figma prompts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_nav_accounts_delete',
    description: 'Delete account row by index (DELETE /api/accounts/:index).',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'integer', minimum: 0 } },
      required: ['index'],
    },
  },
  {
    name: 'insight_qa_nav_accounts_bulk',
    description: 'Bulk upsert accounts (POST /api/accounts/bulk). Body in `payload`.',
    inputSchema: {
      type: 'object',
      properties: { payload: { type: 'object' } },
      required: ['payload'],
    },
  },
  {
    name: 'insight_qa_nav_accounts_tag',
    description: 'Set tag on account index (PUT /api/accounts/:index/tag).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0 },
        tag: { type: 'string' },
      },
      required: ['index', 'tag'],
    },
  },
  {
    name: 'insight_qa_nav_launch',
    description: 'Open Chromium and log into saved account (POST /api/launch). Body: { email, insightEnv? }.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        insightEnv: { type: 'string' },
      },
      required: ['email'],
    },
  },
  {
    name: 'insight_qa_nav_cancel',
    description: 'Close Navigator browser session (POST /api/cancel).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_nav_add_devices',
    description:
      'Add devices on current session (POST /api/add-devices). Requires prior launch. Body fields: count?, deviceType?, nhbCount?, hbCount?, deviceOrgName?, deviceLocationName?, insightEnv?',
    inputSchema: {
      type: 'object',
      properties: { payload: { type: 'object' } },
      required: ['payload'],
    },
  },
  {
    name: 'insight_qa_nav_acc_purchase',
    description:
      'Stripe hosted checkout purchase on current page (POST /api/acc-purchase). Requires logged-in session. Body: plan, qty, fillFullAddress, address?, card?, insightEnv?, …',
    inputSchema: {
      type: 'object',
      properties: { payload: { type: 'object' } },
      required: ['payload'],
    },
  },
  {
    name: 'insight_qa_nav_stripe_preview_matrix',
    description: 'Country matrix metadata (GET /api/stripe-checkout-preview/matrix).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_nav_stripe_preview_state',
    description: 'Stripe preview runner state (GET /api/stripe-checkout-preview/state).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_nav_stripe_preview_history',
    description: 'Stripe preview run history (GET /api/stripe-checkout-preview/history).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_nav_stripe_preview_run',
    description: 'Start Stripe checkout preview matrix run (POST /api/stripe-checkout-preview/run). Body in `payload`.',
    inputSchema: {
      type: 'object',
      properties: { payload: { type: 'object' } },
      required: ['payload'],
    },
  },
  {
    name: 'insight_qa_nav_stripe_default_address',
    description: 'Default billing address row for ISO2 (GET /api/stripe-preview-default-address/:iso2).',
    inputSchema: {
      type: 'object',
      properties: { iso2: { type: 'string', description: 'Two-letter country' } },
      required: ['iso2'],
    },
  },
  {
    name: 'insight_qa_subscription_state_change',
    description:
      'QA Mongo: move paid subscription to grace/expired/active (POST /api/qa/subscription-grace-expired). VPN + credentials required on server.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        mode: { type: 'string', enum: ['grace', 'expired', 'active'] },
        insightEnv: { type: 'string' },
        dryRun: { type: 'boolean' },
        step: { type: 'string' },
        bypassValidation: { type: 'boolean' },
      },
      required: ['email', 'mode'],
    },
  },
  {
    name: 'insight_qa_mongo_db_history',
    description: 'Append-only QA Mongo change log (GET /api/qa/mongo-db-history?insightEnv=).',
    inputSchema: {
      type: 'object',
      properties: { insightEnv: { type: 'string' } },
    },
  },
  {
    name: 'insight_qa_interactive_init',
    description: 'Dashboard interactive mode: init test titles (POST /api/interactive/init).',
    inputSchema: {
      type: 'object',
      properties: {
        tests: { type: 'array', items: { type: 'string' }, description: 'Test case titles' },
      },
      required: ['tests'],
    },
  },
  {
    name: 'insight_qa_interactive_begin',
    description: 'Mark interactive test index as running (POST /api/interactive/begin).',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'integer', minimum: 0 } },
      required: ['index'],
    },
  },
  {
    name: 'insight_qa_interactive_step',
    description: 'Record interactive step (POST /api/interactive/step).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        action: { type: 'string' },
        expected: { type: 'string' },
        status: { type: 'string', enum: ['passed', 'failed'] },
        error: { type: 'string' },
        screenshot: { type: 'string' },
        duration: { type: 'number' },
      },
      required: ['index'],
    },
  },
  {
    name: 'insight_qa_interactive_screenshot',
    description: 'Attach screenshot to interactive test (POST /api/interactive/screenshot).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        filename: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['index', 'filename'],
    },
  },
  {
    name: 'insight_qa_interactive_end',
    description: 'End interactive test case (POST /api/interactive/end).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        status: { type: 'string', enum: ['passed', 'failed'] },
        error: { type: 'string' },
      },
      required: ['index', 'status'],
    },
  },
  {
    name: 'insight_qa_interactive_finish',
    description: 'Finalize interactive session (POST /api/interactive/finish).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'insight_qa_fetch_path',
    description:
      'GET a whitelisted path from the dashboard static server: /evidence/, /artifacts/, /history/, /report/ only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Must start with an allowed prefix' },
        maxBytes: { type: 'integer', description: 'Cap download size (default 10485760)' },
      },
      required: ['path'],
    },
  },
];

const server = new Server(
  {
    name: 'NTGR-Insight_QA',
    version: '0.2.3',
    title: 'NETGEAR Insight QA Workbench',
    iconUrl: 'https://auth-stg.netgear.com/assets/insight-logo-Bu4-N7lu.png',
  },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/** Source: tools/account-navigator/server.js (POST /api/accounts, constants ~L113–776). */
function buildAccountCreationReference() {
  return {
    implementedIn: 'playwright_hackathon/tools/account-navigator/server.js — POST /api/accounts',
    mcpCreateTool: 'insight_qa_nav_accounts_create — JSON body is forwarded as `payload` (Navigator req.body)',
    requiredField: {
      prefix:
        'string — mail.tm local part; dots removed before mailbox create. Final email is prefix@<pickedDomain>.',
    },
    defaultsWhenOmitted: {
      flow:
        "string — default `'new'`: auth-stg OC signup with redirect to session Insight portal. Any value other than `'old'` is treated as new. `'old'`: classic Angular `/classic/#/register` only (no auth-stg signup page).",
      country: "string — default `'US'` — `#country` on new flow; maps to classic register label via classicRegisterCountryLabel() on old flow.",
      insightEnv:
        "optional string in POST body — valid slug (see insight-env.js normalizeKey) updates session for this run. Invalid or omitted: session unchanged (boot default `pri-qa` or `NAVIGATOR_INSIGHT_ENV`).",
      browser:
        "optional `'chrome'` | `'firefox'` — if set, switches Navigator session browser for subsequent automation; otherwise unchanged.",
      addDevice: 'boolean — default false. If true, runs device bulk add after login (NHB/HB mix or single type).',
      deviceType: "when addDevice and nhbCount/hbCount not used — `'NHB'` or `'HB'` (default `'NHB'`).",
      deviceCount:
        'when addDevice, single-type path — normalizeDeviceCount(): default 1, clamped to 1–1000, integer.',
      nhbCountHbCount:
        'when addDevice with mix path — normalizeMixCount() per field (0–1000); if rawNhb omitted use 1, if rawHb omitted use 0.',
      deviceOrgName: 'trimmed string or omitted — bulk/org tree falls back to constant `org` (BULK_ONBOARD_ORG).',
      deviceLocationName: 'trimmed string or omitted — falls back to `loc` (BULK_ONBOARD_LOC).',
      newLoginOnboarding: {
        organizationName: '`org`',
        locationName: '`loc`',
        locationCountry:
          'Always United States for Create Location wizard (not necessarily signup `country`); see selectNewLoginLocationCountryUnitedStates().',
      },
      mailDomain:
        'null/omit: pick domain from mail.tm API list — first match in preferred list, else first API domain. Set to force a specific domain if available.',
      preferredMailDomains: ['deltajohnsons.com', 'sharebot.net', 'dollicons.com'],
      mailTmApisTriedInOrder: ['https://api.mail.tm', 'https://api.mail.gw'],
      mailTmMailboxPassword: 'Password123! — only for disposable mail.tm API account creation (not NETGEAR password).',
      netgearAccountPassword_literal_DEFAULT_PW: 'Lkjhgfdsa123456789! — used for auth-stg signup, login, and newLogin password fields (constant DEFAULT_PW in server.js). Treat as team QA secret.',
      authStgNewFlowProfile: {
        firstName: 'Test',
        lastName: 'User',
        phone: '+1 707 777 8889',
        phoneCountryCombobox: "label 'United States' when combobox exists",
      },
    },
    purchaseWhenEnabled: {
      rule: 'purchase.enabled true requires addDevice true (HTTP 400 otherwise — trial must exist on Manage Subscriptions).',
      defaultsFromPurchaseBodyToOpts: {
        plan: "'1-Year' unless purchase.plan === '3-Year'",
        qty: '1 if omitted',
        fillFullAddress: 'false if omitted',
        businessPurchase: 'false',
        deviceContext: "'na' unless 'HB' or 'NHB'",
        maxWaitMs: '360000',
        addressCardholderBusinessFields: 'optional — see purchase object in server.js purchaseBodyToOpts()',
      },
    },
    mandatoryCursorAskQuestion: {
      rule:
        'Before calling insight_qa_nav_accounts_create, the assistant MUST use Cursor AskQuestion (tool: AskQuestion) at least once so the user explicitly chooses default-only vs custom configuration. Do not invent a prefix or call create from silence.',
      step1AskQuestion: {
        title: 'Insight Navigator — account creation',
        questions: [
          {
            id: 'account_create_mode',
            prompt:
              'How should we configure the new test account? (Defaults use Navigator built-ins; Custom lets you set flow, env, devices, mail, purchase, etc.)',
            allow_multiple: false,
            options: [
              {
                id: 'all_defaults',
                label: 'Use all Navigator defaults — I will only ask for a unique mailbox prefix (and optionally insightEnv)',
              },
              {
                id: 'customize',
                label: 'Custom — show me every option and I will choose values before you create the account',
              },
            ],
          },
        ],
      },
      afterStep1: {
        all_defaults:
          'AskQuestion again OR chat: unique `prefix` (required). Optionally AskQuestion for `insightEnv` (e.g. pri-qa vs maint-beta). Then call insight_qa_nav_accounts_create.',
        customize:
          'Show the user `payloadFieldsAll` below (name, default, notes) and/or defaultsWhenOmitted + purchaseWhenEnabled. Collect answers, build JSON payload, then call insight_qa_nav_accounts_create. Use follow-up AskQuestion per field if the UI allows multi-step.',
      },
    },
    payloadFieldsAll: [
      { field: 'prefix', required: true, type: 'string', defaultWhenOmitted: '(none — required)', notes: 'Mail.tm local part; dots stripped.' },
      { field: 'flow', required: false, type: "'new' | 'old'", defaultWhenOmitted: 'new', notes: 'old = classic /classic/#/register only.' },
      { field: 'insightEnv', required: false, type: 'slug string', defaultWhenOmitted: 'session boot: pri-qa or NAVIGATOR_INSIGHT_ENV', notes: 'Valid slug updates session for this POST.' },
      { field: 'country', required: false, type: 'string (ISO / auth country code)', defaultWhenOmitted: 'US', notes: 'Auth-stg #country or classic register label map.' },
      { field: 'browser', required: false, type: "'chrome' | 'firefox'", defaultWhenOmitted: 'unchanged', notes: 'Sets Navigator session browser when set.' },
      { field: 'addDevice', required: false, type: 'boolean', defaultWhenOmitted: 'false', notes: 'If true, runs HB/NHB bulk add after login.' },
      { field: 'deviceType', required: false, type: "'NHB' | 'HB'", defaultWhenOmitted: 'NHB', notes: 'Used when addDevice and not using nhbCount/hbCount split.' },
      { field: 'deviceCount', required: false, type: 'number', defaultWhenOmitted: '1', notes: 'Single-type path; clamped 1–1000.' },
      { field: 'nhbCount', required: false, type: 'number', defaultWhenOmitted: '1 (if omitted on mix path)', notes: 'Mix path with hbCount; 0–1000.' },
      { field: 'hbCount', required: false, type: 'number', defaultWhenOmitted: '0 (if omitted on mix path)', notes: 'Mix path with nhbCount; 0–1000.' },
      { field: 'deviceOrgName', required: false, type: 'string', defaultWhenOmitted: 'org', notes: 'Trimmed; bulk tree org name.' },
      { field: 'deviceLocationName', required: false, type: 'string', defaultWhenOmitted: 'loc', notes: 'Trimmed; bulk tree location name.' },
      { field: 'mailDomain', required: false, type: 'string | null', defaultWhenOmitted: 'pick from API', notes: 'Force mail.tm domain if listed.' },
      { field: 'preferredMailDomains', required: false, type: 'string[]', defaultWhenOmitted: 'see defaultsWhenOmitted', notes: 'Order of preference for domain pick.' },
      {
        field: 'purchase',
        required: false,
        type: 'object',
        defaultWhenOmitted: 'omit / disabled',
        notes:
          'Requires addDevice true when purchase.enabled. Subfields: enabled, plan (1-Year|3-Year), qty, fillFullAddress, address, businessPurchase, businessId, taxIdTypeHint, cardholder, deviceContext (HB|NHB|na), maxWaitMs, card — see purchaseBodyToOpts() in server.js.',
      },
    ],
    askQuestionTemplates: {
      step1: {
        prompt:
          'Account creation: use Insight Navigator defaults (you only choose a unique mailbox prefix), or configure options field-by-field?',
        options: [
          {
            id: 'all_defaults',
            label: 'Use all defaults — only provide a unique `prefix` (optional: `insightEnv`, e.g. maint-beta)',
            next:
              'After explicit user choice via AskQuestion: call insight_qa_nav_accounts_create with { "payload": { "prefix": "<unique>" } } plus optional insightEnv.',
          },
          {
            id: 'customize',
            label: 'Customize — walk through fields before create',
            next: 'Show payloadFieldsAll + defaultsWhenOmitted; collect values; then insight_qa_nav_accounts_create.',
          },
        ],
      },
      customizeFieldOrder: [
        'prefix',
        'flow (new|old)',
        'insightEnv',
        'country',
        'browser (chrome|firefox)?',
        'addDevice',
        'deviceType | deviceCount OR nhbCount + hbCount',
        'deviceOrgName',
        'deviceLocationName',
        'mailDomain',
        'preferredMailDomains[]',
        'purchase.enabled + purchase.*',
      ],
    },
    relatedMcpToolsAfterCreate: [
      'insight_qa_nav_accounts_list',
      'insight_qa_nav_launch',
      'insight_qa_nav_add_devices',
      'insight_qa_nav_acc_purchase',
      'insight_qa_nav_accounts_tag',
      'insight_qa_nav_accounts_delete',
      'insight_qa_nav_accounts_bulk',
      'insight_qa_nav_cancel',
      'insight_qa_nav_stripe_preview_matrix',
      'insight_qa_nav_stripe_preview_state',
      'insight_qa_nav_stripe_preview_history',
      'insight_qa_nav_stripe_preview_run',
      'insight_qa_nav_stripe_default_address',
    ],
    minimalPayloadExample: { prefix: 'uniquePrefixNoDotsRequired' },
  };
}

function setupWizardPayload() {
  const p = getConfigPath();
  const accountRef = buildAccountCreationReference();
  return {
    intro:
      'MCP cannot open a GUI form. The assistant must ask you in chat for each item, then call insight_qa_setup_set with your answers.',
    singleDashboardRule:
      'Only one dashboard base URL is used for all Navigator/Playwright tools. It is the saved dashboardBaseUrl, else INSIGHT_QA_BASE_URL, else http://127.0.0.1:9323.',
    mcpVsPlugin:
      'This is an MCP server (stdio), not a Cursor UI extension. Cursor spawns one process per configured MCP server; that process holds one config file and one effective dashboard URL. That matches a single local dashboard (node dashboard/server.js).',
    configPath: p,
    accountCreationDefaults: accountRef,
    howToChooseDefaultsInChat: {
      preferDedicatedTool:
        'For defaults text only (no dashboard/Jira/Figma checklist), call insight_qa_nav_account_defaults — identical JSON to accountCreationDefaults below.',
      mandatoryAskQuestion:
        'REQUIRED: use Cursor AskQuestion (mandatoryCursorAskQuestion in accountCreationDefaults) before insight_qa_nav_accounts_create — user must pick all_defaults vs customize; never create without that choice.',
      useAskQuestionStep1: accountRef.askQuestionTemplates.step1,
      quick:
        'After AskQuestion all_defaults + prefix (and optional insightEnv): insight_qa_nav_accounts_create with { "payload": { "prefix": "<unique>" } }. Literals in defaultsWhenOmitted.',
      customize:
        'After AskQuestion customize: show payloadFieldsAll + defaultsWhenOmitted + purchaseWhenEnabled; collect values; then create.',
    },
    envOverrides: {
      INSIGHT_QA_MCP_CONFIG_FILE: 'Optional absolute path to JSON instead of ~/.insight-qa-workbench-mcp/config.json',
      INSIGHT_QA_BASE_URL: 'Fallback dashboard URL when dashboardBaseUrl is not saved',
    },
    askTheUserFor: [
      {
        id: 'dashboardBaseUrl',
        prompt:
          'What is your Insight QA dashboard root URL? (Where `node dashboard/server.js` listens, e.g. http://127.0.0.1:9323 or http://127.0.0.1:9324 for hackathon.)',
      },
      {
        id: 'jira',
        prompt:
          'Optional — Jira Cloud: site base URL (https://YOURDOMAIN.atlassian.net), Atlassian account email, and API token from https://id.atlassian.com/manage-profile/security/api-tokens',
      },
      {
        id: 'figma',
        prompt: 'Optional — Figma personal access token from Figma account settings (for design API checks).',
      },
    ],
    afterYouAnswer: {
      tool: 'insight_qa_setup_set',
      example: {
        dashboardBaseUrl: 'http://127.0.0.1:9323',
        jira: { host: 'https://example.atlassian.net', email: 'you@company.com', apiToken: '***' },
        figma: { accessToken: '***' },
      },
    },
    verify: ['insight_qa_health', 'insight_qa_jira_verify', 'insight_qa_figma_verify'],
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  try {
    switch (name) {
      case 'insight_qa_setup_wizard':
        return toolText(setupWizardPayload(), false);
      case 'insight_qa_setup_get':
        return toolText(redactedView(), false);
      case 'insight_qa_setup_set': {
        mergeAndSave({
          dashboardBaseUrl: args.dashboardBaseUrl,
          jira: args.jira,
          figma: args.figma,
        });
        return toolText(
          {
            ok: true,
            savedTo: getConfigPath(),
            effective: redactedView(),
            nextStep: 'Run insight_qa_health, then insight_qa_jira_verify / insight_qa_figma_verify if you set those.',
          },
          false
        );
      }
      case 'insight_qa_setup_clear': {
        clearSections(args.sections);
        return toolText({ ok: true, cleared: args.sections || 'all', effective: redactedView() }, false);
      }
      case 'insight_qa_jira_verify': {
        const auth = getJiraAuth();
        if (!auth) {
          return toolText(
            {
              ok: false,
              error: 'Jira not configured. Ask the user for host, email, API token; then insight_qa_setup_set.',
            },
            true
          );
        }
        const r = await fetch(`${auth.host}/rest/api/3/myself`, { headers: auth.headers });
        const text = await r.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        return toolText(
          {
            ok: r.ok,
            httpStatus: r.status,
            jiraHost: auth.host,
            body: json || text,
          },
          !r.ok
        );
      }
      case 'insight_qa_figma_verify': {
        const token = getFigmaToken();
        if (!token) {
          return toolText(
            {
              ok: false,
              error: 'Figma not configured. Ask the user for a PAT; then insight_qa_setup_set with figma.accessToken.',
            },
            true
          );
        }
        const r = await fetch('https://api.figma.com/v1/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await r.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        return toolText(
          {
            ok: r.ok,
            httpStatus: r.status,
            body: json || text,
          },
          !r.ok
        );
      }
      case 'insight_qa_health': {
        const r = await dashboardFetch('/api/runner-status', { method: 'GET' });
        return toolText(
          {
            baseUrl: getDashboardBaseUrl(),
            httpStatus: r.status,
            body: r.json != null ? r.json : r.text,
            ifThisFails: 'Ask the user for the correct dashboard URL, then insight_qa_setup_set or INSIGHT_QA_BASE_URL.',
          },
          !r.ok
        );
      }
      case 'insight_qa_env_resolve': {
        const env = encodeURIComponent(String(args.env || '').trim());
        const r = await dashboardFetch(`/api/env/resolve?env=${env}`, { method: 'GET' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_tests_run': {
        const r = await dashboardFetch('/api/run', {
          method: 'POST',
          body: JSON.stringify(args || {}),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_tests_kill': {
        const r = await dashboardFetch('/api/kill', { method: 'POST', body: '{}' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_tests_runner_status': {
        const r = await dashboardFetch('/api/runner-status', { method: 'GET' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_tests_suites': {
        const r = await dashboardFetch('/api/suites', { method: 'GET' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_dpro_status': {
        const r = await dashboardFetch('/api/dpro-status', { method: 'GET' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_dpro_snapshot': {
        const r = await dashboardFetch('/api/dpro-snapshot', { method: 'GET' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_accounts_list': {
        const r = await dashboardFetch('/api/accounts', { method: 'GET' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_accounts_create': {
        const r = await dashboardFetch('/api/accounts', {
          method: 'POST',
          body: JSON.stringify(args.payload || {}),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_account_defaults':
        return toolText(buildAccountCreationReference(), false);
      case 'insight_qa_nav_accounts_delete': {
        const r = await dashboardFetch(`/api/accounts/${encodeURIComponent(args.index)}`, {
          method: 'DELETE',
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_accounts_bulk': {
        const r = await dashboardFetch('/api/accounts/bulk', {
          method: 'POST',
          body: JSON.stringify(args.payload || {}),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_accounts_tag': {
        const r = await dashboardFetch(`/api/accounts/${encodeURIComponent(args.index)}/tag`, {
          method: 'PUT',
          body: JSON.stringify({ tag: args.tag }),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_launch': {
        const body = { email: args.email };
        if (args.insightEnv) body.insightEnv = args.insightEnv;
        const r = await dashboardFetch('/api/launch', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_cancel': {
        const r = await dashboardFetch('/api/cancel', { method: 'POST', body: '{}' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_add_devices': {
        const r = await dashboardFetch('/api/add-devices', {
          method: 'POST',
          body: JSON.stringify(args.payload || {}),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_acc_purchase': {
        const r = await dashboardFetch('/api/acc-purchase', {
          method: 'POST',
          body: JSON.stringify(args.payload || {}),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_stripe_preview_matrix': {
        const r = await dashboardFetch('/api/stripe-checkout-preview/matrix', { method: 'GET' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_stripe_preview_state': {
        const r = await dashboardFetch('/api/stripe-checkout-preview/state', { method: 'GET' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_stripe_preview_history': {
        const r = await dashboardFetch('/api/stripe-checkout-preview/history', { method: 'GET' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_stripe_preview_run': {
        const r = await dashboardFetch('/api/stripe-checkout-preview/run', {
          method: 'POST',
          body: JSON.stringify(args.payload || {}),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_nav_stripe_default_address': {
        const iso = encodeURIComponent(String(args.iso2 || '').trim().toUpperCase());
        const r = await dashboardFetch(`/api/stripe-preview-default-address/${iso}`, {
          method: 'GET',
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_subscription_state_change': {
        const body = {
          email: args.email,
          mode: args.mode,
          dryRun: !!args.dryRun,
          bypassValidation: !!args.bypassValidation,
        };
        if (args.insightEnv) body.insightEnv = args.insightEnv;
        if (args.step) body.step = args.step;
        const r = await dashboardFetch('/api/qa/subscription-grace-expired', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_mongo_db_history': {
        const q = args.insightEnv
          ? `?insightEnv=${encodeURIComponent(String(args.insightEnv))}`
          : '';
        const r = await dashboardFetch(`/api/qa/mongo-db-history${q}`, { method: 'GET' });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_interactive_init': {
        const r = await dashboardFetch('/api/interactive/init', {
          method: 'POST',
          body: JSON.stringify({ tests: args.tests || [] }),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_interactive_begin': {
        const r = await dashboardFetch('/api/interactive/begin', {
          method: 'POST',
          body: JSON.stringify({ index: args.index }),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_interactive_step': {
        const r = await dashboardFetch('/api/interactive/step', {
          method: 'POST',
          body: JSON.stringify(args),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_interactive_screenshot': {
        const r = await dashboardFetch('/api/interactive/screenshot', {
          method: 'POST',
          body: JSON.stringify({
            index: args.index,
            filename: args.filename,
            name: args.name,
          }),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_interactive_end': {
        const r = await dashboardFetch('/api/interactive/end', {
          method: 'POST',
          body: JSON.stringify({
            index: args.index,
            status: args.status,
            error: args.error,
          }),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_interactive_finish': {
        const r = await dashboardFetch('/api/interactive/finish', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        return toolText(
          { baseUrl: getDashboardBaseUrl(), httpStatus: r.status, body: r.json != null ? r.json : r.text },
          !r.ok
        );
      }
      case 'insight_qa_fetch_path': {
        const p = String(args.path || '');
        const ok = ALLOWED_GET_PREFIXES.some((pre) => p.startsWith(pre));
        if (!ok) {
          return toolText(
            {
              error: 'path not allowed',
              allowedPrefixes: ALLOWED_GET_PREFIXES,
            },
            true
          );
        }
        const maxBytes = args.maxBytes != null ? Number(args.maxBytes) : 10 * 1024 * 1024;
        const r = await dashboardFetch(p, { method: 'GET' });
        const raw = r.base64 ? Buffer.from(r.text, 'base64') : Buffer.from(r.text, 'utf8');
        if (raw.length > maxBytes) {
          return toolText(
            {
              error: 'response too large',
              size: raw.length,
              maxBytes,
              hint: 'narrow path or increase maxBytes',
            },
            true
          );
        }
        if (r.base64) {
          return toolText({
            baseUrl: getDashboardBaseUrl(),
            httpStatus: r.status,
            contentType: r.contentType,
            base64: true,
            data: r.text,
            note: 'binary body returned as base64',
          });
        }
        return toolText(
          {
            baseUrl: getDashboardBaseUrl(),
            httpStatus: r.status,
            contentType: r.contentType,
            body: r.json != null ? r.json : r.text,
          },
          !r.ok
        );
      }
      default:
        return toolText({ error: `Unknown tool: ${name}` }, true);
    }
  } catch (e) {
    const url = getDashboardBaseUrl();
    const msg =
      e && e.cause && e.cause.code === 'ECONNREFUSED'
        ? `Cannot reach ${url} (ECONNREFUSED). Start the dashboard (node dashboard/server.js) or run insight_qa_setup_wizard and insight_qa_setup_set with the correct dashboardBaseUrl.`
        : e.message || String(e);
    return toolText({ error: msg, baseUrl: url }, true);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[NTGR-Insight_QA] stdio | dashboard=${getDashboardBaseUrl()} | config=${getConfigPath()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
