/**
 * @payswap/onchain-opportunities — the observation law applied to
 * opportunities (Work Order P4-W3-002 hard requirement 3:
 * "Provenance/evidence is preserved — every opportunity observation carries
 * its evidence chain (which venue/protocol observed, at what freshness,
 * through which adapter); stale observations are invalidated
 * deterministically (the observation law)").
 *
 * `resolveOpportunity` is the deterministic read-time projection of one
 * opportunity at one caller-supplied instant:
 * - CURRENT — the evidence is fresh at `at`; the re-derived policy
 *   evaluation is returned (defense in depth: the construction-time
 *   eligibility recorded on the opportunity is re-derived, never trusted);
 * - STALE — the evidence is older than its freshness bound: the opportunity
 *   is INVALIDATED (eligibility forced false with reason STALE_OBSERVATION)
 *   and the full evidence chain is preserved verbatim so the consumer can
 *   see exactly WHICH observation went stale, through which venue, adapter
 *   and observer. A stale opportunity is never attractive, never repaired
 *   and never silently dropped.
 */

import type { FinancialOpportunity } from "./model.js";
import {
  evaluateDiscoveryPolicy,
  isOpportunityStale,
} from "./eligibility.js";
import type { DiscoveryPolicyEvaluation } from "./eligibility.js";

/** Why a resolved opportunity is not current. */
export type OpportunityInvalidationReason = "STALE_OBSERVATION";

/** The deterministic read-time projection of an opportunity. */
export type ResolvedOpportunity =
  | {
      readonly status: "CURRENT";
      readonly opportunity: FinancialOpportunity;
      readonly policy: DiscoveryPolicyEvaluation;
    }
  | {
      readonly status: "STALE";
      readonly opportunity: FinancialOpportunity;
      /** The re-derived evaluation — always ineligible once stale. */
      readonly policy: DiscoveryPolicyEvaluation;
      readonly reason: OpportunityInvalidationReason;
      /** The caller-supplied invalidation instant (no ambient clock). */
      readonly invalidatedAt: number;
    };

/**
 * Resolves one opportunity at instant `at`. Deterministic and pure: the
 * same opportunity and instant always yield the same resolution. A stale
 * observation surfaces as STALE with eligibility forced false — the
 * deterministic invalidation the observation law demands — while the
 * evidence chain (venue, protocol, adapter, observer, evidence refs,
 * freshness) is carried through verbatim.
 */
export function resolveOpportunity(
  opportunity: FinancialOpportunity,
  at: number,
): ResolvedOpportunity {
  if (!Number.isInteger(at) || at < 0) {
    throw new RangeError(
      "the resolution instant `at` must be a non-negative integer (ms; no ambient clock)",
    );
  }
  const stale = isOpportunityStale(opportunity, at);
  const policy = evaluateDiscoveryPolicy(opportunity, at);
  if (!stale) {
    return Object.freeze({
      status: "CURRENT",
      opportunity,
      policy,
    });
  }
  // Deterministic invalidation: a stale observation is never eligible.
  const invalidated: DiscoveryPolicyEvaluation = Object.freeze({
    eligible: false,
    reasons: Object.freeze([
      ...new Set([...policy.reasons, "STALE_OBSERVATION" as const]),
    ]),
    flags: policy.flags,
    evaluatedAt: at,
  });
  return Object.freeze({
    status: "STALE",
    opportunity,
    policy: invalidated,
    reason: "STALE_OBSERVATION",
    invalidatedAt: at,
  });
}

/**
 * Resolves a batch deterministically: same instants, same order in, same
 * order out. Stale entries are invalidated (never dropped, never repaired).
 */
export function resolveOpportunities(
  opportunities: readonly FinancialOpportunity[],
  at: number,
): readonly ResolvedOpportunity[] {
  return Object.freeze(opportunities.map((opportunity) => resolveOpportunity(opportunity, at)));
}
