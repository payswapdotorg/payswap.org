import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  validateOnchainExecutionObservation,
  validateAssetObservation,
  mapToRailOperation,
} from "@payswap/onchain-domain";
import { recordSimulation } from "@payswap/onchain-security";
import {
  LAB_EXECUTION_TIER,
  assertLabExecutionTier,
  isLabTieredValue,
  labTierPermitsFinancialSettlement,
  rejectLabTierForFinancialSettlement,
} from "../src/index.js";
import { LabTierSettlementRejectedError } from "../src/index.js";
import {
  CANDIDATE_BODY_REF,
  CANDIDATE_PRINCIPAL,
  fiatExecutableBlocks,
  fiatScenario,
  fiatWorld,
  provedSimLane,
  NOW,
  NOW_ISO,
} from "./fixtures.js";
import {
  MIXED_RAIL_DOMAIN_PACK,
  buildMixedRailCandidate,
  simulateMixedRail,
} from "./mixed-rail-lab-harness.js";

/**
 * P4-W3-001 hard requirement 3: Lab simulation is NEVER callable as
 * production financial execution. The discriminator is STRUCTURAL (the
 * onchain-adapters TestnetNeverProduction pattern applied to the Lab tier):
 * branded types, derived-only construction, runtime re-derivation, and
 * kernel validators that reject tiered Lab artifacts where kernel
 * observations are demanded.
 */
describe("P4-W3-001 the structural non-production tier (never production settlement)", () => {
  function mixedResult() {
    const candidate = buildMixedRailCandidate({
      candidateId: "mixed-rail:tier-1",
      title: "tier",
      domainPackId: MIXED_RAIL_DOMAIN_PACK.packId,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      fiatBlocks: fiatExecutableBlocks(),
      onchainLanes: [provedSimLane()],
      body: CANDIDATE_BODY_REF,
      principal: CANDIDATE_PRINCIPAL,
    });
    return simulateMixedRail({
      candidate,
      world: fiatWorld(),
      scenario: fiatScenario(),
      seed: "seed-tier-1",
      at: NOW,
      observedAtIso: NOW_ISO,
    });
  }

  it("every mixed result carries the structural tier (branded + re-derivable)", () => {
    const result = mixedResult();
    expect(isLabTieredValue(result)).toBe(true);
    expect(result.executionTier).toBe(LAB_EXECUTION_TIER);
    expect(result.environmentClass).toBe("SIMULATION");
    expect(() => assertLabExecutionTier(result)).not.toThrow();
  });

  it("the tier settlement law: labTierPermitsFinancialSettlement() is false, always", () => {
    expect(labTierPermitsFinancialSettlement()).toBe(false);
    expect(labTierPermitsFinancialSettlement()).toBe(false);
  });

  it("the downstream settlement gate ALWAYS throws (first-class contract, no input passes)", () => {
    const result = mixedResult();
    expect(() => rejectLabTierForFinancialSettlement(result)).toThrow(
      LabTierSettlementRejectedError,
    );
    expect(() => rejectLabTierForFinancialSettlement(result)).toThrow(
      /can never be production financial execution/,
    );
    // Even a non-tiered value is rejected: the gate never passes anything.
    expect(() => rejectLabTierForFinancialSettlement({ some: "value" })).toThrow(
      LabTierSettlementRejectedError,
    );
    expect(() => rejectLabTierForFinancialSettlement(null)).toThrow(
      LabTierSettlementRejectedError,
    );
  });

  it("the REAL kernel observation validator rejects a tiered Lab result (fail closed)", () => {
    const result = mixedResult();
    expect(() =>
      validateOnchainExecutionObservation(result as unknown as never),
    ).toThrow();
    expect(() => validateAssetObservation(result as unknown as never)).toThrow();
  });

  it("the REAL kernel settlement mapping rejects a tiered Lab result (no rail operation)", () => {
    const result = mixedResult();
    expect(() =>
      mapToRailOperation({
        observation: result as unknown as never,
        settlementInstructionId: "instr:forbidden",
        settlementAttemptId: "attempt:forbidden",
      }),
    ).toThrow();
  });

  it("the REAL kernel simulation recorder rejects a tiered Lab result (not a kernel simulation)", () => {
    const result = mixedResult();
    expect(() =>
      recordSimulation(result as unknown as never),
    ).toThrow();
  });

  it("the Lab execution observations inside a result DO validate (kernel law satisfied)", () => {
    // The distinction is the point: the walk's individual observations are
    // kernel-valid (they must be — they model chain behavior), while the
    // tiered AGGREGATE is structurally barred from settlement. Both facts
    // hold simultaneously; the tier is what separates Lab simulation from
    // production financial execution.
    const result = mixedResult();
    const execution = result.onchainExecutions[0]!;
    if (execution.status !== "EXECUTED") {
      throw new Error("fixture execution must be EXECUTED");
    }
    expect(() =>
      validateOnchainExecutionObservation(execution.observation),
    ).not.toThrow();
    // But that kernel-valid observation is still inside a tiered record:
    // the aggregate is rejected, and there is no exported unwrap.
    expect(() => rejectLabTierForFinancialSettlement(result)).toThrow();
  });

  it("the tier assertion rejects forgeries (fail closed, never guessed)", () => {
    expect(() => assertLabExecutionTier(null)).toThrow(ValidationError);
    expect(() => assertLabExecutionTier({})).toThrow(ValidationError);
    expect(() => assertLabExecutionTier({ executionTier: "PRODUCTION" })).toThrow(
      ValidationError,
    );
    expect(isLabTieredValue({ executionTier: "PRODUCTION" })).toBe(false);
    expect(isLabTieredValue("not an object")).toBe(false);
  });

  it("no lab walk ever records the authorize or broadcast lifecycle stage (INV-G03 + rule 7)", () => {
    const result = mixedResult();
    for (const execution of result.onchainExecutions) {
      expect(execution.lifecycleStages).not.toContain("authorize");
      expect(execution.lifecycleStages).not.toContain("broadcast");
    }
  });
});
