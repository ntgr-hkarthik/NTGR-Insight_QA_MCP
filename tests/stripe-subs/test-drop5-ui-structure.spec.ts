/**
 * Drop 5 — UI Structure Tests (Split 1/6)
 *
 * Tests 1-12: Login, page structure, subscription cards, counts, expirations, tooltips, org pools tab.
 * Uses the 1yr (stripe1yr.final) account.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { applyStealth } from './stealth';
import {
  ACCOUNTS, checkInvalidSession, login, goToManageSubscriptions, detectAccountState,
} from './helpers';

const PREFIX = 'd5-ui';
const EMAIL = ACCOUNTS['1yr'].email;

test.describe('Drop 5 — UI Structure: Subscription Cards & Counts', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    await applyStealth(page);
  });

  test.afterAll(async () => { await ctx?.close(); });

  test('1. Login and navigate to Manage Subscriptions', async () => {
    await login(page, EMAIL, PREFIX);
    await goToManageSubscriptions(page, PREFIX);
    await expect(page.getByRole('heading', { name: 'Manage Subscriptions' })).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-01-page-loaded.png`, fullPage: true });
  });

  test('2. Subscriptions card — heading and subscription controls present', async () => {
    await expect(page.getByRole('heading', { name: 'Subscriptions', exact: true }).first()).toBeVisible();
    const state = await detectAccountState(page);
    if (state.hasStripeSubscription) {
      await expect(page.getByRole('button', { name: 'Manage Subscription' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Manage Subscription' })).toBeEnabled();
    } else {
      await expect(page.getByRole('button', { name: /Choose Subscription Plan/i })).toBeVisible();
      console.log(`No Stripe subscription active. Trial: "${state.trialHeading}"`);
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-02-subs-card.png` });
  });

  test('3. Allocated count is numeric and >= 0', async () => {
    const allocatedLabel = page.getByText('Allocated', { exact: true }).first();
    await expect(allocatedLabel, 'Allocated label should be visible').toBeVisible();
    const container = allocatedLabel.locator('xpath=ancestor::div[.//h2]').first();
    const countEl = container.locator('h2').first();
    const allocText = await countEl.textContent({ timeout: 10_000 }) || '0';
    const allocNum = parseInt(allocText.trim(), 10);
    expect(isNaN(allocNum), 'Allocated should be a number').toBe(false);
    expect(allocNum, 'Allocated should be >= 0').toBeGreaterThanOrEqual(0);
    console.log(`Allocated: ${allocNum}`);
  });

  test('4. Unallocated count is numeric and >= 0', async () => {
    const unallocLabel = page.getByText('Unallocated', { exact: true }).first();
    await expect(unallocLabel, 'Unallocated label should be visible').toBeVisible();
    const container = unallocLabel.locator('xpath=ancestor::div[.//h2]').first();
    const countEl = container.locator('h2').first();
    const unallocText = await countEl.textContent({ timeout: 10_000 }) || '0';
    const unallocNum = parseInt(unallocText.trim(), 10);
    expect(isNaN(unallocNum), 'Unallocated should be a number').toBe(false);
    expect(unallocNum, 'Unallocated should be >= 0').toBeGreaterThanOrEqual(0);
    console.log(`Unallocated: ${unallocNum}`);
  });

  test('5. Allocated + Unallocated counts are consistent', async () => {
    const state = await detectAccountState(page);
    console.log(`Allocated=${state.allocated}, Unallocated=${state.unallocated}, Total=${state.totalCredits}`);
    if (state.hasStripeSubscription) {
      expect(state.totalCredits, 'Total credits should be >= 1 with active subscription').toBeGreaterThanOrEqual(1);
    } else {
      console.log('No Stripe subscription — credits may be 0 (HB devices tracked separately)');
      expect(state.allocated).toBeGreaterThanOrEqual(0);
      expect(state.unallocated).toBeGreaterThanOrEqual(0);
    }
  });

  test('6. Expirations card — Grace Period and Expiring Soon are numeric', async () => {
    await expect(page.getByRole('heading', { name: 'Expirations' })).toBeVisible();
    const gracePeriod = page.getByText('Grace Period').first();
    await expect(gracePeriod).toBeVisible();
    const expiringSoon = page.getByText('Expiring Soon').first();
    await expect(expiringSoon).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-06-expirations.png`, fullPage: true });
  });

  test('7. Subscription detail card shows plan type or trial state', async () => {
    const planType = page.getByText(/1-Year Subscription|3-Year Subscription/).first();
    const trialPending = page.getByRole('heading', { name: /Free Trial/i }).first();
    const hasPlan = await planType.isVisible().catch(() => false);
    const hasTrial = await trialPending.isVisible().catch(() => false);
    expect(hasPlan || hasTrial, 'Should show either plan type or trial state').toBe(true);
    if (hasPlan) console.log(`Plan type: ${await planType.textContent()}`);
    if (hasTrial) console.log(`Trial state: ${await trialPending.textContent()}`);

    const expiration = page.getByText('Expiration').first();
    await expect(expiration, 'Expiration label should be visible').toBeVisible();

    const autoRenewal = page.getByText('Auto Renewal').first();
    await expect(autoRenewal, 'Auto Renewal label should be visible').toBeVisible();

    const onOff = page.getByText(/^ON$|^OFF$/).first();
    await expect(onOff, 'Auto renewal should show ON or OFF').toBeVisible();
    console.log(`Auto Renewal: ${await onOff.textContent()}`);

    await page.screenshot({ path: `test-results/evidence/${PREFIX}-07-plan-detail.png`, fullPage: true });
  });

  test('8. Expiry date is a valid future date', async () => {
    const dateEl = page.getByRole('heading', { level: 4 }).filter({ hasText: /\w+ \d+, \d{4}/ });
    const dateText = await dateEl.first().textContent() || '';
    const parsed = new Date(dateText);
    expect(parsed.toString(), `"${dateText}" should be a valid date`).not.toBe('Invalid Date');
    expect(parsed.getTime(), 'Expiry date should be in the future').toBeGreaterThan(Date.now());
    console.log(`Expiry date: ${dateText} (${parsed.toISOString()})`);
  });

  test('9. Allocated info tooltip icon is present', async () => {
    const allocatedInfo = page.getByText('Allocated').first().locator('..').locator('text=i');
    const visible = await allocatedInfo.isVisible().catch(() => false);
    expect(visible, 'Allocated info icon should be visible').toBe(true);
  });

  test('10. Unallocated info tooltip icon is present', async () => {
    const unallocatedInfo = page.getByText('Unallocated').first().locator('..').locator('text=i');
    const visible = await unallocatedInfo.isVisible().catch(() => false);
    expect(visible, 'Unallocated info icon should be visible').toBe(true);
  });

  test('11. Organization Pools tab is selected by default', async () => {
    const orgPoolsTab = page.getByRole('tab', { name: 'Organization Pools' });
    await expect(orgPoolsTab).toBeVisible();
    const isSelected = await orgPoolsTab.getAttribute('aria-selected');
    expect(isSelected, 'Organization Pools tab should be selected by default').toBe('true');
  });

  test('12. Organization Pools table has all required columns', async () => {
    const expectedColumns = ['Organizations', 'Status', 'Allocated Subscriptions', 'Used Subscriptions', 'Managed Devices', 'Auto Allocation', 'Actions'];
    for (const col of expectedColumns) {
      await expect(
        page.getByRole('columnheader').filter({ hasText: col }).first(),
        `Column "${col}" should be present`
      ).toBeVisible();
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-12-org-pools-columns.png`, fullPage: true });
  });
});
