import { describe, expect, it } from 'vitest';
import { DeterministicClock, createIdFactory, fromMinorUnits, USD, type IdFactory } from '@payswap/protocol';
import type { Money } from '@payswap/protocol';
import { asLeaderboardPoints } from '@payswap/participation';
import {
  consumesAuthorization,
  defineRoleLeaderboard,
  LEADERBOARD_ROLE_CLASSES,
  NON_AUTHORIZATION,
  projectRoleLeaderboard,
  renderRoleLeaderboard,
  RoleClassRejectedError,
  type RoleLeaderboard,
  type RoleLeaderboardEntry,
  type RoleLeaderboardProjection,
} from '../src/leaderboards.js';
import type { AuthorizationArtifact } from '../src/leaderboards.js';
import { contribution, T0 } from './helpers.js';

function ids(): IdFactory {
  return createIdFactory(new DeterministicClock(T0));
}

function leaderboardFixture(): RoleLeaderboard {
  return defineRoleLeaderboard(
    {
      role: 'SENDER',
      scope: 'network:senders:2026-Q4',
      metric: {
        kind: 'QUALITY_WEIGHTED_UNITS',
        qualityWeights: { VERIFIED_COMPLETED: 3n, OBSERVED: 1n, REJECTED: 0n },
      },
      period: { from: T0, to: T0 + 1_000_000n },
      eligibility: [{ kind: 'MIN_PROOF_LEVEL', level: 'P1' }],
      freshness: { computedAt: T0 + 500n, sourceCutoff: T0 + 400n },
      evidenceStrength: 'P2',
      tieRule: 'EARLIEST_FIRST',
      includedBehaviors: ['PAYMENT_METHOD_ADOPTED'],
      tiers: [
        { name: 'bronze', minPoints: asLeaderboardPoints(3n) },
        { name: 'silver', minPoints: asLeaderboardPoints(6n) },
      ],
    },
    { ids: ids() },
  );
}

describe('role leaderboards: definitions', () => {
  it('accepts every declared role class and pins the actor role', () => {
    for (const role of LEADERBOARD_ROLE_CLASSES) {
      const board = defineRoleLeaderboard(
        {
          role,
          scope: `scope:${role}`,
          metric: {
            kind: 'QUALITY_WEIGHTED_UNITS',
            qualityWeights: { VERIFIED_COMPLETED: 1n, OBSERVED: 1n, REJECTED: 0n },
          },
          period: { from: T0, to: T0 + 1_000n },
          eligibility: [{ kind: 'MIN_PROOF_LEVEL', level: 'P1' }],
          freshness: { computedAt: T0 + 100n, sourceCutoff: T0 },
          evidenceStrength: 'P1',
          tieRule: 'LOWEST_ACTOR_ID',
          includedBehaviors: ['PAYMENT_METHOD_ADOPTED'],
        },
        { ids: ids() },
      );
      expect(board.role).toBe(role);
      expect(board.definition.actorRole).toBe(role);
      expect(board.definition.antiGamingStatus).toBe('ENFORCED');
    }
  });

  it('rejects role classes outside the declared set', () => {
    expect(() =>
      defineRoleLeaderboard(
        {
          role: 'OPERATOR' as never,
          scope: 'scope:x',
          metric: {
            kind: 'QUALITY_WEIGHTED_UNITS',
            qualityWeights: { VERIFIED_COMPLETED: 1n, OBSERVED: 1n, REJECTED: 0n },
          },
          period: { from: T0, to: T0 + 1n },
          freshness: { computedAt: T0, sourceCutoff: T0 },
          evidenceStrength: 'P0',
          tieRule: 'EARLIEST_FIRST',
          includedBehaviors: ['ANY'],
        },
        { ids: ids() },
      ),
    ).toThrow(RoleClassRejectedError);
  });

  it('rejects raw-activity metrics loudly (useful outcomes only)', () => {
    expect(() =>
      defineRoleLeaderboard(
        {
          role: 'MERCHANT',
          scope: 'scope:x',
          metric: {
            kind: 'RAW_ACTIVITY_COUNT',
            qualityWeights: { VERIFIED_COMPLETED: 1n, OBSERVED: 1n, REJECTED: 0n },
          },
          period: { from: T0, to: T0 + 1n },
          freshness: { computedAt: T0, sourceCutoff: T0 },
          evidenceStrength: 'P0',
          tieRule: 'EARLIEST_FIRST',
          includedBehaviors: ['ANY'],
        },
        { ids: ids() },
      ),
    ).toThrow(/RAW_ACTIVITY_COUNT/);
  });
});

describe('role leaderboards: projections over contribution records', () => {
  it('projects role-scoped rankings deterministically', () => {
    const board = leaderboardFixture();
    const records = [
      contribution({ id: 'c1', actor: 'sender-alice' }),
      contribution({ id: 'c2', actor: 'sender-alice' }),
      contribution({ id: 'c3', actor: 'sender-bob' }),
      // Different role → excluded from a SENDER leaderboard.
      contribution({ id: 'c4', actor: 'merchant-x', actorRole: 'MERCHANT' }),
      // Weaker evidence → excluded by the P1 eligibility gate.
      contribution({ id: 'c5', actor: 'sender-weak', evidenceLevel: 'P0' }),
    ];
    const projection = projectRoleLeaderboard(board, records);
    expect(projection.role).toBe('SENDER');
    expect(projection.entries.length).toBe(2);
    const alice = projection.entries.find((entry) => entry.actor === 'sender-alice');
    const bob = projection.entries.find((entry) => entry.actor === 'sender-bob');
    expect(alice?.points).toBe(6n);
    expect(alice?.rank).toBe(1);
    expect(alice?.tier).toBe('silver');
    expect(bob?.points).toBe(3n);
    expect(bob?.rank).toBe(2);
    expect(bob?.tier).toBe('bronze');
    // c4 (wrong role) and c5 (weak evidence) are excluded.
    expect(projection.excludedCount).toBe(2n);
    // Deterministic: same definition + records → identical projection.
    expect(projectRoleLeaderboard(board, records)).toEqual(projection);
  });
});

describe('role leaderboards: NEVER authorization or universal trust (INV-P05)', () => {
  it('every projection and entry carries the non-authorization marker', () => {
    const board = leaderboardFixture();
    const projection = projectRoleLeaderboard(board, [contribution({ id: 'c1', actor: 'sender-alice' })]);
    expect(projection.__projection).toBe('ROLE_LEADERBOARD_PROJECTION');
    expect(projection.nonAuthorization.marker).toBe('NOT_AUTHORIZATION');
    expect(projection.nonAuthorization.disclaimer).toMatch(/NOT a trust score/i);
    for (const entry of projection.entries) {
      expect(entry.__projection).toBe('ROLE_LEADERBOARD_PROJECTION');
      expect(entry.nonAuthorization).toBe(NON_AUTHORIZATION);
    }
  });

  it('the rendered surface always carries the disclaimer', () => {
    const board = leaderboardFixture();
    const projection = projectRoleLeaderboard(board, [contribution({ id: 'c1', actor: 'sender-alice' })]);
    const lines = renderRoleLeaderboard(projection);
    expect(lines[0]).toMatch(/^#1 sender-alice — 3 pts/);
    expect(lines[lines.length - 1]).toMatch(/INV-P05/);
  });

  it('COMPILE-TIME PROOF: projections/entries/points/ranks cannot be passed where authorization is required', () => {
    const board = leaderboardFixture();
    const projection: RoleLeaderboardProjection = projectRoleLeaderboard(
      board,
      [contribution({ id: 'c1', actor: 'sender-alice' })],
    );
    const entry: RoleLeaderboardEntry | undefined = projection.entries[0];
    const points = entry?.points;
    const rank = entry?.rank;
    const artifact: AuthorizationArtifact = { __authorization: 'never' } as never;

    // A real authorization artifact IS accepted by the type system (the call
    // throws at runtime because consumption is nominal-only — that is the
    // stand-in's contract).
    expect(() => consumesAuthorization(artifact)).toThrow(/nominal/);

    // …while every leaderboard artifact is REFUSED at compile time. Each of
    // the following @ts-expect-error lines fails the tsc gate if anyone ever
    // weakens the nominal branding (INV-P05).
    // @ts-expect-error — a projection is not an authorization artifact
    expect(() => consumesAuthorization(projection)).toThrow();
    // @ts-expect-error — an entry is not an authorization artifact
    expect(() => consumesAuthorization(entry)).toThrow();
    // @ts-expect-error — points are not an authorization artifact
    expect(() => consumesAuthorization(points)).toThrow();
    // @ts-expect-error — a rank is not an authorization artifact
    expect(() => consumesAuthorization(rank)).toThrow();
    // @ts-expect-error — the non-authorization marker is not authorization either
    expect(() => consumesAuthorization(NON_AUTHORIZATION)).toThrow();

    // Points are not Money and cannot pay for anything (INV-F01 separation).
    const money: Money = fromMinorUnits(USD, 1n);
    // @ts-expect-error — leaderboard points are structurally incompatible with Money
    const asMoney: Money = points;
    expect(asMoney).not.toBe(money);
    expect(points).not.toBe(money);
  });
});
