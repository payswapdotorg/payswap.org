/**
 * @payswap/onchain-opportunities — evidence-backed onchain
 * FinancialOpportunity discovery (Work Order P4-W3-002).
 *
 * This package extends FinancialOpportunity discovery to onchain
 * opportunities across the six policy-approved families (liquidity,
 * lending, staking, incentives, arbitrage/price differences, other
 * policy-approved strategies).
 *
 * Architecture (frozen-law conforming):
 * - src/** composes ONLY the merged kernels: exact rational arithmetic and
 *   the deterministic quote-staleness law come from best-execution
 *   (consumed as-is, never redefined); the observation-law vocabulary
 *   (canonical chain keys, asset refs) comes from onchain-domain; the
 *   never-authorization law is PROVEN against the REAL W1-002 kernel
 *   validators in the test suite (prepareWrite, validateAssetObservation,
 *   recordSimulation — the kernel owns authority, never this package).
 * - The Lab runtime is driven from the TEST layer only (repository-wide
 *   INV-L01 law): opportunity families register as searchable capabilities
 *   through the pure-data descriptors in lab-registration.ts, compiled into
 *   the REAL Lab search index by the test harness (the P4-W3-001
 *   mixed-rail pattern), and the Lab's never-production-execution law
 *   extends to discovery results (OPPORTUNITY_DISCOVERY_NON_PRODUCTION_
 *   CONSTRAINT + the structural discovery tier).
 * - Every opportunity exposes the mandated typed first-class fields:
 *   capital required, expected-return ESTIMATE with explicit uncertainty
 *   bounds (exact rationals — never a claim, the vocabulary law rejects
 *   guarantee language at construction), liquidity, fees, exit path,
 *   lock-up, smart-contract risk, oracle/bridge risk, maximum-loss bound
 *   WHERE KNOWABLE (UNKNOWN is honest), evidence freshness (the observation
 *   law) and policy eligibility.
 * - DISCOVERY IS NEVER AUTHORIZATION: every record carries the structural
 *   DISCOVERY_NEVER_AUTHORIZATION tier (branded, derived-only, re-derivable,
 *   gated); the only route to execution remains the W1-002 kernel path
 *   (prepare → simulate → policy → authorize → pre-broadcast recheck),
 *   which this package never imports, wraps or re-implements.
 * - Money is exact integer minor units everywhere (INV-F01); every instant
 *   is caller-supplied (no ambient clock, no randomness, no floating
 *   point).
 */

export const PACKAGE_NAME = "@payswap/onchain-opportunities" as const;

export * from "./discovery-tier.js";
export * from "./vocabulary.js";
export * from "./model.js";
export * from "./eligibility.js";
export * from "./observation.js";
export * from "./discovery.js";
export * from "./lab-registration.js";
