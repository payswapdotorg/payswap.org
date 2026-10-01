import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import { runRecurringMandateJourney } from "../src/journeys/recurring-mandate.js";
import { expectAxesCovered, expectJourneyPasses, JOURNEY_AXES } from "./journey-helpers.js";

describe("Journey: recurring mandate lifecycle (W1-007)", () => {
  const outcome = runRecurringMandateJourney();

  it("passes every acceptance axis", () => {
    expectJourneyPasses(outcome.journey);
  });

  it("asserts the five journey axes", () => {
    expectAxesCovered(outcome.journey, JOURNEY_AXES);
  });

  it("creates, charges and renews the mandate with a reconciled renewal", () => {
    expect(outcome.details.chargeCountM1).toBe(1n);
    expect(outcome.details.chargeCountM2).toBe(1n);
    expect(outcome.details.renewalOutcome).toBe("RENEWAL_AUTHORIZED");
    expect(outcome.details.renewalReasons).toEqual([]);
    expect(outcome.details.renewalCaseStatus).toBe("RESOLVED");
    expect(outcome.details.certificateRenewalRef).toBe("case:recurring:renewal-1");
  });

  it("treats a term change as authority expansion requiring re-authorization", () => {
    expect(outcome.details.termChangeOutcome).toBe("AUTHORITY_EXPANSION");
    expect(outcome.details.termChangeReasons).toContain("CHARGE_MAXIMUM_RAISED");
    expect(outcome.details.termChangeReauthRequired).toBe(true);
  });

  it("cancels the mandate and stops further charges", () => {
    expect(outcome.details.cancelledState).toBe("CANCELLED");
    expect(outcome.details.chargeAfterCancelAdmissible).toBe(false);
  });

  it("settles both charges with exact per-charge fees", () => {
    expect(outcome.details.chains).toHaveLength(2);
    expect(outcome.details.totalFees).toEqual(fromMinorUnits(USD, 200n));
    for (const chain of outcome.details.chains) {
      expect(chain.settlements[0]?.finality.state).toBe("FINAL");
      expect(chain.settlements[0]?.instruction.amount).toEqual(fromMinorUnits(USD, 10_000n));
    }
  });
});
