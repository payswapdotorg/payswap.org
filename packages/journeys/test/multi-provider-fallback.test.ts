import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import { runMultiProviderFallbackJourney } from "../src/journeys/multi-provider-fallback.js";
import { expectAxesCovered, expectJourneyPasses, JOURNEY_AXES } from "./journey-helpers.js";

describe("Journey: multi-provider fallback (W1-007)", () => {
  const outcome = runMultiProviderFallbackJourney();

  it("passes every acceptance axis", () => {
    expectJourneyPasses(outcome.journey);
  });

  it("asserts the five journey axes", () => {
    expectAxesCovered(outcome.journey, JOURNEY_AXES);
  });

  it("keeps a SEPARATE PaymentAttempt lineage per provider", () => {
    expect(outcome.details.attemptsForPlanCount).toBe(2);
    expect(outcome.details.primaryAttemptId).not.toBe(outcome.details.fallbackAttemptId);
    expect(outcome.details.separateLineage).toBe(true);
    expect(outcome.details.distinctInstances).toBe(true);
    expect(outcome.details.primaryFinalState).toBe("FAILED");
    expect(outcome.details.fallbackFinalState).toBe("SUCCEEDED");
  });

  it("evidences each attempt independently", () => {
    expect(outcome.details.primaryEvidenceCount).toBeGreaterThan(0);
    expect(outcome.details.fallbackEvidenceCount).toBeGreaterThan(0);
    expect(outcome.details.primaryEvidenceCount + outcome.details.fallbackEvidenceCount).toBeGreaterThanOrEqual(2);
  });

  it("never maps UNKNOWN to FAILED (INV-X01)", () => {
    expect(outcome.details.unknownNeverFailed).toBe(true);
  });

  it("settles through the backup with exact fees", () => {
    expect(outcome.details.chain.settlements[0]?.finality.state).toBe("FINAL");
    expect(outcome.details.chain.settlements[0]?.instruction.amount).toEqual(fromMinorUnits(USD, 60_000n));
    expect(outcome.details.fee).toEqual(fromMinorUnits(USD, 130n));
  });
});
