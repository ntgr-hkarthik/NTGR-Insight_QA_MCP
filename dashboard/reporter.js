const fs = require('fs');
const path = require('path');

class DashboardReporter {
  constructor(options = {}) {
    this.outputFile = process.env.DASHBOARD_STATUS_FILE
      ? path.resolve(process.env.DASHBOARD_STATUS_FILE)
      : path.resolve(options.outputFile || 'dashboard/status.json');
    this.results = {
      startTime: null,
      endTime: null,
      overallStatus: 'pending',
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, inProgress: 0, pending: 0 },
      tests: [],
    };
  }

  onBegin(config, suite) {
    this.results.startTime = new Date().toISOString();
    this.results.overallStatus = 'running';
    this.results.tests = [];

    for (const test of suite.allTests()) {
      const file = path.basename(test.location.file).replace('.spec.ts', '');
      this.results.tests.push({
        id: test.id,
        title: test.title,
        fullTitle: test.titlePath().join(' > '),
        file,
        status: 'pending',
        duration: 0,
        error: null,
        retry: 0,
        steps: [],
        attachments: [],
      });
    }
    this.results.summary.total = this.results.tests.length;
    this._recomputeSummary();
    this._write();
  }

  onTestBegin(test) {
    const t = this.results.tests.find(r => r.id === test.id);
    if (t) {
      t.status = 'running';
      t.error = null;
    }
    this._recomputeSummary();
    this._write();
  }

  onTestEnd(test, result) {
    const t = this.results.tests.find(r => r.id === test.id);
    if (t) {
      t.duration = result.duration;
      t.retry = result.retry || 0;
      t.steps = this._flattenSteps(result.steps || []);
      t.attachments = (result.attachments || []).map(a => ({
        name: a.name,
        contentType: a.contentType,
        path: a.path ? path.relative(process.cwd(), a.path) : null,
      }));

      if (result.status === 'passed') {
        t.status = 'passed';
        t.error = null;
      } else if (result.status === 'failed' || result.status === 'timedOut') {
        t.status = 'failed';
        t.error = result.error?.message?.substring(0, 500) || 'Unknown error';
      } else if (result.status === 'skipped') {
        t.status = 'skipped';
      } else {
        t.status = result.status;
      }
    }
    this._recomputeSummary();
    this._write();
  }

  onEnd(result) {
    this.results.endTime = new Date().toISOString();
    this.results.overallStatus = result.status;
    this._recomputeSummary();
    this._write();
  }

  /**
   * Recompute summary counts from actual test statuses.
   * Single source of truth — no fragile increment/decrement tracking.
   */
  _recomputeSummary() {
    const tests = this.results.tests;
    this.results.summary = {
      total: tests.length,
      passed: tests.filter(t => t.status === 'passed').length,
      failed: tests.filter(t => t.status === 'failed').length,
      skipped: tests.filter(t => t.status === 'skipped' || t.status === 'interrupted').length,
      inProgress: tests.filter(t => t.status === 'running').length,
      pending: tests.filter(t => t.status === 'pending').length,
    };
  }

  _flattenSteps(steps, depth = 0) {
    const flat = [];
    for (const s of steps) {
      flat.push({
        title: s.title,
        duration: s.duration,
        error: s.error?.message?.substring(0, 200) || null,
        depth,
      });
      if (s.steps?.length) flat.push(...this._flattenSteps(s.steps, depth + 1));
    }
    return flat;
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.outputFile), { recursive: true });
      fs.writeFileSync(this.outputFile, JSON.stringify(this.results, null, 2));
    } catch (_) {}
  }
}

module.exports = DashboardReporter;
