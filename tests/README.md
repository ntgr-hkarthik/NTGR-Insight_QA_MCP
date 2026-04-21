# Tests

**Playwright** end-to-end specs for this repository. The active tree is mostly under **`stripe-subs/`** (Stripe and subscription flows against Insight staging).

## Configuration

- **`playwright.stripe.config.ts`** — projects, workers, reporters (includes `dashboard/reporter.js` for live status).

## Run

```bash
npx playwright test --config=playwright.stripe.config.ts
```

Or use the **dashboard** at http://localhost:9324 to start runs from the UI (`node dashboard/server.js` first).

## See also

- **`stripe-subs/README.md`** — what each spec group covers  
- Root **`package.json`** — npm scripts for focused runs  
