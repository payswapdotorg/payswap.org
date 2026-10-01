/**
 * @payswap/recourse — the escrow protection mechanism (W1-006).
 *
 * SECURITY-EVIDENCE-RECOURSE "Recourse" mechanisms include escrow. W1-006
 * acceptance: escrowed value is SEPARATELY ACCOUNTED — it lives in its own
 * reservation/account structure, never merged with operational balances.
 *
 * Concrete discipline (all machinery consumed from @payswap/protocol):
 *
 * - SEPARATE ACCOUNT: every escrow hold owns a dedicated
 *   `RESERVE:escrow.<escrowId>` journal account. Funding posts a balanced
 *   entry (INV-F03) moving the exact amount OUT of the funder's operational
 *   account INTO that reserve account; the value is unreachable from any
 *   operational balance projection while HELD.
 * - INV-F04: before the funding entry, a protocol reservation is placed on
 *   the funder's operational account (`reserve` fails closed on
 *   insufficient available value) and captured by the move. The escrowed
 *   value is then locked by a SECOND reservation placed on the dedicated
 *   escrow account itself — its own reservation/account structure.
 * - RELEASE / FORFEIT / REFUND are explicit evidence-backed decisions: the
 *   deterministic escrow state machine guards every disposition on presented
 *   evidence refs, and FORFEIT additionally requires a GRANTED dispute
 *   reference (adjudication before compensation). Forfeit pays the claimant;
 *   release pays the beneficiary; refund returns to the funder.
 * - INV-X04: RELEASED / FORFEITED / REFUNDED are terminal with no recovery.
 * - INV-F01: amounts are exact bigint Money throughout.
 */

import { ValidationError, accountId, createJournalEntry, postJournal } from '@payswap/protocol';
import {
  activateReservation,
  captureReservation,
  reserve,
} from '@payswap/protocol';
import type {
  PaySwapErrorDetails,
  AccountId,
  IdFactory,
  JournalEntryId,
  Money,
  ProtocolClock,
  ReservationId,
  ReservationLedgerState,
  TimestampMs,
  TransitionRecord,
} from '@payswap/protocol';
import { defineStateMachine } from '@payswap/protocol';
import type { StateMachine } from '@payswap/protocol';
import { negate } from '@payswap/protocol';
import type { DisputeAuthority } from './disputes.js';
import type { RecoursePolicy } from './policy.js';

// ---------------------------------------------------------------------------
// Lifecycle (INV-X04)
// ---------------------------------------------------------------------------

export type EscrowState = 'HELD' | 'RELEASED' | 'FORFEITED' | 'REFUNDED';

export type EscrowEvent = 'RELEASE' | 'FORFEIT' | 'REFUND';

/** Guard context: the decision evidence every disposition must present. */
export interface EscrowMachineContext {
  readonly now: TimestampMs;
  readonly evidenceRefs: readonly string[];
  /** REQUIRED for FORFEIT — the granted dispute being compensated. */
  readonly disputeRef?: string;
}

/**
 * The deterministic escrow lifecycle. Every disposition is guarded on an
 * explicit evidence-backed decision; FORFEIT additionally requires a dispute
 * reference. Terminal states are monotonic (INV-X04) — no recovery exists.
 */
export const escrowStateMachine: StateMachine<EscrowState, EscrowEvent, EscrowMachineContext> =
  defineStateMachine<EscrowState, EscrowEvent, EscrowMachineContext>({
    name: 'escrow-hold',
    initial: 'HELD',
    states: ['HELD', 'RELEASED', 'FORFEITED', 'REFUNDED'],
    events: ['RELEASE', 'FORFEIT', 'REFUND'],
    transitions: [
      {
        from: 'HELD',
        on: 'RELEASE',
        to: 'RELEASED',
        guard: (context) => context.evidenceRefs.length > 0,
        description: 'release to the beneficiary requires an evidence-backed decision',
      },
      {
        from: 'HELD',
        on: 'FORFEIT',
        to: 'FORFEITED',
        guard: (context) =>
          context.evidenceRefs.length > 0 && context.disputeRef !== undefined,
        description: 'forfeit to a claimant requires evidence AND a granted dispute reference',
      },
      {
        from: 'HELD',
        on: 'REFUND',
        to: 'REFUNDED',
        guard: (context) => context.evidenceRefs.length > 0,
        description: 'refund to the funder requires an evidence-backed decision',
      },
    ],
    terminalStates: ['RELEASED', 'FORFEITED', 'REFUNDED'],
  });

/** One recorded escrow transition (history is append-only). */
export interface EscrowTransitionRecord extends TransitionRecord<EscrowState, EscrowEvent> {
  readonly recordedAt: TimestampMs;
}

// ---------------------------------------------------------------------------
// The escrow hold record
// ---------------------------------------------------------------------------

/** The disposition decision attached once the hold reaches a terminal state. */
export interface EscrowDecision {
  readonly outcome: EscrowState;
  readonly decidedAt: TimestampMs;
  readonly evidenceRefs: readonly string[];
  /** Present iff FORFEITED — the granted dispute compensated by the forfeit. */
  readonly disputeRef?: string;
  /** Where the escrowed value moved (operational account of the payee). */
  readonly payeeAccount: AccountId;
  readonly dispositionEntryId: JournalEntryId;
}

/**
 * One separately-accounted escrow hold. The escrowed value lives in
 * `escrowAccount` (a dedicated RESERVE account) locked by `reservationId`
 * (a protocol reservation on that account) — never in an operational balance.
 */
export interface EscrowHold {
  readonly escrowId: string;
  readonly transactionRef: string;
  /** Present when the escrow implements a declared recourse policy mechanism. */
  readonly policyId?: string;
  readonly amount: Money;
  readonly funderAccount: AccountId;
  readonly beneficiaryAccount: AccountId;
  /** The DEDICATED reserve account holding the escrowed value. */
  readonly escrowAccount: AccountId;
  /** The protocol reservation locking the escrowed value in the reserve account. */
  readonly reservationId: ReservationId;
  readonly fundingEntryId: JournalEntryId;
  readonly state: EscrowState;
  readonly openedAt: TimestampMs;
  readonly decision?: EscrowDecision;
  readonly history: readonly EscrowTransitionRecord[];
}

/** Command form for opening an escrow hold. */
export interface OpenEscrowCommand {
  readonly transactionRef: string;
  readonly amount: Money;
  readonly funderAccount: AccountId;
  readonly beneficiaryAccount: AccountId;
  /** When provided, must be a policy declaring the ESCROW mechanism. */
  readonly policy?: RecoursePolicy;
}

/** Disposition input: evidence-backed decision parameters. */
export interface EscrowDispositionInput {
  readonly escrowId: string;
  readonly evidenceRefs: readonly string[];
  /** REQUIRED for FORFEIT — must reference a GRANTED dispute. */
  readonly disputeRef?: string;
  /** Operational account the forfeited value pays out to (claimant's). */
  readonly claimantAccount?: AccountId;
}

/** An escrow id was reused, is unknown, or the hold is not open. */
export class EscrowIdConflictError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'EscrowIdConflictError';
  }
}

export class UnknownEscrowError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'UnknownEscrowError';
  }
}

/** A disposition was attempted without the required evidence/decision input. */
export class EscrowDecisionIncompleteError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'EscrowDecisionIncompleteError';
  }
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

function assertEvidenceRefs(evidenceRefs: readonly string[]): void {
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
    throw new EscrowDecisionIncompleteError(
      'an escrow disposition requires at least one evidence reference — decisions are evidence-backed',
    );
  }
  for (const ref of evidenceRefs) {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new ValidationError('evidence refs must be non-empty strings');
    }
  }
}

function freezeHold(hold: EscrowHold): EscrowHold {
  const frozen: {
    -readonly [K in keyof EscrowHold]: EscrowHold[K];
  } = {
    escrowId: hold.escrowId,
    transactionRef: hold.transactionRef,
    amount: hold.amount,
    funderAccount: hold.funderAccount,
    beneficiaryAccount: hold.beneficiaryAccount,
    escrowAccount: hold.escrowAccount,
    reservationId: hold.reservationId,
    fundingEntryId: hold.fundingEntryId,
    state: hold.state,
    openedAt: hold.openedAt,
    history: Object.freeze([...hold.history]),
  };
  if (hold.policyId !== undefined) frozen.policyId = hold.policyId;
  if (hold.decision !== undefined) {
    frozen.decision = Object.freeze({
      outcome: hold.decision.outcome,
      decidedAt: hold.decision.decidedAt,
      evidenceRefs: Object.freeze([...hold.decision.evidenceRefs]),
      payeeAccount: hold.decision.payeeAccount,
      dispositionEntryId: hold.decision.dispositionEntryId,
      ...(hold.decision.disputeRef !== undefined
        ? { disputeRef: hold.decision.disputeRef }
        : {}),
    });
  }
  return Object.freeze(frozen);
}

// ---------------------------------------------------------------------------
// The escrow authority
// ---------------------------------------------------------------------------

export interface EscrowAuthorityDeps {
  /** Journal + reservation book + ids + clock, protocol-owned. */
  readonly ledger: ReservationLedgerState;
  /** Disputes — consulted (never mutated) to verify FORFEIT adjudication. */
  readonly disputes: DisputeAuthority;
}

/**
 * Owns escrow holds: separately accounted value with evidence-backed
 * dispositions. Every journal effect is posted through the protocol's
 * `createJournalEntry` + `postJournal` (INV-F03 balanced, INV-F02 append-only)
 * and every hold is locked by protocol reservations (INV-F04).
 */
export class EscrowAuthority {
  readonly #ledger: ReservationLedgerState;
  readonly #disputes: DisputeAuthority;
  readonly #byId = new Map<string, EscrowHold>();
  readonly #order: EscrowHold[] = [];

  constructor(deps: EscrowAuthorityDeps) {
    if (deps === null || typeof deps !== 'object') {
      throw new ValidationError('deps must be an EscrowAuthorityDeps object');
    }
    this.#ledger = deps.ledger;
    this.#disputes = deps.disputes;
  }

  /** All escrow holds in opening order (audit view). */
  all(): readonly EscrowHold[] {
    return Object.freeze([...this.#order]);
  }

  /** One escrow hold by id (frozen). */
  get(escrowId: string): EscrowHold | undefined {
    return this.#byId.get(escrowId);
  }

  /**
   * Open an escrow hold: the exact amount moves from the funder's operational
   * account into a DEDICATED `RESERVE:escrow.<id>` account (balanced entry,
   * INV-F03) and is locked there by a protocol reservation (INV-F04 checked
   * first on the funder's available value). The value never merges with any
   * operational balance while HELD.
   */
  openEscrow(cmd: OpenEscrowCommand): EscrowHold {
    if (cmd === null || typeof cmd !== 'object') {
      throw new ValidationError('cmd must be an OpenEscrowCommand object');
    }
    if (typeof cmd.transactionRef !== 'string' || cmd.transactionRef.length === 0) {
      throw new ValidationError('cmd.transactionRef must be a non-empty string');
    }
    assertMoney(cmd.amount, 'cmd.amount');
    if (typeof cmd.funderAccount !== 'string' || cmd.funderAccount.length === 0) {
      throw new ValidationError('cmd.funderAccount must be a non-empty AccountId');
    }
    if (typeof cmd.beneficiaryAccount !== 'string' || cmd.beneficiaryAccount.length === 0) {
      throw new ValidationError('cmd.beneficiaryAccount must be a non-empty AccountId');
    }
    if (cmd.policy !== undefined && !cmd.policy.mechanisms.includes('ESCROW')) {
      throw new ValidationError(
        `policy '${cmd.policy.policyId}' does not declare the ESCROW mechanism`,
        { policyId: cmd.policy.policyId },
      );
    }
    const { journal, reservations, ids, clock } = this.#ledger;
    const now = clock.now();

    const escrowId = ids.mintId('esc');
    if (this.#byId.has(escrowId)) {
      throw new EscrowIdConflictError('escrow id already exists — ids are never reused', {
        escrowId,
      });
    }
    const escrowAccount = accountId('RESERVE', `escrow.${escrowId}`);

    // 1. INV-F04: hold the funder's available value BEFORE moving it.
    const funderHold = reserve(this.#ledger, {
      accountId: cmd.funderAccount,
      amount: cmd.amount,
      refs: { correlationId: escrowId },
    });
    activateReservation(this.#ledger, funderHold.id);

    // 2. Balanced funding entry: operational account out, reserve account in.
    const fundingEntry = postJournal(
      journal,
      createJournalEntry(
        {
          lines: [
            { accountId: cmd.funderAccount, amount: negate(cmd.amount) },
            { accountId: escrowAccount, amount: cmd.amount },
          ],
          memo: `ESCROW_FUND:${escrowId}`,
          source: { correlationId: escrowId },
        },
        { ids, clock },
      ),
    );

    // 3. The move consumes the funder hold.
    captureReservation(this.#ledger, funderHold.id);

    // 4. Lock the escrowed value inside its own reservation/account structure.
    const escrowHoldReservation = reserve(this.#ledger, {
      accountId: escrowAccount,
      amount: cmd.amount,
      refs: { correlationId: escrowId },
    });
    activateReservation(this.#ledger, escrowHoldReservation.id);

    const hold = freezeHold({
      escrowId,
      transactionRef: cmd.transactionRef,
      ...(cmd.policy !== undefined ? { policyId: cmd.policy.policyId } : {}),
      amount: cmd.amount,
      funderAccount: cmd.funderAccount,
      beneficiaryAccount: cmd.beneficiaryAccount,
      escrowAccount,
      reservationId: escrowHoldReservation.id,
      fundingEntryId: fundingEntry.entryId,
      state: 'HELD',
      openedAt: now,
      history: [],
    });
    this.#byId.set(escrowId, hold);
    this.#order.push(hold);
    return hold;
  }

  /**
   * Generic disposition: RELEASE (to the beneficiary), FORFEIT (to a claimant,
   * requires a GRANTED dispute), or REFUND (to the funder). Every path is an
   * explicit evidence-backed decision guarded by the state machine; the
   * escrowed value leaves the dedicated reserve account through one final
   * balanced entry (INV-F03) and the hold becomes terminal (INV-X04).
   */
  #dispose(input: EscrowDispositionInput, event: EscrowEvent): EscrowHold {
    if (input === null || typeof input !== 'object') {
      throw new ValidationError('input must be an EscrowDispositionInput object');
    }
    if (typeof input.escrowId !== 'string' || input.escrowId.length === 0) {
      throw new ValidationError('input.escrowId must be a non-empty string');
    }
    const existing = this.#byId.get(input.escrowId);
    if (existing === undefined) {
      throw new UnknownEscrowError('no escrow hold exists under the given id', {
        escrowId: input.escrowId,
      });
    }
    assertEvidenceRefs(input.evidenceRefs);
    const { journal, ids, clock } = this.#ledger;
    const now = clock.now();

    let payeeAccount: AccountId;
    if (event === 'RELEASE') {
      payeeAccount = existing.beneficiaryAccount;
    } else if (event === 'REFUND') {
      payeeAccount = existing.funderAccount;
    } else {
      // FORFEIT: adjudication must exist and be GRANTED; the claimant's
      // operational account must be supplied.
      if (input.disputeRef === undefined) {
        throw new EscrowDecisionIncompleteError(
          'forfeiting an escrow hold requires the dispute reference of the granted claim',
          { escrowId: input.escrowId },
        );
      }
      const dispute = this.#disputes.require(input.disputeRef);
      if (dispute.state !== 'GRANTED') {
        throw new EscrowDecisionIncompleteError(
          'forfeiting an escrow hold requires a GRANTED dispute — adjudication precedes compensation',
          { escrowId: input.escrowId, disputeId: input.disputeRef, disputeState: dispute.state },
        );
      }
      if (input.claimantAccount === undefined) {
        throw new EscrowDecisionIncompleteError(
          'forfeiting an escrow hold requires the claimant account the value pays out to',
          { escrowId: input.escrowId },
        );
      }
      payeeAccount = input.claimantAccount;
    }

    const context: EscrowMachineContext = {
      now,
      evidenceRefs: input.evidenceRefs,
      ...(input.disputeRef !== undefined ? { disputeRef: input.disputeRef } : {}),
    };
    const transition = escrowStateMachine.transition(existing.state, event, context);

    // The lock is consumed by the disposition, then the value moves out of
    // the dedicated reserve account through one balanced entry.
    captureReservation(this.#ledger, existing.reservationId);
    const dispositionEntry = postJournal(
      journal,
      createJournalEntry(
        {
          lines: [
            { accountId: existing.escrowAccount, amount: negate(existing.amount) },
            { accountId: payeeAccount, amount: existing.amount },
          ],
          memo: `ESCROW_${event}:${existing.escrowId}`,
          source: { correlationId: existing.escrowId },
        },
        { ids, clock },
      ),
    );

    const updated = freezeHold({
      ...existing,
      state: transition.to,
      decision: {
        outcome: transition.to,
        decidedAt: now,
        evidenceRefs: [...input.evidenceRefs],
        payeeAccount,
        dispositionEntryId: dispositionEntry.entryId,
        ...(input.disputeRef !== undefined ? { disputeRef: input.disputeRef } : {}),
      },
      history: [
        ...existing.history,
        Object.freeze({
          from: transition.from,
          on: transition.on,
          to: transition.to,
          viaRecovery: transition.viaRecovery,
          recordedAt: now,
        }) as EscrowTransitionRecord,
      ],
    });
    this.#byId.set(updated.escrowId, updated);
    const index = this.#order.findIndex((candidate) => candidate.escrowId === updated.escrowId);
    if (index >= 0) {
      this.#order[index] = updated;
    }
    return updated;
  }

  /** HELD → RELEASED: pay the beneficiary (evidence-backed decision). */
  releaseEscrow(input: EscrowDispositionInput): EscrowHold {
    return this.#dispose(input, 'RELEASE');
  }

  /** HELD → FORFEITED: pay the claimant of a GRANTED dispute. */
  forfeitEscrow(input: EscrowDispositionInput): EscrowHold {
    return this.#dispose(input, 'FORFEIT');
  }

  /** HELD → REFUNDED: return the value to the funder (evidence-backed decision). */
  refundEscrow(input: EscrowDispositionInput): EscrowHold {
    return this.#dispose(input, 'REFUND');
  }
}
