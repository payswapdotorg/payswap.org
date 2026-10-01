import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import { runIncentiveLiquidityJourney } from "../src/journeys/incentive-liquidity.js";
import { expectAxesCovered, expectJourneyPasses, JOURNEY_AXES } from "./journey-helpers.js";

describe("Journey: incentive-funded liquidity acquisition (W1-007)", () => {
  const outcome = runIncentiveLiquidityJourney();

  it("passes every acceptance axis", () => {
    expectJourneyPasses(outcome.journey);
  });

  it("asserts the five journey axes", () => {
    expectAxesCovered(outcome.journey, JOURNEY_AXES);
  });

  it("funds the budget before the reward is promised (INV-P01)", () => {
    expect(outcome.details.programId).toBe("prog:liquidity-acquisition");
    expect(outcome.details.budgetFundingStatus).toBe("FUNDED");
    expect(outcome.details.budgetCommittedMinorUnits).toBe(2_500n);
  });

  it("accrues, finalizes and qualifies the reward through the campaign engine", () => {
    expect(outcome.details.accruedState).toBe("PROVISIONAL");
    expect(outcome.details.finalizedState).toBe("CONFIRMED");
    expect(outcome.details.claimableState).toBe("CLAIMABLE");
    expect(outcome.details.rewardAmount).toEqual(fromMinorUnits(USD, 2_500n));
    expect(outcome.details.rewardReproducible).toBe(true);
    expect(outcome.details.rewardObligationCount).toBe(1);
  });

  it("acquires liquidity through the protocol authority and settles the reward obligation", () => {
    expect(outcome.details.liquidityAssetId).toBe("liq:lp-alpha-wallet");
    expect(outcome.details.liquidityAvailableBeforeMinorUnits).toBe(500_000n);
    expect(outcome.details.liquidityReservedMinorUnits).toBe(250_000n);
    expect(outcome.details.liquidityAvailableAfterMinorUnits).toBe(250_000n);
    expect(outcome.details.sponsorBalanceAfter).toEqual(fromMinorUnits(USD, 47_500n));
    expect(outcome.details.chain.settlements[0]?.finality.state).toBe("FINAL");
  });
});
