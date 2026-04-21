/**
 * Persistent MCP settings (single dashboard URL + optional Jira / Figma).
 * Default path: ~/.insight-qa-workbench-mcp/config.json
 * Override: INSIGHT_QA_MCP_CONFIG_FILE=/abs/path.json
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function getConfigPath() {
  if (process.env.INSIGHT_QA_MCP_CONFIG_FILE && String(process.env.INSIGHT_QA_MCP_CONFIG_FILE).trim()) {
    return path.resolve(String(process.env.INSIGHT_QA_MCP_CONFIG_FILE).trim());
  }
  return path.join(os.homedir(), '.insight-qa-workbench-mcp', 'config.json');
}

function loadConfigRaw() {
  const p = getConfigPath();
  try {
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function saveConfigRaw(cfg) {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
}

/** @type {object | null} */
let cache = null;

function getConfig() {
  if (cache == null) cache = loadConfigRaw();
  return cache;
}

function invalidateCache() {
  cache = null;
}

function normalizeBaseUrl(u) {
  if (u == null || u === '') return '';
  let s = String(u).trim();
  if (!s) return '';
  s = s.replace(/\/$/, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/$/, '');
}

/**
 * One dashboard only: first non-empty wins — saved config, then env, then default.
 */
function getDashboardBaseUrl() {
  const c = getConfig();
  const fromFile = normalizeBaseUrl(c.dashboardBaseUrl);
  if (fromFile) return fromFile;
  const fromEnv = normalizeBaseUrl(process.env.INSIGHT_QA_BASE_URL);
  if (fromEnv) return fromEnv;
  return 'http://127.0.0.1:9323';
}

function maskSecret(s) {
  if (s == null || s === '') return '';
  const t = String(s);
  if (t.length <= 8) return '***';
  return `***${t.slice(-4)}`;
}

function redactedView() {
  const c = getConfig();
  return {
    configPath: getConfigPath(),
    dashboardBaseUrl: getDashboardBaseUrl(),
    dashboardFromFile: !!normalizeBaseUrl(c.dashboardBaseUrl),
    dashboardFromEnv: !normalizeBaseUrl(c.dashboardBaseUrl) && !!normalizeBaseUrl(process.env.INSIGHT_QA_BASE_URL),
    jira: c.jira
      ? {
          host: c.jira.host || '',
          email: c.jira.email || '',
          apiToken: maskSecret(c.jira.apiToken),
          configured: !!(c.jira.host && c.jira.email && c.jira.apiToken),
        }
      : null,
    figma: c.figma
      ? {
          accessToken: maskSecret(c.figma.accessToken),
          configured: !!c.figma.accessToken,
        }
      : null,
  };
}

function mergeAndSave(patch) {
  const cur = { ...loadConfigRaw() };
  if (patch.dashboardBaseUrl !== undefined) {
    const n = normalizeBaseUrl(patch.dashboardBaseUrl);
    if (n) cur.dashboardBaseUrl = n;
    else delete cur.dashboardBaseUrl;
  }
  if (patch.jira !== undefined) {
    if (patch.jira === null) delete cur.jira;
    else {
      cur.jira = { ...(cur.jira || {}) };
      const j = patch.jira || {};
      if (j.host !== undefined) cur.jira.host = j.host ? normalizeBaseUrl(j.host) : '';
      if (j.email !== undefined) cur.jira.email = String(j.email || '').trim();
      if (j.apiToken !== undefined) cur.jira.apiToken = String(j.apiToken || '').trim();
      if (!cur.jira.host && !cur.jira.email && !cur.jira.apiToken) delete cur.jira;
    }
  }
  if (patch.figma !== undefined) {
    if (patch.figma === null) delete cur.figma;
    else {
      cur.figma = { ...(cur.figma || {}) };
      const f = patch.figma || {};
      if (f.accessToken !== undefined) cur.figma.accessToken = String(f.accessToken || '').trim();
      if (!cur.figma.accessToken) delete cur.figma;
    }
  }
  saveConfigRaw(cur);
  cache = cur;
  return cur;
}

/**
 * @param {string[]} sections - 'dashboard' | 'jira' | 'figma'
 */
function clearSections(sections) {
  const cur = { ...loadConfigRaw() };
  const all = !sections || !sections.length;
  if (all || sections.includes('dashboard')) delete cur.dashboardBaseUrl;
  if (all || sections.includes('jira')) delete cur.jira;
  if (all || sections.includes('figma')) delete cur.figma;
  saveConfigRaw(cur);
  cache = cur;
  return cur;
}

function getJiraAuth() {
  const c = getConfig().jira || {};
  const host = c.host ? normalizeBaseUrl(c.host) : '';
  const email = String(c.email || '').trim();
  const apiToken = String(c.apiToken || '').trim();
  if (!host || !email || !apiToken) return null;
  const basic = Buffer.from(`${email}:${apiToken}`).toString('base64');
  return { host, headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' } };
}

function getFigmaToken() {
  const t = String((getConfig().figma || {}).accessToken || '').trim();
  return t || null;
}

module.exports = {
  getConfigPath,
  getDashboardBaseUrl,
  redactedView,
  mergeAndSave,
  clearSections,
  getJiraAuth,
  getFigmaToken,
  invalidateCache,
  loadConfigRaw,
};
