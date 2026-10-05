# @payswap/merchant-checkout

Work Order **P4-W2-003** — the merchant crypto checkout flow, end to end, on
the landed PaySwap primitives (map-and-extend; zero duplication):

```
merchant onboarding → crypto acceptance activation → checkout session →
customer wallet payment (REAL W1-002 kernel) → payment lifecycle →
webhooks/status → refunds → settlement (the two explicit Stripe paths)
```

## Module map

| Module | Owns |
|---|---|
| `src/onboarding.ts` | Typed merchant profile + the deterministic onboarding machine `DRAFT → SUBMITTED → VERIFIED → ACTIVE` (fail-closed on incomplete input; origin country immutable after activation; **no onboarding step may imply rail connectivity** — every onboarding artifact is structurally scanned for connectivity-implying vocabulary). The merchant is **fiat-denominated by default**; crypto acceptance is an explicit opt-in layered on top. Settlement destinations are consumed from the canonical `@payswap/payment` vocabulary (`MerchantSettlementDestination` with provenance). |
| `src/acceptance.ts` | Crypto acceptance activation — a **typed view over** the `@payswap/merchant-crypto` acceptance contract (the composed `MerchantCryptoAcceptancePolicy` is constructed through the landed `defineMerchantCryptoAcceptancePolicy`; every evaluation goes through the landed matchers). Activation requires a verified merchant; deactivation returns a NEW record and preserves the historical policy snapshot (immutable-history law). |
| `src/checkout.ts` | Checkout-session construction over the landed `openMerchantCheckoutSession`: customer-facing payment options with **quotes attached as observations** (expiry-at-boundary semantics) and displayed amounts **derived by exact cross-multiplication** (bigint, INV-F01), plus fiat fallback options from the merchant's base policy. The `RailAssetBinding` is the typed bridge between the merchant-crypto acceptance vocabulary (opaque `CryptoAssetId`/`ChainId`) and the W1-002 kernel vocabulary (structural `ChainRef` + 3-letter-symbol `AssetIdentity`), each side validated by its own owner. |
| `src/payment.ts` | The customer wallet payment **through the REAL W1-002 kernel**: prepare → simulate → deterministic gates → typed diff → authorize → recheck → broadcast handoff. This package composes the pipeline; it never reimplements signing, key handling or gate logic — the trusted approval surface and signer adapter are **injected** (rule 10). **Acceptance law**: the authorization bundle carries the human-readable payment summary (merchant, amounts, asset, chain, destination, fees, expiry) plus the typed diff — and the lifecycle layer requires the `WalletAuthorizationLineage` record on every wallet payment attempt, so a payment without explicit customer authorization lineage is **structurally unrepresentable**. |
| `src/lifecycle.ts` | PaymentAttempt lineage over the canonical machines: intent transitions through the landed `merchantPaymentIntentStateMachine`, attempt transitions through the landed helpers. Evidence mandatory for definitive outcomes (INV-E02); **UNKNOWN preserved** (INV-X01) with reconciliation the only exit (INV-X03); a re-observe is a new observation (`recordAmbiguityEvidence`), never a mutation of history; **blind-retry structurally forbidden** (there is no resubmit function; the landed machine declares SUBMIT only from PENDING). |
| `src/webhooks.ts` | Typed webhook event contracts (checkout-session updates, attempt transitions, settlement notifications, refund lifecycle) with an envelope `{eventId, eventType, occurredAt, payload}` and **idempotent processing by event id** (the same event id never applies twice; replays are classified DUPLICATE). **A webhook never creates authority**: processing runs the lifecycle rules; an illegal claimed transition is REJECTED with the typed reason, never force-applied. Status views are read-only projections. |
| `src/refunds.ts` | Refund initiation **only where the underlying rail supports refunds**: support arrives as a typed rail capability observation scoped to the ACTUAL rail (for the native Stripe family, to the genuinely connected instance — a `ProviderCatalogueEntry` throws `ConnectorAuthorityError`, INV-C05). Unsupported rails answer with the **typed `NOT_SUPPORTED` outcome** — never a silent rejection, never an implied future support. Refund lifecycle mirrors the payment laws (evidence, UNKNOWN preservation, reconciliation, immutable originals); the recourse vocabulary is the payment primitives' own `RecoursePolicyKind`. Native-family semantics follow the Stripe research law: refunds return as stablecoins to the customer's original wallet, partial supported, no chargeback path. |
| `src/settlement.ts` | Settlement policy per destination (schedule/threshold/denomination) — **configuration as typed data; no function turns a policy into an effect**. The Stripe connection model is a ProviderStateEnvelope-style lifecycle (connect/onboard/verify/restrict) built through the canonical `@payswap/connectors` envelope (INV-C06: raw provider state verbatim). The eligible-capability observation is scoped to the ACTUAL connected instance (rule 18). See below for the two explicit Stripe paths. |
| `src/api.ts` | The typed API-surface contracts for the merchant + customer journeys: one typed request union, one typed response union, one dispatch function walking the REAL package functions (the browser/API end-to-end evidence the acceptance criteria demand — deterministic, no I/O, trusted-surface deps injected). |
| `src/evidence.ts` | Journey evidence records — one digest-stable record per stage (onboarding → acceptance → checkout → wallet authorization → lifecycle → webhooks → refund → settlement), deterministic and regenerable (see `evidence/`). |

## The two explicit Stripe paths — §3.9 naming reconciliation (TL audit target)

The work item names the settlement modes `NATIVE_STRIPE_CRYPTO` and
`PAYSWAP_EXTERNAL_SETTLEMENT`; the **LANDED W1-003 route-family literals**
(in `@payswap/merchant-crypto`) are `NATIVE_STRIPE_CRYPTO` and
`EXTERNAL_PAYSWAP_CONVERSION`, and W4-001's route-compiler speaks Mode A /
Mode B over those same families. This package reconciles the two vocabularies
**without renaming the landed literals**:

- the **routing-level discriminator** is always the landed route-family
  literal (`MerchantCryptoSettlementRoute['routeFamily']`), consumed verbatim
  from `@payswap/merchant-crypto`;
- the **settlement-level discriminator** the work item names is introduced as
  a DOCUMENTED typed mapping on top:

  | settlement mode (work item) | landed route family |
  |---|---|
  | `NATIVE_STRIPE_CRYPTO` | `NATIVE_STRIPE_CRYPTO` |
  | `PAYSWAP_EXTERNAL_SETTLEMENT` | `EXTERNAL_PAYSWAP_CONVERSION` |

  with `settlementModeRouteFamily()` / `routeFamilySettlementMode()` as the
  two direction functions, and **disjoint fields both directions** on the
  mode configs (`assertSettlementModeDiscriminated` — a config carrying the
  other family's fields throws `SettlementModeConflationError`);

- `NATIVE_STRIPE_CRYPTO`: settlement through Stripe's own crypto settlement,
  available **only when the actual connected capability is eligible**
  (connected instance + observed eligibility at decision time); effects are
  provider-verified through the landed `recordStripeSettlementConfirmation`
  (constructor-set flags per the merchant-crypto law — a confirmation
  without provider evidence is a `SyntheticStripeBalanceError`);

- `PAYSWAP_EXTERNAL_SETTLEMENT` (maps onto `EXTERNAL_PAYSWAP_CONVERSION`):
  PaySwap converts/settles externally to the merchant's external destination
  — and wherever the native path is not eligible, the selection carries the
  **mandated honest-unavailability notice**, consumed VERBATIM from
  `@payswap/route-compiler`'s `STRIPE_NATIVE_SETTLEMENT_UNAVAILABLE_NOTICE`
  ("Stripe balance settlement unavailable for this route"), with a typed
  reason (`NO_CONNECTED_INSTANCE`, `AUTHORIZATION_NOT_ACTIVE`,
  `INSTANCE_NOT_ELIGIBLE`, `SETTLEMENT_CURRENCY_NOT_IN_SCOPE`,
  `MERCHANT_CONFIGURED_EXTERNAL`). The external settlement record
  structurally cannot carry a Stripe balance reference — it never implies
  Stripe balance settlement.

## Evidence

`evidence/merchant-checkout-journeys.json` — the fixture-proven journey
evidence (all eight stages, digest-stable, regenerable):

```
MERCHANT_CHECKOUT_WRITE_EVIDENCE=1 npx vitest run test/evidence-files.test.ts
```

Law marker: `FIXTURE_PROVEN_TRUSTED_SURFACE_SIGNING_ONLY` — the wallet
payment composes the REAL W1-002 kernel whose terminal state is
`BROADCAST_HANDOFF` (the kernel never broadcasts; the signed authorization
artifact is minted ONLY by the injected trusted approval surface). See
`evidence/README.md`.

## Laws exercised (selection)

INV-F01 (exact integer money everywhere — displayed amounts re-derived by
cross-multiplication), INV-X01/X02/X03 (UNKNOWN preserved, blind-retry
forbidden, reconciliation the only ambiguity exit), INV-E01/E02
(authorization + evidence lineage on every consequential record), INV-C05
(catalogue never authorizes — connected instances required at every
execution seam), INV-C06 (Stripe connection state in a ProviderStateEnvelope,
raw state verbatim), INV-C09-adjacent (no synthetic Stripe balance —
provider-verified effects only), AGENTS.md rules 10 (trusted-surface
signing), 18 (catalogue ≠ connected instance), 21 (provider balances are
observations), 25 (no secret material in any agent-facing artifact — the
kernel scanner runs in every constructor).

## Test battery

`npx vitest run` — contract tests for every typed shape, the full happy-path
journey through the REAL composed kernels, the adversarial suite
(authorization-without-explicit-signing unrepresentable; webhook replay
idempotency; UNKNOWN preservation at every external seam; catalogue-vs-
connected-instance confusion rejected; mode-field disjointness both
directions; refund on non-supporting rail = typed NOT_SUPPORTED;
floating-point money rejected; secret-bearing values rejected;
settlement-implied-without-eligibility rejected; historical record mutation
rejected), the API-surface end-to-end journeys, the evidence-file
regeneration law and the package boundary suite. Deterministic: seeded
fixtures, pinned instants, no time-of-day or random dependence.
