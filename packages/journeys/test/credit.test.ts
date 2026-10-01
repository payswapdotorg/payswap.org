import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import { runCreditJourney } from "../src/journeys/credit.js";
import { expectAxesCovered, expectJourneyPasses, JOURNEY_AXES } from "./journey-helpers.js";

describe("Journey: lending/credit (W1-007)", () => {
  const outcome = runCreditJourney();

  it("passes every acceptance axis", () => {
    expectJourneyPasses(outcome.journey);
  });

  it("asserts the five journey axes", () => {
    expectAxesCovered(outcome.journey, JOURNEY_AXES);
  });

  it("tracks exposure on an explicit credit line (INV-F08)", () => {
    expect(outcome.details.creditLineId).toBe("cl:merchant-x-1");
    expect(outcome.details.limitMinorUnits).toBe(500_000n);
    expect(outcome.details.utilizedBeforeRepay).toBe(400_000n);
    expect(outcome.details.utilizedAfterRepay).toBe(0n);
    expect(outcome.details.exposureOutstanding).toBe(400_000n);
    expect(outcome.details.exposureReason).toBe("DELAYED_SETTLEMENT_BACKING");
    expect(outcome.details.limitExceededRejected).toBe(true);
  });

  it("accounts collateral separately in a dedicated RESERVE account", () => {
    expect(outcome.details.collateralId).toBe("col:merchant-x-cash-1");
    expect(outcome.details.collateralAccountBalance).toEqual(fromMinorUnits(USD, 300_000n));
  });

  it("settles the backed obligation and charges the exact fee", () => {
    const backing = outcome.details.chain.obligations[0];
    expect(backing?.debtor).toBe("merchant:merchant-x");
    expect(outcome.details.chain.settlements[0]?.finality.state).toBe("FINAL");
    expect(outcome.details.creditFee).toEqual(fromMinorUnits(USD, 2_000n));
  });
});
