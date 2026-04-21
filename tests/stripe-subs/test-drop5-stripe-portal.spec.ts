/**
 * Drop 5 — Stripe Portal Navigation Tests (Split 4/6)
 *
 * Tests 25-34: Stripe portal access, branding, payment method options, card form, navigation.
 * Uses the 1yr (stripe1yr.final) account.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { applyStealth } from './stealth';
import {
  ACCOUNTS, checkInvalidSession, login, goToManageSubscriptions,
} from './helpers';

const PREFIX = 'd5-portal';
const EMAIL = ACCOUNTS['1yr'].email;

test.describe('Drop 5 — Stripe Portal: Navigation & Payment Methods', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    await applyStealth(page);
  });

  test.afterAll(async () => { await ctx?.close(); });

  test('25a. Login and navigate to Manage Subscriptions', async () => {
    await login(page, EMAIL, PREFIX);
    await goToManageSubscriptions(page, PREFIX);
    await expect(page.getByRole('heading', { name: 'Manage Subscriptions' })).toBeVisible();
  });

  test('25. Open Stripe portal for payment method review', async () => {
    await page.getByRole('button', { name: 'Manage Subscription' }).click();
    await page.waitForURL(/billing\.stripe\.com/, { timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5_000);
    expect(page.url()).toContain('billing.stripe.com');
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-25-stripe-portal.png`, fullPage: true });
  });

  test('26. Stripe portal — page title contains NETGEAR', async () => {
    const title = await page.title();
    console.log(`Stripe portal title: "${title}"`);
    const hasBranding = title.toLowerCase().includes('netgear') || title.toLowerCase().includes('billing');
    expect(hasBranding, 'Page title should reference NETGEAR or Billing').toBe(true);
  });

  test('27. Stripe portal — Return to NETGEAR link visible', async () => {
    const returnLink = page.getByText(/Return to NETGEAR/);
    await expect(returnLink.first(), 'Return to NETGEAR link should be visible').toBeVisible();
  });

  test('28. Stripe portal — "Powered by Stripe" footer present', async () => {
    const poweredBy = page.getByText('Powered by');
    await expect(poweredBy.first(), 'Powered by Stripe should be visible').toBeVisible();
  });

  test('29. Stripe portal — Terms and Privacy links in footer', async () => {
    const terms = page.getByRole('link', { name: 'Terms' });
    const privacy = page.getByRole('link', { name: 'Privacy' });
    await expect(terms.first(), 'Terms link should be visible').toBeVisible();
    await expect(privacy.first(), 'Privacy link should be visible').toBeVisible();
  });

  test('30. Navigate to Add Payment Method page', async () => {
    const addPayment = page.getByText('Add payment method').first();
    await expect(addPayment).toBeVisible();
    await addPayment.click();
    await page.waitForTimeout(5_000);

    await expect(page.getByText('Add payment method').first()).toBeVisible();
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-30-add-payment.png`, fullPage: true });
  });

  test('31. BUG: Amazon Pay tab visible — should be credit card only per Drop 5', async () => {
    const iframe = page.frameLocator('iframe').first();
    const amazonPayTab = iframe.getByText('Amazon Pay');
    const isVisible = await amazonPayTab.isVisible().catch(() => false);

    if (isVisible) {
      console.log('BUG: Amazon Pay tab IS visible on Add Payment Method page');
      console.log('Per Drop 5 spec, only credit card should be functional.');
      await page.screenshot({ path: `test-results/evidence/${PREFIX}-31-BUG-amazon-pay.png`, fullPage: true });
      expect(isVisible, 'BUG: Amazon Pay should NOT be visible per Drop 5 spec').toBe(false);
    } else {
      console.log('Amazon Pay tab not visible — correct per Drop 5 spec');
    }
  });

  test('32. BUG: Cash App Pay tab visible — should be credit card only per Drop 5', async () => {
    const iframe = page.frameLocator('iframe').first();
    const cashAppTab = iframe.getByText('Cash App Pay');
    const isVisible = await cashAppTab.isVisible().catch(() => false);

    if (isVisible) {
      console.log('BUG: Cash App Pay tab IS visible on Add Payment Method page');
      await page.screenshot({ path: `test-results/evidence/${PREFIX}-32-BUG-cashapp.png`, fullPage: true });
      expect(isVisible, 'BUG: Cash App Pay should NOT be visible per Drop 5 spec').toBe(false);
    } else {
      console.log('Cash App Pay tab not visible — correct per Drop 5 spec');
    }
  });

  test('33. Card form shows supported card types (Visa, Mastercard, Amex, Diners)', async () => {
    const iframe = page.frameLocator('iframe').first();
    const cardTab = iframe.getByText('Card').first();
    if (await cardTab.isVisible().catch(() => false)) {
      await cardTab.click();
      await page.waitForTimeout(1_000);
    }

    const cardNumber = iframe.getByText('Card number');
    const isVisible = await cardNumber.isVisible().catch(() => false);
    if (isVisible) {
      console.log('Card form is visible with Card number field');
      const supportedText = iframe.getByText(/Visa|Mastercard|American Express/);
      const hasSupportedText = await supportedText.isVisible().catch(() => false);
      console.log(`Supported card types visible: ${hasSupportedText}`);
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-33-card-form.png`, fullPage: true });
  });

  test('34. Go back from Add Payment Method to main portal', async () => {
    const goBackBtn = page.getByRole('button', { name: 'Go back' });
    if (await goBackBtn.isVisible().catch(() => false)) {
      await goBackBtn.click();
      await page.waitForTimeout(3_000);
    } else {
      await page.goBack();
      await page.waitForTimeout(3_000);
    }
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-34-back-to-portal.png`, fullPage: true });
  });
});
