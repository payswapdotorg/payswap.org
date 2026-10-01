import { describe, expect, it } from 'vitest';
import { createIdFactory, DeterministicClock, GHS } from '@payswap/protocol';
import {
  defineParticipationGoal,
  evaluateStopConditions,
  type GoalReading,
  type ParticipationGoal,
} from '../src/goals.js';
import { usd } from './helpers.js';

function ids() {
  return createIdFactory(new DeterministicClock(1_000n));
}

function goalFixture(): ParticipationGoal {
  return defineParticipationGoal(
    {
      title: 'Grow verified A2A adoption in the GH corridor',
      description:
        'Senders hesitate to adopt account-to-account rails; the goal is blocked by scarce trust and information, not by fees alone.',
      bottleneck: {
        description: 'senders do not trust A2A rails for first-time merchants',
        scarceResource: 'TRUST',
      },
      targetActorClasses: ['SENDER', 'MERCHANT'],
      successMeasures: [
        {
          name: 'adopted_senders',
          description: 'senders with at least one verified completed A2A payment',
          target: 500n,
          direction: 'AT_LEAST',
        },
      ],
      scope: { jurisdiction: 'GH', currencies: [GHS], corridor: 'GH>NG' },
      window: { opensAt: 1_000n, closesAt: 10_000_000n },
      limits: { budgetCap: usd(1_000_000n), maxAbuseIncidents: 10n, maxRiskIncidents: 5n },
      privacyFairnessConstraints: ['no per-actor identity disclosure in public read models'],
      stopConditions: [
        { kind: 'BUDGET_EXHAUSTED', rationale: 'no budget left to fund interventions' },
        { kind: 'ABUSE_THRESHOLD', rationale: 'gaming exceeds tolerance' },
        { kind: 'TARGET_MET', rationale: 'goal achieved — normalize emissions' },
      ],
      interventions: [
        {
          kind: 'INCENTIVE',
          description: 'fee rebate for first verified completed A2A payment',
          budgetDraw: usd(400_000n),
        },
        {
          kind: 'TRUST_MECHANISM',
          description: 'network-funded guarantee on first-payment recourse',
        },
        { kind: 'INFORMATION', description: 'transparent settlement receipts in-app' },
      ],
    },
    { ids: ids() },
  );
}

describe('goals: ParticipationGoal (W3-004 §3.1)', () => {
  it('defines a goal with non-incentive interventions (broader than a reward engine)', () => {
    const goal = goalFixture();
    expect(goal.targetActorClasses).toEqual(['SENDER', 'MERCHANT']);
    const kinds = goal.interventions.map((intervention) => intervention.kind);
    expect(kinds).toContain('INCENTIVE');
    expect(kinds).toContain('TRUST_MECHANISM');
    expect(kinds).toContain('INFORMATION');
    expect(Object.isFrozen(goal)).toBe(true);
  });

  it('rejects malformed goals deterministically', () => {
    const base = goalFixture;
    expect(() =>
      defineParticipationGoal(
        {
          window: { opensAt: 10n, closesAt: 1n },
          title: 'x',
          description: 'x',
          bottleneck: { description: 'x', scarceResource: 'TRUST' },
          targetActorClasses: ['SENDER'],
          successMeasures: [{ name: 'm', description: 'm', target: 1n, direction: 'AT_LEAST' }],
          scope: { jurisdiction: 'GH', currencies: [] },
          limits: { budgetCap: usd(1n), maxAbuseIncidents: 1n, maxRiskIncidents: 1n },
        },
        { ids: ids() },
      ),
    ).toThrow();
    expect(() =>
      defineParticipationGoal(
        {
          title: 'x',
          description: 'x',
          // @ts-expect-error unknown scarce resource
          bottleneck: { description: 'x', scarceResource: 'VIBES' },
          targetActorClasses: ['SENDER'],
          successMeasures: [{ name: 'm', description: 'm', target: 1n, direction: 'AT_LEAST' }],
          scope: { jurisdiction: 'GH', currencies: [] },
          window: { opensAt: 1n, closesAt: 2n },
          limits: { budgetCap: usd(1n), maxAbuseIncidents: 1n, maxRiskIncidents: 1n },
        },
        { ids: ids() },
      ),
    ).toThrow();
    expect(() =>
      defineParticipationGoal(
        {
          title: 'x',
          description: 'x',
          bottleneck: { description: 'x', scarceResource: 'TRUST' },
          // @ts-expect-error unknown actor class
          targetActorClasses: ['WIZARD'],
          successMeasures: [{ name: 'm', description: 'm', target: 1n, direction: 'AT_LEAST' }],
          scope: { jurisdiction: 'GH', currencies: [] },
          window: { opensAt: 1n, closesAt: 2n },
          limits: { budgetCap: usd(1n), maxAbuseIncidents: 1n, maxRiskIncidents: 1n },
        },
        { ids: ids() },
      ),
    ).toThrow();
    expect(() => base()).toBeDefined();
  });

  it('rejects budget draws on non-incentive interventions', () => {
    expect(() =>
      defineParticipationGoal(
        {
          title: 'x',
          description: 'x',
          bottleneck: { description: 'x', scarceResource: 'TRUST' },
          targetActorClasses: ['SENDER'],
          successMeasures: [{ name: 'm', description: 'm', target: 1n, direction: 'AT_LEAST' }],
          scope: { jurisdiction: 'GH', currencies: [] },
          window: { opensAt: 1n, closesAt: 2n },
          limits: { budgetCap: usd(1_000n), maxAbuseIncidents: 1n, maxRiskIncidents: 1n },
          interventions: [
            { kind: 'CAPABILITY', description: 'one-click rails', budgetDraw: usd(10n) },
          ],
        },
        { ids: ids() },
      ),
    ).toThrow(/budgetDraw/);
  });

  it('evaluates stop conditions deterministically (same reading → same result)', () => {
    const goal = goalFixture();
    const reading: GoalReading = {
      spend: usd(500_000n),
      abuseIncidents: 3n,
      riskIncidents: 0n,
      measures: new Map([['adopted_senders', 120n]]),
      asOf: 5_000n,
    };
    const first = evaluateStopConditions(goal, reading);
    const second = evaluateStopConditions(goal, reading);
    expect(first.stopped).toBe(false);
    expect(first.fired).toEqual([]);
    expect(second).toEqual(first);

    const exhausted = evaluateStopConditions(goal, {
      ...reading,
      spend: usd(1_000_000n),
    });
    expect(exhausted.stopped).toBe(true);
    expect(exhausted.fired.map((condition) => condition.kind)).toEqual(['BUDGET_EXHAUSTED']);

    const achieved = evaluateStopConditions(goal, {
      ...reading,
      measures: new Map([['adopted_senders', 600n]]),
    });
    expect(achieved.fired.map((condition) => condition.kind)).toEqual(['TARGET_MET']);

    // Both firing → both reported, in declared order.
    const both = evaluateStopConditions(goal, {
      spend: usd(1_000_000n),
      abuseIncidents: 10n,
      riskIncidents: 0n,
      measures: new Map([['adopted_senders', 600n]]),
      asOf: 5_000n,
    });
    expect(both.fired.map((condition) => condition.kind)).toEqual([
      'BUDGET_EXHAUSTED',
      'ABUSE_THRESHOLD',
      'TARGET_MET',
    ]);
  });
});
