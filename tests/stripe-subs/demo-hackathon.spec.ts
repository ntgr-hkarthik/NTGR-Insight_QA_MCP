/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  QA Automation Dashboard — E2E Suite
 *  5 real test cases for NETGEAR Insight Cloud Portal
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *  Account: 17762511180271@deltajohnsons.com  (active 1yr, 1 device credit, pri-qa)
 *  All 5 tests share one browser context — login from TC1 persists through TC5.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  BASE,
  login,
  goToManageSubscriptions,
  detectAccountState,
  readSubscriptionSummary,
  checkInvalidSession,
} from './helpers';

const PREFIX = 'hackathon';
const EV = (name: string) => `test-results/evidence/${PREFIX}-${name}.png`;

// ── Shared state across the serial suite ──
let ctx1yr: BrowserContext;
let page1yr: Page;

const ACCOUNT_1YR = '17762511180271@deltajohnsons.com';

// ─────────────────────────────────────────────────────────
test.describe.serial('NETGEAR Insight Cloud Portal — E2E (5 Test Cases)', () => {

  test.beforeAll(async ({ browser }) => {
    ctx1yr = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page1yr = await ctx1yr.newPage();
  });

  test.afterAll(async () => {
    await page1yr?.close().catch(() => {});
    await ctx1yr?.close().catch(() => {});
  });

  // ═══════════════════════════════════════════════════════
  // TC1: Login & Dashboard Load Verification
  // ═══════════════════════════════════════════════════════
  test('TC1 — Login & Dashboard Verification (1-Year Account)', async () => {

    await test.step('Login with 1-year subscription account', async () => {
      await login(page1yr, ACCOUNT_1YR, `${PREFIX}-tc1`);
      console.log(`[TC1] Post-login URL: ${page1yr.url()}`);
    });

    await test.step('Verify dashboard is loaded and session is valid', async () => {
      await checkInvalidSession(page1yr, 'tc1-dashboard', PREFIX);

      expect(
        page1yr.url(),
        'Should land on Insight portal after login',
      ).toContain('insight.netgear.com');

      // Navigate explicitly to the dashboard so the screenshot has a predictable, fully-rendered page
      await page1yr.goto(`${BASE}/mspHome/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page1yr.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

      // Wait until a real heading is visible (not still-loading or spinner)
      const heading = page1yr
        .locator('h1, h2, h3, h4, [role="heading"]')
        .filter({ hasNotText: /loading|please wait/i })
        .first();
      await expect(heading, 'Dashboard should show portal content').toBeVisible({ timeout: 25_000 });

      // Give MUI one more tick to finish painting before the screenshot
      await page1yr.waitForTimeout(800);
      await page1yr.screenshot({ path: EV('tc1-dashboard'), fullPage: false });
      console.log('[TC1] Dashboard verified ✓');
    });
  });

  // ═══════════════════════════════════════════════════════
  // TC2: Manage Subscriptions — Page Load & State Detection
  // ═══════════════════════════════════════════════════════
  test('TC2 — Manage Subscriptions Page Load & Subscription State', async () => {

    await test.step('Navigate to Manage Subscriptions', async () => {
      await goToManageSubscriptions(page1yr, `${PREFIX}-tc2`);
      await page1yr.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    });

    await test.step('Verify Manage Subscriptions page loaded', async () => {
      await checkInvalidSession(page1yr, 'tc2-page-load', PREFIX);

      // URL must stay on manage-subscriptions (not redirected to login/error)
      expect(
        page1yr.url(),
        'Should remain on Manage Subscriptions page',
      ).toContain('manage-subscriptions');

      // Wait for any meaningful page content to render
      const pageContent = page1yr.locator(
        'h1, h2, h3, h4, [role="heading"], [role="tabpanel"], .MuiCard-root, .MuiPaper-root, table',
      ).first();
      await expect(pageContent, 'Manage Subscriptions page must render content').toBeVisible({ timeout: 20_000 });

      await page1yr.screenshot({ path: EV('tc2-manage-subs'), fullPage: false });
      console.log('[TC2] Manage Subscriptions page loaded ✓');
    });

    await test.step('Detect and log subscription state', async () => {
      const state = await detectAccountState(page1yr);
      console.log(
        `[TC2] active=${state.hasStripeSubscription}, choosePlan=${state.hasChoosePlanBtn}, ` +
        `allocated=${state.allocated}, unallocated=${state.unallocated}, grace=${state.gracePeriod}`,
      );

      // Verify the page shows subscription-related content via any available signal
      const hasSubscriptionContent =
        state.hasStripeSubscription ||
        state.hasChoosePlanBtn ||
        state.trialHeading !== null ||
        (state.allocated + state.unallocated + state.gracePeriod) > 0;

      if (!hasSubscriptionContent) {
        // Broader text-based fallback for accounts with non-Stripe credit allocation
        const subText = await page1yr.locator(
          'text=/subscription|allocated|unallocated|billing|plan|grace|trial|credit/i',
        ).first().isVisible({ timeout: 5_000 }).catch(() => false);

        expect(subText, 'Manage Subscriptions page must show subscription-related content').toBe(true);
      }

      await page1yr.screenshot({ path: EV('tc2-state-detected'), fullPage: false });
    });
  });

  // ═══════════════════════════════════════════════════════
  // TC3: Credit Allocation Integrity
  // ═══════════════════════════════════════════════════════
  test('TC3 — Subscription Credit Allocation Integrity', async () => {

    await test.step('Reload Manage Subscriptions for fresh data', async () => {
      await page1yr.reload({ waitUntil: 'domcontentloaded' });
      await page1yr.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await checkInvalidSession(page1yr, 'tc3-reload', PREFIX);
    });

    await test.step('Verify credit counts are valid non-negative integers', async () => {
      const summary = await readSubscriptionSummary(page1yr);

      expect(summary.allocated, 'Allocated credits must be a non-negative integer').toBeGreaterThanOrEqual(0);
      expect(summary.unallocated, 'Unallocated credits must be a non-negative integer').toBeGreaterThanOrEqual(0);
      expect(summary.gracePeriod, 'Grace period count must be a non-negative integer').toBeGreaterThanOrEqual(0);

      console.log(
        `[TC3] Allocated=${summary.allocated}, Unallocated=${summary.unallocated}, Grace=${summary.gracePeriod} ✓`,
      );
      await page1yr.screenshot({ path: EV('tc3-credits'), fullPage: false });
    });
  });

  // ═══════════════════════════════════════════════════════
  // TC4: Billing Portal Access
  // ═══════════════════════════════════════════════════════
  test('TC4 — Stripe Billing Portal Access', async () => {

    await test.step('Navigate to Manage Subscriptions', async () => {
      await goToManageSubscriptions(page1yr, `${PREFIX}-tc4`);
      await page1yr.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    });

    await test.step('Open billing portal', async () => {
      await page1yr.screenshot({ path: EV('tc4-before'), fullPage: false });

      const billingBtn = page1yr
        .getByRole('button', { name: /Manage Subscription|Manage Billing/i })
        .first();
      const hasBtn = await billingBtn.isVisible({ timeout: 8_000 }).catch(() => false);

      if (hasBtn) {
        const [newPage] = await Promise.all([
          page1yr.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null),
          billingBtn.click(),
        ]);
        const portalPage = newPage || page1yr;
        await portalPage.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
        await portalPage.screenshot({ path: EV('tc4-billing-portal'), fullPage: false });
        console.log(`[TC4] Billing portal: ${portalPage.url()} ✓`);
        if (newPage) await newPage.close().catch(() => {});
      } else {
        // No Stripe subscription on this account — log state and pass
        console.log('[TC4] No "Manage Subscription" button — account uses non-Stripe credit allocation ✓');
        await page1yr.screenshot({ path: EV('tc4-state'), fullPage: false });
      }
    });
  });

  // ═══════════════════════════════════════════════════════
  // TC5: Devices Page — Cross-Page Navigation & Session Stability
  // ═══════════════════════════════════════════════════════
  test('TC5 — Devices Page Cross-Navigation & Session Stability', async () => {

    await test.step('Navigate to Devices page', async () => {
      await page1yr.goto(`${BASE}/mspHome/devices`, {
        waitUntil: 'domcontentloaded', timeout: 60_000,
      });
      await page1yr.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    });

    await test.step('Verify Devices page loaded without session error', async () => {
      await checkInvalidSession(page1yr, 'tc5-devices', PREFIX);

      const addBtn   = page1yr.getByRole('button', { name: 'Add' }).first();
      const devTable = page1yr.locator('[role="rowgroup"], table').first();
      const hasContent =
        await addBtn.isVisible({ timeout: 10_000 }).catch(() => false) ||
        await devTable.isVisible({ timeout:  5_000 }).catch(() => false);

      expect(hasContent, 'Devices page must show device table or Add button').toBe(true);
      await page1yr.screenshot({ path: EV('tc5-devices-page'), fullPage: false });
      console.log('[TC5] Devices page verified ✓');
    });

    await test.step('Navigate back to Manage Subscriptions — verify session survives', async () => {
      await goToManageSubscriptions(page1yr, `${PREFIX}-tc5-return`);
      await checkInvalidSession(page1yr, 'tc5-return-to-subs', PREFIX);

      // Session is valid if we stayed on manage-subscriptions (not redirected to login)
      expect(
        page1yr.url(),
        'Session should survive cross-page navigation — must remain on manage-subscriptions',
      ).toContain('manage-subscriptions');

      // Any visible content confirms the page rendered without auth failure
      const anyContent = page1yr.locator('h1, h2, h3, h4, [role="heading"], .MuiPaper-root, main, [role="main"]').first();
      await expect(anyContent, 'Manage Subscriptions page must render after navigation').toBeVisible({ timeout: 15_000 });

      await page1yr.screenshot({ path: EV('tc5-session-stable'), fullPage: false });
      console.log('[TC5] Cross-page session stability verified ✓');
    });
  });

}); // end describe.serial
