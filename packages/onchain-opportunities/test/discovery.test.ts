import { describe, expect, it } from "vitest";
import { OpportunityDiscoveryError, discoverOpportunity } from "../src/index.js";
import type { ArbitrageLeg, OpportunityObservationInput } from "../src/index.js";
import {
  CHAIN,
  MAX_AGE_MS,
  NOW,
  discoveryCatalog,
  healthyArbitrageObservation,
  healthyIncentivesObservation,
  healthyLendingObservation,
  healthyLiquidityObservation,
  healthyStakingObservation,
} from "./fixtures.js";

/**
 * P4-W3-002 discovery: family estimation is evidence-backed and exact —
 * the point is the sum of observed components, the lower bound counts
 * VERIFIED components only (incentives need a reserved budget), an
 * unverified-only estimate is honestly UNKNOWN, and arbitrage spreads are
 * derived from the two venue legs with a lower bound net of observed costs.
 * All arithmetic is exact rationals — never floating point.
 */
describe("P4-W3-002 evidence-backed discovery and estimation", () => {
  it("liquidity: the estimate is the observed fee yield with bounds [verified, total]", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(opportunity.family).toBe("liquidity");
    expect(opportunity.expectedReturn.estimateKind).toBe("EVIDENCE_BACKED_ESTIMATE");
    expect(opportunity.expectedReturn.point).toEqual({ numerator: "431", denominator: "10000" });
    expect(opportunity.expectedReturn.bounds?.low).toEqual({
      numerator: "431",
      denominator: "10000",
    });
    expect(opportunity.expectedReturn.bounds?.high).toEqual({
      numerator: "431",
      denominator: "10000",
    });
    expect(opportunity.expectedReturn.basis).toMatch(/estimate/i);
    expect(opportunity.expectedReturn.components).toHaveLength(1);
  });

  it("lending: the estimate is the observed supply APY with the same bounds discipline", () => {
    const opportunity = discoverOpportunity(healthyLendingObservation(), NOW);
    expect(opportunity.family).toBe("lending");
    expect(opportunity.expectedReturn.point).toEqual({ numerator: "350", denominator: "10000" });
    expect(opportunity.expectedReturn.components[0]?.kind).toBe("SUPPLY_APY");
  });

  it("staking: the estimate is the observed staking yield; the unbonding lock is disclosed", () => {
    const opportunity = discoverOpportunity(healthyStakingObservation(), NOW);
    expect(opportunity.family).toBe("staking");
    expect(opportunity.expectedReturn.point).toEqual({ numerator: "380", denominator: "10000" });
    expect(opportunity.lockUp.locked).toBe(true);
    expect(opportunity.lockUp.durationMs).toBe(1_209_600_000);
    expect(opportunity.exitPath.status).toBe("RESTRICTED");
  });

  it("incentives: the estimate is the observed reward rate; budget reservation is recorded", () => {
    const opportunity = discoverOpportunity(healthyIncentivesObservation(), NOW);
    expect(opportunity.family).toBe("incentives");
    expect(opportunity.expectedReturn.point).toEqual({ numerator: "120", denominator: "10000" });
    expect(opportunity.expectedReturn.components[0]?.budgetReserved).toBe(true);
  });

  it("an unverified-only incentive estimate is honestly UNKNOWN (point and bounds null)", () => {
    const input = {
      ...healthyIncentivesObservation(),
      returnComponents: [
        {
          componentId: "inc:rebate",
          kind: "INCENTIVE_YIELD" as const,
          ratePerYear: { numerator: "950", denominator: "10000" },
          evidenceVerified: false,
          budgetReserved: false,
          description: "unverified reward program claim observed on a forum",
        },
      ],
    };
    const opportunity = discoverOpportunity(input, NOW);
    expect(opportunity.expectedReturn.point).toBeNull();
    expect(opportunity.expectedReturn.bounds).toBeNull();
    expect(opportunity.expectedReturn.basis).toMatch(/UNKNOWN/i);
    expect(opportunity.policyEligibility.eligible).toBe(false);
  });

  it("a verified component PLUS an unverified component: the lower bound counts the verified one only", () => {
    const input = {
      ...healthyLiquidityObservation(),
      returnComponents: [
        {
          componentId: "liq:fee-yield",
          kind: "FEE_YIELD" as const,
          ratePerYear: { numerator: "431", denominator: "10000" },
          evidenceVerified: true,
          description: "observed fee yield, annualized",
        },
        {
          componentId: "liq:forum-claim",
          kind: "FEE_YIELD" as const,
          ratePerYear: { numerator: "500", denominator: "10000" },
          evidenceVerified: false,
          description: "an additional yield claim observed without verified evidence",
        },
      ],
    };
    const opportunity = discoverOpportunity(input, NOW);
    // point = 431/10000 + 500/10000 = 931/10000
    expect(opportunity.expectedReturn.point).toEqual({ numerator: "9310000", denominator: "100000000" });
    // lower bound = verified only = 431/10000
    expect(opportunity.expectedReturn.bounds?.low).toEqual({
      numerator: "431",
      denominator: "10000",
    });
    expect(opportunity.expectedReturn.bounds?.high).toEqual({
      numerator: "9310000",
      denominator: "100000000",
    });
  });

  describe("arbitrage: exact spread derivation from the two venue legs", () => {
    it("the point is the gross observed spread; the lower bound is net of observed costs", () => {
      const opportunity = discoverOpportunity(healthyArbitrageObservation(), NOW);
      expect(opportunity.family).toBe("arbitrage");
      // spread = (1020/1000 − 1005/1000) / (1005/1000) = 15000/1005000
      expect(opportunity.expectedReturn.point).toEqual({
        numerator: "15000",
        denominator: "1005000",
      });
      // net lower bound = 15000/1005000 − 5/10000
      //   = (15000·10000 − 5·1005000) / (1005000·10000) = 144975000/10050000000
      //   (exact; unreduced — the repo exact-math convention)
      expect(opportunity.expectedReturn.bounds?.low).toEqual({
        numerator: "144975000",
        denominator: "10050000000",
      });
      expect(opportunity.expectedReturn.bounds?.high).toEqual({
        numerator: "15000",
        denominator: "1005000",
      });
      expect(opportunity.expectedReturn.components[0]?.kind).toBe("PRICE_DIFFERENCE");
    });

    it("the legs are preserved verbatim on the record (evidence preservation)", () => {
      const opportunity = discoverOpportunity(healthyArbitrageObservation(), NOW);
      expect(opportunity.arbitrageLegs).toHaveLength(2);
      expect(opportunity.arbitrageLegs?.[0]?.venueId).toBe("venue:quote-a");
      expect(opportunity.arbitrageLegs?.[1]?.venueId).toBe("venue:quote-b");
      expect(opportunity.arbitrageLegs?.[0]?.freshness.maxAgeMs).toBe(MAX_AGE_MS);
    });

    it("an equal-price pair yields an honest zero estimate (no fabricated spread)", () => {
      const input = {
        ...healthyArbitrageObservation(),
        arbitrageLegs: [
          {
            legId: "leg:venue-a",
            venueId: "venue:quote-a",
            price: { numerator: "1005", denominator: "1000" },
            freshness: { asOfMs: NOW, maxAgeMs: MAX_AGE_MS },
            withdrawalLiquidityMinorUnits: "15000000000",
          },
          {
            legId: "leg:venue-b",
            venueId: "venue:quote-b",
            price: { numerator: "1005", denominator: "1000" },
            freshness: { asOfMs: NOW, maxAgeMs: MAX_AGE_MS },
            withdrawalLiquidityMinorUnits: "12000000000",
          },
        ],
      };
      const opportunity = discoverOpportunity(input, NOW);
      // Equal prices: an honest ZERO spread, exactly derived (0/1005000 —
      // unreduced, the repo exact-math convention), never fabricated.
      expect(opportunity.expectedReturn.point).toEqual({
        numerator: "0",
        denominator: "1005000",
      });
      // Net of costs the lower bound floors at exact zero.
      expect(opportunity.expectedReturn.bounds?.low).toEqual({ numerator: "0", denominator: "1" });
    });

    it("a zero-price leg fails closed (a zero price is malformed evidence, not a spread)", () => {
      const legs = healthyArbitrageObservation().arbitrageLegs ?? [];
      const input: OpportunityObservationInput = {
        ...healthyArbitrageObservation(),
        observationId: "obs:arb:zero-price",
        arbitrageLegs: [
          legs[0] as ArbitrageLeg,
          {
            ...(legs[1] as ArbitrageLeg),
            price: { numerator: "0", denominator: "1" },
          },
        ],
      };
      expect(() => discoverOpportunity(input, NOW)).toThrow(OpportunityDiscoveryError);
      expect(() => discoverOpportunity(input, NOW)).toThrow(/zero price/);
    });

    it("an arbitrage observation requires EXACTLY two legs (fail closed)", () => {
      const legs = healthyArbitrageObservation().arbitrageLegs ?? [];
      const input: OpportunityObservationInput = {
        ...healthyArbitrageObservation(),
        observationId: "obs:arb:one-leg",
        arbitrageLegs: [legs[0] as ArbitrageLeg],
      };
      expect(() => discoverOpportunity(input, NOW)).toThrow(OpportunityDiscoveryError);
      expect(() => discoverOpportunity(input, NOW)).toThrow(/exactly two/);
    });

    it("a PRICE_DIFFERENCE component can never be supplied directly (derived only)", () => {
      const input = {
        ...healthyLiquidityObservation(),
        observationId: "obs:liq:smuggled-spread",
        returnComponents: [
          {
            componentId: "liq:smuggled",
            kind: "PRICE_DIFFERENCE" as const,
            ratePerYear: { numerator: "1", denominator: "67" },
            evidenceVerified: true,
            description: "a price difference supplied directly instead of derived",
          },
        ],
      };
      expect(() => discoverOpportunity(input, NOW)).toThrow(OpportunityDiscoveryError);
    });
  });

  it("non-arbitrage families require at least one observed component (empty evidence is not an estimate)", () => {
    const input = {
      ...healthyLiquidityObservation(),
      returnComponents: [],
    };
    expect(() => discoverOpportunity(input, NOW)).toThrow(OpportunityDiscoveryError);
  });

  it("the discovery instant is caller-supplied (no ambient clock) — a negative instant fails closed", () => {
    expect(() => discoverOpportunity(healthyLiquidityObservation(), -1)).toThrow(
      OpportunityDiscoveryError,
    );
  });

  it("missing optional evidence surfaces honestly as UNKNOWN with a reason (never guessed)", () => {
    const input = healthyLiquidityObservation({ maxLossKnown: false });
    const { maxLoss: _maxLoss, capitalRequired: _capital, fees: _fees, ...rest } = input;
    const opportunity = discoverOpportunity(rest, NOW);
    expect(opportunity.capitalRequired.kind).toBe("UNKNOWN");
    expect(opportunity.fees.kind).toBe("UNKNOWN");
    expect(opportunity.maxLossBound.kind).toBe("UNKNOWN");
  });

  it("the full discovery catalog constructs across all six families (deterministic counts)", () => {
    const counts: Record<string, number> = {};
    for (const entry of discoveryCatalog()) {
      const opportunity = discoverOpportunity(entry.input, NOW);
      counts[opportunity.family] = (counts[opportunity.family] ?? 0) + 1;
      expect(opportunity.chainKey).toBe(CHAIN);
    }
    expect(counts).toEqual({
      liquidity: 5,
      lending: 4,
      staking: 4,
      incentives: 4,
      arbitrage: 3,
      other: 3,
    });
    expect(discoveryCatalog()).toHaveLength(23);
  });

  it("discovery is deterministic: the same input at the same instant yields the identical record", () => {
    const first = discoverOpportunity(healthyLiquidityObservation(), NOW);
    const second = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(first).toEqual(second);
    expect(first.opportunityId).toBe(second.opportunityId);
  });
});
