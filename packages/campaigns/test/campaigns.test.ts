import { describe, expect, it } from 'vitest';
import { asPartyId } from '@payswap/protocol';
import {
  asIncentiveProgramId,
  UnfundedRewardFinalizationError,
  runAntiGamingChecks,
  type AntiGamingReport,
} from '@payswap/participation';
import {
  asCampaignId,
  CampaignBudgetRequiredError,
  CampaignCapExceededError,
  CampaignEngine,
  CampaignEpochViolationError,
  CampaignNotAcceptingError,
  DeferralOpenError,
  DuplicateCampaignContributionError,
  IncentiveEpochViolationError,
  SuppressedRewardError,
  UnknownCampaignError,
} from '../src/campaigns.js';
import { ContributionLedger } from '@payswap/participation';
import {
  campaignFixture,
  cleanInputs,
  contribution,
  registerProgram,
  testGoalId,
  usd,
  type CampaignFixture,
} from './helpers.js';

const ENROLLMENT = { opensAt: 200_000n, closesAt: 2_000_000n };
const EPOCH_FROM = 500_000n;

interface CampaignSetup {
  readonly fixture: CampaignFixture;
  readonly campaignId: ReturnType<typeof asCampaignId>;
}

/** Standard setup: funded program budget + open campaign (DEFER cap policy). */
function setup(overrides?: {
  readonly cap?: bigint;
  readonly capPolicy?: 'DEFER' | 'REJECT';
  readonly programId?: string;
  readonly funding?: 'FUNDED' | 'CONTINGENT';
  readonly velocityMax?: bigint;
  readonly emission?: {
    readonly below: bigint;
    readonly within: bigint;
    readonly above: bigint;
  };
}): CampaignSetup {
  const fixture = campaignFixture();
  const program = registerProgram(
    fixture,
    {
      ...(overrides?.velocityMax !== undefined
        ? {
            antiGamingPolicy: {
              forbidSelfReferral: true,
              requireIdentityLinkageChecks: true,
              velocity: { maxContributions: overrides.velocityMax, windowMs: 600_000n },
            },
          }
        : {}),
      ...(overrides?.emission !== undefined
        ? {
            emission: {
              belowTargetMultiplierBps: overrides.emission.below,
              withinBandMultiplierBps: overrides.emission.within,
              aboveTargetMultiplierBps: overrides.emission.above,
            },
          }
        : {}),
    },
    overrides?.programId ?? 'prog_campaigns_test',
  );
  if ((overrides?.funding ?? 'FUNDED') === 'FUNDED') {
    fixture.budgets.establishFundedBudget(program);
  } else {
    fixture.budgets.declareContingentBudget(program);
  }
  const campaign = fixture.engine.openCampaign({
    campaignId: asCampaignId('camp_1'),
    goalId: testGoalId(),
    enrollment: ENROLLMENT,
    effectiveFrom: EPOCH_FROM,
    programVersion: { programId: program.programId, version: program.version },
    fundingCap: usd(overrides?.cap ?? 10_000n),
    capPolicy: overrides?.capPolicy ?? 'DEFER',
    curve: { kind: 'CONSTANT', target: 100n },
    band: { toleranceBps: 500n },
  });
  expect(campaign.epochs.length).toBe(1);
  return { fixture, campaignId: campaign.id };
}

function passReport(fixture: CampaignFixture, actor: string): AntiGamingReport {
  return runAntiGamingChecks(
    { forbidSelfReferral: true, requireIdentityLinkageChecks: true },
    {
      contribution: contribution({ id: 'report-only', actor }),
      history: [],
      identityLinks: [],
      declaredSurfaces: [],
      now: fixture.clock.now(),
    },
  );
}

describe('campaigns: opening and epoch discipline', () => {
  it('opens a campaign over an immutable program version with a pinned spec digest', () => {
    const { fixture, campaignId } = setup();
    const campaign = fixture.engine.campaign(campaignId);
    const epoch = fixture.engine.currentEpoch(campaignId);
    const program = fixture.programs.version(asIncentiveProgramId('prog_campaigns_test'), 1n);
    expect(epoch.programSpecDigest).toBe(program.specDigest);
    expect(campaign.goalId).toBe(testGoalId());
    expect(campaign.enrollment).toEqual(ENROLLMENT);
  });

  it('rejects a campaign cap above the program version budget total', () => {
    const fixture = campaignFixture();
    const program = registerProgram(fixture);
    fixture.budgets.establishFundedBudget(program);
    expect(() =>
      fixture.engine.openCampaign({
        goalId: testGoalId(),
        enrollment: ENROLLMENT,
        effectiveFrom: EPOCH_FROM,
        programVersion: { programId: program.programId, version: program.version },
        fundingCap: usd(10_001n),
        curve: { kind: 'CONSTANT', target: 100n },
      }),
    ).toThrow(/cannot exceed the program version budget total/);
  });

  it('requires an established program-version budget state (INV-P01)', () => {
    const fixture = campaignFixture();
    const program = registerProgram(fixture);
    // No budget established at all.
    expect(() =>
      fixture.engine.openCampaign({
        goalId: testGoalId(),
        enrollment: ENROLLMENT,
        effectiveFrom: EPOCH_FROM,
        programVersion: { programId: program.programId, version: program.version },
        fundingCap: usd(1_000n),
        curve: { kind: 'CONSTANT', target: 100n },
      }),
    ).toThrow(CampaignBudgetRequiredError);
  });

  it('pause/resume/close append strictly-later epochs and never rewrite history', () => {
    const { fixture, campaignId } = setup();
    const paused = fixture.engine.pauseCampaign(campaignId, 600_000n);
    const resumed = fixture.engine.resumeCampaign(campaignId, 700_000n);
    const closed = fixture.engine.closeCampaign(campaignId, 800_000n);
    const history = fixture.engine.campaign(campaignId).epochs;
    expect(history.length).toBe(4);
    expect(history.map((epoch) => epoch.status)).toEqual(['ACTIVE', 'PAUSED', 'ACTIVE', 'CLOSED']);
    expect(history.map((epoch) => epoch.epoch)).toEqual([1n, 2n, 3n, 4n]);
    expect(paused.epochs[1]?.supersedesEpoch).toBe(1n);
    expect(resumed.epochs[2]?.supersedesEpoch).toBe(2n);
    expect(closed.epochs[3]?.supersedesEpoch).toBe(3n);
    // Non-advancing epochs are refused.
    expect(() => fixture.engine.pauseCampaign(campaignId, 800_000n)).toThrow(
      CampaignEpochViolationError,
    );
    // CLOSED is terminal.
    expect(() => fixture.engine.resumeCampaign(campaignId, 900_000n)).toThrow(
      CampaignEpochViolationError,
    );
  });

  it('INV-P07: a cap change requires a NEW program version', () => {
    const { fixture, campaignId } = setup();
    expect(() =>
      fixture.engine.reviseCampaign(campaignId, {
        effectiveFrom: 600_000n,
        status: 'ACTIVE',
        programVersion: { programId: asIncentiveProgramId('prog_campaigns_test'), version: 1n },
        fundingCap: usd(2_000n),
      }),
    ).toThrow(IncentiveEpochViolationError);
  });

  it('INV-P07: a curve change requires a NEW program version', () => {
    const { fixture, campaignId } = setup();
    expect(() =>
      fixture.engine.reviseCampaign(campaignId, {
        effectiveFrom: 600_000n,
        status: 'ACTIVE',
        programVersion: { programId: asIncentiveProgramId('prog_campaigns_test'), version: 1n },
        curve: { kind: 'CONSTANT', target: 200n },
      }),
    ).toThrow(IncentiveEpochViolationError);
  });

  it('a status-only revision carries the incentive parameters forward unchanged', () => {
    const { fixture, campaignId } = setup();
    const before = fixture.engine.currentEpoch(campaignId);
    fixture.engine.pauseCampaign(campaignId, 600_000n);
    const after = fixture.engine.currentEpoch(campaignId);
    expect(after.fundingCap).toEqual(before.fundingCap);
    expect(after.curveDigest).toBe(before.curveDigest);
    expect(after.band.toleranceBps).toBe(before.band.toleranceBps);
    expect(after.programVersion).toEqual(before.programVersion);
  });
});

describe('campaigns: funding and caps are enforced at accrual (W3-005 acceptance)', () => {
  it('accrues normally under a funded budget and within the campaign cap', () => {
    const { fixture, campaignId } = setup({ cap: 10_000n });
    const outcome = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    expect(outcome.disposition).toBe('ACCRUED');
    if (outcome.disposition !== 'ACCRUED') throw new Error('unreachable');
    expect(outcome.accrual.amount.value).toBe(500n);
    expect(outcome.accrual.state).toBe('PROVISIONAL');
    expect(fixture.engine.campaignCommitted(campaignId).value).toBe(500n);
    // The contribution was recorded in the campaign ledger.
    expect(fixture.engine.ledger.get('c1' as never)?.actor).toBe('sender-alice');
  });

  it('DEFER policy: accrual beyond the cap is DEFERRED with an evidence record, never silently dropped', () => {
    const { fixture, campaignId } = setup({ cap: 1_200n });
    const first = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    const second = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c2', actor: 'sender-bob' }),
      cleanInputs(100n),
    );
    expect(first.disposition).toBe('ACCRUED');
    expect(second.disposition).toBe('ACCRUED');
    expect(fixture.engine.campaignCommitted(campaignId).value).toBe(1_000n);

    const third = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c3', actor: 'sender-carol' }),
      cleanInputs(100n),
    );
    expect(third.disposition).toBe('DEFERRED_CAP');
    if (third.disposition !== 'DEFERRED_CAP') throw new Error('unreachable');
    expect(third.deferred.kind).toBe('CAMPAIGN_CAP');
    expect(third.deferred.computedAmount.value).toBe(500n);
    expect(third.deferred.contribution.id).toBe('c3');
    expect(third.deferred.reason).toMatch(/never silently dropped/);
    // No reward was created for the deferred accrual.
    expect(fixture.rewards.all.filter((accrual) => accrual.beneficiary === 'sender-carol')).toEqual([]);
    expect(fixture.engine.campaignCommitted(campaignId).value).toBe(1_000n);
    // The deferred record is queryable evidence.
    expect(fixture.engine.deferredCaps.length).toBe(1);
  });

  it('REJECT policy: accrual beyond the cap is REJECTED loudly', () => {
    const { fixture, campaignId } = setup({ cap: 600n, capPolicy: 'REJECT' });
    fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    expect(() =>
      fixture.engine.processContribution(
        campaignId,
        contribution({ id: 'c2', actor: 'sender-bob' }),
        cleanInputs(100n),
      ),
    ).toThrow(CampaignCapExceededError);
    expect(fixture.engine.campaignCommitted(campaignId).value).toBe(500n);
  });

  it('a deferred cap accrual is reprocessable after a cap adjustment (new program version)', () => {
    const { fixture, campaignId } = setup({ cap: 1_200n });
    fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c2', actor: 'sender-bob' }),
      cleanInputs(100n),
    );
    const deferred = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c3', actor: 'sender-carol' }),
      cleanInputs(100n),
    );
    expect(deferred.disposition).toBe('DEFERRED_CAP');

    // Cap adjustment: NEW program version (INV-P07) + budget + new epoch.
    const v2 = fixture.programs.reviseProgram(
      {
        programId: asIncentiveProgramId('prog_campaigns_test'),
        effectiveFrom: 900_000n,
        status: 'ACTIVE',
        sponsor: asPartyId('sponsor-1'),
        objective: 'raise verified first-time adoption',
        eligibleRole: 'SENDER',
        eligibilityRules: [{ kind: 'MIN_PROOF_LEVEL', level: 'P1' }],
        contributionEvents: ['PAYMENT_METHOD_ADOPTED', 'REFERRAL_CREDIT'],
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
      },
      'ACTIVE',
    );
    fixture.budgets.establishFundedBudget(v2);
    fixture.engine.reviseCampaign(campaignId, {
      effectiveFrom: 900_000n,
      status: 'ACTIVE',
      programVersion: { programId: v2.programId, version: v2.version },
      fundingCap: usd(2_000n),
    });

    const deferredId = fixture.engine.deferredCaps[0]?.id;
    expect(deferredId).toBeDefined();
    const reprocessed = fixture.engine.reprocessDeferredCap(
      deferredId as string,
      cleanInputs(100n),
    );
    expect(reprocessed.disposition).toBe('ACCRUED');
    if (reprocessed.disposition !== 'ACCRUED') throw new Error('unreachable');
    expect(reprocessed.accrual.beneficiary).toBe('sender-carol');
    expect(fixture.engine.campaignCommitted(campaignId).value).toBe(1_500n);
    // The resolution is recorded (queryable evidence of the reprocess).
    const resolution = fixture.engine.deferredCapResolution(deferredId as string);
    expect(resolution?.accrualId).toBe(reprocessed.accrual.id);
    // A second reprocess of the same deferred record is refused.
    expect(() =>
      fixture.engine.reprocessDeferredCap(deferredId as string, cleanInputs(100n)),
    ).toThrow(DuplicateCampaignContributionError);
  });

  it('INV-P01: a monetary reward under a contingent budget can never become final', () => {
    const { fixture, campaignId } = setup({ funding: 'CONTINGENT' });
    const outcome = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    expect(outcome.disposition).toBe('ACCRUED');
    if (outcome.disposition !== 'ACCRUED') throw new Error('unreachable');
    expect(outcome.accrual.state).toBe('PROVISIONAL');
    expect(() =>
      fixture.engine.finalizeCampaignReward(
        campaignId,
        outcome.accrual.id,
        passReport(fixture, 'sender-alice'),
      ),
    ).toThrow(UnfundedRewardFinalizationError);
    // …and the reward stays PROVISIONAL (visibly contingent, never final).
    expect(fixture.rewards.get(outcome.accrual.id)?.state).toBe('PROVISIONAL');
  });

  it('finalizes a funded, clean reward through the participation machinery', () => {
    const { fixture, campaignId } = setup();
    const outcome = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    if (outcome.disposition !== 'ACCRUED') throw new Error('unreachable');
    const finalized = fixture.engine.finalizeCampaignReward(
      campaignId,
      outcome.accrual.id,
      passReport(fixture, 'sender-alice'),
    );
    expect(finalized.state).toBe('CONFIRMED');
  });
});

describe('campaigns: processing gates', () => {
  it('refuses contributions outside the enrollment window', () => {
    const { fixture, campaignId } = setup();
    expect(() =>
      fixture.engine.processContribution(
        campaignId,
        contribution({ id: 'c1', actor: 'sender-alice', occurredAt: 100_000n }),
        cleanInputs(100n),
      ),
    ).toThrow(CampaignNotAcceptingError);
  });

  it('refuses contributions while the campaign is paused (at contribution time)', () => {
    const { fixture, campaignId } = setup();
    fixture.engine.pauseCampaign(campaignId, 600_000n);
    expect(() =>
      fixture.engine.processContribution(
        campaignId,
        contribution({ id: 'c1', actor: 'sender-alice', occurredAt: 1_500_000n }),
        cleanInputs(100n),
      ),
    ).toThrow(CampaignNotAcceptingError);
    // …but a contribution that occurred while ACTIVE still processes.
    const outcome = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c2', actor: 'sender-alice', occurredAt: 550_000n }),
      cleanInputs(100n),
    );
    expect(outcome.disposition).toBe('ACCRUED');
  });

  it('refuses duplicate processing of the same contribution (one reward per contribution)', () => {
    const { fixture, campaignId } = setup();
    fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    expect(() =>
      fixture.engine.processContribution(
        campaignId,
        contribution({ id: 'c1', actor: 'sender-alice' }),
        cleanInputs(100n),
      ),
    ).toThrow(DuplicateCampaignContributionError);
  });

  it('unknown campaigns are refused loudly', () => {
    const fixture = campaignFixture();
    expect(() => fixture.engine.campaign(asCampaignId('nope'))).toThrow(UnknownCampaignError);
  });
});

describe('campaigns: anti-gaming dispositions (defer + suppress)', () => {
  it('a FLAG verdict defers the reward: accrual exists, finalization blocked until resolved', () => {
    const { fixture, campaignId } = setup({ velocityMax: 1n });
    const first = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    expect(first.disposition).toBe('ACCRUED');
    // Second contribution by the same actor inside the velocity window → FLAG.
    const second = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c2', actor: 'sender-alice', occurredAt: 1_001_000n }),
      cleanInputs(100n),
    );
    expect(second.disposition).toBe('DEFERRED');
    if (second.disposition !== 'DEFERRED') throw new Error('unreachable');
    expect(second.deferral.kind).toBe('ANTI_GAMING_FLAG');
    expect(second.accrual.state).toBe('PROVISIONAL');
    expect(second.antiGaming.verdict).toBe('FLAG');
    // Finalization is blocked while the deferral is open.
    expect(() =>
      fixture.engine.finalizeCampaignReward(
        campaignId,
        second.accrual.id,
        passReport(fixture, 'sender-alice'),
      ),
    ).toThrow(DeferralOpenError);
    // Resolution requires a FRESH PASS report.
    expect(() =>
      fixture.engine.resolveDeferral(campaignId, second.accrual.id, {
        note: 'reviewed',
        evidenceRefs: ['evd:review:1'],
        report: second.antiGaming,
      }),
    ).toThrow(DeferralOpenError);
    const resolution = fixture.engine.resolveDeferral(campaignId, second.accrual.id, {
      note: 'manual review cleared the velocity flag',
      evidenceRefs: ['evd:review:1'],
      report: passReport(fixture, 'sender-alice'),
    });
    expect(resolution.report.verdict).toBe('PASS');
    // After resolution the reward finalizes normally.
    const finalized = fixture.engine.finalizeCampaignReward(
      campaignId,
      second.accrual.id,
      passReport(fixture, 'sender-alice'),
    );
    expect(finalized.state).toBe('CONFIRMED');
  });

  it('a BLOCK verdict suppresses the reward with an evidence record (no accrual at all)', () => {
    const { fixture, campaignId } = setup();
    // Wash transaction: the actor is on both sides of the activity.
    const outcome = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice', counterparty: 'sender-alice' }),
      cleanInputs(100n),
    );
    expect(outcome.disposition).toBe('SUPPRESSED');
    if (outcome.disposition !== 'SUPPRESSED') throw new Error('unreachable');
    expect(outcome.suppression.kind).toBe('ANTI_GAMING_BLOCK');
    expect(outcome.suppression.report?.verdict).toBe('BLOCK');
    expect(outcome.suppression.evidenceRefs.length).toBeGreaterThan(0);
    expect(fixture.rewards.all).toEqual([]);
    // The contribution itself remains recorded (history preserved).
    expect(fixture.engine.ledger.get('c1' as never)).toBeDefined();
  });

  it('a suppressed (operator emergency) reward can never finalize', () => {
    const { fixture, campaignId } = setup();
    const outcome = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    if (outcome.disposition !== 'ACCRUED') throw new Error('unreachable');
    fixture.engine.emergencySuppressReward(campaignId, outcome.accrual.id, {
      reason: 'suspected farming ring',
      evidenceRefs: ['evd:abuse:ring:42'],
    });
    expect(fixture.rewards.get(outcome.accrual.id)?.state).toBe('EXPIRED');
    expect(() =>
      fixture.engine.finalizeCampaignReward(
        campaignId,
        outcome.accrual.id,
        passReport(fixture, 'sender-alice'),
      ),
    ).toThrow(SuppressedRewardError);
    // Suppression released the campaign headroom (EXPIRED accruals do not count).
    expect(fixture.engine.campaignCommitted(campaignId).value).toBe(0n);
  });

  it('emergency suppression without evidence is refused (never unaudited)', () => {
    const { fixture, campaignId } = setup();
    const outcome = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    if (outcome.disposition !== 'ACCRUED') throw new Error('unreachable');
    expect(() =>
      fixture.engine.emergencySuppressReward(campaignId, outcome.accrual.id, {
        reason: 'no evidence',
        evidenceRefs: [],
      }),
    ).toThrow(/at least one evidence reference/);
  });
});

describe('campaigns: dynamic emission through target curves', () => {
  it('the curve point drives the emission multiplier declared on the program version', () => {
    const { fixture, campaignId } = setup({
      emission: { below: 15_000n, within: 10_000n, above: 5_000n },
      cap: 10_000n,
    });
    const below = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(50n),
    );
    const within = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c2', actor: 'sender-bob' }),
      cleanInputs(100n),
    );
    const above = fixture.engine.processContribution(
      campaignId,
      contribution({ id: 'c3', actor: 'sender-carol' }),
      cleanInputs(200n),
    );
    expect(below.disposition).toBe('ACCRUED');
    expect(within.disposition).toBe('ACCRUED');
    expect(above.disposition).toBe('ACCRUED');
    if (below.disposition !== 'ACCRUED' || within.disposition !== 'ACCRUED' || above.disposition !== 'ACCRUED') {
      throw new Error('unreachable');
    }
    expect(below.curvePoint.emissionLevel).toBe('BELOW_TARGET');
    expect(within.curvePoint.emissionLevel).toBe('WITHIN_BAND');
    expect(above.curvePoint.emissionLevel).toBe('ABOVE_TARGET');
    // 500 × 1.5 / 1.0 / 0.5 — exact bigint basis-point scaling.
    expect(below.accrual.amount.value).toBe(750n);
    expect(within.accrual.amount.value).toBe(500n);
    expect(above.accrual.amount.value).toBe(250n);
  });
});

describe('campaigns: engine construction', () => {
  it('exposes the injected ids/clock/ledger surfaces for deterministic derivations', () => {
    const fixture = campaignFixture();
    expect(fixture.engine.ledger).toBeInstanceOf(ContributionLedger);
    expect(typeof fixture.engine.ids.mintId('probe')).toBe('string');
    expect(fixture.engine.clock.now()).toBe(fixture.clock.now());
    expect(new CampaignEngine({
      ids: fixture.ids,
      clock: fixture.clock,
      rewards: fixture.rewards,
      budgets: fixture.budgets,
      obligations: fixture.obligations,
      programs: fixture.programs,
      ledger: fixture.ledger,
    })).toBeInstanceOf(CampaignEngine);
  });
});
