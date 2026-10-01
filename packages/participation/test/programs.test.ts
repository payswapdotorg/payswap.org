import { describe, expect, it } from 'vitest';
import { asPartyId } from '@payswap/protocol';
import {
  asIncentiveProgramId,
  ProgramEpochViolationError,
  ProgramVersionRegistry,
  UnknownProgramError,
  type IncentiveProgramDraft,
  type IncentiveProgramVersion,
  type ProgramRevision,
} from '../src/programs.js';
import { usd } from './helpers.js';

const PROGRAM_ID = asIncentiveProgramId('prog_gh_adoption');

function draftFixture(overrides?: Partial<IncentiveProgramDraft>): IncentiveProgramDraft {
  return {
    programId: PROGRAM_ID,
    effectiveFrom: 1_000n,
    sponsor: asPartyId('sponsor-1'),
    objective: 'raise verified first-time A2A adoption',
    eligibleRole: 'SENDER',
    eligibilityRules: [{ kind: 'MIN_PROOF_LEVEL', level: 'P1' }],
    contributionEvents: ['PAYMENT_METHOD_ADOPTED'],
    proofRequirements: { minProofLevel: 'P1' },
    reward: {
      mechanism: 'FEE_REBATE',
      formula: { kind: 'FIXED_PER_CONTRIBUTION', amount: usd(500n) },
    },
    budget: { totalAmount: usd(10_000n), funding: 'REQUIRES_FUNDED_RESERVATION' },
    antiGamingPolicy: {
      forbidSelfReferral: true,
      requireIdentityLinkageChecks: true,
      velocity: { maxContributions: 5n, windowMs: 600_000n },
    },
    clawbackPolicy: { clawbackWindowMs: 2_592_000_000n, requiresDisputeRecord: true },
    privacyRules: ['no identity disclosure in public read models'],
    ...overrides,
  };
}

function revisionFrom(
  version: IncentiveProgramVersion,
  effectiveFrom: bigint,
  overrides?: Partial<ProgramRevision>,
): ProgramRevision {
  const { status, ...rest } = overrides ?? {};
  return {
    programId: version.programId,
    effectiveFrom,
    status: status ?? version.status,
    sponsor: version.sponsor,
    objective: version.objective,
    eligibleRole: version.eligibleRole,
    eligibilityRules: version.eligibilityRules,
    contributionEvents: version.contributionEvents,
    proofRequirements: version.proofRequirements,
    reward: version.reward,
    budget: version.budget,
    antiGamingPolicy: version.antiGamingPolicy,
    clawbackPolicy: version.clawbackPolicy,
    privacyRules: version.privacyRules,
    ...rest,
  };
}

describe('programs: IncentiveProgram versioning (INV-P07)', () => {
  it('registers version 1 and revises into strictly later effective epochs', () => {
    const registry = new ProgramVersionRegistry();
    const v1 = registry.registerProgram(draftFixture(), 'ACTIVE');
    expect(v1.version).toBe(1n);
    expect(v1.status).toBe('ACTIVE');
    expect(v1.effectiveFrom).toBe(1_000n);
    expect(v1.supersedesVersion).toBeUndefined();
    expect(Object.isFrozen(v1)).toBe(true);

    const v2 = registry.reviseProgram(
      revisionFrom(v1, 5_000n, {
        reward: {
          mechanism: 'FEE_REBATE',
          formula: { kind: 'FIXED_PER_CONTRIBUTION', amount: usd(750n) },
        },
      }),
    );
    expect(v2.version).toBe(2n);
    expect(v2.supersedesVersion).toBe(1n);
    expect(v2.effectiveFrom).toBe(5_000n);
    expect(v2.reward.formula).toEqual({
      kind: 'FIXED_PER_CONTRIBUTION',
      amount: usd(750n),
    });
    // Epochs strictly advance across the whole history.
    const history = registry.history(v1.programId);
    expect(history.map((version) => version.effectiveFrom)).toEqual([1_000n, 5_000n]);
  });

  it('INV-P07: old versions stay immutable and retrievable after a revision', () => {
    const registry = new ProgramVersionRegistry();
    const v1 = registry.registerProgram(draftFixture(), 'ACTIVE');
    const v1Digest = v1.specDigest;
    const v1Amount = v1.reward.formula.kind === 'FIXED_PER_CONTRIBUTION' ? v1.reward.formula.amount : usd(0n);

    registry.reviseProgram(
      revisionFrom(v1, 9_000n, {
        reward: {
          mechanism: 'FEE_REBATE',
          formula: { kind: 'FIXED_PER_CONTRIBUTION', amount: usd(2_000n) },
        },
      }),
    );

    // The OLD version object is untouched and still addressable.
    const storedV1 = registry.version(v1.programId, 1n);
    expect(storedV1).toBe(v1);
    expect(storedV1.reward.formula).toEqual({
      kind: 'FIXED_PER_CONTRIBUTION',
      amount: v1Amount,
    });
    expect(storedV1.specDigest).toBe(v1Digest);
    expect(() => {
      // Frozen objects refuse silent rewrites — program history is immutable.
      (storedV1 as unknown as { objective: string }).objective = 'rewritten';
    }).toThrow();
  });

  it('INV-P07: a revision that does not advance the epoch is rejected', () => {
    const registry = new ProgramVersionRegistry();
    const v1 = registry.registerProgram(draftFixture(), 'ACTIVE');
    expect(() => registry.reviseProgram(revisionFrom(v1, 1_000n))).toThrow(
      ProgramEpochViolationError,
    );
    expect(() => registry.reviseProgram(revisionFrom(v1, 999n))).toThrow(
      ProgramEpochViolationError,
    );
    // Nothing was appended by the failed revisions.
    expect(registry.history(v1.programId)).toHaveLength(1);
  });

  it('emergency pause / resume / retire each create NEW versions (epochs preserved)', () => {
    const registry = new ProgramVersionRegistry();
    registry.registerProgram(draftFixture(), 'ACTIVE');
    const paused = registry.pauseProgram(PROGRAM_ID, 20_000n);
    expect(paused.status).toBe('PAUSED');
    expect(paused.version).toBe(2n);
    const resumed = registry.resumeProgram(paused.programId, 30_000n);
    expect(resumed.status).toBe('ACTIVE');
    expect(resumed.version).toBe(3n);
    const retired = registry.retireProgram(paused.programId, 40_000n);
    expect(retired.status).toBe('RETIRED');
    expect(retired.version).toBe(4n);
    const history = registry.history(paused.programId);
    expect(history.map((version) => version.status)).toEqual([
      'ACTIVE',
      'PAUSED',
      'ACTIVE',
      'RETIRED',
    ]);
    expect(history.map((version) => version.effectiveFrom)).toEqual([
      1_000n,
      20_000n,
      30_000n,
      40_000n,
    ]);
    // Pause at a non-advancing epoch is refused.
    expect(() => registry.pauseProgram(paused.programId, 40_000n)).toThrow(
      ProgramEpochViolationError,
    );
  });

  it('resolves the version effective at a given time', () => {
    const registry = new ProgramVersionRegistry();
    registry.registerProgram(draftFixture(), 'ACTIVE');
    registry.reviseProgram(revisionFrom(registry.latest(PROGRAM_ID), 5_000n));
    expect(registry.effectiveAt(PROGRAM_ID, 999n)).toBeUndefined();
    expect(registry.effectiveAt(PROGRAM_ID, 1_000n)?.version).toBe(1n);
    expect(registry.effectiveAt(PROGRAM_ID, 4_999n)?.version).toBe(1n);
    expect(registry.effectiveAt(PROGRAM_ID, 5_000n)?.version).toBe(2n);
    expect(registry.effectiveAt(PROGRAM_ID, 50_000n)?.version).toBe(2n);
  });

  it('rejects unknown programs and malformed drafts', () => {
    const registry = new ProgramVersionRegistry();
    expect(() => registry.latest(asIncentiveProgramId('nope'))).toThrow(UnknownProgramError);
    expect(() => registry.registerProgram(draftFixture({ objective: '' }))).toThrow();
    expect(() =>
      registry.registerProgram(
        draftFixture({
          contributionEvents: [],
        }),
      ),
    ).toThrow();
    expect(() =>
      registry.registerProgram(
        draftFixture({
          reward: {
            mechanism: 'FEE_REBATE',
            formula: { kind: 'PROPORTIONAL_OF_VALUE', basisPoints: 0n },
          },
        }),
      ),
    ).toThrow();
    // A single maximum award above the budget total is refused up front.
    expect(() =>
      registry.registerProgram(
        draftFixture({
          reward: {
            mechanism: 'FEE_REBATE',
            formula: { kind: 'FIXED_PER_CONTRIBUTION', amount: usd(20_000n) },
          },
        }),
      ),
    ).toThrow(/exceeds the program budget total/);
    // Tiers must ascend.
    expect(() =>
      registry.registerProgram(
        draftFixture({
          reward: {
            mechanism: 'THRESHOLD_BONUS',
            formula: {
              kind: 'TIERED_THRESHOLD',
              tiers: [
                { atLeast: 10n, amount: usd(100n) },
                { atLeast: 5n, amount: usd(50n) },
              ],
            },
          },
        }),
      ),
    ).toThrow(/ascending/);
  });

  it('version spec digests change exactly when the specification changes', () => {
    const registry = new ProgramVersionRegistry();
    const v1 = registry.registerProgram(draftFixture(), 'ACTIVE');
    // Same spec, later epoch → new version, different digest (epoch + version
    // are digest inputs) but the SAME formula semantics.
    const v2 = registry.reviseProgram(revisionFrom(v1, 7_000n));
    expect(v2.specDigest).not.toBe(v1.specDigest);
    // A formula change also changes the digest.
    const v3 = registry.reviseProgram(
      revisionFrom(v2, 8_000n, {
        reward: {
          mechanism: 'FEE_REBATE',
          formula: { kind: 'FIXED_PER_CONTRIBUTION', amount: usd(600n) },
        },
      }),
    );
    expect(v3.specDigest).not.toBe(v2.specDigest);
    // Reproducing v1's exact spec at a later epoch reproduces its formula
    // fields verbatim — history is never rewritten, only appended.
    expect(registry.version(v1.programId, 1n).objective).toBe(v1.objective);
  });
});
