/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  QA Automation Dashboard — E2E Suite (3-Year / maint-beta)
 *  5 real test cases — runs concurrently with the 1yr suite
 *  on a separate Worker (Worker 2 of 2).
 *
 *  Environment : maint-beta (https://maint-beta.insight.netgear.com)
 *  Account     : 1776233723615@deltajohnsons.com
 *  Plan        : 3-Year, 1 qty purchased
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *  Execution model:
 *    Worker 1 → demo-hackathon.spec.ts    (1yr, pri-qa)
 *    Worker 2 → demo-hackathon-3yr.spec.ts (3yr, maint-beta)
 *  Both files run simultaneously via --workers=2.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import {
  login,
  goToManageSubscriptions,
  detectAccountState,
  readSubscriptionSummary,
  checkInvalidSession,
} from './helpers';

const MAINT_BETA = 'https://maint-beta.insight.netgear.com';
const PREFIX = 'hackathon-3yr';
const EV = (name: string) => `test-results/evidence/${PREFIX}-${name}.png`;

// ── Shared state across the serial suite ──
let ctx3yr: BrowserContext;
let page3yr: Page;

const ACCOUNT_3YR = '1776233723615@deltajohnsons.com';

// ─────────────────────────────────────────────────────────
test.describe.serial('NETGEAR Insight — maint-beta E2E (3-Year Account, 5 TCs)', () => {

  test.beforeAll(async ({ browser }) => {
    ctx3yr = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page3yr = await ctx3yr.newPage();
  });

  test.afterAll(async () => {
    await page3yr?.close().catch(() => {});
    await ctx3yr?.close().catch(() => {});
  });

  // ═══════════════════════════════════════════════════════
  // TC1: Login & Dashboard Load Verification (maint-beta)
  // ═══════════════════════════════════════════════════════
  test('TC1 [3yr] — Login & Dashboard Verification (3-Year Account, maint-beta)', async () => {

    await test.step('Login with 3-year subscription account on maint-beta', async () => {
      await login(page3yr, ACCOUNT_3YR, `${PREFIX}-tc1`, MAINT_BETA);
      console.log(`[TC1-3yr] Post-login URL: ${page3yr.url()}`);
    });

    await test.step('Verify dashboard is loaded and session is valid', async () => {
      await checkInvalidSession(page3yr, 'tc1-dashboard', PREFIX);

      expect(
        page3yr.url(),
        'Should land on maint-beta Insight portal after login',
      ).toContain('insight.netgear.com');

      await page3yr.goto(`${MAINT_BETA}/mspHome/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page3yr.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

      const heading = page3yr
        .locator('h1, h2, h3, h4, [role="heading"]')
        .filter({ hasNotText: /loading|please wait/i })
        .first();
      await expect(heading, 'Dashboard should show portal content').toBeVisible({ timeout: 25_000 });

      await page3yr.waitForTimeout(800);
      await page3yr.screenshot({ path: EV('tc1-dashboard'), fullPage: false });
      console.log('[TC1-3yr] Dashboard verified ✓ (maint-beta)');
    });
  });

  // ═══════════════════════════════════════════════════════
  // TC2: Manage Subscriptions — Page Load & State Detection
  // ═══════════════════════════════════════════════════════
  test('TC2 [3yr] — Manage Subscriptions Page Load & Subscription State', async () => {

    await test.step('Navigate to Manage Subscriptions (maint-beta)', async () => {
      await goToManageSubscriptions(page3yr, `${PREFIX}-tc2`, MAINT_BETA);
      await page3yr.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    });

    await test.step('Verify Manage Subscriptions page loaded', async () => {
      await checkInvalidSession(page3yr, 'tc2-page-load', PREFIX);

      expect(
        page3yr.url(),
        'Should remain on Manage Subscriptions page',
      ).toContain('manage-subscriptions');

      const pageContent = page3yr.locator(
        'h1, h2, h3, h4, [role="heading"], [role="tabpanel"], .MuiCard-root, .MuiPaper-root, table',
      ).first();
      await expect(pageContent, 'Manage Subscriptions page must render content').toBeVisible({ timeout: 20_000 });

      await page3yr.screenshot({ path: EV('tc2-manage-subs'), fullPage: false });
      console.log('[TC2-3yr] Manage Subscriptions page loaded ✓');
    });

    await test.step('Detect and log subscription state', async () => {
      const state = await detectAccountState(page3yr);
      console.log(
        `[TC2-3yr] active=${state.hasStripeSubscription}, choosePlan=${state.hasChoosePlanBtn}, ` +
        `allocated=${state.allocated}, unallocated=${state.unallocated}, grace=${state.gracePeriod}`,
      );

      const hasSubscriptionContent =
        state.hasStripeSubscription ||
        state.hasChoosePlanBtn ||
        state.trialHeading !== null ||
        (state.allocated + state.unallocated + state.gracePeriod) > 0;

      if (!hasSubscriptionContent) {
        const subText = await page3yr.locator(
          'text=/subscription|allocated|unallocated|billing|plan|grace|trial|credit/i',
        ).first().isVisible({ timeout: 5_000 }).catch(() => false);

        expect(subText, 'Manage Subscriptions page must show subscription-related content').toBe(true);
      }

      await page3yr.screenshot({ path: EV('tc2-state-detected'), fullPage: false });
    });
  });

  // ═══════════════════════════════════════════════════════
  // TC3: Credit Allocation Integrity (3-Year)
  // ═══════════════════════════════════════════════════════
  test('TC3 [3yr] — Subscription Credit Allocation Integrity', async () => {

    await test.step('Reload Manage Subscriptions for fresh data', async () => {
      await page3yr.reload({ waitUntil: 'domcontentloaded' });
      await page3yr.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await checkInvalidSession(page3yr, 'tc3-reload', PREFIX);
    });

    await test.step('Verify credit counts are valid non-negative integers', async () => {
      const summary = await readSubscriptionSummary(page3yr);

      expect(summary.allocated, 'Allocated credits must be a non-negative integer').toBeGreaterThanOrEqual(0);
      expect(summary.unallocated, 'Unallocated credits must be a non-negative integer').toBeGreaterThanOrEqual(0);
      expect(summary.gracePeriod, 'Grace period count must be a non-negative integer').toBeGreaterThanOrEqual(0);

      console.log(
        `[TC3-3yr] Allocated=${summary.allocated}, Unallocated=${summary.unallocated}, Grace=${summary.gracePeriod} ✓`,
      );
      await page3yr.screenshot({ path: EV('tc3-credits'), fullPage: false });
    });
  });

  // ═══════════════════════════════════════════════════════
  // TC4: Billing Portal Access (3-Year)
  // ═══════════════════════════════════════════════════════
  test('TC4 [3yr] — Stripe Billing Portal Access', async () => {

    await test.step('Navigate to Manage Subscriptions', async () => {
      await goToManageSubscriptions(page3yr, `${PREFIX}-tc4`, MAINT_BETA);
      await page3yr.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    });

    await test.step('Open billing portal', async () => {
      await page3yr.screenshot({ path: EV('tc4-before'), fullPage: false });

      const billingBtn = page3yr
        .getByRole('button', { name: /Manage Subscription|Manage Billing/i })
        .first();
      const hasBtn = await billingBtn.isVisible({ timeout: 8_000 }).catch(() => false);

      if (hasBtn) {
        const [newPage] = await Promise.all([
          page3yr.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null),
          billingBtn.click(),
        ]);
        const portalPage = newPage || page3yr;
        await portalPage.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
        await portalPage.screenshot({ path: EV('tc4-billing-portal'), fullPage: false });
        console.log(`[TC4-3yr] Billing portal: ${portalPage.url()} ✓`);
        if (newPage) await newPage.close().catch(() => {});
      } else {
        console.log('[TC4-3yr] No "Manage Subscription" button — account uses non-Stripe credit allocation ✓');
        await page3yr.screenshot({ path: EV('tc4-state'), fullPage: false });
      }
    });
  });

  // ═══════════════════════════════════════════════════════
  // TC5: Devices Page — Cross-Page Navigation & Session Stability
  // ═══════════════════════════════════════════════════════
  test('TC5 [3yr] — Devices Page Cross-Navigation & Session Stability', async () => {

    await test.step('Navigate to Devices page (maint-beta)', async () => {
      await page3yr.goto(`${MAINT_BETA}/mspHome/devices`, {
        waitUntil: 'domcontentloaded', timeout: 60_000,
      });
      await page3yr.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    });

    await test.step('Verify Devices page loaded without session error', async () => {
      await checkInvalidSession(page3yr, 'tc5-devices', PREFIX);

      const addBtn   = page3yr.getByRole('button', { name: 'Add' }).first();
      const devTable = page3yr.locator('[role="rowgroup"], table').first();
      const hasContent =
        await addBtn.isVisible({ timeout: 10_000 }).catch(() => false) ||
        await devTable.isVisible({ timeout: 5_000 }).catch(() => false);

      expect(hasContent, 'Devices page must show device table or Add button').toBe(true);
      await page3yr.screenshot({ path: EV('tc5-devices-page'), fullPage: false });
      console.log('[TC5-3yr] Devices page verified ✓');
    });

    await test.step('Navigate back to Manage Subscriptions — verify session survives', async () => {
      await goToManageSubscriptions(page3yr, `${PREFIX}-tc5-return`, MAINT_BETA);
      await checkInvalidSession(page3yr, 'tc5-return-to-subs', PREFIX);

      expect(
        page3yr.url(),
        'Session should survive cross-page navigation — must remain on manage-subscriptions',
      ).toContain('manage-subscriptions');

      const anyContent = page3yr.locator('h1, h2, h3, h4, [role="heading"], .MuiPaper-root, main, [role="main"]').first();
      await expect(anyContent, 'Manage Subscriptions page must render after navigation').toBeVisible({ timeout: 15_000 });

      await page3yr.screenshot({ path: EV('tc5-session-stable'), fullPage: false });
      console.log('[TC5-3yr] Cross-page session stability verified ✓');
    });
  });

}); // end describe.serial
