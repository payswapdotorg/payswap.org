/**
 * @payswap/recourse — the dispute case (W1-006).
 *
 * SECURITY-EVIDENCE-RECOURSE "Recourse": disputes never edit the original
 * transaction. They create separate adjudication and adjustment obligations.
 *
 * A `DisputeCase` is a SEPARATE append-only record:
 * - it REFERENCES the original transaction by id (`transactionRef`) — the
 *   original transaction, its obligations and its evidence are never read
 *   back for mutation and never rewritten;
 * - its lifecycle is an explicit history: every transition appends a frozen
 *   `DisputeTransitionRecord`; the record itself is deeply frozen and every
 *   state change produces a NEW frozen version (no in-place mutation);
 * - terminal states (GRANTED, REJECTED, WITHDRAWN) are monotonic (INV-X04)
 *   with exactly ONE declared recovery: REJECTED --REOPEN--> UNDER_REVIEW,
 *   which requires new evidence to be presented (guard).
 *
 * Opening a dispute ENFORCES the transaction's recourse policy at claim time
 * (consumed from ./policy.js):
 * - a declared policy must exist (`NoRecoursePolicyError` otherwise);
 * - the claim window must be open (`ClaimWindowNotOpenError` /
 *   `ClaimWindowClosedError`);
 * - the declared evidence requirements must be satisfied by the presented
 *   evidence nodes resolved from the settlement evidence graph
 *   (`MissingDisputeEvidenceError`).
 */

import { ValidationError } from '@payswap/protocol';
import type {
  PaySwapErrorDetails,
  IdFactory,
  Money,
  PartyId,
  ProtocolClock,
  TimestampMs,
  TransitionRecord,
} from '@payswap/protocol';
import { defineStateMachine } from '@payswap/protocol';
import type { StateMachine } from '@payswap/protocol';
import type { EvidenceGraph, EvidenceNode } from '@payswap/settlement';
import {
  assertClaimCurrency,
  enforceClaimWindow,
  enforceEvidenceRequirements,
} from './policy.js';
import type { RecoursePolicy, RecoursePolicyRegistry } from './policy.js';
import { resolveEvidenceRefs } from './evidence.js';

// ---------------------------------------------------------------------------
// Lifecycle (INV-X04)
// ---------------------------------------------------------------------------

export type DisputeState = 'OPEN' | 'UNDER_REVIEW' | 'GRANTED' | 'REJECTED' | 'WITHDRAWN';

export type DisputeEvent = 'REVIEW' | 'GRANT' | 'REJECT' | 'WITHDRAW' | 'REOPEN';

/** Guard context for the dispute machine. */
export interface DisputeMachineContext {
  readonly now: TimestampMs;
  /** Evidence nodes newly presented with this transition (REOPEN requires > 0). */
  readonly newEvidenceCount: number;
}

/**
 * The deterministic dispute lifecycle (INV-X04: terminal transitions are
 * monotonic except EXPLICIT recovery). GRANTED is terminal with NO recovery —
 * once recourse obligations exist, reopening would rewrite granted effects;
 * the only declared recovery is REJECTED --REOPEN--> UNDER_REVIEW, guarded on
 * new evidence being presented.
 */
export const disputeStateMachine: StateMachine<DisputeState, DisputeEvent, DisputeMachineContext> =
  defineStateMachine<DisputeState, DisputeEvent, DisputeMachineContext>({
    name: 'dispute-case',
    initial: 'OPEN',
    states: ['OPEN', 'UNDER_REVIEW', 'GRANTED', 'REJECTED', 'WITHDRAWN'],
    events: ['REVIEW', 'GRANT', 'REJECT', 'WITHDRAW', 'REOPEN'],
    transitions: [
      {
        from: 'OPEN',
        on: 'REVIEW',
        to: 'UNDER_REVIEW',
        description: 'adjudication begins',
      },
      {
        from: 'OPEN',
        on: 'GRANT',
        to: 'GRANTED',
        description: 'claim granted — terminal; effects are separate recourse obligations',
      },
      {
        from: 'OPEN',
        on: 'REJECT',
        to: 'REJECTED',
        description: 'claim denied',
      },
      {
        from: 'OPEN',
        on: 'WITHDRAW',
        to: 'WITHDRAWN',
        description: 'claimant withdraws the dispute',
      },
      {
        from: 'UNDER_REVIEW',
        on: 'GRANT',
        to: 'GRANTED',
        description: 'claim granted after review — terminal',
      },
      {
        from: 'UNDER_REVIEW',
        on: 'REJECT',
        to: 'REJECTED',
        description: 'claim denied after review',
      },
      {
        from: 'UNDER_REVIEW',
        on: 'WITHDRAW',
        to: 'WITHDRAWN',
        description: 'claimant withdraws during review',
      },
    ],
    terminalStates: ['GRANTED', 'REJECTED', 'WITHDRAWN'],
    recovery: [
      {
        from: 'REJECTED',
        on: 'REOPEN',
        to: 'UNDER_REVIEW',
        description:
          'explicit recovery only (INV-X04): a rejected dispute reopens with new evidence; the rejection stays in history',
      },
    ],
  });

/** One recorded dispute transition (history is append-only). */
export interface DisputeTransitionRecord extends TransitionRecord<DisputeState, DisputeEvent> {
  readonly recordedAt: TimestampMs;
}

// ---------------------------------------------------------------------------
// The dispute case record
// ---------------------------------------------------------------------------

/** The resolution attached once the dispute reaches a terminal state. */
export interface DisputeResolution {
  readonly outcome: 'GRANTED' | 'REJECTED' | 'WITHDRAWN';
  readonly resolvedAt: TimestampMs;
  /** Who/what adjudicated (operator, expert panel, automatic rule). */
  readonly adjudicatorRef: string;
  /** Present iff GRANTED — never exceeds the disputed amount. */
  readonly grantedAmount?: Money;
}

/**
 * The append-only dispute record. References the original transaction by id
 * only — the original is NEVER embedded or mutated here.
 */
export interface DisputeCase {
  readonly disputeId: string;
  readonly transactionRef: string;
  readonly policyId: string;
  readonly claimant: PartyId;
  readonly respondent: PartyId;
  readonly disputedAmount: Money;
  readonly reason: string;
  readonly state: DisputeState;
  readonly openedAt: TimestampMs;
  /** Evidence node ids in the settlement evidence graph (append-only). */
  readonly evidenceRefs: readonly string[];
  readonly resolution?: DisputeResolution;
  readonly history: readonly DisputeTransitionRecord[];
}

/** Command form for opening a dispute (a recourse CLAIM). */
export interface OpenDisputeCommand {
  readonly transactionRef: string;
  readonly claimant: PartyId;
  readonly respondent: PartyId;
  readonly disputedAmount: Money;
  readonly reason: string;
  /** Evidence node ids cited by the claim — resolved and enforced. */
  readonly evidenceRefs: readonly string[];
}

/** Input for one lifecycle event. */
export interface DisputeEventInput {
  readonly disputeId: string;
  readonly event: DisputeEvent;
  /** Adjudicator (GRANT/REJECT) or withdrawing principal (WITHDRAW). */
  readonly decidedBy?: string;
  /** Granted amount — required for GRANT, must not exceed the disputed amount. */
  readonly grantedAmount?: Money;
  /** Additional evidence presented with the transition (required for REOPEN). */
  readonly additionalEvidenceRefs?: readonly string[];
}

/** A dispute id was reused or is unknown. */
export class DisputeIdConflictError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'DisputeIdConflictError';
  }
}

/** No dispute exists under the given id. */
export class UnknownDisputeError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'UnknownDisputeError';
  }
}

/** A GRANT attempted to grant more than the disputed amount. */
export class DisputeGrantExceedsDisputedAmountError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'DisputeGrantExceedsDisputedAmountError';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertMoney(amount: Money, label: string): void {
  if (amount === null || typeof amount !== 'object') {
    throw new ValidationError(`${label} must be a Money object`);
  }
  if (typeof amount.value !== 'bigint') {
    throw new ValidationError(`${label}.value must be a bigint (INV-F01)`);
  }
  if (amount.value <= 0n) {
    throw new ValidationError(`${label} must be positive Money`);
  }
}

function freezeResolution(resolution: DisputeResolution): DisputeResolution {
  const frozen: {
    -readonly [K in keyof DisputeResolution]: DisputeResolution[K];
  } = {
    outcome: resolution.outcome,
    resolvedAt: resolution.resolvedAt,
    adjudicatorRef: resolution.adjudicatorRef,
  };
  if (resolution.grantedAmount !== undefined) frozen.grantedAmount = resolution.grantedAmount;
  return Object.freeze(frozen);
}

function freezeDispute(dispute: DisputeCase): DisputeCase {
  const frozen: {
    -readonly [K in keyof DisputeCase]: DisputeCase[K];
  } = {
    disputeId: dispute.disputeId,
    transactionRef: dispute.transactionRef,
    policyId: dispute.policyId,
    claimant: dispute.claimant,
    respondent: dispute.respondent,
    disputedAmount: dispute.disputedAmount,
    reason: dispute.reason,
    state: dispute.state,
    openedAt: dispute.openedAt,
    evidenceRefs: Object.freeze([...dispute.evidenceRefs]),
    history: Object.freeze([...dispute.history]),
  };
  if (dispute.resolution !== undefined) frozen.resolution = freezeResolution(dispute.resolution);
  return Object.freeze(frozen);
}

// ---------------------------------------------------------------------------
// The dispute authority
// ---------------------------------------------------------------------------

export interface DisputeAuthorityDeps {
  readonly policies: RecoursePolicyRegistry;
  readonly evidence: EvidenceGraph;
  readonly ids: IdFactory;
  readonly clock: ProtocolClock;
}

/**
 * Owns dispute cases: opening (with policy enforcement at claim time) and the
 * deterministic lifecycle. The authority NEVER receives the original
 * transaction object — only its reference — so it structurally cannot rewrite
 * it. Disputes are stored as frozen records; every transition produces a new
 * frozen version with the transition appended to history.
 */
export class DisputeAuthority {
  readonly #policies: RecoursePolicyRegistry;
  readonly #evidence: EvidenceGraph;
  readonly #ids: IdFactory;
  readonly #clock: ProtocolClock;
  readonly #byId = new Map<string, DisputeCase>();
  readonly #order: DisputeCase[] = [];

  constructor(deps: DisputeAuthorityDeps) {
    if (deps === null || typeof deps !== 'object') {
      throw new ValidationError('deps must be a DisputeAuthorityDeps object');
    }
    this.#policies = deps.policies;
    this.#evidence = deps.evidence;
    this.#ids = deps.ids;
    this.#clock = deps.clock;
  }

  /**
   * Open a dispute (file a recourse claim) against a transaction.
   *
   * Enforcement at claim time (W1-006 acceptance):
   * 1. the transaction must have a declared recourse policy;
   * 2. the claim window must be open at the injected clock reading;
   * 3. the cited evidence must exist and satisfy the policy's declared
   *    evidence requirements.
   *
   * The dispute references the transaction by id only.
   */
  openDispute(cmd: OpenDisputeCommand): DisputeCase {
    if (cmd === null || typeof cmd !== 'object') {
      throw new ValidationError('cmd must be an OpenDisputeCommand object');
    }
    if (!isNonEmptyString(cmd.transactionRef)) {
      throw new ValidationError('cmd.transactionRef must be a non-empty string');
    }
    if (!isNonEmptyString(cmd.claimant) || !isNonEmptyString(cmd.respondent)) {
      throw new ValidationError('cmd.claimant and cmd.respondent must be non-empty PartyIds');
    }
    if (cmd.claimant === cmd.respondent) {
      throw new ValidationError('a dispute cannot pit a party against itself');
    }
    if (!isNonEmptyString(cmd.reason)) {
      throw new ValidationError('cmd.reason must be a non-empty string');
    }
    assertMoney(cmd.disputedAmount, 'cmd.disputedAmount');

    const now = this.#clock.now();
    const policy: RecoursePolicy = this.#policies.requireForTransaction(cmd.transactionRef);
    enforceClaimWindow(policy, now);
    assertClaimCurrency(policy, cmd.disputedAmount);
    const presented: readonly EvidenceNode[] = resolveEvidenceRefs(
      this.#evidence,
      cmd.evidenceRefs,
    );
    enforceEvidenceRequirements(policy, presented);

    const disputeId = this.#ids.mintId('dsp');
    const dispute = freezeDispute({
      disputeId,
      transactionRef: cmd.transactionRef,
      policyId: policy.policyId,
      claimant: cmd.claimant,
      respondent: cmd.respondent,
      disputedAmount: cmd.disputedAmount,
      reason: cmd.reason,
      state: 'OPEN',
      openedAt: now,
      evidenceRefs: [...cmd.evidenceRefs],
      // history records MACHINE transitions only; the opening is stamped by
      // `openedAt` (same discipline as settlement finality records).
      history: [],
    });
    if (this.#byId.has(disputeId)) {
      throw new DisputeIdConflictError('dispute id already exists — ids are never reused', {
        disputeId,
      });
    }
    this.#byId.set(disputeId, dispute);
    this.#order.push(dispute);
    return dispute;
  }

  /**
   * Apply one lifecycle event under the deterministic machine (INV-X04).
   * Additional evidence (REOPEN) is resolved against the graph and appended —
   * evidence citation is append-only. GRANT validates the granted amount
   * against the disputed amount and stamps a resolution.
   */
  applyEvent(input: DisputeEventInput): DisputeCase {
    if (input === null || typeof input !== 'object') {
      throw new ValidationError('input must be a DisputeEventInput object');
    }
    if (!isNonEmptyString(input.disputeId)) {
      throw new ValidationError('input.disputeId must be a non-empty string');
    }
    const existing = this.#byId.get(input.disputeId);
    if (existing === undefined) {
      throw new UnknownDisputeError('no dispute exists under the given id', {
        disputeId: input.disputeId,
      });
    }
    const now = this.#clock.now();

    const additionalEvidence =
      input.additionalEvidenceRefs !== undefined
        ? resolveEvidenceRefs(this.#evidence, input.additionalEvidenceRefs)
        : [];
    if (input.event === 'REOPEN' && additionalEvidence.length === 0) {
      throw new ValidationError(
        'reopening a rejected dispute requires new evidence — recovery without new facts is forbidden',
        { disputeId: input.disputeId },
      );
    }

    let grantedAmount: Money | undefined;
    if (input.event === 'GRANT') {
      if (input.grantedAmount === undefined) {
        throw new ValidationError('GRANT requires a granted amount');
      }
      assertMoney(input.grantedAmount, 'input.grantedAmount');
      if (input.grantedAmount.currency !== existing.disputedAmount.currency) {
        throw new ValidationError('granted amount currency differs from the disputed amount');
      }
      if (input.grantedAmount.value > existing.disputedAmount.value) {
        throw new DisputeGrantExceedsDisputedAmountError(
          'granted amount exceeds the disputed amount',
          {
            disputeId: input.disputeId,
            disputed: existing.disputedAmount.value.toString(),
            granted: input.grantedAmount.value.toString(),
          },
        );
      }
      grantedAmount = input.grantedAmount;
    }
    if (
      (input.event === 'GRANT' || input.event === 'REJECT') &&
      !isNonEmptyString(input.decidedBy)
    ) {
      throw new ValidationError('GRANT and REJECT require an adjudicator reference');
    }

    const context: DisputeMachineContext = {
      now,
      newEvidenceCount: additionalEvidence.length,
    };
    const transition = disputeStateMachine.transition(existing.state, input.event, context);

    let resolution: DisputeResolution | undefined;
    if (transition.to === 'GRANTED') {
      resolution = {
        outcome: 'GRANTED',
        resolvedAt: now,
        adjudicatorRef: input.decidedBy ?? 'unknown',
        ...(grantedAmount !== undefined ? { grantedAmount } : {}),
      };
    } else if (transition.to === 'REJECTED') {
      resolution = {
        outcome: 'REJECTED',
        resolvedAt: now,
        adjudicatorRef: input.decidedBy ?? 'unknown',
      };
    } else if (transition.to === 'WITHDRAWN') {
      resolution = {
        outcome: 'WITHDRAWN',
        resolvedAt: now,
        adjudicatorRef: input.decidedBy ?? existing.claimant,
      };
    }

    const updated = freezeDispute({
      ...existing,
      state: transition.to,
      evidenceRefs: [...existing.evidenceRefs, ...additionalEvidence.map((node) => node.nodeId)],
      ...(resolution !== undefined ? { resolution } : {}),
      history: [
        ...existing.history,
        Object.freeze({
          from: transition.from,
          on: transition.on,
          to: transition.to,
          viaRecovery: transition.viaRecovery,
          recordedAt: now,
        }) as DisputeTransitionRecord,
      ],
    });
    this.#byId.set(updated.disputeId, updated);
    const index = this.#order.findIndex((candidate) => candidate.disputeId === updated.disputeId);
    if (index >= 0) {
      this.#order[index] = updated;
    }
    return updated;
  }

  /** One dispute by id (frozen). */
  get(disputeId: string): DisputeCase | undefined {
    return this.#byId.get(disputeId);
  }

  /** The dispute must exist — throws `UnknownDisputeError` otherwise. */
  require(disputeId: string): DisputeCase {
    const dispute = this.#byId.get(disputeId);
    if (dispute === undefined) {
      throw new UnknownDisputeError('no dispute exists under the given id', { disputeId });
    }
    return dispute;
  }

  /** All disputes in opening order (audit view). */
  all(): readonly DisputeCase[] {
    return Object.freeze([...this.#order]);
  }

  /** All disputes referencing one transaction, in opening order. */
  byTransaction(transactionRef: string): readonly DisputeCase[] {
    return Object.freeze(this.#order.filter((d) => d.transactionRef === transactionRef));
  }
}
