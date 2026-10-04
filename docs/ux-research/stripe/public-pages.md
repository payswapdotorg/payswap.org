Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages via automated extraction, no authentication

# Stripe public-surface survey — master page index

## Purpose, method, sanitization

Survey index for Phase 1 of the Stripe UX research set: every public page covered by the three research batches (R1 core marketing surfaces, R2 crypto/stablecoin + risk + developer surfaces, R3 dashboard-adjacent public docs), with one-line takeaways and pointers to the per-topic files where detailed observations live.

- **Method.** Automated page reading of public pages only — no authentication, no cookies sent or recorded, no Stripe API calls. R2 additionally used the official docs Markdown view (appending `.md` to docs URLs) to recover tabbed content that server-rendered HTML omits. `dashboard.stripe.com` was never fetched; its public login/register URLs appear only as recorded link destinations inside marketing markup.
- **Subject matter.** Product-design logic only: information architecture, interaction patterns, progressive disclosure, state design. No visual design, branding, or code copying.
- **Sanitization.** All source notes were audited: no credentials, tokens, keys, session material, or customer data are recorded anywhere in this set. Test-mode key fixtures visible in Stripe's own published code samples were not transcribed. Quotes are short (<25 words) — factual labels and CTA text only.
- **Phase 2 placeholder.** The authenticated dashboard is deliberately out of scope for Phase 1. Phase 2 will study it under an operator-assisted authenticated window and produce separate documents; pages below marked "dashboard-adjacent" are public-docs descriptions, not dashboard observations.

## Master survey table

Role: marketing (stripe.com product/pricing pages) or docs (docs.stripe.com reference/guide pages). "Detailed notes" = the file in this set holding per-page analysis.

### R1 — core marketing surfaces (stripe.com)

| Surface | URL | Role | Key UX takeaway | Detailed notes |
|---|---|---|---|---|
| Home | `https://stripe.com/` | marketing | Top-of-funnel router; no site search — discovery via mega-menus plus "Guide me" recommender | navigation.md |
| Payments hub | `https://stripe.com/payments` | marketing | Flagship hub with sticky sub-nav; integration ladder; product-scoped signup URL | payments.md |
| Checkout | `https://stripe.com/payments/checkout` | marketing | Four deployment modes framed as choose-your-path; Checkout studio tooling | payments.md |
| Payment links | `https://stripe.com/payment-links` | marketing | No-code tier; interactive configurator demo before signup | payments.md |
| Payment links (canonical path) | `https://stripe.com/payments/payment-links` | marketing | Verification fetch: same page served at both paths, both 200 | payments.md |
| Connect | `https://stripe.com/connect` | marketing | Three-sided platform model; funds-flow pattern gallery; compliance-shift messaging | connect.md |
| Billing | `https://stripe.com/billing` | marketing | Quote-to-revenue hub; only surveyed page with native FAQ accordions | billing.md |
| Pricing | `https://stripe.com/pricing` | marketing | Standard-vs-Custom frame first, then full-catalog fee line items with caps/bundles | billing.md, navigation.md |
| Terminal | `https://stripe.com/terminal` | marketing | Leaf product (no sub-nav); hardware priced as SKUs; fixed Challenge/Solution/Impact case studies | navigation.md |
| Invoicing | `https://stripe.com/invoicing` | marketing | Four-step AR lifecycle with fully mocked paid state | billing.md |

### R2 — crypto/stablecoin, risk, developer surfaces

| Surface | URL | Role | Key UX takeaway | Detailed notes |
|---|---|---|---|---|
| Crypto umbrella | `https://stripe.com/crypto` | marketing | Crypto/stablecoin presented as a product family with fiat-settlement messaging | crypto.md |
| Stablecoins landing | `https://docs.stripe.com/stablecoins` | docs | Stablecoins is a first-class top-level docs section | crypto.md, developers.md |
| Assets/networks matrix | `https://docs.stripe.com/stablecoins/availability` | docs | Tabbed support matrix; only the default tab is server-rendered | crypto.md |
| Matrix, Markdown view | `https://docs.stripe.com/stablecoins/availability.md` | docs | `.md` view recovers all tab content — LLM-first docs design | crypto.md, developers.md |
| Key concepts | `https://docs.stripe.com/stablecoins/concepts` | docs | Glossary taxonomy for the stablecoin domain | crypto.md |
| Use cases | `https://docs.stripe.com/stablecoins/use-cases.md` | docs | Use-case routing table with Bridge/Privy escape hatches | crypto.md |
| Stablecoin payments index | `https://docs.stripe.com/stablecoins/payments.md` | docs | Category index page for stablecoin acceptance | crypto.md |
| Accept stablecoin payments | `https://docs.stripe.com/payments/accept-stablecoin-payments` | docs | Activation is request-then-review (Pending state); testnet testing documented | crypto.md |
| Payment-method properties | `https://docs.stripe.com/payments/stablecoin-payments.md` | docs | Fact sheet: tokens, networks, refunds, no disputes, per-transaction limit | crypto.md |
| Stablecoin subscriptions | `https://docs.stripe.com/billing/subscriptions/stablecoins.md` | docs | Variant index only — integration-variant bodies not retrievable (honest gap) | crypto.md, billing.md |
| Crypto onramp | `https://docs.stripe.com/crypto/onramp.md` | docs | Three integration surfaces; merchant-of-record liability framing | crypto.md |
| Connect stablecoin payouts | `https://docs.stripe.com/connect/stablecoin-payouts.md` | docs | Private preview; ~60 recipient countries; NY/HI excluded | crypto.md, connect.md |
| Treasury stablecoins | `https://docs.stripe.com/treasury/stablecoins.md` | docs | Explicit fund-flow diagram; two-way stablecoin/fiat balances | crypto.md |
| Global payouts, send money | `https://docs.stripe.com/global-payouts/send-money.md` | docs | OutboundPayments v2 (GA) plus PayoutIntents (preview) | crypto.md, balances.md |
| Stablecoin-backed cards | `https://docs.stripe.com/issuing/stablecoin-cards.md` | docs | Two integration paths (Stripe financial accounts vs Bridge/Privy wallets) | crypto.md |
| Privy ecosystem | `https://docs.stripe.com/stablecoins/ecosystem/privy.md` | docs | Wallet ecosystem: embedded wallets, policy-based authorization | crypto.md |
| Machine payments (MPP) | `https://docs.stripe.com/payments/machine/mpp.md` | docs | HTTP 402 challenge flow for agentic payments | crypto.md, developers.md |
| Radar | `https://stripe.com/radar` | marketing | Fraud framed as a full lifecycle: onboarding → payment → post-purchase | risk.md |
| Docs home | `https://docs.stripe.com` | docs | Docs IA tree mirrors the product taxonomy; task-shaped guides | developers.md, navigation.md |
| API reference | `https://docs.stripe.com/api` | docs | Idempotency, expand, cursor pagination, named monthly versions | developers.md |
| Security | `https://docs.stripe.com/security` | docs | Certifications-first, audience-layered trust narrative | risk.md |
| Disputes | `https://docs.stripe.com/disputes` | docs | Money-flow-first definition; respond/analyze/prevent strategy layers | risk.md |
| Stripe Apps | `https://docs.stripe.com/stripe-apps` | docs | Dashboard-extension app model with marketplace distribution | apps.md |
| App design patterns | `https://docs.stripe.com/stripe-apps/patterns.md` | docs | UX pattern library: layout, onboarding, user actions, status | apps.md, component-patterns.md |
| Empty-state pattern | `https://docs.stripe.com/stripe-apps/patterns/empty-state.md` | docs | Empty-state rules incl. filtered-empty vs no-data-empty distinction | component-patterns.md |
| Loading pattern | `https://docs.stripe.com/stripe-apps/patterns/loading.md` | docs | Scope-matched spinners; delay guidance; pending buttons | component-patterns.md |

### R3 — dashboard-adjacent public docs

| Surface | URL | Role | Key UX takeaway | Detailed notes |
|---|---|---|---|---|
| Dashboard overview | `https://docs.stripe.com/dashboard` | docs | Dashboard home conceptual model | dashboard-pages.md |
| Dashboard search | `https://docs.stripe.com/dashboard/search` | docs | Cross-resource fuzzy search; `field:term` filters; shareable search state | search.md |
| Dashboard mobile | `https://docs.stripe.com/dashboard/mobile` | docs | Mobile app is live-only; bottom tabs + global + FAB | responsive.md |
| Test mode | `https://docs.stripe.com/test-mode` | docs | Keys determine mode, not Dashboard location; sandbox isolation | settings.md, developers.md |
| API key management | `https://docs.stripe.com/keys` | docs | One-time live reveal; rotation grace periods; access policies | settings.md |
| Webhooks | `https://docs.stripe.com/webhooks` | docs | Event destinations; retry policy; secret rolling with grace | developers.md |
| Payouts | `https://docs.stripe.com/payouts` | docs | Payout state machine incl. documented paid→failed regression | balances.md |
| Workbench | `https://docs.stripe.com/workbench` | docs | Developer console surface | developers.md |
| Customers | `https://docs.stripe.com/billing/customer` | docs | Minimal-profile entity; single-key create; recipe patterns | customers.md |
| Account | `https://docs.stripe.com/get-started/account` | docs | Onboarding progression: create → sandbox-ready → verify → activate | onboarding.md |
| Account set-up | `https://docs.stripe.com/get-started/account/set-up` | docs | Progressive verification per service | onboarding.md |
| Account checklist | `https://docs.stripe.com/get-started/account/checklist` | docs | Browser-cached onboarding progress (no login needed) | onboarding.md |
| Teams | `https://docs.stripe.com/get-started/account/teams` | docs | Bulk invites; lowest-permission default; 10-day expiry | settings.md, onboarding.md |
| Go-live checklist | `https://docs.stripe.com/get-started/checklist/go-live` | docs | Go-live = swap keys; recreate objects with same IDs | onboarding.md |
| Balance object | `https://docs.stripe.com/api/balance/balance_object` | docs | available/pending arrays per currency × source type | balances.md |
| Payout object | `https://docs.stripe.com/api/payouts/object` | docs | Payout failure-code taxonomy | balances.md |
| How Sigma works | `https://docs.stripe.com/data/how-sigma-works` | docs | SQL plus natural-language assistant; template gallery | reports.md |
| Reports | `https://docs.stripe.com/reports` | docs | Task→report routing; bank-statement vs clearing-account mental models | reports.md |
| Select a report | `https://docs.stripe.com/reports/select-a-report` | docs | Report catalog browsing | reports.md |
| Report options | `https://docs.stripe.com/reports/options` | docs | Scheduled delivery; Connect scoping incl. subset drawer | reports.md |
| llms.txt | `https://docs.stripe.com/llms.txt` | docs | Machine-readable docs index — LLM-first surface | developers.md |
| Sigma (marketing) | `https://stripe.com/sigma` | marketing | Custom-reporting product page | reports.md |
| Balance (failed) | `https://docs.stripe.com/balance` | docs | Soft 404: HTTP 200 with "Page not found" body — recorded as failure | balances.md |

## Fetch-outcome summary (honest)

- **R1 — 10/10 OK, zero failures.** All marketing pages returned 200 with no redirects. Not observable from static content: runtime JS behaviors, real form validation, cookie banner (not present in static HTML).
- **R2 — ~30 fetch attempts** (26 page fetches, including `.md` re-fetches, plus 3 discovery web searches). Transient issues, all recovered: 1 JINA timeout on the availability page (retried OK) and rate limits on 4 URLs (one hit twice), each recovered via cooldown and retry. Standing gaps recorded by R2: billing/subscriptions/stablecoins returns only a variant index (integration-variant bodies not retrievable — the reader does not honor query parameters); docs tabs beyond the default are client-rendered and invisible in HTML (recovered via `.md` view); stablecoin fee/pricing numbers were not present on the surveyed pages; crypto.stripe.com and dashboard screens intentionally not visited (no-auth rule).
- **R3 — 26 fetches, 25 OK, 1 failure.** Failure: `docs.stripe.com/balance` returned a soft 404 (HTTP 200 with a "Page not found" body). The table above lists the URLs as enumerated in R3's summary; in-session retries were not separately itemized, so the enumeration may undercount the reported 25 successful fetches.

## Coverage notes

- All fetches were US/English locale; geo-personalized variants were not compared.
- Interactive behaviors were inferred from markup (aria-expanded counts, tab/accordion structures), never executed.
- Detailed per-topic analysis lives in the per-topic files, not here; this index is intentionally non-duplicative.

## Cross-references

Batch 1 (this drop): `navigation.md`, `payments.md`, `connect.md`, `billing.md`. Later batches complete the set: `README.md`, `crypto.md`, `risk.md`, `developers.md`, `settings.md`, `search.md`, `reports.md`, `customers.md`, `balances.md`, `apps.md`, `onboarding.md`, `responsive.md`, `component-patterns.md`, `workflow-patterns.md`, `pay-swap-ux-mapping.md`, `dashboard-pages.md`.
