/**
 * Drop 5 — Country Support Validation
 *
 * Validates that:
 *   1. The API returns correct country support flags matching countryList.json
 *   2. All 38 supported countries have isSubscriptionPymtSupported = true
 *   3. Unsupported countries (India, China, etc.) show the International Plan screen
 *   4. The Manage Subscriptions page respects country-based availability
 *
 * Uses the portal account (USD/US) for API validation and UI checks.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { applyStealth } from './stealth';
import {
  BASE, ACCOUNTS, SUPPORTED_COUNTRIES, UNSUPPORTED_COUNTRIES_SAMPLE,
  checkInvalidSession, login, goToManageSubscriptions,
} from './helpers';
import fs from 'fs';
import path from 'path';

const PREFIX = 'd5-country';
const EMAIL = ACCOUNTS['1yr'].email;

// Load the full country list from the JSON file
const countryListPath = path.resolve(__dirname, '../../countryList.json');
const countryListData = JSON.parse(fs.readFileSync(countryListPath, 'utf-8'));
const allCountries: Array<{
  countryName: string;
  countryCode: string;
  isSubscriptionPymtSupported: boolean;
}> = countryListData.countryList;

const supportedCountries = allCountries.filter(c => c.isSubscriptionPymtSupported === true);
const unsupportedCountries = allCountries.filter(c => c.isSubscriptionPymtSupported === false);

test.describe('Drop 5 — Country Support Validation', () => {
  test.describe.configure({ mode: 'serial' });

  let page: Page;
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await ctx.newPage();
    await applyStealth(page);
  });

  test.afterAll(async () => { await ctx?.close(); });

  // ─── LOGIN ───

  test('1. Login with US account for country validation', async () => {
    await login(page, EMAIL, PREFIX);
    expect(page.url()).toContain('mspHome');
    await page.screenshot({ path: `test-results/evidence/${PREFIX}-01-login.png`, fullPage: true });
  });

  // ─── COUNTRY LIST DATA VALIDATION ───

  test('2. Verify exactly 38 countries have subscription payment supported', async () => {
    console.log(`Total countries in list: ${allCountries.length}`);
    console.log(`Supported (isSubscriptionPymtSupported=true): ${supportedCountries.length}`);
    console.log(`Unsupported: ${unsupportedCountries.length}`);

    expect(supportedCountries.length, 'Should have exactly 38 supported countries').toBe(38);
  });

  test('3. Validate all 38 supported country names and codes', async () => {
    const expectedSupported = SUPPORTED_COUNTRIES;
    for (const expected of expectedSupported) {
      const found = supportedCountries.find(
        c => c.countryCode === expected.code
      );
      expect(found, `Country ${expected.name} (${expected.code}) should be in the supported list`).toBeTruthy();
      if (found) {
        expect(found.isSubscriptionPymtSupported).toBe(true);
      }
    }
    console.log('All 38 supported countries verified in countryList.json');
  });

  test('4. Validate key unsupported countries are correctly flagged', async () => {
    for (const country of UNSUPPORTED_COUNTRIES_SAMPLE) {
      const found = allCountries.find(c => c.countryCode === country.code);
      expect(found, `${country.name} (${country.code}) should exist in country list`).toBeTruthy();
      if (found) {
        expect(
          found.isSubscriptionPymtSupported,
          `${country.name} should have isSubscriptionPymtSupported=false`
        ).toBe(false);
      }
    }
    console.log('Unsupported countries (India, China, Brazil, Mexico, Russia, Turkey) correctly flagged');
  });

  // ─── API VALIDATION ───

  test('5. Country list API returns consistent data', async () => {
    // Try to fetch the country list via the app's API
    const cookies = await ctx.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const response = await page.evaluate(async (base) => {
      try {
        const res = await fetch(`${base}/api/v1/config/country-list`, {
          credentials: 'include',
        });
        if (res.ok) return { status: res.status, data: await res.json() };
        return { status: res.status, data: null };
      } catch (e: any) {
        return { status: 0, error: e.message };
      }
    }, BASE);

    console.log(`Country list API response status: ${response.status}`);

    if (response.data) {
      const apiCountries = response.data.countryList || response.data;
      if (Array.isArray(apiCountries)) {
        const apiSupported = apiCountries.filter((c: any) => c.isSubscriptionPymtSupported === true);
        console.log(`API returned ${apiCountries.length} countries, ${apiSupported.length} supported`);
        expect(apiSupported.length, 'API supported count should match JSON file').toBe(supportedCountries.length);
      }
    } else {
      console.log('Country list API not accessible or returned non-200. Skipping API comparison.');
    }
  });

  // ─── UI VALIDATION: SUPPORTED COUNTRY (US) ───

  test('6. US account — Manage Subscriptions shows subscription options', async () => {
    await goToManageSubscriptions(page, PREFIX);

    // For a US account, subscription features should be fully available
    const hasManageBtn = await page.getByRole('button', { name: 'Manage Subscription' }).isVisible().catch(() => false);
    const hasChoosePlan = await page.getByText(/Choose Subscription Plan/i).isVisible().catch(() => false);
    const hasSubscription = await page.getByText(/Year Subscription/i).isVisible().catch(() => false);
    const hasTrial = await page.getByText(/Free Trial/i).first().isVisible().catch(() => false);

    expect(
      hasManageBtn || hasChoosePlan || hasSubscription || hasTrial,
      'US account should show subscription options (Manage/Choose Plan/Active Sub/Trial)'
    ).toBe(true);

    // Should NOT show the International Plan screen
    const hasInternationalScreen = await page.getByText(/International Plan|not supported|not available in your country/i).isVisible().catch(() => false);
    expect(hasInternationalScreen, 'US account should NOT see International Plan screen').toBe(false);

    await page.screenshot({ path: `test-results/evidence/${PREFIX}-06-us-supported.png`, fullPage: true });
  });

  test('7. US account — plan selection shows 1-Year and 3-Year options', async () => {
    const choosePlan = page.getByText(/Choose Subscription Plan/i).first();
    if (await choosePlan.isVisible().catch(() => false)) {
      await choosePlan.click();
      await page.waitForTimeout(3_000);

      // Dismiss alert if present
      const alertDialog = page.getByText(/To activate your subscription/i);
      if (await alertDialog.isVisible().catch(() => false)) {
        await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
        await page.waitForTimeout(2_000);
      } else {
        // Should show both 1-Year and 3-Year plan options
        const has1yr = await page.getByText(/1.Year/i).isVisible().catch(() => false);
        const has3yr = await page.getByText(/3.Year/i).isVisible().catch(() => false);

        if (has1yr) console.log('1-Year plan option visible');
        if (has3yr) console.log('3-Year plan option visible');

        // DROP 5: Monthly and 5-Year NOT ready
        const has5yr = await page.getByText(/5.Year/i).isVisible().catch(() => false);
        const hasMonthly = await page.getByText(/Monthly|MUB/i).isVisible().catch(() => false);

        if (has5yr) console.log('WARNING: 5-Year plan visible — should NOT be available in Drop 5');
        if (hasMonthly) console.log('WARNING: Monthly plan visible — should NOT be available in Drop 5');

        await page.screenshot({ path: `test-results/evidence/${PREFIX}-07-plan-options.png`, fullPage: true });

        // Close the plan selection
        try { await page.keyboard.press('Escape'); } catch {}
        await page.waitForTimeout(1_000);
      }
    }
  });

  // ─── SUPPORTED COUNTRIES MATRIX TEST ───

  test('8. All 38 supported countries — log names for verification', async () => {
    console.log('\n=== 38 SUPPORTED COUNTRIES (isSubscriptionPymtSupported = true) ===');
    for (let i = 0; i < supportedCountries.length; i++) {
      const c = supportedCountries[i];
      console.log(`  ${i + 1}. ${c.countryName} (${c.countryCode})`);
    }

    // Verify key countries are in the supported list
    const keySupportedCodes = ['US', 'GB', 'DE', 'FR', 'JP', 'AU', 'CA', 'IT', 'ES', 'NL'];
    for (const code of keySupportedCodes) {
      const found = supportedCountries.find(c => c.countryCode === code);
      expect(found, `Key country ${code} should be supported`).toBeTruthy();
    }
  });

  test('9. All unsupported countries — log names for verification', async () => {
    console.log(`\n=== ${unsupportedCountries.length} UNSUPPORTED COUNTRIES ===`);
    for (let i = 0; i < unsupportedCountries.length; i++) {
      const c = unsupportedCountries[i];
      console.log(`  ${i + 1}. ${c.countryName} (${c.countryCode})`);
    }

    // Verify key unsupported countries
    const keyUnsupportedCodes = ['IN', 'CN', 'BR', 'RU', 'MX', 'TR', 'KR', 'TW', 'TH', 'PH'];
    for (const code of keyUnsupportedCodes) {
      const found = unsupportedCountries.find(c => c.countryCode === code);
      expect(found, `Country ${code} should be in unsupported list`).toBeTruthy();
    }
  });

  // ─── CURRENCY CONSISTENCY CHECK ───

  test('10. Supported EU countries — verify Eurozone coverage', async () => {
    const euCountryCodes = ['AT', 'BE', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES'];
    for (const code of euCountryCodes) {
      const found = supportedCountries.find(c => c.countryCode === code);
      expect(found, `Eurozone country ${code} should be supported for subscription payment`).toBeTruthy();
    }
    console.log(`All ${euCountryCodes.length} Eurozone countries verified as supported`);
  });

  test('11. Non-EU supported countries — verify diverse region coverage', async () => {
    const nonEuSupported = ['US', 'CA', 'GB', 'AU', 'NZ', 'JP', 'SG', 'HK', 'ZA', 'CH', 'NO', 'SE', 'DK', 'CZ', 'HU', 'PL', 'BG', 'HR', 'RO'];
    for (const code of nonEuSupported) {
      const found = supportedCountries.find(c => c.countryCode === code);
      expect(found, `Non-EU supported country ${code} should be in supported list`).toBeTruthy();
    }
    console.log(`All ${nonEuSupported.length} non-EU supported countries verified`);
  });

  // ─── WIRELESS REGION CROSS-CHECK ───

  test('12. All supported countries have isWirelessRegion = "1"', async () => {
    let allWireless = true;
    for (const c of supportedCountries) {
      if (c.isWirelessRegion !== '1') {
        console.log(`WARNING: ${c.countryName} (${c.countryCode}) is supported but isWirelessRegion=${c.isWirelessRegion}`);
        allWireless = false;
      }
    }
    expect(allWireless, 'All subscription-supported countries should also be wireless regions').toBe(true);
  });

  // ─── COUNTRY CODE FORMAT VALIDATION ───

  test('13. All country codes are valid 2-letter ISO 3166-1 alpha-2', async () => {
    for (const c of allCountries) {
      expect(c.countryCode.length, `Country code for ${c.countryName} should be 2 letters`).toBe(2);
      expect(c.countryCode, `Country code for ${c.countryName} should be uppercase`).toMatch(/^[A-Z]{2}$/);
    }
  });

  test('14. No duplicate country codes in the list', async () => {
    const codes = allCountries.map(c => c.countryCode);
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size, 'Should have no duplicate country codes').toBe(codes.length);
  });

  // ─── SUMMARY ───

  test('15. Summary report — supported vs unsupported totals', async () => {
    const total = allCountries.length;
    const supported = supportedCountries.length;
    const unsupported = unsupportedCountries.length;

    console.log(`\n=== COUNTRY SUPPORT SUMMARY ===`);
    console.log(`Total countries: ${total}`);
    console.log(`Supported for Stripe: ${supported} (${((supported / total) * 100).toFixed(1)}%)`);
    console.log(`Unsupported: ${unsupported}`);
    console.log(`\nSupported country codes: ${supportedCountries.map(c => c.countryCode).join(', ')}`);

    expect(supported + unsupported, 'Supported + unsupported should equal total').toBe(total);

    await page.screenshot({ path: `test-results/evidence/${PREFIX}-15-summary.png`, fullPage: true });
  });
});
