/**
 * @payswap/best-execution — the net-executable-outcome comparator
 * (P4-W2-002).
 *
 * The comparator evaluates the NET EXECUTABLE ECONOMIC OUTCOME of a quoted
 * route: the guaranteed worst-case output minus every explicit cost
 * (fees, gas, bridge, FX, liquidity impact), minus the policy-declared
 * failure-risk deduction and time cost — all converted into the policy's
 * numeraire through its EXPLICIT conversion table, with exact bigint
 * rational arithmetic and a single documented floor per component. There
 * is NO hidden constant in this module: every number enters through the
 * quote's typed disclosures or the versioned policy.
 *
 * Provider-native optimization parity (AGENTS.md rule 20 / INV-C08): the
 * comparator is structurally INDIFFERENT to `optimizationOrigin` — a
 * provider-native route and a composed route with identical dimensions
 * compare exactly equal (proven in test/comparator.test.ts). Composition
 * is never assumed superior; native is never penalized.
 *
 * Ranking is deterministic: net outcome descending, then the policy's
 * declared tie-breakers, ending in the venue-id total order.
 */

import { ValidationError } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/trust";
import type { AssetDenominatedAmount } from "./outcome-dimensions.js";
import { validateAssetDenominatedAmount } from "./outcome-dimensions.js";
import type { ExactRational } from "./exact-math.js";
import {
  multiplyRationals,
  rationalTimesInteger,
  valueThroughRate,
} from "./exact-math.js";
import type { RiskClass } from "./outcome-dimensions.js";
import { riskClassRank } from "./outcome-dimensions.js";
import type { BestExecutionPolicy } from "./policy.js";
import { conversionFor } from "./policy.js";
import type { VenueQuote } from "./venue-port.js";

// ---------------------------------------------------------------------------
// The valued component (the arithmetic trace)
// ---------------------------------------------------------------------------

export const VALUED_COMPONENT_KINDS = [
  "OUTPUT",
  "FEE",
  "GAS",
  "BRIDGE_COST",
  "FX_COST",
  "LIQUIDITY_IMPACT",
  "RISK_DEDUCTION",
  "TIME_COST",
] as const;

export type ValuedComponentKind = (typeof VALUED_COMPONENT_KINDS)[number];

/**
 * One auditable arithmetic step of the net-outcome evaluation: what was
 * valued, from which exact source amount, through which explicit rate, and
 * the signed numeraire result (OUTPUT is positive; every cost is negative).
 */
export interface ValuedComponent {
  readonly kind: ValuedComponentKind;
  readonly description: string;
  /** The asset-denominated source amount, when the component is asset-denominated. */
  readonly sourceAmount?: AmountSpec;
  /** The explicit conversion rate applied, when any. */
  readonly appliedRate?: ExactRational;
  /** The gas units valued, for GAS components. */
  readonly gasUnits?: string;
  /** The milliseconds costed, for TIME_COST components. */
  readonly milliseconds?: number;
  /** The risk class deducted, for RISK_DEDUCTION components. */
  readonly riskClass?: RiskClass;
  /** Signed numeraire minor units (decimal string; costs are negative). */
  readonly numeraireMinorUnits: string;
}

// ---------------------------------------------------------------------------
// The net outcome evaluation
// ---------------------------------------------------------------------------

/** The evaluated net executable economic outcome of one quoted route. */
export interface NetOutcomeEvaluation {
  readonly venueId: string;
  readonly quoteId: string;
  readonly numeraire: string;
  readonly components: readonly ValuedComponent[];
  /** Net value in numeraire minor units (signed decimal string). */
  readonly netNumeraireMinorUnits: string;
}

function rateFor(policy: BestExecutionPolicy, asset: { chain: string; assetId: string; symbol: string }): ExactRational {
  const rule = conversionFor(policy, asset);
  if (rule === undefined) {
    throw new ValidationError(
      `no explicit conversion rule for asset ${asset.symbol} (${asset.assetId} on ${asset.chain}) — the valuation fails closed rather than guessing a rate (no hidden constants)`,
    );
  }
  return rule.rate;
}

function assetAmountComponent(
  kind: ValuedComponentKind,
  description: string,
  amount: AssetDenominatedAmount,
  policy: BestExecutionPolicy,
  sign: 1 | -1,
): ValuedComponent {
  validateAssetDenominatedAmount(amount);
  const rate = rateFor(policy, amount.asset);
  const magnitude = valueThroughRate(amount.minorUnits, rate);
  return {
    kind,
    description,
    sourceAmount: { currency: amount.asset.symbol, minorUnits: amount.minorUnits },
    appliedRate: rate,
    numeraireMinorUnits: sign === 1 ? magnitude : `-${magnitude}`,
  };
}

/**
 * Evaluates the net executable economic outcome of a validated quote under
 * a validated policy. The evaluation uses the GUARANTEED worst-case output
 * (the executable number), never the optimistic mid-estimate; slippage
 * enters exactly once, through that worst case.
 */
export function evaluateNetOutcome(input: {
  readonly quote: VenueQuote;
  readonly policy: BestExecutionPolicy;
}): NetOutcomeEvaluation {
  const { quote, policy } = input;
  const components: ValuedComponent[] = [];

  // 1. OUTPUT — the guaranteed worst-case executable amount.
  components.push(
    assetAmountComponent(
      "OUTPUT",
      `guaranteed worst-case output${quote.slippage.limitBasisPoints !== undefined ? ` (declared slippage limit ${quote.slippage.limitBasisPoints}bps applied)` : ""}`,
      { asset: quote.outputAsset, minorUnits: quote.slippage.worstCaseOutput.minorUnits },
      policy,
      1,
    ),
  );

  // 2. FEES — every explicit fee component.
  for (const fee of quote.fees) {
    components.push(
      assetAmountComponent(
        "FEE",
        `${fee.feeKind}: ${fee.description}`,
        fee.amount,
        policy,
        -1,
      ),
    );
  }

  // 3. GAS — gasUnits × pricePerUnitNativeMinor × feeAsset rate, floored once.
  if (quote.gasCost !== undefined) {
    const gas = quote.gasCost;
    const fullRate = multiplyRationals(gas.pricePerUnitNativeMinor, rateFor(policy, gas.feeAsset));
    const magnitude = valueThroughRate(gas.gasUnits, fullRate);
    components.push({
      kind: "GAS",
      description: `gas: ${gas.gasUnits} units × explicit price in ${gas.feeAsset.symbol}`,
      appliedRate: fullRate,
      gasUnits: gas.gasUnits,
      numeraireMinorUnits: `-${magnitude}`,
    });
  }

  // 4. BRIDGE / FX costs.
  if (quote.bridgeCost !== undefined) {
    components.push(
      assetAmountComponent(
        "BRIDGE_COST",
        quote.bridgeCost.description,
        quote.bridgeCost.bridgeFee,
        policy,
        -1,
      ),
    );
  }
  if (quote.fxCost !== undefined) {
    components.push(
      assetAmountComponent(
        "FX_COST",
        quote.fxCost.description,
        quote.fxCost.conversionFee,
        policy,
        -1,
      ),
    );
  }

  // 5. LIQUIDITY IMPACT — the venue-declared explicit impact cost.
  if (quote.liquidityImpact !== undefined) {
    components.push(
      assetAmountComponent(
        "LIQUIDITY_IMPACT",
        quote.liquidityImpact.description,
        quote.liquidityImpact.declaredImpactCost,
        policy,
        -1,
      ),
    );
  }

  // 6. FAILURE/RETRY RISK — the policy-declared deduction for the declared class.
  const riskDeduction = policy.failureRiskDeductions[quote.failureRisk.riskClass];
  if (riskDeduction === undefined) {
    throw new ValidationError(
      `the policy is missing failureRiskDeductions.${quote.failureRisk.riskClass} — the deduction is always an explicit typed input`,
    );
  }
  components.push({
    kind: "RISK_DEDUCTION",
    description: `declared failure/retry risk class ${quote.failureRisk.riskClass} (retry policy ${quote.failureRisk.retryPolicy})`,
    riskClass: quote.failureRisk.riskClass,
    numeraireMinorUnits: `-${riskDeduction}`,
  });

  // 7. TIME — estimatedMs × the explicit per-ms time cost, floored once.
  const timeComponent = rationalTimesInteger(policy.timeCostPerMs, quote.timeToSettlement.estimatedMs.toString());
  const timeMagnitude = (
    BigInt(timeComponent.numerator) / BigInt(timeComponent.denominator)
  ).toString();
  components.push({
    kind: "TIME_COST",
    description: `time: ${quote.timeToSettlement.estimatedMs}ms × explicit per-ms cost (finality model ${quote.timeToSettlement.finalityModel})`,
    appliedRate: policy.timeCostPerMs,
    milliseconds: quote.timeToSettlement.estimatedMs,
    numeraireMinorUnits: `-${timeMagnitude}`,
  });

  const net = components.reduce(
    (sum, component) => sum + BigInt(component.numeraireMinorUnits),
    0n,
  );

  return Object.freeze({
    venueId: quote.venueId,
    quoteId: quote.quoteId,
    numeraire: policy.numeraire,
    components: Object.freeze(components),
    netNumeraireMinorUnits: net.toString(),
  });
}

// ---------------------------------------------------------------------------
// Ranking (deterministic; tie-breakers are policy-declared)
// ---------------------------------------------------------------------------

/** One rankable candidate: the validated quote plus its net evaluation. */
export interface RankableCandidate {
  readonly quote: VenueQuote;
  readonly evaluation: NetOutcomeEvaluation;
}

function compareBigIntStrings(a: string, b: string): -1 | 0 | 1 {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareTieBreak(
  a: RankableCandidate,
  b: RankableCandidate,
  tieBreaker: string,
): -1 | 0 | 1 {
  switch (tieBreaker) {
    case "LOWER_RISK_CLASS": {
      const left = riskClassRank(a.quote.failureRisk.riskClass);
      const right = riskClassRank(b.quote.failureRisk.riskClass);
      return left < right ? -1 : left > right ? 1 : 0;
    }
    case "FASTER_SETTLEMENT": {
      const left = a.quote.timeToSettlement.estimatedMs;
      const right = b.quote.timeToSettlement.estimatedMs;
      return left < right ? -1 : left > right ? 1 : 0;
    }
    case "FEWER_HOPS": {
      const left = a.quote.routeShape.length;
      const right = b.quote.routeShape.length;
      return left < right ? -1 : left > right ? 1 : 0;
    }
    case "VENUE_ID": {
      return a.quote.venueId < b.quote.venueId ? -1 : a.quote.venueId > b.quote.venueId ? 1 : 0;
    }
    default:
      throw new ValidationError(`unknown tie-breaker '${tieBreaker}'`);
  }
}

/**
 * Deterministically orders candidates: net executable outcome descending,
 * then the policy's declared tie-breakers (which must end with VENUE_ID —
 * the total order). The comparison NEVER consults optimizationOrigin
 * (provider-native and composed routes compete on identical terms).
 */
export function rankCandidates(
  candidates: readonly RankableCandidate[],
  policy: BestExecutionPolicy,
): readonly RankableCandidate[] {
  return [...candidates].sort((a, b) => {
    // Net outcome descending.
    const netOrder = compareBigIntStrings(
      b.evaluation.netNumeraireMinorUnits,
      a.evaluation.netNumeraireMinorUnits,
    );
    if (netOrder !== 0) {
      return netOrder;
    }
    // Declared tie-breakers in order.
    for (const tieBreaker of policy.tieBreakers) {
      const order = compareTieBreak(a, b, tieBreaker);
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  });
}
