# Stripe subscription tests

Playwright specs targeting **Insight staging** + **Stripe** (hosted checkout, portal, plans, invoices, country matrix, etc.).

## Contents (overview)

| Pattern | Purpose |
|---------|---------|
| `demo-*.spec.ts`, `demo-e2e.spec.ts`, `demo-final.spec.ts` | Shorter demo / hackathon paths |
| `test-drop5-*.spec.ts` | Deeper coverage (portal, plans, invoices, countries, negatives, …) |
| `helpers.ts`, `email-helpers.ts` | Shared steps, mail providers, screenshots |

## Run

```bash
npx playwright test --config=playwright.stripe.config.ts
```

Filter by file or project name as defined in `playwright.stripe.config.ts`.

## Notes

- **Base URL** defaults in config; override with `BASE_URL` when needed.  
- Evidence (screenshots, traces) follows Playwright defaults under `test-results/` and `playwright-report/`.  
