/**
 * @payswap/best-execution — the typed net-executable-outcome dimensions
 * (P4-W2-002).
 *
 * Best execution evaluates the NET EXECUTABLE ECONOMIC OUTCOME, never the
 * quoted price alone (UNIVERSAL-MONEY-INTERFACE-ARCHITECTURE "Best
 * execution"). Every dimension the evaluation consumes is an EXPLICIT TYPED
 * INPUT — output, fees, gas, bridge/FX cost, slippage, liquidity impact,
 * failure/retry risk, time/finality, health, policy and security. There is
 * no hidden constant anywhere: numbers enter only through these contracts
 * (venue quote disclosures, observed health, versioned policy, deterministic
 * gate outcomes) and every arithmetic step is recorded in the evaluation
 * trace.
 *
 * Amounts are exact integer minor units (@payswap/trust AmountSpec —
 * INV-F01; no floating point ever crosses this boundary). Rates are exact
 * rationals (see ./exact-math.ts).
 */

import { ValidationError } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/trust";
import { validateAmountSpec } from "@payswap/trust";
import type { AssetIdentity } from "@payswap/onchain-security";
import { validateAssetIdentity } from "@payswap/onchain-security";
import type { ExactRational } from "./exact-math.js";
import { validateExactRational } from "./exact-math.js";
import type { QuoteProvenance } from "./quote-observation.js";
import { validateQuoteProvenance } from "./quote-observation.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateMs(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a non-negative integer (ms)`);
  }
}

/**
 * An asset-denominated exact amount: the FULL asset identity plus integer
 * minor units (INV-F01). Every cost disclosure carries this shape so the
 * valuation converts through the exact asset-specific rule — never a
 * symbol-only guess (two tokens with the same symbol are different
 * assets).
 */
export interface AssetDenominatedAmount {
  readonly asset: AssetIdentity;
  /** Exact integer minor units (canonical decimal string). */
  readonly minorUnits: string;
}

const CANONICAL_INTEGER_STRING = /^(0|[1-9][0-9]*)$/;

export function validateAssetDenominatedAmount(amount: AssetDenominatedAmount): void {
  if (amount === null || typeof amount !== "object") {
    throw new ValidationError("an asset-denominated amount must be an object { asset, minorUnits }");
  }
  validateAssetIdentity(amount.asset);
  if (
    typeof amount.minorUnits !== "string" ||
    !CANONICAL_INTEGER_STRING.test(amount.minorUnits)
  ) {
    throw new ValidationError(
      "minorUnits must be a canonical non-negative decimal integer string (exact integer minor units — INV-F01)",
    );
  }
}

// ---------------------------------------------------------------------------
// Failure/retry risk
// ---------------------------------------------------------------------------

export const RISK_CLASSES = ["LOW", "MODERATE", "ELEVATED", "HIGH"] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

/** Deterministic risk-class ordering: LOW < MODERATE < ELEVATED < HIGH. */
export function riskClassRank(riskClass: RiskClass): number {
  const index = RISK_CLASSES.indexOf(riskClass);
  if (index < 0) {
    throw new ValidationError(`unknown risk class '${String(riskClass)}'`);
  }
  return index;
}

/**
 * The venue-declared failure/retry risk profile of a quoted route. The class
 * is a DECLARED property (never guessed); the retry policy mirrors the
 * canonical onchain failure vocabulary (INV-X02 governs unknowns).
 */
export interface FailureRiskDisclosure {
  readonly riskClass: RiskClass;
  readonly retryPolicy: "SAFE_TO_RETRY" | "REQUIRES_RECONCILIATION" | "NOT_RETRYABLE";
  readonly description: string;
}

export function validateFailureRiskDisclosure(disclosure: FailureRiskDisclosure): void {
  if (disclosure === null || typeof disclosure !== "object") {
    throw new ValidationError("a failure-risk disclosure is mandatory on every quote");
  }
  if (!(RISK_CLASSES as readonly unknown[]).includes(disclosure.riskClass)) {
    throw new ValidationError(
      `failureRisk.riskClass must be one of [${RISK_CLASSES.join(", ")}] (a declared property, never guessed)`,
    );
  }
  if (
    disclosure.retryPolicy !== "SAFE_TO_RETRY" &&
    disclosure.retryPolicy !== "REQUIRES_RECONCILIATION" &&
    disclosure.retryPolicy !== "NOT_RETRYABLE"
  ) {
    throw new ValidationError(
      "failureRisk.retryPolicy must be SAFE_TO_RETRY, REQUIRES_RECONCILIATION or NOT_RETRYABLE",
    );
  }
  if (!isNonEmptyString(disclosure.description)) {
    throw new ValidationError("failureRisk.description must be a non-empty string");
  }
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

export const QUOTE_FEE_KINDS = [
  "VENUE_FEE",
  "PROTOCOL_FEE",
  "INTEGRATOR_FEE",
  "SOLVER_FEE",
  "NETWORK_FEE",
  "PROVIDER_DEFINED",
] as const;

export type QuoteFeeKind = (typeof QUOTE_FEE_KINDS)[number];

/** One explicit, asset-denominated fee component of a quoted route. */
export interface QuoteFee {
  readonly feeKind: QuoteFeeKind;
  /** The exact fee amount in the declared asset (INV-F01). */
  readonly amount: AssetDenominatedAmount;
  readonly description: string;
}

export function validateQuoteFee(fee: QuoteFee): void {
  if (fee === null || typeof fee !== "object") {
    throw new ValidationError("a quote fee must be an object");
  }
  if (!(QUOTE_FEE_KINDS as readonly unknown[]).includes(fee.feeKind)) {
    throw new ValidationError(
      `fee.feeKind must be one of [${QUOTE_FEE_KINDS.join(", ")}]`,
    );
  }
  validateAssetDenominatedAmount(fee.amount);
  if (!isNonEmptyString(fee.description)) {
    throw new ValidationError("fee.description must be a non-empty string");
  }
}

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------

/**
 * The gas cost disclosure of a quoted route: exact gas units times an exact
 * rational price per unit in the fee-paying (native) asset. Both parts are
 * venue-declared typed inputs; the valuation converts through the policy's
 * explicit conversion table.
 */
export interface GasCostDisclosure {
  /** Estimated gas units (canonical decimal integer string). */
  readonly gasUnits: string;
  /** Price per gas unit in feeAsset minor units (exact rational). */
  readonly pricePerUnitNativeMinor: ExactRational;
  /** The fee-paying asset (typically the chain's native asset). */
  readonly feeAsset: AssetIdentity;
}

export function validateGasCostDisclosure(disclosure: GasCostDisclosure): void {
  if (disclosure === null || typeof disclosure !== "object") {
    throw new ValidationError("a gas cost disclosure must be an object");
  }
  if (
    typeof disclosure.gasUnits !== "string" ||
    !CANONICAL_INTEGER_STRING.test(disclosure.gasUnits)
  ) {
    throw new ValidationError(
      "gasCost.gasUnits must be a canonical non-negative decimal integer string",
    );
  }
  validateExactRational(disclosure.pricePerUnitNativeMinor);
  validateAssetIdentity(disclosure.feeAsset);
}

// ---------------------------------------------------------------------------
// Slippage / liquidity impact
// ---------------------------------------------------------------------------

/**
 * The slippage disclosure of a quoted route. `worstCaseOutput` is the
 * GUARANTEED minimum received (the executable number the evaluation uses);
 * the optional limit/expected fields are declared context. An executable
 * quote always discloses its worst case — a quote without one is never
 * selectable.
 */
export interface SlippageDisclosure {
  readonly protection: "DECLARED_LIMIT" | "PROVIDER_DEFINED";
  /** The guaranteed worst-case received amount in the OUTPUT asset. */
  readonly worstCaseOutput: AmountSpec;
  /** The declared slippage limit in basis points, when the venue declares one. */
  readonly limitBasisPoints?: number;
  /** The expected (mid-estimate) output, when the venue discloses one. */
  readonly expectedOutput?: AmountSpec;
}

export function validateSlippageDisclosure(disclosure: SlippageDisclosure): void {
  if (disclosure === null || typeof disclosure !== "object") {
    throw new ValidationError("a slippage disclosure is mandatory on every quote");
  }
  if (
    disclosure.protection !== "DECLARED_LIMIT" &&
    disclosure.protection !== "PROVIDER_DEFINED"
  ) {
    throw new ValidationError("slippage.protection must be DECLARED_LIMIT or PROVIDER_DEFINED");
  }
  validateAmountSpec(disclosure.worstCaseOutput);
  if (disclosure.limitBasisPoints !== undefined) {
    if (
      !Number.isInteger(disclosure.limitBasisPoints) ||
      disclosure.limitBasisPoints < 0 ||
      disclosure.limitBasisPoints > 10_000
    ) {
      throw new ValidationError(
        "slippage.limitBasisPoints, when present, must be an integer in [0, 10000]",
      );
    }
  }
  if (disclosure.expectedOutput !== undefined) {
    validateAmountSpec(disclosure.expectedOutput);
  }
}

/**
 * The liquidity-impact disclosure: the venue-declared explicit cost of the
 * route's price impact in the output asset. A DECLARED typed input — the
 * core never models liquidity itself.
 */
export interface LiquidityImpactDisclosure {
  /** The declared impact cost in the OUTPUT asset (exact minor units). */
  readonly declaredImpactCost: AssetDenominatedAmount;
  /** Declared price impact in basis points, when the venue discloses it. */
  readonly priceImpactBasisPoints?: number;
  readonly description: string;
}

export function validateLiquidityImpactDisclosure(disclosure: LiquidityImpactDisclosure): void {
  if (disclosure === null || typeof disclosure !== "object") {
    throw new ValidationError("a liquidity impact disclosure must be an object");
  }
  validateAssetDenominatedAmount(disclosure.declaredImpactCost);
  if (disclosure.priceImpactBasisPoints !== undefined) {
    if (
      !Number.isInteger(disclosure.priceImpactBasisPoints) ||
      disclosure.priceImpactBasisPoints < 0
    ) {
      throw new ValidationError(
        "liquidityImpact.priceImpactBasisPoints, when present, must be a non-negative integer",
      );
    }
  }
  if (!isNonEmptyString(disclosure.description)) {
    throw new ValidationError("liquidityImpact.description must be a non-empty string");
  }
}

// ---------------------------------------------------------------------------
// Bridge / FX
// ---------------------------------------------------------------------------

/** The explicit bridge cost of a route that crosses chains. */
export interface BridgeCostDisclosure {
  readonly bridgeFee: AssetDenominatedAmount;
  readonly description: string;
}

export function validateBridgeCostDisclosure(disclosure: BridgeCostDisclosure): void {
  if (disclosure === null || typeof disclosure !== "object") {
    throw new ValidationError("a bridge cost disclosure must be an object");
  }
  validateAssetDenominatedAmount(disclosure.bridgeFee);
  if (!isNonEmptyString(disclosure.description)) {
    throw new ValidationError("bridgeCost.description must be a non-empty string");
  }
}

/** The explicit FX conversion cost of a route that changes currencies. */
export interface FxCostDisclosure {
  readonly conversionFee: AssetDenominatedAmount;
  readonly description: string;
}

export function validateFxCostDisclosure(disclosure: FxCostDisclosure): void {
  if (disclosure === null || typeof disclosure !== "object") {
    throw new ValidationError("an FX cost disclosure must be an object");
  }
  validateAssetDenominatedAmount(disclosure.conversionFee);
  if (!isNonEmptyString(disclosure.description)) {
    throw new ValidationError("fxCost.description must be a non-empty string");
  }
}

// ---------------------------------------------------------------------------
// Time / finality
// ---------------------------------------------------------------------------

/**
 * The time-to-settlement disclosure: an estimated settlement duration and
 * the venue's finality model. A declared typed input feeding both the hard
 * time budget and the explicit time-cost component.
 */
export interface TimeToSettlementDisclosure {
  readonly estimatedMs: number;
  readonly finalityModel: "PROBABILISTIC" | "DETERMINISTIC" | "INSTANT" | "HYBRID";
  readonly description: string;
}

export function validateTimeToSettlementDisclosure(disclosure: TimeToSettlementDisclosure): void {
  if (disclosure === null || typeof disclosure !== "object") {
    throw new ValidationError("a time-to-settlement disclosure is mandatory on every quote");
  }
  validateMs(disclosure.estimatedMs, "timeToSettlement.estimatedMs");
  if (
    disclosure.finalityModel !== "PROBABILISTIC" &&
    disclosure.finalityModel !== "DETERMINISTIC" &&
    disclosure.finalityModel !== "INSTANT" &&
    disclosure.finalityModel !== "HYBRID"
  ) {
    throw new ValidationError(
      "timeToSettlement.finalityModel must be PROBABILISTIC, DETERMINISTIC, INSTANT or HYBRID",
    );
  }
  if (!isNonEmptyString(disclosure.description)) {
    throw new ValidationError("timeToSettlement.description must be a non-empty string");
  }
}

// ---------------------------------------------------------------------------
// Venue health (an observation with its own freshness law)
// ---------------------------------------------------------------------------

export const VENUE_HEALTH_STATUSES = [
  "HEALTHY",
  "DEGRADED",
  "UNHEALTHY",
  "UNKNOWN",
] as const;

export type VenueHealthStatus = (typeof VENUE_HEALTH_STATUSES)[number];

/**
 * An observed venue health signal — an OBSERVATION carrying its own
 * mandatory freshness and provenance (the observation law applies to health
 * exactly as it applies to quotes).
 */
export interface HealthObservation {
  readonly status: VenueHealthStatus;
  readonly observedAtMs: number;
  readonly maxAgeMs: number;
  readonly provenance: QuoteProvenance;
}

export function validateHealthObservation(observation: HealthObservation): void {
  if (observation === null || typeof observation !== "object") {
    throw new ValidationError("a venue health observation must be an object");
  }
  if (!(VENUE_HEALTH_STATUSES as readonly unknown[]).includes(observation.status)) {
    throw new ValidationError(
      `health.status must be one of [${VENUE_HEALTH_STATUSES.join(", ")}]`,
    );
  }
  validateMs(observation.observedAtMs, "health.observedAtMs");
  if (!Number.isInteger(observation.maxAgeMs) || observation.maxAgeMs <= 0) {
    throw new ValidationError("health.maxAgeMs must be a positive integer (ms)");
  }
  validateQuoteProvenance(observation.provenance);
}

/** Deterministic staleness probe for a health observation. */
export function isHealthObservationStale(
  observation: HealthObservation,
  at: number,
): boolean {
  validateHealthObservation(observation);
  if (!Number.isInteger(at) || at < 0) {
    throw new ValidationError("the staleness probe instant `at` must be a non-negative integer (ms)");
  }
  return at - observation.observedAtMs > observation.maxAgeMs;
}
