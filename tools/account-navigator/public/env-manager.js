/**
 * Shared env dropdown manager.
 * Lets user add custom Insight hosts and delete their custom additions.
 *
 * Key rules:
 *   - Default envs are always present + cannot be deleted.
 *   - Custom envs persist in localStorage under 'ng-envs-custom' as
 *     [{ key, url }] pairs.
 *   - Key derivation from a host: strip ".insight.netgear.com" suffix.
 *     Bare "insight.netgear.com" (prod) maps to key "prod".
 *   - URL derivation from a key: "prod" → https://insight.netgear.com;
 *     any other key → https://<key>.insight.netgear.com.
 *
 * Usage:
 *   NGEnvManager.attach(selectElement, { includePlus: true, includeTrash: true,
 *     onChange: (key) => { ... } });
 */
(function () {
  const STORAGE_KEY = 'ng-envs-custom';

  // Default envs — always shown, cannot be deleted.
  const DEFAULTS = [
    { key: 'pri-qa',      url: 'https://pri-qa.insight.netgear.com' },
    { key: 'maint-beta',  url: 'https://maint-beta.insight.netgear.com' },
    { key: 'maint-qa',    url: 'https://maint-qa.insight.netgear.com' },
    { key: 'prod',        url: 'https://insight.netgear.com' },
  ];

  function keyFromHost(hostOrUrl) {
    if (!hostOrUrl) return '';
    let s = String(hostOrUrl).trim();
    // Strip scheme
    s = s.replace(/^https?:\/\//i, '');
    // Strip path
    s = s.split('/')[0];
    // Strip port
    s = s.split(':')[0];
    if (/^insight\.netgear\.com$/i.test(s)) return 'prod';
    const m = s.match(/^([a-z0-9][a-z0-9-]*)\.insight\.netgear\.com$/i);
    return m ? m[1].toLowerCase() : '';
  }

  function urlFromKey(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return '';
    if (k === 'prod') return 'https://insight.netgear.com';
    return `https://${k}.insight.netgear.com`;
  }

  function loadCustom() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter((e) => e && typeof e.key === 'string' && typeof e.url === 'string');
    } catch { return []; }
  }

  function saveCustom(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function allEnvs() {
    const custom = loadCustom();
    // Hide customs that duplicate defaults
    const defaultKeys = new Set(DEFAULTS.map((d) => d.key));
    const uniqueCustom = custom.filter((c) => !defaultKeys.has(c.key));
    return [...DEFAULTS, ...uniqueCustom];
  }

  function isDefault(key) {
    return DEFAULTS.some((d) => d.key === key);
  }

  function repopulate(selectEl) {
    const prev = selectEl.value;
    selectEl.innerHTML = '';
    for (const env of allEnvs()) {
      const opt = document.createElement('option');
      opt.value = env.key;
      // Label: "pri-qa.insight.netgear.com" for non-prod, bare for prod
      opt.textContent = env.key === 'prod' ? 'insight.netgear.com (prod)' : `${env.key}.insight.netgear.com`;
      selectEl.appendChild(opt);
    }
    // Restore selection if still valid
    if ([...selectEl.options].some((o) => o.value === prev)) {
      selectEl.value = prev;
    }
  }

  function promptAdd(selectEl, onChange) {
    const input = window.prompt(
      'Enter full URL or host (e.g. https://demo-aux.insight.netgear.com, or demo.insight.netgear.com):',
      'https://',
    );
    if (!input) return;
    const key = keyFromHost(input);
    if (!key) {
      alert('Could not parse host. Must end in .insight.netgear.com (or be insight.netgear.com for prod).');
      return;
    }
    const url = urlFromKey(key);
    const existing = loadCustom();
    if (!existing.some((e) => e.key === key) && !isDefault(key)) {
      existing.push({ key, url });
      saveCustom(existing);
    }
    repopulate(selectEl);
    selectEl.value = key;
    if (typeof onChange === 'function') onChange(key);
  }

  function promptDelete(selectEl, onChange) {
    const key = selectEl.value;
    if (isDefault(key)) {
      alert(`"${key}" is a default env and cannot be deleted.`);
      return;
    }
    const list = loadCustom().filter((e) => e.key !== key);
    saveCustom(list);
    repopulate(selectEl);
    if (typeof onChange === 'function') onChange(selectEl.value);
  }

  function attach(selectEl, opts = {}) {
    if (!selectEl) return;
    repopulate(selectEl);

    // Accept a pre-selected value if provided via data-attr or opts.initial
    const initial = opts.initial || selectEl.getAttribute('data-initial');
    if (initial && [...selectEl.options].some((o) => o.value === initial)) {
      selectEl.value = initial;
    }

    // Wrap select + buttons in a horizontal flex row so buttons always sit
    // to the RIGHT of the select, never stacked beneath — regardless of the
    // ancestor's flex direction (e.g. the Mongo env's <label class="flex flex-col">).
    const parent = selectEl.parentElement;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-1 flex-wrap';
    if (parent) {
      parent.insertBefore(row, selectEl);
      row.appendChild(selectEl);
    }

    if (opts.includePlus !== false) {
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.textContent = '+';
      plus.title = 'Add a new Insight env (paste the URL)';
      plus.className = opts.buttonClass || 'ctrl-h9 px-2 rounded border border-cyan-500/40 bg-cyan-950/40 text-cyan-100 hover:bg-cyan-900/50 text-xs';
      plus.addEventListener('click', () => promptAdd(selectEl, opts.onChange));
      row.appendChild(plus);
    }
    if (opts.includeTrash !== false) {
      const trash = document.createElement('button');
      trash.type = 'button';
      trash.textContent = '−';
      trash.title = 'Delete the currently selected custom env (defaults are protected)';
      trash.className = opts.buttonClass || 'ctrl-h9 px-2 rounded border border-red-500/40 bg-red-950/40 text-red-200 hover:bg-red-900/50 text-xs';
      trash.addEventListener('click', () => promptDelete(selectEl, opts.onChange));
      row.appendChild(trash);
    }

    if (typeof opts.onChange === 'function') {
      selectEl.addEventListener('change', () => opts.onChange(selectEl.value));
    }
  }

  window.NGEnvManager = {
    DEFAULTS,
    keyFromHost,
    urlFromKey,
    loadCustom,
    saveCustom,
    allEnvs,
    isDefault,
    repopulate,
    attach,
  };
})();
