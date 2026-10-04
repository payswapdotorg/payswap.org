Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe docs via automated extraction, no authentication; authenticated dashboard survey is Phase 2 (operator-gated)

# Stripe mobile and responsive patterns — live-only app, bottom tabs, documented destructive exception

Sources: R3 `notes-mobile-responsive.md` (docs.stripe.com/dashboard/mobile) + R3 SUMMARY §g; web-Dashboard browser-support policy from `notes-dashboard-basics.md`; marketing-page responsive evidence re-read from R1 `notes-home.md` / `notes-payments.md` viewport sections.

## Mobile app scope (native iOS/Android, 14 languages)

- Capability matrix is a subset of web, per platform: Monitor (charts, payment/customer lists + detail, push, search, widgets) / Accept (Tap to pay, payment links [iOS only], basic invoices, subscriptions [iOS only], manual card entry) / Manage payments (refunds incl. partial, receipts) / Payouts (view balances, initiate instant or standard, track bank transfers) / Customers (create/edit, card on file [iOS only], email) / Financial account (balances, history, details).

## Hard limitations (documented honestly)

- **"The app only displays live mode data"** — no sandbox/test mode on mobile; notable asymmetry vs the web Dashboard (keys/modes: see `settings.md`, `developers.md`).
- View-only role users can't create payments/refunds/payouts in app; inactive accounts and Support-specialist role users can't log in at all.
- **Bank linking is web-only** — external accounts (debit card/bank) can only be linked through the web Dashboard; mobile is view/initiate for that config.
- **iOS/Android feature asymmetry:** subscriptions, payment-link management, card-on-file are iOS-only; widgets differ (iOS 17+ lock-screen metrics vs Android 4 home-screen widgets).

## Interaction patterns

- **Bottom-tab navigation:** Payments / Balances / Customers + a **global plus (+) action at top right** (create customer, pay out funds, charge a card / send invoice, create payment link) — FAB-style universal create.
- **Bottom action bars on detail screens:** Refund, overflow menu (view/send receipt), Cancel subscription, Activate.
- Subscription creation is constrained to existing recurring prices (no price authoring on mobile); refund flow = select successful payment → Refund → amount → partial-refund toggle.
- **Documented no-confirmation destructive exception:** deactivating a payment link "immediately deactivates without a confirmation prompt" — with activate-as-undo: "reactivate it by tapping Activate". An explicit, documented exception to the confirm-before-destructive norm.
- Subscription cancel asks immediate vs end-of-period (a confirmation/decision point mobile does enforce).
- Charts are customizable per platform (iOS Edit; Android add/remove/reorder). Multi-currency chart display uses **sample exchange rates** with expectation-setting copy: estimates "won't exactly match with settled amounts".
- Onboarding to the app: create/log in (iOS can create from app) → 2FA + phone verification.

## Push notification taxonomy

- Daily summary; new payments; new customers; disputed payments; deposited transfers. Opt-in is OS-level notification permission.
- Widget metric examples: daily gross volume, new payments/customers, net volume; lock-screen: MRR, net volume from new sales, high-risk payments, dispute activity.

## Payout timing copy (mobile)

- Standard: industry/country/first-payout dependent; **first payout ~7 days**. Instant: card funds available as soon as the charge completes; ~30 minutes to bank after eligibility verification.

## Marketing-site responsive evidence (R1, static HTML)

- Viewport meta on all pages: width=device-width, initial-scale=1, viewport-fit=cover.
- **Duplicated H1/text blocks and nav content for mobile vs desktop variants** (home shows 2 H1s in markup — likely responsive variants); a "Back" button label present for the mobile nav drawer; mega-menus carry aria-expanded attributes (16 on home, 11 on payments/checkout).
- Sticky counts: 0 on home; 2–3 on product pages (global nav + mobile nav + chat).
- Skip link: not found in static HTML (hedge — may be injected at runtime).
- Web Dashboard browser-support policy: last 20 major versions of Chrome/Firefox/Edge; last 4 of Safari.

## PaySwap implications

- **Approval flows must be legible on phones:** PaySwap agent-approval rules, capability activation requests, and settlement-exception reviews will arrive by push and must be decidable from a bottom action bar without desktop fallback (Stripe proves review/confirm fits mobile; PaySwap adds approve/reject with evidence visible).
- **INV-X01 states must be legible on mobile:** UNKNOWN/reconciling, pending, in-transit — the mobile payout-tracking and balance surfaces are the precedent; PaySwap mobile must never compress ambiguous states into a spinner or a green check.
- The documented no-confirm exception + activate-as-undo shows the rule: reversibility can substitute for confirmation — PaySwap destructive actions over external money (irreversible on-chain) still require explicit confirmation; reversible in-app state changes may use undo instead.
- Live-only asymmetry is a deliberate scope decision, not an oversight — PaySwap should decide and document mobile mode parity explicitly (TESTNET visibility on mobile is a differentiator to consider, per Directive B §13).
- Platform asymmetry should be published as a capability matrix (Stripe's honesty pattern), not discovered by users.
- Bottom tabs + single FAB create + web-only config escape hatch is a coherent division: read + initiate + approve on mobile; configure on web.

## Honest gaps

- Real device rendering, gesture behavior, and app-store rollout states are not observable from docs; marketing-page responsive behavior is inferred from static markup (variants, stickies), not executed. The authenticated mobile app is Phase 2.

## Cross-references

Related files in this set: `settings.md` (modes, roles, live-only), `balances.md` (payouts on mobile), `search.md` (mobile search parity), `component-patterns.md` (action bars, state patterns), `workflow-patterns.md`, `onboarding.md` (2FA + phone verification), `navigation.md`, `pay-swap-ux-mapping.md`, `README.md`.
