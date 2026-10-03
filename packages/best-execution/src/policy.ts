/**
 * @payswap/best-execution — the versioned best-execution policy (P4-W2-002).
 *
 * The policy is the EXPLICIT, VERSIONED, CALLER-SUPPLIED input that turns
 * the typed dimension disclosures into comparable numbers. Every constant
 * lives here as a declared field — conversion rates, risk deductions, the
 * time cost, the hard budgets and tie-breakers — so the comparator itself
 * contains no hidden constant whatsoever (hard requirement). Compliance,
 * risk, policy and security constraints are HARD constraints evaluated
 * before any soft optimization (AGENTS.md rule 14).
 */

import { ValidationError } from "@payswap/protocol";
import type { AssetIdentity } from "@payswap/onchain-security";
import { validateAssetIdentity } from "@payswap/onchain-security";
import type { ExactRational } from "./exact-math.js";
import { validateExactRational } from "./exact-math.js";
import type { RiskClass } from "./outcome-dimensions.js";
import { RISK_CLASSES } from "./outcome-dimensions.js";
import type { VenueId } from "./venue-port.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// Tie-breakers
// ---------------------------------------------------------------------------

export const TIE_BREAKER_KINDS = [
  "LOWER_RISK_CLASS",
  "FASTER_SETTLEMENT",
  "FEWER_HOPS",
  "VENUE_ID",
] as const;

export type TieBreakerKind = (typeof TIE_BREAKER_KINDS)[number];

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/**
 * One explicit asset→numeraire conversion rule: the numeraire minor units
 * per ONE minor unit of the asset, as an exact rational. Every valued
 * component of every candidate converts through exactly one rule — there is
 * no ambient price feed and no default rate anywhere.
 */
export interface AssetConversionRule {
  readonly asset: AssetIdentity;
  readonly rate: ExactRational;
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * The deterministic best-execution policy. Hard constraints (time budget,
 * risk-class cap, venue allowlist, hop bound, health rules) are evaluated
 * BEFORE the soft net-outcome comparison (rule 14); the soft comparison
 * consumes the explicit rates, deductions and time cost declared here.
 */
export interface BestExecutionPolicy {
  readonly policyId: string;
  readonly version: number;
  /** The numeraire currency code every value converts into (3 letters). */
  readonly numeraire: string;
  /** The explicit conversion table (must cover every asset a valuation touches). */
  readonly conversions: readonly AssetConversionRule[];
  /** Hard budget: candidates whose estimated settlement exceeds this are disqualified. */
  readonly maxSettlementMs: number;
  /** Hard cap: risk classes ranked above this are disqualified. */
  readonly maxFailureRiskClass: RiskClass;
  /** Hard health rule for DEGRADED venues (UNHEALTHY always disqualifies). */
  readonly degradedVenuePolicy: "DISQUALIFY" | "ADMIT";
  /**
   * Explicit failure-risk deduction per class, in numeraire minor units
   * (canonical decimal integer strings). Every class must be declared —
   * even if "0" — so the deduction is always an auditable typed input.
   */
  readonly failureRiskDeductions: Readonly<Record<RiskClass, string>>;
  /** Explicit time cost per millisecond, in numeraire minor units (exact rational). */
  readonly timeCostPerMs: ExactRational;
  /** Allowed venue ids (exact); undefined = unrestricted. */
  readonly allowedVenues?: readonly VenueId[];
  /** Maximum route hops; undefined = unrestricted. */
  readonly maxRouteHops?: number;
  /**
   * Tie-break order for exactly-equal net outcomes. MUST end with VENUE_ID
   * (the deterministic total order); duplicates are rejected.
   */
  readonly tieBreakers: readonly TieBreakerKind[];
}

const CANONICAL_INTEGER_STRING = /^(0|[1-9][0-9]*)$/;

/** Runtime validation for a best-execution policy (fail closed). */
export function validateBestExecutionPolicy(policy: BestExecutionPolicy): void {
  if (policy === null || typeof policy !== "object") {
    throw new ValidationError("a best-execution policy must be an object");
  }
  const errors: string[] = [];
  if (!isNonEmptyString(policy.policyId)) {
    errors.push("policyId must be a non-empty string");
  }
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    errors.push("version must be a positive integer");
  }
  if (!/^[A-Z]{3}$/.test(policy.numeraire)) {
    errors.push("numeraire must be a 3-letter currency code (the AmountSpec currency law)");
  }
  if (!Array.isArray(policy.conversions) || policy.conversions.length === 0) {
    errors.push("conversions must be a non-empty explicit conversion table");
  } else {
    const seenAssets = new Set<string>();
    for (const rule of policy.conversions) {
      if (rule === null || typeof rule !== "object") {
        errors.push("each conversion must be { asset, rate }");
        continue;
      }
      try {
        validateAssetIdentity(rule.asset);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      try {
        validateExactRational(rule.rate);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      const key = `${rule.asset.chain}|${rule.asset.assetId}|${rule.asset.symbol}`;
      if (seenAssets.has(key)) {
        errors.push(`duplicate conversion rule for ${key} — the table must be deterministic`);
      }
      seenAssets.add(key);
    }
  }
  if (!Number.isInteger(policy.maxSettlementMs) || policy.maxSettlementMs <= 0) {
    errors.push("maxSettlementMs must be a positive integer (ms)");
  }
  if (!(RISK_CLASSES as readonly unknown[]).includes(policy.maxFailureRiskClass)) {
    errors.push(`maxFailureRiskClass must be one of [${RISK_CLASSES.join(", ")}]`);
  }
  if (policy.degradedVenuePolicy !== "DISQUALIFY" && policy.degradedVenuePolicy !== "ADMIT") {
    errors.push("degradedVenuePolicy must be DISQUALIFY or ADMIT");
  }
  const deductions = policy.failureRiskDeductions;
  if (deductions === null || typeof deductions !== "object") {
    errors.push("failureRiskDeductions must be a complete per-class deduction table");
  } else {
    for (const riskClass of RISK_CLASSES) {
      const deduction = deductions[riskClass];
      if (
        deduction === undefined ||
        typeof deduction !== "string" ||
        !CANONICAL_INTEGER_STRING.test(deduction)
      ) {
        errors.push(
          `failureRiskDeductions.${riskClass} must be a canonical non-negative decimal integer string (declare '0' explicitly — no hidden constants)`,
        );
      }
    }
  }
  try {
    validateExactRational(policy.timeCostPerMs);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (policy.allowedVenues !== undefined) {
    if (!Array.isArray(policy.allowedVenues)) {
      errors.push("allowedVenues, when present, must be an array of venue ids");
    } else {
      for (const venueId of policy.allowedVenues) {
        if (!isNonEmptyString(venueId)) {
          errors.push("allowedVenues entries must be non-empty strings");
        }
      }
    }
  }
  if (policy.maxRouteHops !== undefined) {
    if (!Number.isInteger(policy.maxRouteHops) || policy.maxRouteHops < 1) {
      errors.push("maxRouteHops, when present, must be a positive integer");
    }
  }
  if (!Array.isArray(policy.tieBreakers) || policy.tieBreakers.length === 0) {
    errors.push("tieBreakers must be a non-empty ordered list");
  } else {
    const seen = new Set<string>();
    for (const tieBreaker of policy.tieBreakers) {
      if (!(TIE_BREAKER_KINDS as readonly unknown[]).includes(tieBreaker)) {
        errors.push(
          `tieBreakers entries must be one of [${TIE_BREAKER_KINDS.join(", ")}]`,
        );
      }
      if (seen.has(String(tieBreaker))) {
        errors.push(`duplicate tie-breaker '${String(tieBreaker)}'`);
      }
      seen.add(String(tieBreaker));
    }
    const last = policy.tieBreakers[policy.tieBreakers.length - 1];
    if (last !== "VENUE_ID") {
      errors.push("tieBreakers must end with VENUE_ID (the deterministic total order)");
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(`Invalid best-execution policy: ${errors.join("; ")}`, {
      errors: [...errors],
    });
  }
}

/**
 * Deterministic conversion-rule lookup: exact asset identity (chain +
 * assetId + symbol). A missing rule is undefined — the valuation fails
 * closed with an explicit error naming the asset (never a default rate).
 */
export function conversionFor(
  policy: BestExecutionPolicy,
  asset: AssetIdentity,
): AssetConversionRule | undefined {
  return policy.conversions.find(
    (rule) =>
      rule.asset.chain === asset.chain &&
      rule.asset.assetId === asset.assetId &&
      rule.asset.symbol === asset.symbol,
  );
}
