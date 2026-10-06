Status: SUPERSEDED BY PHASE 2 — the authenticated dashboard survey was completed 2026-10-06; its artifacts live in `phase2/` (README, dashboard-shell, payments, hosted-checkout, dashboard-pages-survey). This file remains as the Phase-1 record of what public docs established and what the survey was planned to cover. NOTHING in this file is claimed from an authenticated session.

# Stripe Dashboard pages — Phase-2 placeholder (gated)

## What IS known from public docs (honest, sourced)

The authenticated Stripe Dashboard itself was never accessed in Phase 1 — no credentials existed to access it with, and none were sought. What is known comes exclusively from public documentation and marketing pages that describe or advertise dashboard surfaces, all catalogued in the Phase-1 files of this set. These descriptions are docs-claims and marketing-claims about the product, not observations of rendered authenticated pages; several were accompanied by static mockups in marketing markup, which are themselves staged content rather than live data.

Publicly documented dashboard surfaces include:

- **Dashboard overview and mobile docs** — docs.stripe.com/dashboard describes the conceptual model and first sidebar sections (Home with customizable analytics widgets and important notifications, Balances, Transactions, Customers, Product catalog, Shortcuts incl. pinned pages); docs.stripe.com/dashboard/mobile documents the mobile app (live-only, bottom tabs + global + FAB — see `settings.md`, `responsive.md`).
- **Dashboard search** — fully documented publicly: cross-resource fuzzy search, `field:term` filter vocabulary, grouped drill-down, URL-shareable state (`search.md`).
- **Workbench replaces the Developers Dashboard** — event destinations, API version upgrades, integration health, and request logs of every successful/failed request (filterable by endpoint or error type) live there (`developers.md`, `settings.md`).
- **Sandbox management in the Dashboard** — sandbox creation with copyable test credentials, access control via overflow menu, test-data deletion behind a review dialog (`settings.md`).
- **Event deliveries surface** — per-endpoint Delivered/Pending/Failed status with per-attempt HTTP codes (`developers.md`).
- **Connect operational dashboards** — marketing pages advertise "Accounts to review" queues, top-grossing lists, Tasks with due dates, and connected-user payments/payouts dashboards with standard vs instant timing (`connect.md`).
- **Dispute management in the Dashboard** — docs describe Dashboard-guided dispute response with structured evidence packets ("text and images for the dispute reason, and your counterargument") and the Disputes API as the programmatic equivalent (`risk.md`).
- **Checkout studio** — marketed as the Configure/Monitor/Optimize home for checkout, i.e. advertised dashboard-side reporting/monitoring tooling (`payments.md`).
- **Prior survey context** — the W3-001 curl survey (`spec/research/STRIPE-UX-SURVEY-2026-09-30.md`) reached only the public login page; it contains no authenticated content either.

## What Phase 2 will survey

The work-order section list, each to be surveyed with the full Directive B §4 checklist (page, purpose, primary user, primary task, navigation entry, information hierarchy, primary CTA, secondary actions, search behavior, filtering, sorting, forms, states, notifications, eligibility, responsive hints, object relationships, cross-sell):

| Section | Survey focus (working hypotheses to verify, not claims) |
|---|---|
| Home | Widget composition, customization, notifications triage, role adaptation |
| Payments | List/detail object surface, status vocabulary, filters, saved views |
| Balances | Segmented balance presentation, pending→available communication |
| Customers | Object hub, Actions menu, create/edit flows vs docs claims |
| Products | Catalog management, mode-locking of objects |
| Billing | Invoices/subscriptions surfaces, recovery states |
| Reports | Task routing, config UX, Sigma embedding |
| Connect | Accounts-to-review queues, connected-account detail, payout dashboards |
| Apps | Installed-apps management, viewports vs full-page apps in situ |
| Settings | Three-category organization, team/roles, sensitive-action step-up auth |
| Developers | Workbench surfaces: keys, logs, versions, sandboxes |
| Webhooks | Event-destination wizard, Event deliveries tab, secret rolling UX |
| API keys | One-time reveal, rotation grace, access policies, agent-tagged keys |
| Test/Live mode | Account picker, banner + field disabling, sandbox isolation in practice |
| Payouts | Status enum incl. the documented paid→failed regression, failure recovery flow |
| Risk | Radar review queues, risk-score presentation, rules surfaces |
| Disputes | Evidence-packet UI, reason-code categories, Smart Disputes |

## Explicit statement

No authenticated dashboard content is reconstructed here from memory, screenshots, or third-party descriptions — everything above that is not already sourced to a public page awaits the real operator-assisted window. Until that window opens, this file deliberately contains zero claims about rendered authenticated pages, and Phase-1 files' "not observable" hedges stand as the honest record.

## Cross-references

Related files in this set: `README.md` (set index and Phase-2 gate), `settings.md`, `developers.md`, `search.md`, `balances.md`, `connect.md`, `risk.md`, `reports.md`, `responsive.md` (the public-docs sources for the bullets above), `pay-swap-ux-mapping.md` (Phase-1-only derivations this file will later validate against reality).
