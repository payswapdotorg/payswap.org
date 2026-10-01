import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import { runCustomerActionJourney } from "../src/journeys/customer-action.js";
import { expectAxesCovered, expectJourneyPasses, JOURNEY_AXES } from "./journey-helpers.js";

describe("Journey: customer-action-required payment (W1-007)", () => {
  const outcome = runCustomerActionJourney();

  it("passes every acceptance axis", () => {
    expectJourneyPasses(outcome.journey);
  });

  it("asserts the five journey axes", () => {
    expectAxesCovered(outcome.journey, JOURNEY_AXES);
  });

  it("preserves the provider challenge losslessly and surfaces it (INV-C06)", () => {
    expect(outcome.details.challengeKind).toBe("3DS_CHALLENGE");
    expect(outcome.details.challengeMessage).toBe("Approve the payment in your banking app");
    expect(outcome.details.challengeDeepLink).toBe("bankapp://approve/pi_3ds_1");
    expect(outcome.details.awaitingState).toBe("AWAITING_CUSTOMER_ACTION");
    expect(outcome.details.pendingActionsCount).toBe(1);
  });

  it("classifies the challenge as awaiting customer action, never FAILED (INV-X01)", () => {
    expect(outcome.details.classificationAtChallenge).toBe("AWAITING_CUSTOMER_ACTION");
  });

  it("completes ONLY on external action evidence with append-only revisions (INV-E05)", () => {
    expect(outcome.details.revisionHistoryCount).toBe(3);
    expect(outcome.details.completionOnExternalEvidence).toBe(true);
    expect(outcome.details.finalAttemptState).toBe("SUCCEEDED");
    expect(outcome.details.chain.settlements[0]?.finality.state).toBe("FINAL");
    expect(outcome.details.chain.settlements[0]?.instruction.amount).toEqual(fromMinorUnits(USD, 25_000n));
  });
});
