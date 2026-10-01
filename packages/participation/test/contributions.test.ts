import { describe, expect, it } from 'vitest';
import { asPartyId, createIdFactory, DeterministicClock } from '@payswap/protocol';
import {
  asContributionId,
  asReferralBindingId,
  attributeContribution,
  ContributionIdConflictError,
  ContributionLedger,
  deriveIntroducerContribution,
  DuplicateReferralBindingError,
  ReferralRegistry,
  type AttributionRule,
  type ContributionRecord,
  type ReferralBinding,
} from '../src/contributions.js';
import { asIncentiveProgramId } from '../src/programs.js';
import { T0, usd } from './helpers.js';

const INTRODUCER = asPartyId('merchant-alice');
const INTRODUCED = asPartyId('sender-bob');

function bindingFixture(overrides?: Partial<ReferralBinding>): ReferralBinding {
  return {
    id: asReferralBindingId('refbind_1'),
    introducer: INTRODUCER,
    introduced: INTRODUCED,
    code: 'ALICE-BOB-77',
    boundAt: T0 - 100n,
    evidence: [{ kind: 'signed_referral', locator: 'evd:refbind:1', level: 'P2' }],
    ...overrides,
  };
}

function contributionFixture(): ContributionRecord {
  return {
    id: asContributionId('contrib_1'),
    actor: INTRODUCED,
    actorRole: 'SENDER',
    behavior: 'PAYMENT_METHOD_ADOPTED',
    affectedObjects: [{ objectType: 'payment_intent', objectId: 'pi_1' }],
    quantity: 1n,
    value: usd(12_345n),
    occurredAt: T0,
    outcome: 'VERIFIED_COMPLETED',
    evidence: [{ kind: 'rail_receipt', locator: 'evd:contrib:1', level: 'P2' }],
    attribution: attributeContribution({
      actor: INTRODUCED,
      actorRole: 'SENDER',
      evidence: [{ kind: 'rail_receipt', locator: 'evd:contrib:1', level: 'P2' }],
      rules: [{ ruleId: 'direct:participant', kind: 'DIRECT_PARTICIPANT' }],
    }),
    programVersion: { programId: asIncentiveProgramId('prog_1'), version: 1n },
  };
}

function ids() {
  return createIdFactory(new DeterministicClock(T0));
}

describe('contributions: deterministic auditable attribution (INV-P02)', () => {
  it('attributes direct participation and records the full decision trace', () => {
    const attribution = attributeContribution({
      actor: INTRODUCED,
      actorRole: 'SENDER',
      evidence: [{ kind: 'rail_receipt', locator: 'evd:contrib:1', level: 'P2' }],
      rules: [{ ruleId: 'direct:participant', kind: 'DIRECT_PARTICIPANT' }],
    });
    expect(attribution.attributedActor).toBe(INTRODUCED);
    expect(attribution.creditedRole).toBe('SENDER');
    expect(attribution.basis).toBe('DIRECT_EVIDENCE');
    expect(attribution.decisionTrace).toEqual([
      { ruleId: 'direct:participant', matched: true, note: 'direct participation evidence matched' },
    ]);
  });

  it('INV-P02: attribution is reproducible — recompute yields the identical value AND trace', () => {
    const binding = bindingFixture();
    const rules: readonly AttributionRule[] = [
      { ruleId: 'referral:introducer', kind: 'REFERRAL_INTRODUCER', binding },
      { ruleId: 'direct:participant', kind: 'DIRECT_PARTICIPANT' },
    ];
    const input = {
      actor: INTRODUCED,
      actorRole: 'SENDER' as const,
      evidence: [{ kind: 'rail_receipt', locator: 'evd:contrib:1', level: 'P2' as const }],
      rules,
    };
    const first = attributeContribution(input);
    const second = attributeContribution(input);

    // Introducer rule wins: the introduced actor's contribution is credited
    // to the introducer, with binding + contribution evidence retained.
    expect(first.attributedActor).toBe(INTRODUCER);
    expect(first.creditedRole).toBe('INTRODUCER_REFERRER');
    expect(first.basis).toBe('REFERRAL_BINDING');
    expect(first.evidenceRefs).toEqual(['evd:refbind:1', 'evd:contrib:1']);
    // Reproducibility: identical value and identical audit trace.
    expect(second).toEqual(first);
    expect(second.decisionTrace).toEqual(first.decisionTrace);
  });

  it('records non-matching rules in the trace (auditable negative evidence)', () => {
    const otherBinding = bindingFixture({ introduced: asPartyId('someone-else') });
    const attribution = attributeContribution({
      actor: INTRODUCED,
      actorRole: 'SENDER',
      evidence: [{ kind: 'rail_receipt', locator: 'evd:contrib:1', level: 'P2' }],
      rules: [
        { ruleId: 'referral:introducer', kind: 'REFERRAL_INTRODUCER', binding: otherBinding },
        { ruleId: 'direct:participant', kind: 'DIRECT_PARTICIPANT' },
      ],
    });
    expect(attribution.basis).toBe('DIRECT_EVIDENCE');
    expect(attribution.decisionTrace).toHaveLength(2);
    expect(attribution.decisionTrace[0]?.matched).toBe(false);
    expect(attribution.decisionTrace[1]?.matched).toBe(true);
  });

  it('rejects malformed attribution inputs deterministically', () => {
    expect(() =>
      attributeContribution({
        actor: INTRODUCED,
        actorRole: 'SENDER',
        evidence: [],
        rules: [{ ruleId: 'direct:participant', kind: 'DIRECT_PARTICIPANT' }],
      }),
    ).toThrow();
    expect(() =>
      attributeContribution({
        actor: INTRODUCED,
        actorRole: 'SENDER',
        evidence: [{ kind: 'rail_receipt', locator: 'evd:contrib:1', level: 'P2' }],
        rules: [],
      }),
    ).toThrow();
    expect(() =>
      attributeContribution({
        actor: INTRODUCED,
        actorRole: 'SENDER',
        evidence: [{ kind: 'rail_receipt', locator: 'evd:contrib:1', level: 'P2' }],
        rules: [
          // A non-matching referral rule first, so the loop reaches the
          // duplicate rule-id check instead of returning on a direct match.
          {
            ruleId: 'dup',
            kind: 'REFERRAL_INTRODUCER',
            binding: bindingFixture({ introduced: asPartyId('someone-else') }),
          },
          { ruleId: 'dup', kind: 'DIRECT_PARTICIPANT' },
        ],
      }),
    ).toThrow(/unique/);
  });
});

describe('contributions: referral bindings and introducer derivation', () => {
  it('records evidence-backed bindings and resolves introducers deterministically', () => {
    const registry = new ReferralRegistry();
    const binding = registry.bind(bindingFixture());
    expect(registry.activeBindingFor(INTRODUCED)?.id).toBe(binding.id);
    expect(registry.byCode('ALICE-BOB-77')).toHaveLength(1);
  });

  it('rejects duplicate bindings for one introduced actor (no ambiguous attribution)', () => {
    const registry = new ReferralRegistry();
    registry.bind(bindingFixture());
    expect(() =>
      registry.bind(bindingFixture({ id: asReferralBindingId('refbind_2'), introducer: asPartyId('merchant-carol') })),
    ).toThrow(DuplicateReferralBindingError);
    // The registry kept the FIRST binding — attribution stays unambiguous.
    expect(registry.activeBindingFor(INTRODUCED)?.introducer).toBe(INTRODUCER);
  });

  it('rejects self-referral bindings at bind time', () => {
    const registry = new ReferralRegistry();
    expect(() =>
      registry.bind(bindingFixture({ introducer: INTRODUCED, introduced: INTRODUCED })),
    ).toThrow(/cannot refer themselves/);
  });

  it('derives the introducer contribution deterministically from evidence', () => {
    const registry = new ReferralRegistry();
    const binding = registry.bind(bindingFixture());
    const original = contributionFixture();

    const deps = { ids: ids() };
    const first = deriveIntroducerContribution(original, binding, deps);
    const second = deriveIntroducerContribution(original, binding, deps);

    expect(first.actor).toBe(INTRODUCER);
    expect(first.actorRole).toBe('INTRODUCER_REFERRER');
    expect(first.behavior).toBe('REFERRAL_CREDIT');
    expect(first.quantity).toBe(1n);
    expect(first.outcome).toBe(original.outcome);
    expect(first.attribution.basis).toBe('INTRODUCER_DERIVATION');
    expect(first.attribution.attributedActor).toBe(INTRODUCER);
    // Deterministic given the same id factory state — same derivation twice.
    expect(second.actor).toBe(first.actor);
    expect(second.behavior).toBe(first.behavior);
    expect(second.attribution.decisionTrace).toEqual(first.attribution.decisionTrace);

    expect(() =>
      deriveIntroducerContribution(
        { ...original, actor: asPartyId('someone-else') },
        binding,
        deps,
      ),
    ).toThrow(/binding introduced/);
  });
});

describe('contributions: append-only ledger', () => {
  it('stores immutable contributions and refuses id reuse', () => {
    const ledger = new ContributionLedger();
    const record = contributionFixture();
    const stored = ledger.append(record);
    expect(ledger.get(stored.id)).toBeDefined();
    expect(ledger.byActor(INTRODUCED)).toHaveLength(1);
    expect(() => ledger.append(record)).toThrow(ContributionIdConflictError);

    // History cannot be rewritten through the stored record.
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as unknown as { behavior: string }).behavior = 'FABRICATED';
    }).toThrow();
  });

  it('validates contribution shape on append (no unevidenced records)', () => {
    const ledger = new ContributionLedger();
    const record = contributionFixture();
    expect(() => ledger.append({ ...record, evidence: [] })).toThrow(/at least one evidence/);
    expect(() => ledger.append({ ...record, quantity: 0n })).toThrow();
    expect(() =>
      ledger.append({
        ...record,
        // @ts-expect-error unknown outcome must be rejected at the type level too
        outcome: 'MAYBE',
      }),
    ).toThrow();
  });
});
