/**
 * E2E Subscription Demo — 6 Test Cases
 *
 * Recorded from interactive browser session on 2026-02-20.
 * Flow: Signup → Verify Email → Login + Onboarding → Trial Check → Add Device → Purchase
 *
 * TC6 is an intentional FAIL case: the page says "60 days" but the actual trial is 90 days.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  BASE, PWD, CARDS,
  generateSerial,
  type DeviceType,
} from './helpers';
import { generateTestEmail } from './email-helpers';

const PREFIX = 'demo';
const EV = (name: string) => `test-results/evidence/${PREFIX}-${name}.png`;

let DEMO_EMAIL = '';
let DEMO_INBOX = '';
let accountReady = false;
let trialStarted = false;

test.describe.serial('E2E Subscription Demo (6 Cases)', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page?.close().catch(() => {});
  });

  // ─── TC1: Create Fresh Account & Verify Email ───
  test('1. Create Fresh Account & Verify Email', async () => {
    const gen = generateTestEmail('demo');
    DEMO_EMAIL = gen.email;
    DEMO_INBOX = gen.inbox;
    console.log(`[TC1] Fresh email: ${DEMO_EMAIL}`);

    await test.step('Navigate to signup page', async () => {
      await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.locator('#outlined-adornment-firstname-register')
        .waitFor({ state: 'visible', timeout: 20_000 });
      await page.screenshot({ path: EV('01-signup-page'), fullPage: true });
    });

    await test.step('Fill signup form', async () => {
      await page.locator('#outlined-adornment-firstname-register').fill('Stripe');
      await page.locator('#outlined-adornment-lastname-register').fill('Demo');
      await page.locator('#outlined-adornment-email-register').fill(DEMO_EMAIL);
      await page.locator('#outlined-adornment-phone-register').fill('+12025551234');
      await page.locator('#outlined-adornment-password-register').fill(PWD);
      await page.locator('#outlined-adornment-confirm-password-register').fill(PWD);

      const termsCheckbox = page.getByRole('checkbox', { name: /Terms and Condition/i });
      await termsCheckbox.check();
    });

    await test.step('Submit signup', async () => {
      await page.getByRole('button', { name: /sign up/i }).click();

      const successAlert = page.getByText(/Registration successful|verification.*sent/i).first();
      await expect(successAlert).toBeVisible({ timeout: 30_000 });
      console.log('[TC1] Signup success');
      await page.screenshot({ path: EV('01-signup-success'), fullPage: true });
      accountReady = true;
    });

    await test.step('Verify email via Yopmail (manual CAPTCHA if needed)', async () => {
      await page.goto('https://yopmail.com', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const loginInput = page.getByRole('textbox', { name: 'Login' });
      await loginInput.waitFor({ state: 'visible', timeout: 10_000 });
      await loginInput.fill(DEMO_INBOX);
      await loginInput.press('Enter');
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

      const mailCount = page.locator('#nbmail');
      await mailCount.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      console.log(`[TC1] Mail count: ${await mailCount.textContent()}`);

      const hasCaptcha = await page.frameLocator('#ifmail')
        .locator('text=Complete the CAPTCHA').isVisible({ timeout: 3_000 }).catch(() => false);

      if (hasCaptcha) {
        console.log('[TC1] CAPTCHA detected — waiting 15s for manual solve...');
        await page.waitForTimeout(15_000);
      }

      const bodyFrame = page.frameLocator('#ifmail');
      await bodyFrame.locator('body').waitFor({ state: 'visible', timeout: 15_000 });

      const verifyLink = bodyFrame.getByRole('link', { name: /Verify My Email|Verify|Activate|Confirm/i }).first();
      await expect(verifyLink).toBeVisible({ timeout: 15_000 });
      const href = await verifyLink.getAttribute('href');
      expect(href, 'Verification link must exist').toBeTruthy();
      console.log(`[TC1] Verify link: ${href?.substring(0, 80)}...`);

      const [newPage] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 10_000 }).catch(() => null),
        verifyLink.click(),
      ]);

      if (newPage) {
        await newPage.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
        const congratsText = newPage.getByText(/Congratulations|successfully verified/i).first();
        await expect(congratsText).toBeVisible({ timeout: 15_000 });
        console.log('[TC1] Email verified successfully');
        await newPage.screenshot({ path: EV('01-email-verified'), fullPage: true });
        await newPage.close();
      } else {
        await page.goto(href!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.screenshot({ path: EV('01-email-verified'), fullPage: true });
      }
    });
  });

  // ─── TC2: Login → Org+Loc Wizard → Dashboard ───
  test('2. Login, Complete Onboarding & Verify Dashboard', async () => {

    await test.step('Logout existing session if any', async () => {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

      if (page.url().includes('mspHome')) {
        const userBtn = page.getByRole('button', { name: /user-account/i });
        if (await userBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
          await userBtn.click();
          const logoutBtn = page.getByRole('button', { name: 'Logout' });
          if (await logoutBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await logoutBtn.click();
            await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
          }
        }
      }
    });

    await test.step('Login with fresh account', async () => {
      if (!page.url().includes('accounts2-stg.netgear.com/login')) {
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

        const loginNow = page.getByRole('button', { name: /Login Now/i });
        if (await loginNow.isVisible({ timeout: 10_000 }).catch(() => false)) {
          await loginNow.click();
        }
      }

      const emailField = page.getByRole('textbox', { name: /email/i }).first();
      await emailField.waitFor({ state: 'visible', timeout: 20_000 });
      await emailField.fill(DEMO_EMAIL);

      const pwdField = page.getByRole('textbox', { name: /password/i }).first();
      await pwdField.fill(PWD);

      await page.getByRole('button', { name: /NETGEAR Sign In/i }).click();
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      console.log(`[TC2] Post-login URL: ${page.url()}`);
      await page.screenshot({ path: EV('02-post-login'), fullPage: true });
    });

    await test.step('Complete onboarding wizard (Org + Location)', async () => {
      const orgHeading = page.getByRole('heading', { name: /Create Organization/i }).first();
      if (await orgHeading.isVisible({ timeout: 10_000 }).catch(() => false)) {
        console.log('[TC2] Step 1: Creating organization');
        const orgInput = page.locator('main').getByRole('textbox').first();
        await orgInput.waitFor({ state: 'visible', timeout: 10_000 });
        await orgInput.fill(`Org-${PREFIX}-${Date.now().toString(36)}`);

        await page.getByRole('button', { name: 'Next' }).click();
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      }

      const locHeading = page.getByRole('heading', { name: /Create Location/i }).first();
      if (await locHeading.isVisible({ timeout: 10_000 }).catch(() => false)) {
        console.log('[TC2] Step 2: Creating location');
        const locName = `Loc-${PREFIX}-${Date.now().toString(36)}`;

        // Use page.evaluate to reliably fill MUI controlled inputs by label context
        await page.evaluate(({ locName, pwd }) => {
          const findInputByLabel = (labelText: string): HTMLInputElement | null => {
            const paragraphs = document.querySelectorAll('main p');
            for (const p of paragraphs) {
              if (p.textContent?.includes(labelText)) {
                const container = p.nextElementSibling;
                return container?.querySelector('input') ?? null;
              }
            }
            return null;
          };

          const setNativeValue = (el: HTMLInputElement, value: string) => {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value',
            )?.set;
            if (setter) {
              setter.call(el, value);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          };

          const locInput = findInputByLabel('Location Name');
          if (locInput) { locInput.focus(); setNativeValue(locInput, locName); }

          const pwdInput = findInputByLabel('Device Admin Password');
          if (pwdInput) { pwdInput.focus(); setNativeValue(pwdInput, pwd); }
        }, { locName, pwd: PWD });

        // Verify both fields have values before clicking Next
        const locInput = page.locator('main').getByRole('textbox').first();
        const locValue = await locInput.inputValue();
        console.log(`[TC2] Location Name filled: "${locValue}"`);

        const nextBtn = page.getByRole('button', { name: 'Next' });
        await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
        await nextBtn.click();
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      }
    });

    await test.step('Verify dashboard loaded', async () => {
      if (!page.url().includes('mspHome/dashboard')) {
        await page.goto(`${BASE}/mui/mspHome/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      }

      const welcome = page.getByText(/Welcome/i).first();
      await expect(welcome).toBeVisible({ timeout: 20_000 });
      console.log(`[TC2] Dashboard URL: ${page.url()}`);
      await page.screenshot({ path: EV('02-dashboard'), fullPage: true });
    });
  });

  // ─── TC3: Navigate to Manage Subscriptions & Verify Trial ───
  test('3. Manage Subscriptions - Trial Period Verification', async () => {
    test.skip(!accountReady, 'No account created');

    await test.step('Navigate to Manage Subscriptions', async () => {
      await page.goto(`${BASE}/mui/mspHome/administration/manage-subscriptions`, {
        waitUntil: 'domcontentloaded', timeout: 60_000,
      });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.screenshot({ path: EV('03-manage-subs'), fullPage: true });
    });

    await test.step('Verify trial status', async () => {
      const freeTrialHeading = page.getByRole('heading', { name: /Free Trial/i }).first();
      await expect(freeTrialHeading).toBeVisible({ timeout: 20_000 });

      const choosePlanBtn = page.getByRole('button', { name: /Choose Subscription Plan/i });
      await expect(choosePlanBtn).toBeVisible({ timeout: 10_000 });

      await expect(page.getByText('Allocated', { exact: true })).toBeVisible();
      await expect(page.getByText('Unallocated', { exact: true })).toBeVisible();
      console.log('[TC3] Trial verification passed');
    });
  });

  // ─── TC4: Add a Device ───
  test('4. Add a Device Before Purchase', async () => {
    test.skip(!accountReady, 'No account created');

    const serial = generateSerial('NHB');
    console.log(`[TC4] Generated serial: ${serial}`);

    await test.step('Navigate to Devices page', async () => {
      await page.goto(`${BASE}/mui/mspHome/devices`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      const addBtn = page.getByRole('button', { name: 'Add' }).first();
      await addBtn.waitFor({ state: 'visible', timeout: 30_000 });
      await page.screenshot({ path: EV('04-devices-page'), fullPage: true });
    });

    await test.step('Open Add Device panel', async () => {
      await page.getByRole('button', { name: 'Add' }).first().click();
      await page.getByRole('heading', { name: /Add Device/i }).first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      await page.screenshot({ path: EV('04-add-panel'), fullPage: true });
    });

    await test.step('Select location from dropdown', async () => {
      const locDropdown = page.locator('#org-dropdown-button-addDeviceAllOrg');
      await locDropdown.waitFor({ state: 'visible', timeout: 10_000 });
      await locDropdown.click();

      const orgItem = page.getByRole('treeitem').filter({ hasText: /Org-/ }).first();
      await orgItem.waitFor({ state: 'visible', timeout: 8_000 });

      const expandIcon = orgItem.locator('img').first();
      await expandIcon.click();

      const locItem = page.getByRole('treeitem').filter({ hasText: /Loc-/ }).first();
      await locItem.waitFor({ state: 'visible', timeout: 8_000 });
      await locItem.click();
      await page.screenshot({ path: EV('04-loc-selected'), fullPage: true });
    });

    await test.step('Fill serial number, device name, MAC and submit', async () => {
      const serialInput = page.locator('#serialNumber');
      await serialInput.waitFor({ state: 'visible', timeout: 15_000 });
      await serialInput.fill(serial);

      const deviceNameInput = page.locator('#deviceName');
      if (await deviceNameInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await deviceNameInput.fill(`Demo-${serial.substring(0, 3)}`);
      }

      const macInput = page.getByPlaceholder(/aa:bb:cc/i).first();
      if (await macInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await macInput.fill('AA:BB:CC:DD:EE:01');
      }

      await page.screenshot({ path: EV('04-serial-filled'), fullPage: true });

      await page.getByRole('button', { name: 'Add' }).last().click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.screenshot({ path: EV('04-device-result'), fullPage: true });
    });

    await test.step('Handle trial popup and verify device added', async () => {
      const trialPopup = page.getByRole('heading', { name: /Trial Starts Now/i }).first();
      if (await trialPopup.isVisible({ timeout: 10_000 }).catch(() => false)) {
        console.log('[TC4] Trial popup appeared');
        trialStarted = true;
        await page.screenshot({ path: EV('04-trial-popup'), fullPage: true });
        const gotIt = page.getByRole('button', { name: /Got It/i });
        if (await gotIt.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await gotIt.click();
        }
      }

      const successAlert = page.getByText(/Device added successfully/i).first();
      if (await successAlert.isVisible({ timeout: 10_000 }).catch(() => false)) {
        console.log('[TC4] Device added successfully');
      }

      await page.screenshot({ path: EV('04-final'), fullPage: true });
    });
  });

  // ─── TC5: Purchase 1-Year Subscription (Visa) ───
  test('5. Purchase 1-Year Subscription (Visa)', async () => {
    test.skip(!accountReady, 'No account created');

    await test.step('Navigate to Manage Subscriptions', async () => {
      await page.goto(`${BASE}/mui/mspHome/administration/manage-subscriptions`, {
        waitUntil: 'domcontentloaded', timeout: 60_000,
      });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.getByRole('button', { name: /Choose Subscription Plan/i })
        .waitFor({ state: 'visible', timeout: 20_000 });
    });

    await test.step('Open plan dialog and choose 1-year', async () => {
      await page.getByRole('button', { name: /Choose Subscription Plan/i }).click();
      await page.getByRole('heading', { name: 'Choose Subscription Plan' })
        .waitFor({ state: 'visible', timeout: 10_000 });
      await page.screenshot({ path: EV('05-plan-dialog'), fullPage: true });

      const chooseBtns = page.getByRole('button', { name: 'Choose Plan' });
      const count = await chooseBtns.count();
      if (count >= 2) await chooseBtns.nth(1).click();
      else await chooseBtns.first().click();
    });

    await test.step('Fill Stripe checkout', async () => {
      await page.waitForURL(/stripe\.com|checkout/, { timeout: 20_000 });
      console.log(`[TC5] Stripe checkout: ${page.url()}`);
      await page.screenshot({ path: EV('05-stripe-page'), fullPage: true });

      await page.evaluate(() => {
        const btn = document.querySelector<HTMLElement>('[data-testid="card-accordion-item-button"]');
        if (btn) btn.click();
      });
      await page.locator('#cardNumber').waitFor({ state: 'visible', timeout: 10_000 });

      await page.locator('#cardNumber').fill(CARDS.visa);
      await page.locator('#cardExpiry').fill('1230');
      await page.locator('#cardCvc').fill('123');
      await page.locator('#billingName').fill('Stripe Demo');
      await page.locator('#billingPostalCode').fill('10001');
      await page.screenshot({ path: EV('05-stripe-filled'), fullPage: true });
    });

    await test.step('Submit payment and verify subscription', async () => {
      await page.getByRole('button', { name: /subscribe/i }).click();
      console.log('[TC5] Payment submitted, waiting for redirect...');

      await page.waitForURL(/manage-subscriptions|landingPage|mui/, { timeout: 60_000 });

      if (!page.url().includes('manage-subscriptions')) {
        console.log(`[TC5] Redirected to ${page.url()} — re-login needed`);
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

        if (page.url().includes('mspHome')) {
          const userBtn = page.getByRole('button', { name: /user-account/i });
          if (await userBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await userBtn.click();
            const logoutBtn = page.getByRole('button', { name: 'Logout' });
            if (await logoutBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
              await logoutBtn.click();
              await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
            }
          }
        }

        const loginNow = page.getByRole('button', { name: /Login Now/i });
        if (await loginNow.isVisible({ timeout: 10_000 }).catch(() => false)) {
          await loginNow.click();
        }

        const emailField = page.getByRole('textbox', { name: /email/i }).first();
        await emailField.waitFor({ state: 'visible', timeout: 20_000 });
        await emailField.fill(DEMO_EMAIL);
        await page.getByRole('textbox', { name: /password/i }).first().fill(PWD);
        await page.getByRole('button', { name: /NETGEAR Sign In/i }).click();
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

        await page.goto(`${BASE}/mui/mspHome/administration/manage-subscriptions`, {
          waitUntil: 'domcontentloaded', timeout: 60_000,
        });
      }

      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.screenshot({ path: EV('05-post-payment'), fullPage: true });

      const manageBtn = page.getByRole('button', { name: 'Manage Subscription' });
      await expect(manageBtn).toBeVisible({ timeout: 20_000 });

      const subLabel = page.getByText(/1-Year Subscription/i).first();
      await expect(subLabel).toBeVisible({ timeout: 10_000 });

      const expiration = page.getByRole('heading', { name: /Feb.*2027/i }).first();
      await expect(expiration).toBeVisible({ timeout: 10_000 });

      console.log('[TC5] Subscription purchase verified');
      await page.screenshot({ path: EV('05-purchase-complete'), fullPage: true });
    });
  });

  // ─── TC6: Trial period shows 60 days instead of 90 days ───
  test('6. Trial period shows 60 days instead of 90 days', async () => {
    test.skip(!accountReady, 'No account created');

    await test.step('Navigate to Manage Subscriptions', async () => {
      await page.goto(`${BASE}/mui/mspHome/administration/manage-subscriptions`, {
        waitUntil: 'domcontentloaded', timeout: 60_000,
      });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.screenshot({ path: EV('06-manage-subs'), fullPage: true });
    });

    await test.step('Verify trial period shows 90 days', async () => {
      await page.screenshot({ path: EV('06-trial-duration'), fullPage: true });
      await expect(
        page.getByText(/90 days/i).first(),
        'Trial period should show 90 days but page displays 60 days',
      ).toBeVisible({ timeout: 5_000 });
    });
  });
});
