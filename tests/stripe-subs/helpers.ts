/**
 * Shared helpers for Drop 5 Stripe migration test suites.
 * Provides reusable login, navigation, dialog dismissal, and assertion utilities.
 */
import { expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/* ── Serial Number Generator (mirrors HB_NHB.py) ── */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const HB_CSV = path.join(PROJECT_ROOT, 'hb_prefixes.csv');
const NHB_CSV = path.join(PROJECT_ROOT, 'nhb_prefixes.csv');

export type DeviceType = 'HB' | 'NHB';

export function generateSerial(type: DeviceType = 'NHB'): string {
  const csvPath = type === 'HB' ? HB_CSV : NHB_CSV;
  const raw = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const header = raw[0];
  const firstRow = raw[1].split(',');
  const prefix = firstRow[0];
  const nextNum = parseInt(firstRow[1], 10) + 1;

  const updatedLines = [header, `${prefix},${nextNum}`, ...raw.slice(2)];
  fs.writeFileSync(csvPath, updatedLines.join('\n') + '\n');

  return `${prefix}${String(nextNum).padStart(10, '0')}`;
}

export const BASE = 'https://pri-qa.insight.netgear.com';
export const PWD = 'Lkjhgfdsa123456789!';
export const CARDS = {
  visa: '4242424242424242',
  mastercard: '5555555555554444',
  amex: '378282246310005',
  discover: '6011111111111117',
  diners: '30569309025904',
  jcb: '3566002020360505',
  unionpay: '6200000000000005',
  declined: '4000000000000002',
  insufficient: '4000000000009995',
  expired: '4000000000000069',
  badcvc: '4000000000000127',
  threeds: '4000002500003155',
} as const;

export const STRIPE_TEST_CARD = CARDS.visa;
export const STRIPE_DECLINED_CARD = CARDS.declined;
export const STRIPE_INSUFFICIENT_CARD = CARDS.insufficient;
export const CARD_EXPIRY = '1230';
export const CARD_CVC = '123';
export const CARD_ZIP = '10001';

export const PRICES: Record<string, { '1yr': string; '3yr': string }> = {
  USD: { '1yr': '9.99', '3yr': '29.97' },
  EUR: { '1yr': '9.99', '3yr': '29.97' },
  GBP: { '1yr': '8.95', '3yr': '26.85' },
  JPY: { '1yr': '1125', '3yr': '3375' },
  AUD: { '1yr': '14.50', '3yr': '43.50' },
  CAD: { '1yr': '12.75', '3yr': '38.25' },
  CHF: { '1yr': '10', '3yr': '30' },
  CZK: { '1yr': '230', '3yr': '690' },
  DKK: { '1yr': '64', '3yr': '192' },
  HKD: { '1yr': '78', '3yr': '234' },
  HUF: { '1yr': '3057', '3yr': '9171' },
  NOK: { '1yr': '93', '3yr': '279' },
  NZD: { '1yr': '16', '3yr': '48' },
  PLN: { '1yr': '39', '3yr': '117' },
  SEK: { '1yr': '89', '3yr': '267' },
  SGD: { '1yr': '14', '3yr': '42' },
  ZAR: { '1yr': '166', '3yr': '498' },
};

export const ACCOUNTS = {
  '1yr': { email: 'stripe1yr.final@yopmail.com', org: 'Stripe1Yr-TestOrg', loc: 'Loc1yr' },
  '3yr': { email: 'stripe3yr.final@yopmail.com', org: 'Stripe3Yr-TestOrg', loc: 'Loc3yr' },
} as const;

export const SUPPORTED_COUNTRIES = [
  { name: 'Australia', code: 'AU' }, { name: 'Austria', code: 'AT' },
  { name: 'Belgium', code: 'BE' }, { name: 'Bulgaria', code: 'BG' },
  { name: 'Canada', code: 'CA' }, { name: 'Croatia', code: 'HR' },
  { name: 'Cyprus', code: 'CY' }, { name: 'Czech Republic', code: 'CZ' },
  { name: 'Denmark', code: 'DK' }, { name: 'Estonia', code: 'EE' },
  { name: 'Finland', code: 'FI' }, { name: 'France', code: 'FR' },
  { name: 'Germany', code: 'DE' }, { name: 'Greece', code: 'GR' },
  { name: 'Hong Kong', code: 'HK' }, { name: 'Hungary', code: 'HU' },
  { name: 'Ireland', code: 'IE' }, { name: 'Italy', code: 'IT' },
  { name: 'Japan', code: 'JP' }, { name: 'Latvia', code: 'LV' },
  { name: 'Lithuania', code: 'LT' }, { name: 'Luxembourg', code: 'LU' },
  { name: 'Malta', code: 'MT' }, { name: 'Netherlands', code: 'NL' },
  { name: 'New Zealand', code: 'NZ' }, { name: 'Norway', code: 'NO' },
  { name: 'Poland', code: 'PL' }, { name: 'Portugal', code: 'PT' },
  { name: 'Romania', code: 'RO' }, { name: 'Singapore', code: 'SG' },
  { name: 'Slovakia', code: 'SK' }, { name: 'Slovenia', code: 'SI' },
  { name: 'South Africa', code: 'ZA' }, { name: 'Spain', code: 'ES' },
  { name: 'Sweden', code: 'SE' }, { name: 'Switzerland', code: 'CH' },
  { name: 'United Kingdom', code: 'GB' }, { name: 'United States of America', code: 'US' },
];

export const UNSUPPORTED_COUNTRIES_SAMPLE = [
  { name: 'India', code: 'IN' }, { name: 'China', code: 'CN' },
  { name: 'Brazil', code: 'BR' }, { name: 'Mexico', code: 'MX' },
  { name: 'Russia', code: 'RU' }, { name: 'Turkey', code: 'TR' },
];

export async function checkInvalidSession(page: Page, step: string, prefix: string): Promise<void> {
  const popup = page.getByText(/invalid session|session expired|session timed out/i);
  if (await popup.isVisible().catch(() => false)) {
    await page.screenshot({ path: `test-results/evidence/${prefix}-BUG-invalid-session-${step}.png`, fullPage: true });
    throw new Error(`BUG: "Invalid Session" popup at step "${step}". This should not happen.`);
  }
}

export async function dismissDialogs(page: Page): Promise<void> {
  try { await page.getByRole('button', { name: /No Thank You/i }).click({ timeout: 5_000 }); } catch {}
  try { await page.getByRole('button', { name: /later|skip|not now/i }).click({ timeout: 2_000 }); } catch {}
  try { await page.getByRole('button', { name: /close|got it|ok/i }).first().click({ timeout: 3_000 }); } catch {}
}

/**
 * Wait for the page to show meaningful content (any heading, nav, or MUI element).
 * Uses polling with Playwright's built-in timeout — no fixed sleeps.
 */
async function waitForPageReady(page: Page, timeout = 30_000): Promise<void> {
  try {
    await page.locator('h1, h2, h3, h4, [role="heading"], nav, .MuiTypography-root').first()
      .waitFor({ state: 'visible', timeout });
  } catch {
    console.log('[Wait] Page content did not appear within timeout — proceeding anyway');
  }
}

/**
 * Login flow:
 *  1. /mui/ → landing page → click "Login Now"
 *  2. accounts2-stg.netgear.com → fill email/password → "NETGEAR Sign In"
 *  3. Redirects to /mui/newLogin (org+loc wizard) OR /mui/mspHome/dashboard
 *  4. If wizard: fill Org Name → Next → fill Location Name → finish → lands on dashboard
 */
export async function login(page: Page, email: string, prefix: string, base = BASE): Promise<void> {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForPageReady(page, 20_000);

  const loginNowBtn = page.getByRole('button', { name: /Login Now/i });
  if (await loginNowBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await loginNowBtn.click();
    await waitForPageReady(page, 20_000);
  } else {
    const redirectUrl = encodeURIComponent(`${base}/`);
    await page.goto(
      `https://auth-stg.netgear.com/login?theme=insight&redirectUrl=${redirectUrl}`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );
  }

  const emailField = page.locator('input[type="email"], #email').first()
    .or(page.getByPlaceholder(/email/i));
  await emailField.first().waitFor({ state: 'visible', timeout: 20_000 });
  await emailField.first().fill(email);

  const pwdField = page.locator('input[type="password"], #password').first();
  await pwdField.first().fill(PWD);

  await page.getByRole('button', { name: /NETGEAR Sign In|Sign In|Login/i }).first().click();
  console.log('[Login] Signing in — waiting for redirect...');

  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await waitForPageReady(page, 30_000);
  await page.screenshot({ path: `test-results/evidence/${prefix}-post-signin.png`, fullPage: true });
  console.log(`[Login] Post-signin URL: ${page.url()}`);

  if (page.url().includes('failSafe')) {
    console.log('[Login] failSafeSupport detected — waiting for redirect...');
    await page.waitForURL(/(?!.*failSafe)/, { timeout: 30_000 }).catch(() => {});
    if (page.url().includes('failSafe')) {
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await waitForPageReady(page, 30_000);
    }
    console.log(`[Login] After failSafe: ${page.url()}`);
  }

  await dismissDialogs(page);
  await checkInvalidSession(page, 'post-signin', prefix);

  await handleOnboarding(page, prefix);

  await waitForPageReady(page, 20_000);
  console.log(`[Login] Final URL: ${page.url()}`);

  if (!page.url().includes('mspHome')) {
    console.log('[Login] Not on mspHome — navigating to dashboard');
    await page.goto(`${base}/mspHome/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForPageReady(page, 20_000);
  }
  await checkInvalidSession(page, 'login-final', prefix);
}

/**
 * Handle the /mui/newLogin onboarding wizard for fresh accounts.
 *
 *  Step 1 (if shown): Create Organization → fill "Organization Name" → "Next"
 *  Step 2: Create Location → fill "Location Name" + "Device Admin Password" → "Next"
 */
async function handleOnboarding(page: Page, prefix: string): Promise<void> {
  const isWizard = page.url().includes('newLogin') ||
    page.url().includes('failSafe');

  if (!isWizard) {
    const hasOrgH = await page.getByRole('heading', { name: /Create Organization/i }).isVisible({ timeout: 5_000 }).catch(() => false);
    const hasLocH = await page.getByRole('heading', { name: /Create Location/i }).isVisible({ timeout: 3_000 }).catch(() => false);
    if (!hasOrgH && !hasLocH) return;
  }

  const ts = Date.now().toString(36);
  console.log('[Onboarding] Wizard detected');
  await waitForPageReady(page, 30_000);
  await page.screenshot({ path: `test-results/evidence/${prefix}-onboarding-start.png`, fullPage: true });

  // ── Step 1: Create Organization ──
  const orgHeading = page.getByRole('heading', { name: /Create Organization/i }).first();
  if (await orgHeading.isVisible({ timeout: 10_000 }).catch(() => false)) {
    console.log('[Onboarding] Step 1: Create Organization');
    const orgInput = page.locator('input[type="text"]').first();
    await orgInput.waitFor({ state: 'visible', timeout: 15_000 });
    await orgInput.fill(`Org-${prefix}-${ts}`);

    const nextBtn = page.getByRole('button', { name: 'Next' });
    await nextBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await nextBtn.click();
    console.log('[Onboarding] Org submitted — waiting for Location step...');

    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await waitForPageReady(page, 30_000);
    await page.screenshot({ path: `test-results/evidence/${prefix}-onboarding-after-org.png`, fullPage: true });
  } else {
    console.log('[Onboarding] Org step not shown — already done');
  }

  // ── Step 2: Create Location ──
  const locHeading = page.getByRole('heading', { name: /Create Location/i }).first();
  let locVisible = await locHeading.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!locVisible) {
    try {
      await locHeading.waitFor({ state: 'visible', timeout: 30_000 });
      locVisible = true;
    } catch {
      console.log('[Onboarding] Location step never appeared — may already be done');
    }
  }

  if (locVisible) {
    console.log('[Onboarding] Step 2: Create Location');
    await page.screenshot({ path: `test-results/evidence/${prefix}-onboarding-loc.png`, fullPage: true });

    const locInput = page.locator('input[type="text"]').first();
    await locInput.waitFor({ state: 'visible', timeout: 15_000 });
    await locInput.fill(`Loc-${prefix}-${ts}`);
    console.log(`[Onboarding] Location name: Loc-${prefix}-${ts}`);

    const devicePwd = page.locator('input[type="password"]');
    if (await devicePwd.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await devicePwd.first().fill(PWD);
      console.log('[Onboarding] Device Admin Password filled');
    }

    await page.screenshot({ path: `test-results/evidence/${prefix}-onboarding-loc-filled.png`, fullPage: true });

    const nextBtn = page.getByRole('button', { name: 'Next' });
    await nextBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await nextBtn.click();
    console.log('[Onboarding] Location submitted — waiting for dashboard...');

    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await waitForPageReady(page, 30_000);
  }

  await dismissDialogs(page);
  await page.screenshot({ path: `test-results/evidence/${prefix}-onboarding-done.png`, fullPage: true });
  console.log(`[Onboarding] Complete — URL: ${page.url()}`);
}

export async function goToManageSubscriptions(page: Page, prefix: string, base = BASE): Promise<void> {
  await page.goto(`${base}/mspHome/administration/manage-subscriptions`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await checkInvalidSession(page, 'nav-manage-subs', prefix);
  try {
    const cancelBtn = page.getByRole('button', { name: 'Cancel', exact: true }).first();
    if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click();
  } catch {}
}

export async function fillStripeCheckout(page: Page, email: string, cardName: string, cardNumber?: string): Promise<void> {
  const card = cardNumber || STRIPE_TEST_CARD;
  await page.waitForLoadState('domcontentloaded');

  try { const ef = page.getByLabel(/email/i).first(); if (await ef.isVisible().catch(() => false)) await ef.fill(email); } catch {}

  // Stripe Checkout: card form is hidden behind an accordion — click it via JS to expand
  await page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>('[data-testid="card-accordion-item-button"]');
    if (btn) btn.click();
  });

  // Wait for the card number input to appear after accordion expands
  const cardInput = page.locator('#cardNumber');
  await cardInput.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

  if (await cardInput.isVisible().catch(() => false)) {
    await cardInput.fill(card);
    await page.locator('#cardExpiry').fill(CARD_EXPIRY);
    await page.locator('#cardCvc').fill(CARD_CVC);
    const nameField = page.locator('#billingName');
    if (await nameField.isVisible().catch(() => false)) await nameField.fill(cardName);
    const zipField = page.locator('#billingPostalCode');
    if (await zipField.isVisible().catch(() => false)) await zipField.fill(CARD_ZIP);
  } else {
    // Fallback: try iframe-based Stripe Elements
    try {
      const ci = page.getByPlaceholder(/card number/i).or(page.getByLabel(/card number/i));
      await ci.first().waitFor({ state: 'visible', timeout: 10_000 });
      await ci.first().fill(card);

      const ei = page.getByPlaceholder(/mm.*yy/i).or(page.getByLabel(/expir/i));
      await ei.first().fill(CARD_EXPIRY);

      const cv = page.getByPlaceholder(/cvc|cvv/i).or(page.getByLabel(/cvc|security/i));
      await cv.first().fill(CARD_CVC);
    } catch {
      try { await page.frameLocator('iframe').first().locator('[name="cardnumber"]').fill(card); } catch {}
    }

    try {
      const ni = page.getByLabel(/name on card/i).or(page.getByPlaceholder(/name/i));
      if (await ni.first().isVisible().catch(() => false)) await ni.first().fill(cardName);
    } catch {}
    try {
      const zi = page.getByLabel(/zip|postal/i).or(page.getByPlaceholder(/zip/i));
      if (await zi.first().isVisible().catch(() => false)) await zi.first().fill(CARD_ZIP);
    } catch {}
  }
}

export async function submitStripePayment(page: Page): Promise<void> {
  const payBtn = page.getByRole('button', { name: /subscribe|pay|submit|confirm/i }).first();
  if (await payBtn.isVisible().catch(() => false)) {
    await payBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  }
}

export async function readSubscriptionSummary(page: Page): Promise<{
  allocated: number; unallocated: number; gracePeriod: number;
}> {
  const getText = async (label: string | RegExp) => {
    try {
      const el = typeof label === 'string'
        ? page.getByText(label, { exact: true })
        : page.getByText(label);
      return await el.locator('xpath=../..').locator('h2').textContent() || '0';
    } catch { return '0'; }
  };

  return {
    allocated: parseInt(await getText('Allocated'), 10) || 0,
    unallocated: parseInt(await getText(/^(Unallocated|Available)$/), 10) || 0,
    gracePeriod: parseInt(await getText('Grace Period'), 10) || 0,
  };
}

export type AccountState = {
  hasStripeSubscription: boolean;
  hasChoosePlanBtn: boolean;
  trialHeading: string | null;
  allocated: number;
  unallocated: number;
  gracePeriod: number;
  totalCredits: number;
};

export async function detectAccountState(page: Page): Promise<AccountState> {
  const summary = await readSubscriptionSummary(page);

  const manageBtn = page.getByRole('button', { name: 'Manage Subscription' });
  const hasStripeSubscription = await manageBtn.isVisible().catch(() => false);

  const choosePlanBtn = page.getByRole('button', { name: /Choose Subscription Plan/i });
  const hasChoosePlanBtn = await choosePlanBtn.isVisible().catch(() => false);

  let trialHeading: string | null = null;
  const trialEl = page.getByRole('heading', { name: /Free Trial/i }).first();
  if (await trialEl.isVisible().catch(() => false)) {
    trialHeading = await trialEl.textContent() || null;
  }

  const state: AccountState = {
    hasStripeSubscription,
    hasChoosePlanBtn,
    trialHeading,
    allocated: summary.allocated,
    unallocated: summary.unallocated,
    gracePeriod: summary.gracePeriod,
    totalCredits: summary.allocated + summary.unallocated,
  };

  console.log(`[AccountState] subscription=${hasStripeSubscription}, choosePlan=${hasChoosePlanBtn}, ` +
    `trial="${trialHeading}", allocated=${state.allocated}, unallocated=${state.unallocated}, total=${state.totalCredits}`);

  return state;
}

export async function purchaseSubscriptionViaPlanDialog(
  page: Page, planTab: '1 year' | '3 years' | '5 years', email: string, prefix: string,
): Promise<boolean> {
  const state = await detectAccountState(page);

  if (state.hasStripeSubscription) {
    console.log(`Subscription already active — skipping purchase (allocated=${state.allocated}, unallocated=${state.unallocated})`);
    await page.screenshot({ path: `test-results/evidence/${prefix}-already-subscribed.png` });
    return false;
  }

  if (!state.hasChoosePlanBtn) {
    throw new Error(`Neither "Manage Subscription" nor "Choose Subscription Plan" found. Page may be in unexpected state.`);
  }

  const preState = { ...state };

  await page.getByRole('button', { name: /Choose Subscription Plan/i }).click();

  const dialogHeading = page.getByRole('heading', { name: 'Choose Subscription Plan' });
  await expect(dialogHeading, 'Plan selection dialog should open').toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `test-results/evidence/${prefix}-plan-dialog.png` });

  const yearlyHeading = page.getByRole('heading', { name: 'Yearly Subscription' });
  await expect(yearlyHeading, 'Yearly Subscription section should be visible').toBeVisible();

  if (planTab !== '1 year') {
    const tabBtn = page.getByRole('button', { name: planTab });
    await tabBtn.click();
  }

  const priceText = await page.getByText(/\$\s*[\d.]+\s*billed/i).first().textContent() || '';
  console.log(`Insight UI price for ${planTab}: ${priceText}`);
  await page.screenshot({ path: `test-results/evidence/${prefix}-plan-price.png` });

  const allChooseBtns = page.getByRole('button', { name: 'Choose Plan' });
  const btnCount = await allChooseBtns.count();
  if (btnCount >= 2) await allChooseBtns.nth(1).click();
  else if (btnCount === 1) await allChooseBtns.first().click();

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  const alertDialog = page.getByText(/To activate your subscription|please add a device/i);
  if (await alertDialog.isVisible().catch(() => false)) {
    console.log('Alert dialog appeared — device setup may be required before purchase');
    await page.screenshot({ path: `test-results/evidence/${prefix}-alert-device-needed.png` });
    try { await page.getByRole('button', { name: /ok|cancel|close|got it/i }).first().click(); } catch {}
  }

  let redirectedToStripe = false;
  try {
    await page.waitForURL(/stripe\.com|checkout/, { timeout: 15_000 });
    redirectedToStripe = true;
  } catch {
    redirectedToStripe = page.url().includes('stripe.com') || page.url().includes('checkout');
  }

  if (redirectedToStripe) {
    console.log(`Redirected to Stripe: ${page.url()}`);
    const stripePrice = await page.getByText(/\$[\d.]+/).first().textContent().catch(() => '') || '';
    console.log(`Stripe checkout price: ${stripePrice}`);

    await fillStripeCheckout(page, email, `Stripe ${planTab}`);
    await page.screenshot({ path: `test-results/evidence/${prefix}-stripe-filled.png` });
    await submitStripePayment(page);
  } else {
    console.log('Did NOT redirect to Stripe checkout.');
    await page.screenshot({ path: `test-results/evidence/${prefix}-no-stripe-redirect.png` });
    try { await page.getByRole('button', { name: 'Cancel' }).click(); } catch {}
    try { await page.keyboard.press('Escape'); } catch {}
  }

  if (!page.url().includes('manage-subscriptions')) {
    await page.goto(`${BASE}/mspHome/administration/manage-subscriptions`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  } else {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  }

  const postState = await detectAccountState(page);
  console.log(`Post-purchase state: allocated=${postState.allocated}, unallocated=${postState.unallocated}, total=${postState.totalCredits}`);

  if (postState.hasStripeSubscription) {
    console.log('Purchase confirmed: "Manage Subscription" button now visible');
    if (postState.totalCredits > preState.totalCredits) {
      console.log(`Credits increased from ${preState.totalCredits} to ${postState.totalCredits} (+${postState.totalCredits - preState.totalCredits})`);
    }
  } else {
    console.warn('Purchase did not complete — "Manage Subscription" button NOT visible.');
  }

  await page.screenshot({ path: `test-results/evidence/${prefix}-post-purchase.png` });
  return postState.hasStripeSubscription;
}
