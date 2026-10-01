/**
 * @payswap/protocol — liquidity assets, positions, reservations and
 * forecasts (W1-003).
 *
 * FROZEN-ARCHITECTURE §3 liquidity loop: demand forecast → gap → capability
 * discovery → liquidity/credit strategy → reservation → settlement →
 * measured outcome. This module freezes the deterministic contract slice of
 * that loop.
 *
 * INV-C09-adjacent: a `LiquidityPosition` is an OBSERVATION of value held at
 * an external venue/capability — it is never a PaySwap custodial balance.
 * Positions carry explicit observation provenance.
 *
 * `LiquidityReservation` reuses the W1-002 reservation state machine
 * (`reservationStateMachine`: PENDING → ACTIVE → CAPTURED / RELEASED /
 * EXPIRED, INV-X04 terminality) so liquidity holds and ledger holds share
 * one lifecycle vocabulary. Reserving is ATOMIC (INV-F04): available =
 * observed position − active holds, checked and written in one synchronous
 * call with no observable intermediate state.
 *
 * Determinism: every function receives the clock by injection; nothing in
 * this module reads host time, schedules timers or uses entropy.
 */

import {
  add,
  compare,
  fromMinorUnits,
  isPositive,
  sub,
  type CurrencyCode,
  type Money,
} from './money.js';
import { PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';
import { InvalidIdentifierError } from './identifiers.js';
import type { IdFactory } from './identifiers.js';
import type { ProtocolClock, TimestampMs } from './clock.js';
import type { ReservationId, ReservationState } from './reservation.js';
import { asReservationId, reservationStateMachine } from './reservation.js';

declare const LiquidityAssetIdBrand: unique symbol;

/** Branded id of one liquidity asset (an external venue/capability slot). */
export type LiquidityAssetId = string & { readonly [LiquidityAssetIdBrand]: 'LiquidityAssetId' };

/** What kind of external venue holds the observed value. */
export type LiquidityAssetKind =
  | 'SETTLEMENT_ACCOUNT'
  | 'WALLET'
  | 'ESCROW'
  | 'TREASURY'
  | 'PROVIDER_POSITION';

/**
 * One liquidity asset: the descriptor of WHERE value is observed. The asset
 * itself carries no balance — balances live in `LiquidityPosition`
 * observations (INV-C09: external positions are observations, not custody).
 */
export interface LiquidityAsset {
  readonly id: LiquidityAssetId;
  readonly label: string;
  readonly kind: LiquidityAssetKind;
  readonly currency: CurrencyCode;
  /** External venue/rail descriptor, e.g. `rail:mobile-money:GHS:issuer-x`. */
  readonly venue: string;
}

/** How a liquidity position came to be known (observation provenance). */
export interface LiquidityPositionProvenance {
  /** Observation source descriptor, e.g. `provider-balance-report`. */
  readonly source: string;
  /** Reference to the underlying observation record at the source. */
  readonly observationRef: string;
  readonly observedAt: TimestampMs;
}

/**
 * An OBSERVATION of value at a liquidity asset as of a point in time.
 * Never a PaySwap custodial balance (INV-C09).
 */
export interface LiquidityPosition {
  readonly assetId: LiquidityAssetId;
  readonly balance: Money;
  readonly asOf: TimestampMs;
  readonly provenance: LiquidityPositionProvenance;
}

/** Why a liquidity reservation exists. */
export interface LiquidityReservationRefs {
  /** Human/machine readable purpose, e.g. `settlement-instruction-backing`. */
  readonly purpose: string;
  readonly correlationId?: string;
}

/**
 * An atomic hold over observed value at one liquidity asset. Lifecycle is
 * the W1-002 reservation state machine — PENDING/ACTIVE hold capacity;
 * CAPTURED/RELEASED/EXPIRED are terminal (INV-X04).
 */
export interface LiquidityReservation {
  readonly id: ReservationId;
  readonly assetId: LiquidityAssetId;
  readonly amount: Money;
  readonly state: ReservationState;
  readonly createdAt: TimestampMs;
  readonly expiresAt?: TimestampMs;
  readonly refs: LiquidityReservationRefs;
}

/** Command form for `reserveLiquidity`. */
export interface ReserveLiquidityCommand {
  readonly assetId: LiquidityAssetId;
  readonly amount: Money;
  readonly expiresAt?: TimestampMs;
  readonly refs: LiquidityReservationRefs;
}

/**
 * Storage-agnostic liquidity reservation store contract. Ids are never
 * reused; terminal states never regress.
 */
export interface LiquidityReservationBook {
  readonly all: readonly LiquidityReservation[];
  get(id: ReservationId): LiquidityReservation | undefined;
  byAsset(assetId: LiquidityAssetId): readonly LiquidityReservation[];
  add(reservation: LiquidityReservation): void;
  replace(reservation: LiquidityReservation): void;
}

/** The state liquidity operations reason over (all injected, no ambient). */
export interface LiquidityLedgerState {
  readonly positions: ReadonlyMap<LiquidityAssetId, LiquidityPosition>;
  readonly reservations: LiquidityReservationBook;
  readonly ids: IdFactory;
  readonly clock: ProtocolClock;
}

/** INV-F04: the hold exceeds observed position − active holds. */
export class InsufficientLiquidityError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'INSUFFICIENT_LIQUIDITY', category: 'CONFLICT', message, details });
  }
}

/** No liquidity position observation exists for the asset. */
export class UnknownLiquidityAssetError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'UNKNOWN_LIQUIDITY_ASSET', category: 'NOT_FOUND', message, details });
  }
}

/** No liquidity reservation exists under the given id. */
export class UnknownLiquidityReservationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'UNKNOWN_LIQUIDITY_RESERVATION', category: 'NOT_FOUND', message, details });
  }
}

/** A liquidity reservation id already exists. */
export class LiquidityReservationConflictError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'LIQUIDITY_RESERVATION_CONFLICT', category: 'CONFLICT', message, details });
  }
}

const MAX_LABEL_LENGTH = 128;

/** Brand a validated string as a `LiquidityAssetId`. */
export function asLiquidityAssetId(value: string): LiquidityAssetId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError('LiquidityAssetId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new InvalidIdentifierError('LiquidityAssetId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError('LiquidityAssetId must not carry surrounding whitespace', {
      value,
    });
  }
  return value as LiquidityAssetId;
}

/** Construct a validated, frozen liquidity asset descriptor. */
export function defineLiquidityAsset(input: {
  readonly id: string;
  readonly label: string;
  readonly kind: LiquidityAssetKind;
  readonly currency: CurrencyCode;
  readonly venue: string;
}): LiquidityAsset {
  const id = asLiquidityAssetId(input.id);
  if (typeof input.label !== 'string' || input.label.length === 0) {
    throw new ValidationError('liquidity asset label must be a non-empty string', { id });
  }
  if (input.label.length > MAX_LABEL_LENGTH) {
    throw new ValidationError(`liquidity asset label exceeds ${MAX_LABEL_LENGTH} characters`, {
      id,
    });
  }
  const KINDS: readonly LiquidityAssetKind[] = [
    'SETTLEMENT_ACCOUNT',
    'WALLET',
    'ESCROW',
    'TREASURY',
    'PROVIDER_POSITION',
  ];
  if (!KINDS.includes(input.kind)) {
    throw new ValidationError('liquidity asset kind is not a declared kind', {
      id,
      kind: input.kind,
    });
  }
  if (typeof input.venue !== 'string' || input.venue.length === 0) {
    throw new ValidationError('liquidity asset venue must be a non-empty string', { id });
  }
  if (typeof input.currency !== 'string' || input.currency.length === 0) {
    throw new ValidationError('liquidity asset currency must be set', { id });
  }
  return Object.freeze({
    id,
    label: input.label,
    kind: input.kind,
    currency: input.currency,
    venue: input.venue,
  });
}

/** Construct a validated liquidity position observation (INV-C09: observation, not custody). */
export function observeLiquidityPosition(input: {
  readonly assetId: string;
  readonly balance: Money;
  readonly asOf: TimestampMs;
  readonly provenance: LiquidityPositionProvenance;
}): LiquidityPosition {
  const assetId = asLiquidityAssetId(input.assetId);
  if (input.balance === null || typeof input.balance !== 'object') {
    throw new ValidationError('balance must be a Money object', { assetId });
  }
  if (typeof input.balance.value === 'number') {
    throw new ValidationError('balance.value is a JS number — forbidden (INV-F01)', { assetId });
  }
  if (typeof input.balance.value !== 'bigint') {
    throw new ValidationError('balance.value must be a bigint', { assetId });
  }
  if (input.balance.value < 0n) {
    throw new ValidationError('an observed liquidity position cannot be negative', { assetId });
  }
  if (typeof input.asOf !== 'bigint') {
    throw new ValidationError('asOf must be a bigint TimestampMs', { assetId });
  }
  const provenance = input.provenance;
  if (provenance === null || typeof provenance !== 'object') {
    throw new ValidationError('provenance must be a LiquidityPositionProvenance', { assetId });
  }
  if (
    typeof provenance.source !== 'string' ||
    provenance.source.length === 0 ||
    typeof provenance.observationRef !== 'string' ||
    provenance.observationRef.length === 0 ||
    typeof provenance.observedAt !== 'bigint'
  ) {
    throw new ValidationError('provenance must carry source, observationRef and observedAt', {
      assetId,
    });
  }
  if (provenance.observedAt > input.asOf) {
    throw new ValidationError('provenance cannot be observed after the position asOf', {
      assetId,
    });
  }
  return Object.freeze({
    assetId,
    balance: input.balance,
    asOf: input.asOf,
    provenance: Object.freeze({ ...provenance }),
  });
}

function freezeLiquidityReservation(reservation: LiquidityReservation): LiquidityReservation {
  const frozen: { -readonly [K in keyof LiquidityReservation]: LiquidityReservation[K] } = {
    id: reservation.id,
    assetId: reservation.assetId,
    amount: reservation.amount,
    state: reservation.state,
    createdAt: reservation.createdAt,
    refs: Object.freeze({ ...reservation.refs }),
  };
  if (reservation.expiresAt !== undefined) frozen.expiresAt = reservation.expiresAt;
  return Object.freeze(frozen);
}

/** Sum of amounts currently holding capacity at one asset (PENDING/ACTIVE). */
function heldLiquidity(
  state: LiquidityLedgerState,
  assetId: LiquidityAssetId,
  currency: CurrencyCode,
): Money {
  let total: Money = fromMinorUnits(currency, 0n);
  for (const reservation of state.reservations.byAsset(assetId)) {
    if (reservation.state !== 'PENDING' && reservation.state !== 'ACTIVE') continue;
    if (reservation.amount.currency !== currency) {
      throw new ValidationError('liquidity reservations mix currencies on one asset', {
        assetId,
        expected: currency,
        found: reservation.amount.currency,
      });
    }
    total = add(total, reservation.amount);
  }
  return total;
}

/** Deterministic in-memory reference liquidity reservation book. */
export class InMemoryLiquidityReservationBook implements LiquidityReservationBook {
  private readonly _byId = new Map<ReservationId, LiquidityReservation>();
  private readonly _byAsset = new Map<LiquidityAssetId, LiquidityReservation[]>();
  private readonly _order: LiquidityReservation[] = [];

  get all(): readonly LiquidityReservation[] {
    return Object.freeze([...this._order]);
  }

  get(id: ReservationId): LiquidityReservation | undefined {
    return this._byId.get(id);
  }

  byAsset(assetId: LiquidityAssetId): readonly LiquidityReservation[] {
    return Object.freeze([...(this._byAsset.get(assetId) ?? [])]);
  }

  add(reservation: LiquidityReservation): void {
    if (this._byId.has(reservation.id)) {
      throw new LiquidityReservationConflictError('liquidity reservation id already exists', {
        id: reservation.id,
      });
    }
    const stored = freezeLiquidityReservation(reservation);
    this._byId.set(stored.id, stored);
    const bucket = this._byAsset.get(stored.assetId);
    if (bucket === undefined) {
      this._byAsset.set(stored.assetId, [stored]);
    } else {
      bucket.push(stored);
    }
    this._order.push(stored);
  }

  replace(reservation: LiquidityReservation): void {
    const existing = this._byId.get(reservation.id);
    if (existing === undefined) {
      throw new UnknownLiquidityReservationError(
        'cannot replace an unknown liquidity reservation',
        { id: reservation.id },
      );
    }
    const stored = freezeLiquidityReservation(reservation);
    this._byId.set(stored.id, stored);
    const bucket = this._byAsset.get(stored.assetId);
    if (bucket !== undefined) {
      const index = bucket.findIndex((candidate) => candidate.id === stored.id);
      if (index >= 0) {
        bucket[index] = stored;
      }
    }
    const orderIndex = this._order.findIndex((candidate) => candidate.id === stored.id);
    if (orderIndex >= 0) {
      this._order[orderIndex] = stored;
    }
  }
}

/**
 * Observed available liquidity at one asset:
 * `available = observed position − PENDING/ACTIVE holds` (INV-F04 basis).
 * Throws `UnknownLiquidityAssetError` when no position is observed.
 */
export function availableLiquidity(
  state: LiquidityLedgerState,
  assetId: LiquidityAssetId,
): { readonly position: LiquidityPosition; readonly held: Money; readonly available: Money } {
  const position = state.positions.get(assetId);
  if (position === undefined) {
    throw new UnknownLiquidityAssetError('no liquidity position observed for the asset', {
      assetId,
    });
  }
  const held = heldLiquidity(state, assetId, position.balance.currency);
  return Object.freeze({
    position,
    held,
    available: sub(position.balance, held),
  });
}

/**
 * Atomically place a liquidity hold. The hold is written only when the
 * requested amount fits observed position − active holds; otherwise
 * `InsufficientLiquidityError` is thrown and the book is untouched —
 * a failed reservation is never half-applied (INV-F04).
 */
export function reserveLiquidity(
  state: LiquidityLedgerState,
  cmd: ReserveLiquidityCommand,
): LiquidityReservation {
  if (cmd === null || typeof cmd !== 'object') {
    throw new ValidationError('cmd must be a ReserveLiquidityCommand object');
  }
  const assetId = asLiquidityAssetId(cmd.assetId);
  const position = state.positions.get(assetId);
  if (position === undefined) {
    throw new UnknownLiquidityAssetError('no liquidity position observed for the asset', {
      assetId,
    });
  }
  if (cmd.amount === null || typeof cmd.amount !== 'object') {
    throw new ValidationError('cmd.amount must be a Money object', { assetId });
  }
  if (typeof cmd.amount.value === 'number') {
    throw new ValidationError('cmd.amount.value is a JS number — forbidden (INV-F01)', {
      assetId,
    });
  }
  if (typeof cmd.amount.value !== 'bigint') {
    throw new ValidationError('cmd.amount.value must be a bigint', { assetId });
  }
  if (!isPositive(cmd.amount)) {
    throw new ValidationError('a liquidity reservation must be a positive amount', { assetId });
  }
  if (cmd.amount.currency !== position.balance.currency) {
    throw new ValidationError('reservation currency must match the observed position currency', {
      assetId,
      expected: position.balance.currency,
      found: cmd.amount.currency,
    });
  }
  if (
    cmd.refs === null ||
    typeof cmd.refs !== 'object' ||
    typeof cmd.refs.purpose !== 'string' ||
    cmd.refs.purpose.length === 0
  ) {
    throw new ValidationError('cmd.refs.purpose must be a non-empty string', { assetId });
  }
  if (cmd.expiresAt !== undefined && typeof cmd.expiresAt !== 'bigint') {
    throw new ValidationError('cmd.expiresAt must be a bigint TimestampMs when present', {
      assetId,
    });
  }
  const now = state.clock.now();
  if (cmd.expiresAt !== undefined && cmd.expiresAt <= now) {
    throw new ValidationError('cmd.expiresAt must lie strictly in the future', { assetId });
  }

  const held = heldLiquidity(state, assetId, position.balance.currency);
  const available = sub(position.balance, held);
  if (compare(cmd.amount, available) > 0) {
    throw new InsufficientLiquidityError(
      'requested liquidity hold exceeds observed available value (INV-F04)',
      {
        assetId,
        available: available.value.toString(),
        requested: cmd.amount.value.toString(),
      },
    );
  }

  const reservation: LiquidityReservation = freezeLiquidityReservation({
    id: asReservationId(state.ids.mintId('liq')),
    assetId,
    amount: cmd.amount,
    state: 'PENDING',
    createdAt: now,
    ...(cmd.expiresAt !== undefined ? { expiresAt: cmd.expiresAt } : {}),
    refs: { purpose: cmd.refs.purpose, ...('correlationId' in cmd.refs ? { correlationId: cmd.refs.correlationId } : {}) },
  });
  state.reservations.add(reservation);
  return reservation;
}

/** Transition a liquidity reservation under the shared W1-002 machine. */
export function transitionLiquidityReservation(
  state: LiquidityLedgerState,
  id: ReservationId,
  event: 'ACTIVATE' | 'CAPTURE' | 'RELEASE' | 'EXPIRE',
): LiquidityReservation {
  const existing = state.reservations.get(id);
  if (existing === undefined) {
    throw new UnknownLiquidityReservationError('no liquidity reservation exists under the id', {
      id,
    });
  }
  const record = reservationStateMachine.transition(existing.state, event, {
    now: state.clock.now(),
    expiresAt: existing.expiresAt,
  });
  const updated = freezeLiquidityReservation({ ...existing, state: record.to });
  state.reservations.replace(updated);
  return updated;
}

/** One expected liquidity flow (inflow or outflow) at an asset. */
export interface ExpectedFlow {
  readonly assetId: LiquidityAssetId;
  readonly direction: 'INFLOW' | 'OUTFLOW';
  readonly amount: Money;
  readonly expectedAt: TimestampMs;
  /** 'CERTAIN' flows (e.g. confirmed inbound settlement) vs forecasts. */
  readonly certainty: 'CERTAIN' | 'FORECAST';
}

/** A projected liquidity shortfall at one asset. */
export interface LiquidityGap {
  readonly assetId: LiquidityAssetId;
  readonly currency: CurrencyCode;
  /** Positive shortfall (magnitude of the deepest projected deficit). */
  readonly shortfall: Money;
  /** When the deepest deficit occurs. */
  readonly atTime: TimestampMs;
}

/** The deterministic liquidity forecast over a horizon. */
export interface LiquidityForecast {
  readonly asOf: TimestampMs;
  readonly horizon: TimestampMs;
  readonly expectedInflows: readonly ExpectedFlow[];
  readonly expectedOutflows: readonly ExpectedFlow[];
  readonly gaps: readonly LiquidityGap[];
}

/**
 * Deterministically forecast liquidity per asset up to `horizon`.
 *
 * For every asset with an observed position, the flows with
 * `expectedAt <= horizon` are applied in a deterministic order —
 * `(expectedAt, direction: INFLOW before OUTFLOW, amount ascending, assetId,
 * certainty)` — to a running balance seeded from the observed position.
 * The deepest deficit (most negative running balance) is reported as a
 * `LiquidityGap`; assets never going negative have no gap. Assets are
 * reported in lexicographic assetId order. The clock stamps `asOf` only; it
 * never influences the projection itself.
 */
export function forecastLiquidity(
  positions: readonly LiquidityPosition[],
  flows: readonly ExpectedFlow[],
  clock: ProtocolClock,
  horizon: TimestampMs,
): LiquidityForecast {
  if (!Array.isArray(positions)) {
    throw new ValidationError('positions must be an array of LiquidityPosition');
  }
  if (!Array.isArray(flows)) {
    throw new ValidationError('flows must be an array of ExpectedFlow');
  }
  if (typeof horizon !== 'bigint') {
    throw new ValidationError('horizon must be a bigint TimestampMs');
  }
  const balances = new Map<LiquidityAssetId, { currency: CurrencyCode; balance: bigint }>();
  for (const position of positions) {
    if (position === null || typeof position !== 'object') {
      throw new ValidationError('each position must be a LiquidityPosition');
    }
    if (balances.has(position.assetId)) {
      throw new ValidationError('duplicate liquidity position for one asset', {
        assetId: position.assetId,
      });
    }
    if (typeof position.balance.value !== 'bigint') {
      throw new ValidationError('position.balance.value must be a bigint (INV-F01)', {
        assetId: position.assetId,
      });
    }
    balances.set(position.assetId, {
      currency: position.balance.currency,
      balance: position.balance.value,
    });
  }

  const inflows: ExpectedFlow[] = [];
  const outflows: ExpectedFlow[] = [];
  for (const flow of flows) {
    if (flow === null || typeof flow !== 'object') {
      throw new ValidationError('each flow must be an ExpectedFlow');
    }
    if (typeof flow.assetId !== 'string' || flow.assetId.length === 0) {
      throw new ValidationError('flow.assetId must be a non-empty string');
    }
    if (flow.direction !== 'INFLOW' && flow.direction !== 'OUTFLOW') {
      throw new ValidationError('flow.direction must be INFLOW or OUTFLOW');
    }
    if (flow.certainty !== 'CERTAIN' && flow.certainty !== 'FORECAST') {
      throw new ValidationError('flow.certainty must be CERTAIN or FORECAST');
    }
    if (flow.amount === null || typeof flow.amount !== 'object') {
      throw new ValidationError('flow.amount must be a Money object');
    }
    if (typeof flow.amount.value !== 'bigint') {
      throw new ValidationError('flow.amount.value must be a bigint (INV-F01)');
    }
    if (flow.amount.value <= 0n) {
      throw new ValidationError('flow amounts must be positive', {
        assetId: flow.assetId,
      });
    }
    if (typeof flow.expectedAt !== 'bigint') {
      throw new ValidationError('flow.expectedAt must be a bigint TimestampMs');
    }
    if (flow.expectedAt > horizon) continue;
    (flow.direction === 'INFLOW' ? inflows : outflows).push(flow);
  }

  const relevant = [...inflows, ...outflows];
  const byAssetFlows = new Map<LiquidityAssetId, ExpectedFlow[]>();
  for (const flow of relevant) {
    const bucket = byAssetFlows.get(flow.assetId);
    if (bucket === undefined) {
      byAssetFlows.set(flow.assetId, [flow]);
    } else {
      bucket.push(flow);
    }
  }

  const gaps: LiquidityGap[] = [];
  for (const assetId of [...new Set([...balances.keys(), ...byAssetFlows.keys()])].sort()) {
    const assetFlows = byAssetFlows.get(assetId) ?? [];
    const entry = balances.get(assetId);
    const currency = entry?.currency ?? assetFlows[0]?.amount.currency;
    if (currency === undefined) continue;
    let running = entry?.balance ?? 0n;
    let minBalance = running;
    let minAt = clock.now();
    // Deterministic ordering: expectedAt, INFLOW before OUTFLOW, amount
    // ascending, certainty lexicographic.
    const ordered = [...assetFlows].sort((a, b) => {
      if (a.expectedAt !== b.expectedAt) return a.expectedAt < b.expectedAt ? -1 : 1;
      if (a.direction !== b.direction) return a.direction === 'INFLOW' ? -1 : 1;
      if (a.amount.value !== b.amount.value) return a.amount.value < b.amount.value ? -1 : 1;
      if (a.certainty !== b.certainty) return a.certainty < b.certainty ? -1 : 1;
      return 0;
    });
    for (const flow of ordered) {
      if (flow.amount.currency !== currency) {
        throw new ValidationError('forecast flows mix currencies on one asset', {
          assetId,
          expected: currency,
          found: flow.amount.currency,
        });
      }
      running += flow.direction === 'INFLOW' ? flow.amount.value : -flow.amount.value;
      if (running < minBalance) {
        minBalance = running;
        minAt = flow.expectedAt;
      }
    }
    if (minBalance < 0n) {
      gaps.push(
        Object.freeze({
          assetId,
          currency,
          shortfall: fromMinorUnits(currency, -minBalance),
          atTime: minAt,
        }),
      );
    }
  }

  return Object.freeze({
    asOf: clock.now(),
    horizon,
    expectedInflows: Object.freeze(inflows),
    expectedOutflows: Object.freeze(outflows),
    gaps: Object.freeze(gaps),
  });
}
