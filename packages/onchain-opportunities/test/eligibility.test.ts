import { describe, expect, it } from "vitest";
import {
  MAX_PLAUSIBLE_RETURN_PER_YEAR,
  evaluateDiscoveryPolicy,
  discoverOpportunity,
} from "../src/index.js";
import {
  MAX_AGE_MS,
  NOW,
  adversarialEntries,
  discoveryCatalog,
  fakeIncentiveObservation,
  healthyIncentivesObservation,
  healthyLiquidityObservation,
  healthyLiquidityObservation as liquidity,
  healthyOtherObservation,
  manipulatedApyObservation,
  staleQuoteObservation,
  staleStakingObservation,
  unapprovedOtherObservation,
  unreservedBudgetObservation,
  vanishedLiquidityObservation,
} from "./fixtures.js";

/**
 * P4-W3-002 hard requirement 5 (the adversarial policy): stale quotes,
 * manipulated APYs, fake incentives, vanished liquidity, honeypot exit
 * paths and unapproved strategies each surface as ineligible (or honestly
 * UNKNOWN-flagged) — never as an attractive opportunity. UNKNOWN states
 * (max-loss, estimate) are FLAGS, never ineligibility (UNKNOWN is not
 * FAILED).
 */
describe("P4-W3-002 the deterministic discovery policy", () => {
  it("healthy opportunities are eligible with no ineligibility reasons", () => {
    for (const entry of discoveryCatalog()) {
      if (!entry.label.includes("healthy")) {
        continue;
      }
      const opportunity = discoverOpportunity(entry.input, NOW);
      expect(opportunity.policyEligibility.eligible, entry.label).toBe(true);
      expect(opportunity.policyEligibility.reasons, entry.label).toEqual([]);
    }
  });

  describe("the adversarial fixtures surface as ineligible (never attractive)", () => {
    const expectedReasons: Readonly<Record<string, readonly string[]>> = {
      "liquidity:adversarial-stale": ["STALE_OBSERVATION"],
      "liquidity:adversarial-honeypot": ["EXIT_PATH_SUSPECT_HONEYPOT"],
      "lending:adversarial-manipulated-apy": ["SUSPECT_RETURN_OUTSIDE_PLAUSIBLE_BAND"],
      "staking:adversarial-stale": ["STALE_OBSERVATION"],
      "incentives:adversarial-fake": ["UNVERIFIED_INCENTIVE_COMPONENT", "INCENTIVE_BUDGET_NOT_RESERVED"],
      "incentives:adversarial-unreserved": ["INCENTIVE_BUDGET_NOT_RESERVED"],
      "arbitrage:adversarial-vanished-liquidity": ["WITHDRAWAL_LIQUIDITY_VANISHED"],
      "other:adversarial-unapproved": ["POLICY_APPROVAL_MISSING"],
    };

    for (const entry of adversarialEntries()) {
      it(`${entry.label} → ineligible with ${expectedReasons[entry.label]?.join(", ")}`, () => {
        const opportunity = discoverOpportunity(entry.input, NOW);
        expect(opportunity.policyEligibility.eligible, entry.label).toBe(false);
        expect([...opportunity.policyEligibility.reasons], entry.label).toEqual(
          expectedReasons[entry.label] ?? [],
        );
      });
    }

    it("EVERY adversarial entry in the catalog is ineligible (table-driven sweep)", () => {
      expect(adversarialEntries()).toHaveLength(8);
      for (const entry of adversarialEntries()) {
        const opportunity = discoverOpportunity(entry.input, NOW);
        expect(opportunity.policyEligibility.eligible, entry.label).toBe(false);
        expect(opportunity.policyEligibility.reasons.length, entry.label).toBeGreaterThan(0);
      }
    });
  });

  it("the manipulated-APY point estimate is NOT repeated as attractive evidence (800,000%/yr flagged)", () => {
    const opportunity = discoverOpportunity(manipulatedApyObservation(), NOW);
    // The estimate is still surfaced (honest observation), but the policy
    // flags it outside the frozen plausibility band and marks ineligible.
    expect(opportunity.expectedReturn.point).toEqual({ numerator: "8000", denominator: "1" });
    expect(opportunity.policyEligibility.reasons).toContain(
      "SUSPECT_RETURN_OUTSIDE_PLAUSIBLE_BAND",
    );
  });

  it("the plausibility ceiling is the frozen 1000%/yr discovery-policy constant", () => {
    expect(MAX_PLAUSIBLE_RETURN_PER_YEAR).toEqual({ numerator: "10", denominator: "1" });
  });

  it("a point exactly at the ceiling is NOT flagged (the boundary is inclusive)", () => {
    const input = {
      ...liquidity(),
      observationId: "obs:liq:at-ceiling",
      returnComponents: [
        {
          componentId: "liq:fee-yield",
          kind: "FEE_YIELD" as const,
          ratePerYear: { numerator: "10", denominator: "1" },
          evidenceVerified: true,
          description: "observed fee yield exactly at the plausibility ceiling",
        },
      ],
    };
    const opportunity = discoverOpportunity(input, NOW);
    expect(opportunity.policyEligibility.reasons).not.toContain(
      "SUSPECT_RETURN_OUTSIDE_PLAUSIBLE_BAND",
    );
  });

  it("a fake incentive makes the estimate UNKNOWN (no verified component) AND ineligible", () => {
    const opportunity = discoverOpportunity(fakeIncentiveObservation(), NOW);
    expect(opportunity.expectedReturn.point).toBeNull();
    expect(opportunity.policyEligibility.eligible).toBe(false);
    const evaluation = evaluateDiscoveryPolicy(opportunity, NOW);
    expect(evaluation.reasons).toContain("UNVERIFIED_INCENTIVE_COMPONENT");
    expect(evaluation.reasons).toContain("INCENTIVE_BUDGET_NOT_RESERVED");
  });

  it("an unreserved incentive budget is ineligible even with verified evidence (AGENTS.md rule 13)", () => {
    const opportunity = discoverOpportunity(unreservedBudgetObservation(), NOW);
    // An unreserved-budget incentive is NOT a verified component (rule 13:
    // budgets are reserved before a program can promise funded rewards) —
    // so the estimate is honestly UNKNOWN, and the opportunity ineligible.
    expect(opportunity.expectedReturn.point).toBeNull();
    expect(opportunity.expectedReturn.bounds).toBeNull();
    expect(opportunity.policyEligibility.eligible).toBe(false);
    expect(opportunity.policyEligibility.reasons).toContain("INCENTIVE_BUDGET_NOT_RESERVED");
  });

  it("vanished liquidity on an arbitrage leg is ineligible (the leg's exit is gone)", () => {
    const opportunity = discoverOpportunity(vanishedLiquidityObservation(), NOW);
    expect(opportunity.policyEligibility.eligible).toBe(false);
    expect(opportunity.policyEligibility.reasons).toContain("WITHDRAWAL_LIQUIDITY_VANISHED");
    // The spread component loses verified status entirely: an uncapturable
    // difference (no exit liquidity on one side) is not an estimate — the
    // expected return is honestly UNKNOWN, never an attractive number.
    expect(opportunity.expectedReturn.point).toBeNull();
    expect(opportunity.expectedReturn.bounds).toBeNull();
  });

  it("the unapproved 'other' strategy is discovered but ineligible (surfaced, never hidden)", () => {
    const opportunity = discoverOpportunity(unapprovedOtherObservation(), NOW);
    expect(opportunity.family).toBe("other");
    expect(opportunity.policyApprovalRef).toBeUndefined();
    expect(opportunity.policyEligibility.eligible).toBe(false);
    expect(opportunity.policyEligibility.reasons).toContain("POLICY_APPROVAL_MISSING");
    const approved = discoverOpportunity(healthyOtherObservation(), NOW);
    expect(approved.policyEligibility.eligible).toBe(true);
  });

  it("UNKNOWN states are FLAGS, never ineligibility (UNKNOWN is not FAILED)", () => {
    const opportunity = discoverOpportunity(
      healthyLiquidityObservation({ maxLossKnown: false }),
      NOW,
    );
    const evaluation = evaluateDiscoveryPolicy(opportunity, NOW);
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.reasons).toEqual([]);
    expect(evaluation.flags).toContain("MAX_LOSS_BOUND_UNKNOWN");
  });

  it("an UNKNOWN estimate is flagged honestly without ineligibility", () => {
    const input = {
      ...healthyIncentivesObservation(),
      returnComponents: [
        {
          componentId: "inc:rebate",
          kind: "INCENTIVE_YIELD" as const,
          ratePerYear: { numerator: "120", denominator: "10000" },
          evidenceVerified: true,
          budgetReserved: true,
          description: "observed rebate rate",
        },
      ],
    };
    const unverified = {
      ...input,
      returnComponents: [
        {
          componentId: "inc:rebate",
          kind: "INCENTIVE_YIELD" as const,
          ratePerYear: { numerator: "120", denominator: "10000" },
          evidenceVerified: false,
          budgetReserved: true,
          description: "an unverified rebate rate claim",
        },
      ],
    };
    const opportunity = discoverOpportunity(unverified, NOW);
    const evaluation = evaluateDiscoveryPolicy(opportunity, NOW);
    // The unverified incentive component is ineligible (fake-incentive law)…
    expect(evaluation.eligible).toBe(false);
    // …and the estimate itself is honestly UNKNOWN (flagged).
    expect(opportunity.expectedReturn.point).toBeNull();
    expect(evaluation.flags).toContain("EXPECTED_RETURN_UNKNOWN");
    // A verified one is eligible with a point estimate.
    const verified = discoverOpportunity(input, NOW);
    expect(evaluateDiscoveryPolicy(verified, NOW).eligible).toBe(true);
  });

  it("the policy is pure and deterministic: same opportunity, same instant, same evaluation", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(evaluateDiscoveryPolicy(opportunity, NOW)).toEqual(
      evaluateDiscoveryPolicy(opportunity, NOW),
    );
  });

  it("the evaluation instant is caller-supplied — a negative instant fails closed", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(() => evaluateDiscoveryPolicy(opportunity, -1)).toThrow(RangeError);
  });

  it("a BLOCKED exit path is ineligible", () => {
    const input = {
      ...healthyLiquidityObservation(),
      observationId: "obs:liq:blocked-exit",
      exitPath: {
        status: "BLOCKED" as const,
        description: "exits are currently paused by the venue operator",
        constraints: ["operator pause observed at the evidence instant"],
      },
    };
    const opportunity = discoverOpportunity(input, NOW);
    expect(opportunity.policyEligibility.eligible).toBe(false);
    expect(opportunity.policyEligibility.reasons).toContain("EXIT_PATH_BLOCKED");
  });

  it("vanished liquidity on the opportunity's own profile is ineligible", () => {
    const input = {
      ...healthyLiquidityObservation(),
      observationId: "obs:liq:own-vanished",
      liquidity: { depthMinorUnits: "500000000000", withdrawalLiquidityMinorUnits: "0" },
    };
    const opportunity = discoverOpportunity(input, NOW);
    expect(opportunity.policyEligibility.eligible).toBe(false);
    expect(opportunity.policyEligibility.reasons).toContain("WITHDRAWAL_LIQUIDITY_VANISHED");
  });

  it("multiple failed rules are ALL collected (never just the first)", () => {
    // Stale AND honeypot AND vanished liquidity: three reasons at once.
    const input = {
      ...staleQuoteObservation(),
      exitPath: {
        status: "SUSPECT_HONEYPOT" as const,
        description: "deposits are open; withdrawals require operator approval never observed",
        constraints: [],
      },
      liquidity: { depthMinorUnits: "500000000000", withdrawalLiquidityMinorUnits: "0" },
    };
    const opportunity = discoverOpportunity(input, NOW);
    expect(opportunity.policyEligibility.reasons).toEqual([
      "STALE_OBSERVATION",
      "EXIT_PATH_SUSPECT_HONEYPOT",
      "WITHDRAWAL_LIQUIDITY_VANISHED",
    ]);
  });

  it("a stale staking observation is ineligible (the policy re-derives staleness too)", () => {
    const opportunity = discoverOpportunity(staleStakingObservation(), NOW);
    expect(opportunity.policyEligibility.eligible).toBe(false);
    expect(opportunity.policyEligibility.reasons).toContain("STALE_OBSERVATION");
  });

  it("the stale fixture is exactly past its freshness bound at the evaluation instant", () => {
    const staleInput = staleQuoteObservation();
    expect(staleInput.freshness.asOfMs).toBe(NOW - (MAX_AGE_MS + 30_000));
    const opportunity = discoverOpportunity(staleInput, NOW);
    expect(opportunity.evidenceFreshness.maxAgeMs).toBe(MAX_AGE_MS);
    expect(opportunity.policyEligibility.reasons).toEqual(["STALE_OBSERVATION"]);
  });
});
