Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe pages/docs via automated extraction, no authentication; this file derives PaySwap design contracts from Phase-1 observations only (no authenticated-session content)

# PaySwap UX mapping — from observed Stripe patterns to PaySwap design contracts

The core derivation file of the set. Every important pattern below is derived through the mandated chain: **OBSERVED STRIPE PATTERN → USER PROBLEM IT SOLVES → PAYSWAP EQUIVALENT → PAYSWAP-SPECIFIC MODIFICATION → IMPLEMENTATION CONTRACT**. The pattern line cites the file in this set holding the observation; everything downstream is PaySwap design work. Nothing here claims authenticated-session knowledge.

## Derivations

### 1. Global cross-resource search

- **Observed Stripe pattern** (`search.md`): fuzzy instant results while typing → grouped drill-down by resource → per-resource sortable tables; ~20-field `field:term` filter vocabulary with phrases, negation, flexible dates; URL-encoded shareable search state.
- **User problem it solves:** operators must find any money object fast without knowing where it lives.
- **PaySwap equivalent:** SEARCH/COMMAND over payments, customers, merchants, wallets, accounts, transactions, providers, chains, tokens, DEXs, capabilities, organizations, opportunities, security events, settlements, evidence.
- **PaySwap-specific modification:** command execution where authorization permits — "Pay Alice €100", "Show failed USDC payments", "Show today's settlement exceptions" — with search and command as separate internal concepts behind one surface; UNKNOWN states are searchable as first-class objects.
- **Implementation contract:** search is a read-only projection of protocol state (never a source of inferred finality); commands compile to a MoneyMovementIntent plus its authorization artifacts; every result carries object-model deep links.

### 2. Test/live + sandbox separation

- **Observed Stripe pattern** (`settings.md`, `developers.md`): sandboxes with isolated settings; keys determine mode, not Dashboard location; mode-locked objects; banner + field disabling where test settings could bleed into live.
- **User problem it solves:** safety when experimenting with real-looking money objects.
- **PaySwap equivalent:** TEST MODE / LIVE MODE, plus TESTNET / MAINNET where chains are involved.
- **PaySwap-specific modification:** mode is protocol-scoped and visually unambiguous everywhere (Directive B §13); no test transaction may appear to be a real financial transaction; demo/test paths share the one protocol pipeline — no fake settlement staged behind production UI.
- **Implementation contract:** mode is a typed scope rendered on every object view; test↔live crossover is structurally rejected by the protocol, not merely discouraged by copy.

### 3. Integration ladder

- **Observed Stripe pattern** (`payments.md`): Payment links (no-code) → Checkout hosted → embedded forms → full API, repeated as a first-class choose-your-path concept across the payments family.
- **User problem it solves:** merchants of every technical level must be able to start.
- **PaySwap equivalent:** the same ladder for crypto acceptance — no-code payment link → hosted crypto checkout (MerchantCheckoutSession) → API (MerchantPaymentIntent).
- **PaySwap-specific modification:** every tier produces authoritative protocol state; quote expiry and acceptance policy are enforced identically at every tier.
- **Implementation contract:** each tier maps onto the same intent/attempt/checkout contracts (@payswap/merchant-crypto); no tier can bypass policy, security, or evidence requirements.

### 4. Object-model navigation

- **Observed Stripe pattern** (`customers.md`, `balances.md`, + Directive B §7): payment detail pages link customer, payout, and balance transaction; the API's expand mechanism reaches four levels deep across objects.
- **User problem it solves:** money questions are cross-object — an operator never investigates one row in isolation.
- **PaySwap equivalent (the spine):** Payment → Customer → Payment attempt → Execution route → Provider/chain/protocol → Settlement → Finality → Evidence; and on the advisory side, Opportunity → Strategy → Organization → Capabilities → Execution → Result.
- **PaySwap-specific modification:** evidence and finality are first-class navigation targets (Stripe has no evidence-graph equivalent); UNKNOWN states link to their reconciliation cases rather than dead-ending.
- **Implementation contract:** every object detail page renders its relationship spine with deep links; no dead ends anywhere in the object graph.

### 5. Staged onboarding + checklist

- **Observed Stripe pattern** (`onboarding.md`): create account → sandbox-ready immediately → progressive per-service verification → activate; checklist progress cached in the browser, usable without login.
- **User problem it solves:** KYC complexity must not block starting.
- **PaySwap equivalent:** capability-entitlement onboarding — acceptance policies and routes activate per compliance state; the catalogue observes and requests, never authorizes (INV-C05).
- **PaySwap-specific modification:** crypto acceptance policy setup (assets, chains, quote validity) is a first-class onboarding step, not an advanced setting.
- **Implementation contract:** onboarding ends in an explicit entitlement state per capability — never an implied all-rails-available default.

### 6. Payout failure recovery

- **Observed Stripe pattern** (`balances.md`): failed payout → re-enter bank details → auto-retry at next interval → Resume Payouts button; a documented paid→failed regression window of up to five business days.
- **User problem it solves:** bank failures need operator-visible recovery, not silent retries.
- **PaySwap equivalent:** settlement attempts — a FAILED retry mints a NEW attempt (append-only history); OUTCOME_UNKNOWN is NEVER blindly retried (INV-X02) and exits only through reconciliation (INV-X03).
- **PaySwap-specific modification:** PaySwap's UNKNOWN is richer than Stripe's failure vocabulary because external ambiguity (chain reorgs, provider lag, partial fills) is a native case; the UI renders a reconciling state with case links, not a spinner.
- **Implementation contract:** retry actions are disabled on UNKNOWN objects; resolution requires evidence-bearing reconciliation records.

### 7. Pricing transparency grammar

- **Observed Stripe pattern** (`component-patterns.md` + R1 pricing notes in `billing.md`): Standard-vs-Custom two-tier frame; caps and minimums on line items; pass-through fees disclosed by name; promotional rates carry expiry dates.
- **User problem it solves:** fee trust — merchants must be able to predict and audit what they pay.
- **PaySwap equivalent:** exact integer fee presentation with per-component provenance (INV-F09); quotes are exact ratios, never floats.
- **PaySwap-specific modification:** crypto quotes carry a mandatory expiry and a source-capability reference, since rates are time-boxed and route-dependent.
- **Implementation contract:** every fee line links to its provenance artifact; an expired quote is unconstructible as an authorization basis.

### 8. Integrated risk

- **Observed Stripe pattern** (`risk.md`): Radar spans onboarding, payment, and post-purchase stages; score + named signals presentation; Smart Disputes automates evidence submission.
- **User problem it solves:** risk must be operational — inside the money flows — not a separate tool operators forget to open.
- **PaySwap equivalent:** security integrated into every lifecycle step (Directive B §12): onboarding, payment creation, checkout, wallet connection, signing, payout, DEX/bridge execution, merchant settlement.
- **PaySwap-specific modification:** deterministic BLOCK is non-overridable by agents or advisors (INV-S rules; architecture law); crypto-specific threats (malicious approvals, fake tokens, bridge risk) are presented in human terms next to the action they gate.
- **Implementation contract:** every security decision renders why + expected action + recommendation; blocks cite the violated invariant by ID.

### 9. Disputes never rewrite

- **Observed Stripe pattern** (`risk.md`): disputes are separate records with their own lifecycle, evidence packets, and reason-code categories; the original payment's history is never edited to pretend the dispute away.
- **User problem it solves:** financial history integrity — auditors and operators must trust the ledger.
- **PaySwap equivalent:** disputes create new records plus compensating obligations; a FINAL reversal happens only through an explicit recovery flow that references its compensating obligation.
- **PaySwap-specific modification:** none needed on the principle — the crypto difference (no chargebacks on push payments) changes the trigger set, not the append-only discipline.
- **Implementation contract:** original transactions are immutable; dispute workflows produce adjudication artifacts linked into the evidence graph.

### 10. Stablecoin acceptance semantics

- **Observed Stripe pattern** (`crypto.md`): crypto-in → fiat balance; no chargebacks; $10k per-transaction cap; testnet testing; review-gated activation; asset/network coverage that drifts between Stripe's own published pages.
- **User problem it solves:** merchants want crypto acceptance without crypto-operations burden.
- **PaySwap equivalent:** merchant prices fiat; customer pays eligible crypto; settlement has TWO route families — native Stripe crypto settlement (provider-verified only, PASS_THROUGH_NATIVE) vs PaySwap external conversion/off-ramp (composed, explicit conversion terms) — never conflated, never synthesized.
- **PaySwap-specific modification:** route family is a typed discriminant on every settlement route; any Stripe balance effect is provider-verified or UNKNOWN, never assumed.
- **Implementation contract:** @payswap/merchant-crypto settlement-route union plus StripeSettlementConfirmation (evidence-mandatory); adversarial tests include synthetic-balance probes to prove no route can fabricate a native settlement.

### 11. Apps/extensions marketplace

- **Observed Stripe pattern** (`apps.md`): embedded viewports + full-page apps, a component kit, a pattern library that doubles as a review accelerator, and installed-apps management in the Dashboard.
- **User problem it solves:** platform extensibility without core sprawl.
- **PaySwap equivalent:** the capability marketplace — DEX extensions, blockchain connectors, wallet connectors, off-ramps, security providers, accounting, analytics, merchant tools, AI agents, protocol capabilities.
- **PaySwap-specific modification:** extensions are capabilities in the graph — typed tokens, no direct ledger authority (INV-C04); an extension can observe and propose, never unilaterally move money.
- **Implementation contract:** every extension declares the §2A capability declaration set; installation creates a ConnectedCapabilityInstance, not authority.

### 12. Event destinations

- **Observed Stripe pattern** (`developers.md`): Workbench wizard for event destinations; 16-endpoint cap; 3-day exponential retry; event-ID dedupe; dual-secret rotation with a grace window.
- **User problem it solves:** reliable event integration despite flaky receivers.
- **PaySwap equivalent:** event destinations over the durable outbox; fast-ack + idempotent handling + event-ID dedupe (matches INV-F05 / INV-O01).
- **PaySwap-specific modification:** PaySwap events carry protocol-state provenance (which state transition, which evidence); UNKNOWN external effects emit reconciliation-required events rather than silence.
- **Implementation contract:** signature verification plus timestamp-based replay defense at every destination; secret rotation with an explicit dual-active grace window.

### 13. Documented state patterns

- **Observed Stripe pattern** (`component-patterns.md`): empty/loading/waiting/communicating-state are documented system patterns with rules (render order, filtered-empty vs no-data-empty, scope-matched spinners); "verifying status" is a docs topic in its own right.
- **User problem it solves:** honest async UX — users must know what the system is doing, not just that it is busy.
- **PaySwap equivalent:** the honest-states system — every surface renders protocol-derived status, including OUTCOME_UNKNOWN → reconciling (INV-X01).
- **PaySwap-specific modification:** UNKNOWN gets an actionable reconcile affordance, never a spinner-to-assumed-success.
- **Implementation contract:** UI state maps 1:1 from protocol state-machine states; no fake success states exist anywhere (certification law).

### 14. Task-routed reports with data SLA

- **Observed Stripe pattern** (`reports.md`): task→report routing before any report catalog; Balance (bank-statement) vs Payout reconciliation (clearing-account) mental models; a published 12-hour data SLA with named exceptions; Connect scoping incl. a subset drawer.
- **User problem it solves:** operators need answers, not report catalogs.
- **PaySwap equivalent:** reports as protocol projections with task routing; every aggregate row links to the underlying movements it summarizes (evidence all the way down).
- **PaySwap-specific modification:** settlement-exception and route-performance reports are PaySwap-specific — Stripe has no analogue for multi-route execution reporting.
- **Implementation contract:** reports are read-only projections; the data SLA is stated per report; UNKNOWN counts are surfaced separately from FAILED counts, never merged.

## PaySwap dashboard information architecture (proposal)

Revised from the Directive B §6 baseline. Top level (persistent nav):

1. **Home** — role-aware overview: a consumer sees Pay/Receive/Move quick actions plus recent activity; a merchant sees payments/balances/settlement exceptions plus to-do prompts (the Stripe Home pattern).
2. **Pay** — money-out entry (consumer payments, merchant payouts).
3. **Receive** — money-in entry (consumer requests; merchant payment links, hosted checkout, invoices).
4. **Move & Convert** — transfers, FX, and crypto off-ramp under one intent-level surface.
5. **Payments** — the object surface: all money movements with status, filters, saved views.
6. **Accounts** — external accounts/balances/wallets, clearly labeled as OBSERVATIONS (INV-C09), including connected Stripe accounts.
7. **Activity** — unified event stream (payments, security events, approvals, webhook deliveries).
8. **Opportunities** — the FinancialOpportunity surface (advisory; discovery is never authorization).
9. **Connections** — connect/review providers, wallets, chains (the Connect-pattern "accounts to review").
10. **Capabilities** — the marketplace/extensions surface.
11. **Security** — advisories, epochs, approvals, quarantine (integrated but inspectable).
12. **Reports** — task-routed protocol projections.
13. **Developers** — API keys, event destinations, sandboxes, TEST/LIVE + TESTNET/MAINNET controls.
14. **Settings** — account, team/roles, merchant acceptance policies (incl. the crypto acceptance policy).

Cross-cutting concerns:

- **(a) Global SEARCH/COMMAND** in the top bar (derivation 1).
- **(b) Mode switcher** (TEST/LIVE, TESTNET/MAINNET) persistent and visually unambiguous on every screen (derivation 2).
- **(c) Role density switch** (consumer/simple ↔ merchant/professional) changes Home composition and default columns, NEVER the object model — one product, two densities, not two products.
- **(d) Progressive disclosure:** expert fields (chain, tx hash, route, gas, slippage) hidden by default behind "details" affordances (Directive B §9/§10).

**Justification vs the Directive B §6 baseline.** The baseline verbs Pay/Receive/Move/Convert are kept, but Convert is merged into Move & Convert: four money-verb items at the top level diluted the nav, and Stripe's clearest IA lesson is few top-level entries with strong drill-down. Opportunities, Connections, Capabilities, and Security are promoted to first-class items: these are PaySwap-specific surfaces with no Stripe equivalent, and the universal-money mission requires them at the top level rather than buried. Accounts is framed as external observations (non-custodial honesty, INV-C09) rather than a "Balances" product — Stripe's Balances implies a custody PaySwap must never claim. Payments remains the single object surface for both roles, so the density switch never forks the object model.

## Cross-references

Related files in this set: every topic file feeds a derivation above — `search.md` (1), `settings.md`/`developers.md` (2, 12), `payments.md` (3), `customers.md`/`balances.md` (4, 6), `onboarding.md` (5), `billing.md`/`component-patterns.md` (7, 13), `risk.md` (8, 9), `crypto.md` (10), `apps.md` (11), `reports.md` (14); `navigation.md` (IA reasoning); `dashboard-pages.md` (Phase-2 validation of these hypotheses); `README.md` (set index).
