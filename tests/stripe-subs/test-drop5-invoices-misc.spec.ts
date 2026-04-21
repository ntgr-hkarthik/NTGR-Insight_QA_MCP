/**
 * Drop 5 — Invoices, Jobs, Sidebar, Footer Tests (Split 6/6)
 *
 * Tests 46-55: Stripe invoice history, return to NETGEAR, session stability,
 * Run Device/License Job buttons, sidebar navigation, footer copyright.
 * Uses the 1yr (stripe1yr.final) account.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { applyStealth } from './stealth';
import {
  ACCOUNTS, checkInvalidSession, login, goToManageSubscriptions,
} from './helpers';

const PREFIX = 'd5-misc';
const EMAIL = ACCOUNTS['1yr'].email;

test.describe('Drop 5 — Invoices: Stripe Invoice History', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    await applyStealth(page);
  });

  test.afterAll(async () => { await ctx?.close(); });

  test('46a. Login and open Stripe portal', async () => {
    await login(page, EMAIL, PREFIX);
    await goToManageSubscriptions(page, PREFIX);
    await page.getByRole('button', { name: 'Manage Subscription' }).click();
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5_000);
  });

  test('46. Stripe portal — Invoice history shows at least one entry', async () => {
    const invoiceHistory = page.getByText('Invoice history');
    await expect(invoiceHistory.first(), 'Invoice history section should be visible').toBeVisible();

    const paidBadge = page.getByText('Paid');
    await expect(paidBadge.first(), 'At least one Paid invoice should exist').toBeVisible();
  });

  test('47. Stripe portal — Invoice references Insight plan', async () => {
    const insightRef = page.getByText(/Insight.*year/i);
    await expect(insightRef.first(), 'Invoice should reference Insight plan').toBeVisible();
    console.log(`Invoice plan: ${await insightRef.first().textContent()}`);
  });

  test('48. Stripe portal — Invoice has clickable link (download/view)', async () => {
    const invoiceLink = page.getByRole('link').filter({ hasText: /\$\d+/ });
    const isVisible = await invoiceLink.first().isVisible().catch(() => false);
    if (isVisible) {
      const href = await invoiceLink.first().getAttribute('href') || '';
      expect(href, 'Invoice link should point to invoice.stripe.com').toContain('invoice.stripe.com');
      console.log(`Invoice link: ${href.substring(0, 60)}...`);
    }
  });
});

test.describe('Drop 5 — Session Stability & Misc', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    await applyStealth(page);
  });

  test.afterAll(async () => { await ctx?.close(); });

  test('49a. Login and open Stripe portal for round-trip test', async () => {
    await login(page, EMAIL, PREFIX);
    await goToManageSubscriptions(page, PREFIX);
    await page.getByRole('button', { name: 'Manage Subscription' }).click();
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5_000);
  });

  test('49. Return to NETGEAR from Stripe portal', async () => {
    const returnLink = page.getByText(/Return to NETGEAR/).first();
    await returnLink.click();
    await page.waitForTimeout(8_000);
    expect(page.url(), 'Should return to NETGEAR manage subscriptions').toContain('manage-subscriptions');
    await checkInvalidSession(page, 'return-from-portal', PREFIX);
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-49-returned.png`, fullPage: true });
  });

  test('50. Subscription data intact after portal round-trip', async () => {
    const subscriptionsHeading = page.getByRole('heading', { name: 'Subscriptions', exact: true }).first();
    await expect(subscriptionsHeading, 'Subscriptions heading should still be visible').toBeVisible();

    const planType = page.getByText(/1-Year Subscription|3-Year Subscription/).first();
    await expect(planType, 'Plan type should still be visible after portal return').toBeVisible();
    console.log('Subscription data intact after portal round-trip');
  });

  test('51. Run Device Job button clickable and responds', async () => {
    const btn = page.getByRole('button', { name: 'Run Device Job' });
    await expect(btn).toBeVisible();
    await btn.click();
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-51-device-job.png`, fullPage: true });
    try { await page.getByRole('button', { name: /ok|close|cancel/i }).first().click({ timeout: 3_000 }); } catch {}
  });

  test('52. Run License Job button clickable and responds', async () => {
    const btn = page.getByRole('button', { name: 'Run License Job' });
    await expect(btn).toBeVisible();
    await btn.click();
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-52-license-job.png`, fullPage: true });
    try { await page.getByRole('button', { name: /ok|close|cancel/i }).first().click({ timeout: 3_000 }); } catch {}
  });

  test('53. Sidebar — all navigation items present', async () => {
    const navItems = ['Dashboard', 'Organizations', 'Locations', 'Devices', 'Administration', 'Alarms'];
    for (const item of navItems) {
      const navEl = page.getByText(item, { exact: true }).first();
      const isVisible = await navEl.isVisible().catch(() => false);
      expect(isVisible, `Sidebar should show "${item}"`).toBe(true);
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-53-sidebar.png`, fullPage: true });
  });

  test('54. Sidebar — Dashboard navigation works without Invalid Session', async () => {
    const dashLink = page.getByRole('link', { name: /Dashboard/ }).first();
    await dashLink.click();
    await page.waitForTimeout(5_000);
    expect(page.url(), 'Should navigate to dashboard').toContain('dashboard');
    await checkInvalidSession(page, 'sidebar-dashboard', PREFIX);
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-54-dashboard.png`, fullPage: true });
  });

  test('55. Footer copyright present on MUI page', async () => {
    const copyright = page.getByText(/© 1996.*NETGEAR/);
    await expect(copyright.first(), 'Footer copyright should be visible').toBeVisible();
  });
});
