/**
 * Set prepaid plan quantity on Insight Manage Subscriptions before Checkout/Subscribe.
 * MUI/React often ignores plain .fill(); Stripe line item stays at 1 if Update is not clicked.
 * Qty controls can mount late after plan selection — retry with backoff.
 * @param {import('playwright').Page} page
 * @param {number} qty
 */
async function setInsightPlanQuantityBeforeStripe(page, qty) {
  const n = Math.max(1, parseInt(String(qty), 10) || 1);
  if (n <= 1) return;

  await page.waitForTimeout(2000);

  const tryOpenQtyEditor = async (visibleTimeout) => {
    const candidates = [
      page.getByRole('button', { name: /^qty$/i }),
      page.getByRole('button', { name: /quantity/i }),
      page.locator('button').filter({ hasText: /^qty$/i }),
    ];
    for (const loc of candidates) {
      const first = loc.first();
      if (await first.isVisible({ timeout: visibleTimeout }).catch(() => false)) {
        await first.click();
        await page.waitForTimeout(500);
        return true;
      }
    }
    return false;
  };

  const pickQuantityInput = async (root, inputVisibleTimeout) => {
    const ordered = [
      root.locator('input[name="quantity"]'),
      root.getByLabel(/quantity/i).first(),
      root.locator('input[aria-label="quantity"]'),
      root.locator('input[aria-label*="Quantity"]'),
      root.locator('input[aria-label*="quantity"]'),
      root.locator('input.MuiOutlinedInput-input[type="number"]'),
      root.locator('input[type="number"]'),
    ];
    for (const loc of ordered) {
      const inp = loc.first();
      if (await inp.isVisible({ timeout: inputVisibleTimeout }).catch(() => false)) return inp;
    }
    return null;
  };

  const MAX_QTY_ATTEMPTS = 5;
  let qIn = null;
  for (let attempt = 1; attempt <= MAX_QTY_ATTEMPTS && !qIn; attempt++) {
    const openT = Math.min(5000, 1500 + attempt * 700);
    await tryOpenQtyEditor(openT);

    const dialogVisible = await page
      .locator('[role="dialog"]')
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    const root = dialogVisible ? page.locator('[role="dialog"]').last() : page;

    const inputT = Math.min(6000, 2000 + attempt * 800);
    qIn = await pickQuantityInput(root, inputT);
    if (!qIn) {
      await tryOpenQtyEditor(openT);
      qIn = await pickQuantityInput(
        dialogVisible ? page.locator('[role="dialog"]').last() : page,
        inputT
      );
    }
    if (!qIn && attempt < MAX_QTY_ATTEMPTS) {
      console.log(
        `[insight-quantity] Qty controls not ready (attempt ${attempt}/${MAX_QTY_ATTEMPTS}) — waiting before retry`
      );
      await page.waitForTimeout(1800);
    }
  }

  if (qIn) {
    await qIn.click({ timeout: 2000 }).catch(() => {});
    await qIn.press('Control+a').catch(() => {});
    await qIn.fill(String(n), { timeout: 5000 }).catch(() => {});

    await qIn.evaluate((el, v) => {
      if (!(el instanceof HTMLInputElement)) return;
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (d && d.set) d.set.call(el, v);
      else el.value = v;
      const tr = el._valueTracker;
      if (tr && typeof tr.setValue === 'function') tr.setValue('');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(n));

    await page.waitForTimeout(300);

    const upd = page
      .getByRole('button', { name: /^update$/i })
      .or(root.getByRole('button', { name: /^update$/i }))
      .or(page.getByRole('button', { name: /update/i }).filter({ hasText: /update/i }))
      .first();

    if (await upd.isVisible({ timeout: 6000 }).catch(() => false)) {
      await upd.click();
      await page.waitForTimeout(1000);
      console.log('[insight-quantity] Set qty=%d and clicked Update', n);
    } else {
      console.warn('[insight-quantity] Filled qty=%d but no Update button — total may not refresh until blur', n);
      await qIn.press('Tab').catch(() => {});
      await page.waitForTimeout(500);
    }
    return;
  }

  const plus = page
    .getByRole('button', { name: /^\+$/ })
    .or(page.locator('button[aria-label*="increase" i]'))
    .first();
  if (await plus.isVisible({ timeout: 3000 }).catch(() => false)) {
    const need = Math.min(n - 1, 200);
    for (let i = 0; i < need; i++) {
      await plus.click();
      await page.waitForTimeout(60);
    }
    if (n - 1 > 200) console.warn('[insight-quantity] Increment capped at 201 clicks');
    const upd2 = page.getByRole('button', { name: /^update$/i }).first();
    if (await upd2.isVisible({ timeout: 3000 }).catch(() => false)) await upd2.click();
    await page.waitForTimeout(600);
    console.log('[insight-quantity] Set qty=%d via + button', n);
    return;
  }

  console.warn('[insight-quantity] Could not set quantity to %d — selectors may need refresh', n);
}

module.exports = { setInsightPlanQuantityBeforeStripe };
