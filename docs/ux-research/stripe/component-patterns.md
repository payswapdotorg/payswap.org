Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe docs via automated extraction, no authentication; authenticated dashboard survey is Phase 2 (operator-gated)

# Stripe component patterns — cross-source catalog (R1 marketing + R2 docs/apps + R3 dashboard docs)

A pattern catalog, not a page survey. Each entry: **observed form → user problem solved → PaySwap equivalent (one line)**. Full derivations live in `pay-swap-ux-mapping.md`. Sources cited as R1/R2/R3 notes files.
Observation method is static extraction (R1 marketing HTML, R2/R3 docs pages incl. `.md` views); interactive behaviors are inferred from markup/text, not executed — see per-file hedges.

## Navigation and disclosure

- **Mega-menus with aria-expanded** — Products/Solutions/Developers drawers with grouped name+descriptor items; 16 aria-expanded on home, 11 on product pages (R1 notes-home, notes-payments). Problem: huge catalog, small screen real estate, progressive reveal without navigation. PaySwap: command-center primary nav groups capabilities by merchant task, not by internal package.
- **Sticky sub-navs on hub products only** — /payments and /billing get sticky section tabs; leaf products (checkout, payment-links, terminal, invoicing) get none; /pricing gets a sticky category rail (R1 SUMMARY). Problem: long scroll pages lose wayfinding. PaySwap: sticky sub-nav on hub dashboards (Payments, Settlements), never on leaf object pages.
- **Code-language tabs** — 7-language tabs on checkout/payment-links code samples; Ruby/Python/PHP/Java/Node.js/Go/.NET on webhook handlers (R1 notes-checkout; R3 webhooks raw). Problem: developers shouldn't translate boilerplate. PaySwap: SDK tabs on every integration snippet.
- **Country/method switchers** — country carousel with localized payment-form mockups (iDEAL, Przelewy24, JCB); country tabs on bank-detail tables; regional-considerations tabs on stablecoin pages (R1 notes-checkout; R3 notes-payouts; R2 stablecoins). Problem: capability varies by jurisdiction. PaySwap: per-corridor/per-chain parameter surfaces, tabbed.
- **Native details/accordion FAQs** — only /billing uses native `<details>` accordions; other pages use static glossary lists (R1 notes-billing, SUMMARY). Problem: progressive disclosure without JS weight. PaySwap: native HTML disclosure for docs/FAQ surfaces.
- **URL-encoded application state** — Dashboard search terms live in the URL so views are bookmarkable/shareable (R3 notes-dashboard-search). Problem: handoffs and reproducibility. PaySwap: object views + filtered lists are linkable, deep-linkable evidence.
- **Progressive docs personalization** — checklists say "log in to see some of your current settings"; docs hydrate from account state when authenticated (R3 notes-account-onboarding). Problem: generic docs go stale per-user. PaySwap: capability docs reflect the merchant's activation state.

## Labels, pricing, and trust grammar

- **"Preview"/asterisk label system** — feature matrices mark pre-GA items "Preview" and add-on costs with asterisks; release-phase labels (private/public preview/GA) link to an explainer (R1 notes-billing/pricing; R2 stablecoins). Problem: users must price and trust maturity at a glance. PaySwap: capability cards carry release-phase + fee badges (stablecoin 1.5% precedent, R1 notes-pricing).
- **Dual-plan pricing pairs** — "Pay monthly | Pay as you go" with 30-day trials; Sigma monthly vs annual (R1 SUMMARY; R3 notes-reports). Problem: different buyer economics without separate pages. PaySwap: merchant plan pairs for subscription vs usage-based connector pricing.
- **Two-CTA hero pattern** — every product page: self-serve signup (product-scoped register URL) + Contact sales (R1 SUMMARY). Problem: self-serve and enterprise buyers both need a door. PaySwap: "Start in sandbox" + "Talk to us" on every capability page.
- **Sales chat with live-rep count** — widget showing available reps ("8 sales reps available… Chat now") on all pages (R1 SUMMARY). Problem: trust + instant human escalation. PaySwap: in-app support with honest availability state.
- **Live-UI mockups as marketing** — hero art is the actual product UI (checkout forms, dashboards, reader screens), not screenshots-of-slides (R1 SUMMARY §2). Problem: prove the product before signup. PaySwap: embed real read-only PaySwap object pages as marketing evidence.
- **State-marketing** — success/processing/pending/review queues and pending/en-route payouts shown as proof points (R1 notes-payments/checkout). Problem: operational maturity is the product. PaySwap: market INV-X01 state honesty — reconciling states as a feature, with mockups.

## States and feedback (documented Stripe Apps pattern library — R2 notes-docs-stripe-apps)

- **Empty state** — appears on first use, zero-result filters, or all-items-removed; title + description + action as call-and-response ("No customers yet" → "Add customer"); filtered-empty pairs with "Clear filters"; never show create-CTAs when items exist but are filtered; render order: loading → error → empty → content. Problem: empty screens read as broken. PaySwap: every list view (payments, settlements, security events) ships an explained empty state with a next action.
- **Loading pattern** — immediate indicator on fetch start; appropriate scope (full-page vs inline); Spinner `delay` to prevent flash (200–300ms fetches, 0ms known-slow, 100ms view transitions); keep tab bars visible and interactive. Problem: unresponsive feel + layout shift. PaySwap: loading is never a substitute for state; delays tuned per surface.
- **Waiting screens / communicating state / progress stepping** — dedicated Status-category patterns for long-running async work (R2 apps patterns index). Problem: async money movement needs expectation-setting UI. PaySwap: settlement/payout waits render progress + "communicating state" copy, never inferred finality.
- **Button `pending` prop** — pending visual style + disabled → prevents double submission without manual spinner wiring (R2 loading page). Problem: double-click double-pay. PaySwap: every money-moving button gets pending semantics (plus idempotency underneath).
- **Skeleton/spinner/toast/banner component kit** — sized spinners (large full-page / medium section / small inline), banner callouts for anti-patterns, toasts (R2 apps components). Problem: consistent feedback grammar. PaySwap: one state-component vocabulary across web + mobile.

## Dashboard ergonomics (R3 dashboard-adjacent docs)

- **Overflow (…) menu as universal row-level action surface** — key expire/rotate/restore, customer edit/delete, sandbox access all live in overflow menus (R3 notes-api-keys, notes-customers). Problem: dense tables stay scannable. PaySwap: object-row actions behind one consistent menu.
- **Dashboard/API tabs** — same task documented twice, tabbed, at the top of guides (R3 notes-customers; webhooks raw). Problem: no-code operators and developers share one doc. PaySwap: every merchant-crypto capability doc has UI-path and API-path variants.
- **Keyboard shortcuts** — "?" lists available shortcuts; N creates a customer (R3 notes-dashboard-basics, notes-customers). Problem: operator speed. PaySwap: shortcut affordances for power operators (search-first surface).
- **One-time reveal + note-to-future-self** — sensitive values shown once with a forced "Add a note" recording where they were saved (R3 notes-api-keys). Problem: lost-secret support burden. PaySwap: connector credentials/keys reveal once, then require rotation.
- **Step-up auth on sensitive creates** — verification code by email/text before creating a secret key; re-authenticate when creating access policies (R3 notes-api-keys). Problem: session theft escalates silently. PaySwap: step-up before credential + payout-config changes.
- **Test-trigger matrix** — routing/account number pairs map to deterministic payout outcomes; same for debit cards and instant eligibility (R3 notes-payouts, notes-test-mode). Problem: failure paths must be rehearsable. PaySwap: TESTNET fixtures that deterministically produce each settlement-failure code.
- **Disabled control as immutable-property signal** — locked currency shows as a disabled dropdown (R3 notes-customers). Problem: immutability must be visible, not surprising. PaySwap: origin chain, token contract, settled currency shown locked.
- **Documented destructive exception + undo** — payment-link deactivate needs no confirm, reactivation is the undo (R3 notes-mobile-responsive). Problem: confirmation fatigue. PaySwap: irreversible external writes confirm; reversible internal state changes may undo.
- **Callout grammar (Note/Caution/Warning)** — docs distinguish neutral notes (virtual-bank payout risk), cautions (paid→failed payout regression), and warnings (account API-version governance) (R3 notes-payouts, notes-account-onboarding). Problem: severity must be scannable. PaySwap: three-level callout vocabulary for docs + UI banners, reserved and consistent.
- **Collapsed per-country tables** — country tabs and collapsed tables hide long jurisdictional detail behind a default view (R3 notes-payouts). Problem: global parameter sprawl. PaySwap: per-chain/per-corridor config collapsed by default with a searchable picker.

## Cross-references

Related files in this set: `navigation.md` (nav taxonomy), `payments.md` (state-marketing detail), `billing.md` (Preview/asterisk system), `pricing evidence in public-pages.md`, `apps.md` (component kit, pattern library), `developers.md` (code tabs, keys), `customers.md` (overflow/Actions), `responsive.md` (mobile action bars), `search.md` (progressive drill-down), `workflow-patterns.md`, `pay-swap-ux-mapping.md`, `README.md`.
