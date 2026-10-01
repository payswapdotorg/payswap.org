import { describe, expect, it } from 'vitest';
import { asPartyId } from '@payswap/protocol';
import {
  asReferralBindingId,
  ReferralRegistry,
  runAntiGamingChecks,
  type ReferralBinding,
} from '@payswap/participation';
import { processReferralCredit, ReferralSurface, ReferralSurfaceError } from '../src/referrals.js';
import {
  campaignFixture,
  contribution,
  evidence,
  registerProgram,
  testGoalId,
  usd,
  type CampaignFixture,
} from './helpers.js';

const ENROLLMENT = { opensAt: 200_000n, closesAt: 2_000_000n };
const EPOCH_FROM = 500_000n;

interface ReferralSetup {
  readonly fixture: CampaignFixture;
  readonly campaignId: string;
  readonly surface: ReferralSurface;
}

function referralSetup(overrides?: { readonly velocityMax?: bigint }): ReferralSetup {
  const fixture = campaignFixture();
  const program = registerProgram(fixture, {
    ...(overrides?.velocityMax !== undefined
      ? {
          antiGamingPolicy: {
            forbidSelfReferral: true,
            requireIdentityLinkageChecks: true,
            velocity: { maxContributions: overrides.velocityMax, windowMs: 600_000n },
          },
        }
      : {}),
  });
  fixture.budgets.establishFundedBudget(program);
  const campaign = fixture.engine.openCampaign({
    campaignId: 'camp_referrals' as never,
    goalId: testGoalId(),
    enrollment: ENROLLMENT,
    effectiveFrom: EPOCH_FROM,
    programVersion: { programId: program.programId, version: program.version },
    fundingCap: usd(10_000n),
    curve: { kind: 'CONSTANT', target: 100n },
  });
  const surface = new ReferralSurface({
    ids: fixture.ids,
    referrals: new ReferralRegistry(),
  });
  return { fixture, campaignId: campaign.id, surface };
}

function binding(
  id: string,
  introducer: string,
  introduced: string,
  code = `ref-${id}`,
): ReferralBinding {
  return {
    id: asReferralBindingId(id),
    introducer: asPartyId(introducer),
    introduced: asPartyId(introduced),
    code,
    boundAt: 400_000n,
    evidence: [evidence('referral_link', `evd:${id}:link`, 'P2')],
  };
}

describe('referral surfaces: links and codes as contribution records', () => {
  it('mints deterministic referral codes and binds evidence-backed introductions', () => {
    const { fixture, surface } = referralSetup();
    const code = surface.mintCode(asPartyId('introducer-alice'));
    expect(code).toMatch(/^ref-introducer-alice-code_/);
    const bound = surface.bind({
      introducer: asPartyId('introducer-alice'),
      introduced: asPartyId('sender-bob'),
      code,
      boundAt: 400_000n,
      evidence: [evidence('referral_link', 'evd:link:1', 'P2')],
    });
    expect(bound.introducer).toBe('introducer-alice');
    // The same introduced actor cannot be bound twice.
    expect(() =>
      surface.bind({
        introducer: asPartyId('introducer-carol'),
        introduced: asPartyId('sender-bob'),
        code: surface.mintCode(asPartyId('introducer-carol')),
        boundAt: 400_000n,
        evidence: [evidence('referral_link', 'evd:link:2', 'P2')],
      }),
    ).toThrow(/already has an active referral binding/);
    // Deterministic codes from the same factory sequence.
    expect(typeof fixture.ids.mintId('probe')).toBe('string');
  });

  it('records a referral link/code USE as the introduced actor\'s signup contribution', () => {
    const { surface } = referralSetup();
    const bound = surface.bind({
      introducer: asPartyId('introducer-alice'),
      introduced: asPartyId('sender-bob'),
      code: 'ref-use-1',
      boundAt: 400_000n,
      evidence: [evidence('referral_link', 'evd:link:1', 'P2')],
    });
    const signup = surface.recordSignup(bound, { occurredAt: 450_000n });
    expect(signup.actor).toBe('sender-bob');
    expect(signup.behavior).toBe('REFERRAL_SIGNUP');
    expect(signup.attribution.basis).toBe('DIRECT_EVIDENCE');
    expect(signup.attribution.decisionTrace[0]?.ruleId).toBe(`referral:signup:${bound.id}`);
    expect(signup.evidence.length).toBeGreaterThan(0);
  });
});

describe('referral credits: wash/collusion signals defer and suppress rewards (W3-005 acceptance)', () => {
  it('a clean referral credit accrues the introducer reward', () => {
    const { fixture, campaignId } = referralSetup();
    const b = binding('b1', 'introducer-alice', 'sender-bob');
    const outcome = processReferralCredit(
      fixture.engine,
      campaignId as never,
      contribution({ id: 'c1', actor: 'sender-bob' }),
      b,
      { identityLinks: [], declaredSurfaces: [], observedParticipation: 100n },
    );
    expect(outcome.disposition).toBe('ACCRUED');
    expect(outcome.introducerContribution.actor).toBe('introducer-alice');
    expect(outcome.introducerContribution.behavior).toBe('REFERRAL_CREDIT');
    expect(outcome.referral.introducer).toBe('introducer-alice');
    const result = outcome.outcome;
    if (result.disposition !== 'ACCRUED') throw new Error('unreachable');
    expect(result.accrual.beneficiary).toBe('introducer-alice');
  });

  it('DEFER path: a collusion FLAG (velocity) defers the introducer reward with an evidence record', () => {
    const { fixture, campaignId } = referralSetup({ velocityMax: 1n });
    const b = binding('b1', 'introducer-alice', 'sender-bob');
    // First referral credit by introducer-alice: clean.
    const first = processReferralCredit(
      fixture.engine,
      campaignId as never,
      contribution({ id: 'c1', actor: 'sender-bob' }),
      b,
      { identityLinks: [], declaredSurfaces: [], observedParticipation: 100n },
    );
    expect(first.disposition).toBe('ACCRUED');
    // Second referral credit by the SAME introducer inside the velocity
    // window → VELOCITY_LIMIT_EXCEEDED (FLAG) → deferred reward.
    const second = processReferralCredit(
      fixture.engine,
      campaignId as never,
      contribution({ id: 'c2', actor: 'sender-carol-introduced' }),
      binding('b2', 'introducer-alice', 'sender-carol-introduced'),
      { identityLinks: [], declaredSurfaces: [], observedParticipation: 100n },
    );
    expect(second.disposition).toBe('DEFERRED');
    const result = second.outcome;
    if (result.disposition !== 'DEFERRED') throw new Error('unreachable');
    expect(result.antiGaming.verdict).toBe('FLAG');
    expect(result.antiGaming.findings.map((finding) => finding.code)).toContain(
      'VELOCITY_LIMIT_EXCEEDED',
    );
    // The deferred reward exists (a promise) but carries the deferral record.
    expect(result.accrual.state).toBe('PROVISIONAL');
    expect(result.deferral.kind).toBe('ANTI_GAMING_FLAG');
    // Finalization is blocked while the deferral is open.
    const pass = runAntiGamingChecks(
      { forbidSelfReferral: true, requireIdentityLinkageChecks: true },
      {
        contribution: contribution({ id: 'resolve', actor: 'introducer-alice' }),
        history: [],
        identityLinks: [],
        declaredSurfaces: [],
        now: fixture.clock.now(),
      },
    );
    expect(() =>
      fixture.engine.finalizeCampaignReward(campaignId as never, result.accrual.id, pass),
    ).toThrow(/unresolved anti-gaming deferral/);
    // Resolution with a fresh PASS report unblocks finalization.
    fixture.engine.resolveDeferral(campaignId as never, result.accrual.id, {
      note: 'manual review cleared the introducer',
      evidenceRefs: ['evd:review:referral:1'],
      report: pass,
    });
    expect(
      fixture.engine.finalizeCampaignReward(campaignId as never, result.accrual.id, pass).state,
    ).toBe('CONFIRMED');
  });

  it('SUPPRESS path: a collusion BLOCK (Sybil identity cluster) suppresses the reward entirely', () => {
    const { fixture, campaignId } = referralSetup();
    const b = binding('b1', 'introducer-alice', 'sender-bob');
    // The introducer and the introduced actor are identity-linked (collusion).
    const outcome = processReferralCredit(
      fixture.engine,
      campaignId as never,
      contribution({ id: 'c1', actor: 'sender-bob' }),
      b,
      {
        identityLinks: [{ a: asPartyId('introducer-alice'), b: asPartyId('sender-bob'), kind: 'shared_device' }],
        declaredSurfaces: [],
        observedParticipation: 100n,
      },
    );
    expect(outcome.disposition).toBe('SUPPRESSED');
    const result = outcome.outcome;
    if (result.disposition !== 'SUPPRESSED') throw new Error('unreachable');
    expect(result.antiGaming.verdict).toBe('BLOCK');
    expect(result.antiGaming.findings.map((finding) => finding.code)).toContain(
      'SYBIL_IDENTITY_CLUSTER',
    );
    expect(result.suppression.kind).toBe('ANTI_GAMING_BLOCK');
    expect(result.suppression.evidenceRefs.length).toBeGreaterThan(0);
    // No reward accrual exists for the introducer — suppressed, not dropped.
    expect(fixture.rewards.all.filter((accrual) => accrual.beneficiary === 'introducer-alice')).toEqual([]);
    // But the introducer-credit CONTRIBUTION remains recorded (history preserved).
    expect(fixture.engine.ledger.get(outcome.introducerContribution.id)).toBeDefined();
  });

  it('SUPPRESS path: a self-referral signal suppresses the reward', () => {
    const { fixture, campaignId } = referralSetup();
    // A self-referral binding (constructible only by bypassing the registry —
    // the surface itself rejects it loudly; the signal path still must hold).
    const selfBinding = binding('b-self', 'sender-bob', 'sender-bob');
    const outcome = processReferralCredit(
      fixture.engine,
      campaignId as never,
      contribution({ id: 'c1', actor: 'sender-bob' }),
      selfBinding,
      { identityLinks: [], declaredSurfaces: [], observedParticipation: 100n },
    );
    expect(outcome.disposition).toBe('SUPPRESSED');
    const result = outcome.outcome;
    if (result.disposition !== 'SUPPRESSED') throw new Error('unreachable');
    expect(result.antiGaming.findings.map((finding) => finding.code)).toContain('SELF_REFERRAL');
    expect(fixture.rewards.all).toEqual([]);
  });

  it('the referral surface itself rejects self-referral bindings loudly', () => {
    const { surface } = referralSetup();
    expect(() =>
      surface.bind({
        introducer: asPartyId('sender-bob'),
        introduced: asPartyId('sender-bob'),
        code: 'ref-self',
        boundAt: 400_000n,
        evidence: [evidence('referral_link', 'evd:self', 'P2')],
      }),
    ).toThrow(/cannot refer themselves/);
  });

  it('refuses deriving a referral credit from another actor\'s contribution', () => {
    const { fixture, campaignId } = referralSetup();
    expect(() =>
      processReferralCredit(
        fixture.engine,
        campaignId as never,
        contribution({ id: 'c1', actor: 'sender-carol' }),
        binding('b1', 'introducer-alice', 'sender-bob'),
        { identityLinks: [], declaredSurfaces: [], observedParticipation: 100n },
      ),
    ).toThrow(ReferralSurfaceError);
  });
});
