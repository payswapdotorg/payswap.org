/**
 * @payswap/onchain-opportunities — evidence-backed discovery
 * (Work Order P4-W3-002: "Extend FinancialOpportunity discovery to onchain
 * opportunities" across the liquidity / lending / staking / incentives /
 * arbitrage / other families).
 *
 * `discoverOpportunity` is the ONE constructor of FinancialOpportunity
 * records in this package. It is:
 * - DETERMINISTIC — every instant is caller-supplied, every amount is an
 *   exact integer minor-unit string, every rate is an ExactRational; there
 *   is no ambient clock, no randomness and no floating point;
 * - EVIDENCE-GROUNDED — the observation input carries the venue/protocol/
 *   chain/adapter/observer provenance, a NON-EMPTY evidence chain (INV-E02)
 *   and mandatory freshness (the observation law); family-scoped evidence
 *   (arbitrage legs, policy approvals) is preserved verbatim on the record;
 * - HONEST IN ITS ESTIMATES — the expected return is derived from observed
 *   components: the point is the sum of all observed components, the lower
 *   bound is the sum of components whose evidence is verified (incentive
 *   components count as verified only with a reserved budget — AGENTS.md
 *   rule 13), and when NO component is verified the estimate is UNKNOWN
 *   (point and bounds null) rather than an unverified number. Arbitrage
 *   estimates are derived from the two venue price legs: gross spread as
 *   the point/upper bound, spread net of observed execution costs as the
 *   lower bound (floored at zero — never a negative rational);
 * - STRUCTURALLY NEVER AUTHORIZATION — the constructed record carries the
 *   discovery tier brand and NO execution-shaped field; the full model
 *   validator runs as the construction gate (defense in depth).
 */

import { ValidationError } from "@payswap/protocol";
import { isValidChainKey } from "@payswap/onchain-domain";
import { compareRationals, validateExactRational } from "@payswap/best-execution";
import type { ExactRational } from "@payswap/best-execution";
import { assertNoGuaranteeLanguage } from "./vocabulary.js";
import { DISCOVERY_TIER } from "./discovery-tier.js";
import {
  evaluateDiscoveryPolicy,
} from "./eligibility.js";
import {
  isOpportunityFamily,
  opportunityId,
  validateFinancialOpportunity,
} from "./model.js";
import type {
  ArbitrageLeg,
  CapitalRequirement,
  EvidenceFreshness,
  ExpectedReturnEstimate,
  ExitPathAssessment,
  FeeSchedule,
  FinancialOpportunity,
  LiquidityProfile,
  LockUp,
  MaxLossBound,
  OpportunityFamily,
  OpportunityProvenance,
  ReturnComponent,
  RiskRating,
} from "./model.js";

/** Raised when discovery input is malformed (fail closed, never guessed). */
export class OpportunityDiscoveryError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "OpportunityDiscoveryError";
  }
}

// ---------------------------------------------------------------------------
// The observation input (what an adapter-sourced evidence feed supplies)
// ---------------------------------------------------------------------------

/**
 * One observed opportunity: everything the discovery knows, with its
 * evidence. Family-scoped fields are validated per family:
 * - `arbitrage` requires exactly two `legs` (the two venue price
 *   observations) and derives the price-difference estimate;
 * - `other` requires a `policyApprovalRef` for eligibility (an unapproved
 *   strategy is still discovered — surfaced as ineligible, never hidden);
 * - `returnComponents` supply the estimation inputs for the
 *   non-arbitrage families.
 */
export interface OpportunityObservationInput {
  readonly family: OpportunityFamily;
  readonly observationId: string;
  readonly venueId: string;
  readonly protocolKey?: string;
  readonly chainKey: string;
  readonly adapterId: string;
  readonly observerId: string;
  readonly freshness: EvidenceFreshness;
  readonly evidenceRefs: readonly string[];
  readonly title: string;
  readonly description: string;
  readonly capitalRequired?: CapitalRequirement;
  readonly fees?: FeeSchedule;
  readonly liquidity?: LiquidityProfile;
  readonly exitPath: ExitPathAssessment;
  readonly lockUp: LockUp;
  readonly smartContractRisk: RiskRating;
  readonly oracleBridgeRisk: RiskRating;
  readonly maxLoss?: { readonly fractionOfCapital: ExactRational };
  readonly returnComponents?: readonly ReturnComponent[];
  readonly arbitrageLegs?: readonly ArbitrageLeg[];
  /** Observed execution cost fraction (arbitrage lower-bound reduction). */
  readonly executionCostFraction?: ExactRational;
  readonly policyApprovalRef?: string;
}

const MINOR_UNITS_PATTERN = /^(0|[1-9][0-9]*)$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// Exact rational estimation (bigint arithmetic — never floating point)
// ---------------------------------------------------------------------------

function toBigint(value: ExactRational): bigint {
  return BigInt(value.numerator);
}

/** Adds two exact rationals (exact; no rounding). */
export function addRationals(a: ExactRational, b: ExactRational): ExactRational {
  validateExactRational(a);
  validateExactRational(b);
  const numerator =
    toBigint(a) * BigInt(b.denominator) + toBigint(b) * BigInt(a.denominator);
  return { numerator: numerator.toString(), denominator: (BigInt(a.denominator) * BigInt(b.denominator)).toString() };
}

/** The zero rational. */
const ZERO: ExactRational = { numerator: "0", denominator: "1" };

/** Subtracts b from a, floored at zero (never a negative rational). */
function subtractFlooredAtZero(a: ExactRational, b: ExactRational): ExactRational {
  validateExactRational(a);
  validateExactRational(b);
  if (compareRationals(a, b) <= 0) {
    return { ...ZERO };
  }
  const numerator =
    toBigint(a) * BigInt(b.denominator) - toBigint(b) * BigInt(a.denominator);
  return { numerator: numerator.toString(), denominator: (BigInt(a.denominator) * BigInt(b.denominator)).toString() };
}

function isVerifiedComponent(component: ReturnComponent): boolean {
  if (!component.evidenceVerified) {
    return false;
  }
  if (component.kind === "INCENTIVE_YIELD" && component.budgetReserved !== true) {
    return false;
  }
  return true;
}

function sumComponents(components: readonly ReturnComponent[]): ExactRational {
  let sum: ExactRational = { ...ZERO };
  for (const component of components) {
    sum = addRationals(sum, component.ratePerYear);
  }
  return sum;
}

/**
 * Derives the price-difference component of an arbitrage opportunity from
 * its two venue price legs. The gross spread rate is
 * (max(price) − min(price)) / min(price) — an exact rational. The component
 * counts as evidence-verified only when BOTH legs carry observed,
 * non-vanished exit liquidity (a vanished-liquidity leg is not verified
 * evidence of a capturable difference).
 */
export function deriveArbitrageComponents(
  legs: readonly ArbitrageLeg[],
): readonly ReturnComponent[] {
  if (legs.length !== 2) {
    throw new OpportunityDiscoveryError(
      `an arbitrage opportunity observation requires exactly two venue price legs (got ${legs.length}) — a price difference needs both sides`,
    );
  }
  const [legA, legB] = legs as [ArbitrageLeg, ArbitrageLeg];
  validateExactRational(legA.price);
  validateExactRational(legB.price);
  const comparison = compareRationals(legA.price, legB.price);
  const lower = comparison <= 0 ? legA.price : legB.price;
  const higher = comparison <= 0 ? legB.price : legA.price;
  // spread = (higher − lower) / lower, exact.
  const numerator =
    toBigint(higher) * BigInt(lower.denominator) -
    toBigint(lower) * BigInt(higher.denominator);
  const denominator = toBigint(lower) * BigInt(higher.denominator);
  const spread: ExactRational =
    denominator === 0n
      ? { ...ZERO }
      : { numerator: numerator.toString(), denominator: denominator.toString() };
  const bothLegsLiquid =
    legA.withdrawalLiquidityMinorUnits !== null &&
    legA.withdrawalLiquidityMinorUnits !== "0" &&
    legB.withdrawalLiquidityMinorUnits !== null &&
    legB.withdrawalLiquidityMinorUnits !== "0";
  const component: ReturnComponent = {
    componentId: `arbitrage-spread:${legA.venueId}:${legB.venueId}`,
    kind: "PRICE_DIFFERENCE",
    ratePerYear: spread,
    evidenceVerified: bothLegsLiquid,
    description: `observed price difference between venue '${legA.venueId}' and venue '${legB.venueId}' — an estimate from two venue observations, net of nothing (see bounds)`,
  };
  return Object.freeze([component]);
}

/**
 * Derives the expected-return ESTIMATE from observed components. The point
 * is the sum of ALL observed components; the lower bound is the sum of
 * VERIFIED components reduced by the observed execution costs (floored at
 * zero; only the arbitrage path supplies costs); the upper bound equals the
 * point. When NO component is verified the estimate is UNKNOWN (point and
 * bounds null) — honest disclosure, never an unverified number.
 */
export function estimateExpectedReturn(
  components: readonly ReturnComponent[],
  input?: { readonly executionCostFraction?: ExactRational },
): ExpectedReturnEstimate {
  const total = sumComponents(components);
  const verified = sumComponents(components.filter(isVerifiedComponent));
  const costReduction = input?.executionCostFraction;
  if (costReduction !== undefined) {
    validateExactRational(costReduction);
  }
  const low = costReduction !== undefined
    ? subtractFlooredAtZero(verified, costReduction)
    : verified;
  const hasVerified = components.some(isVerifiedComponent);
  if (!hasVerified) {
    return {
      estimateKind: "EVIDENCE_BACKED_ESTIMATE",
      point: null,
      bounds: null,
      components: Object.freeze([...components]),
      basis:
        "expected return UNKNOWN: no observed return component carries verified evidence (honest disclosure — never an unverified number)",
    };
  }
  const componentSummary = components
    .map(
      (component) =>
        `${component.kind} (verified: ${component.evidenceVerified ? "yes" : "no"}${component.kind === "INCENTIVE_YIELD" ? `, budget reserved: ${component.budgetReserved === true ? "yes" : "no"}` : ""})`,
    )
    .join("; ");
  const basis = `estimate derived from observed components: ${componentSummary}; lower bound counts verified components only${costReduction !== undefined ? ", net of observed execution costs" : ""}; the point is an estimate with uncertainty bounds, not a claim`;
  return {
    estimateKind: "EVIDENCE_BACKED_ESTIMATE",
    point: total,
    bounds: { low, high: total },
    components: Object.freeze([...components]),
    basis,
  };
}

// ---------------------------------------------------------------------------
// Input validation (fail closed BEFORE anything is constructed)
// ---------------------------------------------------------------------------

function validateDiscoveryInput(input: OpportunityObservationInput): void {
  const errors: string[] = [];
  if (!isOpportunityFamily(input.family)) {
    errors.push(`family must be one of the six opportunity families`);
  }
  for (const field of ["observationId", "venueId", "adapterId", "observerId"] as const) {
    if (!isNonEmptyString(input[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!isValidChainKey(input.chainKey)) {
    errors.push("chainKey must be a canonical `${namespace}:${network}` chain key");
  }
  if (
    input.freshness === null ||
    typeof input.freshness !== "object" ||
    !Number.isInteger(input.freshness.asOfMs) ||
    input.freshness.asOfMs < 0 ||
    !Number.isInteger(input.freshness.maxAgeMs) ||
    input.freshness.maxAgeMs <= 0
  ) {
    errors.push("freshness must be { asOfMs, maxAgeMs } with a positive maxAgeMs (the observation law)");
  }
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) {
    errors.push("evidenceRefs is MANDATORY and non-empty (INV-E02 — an observation without linked evidence is not evidence)");
  }
  for (const surface of [input.title, input.description]) {
    if (!isNonEmptyString(surface)) {
      errors.push("title and description must be non-empty strings");
      break;
    }
  }
  if (errors.length > 0) {
    throw new OpportunityDiscoveryError(
      `Invalid opportunity observation input: ${errors.join("; ")}`,
    );
  }

  // Vocabulary law on the input's human-readable surfaces.
  assertNoGuaranteeLanguage(input.title, "observation input title");
  assertNoGuaranteeLanguage(input.description, "observation input description");
  assertNoGuaranteeLanguage(input.exitPath.description, "observation input exitPath.description");
  for (const constraint of input.exitPath.constraints) {
    assertNoGuaranteeLanguage(constraint, "observation input exitPath.constraints entry");
  }
  assertNoGuaranteeLanguage(input.smartContractRisk.summary, "smartContractRisk.summary");
  assertNoGuaranteeLanguage(input.oracleBridgeRisk.summary, "oracleBridgeRisk.summary");

  if (input.capitalRequired !== undefined) {
    if (
      !isNonEmptyString(input.capitalRequired.assetRef) ||
      !input.capitalRequired.assetRef.startsWith(`${input.chainKey}/asset:`) ||
      typeof input.capitalRequired.minorUnits !== "string" ||
      !MINOR_UNITS_PATTERN.test(input.capitalRequired.minorUnits)
    ) {
      throw new OpportunityDiscoveryError(
        "capitalRequired, when present, must be { assetRef: `${chainKey}/asset:<SYMBOL>`, minorUnits } (exact integer minor units — INV-F01)",
      );
    }
  }
  if (input.liquidity !== undefined) {
    for (const field of ["depthMinorUnits", "withdrawalLiquidityMinorUnits"] as const) {
      const value = input.liquidity[field];
      if (value !== null && (typeof value !== "string" || !MINOR_UNITS_PATTERN.test(value))) {
        throw new OpportunityDiscoveryError(
          `liquidity.${field} must be a canonical minor-unit string or null (UNKNOWN surfaced honestly)`,
        );
      }
    }
  }
  if (input.maxLoss !== undefined) {
    validateExactRational(input.maxLoss.fractionOfCapital);
  }
  if (input.executionCostFraction !== undefined) {
    validateExactRational(input.executionCostFraction);
  }

  // Family-scoped input laws.
  if (input.family === "arbitrage") {
    if (!Array.isArray(input.arbitrageLegs) || input.arbitrageLegs.length !== 2) {
      throw new OpportunityDiscoveryError(
        "an arbitrage observation requires exactly two venue price legs (the two sides of the price difference)",
      );
    }
    for (const leg of input.arbitrageLegs) {
      if (!isNonEmptyString(leg.legId) || !isNonEmptyString(leg.venueId)) {
        throw new OpportunityDiscoveryError(
          "every arbitrage leg must carry a non-empty legId and venueId",
        );
      }
      validateExactRational(leg.price);
    }
  }
  if (input.family !== "arbitrage") {
    if (!Array.isArray(input.returnComponents) || input.returnComponents.length === 0) {
      throw new OpportunityDiscoveryError(
        `a '${input.family}' observation requires at least one observed return component (empty evidence is not an estimate)`,
      );
    }
    for (const component of input.returnComponents) {
      if (!isNonEmptyString(component.componentId)) {
        throw new OpportunityDiscoveryError(
          "every return component must carry a non-empty componentId",
        );
      }
      validateExactRational(component.ratePerYear);
      if (component.kind === "PRICE_DIFFERENCE") {
        throw new OpportunityDiscoveryError(
          `the PRICE_DIFFERENCE component kind is derived by arbitrage discovery, never supplied directly (component '${component.componentId}')`,
        );
      }
      assertNoGuaranteeLanguage(component.description, `return component '${component.componentId}'.description`);
    }
  }
  if (input.family === "other" && input.policyApprovalRef !== undefined) {
    if (!isNonEmptyString(input.policyApprovalRef)) {
      throw new OpportunityDiscoveryError(
        "policyApprovalRef, when present, must be a non-empty string",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The discovery constructor
// ---------------------------------------------------------------------------

/**
 * Discovers one onchain financial opportunity from an adapter-sourced
 * observation. The constructed record:
 * - carries EVERY mandated first-class field (typed, validated, frozen);
 * - carries the full evidence chain verbatim (venue/protocol/chain/adapter/
 *   observer, evidence refs, freshness, arbitrage legs, policy approvals);
 * - carries the discovery-time policy evaluation (re-derivable at read time
 *   through resolveOpportunity/evaluateDiscoveryPolicy — defense in depth);
 * - is stamped with the structural DISCOVERY_NEVER_AUTHORIZATION tier.
 *
 * This function constructs DATA ONLY: it is not, and structurally cannot be,
 * a step toward execution (see ./discovery-tier.js).
 */
export function discoverOpportunity(
  input: OpportunityObservationInput,
  at: number,
): FinancialOpportunity {
  if (!Number.isInteger(at) || at < 0) {
    throw new OpportunityDiscoveryError(
      "the discovery instant `at` must be a non-negative integer (ms; no ambient clock)",
    );
  }
  validateDiscoveryInput(input);

  const components: readonly ReturnComponent[] =
    input.family === "arbitrage"
      ? deriveArbitrageComponents(input.arbitrageLegs ?? [])
      : Object.freeze([...(input.returnComponents ?? [])]);
  const expectedReturn =
    input.family === "arbitrage"
      ? estimateExpectedReturn(components, {
          ...(input.executionCostFraction !== undefined
            ? { executionCostFraction: input.executionCostFraction }
            : {}),
        })
      : estimateExpectedReturn(components);

  // The record is built first with a placeholder discovery-policy decision
  // (evaluateDiscoveryPolicy never reads policyEligibility — it re-derives
  // from the typed first-class fields), then the REAL deterministic
  // evaluation at the discovery instant is stamped in.
  const base: FinancialOpportunity = {
    observationKind: "FinancialOpportunity",
    opportunityId: opportunityId(
      input.family,
      input.chainKey,
      input.venueId,
      input.observationId,
    ),
    family: input.family,
    chainKey: input.chainKey,
    title: input.title,
    description: input.description,
    capitalRequired:
      input.capitalRequired !== undefined
        ? { kind: "KNOWN", value: input.capitalRequired }
        : {
            kind: "UNKNOWN",
            reason:
              "the observation did not determine a capital requirement (honest UNKNOWN — never guessed)",
          },
    expectedReturn,
    liquidity:
      input.liquidity ??
      {
        depthMinorUnits: null,
        withdrawalLiquidityMinorUnits: null,
      },
    fees:
      input.fees !== undefined
        ? { kind: "KNOWN", value: input.fees }
        : {
            kind: "UNKNOWN",
            reason: "the observation did not determine a fee schedule (honest UNKNOWN — never guessed)",
          },
    exitPath: input.exitPath,
    lockUp: input.lockUp,
    smartContractRisk: input.smartContractRisk,
    oracleBridgeRisk: input.oracleBridgeRisk,
    maxLossBound:
      input.maxLoss !== undefined
        ? { kind: "KNOWN", value: input.maxLoss }
        : {
            kind: "UNKNOWN",
            reason:
              "the evidence does not bound the maximum loss (honest UNKNOWN — a maximum-loss bound is surfaced only where knowable)",
          },
    evidenceFreshness: input.freshness,
    policyEligibility: {
      eligible: true,
      reasons: [],
      decidedBy: "discovery-policy",
    },
    provenance: {
      observationId: input.observationId,
      venueId: input.venueId,
      ...(input.protocolKey !== undefined ? { protocolKey: input.protocolKey } : {}),
      chainKey: input.chainKey,
      adapterId: input.adapterId,
      observerId: input.observerId,
      evidenceRefs: Object.freeze([...input.evidenceRefs]),
    },
    ...(input.arbitrageLegs !== undefined
      ? { arbitrageLegs: Object.freeze([...input.arbitrageLegs]) }
      : {}),
    ...(input.policyApprovalRef !== undefined
      ? { policyApprovalRef: input.policyApprovalRef }
      : {}),
    discoveryTier: DISCOVERY_TIER,
  };

  const policy = evaluateDiscoveryPolicy(base, at);
  const record: FinancialOpportunity = {
    ...base,
    policyEligibility: {
      eligible: policy.eligible,
      reasons: policy.reasons,
      decidedBy: "discovery-policy",
    },
  };

  // Defense in depth: the FULL model validator is the construction gate.
  return validateFinancialOpportunity(record);
}

/** The maximum-loss bound helper (KNOWN where knowable). */
export function knownMaxLoss(fractionOfCapital: ExactRational): MaxLossBound {
  validateExactRational(fractionOfCapital);
  return { kind: "KNOWN", value: { fractionOfCapital } };
}

/** The honest UNKNOWN maximum-loss bound. */
export function unknownMaxLoss(reason: string): MaxLossBound {
  if (!isNonEmptyString(reason)) {
    throw new OpportunityDiscoveryError("an UNKNOWN maximum-loss bound requires a reason");
  }
  return { kind: "UNKNOWN", reason };
}

/** Discovery input provenance helper (validated shape builder). */
export function observationProvenance(input: {
  readonly observationId: string;
  readonly venueId: string;
  readonly chainKey: string;
  readonly adapterId: string;
  readonly observerId: string;
  readonly evidenceRefs: readonly string[];
  readonly protocolKey?: string;
}): OpportunityProvenance {
  const errors: string[] = [];
  for (const field of ["observationId", "venueId", "chainKey", "adapterId", "observerId"] as const) {
    if (!isNonEmptyString(input[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) {
    errors.push("evidenceRefs must be a non-empty array (INV-E02)");
  }
  if (errors.length > 0) {
    throw new OpportunityDiscoveryError(
      `Invalid observation provenance: ${errors.join("; ")}`,
    );
  }
  return Object.freeze({
    observationId: input.observationId,
    venueId: input.venueId,
    ...(input.protocolKey !== undefined ? { protocolKey: input.protocolKey } : {}),
    chainKey: input.chainKey,
    adapterId: input.adapterId,
    observerId: input.observerId,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
  });
}
