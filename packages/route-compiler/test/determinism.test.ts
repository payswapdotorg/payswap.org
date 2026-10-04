/**
 * Deterministic route-plan tests (Work Order P4-W4-001 task-packet hard
 * requirement 6): compilation is a PURE FUNCTION of its inputs —
 *
 * - same intent + same provider/chain observations → the SAME route plan
 *   (deep-equal, byte-stable digests);
 * - the plan set is invariant under input PERMUTATION (canonical input
 *   ordering: venue packs by venueId, instances/observations/activations/
 *   destinations/evidence/opportunities by id);
 * - walks are deterministic: same (plan, at, observedAtIso, faults,
 *   finality models) → deep-equal result;
 * - no ambient clock, no randomness: the compiler refuses non-integer or
 *   negative instants and expired intents fail closed.
 */

import { describe, expect, it } from "vitest";
import {
  compileBase,
  baseCompilerInput,
  route1Intent,
  route2Intent,
  route3Intent,
  route4Intent,
  ONCHAIN_FINALITY_MODES,
  NOW,
  NOW_ISO,
} from "./fixtures.js";
import { compileMoneyMovementRoute, walkRoutePlan } from "../src/index.js";

describe("deterministic route-plan compilation", () => {
  it("same intent + same observations → deep-equal compilation (all four routes)", () => {
    for (const intent of [route1Intent(), route2Intent(), route3Intent(), route4Intent()]) {
      const first = compileBase(intent);
      const second = compileBase(intent);
      expect(second).toEqual(first);
      expect(second.compilationDigest).toBe(first.compilationDigest);
      for (let index = 0; index < first.plans.length; index += 1) {
        expect(second.plans[index]!.planDigest).toBe(first.plans[index]!.planDigest);
      }
    }
  });

  it("plan ids and leg ids are pure functions of the canonical projection", () => {
    const result = compileBase(route1Intent());
    for (const plan of result.plans) {
      expect(plan.planId).toBe(`route-plan:${route1Intent().intentId}:${plan.shapeId}`);
      plan.legs.forEach((leg, index) => {
        expect(leg.legId).toBe(`${plan.planId}:leg:${index}:${leg.legKind}`);
      });
    }
  });

  it("input permutation invariance: shuffled inputs → identical compilation digest", () => {
    const intent = route1Intent();
    const base = baseCompilerInput(intent);
    const first = compileMoneyMovementRoute(base);
    const permuted = compileMoneyMovementRoute({
      ...base,
      venuePacks: [...base.venuePacks].reverse(),
      onchainInstances: [...base.onchainInstances].reverse(),
      assetObservations: [...base.assetObservations].reverse(),
      fiatDefinitions: [...base.fiatDefinitions].reverse(),
      fiatInstances: [...base.fiatInstances].reverse(),
      fiatObservations: [...base.fiatObservations].reverse(),
      fiatActivations: [...base.fiatActivations].reverse(),
      settlementDestinations: [...base.settlementDestinations].reverse(),
      conversionRules: [...base.conversionRules].reverse(),
      stripeEligibilityEvidence: [...base.stripeEligibilityEvidence].reverse(),
      opportunityObservations: [...base.opportunityObservations].reverse(),
    });
    expect(permuted.compilationDigest).toBe(first.compilationDigest);
    expect(permuted.plans.map((plan) => plan.planDigest)).toEqual(
      first.plans.map((plan) => plan.planDigest),
    );
  });

  it("plans are emitted in canonical (sorted) order regardless of construction order", () => {
    const result = compileBase(route1Intent());
    const planIds = result.plans.map((plan) => plan.planId);
    expect([...planIds].sort((a, b) => (a < b ? -1 : 1))).toEqual(planIds);
  });

  it("walks are deterministic: same inputs → deep-equal result", () => {
    const result = compileBase(route1Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const faults = {
      [plan.legs[1]!.legId]: { kind: "ONCHAIN_OUTCOME_UNKNOWN" as const, reason: "reorg" },
    };
    const first = walkRoutePlan({
      plan,
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFinalityModels: ONCHAIN_FINALITY_MODES,
      faults,
    });
    const second = walkRoutePlan({
      plan,
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFinalityModels: ONCHAIN_FINALITY_MODES,
      faults,
    });
    expect(second).toEqual(first);
  });

  it("different compile instants are different compilations (never an ambient clock)", () => {
    const intent = route1Intent();
    const first = compileBase(intent);
    const later = compileMoneyMovementRoute(
      baseCompilerInput(intent, { at: NOW + 1000 }),
    );
    expect(later.compilationDigest).not.toBe(first.compilationDigest);
    expect(later.compiledAt).toBe(NOW + 1000);
  });

  it("compilation refuses non-integer and negative instants (fail closed)", () => {
    const intent = route1Intent();
    expect(() => compileMoneyMovementRoute(baseCompilerInput(intent, { at: -1 }))).toThrow(
      /non-negative integer/,
    );
    expect(() =>
      compileMoneyMovementRoute(baseCompilerInput(intent, { at: Number.NaN })),
    ).toThrow(/non-negative integer/);
  });

  it("an expired intent compiles nothing (the authorization window is fail-closed)", () => {
    const intent = route1Intent();
    expect(() =>
      compileMoneyMovementRoute(baseCompilerInput(intent, { at: intent.expiresAt })),
    ).toThrow(/expired/);
  });

  it("a changed intent is a different compilation (the intent is the single source of truth)", () => {
    const first = compileBase(route1Intent());
    const changed = compileBase({ ...route1Intent(), originAmount: { currency: "ETH", minorUnits: "20000000000000000" } });
    expect(changed.compilationDigest).not.toBe(first.compilationDigest);
  });
});
