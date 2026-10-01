/**
 * @payswap/participation — participation experiments (W3-004).
 *
 * PARTICIPATION-ENGINEERING §ParticipationExperiment: hypothesis,
 * cohorts/comparison, treatment, attribution, measurement window,
 * guardrails, budget, evaluation method.
 *
 * W3-004 hard requirement: experiments optimize payment-method adoption,
 * acceptance, recurring conversion, settlement reliability and
 * merchant/customer routing preferences WITHOUT rewarding raw artificial
 * activity. This is enforced structurally: an experiment whose treatment is
 * an INCENTIVE must declare the anti-gaming surfaces its objective exposes
 * (`ArtificialActivitySurface`), and those declarations are exactly what the
 * W3-004 anti-gaming checks (§7, `anti-gaming.ts`) consume to flag farmed
 * behavior before any reward finalization (INV-P04).
 *
 * Determinism: cohort assignment is a pure function of the experiment id,
 * the actor id and the declared cohort weights — no randomness, no ambient
 * host state; identical inputs always land in the identical cohort.
 */

import {
  ValidationError,
  type IdFactory,
  type Money,
  type PartyId,
  type TimestampMs,
} from '@payswap/protocol';
import { stableDigest } from './digest.js';
import type { ParticipationGoalId } from './goals.js';

declare const ParticipationExperimentIdBrand: unique symbol;

/** Branded id of one participation experiment. */
export type ParticipationExperimentId = string & {
  readonly [ParticipationExperimentIdBrand]: 'ParticipationExperimentId';
};

/** Brand a validated string as a `ParticipationExperimentId`. */
export function asParticipationExperimentId(value: string): ParticipationExperimentId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('ParticipationExperimentId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new ValidationError('ParticipationExperimentId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError('ParticipationExperimentId must not carry surrounding whitespace', {
      value,
    });
  }
  return value as ParticipationExperimentId;
}

/**
 * The objective families experiments may optimize (W3-004): payment-method
 * adoption, acceptance, recurring conversion, settlement reliability, and
 * merchant/customer routing preferences.
 */
export type ExperimentObjectiveKind =
  | 'PAYMENT_METHOD_ADOPTION'
  | 'PAYMENT_ACCEPTANCE'
  | 'RECURRING_CONVERSION'
  | 'SETTLEMENT_RELIABILITY'
  | 'ROUTING_PREFERENCE';

/** The closed set of experiment objective kinds. */
export const EXPERIMENT_OBJECTIVE_KINDS: readonly ExperimentObjectiveKind[] = Object.freeze([
  'PAYMENT_METHOD_ADOPTION',
  'PAYMENT_ACCEPTANCE',
  'RECURRING_CONVERSION',
  'SETTLEMENT_RELIABILITY',
  'ROUTING_PREFERENCE',
]);

/**
 * Surfaces of an objective where raw artificial activity could be fabricated
 * cheaply (PARTICIPATION-ENGINEERING §Anti-gaming threat model: wash
 * transactions, low-quality volume, artificial churn, reward farming…).
 */
export interface ArtificialActivitySurface {
  /** Stable surface name, e.g. `raw_transaction_count`. */
  readonly surface: string;
  /** Behavior codes that fabricate this surface, e.g. `PAYMENT_SENT`. */
  readonly fabricableBehaviors: readonly string[];
  /** Whether contributions on this surface only count when verified completed. */
  readonly requiresVerifiedOutcome: boolean;
  /** Why this surface is gameable (auditable rationale). */
  readonly note: string;
}

/**
 * Required anti-gaming surface declarations per objective kind. An INCENTIVE
 * experiment MUST declare every required surface for its objective — this is
 * the structural "no rewarding raw artificial activity" gate.
 */
export const REQUIRED_GAMING_SURFACES: Readonly<Record<ExperimentObjectiveKind, readonly string[]>> =
  Object.freeze({
    PAYMENT_METHOD_ADOPTION: Object.freeze(['raw_transaction_count', 'self_funded_adoption']),
    PAYMENT_ACCEPTANCE: Object.freeze(['raw_merchant_signup', 'self_deal_acceptance']),
    RECURRING_CONVERSION: Object.freeze(['mandate_churn_cycling']),
    SETTLEMENT_RELIABILITY: Object.freeze(['fabricated_settlement_attempts']),
    ROUTING_PREFERENCE: Object.freeze(['self_routed_volume']),
  });

/** The experiment's objective declaration. */
export interface ExperimentObjective {
  readonly kind: ExperimentObjectiveKind;
  readonly description: string;
}

/** A named cohort with a deterministic allocation weight. */
export interface CohortDefinition {
  /** Stable cohort name, e.g. `control`, `treatment_a`. */
  readonly name: string;
  /** Non-negative integer weight (0 = reserved, never assigned). */
  readonly allocationWeight: bigint;
  readonly description?: string;
}

/** Comparison design of the experiment. */
export type ExperimentComparison = 'AGAINST_CONTROL' | 'AGAINST_BASELINE' | 'SWITCHBACK';

/** What the experiment changes. */
export interface TreatmentDeclaration {
  readonly kind: 'INCENTIVE' | 'CAPABILITY' | 'WORKFLOW' | 'TRUST_MECHANISM' | 'INFORMATION';
  readonly description: string;
  /** For INCENTIVE treatments: the incentive program (id + version) applied. */
  readonly programRef?: { readonly programId: string; readonly version: bigint };
}

/** Deterministic guardrail kinds evaluated over experiment readings. */
export type ExperimentGuardrailKind =
  | 'MAX_ABUSE_FLAGS'
  | 'MAX_BUDGET_SPEND'
  | 'MIN_OUTCOME_QUALITY'
  | 'MAX_REGRESSION_VS_CONTROL';

/** One declared guardrail. */
export interface ExperimentGuardrail {
  readonly kind: ExperimentGuardrailKind;
  /** Threshold value semantics depend on the kind (documented per kind). */
  readonly threshold: bigint;
  readonly description: string;
}

/** Experiment budget declaration (the ceiling the experiment may draw). */
export interface ExperimentBudget {
  readonly cap: Money;
  /** Who funds the experiment draw (validated PartyId by callers). */
  readonly funderRef: PartyId;
}

/** Evaluation methods (deterministic, declared — no opaque scoring). */
export type ExperimentEvaluationMethod =
  | 'DETERMINISTIC_COMPARISON'
  | 'DIFF_IN_DIFF'
  | 'SWITCHBACK_COMPARISON'
  | 'THRESHOLD_DECISION';

/** A live reading of one experiment (deterministic inputs, injected time). */
export interface ExperimentReading {
  readonly asOf: TimestampMs;
  readonly abuseFlagCount: bigint;
  readonly spend: Money;
  readonly verifiedOutcomeCount: bigint;
  readonly totalOutcomeCount: bigint;
  /** Mean outcome delta vs comparison, in basis points (negative = regression). */
  readonly outcomeDeltaBps: bigint;
}

/** Result of evaluating guardrails over one reading. */
export interface GuardrailEvaluation {
  readonly breached: boolean;
  /** Breached guardrails in declared order. */
  readonly breachedGuardrails: readonly ExperimentGuardrail[];
}

/** A participation experiment (PARTICIPATION-ENGINEERING §ParticipationExperiment). */
export interface ParticipationExperiment {
  readonly id: ParticipationExperimentId;
  readonly goalId: ParticipationGoalId;
  readonly hypothesis: string;
  readonly objective: ExperimentObjective;
  readonly cohorts: readonly CohortDefinition[];
  readonly comparison: ExperimentComparison;
  readonly treatment: TreatmentDeclaration;
  /** How attribution will be computed for measured contributions. */
  readonly attributionPlan: string;
  readonly measurementWindow: { readonly opensAt: TimestampMs; readonly closesAt: TimestampMs };
  readonly guardrails: readonly ExperimentGuardrail[];
  readonly budget: ExperimentBudget;
  readonly evaluationMethod: ExperimentEvaluationMethod;
  /**
   * Anti-gaming surfaces this experiment declares (W3-004: consumed by
   * `runAntiGamingChecks` — contributions on fabricable behaviors that are
   * not verified completions are flagged as RAW_ARTIFICIAL_ACTIVITY).
   */
  readonly gamingSurfaces: readonly ArtificialActivitySurface[];
}

/** Input shape for `defineParticipationExperiment` (id is minted). */
export interface ParticipationExperimentSpec {
  readonly goalId: ParticipationGoalId;
  readonly hypothesis: string;
  readonly objective: ExperimentObjective;
  readonly cohorts: readonly CohortDefinition[];
  readonly comparison: ExperimentComparison;
  readonly treatment: TreatmentDeclaration;
  readonly attributionPlan: string;
  readonly measurementWindow: { readonly opensAt: TimestampMs; readonly closesAt: TimestampMs };
  readonly guardrails?: readonly ExperimentGuardrail[];
  readonly budget: ExperimentBudget;
  readonly evaluationMethod: ExperimentEvaluationMethod;
  readonly gamingSurfaces: readonly ArtificialActivitySurface[];
}

/**
 * Deterministic cohort assignment: a pure function of
 * (experiment id, actor id, cohort weights). The actor's digest position
 * within the total weight selects the cohort — identical inputs always
 * produce the identical assignment, on every run, on every platform.
 */
export function assignCohort(
  experiment: ParticipationExperiment,
  actor: PartyId,
): CohortDefinition {
  const positive = experiment.cohorts.filter((cohort) => cohort.allocationWeight > 0n);
  if (positive.length === 0) {
    throw new ValidationError('experiment has no cohort with a positive allocation weight');
  }
  let totalWeight = 0n;
  for (const cohort of positive) {
    totalWeight += cohort.allocationWeight;
  }
  const digest = stableDigest([experiment.id, actor]);
  // Position in [0, totalWeight): fold digest hex characters deterministically.
  let position = 0n;
  for (let index = 0; index < digest.length; index += 1) {
    const code = BigInt(digest.charCodeAt(index));
    position = (position * 16n + (code % 16n)) % totalWeight;
  }
  let cumulative = 0n;
  for (const cohort of positive) {
    cumulative += cohort.allocationWeight;
    if (position < cumulative) {
      return cohort;
    }
  }
  // Unreachable: weights sum to totalWeight and position < totalWeight.
  const last = positive[positive.length - 1];
  if (last === undefined) {
    throw new ValidationError('experiment cohort resolution failed');
  }
  return last;
}

/** Deterministically evaluate the experiment's guardrails over one reading. */
export function evaluateGuardrails(
  experiment: ParticipationExperiment,
  reading: ExperimentReading,
): GuardrailEvaluation {
  const breached: ExperimentGuardrail[] = [];
  for (const guardrail of experiment.guardrails) {
    let hit = false;
    switch (guardrail.kind) {
      case 'MAX_ABUSE_FLAGS':
        hit = reading.abuseFlagCount >= guardrail.threshold;
        break;
      case 'MAX_BUDGET_SPEND':
        hit = reading.spend.value >= guardrail.threshold;
        break;
      case 'MIN_OUTCOME_QUALITY':
        if (reading.totalOutcomeCount > 0n) {
          hit = (reading.verifiedOutcomeCount * 10_000n) / reading.totalOutcomeCount < guardrail.threshold;
        }
        break;
      case 'MAX_REGRESSION_VS_CONTROL':
        hit = -reading.outcomeDeltaBps >= guardrail.threshold;
        break;
    }
    if (hit) {
      breached.push(guardrail);
    }
  }
  return Object.freeze({
    breached: breached.length > 0,
    breachedGuardrails: Object.freeze([...breached]),
  });
}

/** Flatten all fabricable behaviors declared by an experiment's surfaces. */
export function declaredFabricableBehaviors(
  experiment: ParticipationExperiment,
): readonly string[] {
  const behaviors = new Set<string>();
  for (const surface of experiment.gamingSurfaces) {
    for (const behavior of surface.fabricableBehaviors) {
      behaviors.add(behavior);
    }
  }
  return Object.freeze([...behaviors]);
}

function validateGamingSurface(
  surface: ArtificialActivitySurface,
  index: number,
): ArtificialActivitySurface {
  if (surface === null || typeof surface !== 'object') {
    throw new ValidationError(`gamingSurfaces[${index}] must be an ArtificialActivitySurface`);
  }
  if (typeof surface.surface !== 'string' || surface.surface.length === 0) {
    throw new ValidationError(`gamingSurfaces[${index}].surface must be a non-empty string`);
  }
  if (surface.surface.length > 128) {
    throw new ValidationError(`gamingSurfaces[${index}].surface exceeds 128 characters`);
  }
  if (!Array.isArray(surface.fabricableBehaviors) || surface.fabricableBehaviors.length === 0) {
    throw new ValidationError(
      `gamingSurfaces[${index}].fabricableBehaviors must be a non-empty array`,
    );
  }
  for (const behavior of surface.fabricableBehaviors) {
    if (typeof behavior !== 'string' || behavior.length === 0) {
      throw new ValidationError('fabricable behaviors must be non-empty strings');
    }
  }
  if (typeof surface.requiresVerifiedOutcome !== 'boolean') {
    throw new ValidationError(`gamingSurfaces[${index}].requiresVerifiedOutcome must be boolean`);
  }
  if (typeof surface.note !== 'string' || surface.note.length === 0) {
    throw new ValidationError(`gamingSurfaces[${index}].note must be a non-empty string`);
  }
  return Object.freeze({
    surface: surface.surface,
    fabricableBehaviors: Object.freeze([...surface.fabricableBehaviors]),
    requiresVerifiedOutcome: surface.requiresVerifiedOutcome,
    note: surface.note,
  });
}

/**
 * Define (validate + freeze) one participation experiment. INCENTIVE
 * treatments must declare every required gaming surface for the objective
 * (W3-004: no rewarding raw artificial activity — structurally enforced).
 */
export function defineParticipationExperiment(
  spec: ParticipationExperimentSpec,
  deps: { readonly ids: IdFactory },
): ParticipationExperiment {
  if (spec === null || typeof spec !== 'object') {
    throw new ValidationError('spec must be a ParticipationExperimentSpec object');
  }
  if (spec.goalId === undefined || spec.goalId.length === 0) {
    throw new ValidationError('spec.goalId must reference a ParticipationGoal');
  }
  if (typeof spec.hypothesis !== 'string' || spec.hypothesis.length === 0) {
    throw new ValidationError('spec.hypothesis must be a non-empty string');
  }
  if (spec.hypothesis.length > 4096) {
    throw new ValidationError('spec.hypothesis exceeds 4096 characters');
  }
  if (spec.objective === null || typeof spec.objective !== 'object') {
    throw new ValidationError('spec.objective must be an ExperimentObjective');
  }
  if (!EXPERIMENT_OBJECTIVE_KINDS.includes(spec.objective.kind)) {
    throw new ValidationError('spec.objective.kind must be a known ExperimentObjectiveKind', {
      kind: spec.objective.kind,
    });
  }
  if (typeof spec.objective.description !== 'string' || spec.objective.description.length === 0) {
    throw new ValidationError('spec.objective.description must be a non-empty string');
  }
  if (!Array.isArray(spec.cohorts) || spec.cohorts.length < 2) {
    throw new ValidationError('spec.cohorts must contain at least two cohorts');
  }
  const cohortNames = new Set<string>();
  let totalWeight = 0n;
  for (const cohort of spec.cohorts) {
    if (cohort === null || typeof cohort !== 'object') {
      throw new ValidationError('spec.cohorts entries must be CohortDefinition objects');
    }
    if (typeof cohort.name !== 'string' || cohort.name.length === 0) {
      throw new ValidationError('spec.cohorts[].name must be a non-empty string');
    }
    if (cohortNames.has(cohort.name)) {
      throw new ValidationError('spec.cohorts[].name must be unique', { name: cohort.name });
    }
    cohortNames.add(cohort.name);
    if (typeof cohort.allocationWeight !== 'bigint' || cohort.allocationWeight < 0n) {
      throw new ValidationError('spec.cohorts[].allocationWeight must be a non-negative bigint');
    }
    totalWeight += cohort.allocationWeight;
    if (cohort.description !== undefined && typeof cohort.description !== 'string') {
      throw new ValidationError('spec.cohorts[].description must be a string when present');
    }
  }
  if (totalWeight <= 0n) {
    throw new ValidationError('spec.cohorts must carry a positive total allocation weight');
  }
  if (
    spec.comparison !== 'AGAINST_CONTROL' &&
    spec.comparison !== 'AGAINST_BASELINE' &&
    spec.comparison !== 'SWITCHBACK'
  ) {
    throw new ValidationError('spec.comparison must be a known ExperimentComparison');
  }
  if (spec.treatment === null || typeof spec.treatment !== 'object') {
    throw new ValidationError('spec.treatment must be a TreatmentDeclaration');
  }
  if (
    spec.treatment.kind !== 'INCENTIVE' &&
    spec.treatment.kind !== 'CAPABILITY' &&
    spec.treatment.kind !== 'WORKFLOW' &&
    spec.treatment.kind !== 'TRUST_MECHANISM' &&
    spec.treatment.kind !== 'INFORMATION'
  ) {
    throw new ValidationError('spec.treatment.kind is unknown', { kind: spec.treatment.kind });
  }
  if (typeof spec.treatment.description !== 'string' || spec.treatment.description.length === 0) {
    throw new ValidationError('spec.treatment.description must be a non-empty string');
  }
  if (spec.treatment.programRef !== undefined) {
    if (spec.treatment.kind !== 'INCENTIVE') {
      throw new ValidationError('spec.treatment.programRef is only valid for INCENTIVE treatments');
    }
    if (
      spec.treatment.programRef === null ||
      typeof spec.treatment.programRef !== 'object' ||
      typeof spec.treatment.programRef.programId !== 'string' ||
      spec.treatment.programRef.programId.length === 0 ||
      typeof spec.treatment.programRef.version !== 'bigint'
    ) {
      throw new ValidationError('spec.treatment.programRef must carry programId + bigint version');
    }
  }
  if (typeof spec.attributionPlan !== 'string' || spec.attributionPlan.length === 0) {
    throw new ValidationError('spec.attributionPlan must be a non-empty string');
  }
  if (
    spec.measurementWindow === null ||
    typeof spec.measurementWindow !== 'object' ||
    typeof spec.measurementWindow.opensAt !== 'bigint' ||
    typeof spec.measurementWindow.closesAt !== 'bigint' ||
    spec.measurementWindow.closesAt <= spec.measurementWindow.opensAt
  ) {
    throw new ValidationError('spec.measurementWindow must open before it closes (bigint bounds)');
  }
  const guardrails = spec.guardrails === undefined ? [] : spec.guardrails;
  if (!Array.isArray(guardrails)) {
    throw new ValidationError('spec.guardrails must be an array of ExperimentGuardrail');
  }
  for (const guardrail of guardrails) {
    if (guardrail === null || typeof guardrail !== 'object') {
      throw new ValidationError('spec.guardrails entries must be ExperimentGuardrail objects');
    }
    if (
      guardrail.kind !== 'MAX_ABUSE_FLAGS' &&
      guardrail.kind !== 'MAX_BUDGET_SPEND' &&
      guardrail.kind !== 'MIN_OUTCOME_QUALITY' &&
      guardrail.kind !== 'MAX_REGRESSION_VS_CONTROL'
    ) {
      throw new ValidationError('spec.guardrails[].kind is unknown', { kind: guardrail.kind });
    }
    if (typeof guardrail.threshold !== 'bigint' || guardrail.threshold < 0n) {
      throw new ValidationError('spec.guardrails[].threshold must be a non-negative bigint');
    }
    if (typeof guardrail.description !== 'string' || guardrail.description.length === 0) {
      throw new ValidationError('spec.guardrails[].description must be a non-empty string');
    }
  }
  if (spec.budget === null || typeof spec.budget !== 'object') {
    throw new ValidationError('spec.budget must be an ExperimentBudget');
  }
  if (spec.budget.cap === null || typeof spec.budget.cap !== 'object') {
    throw new ValidationError('spec.budget.cap must be Money');
  }
  if (typeof spec.budget.cap.value !== 'bigint') {
    throw new ValidationError('spec.budget.cap must carry exact bigint value (INV-F01)');
  }
  if (spec.budget.cap.value < 0n) {
    throw new ValidationError('spec.budget.cap must be non-negative');
  }
  if (typeof spec.budget.funderRef !== 'string' || spec.budget.funderRef.length === 0) {
    throw new ValidationError('spec.budget.funderRef must be a PartyId');
  }
  if (
    spec.evaluationMethod !== 'DETERMINISTIC_COMPARISON' &&
    spec.evaluationMethod !== 'DIFF_IN_DIFF' &&
    spec.evaluationMethod !== 'SWITCHBACK_COMPARISON' &&
    spec.evaluationMethod !== 'THRESHOLD_DECISION'
  ) {
    throw new ValidationError('spec.evaluationMethod is unknown');
  }
  if (!Array.isArray(spec.gamingSurfaces)) {
    throw new ValidationError('spec.gamingSurfaces must be an array of ArtificialActivitySurface');
  }
  const surfaces = spec.gamingSurfaces.map((surface, index) => validateGamingSurface(surface, index));
  const surfaceNames = new Set(surfaces.map((surface) => surface.surface));

  // W3-004 structural rule: INCENTIVE treatments must declare every required
  // anti-gaming surface for the objective — otherwise the experiment could
  // reward raw artificial activity.
  if (spec.treatment.kind === 'INCENTIVE') {
    const required = REQUIRED_GAMING_SURFACES[spec.objective.kind];
    if (required === undefined) {
      throw new ValidationError('objective kind carries no required-surface declaration');
    }
    const missing = required.filter((surface) => !surfaceNames.has(surface));
    if (missing.length > 0) {
      throw new ValidationError(
        'INCENTIVE experiments must declare all required anti-gaming surfaces for their objective (W3-004: no rewarding raw artificial activity)',
        { objective: spec.objective.kind, missing: missing.join(',') },
      );
    }
  }

  return Object.freeze({
    id: asParticipationExperimentId(deps.ids.mintId('exp')),
    goalId: spec.goalId,
    hypothesis: spec.hypothesis,
    objective: Object.freeze({
      kind: spec.objective.kind,
      description: spec.objective.description,
    }),
    cohorts: Object.freeze(
      spec.cohorts.map((cohort) =>
        Object.freeze({
          name: cohort.name,
          allocationWeight: cohort.allocationWeight,
          ...(cohort.description !== undefined ? { description: cohort.description } : {}),
        }),
      ),
    ),
    comparison: spec.comparison,
    treatment: Object.freeze({
      kind: spec.treatment.kind,
      description: spec.treatment.description,
      ...(spec.treatment.programRef !== undefined
        ? { programRef: Object.freeze({ ...spec.treatment.programRef }) }
        : {}),
    }),
    attributionPlan: spec.attributionPlan,
    measurementWindow: Object.freeze({
      opensAt: spec.measurementWindow.opensAt,
      closesAt: spec.measurementWindow.closesAt,
    }),
    guardrails: Object.freeze(guardrails.map((guardrail) => Object.freeze({ ...guardrail }))),
    budget: Object.freeze({ cap: spec.budget.cap, funderRef: spec.budget.funderRef }),
    evaluationMethod: spec.evaluationMethod,
    gamingSurfaces: Object.freeze(surfaces),
  });
}
