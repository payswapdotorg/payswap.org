import { describe, expect, it } from 'vitest';
import { DeterministicClock, asPartyId, createIdFactory } from '@payswap/protocol';
import {
  asReferralBindingId,
  ReferralRegistry,
  type AttributionRule,
  type ReferralBinding,
} from '@payswap/participation';
import {
  replayAttribution,
  resolveReferralChain,
  runAttributionPipeline,
  type AttributionPipelineDeps,
  type RawParticipationEvent,
} from '../src/attribution.js';
import { evidence, T0 } from './helpers.js';

const RULES: readonly AttributionRule[] = [
  { ruleId: 'direct:participant', kind: 'DIRECT_PARTICIPANT' },
];

function event(id: string, actor: string): RawParticipationEvent {
  return {
    actor: asPartyId(actor),
    actorRole: 'SENDER',
    behavior: 'PAYMENT_METHOD_ADOPTED',
    affectedObjects: [{ objectType: 'payment_intent', objectId: `pi_${id}` }],
    quantity: 1n,
    occurredAt: T0,
    outcome: 'VERIFIED_COMPLETED',
    evidence: [evidence('rail_receipt', `evd:${id}:receipt`, 'P2')],
  };
}

function binding(
  id: string,
  introducer: string,
  introduced: string,
  boundAt = 500_000n,
): ReferralBinding {
  return {
    id: asReferralBindingId(id),
    introducer: asPartyId(introducer),
    introduced: asPartyId(introduced),
    code: `ref-${id}`,
    boundAt,
    evidence: [evidence('referral_link', `evd:${id}:link`, 'P2')],
  };
}

/** Fresh, identically-seeded deps — the deterministic-replay contract. */
function freshDeps(referrals?: ReferralRegistry): AttributionPipelineDeps {
  const clock = new DeterministicClock(T0);
  return { ids: createIdFactory(clock), ...(referrals !== undefined ? { referrals } : {}) };
}

describe('attribution pipeline: deterministic and auditable (INV-P02)', () => {
  it('attributes every event with a full decision trace', () => {
    const result = runAttributionPipeline([event('e1', 'sender-alice'), event('e2', 'sender-bob')], RULES, freshDeps());
    expect(result.lines.length).toBe(2);
    for (const line of result.lines) {
      expect(line.attribution.basis).toBe('DIRECT_EVIDENCE');
      expect(line.attribution.decisionTrace.length).toBeGreaterThan(0);
      expect(line.attribution.decisionTrace[0]?.ruleId).toBe('direct:participant');
      expect(line.attribution.evidenceRefs.length).toBeGreaterThan(0);
      expect(line.record.evidence.length).toBeGreaterThan(0);
    }
  });

  it('is reproducible: same inputs → identical records, attribution and digest (INV-P02/P03)', () => {
    const events = [event('e1', 'sender-alice'), event('e2', 'sender-bob'), event('e3', 'sender-carol')];
    const first = runAttributionPipeline(events, RULES, freshDeps());
    const second = runAttributionPipeline(events, RULES, freshDeps());
    expect(second.digest).toBe(first.digest);
    expect(second.lines.map((line) => line.record.id)).toEqual(first.lines.map((line) => line.record.id));
    expect(second.lines.map((line) => line.attribution)).toEqual(first.lines.map((line) => line.attribution));
    // The replay helper proves it explicitly.
    const replay = replayAttribution(events, RULES, freshDeps(), first.digest);
    expect(replay.reproducible).toBe(true);
    // Different inputs → different digest.
    const different = runAttributionPipeline([event('e1', 'sender-alice')], RULES, freshDeps());
    expect(different.digest).not.toBe(first.digest);
  });

  it('refuses events without evidence (unevidenced attribution is not auditable)', () => {
    const bare = { ...event('e1', 'sender-alice'), evidence: [] };
    expect(() => runAttributionPipeline([bare], RULES, freshDeps())).toThrow(/at least one evidence/);
  });

  it('refuses an empty rule set', () => {
    expect(() => runAttributionPipeline([event('e1', 'sender-alice')], [], freshDeps())).toThrow(
      /at least one declared rule/,
    );
  });
});

describe('attribution pipeline: referral attribution chains', () => {
  it('resolves multi-hop referral chains deterministically', () => {
    const referrals = new ReferralRegistry();
    referrals.bind(binding('b1', 'introducer-carol', 'sender-bob'));
    referrals.bind(binding('b2', 'introducer-alice', 'introducer-carol'));
    const chain = resolveReferralChain(referrals, asPartyId('sender-bob'), 5n);
    expect(chain.length).toBe(2);
    expect(chain[0]?.introducer).toBe('introducer-carol');
    expect(chain[1]?.introducer).toBe('introducer-alice');
    // Deterministic: same registry, same actor, same depth → same chain.
    expect(resolveReferralChain(referrals, asPartyId('sender-bob'), 5n)).toEqual(chain);
    // Depth bound is honored.
    expect(resolveReferralChain(referrals, asPartyId('sender-bob'), 1n).length).toBe(1);
    // No binding → empty chain.
    expect(resolveReferralChain(referrals, asPartyId('introducer-alice'), 5n)).toEqual([]);
  });

  it('terminates cyclic binding graphs without crediting anyone twice', () => {
    const referrals = new ReferralRegistry();
    // A→B and B→A is constructible: each introduced actor has one binding.
    referrals.bind(binding('b1', 'party-a', 'party-b'));
    referrals.bind(binding('b2', 'party-b', 'party-a'));
    const chain = resolveReferralChain(referrals, asPartyId('party-a'), 10n);
    // The walk stops at the cycle: party-a → party-b → (party-a already visited).
    expect(chain.length).toBe(1);
    expect(chain[0]?.introducer).toBe('party-b');
    const distinct = new Set(chain.map((hop) => hop.introducer));
    expect(distinct.size).toBe(chain.length);
  });

  it('derives the introducer-credit chain as contribution records', () => {
    const referrals = new ReferralRegistry();
    referrals.bind(binding('b1', 'introducer-alice', 'sender-bob'));
    const result = runAttributionPipeline(
      [event('e1', 'sender-bob')],
      RULES,
      freshDeps(referrals),
      { maxReferralDepth: 1n },
    );
    const line = result.lines[0];
    expect(line).toBeDefined();
    expect(line?.derivedIntroducerRecords.length).toBe(1);
    const derived = line?.derivedIntroducerRecords[0];
    expect(derived?.actor).toBe('introducer-alice');
    expect(derived?.actorRole).toBe('INTRODUCER_REFERRER');
    expect(derived?.behavior).toBe('REFERRAL_CREDIT');
    expect(derived?.attribution.basis).toBe('INTRODUCER_DERIVATION');
  });

  it('requireBindingBeforeEvent stops crediting introducers bound after the event', () => {
    const referrals = new ReferralRegistry();
    // Binding recorded AFTER the contribution occurred.
    referrals.bind(binding('b1', 'introducer-alice', 'sender-bob', T0 + 1n));
    const result = runAttributionPipeline(
      [event('e1', 'sender-bob')],
      RULES,
      freshDeps(referrals),
      { maxReferralDepth: 1n, requireBindingBeforeEvent: true },
    );
    expect(result.lines[0]?.derivedIntroducerRecords).toEqual([]);
    // Without the option the derivation proceeds (declared policy choice).
    const lenient = runAttributionPipeline(
      [event('e1', 'sender-bob')],
      RULES,
      freshDeps(referrals),
      { maxReferralDepth: 1n },
    );
    expect(lenient.lines[0]?.derivedIntroducerRecords.length).toBe(1);
  });

  it('derivation is reproducible: identical inputs → identical derived chains', () => {
    const referrals = new ReferralRegistry();
    referrals.bind(binding('b1', 'introducer-alice', 'sender-bob'));
    const events = [event('e1', 'sender-bob')];
    const options = { maxReferralDepth: 2n };
    const first = runAttributionPipeline(events, RULES, freshDeps(referrals), options);
    const second = runAttributionPipeline(events, RULES, freshDeps(referrals), options);
    expect(second.digest).toBe(first.digest);
    expect(
      second.lines[0]?.derivedIntroducerRecords.map((record) => record.id),
    ).toEqual(first.lines[0]?.derivedIntroducerRecords.map((record) => record.id));
  });
});
