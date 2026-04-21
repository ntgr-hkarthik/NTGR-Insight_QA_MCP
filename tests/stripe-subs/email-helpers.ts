import { chromium, type Page, type BrowserContext } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { applyStealth } from './stealth';

const EVIDENCE_DIR = path.resolve(__dirname, '../../test-results/evidence');

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

export type EmailProvider = 'yopmail' | 'mailtm' | 'dollicons';

export interface EmailResult {
  provider: EmailProvider;
  email: string;
  verificationLink: string | null;
  error?: string;
}

function screenshot(page: Page, name: string) {
  return page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

/**
 * Attempt to verify an email via Yopmail using a persistent browser (no CAPTCHA extension).
 * Returns the verification link URL, or null if captcha blocks / mail count is -1.
 */
export async function verifyViaYopmail(
  inbox: string,
  prefix: string,
): Promise<string | null> {
  const userDataDir = path.resolve(__dirname, '../../.yopmail-profile-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`[Yopmail] Checking inbox "${inbox}"`);

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--disable-default-apps',
      '--disable-popup-blocking',
    ],
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });

  const pg = await ctx.newPage();
  await applyStealth(pg);

  try {
    await pg.goto('https://yopmail.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await screenshot(pg, `${prefix}-yop-home`);

    const loginInput = pg.locator('#login');
    if (await loginInput.isVisible().catch(() => false)) {
      await loginInput.fill(inbox);
      await pg.keyboard.press('Enter');
      await pg.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    } else {
      await pg.goto(`https://yopmail.com/en/wm?login=${inbox}&p=1`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }

    await screenshot(pg, `${prefix}-yop-inbox`);

    // Check captcha
    const hasCaptcha = await pg.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').isVisible().catch(() => false);
    if (hasCaptcha) {
      console.log('[Yopmail] CAPTCHA detected, waiting for resolution (60s)...');
      let solved = false;
      for (let i = 0; i < 12; i++) {
        await pg.waitForTimeout(5_000);
        const still = await pg.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').isVisible().catch(() => false);
        const appeared = await pg.locator('#ifinbox').isVisible().catch(() => false);
        if (appeared || !still) { solved = true; break; }
      }
      if (!solved) {
        console.log('[Yopmail] CAPTCHA not solved — falling back');
        await screenshot(pg, `${prefix}-yop-captcha-fail`);
        return null;
      }
    }

    // Check mail count for -1
    const mailCountEl = pg.locator('#nbmail');
    if (await mailCountEl.isVisible().catch(() => false)) {
      const countText = ((await mailCountEl.textContent()) || '').trim();
      console.log(`[Yopmail] Mail count: "${countText}"`);
      if (countText.includes('-1') || countText === '0 mail' || countText === '0') {
        console.log('[Yopmail] No emails or -1 count — falling back');
        await screenshot(pg, `${prefix}-yop-no-mail`);
        return null;
      }
    }

    // Check inbox frame
    if (!(await pg.locator('#ifinbox').isVisible().catch(() => false))) {
      console.log('[Yopmail] Inbox frame not visible — falling back');
      return null;
    }

    // Find verification email
    const inboxFrame = pg.frameLocator('#ifinbox');
    const mail = inboxFrame.locator('button, div.m').filter({ hasText: /erify|NETGEAR|insight|activ|confirm/i }).first();
    if (!(await mail.isVisible({ timeout: 15_000 }).catch(() => false))) {
      console.log('[Yopmail] No verification email found');
      await screenshot(pg, `${prefix}-yop-no-verify-mail`);
      return null;
    }
    await mail.click();
    await pg.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    // Extract link from the mail body frame
    const bodyFrame = pg.frameLocator('#ifmail');
    await bodyFrame.locator('body').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

    // Try by link text first
    let href: string | null = null;
    const link = bodyFrame.getByRole('link', { name: /Verify|Activate|Confirm|Click here/i }).first();
    if (await link.isVisible({ timeout: 5_000 }).catch(() => false)) {
      href = await link.getAttribute('href');
    }

    // Fallback: any link with verify/confirm/activate in href
    if (!href) {
      const hrefLink = bodyFrame.locator('a[href*="confirm"], a[href*="verify"], a[href*="activate"], a[href*="confirmemail"]').first();
      if (await hrefLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
        href = await hrefLink.getAttribute('href');
      }
    }

    // Last resort: any link that's not unsubscribe
    if (!href) {
      const allLinks = bodyFrame.locator('a[href]');
      const count = await allLinks.count();
      for (let i = 0; i < count; i++) {
        const h = await allLinks.nth(i).getAttribute('href') || '';
        if (h.includes('accounts') || h.includes('confirm') || h.includes('verify')) {
          href = h;
          break;
        }
      }
    }

    if (!href) {
      console.log('[Yopmail] No verify link in email body');
      await screenshot(pg, `${prefix}-yop-no-link`);
      return null;
    }

    await screenshot(pg, `${prefix}-yop-verify-link`);
    console.log(`[Yopmail] Verification link: ${href?.substring(0, 80)}...`);
    return href;
  } catch (err: any) {
    console.log(`[Yopmail] Error: ${err.message?.substring(0, 200)}`);
    await screenshot(pg, `${prefix}-yop-error`);
    return null;
  } finally {
    await ctx.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

/**
 * Verify email via mail.tm — visual browser approach (no API).
 * Opens mail.tm in a browser, creates a temporary address, then waits for
 * the verification email to arrive.
 */
export async function verifyViaMailTM(
  targetEmail: string,
  prefix: string,
): Promise<string | null> {
  console.log(`[mail.tm] Visual verification for: ${targetEmail}`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });
  const pg = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await pg.goto('https://mail.tm', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await pg.waitForTimeout(3_000);
    await screenshot(pg, `${prefix}-mailtm-home`);

    // mail.tm auto-generates an address — we need to read it
    // The address is displayed on the page
    const addressEl = pg.locator('.address, [class*="address"], input[readonly]').first();
    let mailtmAddress = '';
    if (await addressEl.isVisible().catch(() => false)) {
      mailtmAddress = (await addressEl.inputValue().catch(() => '') || await addressEl.textContent() || '').trim();
    }

    if (!mailtmAddress) {
      // Try the copy button area
      const copyArea = pg.locator('button:has-text("Copy")').first();
      if (await copyArea.isVisible().catch(() => false)) {
        const parent = copyArea.locator('xpath=..');
        mailtmAddress = (await parent.textContent() || '').replace('Copy', '').trim();
      }
    }

    console.log(`[mail.tm] Generated address: ${mailtmAddress || '(could not read)'}`);
    await screenshot(pg, `${prefix}-mailtm-address`);

    if (!mailtmAddress) {
      console.log('[mail.tm] Could not get email address — fallback');
      return null;
    }

    // Wait for verification email (up to 120s, checking every 10s)
    console.log('[mail.tm] Waiting for verification email (up to 120s)...');
    let found = false;
    for (let i = 0; i < 12; i++) {
      await pg.waitForTimeout(10_000);
      // Refresh/check for new mail
      try { await pg.getByRole('button', { name: /refresh/i }).click().catch(() => {}); } catch {}
      await pg.waitForTimeout(2_000);

      const mailItem = pg.locator('[class*="message"], [class*="mail"], tr, li').filter({
        hasText: /NETGEAR|erify|insight|activ|confirm/i,
      }).first();

      if (await mailItem.isVisible().catch(() => false)) {
        await mailItem.click();
        await pg.waitForTimeout(3_000);
        found = true;
        break;
      }
      console.log(`[mail.tm] Check ${i + 1}/12 — no verification email yet`);
    }

    if (!found) {
      console.log('[mail.tm] No verification email received');
      await screenshot(pg, `${prefix}-mailtm-no-mail`);
      return null;
    }

    await screenshot(pg, `${prefix}-mailtm-email-body`);

    // Extract verification link
    const verifyLink = pg.getByRole('link', { name: /Verify|Activate|Confirm|Click here/i }).first();
    if (await verifyLink.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const href = await verifyLink.getAttribute('href');
      console.log(`[mail.tm] Verification link: ${href?.substring(0, 80)}...`);
      return href;
    }

    // Fallback: look for any link containing "verify" or "activate"
    const anyLink = pg.locator('a[href*="verify"], a[href*="activate"], a[href*="confirm"]').first();
    if (await anyLink.isVisible().catch(() => false)) {
      const href = await anyLink.getAttribute('href');
      console.log(`[mail.tm] Found link via href match: ${href?.substring(0, 80)}...`);
      return href;
    }

    console.log('[mail.tm] Could not extract verification link');
    return null;
  } catch (err: any) {
    console.log(`[mail.tm] Error: ${err.message?.substring(0, 200)}`);
    await screenshot(pg, `${prefix}-mailtm-error`);
    return null;
  } finally {
    await browser.close();
  }
}

/**
 * Full email verification with fallback chain:
 *   1. Yopmail (primary)
 *   2. mail.tm (visual browser fallback)
 *
 * Returns the provider used and the verification link.
 */
export async function verifyEmailWithFallback(
  inbox: string,
  fullEmail: string,
  prefix: string,
): Promise<EmailResult> {
  // Attempt 1: Yopmail
  console.log('=== Email Verification: Trying Yopmail (primary) ===');
  const yopmailLink = await verifyViaYopmail(inbox, prefix);
  if (yopmailLink) {
    return { provider: 'yopmail', email: fullEmail, verificationLink: yopmailLink };
  }

  // Attempt 2: mail.tm (visual)
  console.log('=== Email Verification: Yopmail failed, trying mail.tm (fallback) ===');
  const mailtmLink = await verifyViaMailTM(fullEmail, prefix);
  if (mailtmLink) {
    return { provider: 'mailtm', email: fullEmail, verificationLink: mailtmLink };
  }

  console.log('=== Email Verification: All providers exhausted ===');
  return { provider: 'yopmail', email: fullEmail, verificationLink: null, error: 'All email verification attempts failed' };
}

/**
 * Generate a fresh test email address.
 * @param tag - Unique identifier (e.g., 'demo', 'usd1yr')
 * @param domain - Email domain: 'yopmail.com' (primary) or 'dollicons.com' (alternative)
 */
export function generateTestEmail(tag: string, domain: 'yopmail.com' | 'dollicons.com' = 'yopmail.com'): { email: string; inbox: string } {
  const ts = Date.now().toString(36);
  const inbox = `stripe-${tag}-${ts}`;
  return { email: `${inbox}@${domain}`, inbox };
}

const SIGNUP_URL = 'https://pri-qa.insight.netgear.com/mui/signup';

/**
 * Create a fresh Insight account via the MUI signup page.
 * Fields: First Name, Last Name, Email, Phone, Password, Confirm Password,
 *         Country (MUI Autocomplete), Terms checkbox → Sign Up button.
 */
export async function createInsightAccount(
  page: Page,
  email: string,
  password: string,
  firstName: string,
  lastName: string,
  country: string,
  prefix: string,
): Promise<boolean> {
  console.log(`[Signup] Creating account: ${email}`);
  await page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('#outlined-adornment-firstname-register')
    .waitFor({ state: 'visible', timeout: 20_000 });
  await screenshot(page, `${prefix}-signup-page`);

  // First Name
  const fnInput = page.locator('#outlined-adornment-firstname-register');
  await fnInput.waitFor({ state: 'visible', timeout: 15_000 });
  await fnInput.fill(firstName);

  // Last Name
  await page.locator('#outlined-adornment-lastname-register').fill(lastName);

  // Email
  await page.locator('#outlined-adornment-email-register').fill(email);

  // Phone (optional but fill a valid one)
  await page.locator('#outlined-adornment-phone-register').fill('+12025551234');

  // Password + Confirm Password
  await page.locator('#outlined-adornment-password-register').fill(password);
  await page.locator('#outlined-adornment-confirm-password-register').fill(password);

  // Country — MUI Select (div[role="combobox"]): click to open, then pick from listbox
  const countrySelect = page.locator('#outlined-adornment-country-register');
  if (await countrySelect.isVisible().catch(() => false)) {
    await countrySelect.click();
    await page.getByRole('listbox').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

    // MUI Select opens a listbox with role="option" items — search for the country
    const option = page.getByRole('option', { name: new RegExp(`^${country}$`, 'i') }).first();
    if (await option.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await option.scrollIntoViewIfNeeded();
      await option.click();
    } else {
      // Partial match fallback
      const partialOpt = page.getByRole('option', { name: new RegExp(country, 'i') }).first();
      if (await partialOpt.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await partialOpt.click();
      } else {
        console.log(`[Signup] Country "${country}" not found in dropdown`);
        await page.keyboard.press('Escape');
      }
    }
  } else {
    // Fallback: plain <input name="country"> — MUI Autocomplete variant
    const fallbackInput = page.locator('input[name="country"]');
    if (await fallbackInput.isVisible().catch(() => false)) {
      await fallbackInput.click();
      await fallbackInput.fill(country);
      await page.getByRole('listbox').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
      const opt = page.getByRole('option', { name: new RegExp(country, 'i') }).first();
      if (await opt.isVisible().catch(() => false)) await opt.click();
    }
  }

  // Terms checkbox (name="checked" — the second checkbox)
  const termsCheck = page.locator('input[name="checked"]');
  if (await termsCheck.isVisible().catch(() => false)) {
    const checked = await termsCheck.isChecked().catch(() => false);
    if (!checked) await termsCheck.check();
  }

  await screenshot(page, `${prefix}-signup-filled`);

  // Click "Sign Up"
  const signupBtn = page.getByRole('button', { name: /sign up/i }).first();
  if (await signupBtn.isVisible().catch(() => false)) {
    await signupBtn.click();
    console.log('[Signup] Clicked Sign Up');
  } else {
    console.log('[Signup] Sign Up button not found, pressing Enter');
    await page.keyboard.press('Enter');
  }

  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await screenshot(page, `${prefix}-signup-submitted`);

  const url = page.url();
  console.log(`[Signup] Post-submit URL: ${url}`);

  // Check for known errors
  const hasError = await page.getByText(/already exists|error|failed|invalid email/i).first().isVisible().catch(() => false);
  if (hasError) {
    const errorText = await page.getByText(/already exists|error|failed|invalid/i).first().textContent().catch(() => '');
    console.log(`[Signup] Error: ${errorText}`);
    await screenshot(page, `${prefix}-signup-error`);
    return false;
  }

  // Check for success indicators
  const successIndicators = [
    page.getByText(/verify your email|check your email|verification email sent/i).first(),
    page.getByText(/account created|successfully|welcome/i).first(),
  ];
  for (const indicator of successIndicators) {
    if (await indicator.isVisible().catch(() => false)) {
      const text = await indicator.textContent().catch(() => '');
      console.log(`[Signup] Success indicator: "${text}"`);
      break;
    }
  }

  return true;
}
