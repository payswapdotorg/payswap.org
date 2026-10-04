Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages via automated extraction, no authentication

# Stripe Connect — platform payments product-design notes

Source: R1 notes for `/connect`. Product-design logic only; all dashboards/forms below are marketing mockups embedded in the public page (dashboard.stripe.com itself was not accessed — that is Phase 2).

## Page facts

- URL: `https://stripe.com/connect` (200, no redirect). Nav entry: Products → Platforms and marketplaces group, first item.
- Purpose / primary user / task: product page for embedded/platform payments; platform, marketplace, and SaaS builders who must onboard sellers and route money; evaluate onboarding, fund-flow control, payouts, and monetization, then start signup or sales contact.
- Primary CTA: "Start now" → generic `dashboard.stripe.com/register` (not product-scoped on this page — a deviation from the payments-family pattern); secondary: "Contact sales" plus per-model sub-CTAs (platforms/marketplaces/enterprise/payouts).

## Three-sided platform model

Connect serves the platform operator (Shopify/DoorDash/Lyft-class), their sellers/service providers, and the end buyers. The page makes the triad concrete through money-flow mockups rather than diagrams alone: a platform dashboard ("Total Sales $1,130 / 41 total orders"), a payout split (customer charges → platform fee → merchant), a DoorDash receipt breakdown (base fee/restaurant/delivery/tip split across customer/DoorDash/restaurant/dasher), and a Lyft ride split (Rider $8.32 → Lyft $1.00 → Driver $7.32). Proof-led hero: "go live in weeks instead of quarters". Stats band: 18,000+ platforms, 12M+ onboarded accounts.

## Onboarding UX for connected accounts

- **Mode switcher: Stripe-hosted | Embedded | API** — the same capability presented at three integration depths (mirrors the payments family's integration ladder).
- **Staged verification forms:** a "Verify your business details" mock (legal business name, EIN, doing-business-as, industry select, business URL, product description) with a "Continue" step — progressive KYC, collecting what is needed when it is needed. Account settings panels show "Other information provided: Last 4 SSN, Phone" with Edit affordances — data already collected is summarized, not re-asked.
- **Networked onboarding:** one-click onboarding for sellers who already have a Stripe account (46+ countries, 14 languages).
- Country-specific verification requirements are framed as tasks (e.g. "US verification requirements").

## Compliance and KYC copy

- Positioning line: "Connect shifts payment obligations from you to Stripe" — compliance as a product benefit, backed by a licensing list (US MTL, EU EMI license), identity verification, KYC/AML, sanctions screening, MATCH list, and PCI tokenization.
- Compliance work is surfaced as operational UI, not legal prose: dashboard "Tasks" with due dates ("Handle verification responses, US verification requirements") and an "Accounts to review" queue.

## Platform operational surfaces (mocked dashboard)

The platform-side dashboard mockup exposes the real IA: top bar Search / Settings / Sandboxes; left nav Home / Payments / Balances / Customers / Connect / More. Surfaces shown:

- "Accounts to review" — a pending-review queue for connected accounts (risk/compliance worklist).
- "Top grossing accounts" and a gross-volume chart ($12,382.22 vs previous period) — platform health metrics.
- US gross earnings tracking and automated 1099s.
- Feature chips: manage/activate accounts, refunds, tax forms, reconcile, custom reports, send funds, understand costs, set pricing no-code.

## Payments and payouts dashboards for connected users

Embedded dashboards that platforms hand to their sellers: a balance view ($100), payout options **standard vs instant** ("Standard bank payout — You'll receive your funds in 2-3 days" vs "Instant Payouts — Pay out up to $79.20 instantly for a fee"), deposit statuses ("Deposit #0132 — En route — $1,042.32"), pending/instant/standard payout splits, and an email notification mock ("Hi Jane, You have $1,321.41 scheduled today"). Timing expectations and payout states are explicit product copy.

## Money-movement pattern gallery

"Control how funds flow" catalogs charge/transfer patterns, each with a real-world example and a docs link: direct charges (Shopify), destination charges (Lyft), split payouts between sellers (ClassPass), top-ups, payouts (Cozy), instant payouts (Instacart), subscriptions on connected accounts (Blackbaud), and account debits (dispute fees). Code panels expose the object model (PaymentIntent with application_fee_amount, transfer_data/destination, transfer_group, topups.create, payouts.create with method 'instant'). The funds-flow diagram uses a four-role legend: Bank / Buyer / Platform / Seller.

## Ecosystem framing

- "Unified payments stack" section: systematic sibling cross-sell with a live UI mockup per product (Terminal receipt with Seattle tax, Tax calc, Billing pricing table with a "Popular!" badge, Capital loan offer, Issuing, Invoicing, Sigma natural-language query, Data Pipeline warehouse picker).
- Monetization: no-code pricing tools, margin reports, and revenue-share qualification ("Learn more about how to qualify for a revenue share from Stripe").
- Closing cards cross-sell a payfac solution and flexible usage-based pricing. No numeric pricing on the page itself; the pricing page carries "Included with Payments" for standard Connect plus "0.25% starting fee for platforms that deploy their own payments pricing".

## Not observable from static content

Runtime behavior of the mode switcher and funds-flow selector, real onboarding validation, real review queues. The funds-flow pattern list appears twice in markup (likely an interactive selector). No native accordions; progressive disclosure via the hosted/embedded/API tabs.

## PaySwap implications

- **Merchant-PSP connector pattern:** Connect's model — one platform onboarding many connected payment recipients with per-recipient verification state — maps to PaySwap connectors managing merchant PSP relationships; a "connectors to review" worklist mirrors "Accounts to review".
- **Capability gating per compliance state:** advanced money movement should be gated on verification state with explicit task copy (what is due, why, and what unlocks), not silently disabled.
- **Standard vs instant payout options with fee and timing copy** ("2-3 days" vs "instantly for a fee") is the pattern for PaySwap settlement-route disclosure (NATIVE_STRIPE_CRYPTO vs EXTERNAL_PAYSWAP_CONVERSION routes).
- **Three integration depths per capability** (hosted / embedded / API) lets PaySwap serve no-code merchants and developers from one surface.
- **Compliance as product copy:** licensing/KYC lists and shift-of-obligation framing convert trust requirements into selling points.
- **Pattern gallery with real-world examples** documents money-movement options better than abstract diagrams — applicable to PaySwap settlement instruction documentation.

## Cross-references

Related files in this set: `public-pages.md` (survey index), `navigation.md`, `payments.md`, `billing.md`, `crypto.md` (Connect stablecoin payouts — private preview), `balances.md` (payout states), `customers.md`, `workflow-patterns.md`, `pay-swap-ux-mapping.md`, `README.md`.
