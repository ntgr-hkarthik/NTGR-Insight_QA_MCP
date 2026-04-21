/**
 * Stripe hosted checkout — preview only (no payment submit).
 * Uses navigateInsightToHostedStripeCheckout + fillStripeBillingAdaptive({ previewMode: true }).
 */

const path = require('path');
const fs = require('fs');
const {
  navigateInsightToHostedStripeCheckout,
  setHostedStripeQuantityBeforeBilling,
  fillStripeBillingAdaptive,
  submitStripeHostedCheckout,
  DEFAULT_CARD,
} = require('./acc-purchase');

/** User-requested order (label → ISO2) */
const PREVIEW_COUNTRY_MATRIX = [
  { label: 'Sweden', iso2: 'SE' },
  { label: 'Canada', iso2: 'CA' },
  { label: 'Denmark', iso2: 'DK' },
  { label: 'Ireland', iso2: 'IE' },
  { label: 'UK', iso2: 'GB' },
  { label: 'Japan', iso2: 'JP' },
  { label: 'Norway', iso2: 'NO' },
  { label: 'Luxembourg', iso2: 'LU' },
  { label: 'Austria', iso2: 'AT' },
  { label: 'Bulgaria', iso2: 'BG' },
  { label: 'Germany', iso2: 'DE' },
  { label: 'New Zealand', iso2: 'NZ' },
  { label: 'France', iso2: 'FR' },
  { label: 'Hungary', iso2: 'HU' },
  { label: 'Netherlands', iso2: 'NL' },
  { label: 'Portugal', iso2: 'PT' },
  { label: 'Czech Republic', iso2: 'CZ' },
  { label: 'Singapore', iso2: 'SG' },
  { label: 'Australia', iso2: 'AU' },
  { label: 'Croatia', iso2: 'HR' },
  { label: 'Greece', iso2: 'GR' },
  { label: 'Hong Kong', iso2: 'HK' },
  { label: 'Poland', iso2: 'PL' },
  { label: 'Slovakia', iso2: 'SK' },
  { label: 'Belgium', iso2: 'BE' },
  { label: 'Lithuania', iso2: 'LT' },
  { label: 'Estonia', iso2: 'EE' },
  { label: 'Finland', iso2: 'FI' },
  { label: 'Latvia', iso2: 'LV' },
  { label: 'Romania', iso2: 'RO' },
  { label: 'Slovenia', iso2: 'SI' },
  { label: 'Italy', iso2: 'IT' },
  { label: 'Malta', iso2: 'MT' },
  { label: 'Cyprus', iso2: 'CY' },
  { label: 'South Africa', iso2: 'ZA' },
  { label: 'Spain', iso2: 'ES' },
  { label: 'Switzerland', iso2: 'CH' },
  { label: 'United States of America', iso2: 'US' },
];

/**
 * NETGEAR Intl hosted-checkout matrix — addresses + plan per country (Stripe shows a subset of fields; we fill only visible).
 * @type {Array<{ label: string, iso2: string, plan: '1-Year'|'3-Year', expectedCurrency: string, address: Record<string, string|undefined> }>}
 */
const INTL_E2E_SCENARIOS = [
  {
    label: 'New Zealand',
    iso2: 'NZ',
    plan: '3-Year',
    expectedCurrency: 'NZD',
    address: {
      countryCode: 'NZ',
      addr1: '12 Lambton Quay',
      addr2: '',
      city: 'Wellington',
      state: 'Wellington',
      zip: '6011',
      company: 'New Business',
    },
  },
  {
    label: 'Japan',
    iso2: 'JP',
    plan: '1-Year',
    expectedCurrency: 'JPY',
    address: {
      countryCode: 'JP',
      addr1: '1-1 Marunouchi',
      addr2: 'Chiyoda-ku',
      city: 'Tokyo',
      state: 'Tokyo',
      zip: '100-0005',
      company: 'New Business',
    },
  },
  {
    label: 'Switzerland',
    iso2: 'CH',
    plan: '3-Year',
    expectedCurrency: 'CHF',
    address: {
      countryCode: 'CH',
      addr1: 'Bahnhofstrasse 21',
      addr2: '',
      city: 'Zurich',
      state: 'Zurich',
      zip: '8001',
      company: 'New Business',
    },
  },
  {
    label: 'Czech Republic',
    iso2: 'CZ',
    plan: '1-Year',
    expectedCurrency: 'CZK',
    address: {
      countryCode: 'CZ',
      addr1: 'Václavské náměstí 1',
      addr2: '',
      city: 'Prague',
      state: 'Prague',
      zip: '110 00',
      company: 'New Business',
    },
  },
  {
    label: 'Denmark',
    iso2: 'DK',
    plan: '3-Year',
    expectedCurrency: 'DKK',
    address: {
      countryCode: 'DK',
      addr1: 'Strøget 12',
      addr2: '',
      city: 'Copenhagen',
      state: 'Capital Region',
      zip: '1260',
      company: 'New Business',
    },
  },
  {
    label: 'Hong Kong',
    iso2: 'HK',
    plan: '1-Year',
    expectedCurrency: 'HKD',
    address: {
      countryCode: 'HK',
      addr1: '1 Harbour Road',
      addr2: 'Wan Chai',
      city: 'Hong Kong',
      state: '',
      zip: '',
      company: 'New Business',
    },
  },
  {
    label: 'Hungary',
    iso2: 'HU',
    plan: '3-Year',
    expectedCurrency: 'HUF',
    address: {
      countryCode: 'HU',
      addr1: 'Andrássy út 1',
      addr2: '',
      city: 'Budapest',
      state: 'Budapest',
      zip: '1061',
      company: 'New Business',
    },
  },
  {
    label: 'Norway',
    iso2: 'NO',
    plan: '1-Year',
    expectedCurrency: 'NOK',
    address: {
      countryCode: 'NO',
      addr1: 'Karl Johans gate 1',
      addr2: '',
      city: 'Oslo',
      state: 'Oslo',
      zip: '154',
      company: 'New Business',
    },
  },
  {
    label: 'Poland',
    iso2: 'PL',
    plan: '3-Year',
    expectedCurrency: 'PLN',
    address: {
      countryCode: 'PL',
      addr1: 'ul. Marszałkowska 1',
      addr2: '',
      city: 'Warsaw',
      state: 'Masovian',
      zip: '00-001',
      company: 'New Business',
    },
  },
  {
    label: 'Singapore',
    iso2: 'SG',
    plan: '1-Year',
    expectedCurrency: 'SGD',
    address: {
      countryCode: 'SG',
      addr1: '1 Raffles Place',
      addr2: '#01-01',
      city: 'Singapore',
      state: '',
      zip: '48616',
      company: 'New Business',
    },
  },
  {
    label: 'South Africa',
    iso2: 'ZA',
    plan: '3-Year',
    expectedCurrency: 'ZAR',
    address: {
      countryCode: 'ZA',
      addr1: '1 Adderley Street',
      addr2: '',
      city: 'Cape Town',
      state: 'Western Cape',
      zip: '8001',
      company: 'New Business',
    },
  },
  {
    label: 'France',
    iso2: 'FR',
    plan: '3-Year',
    expectedCurrency: 'EUR',
    address: {
      countryCode: 'FR',
      addr1: '10 Rue de Rivoli',
      addr2: '',
      city: 'Paris',
      state: 'Île-de-France',
      zip: '75001',
      company: 'New Business',
    },
  },
  {
    label: 'Germany',
    iso2: 'DE',
    plan: '3-Year',
    expectedCurrency: 'EUR',
    address: {
      countryCode: 'DE',
      addr1: 'Unter den Linden 1',
      addr2: '',
      city: 'Berlin',
      state: 'Berlin',
      zip: '10117',
      company: 'New Business',
    },
  },
  {
    label: 'Netherlands',
    iso2: 'NL',
    plan: '3-Year',
    expectedCurrency: 'EUR',
    address: {
      countryCode: 'NL',
      addr1: 'Damrak 1',
      addr2: '',
      city: 'Amsterdam',
      state: 'North Holland',
      zip: '1012 LG',
      company: 'New Business',
    },
  },
];

/** Expected ISO 4217 for validation (best-effort; Nordics / majors explicit). */
const EXPECTED_CURRENCY_BY_ISO2 = {
  US: 'USD',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  SG: 'SGD',
  HK: 'HKD',
  JP: 'JPY',
  CH: 'CHF',
  GB: 'GBP',
  ZA: 'ZAR',
  SE: 'SEK',
  DK: 'DKK',
  NO: 'NOK',
  BG: 'BGN',
  HU: 'HUF',
  CZ: 'CZK',
  PL: 'PLN',
  RO: 'RON',
  IE: 'EUR',
  LU: 'EUR',
  AT: 'EUR',
  DE: 'EUR',
  FR: 'EUR',
  NL: 'EUR',
  PT: 'EUR',
  HR: 'EUR',
  GR: 'EUR',
  SK: 'EUR',
  BE: 'EUR',
  LT: 'EUR',
  EE: 'EUR',
  FI: 'EUR',
  LV: 'EUR',
  SI: 'EUR',
  IT: 'EUR',
  MT: 'EUR',
  CY: 'EUR',
  ES: 'EUR',
};

/** Sample postal / address lines for preview fills (no purchase). */
function previewAddressFor(iso2) {
  const c = String(iso2 || 'US').toUpperCase();
  const table = {
    /** NETGEAR HQ-style line1 + matching city/state/ZIP (do not mix CA city with KS ZIP). */
    US: { zip: '95134', addr1: '350 East Plumeria Drive', city: 'San Jose', state: 'CA' },
    CA: { zip: 'M5H 2N2', addr1: '100 Queen Street West', city: 'Toronto', state: 'ON' },
    GB: { zip: 'SW1A 1AA', addr1: '1 Test Street', city: 'London', state: '' },
    AU: { zip: '2000', addr1: '1 George Street', city: 'Sydney', state: 'NSW' },
    NZ: { zip: '1010', addr1: '1 Queen Street', city: 'Auckland', state: '' },
    JP: { zip: '100-0001', addr1: '1 Chiyoda', city: 'Chiyoda', state: 'Tokyo' },
    SG: { zip: '018956', addr1: '1 Marina Blvd', city: 'Singapore', state: '' },
    HK: { zip: '999077', addr1: '1 Queen Rd Central', city: 'Central', state: 'Hong Kong' },
    CH: { zip: '8001', addr1: 'Bahnhofstrasse 1', city: 'Zürich', state: '' },
    ZA: { zip: '8001', addr1: '1 Long Street', city: 'Cape Town', state: 'WC' },
    SE: { zip: '111 22', addr1: 'Drottninggatan 1', city: 'Stockholm', state: '' },
    DK: { zip: '1050', addr1: 'Strøget 1', city: 'Copenhagen', state: '' },
    NO: { zip: '0150', addr1: 'Karl Johans gate 1', city: 'Oslo', state: '' },
    DE: { zip: '10115', addr1: 'Pariser Platz 1', city: 'Berlin', state: '' },
    FR: { zip: '75001', addr1: '1 Rue de Rivoli', city: 'Paris', state: '' },
    IE: { zip: 'D02 XY45', addr1: '1 St Stephens Green', city: 'Dublin', state: '' },
    NL: { zip: '1012 JS', addr1: 'Dam 1', city: 'Amsterdam', state: '' },
    BE: { zip: '1000', addr1: 'Grand Place 1', city: 'Brussels', state: '' },
    AT: { zip: '1010', addr1: 'Stephansplatz 1', city: 'Vienna', state: '' },
    IT: { zip: '00184', addr1: 'Piazza Venezia 1', city: 'Roma', state: 'RM' },
    ES: { zip: '28013', addr1: 'Puerta del Sol 1', city: 'Madrid', state: '' },
    PT: { zip: '1100-148', addr1: 'Praça do Comércio 1', city: 'Lisboa', state: '' },
    PL: { zip: '00-001', addr1: 'ul. Marszałkowska 1', city: 'Warszawa', state: '' },
    CZ: { zip: '110 00', addr1: 'Václavské náměstí 1', city: 'Praha', state: '' },
    HU: { zip: '1051', addr1: 'Bajcsy-Zsilinszky út 1', city: 'Budapest', state: '' },
    RO: { zip: '010011', addr1: 'Strada Lipscani 1', city: 'București', state: '' },
    BG: { zip: '1000', addr1: 'ul. Tsar Osvoboditel 1', city: 'Sofia', state: '' },
    HR: { zip: '10000', addr1: 'Trg bana Jelačića 1', city: 'Zagreb', state: '' },
    GR: { zip: '105 57', addr1: 'Syntagma Square 1', city: 'Athens', state: '' },
    SK: { zip: '811 01', addr1: 'Hlavné námestie 1', city: 'Bratislava', state: '' },
    SI: { zip: '1000', addr1: 'Prešernov trg 1', city: 'Ljubljana', state: '' },
    EE: { zip: '10111', addr1: 'Viru väljak 1', city: 'Tallinn', state: '' },
    LV: { zip: 'LV-1010', addr1: 'Brīvības iela 1', city: 'Rīga', state: '' },
    LT: { zip: '01103', addr1: 'Gedimino pr. 1', city: 'Vilnius', state: '' },
    FI: { zip: '00100', addr1: 'Mannerheimintie 1', city: 'Helsinki', state: '' },
    LU: { zip: 'L-2226', addr1: 'Place de la Gare 1', city: 'Luxembourg', state: '' },
    MT: { zip: 'VLT 1111', addr1: 'Republic Street 1', city: 'Valletta', state: '' },
    CY: { zip: '1011', addr1: 'Ledra Street 1', city: 'Nicosia', state: '' },
  };
  const row = table[c] || { zip: '1000', addr1: '1 Test Street', city: 'Test City', state: '' };
  return {
    countryCode: c,
    zip: row.zip,
    addr1: row.addr1,
    city: row.city,
    state: row.state || undefined,
  };
}

function readStripeHostedPricingSnapshot(page) {
  return page
    .evaluate(() => {
      const payBtn = document.querySelector('[data-testid="hosted-payment-submit-button"]');
      const order = document.querySelector('[class*="OrderSummary"], [data-testid="order-summary"]');
      const main = document.querySelector('main');
      const text = (main && main.innerText) || document.body.innerText || '';
      return {
        payButtonText: payBtn ? payBtn.textContent.trim().slice(0, 500) : '',
        orderSummary: order ? order.innerText.trim().slice(0, 1500) : '',
        bodySnippet: text.slice(0, 3500),
      };
    })
    .catch(() => ({ payButtonText: '', orderSummary: '', bodySnippet: '' }));
}

/**
 * Visible billing / contact fields on hosted checkout (varies by country) — for matrix metadata + dashboard.
 */
async function readStripeCheckoutBillingFieldsMeta(page) {
  return page
    .evaluate(() => {
      const root =
        document.querySelector('[data-testid="payment-element"]') ||
        document.querySelector('form') ||
        document.body;
      const sel = 'input:not([type="hidden"]):not([type="submit"]), select, textarea';
      const els = Array.from(root.querySelectorAll(sel)).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return els.slice(0, 48).map((el) => {
        const name = el.getAttribute('name') || '';
        const id = el.id || '';
        const ph = el.getAttribute('placeholder') || '';
        const ac = el.getAttribute('autocomplete') || '';
        let lab = el.getAttribute('aria-label') || '';
        if (!lab && id) {
          try {
            const safeFor = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const l = root.querySelector('label[for="' + safeFor + '"]');
            if (l) lab = (l.textContent || '').trim().slice(0, 120);
          } catch (e) {
            /* ignore */
          }
        }
        return {
          tag: el.tagName,
          type: el.type || el.tagName,
          name: name.slice(0, 80),
          id: id.slice(0, 80),
          placeholder: ph.slice(0, 80),
          autocomplete: ac.slice(0, 40),
          label: lab.slice(0, 120),
        };
      });
    })
    .catch(() => []);
}

/** User-facing label for Pay column — avoids raw Stripe "Processing" when we intentionally skip payment. */
function friendlyPayButtonLabel(raw, completePurchase, purchaseSucceeded, purchaseError) {
  if (purchaseSucceeded) return 'Purchase successful';
  if (purchaseError) return `Purchase error: ${purchaseError}`;
  if (completePurchase && !purchaseSucceeded) return 'Purchase did not finish (timeout or blocked)';
  if (!raw || !String(raw).trim()) return 'Checkout left before payment (preview)';
  const r = String(raw).trim();
  if (/processing|subscribe\s*processing|please\s*wait/i.test(r)) {
    return 'Checkout left before payment completed (preview)';
  }
  return r;
}

function inferObservedCurrencyLine(snapshot) {
  const blob = `${snapshot.payButtonText}\n${snapshot.orderSummary}\n${snapshot.bodySnippet}`;
  const m =
    blob.match(
      /(?:US\$|CA\$|A\$|NZ\$|S\$|HK\$|£|€|¥|₣|₹|CHF|AUD|CAD|NZD|SGD|HKD|JPY|GBP|EUR|USD|ZAR|SEK|DKK|NOK|PLN|CZK|HUF|RON|BGN)[\s\d.,()]+/i
    ) || blob.match(/[\d.,]+\s*(?:USD|EUR|GBP|AUD|CAD|NZD|SGD|HKD|JPY|CHF|ZAR|SEK|DKK|NOK|PLN|CZK|HUF|RON|BGN)/i);
  return m ? m[0].trim().slice(0, 120) : blob.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function currencyExpectationMatch(observedText, expectedCode) {
  if (!expectedCode) return { ok: null, note: 'no expected code' };
  const o = (observedText || '').toUpperCase();
  const e = expectedCode.toUpperCase();
  const symbols = { USD: ['$', 'USD'], EUR: ['€', 'EUR'], GBP: ['£', 'GBP'], CAD: ['CAD', 'CA$', 'C$'], AUD: ['AUD', 'A$'], NZD: ['NZD', 'NZ$'], SGD: ['SGD', 'S$'], HKD: ['HKD', 'HK$'], JPY: ['JPY', '¥'], CHF: ['CHF'], ZAR: ['ZAR'], SEK: ['SEK'], DKK: ['DKK'], NOK: ['NOK'], PLN: ['PLN'], CZK: ['CZK'], HUF: ['HUF'], RON: ['RON'], BGN: ['BGN'] };
  const keys = symbols[e] || [e];
  const ok = keys.some((k) => o.includes(k));
  return { ok, note: ok ? 'match' : `expected ${e} in observed line` };
}

/**
 * @param {import('playwright').Page} page
 * @param {object} ctx
 * @param {'1-Year'|'3-Year'} ctx.plan
 * @param {string} ctx.manageSubsUrl
 * @param {string} ctx.outDir
 * @param {string} ctx.slug
 * @param {string} ctx.iso2
 * @param {string} ctx.label
 */
async function runOneCountryPreview(page, ctx) {
  const plan = ctx.plan === '3-Year' ? '3-Year' : '1-Year';
  const slug = ctx.slug || `${ctx.iso2}-${plan.replace(/\s/g, '')}`;
  const base = ctx.outDir;
  fs.mkdirSync(base, { recursive: true });
  const completePurchase = !!ctx.completePurchase;

  const shotBefore = path.join(base, `${slug}-01-before.png`);
  const shotAfter = path.join(base, `${slug}-02-filled.png`);
  const shotSuccess = path.join(base, `${slug}-03-after-purchase.png`);

  const navResult = await navigateInsightToHostedStripeCheckout(page, {
    plan,
    qty: ctx.qty != null ? Number(ctx.qty) : 1,
    skipManageSubsGoto: !!ctx.skipManageSubsGoto,
    manageSubsUrl: ctx.manageSubsUrl,
    navigationTimeoutMs: ctx.navigationTimeoutMs ?? 120000,
    stripeSettleMs: ctx.stripeSettleMsBeforeShot != null ? ctx.stripeSettleMsBeforeShot : 1500,
  });

  const snap0 = await readStripeHostedPricingSnapshot(page);
  await page.screenshot({ path: shotBefore, fullPage: true });

  let addr;
  if (ctx.address && typeof ctx.address === 'object') {
    const base = previewAddressFor(ctx.iso2);
    addr = {
      ...base,
      ...ctx.address,
      countryCode: ctx.address.countryCode || base.countryCode,
    };
  } else {
    addr = previewAddressFor(ctx.iso2);
  }

  const billingMetaBefore = await readStripeCheckoutBillingFieldsMeta(page);

  const qtyVal = ctx.qty != null ? Number(ctx.qty) : 1;
  await setHostedStripeQuantityBeforeBilling(page, qtyVal);

  await fillStripeBillingAdaptive(
    page,
    {
      previewMode: !completePurchase,
      address: addr,
      /** Always expand manual address for preview so lines match selected ISO (not only US/CA “full”). */
      fillFullAddress: true,
      companyName: addr.company,
      stripeFillVisibleBillingOnly: true,
    },
    ctx.card || DEFAULT_CARD,
    'Stripe Preview'
  );

  await page.waitForTimeout(800);
  const billingMetaAfter = await readStripeCheckoutBillingFieldsMeta(page);
  try {
    fs.writeFileSync(
      path.join(base, `${slug}-billing-fields.json`),
      JSON.stringify(
        {
          iso2: String(ctx.iso2).toUpperCase(),
          completePurchase,
          fieldsAfterFill: billingMetaAfter,
          fieldsBeforeFillSample: billingMetaBefore.slice(0, 8),
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (e) {
    /* ignore */
  }

  const snap1 = await readStripeHostedPricingSnapshot(page);
  await page.screenshot({ path: shotAfter, fullPage: true });

  let purchaseSucceeded = false;
  let purchaseError = null;
  let needsInteractivePurchase = false;
  let checkoutUrlForInteractive = navResult.stripeCheckoutUrl;
  if (completePurchase) {
    try {
      const sub = await submitStripeHostedCheckout(page, {
        maxWaitMs: ctx.purchaseMaxWaitMs ?? 360000,
        hostedLandAt: navResult.hostedLandAt,
      });
      if (sub.success) {
        purchaseSucceeded = true;
      } else {
        purchaseError = sub.error || 'Purchase did not complete';
        needsInteractivePurchase = !!sub.needsInteractivePurchase;
        checkoutUrlForInteractive = sub.checkoutUrl || page.url();
      }
      await page.waitForTimeout(2000);
      await page.screenshot({ path: shotSuccess, fullPage: true }).catch(() => {});
    } catch (e) {
      purchaseError = e.message || String(e);
      await page.screenshot({ path: shotSuccess, fullPage: true }).catch(() => {});
    }
  }

  const observed = inferObservedCurrencyLine(snap1);
  const expected =
    (ctx.expectedCurrency && String(ctx.expectedCurrency)) ||
    EXPECTED_CURRENCY_BY_ISO2[String(ctx.iso2).toUpperCase()] ||
    null;
  let match = currencyExpectationMatch(`${snap1.payButtonText} ${observed}`, expected);
  if (String(ctx.iso2).toUpperCase() === 'GB' && match.ok === false) {
    match = {
      ...match,
      note:
        'UK checkout may still show EUR until the portal switches to GBP. ' + (match.note || ''),
    };
  }

  const payButtonRaw = snap1.payButtonText;
  let payButtonDisplay = friendlyPayButtonLabel(
    payButtonRaw,
    completePurchase,
    purchaseSucceeded,
    purchaseError
  );
  if (needsInteractivePurchase && completePurchase) {
    payButtonDisplay =
      'Needs Playwright MCP — Pay disabled or redirect timeout (see INTERACTIVE-PURCHASE-MCP.md in run folder)';
  }

  return {
    countryLabel: ctx.label,
    iso2: String(ctx.iso2).toUpperCase(),
    plan,
    expectedCurrency: expected,
    observedPricing: observed,
    payButtonAfter: payButtonDisplay,
    payButtonRaw,
    completePurchase,
    purchaseSucceeded,
    purchaseError: purchaseError || undefined,
    needsInteractivePurchase,
    checkoutUrlForInteractive,
    billingFieldsMeta: billingMetaAfter,
    validation: match,
    screenshots: {
      before: shotBefore,
      after: shotAfter,
      afterPurchase: purchaseSucceeded || purchaseError ? shotSuccess : undefined,
    },
  };
}

function resolveMatrixSubset(isoList) {
  if (!isoList || !isoList.length) return [...PREVIEW_COUNTRY_MATRIX];
  const set = new Set(isoList.map((x) => String(x).toUpperCase()));
  return PREVIEW_COUNTRY_MATRIX.filter((r) => set.has(r.iso2));
}

/**
 * @param {string} raw — `ISO2` or `ISO2|1-Year` / `ISO2|3-Year`
 * @returns {{ iso2: string, plan: '1-Year'|'3-Year'|null }|null}
 */
function parseCountryPlanToken(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const pipe = t.indexOf('|');
  if (pipe === -1) {
    return { iso2: t.toUpperCase(), plan: null };
  }
  const iso = t.slice(0, pipe).trim().toUpperCase();
  const pl = t.slice(pipe + 1).trim();
  const plan = pl === '3-Year' ? '3-Year' : '1-Year';
  return { iso2: iso, plan };
}

/**
 * @param {string[]} isoList — order preserved; entries may be `ISO2` or `ISO2|plan`
 * @param {'1-Year'|'3-Year'} defaultPlan — when ISO not in INTL_E2E_SCENARIOS and no plan in token
 */
function resolveIntlScenarioRows(isoList, defaultPlan) {
  const dp = defaultPlan === '3-Year' ? '3-Year' : '1-Year';
  const byIso = new Map(INTL_E2E_SCENARIOS.map((s) => [s.iso2, s]));
  const rows = [];
  for (const raw of isoList || []) {
    const parsed = parseCountryPlanToken(raw);
    if (!parsed) continue;
    const c = parsed.iso2;
    const planOverride = parsed.plan;
    const s = byIso.get(c);
    if (s) {
      const plan = planOverride || (s.plan === '3-Year' ? '3-Year' : '1-Year');
      rows.push({
        label: s.label,
        iso2: s.iso2,
        plan,
        expectedCurrency: s.expectedCurrency,
        address: { ...s.address },
      });
      continue;
    }
    const m = PREVIEW_COUNTRY_MATRIX.find((r) => r.iso2 === c);
    if (m) {
      const plan = planOverride || dp;
      rows.push({
        label: m.label,
        iso2: m.iso2,
        plan,
        expectedCurrency: EXPECTED_CURRENCY_BY_ISO2[c] || null,
        address: null,
      });
    }
  }
  return rows;
}

/**
 * Generic matrix rows (no intl scenario addresses) — supports `ISO2|plan` tokens.
 * @param {string[]} tokens
 * @param {'1-Year'|'3-Year'} defaultPlan
 */
function resolveGenericMatrixRows(tokens, defaultPlan) {
  const dp = defaultPlan === '3-Year' ? '3-Year' : '1-Year';
  const rows = [];
  for (const raw of tokens || []) {
    const parsed = parseCountryPlanToken(raw);
    if (!parsed) continue;
    const m = PREVIEW_COUNTRY_MATRIX.find((r) => r.iso2 === parsed.iso2);
    if (!m) continue;
    const plan = parsed.plan || dp;
    rows.push({
      label: m.label,
      iso2: m.iso2,
      plan,
      expectedCurrency: EXPECTED_CURRENCY_BY_ISO2[m.iso2] || null,
      address: null,
    });
  }
  return rows;
}

/**
 * @param {{ all?: boolean, countries?: string[], plan?: string, useScenarioSpec?: boolean }} body
 * @returns {Array<{ label: string, iso2: string, plan: string, expectedCurrency: string|null, address: object|null }>}
 */
function resolvePreviewSubset(body) {
  const b = body || {};
  const all = b.all === true || b.all === 'true';
  const useScenario = b.useScenarioSpec !== false && b.useScenarioSpec !== 'false';
  const defaultPlan = b.plan === '3-Year' ? '3-Year' : '1-Year';
  const countries = Array.isArray(b.countries) ? b.countries.map((c) => String(c).trim()) : [];

  if (all) {
    return PREVIEW_COUNTRY_MATRIX.map((m) => ({
      label: m.label,
      iso2: m.iso2,
      plan: defaultPlan,
      expectedCurrency: EXPECTED_CURRENCY_BY_ISO2[m.iso2] || null,
      address: null,
    }));
  }
  if (countries.length) {
    if (useScenario) {
      return resolveIntlScenarioRows(countries, defaultPlan);
    }
    return resolveGenericMatrixRows(countries, defaultPlan);
  }
  return resolveIntlScenarioRows(
    INTL_E2E_SCENARIOS.map((s) => s.iso2),
    defaultPlan
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {object} opt
 * @param {'1-Year'|'3-Year'} opt.plan
 * @param {Array<{label:string,iso2:string}>} opt.subset
 * @param {string} opt.manageSubsUrl
 * @param {string} opt.outDir
 * @param {function} [opt.onProgress]
 * @param {function} [opt.onRowComplete] — (row, index, total) after each country
 */
async function executeStripePreviewMatrix(page, opt) {
  const plan = opt.plan === '3-Year' ? '3-Year' : '1-Year';
  const subset = opt.subset || [];
  const manageSubsUrl = opt.manageSubsUrl;
  const outDir = opt.outDir;
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  const completePurchase = !!opt.completePurchase;
  const purchaseMaxWaitMs = opt.purchaseMaxWaitMs;
  for (let i = 0; i < subset.length; i++) {
    const rowMeta = subset[i];
    if (opt.onProgress) opt.onProgress(i, rowMeta);
    const slug = `${rowMeta.iso2}-${i}`;
    const rowPlan = rowMeta.plan || plan;
    const row = await runOneCountryPreview(page, {
      plan: rowPlan,
      manageSubsUrl,
      outDir,
      slug,
      iso2: rowMeta.iso2,
      label: rowMeta.label,
      skipManageSubsGoto: false,
      qty: opt.qty != null ? opt.qty : 1,
      completePurchase,
      purchaseMaxWaitMs,
      address: rowMeta.address || undefined,
      expectedCurrency: rowMeta.expectedCurrency,
      fillFullAddress: !!rowMeta.address,
      card: opt.card || undefined,
    });
    rows.push(row);
    if (opt.onRowComplete) opt.onRowComplete(row, i, subset.length);
    if (i < subset.length - 1) {
      await page.goto(manageSubsUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForTimeout(2000);
    }
  }
  return { rows, outDir };
}

module.exports = {
  PREVIEW_COUNTRY_MATRIX,
  INTL_E2E_SCENARIOS,
  EXPECTED_CURRENCY_BY_ISO2,
  runOneCountryPreview,
  parseCountryPlanToken,
  resolveMatrixSubset,
  resolveIntlScenarioRows,
  resolveGenericMatrixRows,
  resolvePreviewSubset,
  previewAddressFor,
  readStripeHostedPricingSnapshot,
  readStripeCheckoutBillingFieldsMeta,
  friendlyPayButtonLabel,
  executeStripePreviewMatrix,
};
