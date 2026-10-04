/**
 * @payswap/onchain-opportunities — the FinancialOpportunity model
 * (Work Order P4-W3-002 task packet: "Each opportunity MUST expose, as typed
 * first-class fields: capital required; expected-return ESTIMATE (never a
 * claim); liquidity; fees; exit path; lock-up; smart-contract risk;
 * oracle/bridge risk; maximum-loss bound WHERE KNOWABLE (UNKNOWN is honest
 * when not knowable); evidence freshness (the onchain-domain observation
 * law); policy eligibility").
 *
 * Discipline (all mirrored from the merged kernels, never redefined):
 * - EXACT MONEY (INV-F01): every amount is an integer minor-unit string;
 *   every rate, fee fraction and return estimate is an ExactRational
 *   (canonical num/den decimal integer strings) evaluated with bigint
 *   arithmetic — there is no floating point anywhere in this package.
 * - OBSERVATION LAW (onchain-domain, INV-C09 / rule 21): every opportunity
 *   carries MANDATORY evidence freshness ({ asOfMs, maxAgeMs } — the
 *   deterministic quote-staleness semantics of best-execution, consumed
 *   as-is), MANDATORY provenance (venue, protocol, chain, adapter, observer)
 *   and a NON-EMPTY evidence chain (INV-E02). An observation-derived
 *   opportunity is never custody, never a balance and never a claim.
 * - KNOWABLE VALUES: the maximum-loss bound and several estimation inputs
 *   use the Knowable<T> union — KNOWN carries the value, UNKNOWN carries a
 *   reason. UNKNOWN is honest disclosure, never failure and never a guess.
 * - NO-GUARANTEE LANGUAGE: every human-readable surface is vocabulary-scanned
 *   at validation time (see ./vocabulary.js).
 * - NEVER AUTHORIZATION: every opportunity carries the structural
 *   discovery tier brand (see ./discovery-tier.js); there is deliberately no
 *   execution-shaped field anywhere in this model.
 */

import { ValidationError } from "@payswap/protocol";
import { isValidChainKey } from "@payswap/onchain-domain";
import { validateExactRational, validateQuoteFreshness } from "@payswap/best-execution";
import type { ExactRational, QuoteFreshness } from "@payswap/best-execution";
import { assertNoGuaranteeLanguage } from "./vocabulary.js";
import { DISCOVERY_TIER } from "./discovery-tier.js";

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

/** The six policy-approved opportunity families (frozen vocabulary). */
export const OPPORTUNITY_FAMILIES = [
  "liquidity",
  "lending",
  "staking",
  "incentives",
  "arbitrage",
  "other",
] as const;

export type OpportunityFamily = (typeof OPPORTUNITY_FAMILIES)[number];

export function isOpportunityFamily(value: unknown): value is OpportunityFamily {
  return (
    typeof value === "string" &&
    (OPPORTUNITY_FAMILIES as readonly unknown[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Knowable values (UNKNOWN is honest — never a guess, never a failure)
// ---------------------------------------------------------------------------

/**
 * A value that is KNOWN with its evidence, or honestly UNKNOWN with the
 * reason it is not knowable. Used for the maximum-loss bound ("WHERE
 * KNOWABLE"), capital requirements and fee schedules that the evidence does
 * not determine.
 */
export type Knowable<T> =
  | { readonly kind: "KNOWN"; readonly value: T }
  | { readonly kind: "UNKNOWN"; readonly reason: string };

/** Type guard for the KNOWN case. */
export function isKnown<T>(knowable: Knowable<T>): knowable is { kind: "KNOWN"; value: T } {
  return knowable.kind === "KNOWN";
}

// ---------------------------------------------------------------------------
// First-class field types
// ---------------------------------------------------------------------------

/** Exact capital requirement: the canonical asset ref + integer minor units. */
export interface CapitalRequirement {
  /** Canonical onchain-domain asset identity: `${chainKey}/asset:${symbol}`. */
  readonly assetRef: string;
  /** Exact integer minor units (INV-F01; canonical decimal string). */
  readonly minorUnits: string;
}

/** Observed liquidity profile (null fields are UNKNOWN, surfaced honestly). */
export interface LiquidityProfile {
  /** Total observed pool/venue depth in minor units, when observed. */
  readonly depthMinorUnits: string | null;
  /** Liquidity actually available to EXIT the position, when observed. */
  readonly withdrawalLiquidityMinorUnits: string | null;
}

/** Fee schedule as exact fractions of the position (never floating point). */
export interface FeeSchedule {
  readonly entryFeeFraction: ExactRational;
  readonly exitFeeFraction: ExactRational;
  readonly ongoingFeeFractionPerYear: ExactRational;
}

export const EXIT_PATH_STATUSES = [
  "AVAILABLE",
  "RESTRICTED",
  "UNKNOWN",
  "BLOCKED",
  "SUSPECT_HONEYPOT",
] as const;

export type ExitPathStatus = (typeof EXIT_PATH_STATUSES)[number];

export function isExitPathStatus(value: unknown): value is ExitPathStatus {
  return (
    typeof value === "string" &&
    (EXIT_PATH_STATUSES as readonly unknown[]).includes(value)
  );
}

/**
 * The exit path assessment: how capital can LEAVE the position. A deposit
 * that cannot honestly be withdrawn (BLOCKED) or that only LOOKS withdrawable
 * (SUSPECT_HONEYPOT) is surfaced as such — never as an attractive
 * opportunity.
 */
export interface ExitPathAssessment {
  readonly status: ExitPathStatus;
  /** Human-readable, vocabulary-scanned description of the exit route. */
  readonly description: string;
  /** Machine-readable constraints on the exit (delays, conditions, caps). */
  readonly constraints: readonly string[];
}

/** Lock-up: whether capital is committed and for how long. */
export interface LockUp {
  readonly locked: boolean;
  /** Lock duration in ms when locked and knowable; null when unknown. */
  readonly durationMs: number | null;
  /** Conditions under which the lock releases (may be empty). */
  readonly unlockConditions: readonly string[];
}

export const RISK_LEVELS = ["LOW", "MODERATE", "HIGH", "UNKNOWN"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return (
    typeof value === "string" &&
    (RISK_LEVELS as readonly unknown[]).includes(value)
  );
}

/** A risk rating: level, audit status (null = not knowable) and summary. */
export interface RiskRating {
  readonly level: RiskLevel;
  /** Whether an audit is known to exist; null when not knowable. */
  readonly audited: boolean | null;
  /** Human-readable, vocabulary-scanned risk summary. */
  readonly summary: string;
}

/**
 * The maximum-loss bound WHERE KNOWABLE: an exact fraction of deployed
 * capital. KNOWN only when the evidence bounds the loss (e.g. a maximum
 * impermanent-loss bound under observed pool weights); UNKNOWN otherwise —
 * honest disclosure, never a fabricated comfort number.
 */
export type MaxLossBound = Knowable<{ readonly fractionOfCapital: ExactRational }>;

// ---------------------------------------------------------------------------
// The expected-return ESTIMATE (never a claim)
// ---------------------------------------------------------------------------

export const RETURN_COMPONENT_KINDS = [
  "FEE_YIELD",
  "INCENTIVE_YIELD",
  "STAKING_YIELD",
  "SUPPLY_APY",
  "PRICE_DIFFERENCE",
] as const;

export type ReturnComponentKind = (typeof RETURN_COMPONENT_KINDS)[number];

export function isReturnComponentKind(value: unknown): value is ReturnComponentKind {
  return (
    typeof value === "string" &&
    (RETURN_COMPONENT_KINDS as readonly unknown[]).includes(value)
  );
}

/**
 * One evidence-backed return component. `ratePerYear` is an exact rational
 * ANNUALIZED rate (e.g. 431/10000 for an observed ~4.31%/yr fee yield).
 * `evidenceVerified` marks components whose evidence chain is verified;
 * `budgetReserved` applies to incentive components (AGENTS.md rule 13:
 * incentive budgets are reserved before a program can promise funded
 * monetary rewards — an unreserved promise is not a verified component).
 */
export interface ReturnComponent {
  readonly componentId: string;
  readonly kind: ReturnComponentKind;
  readonly ratePerYear: ExactRational;
  readonly evidenceVerified: boolean;
  /** Incentive components only: whether the reward budget is reserved. */
  readonly budgetReserved?: boolean;
  /** Human-readable, vocabulary-scanned component description. */
  readonly description: string;
}

/**
 * The expected-return estimate. This is an ESTIMATE with EXPLICIT
 * uncertainty bounds — never a claim, never a promise:
 * - `estimateKind` is pinned to EVIDENCE_BACKED_ESTIMATE (there is no other
 *   kind; the field exists so consumers cannot mistake it for a commitment);
 * - `point` is the sum of ALL observed components (verified and not);
 * - `bounds.low` is the sum of VERIFIED components only — what the evidence
 *   strictly supports;
 * - `bounds.high` equals the point (all observed components);
 * - when NO component is verified, `point` and `bounds` are null: the
 *   expected return is honestly UNKNOWN rather than an unverified number.
 */
export interface ExpectedReturnEstimate {
  readonly estimateKind: "EVIDENCE_BACKED_ESTIMATE";
  readonly point: ExactRational | null;
  readonly bounds: { readonly low: ExactRational; readonly high: ExactRational } | null;
  /** The observed components the estimate was derived from (verbatim). */
  readonly components: readonly ReturnComponent[];
  /** Human-readable, vocabulary-scanned derivation basis. */
  readonly basis: string;
}

// ---------------------------------------------------------------------------
// Evidence freshness + provenance (the observation law)
// ---------------------------------------------------------------------------

/**
 * Evidence freshness with the deterministic best-execution quote-staleness
 * semantics, consumed as-is: stale at instant `at` exactly when
 * (at − asOfMs) > maxAgeMs; at exactly maxAgeMs of age it is still fresh.
 */
export interface EvidenceFreshness {
  readonly asOfMs: number;
  readonly maxAgeMs: number;
}

function assertFreshness(freshness: EvidenceFreshness): void {
  // Structural compatibility with the canonical QuoteFreshness shape: the
  // kernel validator is reused verbatim (never re-implemented).
  const canonical: QuoteFreshness = { asOfMs: freshness.asOfMs, maxAgeMs: freshness.maxAgeMs };
  validateQuoteFreshness(canonical);
}

/** Which venue/protocol/adapter/observer produced the observation. */
export interface OpportunityProvenance {
  /** The underlying observation's id (deterministic identity input). */
  readonly observationId: string;
  readonly venueId: string;
  readonly protocolKey?: string;
  readonly chainKey: string;
  /** The adapter identity the observation flowed through. */
  readonly adapterId: string;
  /** The observer identity that captured the evidence (opaque, never key material). */
  readonly observerId: string;
  /** Evidence node references (INV-E02 — mandatory, never empty). */
  readonly evidenceRefs: readonly string[];
}

/** Deterministic discovery-policy eligibility (re-derivable, never declared). */
export interface PolicyEligibility {
  readonly eligible: boolean;
  /** Machine-readable ineligibility reasons (empty when eligible). */
  readonly reasons: readonly string[];
  readonly decidedBy: "discovery-policy";
}

/** One venue price observation leg of an arbitrage opportunity. */
export interface ArbitrageLeg {
  readonly legId: string;
  readonly venueId: string;
  /** Exact price of one whole unit of the reference asset, in numeraire. */
  readonly price: ExactRational;
  readonly freshness: EvidenceFreshness;
  /** Exit liquidity on this leg's venue, when observed (null = UNKNOWN). */
  readonly withdrawalLiquidityMinorUnits: string | null;
}

// ---------------------------------------------------------------------------
// The FinancialOpportunity
// ---------------------------------------------------------------------------

/** Nominal brand: this value is an opportunity observation, never authority. */
export const OPPORTUNITY_KIND = "FinancialOpportunity" as const;

/**
 * A discovered onchain financial opportunity. Pure frozen data: every field
 * is one of the mandated first-class fields, every human-readable surface is
 * vocabulary-scanned, and the structural discovery tier brands the record as
 * NEVER authorization. There is deliberately no method, no closure and no
 * execution-shaped field anywhere on this type.
 */
export interface FinancialOpportunity {
  readonly observationKind: typeof OPPORTUNITY_KIND;
  /** Deterministic identity: `opportunity:${family}:${chainKey}:${venueId}:${observationId}`. */
  readonly opportunityId: string;
  readonly family: OpportunityFamily;
  /** The chain the opportunity was observed on (canonical chain key). */
  readonly chainKey: string;
  readonly title: string;
  readonly description: string;

  // -- the mandated first-class fields -------------------------------------
  readonly capitalRequired: Knowable<CapitalRequirement>;
  readonly expectedReturn: ExpectedReturnEstimate;
  readonly liquidity: LiquidityProfile;
  readonly fees: Knowable<FeeSchedule>;
  readonly exitPath: ExitPathAssessment;
  readonly lockUp: LockUp;
  readonly smartContractRisk: RiskRating;
  readonly oracleBridgeRisk: RiskRating;
  readonly maxLossBound: MaxLossBound;
  readonly evidenceFreshness: EvidenceFreshness;
  readonly policyEligibility: PolicyEligibility;

  // -- evidence preservation (the observation law) --------------------------
  readonly provenance: OpportunityProvenance;
  /** Arbitrage legs (family evidence), preserved verbatim when present. */
  readonly arbitrageLegs?: readonly ArbitrageLeg[];
  /** Policy approval reference (family "other" eligibility evidence). */
  readonly policyApprovalRef?: string;

  // -- the structural never-authorization tier --------------------------------
  readonly discoveryTier: typeof DISCOVERY_TIER;
}

/** Deterministic opportunity identity. */
export function opportunityId(
  family: OpportunityFamily,
  chainKey: string,
  venueId: string,
  observationId: string,
): string {
  return `opportunity:${family}:${chainKey}:${venueId}:${observationId}`;
}

// ---------------------------------------------------------------------------
// Validation (fail closed, never repaired, never guessed)
// ---------------------------------------------------------------------------

const MINOR_UNITS_PATTERN = /^(0|[1-9][0-9]*)$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (!isNonEmptyString(value)) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateKnowable<T>(
  knowable: Knowable<T>,
  label: string,
  validateValue: (value: T) => void,
): void {
  if (knowable === null || typeof knowable !== "object") {
    throw new ValidationError(`${label} must be a Knowable (KNOWN or UNKNOWN)`);
  }
  if (knowable.kind === "KNOWN") {
    if (knowable.value === undefined) {
      throw new ValidationError(`${label}: KNOWN requires a value`);
    }
    validateValue(knowable.value);
  } else if (knowable.kind === "UNKNOWN") {
    requireNonEmpty(knowable.reason, `${label}.reason`);
  } else {
    throw new ValidationError(
      `${label}.kind must be 'KNOWN' or 'UNKNOWN' — a knowable value is never guessed`,
    );
  }
}

const SYMBOL_TAIL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

function validateCapitalRequirement(
  capital: CapitalRequirement,
  chainKey: string,
): void {
  requireNonEmpty(capital.assetRef, "capitalRequired.assetRef");
  const prefix = `${chainKey}/asset:`;
  const symbol = capital.assetRef.startsWith(prefix)
    ? capital.assetRef.substring(prefix.length)
    : "";
  if (symbol === "" || !SYMBOL_TAIL_PATTERN.test(symbol)) {
    throw new ValidationError(
      `capitalRequired.assetRef '${capital.assetRef}' is not a canonical asset ref for chain '${chainKey}' (expected \`${chainKey}/asset:<SYMBOL>\`)`,
    );
  }
  if (
    typeof capital.minorUnits !== "string" ||
    !MINOR_UNITS_PATTERN.test(capital.minorUnits)
  ) {
    throw new ValidationError(
      "capitalRequired.minorUnits must be a canonical non-negative integer decimal string (exact integer minor units — INV-F01)",
    );
  }
}

function validateReturnComponent(component: ReturnComponent): void {
  requireNonEmpty(component.componentId, "return component componentId");
  if (!isReturnComponentKind(component.kind)) {
    throw new ValidationError(
      `return component '${component.componentId}': kind must be one of [${RETURN_COMPONENT_KINDS.join(", ")}]`,
    );
  }
  validateExactRational(component.ratePerYear);
  if (typeof component.evidenceVerified !== "boolean") {
    throw new ValidationError(
      `return component '${component.componentId}': evidenceVerified must be a boolean`,
    );
  }
  if (component.budgetReserved !== undefined && typeof component.budgetReserved !== "boolean") {
    throw new ValidationError(
      `return component '${component.componentId}': budgetReserved, when present, must be a boolean`,
    );
  }
  if (component.kind !== "INCENTIVE_YIELD" && component.budgetReserved !== undefined) {
    throw new ValidationError(
      `return component '${component.componentId}': budgetReserved applies to incentive components only`,
    );
  }
  assertNoGuaranteeLanguage(component.description, `return component '${component.componentId}'.description`);
}

function validateEstimate(estimate: ExpectedReturnEstimate): void {
  if (estimate.estimateKind !== "EVIDENCE_BACKED_ESTIMATE") {
    throw new ValidationError(
      `expectedReturn.estimateKind must be 'EVIDENCE_BACKED_ESTIMATE' — the estimate is never a claim (got '${String(estimate.estimateKind)}')`,
    );
  }
  for (const component of estimate.components) {
    validateReturnComponent(component);
  }
  if (estimate.point === null && estimate.bounds === null) {
    // Honest UNKNOWN estimate: no verified components. The basis must say so.
    assertNoGuaranteeLanguage(estimate.basis, "expectedReturn.basis");
    return;
  }
  if (estimate.point === null || estimate.bounds === null) {
    throw new ValidationError(
      "expectedReturn: point and bounds are set together or null together (an estimate without bounds is a claim — the uncertainty bounds are mandatory)",
    );
  }
  validateExactRational(estimate.point);
  validateExactRational(estimate.bounds.low);
  validateExactRational(estimate.bounds.high);
  assertNoGuaranteeLanguage(estimate.basis, "expectedReturn.basis");
}

function validateProvenance(provenance: OpportunityProvenance): void {
  requireNonEmpty(provenance.observationId, "provenance.observationId");
  requireNonEmpty(provenance.venueId, "provenance.venueId");
  requireNonEmpty(provenance.adapterId, "provenance.adapterId");
  requireNonEmpty(provenance.observerId, "provenance.observerId");
  if (
    !Array.isArray(provenance.evidenceRefs) ||
    provenance.evidenceRefs.length === 0
  ) {
    throw new ValidationError(
      "provenance.evidenceRefs is MANDATORY and non-empty: an opportunity observation without linked evidence is not evidence (INV-E02)",
    );
  }
  for (const ref of provenance.evidenceRefs) {
    requireNonEmpty(ref, "provenance.evidenceRefs entry");
  }
}

function validateArbitrageLeg(leg: ArbitrageLeg): void {
  requireNonEmpty(leg.legId, "arbitrage leg legId");
  requireNonEmpty(leg.venueId, `arbitrage leg '${leg.legId}' venueId`);
  validateExactRational(leg.price);
  assertFreshness(leg.freshness);
  if (
    leg.withdrawalLiquidityMinorUnits !== null &&
    (typeof leg.withdrawalLiquidityMinorUnits !== "string" ||
      !MINOR_UNITS_PATTERN.test(leg.withdrawalLiquidityMinorUnits))
  ) {
    throw new ValidationError(
      `arbitrage leg '${leg.legId}': withdrawalLiquidityMinorUnits must be a canonical minor-unit string or null (UNKNOWN)`,
    );
  }
}

/**
 * Runtime validation of a FinancialOpportunity from untyped sources. Fails
 * closed on EVERY mandated field, scans EVERY human-readable surface for
 * guarantee vocabulary, validates every exact rational and re-derives the
 * deterministic identity. A valid opportunity is returned deep-frozen.
 */
export function validateFinancialOpportunity(candidate: unknown): FinancialOpportunity {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("a financial opportunity must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;

  if (record.observationKind !== OPPORTUNITY_KIND) {
    errors.push(
      `observationKind must be '${OPPORTUNITY_KIND}' (nominal separation from every execution/authority shape)`,
    );
  }
  if (record.discoveryTier !== DISCOVERY_TIER) {
    errors.push(
      `discoveryTier must be '${DISCOVERY_TIER}' (the structural never-authorization tier is mandatory on every opportunity)`,
    );
  }
  if (!isOpportunityFamily(record.family)) {
    errors.push(`family must be one of [${OPPORTUNITY_FAMILIES.join(", ")}]`);
  }
  if (!isNonEmptyString(record.opportunityId)) {
    errors.push("opportunityId must be a non-empty string");
  }
  if (!isValidChainKey(record.chainKey)) {
    errors.push("chainKey must be a canonical `${namespace}:${network}` chain key");
  }

  const family = isOpportunityFamily(record.family) ? record.family : undefined;
  const chainKey = isNonEmptyString(record.chainKey) ? record.chainKey : undefined;

  // Human-readable surfaces: the no-guaranteed-returns law is structural.
  const textSurfaces: readonly [string, unknown][] = [
    ["title", record.title],
    ["description", record.description],
  ];
  for (const [label, surface] of textSurfaces) {
    if (!isNonEmptyString(surface)) {
      errors.push(`${label} must be a non-empty string`);
    } else {
      try {
        assertNoGuaranteeLanguage(surface, label);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  // capitalRequired
  try {
    const capital = record.capitalRequired;
    if (capital === null || typeof capital !== "object") {
      throw new ValidationError("capitalRequired must be a Knowable (KNOWN or UNKNOWN)");
    }
    validateKnowable(capital as Knowable<CapitalRequirement>, "capitalRequired", (value) => {
      if (chainKey !== undefined) {
        validateCapitalRequirement(value, chainKey);
      }
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  // expectedReturn
  try {
    if (record.expectedReturn === null || typeof record.expectedReturn !== "object") {
      throw new ValidationError("expectedReturn must be an ExpectedReturnEstimate");
    }
    validateEstimate(record.expectedReturn as ExpectedReturnEstimate);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  // liquidity
  const liquidity = record.liquidity;
  if (liquidity === null || typeof liquidity !== "object") {
    errors.push("liquidity must be a LiquidityProfile");
  } else {
    for (const field of ["depthMinorUnits", "withdrawalLiquidityMinorUnits"] as const) {
      const value = (liquidity as LiquidityProfile)[field];
      if (value !== null && (typeof value !== "string" || !MINOR_UNITS_PATTERN.test(value))) {
        errors.push(
          `liquidity.${field} must be a canonical minor-unit string or null (UNKNOWN surfaced honestly)`,
        );
      }
    }
  }

  // fees
  try {
    const fees = record.fees;
    if (fees === null || typeof fees !== "object") {
      throw new ValidationError("fees must be a Knowable (KNOWN or UNKNOWN)");
    }
    validateKnowable(fees as Knowable<FeeSchedule>, "fees", (value) => {
      validateExactRational(value.entryFeeFraction);
      validateExactRational(value.exitFeeFraction);
      validateExactRational(value.ongoingFeeFractionPerYear);
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  // exitPath
  const exitPath = record.exitPath;
  if (exitPath === null || typeof exitPath !== "object") {
    errors.push("exitPath must be an ExitPathAssessment");
  } else {
    if (!isExitPathStatus((exitPath as ExitPathAssessment).status)) {
      errors.push(
        `exitPath.status must be one of [${EXIT_PATH_STATUSES.join(", ")}]`,
      );
    }
    if (!isNonEmptyString((exitPath as ExitPathAssessment).description)) {
      errors.push("exitPath.description must be a non-empty string");
    } else {
      try {
        assertNoGuaranteeLanguage(
          (exitPath as ExitPathAssessment).description,
          "exitPath.description",
        );
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!Array.isArray((exitPath as ExitPathAssessment).constraints)) {
      errors.push("exitPath.constraints must be an array");
    } else {
      for (const constraint of (exitPath as ExitPathAssessment).constraints) {
        if (!isNonEmptyString(constraint)) {
          errors.push("exitPath.constraints entries must be non-empty strings");
          break;
        }
        try {
          assertNoGuaranteeLanguage(constraint, "exitPath.constraints entry");
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  // lockUp
  const lockUp = record.lockUp;
  if (lockUp === null || typeof lockUp !== "object") {
    errors.push("lockUp must be a LockUp");
  } else {
    if (typeof (lockUp as LockUp).locked !== "boolean") {
      errors.push("lockUp.locked must be a boolean");
    }
    const duration = (lockUp as LockUp).durationMs;
    if (
      duration !== null &&
      (typeof duration !== "number" || !Number.isInteger(duration) || duration < 0)
    ) {
      errors.push("lockUp.durationMs must be a non-negative integer (ms) or null (UNKNOWN)");
    }
    if (!Array.isArray((lockUp as LockUp).unlockConditions)) {
      errors.push("lockUp.unlockConditions must be an array of strings");
    }
  }

  // risks
  for (const riskLabel of ["smartContractRisk", "oracleBridgeRisk"] as const) {
    const risk = record[riskLabel];
    if (risk === null || typeof risk !== "object") {
      errors.push(`${riskLabel} must be a RiskRating`);
    } else {
      if (!isRiskLevel((risk as RiskRating).level)) {
        errors.push(`${riskLabel}.level must be one of [${RISK_LEVELS.join(", ")}]`);
      }
      const audited = (risk as RiskRating).audited;
      if (audited !== null && typeof audited !== "boolean") {
        errors.push(`${riskLabel}.audited must be a boolean or null (UNKNOWN)`);
      }
      if (!isNonEmptyString((risk as RiskRating).summary)) {
        errors.push(`${riskLabel}.summary must be a non-empty string`);
      } else {
        try {
          assertNoGuaranteeLanguage((risk as RiskRating).summary, `${riskLabel}.summary`);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  // maxLossBound
  try {
    const maxLoss = record.maxLossBound;
    if (maxLoss === null || typeof maxLoss !== "object") {
      throw new ValidationError("maxLossBound must be a Knowable (KNOWN or UNKNOWN)");
    }
    validateKnowable(
      maxLoss as Knowable<{ readonly fractionOfCapital: ExactRational }>,
      "maxLossBound",
      (value) => {
        validateExactRational(value.fractionOfCapital);
      },
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  // evidenceFreshness + provenance
  try {
    if (record.evidenceFreshness === null || typeof record.evidenceFreshness !== "object") {
      throw new ValidationError("evidenceFreshness is MANDATORY (the observation law)");
    }
    assertFreshness(record.evidenceFreshness as EvidenceFreshness);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    if (record.provenance === null || typeof record.provenance !== "object") {
      throw new ValidationError("provenance is MANDATORY (the observation law)");
    }
    validateProvenance(record.provenance as OpportunityProvenance);
    if (chainKey !== undefined) {
      const provenance = record.provenance as OpportunityProvenance;
      if (provenance.chainKey !== chainKey) {
        errors.push("provenance.chainKey must match the opportunity chainKey");
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  // policyEligibility
  const policy = record.policyEligibility;
  if (policy === null || typeof policy !== "object") {
    errors.push("policyEligibility must be a PolicyEligibility");
  } else {
    if (typeof (policy as PolicyEligibility).eligible !== "boolean") {
      errors.push("policyEligibility.eligible must be a boolean");
    }
    if ((policy as PolicyEligibility).decidedBy !== "discovery-policy") {
      errors.push("policyEligibility.decidedBy must be 'discovery-policy'");
    }
    if (!Array.isArray((policy as PolicyEligibility).reasons)) {
      errors.push("policyEligibility.reasons must be an array of strings");
    } else if (
      (policy as PolicyEligibility).eligible === false &&
      (policy as PolicyEligibility).reasons.length === 0
    ) {
      errors.push(
        "policyEligibility: an ineligible opportunity carries at least one machine-readable reason (never guessed)",
      );
    }
  }

  // arbitrage legs + policy approval (family-scoped evidence preservation)
  if (Array.isArray(record.arbitrageLegs)) {
    for (const leg of record.arbitrageLegs) {
      try {
        validateArbitrageLeg(leg as ArbitrageLeg);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (record.policyApprovalRef !== undefined && !isNonEmptyString(record.policyApprovalRef)) {
    errors.push("policyApprovalRef, when present, must be a non-empty string");
  }

  // deterministic identity
  if (
    family !== undefined &&
    chainKey !== undefined &&
    isNonEmptyString(record.opportunityId) &&
    record.provenance !== null &&
    typeof record.provenance === "object"
  ) {
    const provenance = record.provenance as OpportunityProvenance;
    if (isNonEmptyString(provenance.observationId) && isNonEmptyString(provenance.venueId)) {
      const expected = opportunityId(family, chainKey, provenance.venueId, provenance.observationId);
      if (record.opportunityId !== expected) {
        errors.push(
          `opportunity identity is deterministic: opportunityId must be '${expected}'`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(`Invalid financial opportunity: ${errors.join("; ")}`, {
      errors: [...errors],
    });
  }

  return deepFreezeOpportunity(candidate as FinancialOpportunity);
}

/** Deep-freezes plain data (bigint-safe) so published opportunities are immutable. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (Object.isFrozen(value)) {
      return value;
    }
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function deepFreezeOpportunity(opportunity: FinancialOpportunity): FinancialOpportunity {
  return deepFreeze(opportunity);
}
