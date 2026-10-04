Status: PHASE 1 COMPLETE (public surfaces) — 2026-10-03 (P4-W1-003) — Phase 2 (authenticated dashboard survey) PENDING, gated on the operator-assisted authentication window; this worker never logs in, never touches authentication, and receives no credentials.

# Stripe UX research set — Phase 1 index (public surfaces)

## Purpose

Stripe is PaySwap's primary operational UX benchmark (Directive: `docs/STRIPE-UX-DIRECTIVE-2026-10-02.md`, "Directive B"). This set reverse-engineers Stripe's **product-design logic** — information architecture, interaction patterns, progressive disclosure, state design, and end-to-end workflows — so PaySwap can adopt the reasoning behind the patterns. It is explicitly **not** a study of pixels, branding, visual design, code, or proprietary assets: nothing is copied, only described and then derived into PaySwap design contracts.

The set culminates in `pay-swap-ux-mapping.md`, where every important observed pattern is carried through the mandated derivation chain (observed Stripe pattern → user problem it solves → PaySwap equivalent → PaySwap-specific modification → implementation contract) and consolidated into a proposed PaySwap dashboard information architecture.

## Method

- **Public-surface survey only**, conducted 2026-10-03 via automated page reading of public marketing pages and public docs (including Stripe's official Markdown docs views, which recover tabbed content invisible in server-rendered HTML), plus web search for URL discovery. Three parallel research batches: R1 (core marketing surfaces), R2 (crypto/stablecoin + risk + developer surfaces), R3 (dashboard-adjacent public docs).
- **No authentication of any kind.** No logins, no account creation, no cookies sent or recorded, no Stripe API calls. `dashboard.stripe.com` was never fetched — its public login/register URLs appear only as recorded link destinations inside marketing markup. `crypto.stripe.com` was likewise not visited.
- **Honesty over coverage.** Fetch failures, rate limits, soft 404s, truncation points, and items not observable from static content are recorded where they occur; the consolidated fetch-outcome summary lives in `public-pages.md`. Nothing was inferred past a truncation point or reconstructed from memory.
- **Relation to the prior survey.** `spec/research/STRIPE-UX-SURVEY-2026-09-30.md` (work item W3-001) was a curl-based first pass that reached only public marketing pages and the login screen. This set is the deeper, Directive-B-structured successor: the same no-auth discipline, but organized into per-topic files with per-page checklists, cross-batch attribution, and derivation into PaySwap implementation contracts.

## Sanitization statement

No credentials, cookies, tokens, API keys, session material, or customer data appear anywhere in this set. Key and secret formats are described by prefix only — no example values, no full credential-shaped strings. Screenshots were not captured; visual surfaces are replaced by textual description. Quotes are short (<25 words), factual labels and CTA text only. Test-mode key fixtures visible in Stripe's own published code samples were not transcribed. Every batch in this set passed the mandated credential-pattern scan before landing (results recorded in `/home/z/my-project/worklog.md`).

## File index

All 21 files of the complete Phase-1 set (18 topic files plus this index, the Phase-2 placeholder, and the derivation file):

| File | Contents (one line) |
|---|---|
| `README.md` | This index: purpose, method, sanitization, file map, Phase-2 scope |
| `public-pages.md` | Master survey index: all R1/R2/R3 URLs with takeaways and honest fetch outcomes |
| `navigation.md` | Global nav taxonomy, mega-menus, docs-domain separation, no-site-search finding |
| `payments.md` | Payments hub, Checkout, Payment Links — the choose-your-path integration ladder |
| `connect.md` | Three-sided platform model, onboarding UX, operational review surfaces |
| `billing.md` | Quote-to-revenue hub, pricing-page grammar, recovery states as product proof |
| `crypto.md` | Stablecoin support matrix, settlement semantics, activation gating, honest gaps |
| `risk.md` | Radar lifecycle framing, dispute lifecycle, security-page layering |
| `developers.md` | Docs IA, API conventions, key UX, webhooks, sandboxes/test mode |
| `apps.md` | Stripe Apps model, component kit, pattern library, marketplace |
| `settings.md` | Account model, teams/roles, test/live separation, sensitive-action auth |
| `search.md` | Dashboard search mechanics and the SEARCH/COMMAND evolution (Directive B §8) |
| `customers.md` | Customer object model, Dashboard flows, lightweight-CRM framing |
| `balances.md` | Segmented balance model, payout status vocabulary, failure recovery |
| `reports.md` | Task-routed reports, 12h data SLA, Sigma with visible queries |
| `onboarding.md` | Onboarding progression, progressive KYC, cached checklists, go-live |
| `responsive.md` | Mobile live-only app, bottom tabs/FAB, push taxonomy, marketing responsive evidence |
| `component-patterns.md` | Cross-source pattern catalog: observed form → problem → PaySwap note |
| `workflow-patterns.md` | Eight end-to-end workflows in start→intent→steps→errors→recovery grammar |
| `pay-swap-ux-mapping.md` | Core derivation file: 14 pattern chains + PaySwap dashboard IA proposal |
| `dashboard-pages.md` | Phase-2 placeholder: what public docs establish, what the authenticated survey will cover |

Reading order for a newcomer: `public-pages.md` → any topic file → `component-patterns.md` + `workflow-patterns.md` → `pay-swap-ux-mapping.md` → `dashboard-pages.md`.

## Phase-2 scope (pending, gated)

Phase 2 will survey the **authenticated dashboard** — Home, Payments, Balances, Customers, Products, Billing, Reports, Connect, Apps, Settings, Developers, Webhooks, API keys, Test/Live mode, Payouts, Risk, Disputes — through the operator-controlled isolated browser under the P4-W1-003 protocol: the operator personally performs the Google/MFA authentication, and the worker operates only the already-authorized session, never receiving credentials and never touching authentication. Phase-2 output lands as new documents (or a revision of `dashboard-pages.md`) produced inside that window; until then, `dashboard-pages.md` records only what public documentation establishes, clearly separated from anything observed.

## Cross-references

Directive B (`docs/STRIPE-UX-DIRECTIVE-2026-10-02.md`); prior survey `spec/research/STRIPE-UX-SURVEY-2026-09-30.md`; capability map `spec/research/STRIPE-CAPABILITY-MAP-2026-09-30.md`. Within this set every file cross-references its siblings; `dashboard-pages.md` holds the Phase-2 gate.
