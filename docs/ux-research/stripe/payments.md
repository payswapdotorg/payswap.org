Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages via automated extraction, no authentication

# Stripe payments family — hub, Checkout, Payment Links

Sources: R1 notes for `/payments`, `/payments/checkout`, `/payment-links` (plus the `/payments/payment-links` verification fetch). Product-design logic only. All "forms" below are marketing mockups; no real validation was observable from static content.

## The choose-your-path integration ladder

The same four-step ladder is repeated on `/payments`, `/payments/checkout`, and `/payments/payment-links`:

**Payment links (no code) → Checkout full page (prebuilt) → Embedded form (low-code) → Elements (full custom)**

- Presented as a no-code → full-code spectrum: a first-class IA concept, not a footnote. Sibling surfaces are cross-sold as alternatives within one family ("Pick your path" grid), and Checkout's hero enumerates all four modes up front.
- Signup entry carries product context: `dashboard.stripe.com/register/payments`, `/register/checkout` — registration deep-links are product-scoped.
- Developer-oriented paths route to docs, not signup ("Explore embedded form" → docs).

## Scale claims (marketing numbers)

- 125+ payment methods · 135+ currencies · 195+ countries · 46 local acquiring markets.
- These are marketing numbers used as proof points (alongside 99.999% uptime and volume stats). Method availability is always country-framed (Alipay CN, OXXO MX, iDEAL NL, Bacs UK) — counts and geography are presented together, never bare counts.

## State-marketing

Stripe markets its states as product proof: live-UI mockups show success ("Payment succeeded… will appear on your statement" — the same success component reused across Checkout and Payment Links), processing (Terminal "Processing" → "Approved"), pending/en-route payouts, "Accounts to review" queues, and dispute won/lost charts. Implication for PaySwap: empty/loading/error/success states are first-class surfaces worth designing, mocking, and documenting (compare R2's empty-state and loading pattern notes → `component-patterns.md`).

## Cross-sell structure

- Closing cross-sell cards on `/payments`: "Recurring payments → Explore Billing" and "Platform payments → Explore Connect".
- Every subsection ends with a "Learn more / Explore" link into a child product — a breadcrumb-style funnel from platform → product → feature.
- Checkout's "What's in the box" glossary is a dense cross-sell surface: each feature names a sibling product (Billing, Metronome, Connect, Tax, Radar, Link, Climate, customer portal, pricing table).

## Per-page detail — /payments (hub)

- **Purpose / primary user / task.** Flagship product page; merchant decision-maker plus evaluating developer; understand coverage (online/global/in-person/intelligence/platform) and start signup or contact sales.
- **Navigation entry.** Products → Payments group, first item. Sticky sub-nav: Overview | Features | Payment methods | Authentication | Disputes | AI | Docs. Logged-in markup variant adds a "Dashboard" link.
- **Hierarchy.** Hero with product-scoped CTA → live-UI mockup carousel (subscription plan picker, multi-step Cart → Billing details → Shipping Address → Confirmation stepper, konbini, Link SMS flow) → four value props → sticky anchor tabs (Online | Global | In-person | Intelligence Suite | Unified platform) → per-section deep dives → advanced-capabilities gate → compliance/developer sections → pricing card → final CTA + cross-sell cards.
- **CTAs.** "Start accepting payments" → register/payments; "Contact sales"; "Try the demo" → checkout.stripe.dev (first-party demo domain).
- **Progressive disclosure.** Sticky anchor tabs; country switcher (US/DE/UK/CN/MX) for method display; 7-language code tabs; payment-method toggles in the hero carousel; aria-expanded menus (11). No native accordions.
- **Forms.** Mockups only (form count 0): card entry, bank search, 6-box SMS code, masked last-4 "(•••) ••• ••35". Real validation not observable from static content.
- **States.** Terminal processing/approved; dispute charts; Radar rule table with a "Changes" column; checkout success mockup. Error states not directly shown here.
- **Eligibility.** "For qualified users and where available via Stripe" gates advanced capabilities (incremental auth, multicapture, local acquiring, regional debit networks, multiprocessor, Organizations) behind sales contact.
- **Pricing card.** Standard "Starts at 2.9% + 30¢ per successful charge" vs Custom "Contact sales" (volume discounts, country-specific rates, multi-product discounts, interchange plus).

## Per-page detail — /payments/checkout

- **Purpose / primary user / task.** Product page for the prebuilt payment UI family; merchant/developer choosing an integration path; understand the four deployment modes and start one (demo/signup/docs).
- **Navigation entry.** Products → Payments group → "Checkout — Prebuilt payment UIs". Leaf page: no product-local sub-nav.
- **Hierarchy.** Hero "We built Checkout so you don't have to" (subhead enumerates the 4 modes) → conversion features → path picker → Checkout studio → developer code tabs → security/compliance → testimonials → "What's in the box" glossary → "Know what you'll pay" pricing card → final CTA.
- **Conversion framing.** Form-UX patterns listed as selling points: real-time card validation, email-domain misspelling detection, descriptive localized errors, address autocomplete, Link 1-click, wallets out of the box, "Check out as guest", dynamic amount button labels ("Pay $65.00"). Four feature cards: reduce friction / any device / global (30+ languages, country carousel) / brand theming (icon, logo, brand color, accent, font, shapes — framed as applying "across the Stripe products your customers use").
- **Checkout studio.** "AI-powered home for building, monitoring, and optimizing checkout" — a 3-step Configure / Monitor / Optimize loop cross-selling Dashboard tooling.
- **Progressive disclosure.** Code-language tabs; country carousel; brand-settings mock panel; glossary lists are static headings, not accordions.
- **States.** Success state mocked with a shareable buy.stripe.com URL; card-testing protection implies a CAPTCHA challenge state; loading/error not directly rendered (error messaging appears as a listed feature, not a mockup).
- **Eligibility.** Method availability framed per country; Instant Bank Payments tied to "Link-enabled users"; PCI framed as "pre-filled SAQ A"; custom domain requires Dashboard setup.
- **Pricing card.** Pay-as-you-go base (2.9% + 30¢; "Checkout is included in Stripe's integrated pricing") plus à-la-carte add-ons: custom domain $10/mo; post-payment invoices 0.4% capped at $2; Adaptive Pricing included but with a customer-visible conversion fee "starting at 2%" — pass-through fees disclosed honestly.

## Per-page detail — /payment-links (no-code tier)

- **Purpose / primary user / task.** Non-technical seller / SMB without a website (or marketers wanting shareable pay URLs); understand the 3-step flow and create a link.
- **Navigation entry.** Products → Payments group → "Payment links — No-code payments". Canonical nav path is `/payments/payment-links`; `/payment-links` serves the same page (both 200).
- **Hierarchy.** Hero "Create a link. Sell anywhere." → chat-conversation mock (seller pastes a buy.stripe.com URL → payment page → success) → numbered 3-step flow (Create a link / Share the link / Get paid) → interactive configuration demo → API section (paymentLinks.create, 7-language tabs) → new channels + platform distribution → testimonials → pricing card → "Pick your path" sibling grid → final CTA.
- **Interactive demo (try-before-signup).** An "Interactive demo" toggle next to "Create account" exposes the configurator anonymously: payment type (Payment | Subscription | Tip or donation), product picker, price + currency (9 currencies), billing frequency, quantity and promo-code toggles, CTA label (Pay | Book | Donate), phone requirement — with live "Payment page" / "After payment" preview panes and the resulting buy.stripe.com URL. This is the configure → instant-preview pattern for no-code object creation.
- **Commitment microcopy.** "no contracts or banking details required" to create an account.
- **States.** Success fully mocked in the hero (same success component as Checkout); "After payment" pane implies confirmation-page configuration; validation errors not observable statically.
- **Ladder position.** Explicitly the lowest rung; the sibling grid upsells from no-code toward code.

## PaySwap implications

- Present an explicit integration ladder for PaySwap merchants (hosted pay page → payment link → embedded → SDK) with a page per rung and scoped signup URLs that preserve product context.
- Try-before-signup configurators with live preview lower the entry barrier for non-technical merchants — directly applicable to PaySwap checkout/link configuration.
- Market states, not just features: success/processing/pending/review mockups as proof of operational maturity.
- Pair scale claims with country framing (capability per geography) rather than bare counts; keep marketing numbers clearly labeled as marketing.
- Reuse one pricing-card component across product pages: base rate + à-la-carte add-ons with caps and disclosed pass-through fees — precedent for merchant-crypto fee communication (see `crypto.md`).
- Reuse one success-state component across all payment surfaces (Stripe reuses its "Payment succeeded" mock across Checkout and Links).

## Cross-references

Related files in this set: `public-pages.md` (survey index), `navigation.md` (hub/leaf sub-nav pattern), `connect.md`, `billing.md`, `crypto.md` (stablecoin payment method), `component-patterns.md` (state patterns), `developers.md`, `pay-swap-ux-mapping.md`, `README.md`.
