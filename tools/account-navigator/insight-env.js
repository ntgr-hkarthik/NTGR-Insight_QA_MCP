/**
 * Insight portal base URL for Account Navigator (MUI).
 * Session key drives signup redirect, login landing, device pages, Manage Subscriptions, and Stripe return detection.
 *
 * Accepts any normalized slug (^[a-z0-9][a-z0-9-]{0,40}$) plus the 'prod' alias
 * (which maps to https://insight.netgear.com — no subdomain).
 *
 * Override default at startup: NAVIGATOR_INSIGHT_ENV=<slug>|prod
 * Per-request: body.insightEnv on POST /api/accounts, /api/launch, /api/acc-purchase.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// auth base per env. prod uses live auth; anything else staging.
function authBaseFor(key) {
  return key === 'prod' ? 'https://auth.netgear.com' : 'https://auth-stg.netgear.com';
}

function originFor(key) {
  if (key === 'prod') return 'https://insight.netgear.com';
  return `https://${key}.insight.netgear.com`;
}

function normalizeKey(k) {
  if (typeof k !== 'string') return null;
  const s = k.toLowerCase().trim();
  if (!s) return null;
  if (s === 'prod') return 'prod';
  if (SLUG_RE.test(s)) return s;
  return null;
}

const boot = normalizeKey(process.env.NAVIGATOR_INSIGHT_ENV);
let sessionKey = boot || 'pri-qa';

function setSessionInsightEnv(k) {
  const n = normalizeKey(k);
  if (n) sessionKey = n;
}

function parseInsightEnvFromBody(body) {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'insightEnv')) {
    return null;
  }
  return normalizeKey(body.insightEnv);
}

function getSessionInsightEnv() {
  return sessionKey;
}

function originForSession() {
  return originFor(sessionKey);
}

function authBaseForSession() {
  return authBaseFor(sessionKey);
}

function manageSubsUrlForSession() {
  return `${originForSession()}/mspHome/administration/manage-subscriptions`;
}

function portalRootUrlForSession() {
  return `${originForSession()}/`;
}

const ENVS = {
  'pri-qa':    { origin: originFor('pri-qa'),    authBase: authBaseFor('pri-qa') },
  'maint-beta':{ origin: originFor('maint-beta'),authBase: authBaseFor('maint-beta') },
  prod:        { origin: originFor('prod'),      authBase: authBaseFor('prod') },
};

module.exports = {
  ENVS,
  normalizeKey,
  originFor,
  authBaseFor,
  setSessionInsightEnv,
  getSessionInsightEnv,
  parseInsightEnvFromBody,
  originForSession,
  authBaseForSession,
  manageSubsUrlForSession,
  portalRootUrlForSession,
};
