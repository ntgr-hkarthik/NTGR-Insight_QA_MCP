const express = require('express');
const { chromium, firefox } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
let countryData = { countryList: [] };
try {
    countryData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../countryList.json'), 'utf8'));
} catch(e) { console.error('Could not load countryList.json', e); }
const https = require('https');
const { runInsightHostedPurchase } = require('./acc-purchase');
const {
    executeStripePreviewMatrix,
    runOneCountryPreview,
    resolvePreviewSubset,
    PREVIEW_COUNTRY_MATRIX,
    INTL_E2E_SCENARIOS,
    EXPECTED_CURRENCY_BY_ISO2,
    previewAddressFor,
} = require('./stripe-checkout-preview');
const insightEnv = require('./insight-env');

let sessionBrowser = 'firefox';
function getActiveBrowser() { return sessionBrowser === 'chrome' ? chromium : firefox; }

const WORKSPACE_ROOT = path.join(__dirname, '../..');
let runSubscriptionStateChange = async () => ({ ok: false, error: 'DB access not available in this environment' });
let readMongoDbHistory = () => [];
try {
    ({ runSubscriptionStateChange } = require(path.join(WORKSPACE_ROOT, 'scripts/db-subscription-grace-expired.js')));
    ({ readFiltered: readMongoDbHistory } = require(path.join(WORKSPACE_ROOT, 'scripts/qa-mongo-history.js')));
} catch (_) { /* scripts/ not present — running without DB access */ }
const STRIPE_PREVIEW_STATE_FILE = path.join(WORKSPACE_ROOT, 'test-results', 'stripe-preview', 'last-run.json');
const STRIPE_PREVIEW_RUN_COUNTER_FILE = path.join(WORKSPACE_ROOT, 'test-results', 'stripe-preview', 'run-counter.json');

/** @type {{ status: string, currentIndex: number, currentLabel: string|null, rows: object[], error: string|null, startedAt: string|null, finishedAt: string|null, outDir: string|null, plan: string|null, defaultPlan?: string|null, currentCountryPlan?: string|null, countryTotal?: number|null, runNumber?: number|null, runLabel?: string|null, completePurchase?: boolean|null, useScenarioSpec?: boolean|null, insightEnv?: string|null, newAccountPerCountry?: boolean|null }} */
let stripePreviewState = {
    status: 'idle',
    currentIndex: 0,
    currentLabel: null,
    rows: [],
    error: null,
    startedAt: null,
    finishedAt: null,
    outDir: null,
    plan: null,
    defaultPlan: null,
    currentCountryPlan: null,
    countryTotal: null,
    newAccountPerCountry: null,
    runNumber: null,
    runLabel: null,
    completePurchase: null,
    useScenarioSpec: null,
    insightEnv: null,
    interactivePurchaseQueue: null,
};

function nextStripePreviewRunFolder() {
    fs.mkdirSync(path.dirname(STRIPE_PREVIEW_RUN_COUNTER_FILE), { recursive: true });
    let n = 1;
    try {
        if (fs.existsSync(STRIPE_PREVIEW_RUN_COUNTER_FILE)) {
            const j = JSON.parse(fs.readFileSync(STRIPE_PREVIEW_RUN_COUNTER_FILE, 'utf8'));
            if (j && typeof j.next === 'number' && j.next >= 1) n = j.next;
        }
    } catch (e) {
        /* start at 1 */
    }
    const label = `run${n}`;
    const outDir = path.join(WORKSPACE_ROOT, 'test-results', 'stripe-preview', label);
    try {
        fs.writeFileSync(STRIPE_PREVIEW_RUN_COUNTER_FILE, JSON.stringify({ next: n + 1 }, null, 2));
    } catch (e) {
        console.error('[stripe-preview] run counter persist', e.message);
    }
    return { runNumber: n, runLabel: label, outDir };
}

function persistStripePreviewState() {
    try {
        fs.mkdirSync(path.dirname(STRIPE_PREVIEW_STATE_FILE), { recursive: true });
        fs.writeFileSync(STRIPE_PREVIEW_STATE_FILE, JSON.stringify(stripePreviewState, null, 2));
    } catch (e) {
        console.error('[stripe-preview] persist', e.message);
    }
}

function artifactRelFromAbs(absPath) {
    if (!absPath) return '';
    const rel = path.relative(WORKSPACE_ROOT, absPath).replace(/\\/g, '/');
    return rel;
}

const app = express();
app.use(express.json());

/** Local dev: allow acc-purchase.html opened from file:// or another port (Live Preview) to call this API. */
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

const PORT = 3000;
const DB_FILE = path.join(__dirname, 'accounts.json');

// Default password
const DEFAULT_PW = 'Lkjhgfdsa123456789!';

// Playwright state
let browser = null;
let context = null;
let page = null;

/**
 * Normalize an Insight env key from client. Accepts any safe slug (a-z0-9-)
 * plus the "prod" alias. Invalid input falls back to 'pri-qa'.
 */
function normalizeInsightEnv(raw) {
    if (typeof raw !== 'string') return 'pri-qa';
    const k = raw.trim().toLowerCase();
    if (!k) return 'pri-qa';
    if (k === 'prod') return 'prod';
    if (/^[a-z0-9][a-z0-9-]{0,40}$/.test(k)) return k;
    return 'pri-qa';
}

/** Resolve an Insight env key → full https origin. */
function resolveInsightHost(envKey) {
    const k = normalizeInsightEnv(envKey);
    if (k === 'prod') return 'https://insight.netgear.com';
    return `https://${k}.insight.netgear.com`;
}

/** Infer registry source from tab name when `source` was never persisted. */
function inferAccountSourceFromTag(tag) {
    const t = tag || '';
    if (t === 'stripe-preview') return 'stripe_preview';
    return 'legacy';
}

/** Normalize one registry row (legacy string or object missing insightEnv). */
function parseAccountEntry(raw) {
    if (typeof raw === 'string') {
        const email = String(raw).trim();
        if (!email) return null;
        return {
            email,
            tag: 'Default',
            insightEnv: 'pri-qa',
            dateAdded: null,
            source: 'legacy',
        };
    }
    if (!raw || typeof raw !== 'object') return null;
    const email = raw.email != null ? String(raw.email).trim() : '';
    if (!email) return null;
    const insightEnvVal = normalizeInsightEnv(raw.insightEnv);
    const tagNorm = raw.tag || 'Default';
    const src =
        raw.source != null && String(raw.source).trim()
            ? String(raw.source).trim()
            : inferAccountSourceFromTag(tagNorm);
    const out = {
        email,
        tag: tagNorm,
        insightEnv: insightEnvVal,
        dateAdded: raw.dateAdded != null ? String(raw.dateAdded) : null,
        source: src,
    };
    if (raw.provisionProfile && typeof raw.provisionProfile === 'object') {
        out.provisionProfile = raw.provisionProfile;
    }
    return out;
}

// Load accounts (always object rows with insightEnv)
function getAccounts() {
    if (!fs.existsSync(DB_FILE)) return [];
    let data;
    try {
        data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
        return [];
    }
    if (!Array.isArray(data)) return [];
    return data.map(parseAccountEntry).filter(Boolean);
}

// Save accounts
function saveAccounts(accounts) {
    fs.writeFileSync(DB_FILE, JSON.stringify(accounts, null, 2));
}

/** One-time rewrite when file has legacy strings or missing insightEnv. */
function migrateAccountsFileOnce() {
    if (!fs.existsSync(DB_FILE)) return;
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
        return;
    }
    if (!Array.isArray(raw)) return;
    const needsWrite = raw.some(
        (r) =>
            typeof r === 'string' ||
            !r ||
            typeof r !== 'object' ||
            (r.insightEnv !== 'pri-qa' && r.insightEnv !== 'maint-beta' && r.insightEnv !== 'prod')
    );
    if (!needsWrite) return;
    const migrated = raw.map(parseAccountEntry).filter(Boolean);
    saveAccounts(migrated);
    console.log('[accounts] Migrated accounts.json (insightEnv + normalized rows)');
}

/** Persist dateAdded + source for rows created before metadata fields existed. */
function migrateAccountMetadataOnce() {
    if (!fs.existsSync(DB_FILE)) return;
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
        return;
    }
    if (!Array.isArray(raw)) return;
    let changed = false;
    const out = [];
    for (const r of raw) {
        const parsed = parseAccountEntry(r);
        if (!parsed) continue;
        if (typeof r === 'string') changed = true;
        else if (r && typeof r === 'object') {
            if (!Object.prototype.hasOwnProperty.call(r, 'source')) changed = true;
            if (!Object.prototype.hasOwnProperty.call(r, 'dateAdded')) changed = true;
        } else {
            changed = true;
        }
        out.push(parsed);
    }
    if (changed && out.length === raw.length) {
        saveAccounts(out);
        console.log('[accounts] Migrated account metadata (dateAdded / source)');
    }
}

/**
 * @param {string} email
 * @param {string} [tag]
 * @param {string} [explicitInsightEnv]
 * @param {{ source?: string, provisionProfile?: object, dateAdded?: string }} [meta]
 */
function newAccountRecord(email, tag = 'Default', explicitInsightEnv, meta = {}) {
    const ie =
        explicitInsightEnv === 'maint-beta' || explicitInsightEnv === 'pri-qa' || explicitInsightEnv === 'prod'
            ? explicitInsightEnv
            : insightEnv.getSessionInsightEnv();
    const row = {
        email: String(email).trim(),
        tag: tag || 'Default',
        insightEnv: ie,
        dateAdded: meta.dateAdded || new Date().toISOString(),
        source: meta.source || 'navigator',
    };
    if (meta.provisionProfile && typeof meta.provisionProfile === 'object') {
        row.provisionProfile = meta.provisionProfile;
    }
    return row;
}

/** Saved profile for accounts created via POST /api/accounts (Navigator UI). */
function buildNavigatorProvisionProfile(body, addDevice, deviceCount, purchaseEnabled, mix) {
    const flow = body && body.flow === 'old' ? 'old' : 'new';
    const country =
        body && body.country != null && String(body.country).trim()
            ? String(body.country).trim()
            : 'US';
    const prof = {
        signupFlow: flow,
        country,
        addDevice: !!addDevice,
        deviceCount: addDevice ? deviceCount : 0,
        stripePurchase: !!purchaseEnabled,
    };
    if (mix && (mix.nhb > 0 || mix.hb > 0)) {
        prof.deviceNhb = mix.nhb;
        prof.deviceHb = mix.hb;
    }
    return prof;
}

// --- Mail.tm API Helpers ---
function request(url, options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: body ? JSON.parse(body) : null }); }
        catch (e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/** mail.tm-compatible APIs (same hydra JSON shape). */
const MAILTM_APIS = ['https://api.mail.tm', 'https://api.mail.gw'];
/** Prefer these domains when mail.tm lists them — avoids mismatch with sharebot-only assumptions. */
const DEFAULT_PREFERRED_MAIL_DOMAINS = [
  'deltajohnsons.com',
  'sharebot.net',
  'dollicons.com',
];

async function fetchMailTmDomains(api) {
  try {
    const domainRes = await request(`${api}/domains`, { method: 'GET' });
    if (!domainRes || domainRes.status !== 200 || !domainRes.data) return [];
    const member = domainRes.data['hydra:member'];
    if (!Array.isArray(member)) return [];
    return member.map((d) => d.domain).filter(Boolean);
  } catch (e) {
    console.log(`[MailTM] Domain fetch error for ${api}:`, e.message || e);
    return [];
  }
}

function pickMailTmDomain(available, preferredList, forcedDomain) {
  if (!available.length) return null;
  if (forcedDomain) {
    const f = String(forcedDomain).trim().toLowerCase();
    const found = available.find((d) => d.toLowerCase() === f);
    return found || null;
  }
  for (const p of preferredList) {
    const want = String(p).trim().toLowerCase();
    const found = available.find((d) => d.toLowerCase() === want);
    if (found) return found;
  }
  return available[0];
}

/**
 * Create mailbox on first working API + domain.
 * @param {string} localPart
 * @param {{ mailDomain?: string|null, preferredDomains?: string[] }} [options]
 */
async function createMailTmAccount(localPart, options = {}) {
  const forcedDomain = options.mailDomain || null;
  const preferredDomains =
    Array.isArray(options.preferredDomains) && options.preferredDomains.length
      ? options.preferredDomains
      : DEFAULT_PREFERRED_MAIL_DOMAINS;

  const local = localPart.replace(/\./g, '');
  const pwd = 'Password123!';

  for (const api of MAILTM_APIS) {
    const available = await fetchMailTmDomains(api);
    if (!available.length) {
      console.log(`[MailTM] No domains from ${api}, trying next API...`);
      continue;
    }
    const domain = pickMailTmDomain(available, preferredDomains, forcedDomain);
    if (!domain) {
      console.log(
        `[MailTM] Domain ${forcedDomain || '(pick)'} unavailable on ${api}; have: ${available.join(', ')}`
      );
      if (forcedDomain) continue;
      return null;
    }

    const address = `${local}@${domain}`;
    console.log(`[MailTM] ${api} → ${address} (picked domain ${domain})`);
    const postData = JSON.stringify({ address, password: pwd });

    const res = await request(`${api}/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, postData);

    if (res.status === 422) {
      console.log(
        `[MailTM] Mailbox already exists for ${address} — obtaining token (same as logging into existing inbox).`
      );
    } else if (res.status === 201) {
      console.log(`[MailTM] New mailbox created for ${address}`);
    }

    if (res.status === 201 || res.status === 422) {
      const tokenData = JSON.stringify({ address, password: pwd });
      const tokenRes = await request(`${api}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(tokenData),
        },
      }, tokenData);

      if (tokenRes.status === 200 && tokenRes.data && tokenRes.data.token) {
        return {
          address,
          token: tokenRes.data.token,
          api,
          password: pwd,
          domain,
        };
      }
      console.log('[MailTM] Token error after account create:', tokenRes.status, tokenRes.data);
    } else {
      console.log(
        `[MailTM] POST /accounts ${res.status} for ${address}:`,
        JSON.stringify(res.data || '').slice(0, 300)
      );
    }
  }
  return null;
}

/** Normalize mail.tm message body (html may be string or array of parts). */
function normalizeMailBody(data) {
  if (!data) return { html: '', text: '' };
  let html = data.html;
  if (Array.isArray(html)) html = html.join('');
  else if (html == null) html = '';
  const text = data.text != null ? String(data.text) : '';
  return { html: String(html), text };
}

/**
 * Extract verification link and/or 6-digit OTP from NETGEAR / auth emails.
 */
function extractVerificationLinkAndOtp(html, text) {
  const blob = `${html}\n${text}`;
  let link = null;

  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let hm;
  while ((hm = hrefRe.exec(blob)) !== null) {
    const u = hm[1].replace(/&amp;/g, '&').replace(/&#x3D;/g, '=');
    if (
      /^https?:\/\//i.test(u) &&
      /verify|confirm-signup|confirm\/email|activate|registration\/confirm|auth-stg\.netgear\.com\/confirm/i.test(
        u
      )
    ) {
      link = u;
      break;
    }
  }
  if (!link) {
    const urlRe =
      /(https:\/\/[^\s"'<>\]]*(?:auth-stg\.netgear\.com\/confirm|verify|confirm-signup|confirm%2Femail|activate)[^\s"'<>\]]*)/i;
    const um = blob.match(urlRe);
    if (um) link = um[1].replace(/&amp;/g, '&');
  }

  let otp = null;
  const codeInUrl = blob.match(/[?&]code=(\d{6})\b/i);
  if (codeInUrl) otp = codeInUrl[1];
  if (!otp) {
    const styled = blob.match(/letter-spacing[^>]*>\s*(\d{6})\s*</i);
    if (styled) otp = styled[1];
  }
  if (!otp) {
    const bigCode = blob.match(/font-size:\s*3[0-9]px[^>]*letter-spacing[^>]*>\s*(\d{6})\s*</i);
    if (bigCode) otp = bigCode[1];
  }
  if (!otp) {
    const labeled = blob.match(
      /(?:code|otp|pin|verification)\s*[:#=\s-]*\s*(\d{6})\b/i
    );
    if (labeled) otp = labeled[1];
  }
  if (!otp && text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    for (const line of lines) {
      const six = line.match(/\b(\d{6})\b/);
      if (six && !/20\d{4}/.test(six[1])) {
        otp = six[1];
        break;
      }
    }
  }
  if (!otp) {
    const fallback = blob.match(/\b(\d{6})\b/);
    if (fallback && !/(19|20)\d{4}/.test(fallback[1])) otp = fallback[1];
  }

  return { link, otp };
}

const MAIL_SUBJECT_HINT =
  /verify|confirm|netgear|insight|code|your email|e-mail|email address|signup|sign up|registration|activate|security/i;

function messageLooksLikeVerification(msg) {
  const sub = msg.subject || '';
  if (MAIL_SUBJECT_HINT.test(sub)) return true;
  const fromAddr = (msg.from && msg.from.address) || '';
  if (/netgear|message\.netgear/i.test(fromAddr)) return true;
  return false;
}

/** Poll mail.tm for verification link and/or 6-digit OTP (newest messages first). */
async function pollVerificationLinkOrOtp(token, api, timeoutMs = 120000) {
  const start = Date.now();
  const seen = new Set();
  while (Date.now() - start < timeoutMs) {
    const res = await request(`${api}/messages`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 200 && res.data && res.data['hydra:member']) {
      const list = res.data['hydra:member']
        .slice()
        .sort((a, b) =>
          String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
        );
      for (const msg of list) {
        if (!messageLooksLikeVerification(msg)) continue;
        const sub = msg.subject || '';

        const msgRes = await request(`${api}/messages/${msg.id}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (msgRes.status !== 200) continue;

        const { html, text } = normalizeMailBody(msgRes.data);
        const { link, otp } = extractVerificationLinkAndOtp(html, text);
        const key = `${link || ''}|${otp || ''}`;
        if ((link || otp) && !seen.has(key)) {
          seen.add(key);
          console.log(
            `Mail parsed: link=${link ? 'yes' : 'no'} otp=${otp ? 'yes' : 'no'} subject=${sub.slice(0, 60)}`
          );
          return { link, otp };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { link: null, otp: null };
}

/** Fill OTP on auth-stg confirm UI and submit. */
async function submitEmailVerificationOtp(page, otp) {
  if (!/^\d{6}$/.test(otp)) throw new Error('Invalid OTP length');
  await page.waitForTimeout(500);

  const digitInputs = page.locator(
    'input.otp-digit-input, input[maxlength="1"], [class*="otp"] input[type="text"], [class*="Otp"] input'
  );
  const n = await digitInputs.count();
  if (n >= 6) {
    for (let i = 0; i < 6; i++) {
      await digitInputs.nth(i).fill(otp[i], { timeout: 5000 });
    }
  } else {
    const codeField = page
      .locator(
        'input[inputmode="numeric"], input[autocomplete="one-time-code"], input[name*="code" i], input[placeholder*="code" i]'
      )
      .first();
    if (await codeField.isVisible({ timeout: 5000 }).catch(() => false)) {
      await codeField.fill(otp);
    } else {
      await page.getByRole('textbox').first().fill(otp);
    }
  }

  const submit = page
    .getByRole('button', { name: /confirm|verify|submit|continue/i })
    .first();
  if (await submit.isVisible({ timeout: 5000 }).catch(() => false)) {
    await submit.click();
  } else {
    await page.locator('button[type="submit"]').first().click();
  }
  await page.waitForTimeout(4000);
}

/** Wait for post-signup “check email” / OTP / confirm page (loading can mask copy for many seconds). */
async function waitForPostSignupSuccess(page, maxMs = 90000) {
  await page.waitForTimeout(2500);
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/confirm-signup|verify|email|code|otp/i.test(url)) return 'ready';

    const otpInputs = page.locator(
      '.otp-digit-input, input.otp-digit-input, input[inputmode="numeric"][maxlength="1"], [class*="otp"] input[type="text"], [class*="Otp"] input'
    );
    const nOtp = await otpInputs.count().catch(() => 0);
    if (nOtp >= 1) {
      const anyVis = await otpInputs
        .first()
        .isVisible()
        .catch(() => false);
      if (anyVis) return 'ready';
    }

    const body = await page.locator('body').innerText().catch(() => '');
    if (/already exists|already registered/i.test(body)) return 'exists';
    if (
      /confirm your e?mail|check your e?mail|verification code|one[- ]time|sent (you )?an e?mail|verify your|enter (the )?code|6[- ]?digit|authentication code|we(?:'ve| have) sent|security code/i.test(
        body
      )
    )
      return 'ready';

    await page.waitForTimeout(1500);
  }
  return false;
}

function writeCurrentEmailSession(email, mailAcc) {
  if (!mailAcc) return;
  try {
    const payload = {
      email,
      domain: mailAcc.domain || (email.includes('@') ? email.split('@')[1] : ''),
      mailtmPassword: mailAcc.password,
      mailtmToken: mailAcc.token,
      api: mailAcc.api,
      note: 'Inbox is always this full address (domain from mail.tm). mail.tm web UI: log in with email + mailtmPassword. API: GET {api}/messages Bearer mailtmToken',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(__dirname, 'current-email.json'),
      JSON.stringify(payload, null, 2)
    );
  } catch (e) {
    console.log('Could not write current-email.json', e.message);
  }
}

// --- End Mail.tm API Helpers ---

/** Reject patterns Insight / QA often flags (zero-padded, long zero runs, trivial sequences). */
function serialNumericSuffixLooksPlausible(suffix) {
  if (!/^\d{10}$/.test(suffix)) return false;
  if (/0{5,}/.test(suffix)) return false;
  if (/^0{4,}/.test(suffix)) return false;
  if (/^0+1$/.test(suffix)) return false;
  if (/(\d)\1{6,}/.test(suffix)) return false;
  if (/0123456789|1234567890|9876543210|0987654321/.test(suffix)) return false;
  return true;
}

/**
 * Random NHB/HB-style serial; retries until suffix passes plausibility checks.
 * AGENTS: avoid zero-padded / obvious test patterns like 4W80000000001.
 */
function generateSerial(type = 'NHB') {
  const digits = '0123456789';
  const prefix = type === 'HB' ? (Math.random() < 0.5 ? '6LC' : '4XT') : '4W8';
  for (let attempt = 0; attempt < 120; attempt++) {
    let s = prefix;
    for (let i = 0; i < 10; i++) s += digits.charAt(Math.floor(Math.random() * digits.length));
    const suf = s.slice(prefix.length);
    if (serialNumericSuffixLooksPlausible(suf)) return s;
  }
  let s = prefix;
  for (let i = 0; i < 10; i++) s += digits.charAt(1 + Math.floor(Math.random() * 9));
  return s;
}

/** Clamp bulk add to [1, 1000]. */
function normalizeDeviceCount(raw) {
  let n = raw != null ? Number(raw) : 1;
  if (!Number.isFinite(n)) n = 1;
  n = Math.floor(n);
  return Math.max(1, Math.min(1000, n));
}

/** Per-type counts for NHB/HB mix (0–1000 each). */
function normalizeMixCount(raw) {
  let n = raw != null ? Number(raw) : 0;
  if (!Number.isFinite(n)) n = 0;
  n = Math.floor(n);
  return Math.max(0, Math.min(1000, n));
}

function generateRandomMac() {
  const hex = '0123456789ABCDEF';
  for (let attempt = 0; attempt < 50; attempt++) {
    const parts = [];
    for (let b = 0; b < 6; b++) {
      let byte = '';
      for (let i = 0; i < 2; i++) byte += hex.charAt(Math.floor(Math.random() * 16));
      parts.push(byte);
    }
    const mac = parts.join(':');
    const zeroOctets = parts.filter((p) => p === '00').length;
    if (zeroOctets <= 1) return mac;
  }
  const parts = [];
  for (let b = 0; b < 6; b++) {
    parts.push(`${1 + Math.floor(Math.random() * 15)}${1 + Math.floor(Math.random() * 15)}`);
  }
  return parts.join(':');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create Location wizard: always United States (Insight QA — device/location region), regardless of signup country.
 * Never fall back to `li[role="option"]` first item (often Afghanistan).
 */
async function selectNewLoginLocationCountryUnitedStates(page) {
    const countryDropdown = page
        .locator('div[role="button"]:has-text("Country"), div[aria-haspopup="listbox"]')
        .first();
    if (!(await countryDropdown.isVisible().catch(() => false))) {
        console.warn('[newLogin] Location country dropdown not visible — skip US selection');
        return false;
    }
    await countryDropdown.click();
    await page.waitForTimeout(500);
    const tryLabels = ['United States of America', 'United States', 'USA'];
    for (const label of tryLabels) {
        const exactOption = page
            .locator('li[role="option"]')
            .filter({ hasText: new RegExp('^' + escapeRe(label) + '$', 'i') })
            .first();
        if (await exactOption.isVisible().catch(() => false)) {
            await exactOption.click();
            await page.waitForTimeout(800);
            console.log('[newLogin] Location country set to United States (exact:', label + ')');
            return true;
        }
    }
    const partial = page.locator('li[role="option"]').filter({ hasText: /^United States/i }).first();
    if (await partial.isVisible().catch(() => false)) {
        await partial.click();
        await page.waitForTimeout(800);
        console.log('[newLogin] Location country set to United States (partial match)');
        return true;
    }
    console.error(
        '[newLogin] Could not select United States for location — not using first list option (avoids Afghanistan default)'
    );
    return false;
}

async function dismissTrialPopupIfAny(page) {
  const trialHeading = page
    .getByRole('heading', {
      name: /Trial Starts Now|free trial|trial started|90\s*[- ]?\s*day/i,
    })
    .first();
  if (await trialHeading.isVisible({ timeout: 5000 }).catch(() => false)) {
    const gotIt = page.getByRole('button', { name: /Got It|OK|Close/i });
    if (await gotIt.isVisible({ timeout: 3000 }).catch(() => false)) await gotIt.click();
  }
  await page.waitForTimeout(600);
}

/** Fixed names for newLogin onboarding (must match CSV LOCATION NAME column). */
const BULK_ONBOARD_ORG = 'org';
const BULK_ONBOARD_LOC = 'loc';

/** After CSV parse success icon, wait before Next/View — backend must finish processing rows (see HAR: validateAdd after user steps). */
const BULK_POST_PARSE_SETTLE_MS =
    Number(process.env.BULK_POST_PARSE_SETTLE_MS) > 0
        ? Number(process.env.BULK_POST_PARSE_SETTLE_MS)
        : 4500;
/** Hold after success SVG detection so parse is not treated as “done” too early. */
const BULK_PARSE_SUCCESS_ICON_HOLD_MS =
    Number(process.env.BULK_PARSE_SUCCESS_ICON_HOLD_MS) > 0
        ? Number(process.env.BULK_PARSE_SUCCESS_ICON_HOLD_MS)
        : 2500;
/** Single-device Add modal: wait for org dropdown to mount. */
const SINGLE_DEVICE_ORG_TREE_MS = 8000;
/** After tree is open: pick org / loc rows (MUI tree + network can exceed 5s). */
const SINGLE_DEVICE_TREE_NAV_MS = 16000;

async function waitUntilLocatorVisible(page, locator, budgetMs, stepMs = 200) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await locator.first().isVisible({ timeout: Math.min(stepMs, 400) }).catch(() => false)) return true;
    await page.waitForTimeout(stepMs);
  }
  return false;
}

/** Output only — overwritten each bulk run (Insight rejects duplicate serials across accounts). */
const BULK_CSV_STAGING = path.join(__dirname, 'bulk-devices-staging.csv');
/**
 * Fallback header — must match Insight’s template byte-for-byte on the IMEI column:
 * `Devices,Ex` (no space after comma). A space after the comma breaks column mapping and LOCATION parsing.
 */
const BULK_CSV_HEADER_FALLBACK =
  'DEVICE NAME,DEVICE SERIAL,LOCATION NAME,MAC Address (Ex : AA:BB:CC:DD:EE:FF),PROFILE NAME (Mobile Hotspot Devices),IMEI NUMBER (Mobile Hotspot Devices,Ex : IMEI-098765432123456)';

/** Read header from reference copy (never written by automation). Order: reference → user’s “staging copy”. */
function readBulkCsvHeaderLine() {
  const refPaths = [
    path.join(__dirname, 'bulk-devices-reference.csv'),
    path.join(__dirname, 'bulk-devices-staging copy.csv'),
  ];
  for (const p of refPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      const first = raw.split(/\r?\n/).find((l) => String(l).trim().length > 0);
      if (first && /DEVICE\s+NAME/i.test(first)) {
        console.log('[bulk-csv] Using header from', path.basename(p));
        return String(first).trim();
      }
    } catch (e) {
      console.log('[bulk-csv] Could not read header from', p, e.message);
    }
  }
  console.log('[bulk-csv] Using built-in fallback header');
  return BULK_CSV_HEADER_FALLBACK;
}

function writeBulkDeviceStagingCsv(count, deviceType, locationNameCol) {
  const lines = [readBulkCsvHeaderLine()];
  const loc = locationNameCol || BULK_ONBOARD_LOC;
  const usedSerials = new Set();
  for (let i = 1; i <= count; i++) {
    let serial;
    for (let t = 0; t < 500; t++) {
      serial = generateSerial(deviceType);
      if (!usedSerials.has(serial)) break;
    }
    usedSerials.add(serial);
    const mac = generateRandomMac();
    lines.push(`Dev-${i},${serial},${loc},${mac},,,`);
  }
  fs.writeFileSync(BULK_CSV_STAGING, `${lines.join('\n')}\n`, 'utf8');
  return BULK_CSV_STAGING;
}

/** Staging CSV with NHB rows first, then HB rows (mixed bulk upload). */
function writeBulkDeviceStagingCsvMixed(nhbCount, hbCount, locationNameCol) {
  const nhb = normalizeMixCount(nhbCount);
  const hb = normalizeMixCount(hbCount);
  const lines = [readBulkCsvHeaderLine()];
  const loc = locationNameCol || BULK_ONBOARD_LOC;
  const usedSerials = new Set();
  let i = 1;
  function pushOne(deviceType) {
    let serial;
    for (let t = 0; t < 500; t++) {
      serial = generateSerial(deviceType);
      if (!usedSerials.has(serial)) break;
    }
    usedSerials.add(serial);
    const mac = generateRandomMac();
    lines.push(`Dev-${i},${serial},${loc},${mac},,,`);
    i += 1;
  }
  for (let k = 0; k < nhb; k++) pushOne('NHB');
  for (let k = 0; k < hb; k++) pushOne('HB');
  fs.writeFileSync(BULK_CSV_STAGING, `${lines.join('\n')}\n`, 'utf8');
  return BULK_CSV_STAGING;
}

function addDeviceDialogRoot(page) {
  return page.locator('[role="dialog"]').filter({ has: page.getByRole('heading', { name: /Add Device/i }) }).first();
}

function isPlaywrightClosedError(e) {
  const m = (e && e.message) || '';
  return /Target page, context or browser has been closed|Browser has been closed/i.test(m);
}

/** Avoid throwing when the user closed Chromium mid-flow. */
async function safePageWait(page, ms) {
  try {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
    await page.waitForTimeout(ms);
  } catch (e) {
    if (isPlaywrightClosedError(e)) return;
    throw e;
  }
}

function bulkRemainingMs(deadlineTs) {
  return Math.max(0, deadlineTs - Date.now());
}

/**
 * Org/location before CSV: strict "Add Device" filter sometimes matches a dialog shell with 0 comboboxes
 * (MUI mounts selects in a nested dialog or sibling). Prefer any visible dialog that has MUI/native selects.
 */
async function bulkPreUploadDialogRoot(page) {
  const strict = addDeviceDialogRoot(page);
  const comboCount = async (loc) =>
    loc.locator('.MuiSelect-root [role="combobox"], div[role="combobox"]').count();

  if (await strict.isVisible({ timeout: 2000 }).catch(() => false)) {
    const n = await comboCount(strict);
    if (n > 0) return strict;
  }

  const dialogs = page.locator('[role="dialog"]');
  const total = await dialogs.count();
  for (let i = 0; i < total; i++) {
    const d = dialogs.nth(i);
    if (!(await d.isVisible({ timeout: 500 }).catch(() => false))) continue;
    const n = await comboCount(d);
    if (n > 0) return d;
  }
  return strict;
}

/** Max wall time for org-dropdown wait + org/location combobox selection before CSV upload (user: skip long retries). */
const BULK_PREUPLOAD_ORG_LOC_BUDGET_MS = 3000;

/**
 * Max time to **poll** for View Device List or an **enabled** Next after parse.
 * This is only the first sub-step; validation grid + Update + summary can add tens of seconds more (see logs).
 * Default 120s — UI often needs 30–90s before Next enables; 5s was misleading and too tight.
 */
const BULK_NEXT_AFTER_PARSE_MS =
    Number(process.env.BULK_NEXT_AFTER_PARSE_MS) > 0
        ? Number(process.env.BULK_NEXT_AFTER_PARSE_MS)
        : 120000;

/**
 * Step 5 = `completeBulkSetupSummaryAndDismiss` (View Device List / close after summary).
 * Skip can shorten the tail of the flow; the Add Device dialog may stay open — close manually if needed.
 * Restore full behavior: `BULK_CSV_SKIP_STEP5_DISMISS=0` or `false` (default here is skip-on for timing experiment).
 */
const BULK_CSV_SKIP_STEP5_DISMISS =
    process.env.BULK_CSV_SKIP_STEP5_DISMISS === '0' || process.env.BULK_CSV_SKIP_STEP5_DISMISS === 'false'
        ? false
        : true;

const BULK_CSV_EVIDENCE_DIR = path.join(WORKSPACE_ROOT, 'test-results', 'bulk-csv-evidence');

/** Full-page PNG evidence for bulk flow (served as /artifacts/test-results/bulk-csv-evidence/... from dashboard). */
async function bulkCsvEvidenceScreenshot(page, stepSlug) {
    try {
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return null;
        fs.mkdirSync(BULK_CSV_EVIDENCE_DIR, { recursive: true });
        const safe = String(stepSlug || 'step').replace(/[^a-zA-Z0-9._-]+/g, '-');
        const filename = `${Date.now()}-${safe}.png`;
        const abs = path.join(BULK_CSV_EVIDENCE_DIR, filename);
        await page.screenshot({ path: abs, fullPage: true });
        const rel = path.relative(WORKSPACE_ROOT, abs).replace(/\\/g, '/');
        console.log(`[bulk-csv] Evidence screenshot: ${rel}`);
        return abs;
    } catch (e) {
        console.warn('[bulk-csv] Evidence screenshot failed:', e.message || e);
        return null;
    }
}

/** Match validation text in bulk grid (tbody rows) — location, serial, duplicate, etc. */
const BULK_VALIDATION_ERROR_RE =
  /Location does not match|does not match|Select Location|invalid serial|invalid|duplicate|already exists|not recognized|not valid|serial number|must be|required field|failed|error/i;

/** Overwritten each bulk run — full Add Device dialog DOM for selector / flow fixes. */
const LAST_ADD_DEVICE_DIALOG_SNAPSHOT = path.join(__dirname, 'last-add-device-dialog-snapshot.html');

async function captureBulkAddDeviceDebug(page, dialog, reason) {
  const stamp = Date.now();
  const base = path.join(__dirname, `bulk-add-debug-${stamp}`);
  try {
    const text = await dialog.innerText().catch(() => '');
    fs.writeFileSync(`${base}.txt`, `${reason}\n\n${text}`.slice(0, 400000), 'utf8');
    const html = await dialog.evaluate((el) => el.outerHTML || '').catch(() => '');
    if (html) {
      fs.writeFileSync(`${base}-dialog-dom.html`, html.slice(0, 1_200_000), 'utf8');
      console.warn('[bulk-csv] Debug dump:', `${base}.txt`, '+', `${base}-dialog-dom.html`);
    } else {
      console.warn('[bulk-csv] Debug dump:', `${base}.txt`);
    }
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  } catch (e) {
    console.warn('[bulk-csv] Debug capture failed:', e.message);
  }
}

/** Save current Add Device dialog HTML (success or failure) for the next self-serve selector update. */
async function writeLastAddDeviceDialogSnapshot(page) {
  try {
    if (typeof page.isClosed === 'function' && page.isClosed()) return;
    const dialog = addDeviceDialogRoot(page);
    if (!(await dialog.isVisible({ timeout: 2000 }).catch(() => false))) return;
    const html = await dialog.evaluate((el) => el.outerHTML || '').catch(() => '');
    if (!html) return;
    const u = page.url();
    const pre = `<!-- snapshot ${new Date().toISOString()} ${u} -->\n`;
    fs.writeFileSync(LAST_ADD_DEVICE_DIALOG_SNAPSHOT, (pre + html).slice(0, 2_000_000), 'utf8');
    console.log('[bulk-csv] Dialog DOM snapshot (overwrite):', LAST_ADD_DEVICE_DIALOG_SNAPSHOT);
  } catch (e) {
    console.warn('[bulk-csv] last dialog snapshot skipped:', e.message);
  }
}

/**
 * Click the [+] / chevron on a tree row (do not use /org/i on row text — matches "All Organizations").
 */
async function expandAddDeviceTreeRow(page, row) {
  const btn = row.locator('button').first();
  if (await btn.isVisible({ timeout: 700 }).catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(600);
    return;
  }
  const svg = row.locator('svg').first();
  if (await svg.isVisible({ timeout: 500 }).catch(() => false)) {
    await svg.click();
    await page.waitForTimeout(600);
    return;
  }
  const img = row.locator('img').first();
  if (await img.isVisible({ timeout: 500 }).catch(() => false)) await img.click();
  else await row.click();
  await page.waitForTimeout(600);
}

function normalizeAddDeviceTreeLabel(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Tree row whose label is exactly `text` (scoped to popper — avoids matching "All Organizations" for "org"). */
function treeItemExact(popper, text) {
  const label = String(text).trim();
  return popper.getByRole('treeitem').filter({ has: popper.getByText(label, { exact: true }) });
}

/**
 * Single-device Select Location tree uses stable id prefixes (not always .org-tree-item[data-type]).
 * Match user flow: click `[id^=org-dropdown-tree-expand-] ... svg` then `[id^=org-dropdown-tree-item-typography-]/div`.
 */
async function tryPickOrgLocViaInsightDropdownTreeIds(page, orgName, locationName) {
  const root = page.locator('#org-tree-popper-addDeviceAllOrg');
  if (!(await root.isVisible({ timeout: 1200 }).catch(() => false))) return false;

  const normArg = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();

  const clickExpandForLabel = async (name) =>
    root.evaluate((el, wantRaw) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = norm(wantRaw);
      const typos = el.querySelectorAll('[id^="org-dropdown-tree-item-typography-"]');
      for (const typo of typos) {
        const label = norm(typo.innerText || typo.textContent || '');
        if (label === 'all organizations') continue;
        if (label !== want) continue;
        const row =
          typo.closest('[role="treeitem"]') ||
          typo.closest('.MuiTreeItem-root') ||
          typo.closest('[class*="TreeItem"]') ||
          typo.parentElement;
        if (!row) continue;
        const expand = row.querySelector('[id^="org-dropdown-tree-expand-"]');
        if (!expand) continue;
        const svg =
          expand.querySelector(':scope > div > svg') ||
          expand.querySelector('div svg') ||
          expand.querySelector('svg');
        if (svg) {
          svg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        }
      }
      return false;
    }, name);

  const clickTypographyDivForLabel = async (name) =>
    root.evaluate((el, wantRaw) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = norm(wantRaw);
      const typos = el.querySelectorAll('[id^="org-dropdown-tree-item-typography-"]');
      for (const typo of typos) {
        const label = norm(typo.innerText || typo.textContent || '');
        if (label === 'all organizations') continue;
        if (label !== want) continue;
        const div = typo.querySelector(':scope > div');
        if (div) {
          div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        }
        typo.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      }
      return false;
    }, name);

  if (!orgName || !locationName) return false;
  if (normArg(orgName) === 'all organizations') return false;

  const orgEx = await clickExpandForLabel(orgName);
  if (!orgEx) return false;
  console.log('[add-device] Insight tree: clicked org expand (org-dropdown-tree-expand-* → svg)');
  await page.waitForTimeout(600);

  const orgTy = await clickTypographyDivForLabel(orgName);
  if (!orgTy) return false;
  console.log('[add-device] Insight tree: clicked org label div (org-dropdown-tree-item-typography-* / div)');
  await page.waitForTimeout(500);

  await clickExpandForLabel(locationName);
  await page.waitForTimeout(500);

  const locTy = await clickTypographyDivForLabel(locationName);
  if (!locTy) return false;
  console.log('[add-device] Insight tree: clicked location label div');
  await page.waitForTimeout(400);
  return true;
}

/**
 * Find org or location row inside the add-device popper. Uses .org-tree-item[data-type] first (Insight),
 * then role=treeitem, comparing first-line / full text — avoids getByText('org') failing when the label
 * is not a single text node, and avoids /org/i matching "All Organizations".
 */
async function findAddDeviceTreeNode(popper, wantLabel, kind) {
  const want = normalizeAddDeviceTreeLabel(wantLabel);
  if (!want) return null;

  const typeAttr = kind === 'loc' ? 'Loc' : 'Org';
  const typed = popper.locator(`.org-tree-item[data-type="${typeAttr}"]`);
  const nTyped = await typed.count();
  for (let i = 0; i < nTyped; i++) {
    const el = typed.nth(i);
    const raw = await el.innerText().catch(() => '');
    const firstLine = normalizeAddDeviceTreeLabel(raw.split('\n')[0] || '');
    const full = normalizeAddDeviceTreeLabel(raw);
    if (firstLine === 'all organizations' || full === 'all organizations') continue;
    if (firstLine === want || full === want) return el;
  }

  const items = popper.getByRole('treeitem');
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const row = items.nth(i);
    const raw = await row.innerText().catch(() => '');
    const firstLine = normalizeAddDeviceTreeLabel(raw.split('\n')[0] || '');
    const full = normalizeAddDeviceTreeLabel(raw);
    if (firstLine === 'all organizations' || full === 'all organizations') continue;
    if (firstLine === want || full === want) return row;
  }
  return null;
}

/**
 * Single-device modal: Select Location tree is All Organizations → [+] → org → [+] → loc.
 * Regex /org/i wrongly matched "All Organizations"; use exact labels + explicit root expand.
 */
async function selectLocationInAddDeviceDialog(page, pick) {
  const orgName = pick.orgName && String(pick.orgName).trim() ? String(pick.orgName).trim() : '';
  const locationName = pick.locationName && String(pick.locationName).trim() ? String(pick.locationName).trim() : '';
  const t = SINGLE_DEVICE_ORG_TREE_MS;
  const nav = SINGLE_DEVICE_TREE_NAV_MS;

  const locDropdown = page.locator('#org-dropdown-button-addDeviceAllOrg');
  const popper = page.locator('#org-tree-popper-addDeviceAllOrg');

  await page.waitForTimeout(400);
  const hasLocDropdown = await waitUntilLocatorVisible(page, locDropdown, t);
  if (!hasLocDropdown) {
    console.log('[add-device] Org dropdown not visible within', t, 'ms');
  }

  async function expandAllOrganizationsRoot(pop) {
    const root = pop
      .getByRole('treeitem')
      .filter({ has: pop.getByText('All Organizations', { exact: true }) })
      .first();
    if (await root.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('[add-device] Expanding "All Organizations" (+) to reveal orgs…');
      await expandAddDeviceTreeRow(page, root);
    }
  }

  async function pickOrgAndLocExact(pop) {
    await expandAllOrganizationsRoot(pop);
    if (!orgName || !locationName) {
      throw new Error('selectLocationInAddDeviceDialog: org and location names required for exact tree pick');
    }
    await page.waitForTimeout(400);

    if (await tryPickOrgLocViaInsightDropdownTreeIds(page, orgName, locationName)) {
      return;
    }

    try {
      const orgRowTi = treeItemExact(pop, orgName).first();
      if (await orgRowTi.isVisible({ timeout: 2500 }).catch(() => false)) {
        console.log('[add-device] Expanding org', JSON.stringify(orgName), 'via treeitem + exact text…');
        await expandAddDeviceTreeRow(page, orgRowTi);
        await page.waitForTimeout(500);
        const locRowTi = treeItemExact(pop, locationName).first();
        if (await locRowTi.isVisible({ timeout: nav }).catch(() => false)) {
          console.log('[add-device] Selecting location', JSON.stringify(locationName), '(treeitem exact)');
          await locRowTi.click();
          await page.waitForTimeout(400);
          return;
        }
      }
    } catch (_) {
      /* fall through to data-type scan */
    }

    await page.waitForTimeout(400);
    let orgRow = await findAddDeviceTreeNode(pop, orgName, 'org');
    if (!orgRow) {
      await page.waitForTimeout(800);
      orgRow = await findAddDeviceTreeNode(pop, orgName, 'org');
    }
    if (!orgRow) {
      throw new Error(
        `Org "${orgName}" not found under All Organizations (Insight tree ids / treeitem / .org-tree-item scan).`
      );
    }
    await orgRow.waitFor({ state: 'visible', timeout: nav });
    console.log('[add-device] Expanding org', JSON.stringify(orgName), '(+)…');
    await expandAddDeviceTreeRow(page, orgRow);
    await page.waitForTimeout(500);
    let locRow = await findAddDeviceTreeNode(pop, locationName, 'loc');
    if (!locRow) {
      await page.waitForTimeout(800);
      locRow = await findAddDeviceTreeNode(pop, locationName, 'loc');
    }
    if (!locRow) {
      throw new Error(`Location "${locationName}" not found under org (Loc row scan).`);
    }
    await locRow.waitFor({ state: 'visible', timeout: nav });
    console.log('[add-device] Selecting location', JSON.stringify(locationName));
    await locRow.click();
    await page.waitForTimeout(400);
  }

  async function pickLocViaDomTypes(pop) {
    await expandAllOrganizationsRoot(pop);
    const namedOrg = pop
      .locator('.org-tree-item[data-type="Org"]')
      .filter({ hasText: new RegExp(`^\\s*${escapeRe(orgName || '')}\\s*$`, 'i') })
      .first();
    if (orgName && (await namedOrg.isVisible({ timeout: 1200 }).catch(() => false))) {
      await expandAddDeviceTreeRow(page, namedOrg);
    } else {
      const anyOrg = pop.locator('.org-tree-item[data-type="Org"]').first();
      if (await anyOrg.isVisible({ timeout: 1200 }).catch(() => false)) await expandAddDeviceTreeRow(page, anyOrg);
    }
    const locEl = pop
      .locator('.org-tree-item[data-type="Loc"]')
      .filter({ hasText: new RegExp(`^\\s*${escapeRe(locationName || '')}\\s*$`, 'i') })
      .first();
    if (await locEl.isVisible({ timeout: nav }).catch(() => false)) {
      await locEl.click();
      await page.waitForTimeout(400);
      return true;
    }
    const locRow = await findAddDeviceTreeNode(pop, locationName || '', 'loc');
    if (locRow && (await locRow.isVisible({ timeout: 2000 }).catch(() => false))) {
      await locRow.click();
      await page.waitForTimeout(400);
      return true;
    }
    return false;
  }

  if (hasLocDropdown) {
    await locDropdown.click();
    await page.waitForTimeout(400);
    await popper.waitFor({ state: 'visible', timeout: t }).catch(() => {});
    await page.waitForTimeout(300);

    if (locationName && orgName) {
      try {
        await pickOrgAndLocExact(popper);
      } catch (e) {
        console.log('[add-device] Exact treeitem path failed, trying data-type nodes:', e.message);
        const ok = await pickLocViaDomTypes(popper);
        if (!ok) throw e;
      }
      return;
    }

    if (locationName) {
      await expandAllOrganizationsRoot(popper);
      const firstOrg = popper.locator('.org-tree-item[data-type="Org"]').first();
      if (await firstOrg.isVisible({ timeout: nav }).catch(() => false)) {
        await expandAddDeviceTreeRow(page, firstOrg);
      } else {
        const anyOrgRow = popper.getByRole('treeitem').nth(1);
        if (await anyOrgRow.isVisible({ timeout: 800 }).catch(() => false)) await expandAddDeviceTreeRow(page, anyOrgRow);
      }
      const locRow =
        (await findAddDeviceTreeNode(popper, locationName, 'loc')) || popper.locator('.org-tree-item[data-type="Loc"]').first();
      await locRow.waitFor({ state: 'visible', timeout: nav });
      await locRow.click();
      await page.waitForTimeout(400);
      return;
    }

    await expandAllOrganizationsRoot(popper);
    let orgRow = orgName ? await findAddDeviceTreeNode(popper, orgName, 'org') : null;
    if (!orgRow) orgRow = popper.locator('.org-tree-item[data-type="Org"]').first();
    await orgRow.waitFor({ state: 'visible', timeout: nav });
    await expandAddDeviceTreeRow(page, orgRow);
    const locScoped = popper.locator('.org-tree-item[data-type="Loc"]').first();
    if (await locScoped.isVisible({ timeout: nav }).catch(() => false)) await locScoped.click();
    else await popper.getByRole('treeitem').nth(2).click();
    await page.waitForTimeout(400);
    return;
  }

  console.log('[add-device] No #org-dropdown-button-addDeviceAllOrg — dialog fallback…');
  await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .MuiDialog-root'));
    if (dialogs.length > 0) {
      const activeDialog = dialogs[dialogs.length - 1];
      const dd = activeDialog.querySelector('div[role="button"]:not([aria-disabled="true"])');
      if (dd) dd.click();
    }
  });
  await page.waitForTimeout(600);
  await popper.waitFor({ state: 'visible', timeout: t }).catch(() => {});

  if (locationName && orgName) {
    try {
      await pickOrgAndLocExact(popper);
    } catch (e) {
      const ok = await pickLocViaDomTypes(popper);
      if (!ok) {
        throw new Error(
          `Location not found: "${locationName}" (${e.message}). Expand All Organizations → org → loc in UI.`
        );
      }
    }
  } else if (locationName) {
    await expandAllOrganizationsRoot(popper);
    const firstOrg = popper.locator('.org-tree-item[data-type="Org"]').first();
    if (await firstOrg.isVisible({ timeout: nav }).catch(() => false)) await expandAddDeviceTreeRow(page, firstOrg);
    const locRow =
      (await findAddDeviceTreeNode(popper, locationName, 'loc')) || popper.locator('.org-tree-item[data-type="Loc"]').first();
    await locRow.waitFor({ state: 'visible', timeout: nav });
    await locRow.click();
  } else {
    await page.evaluate(() => {
      const locNodes = Array.from(document.querySelectorAll('.org-tree-item[data-type="Loc"]'));
      if (locNodes.length > 0) locNodes[0].click();
    });
  }
  await page.waitForTimeout(500);
}

/**
 * Wait for org dropdown button to be ready and fully rendered.
 * This ensures the dialog is prepared before we upload the CSV.
 */
async function waitForOrgDropdownReady(page, timeoutMs = 12000) {
  const dialog = await bulkPreUploadDialogRoot(page);
  const start = Date.now();
  
  console.log('[bulk-csv] Waiting for org dropdown to be ready...');
  
  while (Date.now() - start < timeoutMs) {
    if (typeof page.isClosed === 'function' && page.isClosed()) return false;
    
    try {
      // Check for the combobox that represents org selection
      const combos = dialog.getByRole('combobox');
      const n = await combos.count().catch(() => 0);
      
      if (n > 0) {
        // Get first combobox and verify it's visible
        const firstCombo = combos.first();
        if (await firstCombo.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log('[bulk-csv] Org dropdown ready');
          return true;
        }
      }
      
      // Also check for MUI select
      const muiSelect = dialog.locator('.MuiSelect-root').first();
      if (await muiSelect.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log('[bulk-csv] MUI select ready');
        return true;
      }
    } catch (e) {
      if (isPlaywrightClosedError(e)) return false;
    }
    
    await safePageWait(page, 300);
  }
  
  console.warn('[bulk-csv] Org dropdown ready timeout - continuing (may use defaults)');
  return false;
}
async function addSingleDeviceViaNavigator(page, deviceType, deviceIndex, locPick) {
  const addHeading = page.getByRole('heading', { name: /Add Device/i }).first();

  if (!page.url().includes('/devices')) {
    await page.goto(`${insightEnv.originForSession()}/mspHome/devices`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(3000);
  }

  const addBtn = page
    .getByRole('button', { name: /^Add$/i })
    .or(page.getByRole('button', { name: /add device/i }))
    .first();
  await addBtn.waitFor({ state: 'visible', timeout: 15000 });
  await addBtn.click();
  await addHeading.waitFor({ state: 'visible', timeout: 20000 });

  const singleRadio = page.getByRole('radio', { name: /single/i });
  if (await singleRadio.isVisible({ timeout: 6000 }).catch(() => false)) {
    await singleRadio.click();
    await page.waitForTimeout(1200);
  }

  await selectLocationInAddDeviceDialog(page, locPick);

  const serial = generateSerial(deviceType);
  const mac = generateRandomMac();
  const devName = `Nav-${String(deviceIndex + 1).padStart(4, '0')}`;

  const serialEl = page.locator('#serialNumber');
  if (await serialEl.isVisible({ timeout: 8000 }).catch(() => false)) {
    await serialEl.fill(serial);
  } else {
    const serialInput = page.locator('input[type="text"]').first();
    await serialInput.click();
    await page.keyboard.type(serial, { delay: 45 });
  }

  await page.waitForFunction(() => document.querySelectorAll('input[type="text"]').length >= 2, { timeout: 12000 }).catch(() => {});

  const nameEl = page.locator('#deviceName');
  if (await nameEl.isVisible({ timeout: 5000 }).catch(() => false)) {
    await nameEl.fill(devName);
  } else {
    const allInputs = await page.locator('input[type="text"]').all();
    if (allInputs.length >= 2) await allInputs[1].fill(devName);
  }

  const macEl = page.locator('#macAddress');
  if (await macEl.isVisible({ timeout: 4000 }).catch(() => false)) {
    await macEl.fill(mac);
  } else {
    const allInputs = await page.locator('input[type="text"]').all();
    if (allInputs.length >= 3) await allInputs[2].fill(mac);
    else {
      await page.evaluate(
        (data) => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
          if (inputs.length > 2) {
            inputs[2].value = data.mac;
            inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
            inputs[2].dispatchEvent(new Event('change', { bubbles: true }));
          }
        },
        { mac }
      );
    }
  }

  await page.waitForTimeout(500);

  const modalAdd = page.getByRole('button', { name: 'Add' }).last();
  if (await modalAdd.isVisible({ timeout: 5000 }).catch(() => false) && !(await modalAdd.isDisabled())) {
    await modalAdd.click();
  } else {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const addSubmit = buttons.find((b) => b.innerText.trim() === 'Add' && !b.disabled && b.type === 'button');
      if (addSubmit) addSubmit.click();
    });
  }

  await page.waitForTimeout(4000);
  await dismissTrialPopupIfAny(page);
  await addHeading.waitFor({ state: 'hidden', timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(800);

  return { serial, mac, devName };
}

/**
 * Multiple-device step: ensure org matches onboarding (default "org"). Optional override from UI.
 */
async function ensureBulkUploadOrgSelection(page, wantOrgName, deadlineTs = Infinity) {
  const target = wantOrgName && String(wantOrgName).trim() ? String(wantOrgName).trim() : BULK_ONBOARD_ORG;
  if (bulkRemainingMs(deadlineTs) < 50) {
    console.log('[bulk-csv] Org selection skipped (pre-upload time budget exhausted)');
    return;
  }
  const dialog = await bulkPreUploadDialogRoot(page);
  const combos = dialog.getByRole('combobox');
  const n = await combos.count();
  for (let i = 0; i < n; i++) {
    if (bulkRemainingMs(deadlineTs) < 50) return;
    const c = combos.nth(i);
    if (!(await c.isVisible({ timeout: 500 }).catch(() => false))) continue;
    const label = await c.getAttribute('aria-label').catch(() => '');
    const t = await c.innerText().catch(() => '');
    if (n > 1 && label && !/org|organization/i.test(label) && !/org|organization/i.test(t)) continue;
    if (new RegExp(escapeRe(target), 'i').test(t || '')) {
      console.log('[bulk-csv] Org already selected:', target);
      return;
    }
    await c.click();
    await safePageWait(page, Math.min(400, bulkRemainingMs(deadlineTs) || 400));
    const opt = page.getByRole('option', { name: new RegExp(escapeRe(target), 'i') }).first();
    const optWait = Math.min(2500, Math.max(300, bulkRemainingMs(deadlineTs)));
    if (optWait > 200 && (await opt.isVisible({ timeout: optWait }).catch(() => false))) {
      await opt.click();
      await safePageWait(page, 600);
      console.log('[bulk-csv] Selected org:', target);
      return;
    }
    await page.keyboard.press('Escape');
  }

  if (bulkRemainingMs(deadlineTs) < 100) return;
  const muiFirst = dialog.locator('.MuiSelect-root [role="combobox"]').first();
  if (await muiFirst.isVisible({ timeout: Math.min(1500, bulkRemainingMs(deadlineTs)) }).catch(() => false)) {
    const t0 = await muiFirst.innerText().catch(() => '');
    if (!new RegExp(escapeRe(target), 'i').test(t0 || '')) {
      await muiFirst.click();
      await safePageWait(page, Math.min(400, bulkRemainingMs(deadlineTs) || 400));
      const opt = page.getByRole('option', { name: new RegExp(escapeRe(target), 'i') }).first();
      const ow = Math.min(3000, Math.max(250, bulkRemainingMs(deadlineTs)));
      if (ow > 200 && (await opt.isVisible({ timeout: ow }).catch(() => false))) {
        await opt.click();
        await safePageWait(page, 600);
        console.log('[bulk-csv] Selected org (MuiSelect first combo):', target);
        return;
      }
      await page.keyboard.press('Escape').catch(() => {});
    } else {
      console.log('[bulk-csv] Org already shown on first MuiSelect:', target);
      return;
    }
  }
  console.log('[bulk-csv] Org combobox not matched; UI default kept');
}

/**
 * Pre-upload step: MUI Select for Location (gray "Select Location" span inside role=combobox).
 * Second combobox after org is the usual order; also match by visible placeholder text.
 */
async function pickBulkPreUploadLocationCombo(dialog) {
  const byPlaceholder = dialog.locator('div[role="combobox"]').filter({ hasText: /Select Location/i }).first();
  if (await byPlaceholder.isVisible({ timeout: 2500 }).catch(() => false)) return byPlaceholder;

  const muiLine = dialog.locator('.MuiSelect-root [role="combobox"]');
  const muiN = await muiLine.count();
  if (muiN === 1) {
    const one = muiLine.first();
    const t = await one.innerText().catch(() => '');
    if (/select location/i.test(t)) return one;
  }
  if (muiN >= 2) {
    const second = muiLine.nth(1);
    if (await second.isVisible({ timeout: 1500 }).catch(() => false)) return second;
  }

  const muiSecond = dialog.locator('.MuiSelect-root div[role="combobox"]').nth(1);
  if (await muiSecond.isVisible({ timeout: 1500 }).catch(() => false)) {
    const t = await muiSecond.innerText().catch(() => '');
    if (/select location|location/i.test(t)) return muiSecond;
  }

  const combos = dialog.getByRole('combobox');
  const n = await combos.count();
  if (n >= 2) {
    const second = combos.nth(1);
    if (await second.isVisible({ timeout: 800 }).catch(() => false)) return second;
  }
  if (n === 1) {
    const only = combos.first();
    const t = await only.innerText().catch(() => '');
    if (/select location|location/i.test(t) || String(t).trim() === '') return only;
  }
  return null;
}

/** If bulk uploader exposes a Location control before CSV, set it to match CSV/onboarding. */
async function ensureBulkUploadLocationCombobox(page, locationName, deadlineTs = Infinity) {
  const target = locationName && String(locationName).trim() ? String(locationName).trim() : BULK_ONBOARD_LOC;
  if (bulkRemainingMs(deadlineTs) < 50) {
    console.log('[bulk-csv] Location pre-select skipped (pre-upload time budget exhausted)');
    return;
  }
  const wantNorm = normalizeAddDeviceTreeLabel(target);
  const dialog = await bulkPreUploadDialogRoot(page);
  const table = dialog.locator('table');
  if (await table.isVisible({ timeout: 800 }).catch(() => false)) return;

  async function locationComboShowsSelection(combo) {
    if (!combo || !(await combo.isVisible({ timeout: 400 }).catch(() => false))) return false;
    const t = normalizeAddDeviceTreeLabel(await combo.innerText().catch(() => ''));
    if (!t || t === 'select location') return false;
    return t.includes(wantNorm) || wantNorm.includes(t);
  }

  for (let attempt = 1; bulkRemainingMs(deadlineTs) > 80 && attempt <= 3; attempt++) {
    const d = await bulkPreUploadDialogRoot(page);
    let combo = await pickBulkPreUploadLocationCombo(d);

    if (!combo) {
      const combos = d.getByRole('combobox');
      const n = await combos.count();
      for (let i = 0; i < n; i++) {
        const c = combos.nth(i);
        if (!(await c.isVisible({ timeout: 400 }).catch(() => false))) continue;
        const label = (await c.getAttribute('aria-label').catch(() => '')) || '';
        const t = (await c.innerText().catch(() => '')) || '';
        if (!/location|loc\b/i.test(label) && !/location|select location/i.test(t)) continue;
        combo = c;
        break;
      }
    }

    if (!combo) {
      console.log('[bulk-csv] Location combobox not found (attempt %d)', attempt);
      await safePageWait(page, Math.min(350, bulkRemainingMs(deadlineTs) || 350));
      continue;
    }

    if (await locationComboShowsSelection(combo)) {
      console.log('[bulk-csv] Pre-upload location already selected:', target);
      return;
    }

    await combo.click();
    const lbWait = Math.min(4000, Math.max(400, bulkRemainingMs(deadlineTs)));
    await page.getByRole('listbox').waitFor({ state: 'visible', timeout: lbWait }).catch(() => {});
    await safePageWait(page, Math.min(200, bulkRemainingMs(deadlineTs) || 200));

    const opt = page.getByRole('option', { name: new RegExp(`^${escapeRe(target)}$`, 'i') }).first();
    const optLoose = page.getByRole('option', { name: new RegExp(escapeRe(target), 'i') }).first();
    const ow = Math.min(3000, Math.max(200, bulkRemainingMs(deadlineTs)));
    let picked = false;
    if (ow > 200 && (await opt.isVisible({ timeout: ow }).catch(() => false))) {
      await opt.click();
      picked = true;
    } else if (ow > 200 && (await optLoose.isVisible({ timeout: ow }).catch(() => false))) {
      await optLoose.click();
      picked = true;
    }

    if (!picked) {
      await page.keyboard.press('Escape').catch(() => {});
      await safePageWait(page, Math.min(300, bulkRemainingMs(deadlineTs) || 300));
      continue;
    }

    await safePageWait(page, Math.min(400, bulkRemainingMs(deadlineTs) || 400));
    if (await page.getByRole('listbox').isVisible({ timeout: 500 }).catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => {});
    }

    const comboAfter = await pickBulkPreUploadLocationCombo(await bulkPreUploadDialogRoot(page));
    if (await locationComboShowsSelection(comboAfter)) {
      console.log('[bulk-csv] Pre-upload location combobox set:', target, '(attempt %d)', attempt);
      return;
    }

    console.log('[bulk-csv] Location selection did not stick (attempt %d), retrying…', attempt);
    await safePageWait(page, Math.min(350, bulkRemainingMs(deadlineTs) || 350));
  }

  console.warn('[bulk-csv] Could not confirm pre-upload location; continuing (table fix may recover)');
}

/**
 * Validation grid: set each row's Location dropdown to `locName` when it shows Select Location / mismatch (before Remove).
 */
async function fixBulkTableRowLocations(page, dialog, locName) {
  const target = locName || BULK_ONBOARD_LOC;
  const errOrPlaceholder = /Location does not match|does not match|Select Location|select location/i;

  const walkPages = async () => {
    let p = 0;
    while (p++ < 80) {
      const rows = dialog.locator('tbody tr');
      const n = await rows.count();
      for (let i = 0; i < n; i++) {
        const row = rows.nth(i);
        const needs = await row.getByText(errOrPlaceholder).first().isVisible({ timeout: 200 }).catch(() => false);
        if (!needs) continue;

        const sel = row.locator('select').first();
        if (await sel.isVisible({ timeout: 400 }).catch(() => false)) {
          await sel.selectOption({ label: new RegExp(escapeRe(target), 'i') }).catch(async () => {
            await sel.selectOption({ value: target }).catch(() => sel.selectOption({ index: 1 }));
          });
          await page.waitForTimeout(300);
          continue;
        }

        const combos = row.getByRole('combobox');
        const nc = await combos.count();
        for (let j = 0; j < nc; j++) {
          const combo = combos.nth(j);
          if (!(await combo.isVisible({ timeout: 300 }).catch(() => false))) continue;
          const txt = (await combo.innerText().catch(() => '')) || '';
          if (!/location|select/i.test(txt) && j < nc - 1) continue;
          await combo.click();
          await page.waitForTimeout(350);
          const exact = page.getByRole('option', { name: new RegExp(`^${escapeRe(target)}$`, 'i') }).first();
          const loose = page.getByRole('option', { name: new RegExp(escapeRe(target), 'i') }).first();
          if (await exact.isVisible({ timeout: 2000 }).catch(() => false)) await exact.click();
          else if (await loose.isVisible({ timeout: 2000 }).catch(() => false)) await loose.click();
          else {
            await page.keyboard.press('Escape');
            continue;
          }
          await page.waitForTimeout(250);
          break;
        }

        const locBtn = row.getByRole('button', { name: /select location/i }).first();
        if (await locBtn.isVisible({ timeout: 300 }).catch(() => false)) {
          await locBtn.click();
          await page.waitForTimeout(300);
          const opt2 = page.getByRole('option', { name: new RegExp(escapeRe(target), 'i') }).first();
          if (await opt2.isVisible({ timeout: 2000 }).catch(() => false)) await opt2.click();
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(200);
        }
      }
      const nextPage = dialog.getByRole('button', { name: /Go to next page/i });
      if (await nextPage.isEnabled().catch(() => false)) {
        await nextPage.click();
        await page.waitForTimeout(600);
        continue;
      }
      break;
    }
  };

  await walkPages();
  await page.waitForTimeout(500);
}

/** Select error rows, Remove, paginate until no error rows on any page. */
async function removeAllBulkRowsWithErrors(page, dialog) {
  const errRe = BULK_VALIDATION_ERROR_RE;
  let guard = 0;
  while (guard++ < 100) {
    let removedThisPass = false;
    const errorRows = dialog.locator('tbody tr').filter({ hasText: errRe });
    const rowCount = await errorRows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = errorRows.nth(i);
      const cb = row.locator('input[type="checkbox"]').first();
      if (await cb.isVisible({ timeout: 400 }).catch(() => false)) {
        await cb.check({ force: true }).catch(() => {});
        removedThisPass = true;
      }
    }
    if (removedThisPass) {
      const removeBtn = dialog.getByRole('button', { name: /^Remove$/i });
      if (await removeBtn.isEnabled({ timeout: 2000 }).catch(() => false)) {
        await removeBtn.click();
        await page.waitForTimeout(2000);
      }
      continue;
    }
    const nextPage = dialog.getByRole('button', { name: /Go to next page/i });
    if (await nextPage.isEnabled().catch(() => false)) {
      await nextPage.click();
      await page.waitForTimeout(700);
      continue;
    }
    break;
  }
}

async function clickUpdateDeviceListWhenReady(page, dialog) {
  const updateBtn = dialog.getByRole('button', { name: /update device list/i });
  if (!(await updateBtn.isVisible({ timeout: 2500 }).catch(() => false))) return false;
  if (await updateBtn.isDisabled().catch(() => true)) return false;
  await updateBtn.click();
  await safePageWait(page, 4000);
  return true;
}

/**
 * Wait for a parse-success affordance after file upload (CheckCircleIcon, SuccessOutlinedIcon in MuiAlert, or table rows).
 */
async function waitForBulkCsvParseSuccess(page, deviceCount) {
  const timeoutMs = Math.min(20000, Math.max(2500, 1500 + deviceCount * 25));
  const start = Date.now();

  console.log(`[bulk-csv] Waiting for parse success (timeout: ${timeoutMs}ms for ${deviceCount} devices)...`);

  while (Date.now() - start < timeoutMs) {
    if (typeof page.isClosed === 'function' && page.isClosed()) return false;

    try {
      const successIcon = page.locator('#success-icon');
      if (await successIcon.isVisible({ timeout: 300 }).catch(() => false)) {
        console.log('[bulk-csv] #success-icon — CSV upload success');
        await safePageWait(page, BULK_PARSE_SUCCESS_ICON_HOLD_MS);
        return true;
      }

      const checkCircle = page.locator('[data-testid="CheckCircleIcon"]');
      if (await checkCircle.first().isVisible({ timeout: 300 }).catch(() => false)) {
        console.log('[bulk-csv] CheckCircleIcon — CSV parsed successfully');
        await safePageWait(page, BULK_PARSE_SUCCESS_ICON_HOLD_MS);
        return true;
      }

      const successOutlined = page.locator('[data-testid="SuccessOutlinedIcon"]');
      if (await successOutlined.first().isVisible({ timeout: 300 }).catch(() => false)) {
        console.log('[bulk-csv] SuccessOutlinedIcon (MuiAlert) — CSV parsed successfully');
        await safePageWait(page, BULK_PARSE_SUCCESS_ICON_HOLD_MS);
        return true;
      }

      const dialog = addDeviceDialogRoot(page);
      const nRows = await dialog.locator('table tbody tr').count().catch(() => 0);
      if (nRows > 0) {
        console.log(`[bulk-csv] Table detected with ${nRows} rows - CSV parsed`);
        await safePageWait(page, BULK_PARSE_SUCCESS_ICON_HOLD_MS);
        return true;
      }
    } catch (e) {
      if (isPlaywrightClosedError(e)) return false;
    }
    
    await safePageWait(page, 200);
  }
  
  console.warn(`[bulk-csv] Parse success timeout (${timeoutMs}ms) - continuing anyway`);
  return false;
}

/**
 * After CSV parse, some builds show enabled **Next** (grid step); others jump straight to
 * **`#bulk-view-devices-btn`** (“View Device List”). MUI often keeps `disabled`/aria misleading — if the
 * button is **visible**, treat it as the path forward (click uses force fallback later if needed).
 * @returns {'viewDevices'|'next'|null}
 */
async function waitForBulkNextOrViewDeviceList(page, timeoutMs = BULK_NEXT_AFTER_PARSE_MS) {
  const start = Date.now();
  const viewBtn = page.locator('#bulk-view-devices-btn').first();
  const viewByRole = page.getByRole('button', { name: /view device list/i }).first();

  while (Date.now() - start < timeoutMs) {
    if (typeof page.isClosed === 'function' && page.isClosed()) return null;
    try {
      if (await viewBtn.isVisible({ timeout: 350 }).catch(() => false)) {
        console.log('[bulk-csv] View Device List visible (#bulk-view-devices-btn) — using it (skip strict enabled check)');
        await safePageWait(page, 150);
        return 'viewDevices';
      }
      if (await viewByRole.isVisible({ timeout: 250 }).catch(() => false)) {
        console.log('[bulk-csv] View Device List visible (role/name) — using it');
        await safePageWait(page, 150);
        return 'viewDevices';
      }
      const dialog = addDeviceDialogRoot(page);
      const dNext = dialog.getByRole('button', { name: /^Next$/i }).first();
      if (
        (await dNext.isVisible({ timeout: 350 }).catch(() => false)) &&
        (await dNext.isEnabled().catch(() => false))
      ) {
        await safePageWait(page, 200);
        return 'next';
      }
      const pNext = page.getByRole('button', { name: /^Next$/i }).first();
      if (
        (await pNext.isVisible({ timeout: 350 }).catch(() => false)) &&
        (await pNext.isEnabled().catch(() => false))
      ) {
        await safePageWait(page, 200);
        return 'next';
      }
    } catch (e) {
      if (isPlaywrightClosedError(e)) return null;
    }
    await safePageWait(page, 150);
  }

  if (await viewBtn.isVisible({ timeout: 800 }).catch(() => false)) return 'viewDevices';
  if (await viewByRole.isVisible({ timeout: 500 }).catch(() => false)) return 'viewDevices';

  console.warn(
    '[bulk-csv] Neither #bulk-view-devices-btn nor enabled Next within',
    timeoutMs,
    'ms'
  );
  return null;
}

async function clickBulkNextButton(page) {
  const dialog = addDeviceDialogRoot(page);
  const dNext = dialog.getByRole('button', { name: /^Next$/i }).first();
  if (
    (await dNext.isVisible({ timeout: 1200 }).catch(() => false)) &&
    (await dNext.isEnabled().catch(() => false))
  ) {
    await dNext.click();
    return;
  }
  const pNext = page.getByRole('button', { name: /^Next$/i }).first();
  await pNext.click();
}

const BULK_SUMMARY_POLL_MS = Number(process.env.BULK_SUMMARY_WAIT_MS) > 0 ? Number(process.env.BULK_SUMMARY_WAIT_MS) : 180000;

async function waitBulkSummaryOrTable(page) {
  const deadline = Date.now() + BULK_SUMMARY_POLL_MS;
  while (Date.now() < deadline) {
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      console.warn('[bulk-csv] waitBulkSummaryOrTable: page closed while waiting for summary');
      return;
    }
    try {
      const done =
        (await page.getByText(/Setup completed\.?/i).first().isVisible({ timeout: 500 }).catch(() => false)) ||
        (await page.locator('#bulk-view-devices-btn').first().isVisible({ timeout: 400 }).catch(() => false)) ||
        (await page
          .getByText(/devices failed|device\(s\) failed|failed to be added/i)
          .first()
          .isVisible({ timeout: 400 })
          .catch(() => false));
      if (done) break;
    } catch (e) {
      if (isPlaywrightClosedError(e)) return;
    }
    await safePageWait(page, 700);
  }
  await safePageWait(page, 800);
}

function parseFailedDeviceCountFromText(text) {
  if (!text) return null;
  const m = text.match(/(\d+)\s+devices?\s+failed/i) || text.match(/(\d+)\s+device\(s\)\s+failed/i);
  return m ? parseInt(m[1], 10) : null;
}

function readSerialsFromBulkCsv(csvPath, maxN = 12) {
  try {
    const raw = fs.readFileSync(csvPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => String(l).trim().length);
    const serials = [];
    for (let i = 1; i < lines.length && serials.length < maxN; i++) {
      const parts = String(lines[i]).split(',');
      const s = parts[1] && String(parts[1]).trim();
      if (s) serials.push(s);
    }
    return serials;
  } catch {
    return [];
  }
}

/** Capture Insight JSON: `{ response: { success, failed, ... }, info: [...] }` from bulk add. */
function installBulkDeviceApiListener(page) {
  const captured = [];
  const handler = async (response) => {
    try {
      const url = response.url();
      if (!/insight\.netgear\.com/i.test(url)) return;
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      const txt = await response.text().catch(() => '');
      if (!txt || txt.length > 600000) return;
      let j;
      try {
        j = JSON.parse(txt);
      } catch {
        return;
      }
      if (!j || !j.response || !Array.isArray(j.info)) return;
      captured.push({ url, body: j });
      const r = j.response;
      console.log(
        '[bulk-csv] Bulk device API:',
        url.split('?')[0],
        'success=',
        r.success,
        'failed=',
        r.failed,
        'info=',
        j.info.length
      );
    } catch {
      /* ignore */
    }
  };
  page.on('response', handler);
  return {
    getCaptured: () => captured,
    dispose: () => page.off('response', handler),
  };
}

function aggregateBulkApiResults(captured) {
  if (!captured || !captured.length) {
    return { apiSuccess: null, apiFailed: null, perRow: [], lastUrl: null };
  }
  const last = captured[captured.length - 1];
  const b = last.body;
  const r = b.response || {};
  let ok = 0;
  let bad = 0;
  for (const row of b.info || []) {
    if (row && row.status === true) ok++;
    else if (row && row.status === false) bad++;
  }
  const rows = b.info || [];
  /** Prefer per-row `status` when `info[]` is present — top-level success/failed can disagree. */
  const apiSuccess = rows.length ? ok : r.success != null ? Number(r.success) : ok;
  const apiFailed = rows.length ? bad : r.failed != null ? Number(r.failed) : bad;
  return {
    apiSuccess,
    apiFailed,
    perRow: rows,
    lastUrl: last.url,
  };
}

async function waitForBulkSaveNextEnabled(page, loc) {
  const start = Date.now();
  while (Date.now() - start < 25000) {
    if (await loc.isEnabled().catch(() => false)) return;
    await safePageWait(page, 250);
  }
}

async function clickBulkCsvSaveNext(page) {
  const ordered = [
    page.locator('#addDrawer-drawer button#save'),
    page.locator('#actionsBox button#save'),
    page.locator('button#save[data-field-label="Save"]'),
  ];
  for (const loc of ordered) {
    const btn = loc.first();
    if (await btn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await waitForBulkSaveNextEnabled(page, btn);
      await btn.click({ timeout: 12000 });
      console.log('[bulk-csv] Clicked Save/Next (#save) after CSV success');
      return;
    }
  }
  const fb = addDeviceDialogRoot(page).getByRole('button', { name: /^Next$/i }).first();
  if (await fb.isVisible({ timeout: 8000 }).catch(() => false)) {
    await waitForBulkSaveNextEnabled(page, fb);
    await fb.click({ timeout: 12000 });
    console.log('[bulk-csv] Clicked dialog Next (fallback)');
    return;
  }
  throw new Error('Bulk CSV: Save/Next not found after CSV upload');
}

async function waitForBulkReviewDrawerOrSummary(page, timeoutMs = BULK_SUMMARY_POLL_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (typeof page.isClosed === 'function' && page.isClosed()) return;
    const review = await page.locator('#bulk-review-drawer').isVisible({ timeout: 400 }).catch(() => false);
    const setup = await page
      .getByText(/Setup completed\.?/i)
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false);
    const alertEl = await page.locator('#bulk-setup-alert').isVisible({ timeout: 400 }).catch(() => false);
    if (review || setup || alertEl) return;
    await safePageWait(page, 500);
  }
}

async function bulkValidationFixShort(page, locCol, maxRounds) {
  for (let round = 0; round < maxRounds; round++) {
    let dialog = addDeviceDialogRoot(page);
    const errVisible = await dialog
      .getByText(BULK_VALIDATION_ERROR_RE)
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (!errVisible) break;
    await fixBulkTableRowLocations(page, dialog, locCol);
    dialog = addDeviceDialogRoot(page);
    await removeAllBulkRowsWithErrors(page, dialog);
    dialog = addDeviceDialogRoot(page);
    await clickUpdateDeviceListWhenReady(page, dialog);
    await safePageWait(page, 1200);
  }
}

async function closeBulkReviewDrawerAndVerifySerials(page, serials) {
  await safePageWait(page, 2000);
  const closeBtn = page.locator('#bulk-drawer-close-btn').first();
  if (await closeBtn.isVisible({ timeout: 15000 }).catch(() => false)) {
    await closeBtn.click();
    console.log('[bulk-csv] Closed bulk review (#bulk-drawer-close-btn)');
    await safePageWait(page, 1500);
  } else {
    console.warn('[bulk-csv] #bulk-drawer-close-btn not visible');
  }

  if (!page.url().includes('/devices')) {
    await page.goto(`${insightEnv.originForSession()}/mspHome/devices`, {
      waitUntil: 'domcontentloaded',
    });
    await safePageWait(page, 2000);
  }

  for (const sn of serials) {
    if (!sn) continue;
    const inGrid = page.locator('[data-field="serialNo"]').filter({ hasText: sn });
    const loose = page.getByText(sn, { exact: true });
    if (
      (await inGrid.first().isVisible({ timeout: 8000 }).catch(() => false)) ||
      (await loose.first().isVisible({ timeout: 4000 }).catch(() => false))
    ) {
      console.log('[bulk-csv] Verified serial visible on Devices:', sn);
      return { serialVerified: true, serial: sn };
    }
  }
  console.warn('[bulk-csv] No CSV serial matched visible text on Devices after close');
  return { serialVerified: false, serial: serials[0] || null };
}

/**
 * After bulk summary ("Setup completed." may appear for partial success too): click View Device List and close dialog.
 * Prefer stable `#bulk-view-devices-btn` (data-field-label="View Devices") over accessible name — MUI can vary.
 */
async function completeBulkSetupSummaryAndDismiss(page) {
  if (typeof page.isClosed === 'function' && page.isClosed()) {
    return { sawSetupCompleted: false, clickedViewDeviceList: false, pageClosed: true };
  }
  const sawSetup = await page.getByText(/Setup completed\.?/i).first().isVisible({ timeout: 1500 }).catch(() => false);

  const primary = page.locator('#bulk-view-devices-btn').first();
  if (await primary.isVisible({ timeout: 10000 }).catch(() => false)) {
    console.log('[bulk-csv] Clicking View Device List (#bulk-view-devices-btn) to complete bulk setup');
    await primary.click();
    await safePageWait(page, 1500);
    return { sawSetupCompleted: sawSetup, clickedViewDeviceList: true };
  }

  const vdl = page.getByRole('button', { name: /view device list/i });
  if (await vdl.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('[bulk-csv] Clicking View Device List (role/name fallback)');
    await vdl.click();
    await safePageWait(page, 1500);
    return { sawSetupCompleted: sawSetup, clickedViewDeviceList: true };
  }

  const close = page.locator('[role="dialog"]').getByRole('button', { name: /^close$/i }).or(page.locator('[aria-label="Close"]'));
  if (await close.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await close.first().click();
    return { sawSetupCompleted: sawSetup, clickedViewDeviceList: false };
  }
  return { sawSetupCompleted: sawSetup, clickedViewDeviceList: false };
}

/**
 * Devices → Add → Multiple devices → upload CSV → `#success-icon` → **Save/Next** (`#save`) → short validation fix if needed →
 * wait for bulk review → read bulk-add **API** (`response` + `info[]`) → **2s** → `#bulk-drawer-close-btn` → verify CSV serial on Devices grid.
 */
async function addDevicesBulkCsv(page, opts) {
  const orgPick = opts.orgName && String(opts.orgName).trim() ? String(opts.orgName).trim() : '';
  const locCol =
    opts.locationName && String(opts.locationName).trim() ? String(opts.locationName).trim() : BULK_ONBOARD_LOC;

  let count;
  let csvPath;
  if (opts.nhbCount != null && opts.hbCount != null) {
    const nhb = normalizeMixCount(opts.nhbCount);
    const hb = normalizeMixCount(opts.hbCount);
    count = nhb + hb;
    if (count < 1) {
      throw new Error('Add at least one device: set NHB and/or HB count.');
    }
    csvPath = writeBulkDeviceStagingCsvMixed(nhb, hb, locCol);
    console.log('[bulk-csv] Mixed CSV:', csvPath, 'NHB:', nhb, 'HB:', hb, 'total:', count, 'LOCATION:', locCol);
  } else {
    count = normalizeDeviceCount(opts.count);
    const deviceType = opts.deviceType === 'HB' ? 'HB' : 'NHB';
    csvPath = writeBulkDeviceStagingCsv(count, deviceType, locCol);
    console.log('[bulk-csv] Staging CSV:', csvPath, 'rows:', count, 'LOCATION:', locCol);
  }

  if (!page.url().includes('/devices')) {
    await page.goto(`${insightEnv.originForSession()}/mspHome/devices`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(3000);
  }

  const addBtn = page
    .getByRole('button', { name: /^Add$/i })
    .or(page.getByRole('button', { name: /add device/i }))
    .first();
  await addBtn.waitFor({ state: 'visible', timeout: 15000 });
  await addBtn.click();

  await page.getByRole('heading', { name: /Add Device/i }).first().waitFor({ state: 'visible', timeout: 20000 });

  const multipleRadio = page.getByRole('radio', { name: /multiple/i });
  await multipleRadio.waitFor({ state: 'visible', timeout: 15000 });
  await multipleRadio.click();
  await safePageWait(page, 1500);

  const preUploadEnd = Date.now() + BULK_PREUPLOAD_ORG_LOC_BUDGET_MS;
  console.log(
    `[bulk-csv] Pre-upload org/location budget ${BULK_PREUPLOAD_ORG_LOC_BUDGET_MS}ms — then CSV upload`
  );
  await waitForOrgDropdownReady(page, bulkRemainingMs(preUploadEnd));

  if (orgPick && bulkRemainingMs(preUploadEnd) > 0) {
    await ensureBulkUploadOrgSelection(page, orgPick, preUploadEnd);
  }
  if (locCol && bulkRemainingMs(preUploadEnd) > 0) {
    await ensureBulkUploadLocationCombobox(page, locCol, preUploadEnd);
  }

  await safePageWait(page, Math.min(400, Math.max(0, bulkRemainingMs(preUploadEnd)) || 300));

  const serialCandidates = readSerialsFromBulkCsv(csvPath);
  const fileInput = page.locator('input[type="file"]').first();
  const apiListener = installBulkDeviceApiListener(page);

  try {
    console.log('[bulk-csv] Uploading CSV (single attach)...');
    await fileInput.setInputFiles(csvPath);

    const parseSuccess = await waitForBulkCsvParseSuccess(page, count);
    if (!parseSuccess) {
      console.warn('[bulk-csv] Parse success affordance timeout — still trying Save Next');
      await safePageWait(page, 1200);
    }

    await page.locator('#success-icon').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {
      console.warn('[bulk-csv] #success-icon not visible — continuing');
    });

    await safePageWait(page, BULK_POST_PARSE_SETTLE_MS);
    await bulkCsvEvidenceScreenshot(page, '01-after-parse-settle');

    await clickBulkCsvSaveNext(page);
    await safePageWait(page, 1800);
    await bulkCsvEvidenceScreenshot(page, '02-after-save-next');

    await bulkValidationFixShort(page, locCol, 5);

    await waitForBulkReviewDrawerOrSummary(page);
    const sawSetup = await page
      .getByText(/Setup completed\.?/i)
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    await bulkCsvEvidenceScreenshot(page, '03-after-bulk-review-or-summary');

    await writeLastAddDeviceDialogSnapshot(page);

    const captured = apiListener.getCaptured();
    const agg = aggregateBulkApiResults(captured);

    let failedN = 0;
    if (agg.apiFailed != null && !Number.isNaN(Number(agg.apiFailed))) {
      failedN = Math.max(0, Number(agg.apiFailed));
    } else {
      const bulkText = await page.locator('#bulk-review-drawer').innerText().catch(() => '');
      const anyDlg = await page.locator('[role="dialog"]').first().innerText().catch(() => '');
      const parsed = parseFailedDeviceCountFromText(bulkText || anyDlg);
      if (parsed != null) failedN = parsed;
    }

    const verify = await closeBulkReviewDrawerAndVerifySerials(page, serialCandidates);
    await bulkCsvEvidenceScreenshot(page, '04-after-close-and-verify');

    if (failedN > 0) {
      console.warn('[bulk-csv] Reported failures (API row status preferred):', failedN);
    }

    return {
      added: Math.max(0, count - failedN),
      samples: [],
      failed: failedN,
      bulkCsvPath: csvPath,
      mode: 'multiple-csv',
      sawSetupCompleted: sawSetup,
      clickedViewDeviceList: false,
      navigatedToManageSubsAfterBulkCsv: false,
      lastDialogDomSnapshot: LAST_ADD_DEVICE_DIALOG_SNAPSHOT,
      bulkApiCaptured: captured.length,
      bulkApiSuccess: agg.apiSuccess,
      bulkApiFailed: agg.apiFailed,
      serialVerified: verify.serialVerified,
      verifiedSerial: verify.serial,
    };
  } finally {
    apiListener.dispose();
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {{ count: number, deviceType: string, orgName?: string, locationName?: string }} opts
 */
async function addDevicesBulk(page, opts) {
  const locationName =
    opts.locationName && String(opts.locationName).trim() ? String(opts.locationName).trim() : BULK_ONBOARD_LOC;
  const orgName =
    opts.orgName && String(opts.orgName).trim() ? String(opts.orgName).trim() : BULK_ONBOARD_ORG;

  if (opts.nhbCount != null && opts.hbCount != null) {
    const nhb = normalizeMixCount(opts.nhbCount);
    const hb = normalizeMixCount(opts.hbCount);
    const total = nhb + hb;
    if (total < 1) {
      throw new Error('Add at least one device: set NHB and/or HB count.');
    }
    console.log('[add-device] Mixed bulk CSV: NHB=%d HB=%d total=%d org=%s loc=%s', nhb, hb, total, orgName, locationName);
    return addDevicesBulkCsv(page, { ...opts, nhbCount: nhb, hbCount: hb, count: total });
  }

  const count = normalizeDeviceCount(opts.count);
  const deviceType = opts.deviceType === 'HB' ? 'HB' : 'NHB';
  // Always use Multiple devices + staging CSV (including count === 1). Single-device tree picker is flaky
  // on current MUI org dropdown ids; bulk org/location combobox + CSV is the supported path.
  console.log(
    '[add-device] %d device(s) → bulk CSV flow (Multiple devices), org=%s loc=%s',
    count,
    orgName,
    locationName
  );
  return addDevicesBulkCsv(page, opts);
}

app.get('/api/browser', (req, res) => res.json({ browser: sessionBrowser }));

app.get('/api/accounts', (req, res) => {
    res.json(getAccounts());
});

app.delete('/api/accounts/:index', (req, res) => {
    const index = parseInt(req.params.index);
    const accounts = getAccounts();
    
    if (index >= 0 && index < accounts.length) {
        accounts.splice(index, 1);
        saveAccounts(accounts);
    }
    
    res.json({ accounts });
});

function sanitizeBulkTag(raw) {
    const s = raw != null ? String(raw).trim() : '';
    const t = s.slice(0, 120);
    return t || 'Bulk Added';
}

app.post('/api/accounts/bulk', (req, res) => {
    const fromBody = insightEnv.parseInsightEnvFromBody(req.body);
    const bulkEnv = fromBody ?? insightEnv.getSessionInsightEnv();
    insightEnv.setSessionInsightEnv(bulkEnv);

    const bulkTag = sanitizeBulkTag(req.body && req.body.tag);

    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Text required' });
    
    // Extract emails using regex (updated to handle more characters like single quotes if present, but standard is fine)
    // The issue might be that the email doesn't strictly match the regex if it has unusual characters or whitespace issues.
    // Let's use a more permissive regex for basic email extraction
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const foundEmails = text.match(emailRegex) || [];
    
    // Fallback: if regex fails but it looks like a single email (e.g. just pasted one string with an @)
    if (foundEmails.length === 0 && text.includes('@') && !text.includes(' ')) {
        foundEmails.push(text.trim());
    }

    const uniqueEmails = [...new Set(foundEmails.map((e) => e.trim()))];

    const accounts = getAccounts();
    let addedCount = 0;
    let updatedCount = 0;

    uniqueEmails.forEach((cleanEmail) => {
        const idx = accounts.findIndex((a) => (typeof a === 'string' ? a : a.email) === cleanEmail);
        if (idx < 0) {
            accounts.push(newAccountRecord(cleanEmail, bulkTag, bulkEnv, { source: 'bulk_import' }));
            addedCount++;
            return;
        }
        const row = accounts[idx];
        if (typeof row === 'string') {
            accounts[idx] = {
                email: row,
                tag: bulkTag,
                insightEnv: bulkEnv,
                source: 'legacy',
                dateAdded: null,
            };
            updatedCount++;
            return;
        }
        const needTag = row.tag !== bulkTag;
        const needEnv = row.insightEnv !== bulkEnv;
        if (needTag || needEnv) {
            row.tag = bulkTag;
            row.insightEnv = bulkEnv;
            updatedCount++;
        }
    });

    if (addedCount > 0 || updatedCount > 0) saveAccounts(accounts);

    res.json({ added: addedCount, updated: updatedCount, tag: bulkTag, accounts });
});

function purchaseBodyToOpts(purchase) {
    if (!purchase || !purchase.enabled) return null;
    return {
        plan: purchase.plan === '3-Year' ? '3-Year' : '1-Year',
        qty: purchase.qty != null ? Number(purchase.qty) : 1,
        fillFullAddress: !!purchase.fillFullAddress,
        address: purchase.address || undefined,
        businessPurchase: !!purchase.businessPurchase,
        businessId: purchase.businessId ? String(purchase.businessId).trim() : undefined,
        taxIdTypeHint: purchase.taxIdTypeHint ? String(purchase.taxIdTypeHint).trim() : undefined,
        cardholder: purchase.cardholder ? String(purchase.cardholder).trim() : undefined,
        deviceContext:
            purchase.deviceContext === 'HB' || purchase.deviceContext === 'NHB'
                ? purchase.deviceContext
                : 'na',
        maxWaitMs: purchase.maxWaitMs != null ? Number(purchase.maxWaitMs) : 360000,
        card: purchase.card,
    };
}

/** Map UI country (ISO2) to classic Angular register `#countryCode` option label. */
function classicRegisterCountryLabel(iso2) {
    const k = String(iso2 || 'US').toUpperCase();
    const MAP = {
        US: 'United States of America',
        CA: 'Canada',
        GB: 'United Kingdom',
        AU: 'Australia',
        IN: 'India',
        DE: 'Germany',
        FR: 'France',
        JP: 'Japan',
        NL: 'Netherlands',
        SG: 'Singapore',
        MX: 'Mexico',
        BR: 'Brazil',
    };
    return MAP[k] || 'United States of America';
}

/**
 * Classic Insight signup at `{origin}/classic/#/register` (Angular multi-step).
 * Used when Navigator "Signup flow" = Old Flow — **not** auth-stg `signup`.
 * @returns {Promise<'created'|'exists'|'form_fail'>}
 */
async function registerInsightClassicOldFlow(page, email, countryIso) {
    const regUrl = `${insightEnv.originForSession()}/classic/#/register`;
    console.log(`[signup old flow] ${regUrl}`);
    await page.goto(regUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(4000);

    for (let w = 0; w < 25; w++) {
        const hasForm = await page.evaluate(
            () =>
                !!(
                    document.querySelector('#smart-form-register1 input') ||
                    document.querySelector('input[name="signupEmail"]') ||
                    document.querySelector('input[type=email]')
                )
        );
        if (hasForm) break;
        await page.waitForTimeout(2000);
    }

    const emailField = page.locator('input[name=signupEmail]').first();
    if ((await emailField.count()) === 0) {
        console.error('[signup old flow] Step 1 email field not found');
        await page.screenshot({ path: 'classic_register_no_email_field.png', fullPage: true }).catch(() => {});
        return 'form_fail';
    }
    await emailField.fill(email);
    await page.waitForTimeout(500);
    await page.locator('button:has-text("Next"):visible').first().click();
    await page.waitForTimeout(4000);

    let step2Loaded = false;
    for (let w = 0; w < 18; w++) {
        if ((await page.locator('input[name=confirmSignupEmail]').count()) > 0) {
            step2Loaded = true;
            break;
        }
        const body = await page.evaluate(() => (document.body ? document.body.innerText.substring(0, 900) : ''));
        if (
            /already registered|already exists|NETGEAR account already/i.test(body) ||
            body.includes('accounts2-stg') ||
            body.includes("page can't")
        ) {
            console.log('[signup old flow] Already-registered or redirect state detected');
            return 'exists';
        }
        if (/verify your email|Verify your email|check your inbox/i.test(body)) {
            console.log('[signup old flow] Verification / exists copy on step 2');
            return 'exists';
        }
        await page.waitForTimeout(2000);
    }
    if (!step2Loaded) {
        console.error('[signup old flow] Step 2 (Primary Contact) did not load');
        await page.screenshot({ path: 'classic_register_step2_fail.png', fullPage: true }).catch(() => {});
        return 'form_fail';
    }

    const countryLabel = classicRegisterCountryLabel(countryIso);

    await page.locator('input[name=confirmSignupEmail]').fill(email);
    await page.waitForTimeout(200);
    await page.locator('#authPwd').fill(DEFAULT_PW);
    await page.waitForTimeout(200);
    await page.locator('#confirmPassField').fill(DEFAULT_PW);
    await page.waitForTimeout(200);
    await page.locator('#firstName').fill('Test');
    await page.waitForTimeout(200);
    await page.locator('input[name=lastName]').fill('User');
    await page.waitForTimeout(200);

    try {
        await page.locator('#countryCode').selectOption({ label: countryLabel });
    } catch (e) {
        console.log('[signup old flow] country select failed, trying US:', e.message || e);
        try {
            await page.locator('#countryCode').selectOption({ label: 'United States of America' });
        } catch (e2) {
            console.log('[signup old flow] US fallback failed:', e2.message || e2);
        }
    }
    await page.waitForTimeout(800);

    await page.locator('input[name=phoneNo]').fill('7075558899');
    await page.waitForTimeout(400);

    const cbLabels = page.locator('label.checkbox.custom-pdding');
    const labelCount = await cbLabels.count();
    for (let li = 0; li < labelCount; li++) {
        await cbLabels.nth(li).click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(250);
    }
    await page.evaluate(() => {
        document.querySelectorAll('input[type=checkbox]').forEach((cb) => {
            if (!cb.checked) {
                cb.checked = true;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    });
    await page.waitForTimeout(400);

    let nextEnabled = false;
    for (let w = 0; w < 12; w++) {
        if ((await page.locator('#_ancSignUpReg').count()) === 0) break;
        const disabled = await page.locator('#_ancSignUpReg').getAttribute('disabled');
        if (disabled === null) {
            nextEnabled = true;
            break;
        }
        if (w === 6) {
            await page.locator('#authPwd').click();
            await page.locator('#authPwd').press('Tab');
            await page.waitForTimeout(400);
            await page.locator('#confirmPassField').click();
            await page.locator('#confirmPassField').press('Tab');
            await page.waitForTimeout(400);
        }
        await page.waitForTimeout(1500);
    }

    if ((await page.locator('#_ancSignUpReg').count()) === 0) {
        await page.screenshot({ path: 'classic_register_no_next_btn.png', fullPage: true }).catch(() => {});
        return 'form_fail';
    }

    if (!nextEnabled) {
        await page.evaluate(() => {
            const b = document.getElementById('_ancSignUpReg');
            if (b) {
                b.removeAttribute('disabled');
                b.click();
            }
        });
    } else {
        await page.locator('#_ancSignUpReg').click();
    }
    await page.waitForTimeout(8000);

    let phase = 'unknown';
    for (let w = 0; w < 22; w++) {
        const t = await page.evaluate(() => (document.body ? document.body.innerText.substring(0, 1400) : ''));
        if (t.includes('Pro Subscription Key') || t.includes('Start Trial')) {
            phase = 'trial';
            break;
        }
        if (t.includes('Business Information') || t.includes('businessName')) {
            phase = 'business';
            break;
        }
        if (t.includes('account has been created') || t.includes('check your inbox')) {
            phase = 'success';
            break;
        }
        if (t.includes('already registered') || t.includes('already exists')) {
            return 'exists';
        }
        await page.waitForTimeout(2000);
    }

    if (phase === 'trial') {
        const startTrialBtn = page
            .locator('button:has-text("Start Trial Now"), a:has-text("Start Trial Now")')
            .first();
        if ((await startTrialBtn.count()) > 0) {
            await startTrialBtn.click();
            await page.waitForTimeout(7000);
        }
        for (let w = 0; w < 18; w++) {
            const t = await page.evaluate(() => (document.body ? document.body.innerText.substring(0, 1200) : ''));
            if (t.includes('Business Information')) {
                phase = 'business';
                break;
            }
            if (t.includes('account has been created') || t.includes('check your inbox')) {
                phase = 'success';
                break;
            }
            await page.waitForTimeout(2000);
        }
    }

    if (phase === 'business') {
        const sbo = page.locator('text=Small Business Owner').first();
        if ((await sbo.count()) > 0) await sbo.click().catch(() => {});
        await page.waitForTimeout(400);
        const bizName = page.locator('#businessName, input[name=businessName]').first();
        if ((await bizName.count()) > 0) {
            await bizName.fill(`NavBiz ${Date.now() % 100000}`);
        }
        const fields = [
            ['input[name=businessAdd]', email],
            ['input[name=city]', 'San Jose'],
            ['input[name=state]', 'California'],
            ['input[name=zipCode]', '95134'],
            ['input[name=businessPhoneNo]', '7075558899'],
        ];
        for (const [sel, val] of fields) {
            const el = page.locator(sel).first();
            if ((await el.count()) > 0) {
                await el.fill(val);
                await page.waitForTimeout(150);
            }
        }
        const bc = page.locator('select[name=businessCountry]');
        if ((await bc.count()) > 0) {
            await bc.selectOption({ label: 'United States of America' }).catch(() => {});
        }
        await page.waitForTimeout(400);
        const signUp = page.locator('button:has-text("Sign Up"):visible').first();
        if ((await signUp.count()) > 0) {
            await signUp.click();
        } else {
            await page.evaluate(() => {
                const b = document.getElementById('_ancSignUpReg');
                if (b) {
                    b.removeAttribute('disabled');
                    b.click();
                }
            });
        }
        await page.waitForTimeout(9000);
    }

    for (let w = 0; w < 18; w++) {
        const t = await page.evaluate(() => (document.body ? document.body.innerText.substring(0, 1000) : ''));
        if (t.includes('account has been created') || t.includes('check your inbox')) {
            await page
                .evaluate(() => {
                    document.querySelectorAll('button').forEach((b) => {
                        const x = (b.innerText || '').trim();
                        if (['OK', 'Got it', 'Close'].includes(x)) b.click();
                    });
                })
                .catch(() => {});
            await page.waitForTimeout(1500);
            console.log('[signup old flow] Registration completed — awaiting email verification');
            return 'created';
        }
        if (t.includes('already registered') || t.includes('already exists')) {
            return 'exists';
        }
        await page.waitForTimeout(2000);
    }

    const snap = await page.evaluate(() => (document.body ? document.body.innerText.substring(0, 400) : ''));
    console.error('[signup old flow] Unknown final state:', snap.substring(0, 200));
    await page.screenshot({ path: 'classic_register_unknown_final.png', fullPage: true }).catch(() => {});
    return 'form_fail';
}

app.post('/api/accounts', async (req, res) => {
    if (req.body && req.body.insightEnv) {
        insightEnv.setSessionInsightEnv(req.body.insightEnv);
    }
    const {
        prefix,
        flow: rawSignupFlow,
        country = 'US',
        addDevice = false,
        deviceType = 'NHB',
        deviceCount: rawDeviceCount,
        nhbCount: rawNhb,
        hbCount: rawHb,
        deviceOrgName = null,
        deviceLocationName = null,
        mailDomain = null,
        preferredMailDomains = null,
        purchase: purchaseBody = null,
        browser: rawBrowser,
    } = req.body;
    if (rawBrowser === 'chrome' || rawBrowser === 'firefox') sessionBrowser = rawBrowser;
    const signupFlow = rawSignupFlow === 'old' ? 'old' : 'new';
    let nhbCount = 0;
    let hbCount = 0;
    let deviceCount = 0;
    let deviceMix = null;
    if (addDevice) {
        if (rawNhb !== undefined || rawHb !== undefined) {
            nhbCount = normalizeMixCount(rawNhb !== undefined ? rawNhb : 1);
            hbCount = normalizeMixCount(rawHb !== undefined ? rawHb : 0);
            deviceCount = nhbCount + hbCount;
            deviceMix = { nhb: nhbCount, hb: hbCount };
        } else {
            const dt = deviceType === 'HB' ? 'HB' : 'NHB';
            const c = normalizeDeviceCount(rawDeviceCount);
            if (dt === 'HB') {
                hbCount = c;
            } else {
                nhbCount = c;
            }
            deviceCount = nhbCount + hbCount;
            deviceMix = { nhb: nhbCount, hb: hbCount };
        }
        if (deviceCount < 1) {
            return res.status(400).json({
                error: 'When Add device is on, set at least one NHB or HB (counts cannot both be zero).',
            });
        }
    }
    const deviceOrgNameTrim =
        deviceOrgName && String(deviceOrgName).trim() ? String(deviceOrgName).trim() : undefined;
    const deviceLocationNameTrim =
        deviceLocationName && String(deviceLocationName).trim()
            ? String(deviceLocationName).trim()
            : undefined;
    if (!prefix) return res.status(400).json({ error: 'Prefix required' });
    if (purchaseBody && purchaseBody.enabled && !addDevice) {
        return res.status(400).json({
            error: 'Hosted subscription purchase requires Add Device (trial must be active on Manage Subscriptions).',
        });
    }

    const purchaseEnabled = !!(purchaseBody && purchaseBody.enabled);
    const navigatorAccountMeta = {
        source: 'navigator',
        provisionProfile: buildNavigatorProvisionProfile(
            req.body,
            addDevice,
            deviceCount,
            purchaseEnabled,
            deviceMix
        ),
    };

    // email defined later
    const accounts = getAccounts();
    
    // check later

    try {
        const mailOpts = {};
        if (mailDomain && String(mailDomain).trim()) mailOpts.mailDomain = String(mailDomain).trim();
        if (Array.isArray(preferredMailDomains) && preferredMailDomains.length) {
            mailOpts.preferredDomains = preferredMailDomains.map((d) => String(d).trim()).filter(Boolean);
        }

        console.log(
            `Ensuring mail.tm mailbox for ${prefix}...`,
            mailOpts.mailDomain
                ? `(force domain ${mailOpts.mailDomain})`
                : `(preferred: ${(mailOpts.preferredDomains || DEFAULT_PREFERRED_MAIL_DOMAINS).join(', ')})`
        );
        const mailAcc = await createMailTmAccount(prefix, mailOpts);
        if (!mailAcc) {
            return res.status(500).json({
                error: 'Failed to create mail.tm account (no API/domain/token). Check console for [MailTM] logs.',
            });
        }
        const email = mailAcc.address;
        console.log(`Mailbox email (poll this exact inbox — domain is ${mailAcc.domain}): ${email}`);
        writeCurrentEmailSession(email, mailAcc);
        if (accounts.some((a) => (typeof a === 'string' ? a : a.email) === email)) {
            console.log(`Account ${email} is already in your saved list — logging you into Insight...`);
            const loginOk = await loginToAccount(email);
            if (!loginOk) {
                return res.status(500).json({
                    error: 'Saved account login failed',
                    email,
                    accounts: getAccounts(),
                });
            }
            return res.json({
                email,
                accounts: getAccounts(),
                success: true,
                message: 'Account already in list — logged in.',
                reusedSavedAccount: true,
            });
        }

        console.log(`Mail.tm ready. Launching browser to register...`);
        if (!browser || !browser.isConnected()) {
            browser = await getActiveBrowser().launch({ headless: false, args: ['--window-size=1920,1080'] });
            browser.on('disconnected', () => {
                browser = null; context = null; page = null;
            });
        }
        
        if (context) {
            try { await context.close(); } catch(e) {}
        }
        
        context = await browser.newContext({ viewport: null });
        page = await context.newPage();

        let postState;
        if (signupFlow === 'old') {
            console.log('[api/accounts] Signup flow: **old** → classic /classic/#/register (not auth-stg signup)');
            const classicResult = await registerInsightClassicOldFlow(page, email, country);
            if (classicResult === 'form_fail') {
                await page.screenshot({ path: 'classic_register_flow_fail.png', fullPage: true }).catch(() => {});
                return res.status(500).json({
                    error:
                        'Classic registration (/classic/#/register) did not complete. See console and classic_register_*.png in the server cwd.',
                    email,
                    accounts: getAccounts(),
                });
            }
            postState = classicResult === 'exists' ? 'exists' : 'ready';
        } else {
        const signupRedirect = encodeURIComponent(insightEnv.portalRootUrlForSession());
        await page.goto(`${insightEnv.authBaseForSession()}/signup?redirectUrl=${signupRedirect}`);
        await page.waitForSelector('#firstName', { timeout: 15000 });
        
        await page.fill('#firstName', 'Test');
        await page.fill('#lastName', 'User');
        await page.fill('#email', email);
        await page.fill('#password', DEFAULT_PW);
        
        // Select country
        await page.selectOption('#country', country);
        
        // Always select US phone country flag as failsafe
        try {
            await page.getByRole('combobox', { name: /Phone number country/i }).selectOption({ label: 'United States' });
        } catch (e) {
            console.log("Could not select phone country flag directly, trying fallback...");
            try {
                const phoneCountrySelect = await page.$('select[aria-label="Phone number country"]');
                if (phoneCountrySelect) {
                    await phoneCountrySelect.selectOption({ label: 'United States' });
                }
            } catch (e2) {
                console.log("Fallback failed too");
            }
        }
        
        await page.waitForTimeout(1000);
        
        const phoneInput = await page.$('input[type="tel"]');
        if (phoneInput) {
            await phoneInput.fill('+1 707 777 8889');
        }
        
        await page.waitForTimeout(1000);
        
        // Check terms
        const terms = await page.$('#termsCondition');
        if (terms) {
            const checked = await terms.isChecked();
            if (!checked) {
                await terms.click({ force: true });
            }
        }
        
        // Also check the other checkbox if it exists just in case
        const promo = await page.$('#communications');
        if (promo) {
            const pChecked = await promo.isChecked();
            if (!pChecked) {
                await promo.click({ force: true });
            }
        }
        
        await page.waitForTimeout(1000);
        
        await page.evaluate(() => {
            const btn = document.querySelector('button[type="submit"]');
            if (btn && !btn.disabled) {
                btn.click();
            } else {
                console.log("Submit button is disabled or not found.");
            }
        });
        
        console.log(`Registration submitted. Waiting for success / confirm UI...`);
        postState = await waitForPostSignupSuccess(page);
        } // end new flow else

        if (postState === 'exists') {
            await page.screenshot({ path: 'registration_email_exists.png' }).catch(() => {});
            console.log(
                `NETGEAR account already exists for ${email} — logging you in instead of registering again.`
            );
            if (!accounts.some((a) => (typeof a === 'string' ? a : a.email) === email)) {
                accounts.push(
                    newAccountRecord(email, 'Default', insightEnv.getSessionInsightEnv(), navigatorAccountMeta)
                );
                saveAccounts(accounts);
            }
            const loginOk = await loginToAccount(email);
            if (!loginOk) {
                return res.status(500).json({
                    error: 'Email already registered, but Insight login failed',
                    email,
                    accounts: getAccounts(),
                });
            }

            let bulkNavigatedToManageSubs = false;
            if (addDevice && deviceCount > 0) {
                console.log(`[existing-account] Adding ${deviceCount} device(s) after login (NHB=${nhbCount}, HB=${hbCount})...`);
                const bulkRes = await addDevicesBulk(page, {
                    nhbCount,
                    hbCount,
                    orgName: deviceOrgNameTrim,
                    locationName: deviceLocationNameTrim,
                });
                if (bulkRes && bulkRes.navigatedToManageSubsAfterBulkCsv) bulkNavigatedToManageSubs = true;
            }

            const purchaseOptsExists = purchaseBodyToOpts(purchaseBody);
            const navTimeout = 120000;
            let openedManageSubsForPurchase = false;
            if (addDevice) {
                if (purchaseOptsExists) {
                    if (!bulkNavigatedToManageSubs) {
                        console.log('Navigating to Manage Subscriptions (purchase flow; existing account)...');
                        await page.goto(insightEnv.manageSubsUrlForSession(), {
                            waitUntil: 'domcontentloaded',
                            timeout: navTimeout,
                        });
                    } else {
                        console.log(
                            '[existing-account] Already on Manage Subscriptions after bulk CSV success — skipping duplicate goto'
                        );
                    }
                    openedManageSubsForPurchase = true;
                } else {
                    console.log('Navigating to dashboard (existing account)...');
                    try {
                        await page.goto(`${insightEnv.originForSession()}/mspHome/dashboard`, {
                            waitUntil: 'domcontentloaded',
                            timeout: navTimeout,
                        });
                    } catch (e) {
                        console.log('Dashboard navigation timed out or failed; continuing:', e.message);
                    }
                }
            }

            let purchaseResult = null;
            if (purchaseOptsExists && page) {
                try {
                    await page.url();
                } catch {
                    purchaseResult = { success: false, error: 'Browser page closed before purchase' };
                }
                if (!purchaseResult) {
                    console.log('[existing-account flow] starting hosted subscription purchase...');
                    try {
                        await runInsightHostedPurchase(page, {
                            ...purchaseOptsExists,
                            manageSubsUrl: insightEnv.manageSubsUrlForSession(),
                            skipManageSubsGoto: openedManageSubsForPurchase,
                        });
                        purchaseResult = { success: true };
                    } catch (pe) {
                        console.error('[existing-account flow] purchase failed:', pe);
                        purchaseResult = { success: false, error: pe.message || String(pe) };
                    }
                }
            }

            return res.json({
                email,
                accounts: getAccounts(),
                success: true,
                reusedExistingNetgearAccount: true,
                message: 'Account already existed — logged in.',
                purchase: purchaseResult,
            });
        }
        if (postState !== 'ready') {
            console.log(
                'Post-signup UI did not show expected confirm/check-email copy; continuing to poll inbox anyway'
            );
        }

        console.log(`Waiting for verification email (link or OTP, up to 120s)...`);
        const { link: vLink, otp: vOtp } = await pollVerificationLinkOrOtp(
            mailAcc.token,
            mailAcc.api,
            120000
        );
        if (!vLink && !vOtp) {
            await page.screenshot({ path: 'registration_no_verification_mail.png' });
            return res.status(500).json({ error: 'Verification email not received (no link or OTP)' });
        }

        if (vLink) {
            console.log(`Opening verification link...`);
            await page.goto(vLink, { waitUntil: 'domcontentloaded' });
        } else {
            console.log(`Using OTP from email (${vOtp.slice(0, 2)}****)`);
            const confirmUrl = `${insightEnv.authBaseForSession()}/confirm-signup?email=${encodeURIComponent(
                email
            )}&redirectUrl=${encodeURIComponent(insightEnv.portalRootUrlForSession())}`;
            const urlNow = page.url();
            if (!/confirm-signup|verify/i.test(urlNow)) {
                await page.goto(confirmUrl, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(2000);
            }
            await submitEmailVerificationOtp(page, vOtp);
        }
        await page.waitForTimeout(5000);
        
        console.log(`Account ${email} created and verified successfully.`);

        accounts.push(
            newAccountRecord(email, 'Default', insightEnv.getSessionInsightEnv(), navigatorAccountMeta)
        );
        saveAccounts(accounts);

        console.log(`Logging into newly created account ${email}...`);
        await loginToAccount(email);
        
        // Onboarding (Org & Loc)
        console.log(`Handling onboarding (Org & Loc) for ${email}...`);
        await page.waitForFunction(() => {
            return document.body.innerText.includes('Locations') || 
                   document.body.innerText.includes('Organization') ||
                   document.querySelector('.insight-logo') ||
                   window.location.href.includes('newLogin');
        }, { timeout: 30000 }).catch(() => {});
        
        if (page.url().includes('newLogin')) {
            console.log('Onboarding page detected.');
            await page.waitForSelector('input[type="text"]', { timeout: 10000 }).catch(() => {});
            
            // Fill Org
            let inputs = await page.locator('input[type="text"]').all();
            if (inputs.length > 0) {
                await inputs[0].fill(BULK_ONBOARD_ORG);
                await inputs[0].press('Tab');
                await page.waitForTimeout(1000);
                
                let buttons = await page.locator('button').all();
                for (let i = 0; i < buttons.length; i++) {
                    const text = await buttons[i].innerText();
                    const disabled = await buttons[i].isDisabled();
                    if (text.includes('Next') && !disabled) {
                        await buttons[i].click();
                        break;
                    }
                }
                await page.waitForTimeout(3000);
            }
            
            // Fill Loc — country is always United States (not signup `country`; never first list item = Afghanistan)
            inputs = await page.locator('input[type="text"]').all();
            if (inputs.length > 0) {
                await inputs[0].fill(BULK_ONBOARD_LOC);
                await inputs[0].press('Tab'); 
                await page.waitForTimeout(1000);
                
                await selectNewLoginLocationCountryUnitedStates(page);
                await page.waitForTimeout(200);
                
                // Fill device admin password
                const pwdInputs = await page.locator('input[type="password"]').all();
                if (pwdInputs.length > 0) {
                    await pwdInputs[0].fill(DEFAULT_PW);
                    if (pwdInputs.length > 1) {
                        await pwdInputs[1].fill(DEFAULT_PW);
                    }
                    await page.waitForTimeout(500);
                }
                
                let buttons = await page.locator('button').all();
                for (let i = 0; i < buttons.length; i++) {
                    const text = await buttons[i].innerText();
                    const disabled = await buttons[i].isDisabled();
                    if (text.includes('Next') && !disabled) {
                        await buttons[i].click();
                        break;
                    }
                }
                await page.waitForTimeout(3000);
            }
            
            if (addDevice) {
                const doneBtn = page.locator('button:has-text("Done"), button:has-text("Get Started"), button:has-text("Start Guided Tour")').first();
                if (await doneBtn.isVisible().catch(()=>false)) {
                    await doneBtn.click();
                    await page.waitForTimeout(5000);
                }
            } else {
                console.log(`Waiting for guided tour text...`);
                try {
                    await page.waitForSelector('text="Your free trial will automatically start once you add your first device."', { timeout: 15000 });
                    console.log(`Guided tour text visible. Stopping navigation.`);
                } catch (e) {
                    console.log(`Guided tour text not found, but stopping navigation anyway.`);
                }
                if (purchaseBody && purchaseBody.enabled) {
                    return res.status(400).json({
                        error: 'Purchase was requested but Add Device is off — enable Add Device for all-in-one subscribe.',
                    });
                }
                return res.json({ email, accounts, success: true, purchase: null });
            }
        }
        
        // Add Device(s): Multiple-device CSV upload (staging file overwritten each run)
        let bulkNavigatedToManageSubs = false;
        if (addDevice && deviceCount > 0) {
            console.log(`Bulk CSV add ${deviceCount} device(s) (NHB=${nhbCount}, HB=${hbCount})…`, {
                orgPicker: deviceOrgNameTrim || '(UI default)',
                csvLocationColumn: deviceLocationNameTrim || BULK_ONBOARD_LOC,
            });
            const bulkRes = await addDevicesBulk(page, {
                nhbCount,
                hbCount,
                orgName: deviceOrgNameTrim,
                locationName: deviceLocationNameTrim,
            });
            if (bulkRes && bulkRes.navigatedToManageSubsAfterBulkCsv) bulkNavigatedToManageSubs = true;
        }
        
        const purchaseOpts = purchaseBodyToOpts(purchaseBody);
        const navTimeout = 120000;
        let openedManageSubsForPurchase = false;
        if (addDevice) {
                if (purchaseOpts) {
                    if (!bulkNavigatedToManageSubs) {
                        console.log('Navigating to Manage Subscriptions (purchase flow; dashboard SPA can hang indefinitely)...');
                        await page.goto(insightEnv.manageSubsUrlForSession(), {
                            waitUntil: 'domcontentloaded',
                            timeout: navTimeout,
                        });
                    } else {
                        console.log(
                            '[create flow] Already on Manage Subscriptions after bulk CSV success — skipping duplicate goto'
                        );
                    }
                    openedManageSubsForPurchase = true;
                } else {
                    console.log(`Navigating to dashboard...`);
                    try {
                        await page.goto(`${insightEnv.originForSession()}/mspHome/dashboard`, {
                            waitUntil: 'domcontentloaded',
                            timeout: navTimeout,
                        });
                } catch (e) {
                    console.log('Dashboard navigation timed out or failed; continuing:', e.message);
                }
            }
        }

        let purchaseResult = null;
        if (purchaseOpts && page) {
            try {
                await page.url();
            } catch {
                purchaseResult = { success: false, error: 'Browser page closed before purchase' };
            }
            if (!purchaseResult) {
                console.log('[create flow] starting hosted subscription purchase...');
                try {
                    await runInsightHostedPurchase(page, {
                        ...purchaseOpts,
                        manageSubsUrl: insightEnv.manageSubsUrlForSession(),
                        skipManageSubsGoto: openedManageSubsForPurchase,
                    });
                    purchaseResult = { success: true };
                } catch (pe) {
                    console.error('[create flow] purchase failed:', pe);
                    purchaseResult = { success: false, error: pe.message || String(pe) };
                }
            }
        }

        res.json({ email, accounts, success: true, purchase: purchaseResult });
        
    } catch (err) {
        console.error('Error creating account:', err);
        res.status(500).json({ error: err.message });
    }
});

async function loginToAccount(email) {
    try {
        // If browser doesn't exist or was manually closed by the user
        if (!browser || !browser.isConnected()) {
            console.log('Launching new browser instance...');
            browser = await getActiveBrowser().launch({ headless: false, args: ['--window-size=1920,1080'] });
            
            // Handle manual browser close gracefully
            browser.on('disconnected', () => {
                console.log('Browser was closed manually by the user.');
                browser = null;
                context = null;
                page = null;
            });
        }
        
        if (context) {
            try { await context.close(); } catch(e) { /* ignore if already closed */ }
        }
        
        context = await browser.newContext({ viewport: null });
        page = await context.newPage();
        
        console.log(`Logging into ${email}...`);
        
        // Navigate and Login
        await page.goto(insightEnv.portalRootUrlForSession(), { waitUntil: 'domcontentloaded' });
        
        const logInBtn = page.locator('button:has-text("Log In")');
        if (await logInBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await logInBtn.click();
        }
        
        await page.waitForSelector('#email', { timeout: 10000 });
        await page.fill('#email', email);
        await page.fill('#password', DEFAULT_PW);
        await page.click('button[type="submit"]');
        
        // Handle 2FA prompt if it appears
        const noThx = page.locator('text=No thank you');
        if (await noThx.isVisible({ timeout: 8000 }).catch(() => false)) {
            await noThx.click();
        }
        
        console.log(`Successfully opened session for ${email}`);
        return true;
    } catch (err) {
        console.error(`Error logging into ${email}:`, err);
        return false;
    }
}

/**
 * New mail.tm inbox + auth-stg signup (#country = ISO2) + verify + login + newLogin onboarding + 1× bulk CSV device.
 * Replaces global `context`/`page` so Stripe Checkout gets a **new customer per country** (currency follows account region;
 * changing only the Stripe billing dropdown on one session is not valid for this matrix).
 */
async function stripePreviewBootstrapAccountOnce(countryIso2, attemptNo) {
    const country = String(countryIso2 || 'US').toUpperCase();
    const prefix = `sp${country}${Date.now()}a${attemptNo}`.replace(/\D/g, '').slice(0, 24);
    console.log(`[stripe-preview] Bootstrapping account for ISO2=${country} (prefix=${prefix}, attempt=${attemptNo})`);

    const mailAcc = await createMailTmAccount(prefix, {});
    if (!mailAcc) {
        throw new Error('mail.tm account creation failed for Stripe preview bootstrap');
    }
    const email = mailAcc.address;
    writeCurrentEmailSession(email, mailAcc);

    if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({ headless: false, args: ['--window-size=1920,1080'] });
        browser.on('disconnected', () => {
            browser = null;
            context = null;
            page = null;
        });
    }
    if (context) {
        try {
            await context.close();
        } catch (e) {
            /* ignore */
        }
    }
    context = await browser.newContext({ viewport: null });
    page = await context.newPage();

    const signupRedirect = encodeURIComponent(insightEnv.portalRootUrlForSession());
    await page.goto(`${insightEnv.authBaseForSession()}/signup?redirectUrl=${signupRedirect}`);
    await page.waitForSelector('#firstName', { timeout: 15000 });

    await page.fill('#firstName', 'Test');
    await page.fill('#lastName', 'User');
    await page.fill('#email', email);
    await page.fill('#password', DEFAULT_PW);
    await page.selectOption('#country', country);
    try {
        await page.getByRole('combobox', { name: /Phone number country/i }).selectOption({ label: 'United States' });
    } catch (e) {
        try {
            const phoneCountrySelect = await page.$('select[aria-label="Phone number country"]');
            if (phoneCountrySelect) await phoneCountrySelect.selectOption({ label: 'United States' });
        } catch (e2) {
            /* ignore */
        }
    }
    await page.waitForTimeout(800);
    const phoneInput = await page.$('input[type="tel"]');
    if (phoneInput) await phoneInput.fill('+1 707 777 8889');
    await page.waitForTimeout(500);
    const terms = await page.$('#termsCondition');
    if (terms && !(await terms.isChecked().catch(() => true))) await terms.click({ force: true });
    const promo = await page.$('#communications');
    if (promo && !(await promo.isChecked().catch(() => true))) await promo.click({ force: true });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"]');
        if (btn && !btn.disabled) btn.click();
    });

    const postState = await waitForPostSignupSuccess(page);
    if (postState === 'exists') {
        throw new Error(`Email already registered for ${email} — abort Stripe preview bootstrap`);
    }

    const { link: vLink, otp: vOtp } = await pollVerificationLinkOrOtp(mailAcc.token, mailAcc.api, 120000);
    if (!vLink && !vOtp) {
        throw new Error('Verification email not received for Stripe preview signup');
    }
    if (vLink) {
        await page.goto(vLink, { waitUntil: 'domcontentloaded' });
    } else {
        const confirmUrl = `${insightEnv.authBaseForSession()}/confirm-signup?email=${encodeURIComponent(
            email
        )}&redirectUrl=${encodeURIComponent(insightEnv.portalRootUrlForSession())}`;
        const urlNow = page.url();
        if (!/confirm-signup|verify/i.test(urlNow)) {
            await page.goto(confirmUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000);
        }
        await submitEmailVerificationOtp(page, vOtp);
    }
    await page.waitForTimeout(5000);

    const accounts = getAccounts();
    if (!accounts.some((a) => (typeof a === 'string' ? a : a.email) === email)) {
        accounts.push(
            newAccountRecord(email, 'stripe-preview', insightEnv.getSessionInsightEnv(), {
                source: 'stripe_preview',
                provisionProfile: { mode: 'stripe_preview_bootstrap' },
            })
        );
        saveAccounts(accounts);
    }

    await loginToAccount(email);

    await page
        .waitForFunction(
            () =>
                document.body.innerText.includes('Locations') ||
                document.body.innerText.includes('Organization') ||
                document.querySelector('.insight-logo') ||
                window.location.href.includes('newLogin'),
            { timeout: 30000 }
        )
        .catch(() => {});

    if (page.url().includes('newLogin')) {
        await page.waitForSelector('input[type="text"]', { timeout: 10000 }).catch(() => {});
        let inputs = await page.locator('input[type="text"]').all();
        if (inputs.length > 0) {
            await inputs[0].fill(BULK_ONBOARD_ORG);
            await inputs[0].press('Tab');
            await page.waitForTimeout(1000);
            let buttons = await page.locator('button').all();
            for (let i = 0; i < buttons.length; i++) {
                const text = await buttons[i].innerText();
                const disabled = await buttons[i].isDisabled();
                if (text.includes('Next') && !disabled) {
                    await buttons[i].click();
                    break;
                }
            }
            await page.waitForTimeout(3000);
        }
        inputs = await page.locator('input[type="text"]').all();
        if (inputs.length > 0) {
            await inputs[0].fill(BULK_ONBOARD_LOC);
            await inputs[0].press('Tab');
            await page.waitForTimeout(1000);
            await selectNewLoginLocationCountryUnitedStates(page);
            await page.waitForTimeout(200);
            const pwdInputs = await page.locator('input[type="password"]').all();
            if (pwdInputs.length > 0) {
                await pwdInputs[0].fill(DEFAULT_PW);
                if (pwdInputs.length > 1) await pwdInputs[1].fill(DEFAULT_PW);
                await page.waitForTimeout(500);
            }
            const buttons2 = await page.locator('button').all();
            for (let i = 0; i < buttons2.length; i++) {
                const text = await buttons2[i].innerText();
                const disabled = await buttons2[i].isDisabled();
                if (text.includes('Next') && !disabled) {
                    await buttons2[i].click();
                    break;
                }
            }
            await page.waitForTimeout(3000);
        }
        const doneBtn = page
            .locator(
                'button:has-text("Done"), button:has-text("Get Started"), button:has-text("Start Guided Tour")'
            )
            .first();
        if (await doneBtn.isVisible().catch(() => false)) {
            await doneBtn.click();
            await page.waitForTimeout(4000);
        }
    }

    await dismissTrialPopupIfAny(page);

    const bulkRes = await addDevicesBulk(page, {
        nhbCount: 1,
        hbCount: 0,
        orgName: BULK_ONBOARD_ORG,
        locationName: BULK_ONBOARD_LOC,
    });
    console.log('[stripe-preview] Bulk add result added=', bulkRes?.added, 'failed=', bulkRes?.failed);

    return { email, country, bulkRes };
}

/**
 * Retries with a **fresh mail.tm inbox + signup** when verification email is missing (or mailbox create fails).
 * Env: `STRIPE_PREVIEW_MAIL_TRIES` (default 4).
 */
async function stripePreviewBootstrapAccount(countryIso2) {
    const maxTry = Number(process.env.STRIPE_PREVIEW_MAIL_TRIES) || 4;
    let lastErr;
    for (let attempt = 1; attempt <= maxTry; attempt++) {
        try {
            return await stripePreviewBootstrapAccountOnce(countryIso2, attempt);
        } catch (e) {
            lastErr = e;
            const msg = e && e.message ? e.message : String(e);
            const retryable =
                /Verification email not received|mail\.tm account creation failed/i.test(msg) ||
                /Email already registered/i.test(msg);
            console.warn(`[stripe-preview] Bootstrap attempt ${attempt}/${maxTry} failed:`, msg);
            if (!retryable || attempt >= maxTry) throw e;
            await new Promise((r) => setTimeout(r, 2500));
        }
    }
    throw lastErr || new Error('Stripe preview bootstrap failed');
}

app.post('/api/launch', async (req, res) => {
    if (req.body && req.body.insightEnv) {
        insightEnv.setSessionInsightEnv(req.body.insightEnv);
    }
    if (req.body && (req.body.browser === 'chrome' || req.body.browser === 'firefox')) {
        sessionBrowser = req.body.browser;
    }
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const sessionE = insightEnv.getSessionInsightEnv();
    const list = getAccounts();
    const rec = list.find((a) => a.email === email);
    if (rec && rec.insightEnv && rec.insightEnv !== sessionE) {
        return res.status(400).json({
            error: `Account is saved for ${rec.insightEnv}; switch Insight portal to that environment.`,
        });
    }

    const success = await loginToAccount(email);
    if (success) {
        res.json({ success: true, message: `Launched ${email}` });
    } else {
        res.status(500).json({ error: 'Failed to login' });
    }
});

app.post('/api/cancel', async (req, res) => {
    try {
        if (browser && browser.isConnected()) {
            await browser.close();
        }
    } catch (e) {
        console.error('Error closing browser:', e.message);
    } finally {
        browser = null;
        context = null;
        page = null;
    }
    res.json({ success: true, message: 'Browser closed' });
});

app.put("/api/accounts/:index/tag", (req, res) => {
    const index = parseInt(req.params.index);
    const { tag } = req.body;
    const accounts = getAccounts();

    if (index >= 0 && index < accounts.length) {
        if (typeof accounts[index] === "string") {
            accounts[index] = {
                email: accounts[index],
                tag,
                insightEnv: "pri-qa",
                source: "legacy",
                dateAdded: null,
            };
        } else {
            accounts[index].tag = tag;
            if (
                accounts[index].insightEnv !== "pri-qa" &&
                accounts[index].insightEnv !== "maint-beta" &&
                accounts[index].insightEnv !== "prod"
            ) {
                accounts[index].insightEnv = "pri-qa";
            }
        }
        saveAccounts(accounts);
    }

    res.json({ accounts });
});

/**
 * Run Insight → Stripe hosted subscription purchase on the **current** Playwright page.
 * Prereq: user already logged into the selected Insight env (pri-qa or maint-beta — see insightEnv).
 * UI: public/acc-purchase.html
 */
/**
 * Add many devices on the current Playwright session (after Open / Create).
 * Body: { count, deviceType: 'HB'|'NHB', deviceOrgName?, deviceLocationName? }
 */
app.post('/api/add-devices', async (req, res) => {
    try {
        if (req.body && req.body.insightEnv) {
            insightEnv.setSessionInsightEnv(req.body.insightEnv);
        }
        if (!page) {
            return res.status(400).json({
                error: 'No browser session. Use Create & Add or Open an account first.',
            });
        }
        try {
            await page.url();
        } catch {
            return res.status(400).json({
                error: 'Browser page is invalid. Close browser and launch an account again.',
            });
        }

        const body = req.body || {};
        const orgName =
            body.deviceOrgName && String(body.deviceOrgName).trim()
                ? String(body.deviceOrgName).trim()
                : undefined;
        const locationName =
            body.deviceLocationName && String(body.deviceLocationName).trim()
                ? String(body.deviceLocationName).trim()
                : undefined;

        let result;
        if (body.nhbCount !== undefined || body.hbCount !== undefined) {
            const nhb = normalizeMixCount(body.nhbCount);
            const hb = normalizeMixCount(body.hbCount);
            if (nhb + hb < 1) {
                return res.status(400).json({
                    error: 'Set at least one NHB or HB device count.',
                });
            }
            console.log('[api/add-devices]', { nhb, hb, orgName, locationName });
            result = await addDevicesBulk(page, {
                nhbCount: nhb,
                hbCount: hb,
                orgName,
                locationName,
            });
        } else {
            const count = normalizeDeviceCount(body.count);
            const deviceType = body.deviceType === 'HB' ? 'HB' : 'NHB';
            console.log('[api/add-devices]', { count, deviceType, orgName, locationName });
            result = await addDevicesBulk(page, {
                count,
                deviceType,
                orgName,
                locationName,
            });
        }

        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[api/add-devices]', err);
        res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

app.get('/api/stripe-checkout-preview/matrix', (req, res) => {
    const scenarioSelectionTokens = INTL_E2E_SCENARIOS.map((s) => {
        const pl = s.plan === '3-Year' ? '3-Year' : '1-Year';
        return `${s.iso2}|${pl}`;
    });
    res.json({
        matrix: PREVIEW_COUNTRY_MATRIX,
        intlScenarios: INTL_E2E_SCENARIOS,
        defaultScenarioIso2: INTL_E2E_SCENARIOS.map((s) => s.iso2),
        /** Checkbox values for “Select spec (14)” — one token per scenario (iso + plan). */
        scenarioSelectionTokens,
        expectedCurrency: EXPECTED_CURRENCY_BY_ISO2,
        count: PREVIEW_COUNTRY_MATRIX.length,
        /** Matrix rows × 2 plans — for dashboard picker (tokens like `DE|1-Year`). */
        countryPlanSlotCount: PREVIEW_COUNTRY_MATRIX.length * 2,
    });
});

/** Sample billing address lines for automation (same source as Stripe preview matrix fills). */
app.get('/api/stripe-preview-default-address/:iso2', (req, res) => {
    try {
        const raw = String(req.params.iso2 || '').trim().toUpperCase();
        const iso = raw.replace(/[^A-Z]/g, '').slice(0, 2);
        if (iso.length !== 2) {
            return res.status(400).json({ error: 'Expected ISO 3166-1 alpha-2 country code' });
        }
        res.json(previewAddressFor(iso));
    } catch (e) {
        res.status(500).json({ error: e.message || String(e) });
    }
});

app.get('/api/stripe-checkout-preview/state', (req, res) => {
    res.json(stripePreviewState);
});

/** Past runs: reads `test-results/stripe-preview/runN/stripe-preview-run-report.json` (same table as dashboard). */
app.get('/api/stripe-checkout-preview/history', (req, res) => {
    try {
        const base = path.join(WORKSPACE_ROOT, 'test-results', 'stripe-preview');
        if (!fs.existsSync(base)) {
            return res.json({ runs: [] });
        }
        const names = fs.readdirSync(base);
        const runs = [];
        for (const name of names) {
            const runM = /^run(\d+)$/.exec(name);
            if (!runM) continue;
            const reportPath = path.join(base, name, 'stripe-preview-run-report.json');
            if (!fs.existsSync(reportPath)) continue;
            const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            const outDirRel = path.relative(WORKSPACE_ROOT, path.join(base, name)).replace(/\\/g, '/');
            runs.push({
                runLabel: raw.runLabel || name,
                runNumber: parseInt(runM[1], 10),
                finishedAt: raw.finishedAt || null,
                insightEnv: raw.insightEnv,
                completePurchase: raw.completePurchase,
                summary: raw.summary || null,
                interactivePurchaseQueue: raw.interactivePurchaseQueue || [],
                rows: raw.rows || [],
                outDirRel,
            });
        }
        runs.sort((a, b) => b.runNumber - a.runNumber);
        res.json({ runs });
    } catch (e) {
        console.error('[api/stripe-checkout-preview/history]', e);
        res.status(500).json({ error: e.message || String(e), runs: [] });
    }
});

/**
 * Background job: Insight → Stripe hosted checkout, 2 screenshots per country, no purchase.
 * Default: **new mail.tm + signup per country** (`newAccountPerCountry` true) so Stripe customer/currency matches region
 * (changing only the billing country on one checkout session is invalid).
 * Legacy: `newAccountPerCountry: false` — requires an existing logged-in Navigator session on `page`.
 * Body: { plan?, all?, countries?, insightEnv?, newAccountPerCountry?, qty?, completePurchase?, useScenarioSpec? }
 */
app.post('/api/stripe-checkout-preview/run', async (req, res) => {
    try {
        const body = req.body || {};
        if (req.body && req.body.insightEnv) {
            insightEnv.setSessionInsightEnv(req.body.insightEnv);
        }
        if (req.body && (req.body.browser === 'chrome' || req.body.browser === 'firefox')) {
            sessionBrowser = req.body.browser;
        }
        const rawCard = body.card && typeof body.card === 'object' ? body.card : null;
        const sessionCard = rawCard ? {
            number: String(rawCard.number || '4242424242424242').replace(/\s/g, ''),
            expiry: String(rawCard.expiry || '12/30'),
            cvc: String(rawCard.cvc || '123'),
        } : null;
        const newAccountPerCountry = body.newAccountPerCountry !== false && body.newAccountPerCountry !== 'false';
        const useScenarioSpec = body.useScenarioSpec !== false && body.useScenarioSpec !== 'false';
        const completePurchase =
            body.completePurchase === true ||
            body.completePurchase === 'true' ||
            body.executePurchase === true ||
            body.executePurchase === 'true';

        if (!newAccountPerCountry) {
            if (!page) {
                return res.status(400).json({
                    error: 'No browser session. Open or create an account in Account Navigator first.',
                });
            }
            try {
                await page.url();
            } catch {
                return res.status(400).json({
                    error: 'Browser page is invalid. Close browser and launch an account again.',
                });
            }
        }
        if (stripePreviewState.status === 'running') {
            return res.status(409).json({ error: 'A stripe preview run is already in progress.' });
        }

        const defaultPlan = body.plan === '3-Year' ? '3-Year' : '1-Year';
        const subset = resolvePreviewSubset(body);

        if (!subset.length) {
            const b = body || {};
            const countries = Array.isArray(b.countries) ? b.countries : [];
            const hint = {
                all: !!(b.all === true || b.all === 'true'),
                plan: b.plan,
                useScenarioSpec: b.useScenarioSpec !== false && b.useScenarioSpec !== 'false',
                countryCount: countries.length,
                sample: countries.slice(0, 12).map((c) => String(c)),
            };
            console.warn('[stripe-checkout-preview/run] empty subset', hint);
            return res.status(400).json({
                error:
                    'No countries to run — each token must match the matrix (ISO2 or ISO2|1-Year / ISO2|3-Year). ' +
                    `Got all=${hint.all}, useScenarioSpec=${hint.useScenarioSpec}, ` +
                    `${hint.countryCount} token(s)` +
                    (hint.sample.length ? `: ${hint.sample.join(', ')}` : '') +
                    '.',
            });
        }

        const { runNumber, runLabel, outDir } = nextStripePreviewRunFolder();

        const firstRowPlan = subset[0] ? subset[0].plan || defaultPlan : defaultPlan;
        stripePreviewState = {
            status: 'running',
            currentIndex: 0,
            currentLabel: subset[0] ? subset[0].label : null,
            rows: [],
            error: null,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            outDir,
            plan: firstRowPlan,
            defaultPlan,
            currentCountryPlan: firstRowPlan,
            countryTotal: subset.length,
            newAccountPerCountry,
            runNumber,
            runLabel,
            completePurchase,
            useScenarioSpec,
            insightEnv: insightEnv.getSessionInsightEnv(),
        };
        persistStripePreviewState();

        res.json({
            ok: true,
            started: true,
            outDir,
            runNumber,
            runLabel,
            countryCount: subset.length,
            plan: firstRowPlan,
            defaultPlan,
            newAccountPerCountry,
            completePurchase,
            useScenarioSpec,
            insightEnv: insightEnv.getSessionInsightEnv(),
        });

        setImmediate(() => {
            (async () => {
                const manageSubsUrl = insightEnv.manageSubsUrlForSession();
                try {
                    function rowPayload(r, bootstrapEmail) {
                        return {
                            countryLabel: r.countryLabel,
                            iso2: r.iso2,
                            plan: r.plan,
                            expectedCurrency: r.expectedCurrency,
                            observedPricing: r.observedPricing,
                            payButtonAfter: r.payButtonAfter,
                            payButtonRaw: r.payButtonRaw,
                            completePurchase: r.completePurchase,
                            purchaseSucceeded: r.purchaseSucceeded,
                            purchaseError: r.purchaseError,
                            needsInteractivePurchase: !!r.needsInteractivePurchase,
                            checkoutUrlForInteractive: r.checkoutUrlForInteractive || null,
                            validation: r.validation,
                            billingFieldsMeta: Array.isArray(r.billingFieldsMeta)
                                ? r.billingFieldsMeta.slice(0, 16)
                                : [],
                            bootstrapEmail: bootstrapEmail || null,
                            screenshots: {
                                before: artifactRelFromAbs(r.screenshots.before),
                                after: artifactRelFromAbs(r.screenshots.after),
                                afterPurchase: artifactRelFromAbs(r.screenshots.afterPurchase),
                            },
                        };
                    }
                    if (newAccountPerCountry) {
                        const qty = body.qty != null ? Number(body.qty) : 1;
                        for (let i = 0; i < subset.length; i++) {
                            const meta = subset[i];
                            const rowPlan = meta.plan || defaultPlan;
                            stripePreviewState.currentIndex = i;
                            stripePreviewState.currentLabel = meta.label;
                            stripePreviewState.plan = rowPlan;
                            stripePreviewState.currentCountryPlan = rowPlan;
                            persistStripePreviewState();
                            const boot = await stripePreviewBootstrapAccount(meta.iso2);
                            const r = await runOneCountryPreview(page, {
                                plan: meta.plan || defaultPlan,
                                manageSubsUrl,
                                outDir,
                                slug: `${meta.iso2}-${i}`,
                                iso2: meta.iso2,
                                label: meta.label,
                                skipManageSubsGoto: false,
                                qty,
                                completePurchase,
                                address: meta.address || undefined,
                                expectedCurrency: meta.expectedCurrency,
                                fillFullAddress: !!meta.address,
                                card: sessionCard || undefined,
                            });
                            stripePreviewState.rows.push(rowPayload(r, boot.email));
                            persistStripePreviewState();
                        }
                    } else {
                        await executeStripePreviewMatrix(page, {
                            plan: defaultPlan,
                            subset,
                            manageSubsUrl,
                            outDir,
                            completePurchase,
                            card: sessionCard || undefined,
                            onProgress: (idx, meta) => {
                                const rowPlan = meta ? meta.plan || defaultPlan : defaultPlan;
                                stripePreviewState.currentIndex = idx;
                                stripePreviewState.currentLabel = meta ? meta.label : null;
                                stripePreviewState.plan = rowPlan;
                                stripePreviewState.currentCountryPlan = rowPlan;
                                persistStripePreviewState();
                            },
                            onRowComplete: (r) => {
                                stripePreviewState.rows.push(rowPayload(r, null));
                                persistStripePreviewState();
                            },
                        });
                    }
                    stripePreviewState.status = 'done';
                    stripePreviewState.currentLabel = null;
                    stripePreviewState.finishedAt = new Date().toISOString();

                    const rowsDone = stripePreviewState.rows || [];
                    const needMcp = rowsDone.filter((row) => row.needsInteractivePurchase);
                    stripePreviewState.interactivePurchaseQueue = needMcp.map((row) => ({
                        iso2: row.iso2,
                        countryLabel: row.countryLabel,
                        bootstrapEmail: row.bootstrapEmail,
                        checkoutUrl: row.checkoutUrlForInteractive,
                        error: row.purchaseError,
                    }));
                    try {
                        const reportJson = path.join(outDir, 'stripe-preview-run-report.json');
                        const reportMd = path.join(outDir, 'INTERACTIVE-PURCHASE-MCP.md');
                        const okPurch = rowsDone.filter((x) => x.purchaseSucceeded).length;
                        fs.writeFileSync(
                            reportJson,
                            JSON.stringify(
                                {
                                    finishedAt: stripePreviewState.finishedAt,
                                    runLabel,
                                    outDir,
                                    completePurchase,
                                    insightEnv: insightEnv.getSessionInsightEnv(),
                                    summary: {
                                        totalRows: rowsDone.length,
                                        purchaseSucceeded: okPurch,
                                        needsInteractiveMcp: needMcp.length,
                                    },
                                    interactivePurchaseQueue: stripePreviewState.interactivePurchaseQueue,
                                    rows: rowsDone,
                                },
                                null,
                                2
                            ),
                            'utf8'
                        );
                        let md = `# Stripe preview run (${runLabel})\n\n`;
                        md += `- **Finished:** ${stripePreviewState.finishedAt}\n`;
                        md += `- **Insight:** ${insightEnv.getSessionInsightEnv()}\n`;
                        md += `- **Complete purchase:** ${completePurchase}\n\n`;
                        md += `## Summary\n\n`;
                        md += `| Total rows | Purchase OK | Needs Playwright MCP |\n`;
                        md += `|------------|---------------|----------------------|\n`;
                        md += `| ${rowsDone.length} | ${okPurch} | ${needMcp.length} |\n\n`;
                        if (needMcp.length) {
                            md += `## Interactive completion (Playwright MCP)\n\n`;
                            md += `Automated pay did not enable or Insight redirect timed out. In **Cursor**, use **Playwright MCP** (browser tools) with a headed session: open each checkout URL, fix remaining fields (e.g. **Japan — Prefecture** dropdown = Tokyo), accept terms if needed, click **Pay/Subscribe**, use test card **4242…4242**, wait for redirect to Insight.\n\n`;
                            needMcp.forEach((row, i) => {
                                md += `${i + 1}. **${row.countryLabel}** (${row.iso2}) — ${row.bootstrapEmail || '—'}\n`;
                                md += `   - Checkout: ${row.checkoutUrlForInteractive || '—'}\n`;
                                md += `   - Detail: ${row.purchaseError || '—'}\n\n`;
                            });
                        } else {
                            md += `No MCP follow-up required for this run.\n`;
                        }
                        fs.writeFileSync(reportMd, md, 'utf8');
                        console.log('[stripe-preview] Report:', reportJson, reportMd);
                    } catch (repErr) {
                        console.error('[stripe-preview] report', repErr.message);
                    }
                } catch (err) {
                    console.error('[stripe-preview] run failed', err);
                    stripePreviewState.status = 'error';
                    stripePreviewState.error = err.message || String(err);
                    stripePreviewState.finishedAt = new Date().toISOString();
                    stripePreviewState.currentLabel = null;
                }
                persistStripePreviewState();
            })();
        });
    } catch (err) {
        console.error('[api/stripe-checkout-preview/run]', err);
        res.status(500).json({ error: err.message || String(err) });
    }
});

app.post('/api/acc-purchase', async (req, res) => {
    try {
        if (req.body && req.body.insightEnv) {
            insightEnv.setSessionInsightEnv(req.body.insightEnv);
        }
        if (!page) {
            return res.status(400).json({
                error: 'No browser session. On the main page, use Create & Add or Open on an account first.',
            });
        }
        try {
            await page.url();
        } catch {
            return res.status(400).json({
                error: 'Browser page is invalid. Close browser and launch an account again.',
            });
        }

        const body = req.body || {};
        if (body.enabled === false) {
            return res.status(400).json({ error: 'Set enabled: true to run purchase (or omit enabled).' });
        }

        console.log('[api/acc-purchase] starting', {
            insightEnv: insightEnv.getSessionInsightEnv(),
            plan: body.plan,
            qty: body.qty,
            fillFullAddress: body.fillFullAddress,
            businessPurchase: body.businessPurchase,
            deviceContext: body.deviceContext,
        });

        const result = await runInsightHostedPurchase(page, {
            plan: body.plan === '3-Year' ? '3-Year' : '1-Year',
            qty: body.qty != null ? Number(body.qty) : 1,
            fillFullAddress: !!body.fillFullAddress,
            address: body.address || undefined,
            businessPurchase: !!body.businessPurchase,
            businessId: body.businessId ? String(body.businessId).trim() : undefined,
            taxIdTypeHint: body.taxIdTypeHint ? String(body.taxIdTypeHint).trim() : undefined,
            cardholder: body.cardholder ? String(body.cardholder).trim() : undefined,
            deviceContext: body.deviceContext === 'HB' || body.deviceContext === 'NHB' ? body.deviceContext : 'na',
            maxWaitMs: body.maxWaitMs != null ? Number(body.maxWaitMs) : 360000,
            card: body.card,
            manageSubsUrl: insightEnv.manageSubsUrlForSession(),
        });

        res.json({ success: result.success !== false, ...result });
    } catch (err) {
        console.error('[api/acc-purchase]', err);
        res.status(500).json({ error: err.message || String(err) });
    }
});

/**
 * QA: Mongo — paid subscription (2nd insightLicKey): grace / expired / active; NHB device licExpDate.
 * Body: { email, mode: "grace"|"expired"|"active", dryRun?, insightEnv?, step?, bypassValidation?: boolean }
 */
app.post('/api/qa/subscription-grace-expired', async (req, res) => {
    try {
        const body = req.body || {};
        const email = body.email != null ? String(body.email).trim() : '';
        const modeRaw = body.mode != null ? String(body.mode).trim() : '';
        const mode =
            modeRaw === 'expired'
                ? 'expired'
                : modeRaw === 'grace'
                  ? 'grace'
                  : modeRaw === 'active'
                    ? 'active'
                    : null;
        if (!email || !mode) {
            return res.status(400).json({
                ok: false,
                error: 'Body requires { email, mode: "grace" | "expired" | "active" }',
            });
        }
        const dryRun = !!body.dryRun;
        const insightEnv = normalizeInsightEnv(body.insightEnv);
        // Gate: require an explicit unlock for this env every server start.
        // Hardcoded URIs (pri-qa / maint-beta) do NOT bypass this check — the
        // user must actively click "Unlock Mongo" and supply the password.
        if (!requireMongoUnlock(insightEnv)) {
            return res.status(401).json({
                ok: false,
                code: 'MONGO_LOCKED',
                insightEnv,
                error: `Mongo is locked for env "${insightEnv}". Click the 🔒 Unlock Mongo button and enter the password. Unlock is cleared on every dashboard restart.`,
            });
        }
        const step = body.step != null && body.step !== '' ? String(body.step).trim() : undefined;
        const bypassValidation = !!body.bypassValidation;
        const result = await runSubscriptionStateChange({
            email,
            mode,
            dryRun,
            insightEnv,
            step,
            bypassValidation,
        });
        res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
        console.error('[api/qa/subscription-grace-expired]', err);
        res.status(500).json({ ok: false, error: err.message || String(err) });
    }
});

/** QA Mongo DB change log (dashboard file qa-mongo-db-history.json). ?insightEnv=pri-qa|maint-beta filters. */
app.get('/api/qa/mongo-db-history', (req, res) => {
    try {
        const q = req.query && req.query.insightEnv;
        const insightEnv = q === 'maint-beta' ? 'maint-beta' : q === 'pri-qa' ? 'pri-qa' : q === 'prod' ? 'prod' : null;
        const entries = readMongoDbHistory(insightEnv);
        res.json({ ok: true, entries });
    } catch (err) {
        console.error('[api/qa/mongo-db-history]', err);
        res.status(500).json({ ok: false, error: err.message || String(err) });
    }
});

// Static last so /api/* is never shadowed by files under public/
/** Return canonical {key, url} for any env slug. */
app.get('/api/env/resolve', (req, res) => {
    const key = normalizeInsightEnv(req.query && req.query.env);
    res.json({ key, url: resolveInsightHost(key) });
});

/**
 * Ephemeral Mongo unlock (memory-only, cleared on server restart).
 * Client posts { env, password } → server stores password AND adds env to
 * a per-process `unlockedMongoEnvs` Set. Any grace/expiry call is gated by
 * that set — even envs with a hardcoded URI (pri-qa, maint-beta) require
 * an explicit unlock every server start.
 */
const unlockedMongoEnvs = new Set();

app.post('/api/mongo/unlock', (req, res) => {
    const body = req.body || {};
    const env = normalizeInsightEnv(body.env);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) return res.status(400).json({ ok: false, error: 'password required' });
    const varName = 'MONGO_PASSWORD_' + env.toUpperCase().replace(/-/g, '_');
    process.env[varName] = password;
    unlockedMongoEnvs.add(env);
    console.log(`[mongo/unlock] stored in-memory ${varName} (len=${password.length}); env "${env}" is now unlocked`);
    res.json({ ok: true, env, envVar: varName });
});

/** Explicit lock — forget the password + remove env from unlocked set. */
app.post('/api/mongo/lock', (req, res) => {
    const body = req.body || {};
    const env = normalizeInsightEnv(body.env);
    const varName = 'MONGO_PASSWORD_' + env.toUpperCase().replace(/-/g, '_');
    delete process.env[varName];
    unlockedMongoEnvs.delete(env);
    res.json({ ok: true, env });
});

/** Returns which envs currently have an in-memory unlock. */
app.get('/api/mongo/unlock-status', (req, res) => {
    res.json({ ok: true, unlocked: Array.from(unlockedMongoEnvs) });
});

/** Exposed so the grace/expiry handler can gate on it. */
function requireMongoUnlock(env) {
    return unlockedMongoEnvs.has(normalizeInsightEnv(env));
}

/**
 * Master-unlock: one password unlocks every env at once.
 * Compares against MASTER_MONGO_PASSWORD env var (default "Netgear123!").
 * On match, every currently-known env slug (defaults + any the client has
 * loaded into localStorage and tells us about via body.envs) is added to
 * the unlockedMongoEnvs set. Cleared on server restart like single unlock.
 */
const MASTER_MONGO_PASSWORD = process.env.MASTER_MONGO_PASSWORD || 'Netgear123!';

app.post('/api/mongo/unlock-all', (req, res) => {
    const body = req.body || {};
    const password = typeof body.password === 'string' ? body.password : '';
    if (password !== MASTER_MONGO_PASSWORD) {
        return res.status(401).json({ ok: false, error: 'Incorrect master password.' });
    }
    // Always unlock the four defaults; also honour any client-provided slugs.
    const envs = new Set(['pri-qa', 'maint-beta', 'maint-qa', 'prod']);
    if (Array.isArray(body.envs)) for (const e of body.envs) envs.add(normalizeInsightEnv(e));
    for (const e of envs) unlockedMongoEnvs.add(e);
    console.log(`[mongo/unlock-all] master password accepted; unlocked: ${Array.from(unlockedMongoEnvs).join(', ')}`);
    res.json({ ok: true, unlocked: Array.from(unlockedMongoEnvs) });
});

app.use(express.static(path.join(__dirname, 'public')));

module.exports = { app, migrateAccountsFileOnce, migrateAccountMetadataOnce, NAVIGATOR_PORT: PORT };

if (require.main === module) {
    migrateAccountsFileOnce();
    migrateAccountMetadataOnce();
    app.listen(PORT, () => {
        console.log(`Account Navigator running at http://localhost:${PORT}`);
        console.log(
            `Insight env: ${insightEnv.getSessionInsightEnv()} (${insightEnv.originForSession()}) — set NAVIGATOR_INSIGHT_ENV or pass insightEnv in API body`
        );
        console.log(`Acc Purchase UI: http://localhost:${PORT}/acc-purchase.html`);
    });
}
