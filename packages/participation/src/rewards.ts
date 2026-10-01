/**
 * @payswap/participation — reward formulas, accruals, obligations and
 * clawbacks (W3-004).
 *
 * PARTICIPATION-ENGINEERING §RewardAccrual lifecycle:
 *   PROVISIONAL → CONFIRMED → CLAIMABLE → CLAIMED
 *   with side states DISPUTED, CLAWED_BACK and EXPIRED.
 *
 * Monetary rewards create protocol obligations (FROZEN §14 / AGENTS.md rule
 * 12): qualification derives a fulfillment activity (funder → beneficiary)
 * through the @payswap/protocol clearing machinery (`deriveObligations`,
 * consumed — never reimplemented) and the derived obligations settle via the
 * normal clearing/netting/settlement pipeline.
 *
 * Invariant gates enforced HERE (each has a dedicated test):
 * - INV-P01: finalization (PROVISIONAL → CONFIRMED) of a MONETARY reward
 *   requires the program-version budget to be FUNDED — otherwise
 *   `UnfundedRewardFinalizationError`. Contingent programs may hold rewards
 *   at PROVISIONAL, visibly.
 * - INV-P03: reward amounts are pure deterministic functions of (contribution
 *   evidence, program version) — every accrual carries the program
 *   `specDigest` + a formula digest, and `recomputeReward` reproduces the
 *   identical amount from the same inputs.
 * - INV-P04: `finalizeReward` requires an anti-gaming report with verdict
 *   PASS — FLAG and BLOCK both throw `AntiGamingGateError`.
 * - INV-P06: clawbacks create SEPARATE adjustment obligations (beneficiary →
 *   funder clearing record) and move the accrual to CLAWED_BACK — the
 *   original obligations and the contribution history remain untouched.
 *
 * Exact money only (INV-F01): proportional formulas use bigint basis-point
 * arithmetic with documented truncation toward zero — no floats anywhere.
 */

import {
  asClearingRecordId,
  asFulfillmentActivityId,
  asPartyId,
  compare,
  defineStateMachine,
  deriveObligations,
  fromMinorUnits,
  PaySwapError,
  ValidationError,
  type ClearingRecord,
  type ClearingRecordId,
  type FulfillmentActivity,
  type IdFactory,
  type Money,
  type Obligation,
  type ObligationBook,
  type ObligationDueWindow,
  type ObligationId,
  type PartyId,
  type ProtocolClock,
  type StateMachine,
  type TimestampMs,
} from '@payswap/protocol';
import { stableDigest } from './digest.js';
import { strongestEvidenceLevel as strongestEvidence, proofLevelMeets as proofMeets } from './evidence.js';
import type { IncentiveBudgetLedger } from './budget.js';
import type { ContributionRecord } from './contributions.js';
import type {
  EmissionLevel,
  IncentiveProgramVersion,
  ProgramVersionRef,
  RewardFormula,
} from './programs.js';
import { isMonetaryMechanism, resolveEmissionMultiplierBps } from './programs.js';
import type { AntiGamingReport } from './anti-gaming.js';

declare const RewardAccrualIdBrand: unique symbol;

/** Branded id of one reward accrual. */
export type RewardAccrualId = string & { readonly [RewardAccrualIdBrand]: 'RewardAccrualId' };

/** Brand a validated string as a `RewardAccrualId`. */
export function asRewardAccrualId(value: string): RewardAccrualId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('RewardAccrualId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new ValidationError('RewardAccrualId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError('RewardAccrualId must not carry surrounding whitespace', { value });
  }
  return value as RewardAccrualId;
}

/** Reward accrual lifecycle states (main line + side states). */
export type RewardState =
  | 'PROVISIONAL'
  | 'CONFIRMED'
  | 'CLAIMABLE'
  | 'CLAIMED'
  | 'DISPUTED'
  | 'CLAWED_BACK'
  | 'EXPIRED';

/** Events the reward state machine declares. */
export type RewardEvent =
  | 'CONFIRM'
  | 'QUALIFY'
  | 'CLAIM'
  | 'DISPUTE'
  | 'RESOLVE_UPHOLD'
  | 'RESOLVE_REJECT'
  | 'RESOLVE_CLAWBACK'
  | 'CLAW_BACK'
  | 'EXPIRE';

/** Guard context: injected clock + the clawback window close. */
export interface RewardMachineContext {
  readonly now: TimestampMs;
  readonly clawbackClosesAt: TimestampMs;
}

/**
 * The deterministic reward lifecycle machine. CLAW_BACK is guarded to the
 * declared clawback window; terminal states (CLAIMED, CLAWED_BACK, EXPIRED)
 * are monotonic (INV-X04) — the ONLY exit from a terminal state is the
 * explicitly declared recovery `CLAIMED --CLAW_BACK--> CLAWED_BACK`
 * (clawback of an already-claimed reward), which is exactly the INV-X04
 * “terminal transitions are monotonic except explicit recovery states”
 * carve-out. The service layer enforces the clawback window on that recovery
 * path because recovery rules carry no guards by protocol design.
 */
export const rewardStateMachine: StateMachine<RewardState, RewardEvent, RewardMachineContext> =
  defineStateMachine<RewardState, RewardEvent, RewardMachineContext>({
    name: 'reward-accrual',
    initial: 'PROVISIONAL',
    states: ['PROVISIONAL', 'CONFIRMED', 'CLAIMABLE', 'CLAIMED', 'DISPUTED', 'CLAWED_BACK', 'EXPIRED'],
    events: ['CONFIRM', 'QUALIFY', 'CLAIM', 'DISPUTE', 'RESOLVE_UPHOLD', 'RESOLVE_REJECT', 'RESOLVE_CLAWBACK', 'CLAW_BACK', 'EXPIRE'],
    transitions: [
      // Main line (INV-P01/INV-P04 gates are enforced by the service layer).
      { from: 'PROVISIONAL', on: 'CONFIRM', to: 'CONFIRMED', description: 'anti-gaming PASS + funded budget required' },
      { from: 'CONFIRMED', on: 'QUALIFY', to: 'CLAIMABLE', description: 'creates the protocol obligation for monetary rewards' },
      { from: 'CLAIMABLE', on: 'CLAIM', to: 'CLAIMED', description: 'claim against the derived obligation' },
      // Disputes (side state).
      { from: 'PROVISIONAL', on: 'DISPUTE', to: 'DISPUTED', description: 'dispute before finalization' },
      { from: 'CONFIRMED', on: 'DISPUTE', to: 'DISPUTED', description: 'dispute after finalization' },
      { from: 'CLAIMABLE', on: 'DISPUTE', to: 'DISPUTED', description: 'dispute after qualification' },
      { from: 'DISPUTED', on: 'RESOLVE_UPHOLD', to: 'CONFIRMED', description: 'dispute rejected — reward restored to CONFIRMED' },
      { from: 'DISPUTED', on: 'RESOLVE_REJECT', to: 'EXPIRED', description: 'dispute upheld against the reward' },
      { from: 'DISPUTED', on: 'RESOLVE_CLAWBACK', to: 'CLAWED_BACK', description: 'dispute resolved by clawback' },
      // Clawback (INV-P06: separate adjustment obligation, history preserved).
      {
        from: 'CLAIMABLE',
        on: 'CLAW_BACK',
        to: 'CLAWED_BACK',
        guard: (context) => context.now <= context.clawbackClosesAt,
        description: 'clawback within the declared window',
      },
      // Expiry (side state).
      { from: 'PROVISIONAL', on: 'EXPIRE', to: 'EXPIRED', description: 'provisional reward expired' },
      { from: 'CONFIRMED', on: 'EXPIRE', to: 'EXPIRED', description: 'confirmed reward expired unclaimed' },
      { from: 'CLAIMABLE', on: 'EXPIRE', to: 'EXPIRED', description: 'claimable reward expired unclaimed' },
    ],
    terminalStates: ['CLAIMED', 'CLAWED_BACK', 'EXPIRED'],
    recovery: [
      {
        from: 'CLAIMED',
        on: 'CLAW_BACK',
        to: 'CLAWED_BACK',
        description:
          'INV-X04 explicit recovery: clawback of an already-claimed reward (window enforced by the service layer)',
      },
    ],
  });

/** Whether the reward under this mechanism is monetary (creates obligations). */
export type RewardKind = 'MONETARY' | 'POINTS' | 'RECOGNITION';

/** One reward accrual. */
export interface RewardAccrual {
  readonly id: RewardAccrualId;
  readonly programVersion: ProgramVersionRef;
  readonly contributionId: string;
  readonly beneficiary: PartyId;
  readonly kind: RewardKind;
  readonly amount: Money;
  readonly state: RewardState;
  /** INV-P03: fingerprint of (program version spec, contribution, formula outcome). */
  readonly formulaDigest: string;
  /** INV-P03: the exact program spec digest the reward was computed under. */
  readonly programSpecDigest: string;
  readonly createdAt: TimestampMs;
  /** Original reward obligations (funder → beneficiary), derived at QUALIFY. */
  readonly obligationIds: readonly ObligationId[];
  /** INV-P06: SEPARATE adjustment obligations (beneficiary → funder). */
  readonly adjustmentObligationIds: readonly ObligationId[];
  /** Verdict of the anti-gaming report accepted at finalization (INV-P04). */
  readonly antiGamingVerdict?: 'PASS' | 'FLAG' | 'BLOCK';
  readonly note?: string;
}

/** Storage-agnostic reward store contract. */
export interface RewardBook {
  readonly all: readonly RewardAccrual[];
  get(id: RewardAccrualId): RewardAccrual | undefined;
  add(accrual: RewardAccrual): void;
  replace(accrual: RewardAccrual): void;
  byBeneficiary(programVersion: ProgramVersionRef, beneficiary: PartyId): readonly RewardAccrual[];
}

/** No reward accrual exists under the given id. */
export class UnknownRewardError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'UNKNOWN_REWARD', category: 'NOT_FOUND', message, details });
    this.name = 'UnknownRewardError';
  }
}

/** An accrual id already exists (ids are never reused). */
export class RewardIdConflictError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'REWARD_ID_CONFLICT', category: 'CONFLICT', message, details });
    this.name = 'RewardIdConflictError';
  }
}

/** INV-P01: a monetary reward cannot become final without funding. */
export class UnfundedRewardFinalizationError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'UNFUNDED_REWARD_FINALIZATION', category: 'POLICY_BLOCKED', message, details });
    this.name = 'UnfundedRewardFinalizationError';
  }
}

/** INV-P04: anti-gaming checks did not pass before finalization. */
export class AntiGamingGateError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'ANTI_GAMING_GATE', category: 'POLICY_BLOCKED', message, details });
    this.name = 'AntiGamingGateError';
  }
}

/** The per-actor cap or concentration limit refuses this accrual. */
export class RewardCapExceededError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'REWARD_CAP_EXCEEDED', category: 'POLICY_BLOCKED', message, details });
    this.name = 'RewardCapExceededError';
  }
}

/** Deterministic in-memory reward book (frozen copies, ids never reused). */
export class InMemoryRewardBook implements RewardBook {
  private readonly _byId = new Map<RewardAccrualId, RewardAccrual>();
  private readonly _order: RewardAccrual[] = [];

  get all(): readonly RewardAccrual[] {
    return Object.freeze([...this._order]);
  }

  get(id: RewardAccrualId): RewardAccrual | undefined {
    return this._byId.get(id);
  }

  byBeneficiary(
    programVersion: ProgramVersionRef,
    beneficiary: PartyId,
  ): readonly RewardAccrual[] {
    return Object.freeze(
      this._order.filter(
        (accrual) =>
          accrual.programVersion.programId === programVersion.programId &&
          accrual.programVersion.version === programVersion.version &&
          accrual.beneficiary === beneficiary,
      ),
    );
  }

  add(accrual: RewardAccrual): void {
    if (this._byId.has(accrual.id)) {
      throw new RewardIdConflictError('reward accrual id already exists', { id: accrual.id });
    }
    const stored = freezeAccrual(accrual);
    this._byId.set(stored.id, stored);
    this._order.push(stored);
  }

  replace(accrual: RewardAccrual): void {
    if (!this._byId.has(accrual.id)) {
      throw new UnknownRewardError('cannot replace an unknown reward accrual', { id: accrual.id });
    }
    const stored = freezeAccrual(accrual);
    this._byId.set(stored.id, stored);
    const index = this._order.findIndex((candidate) => candidate.id === stored.id);
    if (index >= 0) {
      this._order[index] = stored;
    }
  }
}

function freezeAccrual(accrual: RewardAccrual): RewardAccrual {
  const frozen: {
    -readonly [K in keyof RewardAccrual]: RewardAccrual[K];
  } = {
    id: accrual.id,
    programVersion: Object.freeze({ ...accrual.programVersion }),
    contributionId: accrual.contributionId,
    beneficiary: accrual.beneficiary,
    kind: accrual.kind,
    amount: accrual.amount,
    state: accrual.state,
    formulaDigest: accrual.formulaDigest,
    programSpecDigest: accrual.programSpecDigest,
    createdAt: accrual.createdAt,
    obligationIds: Object.freeze([...accrual.obligationIds]),
    adjustmentObligationIds: Object.freeze([...accrual.adjustmentObligationIds]),
  };
  if (accrual.antiGamingVerdict !== undefined) frozen.antiGamingVerdict = accrual.antiGamingVerdict;
  if (accrual.note !== undefined) frozen.note = accrual.note;
  return Object.freeze(frozen);
}

/** Everything the reward services need, injected (no ambient dependencies). */
export interface RewardServiceDeps {
  readonly ids: IdFactory;
  readonly clock: ProtocolClock;
  readonly rewards: RewardBook;
  readonly budgets: IncentiveBudgetLedger;
  /** Obligation book for derived reward + adjustment obligations. */
  readonly obligations: ObligationBook;
}

/**
 * INV-P03 — compute one reward amount as a PURE deterministic function of the
 * program version (spec + digest) and the contribution record. Same inputs →
 * identical amount AND identical digest, on every call, in every process.
 */
export function computeRewardAmount(
  program: IncentiveProgramVersion,
  contribution: ContributionRecord,
  emissionLevel: EmissionLevel,
): { readonly amount: Money; readonly formulaDigest: string } {
  const formula = program.reward.formula;
  const currency = program.budget.totalAmount.currency;
  let base: Money;
  switch (formula.kind) {
    case 'FIXED_PER_CONTRIBUTION': {
      base = formula.amount;
      break;
    }
    case 'PROPORTIONAL_OF_VALUE': {
      if (contribution.value === undefined) {
        throw new ValidationError(
          'PROPORTIONAL_OF_VALUE rewards require the contribution to carry an economic value',
          { contribution: contribution.id, behavior: contribution.behavior },
        );
      }
      if (contribution.value.currency !== currency) {
        throw new ValidationError('contribution value currency differs from the program budget', {
          contribution: contribution.value.currency,
          program: currency,
        });
      }
      // Exact bigint math; truncation toward zero is the documented policy.
      const computed = (contribution.value.value * formula.basisPoints) / 10_000n;
      if (computed <= 0n) {
        throw new ValidationError(
          'proportional reward truncated to zero — the contribution value is too small for this formula',
          { value: contribution.value.value.toString(), basisPoints: formula.basisPoints.toString() },
        );
      }
      base = fromMinorUnits(currency, computed);
      if (formula.cap !== undefined && compare(base, formula.cap) > 0) {
        base = formula.cap;
      }
      break;
    }
    case 'TIERED_THRESHOLD': {
      let matched: Money | undefined;
      for (const tier of formula.tiers) {
        if (contribution.quantity >= tier.atLeast) {
          matched = tier.amount;
        }
      }
      if (matched === undefined) {
        throw new ValidationError(
          'the contribution quantity does not reach the lowest declared tier',
          { quantity: contribution.quantity.toString() },
        );
      }
      base = matched;
      break;
    }
    case 'COMPLETION_BOUNTY': {
      if (contribution.outcome !== 'VERIFIED_COMPLETED') {
        throw new ValidationError(
          'COMPLETION_BOUNTY rewards require a VERIFIED_COMPLETED outcome',
          { outcome: contribution.outcome },
        );
      }
      base = formula.amount;
      break;
    }
  }
  const multiplierBps = resolveEmissionMultiplierBps(program.emission, emissionLevel);
  // Emission multiplier: exact bigint basis-point scaling (truncation documented).
  const scaled = (base.value * multiplierBps) / 10_000n;
  if (scaled <= 0n) {
    throw new ValidationError('emission multiplier scaled the reward to zero');
  }
  const amount = fromMinorUnits(currency, scaled);
  const formulaDigest = stableDigest([
    program.specDigest,
    program.programId,
    program.version.toString(),
    contribution.id,
    contribution.actor,
    contribution.behavior,
    contribution.quantity.toString(),
    contribution.outcome,
    contribution.value !== undefined ? `${contribution.value.currency}:${contribution.value.value}` : '-',
    emissionLevel,
    amount.value.toString(),
  ]);
  return { amount, formulaDigest };
}

/** The reward kind produced by a program mechanism. */
export function rewardKindFor(program: IncentiveProgramVersion): RewardKind {
  switch (program.reward.mechanism) {
    case 'POINTS':
      return 'POINTS';
    case 'BADGE':
    case 'RECOGNITION':
    case 'REPUTATION_ATTESTATION':
    case 'CAPACITY_RIGHTS':
    case 'PRIORITY_RIGHTS':
      return 'RECOGNITION';
    default:
      return 'MONETARY';
  }
}

/**
 * Accrue one reward for a contribution under a program version. The
 * contribution must match the program's declared contribution events and
 * carry evidence at the program's minimum proof level (INV-E03 discipline).
 * Monetary accruals commit budget headroom immediately (AGENTS.md rule 13).
 */
export function accrueReward(
  deps: RewardServiceDeps,
  program: IncentiveProgramVersion,
  contribution: ContributionRecord,
  emissionLevel: EmissionLevel = 'WITHIN_BAND',
): RewardAccrual {
  if (!program.contributionEvents.includes(contribution.behavior)) {
    throw new ValidationError(
      'the contribution behavior is not a declared contribution event of this program version',
      { behavior: contribution.behavior, programId: program.programId },
    );
  }
  if (contribution.programVersion !== undefined) {
    if (
      contribution.programVersion.programId !== program.programId ||
      contribution.programVersion.version !== program.version
    ) {
      throw new ValidationError('the contribution is bound to a different program version', {
        contribution: `${contribution.programVersion.programId}@${contribution.programVersion.version}`,
        program: `${program.programId}@${program.version}`,
      });
    }
  }
  const strongest = strongestEvidence(contribution.evidence);
  if (strongest === undefined || !proofMeets(strongest, program.proofRequirements.minProofLevel)) {
    throw new ValidationError(
      'the contribution evidence does not meet the program minimum proof level (INV-E03)',
      { required: program.proofRequirements.minProofLevel },
    );
  }
  const kind = rewardKindFor(program);
  if (kind !== 'MONETARY' && isMonetaryMechanism(program.reward.mechanism)) {
    throw new ValidationError('inconsistent mechanism/kind mapping');
  }
  const { amount, formulaDigest } = computeRewardAmount(program, contribution, emissionLevel);

  // Per-actor cap + concentration limits (deterministic over book history).
  if (program.perActorCap !== undefined) {
    const history = deps.rewards.byBeneficiary(
      { programId: program.programId, version: program.version },
      contribution.attribution.attributedActor,
    );
    let consumed = 0n;
    for (const accrual of history) {
      if (accrual.state === 'EXPIRED' || accrual.state === 'CLAWED_BACK') continue;
      consumed += accrual.amount.value;
    }
    if (consumed + amount.value > program.perActorCap.value) {
      throw new RewardCapExceededError(
        'this accrual would exceed the per-actor cap of the program version',
        {
          actor: contribution.attribution.attributedActor,
          cap: program.perActorCap.value.toString(),
          consumed: consumed.toString(),
          attempted: amount.value.toString(),
        },
      );
    }
  }
  if (program.concentrationLimit !== undefined && program.budget.totalAmount.value > 0n) {
    const history = deps.rewards.byBeneficiary(
      { programId: program.programId, version: program.version },
      contribution.attribution.attributedActor,
    );
    let consumed = 0n;
    for (const accrual of history) {
      if (accrual.state === 'EXPIRED' || accrual.state === 'CLAWED_BACK') continue;
      consumed += accrual.amount.value;
    }
    const shareAfter = ((consumed + amount.value) * 10_000n) / program.budget.totalAmount.value;
    if (shareAfter > program.concentrationLimit.maxShareBpsOfBudgetPerActor) {
      throw new RewardCapExceededError(
        'this accrual would breach the per-actor concentration limit of the program version',
        {
          actor: contribution.attribution.attributedActor,
          limitBps: program.concentrationLimit.maxShareBpsOfBudgetPerActor.toString(),
          shareAfterBps: shareAfter.toString(),
        },
      );
    }
  }

  // Monetary accruals commit budget headroom the moment they are promised.
  if (kind === 'MONETARY') {
    deps.budgets.commit(
      { programId: program.programId, version: program.version },
      amount,
    );
  }

  const accrual: RewardAccrual = Object.freeze({
    id: asRewardAccrualId(deps.ids.mintId('rwd')),
    programVersion: Object.freeze({ programId: program.programId, version: program.version }),
    contributionId: contribution.id,
    beneficiary: asPartyId(contribution.attribution.attributedActor),
    kind,
    amount,
    state: 'PROVISIONAL',
    formulaDigest,
    programSpecDigest: program.specDigest,
    createdAt: deps.clock.now(),
    obligationIds: Object.freeze([]),
    adjustmentObligationIds: Object.freeze([]),
  });
  deps.rewards.add(accrual);
  return accrual;
}

/**
 * INV-P03 verification: recompute the reward from the stored program version
 * and contribution and prove the amount + digest reproduce identically.
 */
export function recomputeReward(
  program: IncentiveProgramVersion,
  contribution: ContributionRecord,
  emissionLevel: EmissionLevel,
  accrual: RewardAccrual,
): { readonly reproducible: boolean; readonly computed: Money; readonly formulaDigest: string } {
  const { amount, formulaDigest } = computeRewardAmount(program, contribution, emissionLevel);
  return {
    reproducible: amount.value === accrual.amount.value && formulaDigest === accrual.formulaDigest,
    computed: amount,
    formulaDigest,
  };
}

/**
 * Finalize one reward: PROVISIONAL → CONFIRMED.
 * INV-P04: the anti-gaming report must be PASS (FLAG and BLOCK both throw).
 * INV-P01: monetary rewards require a FUNDED program-version budget
 * (contingent budgets throw `UnfundedRewardFinalizationError`).
 */
export function finalizeReward(
  deps: RewardServiceDeps,
  program: IncentiveProgramVersion,
  accrualId: RewardAccrualId,
  antiGaming: AntiGamingReport,
): RewardAccrual {
  const accrual = deps.rewards.get(accrualId);
  if (accrual === undefined) {
    throw new UnknownRewardError('no reward accrual exists under the given id', { id: accrualId });
  }
  assertSameProgram(program, accrual);
  if (antiGaming.verdict !== 'PASS') {
    throw new AntiGamingGateError(
      'anti-gaming checks did not PASS before reward finalization (INV-P04) — finalization is blocked',
      {
        verdict: antiGaming.verdict,
        findings: antiGaming.findings.map((finding) => finding.code).join(','),
      },
    );
  }
  if (accrual.kind === 'MONETARY') {
    // INV-P01: the program-version budget must be FUNDED (an active protocol
    // reservation) before a monetary reward may become final. Contingent
    // budgets keep rewards at PROVISIONAL, visibly.
    if (!deps.budgets.isFunded(accrual.programVersion)) {
      throw new UnfundedRewardFinalizationError(
        'a monetary reward cannot become final without funded budget (INV-P01): the program version budget is explicitly contingent or unfunded',
        {
          programId: accrual.programVersion.programId,
          version: accrual.programVersion.version,
          accrual: accrual.id,
        },
      );
    }
  }
  const context: RewardMachineContext = {
    now: deps.clock.now(),
    clawbackClosesAt: accrual.createdAt + program.clawbackPolicy.clawbackWindowMs,
  };
  rewardStateMachine.transition(accrual.state, 'CONFIRM', context);
  const updated = freezeAccrual({
    ...accrual,
    state: 'CONFIRMED',
    antiGamingVerdict: 'PASS',
  });
  deps.rewards.replace(updated);
  return updated;
}

/**
 * Qualify one confirmed reward: CONFIRMED → CLAIMABLE. For MONETARY rewards
 * this derives the protocol obligation (funder → beneficiary) through the
 * protocol clearing machinery — the reward becomes a protocol obligation and
 * settles via normal clearing/netting/settlement (FROZEN §14).
 */
export function qualifyReward(
  deps: RewardServiceDeps,
  program: IncentiveProgramVersion,
  accrualId: RewardAccrualId,
  options: { readonly settlementWindowMs: bigint },
): RewardAccrual {
  const accrual = deps.rewards.get(accrualId);
  if (accrual === undefined) {
    throw new UnknownRewardError('no reward accrual exists under the given id', { id: accrualId });
  }
  assertSameProgram(program, accrual);
  const now = deps.clock.now();
  const context: RewardMachineContext = {
    now,
    clawbackClosesAt: accrual.createdAt + program.clawbackPolicy.clawbackWindowMs,
  };
  rewardStateMachine.transition(accrual.state, 'QUALIFY', context);

  let obligationIds: readonly ObligationId[] = accrual.obligationIds;
  if (accrual.kind === 'MONETARY' && obligationIds.length === 0) {
    const dueWindow: ObligationDueWindow = {
      opensAt: now,
      closesAt: now + options.settlementWindowMs,
    };
    const clearing = rewardClearingRecord(program, accrual, now, 'INCENTIVE_REWARD');
    const derived = deriveObligations([clearing], { dueWindow });
    for (const obligation of derived) {
      deps.obligations.add(obligation);
    }
    obligationIds = derived.map((obligation) => obligation.id);
  }

  const updated = freezeAccrual({ ...accrual, state: 'CLAIMABLE', obligationIds });
  deps.rewards.replace(updated);
  return updated;
}

/** Claim one claimable reward: CLAIMABLE → CLAIMED (terminal). */
export function claimReward(
  deps: RewardServiceDeps,
  program: IncentiveProgramVersion,
  accrualId: RewardAccrualId,
): RewardAccrual {
  return transitionReward(deps, program, accrualId, 'CLAIM');
}

/** Dispute one reward (side state DISPUTED, from PROVISIONAL/CONFIRMED/CLAIMABLE). */
export function disputeReward(
  deps: RewardServiceDeps,
  program: IncentiveProgramVersion,
  accrualId: RewardAccrualId,
  note?: string,
): RewardAccrual {
  const accrual = deps.rewards.get(accrualId);
  if (accrual === undefined) {
    throw new UnknownRewardError('no reward accrual exists under the given id', { id: accrualId });
  }
  assertSameProgram(program, accrual);
  const context = machineContext(deps, program, accrual);
  rewardStateMachine.transition(accrual.state, 'DISPUTE', context);
  const updated = freezeAccrual({
    ...accrual,
    state: 'DISPUTED',
    ...(note !== undefined ? { note } : {}),
  });
  deps.rewards.replace(updated);
  return updated;
}

/** Resolve a dispute (uphold → CONFIRMED, reject → EXPIRED, clawback → CLAWED_BACK). */
export function resolveRewardDispute(
  deps: RewardServiceDeps,
  program: IncentiveProgramVersion,
  accrualId: RewardAccrualId,
  resolution: 'UPHOLD' | 'REJECT' | 'CLAWBACK',
  options: { readonly settlementWindowMs: bigint },
): RewardAccrual {
  switch (resolution) {
    case 'UPHOLD':
      return transitionReward(deps, program, accrualId, 'RESOLVE_UPHOLD');
    case 'REJECT':
      return transitionReward(deps, program, accrualId, 'RESOLVE_REJECT');
    case 'CLAWBACK':
      return clawBackReward(deps, program, accrualId, options);
  }
}

/**
 * Expire one reward (side state EXPIRED from PROVISIONAL/CONFIRMED/CLAIMABLE)
 * and release the budget commitment of a monetary accrual that never became
 * claimable (the promise no longer binds budget).
 */
export function expireReward(
  deps: RewardServiceDeps,
  program: IncentiveProgramVersion,
  accrualId: RewardAccrualId,
): RewardAccrual {
  const accrual = deps.rewards.get(accrualId);
  if (accrual === undefined) {
    throw new UnknownRewardError('no reward accrual exists under the given id', { id: accrualId });
  }
  assertSameProgram(program, accrual);
  const context = machineContext(deps, program, accrual);
  rewardStateMachine.transition(accrual.state, 'EXPIRE', context);
  if (accrual.kind === 'MONETARY' && accrual.obligationIds.length === 0) {
    deps.budgets.releaseCommitment(accrual.programVersion, accrual.amount);
  }
  const updated = freezeAccrual({ ...accrual, state: 'EXPIRED' });
  deps.rewards.replace(updated);
  return updated;
}

/**
 * INV-P06 — claw back one reward: CLAIMABLE/CLAIMED → CLAWED_BACK within the
 * declared clawback window. The clawback creates a SEPARATE adjustment
 * obligation (beneficiary → funder) derived through the protocol clearing
 * machinery; the ORIGINAL reward obligations and the contribution history
 * remain untouched — nothing is rewritten, history is preserved.
 */
export function clawBackReward(
  deps: RewardServiceDeps,
  program: IncentiveProgramVersion,
  accrualId: RewardAccrualId,
  options: { readonly settlementWindowMs: bigint },
): RewardAccrual {
  const accrual = deps.rewards.get(accrualId);
  if (accrual === undefined) {
    throw new UnknownRewardError('no reward accrual exists under the given id', { id: accrualId });
  }
  assertSameProgram(program, accrual);
  const now = deps.clock.now();
  const clawbackClosesAt = accrual.createdAt + program.clawbackPolicy.clawbackWindowMs;
  const context: RewardMachineContext = { now, clawbackClosesAt };
  // The CLAIMABLE→CLAWED_BACK transition is guarded by the machine; the
  // CLAIMED→CLAWED_BACK recovery carries no guard by protocol design
  // (INV-X04 recovery rules are unguarded), so the window is enforced here
  // for BOTH paths before any state changes or adjustment obligations exist.
  if (now > clawbackClosesAt) {
    throw new PaySwapError({
      code: 'CLAWBACK_WINDOW_CLOSED',
      category: 'POLICY_BLOCKED',
      message: 'the declared clawback window has closed — this reward can no longer be clawed back',
      details: { accrual: accrual.id, closesAt: clawbackClosesAt.toString(), now: now.toString() },
    });
  }
  rewardStateMachine.transition(accrual.state, 'CLAW_BACK', context);

  // INV-P06: a SEPARATE adjustment clearing record — the original reward
  // clearing record and its obligations are never mutated or re-derived.
  let adjustmentObligationIds: readonly ObligationId[] = accrual.adjustmentObligationIds;
  if (accrual.kind === 'MONETARY' && adjustmentObligationIds.length === 0) {
    const dueWindow: ObligationDueWindow = {
      opensAt: now,
      closesAt: now + options.settlementWindowMs,
    };
    const clearing = rewardClearingRecord(program, accrual, now, 'INCENTIVE_REWARD_CLAWBACK');
    const derived = deriveObligations([clearing], { dueWindow });
    for (const obligation of derived) {
      deps.obligations.add(obligation);
    }
    adjustmentObligationIds = derived.map((obligation) => obligation.id);
  }

  const updated = freezeAccrual({
    ...accrual,
    state: 'CLAWED_BACK',
    adjustmentObligationIds,
    // Original obligations deliberately preserved on the record.
  });
  deps.rewards.replace(updated);
  return updated;
}

function transitionReward(
  deps: RewardServiceDeps,
  program: IncentiveProgramVersion,
  accrualId: RewardAccrualId,
  event: RewardEvent,
): RewardAccrual {
  const accrual = deps.rewards.get(accrualId);
  if (accrual === undefined) {
    throw new UnknownRewardError('no reward accrual exists under the given id', { id: accrualId });
  }
  assertSameProgram(program, accrual);
  const record = rewardStateMachine.transition(accrual.state, event, machineContext(deps, program, accrual));
  const updated = freezeAccrual({ ...accrual, state: record.to });
  deps.rewards.replace(updated);
  return updated;
}

function machineContext(
  deps: RewardServiceDeps,
  program: IncentiveProgramVersion,
  accrual: RewardAccrual,
): RewardMachineContext {
  return {
    now: deps.clock.now(),
    clawbackClosesAt: accrual.createdAt + program.clawbackPolicy.clawbackWindowMs,
  };
}

function assertSameProgram(program: IncentiveProgramVersion, accrual: RewardAccrual): void {
  if (
    accrual.programVersion.programId !== program.programId ||
    accrual.programVersion.version !== program.version
  ) {
    throw new ValidationError('the reward accrual belongs to a different program version', {
      accrual: `${accrual.programVersion.programId}@${accrual.programVersion.version}`,
      program: `${program.programId}@${program.version}`,
    });
  }
}

/**
 * Build the clearing record linking a reward (or its clawback adjustment) to
 * the protocol obligation machinery. Deterministic content-derived record id
 * (`CLR:<accrualId>:<direction>`) so replay reproduces identical obligation
 * ids (`OBL:<recordId>:<pair>:<currency>` — W1-002 discipline).
 */
function rewardClearingRecord(
  program: IncentiveProgramVersion,
  accrual: RewardAccrual,
  occurredAt: TimestampMs,
  activityType: 'INCENTIVE_REWARD' | 'INCENTIVE_REWARD_CLAWBACK',
): ClearingRecord {
  const isReward = activityType === 'INCENTIVE_REWARD';
  // Reward: funder owes beneficiary. Clawback: beneficiary owes funder.
  const debtor = isReward ? program.sponsor : accrual.beneficiary;
  const creditor = isReward ? accrual.beneficiary : program.sponsor;
  const activity: FulfillmentActivity = {
    id: asFulfillmentActivityId(`act:${accrual.id}:${activityType}`),
    activityType,
    debtor,
    creditor,
    amount: accrual.amount,
    occurredAt,
    refs: { correlationId: `${accrual.programVersion.programId}@${accrual.programVersion.version}:${accrual.id}` },
  };
  const recordId: ClearingRecordId = asClearingRecordId(`CLR:${accrual.id}:${activityType}`);
  return { id: recordId, activities: Object.freeze([Object.freeze(activity)]), netted: false };
}

/** All obligations of one accrual (original + adjustment) from the book. */
export function obligationsOf(
  deps: RewardServiceDeps,
  accrual: RewardAccrual,
): { readonly original: readonly Obligation[]; readonly adjustments: readonly Obligation[] } {
  return {
    original: accrual.obligationIds.flatMap((id) => {
      const obligation = deps.obligations.get(id);
      return obligation === undefined ? [] : [obligation];
    }),
    adjustments: accrual.adjustmentObligationIds.flatMap((id) => {
      const obligation = deps.obligations.get(id);
      return obligation === undefined ? [] : [obligation];
    }),
  };
}
