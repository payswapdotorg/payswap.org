import { describe, expect, it } from "vitest";
import { GHS, USD, fromMinorUnits } from "@payswap/protocol";
import { runCrossBorderJourney } from "../src/journeys/cross-border.js";
import { expectAxesCovered, expectJourneyPasses, JOURNEY_AXES } from "./journey-helpers.js";

describe("Journey: cross-border (W1-007)", () => {
  const outcome = runCrossBorderJourney();

  it("passes every acceptance axis", () => {
    expectJourneyPasses(outcome.journey);
  });

  it("asserts the five journey axes", () => {
    expectAxesCovered(outcome.journey, JOURNEY_AXES);
  });

  it("retains FX rate provenance (INV-F09)", () => {
    expect(outcome.details.rateSource).toContain("ecb-reference-rates");
    expect(outcome.details.rateSourceRef).toContain("ecb-daily:");
    expect(outcome.details.spreadBasisPoints).toBe(150n);
    expect(outcome.details.fxFee).toEqual(fromMinorUnits(GHS, 200n));
    expect(outcome.details.provenanceObservedAt).toBeGreaterThan(0n);
  });

  it("converts exactly through the rational cross rate (INV-F01)", () => {
    expect(outcome.details.quoteRate.numerator).toBe(162n * 10_000n);
    expect(outcome.details.quoteRate.denominator).toBe(10n * 11_355n);
    expect(outcome.details.convertedAmount).toEqual(fromMinorUnits(GHS, 32_400n));
    expect(outcome.details.usdObligationMinorUnits).toBe(2_271n);
    expect(outcome.details.ghsObligationMinorUnits).toBe(32_400n);
  });

  it("settles both currency legs and reconciles accounting", () => {
    expect(outcome.details.chain.settlements).toHaveLength(2);
    expect(outcome.details.payerBalanceAfter).toEqual(fromMinorUnits(USD, 97_729n));
    expect(outcome.details.merchantBalanceAfter).toEqual(fromMinorUnits(GHS, 32_200n));
  });
});
