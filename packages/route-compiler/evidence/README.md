# P4-W4-001 — Route Journey Evidence

Work Order: P4-W4-001 — Mixed Fiat/Onchain Route Compiler (`@payswap/route-compiler`)
Artifact: `route-journeys.json` (this directory) — deterministic journey evidence for the
four representative Money Movement Intents, built by `test/evidence-files.test.ts`.
Law marker (recorded in the file, asserted by the test):
`FIXTURE_PROVEN_LIVE_BROADCAST_IMPOSSIBLE_BY_LAW`.

## What the journeys file records

Ten `RouteJourneyEvidenceRecord`s — for each representative route shape, one HAPPY walk
(`ROUTE_COMPLETED_ALL_LEGS_OBSERVED`) and one honestly FAULTED walk
(`ROUTE_REQUIRES_RECONCILIATION`, an injected OUTCOME_UNKNOWN at a mid-route leg with
`blindRetryForbidden: true` and `SETTLEMENT_RECONCILIATION_AUTHORITY` as the only
resolver — INV-X01/X02/X03):

| Intent | Shape | Legs | Records |
| --- | --- | --- | --- |
| route-1 crypto→DEX→stablecoin→off-ramp→bank | `mixed-dex-offramp` | ONCHAIN_DEX_SWAP → ONCHAIN_TRANSFER → OFF_RAMP_PAYOUT → BANK_SETTLEMENT | happy + faulted |
| route-2 fiat→PSP→stablecoin→chain→recipient | `mixed-psp-onramp` | FIAT_PSP_COLLECT → PSP_STABLECOIN_ISSUANCE → ONCHAIN_TRANSFER | happy + faulted |
| route-3 chainA→DEX→bridge→chainB | `mixed-dex-bridge` | ONCHAIN_DEX_SWAP → ONCHAIN_BRIDGE | happy + faulted |
| route-4 eligible crypto→Stripe balance (Mode B) | `stripe-external-payswap-route` | ONCHAIN_DEX_SWAP → ONCHAIN_TRANSFER → OFF_RAMP_PAYOUT → BANK_SETTLEMENT | happy + faulted |
| route-4 eligible crypto→Stripe balance (Mode A) | `stripe-native-crypto-settlement` | STRIPE_CRYPTO_SETTLEMENT | happy + faulted |

Each record carries the compiled plan's digest and per-leg shapes with their authorization
kind, explicit custody transfer (from/to/via, exact amount, evidence refs) and planned
amount basis, plus the walked outcome (per-leg statuses, custody at stop, the
reconciliation plan when the journey honestly stopped). Every digest is the kernel's own
`contentDigest` over the canonical record projection; `file.digests[i]` re-digests
`file.journeys[i]`.

## How the journeys are produced (REAL kernels — no shadow models)

- the DEX hops run as REAL engine-selected lanes over the REAL Uniswap v2 reference venue
  pack (`createUniswapV2VenuePack` with injected deterministic pool state — the venue port,
  the v2 constant-product math and the INV-SC01 declarations are the pack's own);
- lane discovery, execution and evidence come from `@payswap/mixed-rail`
  (`executeOnchainLane`, which itself drives the `@payswap/best-execution` venue port and
  the canonical `@payswap/onchain-domain` settlement mapping);
- transfer/bridge legs run the `@payswap/onchain-security` write pipeline
  (prepare → deterministic gate → expected-state diff);
- the off-ramp payout hop is authorized by the REAL `@payswap/connectors` payout gate
  over an activation carrying a separate TransferOutAuthorization;
- the bank arrival is derived through the canonical `@payswap/payment`
  settlement-destination vocabulary (`settlementResultFrom`);
- the Stripe Mode A hop compiles only on provider-verified eligibility evidence and walks
  only to provider-verified settlement observations (`awaitingAuthority: "P4-W1-003"` —
  the actual integration honestly awaits that research authority);
- the opportunity context is resolved + policy-evaluated by the REAL `@payswap/onchain-opportunities`
  discovery kernel — routing context only, structurally never authorization.

## The fixture-proven law

Live broadcast is impossible by law in this tier: the execution walk is Lab-discipline
simulation (`LAB_EXECUTION_TIER = LAB_SIMULATION_NON_PRODUCTION`, INV-L01 — the Lab
runtime is driven from the test layer only; no `src/` imports it), and no route-compiler
artifact ever signs, broadcasts or moves real value. The records therefore prove exactly
what is provable here: the composed REAL kernels produce these journeys deterministically
from the pinned fixtures (same fixtures → same plans → same walks → same digests, verified
byte-identical across regenerations).

## Regeneration

```
ROUTE_COMPILER_WRITE_EVIDENCE=1 npx vitest run test/evidence-files.test.ts
```

(run from `packages/route-compiler`; deterministic — the committed file never drifts).
Without the flag the same test READS this file and verifies it: deep equality with the
freshly built journeys, every digest re-computed via `routeJourneyEvidenceDigest`, and
the law marker checked verbatim.
