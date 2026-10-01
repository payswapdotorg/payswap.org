/**
 * @payswap/participation — leaderboard and points PROJECTIONS (W3-004).
 *
 * PARTICIPATION-ENGINEERING §Leaderboards: leaderboards are read models over
 * ContributionRecords. Every leaderboard declares scope and actor role,
 * metric and formula, period, eligibility, freshness, evidence strength, tie
 * rule and anti-gaming status. Metrics reflect useful outcomes, never cheap
 * activity.
 *
 * INV-P05 (leaderboards/points never become authorization or universal
 * creditworthiness) is enforced at the TYPE level:
 * - points are `LeaderboardPoints` — a bigint branded with a unique symbol
 *   that is structurally incompatible with every protocol authorization,
 *   party, obligation or reservation identifier (all string-branded) and
 *   with `Money` (an object shape);
 * - entries/projections carry a phantom `__projection` marker making them
 *   non-assignable to any protocol artifact type;
 * - the type-level separation is PROVEN by compile-time assertions in
 *   `test/leaderboards.test.ts` (`@ts-expect-error` lines that fail the
 *   `tsc --noEmit` gate if anyone ever weakens the branding).
 *
 * There is deliberately NO function on a leaderboard projection that mints,
 * signs or delegates authority: a projection is data for social/product
 * coordination only (AGENTS.md rule 11).
 */

import {
  ValidationError,
  type IdFactory,
  type PartyId,
  type TimestampMs,
} from '@payswap/protocol';
import type { ProofLevel } from './evidence.js';
import { proofLevelMeets } from './evidence.js';
import type { ActorClass } from './goals.js';
import type { ContributionRecord, ContributionOutcome } from './contributions.js';

declare const LeaderboardIdBrand: unique symbol;

/** Branded id of one leaderboard definition. */
export type LeaderboardId = string & { readonly [LeaderboardIdBrand]: 'LeaderboardId' };

/** Brand a validated string as a `LeaderboardId`. */
export function asLeaderboardId(value: string): LeaderboardId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('LeaderboardId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new ValidationError('LeaderboardId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError('LeaderboardId must not carry surrounding whitespace', { value });
  }
  return value as LeaderboardId;
}

declare const LeaderboardPointsBrand: unique symbol;

/**
 * INV-P05: leaderboard points are a distinct branded numeric quantity —
 * NOT Money, NOT a PartyId/ObligationId/ReservationId, NOT authorization
 * evidence of any kind.
 */
export type LeaderboardPoints = bigint & {
  readonly [LeaderboardPointsBrand]: 'LeaderboardPoints';
};

/** Brand a bigint as `LeaderboardPoints` (projection artifact, INV-P05). */
export function asLeaderboardPoints(value: bigint): LeaderboardPoints {
  if (typeof value !== 'bigint') {
    throw new ValidationError('LeaderboardPoints must be a bigint', { value });
  }
  return value as LeaderboardPoints;
}

declare const LeaderboardRankBrand: unique symbol;

/** Branded rank of one leaderboard entry (projection artifact, INV-P05). */
export type LeaderboardRank = number & {
  readonly [LeaderboardRankBrand]: 'LeaderboardRank';
};

/**
 * Metric kinds. `RAW_ACTIVITY_COUNT` exists in the type vocabulary ONLY so
 * `defineLeaderboard` can REJECT it loudly — leaderboards must not reward
 * raw activity when that activity can be fabricated cheaply.
 */
export type LeaderboardMetricKind =
  | 'QUALITY_WEIGHTED_UNITS'
  | 'SETTLED_VALUE_POINTS'
  | 'REFERRAL_SUCCESS_POINTS'
  | 'RAW_ACTIVITY_COUNT';

/** Quality weights per contribution outcome (deterministic integers). */
export interface QualityWeights {
  readonly VERIFIED_COMPLETED: bigint;
  readonly OBSERVED: bigint;
  /** REJECTED contributions always score zero — validating that is mandatory. */
  readonly REJECTED: bigint;
}

/** The declared metric + formula of a leaderboard. */
export interface LeaderboardMetric {
  readonly kind: LeaderboardMetricKind;
  readonly qualityWeights: QualityWeights;
  /** SETTLED_VALUE_POINTS: points per 10,000 minor units of contribution value. */
  readonly valuePointsBps?: bigint;
}

/** Deterministic eligibility rules applied per contribution. */
export type LeaderboardEligibilityRule =
  | { readonly kind: 'MIN_PROOF_LEVEL'; readonly level: ProofLevel }
  | { readonly kind: 'EXCLUDE_OUTCOME'; readonly outcome: ContributionOutcome }
  | { readonly kind: 'MIN_QUANTITY'; readonly min: bigint };

/** Tie rules for equal points. */
export type LeaderboardTieRule = 'EARLIEST_FIRST' | 'LOWEST_ACTOR_ID' | 'SHARED_RANK';

/** One recognition tier threshold (a projection artifact — never authority). */
export interface RecognitionTier {
  readonly name: string;
  readonly minPoints: LeaderboardPoints;
  readonly description?: string;
}

/** A leaderboard definition — every §Leaderboards declaration is present. */
export interface LeaderboardDefinition {
  readonly id: LeaderboardId;
  /** Scope and actor role. */
  readonly scope: string;
  readonly actorRole: ActorClass;
  readonly metric: LeaderboardMetric;
  /** Period: only contributions inside [from, to] project. */
  readonly period: { readonly from: TimestampMs; readonly to: TimestampMs };
  /** Eligibility: deterministic per-contribution rules. */
  readonly eligibility: readonly LeaderboardEligibilityRule[];
  /** Freshness: when the projection was computed and the source cutoff. */
  readonly freshness: { readonly computedAt: TimestampMs; readonly sourceCutoff: TimestampMs };
  /** Declared evidence strength of the metric. */
  readonly evidenceStrength: ProofLevel;
  readonly tieRule: LeaderboardTieRule;
  /** Anti-gaming status of the metric (declared, auditable). */
  readonly antiGamingStatus: 'ENFORCED' | 'DECLARED_NOT_ENFORCED';
  /** Which behavior codes count toward this leaderboard. */
  readonly includedBehaviors: readonly string[];
  readonly tiers?: readonly RecognitionTier[];
}

/** Input shape for `defineLeaderboard` (id minted via injected factory). */
export interface LeaderboardDefinitionSpec {
  readonly scope: string;
  readonly actorRole: ActorClass;
  readonly metric: LeaderboardMetric;
  readonly period: { readonly from: TimestampMs; readonly to: TimestampMs };
  readonly eligibility?: readonly LeaderboardEligibilityRule[];
  readonly freshness: { readonly computedAt: TimestampMs; readonly sourceCutoff: TimestampMs };
  readonly evidenceStrength: ProofLevel;
  readonly tieRule: LeaderboardTieRule;
  readonly antiGamingStatus: 'ENFORCED' | 'DECLARED_NOT_ENFORCED';
  readonly includedBehaviors: readonly string[];
  readonly tiers?: readonly RecognitionTier[];
}

/**
 * A leaderboard entry — a PROJECTION artifact (INV-P05). The phantom
 * `__projection` marker makes this structurally incompatible with protocol
 * artifact types at compile time.
 */
export interface LeaderboardEntry {
  readonly __projection: 'LEADERBOARD_PROJECTION';
  readonly actor: PartyId;
  readonly points: LeaderboardPoints;
  readonly rank: LeaderboardRank;
  readonly contributionCount: bigint;
  readonly evidenceRefs: readonly string[];
  readonly tier?: string;
}

/** The computed projection (frozen, deterministic for definition + records). */
export interface LeaderboardProjection {
  readonly __projection: 'LEADERBOARD_PROJECTION';
  readonly definition: LeaderboardDefinition;
  readonly entries: readonly LeaderboardEntry[];
  readonly excludedCount: bigint;
}

/** A raw-activity metric was rejected (leaderboards reward useful outcomes). */
export class RawActivityMetricRejectedError extends ValidationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.name = 'RawActivityMetricRejectedError';
  }
}

/** Define (validate + freeze) one leaderboard definition. */
export function defineLeaderboard(
  spec: LeaderboardDefinitionSpec,
  deps: { readonly ids: IdFactory },
): LeaderboardDefinition {
  if (spec === null || typeof spec !== 'object') {
    throw new ValidationError('spec must be a LeaderboardDefinitionSpec object');
  }
  if (typeof spec.scope !== 'string' || spec.scope.length === 0) {
    throw new ValidationError('spec.scope must be a non-empty string');
  }
  if (spec.scope.length > 256) {
    throw new ValidationError('spec.scope exceeds 256 characters');
  }
  const knownRoles: readonly string[] = [
    'SENDER',
    'RECIPIENT_BENEFICIARY',
    'MERCHANT',
    'LIQUIDITY_PROVIDER',
    'LENDER',
    'BORROWER',
    'MARKET_MAKER',
    'RAIL_PROVIDER',
    'DEVELOPER',
    'AGENT_PUBLISHER',
    'EXPERT_VERIFIER',
    'INTRODUCER_REFERRER',
    'GUARANTY_INSURER',
    'OPERATOR',
  ];
  if (!knownRoles.includes(spec.actorRole)) {
    throw new ValidationError('spec.actorRole must be a known ActorClass', { role: spec.actorRole });
  }
  if (spec.metric === null || typeof spec.metric !== 'object') {
    throw new ValidationError('spec.metric must be a LeaderboardMetric');
  }
  if (spec.metric.kind === 'RAW_ACTIVITY_COUNT') {
    throw new RawActivityMetricRejectedError(
      'RAW_ACTIVITY_COUNT metrics are rejected: leaderboards must reflect useful outcomes, not raw artificial activity (W3-004 / PARTICIPATION-ENGINEERING §Leaderboards)',
    );
  }
  const allowedKinds: readonly string[] = [
    'QUALITY_WEIGHTED_UNITS',
    'SETTLED_VALUE_POINTS',
    'REFERRAL_SUCCESS_POINTS',
    'RAW_ACTIVITY_COUNT',
  ];
  if (!allowedKinds.includes(spec.metric.kind)) {
    throw new ValidationError('spec.metric.kind is unknown', { kind: spec.metric.kind });
  }
  const weights = spec.metric.qualityWeights;
  if (weights === null || typeof weights !== 'object') {
    throw new ValidationError('spec.metric.qualityWeights must be declared');
  }
  for (const weight of [weights.VERIFIED_COMPLETED, weights.OBSERVED, weights.REJECTED]) {
    if (typeof weight !== 'bigint' || weight < 0n) {
      throw new ValidationError('quality weights must be non-negative bigints');
    }
  }
  if (weights.REJECTED !== 0n) {
    throw new ValidationError('REJECTED contributions must always weigh zero');
  }
  if (spec.metric.kind === 'SETTLED_VALUE_POINTS') {
    if (spec.metric.valuePointsBps === undefined || typeof spec.metric.valuePointsBps !== 'bigint' || spec.metric.valuePointsBps <= 0n) {
      throw new ValidationError('SETTLED_VALUE_POINTS metrics require a positive bigint valuePointsBps');
    }
  }
  if (
    spec.period === null ||
    typeof spec.period !== 'object' ||
    typeof spec.period.from !== 'bigint' ||
    typeof spec.period.to !== 'bigint' ||
    spec.period.to <= spec.period.from
  ) {
    throw new ValidationError('spec.period must be a window that closes after it opens');
  }
  const eligibility = spec.eligibility === undefined ? [] : spec.eligibility;
  if (!Array.isArray(eligibility)) {
    throw new ValidationError('spec.eligibility must be an array of rules');
  }
  for (const rule of eligibility) {
    if (rule === null || typeof rule !== 'object') {
      throw new ValidationError('spec.eligibility entries must be LeaderboardEligibilityRule');
    }
    if (rule.kind !== 'MIN_PROOF_LEVEL' && rule.kind !== 'EXCLUDE_OUTCOME' && rule.kind !== 'MIN_QUANTITY') {
      throw new ValidationError('spec.eligibility[].kind is unknown', { kind: rule.kind });
    }
  }
  if (
    spec.freshness === null ||
    typeof spec.freshness !== 'object' ||
    typeof spec.freshness.computedAt !== 'bigint' ||
    typeof spec.freshness.sourceCutoff !== 'bigint' ||
    spec.freshness.sourceCutoff > spec.freshness.computedAt
  ) {
    throw new ValidationError('spec.freshness must carry computedAt >= sourceCutoff (bigint)');
  }
  const proofLevels: readonly string[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];
  if (!proofLevels.includes(spec.evidenceStrength)) {
    throw new ValidationError('spec.evidenceStrength must be a ProofLevel P0..P5');
  }
  if (
    spec.tieRule !== 'EARLIEST_FIRST' &&
    spec.tieRule !== 'LOWEST_ACTOR_ID' &&
    spec.tieRule !== 'SHARED_RANK'
  ) {
    throw new ValidationError('spec.tieRule must be a known LeaderboardTieRule');
  }
  if (spec.antiGamingStatus !== 'ENFORCED' && spec.antiGamingStatus !== 'DECLARED_NOT_ENFORCED') {
    throw new ValidationError('spec.antiGamingStatus must be ENFORCED or DECLARED_NOT_ENFORCED');
  }
  if (spec.antiGamingStatus === 'ENFORCED') {
    const hasProofGate = eligibility.some(
      (rule) => rule.kind === 'MIN_PROOF_LEVEL' && proofLevelMeets(rule.level, 'P1'),
    );
    if (!hasProofGate) {
      throw new ValidationError(
        'ENFORCED anti-gaming status requires at least one MIN_PROOF_LEVEL eligibility rule at P1 or stronger',
      );
    }
  }
  if (!Array.isArray(spec.includedBehaviors) || spec.includedBehaviors.length === 0) {
    throw new ValidationError('spec.includedBehaviors must be a non-empty array');
  }
  const tiers = spec.tiers === undefined ? [] : spec.tiers;
  if (!Array.isArray(tiers)) {
    throw new ValidationError('spec.tiers must be an array of RecognitionTier');
  }
  let previousMin: bigint | undefined;
  for (const tier of tiers) {
    if (tier === null || typeof tier !== 'object') {
      throw new ValidationError('spec.tiers entries must be RecognitionTier objects');
    }
    if (typeof tier.name !== 'string' || tier.name.length === 0) {
      throw new ValidationError('spec.tiers[].name must be a non-empty string');
    }
    if (typeof tier.minPoints !== 'bigint' || tier.minPoints < 0n) {
      throw new ValidationError('spec.tiers[].minPoints must be a non-negative bigint');
    }
    if (previousMin !== undefined && tier.minPoints <= previousMin) {
      throw new ValidationError('spec.tiers must be strictly ascending by minPoints');
    }
    previousMin = tier.minPoints;
  }
  return Object.freeze({
    id: asLeaderboardId(deps.ids.mintId('lead')),
    scope: spec.scope,
    actorRole: spec.actorRole,
    metric: Object.freeze({
      kind: spec.metric.kind,
      qualityWeights: Object.freeze({
        VERIFIED_COMPLETED: weights.VERIFIED_COMPLETED,
        OBSERVED: weights.OBSERVED,
        REJECTED: 0n,
      }),
      ...(spec.metric.valuePointsBps !== undefined
        ? { valuePointsBps: spec.metric.valuePointsBps }
        : {}),
    }),
    period: Object.freeze({ from: spec.period.from, to: spec.period.to }),
    eligibility: Object.freeze(eligibility.map((rule) => Object.freeze({ ...rule }))),
    freshness: Object.freeze({ ...spec.freshness }),
    evidenceStrength: spec.evidenceStrength,
    tieRule: spec.tieRule,
    antiGamingStatus: spec.antiGamingStatus,
    includedBehaviors: Object.freeze([...spec.includedBehaviors]),
    ...(tiers.length > 0
      ? { tiers: Object.freeze(tiers.map((tier) => Object.freeze({ ...tier }))) }
      : {}),
  });
}

/** Deterministic per-contribution eligibility evaluation. */
function eligible(
  definition: LeaderboardDefinition,
  record: ContributionRecord,
): boolean {
  if (record.actorRole !== definition.actorRole) {
    return false;
  }
  if (!definition.includedBehaviors.includes(record.behavior)) {
    return false;
  }
  if (record.occurredAt < definition.period.from || record.occurredAt > definition.period.to) {
    return false;
  }
  for (const rule of definition.eligibility) {
    if (rule.kind === 'MIN_PROOF_LEVEL') {
      const strongest = strongestOf(record);
      if (strongest === undefined || !proofLevelMeets(strongest, rule.level)) {
        return false;
      }
    } else if (rule.kind === 'EXCLUDE_OUTCOME') {
      if (record.outcome === rule.outcome) {
        return false;
      }
    } else if (rule.kind === 'MIN_QUANTITY') {
      if (record.quantity < rule.min) {
        return false;
      }
    }
  }
  return true;
}

function strongestOf(record: ContributionRecord): ProofLevel | undefined {
  let strongest: ProofLevel | undefined;
  const ranks: Readonly<Record<string, number>> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };
  for (const reference of record.evidence) {
    if (strongest === undefined || (ranks[reference.level] ?? 0) > (ranks[strongest] ?? 0)) {
      strongest = reference.level;
    }
  }
  return strongest;
}

/** Deterministic points of one eligible contribution under the metric. */
function pointsFor(
  definition: LeaderboardDefinition,
  record: ContributionRecord,
): LeaderboardPoints {
  const weights = definition.metric.qualityWeights;
  let points: bigint;
  switch (definition.metric.kind) {
    case 'QUALITY_WEIGHTED_UNITS':
      points = record.quantity * weightFor(weights, record.outcome);
      break;
    case 'SETTLED_VALUE_POINTS': {
      const bps = definition.metric.valuePointsBps ?? 1n;
      const value = record.value !== undefined ? record.value.value : 0n;
      points = (value * bps) / 10_000n;
      break;
    }
    case 'REFERRAL_SUCCESS_POINTS':
      points = record.quantity * weightFor(weights, record.outcome);
      break;
    case 'RAW_ACTIVITY_COUNT':
      // Unreachable: defineLeaderboard rejects this kind loudly.
      throw new ValidationError('RAW_ACTIVITY_COUNT is not projectable');
  }
  return points as LeaderboardPoints;
}

function weightFor(weights: QualityWeights, outcome: ContributionOutcome): bigint {
  switch (outcome) {
    case 'VERIFIED_COMPLETED':
      return weights.VERIFIED_COMPLETED;
    case 'OBSERVED':
      return weights.OBSERVED;
    case 'REJECTED':
      return weights.REJECTED;
  }
}

/**
 * Project a leaderboard over contribution records — a pure deterministic
 * read model: same definition + same records → identical ranking, points,
 * tiers and excluded count. Ranking is points-descending; ties resolve by
 * the declared tie rule (SHARED_RANK gives tied actors the same rank).
 */
export function projectLeaderboard(
  definition: LeaderboardDefinition,
  records: readonly ContributionRecord[],
): LeaderboardProjection {
  if (!Array.isArray(records)) {
    throw new ValidationError('records must be an array of ContributionRecord');
  }
  const aggregated = new Map<PartyId, { points: bigint; count: bigint; evidence: string[]; firstAt: TimestampMs }>();
  let excluded = 0n;
  for (const record of records) {
    if (!eligible(definition, record)) {
      excluded += 1n;
      continue;
    }
    const entry = aggregated.get(record.actor);
    const points = pointsFor(definition, record);
    if (entry === undefined) {
      aggregated.set(record.actor, {
        points,
        count: 1n,
        evidence: [...record.attribution.evidenceRefs],
        firstAt: record.occurredAt,
      });
    } else {
      entry.points += points;
      entry.count += 1n;
      entry.evidence.push(...record.attribution.evidenceRefs);
      if (record.occurredAt < entry.firstAt) {
        entry.firstAt = record.occurredAt;
      }
    }
  }

  const actors = [...aggregated.keys()];
  const pointsOf = (actor: PartyId): bigint => aggregated.get(actor)?.points ?? 0n;
  const firstOf = (actor: PartyId): TimestampMs => aggregated.get(actor)?.firstAt ?? 0n;
  actors.sort((a, b) => {
    const pointsDelta = pointsOf(b) - pointsOf(a);
    if (pointsDelta !== 0n) return pointsDelta > 0n ? 1 : -1;
    // Tie resolution — deterministic per the declared rule.
    switch (definition.tieRule) {
      case 'EARLIEST_FIRST':
        return firstOf(a) < firstOf(b) ? -1 : firstOf(a) > firstOf(b) ? 1 : a < b ? -1 : 1;
      case 'LOWEST_ACTOR_ID':
        return a < b ? -1 : a > b ? 1 : 0;
      case 'SHARED_RANK':
        return a < b ? -1 : a > b ? 1 : 0;
    }
  });

  const entries: LeaderboardEntry[] = [];
  let sharedRank = 1;
  let previousPoints: bigint | undefined;
  for (let index = 0; index < actors.length; index += 1) {
    const actor = actors[index];
    if (actor === undefined) {
      continue;
    }
    const data = aggregated.get(actor);
    if (data === undefined) {
      continue;
    }
    const rank =
      definition.tieRule === 'SHARED_RANK' && previousPoints !== undefined && data.points === previousPoints
        ? (sharedRank as LeaderboardRank)
        : ((index + 1) as LeaderboardRank);
    if (definition.tieRule === 'SHARED_RANK' && (previousPoints === undefined || data.points !== previousPoints)) {
      sharedRank = index + 1;
    }
    previousPoints = data.points;
    const tierName =
      definition.tiers !== undefined
        ? recognitionTierFor(data.points as LeaderboardPoints, definition.tiers)
        : undefined;
    entries.push(
      Object.freeze({
        __projection: 'LEADERBOARD_PROJECTION' as const,
        actor,
        points: data.points as LeaderboardPoints,
        rank,
        contributionCount: data.count,
        evidenceRefs: Object.freeze([...data.evidence]),
        ...(tierName !== undefined ? { tier: tierName } : {}),
      }),
    );
  }
  return Object.freeze({
    __projection: 'LEADERBOARD_PROJECTION' as const,
    definition,
    entries: Object.freeze(entries),
    excludedCount: excluded,
  });
}

/**
 * Recognition tier for a points total: the highest declared threshold the
 * points reach (deterministic; undefined when below every threshold).
 * Recognition tiers are PROJECTION artifacts — they never authorize anything.
 */
export function recognitionTierFor(
  points: LeaderboardPoints,
  tiers: readonly RecognitionTier[],
): string | undefined {
  let matched: string | undefined;
  for (const tier of tiers) {
    if (points >= tier.minPoints) {
      matched = tier.name;
    }
  }
  return matched;
}
