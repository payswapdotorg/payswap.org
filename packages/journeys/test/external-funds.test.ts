import { describe, expect, it } from "vitest";
import { runExternalFundsJourney } from "../src/journeys/external-funds.js";
import { expectAxesCovered, expectJourneyPasses, JOURNEY_AXES } from "./journey-helpers.js";

describe("Journey: external-funds position observation (W1-007)", () => {
  const outcome = runExternalFundsJourney();

  it("passes every acceptance axis", async () => {
    expectJourneyPasses((await outcome).journey);
  });

  it("asserts the five journey axes", async () => {
    expectAxesCovered((await outcome).journey, JOURNEY_AXES);
  });

  it("observes the external position through the real rail adapter with freshness + provenance", async () => {
    const details = (await outcome).details;
    expect(details.observedCurrency).toBe("ETH");
    expect(details.observedMinorUnits).toBe("1000000000000000000");
    expect(details.maxAgeSeconds).toBe(180);
    expect(details.provenanceSource).toBe("PROVIDER_API");
    expect(details.freshAtReferenceTime).toBe(true);
  });

  it("reconciles with canonical state and is NEVER custody (INV-C09)", async () => {
    const details = (await outcome).details;
    expect(details.reconciliationOutcome).toBe("MATCHED");
    expect(details.custodyBooking).toBe("NONE");
    expect(details.externalAddressNeverBooked).toBe(true);
    expect(details.caseStatus).toBe("RESOLVED");
    expect(details.certificateReconciliationRefs).toContain("case:extfunds:1");
  });

  it("rejects stale observations and records discrepancies without correction", async () => {
    const details = (await outcome).details;
    expect(details.staleOutcome).toBe("STALE_NOT_USABLE");
    expect(details.discrepancyOutcome).toBe("DISCREPANCY");
  });
});
