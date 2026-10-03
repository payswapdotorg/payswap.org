import { describe, expect, it } from "vitest";
import * as onchainVenues from "../src/index.js";

/** Smoke: the package surface. */
describe("@payswap/onchain-venues smoke", () => {
  it("declares its package name", () => {
    expect(onchainVenues.PACKAGE_NAME).toBe("@payswap/onchain-venues");
  });

  it("exports the neutral pack contract", () => {
    expect(typeof onchainVenues.validateVenueExtensionPack).toBe("function");
    expect(typeof onchainVenues.venuePackId).toBe("function");
    expect(typeof onchainVenues.venueActionCapabilityDefinition).toBe("function");
    expect(typeof onchainVenues.venueConnectedProtocolInstance).toBe("function");
  });
});
