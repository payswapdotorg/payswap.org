/**
 * @payswap/participation — ParticipationGoal (W3-004).
 *
 * PARTICIPATION-ENGINEERING §Purpose: the network must discover ways to
 * increase useful participation when an ECONOMIC GOAL is blocked by scarce
 * actors, capacity, liquidity, trust, information or operational effort.
 *
 * A ParticipationGoal names the scarce behavior/bottleneck, the target actor
 * population, the desired useful outcome, the jurisdiction/scope, the time
 * window, budget/risk limits, privacy/fairness constraints and stop
 * conditions.
 *
 * This is deliberately BROADER than a reward engine: the best intervention
 * may be an incentive, a new capability, a better workflow, lower friction,
 * a cooperative pool, better information, or a safer trust mechanism — the
 * goal model therefore carries intervention declarations of ALL these kinds,
 * not only rewards (W3-004 §3.1).
 */

import {
  asPartyId,
  fromMinorUnits,
  ValidationError,
  type CurrencyCode,
  type IdFactory,
  type Money,
  type PartyId,
  type TimestampMs,
} from '@payswap/protocol';

declare const ParticipationGoalIdBrand: unique symbol;

/** Branded id of one participation goal. */
export type ParticipationGoalId = string & {
  readonly [ParticipationGoalIdBrand]: 'ParticipationGoalId';
};

/** Brand a validated string as a `ParticipationGoalId`. */
export function asParticipationGoalId(value: string): ParticipationGoalId {
  return brandGoalId(value, 'ParticipationGoalId');
}

function brandGoalId(value: string, kind: string): ParticipationGoalId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${kind} must be a non-empty string`, { value });
  }
  if (value.length > 256) {
    throw new ValidationError(`${kind} exceeds 256 characters`, { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError(`${kind} must not carry surrounding whitespace`, { value });
  }
  return value as ParticipationGoalId;
}

/**
 * Actor classes (PARTICIPATION-ENGINEERING §Actor classes). Actors can hold
 * multiple roles; the closed vocabulary below is the single spelling used by
 * goals, experiments, programs, contributions and leaderboards.
 */
export type ActorClass =
  | 'SENDER'
  | 'RECIPIENT_BENEFICIARY'
  | 'MERCHANT'
  | 'LIQUIDITY_PROVIDER'
  | 'LENDER'
  | 'BORROWER'
  | 'MARKET_MAKER'
  | 'RAIL_PROVIDER'
  | 'DEVELOPER'
  | 'AGENT_PUBLISHER'
  | 'EXPERT_VERIFIER'
  | 'INTRODUCER_REFERRER'
  | 'GUARANTY_INSURER'
  | 'OPERATOR';

/** The closed set of actor classes. */
export const ACTOR_CLASSES: readonly ActorClass[] = Object.freeze([
  'SENDER',
  'RECIPIENT_BENEFICIARY',
  'MERCHANT',
  'LIQUIDITY_PROVIDER',
  'LENDER',
  'BORROWER',
  'MARKET_MAKER',
  'RAIL_PROVIDER',
  'DEVELOPER',
  'AGENT_PUBLISHER',
  'EXPERT_VERIFIER',
  'INTRODUCER_REFERRER',
  'GUARANTY_INSURER',
  'OPERATOR',
]);

/** What is scarce and blocking the economic goal. */
export type ScarceResource =
  | 'ACTORS'
  | 'CAPACITY'
  | 'LIQUIDITY'
  | 'TRUST'
  | 'INFORMATION'
  | 'EFFORT';

/** The closed set of scarce resources. */
export const SCARCE_RESOURCES: readonly ScarceResource[] = Object.freeze([
  'ACTORS',
  'CAPACITY',
  'LIQUIDITY',
  'TRUST',
  'INFORMATION',
  'EFFORT',
]);

/**
 * Intervention families (PARTICIPATION-ENGINEERING §Purpose): incentives are
 * ONE option, not the only one.
 */
export type InterventionKind =
  | 'INCENTIVE'
  | 'CAPABILITY'
  | 'WORKFLOW'
  | 'TRUST_MECHANISM'
  | 'INFORMATION'
  | 'COOPERATIVE_POOL';

/** The closed set of intervention kinds. */
export const INTERVENTION_KINDS: readonly InterventionKind[] = Object.freeze([
  'INCENTIVE',
  'CAPABILITY',
  'WORKFLOW',
  'TRUST_MECHANISM',
  'INFORMATION',
  'COOPERATIVE_POOL',
]);

/** The declared bottleneck blocking the economic goal. */
export interface BottleneckDeclaration {
  /** Human-readable description of the scarce behavior or bottleneck. */
  readonly description: string;
  /** Which scarce resource class is binding. */
  readonly scarceResource: ScarceResource;
}

/** Jurisdiction / corridor / currency scope of the goal. */
export interface ParticipationScope {
  /** Jurisdiction or regulatory scope identifier (e.g. `EU`, `GH`). */
  readonly jurisdiction: string;
  /** Currencies the goal covers (empty/omitted = all). */
  readonly currencies: readonly CurrencyCode[];
  /** Optional corridor description (e.g. `GH>NG`). */
  readonly corridor?: string;
}

/** How success of the goal is measured (target + measure semantics). */
export interface SuccessMeasure {
  /** Stable name of the measure (e.g. `adopted_senders`). */
  readonly name: string;
  /** What is being measured. */
  readonly description: string;
  /** Target value the goal wants to reach. */
  readonly target: bigint;
  /** Direction of improvement. */
  readonly direction: 'AT_LEAST' | 'AT_MOST';
}

/** Budget / risk limits bounding any intervention under this goal. */
export interface GoalLimits {
  /** Hard ceiling on incentive spending under this goal. */
  readonly budgetCap: Money;
  /** Maximum accepted abuse/flag incidents before a stop condition fires. */
  readonly maxAbuseIncidents: bigint;
  /** Maximum accepted operational risk incidents. */
  readonly maxRiskIncidents: bigint;
}

/** Deterministic stop-condition kinds (evaluated over a goal reading). */
export type StopConditionKind =
  | 'BUDGET_EXHAUSTED'
  | 'ABUSE_THRESHOLD'
  | 'RISK_THRESHOLD'
  | 'TARGET_MET'
  | 'DEADLINE_PASSED';

/** One declared stop condition. */
export interface StopCondition {
  readonly kind: StopConditionKind;
  /** Human-readable rationale. */
  readonly rationale: string;
}

/** Live reading of the goal's progress, fed by callers (deterministic input). */
export interface GoalReading {
  /** Incentive spend under the goal so far (exact). */
  readonly spend: Money;
  /** Anti-gaming flag/block incidents observed so far. */
  readonly abuseIncidents: bigint;
  /** Operational risk incidents observed so far. */
  readonly riskIncidents: bigint;
  /** Current value per success measure (missing = 0). */
  readonly measures: ReadonlyMap<string, bigint>;
  /** The reading's clock stamp (injected, never ambient). */
  readonly asOf: TimestampMs;
}

/** Result of evaluating a goal's stop conditions. */
export interface StopEvaluation {
  readonly stopped: boolean;
  /** Conditions that fired, in declared order. */
  readonly fired: readonly StopCondition[];
}

/** One declared intervention candidate under the goal. */
export interface InterventionDeclaration {
  readonly kind: InterventionKind;
  /** What the intervention changes (mechanism, capability, workflow, …). */
  readonly description: string;
  /** Declared budget draw for incentive interventions (must fit GoalLimits). */
  readonly budgetDraw?: Money;
}

/** A ParticipationGoal (PARTICIPATION-ENGINEERING §ParticipationGoal). */
export interface ParticipationGoal {
  readonly id: ParticipationGoalId;
  readonly title: string;
  readonly description: string;
  readonly bottleneck: BottleneckDeclaration;
  /** Target actor population. */
  readonly targetActorClasses: readonly ActorClass[];
  /** Desired useful outcomes. */
  readonly successMeasures: readonly SuccessMeasure[];
  readonly scope: ParticipationScope;
  readonly window: { readonly opensAt: TimestampMs; readonly closesAt: TimestampMs };
  readonly limits: GoalLimits;
  /** Privacy/fairness hard constraints (INV-R03: privacy is a hard constraint). */
  readonly privacyFairnessConstraints: readonly string[];
  readonly stopConditions: readonly StopCondition[];
  /** Interventions may be incentives OR capability/workflow/trust/etc. */
  readonly interventions: readonly InterventionDeclaration[];
}

/** Input shape for `defineParticipationGoal` (id is minted). */
export interface ParticipationGoalSpec {
  readonly title: string;
  readonly description: string;
  readonly bottleneck: BottleneckDeclaration;
  readonly targetActorClasses: readonly ActorClass[];
  readonly successMeasures: readonly SuccessMeasure[];
  readonly scope: ParticipationScope;
  readonly window: { readonly opensAt: TimestampMs; readonly closesAt: TimestampMs };
  readonly limits: GoalLimits;
  readonly privacyFairnessConstraints?: readonly string[];
  readonly stopConditions?: readonly StopCondition[];
  readonly interventions?: readonly InterventionDeclaration[];
}

/** Deterministic evaluation of a goal's stop conditions over one reading. */
export function evaluateStopConditions(goal: ParticipationGoal, reading: GoalReading): StopEvaluation {
  const fired: StopCondition[] = [];
  for (const condition of goal.stopConditions) {
    let hit = false;
    switch (condition.kind) {
      case 'BUDGET_EXHAUSTED':
        hit = reading.spend.value >= goal.limits.budgetCap.value;
        break;
      case 'ABUSE_THRESHOLD':
        hit = reading.abuseIncidents >= goal.limits.maxAbuseIncidents;
        break;
      case 'RISK_THRESHOLD':
        hit = reading.riskIncidents >= goal.limits.maxRiskIncidents;
        break;
      case 'TARGET_MET':
        hit = goal.successMeasures.every((measure) => {
          const current = reading.measures.get(measure.name) ?? 0n;
          return measure.direction === 'AT_LEAST' ? current >= measure.target : current <= measure.target;
        });
        break;
      case 'DEADLINE_PASSED':
        hit = reading.asOf >= goal.window.closesAt;
        break;
    }
    if (hit) {
      fired.push(condition);
    }
  }
  return Object.freeze({ stopped: fired.length > 0, fired: Object.freeze([...fired]) });
}

/** Validate and freeze one intervention declaration. */
function validateIntervention(
  intervention: InterventionDeclaration,
  goalLimits: GoalLimits,
  index: number,
  issues: string[],
): InterventionDeclaration {
  if (intervention === null || typeof intervention !== 'object') {
    throw new ValidationError(`interventions[${index}] must be an InterventionDeclaration`);
  }
  if (!INTERVENTION_KINDS.includes(intervention.kind)) {
    throw new ValidationError(`interventions[${index}].kind must be a known InterventionKind`, {
      kind: intervention.kind,
    });
  }
  if (typeof intervention.description !== 'string' || intervention.description.length === 0) {
    throw new ValidationError(`interventions[${index}].description must be a non-empty string`);
  }
  if (intervention.description.length > 2048) {
    throw new ValidationError(`interventions[${index}].description exceeds 2048 characters`);
  }
  const frozen: {
    -readonly [K in keyof InterventionDeclaration]: InterventionDeclaration[K];
  } = {
    kind: intervention.kind,
    description: intervention.description,
  };
  if (intervention.budgetDraw !== undefined) {
    if (intervention.kind !== 'INCENTIVE') {
      throw new ValidationError(
        `interventions[${index}].budgetDraw is only valid for INCENTIVE interventions`,
        { kind: intervention.kind },
      );
    }
    if (intervention.budgetDraw.value <= 0n) {
      throw new ValidationError(`interventions[${index}].budgetDraw must be positive Money`);
    }
    if (intervention.budgetDraw.currency !== goalLimits.budgetCap.currency) {
      throw new ValidationError('intervention budget draw currency differs from the goal budget cap', {
        draw: intervention.budgetDraw.currency,
        cap: goalLimits.budgetCap.currency,
      });
    }
    if (intervention.budgetDraw.value > goalLimits.budgetCap.value) {
      issues.push(
        `interventions[${index}].budgetDraw exceeds the goal budget cap (soft warning, stop condition guards spend)`,
      );
    }
    frozen.budgetDraw = intervention.budgetDraw;
  }
  return Object.freeze(frozen);
}

/**
 * Define (validate + freeze) one ParticipationGoal. The id is minted through
 * the injected id factory — never from entropy. All declared inputs are
 * validated up front; a goal is immutable once defined.
 */
export function defineParticipationGoal(
  spec: ParticipationGoalSpec,
  deps: { readonly ids: IdFactory },
): ParticipationGoal {
  if (spec === null || typeof spec !== 'object') {
    throw new ValidationError('spec must be a ParticipationGoalSpec object');
  }
  if (typeof spec.title !== 'string' || spec.title.length === 0) {
    throw new ValidationError('spec.title must be a non-empty string');
  }
  if (spec.title.length > 256) {
    throw new ValidationError('spec.title exceeds 256 characters');
  }
  if (typeof spec.description !== 'string' || spec.description.length === 0) {
    throw new ValidationError('spec.description must be a non-empty string');
  }
  if (spec.description.length > 4096) {
    throw new ValidationError('spec.description exceeds 4096 characters');
  }
  if (spec.bottleneck === null || typeof spec.bottleneck !== 'object') {
    throw new ValidationError('spec.bottleneck must be a BottleneckDeclaration');
  }
  if (
    typeof spec.bottleneck.description !== 'string' ||
    spec.bottleneck.description.length === 0 ||
    spec.bottleneck.description.length > 2048
  ) {
    throw new ValidationError('spec.bottleneck.description must be 1..2048 characters');
  }
  if (!SCARCE_RESOURCES.includes(spec.bottleneck.scarceResource)) {
    throw new ValidationError('spec.bottleneck.scarceResource must be a known ScarceResource', {
      scarceResource: spec.bottleneck.scarceResource,
    });
  }
  if (!Array.isArray(spec.targetActorClasses) || spec.targetActorClasses.length === 0) {
    throw new ValidationError('spec.targetActorClasses must be a non-empty array');
  }
  for (const actorClass of spec.targetActorClasses) {
    if (!ACTOR_CLASSES.includes(actorClass)) {
      throw new ValidationError('spec.targetActorClasses contains an unknown ActorClass', {
        actorClass,
      });
    }
  }
  if (new Set(spec.targetActorClasses).size !== spec.targetActorClasses.length) {
    throw new ValidationError('spec.targetActorClasses must not repeat an actor class');
  }
  if (!Array.isArray(spec.successMeasures) || spec.successMeasures.length === 0) {
    throw new ValidationError('spec.successMeasures must be a non-empty array');
  }
  const measureNames = new Set<string>();
  for (const measure of spec.successMeasures) {
    if (measure === null || typeof measure !== 'object') {
      throw new ValidationError('spec.successMeasures entries must be SuccessMeasure objects');
    }
    if (typeof measure.name !== 'string' || measure.name.length === 0) {
      throw new ValidationError('spec.successMeasures[].name must be a non-empty string');
    }
    if (measureNames.has(measure.name)) {
      throw new ValidationError('spec.successMeasures[].name must be unique per goal', {
        name: measure.name,
      });
    }
    measureNames.add(measure.name);
    if (typeof measure.description !== 'string' || measure.description.length === 0) {
      throw new ValidationError('spec.successMeasures[].description must be a non-empty string');
    }
    if (typeof measure.target !== 'bigint') {
      throw new ValidationError('spec.successMeasures[].target must be a bigint');
    }
    if (measure.target <= 0n) {
      throw new ValidationError('spec.successMeasures[].target must be positive');
    }
    if (measure.direction !== 'AT_LEAST' && measure.direction !== 'AT_MOST') {
      throw new ValidationError('spec.successMeasures[].direction must be AT_LEAST or AT_MOST');
    }
  }
  if (spec.scope === null || typeof spec.scope !== 'object') {
    throw new ValidationError('spec.scope must be a ParticipationScope');
  }
  if (typeof spec.scope.jurisdiction !== 'string' || spec.scope.jurisdiction.length === 0) {
    throw new ValidationError('spec.scope.jurisdiction must be a non-empty string');
  }
  if (!Array.isArray(spec.scope.currencies)) {
    throw new ValidationError('spec.scope.currencies must be an array of CurrencyCode');
  }
  if (spec.scope.corridor !== undefined && (spec.scope.corridor.length === 0 || spec.scope.corridor.length > 128)) {
    throw new ValidationError('spec.scope.corridor must be 1..128 characters when present');
  }
  if (
    spec.window === null ||
    typeof spec.window !== 'object' ||
    typeof spec.window.opensAt !== 'bigint' ||
    typeof spec.window.closesAt !== 'bigint'
  ) {
    throw new ValidationError('spec.window bounds must be bigint TimestampMs');
  }
  if (spec.window.closesAt <= spec.window.opensAt) {
    throw new ValidationError('spec.window must close strictly after it opens');
  }
  if (spec.limits === null || typeof spec.limits !== 'object') {
    throw new ValidationError('spec.limits must be a GoalLimits object');
  }
  if (spec.limits.budgetCap === null || typeof spec.limits.budgetCap !== 'object') {
    throw new ValidationError('spec.limits.budgetCap must be Money');
  }
  if (typeof spec.limits.budgetCap.value !== 'bigint') {
    throw new ValidationError('spec.limits.budgetCap must carry exact bigint value (INV-F01)');
  }
  if (spec.limits.budgetCap.value < 0n) {
    throw new ValidationError('spec.limits.budgetCap must be non-negative');
  }
  if (typeof spec.limits.maxAbuseIncidents !== 'bigint' || typeof spec.limits.maxRiskIncidents !== 'bigint') {
    throw new ValidationError('spec.limits thresholds must be bigints');
  }
  if (spec.limits.maxAbuseIncidents < 0n || spec.limits.maxRiskIncidents < 0n) {
    throw new ValidationError('spec.limits thresholds must be non-negative');
  }
  const privacyConstraints =
    spec.privacyFairnessConstraints === undefined ? [] : spec.privacyFairnessConstraints;
  if (!Array.isArray(privacyConstraints)) {
    throw new ValidationError('spec.privacyFairnessConstraints must be an array of strings');
  }
  for (const constraint of privacyConstraints) {
    if (typeof constraint !== 'string' || constraint.length === 0 || constraint.length > 1024) {
      throw new ValidationError('privacy/fairness constraints must be 1..1024 characters');
    }
  }
  const stopConditions = spec.stopConditions === undefined ? [] : spec.stopConditions;
  if (!Array.isArray(stopConditions)) {
    throw new ValidationError('spec.stopConditions must be an array of StopCondition');
  }
  for (const condition of stopConditions) {
    if (condition === null || typeof condition !== 'object') {
      throw new ValidationError('spec.stopConditions entries must be StopCondition objects');
    }
    if (
      condition.kind !== 'BUDGET_EXHAUSTED' &&
      condition.kind !== 'ABUSE_THRESHOLD' &&
      condition.kind !== 'RISK_THRESHOLD' &&
      condition.kind !== 'TARGET_MET' &&
      condition.kind !== 'DEADLINE_PASSED'
    ) {
      throw new ValidationError('spec.stopConditions[].kind is unknown', { kind: condition.kind });
    }
    if (typeof condition.rationale !== 'string' || condition.rationale.length === 0) {
      throw new ValidationError('spec.stopConditions[].rationale must be a non-empty string');
    }
  }
  const interventions = spec.interventions === undefined ? [] : spec.interventions;
  if (!Array.isArray(interventions)) {
    throw new ValidationError('spec.interventions must be an array of InterventionDeclaration');
  }
  const issues: string[] = [];
  const frozenInterventions = interventions.map((intervention, index) =>
    validateIntervention(intervention, spec.limits, index, issues),
  );

  const goal: ParticipationGoal = Object.freeze({
    id: asParticipationGoalId(deps.ids.mintId('goal')),
    title: spec.title,
    description: spec.description,
    bottleneck: Object.freeze({
      description: spec.bottleneck.description,
      scarceResource: spec.bottleneck.scarceResource,
    }),
    targetActorClasses: Object.freeze([...spec.targetActorClasses]),
    successMeasures: Object.freeze(
      spec.successMeasures.map((measure) =>
        Object.freeze({
          name: measure.name,
          description: measure.description,
          target: measure.target,
          direction: measure.direction,
        }),
      ),
    ),
    scope: Object.freeze({
      jurisdiction: spec.scope.jurisdiction,
      currencies: Object.freeze([...spec.scope.currencies]),
      ...(spec.scope.corridor !== undefined ? { corridor: spec.scope.corridor } : {}),
    }),
    window: Object.freeze({ opensAt: spec.window.opensAt, closesAt: spec.window.closesAt }),
    limits: Object.freeze({
      budgetCap: spec.limits.budgetCap,
      maxAbuseIncidents: spec.limits.maxAbuseIncidents,
      maxRiskIncidents: spec.limits.maxRiskIncidents,
    }),
    privacyFairnessConstraints: Object.freeze([...privacyConstraints]),
    stopConditions: Object.freeze(
      stopConditions.map((condition) => Object.freeze({ ...condition })),
    ),
    interventions: Object.freeze(frozenInterventions),
  });
  return goal;
}

/**
 * Convenience: reference to a funder/sponsor actor, validated as a protocol
 * PartyId so goal, budget and obligation layers share one party vocabulary.
 */
export function asFunderRef(value: string): PartyId {
  return asPartyId(value);
}

/** Zero-value helper for goal budget projections in the goal's own currency. */
export function zeroIn(currency: CurrencyCode): Money {
  return fromMinorUnits(currency, 0n);
}
