Status: PHASE 2 (authenticated) — 2026-10-06 — live survey of buy.stripe.com hosted payment (test mode), exercised end-to-end with a test card.

# Hosted payment page (buy.stripe.com) — checkout form, Adaptive Pricing, success screen

## What this is

The Stripe-hosted payment page a payer sees when a merchant shares a payment link (or redirects to Checkout). This is the closest public analogue to PaySwap's consumer-facing payment surfaces — a **guest, non-technical payer** completing a money movement with zero product knowledge.

## Page anatomy (top to bottom)

1. **Header**: business name ("PaySwap sandbox") + **"Sandbox" badge** — the environment banner survives onto the customer-facing page in test mode; the payer can also tell they're in a test world.
2. **Choose currency** (Adaptive Pricing):
   > "HK$229.73 · €25.00 — 1 EUR = 9.1892 HKD (includes 4% conversion fee)"

   The payer sees BOTH amounts, the conversion rate, AND the fee — in one line, before paying. Conversion is offered (toggle between merchant currency and local), never forced.
3. **Order summary**: product name + amount ("UX Survey Product — HK$229.73").
4. "OR" divider.
5. **Contact information**: Email (single field; the only identity required for a guest payment).
6. **Payment method** tabs: Card + wallets (Link etc.).
7. **Card form**:
   - Accepted types spelled in words: "Visa, Mastercard, American Express, UnionPay, JCB, Discover, and Diners Club".
   - Field-level microcopy: CVC helper "3-digit code on back of card".
   - Cardholder name · Country or region (full localized country list).
   - Fields: `email`, `cardNumber`, `cardExpiry`, `cardCvc`, `billingName`, `billingCountry` — same-origin inputs on the hosted page (unlike embedded Elements).
8. **Pay button** carries the amount in its label and a Processing state ("Pay / Processing" — the label itself is the spinner's anchor).
9. Footer: "Powered by" (Stripe) · Terms · Privacy.

## Observed interaction behaviors

- Inline validation blocks submission with per-field messages (a malformed email blocked Pay until fixed — observed live: "examplecom" missing its dot stopped the payment; fixing the field re-enabled it).
- The card inputs format as you type ("4242 4242 4242 4242", "12 / 30").
- On success the page navigates to the checkout-session receipt URL (`/c/pay/cs_test_…`) — no intermediate interstitial.

## Success screen

> "Thanks for your payment
> A payment to Stripe will appear on your statement.
> Contact information: ux-survey@example.com
> Payment method: Visa ••••4242
> — HK$229.73
> Powered by · Terms · Privacy"

- Gratitude + **statement-descriptor expectation setting** ("A payment to Stripe will appear on your statement") — pre-empting the #1 chargeback cause (unrecognized statement lines).
- Masked payment method + amount breakdown; nothing else required of the payer (no account creation push).

## Derivation seeds (→ contracts)

- OBSERVED: dual-currency display + rate + fee in one pre-payment line → PROBLEM: FX surprise is the top trust killer in cross-border payments → PAYSWAP: every cross-rail payment shows "You pay X (asset/rail) ≈ Y (display currency) — rate R, fee F" before confirmation; PaySwap's sweep/route optimization makes this line the product's hero (contract: workflow + error-state).
- OBSERVED: environment badge on the payer-facing page → PAYSWAP testnet payment links show a TESTNET badge so demo links never confuse real payers.
- OBSERVED: statement-descriptor expectation on success → PAYSwap: success screens set the wallet-statement expectation ("This will appear as … in your wallet/app history") — the crypto analogue of descriptor confusion.
- OBSERVED: email as the only required identity → PaySwap guest payment = address/link + optional email for receipt; progressive identity, no forced account.
- OBSERVED: amount-in-button ("Pay HK$229.73") with in-button Processing state → PaySwap confirmation buttons always restate the exact amount+asset; no spinner-only buttons.
- OBSERVED: accepted-methods in plain words → PaySwap: supported wallets/chains named in human language next to the picker.
