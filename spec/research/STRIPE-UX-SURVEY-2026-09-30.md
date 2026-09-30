# Stripe UX Survey — 2026-09-30 (W3-001)

Status: RESEARCH SURVEY — 2026-09-30 (W3-001)

Method: `curl -s -L` (User-Agent "Mozilla/5.0", 20s timeout) of public Stripe marketing and documentation pages from this sandbox, followed by grep/sed/awk/python extraction of titles, headings, nav links, meta descriptions and visible text from the saved HTML. Zero authentication was performed and no credentials were used or recorded. Dashboard surfaces beyond the public login page are auth-walled and are recorded as: paused at authentication boundary — requires operator login. All fetches resolved through locale negotiation to the `en-hk` (Hong Kong) storefront, so fee figures quoted in HTML are HKD; IA evidence is locale-independent. Stripe pages are JS-heavy; anything not present in static HTML is marked "not extractable from static HTML" rather than guessed.

Relation to baseline: this survey executes the procedure defined in `spec/research/STRIPE-UX-PARITY-LAB.md` (BASELINE RESEARCH — 2026-09-30) for W3-001 and updates it with live-fetch evidence. The parity lab's "PaySwap adaptation targets" list (simple top-level IA, progressive disclosure, operational tables, money/status hierarchy, developer-first docs, agent permission visibility) is used as the evaluation lens. Product-catalogue claims in `spec/research/STRIPE-CAPABILITY-MAP-2026-09-30.md` (53 products incl. Agentic Commerce, stablecoin payments, mobile dashboard, sandboxes, Workbench) were spot-checked against fetched pages where possible.

## Source log

All fetches 2026-09-30, exit=0 (curl success) unless noted. "Effective URL" is the final URL after redirects.

| # | URL | Fetch outcome | Size (bytes) | Key evidence extracted |
|---|-----|--------------|--------------|------------------------|
| 1 | https://stripe.com/ | OK (redirect to locale) → https://stripe.com/en-hk, HTTP 200 | 722,443 | Hero H1 "Financial infrastructure to grow your revenue…"; global nav labels (Products/Solutions/Developers/Resources/Pricing/"Guide me"/"Sign in"/"Start now"→dashboard.stripe.com/register); bento product cards; 100+ internal links (/use-cases/*, /industries/*, /customers/*) |
| 2 | https://stripe.com/pricing | OK (redirect) → https://stripe.com/en-hk/pricing, 200 | 856,518 | "Standard pricing for all products" vs "Custom pricing"; "No setup fees, monthly fees, or hidden fees"; "3.4% + HK$2.35 per successful transaction for domestic cards"; per-product pricing sub-pages |
| 3 | https://stripe.com/payments | OK (redirect) → https://stripe.com/en-hk/payments, 200 | 1,210,391 | "125+ payment methods", "135+ currencies", "195+ countries"; sticky sub-nav sections; Payments Intelligence Suite; product links incl. /payments/dispute-management |
| 4 | https://stripe.com/billing | OK (redirect) → https://stripe.com/en-hk/billing, 200 | 867,020 | "One platform to price, meter, bill, invoice and grow"; Subscriptions / Usage-based billing / Invoicing tabs; quote-to-revenue framing |
| 5 | https://stripe.com/connect | OK (redirect) → https://stripe.com/en-hk/connect, 200 | 918,655 | Connect Onboarding ("Verify your business details" form graphic); KYC copy (sanctions screening, MATCH list checks, identity verifications); "Payments and payouts dashboards"; "Accounts to review" |
| 6 | https://stripe.com/docs | OK (redirect) → https://docs.stripe.com/, 200 | 1,331,894 | Full docs IA tree (~2,655 unique nav links): account model (teams/roles/organizations/SSO/SCIM/approvals), dashboard docs, disputes subtree, stripe-apps UX patterns, sandboxes, Workbench, llms.txt |
| 7 | https://stripe.com/docs/api | OK (redirect) → https://docs.stripe.com/api, 200 | 1,378,968 | "Just getting started?" / "Not a developer?" tracks; idempotency keys; auto-pagination; expand; /api/errors with error.code / decline_code / param; named dated API versions (Dahlia 2026-08-26 latest) |
| 8 | https://stripe.com/payment-links | OK (redirect) → https://stripe.com/en-hk/payments/payment-links, 200 | 642,599 | "Accept payments in minutes, without a line of code"; no-code vs API paths; "Try it out" interactive demo section |
| 9 | https://stripe.com/stablecoin | 404 (no redirect; served "Page not found" template, data-page-id="Not found") | 370,272 | 404 page shell only. Docs nav references `/stablecoins` (plural) — stablecoin content lives under docs, not this marketing URL |
| 10 | https://stripe.com/agentic-commerce | 404 (no redirect; "Page not found") | 370,272 | 404 page shell only. Home page links agentic commerce at `/use-cases/agentic-commerce` (see supplementary fetch #15) |
| 11 | https://stripe.com/trust-security | 404 (no redirect; "Page not found") | 370,272 | 404 page shell only. Fallback https://stripe.com/security redirects to https://docs.stripe.com/security (supplementary fetch #14) |
| 12 | https://stripe.com/radar | OK (redirect) → https://stripe.com/en-hk/radar, 200 | 638,727 | "Trained on 70 trillion data points… reduces fraud by 32% on average… with any processor"; four protection pillars incl. dispute management; Radar for Fraud Teams |
| 13 | https://dashboard.stripe.com/login | OK (no redirect), HTTP 200 — login page only; everything behind it: paused at authentication boundary — requires operator login | 149,048 | Title "Stripe Login | Sign in to the Stripe Dashboard"; meta describes dashboard scope; JS app shell (login.*.js), 20+ locale variants, noscript→enable-javascript.com. Login form itself not extractable from static HTML |
| 14 | https://stripe.com/security (supplementary, fallback for #11) | OK (redirect) → https://docs.stripe.com/security, 200 | 702,037 | "Security at Stripe"; PCI Service Provider Level 1; SOC 1/SOC 2 Type II + SOC 3; NIST CSF; least-privilege roles + restricted API keys; activity logs; sensitive action authentication |
| 15 | https://stripe.com/use-cases/agentic-commerce (supplementary, after #10 404) | OK (redirect) → https://stripe.com/en-hk/use-cases/agentic-commerce, 200 | 539,437 | "Stripe Agentic Commerce | Infrastructure for the Agent Economy"; Agentic Commerce Suite; Machine Payments Protocol; Link's agent wallet; Shared Payment Tokens; Radar for agent-transaction legitimacy |
| 16 | https://docs.stripe.com/agents (supplementary) | OK (no redirect), 200 | 261,724 | "Agents and AI on Stripe"; agent plugins, agent skills, "Billing for LLM tokens", MCP, sandboxes, "Copy for LLM" / llms.txt |
| 17 | https://stripe.com/payments/checkout (supplementary for §4) | OK (redirect) → https://stripe.com/en-hk/payments/checkout, 200 | 1,128,592 | "Checkout studio — AI-powered home for building, monitoring and optimising checkout"; conversion-obsessed copy; "What's in the box"; security section |
| 18 | https://stripe.com/payments/dispute-management (supplementary for §7) | OK (redirect) → https://stripe.com/en-hk/payments/dispute-management, 200 | 583,318 | "Stripe Smart Disputes"; dispute lifecycle labels (filed → deflection → evidence auto-submitted → countered → resolution); reason codes; card-brand monitoring programmes |
| 19 | https://stripe.com/sigma (supplementary for §8) | OK (redirect) → https://stripe.com/en-hk/sigma, 200 | 647,517 | "Analyse Stripe Data Using SQL and AI"; role-based use-case modals (Business Operations, Finance, Data Analysis, Product Management) |

Locale note: all `stripe.com` marketing fetches redirected to `/en-hk/…` (sandbox egress appears geolocated in Hong Kong). The dashboard login offered 20+ `?locale=` variants. Docs stayed at `docs.stripe.com` (en-US).

## 1. Navigation and information architecture

Findings (2026-09-30, fetched):

- Global nav (home page static HTML i18n strings): Products, Solutions, Developers, Resources, Pricing, plus "Guide me" (a guided-navigation entry point), "Dashboard" link, "Sign in" (aria-label) and a persistent primary CTA "Start now" → `https://dashboard.stripe.com/register` (3 occurrences, incl. nav and hero).
- Home hero H1: "Financial infrastructure to grow your revenue. Accept payments, offer financial services and implement custom revenue models – from your first transaction to your billionth."
- Home body IA is a "bento" of six solution cards with stable anchor ids: payments ("Accept and optimise payments globally – online and in person"), billing ("Enable any billing model"), agentic commerce ("Monetise through agentic commerce"), issuing ("Create a card issuing programme"), crypto ("Access borderless money movement with stablecoins and crypto"), connect ("Embed payments in your platform").
- Secondary taxonomies in home footer/nav: `/use-cases/*` (agentic-commerce, ai, creator-economy, crypto, ecommerce, embedded-finance, finance-automation, global-businesses, in-app-payments, marketplaces, platforms, saas), `/industries/*` (fintech, gaming, insurance, media-entertainment, nonprofits, professional-services, public-sector, retail, travel), `/customers/*` stories, and trust/legal links.
- Social proof is structural, not decorative: a stats section ("The backbone of global commerce"; "Businesses on Stripe generated US$1.9tn in 2025") and an events/news carousel ("What's happening").
- Docs (docs.stripe.com) is a separate top-level domain with its own deep tree (~2,655 unique nav links extracted): payments, billing, connect, stablecoins, crypto, agents, radar, tax, treasury, terminal, identity, capital, atlas, climate, data (Sigma, Data Pipeline), issuing, financial-connections, money-management, revenue, quickstarts, no-code, sandboxes, workbench, projects, custom-objects, changelog, CLI.
- Marketing product pages use a sticky in-page section nav (e.g. payments: Online payments / Global payments / In-person payments / Payments Intelligence Suite / Unified platform / How it works / Pricing) — one long page per product rather than many small pages.

PaySwap implications:

- Stripe's five top-level nav verbs plus a "Guide me" affordance map cleanly onto the Work Graph command center (§2B): top-level surfaces stay few, and journey-style entry ("Guide me") matches PaySwap's universal journey model ("I need to pay X", "Connect my existing PSP").
- The use-case/industry/role overlay without separate products is the pattern PaySwap needs for role-sensitive navigation (merchant, LP, lender, developer, expert, network operator) — one capability graph, many entry lenses.
- Docs as a first-class separate surface with stable anchors supports PaySwap's developer-surface requirement; capabilities & connectors documentation should be navigable independently of the marketing site.

## 2. Onboarding and workspace model

Findings (2026-09-30):

- Fetched: account creation is a single persistent CTA — "Start now" on every marketing page points to `dashboard.stripe.com/register`. Connect page copy: "Quickly create a new Stripe account today and get started in minutes."
- Fetched (docs nav, public): the workspace model is documented as: "Start a team" (`/get-started/account/teams`), "User roles" and "Custom roles" (`/teams/roles`, `/teams/custom-roles`), "Organizations" (`/get-started/account/orgs`, "Build an organization", "Manage access to your organization", "Manage SSO"), "Multiple separate accounts" (`/get-started/account/multiple-accounts`), "Linked external accounts", "Approvals" (`/account/approvals`), "Profile", "Branding", "Statement descriptors". SSO supports Entra ID, Okta, OneLogin plus SCIM provisioning. Onboarding checklists: "Set up your account", "Account checklist", "Acceptable verification documents".
- Fetched (security docs): "From the Dashboard, you can assign different detailed roles to enable least-privilege access for your employees, and create restricted API keys."
- Fetched (connect page): onboarding is depicted as an embedded form ("Verify your business details" with progress indicator, "Personal details", "Professional details", "Select your industry"), with copy "Increase sign-up conversion with Connect Onboarding" and "Use Stripe-hosted or [embedded]" onboarding variants; verification copy includes sanctions screening, MATCH list checks, identity verifications, risk review process.
- The actual signup wizard, activation flow and account dashboard: paused at authentication boundary — requires operator login (register/login forms are JS-rendered; the wizard itself is auth-walled).
- Knowledge-based note (unverified model knowledge — verify before relying): Stripe onboarding typically progresses through business type/structure questions, KYC document upload, payouts account linking, then gradual activation of capabilities, with the account living in "restricted" state until requirements are met.

PaySwap implications:

- Stripe separates *identity* (account), *collaboration* (team, roles), *tenancy* (organizations containing multiple accounts/projects) — PaySwap's command center should model workspace (team/org/roles) as a first-class capability orthogonal to rails, with approval artifacts (INV-A03) for permission changes.
- "Approvals" as an account-level surface and least-privilege roles + restricted API keys validate PaySwap's explicit-authorization posture: onboarding should end in a capability-entitlement state, never an implied "all rails available" state (connector catalogue capability ≠ connected-account capability).
- KYC as progressive, staged verification with visible "requirements remaining" maps to PaySwap capabilities whose availability is authoritative and per-account.

## 3. Dashboard patterns

Findings (2026-09-30):

- Live dashboard surfaces: paused at authentication boundary — requires operator login. Only the login page was fetched (title "Stripe Login | Sign in to the Stripe Dashboard"; meta: "Sign in to the Stripe Dashboard to manage business payments and operations in your account. Manage payments and refunds, respond to disputes and more."). The form markup is JS-rendered — not extractable from static HTML.
- Fetched (public docs describing dashboard): "Web Dashboard" (`/dashboard/basics`), "Mobile Dashboard" (`/dashboard/mobile`), "Search in the Dashboard" (`/dashboard/search`) — search is documented as a first-class dashboard surface. "Dashboard assistant" (`/assistant`) — an AI assistant inside the dashboard. Developer surfaces inside the dashboard: "View request logs", "View events", "Add a webhook endpoint" (`/development/dashboard/*`). Sandbox management lives in the dashboard (`/sandboxes/dashboard/manage`, `manage-access`, `organizations`, `sandbox-settings`).
- Fetched (marketing pages referencing dashboard experiences): Connect advertises "Payments and payouts dashboards" for platforms and an accounts view with "Accounts to review" and "Top grossing accounts"; Smart Disputes advertises "Reduce disputes directly from your Dashboard with built-in solutions. No integration required."; Checkout Studio is "AI-powered home for building, monitoring and optimising checkout" with "reports for monitoring performance… and contextual recommendations."
- Repo research: STRIPE-UX-PARITY-LAB.md adaptation targets — operational tables with useful filters, detailed object pages, clear money/status hierarchy, evidence and audit links. STRIPE-CAPABILITY-MAP-2026-09-30.md lists a "mobile dashboard" product in the current catalogue.
- Knowledge-based note (unverified model knowledge — verify before relying): Stripe's dashboard home is a payments overview with balance/payout summaries, recent activity table and to-do prompts; payments list supports filters/saved views; each payment opens a detail page with timeline, metadata, receipt and related events; test/live mode is a top-level toggle.

PaySwap implications:

- Search-as-surface and an in-dashboard assistant are strong precedents for the Work Graph command center: natural-language entry ("I need to pay X") resolving into goals/intents, plus deterministic object pages (INV-X01: UI state derives from protocol state, with UNKNOWN→reconciling states rather than inferred success/failure).
- Dashboard-embedded developer tools (request logs, events, webhook endpoints) support PaySwap's requirement that evidence/provenance be inspectable without leaving the primary interface; approval artifacts (INV-A03) should be first-class object pages.
- Test/live separation via sandboxes (fetched docs: claimable sandboxes, org-level sandboxes) is the pattern for PaySwap local/preview/staging/production — demo must never silently substitute fake financial state (FRONTEND-UX-DEPLOYMENT.md).

## 4. Checkout and payment methods

Findings (2026-09-30, fetched):

- Scale claims on the payments page: "125+ payment methods", "135+ currencies", "195+ countries" (and "195+ countries" for availability). Local-method logos in the fetched HK page are limited; Klarna and Link are the most-referenced consumer brands in static HTML (Link is the most frequent product term overall).
- Integration paths are tiered and explicit: Payment Links ("Accept payments in minutes, without a line of code"; "Configure your payment link in a few clicks"; programmatic generation "Create payment links at scale via an API"), hosted Checkout ("Checkout Pages for Your Website", low-code), Elements (embedded form; docs quickstarts "Embed a full payment page on your site" / "Build an integration with an embedded form"), and full API (PaymentIntents). Docs: "How PaymentIntents and SetupIntents work", "Payment status updates" (`/payments/payment-intents/verifying-status`), "Payment Records API", plus "Older APIs" and "Migrate to the new APIs" (explicit versioned migration paths).
- Checkout Studio (fetched): "AI-powered home for building, monitoring and optimising checkout" with "integration guidance that gets you live faster, reports for monitoring performance… and contextual recommendations."
- Conversion framing (fetched checkout copy): "We obsess over every detail of the checkout page—from its load time to the smallest animation."
- Adaptive Pricing and wallet support (Apple Pay, Google Pay, Link) appear in pricing/pricing-grid headers ("Pay-as-you-go", "Custom domain", "Post-payment invoices", "Adaptive Pricing").
- Customer quote (payments page): "Through one integration, we were able to increase our acceptance rates by creating a bespoke approach for each market… navigating 3D Secure in a user-friendly way."
- Docs analytics subtree (fetched): acceptance, authentication (3DS flows incl. "Data Only"), payment-method analytics, "Set up an A/B test", recommendations.

PaySwap implications:

- The tiered no-code → low-code → full-API ladder is exactly the capability-surface ladder PaySwap needs: Payment Links (no-code economic goal) through intent-level API; every tier still produces authoritative protocol state (no fake completion — W3-001 Forbidden).
- "Payment status updates" being a dedicated docs topic mirrors PaySwap's UNKNOWN→reconciling UI state (INV-X01): checkout UX must render protocol-derived status, including 3DS/authentication intermediate states.
- Payment-method analytics + A/B testing validates routing/optimization as a visible, measurable capability (INV-C07 execution modes) without making the optimizer mandatory — provider-native optimization remains representable.

## 5. Billing and subscriptions

Findings (2026-09-30, fetched):

- Positioning (title/meta): "Stripe Billing | Recurring Payments & Subscription Solutions" — "Set up recurring and usage-based pricing with APIs or within the Dashboard. Reduce churn with AI-powered tools."
- H2: "One platform to price, meter, bill, invoice and grow." Sub-tabs: Subscriptions, Usage-based billing, Invoicing. Section: "An integrated billing platform for your full quote-to-revenue cycle."
- Cross-sell block (fetched headings): faster checkout, real-time fraud prevention, "Simplify sales tax, VAT and GST in 90+ countries", "Automate revenue accounting" (Revenue Recognition), deeper insights, data unification.
- Docs (fetched nav): Subscriptions subtree includes "Build a subscriptions integration", "Limit customers to one subscription", "Set billing cycle date"; no-code subtree includes "Create subscriptions" and "Send quotes"; testing includes "Test clocks" (`/billing/testing/test-clocks` — time-travel testing for billing) and "Subscription testing best practices"; webhooks: "Configure subscription events".
- Case studies in page (fetched): Atlassian (single global billing platform), Intercom (3 months to usage-based billing), Fox Sports (+20% subscription revenue, +54% retention).

PaySwap implications:

- "Price, meter, bill, invoice" as one pipeline matches PaySwap's Collections/Billing surfaces as capabilities: metering should be an evidence-producing capability, and invoices should be approval/authorization artifacts when they trigger money movement (INV-A03).
- Test clocks (simulated time) are a direct precedent for PaySwap's simulation/preview environments — billing logic must be testable without real money movement, while production financial state stays authoritative (repo: CASE-STUDIES.md Sporta/PayBridge lessons).
- Quote-to-revenue framing supports PaySwap's universal journey: a financing or netting goal should compile into the same billing/invoicing evidence chain as ordinary subscriptions.

## 6. Connect / platform flows

Findings (2026-09-30, fetched):

- Positioning: "Stripe Connect is the fastest and easiest way to integrate payments and financial services into your software platform or marketplace." Sections: Embed payments with confidence / How it works / Security and compliance / Unified payments stack / Under the hood.
- Onboarding UX (fetched graphic labels): "Verify your business details", "Personal details", "Professional details" ("DOB, Phone, Industry"), "Select your industry", "Doing business as", "Legal business name", with form progress indicator and "Continue" — plus "Increase sign-up conversion with Connect Onboarding" and "Use Stripe-hosted or [embedded]" variants.
- Risk/compliance copy (fetched): sanctions screening, MATCH list checks, identity verifications, risk review process, "US verification requirements", "Learn about the relationship between onboarding and verification."
- Platform operational copy (fetched): "Accounts to review", "Top grossing accounts", "Active, onboarded accounts that get paid via Connect", "Manage and activate accounts", "Track and reconcile payments", destination charges, "Standard bank payout", "Standard payouts" vs "Instant Payouts", tax forms generation.
- Ecosystem framing (fetched): "Payments and payouts dashboards" for platform users, Stripe App Marketplace, partner ecosystem, "white label and monetise payments".
- Repo research: STRIPE-UX-PARITY-LAB.md notes Connect positions payments, payouts, invoicing, tax, financing, card issuing as an integrated platform/marketplace stack.

PaySwap implications:

- Stripe's three-sided model (platform → connected accounts → end-payers) is the connector analog for PaySwap's Merchant PSP Connector: "connect once, expose as payment method/orchestration endpoint/agentic checkout path depending on PSP capabilities" (STRIPE-CAPABILITY-MAP-2026-09-30.md).
- "Accounts to review" + staged verification proves the pattern for capability gating in PaySwap: a connected merchant's rails are authoritative per compliance state, never per catalogue listing.
- Payout options (standard vs instant) as explicit choices supports INV-C07 execution modes: settlement timing/cost tradeoffs should be user-selectable strategy, surfaced with expected evidence.

## 7. Disputes and refunds

Findings (2026-09-30, fetched):

- Product page (title): "Stripe Smart Disputes | Dispute Chargebacks with AI" — "Reduce dispute fees, help improve win rates and save valuable time managing disputes." Sections: Reduce time and costs / Recover more revenue / Avoid card brand monitoring programmes / Get started immediately.
- Dispute lifecycle rendered as explicit states (fetched labels): "Dispute is filed" → "Dispute deflection" → "Evidence auto-submitted" → "Dispute is countered" → "Dispute resolution". Reason codes shown: "Credit not processed", "Product not received", "Product unacceptable", "Customer reviews charge".
- Key copy (fetched): "Reduce disputes directly from your Dashboard with built-in solutions. No integration required."; "Reduce costs and restrictions from Visa and Mastercard monitoring programs"; "Radar Assistant" referenced on the page.
- Docs disputes subtree (fetched nav): "How disputes work", "Respond to disputes", "Network categories", "Reason code and evidence examples" (`/disputes/reason-codes-defense-requirements`), "Sample evidence packets" (`/disputes/visual-evidence`), "Evidence best practices", Smart Disputes with "Configure auto-respond", "Manage disputes programmatically" (`/disputes/api`), Visa Compelling Evidence 3.0, Visa/Mastercard compliance, "Dispute withdrawals", "High risk merchant lists" (MATCH), "Measuring disputes", "Monitoring programs", and a full prevention subtree (card testing, identifying fraud, verification checks, customer abuse).
- Refunds (fetched docs): "Refunds and cancellations" (`/refunds`), "Refund transactions" (Terminal), refunds and credit notes (Tax). Declines are their own docs branch: `/declines`, "Card declines", "Stripe decline codes", "Network decline codes".

PaySwap implications:

- Dispute state machines with named network categories and per-reason evidence requirements are the template for PaySwap's Disputes/Evidence surfaces: evidence packets should be inspectable artifacts (INV-A03), auto-response should still produce explicit authorization records.
- "Evidence auto-submitted" plus "manage disputes programmatically" shows automation and human audit coexisting — PaySwap agents may assemble evidence, but finality remains protocol-owned (adapters cannot declare finality, W3-001 acceptance).
- Refunds/declines/disputes as separate docs branches with code-level taxonomies supports PaySwap's requirement that failure states be explicit, typed and reconcilable (INV-X01), not folded into generic "error".

## 8. Analytics and reporting

Findings (2026-09-30, fetched):

- Sigma page (title): "Stripe Sigma | Analyse Stripe Data Using SQL and AI" — "Use SQL and our AI-powered assistant to easily analyse Stripe data in your Dashboard to uncover revenue drivers, payment trends and create custom reports." Role-based modals: Business Operations, Finance, Data Analysis, Product Management ("Business teams use Stripe Sigma to run their company more efficiently"; "Data teams use Stripe Sigma to analyse everything from ARPU to churn"). Also "Easy-to-use schema", "Designed for collaboration".
- Payments page (fetched): "Payments Intelligence Suite" section; docs analytics subtree: acceptance, authentication, disputes analytics, payment methods, "Payments optimization", recommendations, A/B testing.
- Connect page (fetched): "Offer powerful reporting and analytics to your users", "Build custom reports", "View full report", "View all deposits", "Track and reconcile payments".
- Docs (fetched nav): Data Pipeline and Sigma under `/data`; Revenue Recognition reports ("Trial balance", "Period summary"); Tax reports ("Choose which report to use", "Reconcile reports"); disputes measuring/monitoring docs; "Disputes analytics".
- Home page (fetched): stats as marketing ("Businesses on Stripe generated US$1.9tn in 2025").

PaySwap implications:

- Role-based report discovery (ops vs finance vs data vs product) is the pattern for PaySwap's role-sensitive dashboards — analytics should be projections of authoritative protocol state, not a second source of truth (INV-X01).
- "Track and reconcile" as a platform promise maps to PaySwap's Evidence surface: reports should link every aggregate row back to movement intents and settlement artifacts.
- Checkout Studio's "reports + contextual recommendations" pairing suggests PaySwap analytics should propose strategies (goals) with expected economics, keeping execution choice with the user (INV-C07).

## 9. Developer surfaces

Findings (2026-09-30, fetched):

- Docs home (fetched): clear getting-started ladder — "Quickstarts", "Set up your development environment", "Send your first API request", "Build and test new features", "Go-live checklist" (`/get-started/checklist/go-live`), "Release phases". Use-case entry points (startup, SaaS subscriptions, invoices, in-person).
- API reference (fetched): "Just getting started?" and "Not a developer?" (→ no-code options / partner apps) as sibling tracks; idempotency documented ("POST requests accept idempotency keys. Don't send idempotency keys in GET", "Don't send sensitive data… as idempotency keys", automatic key removal); auto-pagination; `expand` (including recursive expansion); typed errors with `error.code`, `error.decline_code`, `error.param`, `error.message`, `error.type`; separate `/error-handling`, `/error-codes`, "Advanced error handling" pages.
- API versioning (fetched): named, dated release versions (changelog shows Dahlia 2026-08-26 latest, then Clover, Basil, Acacia…) with `.preview` variants and a documented release model ("API versions monthly with no breaking changes"); "How API versioning works" (`/api-versions`) and "Upgrade your integration" (`/upgrades`).
- Tooling (fetched docs nav): Workbench ("How Workbench works", "Shell and API Explorer", "Manage event destinations", "Health alerts and insights"), Sandboxes (incl. "Create claimable sandboxes", org sandboxes), CLI (`/cli/install`), "Stripe for Visual Studio Code", a Terraform provider, Custom Objects, Stripe Apps SDK with a full component kit (DataTable, DetailPage, Toast, Tabs…), MCP (`/mcp`), "Agent plugins" (`/agents/plugin`), "Agent skills" (`/skills`), "Stripebot web crawler" (`/stripebot-crawler`), and LLM affordances: "Read llms.txt" footer link plus a "Copy for LLM" button on docs pages.
- Docs contribute affordances: "Ask about this page", Discord, support links.

PaySwap implications:

- Idempotency + typed errors + explicit dated API versions are contract requirements PaySwap already encodes (every mutation idempotent; external versions explicit; adapters cannot declare finality) — Stripe's UX proves these can be surfaced as first-class developer UX, not buried.
- Workbench (shell, event destinations, health alerts) is the reference shape for PaySwap's developer surface inside the command center: live protocol inspection with health/reconciliation views (INV-X01 reconciling states).
- llms.txt + "Copy for LLM" + Stripebot crawler show Stripe treating AI agents as a real audience — PaySwap should publish machine-readable capability/connectors manifests from day one (MCP/A2A boundaries per CASE-STUDIES.md).

## 10. Agentic commerce

Findings (2026-09-30, fetched):

- The curated URL https://stripe.com/agentic-commerce returns 404; the live surface is https://stripe.com/en-hk/use-cases/agentic-commerce (fetched): title "Stripe Agentic Commerce | Infrastructure for the Agent Economy", meta "The Agentic Commerce Suite connects businesses, agents and buyers. Accept agentic payments, and make products discoverable across AI surfaces."
- Page structure (fetched): For businesses / For agents / For developers / Infrastructure / Why Stripe. Key copy: "Accept payments from agents using the Machine Payments Protocol"; "Give agents a way to pay on your behalf with Link's agent wallet"; "Distinguish legitimate agent-initiated transactions from fraudulent activity with Stripe Radar"; "Publish products on AI surfaces with a hosted solution or API"; "Issuing for agents"; "Shared Payment Tokens"; "Machine payments".
- Home page (fetched): agentic commerce is one of six bento solution cards ("Monetise through agentic commerce") and appears in the news carousel ("Make your products shoppable through AI platforms").
- Docs (fetched, docs.stripe.com/agents): "Give an AI agent access to Stripe, and build products that agents can use." Sub-pages: "How agents work with Stripe", "Agent plugins for Stripe" (`/agents/plugin`), "Agent skills", "Agentic commerce overview", "Billing for LLM tokens", "Analyze your data with AI", "Accept payments initiated by AI agents and automated systems", "Enable commerce between buyers and sellers through AI agents", "Build an agent", "Build with agents". MCP and sandboxes referenced.
- Repo research: STRIPE-CAPABILITY-MAP-2026-09-30.md maps Stripe's stack (Shared Payment Tokens, Link agent wallet, Delegated Checkout, machine payments) to PaySwap capabilities: ScopedPaymentCredentialCapability, AgentFundingCapability, DelegatedCheckoutCapability, MachinePaymentCapability. STRIPE-UX-PARITY-LAB.md notes SPTs scoped by seller, amount and time window.

PaySwap implications:

- Stripe's "For businesses / For agents / For developers" triad matches PaySwap's agent UX rule: agents are collaborators with visible authority, funding limits and produced evidence — never the center of the user mental model.
- Scoped credentials and agent wallets validate PaySwap's non-custodial framing: the user delegates bounded spending authority (approval artifacts INV-A03; wallet UX: "approve a policy once; let the User Agent operate inside limits" — FRONTEND-UX-DEPLOYMENT.md).
- The 404 on `/agentic-commerce` plus relocation under `/use-cases/` is a live lesson in URL stability: PaySwap capability pages need stable canonical URLs as surfaces evolve.

## 11. Responsive / mobile patterns

Findings (2026-09-30, fetched):

- All fetched marketing pages declare `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>` — including `viewport-fit=cover` for notched devices.
- Product pages ship a distinct mobile navigation layer: `RefreshedProductsNavMobile` markup (9 occurrences on product pages; the home page uses a simpler hamburger: `navigation-hamburger-button` with `aria-label="Toggle navigation menu"`, `aria-expanded="false"`), plus `SiteHeader__mobileMenu` and `mobileNavDis[play]` CSS state.
- Inline CSS on product pages reveals a breakpoint ladder: `min-width:600px`, `min-width:900px`, `min-width:1112px`, `min-width:1300px` with matching `max-width:599px` / `max-width:899px` rules (roughly phone / tablet / small desktop / wide).
- Locale/country selection is an aria-labelled control ("Hong Kong SAR, China. Choose your country") rather than a plain link list in the header.
- Mobile as a product surface (fetched docs): "Mobile Dashboard" (`/dashboard/mobile`) is documented alongside the web dashboard; payments docs have a full mobile subtree (Payment Sheet, accept in-app payments, finalize on server, filter card brands/funding). The capability map (repo research) lists "mobile dashboard" in the catalogue.
- Knowledge-based note (unverified model knowledge — verify before relying): Stripe's mobile dashboard app (iOS/Android) provides a subset of dashboard functionality — payments overview, approvals-style actions and notifications — optimized for operators rather than developers.

PaySwap implications:

- A documented breakpoint ladder + separate mobile nav componentry should be encoded in PaySwap's design-system foundations and responsive layout rules (W3-001 scope) with desktop AND mobile verification per UI work order (FRONTEND-UX-DEPLOYMENT.md browser-verification gate).
- Mobile Dashboard as a first-class docs product confirms PaySwap's command center must degrade gracefully: approval flows (INV-A03) and UNKNOWN/reconciliation states must be legible on phones, where users most urgently need answers about money state.
- "Finalize payments on the server" as an explicit mobile docs topic matches PaySwap's rule that client UX never infers finality (INV-X01).

## 12. Trust and security messaging

Findings (2026-09-30, fetched):

- The curated URL https://stripe.com/trust-security returns 404; security content lives at https://docs.stripe.com/security (via redirect from stripe.com/security; both outcomes recorded). Title: "Security at Stripe | Stripe Documentation".
- Compliance claims (fetched): "A PCI-certified auditor evaluated Stripe and certified us to [PCI Service Provider Level 1]"; "SOC 1 and SOC 2 Type II report[s]"; SOC 3; "NIST Cybersecurity Framework"; "EMVCo standard for card terminals"; "PCI Payment Application Data Security Standard" (PA-DSS); Self-Assessment Questionnaire; Data Processing Agreement; Privacy Center.
- Product-security copy (fetched): "HTTPS and HSTS for secure connections"; "Access restriction and auditing"; "Activity logs"; "Sensitive action authentication"; "Managing access control"; "Infrastructure safeguards"; "Security posture maintenance"; internal controls: "two-factor authentication (2FA) using a hardware-based token, and mTLS… on Stripe-issued machines", with additional permissions for sensitive internal systems.
- Security is also marketed inline on product pages (fetched): Radar ("Trained on 70 trillion data points… reduces fraud by 32% on average", "with any processor"), Checkout has a dedicated "Security" section, Connect a "Security and compliance" section, home footer links legal/restricted-businesses and privacy.
- Uptime as a trust stat (fetched, pricing page): "99.999% average historical uptime".

PaySwap implications:

- Trust messaging is certification-anchored (PCI/SOC/NIST names, not adjectives) and lives in docs where claims are auditable — PaySwap's non-custodial framing needs equivalent precision: custody boundaries, key authority and recourse paths stated as verifiable facts per capability, not marketing.
- "Sensitive action authentication" and activity logs map directly to INV-A03 approval artifacts: sensitive mutations require an explicit authentication/authorization step and leave inspectable audit records.
- Radar's "with any processor" positioning is a model for PaySwap capability marketing: provider-neutral risk tooling that composes across connectors without claiming authority over them.

## 13. Loading, error and empty states

Findings (2026-09-30, fetched):

- 404 page (fetched, from the three dead curated URLs): `data-page-id="Not found"`, `data-page-title="Page not found"`, with a static accessibility fallback (footer sitemap with links) and an inline error-capture bootstrap: `window.__capturedErrors = []; window.onerror = …; window.onunhandledrejection = …` plus a Sentry config meta tag. Detailed recovery UI beyond the sitemap is not extractable from static HTML.
- Page-load pattern (fetched, product pages): `<html … data-loading>` attribute with CSS such as `[data-loading] .SiteHeader__ctaNav{opacity:0}` — header CTAs fade in when loading completes (progressive enhancement rather than spinners).
- Design-system-level state documentation (fetched docs nav, Stripe Apps patterns): dedicated documented patterns for "Empty state" (`/stripe-apps/patterns/empty-state`), "Loading" (`/stripe-apps/patterns/loading`), "Waiting screens" (`/stripe-apps/patterns/waiting-screens`), "Communicating state" (`/stripe-apps/patterns/communicating-state`), "Progress stepping", "Demo content", plus a `Spinner` component and `Toast`/`Banner` components for feedback.
- Error taxonomies (fetched docs): `/api/errors` with structured attributes (`error.code`, `error.decline_code`, `error.param`); dedicated `/declines` tree (card declines, Stripe decline codes, network decline codes); webhook "signature verification errors"; docs "Handle errors" / "Advanced error handling" / "Error codes".
- Payment-status verification (fetched docs): "Payment status updates" (`/payments/payment-intents/verifying-status`) — the docs explicitly instruct verifying status rather than trusting client events.
- Dashboard loading/empty/error states (lists, detail pages, onboarding wizard): paused at authentication boundary — requires operator login. Not surveyed.
- Knowledge-based note (unverified model knowledge — verify before relying): Stripe dashboard lists typically show skeleton loaders, empty states with a primary setup CTA and "learn more" link, and inline banners for actionable errors; payment detail pages render a status timeline where pending states are explicit.

PaySwap implications:

- "Verifying status" as an official docs topic is the Stripe analogue of INV-X01 (UNKNOWN→reconciling UI state): PaySwap must render pending/unknown as a distinct, honest state and offer a reconcile action — never inferring success from a spinner disappearing (FRONTEND-UX-DEPLOYMENT.md state-rendering rules).
- Documented empty-state/loading/waiting-screen patterns should be codified in PaySwap's design-system foundations from the start (W3-001 scope), including agent-proposed-action "waiting for approval" screens (INV-A03).
- Client-side error capture wired to Sentry on marketing pages shows observability as a UX concern; PaySwap execution modes (INV-C07) should likewise report execution health per mode (pending/reconciling/failed) into the evidence chain.

## Fallback disclosure

Sections relying partly or wholly on non-live-fetch sourcing:

- §2 Onboarding and workspace model: actual signup/onboarding wizard paused at authentication boundary — requires operator login; workspace facts came from fetched public docs nav, plus one knowledge-based note (typical onboarding progression) labeled inline.
- §3 Dashboard patterns: live dashboard paused at authentication boundary — requires operator login; supplemented by fetched public docs references (web/mobile dashboard, search, assistant, request logs, sandbox management), repo research (STRIPE-UX-PARITY-LAB.md adaptation targets; STRIPE-CAPABILITY-MAP-2026-09-30.md mobile dashboard listing), and one knowledge-based note (dashboard home/lists/detail conventions).
- §5 Billing and subscriptions: findings are live-fetched, but the simulation claim references repo research (CASE-STUDIES.md Sporta/PayBridge lessons) as corroboration only.
- §6 Connect / platform flows: all findings live-fetched except the integrated-stack positioning note, sourced from repo research (STRIPE-UX-PARITY-LAB.md).
- §8 Analytics and reporting: findings live-fetched; no dashboard-internal report screens were surveyed (paused at authentication boundary — requires operator login), so claims are limited to marketing/docs surfaces.
- §10 Agentic commerce: the curated URL 404'd; findings use the fetched replacement surface plus repo research (STRIPE-CAPABILITY-MAP-2026-09-30.md, STRIPE-UX-PARITY-LAB.md) for the capability mapping. No knowledge-based notes used.
- §11 Responsive / mobile patterns: breakpoints and mobile nav are live-fetched; the mobile dashboard app description is a knowledge-based note (the app itself was not fetched); mobile-dashboard existence is corroborated by fetched docs nav and repo research (capability map).
- §13 Loading, error and empty states: 404 page, data-loading CSS, docs pattern links and error taxonomies are live-fetched; dashboard-internal states are paused at authentication boundary — requires operator login, with one knowledge-based note (dashboard skeleton/empty/banner conventions) labeled inline.
- Sections 1, 4, 7, 9 and 12 are sourced entirely from this session's fetched HTML (no fallback sourcing).
