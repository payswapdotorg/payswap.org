import { describe, expect, it } from "vitest";
import {
  DISCOVERY_TIER,
  OPPORTUNITY_DISCOVERY_NON_PRODUCTION_CONSTRAINT,
  OPPORTUNITY_FAMILIES,
  PACKAGE_NAME,
  GUARANTEE_LANGUAGE_PATTERNS,
  discoveryPermitsExecution,
} from "../src/index.js";

/**
 * Package smoke (the repo-wide smoke-test convention): the public surface,
 * constants and laws are exactly what the work order demands.
 */
describe("package smoke (P4-W3-002)", () => {
  it("exposes the canonical package name", () => {
    expect(PACKAGE_NAME).toBe("@payswap/onchain-opportunities");
  });

  it("the six opportunity families are exactly the work order's family list", () => {
    expect([...OPPORTUNITY_FAMILIES]).toEqual([
      "liquidity",
      "lending",
      "staking",
      "incentives",
      "arbitrage",
      "other",
    ]);
  });

  it("the structural discovery tier is DISCOVERY_NEVER_AUTHORIZATION", () => {
    expect(DISCOVERY_TIER).toBe("DISCOVERY_NEVER_AUTHORIZATION");
    expect(discoveryPermitsExecution()).toBe(false);
  });

  it("the Lab non-production constraint is exported for discovery results", () => {
    expect(OPPORTUNITY_DISCOVERY_NON_PRODUCTION_CONSTRAINT).toBe(
      "OPPORTUNITY_DISCOVERY_IS_NOT_PRODUCTION_EXECUTION",
    );
  });

  it("the guarantee-vocabulary pattern list is frozen and non-empty", () => {
    expect(Object.isFrozen(GUARANTEE_LANGUAGE_PATTERNS)).toBe(true);
    expect(GUARANTEE_LANGUAGE_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });
});
