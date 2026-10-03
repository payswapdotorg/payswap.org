import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import type { VenueQuote } from "../src/venue-port.js";
import { evaluateNetOutcome, rankCandidates } from "../src/comparator.js";
import type { BestExecutionPolicy } from "../src/policy.js";
import { validateBestExecutionPolicy } from "../src/policy.js";
import {
  floorRationalToIntegerString,
  multiplyRationals,
  rationalTimesInteger,
  valueThroughRate,
  validateExactRational,
} from "../src/exact-math.js";
import {
  USC_ASSET,
  baseBestExecutionPolicy,
  baseSwapRequest,
  syntheticVenue,
} from "./helpers.js";

/**
 * The net-executable-outcome comparator (P4-W2-002 hard requirement):
 * every dimension is an explicit typed input, the arithmetic is exact, and
 * there are NO hidden constants — every number that influences a net value
 * is either a quote disclosure or a policy field, and mutating either
 * changes the result exactly as declared.
 */

function quoteFrom(venueId: string, overrides?: Partial<VenueQuote>): VenueQuote {
  const venue = syntheticVenue({ venueId, protocolKey: `synth-${venueId}` });
  const outcome = venue.quote(baseSwapRequest() as never, 0);
  if (outcome.kind !== "QUOTE") {
    throw new Error("fixture venue must quote");
  }
  return { ...outcome.quote, ...overrides };
}

describe("exact rational arithmetic (no floating point anywhere)", () => {
  it("multiplies rationals exactly", () => {
    expect(
      multiplyRationals({ numerator: "2", denominator: "3" }, { numerator: "3", denominator: "4" }),
    ).toEqual({ numerator: "6", denominator: "12" });
  });

  it("scales by integer strings exactly", () => {
    expect(rationalTimesInteger({ numerator: "1", denominator: "3" }, "10")).toEqual({
      numerator: "10",
      denominator: "3",
    });
  });

  it("floors deterministically at the documented boundary", () => {
    expect(floorRationalToIntegerString({ numerator: "10", denominator: "3" })).toBe("3");
    expect(floorRationalToIntegerString({ numerator: "9", denominator: "3" })).toBe("3");
    expect(valueThroughRate("1000000", { numerator: "1", denominator: "1" })).toBe("1000000");
    expect(valueThroughRate("1000000", { numerator: "1", denominator: "3" })).toBe("333333");
  });

  it("rejects malformed rationals (fail closed)", () => {
    expect(() => validateExactRational({ numerator: "-1", denominator: "1" })).toThrow();
    expect(() => validateExactRational({ numerator: "1", denominator: "0" })).toThrow();
    expect(() => validateExactRational({ numerator: "01", denominator: "1" })).toThrow();
    expect(() => validateExactRational({ numerator: "1.5", denominator: "1" })).toThrow();
  });
});

describe("evaluateNetOutcome (the auditable arithmetic trace)", () => {
  const policy = baseBestExecutionPolicy();

  it("computes the net from the guaranteed worst case, not the expected output", () => {
    const quote = quoteFrom("venue-a", {
      slippage: {
        protection: "DECLARED_LIMIT",
        worstCaseOutput: { currency: "USC", minorUnits: "990000" },
        limitBasisPoints: 50,
        expectedOutput: { currency: "USC", minorUnits: "995000" },
      },
    });
    const evaluation = evaluateNetOutcome({ quote, policy });
    const output = evaluation.components.find((c) => c.kind === "OUTPUT");
    expect(output?.numeraireMinorUnits).toBe("990000");
    // The optimistic mid-estimate never enters the arithmetic.
    expect(evaluation.components.some((c) => c.numeraireMinorUnits === "995000")).toBe(false);
  });

  it("values gas through the explicit rational price and asset rate", () => {
    const quote = quoteFrom("venue-a", {
      gasCost: {
        gasUnits: "150000",
        pricePerUnitNativeMinor: { numerator: "1", denominator: "1000" },
        feeAsset: USC_ASSET,
      },
    });
    const evaluation = evaluateNetOutcome({ quote, policy });
    const gas = evaluation.components.find((c) => c.kind === "GAS");
    expect(gas?.numeraireMinorUnits).toBe("-150");
  });

  it("deducts every fee, bridge, FX and liquidity-impact component", () => {
    const quote = quoteFrom("venue-a", {
      fees: [
        {
          feeKind: "VENUE_FEE",
          amount: { asset: USC_ASSET, minorUnits: "1000" },
          description: "venue fee",
        },
        {
          feeKind: "INTEGRATOR_FEE",
          amount: { asset: USC_ASSET, minorUnits: "500" },
          description: "integrator fee",
        },
      ],
      bridgeCost: {
        bridgeFee: { asset: USC_ASSET, minorUnits: "2000" },
        description: "bridge",
      },
      fxCost: {
        conversionFee: { asset: USC_ASSET, minorUnits: "300" },
        description: "fx",
      },
      liquidityImpact: {
        declaredImpactCost: { asset: USC_ASSET, minorUnits: "700" },
        description: "impact",
      },
    });
    const evaluation = evaluateNetOutcome({ quote, policy });
    expect(evaluation.components.find((c) => c.kind === "FEE" && c.description.startsWith("VENUE_FEE"))?.numeraireMinorUnits).toBe("-1000");
    expect(evaluation.components.find((c) => c.kind === "FEE" && c.description.startsWith("INTEGRATOR_FEE"))?.numeraireMinorUnits).toBe("-500");
    expect(evaluation.components.find((c) => c.kind === "BRIDGE_COST")?.numeraireMinorUnits).toBe("-2000");
    expect(evaluation.components.find((c) => c.kind === "FX_COST")?.numeraireMinorUnits).toBe("-300");
    expect(evaluation.components.find((c) => c.kind === "LIQUIDITY_IMPACT")?.numeraireMinorUnits).toBe("-700");
  });

  it("applies the policy-declared risk deduction and time cost exactly", () => {
    const quote = quoteFrom("venue-a", {
      failureRisk: { riskClass: "MODERATE", retryPolicy: "SAFE_TO_RETRY", description: "moderate" },
      timeToSettlement: { estimatedMs: 60_000, finalityModel: "PROBABILISTIC", description: "60s" },
    });
    const evaluation = evaluateNetOutcome({ quote, policy });
    expect(evaluation.components.find((c) => c.kind === "RISK_DEDUCTION")?.numeraireMinorUnits).toBe("-100000");
    expect(evaluation.components.find((c) => c.kind === "TIME_COST")?.numeraireMinorUnits).toBe("-60");
  });

  it("nets every component (signed bigint sum)", () => {
    const quote = quoteFrom("venue-a");
    const evaluation = evaluateNetOutcome({ quote, policy });
    const sum = evaluation.components.reduce((acc, c) => acc + BigInt(c.numeraireMinorUnits), 0n);
    expect(evaluation.netNumeraireMinorUnits).toBe(sum.toString());
    // Baseline: 990000 output - 150 gas - 0 risk (LOW) - 60 time.
    expect(evaluation.netNumeraireMinorUnits).toBe("989790");
  });

  it("fails closed on an asset with no explicit conversion rule (no default rate)", () => {
    const restricted: BestExecutionPolicy = {
      ...policy,
      conversions: policy.conversions.filter((rule) => rule.asset.symbol !== "USC"),
    };
    const quote = quoteFrom("venue-a");
    expect(() => evaluateNetOutcome({ quote, policy: restricted })).toThrow(/no explicit conversion rule/);
  });
});

describe("no hidden constants (every number is a declared input)", () => {
  it("changing the policy's time cost changes the net exactly by the declared delta", () => {
    const quote = quoteFrom("venue-a");
    const base = evaluateNetOutcome({ quote, policy: baseBestExecutionPolicy() });
    const pricier = evaluateNetOutcome({
      quote,
      policy: baseBestExecutionPolicy({
        timeCostPerMs: { numerator: "2", denominator: "1000" },
      }),
    });
    const delta = BigInt(pricier.netNumeraireMinorUnits) - BigInt(base.netNumeraireMinorUnits);
    // 60000ms × 1/1000 extra = exactly 60 more deducted.
    expect(delta).toBe(-60n);
  });

  it("changing the risk deduction changes the net exactly", () => {
    const quote = quoteFrom("venue-a", {
      failureRisk: { riskClass: "MODERATE", retryPolicy: "SAFE_TO_RETRY", description: "m" },
    });
    const base = evaluateNetOutcome({ quote, policy: baseBestExecutionPolicy() });
    const pricier = evaluateNetOutcome({
      quote,
      policy: baseBestExecutionPolicy({
        failureRiskDeductions: { LOW: "0", MODERATE: "250000", ELEVATED: "1000000", HIGH: "10000000" },
      }),
    });
    expect(BigInt(base.netNumeraireMinorUnits) - BigInt(pricier.netNumeraireMinorUnits)).toBe(150000n);
  });
});

describe("provider-native optimization parity (INV-C08 / rule 20)", () => {
  it("identical dimensions compare exactly equal regardless of optimization origin", () => {
    const native = quoteFrom("venue-native", { optimizationOrigin: "PROVIDER_NATIVE" });
    const composed = quoteFrom("venue-composed", { optimizationOrigin: "COMPOSED" });
    const policy = baseBestExecutionPolicy();
    const nativeEval = evaluateNetOutcome({ quote: native, policy });
    const composedEval = evaluateNetOutcome({ quote: composed, policy });
    expect(nativeEval.netNumeraireMinorUnits).toBe(composedEval.netNumeraireMinorUnits);

    // Ranking: the total order is the venue id (no origin preference).
    const ranked = rankCandidates(
      [
        { quote: native, evaluation: nativeEval },
        { quote: composed, evaluation: composedEval },
      ],
      policy,
    );
    expect(ranked[0]?.quote.venueId).toBe("venue-composed");
    expect(ranked[1]?.quote.venueId).toBe("venue-native");
  });

  it("a strictly better provider-native route wins (never structurally disadvantaged)", () => {
    const native = quoteFrom("venue-native", {
      optimizationOrigin: "PROVIDER_NATIVE",
      slippage: {
        protection: "DECLARED_LIMIT",
        worstCaseOutput: { currency: "USC", minorUnits: "999000" },
      },
    });
    const composed = quoteFrom("venue-composed", {
      optimizationOrigin: "COMPOSED",
      slippage: {
        protection: "DECLARED_LIMIT",
        worstCaseOutput: { currency: "USC", minorUnits: "990000" },
      },
    });
    const policy = baseBestExecutionPolicy();
    const ranked = rankCandidates(
      [
        { quote: composed, evaluation: evaluateNetOutcome({ quote: composed, policy }) },
        { quote: native, evaluation: evaluateNetOutcome({ quote: native, policy }) },
      ],
      policy,
    );
    expect(ranked[0]?.quote.venueId).toBe("venue-native");
  });
});

describe("deterministic ranking with declared tie-breakers", () => {
  it("orders by net outcome descending", () => {
    const policy = baseBestExecutionPolicy();
    const better = quoteFrom("venue-better", {
      slippage: { protection: "DECLARED_LIMIT", worstCaseOutput: { currency: "USC", minorUnits: "995000" } },
    });
    const worse = quoteFrom("venue-worse", {
      slippage: { protection: "DECLARED_LIMIT", worstCaseOutput: { currency: "USC", minorUnits: "980000" } },
    });
    const ranked = rankCandidates(
      [
        { quote: worse, evaluation: evaluateNetOutcome({ quote: worse, policy }) },
        { quote: better, evaluation: evaluateNetOutcome({ quote: better, policy }) },
      ],
      policy,
    );
    expect(ranked.map((candidate) => candidate.quote.venueId)).toEqual(["venue-better", "venue-worse"]);
  });

  it("breaks exact ties by the declared order (risk, then time, then hops, then venue id)", () => {
    const policy = baseBestExecutionPolicy();
    const lowRiskSlow = quoteFrom("venue-a", {
      failureRisk: { riskClass: "LOW", retryPolicy: "SAFE_TO_RETRY", description: "low" },
      timeToSettlement: { estimatedMs: 120_000, finalityModel: "PROBABILISTIC", description: "slow" },
    });
    const lowRiskFast = quoteFrom("venue-b", {
      failureRisk: { riskClass: "LOW", retryPolicy: "SAFE_TO_RETRY", description: "low" },
      timeToSettlement: { estimatedMs: 30_000, finalityModel: "PROBABILISTIC", description: "fast" },
    });
    const ranked = rankCandidates(
      [
        { quote: lowRiskSlow, evaluation: evaluateNetOutcome({ quote: lowRiskSlow, policy }) },
        { quote: lowRiskFast, evaluation: evaluateNetOutcome({ quote: lowRiskFast, policy }) },
      ],
      policy,
    );
    expect(ranked[0]?.quote.venueId).toBe("venue-b");
  });

  it("rejects a policy whose tie-breakers lack the VENUE_ID total order", () => {
    expect(() =>
      validateBestExecutionPolicy(
        baseBestExecutionPolicy({ tieBreakers: ["LOWER_RISK_CLASS"] }),
      ),
    ).toThrow(/VENUE_ID/);
  });
});
