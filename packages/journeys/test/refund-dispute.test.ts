import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import { runRefundDisputeJourney } from "../src/journeys/refund-dispute.js";
import { expectAxesCovered, expectJourneyPasses, JOURNEY_AXES } from "./journey-helpers.js";

describe("Journey: refund/dispute lifecycle (W1-007)", () => {
  const outcome = runRefundDisputeJourney();

  it("passes every acceptance axis", () => {
    expectJourneyPasses(outcome.journey);
  });

  it("asserts the five journey axes", () => {
    expectAxesCovered(outcome.journey, JOURNEY_AXES);
  });

  it("does not rewrite the original (recourse immutability)", () => {
    expect(outcome.details.originalObligationState).toBe("SETTLED");
    expect(outcome.details.originalFinalityState).toBe("FINAL");
    expect(outcome.details.disputeState).toBe("GRANTED");
    expect(outcome.details.grantedAmount).toEqual(fromMinorUnits(USD, 60_000n));
  });

  it("mints the refund as a SEPARATE recourse obligation", () => {
    expect(outcome.details.recourseObligationSeparate).toBe(true);
    expect(outcome.details.recourseObligationId).not.toBe(outcome.details.originalObligationId);
    expect(outcome.details.recourseChain.settlements[0]?.finality.state).toBe("FINAL");
    expect(outcome.details.recourseChain.settlements[0]?.instruction.amount).toEqual(
      fromMinorUnits(USD, 60_000n),
    );
  });

  it("accounts escrow separately in a dedicated RESERVE account", () => {
    expect(outcome.details.escrowState).toBe("RELEASED");
    expect(outcome.details.escrowAccountBalance).toEqual(fromMinorUnits(USD, 0n));
    expect(outcome.details.payerBalanceAfter).toEqual(fromMinorUnits(USD, 170_000n));
    expect(outcome.details.merchantBalanceAfter).toEqual(fromMinorUnits(USD, 30_000n));
  });
});
