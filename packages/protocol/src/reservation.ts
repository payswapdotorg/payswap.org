/**
 * @payswap/protocol — atomic reservations / holds (W1-002).
 *
 * INV-F04: reservations cannot exceed authorized available value.
 *
 * `available = projected balance − active reservations` is computed inside
 * the single synchronous `reserve` call, and the hold is written only after
 * every check passes — there is no observable intermediate state, so a
 * second command racing the same capacity (modeled as an interleaved command
 * application) deterministically fails with `InsufficientAvailableFundsError`.
 *
 * Capacity holders are reservations in PENDING or ACTIVE state. Expiry is
 * evaluated exclusively through the injected `ProtocolClock` — no timers are
 * ever scheduled and no ambient host time is read anywhere in this module.
 *
 * State machine (deterministic, declared via the W1-001 kernel):
 *
 *   PENDING --ACTIVATE--> ACTIVE --CAPTURE--> CAPTURED (terminal)
 *   PENDING --RELEASE--> RELEASED (terminal)
 *   PENDING --EXPIRE---> EXPIRED (terminal)
 *   ACTIVE  --RELEASE--> RELEASED (terminal)
 *   ACTIVE  --EXPIRE---> EXPIRED (terminal)
 *
 * Terminal states are monotonic (INV-X04): there is no recovery rule at
 * Stage 1. ACTIVATE and CAPTURE are refused once the reservation's expiry
 * has passed (the caller must EXPIRE it first); EXPIRE is refused before the
 * expiry actually passes.
 */

import { add, compare, isPositive, sub, zero, CurrencyMismatchError, type CurrencyCode, type Money } from './money.js';
import { PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';
import { InvalidIdentifierError } from './identifiers.js';
import type { CommandId, EventId, IdFactory } from './identifiers.js';
import type { ProtocolClock, TimestampMs } from './clock.js';
import { defineStateMachine, type StateMachine } from './state-machine.js';
import { projectBalances } from './ledger/projections.js';
import { MixedCurrencyAccountError, UnknownAccountError } from './ledger/journal.js';
import type { AccountId, LedgerJournal } from './ledger/journal.js';

declare const ReservationIdBrand: unique symbol;

/** Branded id of one reservation. */
export type ReservationId = string & { readonly [ReservationIdBrand]: 'ReservationId' };

/** Lifecycle of a reservation/hold. */
export type ReservationState = 'PENDING' | 'ACTIVE' | 'CAPTURED' | 'RELEASED' | 'EXPIRED';

/** Events the reservation state machine declares. */
export type ReservationEvent = 'ACTIVATE' | 'CAPTURE' | 'RELEASE' | 'EXPIRE';

/** Guard context: the injected clock reading plus the reservation's expiry. */
export interface ReservationMachineContext {
  readonly now: TimestampMs;
  readonly expiresAt: TimestampMs | undefined;
}

function isExpiredContext(context: ReservationMachineContext): boolean {
  return context.expiresAt !== undefined && context.now >= context.expiresAt;
}

/**
 * The deterministic reservation state machine (INV-X04: CAPTURED, RELEASED
 * and EXPIRED are terminal with no declared recovery at Stage 1).
 */
export const reservationStateMachine: StateMachine<
  ReservationState,
  ReservationEvent,
  ReservationMachineContext
> = defineStateMachine<ReservationState, ReservationEvent, ReservationMachineContext>({
  name: 'reservation',
  initial: 'PENDING',
  states: ['PENDING', 'ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED'],
  events: ['ACTIVATE', 'CAPTURE', 'RELEASE', 'EXPIRE'],
  transitions: [
    {
      from: 'PENDING',
      on: 'ACTIVATE',
      to: 'ACTIVE',
      guard: (context) => !isExpiredContext(context),
      description: 'activation refused once the hold has expired',
    },
    { from: 'PENDING', on: 'RELEASE', to: 'RELEASED', description: 'release before activation' },
    {
      from: 'PENDING',
      on: 'EXPIRE',
      to: 'EXPIRED',
      guard: (context) => isExpiredContext(context),
      description: 'expiry is declarative: only after expiresAt',
    },
    {
      from: 'ACTIVE',
      on: 'CAPTURE',
      to: 'CAPTURED',
      guard: (context) => !isExpiredContext(context),
      description: 'capture refused once the hold has expired',
    },
    { from: 'ACTIVE', on: 'RELEASE', to: 'RELEASED', description: 'release an active hold' },
    {
      from: 'ACTIVE',
      on: 'EXPIRE',
      to: 'EXPIRED',
      guard: (context) => isExpiredContext(context),
      description: 'expiry is declarative: only after expiresAt',
    },
  ],
  terminalStates: ['CAPTURED', 'RELEASED', 'EXPIRED'],
});

/** Lineage refs attached to a reservation. */
export interface ReservationRefs {
  readonly causationId?: CommandId | EventId;
  readonly correlationId?: string;
}

/** One atomic reservation/hold over an account's available capacity. */
export interface Reservation {
  readonly id: ReservationId;
  readonly accountId: AccountId;
  readonly amount: Money;
  readonly state: ReservationState;
  readonly createdAt: TimestampMs;
  /** Absent when the reservation never expires. */
  readonly expiresAt?: TimestampMs;
  readonly refs?: ReservationRefs;
}

/** Command form for `reserve`. */
export interface ReserveCommand {
  readonly accountId: AccountId;
  readonly amount: Money;
  readonly expiresAt?: TimestampMs;
  readonly refs?: ReservationRefs;
}

/**
 * Storage-agnostic reservation store contract. `add`/`replace` are the only
 * mutations; reservation HISTORY is append-only in the sense that ids are
 * never reused and terminal states never regress.
 */
export interface ReservationBook {
  /** All reservations in creation order. */
  readonly all: readonly Reservation[];
  get(id: ReservationId): Reservation | undefined;
  byAccount(accountId: AccountId): readonly Reservation[];
  add(reservation: Reservation): void;
  replace(reservation: Reservation): void;
}

/**
 * The state `reserve` reasons over: the append-only journal (whose
 * projections define balances), the reservation book, and the injected
 * id factory + clock. No ambient dependencies.
 */
export interface ReservationLedgerState {
  readonly journal: LedgerJournal;
  readonly reservations: ReservationBook;
  readonly ids: IdFactory;
  readonly clock: ProtocolClock;
}

/** Breakdown of authorized availability for one account (INV-F04). */
export interface FundsAvailability {
  readonly currency: CurrencyCode;
  readonly balance: Money;
  readonly held: Money;
  readonly available: Money;
}

/** INV-F04: the requested hold exceeds available (balance − held) value. */
export class InsufficientAvailableFundsError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'INSUFFICIENT_AVAILABLE_FUNDS', category: 'CONFLICT', message, details });
  }
}

/** No reservation exists under the given id. */
export class UnknownReservationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'UNKNOWN_RESERVATION', category: 'NOT_FOUND', message, details });
  }
}

/** A reservation id already exists (ids are never reused). */
export class ReservationIdConflictError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'RESERVATION_ID_CONFLICT', category: 'CONFLICT', message, details });
  }
}

/** Brand a validated string as a `ReservationId`. */
export function asReservationId(value: string): ReservationId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError('ReservationId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new InvalidIdentifierError('ReservationId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError('ReservationId must not carry surrounding whitespace', { value });
  }
  return value as ReservationId;
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

function freezeReservation(reservation: Reservation): Reservation {
  const frozen: {
    -readonly [K in keyof Reservation]: Reservation[K];
  } = {
    id: reservation.id,
    accountId: reservation.accountId,
    amount: reservation.amount,
    state: reservation.state,
    createdAt: reservation.createdAt,
  };
  if (reservation.expiresAt !== undefined) frozen.expiresAt = reservation.expiresAt;
  if (reservation.refs !== undefined) frozen.refs = Object.freeze({ ...reservation.refs });
  return Object.freeze(frozen);
}

/** Sum of amounts currently holding capacity (PENDING or ACTIVE). */
function heldAmount(
  state: ReservationLedgerState,
  accountId: AccountId,
  currency: CurrencyCode,
): Money {
  let total: Money = zero(currency);
  for (const reservation of state.reservations.byAccount(accountId)) {
    if (reservation.state !== 'PENDING' && reservation.state !== 'ACTIVE') continue;
    if (reservation.amount.currency !== currency) {
      throw new MixedCurrencyAccountError(
        'reservation book mixes currencies on one account',
        { accountId, expected: currency, found: reservation.amount.currency },
      );
    }
    total = add(total, reservation.amount);
  }
  return total;
}

/**
 * Compute the INV-F04 breakdown for one account: projected balance, capacity
 * held by PENDING/ACTIVE reservations, and their difference. Throws
 * `UnknownAccountError` when the account has no projected balance at all.
 */
export function availableFunds(
  state: ReservationLedgerState,
  accountId: AccountId,
): FundsAvailability {
  const balance = projectBalances(state.journal, accountId).get(accountId);
  if (balance === undefined) {
    throw new UnknownAccountError('account has no projected balance in the journal', {
      accountId,
    });
  }
  const held = heldAmount(state, accountId, balance.currency);
  return Object.freeze({ currency: balance.currency, balance, held, available: sub(balance, held) });
}

/**
 * Atomically place a hold: `available = projected balance − active holds`,
 * and the reservation is written only when the requested amount fits.
 * Exceeding availability throws `InsufficientAvailableFundsError` (INV-F04)
 * and leaves the book untouched — a failed reserve is never half-applied.
 *
 * Layering note: the journal itself does not know about reservations. A
 * later journal entry MAY debit a reserved account below its held capacity
 * (for example an external reconciliation); `available` then legitimately
 * goes negative and every further reservation on that account fails until
 * the projection recovers. Capacity-aware posting policy is W1-003 scope.
 */
export function reserve(state: ReservationLedgerState, cmd: ReserveCommand): Reservation {
  if (cmd === null || typeof cmd !== 'object') {
    throw new ValidationError('cmd must be a ReserveCommand object');
  }
  const accountId = cmd.accountId;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new ValidationError('cmd.accountId must be a non-empty AccountId string');
  }
  const currency = assertMoneyAmount(cmd.amount, 'cmd.amount');
  if (!isPositive(cmd.amount)) {
    throw new ValidationError('cmd.amount must be positive Money');
  }
  const now = state.clock.now();
  const expiresAt = cmd.expiresAt;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'bigint') {
      throw new ValidationError('cmd.expiresAt must be a bigint TimestampMs when present');
    }
    if (expiresAt <= now) {
      throw new ValidationError(
        'cmd.expiresAt must be strictly after the injected clock reading',
        { expiresAt: expiresAt.toString(), now: now.toString() },
      );
    }
  }

  const balance = projectBalances(state.journal, accountId).get(accountId);
  let available: Money;
  if (balance === undefined) {
    // An account with no projected balance has zero available capacity.
    available = zero(currency);
  } else {
    if (balance.currency !== currency) {
      throw new CurrencyMismatchError('reservation currency differs from the account currency', {
        accountId,
        account: balance.currency,
        requested: currency,
      });
    }
    available = sub(balance, heldAmount(state, accountId, currency));
  }

  if (compare(cmd.amount, available) > 0) {
    throw new InsufficientAvailableFundsError(
      'reservation exceeds authorized available value (INV-F04)',
      {
        accountId,
        currency,
        requested: cmd.amount.value.toString(),
        available: available.value.toString(),
        balance: balance === undefined ? '0' : balance.value.toString(),
      },
    );
  }

  const reservation = freezeReservation({
    id: asReservationId(state.ids.mintId('rsv')),
    accountId,
    amount: cmd.amount,
    state: 'PENDING',
    createdAt: now,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(cmd.refs !== undefined ? { refs: cmd.refs } : {}),
  });
  state.reservations.add(reservation);
  return reservation;
}

/**
 * Apply one declared reservation event under the deterministic machine,
 * with guard context drawn from the injected clock and the reservation's
 * own expiry. Returns the updated (frozen) reservation.
 */
export function transitionReservation(
  state: ReservationLedgerState,
  id: ReservationId,
  event: ReservationEvent,
): Reservation {
  const existing = state.reservations.get(id);
  if (existing === undefined) {
    throw new UnknownReservationError('no reservation exists under the given id', { id });
  }
  const context: ReservationMachineContext = {
    now: state.clock.now(),
    expiresAt: existing.expiresAt,
  };
  const record = reservationStateMachine.transition(existing.state, event, context);
  const updated = freezeReservation({ ...existing, state: record.to });
  state.reservations.replace(updated);
  return updated;
}

/** PENDING → ACTIVE (refused after expiry). */
export function activateReservation(
  state: ReservationLedgerState,
  id: ReservationId,
): Reservation {
  return transitionReservation(state, id, 'ACTIVATE');
}

/** ACTIVE → CAPTURED (terminal; refused after expiry). */
export function captureReservation(
  state: ReservationLedgerState,
  id: ReservationId,
): Reservation {
  return transitionReservation(state, id, 'CAPTURE');
}

/** PENDING/ACTIVE → RELEASED (terminal; releases held capacity). */
export function releaseReservation(
  state: ReservationLedgerState,
  id: ReservationId,
): Reservation {
  return transitionReservation(state, id, 'RELEASE');
}

/** PENDING/ACTIVE → EXPIRED (terminal; only once expiresAt has passed). */
export function expireReservation(
  state: ReservationLedgerState,
  id: ReservationId,
): Reservation {
  return transitionReservation(state, id, 'EXPIRE');
}

/**
 * Declarative expiry sweep driven by the injected clock: expires every
 * PENDING/ACTIVE reservation whose `expiresAt` has passed. Returns the ids
 * expired, in creation order. Deterministic for a clock reading.
 */
export function expireDueReservations(
  state: ReservationLedgerState,
  accountId?: AccountId,
): readonly ReservationId[] {
  const now = state.clock.now();
  const expired: ReservationId[] = [];
  for (const reservation of state.reservations.all) {
    if (accountId !== undefined && reservation.accountId !== accountId) continue;
    if (reservation.state !== 'PENDING' && reservation.state !== 'ACTIVE') continue;
    if (reservation.expiresAt !== undefined && reservation.expiresAt <= now) {
      transitionReservation(state, reservation.id, 'EXPIRE');
      expired.push(reservation.id);
    }
  }
  return Object.freeze(expired);
}

/**
 * Deterministic in-memory reference reservation book. Stores frozen copies;
 * returns frozen copies; ids are never reused.
 */
export class InMemoryReservationBook implements ReservationBook {
  private readonly _byId = new Map<ReservationId, Reservation>();
  private readonly _order: Reservation[] = [];

  get all(): readonly Reservation[] {
    return Object.freeze([...this._order]);
  }

  get(id: ReservationId): Reservation | undefined {
    const stored = this._byId.get(id);
    return stored === undefined ? undefined : stored;
  }

  byAccount(accountId: AccountId): readonly Reservation[] {
    return Object.freeze(this._order.filter((reservation) => reservation.accountId === accountId));
  }

  add(reservation: Reservation): void {
    if (this._byId.has(reservation.id)) {
      throw new ReservationIdConflictError('reservation id already exists', {
        id: reservation.id,
      });
    }
    const stored = freezeReservation(reservation);
    this._byId.set(stored.id, stored);
    this._order.push(stored);
  }

  replace(reservation: Reservation): void {
    const existing = this._byId.get(reservation.id);
    if (existing === undefined) {
      throw new UnknownReservationError('cannot replace an unknown reservation', {
        id: reservation.id,
      });
    }
    const stored = freezeReservation(reservation);
    this._byId.set(stored.id, stored);
    const index = this._order.findIndex((candidate) => candidate.id === stored.id);
    if (index >= 0) {
      this._order[index] = stored;
    }
  }
}
