# Cross-Provider Conformance Certification (P2-W2-003)

The common certification suite across all production providers (Phase 2
Wave 3, Worker 2). Work order: `spec/phase-2/work-items/P2-W2-003.md`.

## What it is

Every production provider with a merged connector is certified against the
**13 lifecycle scenarios** of the work order, through the **four shared
PaySwap gates** — the same gates for every provider, exactly as the work
order's second acceptance line demands:

| Gate | Law | Proof |
| --- | --- | --- |
| AUTHORIZATION | INV-NC04 | fail-closed: no credential → the connector REFUSES the effectful operation BEFORE any provider call (armed scripted transport; zero recorded calls is the proof) |
| EVIDENCE | INV-C06 | ProviderStateEnvelope losslessness: every envelope survives serialize → parse with external id + provider identity preserved |
| RECONCILIATION | INV-X03 | recovery by external id: the re-fetch reproduces the same (external id, revision, family, lifecycle step) |
| SECURITY | secret hygiene | byte-scan of every product the scenario produced: no synthetic key material, no live-key patterns |

The 13 scenarios: CUSTOMER_ACTION_REQUIRED, ASYNC_PROCESSING, CAPTURE,
RECURRING_MANDATE, REFUND, DISPUTE, PAYOUT, DUPLICATE_SUBMISSION,
WEBHOOK_LOSS, PROVIDER_OUTAGE, UNKNOWN, PROVIDER_REVISION_CHANGE,
FALLBACK_RE_AUTHORIZATION.

## How it runs

- **Contract level, offline by construction**: the providers' OWN mapping
  code (status tables, envelope builders, webhook verifiers, idempotency
  derivations, connector SDK paths) runs over SYNTHETIC fixtures on a
  scripted `HttpTransport` that records every call. No live provider is
  contacted; no financial effect is simulated.
- **Deterministic**: a fixed conformance epoch, no wall-clock or RNG reads;
  two full runs produce byte-identical reports.
- **In the battery**: `packages/journeys/test/conformance.test.ts` runs the
  full matrix on every `npm test` — the certification is repeatable
  evidence, not a one-time record.

## The matrix (2026-10-02, main)

39 pairs = 31 executed **all PASS** + 8 NOT_APPLICABLE with honest declared
bases:

- **stripe** (2025-08-27.basil): 13/13 executed PASS
- **paystack**: 9/9 executed PASS + 4 N/A (no manual-capture flow, no
  provider mandate object, no dispute surface, no payout family — each with
  the capability-vocabulary basis)
- **flutterwave** (v3): 9/9 executed PASS + 4 N/A (same classes, with the
  wallet-observation vs payout-execution distinction carried)

Extending the set: add a `ProviderConformanceProfile` (declared
applicability from the provider's OWN capability ids — never assumed) to
`conformanceProfileSet` in `src/conformance/runner.ts`; the runner and the
battery pick it up with zero changes.

## Structure

- `src/conformance/model.ts` — the 13 scenario ids, applicability
  vocabulary, artifact/report types, the scripted transport, determinism
  anchors
- `src/conformance/profile.ts` — the profile contract (lifecycles, webhook
  contract, SDK probes, secret-material markers)
- `src/conformance/profiles-{stripe,paystack,flutterwave}.ts` — the
  declared profiles
- `src/conformance/scenarios.ts` — the 13 scenario definitions (execution +
  lifecycle checks), composing the REAL subsystems (INV-X01 classifier,
  ProviderRevisionLedger, SettlementReconciliationAuthority, webhook
  ingestors, RailIncidentRecorder, coverage-gap vocabulary)
- `src/conformance/gates.ts` — the four shared gates
- `src/conformance/runner.ts` — the matrix runner + report + summary
- `test/conformance.test.ts` — the battery evidence
