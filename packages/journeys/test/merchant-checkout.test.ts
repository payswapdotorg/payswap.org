import { describe, expect, it } from "vitest";
import { GHS, fromMinorUnits } from "@payswap/protocol";
import { runMerchantCheckoutJourney } from "../src/journeys/merchant-checkout.js";
import { expectAxesCovered, expectJourneyPasses, JOURNEY_AXES } from "./journey-helpers.js";

describe("Journey: merchant checkout (W1-007)", () => {
  const outcome = runMerchantCheckoutJourney();

  it("passes every acceptance axis", () => {
    expectJourneyPasses(outcome.journey);
  });

  it("asserts the five journey axes", () => {
    expectAxesCovered(outcome.journey, JOURNEY_AXES);
  });

  it("derives the offer from acceptance with method-selection reasons", () => {
    expect(outcome.details.offerDerived).toBe(true);
    expect(outcome.details.offerFees).toEqual(fromMinorUnits(GHS, 1_500n));
    expect(outcome.details.offerMode).toBe("COMPOSED_PAYSWAP");
    expect(outcome.details.offerRailPath).toContain("cap.mobile_money.collect");
    expect(outcome.details.acceptedReasons).toEqual([]);
    expect(outcome.details.cardRejected).toBe(true);
    expect(outcome.details.cardRejectionReasons).toContain("METHOD_NOT_IN_CATALOG");
    expect(outcome.details.geographyRejectionReasons).toContain("GEOGRAPHY_NOT_SERVED");
  });

  it("authorizes the translation and requires re-authorization on material-term drift", () => {
    expect(outcome.details.translationAuthorized).toBe(true);
    expect(outcome.details.translationDriftRequiresReauth).toBe(true);
  });

  it("keeps the two availability axes separate (INV-C01/C02)", () => {
    expect(outcome.details.twoAxisAvailability.reachableAvailable).toBe("AVAILABLE");
    expect(outcome.details.twoAxisAvailability.unreachableUnknown).toBe("UNKNOWN");
  });

  it("settles to the explicit destination with exact fee accounting", () => {
    const settlement = outcome.details.chain.settlements[0];
    expect(settlement?.instruction.settlementDestinationId).toBe("dest:merchant-gh");
    expect(settlement?.instruction.amount).toEqual(fromMinorUnits(GHS, 50_000n));
    expect(outcome.details.feeIncome).toEqual(fromMinorUnits(GHS, 1_500n));
    expect(outcome.details.merchantBalanceAfter).toEqual(fromMinorUnits(GHS, 50_000n));
    expect(outcome.details.certificateDocumentRefs).toEqual([
      { documentKind: "INVOICE", documentId: "doc-5001" },
    ]);
  });
});
