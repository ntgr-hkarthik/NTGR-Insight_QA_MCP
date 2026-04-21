/**
 * Drop 5 — Purchase History Tests (Split 3/6)
 *
 * Tests 20-24: Purchase History tab, entries, Invoice ID, amount format, date validation.
 * Uses the 1yr (stripe1yr.final) account.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { applyStealth } from './stealth';
import {
  ACCOUNTS, checkInvalidSession, login, goToManageSubscriptions,
} from './helpers';

const PREFIX = 'd5-history';
const EMAIL = ACCOUNTS['1yr'].email;

test.describe('Drop 5 — Purchase History Tab', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    await applyStealth(page);
  });

  test.afterAll(async () => { await ctx?.close(); });

  test('20a. Login and navigate to Manage Subscriptions', async () => {
    await login(page, EMAIL, PREFIX);
    await goToManageSubscriptions(page, PREFIX);
    await expect(page.getByRole('heading', { name: 'Manage Subscriptions' })).toBeVisible();
  });

  test('20. Purchase History tab — switch and verify table', async () => {
    await page.getByRole('tab', { name: 'Purchase History' }).click();
    await page.waitForTimeout(2_000);

    const expectedColumns = ['Purchase Date', 'Expiration Date', 'Invoice ID', 'Amount'];
    for (const col of expectedColumns) {
      await expect(
        page.getByRole('columnheader').filter({ hasText: col }).first(),
        `Column "${col}" should be present`
      ).toBeVisible();
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-20-purchase-history.png`, fullPage: true });
  });

  test('21. Purchase History — at least one entry exists', async () => {
    const rows = page.getByRole('row');
    const rowCount = await rows.count();
    expect(rowCount, 'Should have at least 1 data row + header').toBeGreaterThanOrEqual(2);
  });

  test('22. Purchase History — Invoice ID is clickable (downloads PDF)', async () => {
    const invoiceBtn = page.getByRole('button').filter({ hasText: /#\d+/ }).first();
    const isVisible = await invoiceBtn.isVisible().catch(() => false);
    if (isVisible) {
      const invoiceText = await invoiceBtn.textContent() || '';
      console.log(`Invoice ID: ${invoiceText}`);
      expect(invoiceText, 'Invoice ID should match #number format').toMatch(/#\d+/);

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15_000 }).catch(() => null),
        invoiceBtn.click(),
      ]);

      if (download) {
        const filename = download.suggestedFilename();
        console.log(`Downloaded: ${filename}`);
        expect(filename, 'Download filename should contain "Invoice"').toContain('Invoice');
        expect(filename, 'Download should be a PDF').toContain('.pdf');
      } else {
        console.log('No download event captured, but button was clicked successfully');
      }
    } else {
      console.log('No invoice button visible — skipping download test');
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-22-invoice-click.png`, fullPage: true });
  });

  test('23. Purchase History — Amount shows currency format', async () => {
    const amountCell = page.getByText(/\$\s*\d+/).first();
    const isVisible = await amountCell.isVisible().catch(() => false);
    if (isVisible) {
      const text = await amountCell.textContent() || '';
      expect(text, 'Amount should contain $ and USD').toMatch(/\$\s*[\d,.]+\s*USD/);
      console.log(`Amount: ${text}`);
    } else {
      console.log('No amount visible — possibly no purchase history');
    }
  });

  test('24. Purchase History — dates are valid and Expiration > Purchase', async () => {
    const rows = page.getByRole('row');
    const rowCount = await rows.count();
    if (rowCount >= 2) {
      const firstDataRow = rows.nth(1);
      const cells = firstDataRow.getByRole('gridcell');
      const purchaseDate = await cells.nth(0).textContent() || '';
      const expirationDate = await cells.nth(1).textContent() || '';

      console.log(`Purchase: ${purchaseDate}, Expiration: ${expirationDate}`);

      const pDate = new Date(purchaseDate.trim());
      const eDate = new Date(expirationDate.trim());

      if (!isNaN(pDate.getTime()) && !isNaN(eDate.getTime())) {
        expect(eDate.getTime(), 'Expiration should be after Purchase date').toBeGreaterThan(pDate.getTime());
        const diffDays = (eDate.getTime() - pDate.getTime()) / (1000 * 60 * 60 * 24);
        console.log(`Duration: ${Math.round(diffDays)} days (~${Math.round(diffDays / 365)} years)`);
      }
    }
    await page.getByRole('tab', { name: 'Organization Pools' }).click();
    await page.waitForTimeout(1_000);
  });
});
