/**
 * @payswap/campaigns — role-specific leaderboard projections (W3-005).
 *
 * PARTICIPATION-ENGINEERING §Leaderboards: leaderboards are READ MODELS over
 * ContributionRecords, and every leaderboard declares scope and actor role,
 * metric and formula, period, eligibility, freshness, evidence strength, tie
 * rule and anti-gaming status. This module builds ROLE-SPECIFIC projections
 * (sender / merchant / developer / expert / introducer classes) on top of the
 * W3-004 projection machinery — consumed, never reimplemented.
 *
 * INV-P05 (leaderboards/points never become authorization or universal
 * creditworthiness) — enforced at the TYPE level, mirroring and strengthening
 * the W3-004 discipline:
 * - every projection and entry carries a `__projection` marker
 *   (`ROLE_LEADERBOARD_PROJECTION`) AND an explicit `nonAuthorization`
 *   marker object, so a projection can never be confused with a protocol
 *   artifact;
 * - `AuthorizationArtifact` is a nominally-branded type standing in for any
 *   authorization-consuming position; the compile-time assertions in
 *   `test/leaderboards.test.ts` (`@ts-expect-error`) PROVE that neither a
 *   projection, an entry, points nor ranks can be passed where authorization
 *   is required — those assertions fail the `tsc --noEmit` gate if anyone
 *   ever weakens the branding;
 * - there is deliberately NO function on a projection that mints, signs or
 *   delegates authority: a projection is data for social/product
 *   coordination only (AGENTS.md rule 11).
 */

import {
  ValidationError,
  type IdFactory,
  type PartyId,
} from '@payswap/protocol';
import {
  defineLeaderboard,
  projectLeaderboard,
  type ContributionRecord,
  type LeaderboardDefinition,
  type LeaderboardDefinitionSpec,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type LeaderboardPoints,
  type LeaderboardTieRule,
  type ProofLevel,
} from '@payswap/participation';

/**
 * The role classes that carry role-specific leaderboards (W3-005 §4). A
 * leaderboard is ALWAYS scoped to exactly one of these — there is no
 * cross-role or "all actors" projection surface here.
 */
export type LeaderboardRoleClass =
  | 'SENDER'
  | 'MERCHANT'
  | 'DEVELOPER'
  | 'EXPERT_VERIFIER'
  | 'INTRODUCER_REFERRER';

/** The closed set of role classes with role-specific leaderboards. */
export const LEADERBOARD_ROLE_CLASSES: readonly LeaderboardRoleClass[] = Object.freeze([
  'SENDER',
  'MERCHANT',
  'DEVELOPER',
  'EXPERT_VERIFIER',
  'INTRODUCER_REFERRER',
]);

/**
 * INV-P05 nominal brand: the type of anything an authorization-consuming
 * position accepts. Structurally incompatible with every leaderboard
 * projection artifact below — proven by compile-time assertions in tests.
 */
declare const AuthorizationArtifactBrand: unique symbol;

/** Anything that could be (mis)used as authorization evidence. */
export type AuthorizationArtifact = {
  readonly [AuthorizationArtifactBrand]: 'AuthorizationArtifact';
};

/**
 * A stand-in for any authorization-consuming API. Passing a leaderboard
 * projection here is a TYPE ERROR — by design (INV-P05).
 */
export function consumesAuthorization(artifact: AuthorizationArtifact): never {
  throw new ValidationError(
    'authorization consumption is nominal — leaderboard projections can never be authorization (INV-P05)',
    { received: String(artifact) },
  );
}

/** The non-authorization marker every projection carries (INV-P05). */
export interface NonAuthorizationMarker {
  /** Literal marker — 'NOT_AUTHORIZATION'. */
  readonly marker: 'NOT_AUTHORIZATION';
  /** Human-readable disclaimer rendered with every projection. */
  readonly disclaimer: string;
}

/** The shared non-authorization marker instance (frozen, immutable). */
export const NON_AUTHORIZATION: NonAuthorizationMarker = Object.freeze({
  marker: 'NOT_AUTHORIZATION',
  disclaimer:
    'This leaderboard is a social/product coordination projection over contribution records. It is NOT a trust score, NOT creditworthiness, and can NEVER authorize a transfer, a limit, a permission or any protocol action (INV-P05).',
});

/** Input shape for defining one role-specific leaderboard. */
export interface RoleLeaderboardSpec {
  readonly role: LeaderboardRoleClass;
  readonly scope: string;
  readonly metric: LeaderboardMetric;
  readonly period: { readonly from: bigint; readonly to: bigint };
  readonly eligibility?: LeaderboardDefinitionSpec['eligibility'];
  readonly freshness: { readonly computedAt: bigint; readonly sourceCutoff: bigint };
  readonly evidenceStrength: ProofLevel;
  readonly tieRule: LeaderboardTieRule;
  readonly includedBehaviors: readonly string[];
  readonly tiers?: LeaderboardDefinitionSpec['tiers'];
}

/** A defined role-specific leaderboard (wraps a W3-004 definition). */
export interface RoleLeaderboard {
  readonly __projection: 'ROLE_LEADERBOARD_PROJECTION';
  readonly role: LeaderboardRoleClass;
  readonly definition: LeaderboardDefinition;
  readonly nonAuthorization: NonAuthorizationMarker;
}

/** One role-specific leaderboard entry (projection artifact, INV-P05). */
export interface RoleLeaderboardEntry {
  readonly __projection: 'ROLE_LEADERBOARD_PROJECTION';
  readonly actor: PartyId;
  readonly points: LeaderboardPoints;
  readonly rank: number;
  readonly contributionCount: bigint;
  readonly evidenceRefs: readonly string[];
  readonly tier?: string;
  readonly nonAuthorization: NonAuthorizationMarker;
}

/** The projected role-specific leaderboard (read model, INV-P05). */
export interface RoleLeaderboardProjection {
  readonly __projection: 'ROLE_LEADERBOARD_PROJECTION';
  readonly role: LeaderboardRoleClass;
  readonly definition: LeaderboardDefinition;
  readonly entries: readonly RoleLeaderboardEntry[];
  readonly excludedCount: bigint;
  readonly nonAuthorization: NonAuthorizationMarker;
}

/** A non-role class was supplied. */
export class RoleClassRejectedError extends ValidationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.name = 'RoleClassRejectedError';
  }
}

/**
 * Define one role-specific leaderboard. The W3-004 machinery validates and
 * freezes the definition (rejecting RAW_ACTIVITY_COUNT metrics loudly and
 * requiring an ENFORCED anti-gaming status to carry a proof gate); this
 * wrapper pins the actor role to the declared role class and attaches the
 * non-authorization marker.
 */
export function defineRoleLeaderboard(
  spec: RoleLeaderboardSpec,
  deps: { readonly ids: IdFactory },
): RoleLeaderboard {
  if (spec === null || typeof spec !== 'object') {
    throw new ValidationError('spec must be a RoleLeaderboardSpec object');
  }
  if (!LEADERBOARD_ROLE_CLASSES.includes(spec.role)) {
    throw new RoleClassRejectedError(
      'role-specific leaderboards require one of the declared role classes (SENDER, MERCHANT, DEVELOPER, EXPERT_VERIFIER, INTRODUCER_REFERRER)',
      { role: spec.role },
    );
  }
  const definition = defineLeaderboard(
    {
      scope: spec.scope,
      actorRole: spec.role,
      metric: spec.metric,
      period: spec.period,
      ...(spec.eligibility !== undefined ? { eligibility: spec.eligibility } : {}),
      freshness: spec.freshness,
      evidenceStrength: spec.evidenceStrength,
      tieRule: spec.tieRule,
      antiGamingStatus: 'ENFORCED',
      includedBehaviors: spec.includedBehaviors,
      ...(spec.tiers !== undefined ? { tiers: spec.tiers } : {}),
    },
    deps,
  );
  return Object.freeze({
    __projection: 'ROLE_LEADERBOARD_PROJECTION' as const,
    role: spec.role,
    definition,
    nonAuthorization: NON_AUTHORIZATION,
  });
}

/**
 * Project one role-specific leaderboard over contribution records — a pure
 * deterministic read model (same definition + records → identical ranking),
 * delegated to the W3-004 projector. Every entry carries the
 * non-authorization marker.
 */
export function projectRoleLeaderboard(
  leaderboard: RoleLeaderboard,
  records: readonly ContributionRecord[],
): RoleLeaderboardProjection {
  if (leaderboard === null || typeof leaderboard !== 'object') {
    throw new ValidationError('leaderboard must be a RoleLeaderboard');
  }
  const projected = projectLeaderboard(leaderboard.definition, records);
  const entries: RoleLeaderboardEntry[] = projected.entries.map((entry: LeaderboardEntry) => {
    const frozen: {
      -readonly [K in keyof RoleLeaderboardEntry]: RoleLeaderboardEntry[K];
    } = {
      __projection: 'ROLE_LEADERBOARD_PROJECTION',
      actor: entry.actor,
      points: entry.points,
      rank: entry.rank,
      contributionCount: entry.contributionCount,
      evidenceRefs: entry.evidenceRefs,
      nonAuthorization: NON_AUTHORIZATION,
    };
    if (entry.tier !== undefined) frozen.tier = entry.tier;
    return Object.freeze(frozen);
  });
  return Object.freeze({
    __projection: 'ROLE_LEADERBOARD_PROJECTION' as const,
    role: leaderboard.role,
    definition: leaderboard.definition,
    entries: Object.freeze(entries),
    excludedCount: projected.excludedCount,
    nonAuthorization: NON_AUTHORIZATION,
  });
}

/**
 * Render helper for operator/product surfaces: the display lines of one
 * projection, each suffixed with the non-authorization disclaimer so a
 * leaderboard can never be RENDERED as a trust/authorization score.
 */
export function renderRoleLeaderboard(projection: RoleLeaderboardProjection): readonly string[] {
  const lines = projection.entries.map(
    (entry) =>
      `#${entry.rank} ${entry.actor} — ${entry.points} pts (${entry.contributionCount} contributions)${entry.tier !== undefined ? ` [${entry.tier}]` : ''}`,
  );
  return Object.freeze([...lines, projection.nonAuthorization.disclaimer]);
}
