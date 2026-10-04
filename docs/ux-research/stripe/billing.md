Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages via automated extraction, no authentication

# Stripe Billing — recurring revenue product-design notes

Source: R1 notes for `/billing`, with cross-batch notes flagged inline. Product-design logic only; all forms/dashboards below are marketing mockups (form count 0; real validation not observable from static content).

## Page facts

- URL: `https://stripe.com/billing` (200, no redirect). Nav entry: Products → Revenue group, first item.
- Purpose / primary user / task: hub for the Billing family (Subscriptions, Metronome usage-based, Invoicing); SaaS/AI product teams monetizing recurring or usage-based revenue; understand supported billing models plus recovery tooling, then start or talk to sales.
- Primary CTA: "Start now" → `dashboard.stripe.com/register/billing` (product-scoped); secondary: "Contact sales".

## Quote-to-revenue framing

Billing is framed as the full monetization pipeline — "One platform to price, meter, bill, invoice, and grow" — positioned as "an integrated billing platform for your full quote-to-revenue cycle" (350,000+ companies; $8.2B failed payments recovered in 2025; $14 recovered per $1 spent). Hero mockups rotate through the three artifacts of that cycle: a hosted pricing page (Starter/Professional "Best value"/Enterprise plan cards), a usage-based estimate card with explicit unit math ("10,000 × $0.0015/request = $15.00"), and an invoice + payment mock. An "opportunity" paragraph frames AI-era monetization (consumption, hybrid, tiers) before the pitch.

## Product-local sub-nav (hub pattern)

Sticky sub-nav: **Overview | Usage-based billing | Subscriptions | Invoicing | Pricing | Docs**. Notable: "Usage-based billing" links off-site to metronome.com/pricing — the acquired Metronome product ("Powered by Metronome, a Stripe product") keeps a separate domain yet stays inside the hub nav. The page itself covers the three pillars with an Explore CTA and dashboard mock each: Subscriptions ("New subscription" form mock with per-unit pricing and tax classification, plus a success toast), Usage-based billing (usage meter, $0.01 per 1,000 units), Invoicing (email + invoice detail + card/bank payment).

## Feature matrix and maturity labels

"Key Stripe Billing features and platform capabilities" is a five-column matrix — **Sell / Bill / Collect / Report** plus compliance chips — with "Powered by Metronome" as a sub-group (metering up to 100K events/sec). Pre-GA capabilities are labeled "Preview" (e.g. "Paid trials Preview", "Billing customizations Preview"); paid add-ons use an asterisk system ("*Features available at an additional cost"). Maturity and cost are disclosed in the matrix itself, not hidden in footnotes.

## Pricing-model tooling and market scaling

- "Launch new pricing/business models faster" is demonstrated with a rate-card editor mock: Pay as you go, USD, tax included, price type Fixed/Graduated/Volume, sell as individual units or packaged, $/unit — plus a plan picker (Free/Pro "Popular"). The pricing model itself is the configurable object.
- "Scale into new markets quickly": multi-currency checkout mock (Klarna/PayPal/Affirm/Alipay), 135+ currencies, 35+ languages, Adaptive Pricing with an "+18% LTV" claim. "Monetize with fewer resources" leans on customer-portal self-serve and a Forrester Leader claim.
- Data freshness is stated as a product property: "up-to-date data with under 1-hour freshness."

## Recovery and failure states as product proof

The recovery dashboard mock quantifies failure honestly: failed $32,195.80, failure rate 32%, recovered $18,206.15, recovery rate 44%, with an In recovery / Recovered / Not recovered breakdown. Tooling: Smart Retries, card account updater, cancellation surveys, dunning emails; claim: "recover 55% of failed payments on average". Churned-revenue charts split voluntary vs involuntary. Failure is treated as a first-class, instrumented surface.

## Cross-sell block

"Optimize every step of your revenue cycle with Stripe and Metronome" is the densest cross-sell section in the R1 survey besides the pricing page — each adjacent product gets a live UI mock: Optimized Checkout (whose method selector includes a **Crypto** option — crypto framed as a first-class collect method), Radar (rule performance table), Tax (city tax calc), Revenue Recognition (recognized revenue chart), Sigma (natural-language query), Data Pipeline (warehouse picker), Stripe Projects. A personalizer CTA ("Not sure where to start? Get personalized Stripe product recommendations") appears mid-page — a unique placement in the survey.

## FAQ accordions — the only native `<details>` usage

Seven `<details>/<summary>` FAQ accordions — the only page in the R1 survey using native HTML disclosure; every other page uses aria-expanded menus/tabs or static headings. FAQs cover what Billing is, no-code recurring setup (Dashboard), and pricing shapes.

## Case-study and trust patterns

"Trusted by industry leaders" uses customer-story cards (Atlassian, Intercom, Fox Sports) plus analyst badges (Forrester Wave Recurring Billing Q1 2025 Leader; Gartner Magic Quadrant Leader) with trademark disclaimers. In the wider R1 survey, story cards carry "Products used" tags, and the fixed Challenge/Solution/Impact case format appears on `/terminal` — two reusable credibility formats.

## Pricing presentation

No headline numbers on this page. Two plan shapes are described: "annual subscription paid monthly" vs "pay-as-you-go (0.7% of Billing volume)" — the Pay-monthly | Pay-as-you-go pair with 30-day trials used across subscription products on `/pricing`. Detail lives on product-family pricing sub-pages (`/billing/pricing`, `/invoicing/pricing`) and Metronome's external page; footnotes state Metronome is not included in Billing pricing.

## Cross-batch notes

- R2: `docs.stripe.com/billing/subscriptions/stablecoins.md` exists but returned only a variant index — integration-variant bodies were not retrievable (honest gap; see `crypto.md`).
- R3: Billing test clocks support time-travel testing of subscription logic — one-line cross-reference; see `developers.md` for test-mode mechanics.

## PaySwap implications

- Model PaySwap's recurring/off-network packages as one billing hub with pillar sections (subscription vs usage vs invoice), each with its own Explore path — matching `packages/payment` recurring primitives without splitting pages.
- Instrument and surface failure/recovery states (failed, in recovery, recovered, involuntary churn) as dashboard-first proof, mirroring Stripe's recovery metrics.
- Use explicit maturity labels ("Preview") and asterisk cost markers in capability matrices — precedent for gating merchant-crypto capabilities pre-GA.
- Adopt the Pay-monthly vs pay-as-you-go plan pair with trial microcopy for any PaySwap subscription-priced surface.
- Include crypto/stablecoin as a first-class collect method in billing mockups and docs (Stripe does so even on non-crypto pages).

## Cross-references

Related files in this set: `public-pages.md` (survey index), `navigation.md` (hub sub-nav pattern), `payments.md`, `connect.md`, `crypto.md` (stablecoin subscriptions), `developers.md` (test clocks), `customers.md`, `reports.md`, `component-patterns.md`, `pay-swap-ux-mapping.md`, `README.md`.
