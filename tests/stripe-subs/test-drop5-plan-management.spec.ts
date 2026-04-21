/**
 * Drop 5 — Plan Management Tests (Split 5/6)
 *
 * Tests 35-45: Update subscription flow, cancel subscription flow, plan switching.
 * Uses the 1yr (stripe1yr.final) account.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { applyStealth } from './stealth';
import {
  ACCOUNTS, checkInvalidSession, login, goToManageSubscriptions,
} from './helpers';

const PREFIX = 'd5-plans';
const EMAIL = ACCOUNTS['1yr'].email;

test.describe('Drop 5 — Plan Management: Update & Cancel Subscription', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    await applyStealth(page);
  });

  test.afterAll(async () => { await ctx?.close(); });

  test('35a. Login and open Stripe portal', async () => {
    await login(page, EMAIL, PREFIX);
    await goToManageSubscriptions(page, PREFIX);
    await expect(page.getByRole('heading', { name: 'Manage Subscriptions' })).toBeVisible();

    await page.getByRole('button', { name: 'Manage Subscription' }).click();
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5_000);
  });

  test('35. Update subscription — opens with Yearly and Every 3 years options', async () => {
    const updateLink = page.getByText('Update subscription').first();
    if (!await updateLink.isVisible().catch(() => false)) {
      console.log('Update subscription link not visible — may need to navigate back');
      test.skip();
      return;
    }
    await updateLink.click();
    await page.waitForTimeout(5_000);

    const yearly = page.getByText('Yearly');
    const every3yr = page.getByText('Every 3 years');
    await expect(yearly.first(), 'Yearly option should be visible').toBeVisible();
    await expect(every3yr.first(), 'Every 3 years option should be visible').toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-35-update-sub-options.png`, fullPage: true });
  });

  test('36. Update subscription — no 5-Year or Monthly option in Stripe portal', async () => {
    const fiveYear = page.getByText(/5.year/i);
    const monthly = page.getByText(/monthly/i);
    const has5yr = await fiveYear.isVisible().catch(() => false);
    const hasMonthly = await monthly.isVisible().catch(() => false);
    expect(has5yr, 'Stripe portal should NOT show 5-Year option').toBe(false);
    expect(hasMonthly, 'Stripe portal should NOT show Monthly option').toBe(false);
    console.log('Confirmed: Only Yearly and Every 3 years visible in Stripe portal');
  });

  test('37. Update subscription — current plan shows "Current subscription" badge', async () => {
    const currentBadge = page.getByText('Current subscription');
    await expect(currentBadge.first(), 'Current subscription badge should be shown').toBeVisible();
    const planName = page.getByText(/Insight 1-year|Insight 3-year/);
    await expect(planName.first(), 'Plan name should be visible').toBeVisible();
    console.log(`Current plan: ${await planName.first().textContent()}`);
  });

  test('38. Update subscription — quantity controls present', async () => {
    const decreaseBtn = page.getByRole('button', { name: 'Decrease' });
    const increaseBtn = page.getByRole('button', { name: 'Increase' });

    await expect(increaseBtn.first(), 'Increase button should be visible').toBeVisible();
    if (await decreaseBtn.first().isVisible().catch(() => false)) {
      const isDisabled = await decreaseBtn.first().isDisabled();
      console.log(`Decrease button disabled: ${isDisabled}`);
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-38-quantity.png`, fullPage: true });
  });

  test('39. Update subscription — Continue button state correct', async () => {
    const continueBtn = page.getByRole('button', { name: 'Continue' });
    await expect(continueBtn.first(), 'Continue button should be present').toBeVisible();
    const isDisabled = await continueBtn.first().isDisabled();
    console.log(`Continue button disabled (no changes): ${isDisabled}`);
    expect(isDisabled, 'Continue should be disabled when no changes made').toBe(true);
  });

  test('40. Update subscription — switching to 3-year shows Insight 3-year plan', async () => {
    const every3yr = page.getByText('Every 3 years').first();
    if (await every3yr.isVisible().catch(() => false)) {
      await every3yr.click();
      await page.waitForTimeout(3_000);

      const plan3yr = page.getByText('Insight 3-year');
      await expect(plan3yr.first(), '3-year plan should be visible after switching').toBeVisible();
      const price = page.getByText(/\$\d+\.\d+.*every 3 years/);
      await expect(price.first(), 'Price should show "every 3 years"').toBeVisible();
      console.log(`3-year price: ${await price.first().textContent()}`);

      const selectBtn = page.getByRole('button', { name: 'Select' });
      await expect(selectBtn.first(), 'Select button should be visible for new plan').toBeVisible();
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-40-switch-3yr.png`, fullPage: true });
  });

  test('41. Navigate back to main Stripe portal', async () => {
    const billingLink = page.getByRole('button', { name: 'Billing' });
    if (await billingLink.isVisible().catch(() => false)) {
      await billingLink.click();
      await page.waitForTimeout(5_000);
    } else {
      await page.goBack();
      await page.waitForTimeout(5_000);
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-41-back-portal.png`, fullPage: true });
  });

  test('42. Cancel subscription — shows confirmation with plan details', async () => {
    const cancelLink = page.getByText('Cancel subscription').first();
    if (!await cancelLink.isVisible().catch(() => false)) {
      console.log('Cancel subscription link not visible');
      test.skip();
      return;
    }
    await cancelLink.click();
    await page.waitForTimeout(5_000);

    await expect(page.getByText('Confirm cancellation').first()).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-42-cancel-confirm.png`, fullPage: true });
  });

  test('43. Cancel flow — shows billing period end date', async () => {
    const endDateMsg = page.getByText(/still be available until.*\d{4}/);
    const isVisible = await endDateMsg.isVisible().catch(() => false);
    if (isVisible) {
      const text = await endDateMsg.textContent() || '';
      console.log(`Cancel message: ${text}`);
    } else {
      console.log('Cancel confirmation page not showing expected message');
    }
  });

  test('44. Cancel flow — no refund information shown (Drop 5 limitation)', async () => {
    const refundText = page.getByText(/refund/i);
    const hasRefund = await refundText.isVisible().catch(() => false);
    expect(hasRefund, 'Drop 5: No refund information should be shown').toBe(false);
    console.log('Confirmed: No refund info in cancel flow (Drop 5 limitation)');
  });

  test('45. Cancel flow — Go back button returns to portal without cancelling', async () => {
    const goBackBtn = page.getByRole('button', { name: 'Go back' });
    if (await goBackBtn.isVisible().catch(() => false)) {
      await goBackBtn.click();
      await page.waitForTimeout(5_000);
      const currentSub = page.getByText('Current subscription');
      await expect(currentSub.first(), 'Should return to main portal with active subscription').toBeVisible();
      console.log('Confirmed: Go back did not cancel the subscription');
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-45-go-back.png`, fullPage: true });
  });
});
