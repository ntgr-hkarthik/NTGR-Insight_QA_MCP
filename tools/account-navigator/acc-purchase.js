/**
 * Insight Manage Subscriptions → Stripe hosted checkout (Playwright page API).
 * Used by Account Navigator server — keep in sync with tests/helpers/insightSubscriptionFlow patterns.
 */

const { setInsightPlanQuantityBeforeStripe } = require('./insight-quantity.js');

/** @deprecated Use opts.manageSubsUrl from server (insight-env). Kept for callers that import the constant. */
const MANAGE_SUBS =
  'https://pri-qa.insight.netgear.com/mspHome/administration/manage-subscriptions';

const DEFAULT_MANAGE_SUBS = MANAGE_SUBS;

const DEFAULT_CARD = {
  number: '4242424242424242',
  expiry: '12/30',
  cvc: '123',
};

/** Hosted Stripe often ignores Pay/Subscribe if the iframe/shell is still hydrating — idle before fill and before submit. */
const STRIPE_HOSTED_SETTLE_MS = 5000;

/** After changing billing country `<select>`, short wait for field set to swap (was 1200ms — too slow). */
const STRIPE_BILLING_SETTLE_MS = 450;

/** US + Canada: Stripe hosted checkout typically requires full billing address. */
function requiresFullStripeAddress(countryCode) {
  const c = String(countryCode || '')
    .trim()
    .toUpperCase();
  return c === 'US' || c === 'CA';
}

function planTabRegex(plan) {
  return plan === '1-Year' ? /1\s*year/i : /3\s*years?/i;
}

async function openPlanChooser(page) {
  const chooseArrow = page.getByRole('button', { name: /choose plan/i });
  if (await chooseArrow.isVisible({ timeout: 15000 }).catch(() => false)) {
    await chooseArrow.click();
    return;
  }
  const chooseSub = page.getByRole('button', { name: /choose subscription plan/i });
  if (await chooseSub.isVisible({ timeout: 8000 }).catch(() => false)) {
    await chooseSub.click();
  }
}

async function countChoosePlanButtons(page) {
  return page.getByRole('button', { name: /^choose plan$/i }).count();
}

/**
 * If only one plan row is visible, prepaid cards may still be loading. Wait 2s and recount.
 * If still exactly one card, yearly prepaid is not offered for this region.
 */
async function waitForPlanCardsReadyOrThrow(page) {
  let n = await countChoosePlanButtons(page);
  if (n === 1) {
    console.log(
      '[acc-purchase] Only 1 plan card visible — waiting 2s in case 1 Year / 3 Years cards are still loading…'
    );
    await page.waitForTimeout(2000);
    n = await countChoosePlanButtons(page);
  }
  if (n === 1) {
    throw new Error(
      '[acc-purchase] Yearly prepaid (1 Year / 3 Years) not available: still only one plan card after wait (region may not support prepaid).'
    );
  }
  const hasYear = await page.getByRole('heading', { name: /^1\s*Year$/i }).first().isVisible().catch(() => false);
  const hasThree = await page.getByRole('heading', { name: /^3\s*Years?$/i }).first().isVisible().catch(() => false);
  if (!hasYear && !hasThree) {
    await page
      .getByRole('heading', { name: /^1\s*Year$/i })
      .first()
      .waitFor({ state: 'visible', timeout: 45000 })
      .catch(() => {});
  }
}

/** Wait until Playwright locator is not disabled (button enabled for click). */
async function waitUntilLocatorEnabled(page, locator, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const disabled = await locator.isDisabled().catch(() => true);
    if (!disabled) return;
    await page.waitForTimeout(300);
  }
  throw new Error('Timed out waiting for control to become enabled');
}

/**
 * DOM: #monthly-subscription-card + #choosePlanMonthly (MUB), prepaid cards share #yearly-subscription-card
 * and button id choosePlanYearly (duplicate ids). Scope by MuiCard + h3 "1 Year" / "3 Years" + (Prepaid).
 */
async function clickChoosePlanOnPrepaidCard(page, plan) {
  const mubRe =
    /monthly\s+usage|usage\s+billing|metered|pay\s+as\s+you\s+go|\bmub\b|^monthly$|postpaid/i;
  let prepaidRe;
  if (plan === '1-Year') {
    prepaidRe =
      /(?:^|[^\d])1\s*[\s-]*year(?:s)?\b|one\s+year\b|yearly\b|annual\b|1\s*yr\b|1-year\b|1\s*year\s*\(?prepaid\)?/i;
  } else {
    prepaidRe =
      /(?:^|[^\d])3\s*[\s-]*years?\b|three\s+years\b|3\s*yr\b|3-year\b|3\s*years?\s*\(?prepaid\)?/i;
  }

  await openPlanChooser(page);
  await page.waitForTimeout(800);
  await waitForPlanCardsReadyOrThrow(page);

  const tabLoc = page
    .getByRole('tab', { name: planTabRegex(plan) })
    .or(page.getByRole('button', { name: planTabRegex(plan) }));
  const nTabs = await tabLoc.count();
  for (let ti = 0; ti < nTabs; ti++) {
    const t = tabLoc.nth(ti);
    if (await t.isVisible().catch(() => false)) {
      await t.click().catch(() => {});
      await page.waitForTimeout(600);
      break;
    }
  }

  const headingName = plan === '1-Year' ? /^1\s*Year$/i : /^3\s*Years?$/i;
  const prepaidCard = page
    .locator('div.MuiCard-root')
    .filter({ has: page.getByRole('heading', { name: headingName }) })
    .filter({ has: page.getByText(/\(?\s*Prepaid\s*\)?/i) })
    .first();

  if (await prepaidCard.isVisible({ timeout: 12000 }).catch(() => false)) {
    const btn = prepaidCard.getByRole('button', { name: /^choose plan$/i });
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    await waitUntilLocatorEnabled(page, btn, 45000);
    console.log(`[acc-purchase] Choose plan: scoped to prepaid ${plan} card (MuiCard + heading + Prepaid)`);
    await btn.click();
    return;
  }

  const byIdYearly = page.locator('#choosePlanYearly');
  const nYearlyIds = await byIdYearly.count();
  if (nYearlyIds >= 2) {
    const idx = plan === '1-Year' ? 0 : 1;
    const b = byIdYearly.nth(idx);
    await b.waitFor({ state: 'visible', timeout: 10000 });
    await waitUntilLocatorEnabled(page, b, 45000);
    console.log(`[acc-purchase] Choose plan: #choosePlanYearly index ${idx} (1yr=0, 3yr=1)`);
    await b.click();
    return;
  }
  if (nYearlyIds === 1) {
    if (plan === '3-Year') {
      throw new Error('[acc-purchase] Only one #choosePlanYearly button — 3-Year prepaid not available.');
    }
    const b = byIdYearly.first();
    await waitUntilLocatorEnabled(page, b, 45000);
    console.log('[acc-purchase] Choose plan: single #choosePlanYearly (1-Year only market)');
    await b.click();
    return;
  }

  const buttons = page.getByRole('button', { name: /^choose plan$/i });
  await buttons.first().waitFor({ state: 'visible', timeout: 45000 });
  const n = await buttons.count();

  async function blockTextForButton(btn) {
    return btn.evaluate((el) => {
      let node = el;
      const parts = [];
      for (let depth = 0; depth < 22 && node; depth++) {
        const text = (node.innerText || '').trim();
        if (text) parts.push(text);
        node = node.parentElement;
      }
      return parts.join('\n---\n').slice(0, 4500);
    });
  }

  for (let i = 0; i < n; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const blockText = await blockTextForButton(btn);
    const looksMub = mubRe.test(blockText);
    const looksPrepaid = prepaidRe.test(blockText);
    if (looksPrepaid && !looksMub) {
      await waitUntilLocatorEnabled(page, btn, 45000);
      console.log(`[acc-purchase] Choose plan on prepaid ${plan} card (ancestor text, index ${i})`);
      await btn.click();
      return;
    }
  }

  for (let i = 0; i < n; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const blockText = await blockTextForButton(btn);
    if (mubRe.test(blockText)) continue;
    if (prepaidRe.test(blockText)) {
      await waitUntilLocatorEnabled(page, btn, 45000);
      console.log(`[acc-purchase] Choose plan: prepaid match index ${i}`);
      await btn.click();
      return;
    }
  }

  throw new Error(
    `[acc-purchase] Could not resolve prepaid ${plan} vs Monthly/MUB/Partner among ${n} "Choose plan" control(s).`
  );
}

const STRIPE_COUNTRY_LABELS = {
  AU: 'Australia',
  US: 'United States',
  CA: 'Canada',
  IN: 'India',
  GB: 'United Kingdom',
  DE: 'Germany',
  FR: 'France',
  NZ: 'New Zealand',
  SG: 'Singapore',
  JP: 'Japan',
  IE: 'Ireland',
  CH: 'Switzerland',
  NL: 'Netherlands',
  SE: 'Sweden',
  NO: 'Norway',
  DK: 'Denmark',
  PL: 'Poland',
  CZ: 'Czech Republic',
  HU: 'Hungary',
  ZA: 'South Africa',
  HK: 'Hong Kong',
};

async function selectStripeCountry(combo, countryCode) {
  const code = String(countryCode || 'US')
    .trim()
    .toUpperCase();
  try {
    await combo.selectOption({ value: code });
    return;
  } catch {
    /* continue */
  }
  const label = STRIPE_COUNTRY_LABELS[code];
  if (label) {
    try {
      await combo.selectOption({ label });
      return;
    } catch {
      /* continue */
    }
  }
  try {
    await combo.selectOption({ index: 1 });
  } catch {
    /* leave default */
  }
}

/** Read ISO2 from Stripe hosted checkout when we did not override country (native select or combobox-backed select). */
async function readStripeCheckoutCountryCode(page) {
  const fromDom = await page
    .evaluate(() => {
      const sel = document.querySelector(
        'select[name="billingCountry"], select[name="billingAddress.country"], select[autocomplete="country"]'
      );
      if (sel instanceof HTMLSelectElement && sel.value && /^[A-Za-z]{2}$/.test(sel.value)) {
        return sel.value.toUpperCase();
      }
      return null;
    })
    .catch(() => null);
  if (fromDom) return fromDom;
  const combo = page.getByRole('combobox', { name: /country or region/i });
  if (!(await combo.isVisible({ timeout: 2000 }).catch(() => false))) return null;
  return combo
    .evaluate((el) => {
      if (el instanceof HTMLSelectElement && el.value && /^[A-Za-z]{2}$/.test(el.value)) {
        return el.value.toUpperCase();
      }
      return null;
    })
    .catch(() => null);
}

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Stripe hosted checkout usually exposes billing country as a native <select id="billingCountry">.
 * Relying only on getByRole('combobox') misses that control, so the session can stay on US while we fill DE lines.
 */
async function setStripeBillingCountryIfPossible(page, countryCode) {
  const code = String(countryCode || '')
    .trim()
    .toUpperCase();
  if (!code) return false;

  const native = page.locator('select#billingCountry, select[name="billingCountry"]').first();
  if (await native.isVisible({ timeout: 5000 }).catch(() => false)) {
    try {
      await native.selectOption({ value: code });
      await page.waitForTimeout(STRIPE_BILLING_SETTLE_MS);
      return true;
    } catch {
      const label = STRIPE_COUNTRY_LABELS[code];
      if (label) {
        try {
          await native.selectOption({ label: new RegExp(escapeRe(label), 'i') });
          await page.waitForTimeout(STRIPE_BILLING_SETTLE_MS);
          return true;
        } catch {
          /* fall through */
        }
      }
    }
  }

  const countryCombo = page.getByRole('combobox', { name: /country or region/i });
  if (await countryCombo.isVisible({ timeout: 4000 }).catch(() => false)) {
    await selectStripeCountry(countryCombo, code);
    await page.waitForTimeout(STRIPE_BILLING_SETTLE_MS);
    return true;
  }

  console.warn('[acc-purchase] Could not set billing country control for', code);
  return false;
}

async function tryFill(locator, value, timeout = 2500) {
  if (value == null || String(value).trim() === '') return;
  if (await locator.isVisible({ timeout }).catch(() => false)) {
    await locator.fill(String(value));
    return true;
  }
  return false;
}

/** Stripe labels vary — "City", "Town", "Ward", 市区町村, etc. */
async function tryFillCityAny(page, city, timeout = 1800) {
  if (!city || !String(city).trim()) return false;
  const v = String(city).trim();
  const candidates = [
    page.getByRole('textbox', { name: /^city$/i }).first(),
    page.getByRole('textbox', { name: /city|town|locality|ward|市区町村|市町村/i }).first(),
    page.locator('input[autocomplete="address-level2"]').first(),
    page.getByLabel(/city|town|locality|ward/i).first(),
    page.locator('input[name*="city" i]').first(),
    page.locator('input[id*="city" i]').first(),
  ];
  for (const loc of candidates) {
    if (await tryFill(loc, v, timeout)) return true;
  }
  return false;
}

/**
 * State / province / prefecture / region — native select, or MUI combobox (e.g. Japan 都道府県).
 */
async function trySelectRegionOrPrefecture(page, state, billingCountry) {
  if (!state || !String(state).trim()) return false;
  const v = String(state).trim();
  const re = new RegExp(escapeRe(v), 'i');

  /** Stripe hosted checkout uses `billingAdministrativeArea` for state/prefecture/county (not only `billingAddress.state`). */
  const selectLocators = [
    page.locator('select#billingAdministrativeArea'),
    page.locator('select[name="billingAdministrativeArea"]'),
    page.locator('select[name="billingAddress.state"]'),
    page.locator('select[autocomplete="address-level1"]'),
    page.locator('select[name*="Administrative" i]'),
    page.locator('select[name*="state" i]'),
    page.locator('select[id*="state" i]'),
  ];

  for (const sel of selectLocators) {
    const first = sel.first();
    if (!(await first.isVisible({ timeout: 1500 }).catch(() => false))) continue;
    const count = await first.locator('option').count();
    for (let i = 0; i < count; i++) {
      const opt = first.locator('option').nth(i);
      const t = (await opt.innerText().catch(() => '')).trim();
      if (!t || /^choose|select|^\s*$/i.test(t)) continue;
      if (re.test(t) || t.toLowerCase().includes(v.toLowerCase())) {
        try {
          const label = await opt.textContent();
          if (label?.trim()) await first.selectOption({ label: label.trim() });
          else await first.selectOption({ index: i });
          console.log('[acc-purchase] Selected region/prefecture option:', t.slice(0, 60));
          return true;
        } catch (e) {
          /* try next */
        }
      }
    }
    try {
      await first.selectOption({ label: re });
      return true;
    } catch (e) {
      /* continue */
    }
  }

  const combo = page.getByRole('combobox', { name: /state|region|province|county|prefecture|都道府県/i }).first();
  if (await combo.isVisible({ timeout: 2000 }).catch(() => false)) {
    await combo.click();
    await page.waitForTimeout(400);
    const opt = page.getByRole('option', { name: re }).first();
    if (await opt.isVisible({ timeout: 4000 }).catch(() => false)) {
      await opt.click();
      console.log('[acc-purchase] Selected prefecture/region via combobox');
      return true;
    }
    const fallback = page.getByRole('option').filter({ hasText: re }).first();
    if (await fallback.isVisible({ timeout: 2000 }).catch(() => false)) {
      await fallback.click();
      return true;
    }
    await page.keyboard.press('Escape');
  }

  const stText = page.getByRole('textbox', { name: /state|region|province|county|prefecture|都道府県/i }).first();
  if (await tryFill(stText, v, 2000)) return true;

  if (String(billingCountry || '').toUpperCase() === 'JP') {
    const jp = page.getByRole('combobox', { name: /prefecture|都道府県|province/i }).first();
    if (await jp.isVisible({ timeout: 1500 }).catch(() => false)) {
      await jp.click();
      await page.waitForTimeout(400);
      const o = page.getByRole('option', { name: re }).first();
      if (await o.isVisible({ timeout: 3500 }).catch(() => false)) {
        await o.click();
        return true;
      }
      await page.keyboard.press('Escape');
    }
  }

  return false;
}

/**
 * Stripe sets stable DOM ids (`billingAddressLine1`, …). Line 1 is often combobox or plain input —
 * `getByRole('textbox', /address line 1/)` misses it, so only postal (ZIP) matched before.
 * Prefer ids first; then callers may still use a11y fallbacks.
 * @param {import('playwright').Page} page
 * @param {{ addr1?: string, addr2?: string, city?: string, state?: string, zip?: string }} fields
 * @param {string | null} billingCountry ISO2
 */
async function fillStripeHostedBillingByStableIds(page, fields, billingCountry) {
  const { addr1, addr2, city, state, zip } = fields;
  const bc = String(billingCountry || '').toUpperCase();

  const line1 = page.locator('#billingAddressLine1, input[name="billingAddressLine1"]');
  if (addr1 && String(addr1).trim() && (await line1.first().isVisible({ timeout: 2000 }).catch(() => false))) {
    await line1.first().click({ timeout: 800 }).catch(() => {});
    await line1.first().fill(String(addr1).trim());
  }

  const line2 = page.locator('#billingAddressLine2, input[name="billingAddressLine2"]');
  if (addr2 && String(addr2).trim() && (await line2.first().isVisible({ timeout: 800 }).catch(() => false))) {
    await line2.first().fill(String(addr2).trim());
  }

  const cityEl = page.locator(
    '#billingLocality, input[name="billingLocality"], input[autocomplete="address-level2"]'
  );
  if (city && String(city).trim() && (await cityEl.first().isVisible({ timeout: 1800 }).catch(() => false))) {
    await cityEl.first().fill(String(city).trim());
  }

  if (state && String(state).trim()) {
    const sv = String(state).trim();
    const sel = page.locator('select#billingAdministrativeArea, select[name="billingAdministrativeArea"]').first();
    if (await sel.isVisible({ timeout: 2000 }).catch(() => false)) {
      const code = sv.toUpperCase();
      let picked = false;
      if (code.length === 2 && (bc === 'US' || bc === 'CA')) {
        try {
          await sel.selectOption({ value: code });
          picked = true;
        } catch {
          /* option values may be full names — fall through */
        }
      }
      if (!picked) {
        await trySelectRegionOrPrefecture(page, sv, billingCountry);
      }
    } else {
      await trySelectRegionOrPrefecture(page, sv, billingCountry);
    }
  }

  const zipEl = page.locator(
    '#billingPostalCode, input[name="billingPostalCode"], input[autocomplete="postal-code"]'
  );
  if (zip && String(zip).trim() && (await zipEl.first().isVisible({ timeout: 1800 }).catch(() => false))) {
    await zipEl.first().fill(String(zip).trim());
  }
}

/**
 * Fill whatever Stripe shows: US/CA need full line1/city/state/postal when required;
 * other countries may only show postal or a minimal set — probe visible fields.
 */
/**
 * Hosted Checkout: line total does not refresh until **Update** is clicked (otherwise qty stays 1).
 * @param {import('playwright').Page} page
 */
async function clickStripeHostedQuantityUpdate(page) {
  const candidates = [
    page.getByRole('button', { name: /^update$/i }),
    page.getByRole('button', { name: /update/i }),
    page.locator('button').filter({ hasText: /^update$/i }),
  ];
  for (const loc of candidates) {
    const btn = loc.first();
    if (await btn.isVisible({ timeout: 4500 }).catch(() => false)) {
      await btn.click({ timeout: 10000 });
      await page.waitForTimeout(1000);
      console.log('[acc-purchase] Clicked Stripe hosted quantity Update');
      return true;
    }
  }
  console.warn(
    '[acc-purchase] Stripe hosted quantity Update not found — total may still show qty 1 until Update is clicked'
  );
  return false;
}

/**
 * Prefer typing the quantity directly (spinbutton / text / number), not one-by-one + clicks.
 * @param {import('playwright').Page} page
 * @param {number} n
 */
async function fillStripeHostedQuantityFieldDirect(page, n) {
  const str = String(n);
  const spin = page.getByRole('spinbutton').first();
  if (await spin.isVisible({ timeout: 5000 }).catch(() => false)) {
    await spin.click({ timeout: 3000 }).catch(() => {});
    await spin.press('Control+a').catch(() => {});
    await spin.press('Meta+a').catch(() => {});
    await spin.fill(str);
    await page.waitForTimeout(200);
    console.log('[acc-purchase] Filled Stripe qty field (spinbutton) →', str);
    return true;
  }
  const byName = page.locator('input[name="quantity"]');
  if (await byName.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await byName.first().click().catch(() => {});
    await byName.first().fill(str);
    console.log('[acc-purchase] Filled Stripe qty field (input[name=quantity]) →', str);
    return true;
  }
  const num = page
    .locator('input[type="number"]')
    .filter({ hasNot: page.locator('[name*="card" i]') })
    .first();
  if (await num.isVisible({ timeout: 3000 }).catch(() => false)) {
    await num.click().catch(() => {});
    await num.fill(str);
    console.log('[acc-purchase] Filled Stripe qty field (input[type=number]) →', str);
    return true;
  }
  return false;
}

/**
 * On Stripe hosted checkout only: set line-item quantity **before** card/billing address.
 * When qty is 1, skip (Insight may already match; address-first was causing mismatches).
 * @param {import('playwright').Page} page
 * @param {number} qty
 */
async function setHostedStripeQuantityBeforeBilling(page, qty) {
  const n = Math.max(1, parseInt(String(qty || 1), 10) || 1);
  if (n <= 1) {
    console.log('[acc-purchase] Hosted checkout qty is 1 — skip Stripe line-item step; card/address next');
    return;
  }
  const u = page.url();
  if (!/stripe\.com/i.test(u)) {
    console.warn('[acc-purchase] setHostedStripeQuantityBeforeBilling: not on stripe.com — skipping');
    return;
  }
  console.log('[acc-purchase] Stripe hosted page: set line quantity to', n, 'before card and address');

  await page.waitForTimeout(600);

  // Hosted Checkout often collapses line-item qty behind a "Qty N" pill — open it before spinbutton/input is in the a11y tree.
  const spinPrecheck = page.getByRole('spinbutton').first();
  if (!(await spinPrecheck.isVisible({ timeout: 2000 }).catch(() => false))) {
    const qtyLineToggle = page
      .getByRole('button', { name: /^Qty\s*\d+/i })
      .or(page.locator('button').filter({ hasText: /^Qty\s*\d+/ }))
      .first();
    if (await qtyLineToggle.isVisible({ timeout: 5000 }).catch(() => false)) {
      await qtyLineToggle.click();
      await page.waitForTimeout(700);
      console.log('[acc-purchase] Opened Stripe line-item quantity editor (Qty button)');
    }
  }

  if (await fillStripeHostedQuantityFieldDirect(page, n)) {
    await clickStripeHostedQuantityUpdate(page);
    return;
  }

  const inc = page
    .locator('button[aria-label*="Increase" i]')
    .or(page.locator('button[aria-label*="increment" i]'))
    .first();
  if (await inc.isVisible({ timeout: 3500 }).catch(() => false)) {
    console.warn('[acc-purchase] No direct qty text field — falling back to increment buttons');
    for (let i = 1; i < n; i++) {
      await inc.click();
      await page.waitForTimeout(180);
    }
    await page.waitForTimeout(300);
    await clickStripeHostedQuantityUpdate(page);
    return;
  }

  console.warn(
    '[acc-purchase] Could not locate Stripe hosted quantity control — continuing with billing (verify total manually)'
  );
}

async function fillStripeBillingAdaptive(page, opts, card, holder) {
  const addr = opts.address || {};
  const rawCc = addr.countryCode != null ? String(addr.countryCode).trim() : '';
  const explicitCountryOverride = rawCc.length > 0;
  let billingCountry = explicitCountryOverride ? rawCc.toUpperCase() : null;
  const previewMode = !!opts.previewMode;

  if (!previewMode) {
    await page.evaluate(() => {
      document.querySelector('[data-testid="card-accordion-item-button"]')?.click();
    });
    await page.waitForTimeout(500);

    const cardEl = page.locator('#cardNumber');
    const expiryRaw = String(card.expiry || '12/30');
    const expiryDigits = expiryRaw.replace(/\D/g, '');
    const embedExpiry = expiryDigits.length === 4 ? `${expiryDigits.slice(0, 2)}${expiryDigits.slice(2, 4)}` : expiryRaw;

    if (await cardEl.isVisible({ timeout: 8000 }).catch(() => false)) {
      await cardEl.fill(card.number);
      await page.locator('#cardExpiry').fill(embedExpiry);
      await page.locator('#cardCvc').fill(card.cvc);
      const nameField = page.locator('#billingName');
      if (await nameField.isVisible().catch(() => false)) await nameField.fill(holder);
    } else {
      await page.getByRole('textbox', { name: /card number/i }).first().fill(card.number);
      const exp = page.getByRole('textbox', { name: /expiration|expir/i }).first();
      if (await exp.isVisible({ timeout: 5000 }).catch(() => false)) {
        const disp =
          expiryDigits.length === 4 ? `${expiryDigits.slice(0, 2)}/${expiryDigits.slice(2, 4)}` : expiryRaw;
        await exp.fill(disp);
      }
      const cvc = page.getByRole('textbox', { name: /cvc|security code/i }).first();
      if (await cvc.isVisible().catch(() => false)) await cvc.fill(card.cvc);
      const name = page.getByRole('textbox', { name: /name on card|cardholder/i }).first();
      if (await name.isVisible().catch(() => false)) await name.fill(holder);
    }
  } else {
    console.log('[acc-purchase] previewMode: skip card PAN; open payment accordion for billing fields');
    await page.evaluate(() => {
      document.querySelector('[data-testid="card-accordion-item-button"]')?.click();
    });
    await page.waitForTimeout(500);
  }

  if (explicitCountryOverride && billingCountry) {
    const ok = await setStripeBillingCountryIfPossible(page, billingCountry);
    if (!ok) {
      console.warn('[acc-purchase] Billing country may still be checkout default — fill uses address.countryCode:', billingCountry);
    }
    const verify = await readStripeCheckoutCountryCode(page);
    if (verify) billingCountry = verify;
  } else {
    console.log('[acc-purchase] Leaving Stripe country/region as checkout default (no countryCode in request)');
    await page.waitForTimeout(400);
    const readBack = await readStripeCheckoutCountryCode(page);
    if (readBack) {
      billingCountry = readBack;
      console.log('[acc-purchase] Detected checkout billing country for address rules:', billingCountry);
    }
  }

  const needFull =
    (billingCountry != null && requiresFullStripeAddress(billingCountry)) || !!opts.fillFullAddress;

  const manual = page.getByRole('button', { name: /enter address manually/i });
  const visibleOnly = opts.stripeFillVisibleBillingOnly !== false;
  if (!visibleOnly) {
    if (needFull && (await manual.isVisible({ timeout: 4500 }).catch(() => false))) {
      await manual.click();
      await page.waitForTimeout(350);
    } else if (!needFull && (await manual.isVisible({ timeout: 2500 }).catch(() => false))) {
      await manual.click();
      await page.waitForTimeout(300);
    }
  } else if (await manual.isVisible({ timeout: 4000 }).catch(() => false)) {
    await manual.click();
    await page.waitForTimeout(350);
  }

  const defaultsUS = {
    addr1: '350 East Plumeria Drive',
    city: 'San Jose',
    state: 'CA',
    zip: '95134',
  };
  const defaultsCA = {
    addr1: '100 Queen Street West',
    city: 'Toronto',
    state: 'ON',
    zip: 'M5H 2N2',
  };

  const def =
    billingCountry === 'CA' ? defaultsCA : billingCountry === 'US' ? defaultsUS : null;
  /** US/CA defaults apply whenever fields are missing — including preview (`stripeFillVisibleBillingOnly`). */
  const line1 = String(addr.addr1 || '').trim() || (def ? def.addr1 : '') || '';
  const line2 = String(addr.addr2 || '').trim() || '';
  const city = String(addr.city || '').trim() || (def ? def.city : '') || '';
  const state = String(addr.state || '').trim() || (def ? def.state : '') || '';
  const zip = String(addr.zip || '').trim() || (def ? def.zip : '') || '';

  const a1 = page.getByRole('textbox', { name: /address line 1|street address/i }).first();
  const a2 = page.getByRole('textbox', { name: /address line 2|apartment|suite|building|unit/i }).first();
  const suburb = page.getByRole('textbox', { name: /suburb|district|ward/i }).first();
  const cityBox = page.getByRole('textbox', { name: /^city$/i }).first();
  const zipBox = page
    .getByRole('textbox', { name: /postal|zip|pin|postcode/i })
    .or(page.getByLabel(/postal|zip|pin|postcode/i))
    .first();

  const companyField = page
    .getByRole('textbox', { name: /company|organization|business|firm/i })
    .first();
  await tryFill(companyField, opts.companyName || addr.company, 800);

  await fillStripeHostedBillingByStableIds(
    page,
    { addr1: line1, addr2: line2, city, state, zip },
    billingCountry
  );

  if (visibleOnly || needFull) {
    await tryFill(a1, line1, 1000);
    await tryFill(a2, line2, 700);
    if (addr.suburb && String(addr.suburb).trim()) {
      await tryFill(suburb, addr.suburb, 700);
    }
    if (city) {
      const cityOk = await tryFillCityAny(page, city, 1200);
      if (!cityOk) {
        await tryFill(suburb, city, 800);
        await tryFill(cityBox, city, 1000);
      }
    }
    if (state) {
      const picked = await trySelectRegionOrPrefecture(page, state, billingCountry);
      if (!picked) {
        const sel = page
          .locator(
            'select[name="billingAdministrativeArea"], select#billingAdministrativeArea, select[name="billingAddress.state"], select[autocomplete="address-level1"]'
          )
          .first();
        if (await sel.isVisible({ timeout: 900 }).catch(() => false)) {
          const opt = sel
            .locator('option')
            .filter({ hasText: new RegExp(escapeRe(state), 'i') })
            .first();
          const label = await opt.textContent().catch(() => '');
          if (label?.trim()) {
            await sel.selectOption({ label: label.trim() }).catch(() => {});
          } else {
            await sel.selectOption({ index: 1 }).catch(() => {});
          }
        } else {
          const st = page.getByRole('textbox', { name: /state|region|province|county|prefecture/i }).first();
          await tryFill(st, state, 1000);
        }
      }
    }
    await tryFill(zipBox, zip, 1200);
  } else {
    await tryFill(zipBox, zip, 1500);
    if (opts.fillFullAddress && addr.addr1) {
      await fillStripeHostedBillingByStableIds(
        page,
        {
          addr1: addr.addr1,
          addr2: addr.addr2 || '',
          city: addr.city || '',
          state: addr.state || '',
          zip: addr.zip || '',
        },
        billingCountry
      );
      await tryFill(a1, addr.addr1, 1000);
      await tryFill(a2, addr.addr2, 700);
      if (addr.city) {
        if (!(await tryFill(suburb, addr.city, 800))) await tryFill(cityBox, addr.city, 1000);
      }
      if (addr.state) {
        const st = page.getByRole('textbox', { name: /state|region|province|county/i }).first();
        await tryFill(st, addr.state, 1000);
      }
    }
  }

  if (!previewMode) {
    const pauseMs = opts.postFillSettleMs != null ? opts.postFillSettleMs : 3500;
    if (pauseMs > 0) {
      console.log(`[acc-purchase] Post-fill settle ${pauseMs}ms before terms / Pay`);
      await page.waitForTimeout(pauseMs);
    }
  }

  if (!previewMode && opts.businessPurchase) {
    const biz = page.getByRole('checkbox', { name: /purchasing as a business/i });
    if (await biz.isVisible({ timeout: 5000 }).catch(() => false)) await biz.check();
    await page.waitForTimeout(500);

    if (opts.taxIdTypeHint) {
      const typeCombo = page.getByRole('combobox', { name: /tax id type|vat type|tax id/i });
      if (await typeCombo.first().isVisible({ timeout: 4000 }).catch(() => false)) {
        await typeCombo.first().click();
        const opt = page.getByRole('option', { name: new RegExp(opts.taxIdTypeHint, 'i') });
        if (await opt.first().isVisible({ timeout: 2500 }).catch(() => false)) await opt.first().click();
        else await page.keyboard.press('Escape');
      }
    }
    if (opts.businessId) {
      const tid = page
        .getByRole('textbox', { name: /tax id|vat|abn|gstin/i })
        .or(page.locator('input[name*="tax" i]'));
      if (await tid.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await tid.first().fill(opts.businessId);
      }
    }
  }
}

/**
 * Navigate from Manage Subscriptions → prepaid plan → Checkout until Stripe hosted page loads.
 * Does not fill billing or submit payment (use with fillStripeBillingAdaptive + previewMode for capture-only runs).
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {'1-Year'|'3-Year'} opts.plan
 * @param {number} [opts.qty]
 * @param {boolean} [opts.skipManageSubsGoto]
 * @param {string} [opts.manageSubsUrl]
 * @param {number} [opts.navigationTimeoutMs]
 * @param {number} [opts.stripeSettleMs] — wait after Stripe URL (default 2000; set 0 to skip)
 */
async function navigateInsightToHostedStripeCheckout(page, opts) {
  const plan = opts.plan === '3-Year' ? '3-Year' : '1-Year';
  const qty = Math.max(1, parseInt(String(opts.qty || 1), 10) || 1);
  const gotoTimeout = opts.navigationTimeoutMs ?? 120000;
  const manageSubs = opts.manageSubsUrl || DEFAULT_MANAGE_SUBS;

  if (opts.skipManageSubsGoto) {
    console.log('[acc-purchase] navigateInsightToHostedStripeCheckout: skip goto — waiting on Manage Subscriptions');
    await page
      .getByRole('heading', { name: /manage subscriptions/i })
      .waitFor({ state: 'visible', timeout: 90000 })
      .catch(() => {});
    await page.waitForTimeout(4000);
  } else {
    await page.goto(manageSubs, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
    await page.waitForTimeout(5000);
  }

  await clickChoosePlanOnPrepaidCard(page, plan);
  await page.waitForTimeout(2500);

  await setInsightPlanQuantityBeforeStripe(page, qty);

  const goToStripe = page
    .getByRole('button', { name: /^checkout$/i })
    .or(page.getByRole('button', { name: /^subscribe$/i }))
    .first();
  if (await goToStripe.isVisible({ timeout: 30000 }).catch(() => false)) {
    await waitUntilLocatorEnabled(page, goToStripe, 90000);
    await goToStripe.click();
  }

  await page.waitForURL(/checkout\.stripe\.com|stripe\.com\/c\//i, { timeout: 120000 });
  await page.waitForLoadState('domcontentloaded');
  const hostedLandAt = Date.now();
  const stripeCheckoutUrl = page.url();
  console.log('[acc-purchase] navigateInsightToHostedStripeCheckout URL:', stripeCheckoutUrl);
  const settleMs = opts.stripeSettleMs != null ? opts.stripeSettleMs : 2000;
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  return { stripeCheckoutUrl, hostedLandAt };
}

/**
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {'1-Year'|'3-Year'} opts.plan
 * @param {number} [opts.qty]
 * @param {boolean} [opts.fillFullAddress] — for non-US/CA, opt in to full manual address; US/CA always full when Stripe requires it
 * @param {object} [opts.address] addr1, addr2?, city, state?, zip?, countryCode (ISO2)
 * @param {boolean} [opts.businessPurchase]
 * @param {string} [opts.businessId] VAT / ABN / GSTIN etc.
 * @param {string} [opts.taxIdTypeHint] e.g. ABN, GB
 * @param {string} [opts.cardholder]
 * @param {object} [opts.card] number, expiry, cvc
 * @param {number} [opts.maxWaitMs]
 * @param {'HB'|'NHB'|'na'} [opts.deviceContext] logged only
 * @param {boolean} [opts.skipManageSubsGoto] if true, caller already opened Manage Subscriptions — wait for UI instead of goto
 * @param {string} [opts.manageSubsUrl] full Manage Subscriptions URL (pri-qa vs maint-beta from insight-env)
 */
async function runInsightHostedPurchase(page, opts) {
  const plan = opts.plan === '3-Year' ? '3-Year' : '1-Year';
  const qty = Math.max(1, parseInt(String(opts.qty || 1), 10) || 1);
  const maxWait = opts.maxWaitMs ?? 360000;
  const card = { ...DEFAULT_CARD, ...(opts.card || {}) };
  const holder = opts.cardholder || 'Test Navigator';
  const gotoTimeout = opts.navigationTimeoutMs ?? 120000;
  /** Logged + returned for API consumers (e.g. copy session id from URL). */
  let stripeCheckoutUrlCaptured = null;

  if (opts.deviceContext && opts.deviceContext !== 'na') {
    console.log(`[acc-purchase] deviceContext=${opts.deviceContext} (informational)`);
  }

  const navResult = await navigateInsightToHostedStripeCheckout(page, {
    plan,
    qty,
    skipManageSubsGoto: opts.skipManageSubsGoto,
    manageSubsUrl: opts.manageSubsUrl,
    navigationTimeoutMs: gotoTimeout,
    stripeSettleMs: STRIPE_HOSTED_SETTLE_MS,
  });
  stripeCheckoutUrlCaptured = navResult.stripeCheckoutUrl;
  const stripeHostedLandAt = navResult.hostedLandAt;

  console.log('[acc-purchase] Stripe checkout URL:', stripeCheckoutUrlCaptured);

  await setHostedStripeQuantityBeforeBilling(page, qty);
  await fillStripeBillingAdaptive(page, opts, card, holder);

  const submitResult = await submitStripeHostedCheckout(page, {
    maxWaitMs: maxWait,
    hostedLandAt: stripeHostedLandAt,
  });
  return {
    ...submitResult,
    stripeCheckoutUrl: stripeCheckoutUrlCaptured,
  };
}

/**
 * After hosted checkout is filled (card + billing), accept terms and click Pay/Subscribe — then wait for return to Insight.
 * If the pay control never enables, returns `needsInteractivePurchase: true` (finish in Playwright MCP / headed session).
 * @param {import('playwright').Page} page
 * @param {{ maxWaitMs?: number, hostedLandAt?: number, maxWaitForEnabledMs?: number }} [opts]
 */
/**
 * Stripe hosted Pay/Subscribe is easy to miss (viewport, overlays, shadow). Scroll, then normal → force → DOM .click() if still "enabled".
 */
async function clickStripeHostedSubmitButton(page) {
  const submit = page.getByTestId('hosted-payment-submit-button');
  await submit.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  try {
    await submit.click({ timeout: 12000 });
  } catch (e) {
    console.warn('[acc-purchase] Pay click (first):', e.message || e);
    await submit.click({ force: true, timeout: 10000 }).catch(() => {});
  }

  await page.waitForTimeout(900);

  let stillClickable = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="hosted-payment-submit-button"]');
    return !!(el && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  });

  if (stillClickable) {
    console.warn('[acc-purchase] Pay still looks enabled — sending native DOM click()');
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="hosted-payment-submit-button"]');
      if (el) el.click();
    });
    await page.waitForTimeout(500);
    stillClickable = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="hosted-payment-submit-button"]');
      return !!(el && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    });
  }

  if (stillClickable) {
    const box = await submit.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(400);
    }
  }
}

async function submitStripeHostedCheckout(page, opts = {}) {
  const maxWait = opts.maxWaitMs ?? 360000;
  const stripeHostedLandAt = opts.hostedLandAt != null ? opts.hostedLandAt : Date.now();
  const maxEnable = opts.maxWaitForEnabledMs ?? 60000;

  const terms = page.getByRole('checkbox', { name: /agree|terms|NETGEAR/i });
  if (await terms.first().isVisible({ timeout: 6000 }).catch(() => false)) {
    if (!(await terms.first().isChecked().catch(() => true))) {
      await terms.first().click({ force: true });
    }
  }

  const submit = page.getByTestId('hosted-payment-submit-button');
  await submit.waitFor({ state: 'visible', timeout: 45000 });

  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="hosted-payment-submit-button"]');
        return el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      },
      { timeout: maxEnable }
    );
  } catch (e) {
    await waitUntilLocatorEnabled(page, submit, Math.min(20000, maxEnable)).catch(() => {});
  }

  const enabled = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="hosted-payment-submit-button"]');
    return !!(el && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  });

  if (!enabled) {
    const checkoutUrl = page.url();
    console.warn('[acc-purchase] Pay/Subscribe did not become enabled — flag for interactive MCP completion');
    return {
      success: false,
      needsInteractivePurchase: true,
      error:
        'Payment button stayed disabled after fill — complete purchase interactively (Playwright MCP): choose prefecture/region if needed, then Pay.',
      checkoutUrl,
    };
  }

  const msOnStripe = Date.now() - stripeHostedLandAt;
  const padSubmit = Math.max(0, STRIPE_HOSTED_SETTLE_MS - msOnStripe);
  if (padSubmit > 0) {
    console.log(
      `[acc-purchase] Waiting ${padSubmit}ms before Subscribe/Pay (min ${STRIPE_HOSTED_SETTLE_MS}ms on Stripe since load)`
    );
    await page.waitForTimeout(padSubmit);
  } else {
    console.log(
      `[acc-purchase] Subscribe/Pay: ${msOnStripe}ms already elapsed on Stripe — clicking when enabled`
    );
  }

  await clickStripeHostedSubmitButton(page);

  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    const u = page.url();
    if (/\.insight\.netgear\.com/i.test(u)) {
      await page.waitForTimeout(5000);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      return {
        success: true,
        url: page.url(),
        needsInteractivePurchase: false,
      };
    }
    await page.waitForTimeout(5000);
  }

  return {
    success: false,
    needsInteractivePurchase: true,
    error: `Timeout waiting for return to Insight after ${maxWait}ms (url: ${page.url()})`,
    checkoutUrl: page.url(),
  };
}

module.exports = {
  runInsightHostedPurchase,
  MANAGE_SUBS,
  navigateInsightToHostedStripeCheckout,
  setHostedStripeQuantityBeforeBilling,
  fillStripeBillingAdaptive,
  submitStripeHostedCheckout,
  clickStripeHostedSubmitButton,
  DEFAULT_CARD,
};
