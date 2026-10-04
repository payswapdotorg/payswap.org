/**
 * Failure injection at EVERY leg (Work Order P4-W4-001 task-packet hard
 * requirement 6): every leg of every representative route is faulted with
 * every applicable fault kind, and the outcome is ALWAYS honest:
 *
 * - OUTCOME_UNKNOWN stays UNKNOWN (INV-X01) and routes the partial state to
 *   reconciliation exactly like the single-rail lifecycle — blind retry
 *   forbidden (INV-X02), SETTLEMENT_RECONCILIATION_AUTHORITY the only
 *   resolver (INV-X03, the onchain-adapters reconcile pattern);
 * - a definitive failure stops the route — downstream legs are NOT_EXECUTED
 *   with their honest reason, never silently executed, never coerced;
 * - a submitted-not-final hop stops the route with the honest pending state
 *   (rule 29: submitted ≠ finality);
 * - a stale grounding is never executed (re-observe law);
 * - walking an ineligible plan is fail-closed (never fabricated execution);
 * - the custody position at the stop is recorded honestly at every stop.
 */

import { describe, expect, it } from "vitest";
import { createUniswapV2VenuePack } from "@payswap/onchain-venues/uniswap";
import {
  compileBase,
  route1Intent,
  route2Intent,
  route3Intent,
  route4Intent,
  makeFiatObservation,
  ONCHAIN_FINALITY_MODES,
  NOW,
  NOW_ISO,
  USC_ASSET,
  ETH_ASSET,
} from "./fixtures.js";
import { walkRoutePlan } from "../src/index.js";
import type { RoutePlan, RouteLegFault } from "../src/index.js";

function planOf(intent: Parameters<typeof compileBase>[0], shapeId: string): RoutePlan {
  const result = compileBase(intent);
  const plan = result.plans.find((plan) => plan.shapeId === shapeId);
  if (plan === undefined) {
    throw new Error(`fixture plan '${shapeId}' did not compile — fixtures never fabricate`);
  }
  return plan;
}

function walkWith(plan: RoutePlan, faults: Record<string, RouteLegFault>) {
  return walkRoutePlan({
    plan,
    at: NOW,
    observedAtIso: NOW_ISO,
    onchainFinalityModels: ONCHAIN_FINALITY_MODES,
    faults,
  });
}

const ONCHAIN_FAULTS: RouteLegFault[] = [
  {
    kind: "ONCHAIN_PROTOCOL_FAILURE",
    failureClass: "REVERTED",
    description: "the simulated chain reverted the operation",
    retryGuidance: "SAFE_TO_RETRY",
  },
  { kind: "ONCHAIN_UNFINALIZED_BROADCAST" },
  { kind: "ONCHAIN_OUTCOME_UNKNOWN", reason: "a reorganized receipt left the outcome ambiguous" },
];

const FIAT_FAULTS: RouteLegFault[] = [
  { kind: "FIAT_OUTCOME_UNKNOWN", reason: "the provider API timed out mid-payout" },
  { kind: "FIAT_DEFINITIVE_FAILED", reason: "the provider rejected the payout beneficiary" },
];

const STRIPE_FAULTS: RouteLegFault[] = [
  { kind: "STRIPE_OUTCOME_UNKNOWN", reason: "the Stripe verification endpoint was unreachable" },
];

/** Every plan whose legs are all fault-injectable, with their applicable fault sets. */
function injectablePlans(): {
  readonly label: string;
  readonly plan: RoutePlan;
  readonly faultsFor: (legKind: string) => readonly RouteLegFault[];
}[] {
  const onchain = (legKind: string): readonly RouteLegFault[] =>
    legKind === "STRIPE_CRYPTO_SETTLEMENT"
      ? STRIPE_FAULTS
      : legKind === "ONCHAIN_DEX_SWAP" ||
          legKind === "ONCHAIN_TRANSFER" ||
          legKind === "ONCHAIN_BRIDGE"
        ? ONCHAIN_FAULTS
        : FIAT_FAULTS;
  return [
    { label: "route-1 mixed", plan: planOf(route1Intent(), "mixed-dex-offramp"), faultsFor: onchain },
    { label: "route-1 native", plan: planOf(route1Intent(), "provider-native-offramp"), faultsFor: onchain },
    { label: "route-2 mixed", plan: planOf(route2Intent(), "mixed-psp-onramp"), faultsFor: onchain },
    { label: "route-2 native", plan: planOf(route2Intent(), "provider-native-onramp"), faultsFor: onchain },
    { label: "route-3 mixed", plan: planOf(route3Intent(), "mixed-dex-bridge"), faultsFor: onchain },
    { label: "route-3 native", plan: planOf(route3Intent(), "provider-native-bridge"), faultsFor: onchain },
    {
      label: "route-4 native stripe",
      plan: planOf(route4Intent(), "stripe-native-crypto-settlement"),
      faultsFor: onchain,
    },
    {
      label: "route-4 external",
      plan: planOf(route4Intent(), "stripe-external-payswap-route"),
      faultsFor: onchain,
    },
  ];
}

describe("failure injection at every leg — UNKNOWN/reconciliation semantics preserved", () => {
  for (const { label, plan, faultsFor } of injectablePlans()) {
    for (const leg of plan.legs) {
      for (const fault of faultsFor(leg.legKind)) {
        it(`${label}: leg ${leg.legKind} + ${fault.kind} → honest outcome`, () => {
          const result = walkWith(plan, { [leg.legId]: fault });
          const execution = result.legExecutions.find((e) => e.legId === leg.legId);
          expect(execution).toBeDefined();

          if (fault.kind === "ONCHAIN_OUTCOME_UNKNOWN" || fault.kind === "FIAT_OUTCOME_UNKNOWN" || fault.kind === "STRIPE_OUTCOME_UNKNOWN") {
            // INV-X01: UNKNOWN is honest, never coerced to FAILED or success.
            expect(execution!.status).toBe("OUTCOME_UNKNOWN");
            expect(result.status).toBe("ROUTE_REQUIRES_RECONCILIATION");
            expect(result.reconciliation).toBeDefined();
            expect(result.reconciliation!.blindRetryForbidden).toBe(true);
            expect(result.reconciliation!.resolver).toBe("SETTLEMENT_RECONCILIATION_AUTHORITY");
            expect(result.reconciliation!.reasons.length).toBeGreaterThan(0);
            expect(result.reconciliation!.externalChecks.length).toBeGreaterThan(0);
            expect(execution!.eventCandidate).toEqual({
              kind: "EVENT_CANDIDATE",
              event: "OUTCOME_UNKNOWN",
            });
          } else if (fault.kind === "ONCHAIN_PROTOCOL_FAILURE" || fault.kind === "FIAT_DEFINITIVE_FAILED") {
            expect(execution!.status).toBe("DEFINITIVE_FAILED");
            expect(result.status).toBe("ROUTE_STOPPED_DEFINITIVE_FAILURE");
            expect(execution!.failure).toBeDefined();
            expect(execution!.failure!.retryGuidance).toBe(
              fault.kind === "ONCHAIN_PROTOCOL_FAILURE" ? "SAFE_TO_RETRY" : "REQUIRES_RECONCILIATION",
            );
          } else if (fault.kind === "ONCHAIN_UNFINALIZED_BROADCAST") {
            // rule 29: submitted ≠ finality; the route honestly pends.
            expect(execution!.status).toBe("SUBMITTED_NOT_FINAL");
            expect(result.status).toBe("ROUTE_PENDING_FINALITY");
            expect(result.reconciliation).toBeUndefined();
          }

          // Downstream legs are NEVER executed on an unresolved route.
          const legIndex = plan.legs.findIndex((candidate) => candidate.legId === leg.legId);
          for (let downstream = legIndex + 1; downstream < plan.legs.length; downstream += 1) {
            const downstreamExecution = result.legExecutions[downstream]!;
            expect(downstreamExecution.status).toBe("NOT_EXECUTED");
            expect(downstreamExecution.notExecutedReason).toContain("never execute");
          }

          // The value position at the stop is recorded (no hidden custody).
          expect(result.custodyAtStop).toBeDefined();
        });
      }
    }
  }

  it("a failed leg never corrupts the honest state of the rest of the route", () => {
    const plan = planOf(route1Intent(), "mixed-dex-offramp");
    const result = walkWith(plan, {
      [plan.legs[2]!.legId]: { kind: "FIAT_OUTCOME_UNKNOWN", reason: "payout ambiguous" },
    });
    // Upstream legs keep their observed finality candidates.
    expect(result.legExecutions[0]!.status).toBe("OBSERVED_FINALITY_CANDIDATE");
    expect(result.legExecutions[1]!.status).toBe("OBSERVED_FINALITY_CANDIDATE");
    // The faulted leg is UNKNOWN with its reason.
    expect(result.legExecutions[2]!.status).toBe("OUTCOME_UNKNOWN");
    // The whole partial route routes to reconciliation.
    expect(result.status).toBe("ROUTE_REQUIRES_RECONCILIATION");
    expect(result.reconciliation!.reasons.join(" ")).toContain("value position between");
  });

  it("reconciliation records the custody ambiguity of the UNKNOWN hop (INV-X02)", () => {
    const plan = planOf(route1Intent(), "mixed-dex-offramp");
    const result = walkWith(plan, {
      [plan.legs[1]!.legId]: {
        kind: "ONCHAIN_OUTCOME_UNKNOWN",
        reason: "the deposit transaction receipt vanished after a reorg",
      },
    });
    expect(result.reconciliation!.reasons.join(" ")).toContain("wallet:0x1111");
    expect(result.reconciliation!.reasons.join(" ")).toContain("provider:psp-mock");
    expect(result.reconciliation!.blindRetryForbidden).toBe(true);
  });

  it("an onchain definitive failure carries the kernel failure descriptor verbatim", () => {
    const plan = planOf(route1Intent(), "mixed-dex-offramp");
    const result = walkWith(plan, {
      [plan.legs[0]!.legId]: {
        kind: "ONCHAIN_PROTOCOL_FAILURE",
        failureClass: "INSUFFICIENT_FUNDS",
        description: "the wallet could not fund the swap input",
        retryGuidance: "NOT_RETRYABLE",
      },
    });
    const execution = result.legExecutions[0]!;
    expect(execution.status).toBe("DEFINITIVE_FAILED");
    expect(execution.failure?.failureClass).toBe("INSUFFICIENT_FUNDS");
    expect(execution.failure?.description).toContain("could not fund");
    expect(execution.failure?.retryGuidance).toBe("NOT_RETRYABLE");
    // Nothing moved: custody stays at the origin wallet.
    expect(result.custodyAtStop?.party.kind).toBe("ONCHAIN_WALLET");
    // The rail outcome is the kernel's own vocabulary, verbatim.
    expect(execution.onchain?.railOutcome.kind).toBe("RAIL_EFFECT_FAILED");
    expect(execution.eventCandidate).toEqual({ kind: "EVENT_CANDIDATE", event: "CONFIRM_FAILED" });
  });

  it("an unfinalized broadcast produces the canonical pending rail effect (rule 29)", () => {
    const plan = planOf(route1Intent(), "mixed-dex-offramp");
    const result = walkWith(plan, {
      [plan.legs[0]!.legId]: { kind: "ONCHAIN_UNFINALIZED_BROADCAST" },
    });
    const execution = result.legExecutions[0]!;
    expect(execution.onchain?.railOutcome.kind).toBe("RAIL_EFFECT_PENDING");
    expect(execution.onchain?.observation.finalityCandidate).toBeUndefined();
    expect(execution.eventCandidate).toEqual({ kind: "NO_EVENT", reason: "SUBMITTED_NOT_FINAL" });
  });
});

describe("stale groundings are never executed (the re-observe law)", () => {
  it("a stale fiat observation marks the plan ineligible and the walk fails closed", () => {
    const result = compileBase(route2Intent(), {
      fiatObservations: [
        makeFiatObservation({
          instanceId: "instance:native-routing:1",
          observedAt: "2026-10-02T22:00:00Z",
        }),
        makeFiatObservation({
          instanceId: "instance:psp-payouts:1",
          observedAt: "2026-10-02T22:00:00Z",
        }),
      ],
    });
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-psp-onramp");
    expect(plan).toBeDefined();
    expect(plan!.candidateStatus).toBe("INELIGIBLE_CANDIDATE");
    expect(() =>
      walkRoutePlan({
        plan: plan!,
        at: NOW,
        observedAtIso: NOW_ISO,
        onchainFinalityModels: ONCHAIN_FINALITY_MODES,
      }),
    ).toThrow(/INELIGIBLE_CANDIDATE/);
  });

  it("a stale pool state excludes the DEX hop honestly (the engine's stale-routes law)", () => {
    const stalePack = createUniswapV2VenuePack({
      pools: [
        {
          pairId: "pair:eth-usc-stale",
          assetA: USC_ASSET,
          assetB: ETH_ASSET,
          reserveAMinorUnits: "1000000000000",
          reserveBMinorUnits: "333333333333333333",
          freshness: { asOfMs: NOW - 60_000, maxAgeMs: 10_000 },
          provenance: {
            providerName: "route-compiler-fixture-indexer",
            source: "INDEXED_POOL_STATE",
            capturedAtMs: NOW - 60_000,
            evidenceRefs: ["evidence:pool-state:pair-eth-usc-stale"],
          },
          observer: {
            observerId: "observer:route-compiler-indexer",
            observerKind: "INDEXER",
          },
        },
      ],
    });
    const result = compileBase(route1Intent(), { venuePacks: [stalePack] });
    expect(
      result.plans.some((plan) => plan.shapeId === "mixed-dex-offramp"),
    ).toBe(false);
    const exclusion = result.exclusions.find((e) => e.shapeId === "mixed-dex-offramp");
    expect(exclusion).toBeDefined();
    expect(exclusion!.reasons[0]).toContain("NO_EXECUTABLE_ROUTE");
  });

  it("a stale input-asset observation excludes the lane as UNPROVED GROUNDING (never executed)", () => {
    const result = compileBase(route1Intent(), {
      assetObservations: [
        {
          observationKind: "AssetObservation",
          observationId: "route-obs:eth:stale:1",
          observedAt: NOW_ISO,
          assetId: "ethereum:mainnet/asset:ETH",
          chainKey: "ethereum:mainnet",
          location: { chainKey: "ethereum:mainnet", accountRef: "0x1111111111111111111111111111111111111111" },
          observedAmount: { currency: "ethereum:mainnet/asset:ETH", minorUnits: "10000000000000000000" },
          freshness: { asOf: "2026-10-02T22:00:00Z", maxAgeSeconds: 60 },
          provenance: { providerName: "route-compiler-observer", source: "INTERNAL", capturedAt: NOW_ISO },
          observer: { observerId: "observer:route-compiler-node-001", observerKind: "CHAIN_NODE" },
        },
      ],
    });
    expect(
      result.plans.some((plan) => plan.shapeId === "mixed-dex-offramp"),
    ).toBe(false);
    const exclusion = result.exclusions.find((e) => e.shapeId === "mixed-dex-offramp");
    expect(exclusion).toBeDefined();
    expect(exclusion!.reasons[0]).toContain("LANE_UNPROVED_GROUNDING");
  });
});

describe("typed fault injection (per rail family — never cross-family)", () => {
  it("rejects an onchain fault injected into a fiat leg", () => {
    const plan = planOf(route2Intent(), "mixed-psp-onramp");
    expect(() =>
      walkWith(plan, {
        [plan.legs[0]!.legId]: { kind: "ONCHAIN_OUTCOME_UNKNOWN", reason: "cross-family" },
      }),
    ).toThrow(/cannot be injected into a fiat leg/);
  });

  it("rejects a fiat fault injected into an onchain kernel-prepared leg", () => {
    const plan = planOf(route1Intent(), "mixed-dex-offramp");
    expect(() =>
      walkWith(plan, {
        [plan.legs[1]!.legId]: { kind: "FIAT_OUTCOME_UNKNOWN", reason: "cross-family" },
      }),
    ).toThrow(/cannot be injected into an onchain kernel-prepared leg/);
  });

  it("requires a grounded chain finality model for kernel-prepared legs (never guessed)", () => {
    const plan = planOf(route1Intent(), "mixed-dex-offramp");
    expect(() =>
      walkRoutePlan({ plan, at: NOW, observedAtIso: NOW_ISO, onchainFinalityModels: {} }),
    ).toThrow(/no chain finality model is grounded/);
  });
});
