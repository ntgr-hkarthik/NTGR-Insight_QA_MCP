/**
 * One-off: open a hosted Stripe checkout URL, run setHostedStripeQuantityBeforeBilling only (no payment).
 * Usage: node stripe-checkout-qty-smoke.js <checkoutUrl> [qty]
 * Leaves browser open until Enter in this terminal.
 *
 * Stripe often returns "Something went wrong" with stock Playwright Chromium because of
 * automation signals. This launcher uses Chrome channel when available, strips --enable-automation,
 * disables AutomationControlled blink feature, and masks navigator.webdriver — closer to a manual tab.
 */
const readline = require('readline');
const { chromium } = require('@playwright/test');
const { setHostedStripeQuantityBeforeBilling } = require('./acc-purchase');

const url = process.argv[2];
const qty = Math.max(2, parseInt(process.argv[3] || '3', 10) || 3);

const launchOpts = {
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--disable-blink-features=AutomationControlled',
    '--window-size=1400,900',
  ],
};

async function launchStripeFriendlyBrowser() {
  try {
    const browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
    console.log('[qty-smoke] Using Google Chrome (channel: chrome)');
    return browser;
  } catch (e) {
    console.warn('[qty-smoke] channel:chrome failed —', e.message || e, '— using bundled Chromium with same flags');
    return chromium.launch(launchOpts);
  }
}

async function main() {
  if (!url || !/^https:\/\/checkout\.stripe\.com\//i.test(url)) {
    console.error('Usage: node stripe-checkout-qty-smoke.js <checkout.stripe.com URL> [qty>=2]');
    process.exit(1);
  }

  const browser = await launchStripeFriendlyBrowser();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    hasTouch: false,
    isMobile: false,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  console.log('[qty-smoke] Navigating…');
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(2500);

  console.log('[qty-smoke] setHostedStripeQuantityBeforeBilling, qty=', qty);
  await setHostedStripeQuantityBeforeBilling(page, qty);

  console.log('[qty-smoke] Done (no pay). Inspect the page — totals should reflect qty if it worked.');
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => {
      rl.question('Press Enter to close the browser… ', async () => {
        rl.close();
        await browser.close().catch(() => {});
        resolve();
      });
    });
  } else {
    const ms = process.env.STRIPE_QTY_SMOKE_WAIT_MS
      ? parseInt(process.env.STRIPE_QTY_SMOKE_WAIT_MS, 10)
      : 30 * 60 * 1000;
    console.log(`[qty-smoke] Non-interactive shell — closing browser in ${ms / 60000} minutes (set STRIPE_QTY_SMOKE_WAIT_MS=ms to override).`);
    await page.waitForTimeout(ms);
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
