import { describe, expect, it } from "vitest";
import {
  GUARANTEE_LANGUAGE_PATTERNS,
  GuaranteeLanguageError,
  assertNoGuaranteeLanguage,
  scanForGuaranteeLanguage,
} from "../src/index.js";
import {
  discoveryCatalog,
  healthyLiquidityObservation,
  NOW,
} from "./fixtures.js";
import { discoverOpportunity } from "../src/index.js";

/**
 * P4-W3-002 hard requirement 2 (the language-level adversarial tests):
 * opportunity surfaces NEVER claim guaranteed returns. Every pattern in the
 * frozen list detects its smuggled vocabulary (case-insensitive, hyphen and
 * space spellings), clean estimate-language passes, and every human-readable
 * surface of every catalog opportunity scans clean.
 */
describe("P4-W3-002 the no-guaranteed-returns vocabulary law", () => {
  it("the frozen pattern list covers the mandated vocabulary (guaranteed, risk-free, assured)", () => {
    const patternSources = GUARANTEE_LANGUAGE_PATTERNS.map(String).join("\n");
    expect(patternSources).toMatch(/guaranteed?/);
    expect(patternSources).toMatch(/risk\[-\\s\]\?free/);
    expect(patternSources).toMatch(/assured/);
    expect(GUARANTEE_LANGUAGE_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });

  describe("adversarial guarantee vocabulary is DETECTED (case/spelling variants)", () => {
    const adversarialSurfaces: readonly string[] = [
      "guaranteed 20% APY",
      "a guaranteed yield for liquidity providers",
      "risk-free returns after one epoch",
      "risk free lending with no caveats",
      "RISK-FREE staking for early participants",
      "assured returns on every position",
      "your capital is assured",
      "a riskless arbitrage between two venues",
      "this pool has no risk of loss",
      "no-risk participation for the first epoch",
      "you cannot lose more than you deposit",
      "you can't lose with this strategy",
      "certain returns after the unbonding period",
      "a certain yield regardless of market conditions",
      "a foolproof exit path",
      "a sure thing for passive capital",
      "loss-proof staking module",
      "a loss proof market maker rebate",
    ];

    for (const surface of adversarialSurfaces) {
      it(`detects '${surface}'`, () => {
        const scan = scanForGuaranteeLanguage(surface);
        expect(scan.clean).toBe(false);
        expect(scan.violations.length).toBeGreaterThan(0);
        expect(() => assertNoGuaranteeLanguage(surface, "adversarial-surface")).toThrow(
          GuaranteeLanguageError,
        );
      });
    }
  });

  describe("honest estimate language passes (estimates, bounds, uncertainty)", () => {
    const honestSurfaces: readonly string[] = [
      "an evidence-backed estimate with uncertainty bounds",
      "observed fee yield annualized from venue observations",
      "the lower bound counts verified components only",
      "expected return UNKNOWN: no verified components",
      "up to the observed spread, net of execution costs",
      "may decline when pool utilization changes",
      "the estimate is derived from two venue price observations",
      "slashing exposure is disclosed in the risk summaries",
    ];

    for (const surface of honestSurfaces) {
      it(`accepts '${surface}'`, () => {
        const scan = scanForGuaranteeLanguage(surface);
        expect(scan.clean).toBe(true);
        expect(scan.violations).toEqual([]);
        expect(() => assertNoGuaranteeLanguage(surface, "honest-surface")).not.toThrow();
      });
    }
  });

  it("the scan is deterministic: same text, same violations, same order", () => {
    const first = scanForGuaranteeLanguage("guaranteed and risk-free");
    const second = scanForGuaranteeLanguage("guaranteed and risk-free");
    expect(first).toEqual(second);
    expect(first.violations.map((violation) => violation.matched)).toEqual([
      "guaranteed",
      "risk-free",
    ]);
  });

  it("every human-readable surface of EVERY catalog opportunity scans clean", () => {
    for (const entry of discoveryCatalog()) {
      const opportunity = discoverOpportunity(entry.input, NOW);
      const surfaces: readonly string[] = [
        opportunity.title,
        opportunity.description,
        opportunity.exitPath.description,
        ...opportunity.exitPath.constraints,
        opportunity.smartContractRisk.summary,
        opportunity.oracleBridgeRisk.summary,
        opportunity.expectedReturn.basis,
        ...opportunity.expectedReturn.components.map(
          (component) => component.description,
        ),
      ];
      for (const surface of surfaces) {
        const scan = scanForGuaranteeLanguage(surface);
        expect(scan.clean, `${entry.label}: '${surface}'`).toBe(true);
      }
    }
  });

  it("a smuggled guarantee title is REJECTED at discovery time (the law is structural)", () => {
    const input = {
      ...healthyLiquidityObservation(),
      title: "guaranteed 40% APR liquidity provisioning",
    };
    expect(() => discoverOpportunity(input, NOW)).toThrow(GuaranteeLanguageError);
    expect(() => discoverOpportunity(input, NOW)).toThrow(/no-guaranteed-returns/);
  });

  it("a smuggled guarantee in the risk summary is REJECTED at discovery time", () => {
    const input = {
      ...healthyLiquidityObservation(),
      smartContractRisk: {
        level: "LOW" as const,
        audited: true,
        summary: "audited and risk-free",
      },
    };
    expect(() => discoverOpportunity(input, NOW)).toThrow(GuaranteeLanguageError);
  });

  it("a smuggled guarantee in an exit-path description is REJECTED at discovery time", () => {
    const input = {
      ...healthyLiquidityObservation(),
      exitPath: {
        status: "AVAILABLE" as const,
        description: "withdraw any time — a sure thing",
        constraints: [],
      },
    };
    expect(() => discoverOpportunity(input, NOW)).toThrow(GuaranteeLanguageError);
  });

  it("a smuggled guarantee in a return-component description is REJECTED at discovery time", () => {
    const input = {
      ...healthyLiquidityObservation(),
      returnComponents: [
        {
          componentId: "liq:fee-yield",
          kind: "FEE_YIELD" as const,
          ratePerYear: { numerator: "431", denominator: "10000" },
          evidenceVerified: true,
          description: "a guaranteed fee yield",
        },
      ],
    };
    expect(() => discoverOpportunity(input, NOW)).toThrow(GuaranteeLanguageError);
  });
});
