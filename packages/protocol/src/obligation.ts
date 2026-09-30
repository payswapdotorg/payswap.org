/**
 * @payswap/protocol — fulfillment activities, clearing records and
 * obligations (W1-002).
 *
 * FROZEN-ARCHITECTURE §8 hierarchy (Stage 1 slice):
 *
 *   fulfillment activity → clearing record → obligation
 *
 * `deriveObligations` is a PURE, deterministic derivation: obligations are
 * computed from clearing records by exact integer netting per
 * (debtor, creditor, currency) — never minted by hand, never mutated in
 * place. INV-F07: netting never changes gross obligations without preserving
 * derivation — the clearing record always retains its gross activities and
 * every derived obligation carries `derivedFrom` pointing at the record it
 * was computed from.
 *
 * Obligation lifecycle (deterministic state machine, W1-001 kernel):
 *
 *   PENDING --SETTLE--> SETTLED   (guard: now within the due window)
 *   PENDING --CANCEL--> CANCELLED (always allowed while pending)
 *   PENDING --DEFAULT--> DEFAULTED(guard: now strictly after the window closed)
 *
 * SETTLED / CANCELLED / DEFAULTED are terminal and monotonic (INV-X04); no
 * recovery rule exists at Stage 1 — late settlement and dispute/recourse
 * recovery are W1-004/W1-006 scope and would arrive as declared recovery
 * transitions, never as history rewrites.
 */

import { fromMinorUnits, isPositive, type CurrencyCode, type Money } from './money.js';
import { PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';
import { InvalidIdentifierError } from './identifiers.js';
import type { CommandId, EventId, IdFactory } from './identifiers.js';
import type { ProtocolClock, TimestampMs } from './clock.js';
import { defineStateMachine, type StateMachine } from './state-machine.js';

declare const PartyIdBrand: unique symbol;

/**
 * Branded id of a network participant (the debtor or creditor side of an
 * obligation). `>` is a reserved separator and may not appear in a PartyId.
 */
export type PartyId = string & { readonly [PartyIdBrand]: 'PartyId' };

declare const FulfillmentActivityIdBrand: unique symbol;

/** Branded id of one fulfillment activity. */
export type FulfillmentActivityId = string & {
  readonly [FulfillmentActivityIdBrand]: 'FulfillmentActivityId';
};

declare const ClearingRecordIdBrand: unique symbol;

/** Branded id of one clearing record. */
export type ClearingRecordId = string & {
  readonly [ClearingRecordIdBrand]: 'ClearingRecordId';
};

declare const ObligationIdBrand: unique symbol;

/** Branded id of one obligation. */
export type ObligationId = string & { readonly [ObligationIdBrand]: 'ObligationId' };

/** Lineage refs attached to a fulfillment activity. */
export interface ActivityRefs {
  readonly causationId?: CommandId | EventId;
  readonly correlationId?: string;
}

/**
 * One unit of fulfilled economic activity: `debtor` owes `creditor`
 * `amount` (positive, exact) as of `occurredAt`.
 */
export interface FulfillmentActivity {
  readonly id: FulfillmentActivityId;
  readonly activityType: string;
  readonly debtor: PartyId;
  readonly creditor: PartyId;
  readonly amount: Money;
  readonly occurredAt: TimestampMs;
  readonly refs?: ActivityRefs;
}

/**
 * A clearing record groups fulfillment activities cleared together.
 * INV-F07: `netted` marks that these activities are already net positions
 * from an upstream netting set — the gross derivation is preserved here
 * regardless, and `deriveObligations` still nets deterministically within
 * the record.
 */
export interface ClearingRecord {
  readonly id: ClearingRecordId;
  readonly activities: readonly FulfillmentActivity[];
  readonly netted: boolean;
}

/** Temporal settlement window (FROZEN §9): [opensAt, closesAt]. */
export interface ObligationDueWindow {
  readonly opensAt: TimestampMs;
  readonly closesAt: TimestampMs;
}

/** Lifecycle of an obligation. */
export type ObligationState = 'PENDING' | 'SETTLED' | 'CANCELLED' | 'DEFAULTED';

/** Events the obligation state machine declares. */
export type ObligationEvent = 'SETTLE' | 'CANCEL' | 'DEFAULT';

/** Guard context: the injected clock reading plus the obligation's window. */
export interface ObligationMachineContext {
  readonly now: TimestampMs;
  readonly dueWindow: ObligationDueWindow;
}

/**
 * One derived payable position: `debtor` owes `creditor` `amount` within
 * `dueWindow`. Obligations are protocol records of network positions
 * (FROZEN §8A) — never a claim of custody.
 */
export interface Obligation {
  readonly id: ObligationId;
  readonly debtor: PartyId;
  readonly creditor: PartyId;
  readonly amount: Money;
  readonly dueWindow: ObligationDueWindow;
  readonly state: ObligationState;
  /** INV-F07: the clearing record this obligation was deterministically derived from. */
  readonly derivedFrom: ClearingRecordId;
}

/** Options controlling the deterministic derivation. */
export interface DeriveObligationsOptions {
  /** Due window stamped on every derived obligation. */
  readonly dueWindow: ObligationDueWindow;
  /**
   * Optional injected id factory. When omitted, ids are content-derived
   * (`OBL:<recordId>:<pair>:<currency>`) so replay without a factory still
   * produces identical, collision-checked ids.
   */
  readonly ids?: IdFactory;
}

/** Storage-agnostic obligation store contract. */
export interface ObligationBook {
  /** All obligations in insertion order. */
  readonly all: readonly Obligation[];
  get(id: ObligationId): Obligation | undefined;
  add(obligation: Obligation): void;
  replace(obligation: Obligation): void;
}

/** No obligation exists under the given id. */
export class UnknownObligationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'UNKNOWN_OBLIGATION', category: 'NOT_FOUND', message, details });
  }
}

/** An obligation id already exists (ids are never reused). */
export class ObligationIdConflictError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'OBLIGATION_ID_CONFLICT', category: 'CONFLICT', message, details });
  }
}

const MAX_ID_LENGTH = 256;
const MAX_TYPE_LENGTH = 128;
const PAIR_SEPARATOR = '>';

/**
 * The deterministic obligation lifecycle machine. SETTLE is guarded to the
 * due window; DEFAULT is guarded to strictly after the window closes; CANCEL
 * is always available while PENDING. Terminal states are monotonic (INV-X04).
 */
export const obligationStateMachine: StateMachine<
  ObligationState,
  ObligationEvent,
  ObligationMachineContext
> = defineStateMachine<ObligationState, ObligationEvent, ObligationMachineContext>({
  name: 'obligation',
  initial: 'PENDING',
  states: ['PENDING', 'SETTLED', 'CANCELLED', 'DEFAULTED'],
  events: ['SETTLE', 'CANCEL', 'DEFAULT'],
  transitions: [
    {
      from: 'PENDING',
      on: 'SETTLE',
      to: 'SETTLED',
      guard: (context) =>
        context.now >= context.dueWindow.opensAt && context.now <= context.dueWindow.closesAt,
      description: 'settlement is only declarable inside the due window',
    },
    {
      from: 'PENDING',
      on: 'CANCEL',
      to: 'CANCELLED',
      description: 'cancellation while the obligation is pending',
    },
    {
      from: 'PENDING',
      on: 'DEFAULT',
      to: 'DEFAULTED',
      guard: (context) => context.now > context.dueWindow.closesAt,
      description: 'default is only declarable after the due window closed',
    },
  ],
  terminalStates: ['SETTLED', 'CANCELLED', 'DEFAULTED'],
});

/** Brand a validated string as a `PartyId`. */
export function asPartyId(value: string): PartyId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError('PartyId must be a non-empty string', { value });
  }
  if (value.length > 128) {
    throw new InvalidIdentifierError('PartyId exceeds 128 characters', { value });
  }
  if (value.includes(PAIR_SEPARATOR)) {
    throw new InvalidIdentifierError(`PartyId must not contain '${PAIR_SEPARATOR}'`, { value });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError('PartyId must not carry surrounding whitespace', { value });
  }
  return value as PartyId;
}

/** Brand a validated string as a `FulfillmentActivityId`. */
export function asFulfillmentActivityId(value: string): FulfillmentActivityId {
  return brandSimpleId(value, 'FulfillmentActivityId');
}

/** Brand a validated string as a `ClearingRecordId`. */
export function asClearingRecordId(value: string): ClearingRecordId {
  return brandSimpleId(value, 'ClearingRecordId');
}

/** Brand a validated string as an `ObligationId`. */
export function asObligationId(value: string): ObligationId {
  return brandSimpleId(value, 'ObligationId');
}

function brandSimpleId<TBranded extends string>(value: string, kind: string): TBranded {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError(`${kind} must be a non-empty string`, { kind, value });
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new InvalidIdentifierError(`${kind} exceeds ${MAX_ID_LENGTH} characters`, {
      kind,
      value,
    });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError(`${kind} must not carry surrounding whitespace`, {
      kind,
      value,
    });
  }
  return value as TBranded;
}

function assertMoneyAmount(amount: Money, label: string): CurrencyCode {
  if (amount === null || typeof amount !== 'object') {
    throw new ValidationError(`${label} must be a Money object`, { label });
  }
  if (typeof amount.currency !== 'string' || amount.currency.length === 0) {
    throw new ValidationError(`${label}.currency must be a non-empty string`, { label });
  }
  if (typeof amount.value === 'number') {
    throw new ValidationError(`${label}.value is a JS number — forbidden (INV-F01)`, { label });
  }
  if (typeof amount.value !== 'bigint') {
    throw new ValidationError(`${label}.value must be a bigint`, { label });
  }
  return amount.currency;
}

function freezeDueWindow(dueWindow: ObligationDueWindow): ObligationDueWindow {
  return Object.freeze({ opensAt: dueWindow.opensAt, closesAt: dueWindow.closesAt });
}

function freezeObligation(obligation: Obligation): Obligation {
  return Object.freeze({
    id: obligation.id,
    debtor: obligation.debtor,
    creditor: obligation.creditor,
    amount: obligation.amount,
    dueWindow: freezeDueWindow(obligation.dueWindow),
    state: obligation.state,
    derivedFrom: obligation.derivedFrom,
  });
}

/**
 * Deterministically derive obligations from clearing records.
 *
 * For each record, activities are netted per unordered (debtor, creditor)
 * pair and per currency with exact bigint arithmetic:
 * - positive net → the pair's low-id party owes the high-id party the net;
 * - negative net → mirrored debtor/creditor, absolute net;
 * - zero net → the pair fully offsets and no obligation is produced.
 *
 * Output ordering is fully deterministic: records in input order, then pair
 * keys lexicographically, then currencies lexicographically. The input
 * records are never mutated (INV-F07: gross derivation preserved).
 */
export function deriveObligations(
  clearingRecords: readonly ClearingRecord[],
  options: DeriveObligationsOptions,
): readonly Obligation[] {
  if (!Array.isArray(clearingRecords)) {
    throw new ValidationError('clearingRecords must be an array');
  }
  if (options === null || typeof options !== 'object') {
    throw new ValidationError('options must be a DeriveObligationsOptions object');
  }
  const dueWindow = options.dueWindow;
  if (dueWindow === null || typeof dueWindow !== 'object') {
    throw new ValidationError('options.dueWindow must be an ObligationDueWindow');
  }
  if (typeof dueWindow.opensAt !== 'bigint' || typeof dueWindow.closesAt !== 'bigint') {
    throw new ValidationError('options.dueWindow bounds must be bigint TimestampMs');
  }
  if (dueWindow.closesAt < dueWindow.opensAt) {
    throw new ValidationError('options.dueWindow closes before it opens');
  }

  // Validation pass — the whole input is validated before any obligation is
  // produced (atomic derivation: all or nothing).
  const recordIds = new Set<string>();
  const activityIds = new Set<string>();
  let latestActivityAt: TimestampMs | undefined;
  for (const [recordIndex, record] of clearingRecords.entries()) {
    if (record === null || typeof record !== 'object') {
      throw new ValidationError(`clearingRecords[${recordIndex}] must be a ClearingRecord`);
    }
    const recordId = asClearingRecordId(record.id);
    if (recordIds.has(recordId)) {
      throw new ValidationError('duplicate clearing record id', { record: recordId });
    }
    recordIds.add(recordId);
    if (typeof record.netted !== 'boolean') {
      throw new ValidationError('clearing record netted must be a boolean', { record: recordId });
    }
    if (!Array.isArray(record.activities) || record.activities.length === 0) {
      throw new ValidationError('a clearing record requires at least one activity', {
        record: recordId,
      });
    }
    for (const [activityIndex, activity] of record.activities.entries()) {
      if (activity === null || typeof activity !== 'object') {
        throw new ValidationError(
          `clearingRecords[${recordIndex}].activities[${activityIndex}] must be a FulfillmentActivity`,
        );
      }
      const activityId = asFulfillmentActivityId(activity.id);
      if (activityIds.has(activityId)) {
        throw new ValidationError('duplicate fulfillment activity id', { activity: activityId });
      }
      activityIds.add(activityId);
      if (
        typeof activity.activityType !== 'string' ||
        activity.activityType.length === 0 ||
        activity.activityType.length > MAX_TYPE_LENGTH
      ) {
        throw new ValidationError('activity.activityType must be 1..128 characters', {
          activity: activityId,
        });
      }
      const debtor = asPartyId(activity.debtor);
      const creditor = asPartyId(activity.creditor);
      if (debtor === creditor) {
        throw new ValidationError('a fulfillment activity cannot debtor and credit the same party', {
          activity: activityId,
          party: debtor,
        });
      }
      assertMoneyAmount(activity.amount, `activities[${activityIndex}].amount`);
      if (!isPositive(activity.amount)) {
        throw new ValidationError('activity amounts must be positive Money', {
          activity: activityId,
        });
      }
      if (typeof activity.occurredAt !== 'bigint') {
        throw new ValidationError('activity.occurredAt must be a bigint TimestampMs', {
          activity: activityId,
        });
      }
      if (latestActivityAt === undefined || activity.occurredAt > latestActivityAt) {
        latestActivityAt = activity.occurredAt;
      }
    }
  }
  if (latestActivityAt !== undefined && dueWindow.opensAt < latestActivityAt) {
    throw new ValidationError(
      'due window cannot open before the latest underlying activity occurred',
      {
        opensAt: dueWindow.opensAt.toString(),
        latestActivityAt: latestActivityAt.toString(),
      },
    );
  }

  // Derivation pass — pure netting per (pair, currency).
  const obligations: Obligation[] = [];
  const mintedIds = new Set<string>();
  for (const record of clearingRecords) {
    interface PairGroup {
      readonly low: PartyId;
      readonly high: PartyId;
      readonly perCurrency: Map<CurrencyCode, bigint>;
    }
    const groups = new Map<string, PairGroup>();
    for (const activity of record.activities) {
      const low = activity.debtor < activity.creditor ? activity.debtor : activity.creditor;
      const high = activity.debtor < activity.creditor ? activity.creditor : activity.debtor;
      const key = `${low}${PAIR_SEPARATOR}${high}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = { low, high, perCurrency: new Map<CurrencyCode, bigint>() };
        groups.set(key, group);
      }
      // debtor === low ⇒ low's debt increases; debtor === high ⇒ it decreases.
      const sign = activity.debtor === low ? 1n : -1n;
      const current = group.perCurrency.get(activity.amount.currency) ?? 0n;
      group.perCurrency.set(activity.amount.currency, current + sign * activity.amount.value);
    }
    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key);
      if (group === undefined) continue;
      for (const currency of [...group.perCurrency.keys()].sort()) {
        const net = group.perCurrency.get(currency);
        if (net === undefined || net === 0n) continue;
        const debtor = net > 0n ? group.low : group.high;
        const creditor = net > 0n ? group.high : group.low;
        const amount = fromMinorUnits(currency, net > 0n ? net : -net);
        const id =
          options.ids !== undefined
            ? asObligationId(options.ids.mintId('obl'))
            : asObligationId(`OBL:${record.id}:${key}:${currency}`);
        if (mintedIds.has(id)) {
          throw new ValidationError('obligation id collision during derivation', { id });
        }
        mintedIds.add(id);
        obligations.push(
          freezeObligation({
            id,
            debtor,
            creditor,
            amount,
            dueWindow,
            state: 'PENDING',
            derivedFrom: record.id,
          }),
        );
      }
    }
  }
  return Object.freeze(obligations);
}

/**
 * Apply one declared obligation event under the deterministic machine, with
 * guard context drawn from the injected clock and the obligation's due
 * window. Returns the updated (frozen) obligation.
 */
export function applyObligationEvent(
  book: ObligationBook,
  id: ObligationId,
  event: ObligationEvent,
  clock: ProtocolClock,
): Obligation {
  const existing = book.get(id);
  if (existing === undefined) {
    throw new UnknownObligationError('no obligation exists under the given id', { id });
  }
  const context: ObligationMachineContext = { now: clock.now(), dueWindow: existing.dueWindow };
  const record = obligationStateMachine.transition(existing.state, event, context);
  const updated = freezeObligation({ ...existing, state: record.to });
  book.replace(updated);
  return updated;
}

/** PENDING → SETTLED, only declarable inside the due window. */
export function settleObligation(
  book: ObligationBook,
  id: ObligationId,
  clock: ProtocolClock,
): Obligation {
  return applyObligationEvent(book, id, 'SETTLE', clock);
}

/** PENDING → CANCELLED, available at any time while pending. */
export function cancelObligation(
  book: ObligationBook,
  id: ObligationId,
  clock: ProtocolClock,
): Obligation {
  return applyObligationEvent(book, id, 'CANCEL', clock);
}

/** PENDING → DEFAULTED, only declarable strictly after the window closed. */
export function defaultObligation(
  book: ObligationBook,
  id: ObligationId,
  clock: ProtocolClock,
): Obligation {
  return applyObligationEvent(book, id, 'DEFAULT', clock);
}

/**
 * Deterministic in-memory reference obligation book. Stores frozen copies;
 * returns frozen copies; ids are never reused.
 */
export class InMemoryObligationBook implements ObligationBook {
  private readonly _byId = new Map<ObligationId, Obligation>();
  private readonly _order: Obligation[] = [];

  get all(): readonly Obligation[] {
    return Object.freeze([...this._order]);
  }

  get(id: ObligationId): Obligation | undefined {
    const stored = this._byId.get(id);
    return stored === undefined ? undefined : stored;
  }

  add(obligation: Obligation): void {
    if (this._byId.has(obligation.id)) {
      throw new ObligationIdConflictError('obligation id already exists', { id: obligation.id });
    }
    const stored = freezeObligation(obligation);
    this._byId.set(stored.id, stored);
    this._order.push(stored);
  }

  replace(obligation: Obligation): void {
    const existing = this._byId.get(obligation.id);
    if (existing === undefined) {
      throw new UnknownObligationError('cannot replace an unknown obligation', {
        id: obligation.id,
      });
    }
    const stored = freezeObligation(obligation);
    this._byId.set(stored.id, stored);
    const index = this._order.findIndex((candidate) => candidate.id === stored.id);
    if (index >= 0) {
      this._order[index] = stored;
    }
  }
}
