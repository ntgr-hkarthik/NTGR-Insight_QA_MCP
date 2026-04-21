const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = 9324;
const DASHBOARD_DIR = __dirname;
const ROOT = path.resolve(__dirname, '..');
const STATUS_FILE = path.join(DASHBOARD_DIR, 'status.json');
const HISTORY_DIR = path.join(DASHBOARD_DIR, 'history');
const PID_FILE = path.join(DASHBOARD_DIR, 'test-runner.pid');

fs.mkdirSync(HISTORY_DIR, { recursive: true });

// Fix stale "running" status on server startup (from killed/crashed test runs)
try {
  if (fs.existsSync(STATUS_FILE)) {
    const d = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
    if (d.overallStatus === 'running') {
      const tests = d.tests || [];
      const failed = tests.filter(t => t.status === 'failed' || t.status === 'timedOut').length;
      d.overallStatus = failed > 0 ? 'failed' : 'passed';
      d.endTime = d.endTime || new Date().toISOString();
      tests.forEach(t => {
        if (t.status === 'running') t.status = 'interrupted';
        if (t.status === 'pending') t.status = 'skipped';
      });
      if (d.summary) { d.summary.inProgress = 0; d.summary.pending = 0; }
      fs.writeFileSync(STATUS_FILE, JSON.stringify(d, null, 2));
      console.log('[startup] Fixed stale running status → ' + d.overallStatus);
    }
  }
} catch (e) { console.log('[startup] status fix error:', e.message); }

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.zip': 'application/zip', '.gif': 'image/gif', '.sh': 'text/plain',
  '.md': 'text/plain', '.txt': 'text/plain', '.csv': 'text/csv',
};

let testProcess = null;

// ── Helper: parse JSON body from incoming request ──
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── Helper: read, mutate, write status.json ──
function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); }
  catch { return null; }
}

function writeStatus(data) {
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
}

function recomputeSummary(data) {
  const tests = data.tests || [];
  data.summary = {
    total: tests.length,
    passed: tests.filter(t => t.status === 'passed').length,
    failed: tests.filter(t => t.status === 'failed').length,
    skipped: tests.filter(t => t.status === 'skipped' || t.status === 'interrupted').length,
    inProgress: tests.filter(t => t.status === 'running').length,
    pending: tests.filter(t => t.status === 'pending').length,
  };
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function killAllTests() {
  let killed = [];
  // Kill tracked child process
  if (testProcess && !testProcess.killed) {
    try { process.kill(-testProcess.pid, 'SIGTERM'); } catch (_) {}
    try { testProcess.kill('SIGTERM'); } catch (_) {}
    killed.push('child-process');
    testProcess = null;
  }
  // Kill by PID file
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (pid) { try { process.kill(pid, 'SIGTERM'); killed.push('pid:' + pid); } catch (_) {} }
      fs.unlinkSync(PID_FILE);
    }
  } catch (_) {}
  // Kill any playwright/chromium processes
  try { execSync('pkill -f "npx playwright" 2>/dev/null || true'); killed.push('npx-playwright'); } catch (_) {}
  try { execSync('pkill -f "chromium" 2>/dev/null || true'); killed.push('chromium'); } catch (_) {}
  return killed;
}

// Hackathon demo only. The full NTGR/Zephyr/ST/Single-Tier dashboard lives
// in the sibling playwright/ repo at http://localhost:9323 (or whatever port
// playwright/dashboard/server.js is started on).
const SUITE_COMMANDS = {
  'hackathon-demo': { cmd: 'npx playwright test --config=playwright.stripe.config.ts --project=hackathon-demo --project=hackathon-3yr --workers=2', cwd: ROOT },
};

const ALLOWED_CONFIGS = new Set([
  'playwright.stripe.config.ts',
  'playwright.config.ts',
]);

// Baseline envs (mirror of env-manager.js defaults on the client).
// Any user-added slug resolves to https://<slug>.insight.netgear.com via
// resolveEnvUrl() below; "prod" → https://insight.netgear.com.
const VALID_ENVS = {
  'pri-qa':    'https://pri-qa.insight.netgear.com',
  'maint-qa':  'https://maint-qa.insight.netgear.com',
  'maint-beta':'https://maint-beta.insight.netgear.com',
  'prod':      'https://insight.netgear.com',
};

/** Resolve any env slug → https origin. Invalid input falls back to pri-qa. */
function resolveEnvUrl(key) {
  if (typeof key !== 'string') return VALID_ENVS['pri-qa'];
  const k = key.trim().toLowerCase();
  if (!k) return VALID_ENVS['pri-qa'];
  if (VALID_ENVS[k]) return VALID_ENVS[k];
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(k)) return VALID_ENVS['pri-qa'];
  return `https://${k}.insight.netgear.com`;
}

function startTests({ suite, config, project, failedOnly, env, grep } = {}) {
  killAllTests();
  // Clean evidence in THIS repo (hackathon)
  // Evidence goes into hackathon's test-results/evidence (served by this server)
  const evDir = path.join(ROOT, 'test-results', 'evidence');
  try { fs.mkdirSync(evDir, { recursive: true }); } catch (_) {}
  try { fs.readdirSync(evDir).forEach(f => { try { fs.unlinkSync(path.join(evDir, f)); } catch (_) {} }); } catch (_) {}

  let cmd, cwd;
  const baseUrl = resolveEnvUrl(env);

  // Sanitize grep: allow only T-keys, pipe, parens, alphanumeric, spaces, hyphens
  const safeGrep = grep ? grep.replace(/[^A-Za-z0-9|():\- ]/g, '') : '';

  if (config) {
    const safeConfig = path.basename(config);
    if (!ALLOWED_CONFIGS.has(safeConfig)) {
      console.error('[test-runner] rejected config:', safeConfig);
      return null;
    }
    cwd = ROOT;
    cmd = `npx playwright test --config=${safeConfig}`;
    if (project && project !== 'all' && /^[\w\-]+$/.test(project)) cmd += ` --project=${project}`;
    if (failedOnly) cmd += ' --last-failed';
    if (safeGrep) cmd += ` --grep "${safeGrep}"`;
  } else {
    const entry = SUITE_COMMANDS[suite] || SUITE_COMMANDS['hackathon-demo'];
    cmd = entry.cmd;
    cwd = entry.cwd;
    if (safeGrep) cmd += ` --grep "${safeGrep}"`;
  }

  console.log(`[test-runner] env=${env || 'pri-qa'} baseUrl=${baseUrl} cwd=${cwd} cmd=${cmd}`);

  testProcess = exec(
    cmd,
    { cwd, detached: true, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, BASE_URL: baseUrl, DASHBOARD_STATUS_FILE: STATUS_FILE, EVIDENCE_DIR: evDir } },
    (err) => {
      console.log('[test-runner] finished', err ? 'with error' : 'ok');
      testProcess = null;
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
    }
  );
  fs.writeFileSync(PID_FILE, String(testProcess.pid));
  testProcess.stdout.on('data', d => process.stdout.write('[test] ' + d));
  testProcess.stderr.on('data', d => process.stderr.write('[test-err] ' + d));
  return testProcess.pid;
}

const express = require('express');
const {
  app: navigatorApp,
  migrateAccountsFileOnce: migrateNavigatorAccounts,
} = require(path.join(ROOT, 'tools/account-navigator/server.js'));
try {
  migrateNavigatorAccounts();
} catch (e) {
  console.log('[dashboard] navigator accounts migrate:', e.message);
}

const mainApp = express();

function mountNavigator(req, res, next) {
  const orig = req.originalUrl || req.url;
  const pathOnly = orig.split('?')[0];
  const qs = orig.includes('?') ? orig.slice(orig.indexOf('?')) : '';

  if (pathOnly === '/navigator' || pathOnly.startsWith('/navigator/')) {
    const inner = pathOnly.slice('/navigator'.length) || '/';
    req.url = inner + qs;
    navigatorApp(req, res, () => {
      req.url = orig;
      next();
    });
    return;
  }

  if (
    pathOnly.startsWith('/api/accounts') ||
    pathOnly === '/api/launch' ||
    pathOnly === '/api/cancel' ||
    pathOnly === '/api/add-devices' ||
    pathOnly === '/api/acc-purchase' ||
    pathOnly === '/api/qa/subscription-grace-expired' ||
    pathOnly === '/api/qa/mongo-db-history' ||
    pathOnly.startsWith('/api/stripe-checkout-preview') ||
    pathOnly.startsWith('/api/stripe-preview-default-address')
  ) {
    navigatorApp(req, res, (err) => {
      req.url = orig;
      next(err);
    });
    return;
  }

  next();
}

mainApp.use(mountNavigator);

async function dashboardHandler(req, res) {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';

  // API: Kill all tests
  if (url === '/api/kill' && req.method === 'POST') {
    const killed = killAllTests();
    // Reporter.onEnd() won't fire when processes are SIGTERM'd — patch
    // status.json so the elapsed timer stops ticking in the UI.
    try {
      if (fs.existsSync(STATUS_FILE)) {
        const d = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
        const now = new Date().toISOString();
        d.endTime = d.endTime || now;
        if (d.overallStatus === 'running' || d.overallStatus === 'pending') {
          d.overallStatus = 'aborted';
        }
        if (Array.isArray(d.tests)) {
          for (const t of d.tests) {
            if (t.status === 'running' || t.status === 'pending') {
              t.status = 'skipped';
              t.error = t.error || 'Aborted by user';
            }
          }
        }
        fs.writeFileSync(STATUS_FILE, JSON.stringify(d, null, 2));
      }
    } catch (e) { console.warn('[kill] failed to patch status.json:', e.message); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, killed }));
    const msg = JSON.stringify({ type: 'killed', endTime: new Date().toISOString() });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
    return;
  }

  // API: Start tests
  if (url === '/api/run' && req.method === 'POST') {
    const body = await parseBody(req);
    const { suite, config, project, failedOnly, env, grep } = body || {};
    const pid = startTests({ suite: suite || 'demo', config, project, failedOnly, env, grep });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, pid, suite, config, project, grep }));
    return;
  }

  // API: List available suites
  // Resolve any env key → {key, url}. Usage: GET /api/env/resolve?env=demo-aux
  if (url.startsWith('/api/env/resolve')) {
    const u = new URL(url, 'http://x');
    const key = (u.searchParams.get('env') || '').trim().toLowerCase();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ key, url: resolveEnvUrl(key) }));
    return;
  }

  if (url === '/api/suites' && req.method === 'GET') {
    return jsonResponse(res, 200, { suites: Object.keys(SUITE_COMMANDS) });
  }

  // API: Get runner status
  if (url === '/api/runner-status') {
    const running = testProcess && !testProcess.killed;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ running, pid: running ? testProcess.pid : null }));
    return;
  }

  // ── DirectPro Purchase Status API ──
  if (url === '/api/dpro-status') {
    try {
      const csvFiles = [
        { file: 'im10-dpro-accounts.csv', type: 'dpro' },
        { file: 'im10-team-directpro-accounts.csv', type: 'team' },
      ];
      const result = { dpro: [], team: [], summary: {}, updatedAt: new Date().toISOString() };

      // Parse im10-dpro-accounts.csv
      const dproPath = path.join(ROOT, 'im10-dpro-accounts.csv');
      if (fs.existsSync(dproPath)) {
        const lines = fs.readFileSync(dproPath, 'utf8').split('\n').filter(l => l.trim());
        for (let i = 1; i < lines.length; i++) {
          const p = lines[i].split(',');
          if (p.length < 15) continue;
          result.dpro.push({
            tc: p[0], type: p[1], email: p[2], country: p[4], countryName: p[5],
            currency: p[6], credits: parseInt(p[7]) || 0, notes: p[8],
            orgs: p[9], nhb: p[10], hb: p[11], status: p[14],
          });
        }
      }

      // Parse im10-team-directpro-accounts.csv (multi-row format)
      const teamPath = path.join(ROOT, 'im10-team-directpro-accounts.csv');
      if (fs.existsSync(teamPath)) {
        const lines = fs.readFileSync(teamPath, 'utf8').split('\n');
        let current = null;
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line.trim()) continue;
          if (line.startsWith(',')) {
            const p = line.split(',');
            if (current && p[1]) {
              current.email = p[1];
              current.password = p[2];
              current.status = p[3] || 'unknown';
              result.team.push(current);
              current = null;
            }
          } else {
            const p = line.split(',');
            current = {
              sno: p[0], accountType: p[1], country: p[2], subType: p[3],
              orgs: p[4], locations: p[5], totalCredits: p[6], creditState: p[7],
              nhb: p[8], hb: p[9], autoAlloc: p[10], config: p[11], expected: p[12],
            };
          }
        }
      }

      // Compute summary
      const stats = {};
      let totalCredits = 0;
      result.dpro.forEach(a => {
        const s = a.status || 'unknown';
        if (!stats[s]) stats[s] = { count: 0, credits: 0 };
        stats[s].count++;
        stats[s].credits += a.credits;
        totalCredits += a.credits;
      });
      result.summary = {
        total: result.dpro.length,
        totalCredits,
        breakdown: stats,
        teamTotal: result.team.length,
      };

      return jsonResponse(res, 200, result);
    } catch (e) { return jsonResponse(res, 500, { error: e.message }); }
  }

  // ── DirectPro Snapshot (static previous-run data) ──
  if (url === '/api/dpro-snapshot') {
    const snapPath = path.join(__dirname, 'dpro-snapshot.json');
    if (fs.existsSync(snapPath)) {
      const data = fs.readFileSync(snapPath, 'utf8');
      return jsonResponse(res, 200, JSON.parse(data));
    }
    return jsonResponse(res, 404, { error: 'snapshot not found' });
  }

  // ── Interactive Mode API ──

  // CORS preflight for interactive API
  if (req.method === 'OPTIONS' && url.startsWith('/api/interactive/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // POST /api/interactive/init — Initialize session with test case titles
  if (url === '/api/interactive/init' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const titles = body.tests || [];
      if (!titles.length) return jsonResponse(res, 400, { ok: false, error: 'tests array required' });

      const data = {
        startTime: new Date().toISOString(),
        endTime: null,
        overallStatus: 'running',
        mode: 'interactive',
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, inProgress: 0, pending: 0 },
        tests: titles.map((title, i) => ({
          id: `interactive-${i}`,
          title,
          fullTitle: `Interactive > ${title}`,
          file: 'interactive',
          status: 'pending',
          duration: 0,
          error: null,
          retry: 0,
          steps: [],
          attachments: [],
        })),
      };
      recomputeSummary(data);
      writeStatus(data);
      console.log(`[interactive] Init: ${titles.length} tests`);
      return jsonResponse(res, 200, { ok: true, total: titles.length });
    } catch (e) { return jsonResponse(res, 500, { ok: false, error: e.message }); }
  }

  // POST /api/interactive/begin — Mark test[index] as running
  if (url === '/api/interactive/begin' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const idx = body.index;
      const data = readStatus();
      if (!data || !data.tests) return jsonResponse(res, 400, { ok: false, error: 'No active session' });
      if (idx < 0 || idx >= data.tests.length) return jsonResponse(res, 400, { ok: false, error: 'Invalid index' });

      data.tests[idx].status = 'running';
      data.tests[idx].error = null;
      data.tests[idx]._startedAt = Date.now();
      data.overallStatus = 'running';
      recomputeSummary(data);
      writeStatus(data);
      console.log(`[interactive] Begin: [${idx}] ${data.tests[idx].title}`);
      return jsonResponse(res, 200, { ok: true, test: data.tests[idx].title });
    } catch (e) { return jsonResponse(res, 500, { ok: false, error: e.message }); }
  }

  // POST /api/interactive/step — Record a test step for test[index]
  if (url === '/api/interactive/step' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const idx = body.index;
      const data = readStatus();
      if (!data || !data.tests) return jsonResponse(res, 400, { ok: false, error: 'No active session' });
      if (idx < 0 || idx >= data.tests.length) return jsonResponse(res, 400, { ok: false, error: 'Invalid index' });

      const t = data.tests[idx];
      if (!t.steps) t.steps = [];
      const stepNum = t.steps.length + 1;
      const step = {
        index: stepNum,
        title: body.action || `Step ${stepNum}`,
        expected: body.expected || null,
        status: body.status || 'passed',
        error: body.error || null,
        screenshot: body.screenshot || null,
        duration: body.duration || 0,
        depth: body.depth || 0,
        timestamp: new Date().toISOString(),
      };
      t.steps.push(step);

      if (body.screenshot) {
        if (!t.attachments) t.attachments = [];
        t.attachments.push({
          name: body.action || `Step ${stepNum} screenshot`,
          path: body.screenshot,
          contentType: 'image/png',
          step: stepNum,
        });
      }

      writeStatus(data);
      console.log(`[interactive] Step: [${idx}] #${stepNum} ${step.title} → ${step.status}`);
      return jsonResponse(res, 200, { ok: true, step: stepNum });
    } catch (e) { return jsonResponse(res, 500, { ok: false, error: e.message }); }
  }

  // POST /api/interactive/screenshot — Attach a screenshot to test[index]
  if (url === '/api/interactive/screenshot' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const idx = body.index;
      const data = readStatus();
      if (!data || !data.tests) return jsonResponse(res, 400, { ok: false, error: 'No active session' });
      if (idx < 0 || idx >= data.tests.length) return jsonResponse(res, 400, { ok: false, error: 'Invalid index' });

      const t = data.tests[idx];
      if (!t.attachments) t.attachments = [];
      const ext = (body.filename || '').split('.').pop() || 'png';
      const contentType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webm: 'video/webm', mp4: 'video/mp4' }[ext] || 'image/png';
      t.attachments.push({
        name: body.name || body.filename || 'screenshot',
        path: body.filename,
        contentType,
        step: body.step || null,
      });

      writeStatus(data);
      console.log(`[interactive] Screenshot: [${idx}] ${body.filename}`);
      return jsonResponse(res, 200, { ok: true, attachment: body.filename });
    } catch (e) { return jsonResponse(res, 500, { ok: false, error: e.message }); }
  }

  // POST /api/interactive/end — Mark test[index] as passed/failed
  if (url === '/api/interactive/end' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const idx = body.index;
      const status = body.status || 'passed';
      const data = readStatus();
      if (!data || !data.tests) return jsonResponse(res, 400, { ok: false, error: 'No active session' });
      if (idx < 0 || idx >= data.tests.length) return jsonResponse(res, 400, { ok: false, error: 'Invalid index' });

      const t = data.tests[idx];
      t.status = status;
      t.error = body.error || null;
      t.duration = body.duration || (t._startedAt ? Date.now() - t._startedAt : 0);
      delete t._startedAt;
      if (body.steps) t.steps = body.steps;
      recomputeSummary(data);
      writeStatus(data);
      console.log(`[interactive] End: [${idx}] ${t.title} → ${status}`);
      return jsonResponse(res, 200, { ok: true, test: t.title, status });
    } catch (e) { return jsonResponse(res, 500, { ok: false, error: e.message }); }
  }

  // POST /api/interactive/finish — Finalize the session
  if (url === '/api/interactive/finish' && req.method === 'POST') {
    try {
      const data = readStatus();
      if (!data) return jsonResponse(res, 400, { ok: false, error: 'No active session' });

      data.endTime = new Date().toISOString();
      const failed = (data.tests || []).filter(t => t.status === 'failed').length;
      data.overallStatus = failed > 0 ? 'failed' : 'passed';
      // Mark any still-pending/running tests as skipped/interrupted
      (data.tests || []).forEach(t => {
        if (t.status === 'running') t.status = 'interrupted';
        if (t.status === 'pending') t.status = 'skipped';
      });
      recomputeSummary(data);
      writeStatus(data);
      console.log(`[interactive] Finish: ${data.overallStatus} (${data.summary.passed}P/${data.summary.failed}F/${data.summary.skipped}S)`);
      return jsonResponse(res, 200, { ok: true, overallStatus: data.overallStatus, summary: data.summary });
    } catch (e) { return jsonResponse(res, 500, { ok: false, error: e.message }); }
  }

  // Serve downloadable assets from repo root (setup.sh, README.md, etc.)
  if (url === '/setup.sh' || url === '/README.md' || url === '/llms.txt') {
    const fname = url.replace('/', '');
    const filePath = path.join(ROOT, fname);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not Found'); return; }
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': url.endsWith('.sh') ? 'application/octet-stream' : 'text/plain',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
    return;
  }

  // Serve evidence screenshots/videos from test-results/evidence/
  if (url.startsWith('/evidence/')) {
    const filePath = path.join(ROOT, 'test-results', url.replace('/evidence/', 'evidence/'));
    return serveFile(filePath, res);
  }

  // Serve artifact files by relative path (used by inline test details)
  if (url.startsWith('/artifacts/')) {
    const relPath = decodeURIComponent(url.replace('/artifacts/', ''));
    const filePath = path.join(ROOT, relPath);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
    return serveFile(filePath, res);
  }

  // Serve playwright-report for detailed view
  if (url.startsWith('/report/')) {
    const filePath = path.join(ROOT, 'playwright-report', url.replace('/report/', ''));
    return serveFile(filePath, res);
  }

  // Serve history files
  if (url.startsWith('/history/')) {
    const filePath = path.join(HISTORY_DIR, url.replace('/history/', ''));
    return serveFile(filePath, res);
  }

  // Serve dashboard files
  const filePath = path.join(DASHBOARD_DIR, url);
  serveFile(filePath, res);
}

mainApp.use((req, res) => {
  dashboardHandler(req, res).catch((e) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e && e.message ? e.message : e));
    }
  });
});

const server = http.createServer(mainApp);

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
}

// WebSocket server
const wss = new WebSocketServer({ server });

let lastData = null;

function broadcastStatus() {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
    if (raw === lastData) return;
    lastData = raw;
    const msg = JSON.stringify({ type: 'status', data: JSON.parse(raw) });
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  } catch {}
}

// Also broadcast evidence file list
function broadcastEvidence() {
  try {
    const dir = path.join(ROOT, 'test-results', 'evidence');
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => /\.(png|jpg|webm|mp4)$/.test(f)).sort();
    const msg = JSON.stringify({ type: 'evidence', files });
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  } catch {}
}

// Watch status.json — create it first if missing so fs.watch doesn't throw
if (!fs.existsSync(STATUS_FILE)) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({
    startTime: null, endTime: null, overallStatus: 'idle',
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, inProgress: 0, pending: 0 },
    tests: [],
  }, null, 2));
}
let watchTimer = null;
try {
  fs.watch(STATUS_FILE, { persistent: false }, () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      broadcastStatus();
      broadcastEvidence();
    }, 200);
  });
} catch (e) { console.log('[watch] status.json watch error:', e.message); }

// Also poll in case fs.watch misses events
setInterval(() => { broadcastStatus(); broadcastEvidence(); }, 3000);

// On new WebSocket connection, send current state directly
wss.on('connection', (ws) => {
  // Always send current status to the newly connected client (bypass lastData cache)
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
    ws.send(JSON.stringify({ type: 'status', data: JSON.parse(raw) }));
  } catch {}
  try {
    const dir = path.join(ROOT, 'test-results', 'evidence');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => /\.(png|jpg|webm|mp4)$/.test(f)).sort();
      ws.send(JSON.stringify({ type: 'evidence', files }));
    }
  } catch {}

  // Handle history requests
  ws.on('message', (msg) => {
    try {
      const req = JSON.parse(msg);
      if (req.type === 'getHistory') {
        const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json')).sort().reverse();
        const history = files.slice(0, 20).map(f => {
          const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf-8'));
          return { file: f, ...data.summary, startTime: data.startTime, endTime: data.endTime, overallStatus: data.overallStatus };
        });
        ws.send(JSON.stringify({ type: 'history', data: history }));
      }
      if (req.type === 'getHistoryDetail' && req.file) {
        const safe = path.basename(req.file);
        const filePath = path.join(HISTORY_DIR, safe);
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          ws.send(JSON.stringify({ type: 'historyDetail', data }));
        }
      }
    } catch {}
  });
});

// Save to history when tests complete
let wasRunning = false;
setInterval(() => {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (wasRunning && (data.overallStatus === 'passed' || data.overallStatus === 'failed' || data.overallStatus === 'timedout')) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(HISTORY_DIR, `run-${ts}.json`), raw);
      wasRunning = false;
    }
    if (data.overallStatus === 'running') wasRunning = true;
  } catch {}
}, 5000);

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Navigator: http://localhost:${PORT}/navigator/ (embedded Account Navigator)`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`Evidence:  http://localhost:${PORT}/evidence/`);
  console.log(`Report:    http://localhost:${PORT}/report/`);
});
