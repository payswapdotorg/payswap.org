/**
 * @payswap/participation — Participation engineering + incentive accounting.
 *
 * Work Order W3-004 (Stage 3): ParticipationGoal, participation experiments,
 * IncentiveProgram versioning, budget reservations over the @payswap/protocol
 * reservation discipline, contribution records with deterministic auditable
 * attribution, referral introducer contributions, reproducible reward
 * formulas/accruals that create protocol obligations, anti-Sybil/
 * anti-collusion gates, recognition tiers and leaderboard PROJECTIONS.
 *
 * Invariant ownership (spec/architecture/INVARIANTS.md):
 * - INV-P01 monetary incentives are funded or explicitly contingent (budget.ts + rewards.ts);
 * - INV-P02 attribution is deterministic and auditable (contributions.ts);
 * - INV-P03 reward calculations are reproducible from evidence + program version (rewards.ts);
 * - INV-P04 anti-Sybil/anti-collusion checks run before reward finalization (anti-gaming.ts + rewards.ts);
 * - INV-P05 leaderboards/points never become authorization or universal creditworthiness (leaderboards.ts);
 * - INV-P06 clawbacks create separate adjustment obligations; contribution history remains (rewards.ts);
 * - INV-P07 incentive changes create new versions/effective epochs (programs.ts);
 * - INV-F04/F05 reservation + idempotency discipline is CONSUMED from @payswap/protocol.
 *
 * Deterministic by construction: no Math.random, no ambient clocks, no
 * timers — ids/times come exclusively from the injected protocol factories.
 */

export const PACKAGE_NAME = '@payswap/participation' as const;

export * from './digest.js';
export * from './evidence.js';
export * from './goals.js';
export * from './experiments.js';
export * from './programs.js';
export * from './budget.js';
export * from './contributions.js';
export * from './anti-gaming.js';
export * from './rewards.js';
export * from './leaderboards.js';
