import { describe, expect, it } from 'vitest';
import { inspectRewardProvenance, UnknownProvenanceError } from '../src/provenance.js';
import {
  campaignFixture,
  cleanInputs,
  contribution,
  registerProgram,
  testGoalId,
  usd,
} from './helpers.js';

const ENROLLMENT = { opensAt: 200_000n, closesAt: 2_000_000n };
const EPOCH_FROM = 500_000n;

function provenanceFixture() {
  const fixture = campaignFixture();
  const program = registerProgram(fixture, {
    emission: {
      belowTargetMultiplierBps: 15_000n,
      withinBandMultiplierBps: 10_000n,
      aboveTargetMultiplierBps: 5_000n,
    },
  });
  fixture.budgets.establishFundedBudget(program);
  const campaign = fixture.engine.openCampaign({
    campaignId: 'camp_prov' as never,
    goalId: testGoalId(),
    enrollment: ENROLLMENT,
    effectiveFrom: EPOCH_FROM,
    programVersion: { programId: program.programId, version: program.version },
    fundingCap: usd(10_000n),
    curve: { kind: 'CONSTANT', target: 100n },
    band: { toleranceBps: 500n },
  });
  return { fixture, campaignId: campaign.id };
}

describe('reward provenance inspection (W3-005 acceptance: users can inspect WHY a reward was accrued)', () => {
  it('assembles the full queryable provenance chain: program version, contribution evidence, curve point, anti-gaming verdict', () => {
    const { fixture, campaignId } = provenanceFixture();
    const outcome = fixture.engine.processContribution(
      campaignId as never,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(50n), // below the target band → boost regime
    );
    if (outcome.disposition !== 'ACCRUED') throw new Error('unreachable');

    const provenance = inspectRewardProvenance(
      { engine: fixture.engine, programs: fixture.programs, rewards: fixture.rewards, budgets: fixture.budgets },
      outcome.accrual.id,
    );

    // Pillar 1 — the program version the reward was computed under.
    expect(provenance.program.programId).toBe('prog_campaigns_test');
    expect(provenance.program.version).toBe(1n);
    expect(provenance.program.specDigest).toBe(
      fixture.programs.version('prog_campaigns_test' as never, 1n).specDigest,
    );
    expect(provenance.program.mechanism).toBe('FEE_REBATE');
    expect(provenance.program.formulaKind).toBe('FIXED_PER_CONTRIBUTION');
    expect(provenance.program.budget.funding).toBe('REQUIRES_FUNDED_RESERVATION');

    // Pillar 2 — the contribution evidence with the attribution trace.
    expect(provenance.contribution.id).toBe('c1');
    expect(provenance.contribution.actor).toBe('sender-alice');
    expect(provenance.contribution.behavior).toBe('PAYMENT_METHOD_ADOPTED');
    expect(provenance.contribution.evidenceRefs).toContain('evd:c1:receipt');
    expect(provenance.contribution.attributionBasis).toBe('DIRECT_EVIDENCE');
    expect(provenance.contribution.decisionTrace.length).toBeGreaterThan(0);

    // Pillar 3 — the curve point (the dynamic-incentive decision).
    expect(provenance.curvePoint.target).toBe(100n);
    expect(provenance.curvePoint.observedParticipation).toBe(50n);
    expect(provenance.curvePoint.emissionLevel).toBe('BELOW_TARGET');
    expect(provenance.curvePoint.digest).toBe(outcome.curvePoint.digest);

    // Pillar 4 — the anti-gaming verdict at accrual time.
    expect(provenance.antiGaming.verdict).toBe('PASS');
    expect(provenance.antiGaming.deferral).toBe('NONE');
    expect(provenance.antiGaming.suppression).toBe('NONE');
    expect(provenance.antiGaming.checksRun.length).toBeGreaterThan(0);

    // The reward itself and the funding state (INV-P01 visibility).
    expect(provenance.reward.amount.value).toBe(750n); // 500 × 1.5 boost
    expect(provenance.reward.state).toBe('PROVISIONAL');
    expect(provenance.funding.programBudgetFunded).toBe(true);
    expect(provenance.funding.campaignCap.value).toBe(10_000n);
    expect(provenance.funding.campaignCommitted.value).toBe(750n);

    // The chain digest is present and reproducible.
    expect(provenance.provenanceDigest).toMatch(/^dgb1:/);
  });

  it('the provenance digest is deterministic — the same chain reproduces it identically (INV-P03)', () => {
    const { fixture, campaignId } = provenanceFixture();
    const outcome = fixture.engine.processContribution(
      campaignId as never,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(50n),
    );
    if (outcome.disposition !== 'ACCRUED') throw new Error('unreachable');
    const first = inspectRewardProvenance(
      { engine: fixture.engine, programs: fixture.programs, rewards: fixture.rewards, budgets: fixture.budgets },
      outcome.accrual.id,
    );
    const second = inspectRewardProvenance(
      { engine: fixture.engine, programs: fixture.programs, rewards: fixture.rewards, budgets: fixture.budgets },
      outcome.accrual.id,
    );
    expect(second.provenanceDigest).toBe(first.provenanceDigest);
    expect(second).toEqual(first);
  });

  it('provenance reflects the deferral state of a flagged reward', () => {
    const { fixture, campaignId } = provenanceFixture();
    // Wash transaction → BLOCK → SUPPRESSED (no accrual → no provenance)…
    const blocked = fixture.engine.processContribution(
      campaignId as never,
      contribution({ id: 'c0', actor: 'sender-x', counterparty: 'sender-x' }),
      cleanInputs(100n),
    );
    expect(blocked.disposition).toBe('SUPPRESSED');

    // …and a clean accrual followed by emergency suppression carries the
    // suppression state in its provenance chain.
    const outcome = fixture.engine.processContribution(
      campaignId as never,
      contribution({ id: 'c1', actor: 'sender-alice' }),
      cleanInputs(100n),
    );
    if (outcome.disposition !== 'ACCRUED') throw new Error('unreachable');
    fixture.engine.emergencySuppressReward(campaignId as never, outcome.accrual.id, {
      reason: 'ops review',
      evidenceRefs: ['evd:ops:1'],
    });
    const provenance = inspectRewardProvenance(
      { engine: fixture.engine, programs: fixture.programs, rewards: fixture.rewards, budgets: fixture.budgets },
      outcome.accrual.id,
    );
    expect(provenance.antiGaming.suppression).toBe('SUPPRESSED');
    expect(provenance.reward.state).toBe('EXPIRED');
  });

  it('unknown rewards have no provenance (refused loudly)', () => {
    const { fixture } = provenanceFixture();
    expect(() =>
      inspectRewardProvenance(
        { engine: fixture.engine, programs: fixture.programs, rewards: fixture.rewards, budgets: fixture.budgets },
        'rwd_missing' as never,
      ),
    ).toThrow(UnknownProvenanceError);
  });
});
