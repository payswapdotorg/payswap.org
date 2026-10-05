# P4-W2-003 — Merchant Checkout Journey Evidence

Work Order: P4-W2-003 — Merchant Crypto Checkout + Stripe Settlement
(`@payswap/merchant-checkout`)
Artifact: `merchant-checkout-journeys.json` (this directory) — deterministic
journey evidence for the full merchant flow, built by
`test/evidence-files.test.ts` from `test/journey-helpers.ts` (the REAL
composed functions — no mocks of this package's own code).
Law marker (recorded in the file, asserted by the test):
`FIXTURE_PROVEN_TRUSTED_SURFACE_SIGNING_ONLY`.

## What the journeys file records

One `MerchantCheckoutJourneyRecord` per stage, in flow order —
`MERCHANT_ONBOARDING` → `ACCEPTANCE_ACTIVATION` → `CHECKOUT_SESSION` →
`WALLET_AUTHORIZATION` → `PAYMENT_LIFECYCLE` → `WEBHOOK_UPDATES` → `REFUND`
→ `SETTLEMENT`. Each record carries its lineage refs, its evidence refs and
a content digest (the kernel's own `contentDigest` over the canonical record
projection); the wallet-authorization stage additionally carries the kernel
pipeline's append-only evidence log verbatim (the kernel walk:
PREPARED → SIMULATED → GATED_ALLOW → DIFF_READY → AUTHORIZED → RECHECKED →
BROADCAST_HANDOFF).

The recorded journey: a US merchant onboards (fiat-denominated, bank
settlement destination, verification lineage) → activates crypto acceptance
(composed merchant-crypto policy: USC on `ethereum:mainnet`, min/max bounds,
2 confirmations, 30s quote validity) → opens a checkout for a 99.00 USD cart
(exact quote: 10000 USC minor units at ratio 99/100 — cross-multiplication
exact; card fallback option present) → the customer authorizes with their
wallet through the REAL W1-002 kernel (simulation observed, gates ALLOW,
typed diff + human-readable payment summary shown, trusted-surface signed
artifact, passing pre-broadcast recheck, broadcast handoff receipt) → the
attempt is submitted and CONFIRMED with evidence (intent SUCCEEDED) → two
webhook events applied + one replay classified DUPLICATE → a partial refund
(49.50 USD) to the customer's original wallet on the native rail
(stablecoin-to-original-wallet observation) → settlement on the
NATIVE_STRIPE_CRYPTO path with a provider-verified Stripe settlement
confirmation and the protocol settlement-instruction mapping attached.

## How the journey is produced (REAL kernels — no shadow models)

- onboarding/acceptance/checkout: this package's own deterministic
  constructors composing the landed `@payswap/payment` acceptance/destination
  vocabulary and the landed `@payswap/merchant-crypto` contracts
  (`defineMerchantCryptoAcceptancePolicy`, `defineMerchantPaymentIntent`,
  `openMerchantCheckoutSession`, `defineCryptoQuote`);
- the wallet payment runs the REAL `@payswap/onchain-security` pipeline
  (`OnchainWritePipeline`: prepare → simulate → gates → diff → authorize →
  recheck → broadcast handoff), with the trusted approval surface and signer
  adapter as injected test doubles of the kernel's own PORTS (the same
  pattern as the kernel's test helpers — real signing belongs to the
  trusted surface, never to this package);
- the lifecycle transitions run the landed merchant-crypto machines
  (`merchantPaymentIntentStateMachine`, the attempt helpers);
- the settlement runs the landed
  `defineNativeStripeCryptoSettlementRoute` / `nativeStripeCryptoEligibility`
  / `recordStripeSettlementConfirmation` (provider-verified only).

## The fixture-proven law

Live signing/broadcast is impossible by construction in this tier: the
kernel's terminal state is `BROADCAST_HANDOFF` (the kernel never broadcasts),
and the signed authorization artifact is minted ONLY by the injected trusted
approval surface. No artifact of this package signs, broadcasts or moves
value. The records prove exactly what is provable here: the composed REAL
kernels produce this journey deterministically from the pinned fixtures
(same fixtures → same records → same digests, verified byte-identical
across regenerations).

## Regeneration

```
MERCHANT_CHECKOUT_WRITE_EVIDENCE=1 npx vitest run test/evidence-files.test.ts
```

(run from `packages/merchant-checkout`; deterministic — the committed file
never drifts). Without the flag the same test READS this file and verifies
it: deep equality with the freshly built journey, every digest re-computed
via `journeyRecordDigest`, and the law marker checked verbatim.
