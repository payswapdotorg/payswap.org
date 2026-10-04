/**
 * @payswap/onchain-opportunities — the deterministic discovery policy
 * (Work Order P4-W3-002 hard requirements 3 and 5).
 *
 * A pure, deterministic function over (opportunity, evaluation instant):
 * every rule is re-derivable from the opportunity's own typed fields, the
 * evaluation collects ALL failed rules (never just the first), and honest
 * UNKNOWN states (an un knowable maximum-loss bound, an unverified-only
 * return estimate) surface as FLAGS, never as ineligibility — UNKNOWN is not
 * FAILED (AGENTS.md rule 4).
 *
 * Adversarial rules (the task packet's stale/adversarial fixtures — each must
 * surface as ineligible/UNKNOWN/blocked, never as an attractive opportunity):
 * - STALE_OBSERVATION — the evidence is older than its freshness bound
 *   (the onchain-domain observation law, deterministic boundary);
 * - EXIT_PATH_BLOCKED / EXIT_PATH_SUSPECT_HONEYPOT — no honest exit;
 * - WITHDRAWAL_LIQUIDITY_VANISHED — nothing left to exit into;
 * - SUSPECT_RETURN_OUTSIDE_PLAUSIBLE_BAND — a "return" outside the frozen
 *   plausibility ceiling is treated as manipulated until re-observed;
 * - UNVERIFIED_INCENTIVE_COMPONENT / INCENTIVE_BUDGET_NOT_RESERVED —
 *   incentives without verified evidence or a reserved budget (AGENTS.md
 *   rule 13: incentive budgets are reserved before a program can promise
 *   funded monetary rewards);
 * - POLICY_APPROVAL_MISSING — the "other" family requires an explicit policy
 *   approval reference (no unapproved strategy is ever eligible).
 */

import { compareRationals, isQuoteStale } from "@payswap/best-execution";
import type { ExactRational } from "@payswap/best-execution";
import type { FinancialOpportunity, ReturnComponent } from "./model.js";

/**
 * The frozen plausibility ceiling on annualized expected-return point
 * estimates (1000%/yr). A point estimate ABOVE this ceiling is surfaced as
 * SUSPECT_RETURN_OUTSIDE_PLAUSIBLE_BAND — the discovery does not repeat
 * manipulated APYs, it flags them. The ceiling is a visible, typed, frozen
 * discovery-policy constant — never a hidden heuristic.
 */
export const MAX_PLAUSIBLE_RETURN_PER_YEAR: ExactRational = Object.freeze({
  numerator: "10",
  denominator: "1",
});

/** Machine-readable ineligibility reasons (frozen vocabulary). */
export const DISCOVERY_INELIGIBILITY_REASONS = [
  "STALE_OBSERVATION",
  "EXIT_PATH_BLOCKED",
  "EXIT_PATH_SUSPECT_HONEYPOT",
  "WITHDRAWAL_LIQUIDITY_VANISHED",
  "SUSPECT_RETURN_OUTSIDE_PLAUSIBLE_BAND",
  "UNVERIFIED_INCENTIVE_COMPONENT",
  "INCENTIVE_BUDGET_NOT_RESERVED",
  "POLICY_APPROVAL_MISSING",
] as const;

export type DiscoveryIneligibilityReason =
  (typeof DISCOVERY_INELIGIBILITY_REASONS)[number];

/** Honest disclosure flags (never ineligibility — UNKNOWN is not FAILED). */
export const DISCOVERY_DISCLOSURE_FLAGS = [
  "EXPECTED_RETURN_UNKNOWN",
  "MAX_LOSS_BOUND_UNKNOWN",
  "CAPITAL_REQUIREMENT_UNKNOWN",
  "FEES_UNKNOWN",
  "EXIT_PATH_UNKNOWN",
] as const;

export type DiscoveryDisclosureFlag = (typeof DISCOVERY_DISCLOSURE_FLAGS)[number];

/** The deterministic policy evaluation over one opportunity. */
export interface DiscoveryPolicyEvaluation {
  readonly eligible: boolean;
  readonly reasons: readonly DiscoveryIneligibilityReason[];
  readonly flags: readonly DiscoveryDisclosureFlag[];
  /** The caller-supplied evaluation instant (no ambient clock). */
  readonly evaluatedAt: number;
}

function isVerifiedComponent(component: ReturnComponent): boolean {
  if (!component.evidenceVerified) {
    return false;
  }
  if (component.kind === "INCENTIVE_YIELD" && component.budgetReserved !== true) {
    // An incentive without a reserved budget is not a verified component
    // (AGENTS.md rule 13).
    return false;
  }
  return true;
}

/**
 * Is the opportunity's evidence fresh at instant `at`? Deterministic
 * (best-execution quote-staleness law, consumed as-is): stale exactly when
 * (at − asOfMs) > maxAgeMs. Arbitrage legs carry their own freshness and
 * BOTH must be fresh — one stale leg voids the price-difference evidence.
 */
export function isOpportunityStale(opportunity: FinancialOpportunity, at: number): boolean {
  if (isQuoteStale(opportunity.evidenceFreshness, at)) {
    return true;
  }
  for (const leg of opportunity.arbitrageLegs ?? []) {
    if (isQuoteStale(leg.freshness, at)) {
      return true;
    }
  }
  return false;
}

/**
 * The deterministic discovery policy. Pure: the same opportunity at the
 * same instant always yields the same evaluation. Every rule is derived
 * from typed first-class fields — nothing is guessed, nothing is repaired.
 */
export function evaluateDiscoveryPolicy(
  opportunity: FinancialOpportunity,
  at: number,
): DiscoveryPolicyEvaluation {
  if (!Number.isInteger(at) || at < 0) {
    throw new RangeError(
      "the discovery policy evaluation instant `at` must be a non-negative integer (ms; no ambient clock)",
    );
  }

  const reasons: DiscoveryIneligibilityReason[] = [];
  const flags: DiscoveryDisclosureFlag[] = [];

  // 1. The observation law: stale evidence invalidates eligibility.
  if (isOpportunityStale(opportunity, at)) {
    reasons.push("STALE_OBSERVATION");
  }

  // 2. The exit path: no honest exit, no eligibility.
  if (opportunity.exitPath.status === "BLOCKED") {
    reasons.push("EXIT_PATH_BLOCKED");
  }
  if (opportunity.exitPath.status === "SUSPECT_HONEYPOT") {
    reasons.push("EXIT_PATH_SUSPECT_HONEYPOT");
  }
  if (opportunity.exitPath.status === "UNKNOWN") {
    flags.push("EXIT_PATH_UNKNOWN");
  }

  // 3. Vanished withdrawal liquidity (own profile or any arbitrage leg).
  if (opportunity.liquidity.withdrawalLiquidityMinorUnits === "0") {
    reasons.push("WITHDRAWAL_LIQUIDITY_VANISHED");
  }
  for (const leg of opportunity.arbitrageLegs ?? []) {
    if (leg.withdrawalLiquidityMinorUnits === "0") {
      reasons.push("WITHDRAWAL_LIQUIDITY_VANISHED");
    }
  }

  // 4. Manipulated-return detection: a point estimate above the frozen
  //    plausibility ceiling is surfaced as suspect, never repeated.
  if (
    opportunity.expectedReturn.point !== null &&
    compareRationals(opportunity.expectedReturn.point, MAX_PLAUSIBLE_RETURN_PER_YEAR) > 0
  ) {
    reasons.push("SUSPECT_RETURN_OUTSIDE_PLAUSIBLE_BAND");
  }

  // 5. Incentive integrity: unverified or unreserved incentive components.
  for (const component of opportunity.expectedReturn.components) {
    if (component.kind !== "INCENTIVE_YIELD") {
      continue;
    }
    if (!component.evidenceVerified) {
      reasons.push("UNVERIFIED_INCENTIVE_COMPONENT");
    }
    if (component.budgetReserved !== true) {
      reasons.push("INCENTIVE_BUDGET_NOT_RESERVED");
    }
  }

  // 6. The "other" family requires an explicit policy approval reference.
  if (opportunity.family === "other" && (opportunity.policyApprovalRef ?? "").length === 0) {
    reasons.push("POLICY_APPROVAL_MISSING");
  }

  // 7. Honest UNKNOWN disclosure (flags — never ineligibility).
  if (opportunity.expectedReturn.point === null) {
    flags.push("EXPECTED_RETURN_UNKNOWN");
  }
  if (opportunity.maxLossBound.kind === "UNKNOWN") {
    flags.push("MAX_LOSS_BOUND_UNKNOWN");
  }
  if (opportunity.capitalRequired.kind === "UNKNOWN") {
    flags.push("CAPITAL_REQUIREMENT_UNKNOWN");
  }
  if (opportunity.fees.kind === "UNKNOWN") {
    flags.push("FEES_UNKNOWN");
  }

  return Object.freeze({
    eligible: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
    flags: Object.freeze([...new Set(flags)]),
    evaluatedAt: at,
  });
}
