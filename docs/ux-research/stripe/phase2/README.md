Status: PHASE 2 (authenticated dashboard survey) — 2026-10-06 — conducted inside the operator-assisted authentication window under the P4-W1-003 protocol: the operator personally performed the Google/MFA authentication through the replay image; the researcher operated only the already-authorized session, never received credentials, and never touched authentication.

# Stripe UX research — Phase 2 index (authenticated dashboard survey)

## Purpose

Phase 1 (parent directory) reverse-engineered Stripe's product-design logic from **public surfaces**. Phase 2 surveys the **authenticated Stripe Dashboard** and the **Stripe-hosted payment page** — the surfaces PaySwap's own dashboards most directly compete with. Same discipline: product-design logic only (IA, interaction patterns, progressive disclosure, state design, workflows); no pixels, branding, code, or proprietary assets are copied.

## Method

- Conducted 2026-10-06 against a **test-mode sandbox account** (operator-created "PaySwap sandbox") via CDP-driven DOM extraction on the live, logged-in dashboard. Interactive flows (manual payment form, payment-link creation, product creation, hosted checkout payment) were exercised end-to-end with test instruments (test card 4242…, test email) to populate real object states.
- The account was **deliberately driven through its empty → populated lifecycle**: the empty-state anatomy of every list was captured before test data was created, then the same pages were re-captured with data. Error states were captured both organically (a genuinely failed test payment with decline reason) and through form-validation probing.
- Every observation is textual (DOM/a11y-tree extraction) plus screenshots for internal reference (not committed). Where a surface could not be exercised in the environment (the refund modal), the gap is stated explicitly and Phase-1 documentation remains the record.
- Environment honesty: the survey ran in a memory-constrained sandbox (4 GB, no swap) behind a VPN-proxied browser; several pages were captured after long settle delays. Nothing was inferred past what the DOM showed; truncation points are marked.

## Sanitization statement

No credentials, cookies, tokens, API keys, session material, or real customer data appear in this Phase-2 set. Test-mode key displays observed on the dashboard are described **by pattern only** (masked prefix + suffix ellipsis, never transcribed). All payment amounts, customer names/emails, and object IDs cited are test-mode artifacts created by this survey itself (e.g. `ux-survey@example.com`, "UX Survey Product", €25.00 test charges). Screenshots remain in the researcher's local workspace and are not committed. Account identifiers (acct_/pi_/pm_/plink_/ch_/gcus_) appear only where they were already test artifacts and serve as shape examples of the ID-surfacing pattern.

## File index (Phase 2)

| File | Contents (one line) |
|---|---|
| `README.md` | This index: purpose, method, sanitization, map |
| `dashboard-shell.md` | Global chrome: sandbox banner, sidebar taxonomy, topbar, setup guide, Home page anatomy |
| `payments.md` | Transactions list (empty + populated), create flows (manual payment form, payment link, product), payment-link detail, payment object detail |
| `hosted-checkout.md` | The buy.stripe.com hosted payment page + success screen + Adaptive Pricing disclosure |
| `dashboard-pages-survey.md` | Structured per-page captures: Customers, Balances, Payouts, Products, Billing/Invoices/Subscriptions, Reports, Radar, Disputes, Developers/API keys, Settings, Apps, Connect |

Reading order: `dashboard-shell.md` → `payments.md` → `hosted-checkout.md` → `dashboard-pages-survey.md` → the derived contracts in `spec/experience/contracts/` (§17 deliverables).

## Relation to the directive

Directive: `docs/STRIPE-UX-DIRECTIVE-2026-10-06.md` (§16: research artifact location — canonical `docs/ux-research/stripe/`; §17: research must become implementation contracts). The ten §17 contracts live in `spec/experience/contracts/` and cite this Phase-2 set as their primary evidence base, alongside Phase-1 files where public surfaces remain the best source (e.g. docs IA, marketing responsive behavior).
