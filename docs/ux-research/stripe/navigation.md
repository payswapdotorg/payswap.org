Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages via automated extraction, no authentication

# Stripe global navigation and information architecture

Sources: R1 survey (global nav observed identically across all 9 product pages) plus notes-home.md. Product-design logic only — IA and interaction patterns, not visual design.

## Top-bar navigation (verbatim labels)

**Products · Solutions · Developers · Resources · Pricing · Guide me · Sign in · Start now · Contact sales**

- **Guide me** (→ `/personalize`) — a persistent recommendation wizard inside the top nav.
- **Sign in** (→ `dashboard.stripe.com/login`); markup also carries a "Dashboard" link variant for logged-in users.
- **Start now** (→ `dashboard.stripe.com/register`) — the single persistent signup CTA button.
- **Contact sales** (→ `/contact/sales`) — persistent secondary conversion path on every page.

## Products mega-menu — five groups

Each item is name + one-line descriptor (capability-first labeling):

- **Payments:** Payments (Online payments) · Managed Payments (Merchant of record solution) · Payment links (No-code payments) · Checkout (Prebuilt payment UIs) · Elements (Flexible UI components) · Payment methods (Access to 125+) · Terminal (In-person payments) · Authorization Boost (Acceptance optimizations) · Link (Accelerated checkout) · Financial Connections (Linked financial account data)
- **Revenue:** Billing (Recurring revenue) · Metronome (Usage-based billing) · Subscriptions (Subscription management) · Invoicing (One-time or recurring) · Tax (Sales tax & VAT automation) · Revenue Recognition (Accounting automation) · Stripe Sigma (Custom reports) · Data Pipeline (Data sync)
- **Money management:** Treasury (Business finances) · Global Payouts (Payouts to third parties) · Capital (Business financing) · Crypto (Wallet, stablecoin issuing, and card infrastructure) · Crypto Onramp (Embeddable crypto purchases)
- **Platforms and marketplaces:** Connect (Payments for platforms) · Capital for platforms (Customer financing) · Treasury for platforms (Embedded financial services) · Issuing (Physical and virtual cards)
- **More:** Product roadmap · Radar (Fraud prevention) · Atlas (Startup incorporation) · Climate (Carbon removal) · Identity (Online identity verification)

Cross-drawer constants: a "Not sure where to start? Get recommendations" block inside every Products drawer; a Sessions 2026 promo; a sales-chat widget with live-rep-count social proof ("8 sales reps available").

## Solutions mega-menu — three-axis taxonomy

The same catalog re-cut by audience instead of capability:

- **By stage:** Enterprises · Startups
- **By use case:** Agentic commerce, Crypto, Ecommerce, Embedded finance, Finance automation, Global businesses, In-app payments, Marketplaces, Money management, Platforms, SaaS
- **By industry:** AI companies, Creator economy, Fintech, Gaming, Hospitality/travel/leisure, Insurance, Media and entertainment, Nonprofits, Professional services, Public sector, Retail
- **Ecosystem:** Partners, App Marketplace

Design logic: product capability × customer stage × use-case/industry — three orthogonal routes into one catalog, with product pages as the leaves and Solutions pages as audience re-cuts.

## Developers mega-menu

Documentation (Stripe docs, API reference, Libraries and SDKs, Stripe Apps) · Guides — task-shaped, e.g. "Accept online payments", "Implement a prebuilt checkout", "Build a platform or marketplace", "Manage subscriptions", "Offer usage-based billing", "Issue stablecoin-backed cards", "Provision and manage services with agents" · Resources (App integrations, Code samples, Developer blog, API status) · Learn (Blog, Customer stories, Guides). Guides are organized by job-to-be-done, not by API resource.

## Footer

Seven-column mega-footer, identical on every page: Products & pricing (full catalog) · Solutions · Integrations & custom solutions · Developers · Resources · Company/Support · Privacy & terms — plus the locale picker and Sign in. The footer is a full-catalog cross-sell surface in itself.

## Product-local sticky sub-navs (hub products only)

- `/payments`: Overview | Features | Payment methods | Authentication | Disputes | AI | Docs
- `/billing`: Overview | Usage-based billing | Subscriptions | Invoicing | Pricing | Docs — notable: the "Usage-based billing" item links off-site to metronome.com/pricing (an acquired product keeping a separate domain stays in the nav).
- Leaf product pages (checkout, payment-links, terminal, invoicing) carry no sub-nav. Hubs get wayfinding; leaves stay linear.

Anchored mega-sections complement this: `/payments` uses in-page anchor tabs (Online/Global/In-person/Intelligence/Unified platform); `/pricing` uses a sticky "Navigate to" category rail mirroring the nav taxonomy.

## Docs-domain separation

docs.stripe.com is a separate first-class tree, not a subsection of the marketing site. Its top-level IA (per R2's docs-home survey) runs Get started / Payments / Revenue / Risk / Data / Money management / **Stablecoins** (first-class top-level) / Embedded finance / Developer resources / More / APIs & SDKs / Help — crypto appears both as a payment method under Payments and as the Stablecoins product suite. Every marketing page links a parallel docs page (1:1 marketing↔docs mirroring), and developer-oriented CTAs route to docs rather than signup. Docs are LLM-first: a "View as Markdown" affordance (append `.md`), "Ask about this page", and llms.txt. Full analysis in `developers.md`.

## No site search — Guide me instead

No search input exists anywhere on the marketing site. Discovery is via mega-menus plus the "Guide me" recommender (`/personalize`) and the home recommendation widget (company-URL or free-text input, 500-character limit with live counter, suggestion chips, AI-use consent microcopy). Guided discovery substitutes for search at the marketing stage; search as a mechanic belongs to the dashboard (Connect's dashboard mockup shows a Search affordance; R3 documented dashboard search mechanics — see `search.md`).

## Locale and country picker

"United States ( English )" picker with 40+ country/language variants via hreflang. Geo-personalized marketing observed; no hard geo-blocks observed in static content. The survey was served US/English throughout — regional variants were not compared.

## Not observable from static content

Runtime JS behaviors (menu animation, chat widget, configurators), real search or recommendation results, real form validation, and the cookie banner (not present in static HTML; likely injected post-consent). Interactive structures were inferred from markup (aria-expanded attributes, tab/accordion structure), never executed.

## PaySwap implications

- **Hub/leaf split for the command center:** PaySwap's command center is a hub deserving sticky wayfinding; connector and capability detail pages are leaves that stay linear.
- **Three-axis catalog:** capability (payments/settlement/connectors) × stage × use case lets merchants reach the same catalog from multiple mental models without page duplication.
- **Task-shaped guides:** for merchant-crypto integration, job-to-be-done guides ("accept a stablecoin payment") will outperform API-alphabetical trees.
- **Guide-me before search:** a recommender/capability quiz is a cheaper first investment than site-wide search at marketing scale; reserve search for the authenticated product.
- **Docs as a first-class parallel tree** with 1:1 product↔docs mirroring from day one, including machine-readable views.
- **Acquired/external capabilities** can stay in nav while linking off-site (Metronome precedent) — relevant if PaySwap federates external connectors.

## Cross-references

Related files in this set: `public-pages.md` (survey index), `payments.md`, `connect.md`, `billing.md`, `developers.md` (docs-IA deep dive), `search.md` (dashboard search), `crypto.md`, `pay-swap-ux-mapping.md`, `README.md`. Batch 1 files exist now; the remainder land with later batches.
