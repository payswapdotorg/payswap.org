import { describe, expect, it } from "vitest";
import { PRODUCTION_JOURNEYS } from "../../src/production/journeys/index.js";
import {
  journeyPassed,
  PRODUCTION_JOURNEY_IDS,
  stageDigest,
} from "../../src/production/contract.js";
import type { ProductionJourneyOutcome } from "../../src/production/contract.js";

/**
 * The nine §35 acceptance journeys A–I, driven END-TO-END through the REAL
 * composed kernels (injected ports at the external seams only — the
 * declared doubles in production/world.ts). Each journey asserts its full
 * observable trace: typed states, evidence records, diffs and receipts —
 * not just the final state.
 */

const outcomes = new Map<string, ProductionJourneyOutcome>();
for (const journey of PRODUCTION_JOURNEYS) {
  outcomes.set(journey.journeyId, journey.run());
}

function outcome(id: string): ProductionJourneyOutcome {
  const value = outcomes.get(id);
  if (value === undefined) {
    throw new Error(`journey ${id} did not run`);
  }
  return value;
}

describe("production certification — the nine §35 acceptance journeys", () => {
  it("registers exactly the nine handoff journeys A–I in order", () => {
    expect(PRODUCTION_JOURNEYS.map((journey) => journey.journeyId)).toEqual([
      ...PRODUCTION_JOURNEY_IDS,
    ]);
    expect(PRODUCTION_JOURNEYS.map((journey) => journey.letter)).toEqual([
      "A", "B", "C", "D", "E", "F", "G", "H", "I",
    ]);
  });

  describe("Journey A — simple wallet payment", () => {
    const result = outcome("journey:a-simple-wallet-payment");
    it("passes with the full trace", () => {
      expect(journeyPassed(result)).toBe(true);
    });
    it("records the six §35 stages (route → security → authorization → handoff → finality → receipt)", () => {
      expect(result.stages.map((record) => record.stage)).toEqual([
        "ROUTE_SELECTION",
        "SECURITY_ANALYSIS",
        "WALLET_AUTHORIZATION",
        "BLOCKCHAIN_HANDOFF",
        "FINALITY",
        "RECEIPT",
      ]);
    });
    it("binds the kernel pipeline to the compiled route by write-digest equality", () => {
      const refs = result.stages[0]?.refs ?? [];
      expect(refs.some((ref) => ref.startsWith("writeDigest:"))).toBe(true);
      expect(result.stages[1]?.refs.some((ref) => ref.startsWith("pipeline:"))).toBe(true);
    });
    it("ends at a finality CANDIDATE (submitted is not finality — rule 29)", () => {
      expect(result.stages[4]?.refs.some((ref) => ref.includes("OBSERVED_FINALITY_CANDIDATE"))).toBe(true);
    });
    it("carries evidence on every stage", () => {
      expect(result.stages.every((record) => record.evidenceRefs.length > 0)).toBe(true);
    });
  });

  describe("Journey B — DEX optimization", () => {
    const result = outcome("journey:b-dex-optimization");
    it("passes with the full trace", () => {
      expect(journeyPassed(result)).toBe(true);
    });
    it("collected quotes from all three venues with one selected + runner-ups", () => {
      expect(result.stages[0]?.refs.filter((ref) => ref.startsWith("venue:"))).toHaveLength(3);
      expect(result.stages[0]?.refs.some((ref) => ref.includes(":QUOTED"))).toBe(true);
    });
    it("computed the total economic outcome with exact component arithmetic", () => {
      expect(result.stages[1]?.refs.some((ref) => ref.startsWith("netNumeraire:"))).toBe(true);
      expect(result.stages[1]?.refs.some((ref) => ref.startsWith("OUTPUT:"))).toBe(true);
    });
    it("reached EXECUTED_CANDIDATE with a finality candidate", () => {
      expect(result.stages[5]?.refs.some((ref) => ref.includes("EXECUTED_CANDIDATE"))).toBe(true);
    });
  });

  describe("Journey C — crypto-to-fiat", () => {
    const result = outcome("journey:c-crypto-to-fiat");
    it("passes with the full trace", () => {
      expect(journeyPassed(result)).toBe(true);
    });
    it("found the eligible off-ramp and honestly excluded the degenerate DEX hop", () => {
      expect(result.stages[0]?.refs.some((ref) => ref.startsWith("excluded:mixed-dex-offramp"))).toBe(true);
    });
    it("settled fiat through the payout gate and the bank leg", () => {
      expect(result.stages[2]?.refs.some((ref) => ref.startsWith("payoutObservation:paid"))).toBe(true);
    });
    it("proved the reconciliation-only exit on the faulted twin", () => {
      expect(result.stages[3]?.refs.some((ref) => ref.includes("blindRetryForbidden:true"))).toBe(true);
      expect(result.stages[3]?.refs.some((ref) => ref.includes("resolver:SETTLEMENT_RECONCILIATION_AUTHORITY"))).toBe(true);
    });
  });

  describe("Journey D — merchant crypto payment", () => {
    const result = outcome("journey:d-merchant-crypto-payment");
    it("passes with the full trace", () => {
      expect(journeyPassed(result)).toBe(true);
    });
    it("settled BOTH Stripe modes with the §3.9 reconciliation", () => {
      expect(result.stages.map((record) => record.stage)).toContain("SETTLE_NATIVE_STRIPE");
      expect(result.stages.map((record) => record.stage)).toContain("SETTLE_EXTERNAL_CONVERSION");
      expect(result.stages.map((record) => record.stage)).toContain("SECTION_3_9_RECONCILIATION");
    });
    it("carries the honest-unavailability notice verbatim on the external path", () => {
      expect(
        result.stages
          .find((record) => record.stage === "SETTLE_EXTERNAL_CONVERSION")
          ?.refs.some((ref) => ref === "notice:Stripe balance settlement unavailable for this route"),
      ).toBe(true);
    });
  });

  describe("Journey E — mixed execution", () => {
    const result = outcome("journey:e-mixed-execution");
    it("passes with the full trace", () => {
      expect(journeyPassed(result)).toBe(true);
    });
    it("compiled BOTH honest variants (stablecoin off-ramp + the real DEX/intent lane)", () => {
      expect(result.stages[0]?.refs.some((ref) => ref.startsWith("plan:"))).toBe(true);
      expect(result.stages[1]?.refs.some((ref) => ref.startsWith("dexLane:onchain-lane:"))).toBe(true);
    });
    it("the user sees €100 paid with the typed two-level disclosure", () => {
      expect(result.stages.map((record) => record.stage)).toContain("USER_SEES_EURO_100_PAID");
      expect(result.stages[3]?.refs.some((ref) => ref.startsWith("outcomeLine:"))).toBe(true);
    });
  });

  describe("Journey F — security attack", () => {
    const result = outcome("journey:f-security-attack");
    it("passes with the full trace", () => {
      expect(journeyPassed(result)).toBe(true);
    });
    it("detected all five adversarial fixtures", () => {
      const stages = result.stages.map((record) => record.stage);
      expect(stages).toContain("FAKE_TOKEN_DETECTED");
      expect(stages).toContain("MALICIOUS_APPROVAL_DETECTED");
      expect(stages).toContain("UNEXPECTED_SPENDER_DETECTED");
      expect(stages).toContain("PROXY_IMPLEMENTATION_CHANGE_DETECTED");
      expect(stages).toContain("UNEXPECTED_BALANCE_DELTA_DETECTED");
    });
    it("every fixture BLOCKED/VOIDED with the agent unable to downgrade", () => {
      expect(result.stages[0]?.refs.some((ref) => ref.startsWith("decision:BLOCK"))).toBe(true);
      expect(result.stages[5]?.refs.some((ref) => ref.includes("overrideRejected:true"))).toBe(true);
      expect(result.stages[5]?.refs.some((ref) => ref.includes("kernelBlockResolution:BLOCK"))).toBe(true);
    });
  });

  describe("Journey G — agent opportunity", () => {
    const result = outcome("journey:g-agent-opportunity");
    it("passes with the full trace", () => {
      expect(journeyPassed(result)).toBe(true);
    });
    it("branded the discovery DISCOVERY_NEVER_AUTHORIZATION with policy authoritative", () => {
      expect(result.stages[0]?.refs.some((ref) => ref.includes("DISCOVERY_NEVER_AUTHORIZATION"))).toBe(true);
      expect(result.stages[3]?.refs.some((ref) => ref.includes("discoveryPermitsExecution:false"))).toBe(true);
    });
  });

  describe("Journey H — state changes before broadcast", () => {
    const result = outcome("journey:h-state-change-before-broadcast");
    it("passes with the full trace", () => {
      expect(journeyPassed(result)).toBe(true);
    });
    it("VOIDed on the epoch drift and required a new simulation + new authorization", () => {
      expect(result.stages[3]?.refs.some((ref) => ref.includes("recheck:AUTHORIZATION_VOIDED"))).toBe(true);
      expect(result.stages[4]?.refs.some((ref) => ref.startsWith("newSimulation:"))).toBe(true);
      expect(result.stages[4]?.refs.some((ref) => ref.startsWith("newAuthorizationRequest:"))).toBe(true);
    });
  });

  describe("Journey I — reorg / UNKNOWN", () => {
    const result = outcome("journey:i-reorg-unknown");
    it("passes with the full trace", () => {
      expect(journeyPassed(result)).toBe(true);
    });
    it("rendered UNKNOWN (never fake success) across all three kernels", () => {
      expect(result.stages[0]?.refs.some((ref) => ref.startsWith("outcome:OUTCOME_UNKNOWN"))).toBe(true);
      expect(result.stages[1]?.refs.some((ref) => ref.includes("requiresReconciliation:true"))).toBe(true);
      expect(result.stages[2]?.refs.some((ref) => ref.startsWith("walk:ROUTE_REQUIRES_RECONCILIATION"))).toBe(true);
      expect(result.stages[3]?.refs.some((ref) => ref.startsWith("attemptState:OUTCOME_UNKNOWN"))).toBe(true);
    });
  });

  describe("determinism guards (the W2-003/W4-001 evidence pattern)", () => {
    it("every journey re-run produces the identical journey digest", () => {
      for (const journey of PRODUCTION_JOURNEYS) {
        const first = outcomes.get(journey.journeyId);
        const second = journey.run();
        expect(second.journeyDigest).toBe(first?.journeyDigest);
      }
    });
    it("every stage record re-digests to its recorded digest", () => {
      for (const result of outcomes.values()) {
        for (const record of result.stages) {
          expect(
            stageDigest({
              stage: record.stage,
              summary: record.summary,
              refs: record.refs,
              evidenceRefs: record.evidenceRefs,
            }),
          ).toBe(record.digest);
        }
      }
    });
    it("every definitive journey state is evidence-backed (no simulated success)", () => {
      for (const result of outcomes.values()) {
        expect(
          result.stages.every((record) => record.evidenceRefs.length > 0),
        ).toBe(true);
        expect(result.evidenceRefs.length).toBeGreaterThan(0);
      }
    });
  });
});
