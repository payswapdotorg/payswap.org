/**
 * @payswap/recourse — separate recourse obligations (W1-006).
 *
 * SECURITY-EVIDENCE-RECOURSE "Recourse": disputes never edit the original
 * transaction; they create separate adjudication and adjustment obligations.
 *
 * Recourse effects are produced through the PROTOCOL'S OWN obligation
 * machinery (consumed from @payswap/protocol — INV-F06: no financial mutation
 * bypasses the Financial Protocol Authority):
 *
 * - a granted dispute derives NEW obligations from a NEW recourse clearing
 *   record via `deriveObligations` (the deterministic fulfillment-activity →
 *   clearing-record → obligation pipeline). The derived obligation ids point
 *   at the recourse clearing record (`derivedFrom`), never at the original
 *   transaction's records;
 * - the ORIGINAL obligation is NEVER mutated: it keeps its id, amount, due
 *   window and state. A clawback is a SEPARATE obligation with reversed
 *   debtor/creditor, following INV-F02 append-only discipline — history is
 *   never rewritten, adjustments are new journal-grade facts;
 * - every linkage is recorded in an append-only `RecourseLedgerEntry`
 *   (obligation id ↔ dispute id ↔ mechanism ↔ original reference), so the
 *   full derivation chain is queryable at any time.
 */

import { ValidationError } from '@payswap/protocol';
import {
  asClearingRecordId,
  asFulfillmentActivityId,
  deriveObligations,
} from '@payswap/protocol';
import type {
  PaySwapErrorDetails,
  ClearingRecord,
  FulfillmentActivity,
  IdFactory,
  Money,
  Obligation,
  ObligationBook,
  ObligationDueWindow,
  ObligationId,
  PartyId,
  ProtocolClock,
  TimestampMs,
} from '@payswap/protocol';
import type { DisputeCase } from './disputes.js';
import type { RecourseMechanism } from './policy.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The kind of economic adjustment a recourse obligation records. */
export type RecourseAdjustmentKind =
  | 'CLAWBACK'
  | 'REFUND'
  | 'COMPENSATION'
  | 'BOND_FORFEITURE'
  | 'GUARANTEE_PAYOUT';

/** Append-only linkage between a minted recourse obligation and its cause. */
export interface RecourseLedgerEntry {
  readonly entryId: string;
  readonly obligationId: ObligationId;
  readonly disputeId: string;
  readonly mechanism: RecourseMechanism;
  readonly adjustmentKind: RecourseAdjustmentKind;
  /** The original obligation being compensated, when there is one. Never mutated. */
  readonly originalObligationRef?: ObligationId;
  readonly clearingRecordId: ClearingRecord['id'];
  readonly createdAt: TimestampMs;
}

/** Command form: mint the separate obligations a granted dispute produces. */
export interface GrantRecourseObligationsCommand {
  /** MUST be a GRANTED dispute — effects only exist after adjudication. */
  readonly dispute: DisputeCase;
  /** Who must compensate whom (typically respondent → claimant). */
  readonly debtor: PartyId;
  readonly creditor: PartyId;
  readonly amount: Money;
  readonly mechanism: RecourseMechanism;
  readonly adjustmentKind: RecourseAdjustmentKind;
  /** The original obligation this adjustment compensates (referenced, never mutated). */
  readonly originalObligationRef?: ObligationId;
  readonly dueWindow: ObligationDueWindow;
}

/** Recourse was requested against a dispute that is not GRANTED. */
export class DisputeNotGrantedError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'DisputeNotGrantedError';
  }
}

/** The recourse amount exceeds what the granted dispute allows. */
export class RecourseAmountExceedsGrantError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'RecourseAmountExceedsGrantError';
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

// ---------------------------------------------------------------------------
// The recourse obligation authority
// ---------------------------------------------------------------------------

export interface RecourseObligationAuthorityDeps {
  /** The protocol obligation book — the single authoritative store. */
  readonly book: ObligationBook;
  readonly ids: IdFactory;
  readonly clock: ProtocolClock;
}

/**
 * Produces the SEPARATE obligations/effects of granted disputes through the
 * protocol's own obligation machinery. This authority never touches an
 * original obligation: it derives new clearing records and lets
 * `deriveObligations` (consumed, deterministic, exact) mint new positions.
 */
export class RecourseObligationAuthority {
  readonly #book: ObligationBook;
  readonly #ids: IdFactory;
  readonly #clock: ProtocolClock;
  readonly #entries: RecourseLedgerEntry[] = [];
  readonly #entriesByDispute = new Map<string, RecourseLedgerEntry[]>();

  constructor(deps: RecourseObligationAuthorityDeps) {
    if (deps === null || typeof deps !== 'object') {
      throw new ValidationError('deps must be a RecourseObligationAuthorityDeps object');
    }
    this.#book = deps.book;
    this.#ids = deps.ids;
    this.#clock = deps.clock;
  }

  /**
   * Mint the separate recourse obligations of a GRANTED dispute.
   *
   * Deterministic pipeline (all consumed from the protocol):
   * 1. one recourse `FulfillmentActivity` (debtor compensates creditor) with
   *    correlation lineage to the dispute id;
   * 2. one NEW recourse `ClearingRecord`;
   * 3. `deriveObligations` mints the NEW obligations (PENDING, own ids,
   *    `derivedFrom` = the recourse clearing record);
   * 4. the new obligations are added to the shared protocol book and the
   *    linkage is recorded in the append-only recourse ledger.
   *
   * Guards: the dispute MUST be GRANTED; the amount MUST be positive, in the
   * dispute's currency, and MUST NOT exceed the granted amount. The ORIGINAL
   * obligation (when referenced) is never read for mutation and never
   * rewritten.
   */
  grantRecourseObligations(cmd: GrantRecourseObligationsCommand): readonly Obligation[] {
    if (cmd === null || typeof cmd !== 'object') {
      throw new ValidationError('cmd must be a GrantRecourseObligationsCommand object');
    }
    if (cmd.dispute.state !== 'GRANTED') {
      throw new DisputeNotGrantedError(
        'recourse obligations are only produced by GRANTED disputes — adjudication precedes effects',
        { disputeId: cmd.dispute.disputeId, state: cmd.dispute.state },
      );
    }
    assertMoney(cmd.amount, 'cmd.amount');
    if (cmd.debtor === cmd.creditor) {
      throw new ValidationError('a recourse obligation cannot debtor and credit the same party');
    }
    if (cmd.amount.currency !== cmd.dispute.disputedAmount.currency) {
      throw new ValidationError('recourse amount currency differs from the disputed amount', {
        disputeCurrency: String(cmd.dispute.disputedAmount.currency),
        amountCurrency: String(cmd.amount.currency),
      });
    }
    const granted = cmd.dispute.resolution?.grantedAmount ?? cmd.dispute.disputedAmount;
    if (cmd.amount.value > granted.value) {
      throw new RecourseAmountExceedsGrantError(
        'recourse amount exceeds the granted amount of the dispute',
        {
          disputeId: cmd.dispute.disputeId,
          granted: granted.value.toString(),
          requested: cmd.amount.value.toString(),
        },
      );
    }
    // CUMULATIVE bound: the total recourse minted for one dispute can never
    // exceed its adjudicated grant — repeated claims/invocations/clawbacks
    // citing the same dispute cannot overcompensate (exact arithmetic).
    let alreadyMinted = 0n;
    for (const entry of this.#entriesByDispute.get(cmd.dispute.disputeId) ?? []) {
      const existing = this.#book.get(entry.obligationId);
      if (existing !== undefined) {
        alreadyMinted += existing.amount.value;
      }
    }
    if (alreadyMinted + cmd.amount.value > granted.value) {
      throw new RecourseAmountExceedsGrantError(
        'cumulative recourse for this dispute would exceed the granted amount',
        {
          disputeId: cmd.dispute.disputeId,
          granted: granted.value.toString(),
          alreadyMinted: alreadyMinted.toString(),
          requested: cmd.amount.value.toString(),
        },
      );
    }
    const now = this.#clock.now();

    // 1. the recourse fulfillment activity — a NEW fact, never an edit.
    const activity: FulfillmentActivity = Object.freeze({
      id: asFulfillmentActivityId(this.#ids.mintId('rfa')),
      activityType: `RECOURSE_${cmd.adjustmentKind}`,
      debtor: cmd.debtor,
      creditor: cmd.creditor,
      amount: cmd.amount,
      occurredAt: now,
      refs: Object.freeze({ correlationId: cmd.dispute.disputeId }),
    });

    // 2. the NEW recourse clearing record — separate from any original.
    const clearingRecord: ClearingRecord = Object.freeze({
      id: asClearingRecordId(this.#ids.mintId('rcr')),
      activities: Object.freeze([activity]),
      netted: false,
    });

    // 3. protocol-own derivation: new obligations with own ids.
    const obligations = deriveObligations([clearingRecord], {
      dueWindow: cmd.dueWindow,
      ids: this.#ids,
    });

    // 4. store + linkage (append-only).
    for (const obligation of obligations) {
      this.#book.add(obligation);
      const entry: RecourseLedgerEntry = Object.freeze({
        entryId: this.#ids.mintId('rle'),
        obligationId: obligation.id,
        disputeId: cmd.dispute.disputeId,
        mechanism: cmd.mechanism,
        adjustmentKind: cmd.adjustmentKind,
        clearingRecordId: clearingRecord.id,
        createdAt: now,
        ...(cmd.originalObligationRef !== undefined
          ? { originalObligationRef: cmd.originalObligationRef }
          : {}),
      });
      this.#entries.push(entry);
      const list = this.#entriesByDispute.get(cmd.dispute.disputeId) ?? [];
      list.push(entry);
      this.#entriesByDispute.set(cmd.dispute.disputeId, list);
    }
    return obligations;
  }

  /**
   * Clawback-style adjustment (INV-F02 append-only discipline): compensates an
   * ORIGINAL obligation by minting a SEPARATE reversed obligation. The
   * original keeps its exact id/amount/window/state — verified by tests.
   */
  clawbackObligation(cmd: {
    readonly dispute: DisputeCase;
    readonly originalObligation: Obligation;
    readonly amount: Money;
    readonly mechanism: RecourseMechanism;
    readonly dueWindow: ObligationDueWindow;
  }): readonly Obligation[] {
    if (cmd === null || typeof cmd !== 'object') {
      throw new ValidationError('cmd must be a clawback command object');
    }
    if (this.#book.get(cmd.originalObligation.id) === undefined) {
      throw new ValidationError('the original obligation must exist in the protocol book', {
        obligationId: cmd.originalObligation.id,
      });
    }
    if (cmd.amount.currency !== cmd.originalObligation.amount.currency) {
      throw new ValidationError('clawback currency differs from the original obligation');
    }
    // The clawback reverses the direction: the original creditor compensates
    // the original debtor.
    return this.grantRecourseObligations({
      dispute: cmd.dispute,
      debtor: cmd.originalObligation.creditor,
      creditor: cmd.originalObligation.debtor,
      amount: cmd.amount,
      mechanism: cmd.mechanism,
      adjustmentKind: 'CLAWBACK',
      originalObligationRef: cmd.originalObligation.id,
      dueWindow: cmd.dueWindow,
    });
  }

  /** All recourse ledger entries in creation order (audit view). */
  entries(): readonly RecourseLedgerEntry[] {
    return Object.freeze([...this.#entries]);
  }

  /** The recourse effects produced by one dispute, in creation order. */
  entriesForDispute(disputeId: string): readonly RecourseLedgerEntry[] {
    return Object.freeze([...(this.#entriesByDispute.get(disputeId) ?? [])]);
  }

  /** The obligations minted for one dispute (resolved against the book). */
  obligationsForDispute(disputeId: string): readonly Obligation[] {
    const obligations: Obligation[] = [];
    for (const entry of this.entriesForDispute(disputeId)) {
      const obligation = this.#book.get(entry.obligationId);
      if (obligation !== undefined) {
        obligations.push(obligation);
      }
    }
    return Object.freeze(obligations);
  }
}
