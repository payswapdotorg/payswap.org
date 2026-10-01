import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@payswap/certification";

describe("@payswap/certification smoke (W2-006)", () => {
  it("exposes the package surface", () => {
    expect(PACKAGE_NAME).toBe("@payswap/certification");
  });
});
