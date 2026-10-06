Status: NORMATIVE CONTRACT v1 — 2026-10-06 — derived from Stripe UX research Phase 2 (`payments.md`, `hosted-checkout.md`, `dashboard-pages-survey.md`) + Phase 1 `workflow-patterns.md`. Compliance MANDATORY for all PaySwap money-movement flows.

# PaySwap workflow contract

## 1. Principle

Every workflow is specified as: **intent → steps → states → errors → recovery**, with progressive disclosure (simple first, advanced behind "More options"). No workflow may dead-end: every failure state carries a human reason and a next action. (Directive §7–§11.)

## 2. Canonical workflows (normative set)

### W1 — Create a payment (merchant → customer request; the "Manual payment" analogue)
1. Entry: CreateMenu → "Pay" (`c p`), or Transactions page CTA.
2. Form: segmented One-time | Recurring · Amount (currency-prefixed, auto-format) · Currency · Counterparty (optional combobox "Find or add a contact…") · Description · Statement/note descriptor (auto-formatted; required when paying manually) · Funding rail section (radio: manual entry / on-file method / hosted link), dependent options disable WITH reasons.
3. Validation: per-field inline errors below fields; errors clear on fix; submit blocked until valid (never silent-drop).
4. Confirm: button restates amount+asset ("Send 25 USDC"); in-button Processing state; dual-submit "Send and create another" for repeat flows.
5. Success: navigate to the payment detail route (object exists immediately); failure: payment object created with `failed` state + human reason surfaced in list "Failure reason" column and detail header.

### W2 — Payment link (no-code collection; the "Payment link" analogue)
1. Entry: CreateMenu → "Payment link" (`c l`).
2. Sections: Select type → Product (combobox; unknown name offers **"Add '<name>' as new product"** inline modal: Name/Description/Image/Pricing One-off|Recurring) → Payment page options → After payment.
3. Options in tiers: basic (collect name/address/phone, limit payments) → advanced (custom fields, promo codes, save details, ToS consent). Every priced option states its fee inline (evidence: Managed Payments "adds a 3.5% fee per transaction").
4. **CTA wording selector**: Pay · Request · Donate — merchant picks the verb.
5. Live preview pane (payswap.link URL + "Use your domain") with live estimate ("1 × 25 USDC = 25 USDC · Total").
6. Result page: copyable link + **Add URL parameters** + **Embed button** + **Download QR code** + payment-methods list (Manage).

### W3 — Hosted payment page (payer side; the buy.stripe.com analogue)
1. Header: business name + environment badge (TESTNET on test links).
2. **Dual-amount line**: "You pay 25 USDC ≈ €23.10 — rate R, fee F" (Adaptive-Pricing evidence: "HK$229.73 · €25.00 — 1 EUR = 9.1892 HKD (includes 4% conversion fee)"). Conversion offered, never forced; both currencies visible pre-payment.
3. Order summary → optional email (only required identity) → method tabs (wallet/rail) → form with plain-words accepted methods + field microcopy ("3-digit code…").
4. Pay button restates amount; Processing state; inline validation blocks bad input.
5. Success screen: "Thanks — this will appear as <descriptor> in your wallet history" (statement expectation) + masked method + amount + receipt link. No forced account creation.

### W4 — Refund / reversal
1. Entry: primary action in payment detail header (next to amount+status).
2. Modal: amount prefilled (full) with partial-editable field · reason select (human labels) · explicit consequence line ("Returns to customer's wallet on <rail>; fees not returned").
3. Confirm → payment state → `refunded`/`partially_refunded`; event logged in human sentence; net balance updated with the reversal visible in Balances.

### W5 — Payout / settlement
1. Balances page leads with **Incoming vs Available** split; header carries [Withdraw/Pay out] + [Manage schedule] + [Add rail].
2. Schedule is a status, not a setting ("Settle daily" / "Every Friday").
3. Payout list: Amount · Status (in transit/arrived/failed) · Expected date · Net; failure rows carry reason + retry.

### W6 — Onboarding (first-run)
Persistent SetupGuide drives: verify account → secure wallet → activate first rail → create profile. Each step is a link; exactly one "Next:" at all times; capability surfaces stay usable in test mode throughout.

## 3. State design (all workflows)

- Terminal states: succeeded / failed / refunded / disputed / blocked / dropped — rendered by StatusChip with human tooltip.
- In-flight: processing + freshness + expected-time hint; never a red state.
- **Deadlines are columns and statuses** (evidence: "Evidence due by"; "Settle daily"; "VAMP standing: Projected good").
- Every workflow's empty list/zero state teaches the fill path (evidence: disputes empty state teaches test cards).

## 4. Error & recovery rules (normative)

1. Errors are human sentences with a reason vocabulary shared across flows (see `07-ERROR-STATE-CONTRACT.md`).
2. Failed operations create objects when partially executed (payment intent exists even on decline) — the audit trail never loses attempts.
3. Recovery affordances: Retry (same params) · Edit & retry · Contact/support link · for stuck ops an Investigate action.
4. Invalid deep-links/resources render the dedicated error page: name the resource, name the world (test/live), offer the best next hop (evidence: "Transaction not found… View all test mode payments").
5. No error may present as success; no toast-only errors; no stale validation after successful re-validation.

## 5. Acceptance

- Each W1–W6 has: a written flow spec in this contract, a test-mode walkthrough in the certification battery (§20), and instrumented states (empty, populated, processing, each error state).
- Grepping the app for workflows that lack a recovery affordance returns none.
- The dual-amount line (W3) appears on 100% of cross-rail/cross-currency confirmations.
