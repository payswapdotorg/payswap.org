/**
 * @payswap/campaigns — production participation campaigns, attribution,
 * dynamic target curves, role-specific leaderboards, referral surfaces,
 * operator controls and reward provenance inspection.
 *
 * Work Order W3-005 (Stage 5). This package OPERATIONALIZES the
 * @payswap/participation contracts (goals, programs, budgets,
 * contributions, rewards, anti-gaming, leaderboards — consumed, never
 * modified) and the @payswap/protocol reservation/obligation discipline.
 *
 * Invariant ownership (spec/architecture/INVARIANTS.md):
 * - INV-P01 monetary incentives are funded or explicitly contingent —
 *   per-campaign funding caps are ENFORCED AT ACCRUAL (rejected or deferred
 *   with evidence, never silently dropped) and campaign finalization
 *   delegates to the participation funded-budget gate;
 * - INV-P02/P03 attribution + rewards are deterministic, auditable and
 *   reproducible — the attribution pipeline and target curves are pure
 *   deterministic functions of their inputs (replay-proven);
 * - INV-P04 anti-gaming checks run before reward finalization — BLOCK
 *   suppresses, FLAG defers (both evidence-recorded), finalization requires
 *   a PASS report;
 * - INV-P05 leaderboards/points never become authorization or universal
 *   creditworthiness — role-specific projections carry a non-authorization
 *   marker and are type-incompatible with authorization artifacts;
 * - INV-P07 incentive changes create new versions/effective epochs —
 *   campaign epochs are append-only; cap/curve/band changes require a NEW
 *   program version;
 * - INV-F04/F05 reservation + idempotency discipline CONSUMED from
 *   @payswap/protocol (one contribution → one campaign reward; budget
 *   headroom enforced by the participation budget ledger).
 *
 * Deterministic by construction: no Math.random, no ambient clocks, no
 * timers — ids/times come exclusively from the injected protocol factories.
 */

export const PACKAGE_NAME = '@payswap/campaigns' as const;

export * from './target-curves.js';
export * from './campaigns.js';
export * from './attribution.js';
export * from './leaderboards.js';
export * from './referrals.js';
export * from './operator-controls.js';
export * from './provenance.js';
