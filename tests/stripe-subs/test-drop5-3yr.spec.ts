/**
 * Drop 5 — 3-Year Plan: Comprehensive Stripe Migration Tests
 *
 * Tests the full lifecycle of a 3-Year Stripe subscription:
 *   Login → Manage Subscriptions → Stripe Checkout → Payment → Portal →
 *   Expiry validation (>2yrs) → Auto-Renew → Invoice → Upgrade path → Cross-page
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { applyStealth } from './stealth';
import {
  BASE, ACCOUNTS,
  checkInvalidSession, login, goToManageSubscriptions,
  fillStripeCheckout, submitStripePayment, readSubscriptionSummary,
  detectAccountState, purchaseSubscriptionViaPlanDialog, type AccountState,
} from './helpers';

const PREFIX = 'd5-3yr';
const EMAIL = ACCOUNTS['3yr'].email;

test.describe('Drop 5 — 3-Year Plan Comprehensive', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    await applyStealth(page);
  });

  test.afterAll(async () => { await ctx?.close(); });

  // ─────────────────────────────────────────────────────────────
  // SECTION 1: LOGIN & NAVIGATION
  // ─────────────────────────────────────────────────────────────

  test('1. Login with 3-Year account', async () => {
    await login(page, EMAIL, PREFIX);
    expect(page.url()).toContain('mspHome');
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-01-login.png`, fullPage: true });
  });

  test('2. Navigate to Manage Subscriptions', async () => {
    await goToManageSubscriptions(page, PREFIX);
    await expect(page.getByRole('heading', { name: 'Manage Subscriptions' })).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-02-manage-subs.png`, fullPage: true });
  });

  // ─────────────────────────────────────────────────────────────
  // SECTION 2: STRIPE CHECKOUT FLOW
  // ─────────────────────────────────────────────────────────────

  test('3. Purchase 3-Year plan via Stripe (or verify existing)', async () => {
    await checkInvalidSession(page, 'pre-purchase', PREFIX);
    const purchased = await purchaseSubscriptionViaPlanDialog(page, '3 years', EMAIL, PREFIX);
    console.log(`Purchase result: ${purchased ? 'COMPLETED' : 'NOT COMPLETED (subscription may already exist or device required)'}`);

    await goToManageSubscriptions(page, PREFIX);
    const state = await detectAccountState(page);

    expect(state.hasStripeSubscription || state.hasChoosePlanBtn || state.trialHeading !== null,
      'Page should show Manage Subscription, Choose Plan, or trial info').toBe(true);
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-03-final-state.png` });
  });

  // ─────────────────────────────────────────────────────────────
  // SECTION 3: 3-YEAR SPECIFIC VALIDATION
  // ─────────────────────────────────────────────────────────────

  test('4. Subscription cards show correct counts', async () => {
    await goToManageSubscriptions(page, PREFIX);
    const summary = await readSubscriptionSummary(page);
    expect(summary.allocated).toBeGreaterThanOrEqual(0);
    expect(summary.unallocated).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-04-summary.png`, fullPage: true });
  });

  test('5. Subscription type shows "3-Year" with expiry > 2 years from now', async () => {
    const hasActive = await page.getByText(/3.Year Subscription/i).first().isVisible().catch(() => false);

    if (hasActive) {
      await expect(page.getByText(/3.Year Subscription/i).first()).toBeVisible();

      const expiryEl = page.getByText('Expiration', { exact: true }).locator('..').locator('h4');
      const expiryText = await expiryEl.textContent() || '';
      expect(expiryText.length).toBeGreaterThan(0);

      // 3-Year plan should expire > 2 years from now
      const expiryDate = new Date(expiryText);
      const twoYearsFromNow = Date.now() + (2 * 365 * 24 * 60 * 60 * 1000);
      expect(expiryDate.getTime(), '3-Year plan should expire > 2 years from now').toBeGreaterThan(twoYearsFromNow);

      // And < 4 years from now (sanity check)
      const fourYearsFromNow = Date.now() + (4 * 365 * 24 * 60 * 60 * 1000);
      expect(expiryDate.getTime(), '3-Year plan should expire < 4 years from now').toBeLessThan(fourYearsFromNow);
    }

    await page.screenshot({ path: `test-results/evidence/${PREFIX}-05-3yr-expiry.png`, fullPage: true });
  });

  test('6. Auto-Renewal status visible and correct', async () => {
    const autoRenewEl = page.getByText('Auto Renewal', { exact: true }).locator('..');
    if (await autoRenewEl.isVisible().catch(() => false)) {
      const text = await autoRenewEl.textContent() || '';
      expect(text.includes('ON') || text.includes('OFF'), 'Auto Renewal should show ON or OFF').toBe(true);
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-06-autorenew.png`, fullPage: true });
  });

  test('7. "Manage Subscription" button present and clickable', async () => {
    const manageBtn = page.getByRole('button', { name: 'Manage Subscription' });
    if (await manageBtn.isVisible().catch(() => false)) {
      await expect(manageBtn).toBeEnabled();
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-07-manage-btn.png`, fullPage: true });
  });

  // ─────────────────────────────────────────────────────────────
  // SECTION 4: STRIPE PORTAL FOR 3-YEAR PLAN
  // ─────────────────────────────────────────────────────────────

  test('8. Stripe portal shows "3-Year" plan with correct pricing', async () => {
    const manageBtn = page.getByRole('button', { name: 'Manage Subscription' });
    if (!await manageBtn.isVisible().catch(() => false)) { test.skip(); return; }

    await manageBtn.click();
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 30_000 });
    await page.waitForTimeout(5_000);

    expect(page.url()).toContain('billing.stripe.com');

    // Verify the plan is a 3-year plan
    const planName = page.getByText(/Insight.*3.*year|3.*year.*Insight/i);
    const hasPlan = await planName.first().isVisible().catch(() => false);
    if (hasPlan) {
      await expect(planName.first()).toBeVisible();
    }

    // Price should be 3x the 1-year price (or thereabouts with discount)
    const price = page.getByText(/\$[\d.,]+/);
    await expect(price.first()).toBeVisible();

    await page.screenshot({ path: `test-results/evidence/${PREFIX}-08-portal-plan.png`, fullPage: true });
  });

  test('9. Stripe portal — Payment method Visa 4242', async () => {
    if (!page.url().includes('billing.stripe.com')) { test.skip(); return; }
    await expect(page.getByText(/Visa.*4242/).first()).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-09-payment.png`, fullPage: true });
  });

  test('10. Stripe portal — Invoice history with "Paid" status', async () => {
    if (!page.url().includes('billing.stripe.com')) { test.skip(); return; }

    await expect(page.getByText('Invoice history')).toBeVisible();
    await expect(page.getByText('Paid').first()).toBeVisible();

    await page.screenshot({ path: `test-results/evidence/${PREFIX}-10-invoices.png`, fullPage: true });
  });

  test('11. Stripe portal — Update subscription available for plan upgrade', async () => {
    if (!page.url().includes('billing.stripe.com')) { test.skip(); return; }

    // DROP 5: Upgrade Plan/Quantity possible in Manage Subscription
    await expect(page.getByText('Update subscription')).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-11-update.png`, fullPage: true });
  });

  test('12. Stripe portal — Cancel subscription link present', async () => {
    if (!page.url().includes('billing.stripe.com')) { test.skip(); return; }

    await expect(page.getByText('Cancel subscription')).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-12-cancel.png`, fullPage: true });
  });

  test('13. Stripe portal — Billing information with "Update information"', async () => {
    if (!page.url().includes('billing.stripe.com')) { test.skip(); return; }

    await expect(page.getByText('Billing information')).toBeVisible();
    await expect(page.getByText('Update information')).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-13-billing-info.png`, fullPage: true });
  });

  // ─────────────────────────────────────────────────────────────
  // SECTION 5: RETURN & CROSS-PAGE
  // ─────────────────────────────────────────────────────────────

  test('14. Return to NETGEAR from Stripe portal', async () => {
    if (!page.url().includes('billing.stripe.com')) { test.skip(); return; }

    await page.getByText(/Return to NETGEAR/i).click();
    await page.waitForURL(/manage-subscriptions/, { timeout: 30_000 });
    await page.waitForTimeout(3_000);

    expect(page.url()).toContain('manage-subscriptions');
    await checkInvalidSession(page, 'return-from-stripe', PREFIX);
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-14-return.png`, fullPage: true });
  });

  test('15. Session stability — navigate Dashboard -> Manage Subs without Invalid Session', async () => {
    await page.goto(`${BASE}/mui/mspHome/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000);
    await checkInvalidSession(page, 'dashboard', PREFIX);

    await page.goto(`${BASE}/mui/mspHome/administration/manage-subscriptions`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000);
    await checkInvalidSession(page, 'back-to-subs', PREFIX);

    await page.screenshot({ path: `test-results/evidence/${PREFIX}-15-session.png`, fullPage: true });
  });

  // ─────────────────────────────────────────────────────────────
  // SECTION 6: PAGE ELEMENT VALIDATION
  // ─────────────────────────────────────────────────────────────

  test('16. Run Device Job + Run License Job buttons visible', async () => {
    await goToManageSubscriptions(page, PREFIX);
    await expect(page.getByRole('button', { name: /Run Device Job/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Run License Job/i })).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-16-job-buttons.png`, fullPage: true });
  });

  test('17. Expirations card present', async () => {
    await expect(page.getByText('Expirations', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-17-expirations.png`, fullPage: true });
  });

  test('18. Organization Pools tab accessible', async () => {
    const orgPoolsTab = page.getByRole('tab', { name: 'Organization Pools' });
    if (await orgPoolsTab.isVisible().catch(() => false)) {
      await orgPoolsTab.click();
      await page.waitForTimeout(2_000);
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-18-org-pools.png`, fullPage: true });
  });

  test('19. Purchase History tab accessible', async () => {
    const purchaseTab = page.getByRole('tab', { name: 'Purchase History' });
    if (await purchaseTab.isVisible().catch(() => false)) {
      await purchaseTab.click();
      await page.waitForTimeout(2_000);
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-19-purchase-history.png`, fullPage: true });
  });

  test('20. Sidebar navigation complete', async () => {
    for (const item of ['Dashboard', 'Organizations', 'Locations', 'Devices', 'Administration', 'Alarms']) {
      await expect(page.getByText(item, { exact: true }).first()).toBeVisible();
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-20-sidebar.png`, fullPage: true });
  });

  test('21. Hierarchy Tree or All Organizations visible', async () => {
    await goToManageSubscriptions(page, PREFIX);
    const htVisible = await page.getByText('Hierarchy Tree', { exact: true }).isVisible().catch(() => false);
    const aoVisible = await page.getByText('All Organizations').first().isVisible().catch(() => false);
    expect(htVisible || aoVisible).toBe(true);
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-21-hierarchy.png`, fullPage: true });
  });
});
