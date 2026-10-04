/**
 * Route 2 — fiat → PSP → stablecoin → chain → recipient (Work Order
 * P4-W4-001 representative route 2).
 *
 * Proves the on-ramp journey: the PSP collect hop grounds in a canonical
 * CapabilityObservation (INV-C05), the issuance hop converts fiat into the
 * fiat-pegged stablecoin on an exact conversion grounding, and the final
 * onchain delivery runs through the kernel write pipeline (prepare → gate
 * ALLOW → expected diff) to the recipient wallet — with the provider-native
 * on-ramp incumbent emitted as a baseline candidate.
 */

import { describe, expect, it } from "vitest";
import {
  compileBase,
  route2Intent,
  makeFiatObservation,
  ONCHAIN_FINALITY_MODES,
  NOW,
  NOW_ISO,
  RECIPIENT,
  groundedPlannedAmount,
} from "./fixtures.js";
import { walkRoutePlan } from "../src/index.js";

describe("route 2: fiat→PSP→stablecoin→chain→recipient", () => {
  it("compiles the mixed plan with exactly the three representative hops", () => {
    const result = compileBase(route2Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-psp-onramp");
    expect(plan).toBeDefined();
    expect(plan!.candidateStatus).toBe("EXECUTABLE_CANDIDATE");
    expect(plan!.legs.map((leg) => leg.legKind)).toEqual([
      "FIAT_PSP_COLLECT",
      "PSP_STABLECOIN_ISSUANCE",
      "ONCHAIN_TRANSFER",
    ]);
    expect(plan!.compositionClass).toBe("MIXED");
  });

  it("emits the provider-native on-ramp incumbent as a baseline (INV-C08)", () => {
    const result = compileBase(route2Intent());
    const baseline = result.plans.find((plan) => plan.shapeId === "provider-native-onramp");
    expect(baseline).toBeDefined();
    expect(baseline!.isProviderNativeBaseline).toBe(true);
    expect(baseline!.candidateStatus).toBe("PROVIDER_NATIVE_BASELINE");
    expect(baseline!.executionMode).toBe("PASS_THROUGH_NATIVE");
    // The native flow delivers the stablecoin directly to the recipient.
    expect(baseline!.legs.map((leg) => leg.legKind)).toEqual([
      "FIAT_PSP_COLLECT",
      "PSP_STABLECOIN_ISSUANCE",
    ]);
    expect(baseline!.legs[1]!.custody.to.kind).toBe("ONCHAIN_WALLET");
  });

  it("chains custody: provider instrument → provider pool → issuer protocol → recipient wallet", () => {
    const result = compileBase(route2Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-psp-onramp")!;
    const custodies = plan.legs.map((leg) => leg.custody);
    expect(custodies[0]!.from.kind).toBe("EXTERNAL_PROVIDER");
    expect(custodies[1]!.to.kind).toBe("ONCHAIN_PROTOCOL");
    expect(custodies[2]!.to.kind).toBe("ONCHAIN_WALLET");
    const recipient = custodies[2]!.to as { kind: "ONCHAIN_WALLET"; accountRef: string };
    expect(recipient.accountRef).toBe(RECIPIENT);
    for (let index = 0; index + 1 < custodies.length; index += 1) {
      expect(custodies[index]!.to.kind).toBe(custodies[index + 1]!.from.kind);
    }
  });

  it("grounds the issuance amount in an exact conversion rule (100 EUR → 108 USC)", () => {
    const result = compileBase(route2Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-psp-onramp")!;
    const collect = plan.legs[0]! as Extract<
      typeof plan.legs[number],
      { legKind: "FIAT_PSP_COLLECT" }
    >;
    const issuance = plan.legs[1]! as Extract<
      typeof plan.legs[number],
      { legKind: "PSP_STABLECOIN_ISSUANCE" }
    >;
    expect(issuance.plannedAmount.basis).toBe("CONVERSION_GROUNDED");
    expect(groundedPlannedAmount(issuance.plannedAmount)).toEqual({
      currency: "USC",
      minorUnits: "108000000",
    });
    // The collect hop carries the intent-declared fiat amount.
    expect(collect.plannedAmount.basis).toBe("INTENT_DECLARED");
    expect(groundedPlannedAmount(collect.plannedAmount)).toEqual({
      currency: "EUR",
      minorUnits: "10000",
    });
  });

  it("runs the delivery hop through the kernel write pipeline with a gate ALLOW", () => {
    const result = compileBase(route2Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-psp-onramp")!;
    const delivery = plan.legs[2] as Extract<
      typeof plan.legs[number],
      { legKind: "ONCHAIN_TRANSFER" }
    >;
    expect(delivery.gateDecision.decision).toBe("ALLOW");
    expect(delivery.write.action).toBe("onchain.transfer");
    expect(delivery.write.transfer?.to).toBe(RECIPIENT);
    expect(delivery.expectedDiff).toBeDefined();
    expect(delivery.authorizationLineage.legAuthorization.kind).toBe("ONCHAIN_GATE_DECISION");
  });

  it("provider-owned finality for fiat hops; candidates only everywhere", () => {
    const result = compileBase(route2Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-psp-onramp")!;
    expect(plan.legs[0]!.finality.candidates).toEqual([
      { candidateOnly: true, model: "PROVIDER_OWNED", providerName: "psp-mock" },
    ]);
    for (const leg of plan.legs) {
      expect(leg.finality.finalityNeverAssumed).toBe(true);
    }
  });

  it("walks the happy path: every hop observed, value arrives at the recipient wallet", () => {
    const result = compileBase(route2Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-psp-onramp")!;
    const walkResult = walkRoutePlan({
      plan,
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFinalityModels: ONCHAIN_FINALITY_MODES,
    });
    expect(walkResult.status).toBe("ROUTE_COMPLETED_ALL_LEGS_OBSERVED");
    expect(walkResult.custodyAtStop?.party.kind).toBe("ONCHAIN_WALLET");
    const deliveryExecution = walkResult.legExecutions[2]!;
    expect(deliveryExecution.onchain?.railOperation.railId).toBe("onchain.ethereum:mainnet");
    expect(deliveryExecution.eventCandidate).toEqual({
      kind: "EVENT_CANDIDATE",
      event: "CONFIRM_SUCCEEDED",
    });
  });

  it("excludes both shapes honestly when the PSP instance is unobserved (INV-C05)", () => {
    const result = compileBase(route2Intent(), {
      fiatObservations: [],
    });
    expect(result.plans).toHaveLength(0);
    expect(result.status).toBe("NO_COMPILABLE_ROUTE");
    for (const shapeId of ["mixed-psp-onramp", "provider-native-onramp"]) {
      const exclusion = result.exclusions.find((e) => e.shapeId === shapeId);
      expect(exclusion).toBeDefined();
      expect(exclusion!.reasons[0]).toContain("no connected instance + fresh capability observation");
    }
  });

  it("marks the mixed plan ineligible when the fiat observation is stale (observation law)", () => {
    // An observation two hours old against the one-hour max age (built
    // through the canonical observeCapability — availability derived).
    const result = compileBase(route2Intent(), {
      fiatObservations: [
        makeFiatObservation({
          instanceId: "instance:native-routing:1",
          observedAt: "2026-10-02T22:00:00Z",
        }),
      ],
    });
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-psp-onramp");
    expect(plan).toBeDefined();
    expect(plan!.candidateStatus).toBe("INELIGIBLE_CANDIDATE");
    expect(plan!.ineligibilityReasons.some((r) => r.code === "LEG_GROUNDING_FAILURE")).toBe(true);
  });
});
