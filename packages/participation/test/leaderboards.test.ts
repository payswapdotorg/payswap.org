import { describe, expect, it } from 'vitest';
import {
  asPartyId,
  createIdFactory,
  DeterministicClock,
  type Money,
  type ObligationId,
  type PartyId,
  type Reservation,
  type ReservationId,
} from '@payswap/protocol';
import {
  defineLeaderboard,
  projectLeaderboard,
  RawActivityMetricRejectedError,
  recognitionTierFor,
  asLeaderboardPoints,
  type LeaderboardDefinition,
  type LeaderboardProjection,
} from '../src/leaderboards.js';
import type { ContributionRecord } from '../src/contributions.js';
import { T0, contribution } from './helpers.js';

function ids() {
  return createIdFactory(new DeterministicClock(1_000n));
}

function leaderboardFixture(overrides?: Record<string, unknown>): LeaderboardDefinition {
  return defineLeaderboard(
    {
      scope: 'gh-corridor/verified-adoption',
      actorRole: 'SENDER',
      metric: {
        kind: 'QUALITY_WEIGHTED_UNITS',
        qualityWeights: { VERIFIED_COMPLETED: 2n, OBSERVED: 1n, REJECTED: 0n },
      },
      period: { from: T0 - 100n, to: T0 + 1_000_000n },
      eligibility: [
        { kind: 'MIN_PROOF_LEVEL', level: 'P2' },
        { kind: 'EXCLUDE_OUTCOME', outcome: 'REJECTED' },
      ],
      freshness: { computedAt: T0 + 2_000_000n, sourceCutoff: T0 + 1_000_000n },
      evidenceStrength: 'P2',
      tieRule: 'EARLIEST_FIRST',
      antiGamingStatus: 'ENFORCED',
      includedBehaviors: ['PAYMENT_METHOD_ADOPTED'],
      tiers: [
        { name: 'bronze', minPoints: asLeaderboardPoints(2n) },
        { name: 'silver', minPoints: asLeaderboardPoints(6n) },
        { name: 'gold', minPoints: asLeaderboardPoints(10n) },
      ],
      ...overrides,
    },
    { ids: ids() },
  );
}

const ALICE = asPartyId('sender-alice');
const BOB = asPartyId('sender-bob');
const CAROL = asPartyId('sender-carol');

function records(): readonly ContributionRecord[] {
  return [
    // Alice: two verified adoptions (2 × 2 points each = 4).
    contribution({ id: 'a1', actor: ALICE, occurredAt: T0 }),
    contribution({ id: 'a2', actor: ALICE, occurredAt: T0 + 100n }),
    // Bob: three verified adoptions (6 points) — first contribution EARLIER
    // than alice's, but points rank first anyway.
    contribution({ id: 'b1', actor: BOB, occurredAt: T0 - 50n }),
    contribution({ id: 'b2', actor: BOB, occurredAt: T0 + 150n }),
    contribution({ id: 'b3', actor: BOB, occurredAt: T0 + 200n, outcome: 'OBSERVED' }),
    // Carol: one verified adoption outside the period → excluded.
    contribution({ id: 'c1', actor: CAROL, occurredAt: T0 + 2_000_000n }),
    // A REJECTED adoption by alice: excluded AND zero-weighted by construction.
    contribution({ id: 'a3', actor: ALICE, outcome: 'REJECTED' }),
    // A P0-evidence adoption by carol inside the period: fails the proof gate.
    contribution({ id: 'c2', actor: CAROL, occurredAt: T0 + 10n, evidenceLevel: 'P0' }),
  ];
}

describe('leaderboards: projections over contributions (W3-004 §8)', () => {
  it('defines a leaderboard with every §Leaderboards declaration present', () => {
    const definition = leaderboardFixture();
    expect(definition.scope).toBe('gh-corridor/verified-adoption');
    expect(definition.actorRole).toBe('SENDER');
    expect(definition.tieRule).toBe('EARLIEST_FIRST');
    expect(definition.antiGamingStatus).toBe('ENFORCED');
    expect(definition.evidenceStrength).toBe('P2');
    expect(definition.tiers?.map((tier) => tier.name)).toEqual(['bronze', 'silver', 'gold']);
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it('REJECTS raw-activity metrics (no rewarding cheaply fabricable activity)', () => {
    expect(() =>
      leaderboardFixture({
        metric: {
          kind: 'RAW_ACTIVITY_COUNT',
          qualityWeights: { VERIFIED_COMPLETED: 1n, OBSERVED: 1n, REJECTED: 0n },
        },
      }),
    ).toThrow(RawActivityMetricRejectedError);
  });

  it('rejects REJECTED-positive weights and unenforced anti-gaming without proof gates', () => {
    expect(() =>
      leaderboardFixture({
        metric: {
          kind: 'QUALITY_WEIGHTED_UNITS',
          qualityWeights: { VERIFIED_COMPLETED: 2n, OBSERVED: 1n, REJECTED: 5n },
        },
      }),
    ).toThrow(/REJECTED/);
    expect(() =>
      leaderboardFixture({
        eligibility: [],
        antiGamingStatus: 'ENFORCED',
      }),
    ).toThrow(/MIN_PROOF_LEVEL/);
  });

  it('projects deterministically: quality-weighted points, ranked, tiered, exclusions counted', () => {
    const definition = leaderboardFixture();
    const first = projectLeaderboard(definition, records());
    const second = projectLeaderboard(definition, records());

    expect(second).toEqual(first); // pure read model — identical projection
    expect(first.entries.map((entry) => entry.actor)).toEqual([BOB, ALICE]);
    expect(first.entries[0]?.points).toBe(5n); // bob: 2+2 verified + 1 observed
    expect(first.entries[1]?.points).toBe(4n); // alice: 2+2 (rejected excluded)
    expect(first.entries[0]?.rank).toBe(1);
    expect(first.entries[1]?.rank).toBe(2);
    expect(first.entries[0]?.contributionCount).toBe(3n);
    expect(first.entries[0]?.tier).toBe('bronze'); // 5 points: bronze (silver starts at 6)
    expect(first.entries[1]?.tier).toBe('bronze'); // 4 points ≥ bronze(2)
    // Carol excluded: out-of-period + insufficient proof; a3 excluded (REJECTED).
    expect(first.entries.map((entry) => entry.actor)).not.toContain(CAROL);
    expect(first.excludedCount).toBe(3n); // c1 (period), a3 (outcome), c2 (proof)
  });

  it('breaks ties by the declared rule and supports SHARED_RANK', () => {
    const tieRecords = [
      contribution({ id: 'a1', actor: ALICE, occurredAt: T0 + 500n }),
      contribution({ id: 'b1', actor: BOB, occurredAt: T0 + 100n }),
    ];
    const earliest = projectLeaderboard(
      leaderboardFixture({ tieRule: 'EARLIEST_FIRST' }),
      tieRecords,
    );
    // Equal points (2 each): bob contributed earlier → bob ranks first.
    expect(earliest.entries.map((entry) => entry.actor)).toEqual([BOB, ALICE]);
    expect(earliest.entries.map((entry) => entry.rank)).toEqual([1, 2]);

    const shared = projectLeaderboard(leaderboardFixture({ tieRule: 'SHARED_RANK' }), tieRecords);
    expect(shared.entries.map((entry) => entry.rank)).toEqual([1, 1]);
  });

  it('assigns recognition tiers deterministically (projections, never authority)', () => {
    const tiers = leaderboardFixture().tiers ?? [];
    expect(recognitionTierFor(asLeaderboardPoints(1n), tiers)).toBeUndefined();
    expect(recognitionTierFor(asLeaderboardPoints(2n), tiers)).toBe('bronze');
    expect(recognitionTierFor(asLeaderboardPoints(9n), tiers)).toBe('silver');
    expect(recognitionTierFor(asLeaderboardPoints(10n), tiers)).toBe('gold');
    expect(recognitionTierFor(asLeaderboardPoints(999n), tiers)).toBe('gold');
  });

  it('carries the projection marker on every artifact (INV-P05 runtime surface)', () => {
    const projection: LeaderboardProjection = projectLeaderboard(leaderboardFixture(), records());
    expect(projection.__projection).toBe('LEADERBOARD_PROJECTION');
    for (const entry of projection.entries) {
      expect(entry.__projection).toBe('LEADERBOARD_PROJECTION');
    }
  });
});

/**
 * INV-P05 compile-time separation: leaderboard artifacts must NEVER be
 * assignable to protocol authorization/party/obligation/reservation types.
 * Each `@ts-expect-error` below FAILS the `npx tsc --noEmit` gate if anyone
 * weakens the branding (an unused @ts-expect-error is itself an error).
 */
describe('leaderboards: type-level separation from authorization (INV-P05)', () => {
  it('compiles the separation assertions', () => {
    const projection = projectLeaderboard(leaderboardFixture(), records());
    const entry = projection.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return;
    }
    const points = entry.points;
    const rank = entry.rank;

    // @ts-expect-error INV-P05: points must never be a PartyId (authorization party)
    const asParty: PartyId = points;
    // @ts-expect-error INV-P05: points must never be an ObligationId (payment authority)
    const asObligation: ObligationId = points;
    // @ts-expect-error INV-P05: rank must never be a ReservationId (funds authority)
    const asReservation: ReservationId = rank;
    // @ts-expect-error INV-P05: a leaderboard entry must never be Money (economic value)
    const asMoney: Money = entry;
    // @ts-expect-error INV-P05: a leaderboard entry must never be a Reservation (funds hold)
    const asHold: Reservation = entry;

    expect([asParty, asObligation, asReservation, asMoney, asHold]).toBeDefined();
  });

  it('is a frozen, method-free projection (nothing that could authorize)', () => {
    const projection = projectLeaderboard(leaderboardFixture(), records());
    expect(Object.isFrozen(projection)).toBe(true);
    for (const entry of projection.entries) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(typeof entry.points).toBe('bigint');
      expect(typeof entry.actor).toBe('string');
    }
    // No projection artifact exposes any protocol id of its own.
    const ownProtocolIds = projection.entries.filter(
      (entry) => entry.evidenceRefs.every((locator) => !locator.startsWith('OBL:')),
    );
    expect(ownProtocolIds).toHaveLength(projection.entries.length);
  });
});
