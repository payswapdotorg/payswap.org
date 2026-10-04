Status: PUBLIC-SURFACE RESEARCH — 2026-10-03 (P4-W1-003 Phase 1) — source: public Stripe docs via automated extraction, no authentication; authenticated dashboard survey is Phase 2 (operator-gated)

# Stripe workflow patterns — cross-source catalog of end-to-end flows

Each workflow: starting state → intent → steps → decision/confirmation points → errors → recovery → final state, with source notes cited. Sources: R1 `/tmp/research-r1/notes-payment-links.md`, `notes-checkout.md`, `SUMMARY.md`; R2 `/tmp/research-r2/notes-docs-disputes.md`, `notes-docs-stablecoins-suite.md`, `SUMMARY.md`; R3 `/tmp/research-r3/notes-account-onboarding.md`, `notes-test-mode.md`, `notes-payouts.md`, `notes-api-keys.md`, and the raw `webhooks.txt` fetch (R3's planned notes-webhooks.md was never written — its session broke; facts below come from the persisted raw fetch + R3 SUMMARY §h, as already recorded in `developers.md`).

## 1. Account signup / onboarding progression (R3 notes-account-onboarding.md, notes-test-mode.md)

- Start: no account. Intent: become a live merchant.
- Steps: create account → land in sandbox by default (full features, no money movement) → provide business/product/relationship info → KYC verification → per-service activation requirements → live mode.
- Decisions: origin country (immutable after live activation); public business info + statement descriptor (dispute-prevention framing).
- Errors: restricted industries → extra documentation; prohibited → cannot use Stripe.
- Recovery: settings editable in Account settings; dormant account recommended over closing (financial data/disputes).
- Final: activated account, live keys usable, go-live checklist available.

## 2. Checkout payment — no-code → API ladder (R1 notes-payment-links.md, notes-checkout.md, SUMMARY)

- Start: merchant with something to sell, variable technical skill. Intent: accept a payment.
- Steps by rung: Payment link (3 steps: create link → share → get paid; interactive configurator with live preview) → Checkout full page (hosted, "Try the demo" first) → Embedded form → Elements (custom components).
- Decisions: payment type (payment/subscription/donation), currency, CTA label; customer picks payment method (incl. stablecoins → crypto.stripe.com redirect + wallet connect).
- Errors: real-time card validation, descriptive localized errors, email-domain misspelling detection are showcased as in-flow handling.
- Recovery: cancel affordance in wallet flows; recovery emails for abandoned carts.
- Final: success state ("Payment succeeded… will appear on your statement") with receipt; funds to balance → payout schedule.

## 3. Dispute response (R2 notes-docs-disputes.md, SUMMARY §e; statuses cross-checked R3 notes-test-mode.md)

- Start: cardholder questions the payment with their issuer. Intent: keep the funds.
- Steps: issuer creates dispute on the network → payment "immediately reverses"; Stripe debits balance for amount + dispute fee → merchant notified → Dashboard-guided response: provide "text and images for the dispute reason, and your counterargument" → submit evidence (Disputes API for programmatic submission).
- Decisions: challenge or accept; evidence packet content per Network category (Visa/MC/Amex codes normalized).
- Deflection/prevention: Verifi/Ethoca auto-prevention; Smart Disputes automates evidence for eligible disputes; inquiries (warning_needs_response) refundable until escalated, no funds withdrawn unless disputed.
- Errors: needs_response deadline missed → lost by default (implied by status vocabulary won/lost/warning_closed).
- Recovery: analyze dispute rate, monitoring programs; public business info quality reduces future disputes (R3 onboarding).
- Final: won or lost; funds returned or forfeited; dispute history feeds risk signals.

## 4. Payout failure recovery (R3 notes-payouts.md)

- Start: payout submitted (pending → in_transit → paid). Intent: money actually arrives at the bank.
- Steps: bank returns funds → payout failed (up to 5 extra business days to learn; **status may regress from paid to failed within 5 business days**) → notification by email + Dashboard with failure reason (typed code) → merchant re-enters bank details in Payout settings → Stripe auto-retries at the next scheduled interval → **Resume Payouts** button reactivates.
- Decisions: which bank account/currency; schedule choice (manual/daily/weekly/monthly).
- Errors: no_account, account_closed, insufficient_funds, debit_not_authorized, invalid_currency, could_not_process; negative balance debits the bank.
- Recovery: as above; minimum-balance setting buffers refunds/disputes/fees.
- Final: paid; funds in bank; schedule continues.

## 5. Webhook endpoint setup (R3 raw webhooks.txt + SUMMARY §h)

- Start: integration with async events to consume. Intent: react automatically (bank confirms payment, dispute, recurring success).
- Steps: Workbench → Webhooks tab → **Create an event destination** → select account → select API version → select event types → Continue → destination type "Webhook endpoint" → endpoint URL + description → signing secret (whsec prefix) appears → **Reveal secret** and copy → build handler (verify Stripe-Signature over raw body; return 2xx fast, before complex logic).
- Decisions: which event types (only required ones — listening to all is an anti-pattern); test vs live endpoint separation.
- Errors: signature verification fails on raw-body manipulation; 3xx treated as failure; TLS < v1.2 rejected; timeouts from slow handlers.
- Recovery: retries up to 3 days exponential backoff (live); manual resend ≤15 days Dashboard / ≤30 days CLI; roll secret with ≤24h dual-active grace; Event deliveries tab shows Delivered/Pending/Failed per attempt.
- Final: verified, deduped (event-ID logging), order-independent event consumption.

## 6. API key rotation (R3 notes-api-keys.md)

- Start: live secret key in use, possibly exposed or on schedule. Intent: replace credential without downtime.
- Steps: "Create secret key" → step-up auth (verification code by email/text) → name → create → **one-time reveal** ("Save the key value. You can't retrieve it later.") → forced "Add a note" (where you saved it) → deploy new key gradually (subset of servers, watch request logs) → Rotate (expiration: now or future; countdown displayed) → old + new dual-active up to 7 days → expire old key only at zero request volume.
- Decisions: rotation timing; access-policy attachment (IP/ASN/country/Tor-blocking).
- Errors: expired key → authentication error; missing/invalid → invalid request error.
- Recovery: restore access for >180-day-inactive limited keys; managed keys rotated by hosting provider.
- Final: new key active, old retired, logs clean. (Agent-tagged keys add reviewer approval for sensitive actions.)

## 7. Test → live go-live (R3 notes-account-onboarding.md go-live section + notes-test-mode.md)

- Start: working sandbox integration. Intent: production traffic.
- Steps: run go-live checklist — set API version (Workbench; account settings govern) → handle edge cases (retry same request for duplicates; non-developer test) → review error handling (card_error user-facing vs invalid_request_error backend bug) → review logging → **recreate sandbox-only objects with the same ID values** (plans, products, coupons) → register production webhooks (delayed/duplicate/unordered tolerant) → **rotate and secure keys** → swap sandbox keys for live keys (keys determine mode, not Dashboard location) → exit sandbox via account picker.
- Decisions: cutover timing; team notification (announcements mailing list).
- Errors: live use of test objects fails; test numbers unusable with live keys (warning).
- Recovery: sandbox remains available for regression testing.
- Final: live integration; "Switching between them is mostly a matter of swapping your API keys."

## 8. Stablecoin activation (R2 notes-docs-stablecoins-suite.md)

- Start: verified merchant wanting crypto acceptance. Intent: accept stablecoin payments.
- Steps: request "Stablecoins and Crypto" payment method in Dashboard → Stripe reviews → **Pending** → active; regional gate (US all states except New York) → integrate via Payment Links / Checkout / Elements / Payment Intents (dynamic payment methods marked "Recommended") → customer redirected to crypto.stripe.com → wallet connect → funds settle in USD balance.
- Decisions: integration surface; dynamic vs static method exposure; testnet choice (Polygon Amoy, faucets).
- Errors: variant index pages for subscriptions (query params not honored — honest fetch gap); refund-contract edge case (review transaction_hash on a block explorer).
- Recovery/testing: testnet assets at no cost before activation.
- Final: crypto_payments capability active; $10k/transaction limit; no disputes on stablecoin payments. (Connect payouts variant: sales contact → ~2 business days → questionnaire → approval.)

## PaySwap implications

Every PaySwap external-write workflow (payment execution, settlement, capability activation, credential rotation) should be documentable in this start→intent→steps→decisions→errors→recovery→final grammar, with typed failure vocabularies and explicit recovery affordances (Resume-style buttons, grace windows, undo-where-reversible). See `pay-swap-ux-mapping.md` for derivations.

## Cross-references

Related files in this set: `onboarding.md`, `payments.md`, `risk.md` (disputes), `balances.md` (payout recovery), `developers.md` (webhooks/keys detail), `settings.md` (modes, step-up auth), `crypto.md` (stablecoin activation detail), `customers.md`, `search.md`, `component-patterns.md`, `pay-swap-ux-mapping.md`, `README.md`.
