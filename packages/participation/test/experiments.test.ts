import { describe, expect, it } from 'vitest';
import { createIdFactory, DeterministicClock, asPartyId } from '@payswap/protocol';
import {
  assignCohort,
  defineParticipationExperiment,
  declaredFabricableBehaviors,
  evaluateGuardrails,
  REQUIRED_GAMING_SURFACES,
  type ExperimentReading,
  type ParticipationExperiment,
} from '../src/experiments.js';
import { asParticipationGoalId } from '../src/goals.js';
import { usd } from './helpers.js';

function ids() {
  return createIdFactory(new DeterministicClock(1_000n));
}

const GOAL = asParticipationGoalId('goal_1_1');

function surfacesFor(kind: keyof typeof REQUIRED_GAMING_SURFACES) {
  const required = REQUIRED_GAMING_SURFACES[kind] ?? [];
  return required.map((surface) => ({
    surface,
    fabricableBehaviors:
      surface === 'raw_transaction_count'
        ? ['PAYMENT_SENT', 'PAYMENT_METHOD_ADOPTED']
        : surface === 'self_funded_adoption'
          ? ['PAYMENT_METHOD_ADOPTED']
          : [surface.toUpperCase()],
    requiresVerifiedOutcome: true,
    note: `surface ${surface} can be fabricated cheaply; only verified completions count`,
  }));
}

function experimentFixture(
  overrides?: Partial<Parameters<typeof defineParticipationExperiment>[0]>,
): ParticipationExperiment {
  return defineParticipationExperiment(
    {
      goalId: GOAL,
      hypothesis: 'A first-payment fee rebate raises verified A2A adoption vs control.',
      objective: {
        kind: 'PAYMENT_METHOD_ADOPTION',
        description: 'increase verified completed payments on newly adopted methods',
      },
      cohorts: [
        { name: 'control', allocationWeight: 1n, description: 'no treatment' },
        { name: 'treatment', allocationWeight: 1n, description: 'fee rebate' },
      ],
      comparison: 'AGAINST_CONTROL',
      treatment: {
        kind: 'INCENTIVE',
        description: 'first-payment fee rebate',
        programRef: { programId: 'prog_1', version: 1n },
      },
      attributionPlan: 'deterministic first-party contribution attribution from rail receipts',
      measurementWindow: { opensAt: 1_000n, closesAt: 10_000n },
      guardrails: [
        { kind: 'MAX_ABUSE_FLAGS', threshold: 20n, description: 'stop on abuse flags' },
        { kind: 'MIN_OUTCOME_QUALITY', threshold: 8_000n, description: '≥80% verified outcomes' },
      ],
      budget: { cap: usd(50_000n), funderRef: asPartyId('sponsor-1') },
      evaluationMethod: 'DETERMINISTIC_COMPARISON',
      gamingSurfaces: surfacesFor('PAYMENT_METHOD_ADOPTION'),
      ...overrides,
    },
    { ids: ids() },
  );
}

describe('experiments: objective optimization without raw-activity rewards', () => {
  it('defines an incentive experiment that declares the required gaming surfaces', () => {
    const experiment = experimentFixture();
    expect(experiment.objective.kind).toBe('PAYMENT_METHOD_ADOPTION');
    expect(experiment.gamingSurfaces.map((surface) => surface.surface)).toEqual(
      REQUIRED_GAMING_SURFACES.PAYMENT_METHOD_ADOPTION,
    );
    expect(declaredFabricableBehaviors(experiment)).toContain('PAYMENT_METHOD_ADOPTED');
  });

  it('REJECTS incentive experiments that do not declare the required anti-gaming surfaces (W3-004)', () => {
    expect(() =>
      experimentFixture({
        gamingSurfaces: [
          {
            surface: 'raw_transaction_count',
            fabricableBehaviors: ['PAYMENT_SENT'],
            requiresVerifiedOutcome: true,
            note: 'partial declaration only',
          },
        ],
      }),
    ).toThrow(/raw artificial activity/);

    expect(() => experimentFixture({ gamingSurfaces: [] })).toThrow(
      /raw artificial activity/,
    );
  });

  it('accepts non-incentive treatments without gaming-surface declarations', () => {
    const experiment = experimentFixture({
      treatment: { kind: 'WORKFLOW', description: 'one-click onboarding' },
      gamingSurfaces: [],
    });
    expect(experiment.treatment.kind).toBe('WORKFLOW');
  });

  it('covers all five W3-004 objective kinds when surfaces are declared', () => {
    for (const kind of [
      'PAYMENT_METHOD_ADOPTION',
      'PAYMENT_ACCEPTANCE',
      'RECURRING_CONVERSION',
      'SETTLEMENT_RELIABILITY',
      'ROUTING_PREFERENCE',
    ] as const) {
      const experiment = experimentFixture({
        objective: { kind, description: `optimize ${kind}` },
        treatment: { kind: 'INCENTIVE', description: 'incentive treatment' },
        gamingSurfaces: surfacesFor(kind),
      });
      expect(experiment.objective.kind).toBe(kind);
    }
  });

  it('assigns cohorts deterministically — identical inputs, identical cohort, run after run', () => {
    const experiment = experimentFixture();
    const actors = Array.from({ length: 24 }, (_, index) => asPartyId(`sender-${index}`));
    const firstRun = actors.map((actor) => assignCohort(experiment, actor).name);
    const secondRun = actors.map((actor) => assignCohort(experiment, actor).name);
    expect(firstRun).toEqual(secondRun);
    for (const name of firstRun) {
      expect(['control', 'treatment']).toContain(name);
    }
    // With 24 actors and a 1:1 weight split, both cohorts receive members
    // (deterministic — if this ever fails it fails identically on every run).
    expect(new Set(firstRun).size).toBe(2);
    // A fresh experiment object with the same declared shape assigns the same
    // actor to the same cohort (assignment depends only on experiment.id +
    // actor + weights; the minted id is identical for the same clock/order).
    const twin = experimentFixture();
    expect(assignCohort(twin, actors[0] ?? asPartyId('sender-0')).name).toBe(firstRun[0]);
  });

  it('evaluates guardrails deterministically', () => {
    const experiment = experimentFixture();
    const reading: ExperimentReading = {
      asOf: 5_000n,
      abuseFlagCount: 5n,
      spend: usd(1_000n),
      verifiedOutcomeCount: 90n,
      totalOutcomeCount: 100n,
      outcomeDeltaBps: 250n,
    };
    const first = evaluateGuardrails(experiment, reading);
    const second = evaluateGuardrails(experiment, reading);
    expect(first.breached).toBe(false);
    expect(second).toEqual(first);

    const breached = evaluateGuardrails(experiment, {
      ...reading,
      abuseFlagCount: 25n,
      verifiedOutcomeCount: 50n,
      totalOutcomeCount: 100n,
    });
    expect(breached.breached).toBe(true);
    expect(breached.breachedGuardrails.map((guardrail) => guardrail.kind)).toEqual([
      'MAX_ABUSE_FLAGS',
      'MIN_OUTCOME_QUALITY',
    ]);
  });
});
