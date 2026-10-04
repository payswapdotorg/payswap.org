/**
 * Route 1 — crypto → DEX → stablecoin → off-ramp → bank (Work Order
 * P4-W4-001 representative route 1).
 *
 * Proves the mixed journey end-to-end through the REAL kernels: the DEX hop
 * is an engine-selected, gate-ALLOWed lane over the REAL Uniswap v2
 * reference pack; the deposit/payout/bank hops carry the kernel write
 * pipeline, the REAL payout gate and the canonical settlement destination;
 * every leg preserves authorization lineage, state grounding, finality
 * candidates and evidence; custody chains with nothing implicitly held; and
 * the provider-native incumbent is emitted as a baseline candidate (INV-C08)
 * — structurally undiscriminated.
 */

import { describe, expect, it } from "vitest";
import {
  compileBase,
  route1Intent,
  ONCHAIN_FINALITY_MODES,
  NOW,
  NOW_ISO,
  OFFRAMP_PROVIDER,
  groundedPlannedAmount,
} from "./fixtures.js";
import { walkRoutePlan } from "../src/index.js";
import type { RouteCompilationResult } from "../src/index.js";

function compiled(): RouteCompilationResult {
  return compileBase(route1Intent());
}

describe("route 1: crypto→DEX→stablecoin→off-ramp→bank", () => {
  it("compiles the mixed plan with exactly the four representative hops", () => {
    const result = compiled();
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp");
    expect(plan).toBeDefined();
    expect(plan!.candidateStatus).toBe("EXECUTABLE_CANDIDATE");
    expect(plan!.legs.map((leg) => leg.legKind)).toEqual([
      "ONCHAIN_DEX_SWAP",
      "ONCHAIN_TRANSFER",
      "OFF_RAMP_PAYOUT",
      "BANK_SETTLEMENT",
    ]);
    expect(plan!.compositionClass).toBe("MIXED");
    expect(plan!.executionMode).toBe("OPTIMIZED_MULTI_PROVIDER");
  });

  it("emits the provider-native incumbent as a baseline candidate (INV-C08)", () => {
    const result = compiled();
    const baseline = result.plans.find((plan) => plan.shapeId === "provider-native-offramp");
    expect(baseline).toBeDefined();
    expect(baseline!.isProviderNativeBaseline).toBe(true);
    expect(baseline!.candidateStatus).toBe("PROVIDER_NATIVE_BASELINE");
    expect(baseline!.executionMode).toBe("PASS_THROUGH_NATIVE");
    expect(baseline!.ineligibilityReasons).toHaveLength(0);
    // The baseline is emitted EXACTLY like composed plans — the compiler
    // does not rank plans, so a baseline can never be ranked away.
    expect(result.plans.map((plan) => plan.shapeId).sort()).toEqual([
      "mixed-dex-offramp",
      "provider-native-offramp",
    ]);
  });

  it("preserves authorization lineage on every leg (the authority chain of custody)", () => {
    const result = compiled();
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    for (const leg of plan.legs) {
      expect(leg.intentRef).toBe(route1Intent().intentId);
      expect(leg.authorizationLineage.intentAuthorizationRef).toBe("authz:intent:route-1");
    }
    const swap = plan.legs[0]! as Extract<
      typeof plan.legs[number],
      { legKind: "ONCHAIN_DEX_SWAP" }
    >;
    const deposit = plan.legs[1]! as Extract<
      typeof plan.legs[number],
      { legKind: "ONCHAIN_TRANSFER" }
    >;
    const payout = plan.legs[2]! as Extract<
      typeof plan.legs[number],
      { legKind: "OFF_RAMP_PAYOUT" }
    >;
    const bank = plan.legs[3]! as Extract<
      typeof plan.legs[number],
      { legKind: "BANK_SETTLEMENT" }
    >;
    // The DEX hop's authority is the deterministic kernel gate decision.
    expect(swap.authorizationLineage.legAuthorization.kind).toBe("ONCHAIN_GATE_DECISION");
    if (swap.authorizationLineage.legAuthorization.kind !== "ONCHAIN_GATE_DECISION") {
      throw new Error("unreachable: kind asserted ONCHAIN_GATE_DECISION above");
    }
    expect(swap.authorizationLineage.legAuthorization.gateDecision.decision).toBe("ALLOW");
    // The deposit hop's authority is the kernel gate over the prepared write.
    expect(deposit.authorizationLineage.legAuthorization.kind).toBe("ONCHAIN_GATE_DECISION");
    expect(deposit.gateDecision.decision).toBe("ALLOW");
    expect(deposit.write.writeDigest.startsWith("fnv1a64:")).toBe(true);
    // The payout hop's authority is the REAL transfer-out gate report.
    expect(payout.authorizationLineage.legAuthorization.kind).toBe("PAYOUT_TRANSFER_OUT_GRANT");
    expect(payout.gate.allowed).toBe(true);
    expect(payout.gate.checks.map((check) => check.gate)).toContain("TRANSFER_OUT_GRANT_EXISTS");
    // The bank arrival executes under the intent's own authorization.
    expect(bank.authorizationLineage.legAuthorization.kind).toBe("INTENT_AUTHORIZATION_ONLY");
  });

  it("grounds every leg in fresh observations (the observation law)", () => {
    const result = compiled();
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    for (const leg of plan.legs) {
      expect(leg.stateGrounding.groundingFailures).toHaveLength(0);
    }
    const swap = plan.legs[0]!;
    const groundingIds = swap.stateGrounding.observations.map((obs) => obs.observationId);
    expect(groundingIds).toContain("route-obs:eth:owner:1");
    expect(swap.stateGrounding.observations.every((obs) => obs.fresh)).toBe(true);
  });

  it("never assumes finality: candidates only (INV-F06, rule 29)", () => {
    const result = compiled();
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    for (const leg of plan.legs) {
      expect(leg.finality.finalityNeverAssumed).toBe(true);
    }
    const swap = plan.legs[0]!;
    expect(swap.finality.candidates).toEqual([
      { candidateOnly: true, model: "PROBABILISTIC" },
    ]);
    const payout = plan.legs[2]!;
    expect(payout.finality.candidates).toEqual([
      { candidateOnly: true, model: "PROVIDER_OWNED", providerName: OFFRAMP_PROVIDER },
    ]);
  });

  it("chains custody explicitly with nothing implicitly held (INV-C09)", () => {
    const result = compiled();
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const custodies = plan.legs.map((leg) => leg.custody);
    expect(custodies).toHaveLength(4);
    for (let index = 0; index + 1 < custodies.length; index += 1) {
      expect(custodies[index]!.to.kind).toBe(custodies[index + 1]!.from.kind);
    }
    // wallet → wallet (swap morph) → provider → provider (fiat morph) → bank
    expect(custodies[0]!.from.kind).toBe("ONCHAIN_WALLET");
    expect(custodies[0]!.to.kind).toBe("ONCHAIN_WALLET");
    expect(custodies[1]!.to.kind).toBe("EXTERNAL_PROVIDER");
    expect(custodies[3]!.to.kind).toBe("EXTERNAL_BANK_INSTRUMENT");
    // Every custody transfer is evidenced (INV-E02).
    for (const custody of custodies) {
      expect(custody.evidenceRefs.length).toBeGreaterThan(0);
    }
  });

  it("grounds planned amounts in quotes and conversions — never invented FX", () => {
    const result = compiled();
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const swap = plan.legs[0]! as Extract<
      typeof plan.legs[number],
      { legKind: "ONCHAIN_DEX_SWAP" }
    >;
    const deposit = plan.legs[1]! as Extract<
      typeof plan.legs[number],
      { legKind: "ONCHAIN_TRANSFER" }
    >;
    const payout = plan.legs[2]! as Extract<
      typeof plan.legs[number],
      { legKind: "OFF_RAMP_PAYOUT" }
    >;
    const bank = plan.legs[3]! as Extract<
      typeof plan.legs[number],
      { legKind: "BANK_SETTLEMENT" }
    >;
    expect(swap.plannedAmount.basis).toBe("QUOTE_GROUNDED");
    expect(groundedPlannedAmount(swap.plannedAmount).currency).toBe("USC");
    expect(groundedPlannedAmount(swap.plannedAmount).minorUnits).not.toBe("0");
    expect(deposit.plannedAmount.basis).toBe("QUOTE_GROUNDED");
    expect(payout.plannedAmount.basis).toBe("CONVERSION_GROUNDED");
    expect(groundedPlannedAmount(payout.plannedAmount).currency).toBe("EUR");
    expect(groundedPlannedAmount(bank.plannedAmount).currency).toBe("EUR");
  });

  it("walks the happy path with observed finality CANDIDATES only", () => {
    const result = compiled();
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const walkResult = walkRoutePlan({
      plan,
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFinalityModels: ONCHAIN_FINALITY_MODES,
    });
    expect(walkResult.status).toBe("ROUTE_COMPLETED_ALL_LEGS_OBSERVED");
    for (const execution of walkResult.legExecutions) {
      expect(execution.status).toBe("OBSERVED_FINALITY_CANDIDATE");
      expect(execution.eventCandidate).toBeDefined();
    }
    // The onchain hops carry the canonical settlement mapping artifacts.
    const swapExecution = walkResult.legExecutions[0]!;
    expect(swapExecution.onchain?.railOperation.railId).toBe("onchain.ethereum:mainnet");
    expect(swapExecution.onchain?.observation.finalityCandidate?.candidateOnly).toBe(true);
    // Value arrives at the external bank instrument.
    expect(walkResult.custodyAtStop?.party.kind).toBe("EXTERNAL_BANK_INSTRUMENT");
  });

  it("references the intent as the single source of truth (no duplicate ledger)", () => {
    const result = compiled();
    for (const plan of result.plans) {
      expect(plan.intentRef).toBe(route1Intent().intentId);
      for (const leg of plan.legs) {
        // Legs never re-declare the intent object — only its reference.
        expect(leg.intentRef).toBe(plan.intentRef);
        expect(leg.legId.startsWith(`route-plan:${plan.intentRef}:`)).toBe(true);
      }
    }
    // The onchain hops bind settlement instructions at the boundary (the
    // settlement mapping law — observations map into the canonical
    // machinery, never a parallel ledger).
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const deposit = plan.legs[1]! as Extract<typeof plan.legs[number], { legKind: "ONCHAIN_TRANSFER" }>;
    expect(deposit.write.settlementInstruction?.instructionId).toBe(
      "settlement-instruction:intent:route-1:crypto-dex-offramp-bank:mixed-dex-offramp",
    );
  });

  it("excludes the mixed shape honestly when no conversion grounding exists", () => {
    const result = compileBase(route1Intent(), {
      conversionRules: [
        {
          ruleId: "peg:eth-usd",
          fromCurrency: "ETH",
          toCurrency: "USD",
          rate: { numerator: "3", denominator: "10000000000000" },
          declaredBy: "peg:eth-usd-reference",
        },
      ],
    });
    const exclusion = result.exclusions.find((e) => e.shapeId === "mixed-dex-offramp");
    expect(exclusion).toBeDefined();
    expect(exclusion!.reasons[0]).toContain("no exact fiat grounding");
    expect(exclusion!.reasons[0]).toContain("never invents an FX rate");
  });
});
