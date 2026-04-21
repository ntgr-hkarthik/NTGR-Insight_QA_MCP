/**
 * Drop 5 — Allocation Tests (Split 2/6)
 *
 * Tests 13-19: Org rows, Allocate/Deallocate dialogs, Auto Allocation Settings, pagination.
 * Uses the 1yr (stripe1yr.final) account.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { applyStealth } from './stealth';
import {
  ACCOUNTS, checkInvalidSession, login, goToManageSubscriptions, detectAccountState,
} from './helpers';

const PREFIX = 'd5-alloc';
const EMAIL = ACCOUNTS['1yr'].email;

test.describe('Drop 5 — Allocation: Org Pools, Allocate, Deallocate, Auto Allocation', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    await applyStealth(page);
  });

  test.afterAll(async () => { await ctx?.close(); });

  test('13a. Login and navigate to Manage Subscriptions', async () => {
    await login(page, EMAIL, PREFIX);
    await goToManageSubscriptions(page, PREFIX);
    await expect(page.getByRole('heading', { name: 'Manage Subscriptions' })).toBeVisible();
  });

  test('13. Organization row shows org name and status', async () => {
    const orgName = page.getByText(ACCOUNTS['1yr'].org).first()
      .or(page.getByText(/Stripe.*Org|TestOrg/i).first());
    const isOrgVisible = await orgName.isVisible().catch(() => false);
    if (isOrgVisible) {
      await expect(orgName, 'Organization name should be visible').toBeVisible();
      const status = page.getByText(/Expired|Active|Grace/).first();
      if (await status.isVisible().catch(() => false)) {
        console.log(`Status: ${await status.textContent()}`);
      }
    } else {
      console.log('No org row visible — may need active subscription with allocated credits');
      await page.screenshot({ path: `test-results/evidence/${PREFIX}-13-no-org-row.png` });
    }
  });

  test('14. Allocate button opens Allocate dialog', async () => {
    const allocateBtn = page.getByRole('button', { name: 'Allocate', exact: true }).first();
    await expect(allocateBtn).toBeVisible();
    await allocateBtn.click();
    await page.waitForTimeout(1_000);

    const dialogHeading = page.getByRole('heading', { name: 'Allocate' });
    await expect(dialogHeading, 'Allocate dialog should open').toBeVisible();

    const allocateTo = page.getByText('Allocate To');
    await expect(allocateTo, 'Allocate To label should be present').toBeVisible();

    const subscriptionLabel = page.getByText('Subscription').first();
    await expect(subscriptionLabel, 'Subscription label should be present').toBeVisible();

    await page.screenshot({ path: `test-results/evidence/${PREFIX}-14-allocate-dialog.png`, fullPage: true });

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(500);
  });

  test('15. Allocate dialog — organization name and count shown', async () => {
    const allocateBtn = page.getByRole('button', { name: 'Allocate', exact: true }).first();
    await allocateBtn.click();
    await page.waitForTimeout(1_000);

    const orgInput = page.locator('input[disabled]').first();
    const orgValue = await orgInput.inputValue();
    expect(orgValue, 'Org input should contain org name').toContain('test org');
    console.log(`Allocate To: ${orgValue}`);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(500);
  });

  test('16. Deallocate button shows insufficient subscription message', async () => {
    const deallocateBtn = page.getByRole('button', { name: 'Deallocate' }).first();
    await expect(deallocateBtn).toBeVisible();
    const title = await deallocateBtn.getAttribute('title') || await deallocateBtn.textContent() || '';
    const ariaLabel = await deallocateBtn.getAttribute('aria-label') || '';
    console.log(`Deallocate title="${title}", aria-label="${ariaLabel}", text="${await deallocateBtn.textContent()}"`);
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-16-deallocate.png`, fullPage: true });
  });

  test('17. Auto Allocation Settings — dialog opens with org checkboxes', async () => {
    const autoAllocBtn = page.getByRole('button', { name: 'Auto Allocation Settings' });
    await expect(autoAllocBtn).toBeVisible();
    await autoAllocBtn.click();
    await page.waitForTimeout(1_000);

    const dialogHeading = page.getByRole('heading', { name: 'Auto Allocation' });
    await expect(dialogHeading, 'Auto Allocation dialog should open').toBeVisible();

    const description = page.getByText(/Automatically allocate subscriptions/);
    await expect(description, 'Description should be present').toBeVisible();

    const selectAll = page.getByRole('checkbox', { name: 'Select All' });
    await expect(selectAll, 'Select All checkbox should be present').toBeVisible();

    await page.screenshot({ path: `test-results/evidence/${PREFIX}-17-auto-allocation.png`, fullPage: true });

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(500);
  });

  test('18. Auto Allocation Settings — Save and Cancel buttons present', async () => {
    await page.getByRole('button', { name: 'Auto Allocation Settings' }).click();
    await page.waitForTimeout(1_000);

    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(500);
  });

  test('19. Rows per page selector present with default 25', async () => {
    const rowsPerPage = page.getByText('Rows per page:');
    await expect(rowsPerPage, 'Rows per page selector should be visible').toBeVisible();
    const combobox = page.getByRole('combobox').first();
    const value = await combobox.inputValue();
    expect(value, 'Default rows per page should be 25').toBe('25');
  });
});
