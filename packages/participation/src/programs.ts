/**
 * @payswap/participation — IncentiveProgram and versioning (W3-004).
 *
 * PARTICIPATION-ENGINEERING §IncentiveProgram — every required field is
 * declared: sponsor/funder, objective, eligible actor role, eligibility
 * rules, contribution events, proof requirements, reward formula, budget and
 * reservation, emission/rate policy, caps/concentration limits, anti-Sybil/
 * anti-collusion policy, clawback/dispute policy, privacy rules, effective
 * period and version.
 *
 * INV-P07: incentive changes create NEW versions/effective epochs. A
 * `ProgramVersionRegistry` only ever APPENDS versions: registering a draft
 * creates version 1, `reviseProgram`/`pauseProgram`/`resumeProgram`/
 * `retireProgram` append new versions with strictly advancing effective
 * epochs. Old versions are immutable and remain retrievable forever — program
 * history is never rewritten (AGENTS.md rule 8).
 *
 * Reward formulas are declarative and exact (bigint basis points, Money
 * amounts) so reward calculations are reproducible from evidence plus the
 * program version (INV-P03) — every version carries a deterministic
 * `specDigest` fingerprint of its whole specification.
 */

import {
  ValidationError,
  type Money,
  type PartyId,
  type TimestampMs,
} from '@payswap/protocol';
import { stableDigest } from './digest.js';
import type { ActorClass } from './goals.js';
import type { ProofLevel } from './evidence.js';

declare const IncentiveProgramIdBrand: unique symbol;

/** Branded id of one incentive program (stable across versions). */
export type IncentiveProgramId = string & {
  readonly [IncentiveProgramIdBrand]: 'IncentiveProgramId';
};

/** Brand a validated string as an `IncentiveProgramId`. */
export function asIncentiveProgramId(value: string): IncentiveProgramId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('IncentiveProgramId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new ValidationError('IncentiveProgramId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError('IncentiveProgramId must not carry surrounding whitespace', { value });
  }
  return value as IncentiveProgramId;
}

/** Reference to one immutable program version (INV-P03 input). */
export interface ProgramVersionRef {
  readonly programId: IncentiveProgramId;
  readonly version: bigint;
}

/**
 * Mechanism families (PARTICIPATION-ENGINEERING §Mechanism library and
 * FROZEN §14). Random/lottery-like reward behavior is deliberately outside
 * the initial financial core and is NOT a declarable family here.
 */
export type MechanismFamily =
  | 'FEE_REBATE'
  | 'FEE_CREDIT'
  | 'INTEREST_BOOST'
  | 'INTEREST_DISCOUNT'
  | 'MATCHED_FUNDING'
  | 'THRESHOLD_BONUS'
  | 'CAPACITY_RIGHTS'
  | 'PRIORITY_RIGHTS'
  | 'REFERRAL'
  | 'COMPLETION_BOUNTY'
  | 'POINTS'
  | 'BADGE'
  | 'RECOGNITION'
  | 'REPUTATION_ATTESTATION'
  | 'BOND_SUBSIDY'
  | 'NETWORK_GUARANTEE'
  | 'COOPERATIVE_POOL';

/** The closed set of mechanism families. */
export const MECHANISM_FAMILIES: readonly MechanismFamily[] = Object.freeze([
  'FEE_REBATE',
  'FEE_CREDIT',
  'INTEREST_BOOST',
  'INTEREST_DISCOUNT',
  'MATCHED_FUNDING',
  'THRESHOLD_BONUS',
  'CAPACITY_RIGHTS',
  'PRIORITY_RIGHTS',
  'REFERRAL',
  'COMPLETION_BOUNTY',
  'POINTS',
  'BADGE',
  'RECOGNITION',
  'REPUTATION_ATTESTATION',
  'BOND_SUBSIDY',
  'NETWORK_GUARANTEE',
  'COOPERATIVE_POOL',
]);

/** Mechanism families whose rewards are monetary (create protocol obligations). */
export const MONETARY_MECHANISM_FAMILIES: readonly MechanismFamily[] = Object.freeze([
  'FEE_REBATE',
  'FEE_CREDIT',
  'INTEREST_BOOST',
  'INTEREST_DISCOUNT',
  'MATCHED_FUNDING',
  'THRESHOLD_BONUS',
  'BOND_SUBSIDY',
  'NETWORK_GUARANTEE',
  'COOPERATIVE_POOL',
  'COMPLETION_BOUNTY',
]);

/** Mechanism families whose rewards are non-monetary recognitions/points. */
export const NON_MONETARY_MECHANISM_FAMILIES: readonly MechanismFamily[] = Object.freeze([
  'CAPACITY_RIGHTS',
  'PRIORITY_RIGHTS',
  'REFERRAL',
  'POINTS',
  'BADGE',
  'RECOGNITION',
  'REPUTATION_ATTESTATION',
]);

/** Whether rewards under this mechanism family create protocol obligations. */
export function isMonetaryMechanism(mechanism: MechanismFamily): boolean {
  return MONETARY_MECHANISM_FAMILIES.includes(mechanism);
}

/**
 * Deterministic reward formulas (INV-P03: same inputs → same rewards).
 * All arithmetic is exact bigint minor-unit math — no floats (INV-F01).
 */
export type RewardFormula =
  /** A fixed Money amount per qualifying contribution. */
  | { readonly kind: 'FIXED_PER_CONTRIBUTION'; readonly amount: Money }
  /**
   * A declared fraction (basis points, 1 bp = 0.01%) of the contribution's
   * economic `value`, truncated toward zero, capped by `cap` when present.
   */
  | {
      readonly kind: 'PROPORTIONAL_OF_VALUE';
      readonly basisPoints: bigint;
      readonly cap?: Money;
    }
  /** The reward of the highest threshold the contribution quantity reaches. */
  | { readonly kind: 'TIERED_THRESHOLD'; readonly tiers: readonly RewardTier[] }
  /** A bounty awarded only when the contribution outcome is VERIFIED_COMPLETED. */
  | { readonly kind: 'COMPLETION_BOUNTY'; readonly amount: Money };

/** One tier of a TIERED_THRESHOLD formula. */
export interface RewardTier {
  /** Quantity (inclusive) at which this tier applies. */
  readonly atLeast: bigint;
  readonly amount: Money;
}

/**
 * Emission/rate policy (PARTICIPATION-ENGINEERING §Dynamic incentives):
 * boost below the target band, normalize inside the band, taper above it.
 * Multipliers are declared in basis points (10000 bp = 1.0x).
 */
export interface EmissionPolicy {
  readonly belowTargetMultiplierBps: bigint;
  readonly withinBandMultiplierBps: bigint;
  readonly aboveTargetMultiplierBps: bigint;
}

/** The emission regime a caller observes for the program's target metric. */
export type EmissionLevel = 'BELOW_TARGET' | 'WITHIN_BAND' | 'ABOVE_TARGET';

/** Resolve the declared multiplier (bps) for one emission level. */
export function resolveEmissionMultiplierBps(
  emission: EmissionPolicy | undefined,
  level: EmissionLevel,
): bigint {
  if (emission === undefined) {
    return 10_000n;
  }
  switch (level) {
    case 'BELOW_TARGET':
      return emission.belowTargetMultiplierBps;
    case 'WITHIN_BAND':
      return emission.withinBandMultiplierBps;
    case 'ABOVE_TARGET':
      return emission.aboveTargetMultiplierBps;
  }
}

/** Per-actor concentration limit (caps/concentration limits requirement). */
export interface ConcentrationLimit {
  /** Maximum share of the program budget one actor may accrue, in bp of total. */
  readonly maxShareBpsOfBudgetPerActor: bigint;
}

/** Declarative anti-Sybil/anti-collusion policy (executed by anti-gaming.ts). */
export interface AntiGamingPolicySpec {
  /** Max contributions by one actor per rolling window (velocity control). */
  readonly velocity?: { readonly maxContributions: bigint; readonly windowMs: bigint };
  /** Minimum distinct counterparties for one actor's history. */
  readonly minCounterpartyDiversity?: bigint;
  /** Whether self-referrals are forbidden (always recommended for REFERRAL). */
  readonly forbidSelfReferral: boolean;
  /** Whether declared identity-linkage clusters must be checked before rewards. */
  readonly requireIdentityLinkageChecks: boolean;
  /** Whether finalization must be delayed by a hold window (delayed finalization). */
  readonly delayedFinalization?: { readonly holdMs: bigint };
}

/** Clawback/dispute policy. */
export interface ClawbackPolicy {
  /** How long after qualification/claim a clawback may be declared. */
  readonly clawbackWindowMs: bigint;
  /** Whether a clawback requires a dispute/abuse record as evidence. */
  readonly requiresDisputeRecord: boolean;
}

/** Budget/reservation declaration (executed by budget.ts). */
export interface ProgramBudgetDeclaration {
  readonly totalAmount: Money;
  /**
   * INV-P01: monetary programs are either funded via a protocol reservation
   * before rewards become final, or EXPLICITLY contingent (rewards stay
   * provisional until funding arrives).
   */
  readonly funding: 'REQUIRES_FUNDED_RESERVATION' | 'EXPLICITLY_CONTINGENT';
}

/** Structured eligibility rules (deterministic evaluation). */
export type EligibilityRule =
  | { readonly kind: 'MIN_PROOF_LEVEL'; readonly level: ProofLevel }
  | { readonly kind: 'ACTOR_ROLE'; readonly role: ActorClass }
  | { readonly kind: 'JURISDICTION'; readonly value: string };

/** Program status within its effective epoch. */
export type ProgramStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'RETIRED';

/** One immutable program version (all PARTICIPATION-ENGINEERING fields). */
export interface IncentiveProgramVersion {
  readonly programId: IncentiveProgramId;
  readonly version: bigint;
  readonly status: ProgramStatus;
  /** Effective epoch start — a later version opens a strictly later epoch. */
  readonly effectiveFrom: TimestampMs;
  /** Sponsor/funder (PartyId — the debtor side of reward obligations). */
  readonly sponsor: PartyId;
  readonly objective: string;
  readonly eligibleRole: ActorClass;
  readonly eligibilityRules: readonly EligibilityRule[];
  /** Contribution event/behavior codes this program rewards. */
  readonly contributionEvents: readonly string[];
  readonly proofRequirements: { readonly minProofLevel: ProofLevel };
  readonly reward: {
    readonly mechanism: MechanismFamily;
    readonly formula: RewardFormula;
  };
  readonly budget: ProgramBudgetDeclaration;
  readonly emission?: EmissionPolicy;
  readonly perActorCap?: Money;
  readonly concentrationLimit?: ConcentrationLimit;
  readonly antiGamingPolicy: AntiGamingPolicySpec;
  readonly clawbackPolicy: ClawbackPolicy;
  readonly privacyRules: readonly string[];
  /** Version this version supersedes (absent on version 1). */
  readonly supersedesVersion?: bigint;
  /** Deterministic fingerprint of this exact version specification (INV-P03). */
  readonly specDigest: string;
}

/** Input shape for registering a new program (version 1). */
export interface IncentiveProgramDraft {
  readonly programId?: IncentiveProgramId;
  readonly effectiveFrom: TimestampMs;
  readonly sponsor: PartyId;
  readonly objective: string;
  readonly eligibleRole: ActorClass;
  readonly eligibilityRules: readonly EligibilityRule[];
  readonly contributionEvents: readonly string[];
  readonly proofRequirements: { readonly minProofLevel: ProofLevel };
  readonly reward: {
    readonly mechanism: MechanismFamily;
    readonly formula: RewardFormula;
  };
  readonly budget: ProgramBudgetDeclaration;
  readonly emission?: EmissionPolicy;
  readonly perActorCap?: Money;
  readonly concentrationLimit?: ConcentrationLimit;
  readonly antiGamingPolicy: AntiGamingPolicySpec;
  readonly clawbackPolicy: ClawbackPolicy;
  readonly privacyRules?: readonly string[];
}

/** Input shape for revising a program (creates a NEW version, INV-P07). */
export interface ProgramRevision {
  readonly programId: IncentiveProgramId;
  readonly effectiveFrom: TimestampMs;
  readonly status: ProgramStatus;
  readonly sponsor: PartyId;
  readonly objective: string;
  readonly eligibleRole: ActorClass;
  readonly eligibilityRules: readonly EligibilityRule[];
  readonly contributionEvents: readonly string[];
  readonly proofRequirements: { readonly minProofLevel: ProofLevel };
  readonly reward: {
    readonly mechanism: MechanismFamily;
    readonly formula: RewardFormula;
  };
  readonly budget: ProgramBudgetDeclaration;
  readonly emission?: EmissionPolicy;
  readonly perActorCap?: Money;
  readonly concentrationLimit?: ConcentrationLimit;
  readonly antiGamingPolicy: AntiGamingPolicySpec;
  readonly clawbackPolicy: ClawbackPolicy;
  readonly privacyRules?: readonly string[];
}

/** Unknown program / version in the registry. */
export class UnknownProgramError extends ValidationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.name = 'UnknownProgramError';
  }
}

/** A revision would not create a strictly advancing effective epoch. */
export class ProgramEpochViolationError extends ValidationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.name = 'ProgramEpochViolationError';
  }
}

function validateMoney(amount: Money, label: string): void {
  if (amount === null || typeof amount !== 'object') {
    throw new ValidationError(`${label} must be Money`);
  }
  if (typeof amount.value !== 'bigint') {
    throw new ValidationError(`${label} must carry exact bigint value (INV-F01)`, { label });
  }
}

function validateFormula(formula: RewardFormula, label: string, currency: string): Money | undefined {
  if (formula === null || typeof formula !== 'object') {
    throw new ValidationError(`${label} must be a RewardFormula`);
  }
  switch (formula.kind) {
    case 'FIXED_PER_CONTRIBUTION': {
      validateMoney(formula.amount, `${label}.amount`);
      if (formula.amount.value <= 0n) {
        throw new ValidationError(`${label}.amount must be positive`);
      }
      if (formula.amount.currency !== currency) {
        throw new ValidationError(`${label}.amount currency differs from the program budget`, {
          formula: formula.amount.currency,
          budget: currency,
        });
      }
      return formula.amount;
    }
    case 'PROPORTIONAL_OF_VALUE': {
      if (typeof formula.basisPoints !== 'bigint' || formula.basisPoints <= 0n) {
        throw new ValidationError(`${label}.basisPoints must be a positive bigint`);
      }
      if (formula.basisPoints > 1_000_000n) {
        throw new ValidationError(`${label}.basisPoints exceeds the 1,000,000 bp ceiling`);
      }
      if (formula.cap !== undefined) {
        validateMoney(formula.cap, `${label}.cap`);
        if (formula.cap.value <= 0n) {
          throw new ValidationError(`${label}.cap must be positive`);
        }
        if (formula.cap.currency !== currency) {
          throw new ValidationError(`${label}.cap currency differs from the program budget`);
        }
        return formula.cap;
      }
      return undefined;
    }
    case 'TIERED_THRESHOLD': {
      if (!Array.isArray(formula.tiers) || formula.tiers.length === 0) {
        throw new ValidationError(`${label}.tiers must be a non-empty array`);
      }
      let previous: bigint | undefined;
      let highest: RewardTier | undefined;
      for (const tier of formula.tiers) {
        if (tier === null || typeof tier !== 'object') {
          throw new ValidationError(`${label}.tiers entries must be RewardTier objects`);
        }
        if (typeof tier.atLeast !== 'bigint' || tier.atLeast <= 0n) {
          throw new ValidationError(`${label}.tiers[].atLeast must be a positive bigint`);
        }
        if (previous !== undefined && tier.atLeast <= previous) {
          throw new ValidationError(`${label}.tiers must be strictly ascending by atLeast`);
        }
        previous = tier.atLeast;
        highest = tier;
        validateMoney(tier.amount, `${label}.tiers[].amount`);
        if (tier.amount.value <= 0n) {
          throw new ValidationError(`${label}.tiers[].amount must be positive`);
        }
        if (tier.amount.currency !== currency) {
          throw new ValidationError(`${label}.tiers[].amount currency differs from the program budget`);
        }
      }
      return highest !== undefined ? highest.amount : undefined;
    }
    case 'COMPLETION_BOUNTY': {
      validateMoney(formula.amount, `${label}.amount`);
      if (formula.amount.value <= 0n) {
        throw new ValidationError(`${label}.amount must be positive`);
      }
      if (formula.amount.currency !== currency) {
        throw new ValidationError(`${label}.amount currency differs from the program budget`);
      }
      return formula.amount;
    }
  }
  throw new ValidationError(`${label}.kind is unknown`);
}

interface ValidatedVersionCore {
  readonly sponsor: PartyId;
  readonly objective: string;
  readonly eligibleRole: ActorClass;
  readonly eligibilityRules: readonly EligibilityRule[];
  readonly contributionEvents: readonly string[];
  readonly proofRequirements: { readonly minProofLevel: ProofLevel };
  readonly reward: { readonly mechanism: MechanismFamily; readonly formula: RewardFormula };
  readonly budget: ProgramBudgetDeclaration;
  readonly emission?: EmissionPolicy;
  readonly perActorCap?: Money;
  readonly concentrationLimit?: ConcentrationLimit;
  readonly antiGamingPolicy: AntiGamingPolicySpec;
  readonly clawbackPolicy: ClawbackPolicy;
  readonly privacyRules: readonly string[];
}

function validateVersionCore(
  core: IncentiveProgramDraft | ProgramRevision,
): ValidatedVersionCore {
  if (typeof core.sponsor !== 'string' || core.sponsor.length === 0) {
    throw new ValidationError('program sponsor must be a PartyId');
  }
  if (typeof core.objective !== 'string' || core.objective.length === 0) {
    throw new ValidationError('program objective must be a non-empty string');
  }
  if (core.objective.length > 2048) {
    throw new ValidationError('program objective exceeds 2048 characters');
  }
  if (typeof core.eligibleRole !== 'string' || !isActorClass(core.eligibleRole)) {
    throw new ValidationError('program eligibleRole must be a known ActorClass', {
      role: core.eligibleRole,
    });
  }
  if (!Array.isArray(core.eligibilityRules)) {
    throw new ValidationError('program eligibilityRules must be an array');
  }
  for (const rule of core.eligibilityRules) {
    if (rule === null || typeof rule !== 'object') {
      throw new ValidationError('eligibilityRules entries must be EligibilityRule objects');
    }
    if (
      rule.kind !== 'MIN_PROOF_LEVEL' &&
      rule.kind !== 'ACTOR_ROLE' &&
      rule.kind !== 'JURISDICTION'
    ) {
      throw new ValidationError('eligibilityRules[].kind is unknown', { kind: rule.kind });
    }
  }
  if (!Array.isArray(core.contributionEvents) || core.contributionEvents.length === 0) {
    throw new ValidationError('program contributionEvents must be a non-empty array');
  }
  for (const event of core.contributionEvents) {
    if (typeof event !== 'string' || event.length === 0) {
      throw new ValidationError('contributionEvents entries must be non-empty strings');
    }
  }
  if (new Set(core.contributionEvents).size !== core.contributionEvents.length) {
    throw new ValidationError('contributionEvents must not repeat an event');
  }
  if (
    core.proofRequirements === null ||
    typeof core.proofRequirements !== 'object' ||
    typeof core.proofRequirements.minProofLevel !== 'string'
  ) {
    throw new ValidationError('program proofRequirements.minProofLevel must be a ProofLevel');
  }
  const proofLevels: readonly string[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];
  if (!proofLevels.includes(core.proofRequirements.minProofLevel)) {
    throw new ValidationError('program proofRequirements.minProofLevel must be P0..P5');
  }
  if (core.reward === null || typeof core.reward !== 'object') {
    throw new ValidationError('program reward must be declared');
  }
  if (typeof core.reward.mechanism !== 'string' || !MECHANISM_FAMILIES.includes(core.reward.mechanism)) {
    throw new ValidationError('program reward.mechanism must be a known MechanismFamily', {
      mechanism: core.reward.mechanism,
    });
  }
  if (core.budget === null || typeof core.budget !== 'object') {
    throw new ValidationError('program budget must be declared');
  }
  validateMoney(core.budget.totalAmount, 'program budget.totalAmount');
  if (core.budget.totalAmount.value < 0n) {
    throw new ValidationError('program budget.totalAmount must be non-negative');
  }
  if (
    core.budget.funding !== 'REQUIRES_FUNDED_RESERVATION' &&
    core.budget.funding !== 'EXPLICITLY_CONTINGENT'
  ) {
    throw new ValidationError('program budget.funding kind is unknown', {
      funding: core.budget.funding,
    });
  }
  const formulaCurrency = core.budget.totalAmount.currency;
  const maxFormulaAmount = validateFormula(core.reward.formula, 'program reward.formula', formulaCurrency);
  // Monetary mechanisms must fit inside the declared budget ceiling (a single
  // maximum-award contribution can never exceed the total budget).
  if (isMonetaryMechanism(core.reward.mechanism) && maxFormulaAmount !== undefined) {
    if (maxFormulaAmount.value > core.budget.totalAmount.value && core.budget.totalAmount.value > 0n) {
      throw new ValidationError(
        'a single maximum formula award exceeds the program budget total (declare a larger budget or a smaller award)',
      );
    }
  }
  if (core.emission !== undefined) {
    if (core.emission === null || typeof core.emission !== 'object') {
      throw new ValidationError('program emission must be an EmissionPolicy when present');
    }
    for (const [field, bps] of [
      ['belowTargetMultiplierBps', core.emission.belowTargetMultiplierBps],
      ['withinBandMultiplierBps', core.emission.withinBandMultiplierBps],
      ['aboveTargetMultiplierBps', core.emission.aboveTargetMultiplierBps],
    ] as const) {
      // Boost below target may legitimately exceed 100% (bp > 10_000); the
      // hard ceiling is 10x (100_000 bp) to keep boosts sane and auditable.
      if (typeof bps !== 'bigint' || bps <= 0n || bps > 100_000n) {
        throw new ValidationError('emission multipliers must be bigints in (0, 100000] bp', {
          field,
        });
      }
    }
  }
  if (core.perActorCap !== undefined) {
    validateMoney(core.perActorCap, 'program perActorCap');
    if (core.perActorCap.value < 0n) {
      throw new ValidationError('program perActorCap must be non-negative');
    }
    if (core.perActorCap.currency !== formulaCurrency) {
      throw new ValidationError('program perActorCap currency differs from the program budget');
    }
  }
  if (core.concentrationLimit !== undefined) {
    if (core.concentrationLimit === null || typeof core.concentrationLimit !== 'object') {
      throw new ValidationError('program concentrationLimit must be a ConcentrationLimit');
    }
    if (
      typeof core.concentrationLimit.maxShareBpsOfBudgetPerActor !== 'bigint' ||
      core.concentrationLimit.maxShareBpsOfBudgetPerActor <= 0n ||
      core.concentrationLimit.maxShareBpsOfBudgetPerActor > 10_000n
    ) {
      throw new ValidationError('concentration limit share must be a bigint in (0, 10000] bp');
    }
  }
  const policy = core.antiGamingPolicy;
  if (policy === null || typeof policy !== 'object') {
    throw new ValidationError('program antiGamingPolicy must be declared');
  }
  if (typeof policy.forbidSelfReferral !== 'boolean') {
    throw new ValidationError('antiGamingPolicy.forbidSelfReferral must be boolean');
  }
  if (typeof policy.requireIdentityLinkageChecks !== 'boolean') {
    throw new ValidationError('antiGamingPolicy.requireIdentityLinkageChecks must be boolean');
  }
  if (policy.velocity !== undefined) {
    if (
      policy.velocity === null ||
      typeof policy.velocity !== 'object' ||
      typeof policy.velocity.maxContributions !== 'bigint' ||
      policy.velocity.maxContributions <= 0n ||
      typeof policy.velocity.windowMs !== 'bigint' ||
      policy.velocity.windowMs <= 0n
    ) {
      throw new ValidationError('antiGamingPolicy.velocity must carry positive bigint bounds');
    }
  }
  if (policy.minCounterpartyDiversity !== undefined) {
    if (
      typeof policy.minCounterpartyDiversity !== 'bigint' ||
      policy.minCounterpartyDiversity < 0n
    ) {
      throw new ValidationError('antiGamingPolicy.minCounterpartyDiversity must be a bigint >= 0');
    }
  }
  if (policy.delayedFinalization !== undefined) {
    if (
      policy.delayedFinalization === null ||
      typeof policy.delayedFinalization !== 'object' ||
      typeof policy.delayedFinalization.holdMs !== 'bigint' ||
      policy.delayedFinalization.holdMs < 0n
    ) {
      throw new ValidationError('antiGamingPolicy.delayedFinalization must carry holdMs bigint');
    }
  }
  if (core.clawbackPolicy === null || typeof core.clawbackPolicy !== 'object') {
    throw new ValidationError('program clawbackPolicy must be declared');
  }
  if (
    typeof core.clawbackPolicy.clawbackWindowMs !== 'bigint' ||
    core.clawbackPolicy.clawbackWindowMs < 0n
  ) {
    throw new ValidationError('clawbackPolicy.clawbackWindowMs must be a non-negative bigint');
  }
  if (typeof core.clawbackPolicy.requiresDisputeRecord !== 'boolean') {
    throw new ValidationError('clawbackPolicy.requiresDisputeRecord must be boolean');
  }
  const privacyRules = core.privacyRules === undefined ? [] : core.privacyRules;
  if (!Array.isArray(privacyRules)) {
    throw new ValidationError('program privacyRules must be an array of strings');
  }
  for (const rule of privacyRules) {
    if (typeof rule !== 'string' || rule.length === 0 || rule.length > 1024) {
      throw new ValidationError('privacyRules entries must be 1..1024 characters');
    }
  }
  return {
    sponsor: core.sponsor,
    objective: core.objective,
    eligibleRole: core.eligibleRole,
    eligibilityRules: Object.freeze(core.eligibilityRules.map((rule) => Object.freeze({ ...rule }))),
    contributionEvents: Object.freeze([...core.contributionEvents]),
    proofRequirements: Object.freeze({ minProofLevel: core.proofRequirements.minProofLevel }),
    reward: Object.freeze({
      mechanism: core.reward.mechanism,
      formula: freezeFormula(core.reward.formula),
    }),
    budget: Object.freeze({
      totalAmount: core.budget.totalAmount,
      funding: core.budget.funding,
    }),
    ...(core.emission !== undefined ? { emission: Object.freeze({ ...core.emission }) } : {}),
    ...(core.perActorCap !== undefined ? { perActorCap: core.perActorCap } : {}),
    ...(core.concentrationLimit !== undefined
      ? { concentrationLimit: Object.freeze({ ...core.concentrationLimit }) }
      : {}),
    antiGamingPolicy: freezeAntiGamingPolicy(policy),
    clawbackPolicy: Object.freeze({ ...core.clawbackPolicy }),
    privacyRules: Object.freeze([...privacyRules]),
  };
}

function freezeFormula(formula: RewardFormula): RewardFormula {
  switch (formula.kind) {
    case 'FIXED_PER_CONTRIBUTION':
      return Object.freeze({ kind: formula.kind, amount: formula.amount });
    case 'PROPORTIONAL_OF_VALUE':
      return Object.freeze({
        kind: formula.kind,
        basisPoints: formula.basisPoints,
        ...(formula.cap !== undefined ? { cap: formula.cap } : {}),
      });
    case 'TIERED_THRESHOLD':
      return Object.freeze({
        kind: formula.kind,
        tiers: Object.freeze(formula.tiers.map((tier) => Object.freeze({ ...tier }))),
      });
    case 'COMPLETION_BOUNTY':
      return Object.freeze({ kind: formula.kind, amount: formula.amount });
  }
}

function freezeAntiGamingPolicy(policy: AntiGamingPolicySpec): AntiGamingPolicySpec {
  return Object.freeze({
    ...(policy.velocity !== undefined
      ? { velocity: Object.freeze({ ...policy.velocity }) }
      : {}),
    ...(policy.minCounterpartyDiversity !== undefined
      ? { minCounterpartyDiversity: policy.minCounterpartyDiversity }
      : {}),
    forbidSelfReferral: policy.forbidSelfReferral,
    requireIdentityLinkageChecks: policy.requireIdentityLinkageChecks,
    ...(policy.delayedFinalization !== undefined
      ? { delayedFinalization: Object.freeze({ ...policy.delayedFinalization }) }
      : {}),
  });
}

function isActorClass(value: string): boolean {
  return (
    [
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
    ] as const
  ).includes(value as ActorClass);
}

/** Deterministic fingerprint of one version specification (INV-P03 input). */
function programVersionDigest(
  programId: IncentiveProgramId,
  version: bigint,
  core: ValidatedVersionCore,
  effectiveFrom: TimestampMs,
  status: ProgramStatus,
): string {
  return stableDigest([
    programId,
    version.toString(),
    status,
    effectiveFrom.toString(),
    core.sponsor,
    core.objective,
    core.eligibleRole,
    core.contributionEvents.join(','),
    core.proofRequirements.minProofLevel,
    core.reward.mechanism,
    formulaDigestInput(core.reward.formula),
    `${core.budget.totalAmount.currency}:${core.budget.totalAmount.value}`,
    core.budget.funding,
    core.emission !== undefined
      ? `${core.emission.belowTargetMultiplierBps}/${core.emission.withinBandMultiplierBps}/${core.emission.aboveTargetMultiplierBps}`
      : '-',
    core.perActorCap !== undefined ? `${core.perActorCap.value}` : '-',
    core.concentrationLimit !== undefined
      ? `${core.concentrationLimit.maxShareBpsOfBudgetPerActor}`
      : '-',
    policyDigestInput(core.antiGamingPolicy),
    core.clawbackPolicy.clawbackWindowMs.toString(),
    core.privacyRules.join(','),
  ]);
}

function formulaDigestInput(formula: RewardFormula): string {
  switch (formula.kind) {
    case 'FIXED_PER_CONTRIBUTION':
      return `fixed:${formula.amount.currency}:${formula.amount.value}`;
    case 'PROPORTIONAL_OF_VALUE':
      return `prop:${formula.basisPoints}:${formula.cap !== undefined ? formula.cap.value : '-'}`;
    case 'TIERED_THRESHOLD':
      return `tier:${formula.tiers.map((tier) => `${tier.atLeast}=${tier.amount.value}`).join(',')}`;
    case 'COMPLETION_BOUNTY':
      return `bounty:${formula.amount.currency}:${formula.amount.value}`;
  }
}

function policyDigestInput(policy: AntiGamingPolicySpec): string {
  const velocity =
    policy.velocity !== undefined
      ? `${policy.velocity.maxContributions}@${policy.velocity.windowMs}`
      : '-';
  const diversity = policy.minCounterpartyDiversity !== undefined
    ? policy.minCounterpartyDiversity.toString()
    : '-';
  return `${velocity}|${diversity}|${policy.forbidSelfReferral}|${policy.requireIdentityLinkageChecks}`;
}

/**
 * INV-P07 registry: append-only program version history. Versions are frozen
 * at registration and can never be mutated, replaced or removed — every
 * program change is a NEW version with a strictly advancing effective epoch.
 */
export class ProgramVersionRegistry {
  private readonly _byProgram = new Map<IncentiveProgramId, IncentiveProgramVersion[]>();

  /** Register a new program → immutable version 1 (DRAFT by default). */
  registerProgram(draft: IncentiveProgramDraft, status: ProgramStatus = 'DRAFT'): IncentiveProgramVersion {
    if (draft === null || typeof draft !== 'object') {
      throw new ValidationError('draft must be an IncentiveProgramDraft');
    }
    if (typeof draft.effectiveFrom !== 'bigint' || draft.effectiveFrom < 0n) {
      throw new ValidationError('draft.effectiveFrom must be a non-negative bigint TimestampMs');
    }
    const programId =
      draft.programId !== undefined ? draft.programId : asIncentiveProgramId(mintProgramId());
    if (this._byProgram.has(programId)) {
      throw new ProgramEpochViolationError('program id already registered', { programId });
    }
    const core = validateVersionCore(draft);
    const version = 1n;
    const versionOne: IncentiveProgramVersion = Object.freeze({
      programId,
      version,
      status,
      effectiveFrom: draft.effectiveFrom,
      specDigest: programVersionDigest(programId, version, core, draft.effectiveFrom, status),
      ...core,
    });
    this._store(versionOne);
    return versionOne;
  }

  /**
   * Revise a program → append a NEW version with a strictly advancing
   * effective epoch (INV-P07). The previous version is closed at the new
   * epoch boundary and stays immutable and retrievable.
   */
  reviseProgram(revision: ProgramRevision, status: ProgramStatus = 'ACTIVE'): IncentiveProgramVersion {
    if (revision === null || typeof revision !== 'object') {
      throw new ValidationError('revision must be a ProgramRevision');
    }
    const history = this._byProgram.get(revision.programId);
    if (history === undefined || history.length === 0) {
      throw new UnknownProgramError('no program registered under the given id', {
        programId: revision.programId,
      });
    }
    const current = history[history.length - 1];
    if (current === undefined) {
      throw new UnknownProgramError('program history is empty');
    }
    if (typeof revision.effectiveFrom !== 'bigint' || revision.effectiveFrom < 0n) {
      throw new ValidationError('revision.effectiveFrom must be a non-negative bigint TimestampMs');
    }
    if (revision.effectiveFrom <= current.effectiveFrom) {
      throw new ProgramEpochViolationError(
        'a revision must open a strictly later effective epoch than the version it supersedes (INV-P07)',
        {
          programId: revision.programId,
          supersedes: current.version,
          currentEpoch: current.effectiveFrom.toString(),
          proposedEpoch: revision.effectiveFrom.toString(),
        },
      );
    }
    const core = validateVersionCore(revision);
    const version = current.version + 1n;
    const revised: IncentiveProgramVersion = Object.freeze({
      programId: revision.programId,
      version,
      status,
      effectiveFrom: revision.effectiveFrom,
      supersedesVersion: current.version,
      specDigest: programVersionDigest(revision.programId, version, core, revision.effectiveFrom, status),
      ...core,
    });
    this._store(revised);
    return revised;
  }

  /** Emergency pause (abuse/security/budget violations) — a NEW version. */
  pauseProgram(programId: IncentiveProgramId, effectiveFrom: TimestampMs): IncentiveProgramVersion {
    const revision = this._carryForward(programId, effectiveFrom);
    return this.reviseProgram(revision, 'PAUSED');
  }

  /** Resume a paused program — a NEW version with a new epoch. */
  resumeProgram(programId: IncentiveProgramId, effectiveFrom: TimestampMs): IncentiveProgramVersion {
    const revision = this._carryForward(programId, effectiveFrom);
    return this.reviseProgram(revision, 'ACTIVE');
  }

  /** Retire a program — a NEW terminal status version (history preserved). */
  retireProgram(programId: IncentiveProgramId, effectiveFrom: TimestampMs): IncentiveProgramVersion {
    const revision = this._carryForward(programId, effectiveFrom);
    return this.reviseProgram(revision, 'RETIRED');
  }

  /** The latest appended version of a program. */
  latest(programId: IncentiveProgramId): IncentiveProgramVersion {
    const history = this._byProgram.get(programId);
    if (history === undefined || history.length === 0) {
      throw new UnknownProgramError('no program registered under the given id', { programId });
    }
    const latest = history[history.length - 1];
    if (latest === undefined) {
      throw new UnknownProgramError('program history is empty');
    }
    return latest;
  }

  /** One exact version (immutable history stays retrievable forever). */
  version(programId: IncentiveProgramId, version: bigint): IncentiveProgramVersion {
    const history = this._byProgram.get(programId);
    if (history === undefined) {
      throw new UnknownProgramError('no program registered under the given id', { programId });
    }
    const found = history.find((candidate) => candidate.version === version);
    if (found === undefined) {
      throw new UnknownProgramError('no such program version', { programId, version: version.toString() });
    }
    return found;
  }

  /** The whole version history in append order (never rewritten). */
  history(programId: IncentiveProgramId): readonly IncentiveProgramVersion[] {
    const history = this._byProgram.get(programId);
    if (history === undefined) {
      throw new UnknownProgramError('no program registered under the given id', { programId });
    }
    return Object.freeze([...history]);
  }

  /** The version effective at a given (injected) time, if any. */
  effectiveAt(programId: IncentiveProgramId, at: TimestampMs): IncentiveProgramVersion | undefined {
    const history = this._byProgram.get(programId);
    if (history === undefined) {
      throw new UnknownProgramError('no program registered under the given id', { programId });
    }
    let found: IncentiveProgramVersion | undefined;
    for (const candidate of history) {
      if (candidate.effectiveFrom <= at) {
        found = candidate;
      }
    }
    return found;
  }

  private _carryForward(
    programId: IncentiveProgramId,
    effectiveFrom: TimestampMs,
  ): ProgramRevision {
    const current = this.latest(programId);
    if (current.effectiveFrom >= effectiveFrom) {
      throw new ProgramEpochViolationError(
        'status change must open a strictly later effective epoch than the current version (INV-P07)',
        { programId, currentEpoch: current.effectiveFrom.toString(), proposedEpoch: effectiveFrom.toString() },
      );
    }
    return {
      programId,
      effectiveFrom,
      status: current.status,
      sponsor: current.sponsor,
      objective: current.objective,
      eligibleRole: current.eligibleRole,
      eligibilityRules: current.eligibilityRules,
      contributionEvents: current.contributionEvents,
      proofRequirements: current.proofRequirements,
      reward: current.reward,
      budget: current.budget,
      ...(current.emission !== undefined ? { emission: current.emission } : {}),
      ...(current.perActorCap !== undefined ? { perActorCap: current.perActorCap } : {}),
      ...(current.concentrationLimit !== undefined
        ? { concentrationLimit: current.concentrationLimit }
        : {}),
      antiGamingPolicy: current.antiGamingPolicy,
      clawbackPolicy: current.clawbackPolicy,
      privacyRules: current.privacyRules,
    };
  }

  private _store(version: IncentiveProgramVersion): void {
    let history = this._byProgram.get(version.programId);
    if (history === undefined) {
      history = [];
      this._byProgram.set(version.programId, history);
    }
    history.push(version);
  }
}

let programIdCounter = 0n;

/**
 * Deterministic fallback program-id minter used when a caller does not supply
 * a preferred id. Sequential and injective per process — production callers
 * should pass their own minted `IncentiveProgramId`.
 */
function mintProgramId(): string {
  programIdCounter += 1n;
  return `prog_${programIdCounter}`;
}
