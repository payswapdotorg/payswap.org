import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  OPPORTUNITY_FAMILIES,
  isOpportunityFamily,
  opportunityId,
  validateFinancialOpportunity,
  discoverOpportunity,
} from "../src/index.js";
import type { FinancialOpportunity } from "../src/index.js";
import {
  CHAIN,
  NOW,
  discoveryCatalog,
  healthyLiquidityObservation,
  healthyOtherObservation,
} from "./fixtures.js";

/**
 * P4-W3-002 task packet: each opportunity MUST expose the mandated typed
 * first-class fields. The model validator fails closed on every missing or
 * malformed field; the deterministic identity is re-derived; the record is
 * frozen; and Knowable values carry UNKNOWN honestly with a reason.
 */
describe("P4-W3-002 the FinancialOpportunity model", () => {
  it("the six policy-approved families are the frozen family vocabulary", () => {
    expect(OPPORTUNITY_FAMILIES).toEqual([
      "liquidity",
      "lending",
      "staking",
      "incentives",
      "arbitrage",
      "other",
    ]);
    expect(isOpportunityFamily("liquidity")).toBe(true);
    expect(isOpportunityFamily("yield-farming")).toBe(false);
    expect(isOpportunityFamily(null)).toBe(false);
  });

  it("the deterministic identity is `opportunity:${family}:${chainKey}:${venueId}:${observationId}`", () => {
    expect(opportunityId("liquidity", CHAIN, "venue:stable-pair", "obs:liq:001")).toBe(
      `opportunity:liquidity:${CHAIN}:venue:stable-pair:obs:liq:001`,
    );
  });

  it("EVERY catalog opportunity exposes ALL mandated first-class fields (typed)", () => {
    for (const entry of discoveryCatalog()) {
      const opportunity = discoverOpportunity(entry.input, NOW);
      // The task packet's field checklist — each a typed first-class field.
      expect(opportunity.capitalRequired, entry.label).toBeDefined();
      expect(opportunity.expectedReturn, entry.label).toBeDefined();
      expect(opportunity.liquidity, entry.label).toBeDefined();
      expect(opportunity.fees, entry.label).toBeDefined();
      expect(opportunity.exitPath, entry.label).toBeDefined();
      expect(opportunity.lockUp, entry.label).toBeDefined();
      expect(opportunity.smartContractRisk, entry.label).toBeDefined();
      expect(opportunity.oracleBridgeRisk, entry.label).toBeDefined();
      expect(opportunity.maxLossBound, entry.label).toBeDefined();
      expect(opportunity.evidenceFreshness, entry.label).toBeDefined();
      expect(opportunity.policyEligibility, entry.label).toBeDefined();
      // The observation-law evidence chain is preserved on the record.
      expect(opportunity.provenance.observationId.length, entry.label).toBeGreaterThan(0);
      expect(opportunity.provenance.evidenceRefs.length, entry.label).toBeGreaterThan(0);
      // The structural never-authorization tier is stamped.
      expect(opportunity.discoveryTier).toBe("DISCOVERY_NEVER_AUTHORIZATION");
      expect(opportunity.observationKind).toBe("FinancialOpportunity");
    }
  });

  it("a healthy liquidity opportunity round-trips through the validator", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(() => validateFinancialOpportunity(opportunity)).not.toThrow();
    const revalidated = validateFinancialOpportunity(
      JSON.parse(JSON.stringify(opportunity)) as unknown,
    );
    expect(revalidated.opportunityId).toBe(opportunity.opportunityId);
    expect(revalidated.family).toBe("liquidity");
  });

  it("the record is deep-frozen (immutable data, never mutable authority)", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(Object.isFrozen(opportunity)).toBe(true);
    expect(Object.isFrozen(opportunity.provenance)).toBe(true);
    expect(Object.isFrozen(opportunity.expectedReturn.components)).toBe(true);
    expect(() => {
      (opportunity as unknown as { title: string }).title = "mutated";
    }).toThrow();
  });

  it("Knowable values: KNOWN carries the value; UNKNOWN carries an honest reason", () => {
    const known = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(known.maxLossBound.kind).toBe("KNOWN");
    if (known.maxLossBound.kind === "KNOWN") {
      expect(known.maxLossBound.value.fractionOfCapital).toEqual({
        numerator: "5",
        denominator: "100",
      });
    }

    const unknown = discoverOpportunity(
      healthyLiquidityObservation({ maxLossKnown: false }),
      NOW,
    );
    expect(unknown.maxLossBound.kind).toBe("UNKNOWN");
    if (unknown.maxLossBound.kind === "UNKNOWN") {
      expect(unknown.maxLossBound.reason.length).toBeGreaterThan(0);
      expect(unknown.maxLossBound.reason).toMatch(/honest UNKNOWN/i);
    }
  });

  describe("the validator fails closed on malformed opportunities (never repaired)", () => {
    function malformed(
      mutate: (opportunity: FinancialOpportunity) => Record<string, unknown>,
    ): unknown {
      const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
      return mutate(opportunity);
    }

    it("rejects a wrong nominal observationKind", () => {
      const candidate = malformed((opportunity) => ({
        ...opportunity,
        observationKind: "ExecutionRequest",
      }));
      expect(() => validateFinancialOpportunity(candidate)).toThrow(ValidationError);
    });

    it("rejects a missing never-authorization tier", () => {
      const candidate = malformed((opportunity) => {
        const { discoveryTier: _tier, ...rest } = opportunity;
        return rest;
      });
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/discoveryTier/);
    });

    it("rejects a forged tier value", () => {
      const candidate = malformed((opportunity) => ({
        ...opportunity,
        discoveryTier: "PRODUCTION_AUTHORIZATION",
      }));
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/DISCOVERY_NEVER_AUTHORIZATION/);
    });

    it("rejects an unknown family", () => {
      const candidate = malformed((opportunity) => ({
        ...opportunity,
        family: "yield-farming",
      }));
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/family/);
    });

    it("rejects a non-deterministic identity", () => {
      const candidate = malformed((opportunity) => ({
        ...opportunity,
        opportunityId: "opportunity:some-other-id",
      }));
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/deterministic/);
    });

    it("rejects missing evidence freshness (the observation law)", () => {
      const candidate = malformed((opportunity) => {
        const { evidenceFreshness: _freshness, ...rest } = opportunity;
        return rest;
      });
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/evidenceFreshness/);
    });

    it("rejects an empty evidence chain (INV-E02)", () => {
      const candidate = malformed((opportunity) => ({
        ...opportunity,
        provenance: { ...opportunity.provenance, evidenceRefs: [] },
      }));
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/evidenceRefs/);
    });

    it("rejects a non-canonical chain key", () => {
      const candidate = malformed((opportunity) => ({
        ...opportunity,
        chainKey: "not a chain key",
        provenance: { ...opportunity.provenance, chainKey: "not a chain key" },
      }));
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/chainKey/);
    });

    it("rejects an estimate without bounds (a claim, not an estimate)", () => {
      const candidate = malformed((opportunity) => ({
        ...opportunity,
        expectedReturn: {
          ...opportunity.expectedReturn,
          bounds: null,
        },
      }));
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/bounds/);
    });

    it("rejects floating-point-shaped money (INV-F01)", () => {
      const candidate = malformed((opportunity) => ({
        ...opportunity,
        capitalRequired: {
          kind: "KNOWN",
          value: {
            assetRef: `${CHAIN}/asset:USCD`,
            minorUnits: "1.5",
          },
        },
      }));
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/minorUnits|capital/);
    });

    it("rejects an unknown exit-path status", () => {
      const candidate = malformed((opportunity) => ({
        ...opportunity,
        exitPath: { ...opportunity.exitPath, status: "INSTANT" },
      }));
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/exitPath.status/);
    });

    it("rejects an ineligible opportunity with no machine-readable reason", () => {
      const candidate = malformed((opportunity) => ({
        ...opportunity,
        policyEligibility: { eligible: false, reasons: [], decidedBy: "discovery-policy" },
      }));
      expect(() => validateFinancialOpportunity(candidate)).toThrow(/reason/);
    });

    it("rejects non-object input outright", () => {
      expect(() => validateFinancialOpportunity(null)).toThrow(ValidationError);
      expect(() => validateFinancialOpportunity("opportunity")).toThrow(ValidationError);
      expect(() => validateFinancialOpportunity(42)).toThrow(ValidationError);
    });
  });

  it("the 'other' family preserves its policy approval reference on the record", () => {
    const opportunity = discoverOpportunity(healthyOtherObservation(), NOW);
    expect(opportunity.policyApprovalRef).toBe(
      "policy-approval:strategy:rebalance-001",
    );
  });
});
