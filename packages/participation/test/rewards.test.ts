import { describe, expect, it } from 'vitest';
import { asPartyId } from '@payswap/protocol';
import {
  accrueReward,
  AntiGamingGateError,
  asRewardAccrualId,
  claimReward,
  clawBackReward,
  computeRewardAmount,
  disputeReward,
  expireReward,
  finalizeReward,
  InMemoryRewardBook,
  qualifyReward,
  recomputeReward,
  resolveRewardDispute,
  rewardKindFor,
  RewardCapExceededError,
  obligationsOf,
  UnfundedRewardFinalizationError,
  type RewardAccrual,
  type RewardServiceDeps,
} from '../src/rewards.js';
import {
  asIncentiveProgramId,
  ProgramVersionRegistry,
  type IncentiveProgramDraft,
  type IncentiveProgramVersion,
} from '../src/programs.js';
import { runAntiGamingChecks, type AntiGamingReport } from '../src/anti-gaming.js';
import { ContributionLedger, type ContributionRecord } from '../src/contributions.js';
import { contribution, fixture, usd } from './helpers.js';

const SETTLE_WINDOW = { settlementWindowMs: 360_000n };

function programFixture(overrides?: Partial<IncentiveProgramDraft>): IncentiveProgramVersion {
  const registry = new ProgramVersionRegistry();
  return registry.registerProgram(
    {
      effectiveFrom: 1_000n,
      sponsor: asPartyId('sponsor-1'),
      objective: 'raise verified first-time adoption',
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
        velocity: { maxContributions: 100n, windowMs: 600_000n },
      },
      clawbackPolicy: { clawbackWindowMs: 2_592_000_000n, requiresDisputeRecord: false },
      ...overrides,
    },
    'ACTIVE',
  );
}

function passReport(): AntiGamingReport {
  return runAntiGamingChecks(
    { forbidSelfReferral: true, requireIdentityLinkageChecks: true },
    {
      contribution: contribution({ id: 'c1', actor: 'sender-alice' }),
      history: [],
      identityLinks: [],
      declaredSurfaces: [],
      now: 1_000_000n,
    },
  );
}

function flagReport(): AntiGamingReport {
  return runAntiGamingChecks(
    { forbidSelfReferral: true, requireIdentityLinkageChecks: true, velocity: { maxContributions: 1n, windowMs: 600_000n } },
    {
      contribution: contribution({ id: 'c1', actor: 'sender-alice' }),
      history: [contribution({ id: 'h0', actor: 'sender-alice' })],
      identityLinks: [],
      declaredSurfaces: [],
      now: 1_000_000n,
    },
  );
}

function fundedDeps(balance = 50_000n): { deps: RewardServiceDeps; fx: ReturnType<typeof fixture> } {
  const fx = fixture(balance);
  return {
    fx,
    deps: {
      ids: fx.ids,
      clock: fx.clock,
      rewards: new InMemoryRewardBook(),
      budgets: fx.budgets,
      obligations: fx.obligations,
    },
  };
}

describe('rewards: accrual is reproducible from evidence + program version (INV-P03)', () => {
  it('computes FIXED_PER_CONTRIBUTION rewards deterministically', () => {
    const program = programFixture();
    const record = contribution({ id: 'c1', actor: 'sender-alice' });
    const first = computeRewardAmount(program, record, 'WITHIN_BAND');
    const second = computeRewardAmount(program, record, 'WITHIN_BAND');
    expect(first.amount.value).toBe(500n);
    expect(second.amount).toEqual(first.amount);
    expect(second.formulaDigest).toBe(first.formulaDigest);

    const verified = recomputeReward(program, record, 'WITHIN_BAND', {
      ...emptyAccrual(),
      amount: first.amount,
      formulaDigest: first.formulaDigest,
    });
    expect(verified.reproducible).toBe(true);
  });

  it('computes PROPORTIONAL_OF_VALUE rewards with exact bigint truncation', () => {
    const program = programFixture({
      reward: {
        mechanism: 'FEE_REBATE',
        formula: { kind: 'PROPORTIONAL_OF_VALUE', basisPoints: 250n, cap: usd(10_000n) },
      },
    });
    // 2.5% of 123_456 minor units = 3_086.4 → truncated to 3_086 (documented).
    const record = contribution({ id: 'c1', actor: 'sender-alice', value: usd(123_456n) });
    const { amount } = computeRewardAmount(program, record, 'WITHIN_BAND');
    expect(amount.value).toBe(3_086n);

    // The cap binds above it.
    const capped = computeRewardAmount(
      program,
      contribution({ id: 'c2', actor: 'sender-alice', value: usd(1_000_000n) }),
      'WITHIN_BAND',
    );
    expect(capped.amount.value).toBe(10_000n);

    expect(() =>
      computeRewardAmount(
        program,
        contribution({ id: 'c3', actor: 'sender-alice' }),
        'WITHIN_BAND',
      ),
    ).toThrow(/carry an economic value/);
  });

  it('computes TIERED_THRESHOLD and COMPLETION_BOUNTY formulas', () => {
    const tiered = programFixture({
      reward: {
        mechanism: 'THRESHOLD_BONUS',
        formula: {
          kind: 'TIERED_THRESHOLD',
          tiers: [
            { atLeast: 1n, amount: usd(100n) },
            { atLeast: 5n, amount: usd(400n) },
            { atLeast: 25n, amount: usd(1_500n) },
          ],
        },
      },
    });
    expect(
      computeRewardAmount(tiered, contribution({ id: 'c1', actor: 'a', quantity: 3n }), 'WITHIN_BAND').amount.value,
    ).toBe(100n);
    expect(
      computeRewardAmount(tiered, contribution({ id: 'c2', actor: 'a', quantity: 7n }), 'WITHIN_BAND').amount.value,
    ).toBe(400n);
    expect(
      computeRewardAmount(tiered, contribution({ id: 'c3', actor: 'a', quantity: 100n }), 'WITHIN_BAND').amount.value,
    ).toBe(1_500n);

    const bounty = programFixture({
      reward: {
        mechanism: 'COMPLETION_BOUNTY',
        formula: { kind: 'COMPLETION_BOUNTY', amount: usd(2_000n) },
      },
    });
    expect(
      computeRewardAmount(bounty, contribution({ id: 'c4', actor: 'a' }), 'WITHIN_BAND').amount.value,
    ).toBe(2_000n);
    expect(() =>
      computeRewardAmount(
        bounty,
        contribution({ id: 'c5', actor: 'a', outcome: 'OBSERVED' }),
        'WITHIN_BAND',
      ),
    ).toThrow(/VERIFIED_COMPLETED/);
  });

  it('applies declared emission boost/taper multipliers (dynamic incentives)', () => {
    const program = programFixture({
      emission: {
        belowTargetMultiplierBps: 15_000n,
        withinBandMultiplierBps: 10_000n,
        aboveTargetMultiplierBps: 4_000n,
      },
    });
    const record = contribution({ id: 'c1', actor: 'sender-alice' });
    expect(computeRewardAmount(program, record, 'BELOW_TARGET').amount.value).toBe(750n);
    expect(computeRewardAmount(program, record, 'WITHIN_BAND').amount.value).toBe(500n);
    expect(computeRewardAmount(program, record, 'ABOVE_TARGET').amount.value).toBe(200n);
  });

  it('INV-P03: identical inputs in two fresh stores produce identical accruals', () => {
    const program = programFixture();
    const record = contribution({ id: 'c1', actor: 'sender-alice' });
    const first = fundedDeps();
    const second = fundedDeps();
    first.fx.budgets.establishFundedBudget(program);
    second.fx.budgets.establishFundedBudget(program);

    const accrualA = accrueReward(first.deps, program, record);
    const accrualB = accrueReward(second.deps, program, record);
    expect(accrualA.amount.value).toBe(accrualB.amount.value);
    expect(accrualA.formulaDigest).toBe(accrualB.formulaDigest);
    expect(accrualA.programSpecDigest).toBe(program.specDigest);
    // Deterministic ids: same clock seed + same call order → same minted id.
    expect(accrualA.id).toBe(accrualB.id);
  });

  it('rejects accruals outside the program scope (behavior, version, proof)', () => {
    const program = programFixture();
    const { deps } = fundedDeps();
    expect(() =>
      accrueReward(deps, program, contribution({ id: 'c1', actor: 'a', behavior: 'UNRELATED' })),
    ).toThrow(/declared contribution event/);
    expect(() =>
      accrueReward(deps, program, contribution({ id: 'c2', actor: 'a', evidenceLevel: 'P0' })),
    ).toThrow(/minimum proof level/);
  });
});

describe('rewards: funded-or-contingent finalization (INV-P01)', () => {
  it('accrues provisionally under a contingent budget but REFUSES finalization', () => {
    const program = programFixture({ budget: { totalAmount: usd(10_000n), funding: 'EXPLICITLY_CONTINGENT' } });
    const { deps, fx } = fundedDeps();
    fx.budgets.declareContingentBudget(program);
    const record = contribution({ id: 'c1', actor: 'sender-alice' });

    const accrual = accrueReward(deps, program, record);
    expect(accrual.state).toBe('PROVISIONAL');
    expect(accrual.kind).toBe('MONETARY');
    // Provisional promises still consume budget headroom (visible contingency).
    expect(fx.budgets.get(program.programId, program.version).committed.value).toBe(500n);

    // INV-P01: an unfunded monetary reward can NEVER become final.
    expect(() => finalizeReward(deps, program, accrual.id, passReport())).toThrow(
      UnfundedRewardFinalizationError,
    );
    expect(deps.rewards.get(accrual.id)?.state).toBe('PROVISIONAL');

    // Funding the contingency later unblocks finalization.
    fx.budgets.fundContingentBudget({ programId: program.programId, version: program.version });
    const finalized = finalizeReward(deps, program, accrual.id, passReport());
    expect(finalized.state).toBe('CONFIRMED');
  });

  it('finalizes funded rewards after the anti-gaming gate passes', () => {
    const program = programFixture();
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(program);
    const accrual = accrueReward(deps, program, contribution({ id: 'c1', actor: 'sender-alice' }));
    const finalized = finalizeReward(deps, program, accrual.id, passReport());
    expect(finalized.state).toBe('CONFIRMED');
    expect(finalized.antiGamingVerdict).toBe('PASS');
  });

  it('accrual refuses to over-promise the budget (commit at promise time)', () => {
    const program = programFixture({
      budget: { totalAmount: usd(900n), funding: 'REQUIRES_FUNDED_RESERVATION' },
    });
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(program);
    const first = accrueReward(deps, program, contribution({ id: 'c2', actor: 'a' }));
    expect(first.amount.value).toBe(500n);
    expect(fx.budgets.get(program.programId, program.version).committed.value).toBe(500n);
    // A second promise would exceed the declared total — refused BEFORE the
    // accrual is recorded (no half-applied state).
    expect(() => accrueReward(deps, program, contribution({ id: 'c3', actor: 'b' }))).toThrow();
    expect(deps.rewards.all).toHaveLength(1);
    expect(fx.budgets.get(program.programId, program.version).committed.value).toBe(500n);
  });

  it('enforces per-actor caps and concentration limits deterministically', () => {
    const capped = programFixture({ perActorCap: usd(800n) });
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(capped);
    accrueReward(deps, capped, contribution({ id: 'c1', actor: 'sender-alice' }));
    expect(() =>
      accrueReward(deps, capped, contribution({ id: 'c2', actor: 'sender-alice' })),
    ).toThrow(RewardCapExceededError);
    // A different actor is unaffected by alice's cap usage.
    expect(() => accrueReward(deps, capped, contribution({ id: 'c3', actor: 'sender-bob' }))).not.toThrow();

    const concentrated = programFixture({
      reward: {
        mechanism: 'FEE_REBATE',
        formula: { kind: 'FIXED_PER_CONTRIBUTION', amount: usd(3_000n) },
      },
      concentrationLimit: { maxShareBpsOfBudgetPerActor: 2_500n },
    });
    const { deps: deps2, fx: fx2 } = fundedDeps();
    fx2.budgets.establishFundedBudget(concentrated);
    expect(() =>
      accrueReward(deps2, concentrated, contribution({ id: 'c4', actor: 'sender-carol' })),
    ).toThrow(RewardCapExceededError);
  });
});

describe('rewards: anti-gaming gate before finalization (INV-P04)', () => {
  it('BLOCKS finalization when checks flag or block', () => {
    const program = programFixture();
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(program);
    const accrual = accrueReward(deps, program, contribution({ id: 'c1', actor: 'sender-alice' }));

    expect(flagReport().verdict).toBe('FLAG');
    expect(() => finalizeReward(deps, program, accrual.id, flagReport())).toThrow(
      AntiGamingGateError,
    );
    expect(deps.rewards.get(accrual.id)?.state).toBe('PROVISIONAL');

    // After the FLAG the same accrual can still finalize once checks PASS.
    const finalized = finalizeReward(deps, program, accrual.id, passReport());
    expect(finalized.state).toBe('CONFIRMED');
  });

  it('rejects finalization of unknown accruals and cross-program misuse', () => {
    const program = programFixture();
    const other = programFixture();
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(program);
    expect(() =>
      finalizeReward(deps, program, asRewardAccrualId('rwd_missing'), passReport()),
    ).toThrow();
    const accrual = accrueReward(deps, program, contribution({ id: 'c1', actor: 'a' }));
    expect(() => finalizeReward(deps, other, accrual.id, passReport())).toThrow();
  });
});

describe('rewards: monetary rewards create protocol obligations', () => {
  it('qualifies a confirmed reward into a protocol obligation (funder → beneficiary)', () => {
    const program = programFixture();
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(program);
    const record = contribution({ id: 'c1', actor: 'sender-alice' });
    const ledger = new ContributionLedger();
    ledger.append(record);

    const accrual = accrueReward(deps, program, record);
    finalizeReward(deps, program, accrual.id, passReport());
    const claimable = qualifyReward(deps, program, accrual.id, SETTLE_WINDOW);

    expect(claimable.state).toBe('CLAIMABLE');
    expect(claimable.obligationIds).toHaveLength(1);
    const { original } = obligationsOf(deps, claimable);
    expect(original).toHaveLength(1);
    const obligation = original[0];
    expect(obligation?.debtor).toBe(asPartyId('sponsor-1'));
    expect(obligation?.creditor).toBe(asPartyId('sender-alice'));
    expect(obligation?.amount.value).toBe(500n);
    expect(obligation?.state).toBe('PENDING');
    // INV-F07 discipline (consumed): derivation lineage is preserved.
    expect(obligation?.derivedFrom.startsWith('CLR:')).toBe(true);

    // Claim settles the lifecycle: CLAIMABLE → CLAIMED (terminal).
    const claimed = claimReward(deps, program, claimable.id);
    expect(claimed.state).toBe('CLAIMED');
  });

  it('non-monetary rewards accrue and finalize without obligations or budget', () => {
    const points = programFixture({
      reward: { mechanism: 'POINTS', formula: { kind: 'FIXED_PER_CONTRIBUTION', amount: usd(10n) } },
      budget: { totalAmount: usd(1_000n), funding: 'EXPLICITLY_CONTINGENT' },
    });
    expect(rewardKindFor(points)).toBe('POINTS');
    const { deps, fx } = fundedDeps();
    // No budget established at all: points need no funding.
    const accrual = accrueReward(deps, points, contribution({ id: 'c1', actor: 'a' }));
    expect(accrual.kind).toBe('POINTS');
    const finalized = finalizeReward(deps, points, accrual.id, passReport());
    const claimable = qualifyReward(deps, points, accrual.id, SETTLE_WINDOW);
    expect(finalized.state).toBe('CONFIRMED');
    expect(claimable.obligationIds).toHaveLength(0);
    expect(deps.obligations.all).toHaveLength(0);
    expect(fx.budgets.all()).toHaveLength(0);
  });
});

describe('rewards: clawbacks are separate adjustments, history preserved (INV-P06)', () => {
  it('claws back a claimable reward via a SEPARATE adjustment obligation', () => {
    const program = programFixture();
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(program);
    const record = contribution({ id: 'c1', actor: 'sender-alice' });
    const ledger = new ContributionLedger();
    ledger.append(record);

    const accrual = accrueReward(deps, program, record);
    finalizeReward(deps, program, accrual.id, passReport());
    const claimable = qualifyReward(deps, program, accrual.id, SETTLE_WINDOW);
    const originalObligationId = claimable.obligationIds[0];
    expect(originalObligationId).toBeDefined();
    const originalObligationBefore = originalObligationId !== undefined
      ? deps.obligations.get(originalObligationId)
      : undefined;

    // Claw back within the declared window (2_592_000_000ms).
    const clawedBack = clawBackReward(deps, program, claimable.id, SETTLE_WINDOW);
    expect(clawedBack.state).toBe('CLAWED_BACK');

    // INV-P06: the adjustment is a SEPARATE obligation, reversed direction.
    expect(clawedBack.adjustmentObligationIds).toHaveLength(1);
    const { original, adjustments } = obligationsOf(deps, clawedBack);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.debtor).toBe(asPartyId('sender-alice'));
    expect(adjustments[0]?.creditor).toBe(asPartyId('sponsor-1'));
    expect(adjustments[0]?.amount.value).toBe(500n);

    // The ORIGINAL obligation is untouched — same id, same state, not re-derived.
    expect(clawedBack.obligationIds).toEqual(claimable.obligationIds);
    const originalObligationAfter =
      originalObligationId !== undefined ? deps.obligations.get(originalObligationId) : undefined;
    expect(originalObligationAfter).toEqual(originalObligationBefore);
    expect(original[0]?.id).toBe(originalObligationId);
    expect(original[0]?.state).toBe('PENDING');

    // The CONTRIBUTION history remains (clawback never rewrites history).
    expect(ledger.get(record.id)).toBeDefined();
    expect(ledger.get(record.id)?.outcome).toBe('VERIFIED_COMPLETED');
  });

  it('claws back an already-claimed reward and preserves the original obligation', () => {
    const program = programFixture();
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(program);
    const record = contribution({ id: 'c1', actor: 'sender-alice' });
    const accrual = accrueReward(deps, program, record);
    finalizeReward(deps, program, accrual.id, passReport());
    const claimable = qualifyReward(deps, program, accrual.id, SETTLE_WINDOW);
    claimReward(deps, program, claimable.id);
    const clawed = clawBackReward(deps, program, claimable.id, SETTLE_WINDOW);
    expect(clawed.state).toBe('CLAWED_BACK');
    expect(clawed.obligationIds).toHaveLength(1);
    expect(clawed.adjustmentObligationIds).toHaveLength(1);
  });

  it('refuses clawback after the declared window closes (guarded transition)', () => {
    const program = programFixture();
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(program);
    const record = contribution({ id: 'c1', actor: 'sender-alice' });
    const accrual = accrueReward(deps, program, record);
    finalizeReward(deps, program, accrual.id, passReport());
    const claimable = qualifyReward(deps, program, accrual.id, SETTLE_WINDOW);
    // Advance beyond the clawback window (2_592_000_000 ms).
    fx.clock.advanceMs(2_592_000_001n);
    expect(() => clawBackReward(deps, program, claimable.id, SETTLE_WINDOW)).toThrow();
    expect(deps.rewards.get(claimable.id)?.state).toBe('CLAIMABLE');
  });
});

describe('rewards: disputes and expiry (side states)', () => {
  it('walks the dispute lifecycle deterministically', () => {
    const program = programFixture();
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(program);
    const record = contribution({ id: 'c1', actor: 'sender-alice' });
    const accrual = accrueReward(deps, program, record);
    finalizeReward(deps, program, accrual.id, passReport());
    const claimable = qualifyReward(deps, program, accrual.id, SETTLE_WINDOW);

    const disputed = disputeReward(deps, program, claimable.id, 'quality challenged');
    expect(disputed.state).toBe('DISPUTED');
    expect(disputed.note).toBe('quality challenged');

    const upheld = resolveRewardDispute(deps, program, claimable.id, 'UPHOLD', SETTLE_WINDOW);
    expect(upheld.state).toBe('CONFIRMED');
    const reQualified = qualifyReward(deps, program, claimable.id, SETTLE_WINDOW);
    expect(reQualified.state).toBe('CLAIMABLE');
    expect(reQualified.obligationIds).toHaveLength(1);

    // Dispute again and reject: the reward expires, obligations remain settled
    // through the normal protocol pipeline.
    disputeReward(deps, program, claimable.id, 'final rejection');
    const rejected = resolveRewardDispute(
      deps,
      program,
      claimable.id,
      'REJECT',
      SETTLE_WINDOW,
    );
    expect(rejected.state).toBe('EXPIRED');
  });

  it('expires provisional rewards and releases their budget commitment', () => {
    const program = programFixture();
    const { deps, fx } = fundedDeps();
    fx.budgets.establishFundedBudget(program);
    const record = contribution({ id: 'c1', actor: 'sender-alice' });
    const accrual = accrueReward(deps, program, record);
    expect(fx.budgets.get(program.programId, program.version).committed.value).toBe(500n);

    const expired = expireReward(deps, program, accrual.id);
    expect(expired.state).toBe('EXPIRED');
    expect(fx.budgets.get(program.programId, program.version).committed.value).toBe(0n);
  });
});

function emptyAccrual(): RewardAccrual {
  return {
    id: asRewardAccrualId('rwd_x'),
    programVersion: { programId: asIncentiveProgramId('p'), version: 1n },
    contributionId: 'c',
    beneficiary: asPartyId('b'),
    kind: 'MONETARY',
    amount: usd(0n),
    state: 'PROVISIONAL',
    formulaDigest: '',
    programSpecDigest: '',
    createdAt: 0n,
    obligationIds: [],
    adjustmentObligationIds: [],
  };
}
