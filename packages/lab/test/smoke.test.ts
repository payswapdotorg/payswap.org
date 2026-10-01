import { describe, expect, it } from "vitest";
import {
  PACKAGE_NAME,
  PAYMENT_ROUTING_DOMAIN_PACK,
  getBaselineSuite,
} from "@payswap/lab";

/**
 * Smoke: the package surface is intact and the canonical Domain Pack
 * validates.
 */

describe("@payswap/lab smoke", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("@payswap/lab");
  });

  it("the canonical payment-routing Domain Pack declares the ten LAB.md dimensions", () => {
    const pack = PAYMENT_ROUTING_DOMAIN_PACK;
    expect(pack.domain).toBe("payment-routing");
    expect(pack.scenarioTypes.length).toBeGreaterThan(0);
    expect(pack.hardConstraints.length).toBeGreaterThan(0);
    expect(pack.objectives.length).toBeGreaterThan(0);
    expect(pack.observables.length).toBeGreaterThan(0);
    expect(pack.actionSpace.length).toBeGreaterThan(0);
    expect(pack.failureTaxonomy.length).toBeGreaterThan(0);
    expect(pack.policySet.length).toBeGreaterThan(0);
    expect(pack.evaluationSuite.suiteId).toBe("lab.baseline-suite");
    expect(pack.provenanceRequirements.length).toBeGreaterThan(0);
  });

  it("the baseline suite is non-empty and self-consistent", () => {
    const suite = getBaselineSuite();
    expect(suite.scenarios.length).toBeGreaterThanOrEqual(13);
    expect(suite.candidates.length).toBe(4);
    expect(suite.domainPackId).toBe(PAYMENT_ROUTING_DOMAIN_PACK.packId);
    expect(suite.suiteId).toBe(PAYMENT_ROUTING_DOMAIN_PACK.evaluationSuite.suiteId);
  });
});
