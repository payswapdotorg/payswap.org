import { describe, expect, it } from 'vitest';
import { asPartyId } from '@payswap/protocol';
import {
  identitiesLinked,
  runAntiGamingChecks,
  type AntiGamingContext,
  type IdentityLink,
} from '../src/anti-gaming.js';
import type { AntiGamingPolicySpec } from '../src/programs.js';
import { asReferralBindingId, type ReferralBinding } from '../src/contributions.js';
import { T0, contribution } from './helpers.js';

const ALICE = asPartyId('sender-alice');
const BOB = asPartyId('sender-bob');

function policyFixture(overrides?: Partial<AntiGamingPolicySpec>): AntiGamingPolicySpec {
  return {
    forbidSelfReferral: true,
    requireIdentityLinkageChecks: true,
    ...overrides,
  };
}

function bindingFixture(overrides?: Partial<ReferralBinding>): ReferralBinding {
  return {
    id: asReferralBindingId('refbind_1'),
    introducer: asPartyId('merchant-x'),
    introduced: ALICE,
    code: 'CODE-1',
    boundAt: T0 - 100n,
    evidence: [{ kind: 'signed_referral', locator: 'evd:refbind:1', level: 'P2' }],
    ...overrides,
  };
}

const SURFACES = [
  {
    surface: 'raw_transaction_count',
    fabricableBehaviors: ['PAYMENT_METHOD_ADOPTED'],
    requiresVerifiedOutcome: true,
    note: 'raw adoption events can be fabricated cheaply',
  },
];

function contextFixture(overrides?: Partial<AntiGamingContext>): AntiGamingContext {
  return {
    contribution: contribution({ id: 'c1', actor: ALICE }),
    history: [],
    identityLinks: [],
    declaredSurfaces: SURFACES,
    now: T0,
    ...overrides,
  };
}

describe('anti-gaming: identity linkage', () => {
  it('detects linked identities through multi-hop graphs deterministically', () => {
    const links: readonly IdentityLink[] = [
      { a: ALICE, b: asPartyId('alias-1'), kind: 'shared_device' },
      { a: asPartyId('alias-1'), b: BOB, kind: 'shared_device' },
      { a: asPartyId('unrelated'), b: asPartyId('island'), kind: 'shared_kyc' },
    ];
    expect(identitiesLinked(ALICE, BOB, links)).toBe(true);
    expect(identitiesLinked(BOB, ALICE, links)).toBe(true);
    expect(identitiesLinked(ALICE, asPartyId('unrelated'), links)).toBe(false);
    expect(identitiesLinked(ALICE, ALICE, [])).toBe(true);
    expect(identitiesLinked(ALICE, BOB, [])).toBe(false);
  });
});

describe('anti-gaming: checks before finalization (INV-P04)', () => {
  it('PASSES a clean verified contribution', () => {
    const report = runAntiGamingChecks(policyFixture(), contextFixture());
    expect(report.verdict).toBe('PASS');
    expect(report.findings).toEqual([]);
    expect(report.checksRun).toContain('wash_transaction_pattern');
    expect(report.checksRun).toContain('raw_artificial_activity');
  });

  it('BLOCKS self-referrals', () => {
    const selfBinding = bindingFixture({
      introducer: ALICE,
      introduced: ALICE,
    });
    const report = runAntiGamingChecks(
      policyFixture(),
      contextFixture({ referralBinding: selfBinding }),
    );
    expect(report.verdict).toBe('BLOCK');
    expect(report.findings.map((finding) => finding.code)).toContain('SELF_REFERRAL');
  });

  it('BLOCKS sybil identity clusters (introducer linked to introduced)', () => {
    const links: readonly IdentityLink[] = [
      { a: asPartyId('merchant-x'), b: asPartyId('alias-9'), kind: 'shared_device' },
      { a: asPartyId('alias-9'), b: ALICE, kind: 'shared_kyc' },
    ];
    const report = runAntiGamingChecks(
      policyFixture(),
      contextFixture({
        referralBinding: bindingFixture(),
        identityLinks: links,
      }),
    );
    expect(report.verdict).toBe('BLOCK');
    expect(report.findings.map((finding) => finding.code)).toContain('SYBIL_IDENTITY_CLUSTER');
  });

  it('BLOCKS wash transactions (the same identity on both sides)', () => {
    const report = runAntiGamingChecks(
      policyFixture({ requireIdentityLinkageChecks: false }),
      contextFixture({
        contribution: contribution({ id: 'c1', actor: ALICE, counterparty: ALICE }),
      }),
    );
    expect(report.verdict).toBe('BLOCK');
    expect(report.findings.map((finding) => finding.code)).toContain('WASH_TRANSACTION_PATTERN');
  });

  it('FLAGS velocity above the declared window limit', () => {
    const history = Array.from({ length: 5 }, (_, index) =>
      contribution({
        id: `h${index}`,
        actor: ALICE,
        occurredAt: T0 - 1_000n * BigInt(index),
      }),
    );
    const report = runAntiGamingChecks(
      policyFixture({ velocity: { maxContributions: 3n, windowMs: 10_000n } }),
      contextFixture({ history }),
    );
    expect(report.verdict).toBe('FLAG');
    expect(report.findings.map((finding) => finding.code)).toContain('VELOCITY_LIMIT_EXCEEDED');
    // Clean history of a DIFFERENT actor does not trip the limit.
    const cleanReport = runAntiGamingChecks(
      policyFixture({ velocity: { maxContributions: 3n, windowMs: 10_000n } }),
      contextFixture({
        history: history.map((record) => ({ ...record, actor: BOB })),
      }),
    );
    expect(cleanReport.findings.map((finding) => finding.code)).not.toContain(
      'VELOCITY_LIMIT_EXCEEDED',
    );
  });

  it('FLAGS counterparty diversity below the minimum', () => {
    const history = [
      contribution({ id: 'h0', actor: ALICE, counterparty: asPartyId('merchant-x') }),
      contribution({ id: 'h1', actor: ALICE, counterparty: asPartyId('merchant-x') }),
    ];
    const report = runAntiGamingChecks(
      policyFixture({ minCounterpartyDiversity: 3n }),
      contextFixture({
        history,
        contribution: contribution({
          id: 'c1',
          actor: ALICE,
          counterparty: asPartyId('merchant-x'),
        }),
      }),
    );
    expect(report.verdict).toBe('FLAG');
    expect(report.findings.map((finding) => finding.code)).toContain(
      'COUNTERPARTY_DIVERSITY_BELOW_MIN',
    );
  });

  it('FLAGS raw artificial activity from declared experiment surfaces (W3-004 wiring)', () => {
    // The behavior is on a declared fabricable surface and is NOT verified.
    const farmed = runAntiGamingChecks(
      policyFixture(),
      contextFixture({
        contribution: contribution({
          id: 'c1',
          actor: ALICE,
          behavior: 'PAYMENT_METHOD_ADOPTED',
          outcome: 'OBSERVED',
        }),
      }),
    );
    expect(farmed.verdict).toBe('FLAG');
    expect(farmed.findings.map((finding) => finding.code)).toContain('RAW_ARTIFICIAL_ACTIVITY');

    // The SAME behavior with a VERIFIED_COMPLETED outcome is not flagged.
    const verified = runAntiGamingChecks(
      policyFixture(),
      contextFixture({
        contribution: contribution({
          id: 'c1',
          actor: ALICE,
          behavior: 'PAYMENT_METHOD_ADOPTED',
          outcome: 'VERIFIED_COMPLETED',
        }),
      }),
    );
    expect(verified.findings.map((finding) => finding.code)).not.toContain(
      'RAW_ARTIFICIAL_ACTIVITY',
    );

    // Behaviors NOT on any declared surface never trip this check.
    const offSurface = runAntiGamingChecks(
      policyFixture(),
      contextFixture({
        contribution: contribution({ id: 'c1', actor: ALICE, behavior: 'SETTLEMENT_REPORTED' }),
      }),
    );
    expect(offSurface.findings.map((finding) => finding.code)).not.toContain(
      'RAW_ARTIFICIAL_ACTIVITY',
    );
  });

  it('aggregates deterministically: BLOCK dominates FLAG, order is stable', () => {
    const binding = bindingFixture({ introducer: ALICE, introduced: ALICE });
    const history = Array.from({ length: 5 }, (_, index) =>
      contribution({ id: `h${index}`, actor: ALICE, occurredAt: T0 }),
    );
    const context = contextFixture({
      referralBinding: binding,
      history,
      contribution: contribution({
        id: 'c1',
        actor: ALICE,
        counterparty: ALICE,
        outcome: 'OBSERVED',
      }),
    });
    const policy = policyFixture({
      velocity: { maxContributions: 2n, windowMs: 1_000n },
    });
    const first = runAntiGamingChecks(policy, context);
    const second = runAntiGamingChecks(policy, context);
    expect(first.verdict).toBe('BLOCK');
    expect(second).toEqual(first);
    const codes = first.findings.map((finding) => finding.code);
    expect(codes).toContain('SELF_REFERRAL');
    expect(codes).toContain('WASH_TRANSACTION_PATTERN');
    expect(codes).toContain('VELOCITY_LIMIT_EXCEEDED');
    expect(codes).toContain('RAW_ARTIFICIAL_ACTIVITY');
  });
});
