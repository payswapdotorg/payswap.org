Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe docs via automated extraction, no authentication; authenticated dashboard survey is Phase 2 (operator-gated)

# Stripe balances and payouts — segmented balances, status vocabulary, failure recovery

Sources: R3 `notes-balances.md` (docs.stripe.com/api/balance/balance_object; the human-facing docs.stripe.com/balance page is a **soft 404** — see Honest gaps), `notes-payouts.md` (docs.stripe.com/payouts + api/payouts/object), R3 SUMMARY §c.

## Balance object model (API reference)

- Top-level **available** + **pending** arrays comprise the "payments balance".
- Each entry: amount (integer, smallest currency unit), currency, and a **source_types** breakdown (e.g., card) — balance is segmented **per currency AND per payment source type**, never one number.
- Optional segments: **instant_available** (Instant-Payouts-eligible funds), **connect_reserved** (Connect-only reservation), **issuing** (issuing balance), **refund_and_dispute_prefunding**.
- A `livemode` boolean on the object itself — test/live distinction embedded in every object.
- Ledger linkage: balance ← balance_transactions; balance → payouts (destination bank account/debit card) → top-ups; Connect adds connect_reserved + per-connected-account balances.

## Pending → available lifecycle

- Settlement timing ("T+X") governs when funds move pending → available; Stripe counts from transaction time; business-day vs calendar-day definitions are documented separately.
- Per-method settlement timing: ACH 4bd, SEPA DD 6bd, Bacs 4bd, AU/NZ BECS 2bd, PAD 5bd, USD bank transfers 5bd — bank methods slower due to reversal risk.
- Accelerators: 2-day ACH (US eligible); Instant Payouts any time incl. weekends (~30 min, eligibility check in Dashboard, new users not immediately eligible).
- **Negative balances:** refunds can drive the balance below zero → Stripe creates a payout that **debits the bank account**; the bank must support credit AND debit; a minimum-balance setting buffers refunds/disputes/fees. Below minimum-payout floors, funds are retained in the Stripe account (an explicit "insufficient balance" retention state).

## Payout status vocabulary (Payout object)

- Enum: **pending → in_transit → paid | failed | canceled** (pending until submitted to the bank).
- **Documented status regression:** a payout "might initially show as paid, but then change to failed within 5 business days" — banks return funds up to ~5 extra business days after submission. Stripe surfaces this honestly rather than hiding it.
- Key attributes: arrival_date (factors weekends/holidays), statement_descriptor (22-char cap; NACHA 10-char truncation for US ACH), method (standard/instant), automatic boolean, failure_code/failure_message, reconciliation_status, trace_id, metadata. Endpoints incl. cancel and reverse.
- Create errors: "Insufficient Funds" if balance short; invalid routing number at create.
- **Failure codes:** no_account, account_closed, insufficient_funds, debit_not_authorized, invalid_currency, could_not_process (card), plus instant-ineligibility flags for some cards. Test triggers map routing/account numbers to deterministic outcomes (test values usable only with test keys).

## Schedules and configuration

- Schedule options: manual / daily / weekly / monthly with day pickers; monthly adjustment rule (31st → last day; non-business days roll forward); timezone note (UTC except APAC).
- Country presets: BR/IN always automatic + daily; JP no daily; TH default daily.
- Multiple bank accounts per settlement currency + mandatory default settlement currency (unconfigured currencies auto-convert to default); bank currency must match Payout settings currency.
- Minimum payout amounts: banking-partner floor (typically one base unit of local currency; per-country table collapsed by default).
- First payout 7–14 days (industry/country/risk); failure notification by email + Dashboard.

## Failure recovery flow

1. Payout **failed** (email + Dashboard notification, with reason).
2. Merchant re-enters bank details (Payout settings → Edit).
3. Stripe **auto-retries at the next scheduled interval** — no manual re-trigger required.
4. **Resume Payouts** button reactivates payouts after resolution (explicit recovery affordance, not a buried setting).

## PaySwap implications

- **External balances are observations (INV-C09):** provider/exchange/wallet balances PaySwap displays are observations of external state, never PaySwap custody — mirror Stripe's segmentation (available/pending per currency × source) but label the source and freshness of every segment.
- **Honest status vocabulary:** copy the paid→failed regression honesty — PaySwap external-settlement states must include a provider-side reversal window and render ambiguity as UNKNOWN/reconciling, never inferred success (INV-X01).
- Failure codes as a typed, enumerable vocabulary (not free-text errors) — map provider failure reasons into PaySwap settlement-attempt failure taxonomy, preserving provider state verbatim (INV-C06).
- Retention states (below-minimum funds, negative balance) are legitimate UI states with explanatory copy, not edge cases.
- Recovery = re-enter → auto-retry → explicit Resume action: PaySwap settlement retry UX should separate "fix the inputs" from "resume the flow" the same way (and never blind-retry, INV-X02).
- Schedules + country presets + minimums: PaySwap merchant settlement configuration needs the same explicit, per-corridor parameter surface.

## Honest gaps

- docs.stripe.com/balance is a soft 404 (HTTP 200 with "Page not found" body); the user-facing Balances Dashboard page (charts, breakdown panels) is **not observable** from fetched content — only the API object, payouts doc, reports, and mobile references above. The 404 page also reveals a signed-in-only docs tier ("sign in" for early-access docs) which was not attempted. Balance-page UX is Phase 2.

## Cross-references

Related files in this set: `reports.md` (balance-summary reconciliation model; 12h SLA), `search.md` (amount:, status:, currency: filters), `settings.md` (payout/bank settings, modes), `connect.md` (per-connected-account balances, instant vs standard payouts), `onboarding.md` (bank-info review as payout-delay prevention), `crypto.md` (stablecoin balances/payout semantics), `workflow-patterns.md` (payout failure recovery), `pay-swap-ux-mapping.md`, `README.md`.
