/**
 * @payswap/protocol — durable outbox and event publication (W1-002).
 *
 * INV-O02: a committed financial mutation can never silently lose its
 * outbox event — `enqueue(events, tx)` joins the caller's transaction by
 * contract, and the in-memory reference implementation enqueues
 * atomically (all-or-nothing) with idempotent re-enqueue by event id.
 *
 * INV-O01: async publication is retry-safe — `drain` marks a record
 * PUBLISHED only AFTER the publisher resolves successfully, so a crash
 * between publish and mark leaves the record PENDING and it is re-published
 * on the next drain (at-least-once; publishers MUST be idempotent).
 * Re-draining never re-publishes PUBLISHED records and never duplicates a
 * record for the same event id.
 *
 * Failure semantics (INV-X01/X02/X03): when a publisher throws
 * `ExternalAmbiguityError` the publication outcome is UNKNOWN. `drain`
 * FAILS STOP: it throws, leaves the record PENDING with its attempt count
 * untouched, schedules no blind retry and never coerces the record to
 * FAILED. Reconciliation is required before any further drain.
 *
 * Determinism: backoff is a pure function of the attempt count and options,
 * anchored to the injected `ProtocolClock` reading captured once at the
 * start of the drain — no timers are ever scheduled, no ambient time is read.
 */

import { ExternalAmbiguityError, PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';
import type { ProtocolClock, TimestampMs } from './clock.js';
import { asEventId, type EventId } from './identifiers.js';
import type { DomainEventEnvelope } from './envelope.js';

/** Publication status of one outbox record. */
export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

/**
 * Opaque handle to the caller's transaction. Contract: an implementation
 * MUST insert the outbox rows inside the SAME transaction that commits the
 * journal mutation (INV-O02). The in-memory reference ignores it — memory
 * commits synchronously with the enqueue call by construction.
 */
export interface OutboxTransactionHandle {
  readonly kind: 'OUTBOX_TRANSACTION';
}

/** One durable outbox record with its dispatch state. */
export interface OutboxRecord {
  readonly eventId: EventId;
  /** The enveloped event to publish (never mutated; dispatch is read-only). */
  readonly event: DomainEventEnvelope<unknown>;
  readonly status: OutboxStatus;
  /** Publication attempts performed so far (successful attempt included). */
  readonly attempts: number;
  /** Earliest injected-clock reading at which the next attempt is eligible. */
  readonly nextAttemptAt?: TimestampMs;
}

/**
 * Transport-side publisher contract. `publish` MUST be idempotent
 * (at-least-once delivery). It resolves ONLY on definitive success and
 * throws `ExternalAmbiguityError` when the outcome is UNKNOWN.
 */
export interface OutboxPublisher {
  publish(event: DomainEventEnvelope<unknown>): Promise<void>;
}

/**
 * The durable outbox contract. `enqueue` is the write side (INV-O02);
 * `markPublished` / `scheduleRetry` / `markFailed` are dispatcher
 * transitions legal only from PENDING (`markPublished` is idempotent).
 */
export interface Outbox {
  /**
   * Atomically enqueue events; MUST join the caller's transaction when one
   * is provided. Re-enqueueing the identical event is an idempotent no-op
   * (INV-O01); the same event id with different content is a conflict.
   */
  enqueue(events: readonly DomainEventEnvelope<unknown>[], tx?: OutboxTransactionHandle): void;
  /** All records in enqueue order — frozen copies. */
  readonly records: readonly OutboxRecord[];
  get(eventId: EventId): OutboxRecord | undefined;
  /** Mark definitively published (attempts +1; idempotent when already PUBLISHED). */
  markPublished(eventId: EventId): void;
  /** Record one failed attempt and schedule the next eligible time (PENDING only). */
  scheduleRetry(eventId: EventId, nextAttemptAt: TimestampMs): void;
  /** Record the final failed attempt — status FAILED, record retained (PENDING only). */
  markFailed(eventId: EventId): void;
}

/** Same event id re-enqueued with different content. */
export class OutboxEventConflictError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'OUTBOX_EVENT_CONFLICT', category: 'CONFLICT', message, details });
  }
}

/** A dispatcher transition was applied to a record in an impossible state. */
export class OutboxStateError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'OUTBOX_STATE_CONFLICT', category: 'CONFLICT', message, details });
  }
}

/** Default publication attempts before a record is parked as FAILED. */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;

/** Default exponential backoff base (milliseconds). */
export const DEFAULT_OUTBOX_BACKOFF_BASE_MS: TimestampMs = 1000n;

/** Backoff ceiling (milliseconds) — bounded so bigint shifts stay sane. */
export const MAX_OUTBOX_BACKOFF_MS: TimestampMs = 60_000n;

const MAX_EXPONENT = 16;

/**
 * Deterministic exponential backoff for the Nth failed attempt:
 * `baseMs * 2^(attempts-1)` capped at `MAX_OUTBOX_BACKOFF_MS`.
 * Pure — a function of its arguments only.
 */
export function computeBackoffMs(attempts: number, baseMs: bigint): bigint {
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1) {
    throw new ValidationError('attempts must be a positive integer', { attempts });
  }
  if (typeof baseMs !== 'bigint' || baseMs <= 0n) {
    throw new ValidationError('baseMs must be a positive bigint', { baseMs: baseMs.toString() });
  }
  const shift = BigInt(Math.min(attempts - 1, MAX_EXPONENT));
  const delay = baseMs * 2n ** shift;
  return delay > MAX_OUTBOX_BACKOFF_MS ? MAX_OUTBOX_BACKOFF_MS : delay;
}

/** Options for one drain pass. */
export interface DrainOptions {
  /** Injected clock — the single time authority for eligibility and backoff. */
  readonly clock: ProtocolClock;
  /** Max publication attempts before the record is parked as FAILED. */
  readonly maxAttempts?: number;
  /** Exponential backoff base in milliseconds. */
  readonly backoffBaseMs?: bigint;
}

/** Per-drain dispatch outcome. */
export interface DrainReport {
  /** Events definitively published during this pass. */
  readonly published: readonly EventId[];
  /** Events parked as FAILED (attempts exhausted; record retained — never lost). */
  readonly failed: readonly EventId[];
  /** Events that failed this pass and are scheduled for a backed-off retry. */
  readonly deferred: readonly EventId[];
}

function assertEventEnvelope(event: DomainEventEnvelope<unknown>, label: string): void {
  if (event === null || typeof event !== 'object') {
    throw new ValidationError(`${label} must be a DomainEventEnvelope`, { label });
  }
  if (typeof event.id !== 'string' || event.id.length === 0) {
    throw new ValidationError(`${label}.id must be a non-empty EventId`, { label });
  }
  if (typeof event.eventType !== 'string' || event.eventType.length === 0) {
    throw new ValidationError(`${label}.eventType must be a non-empty string`, { label });
  }
  if (event.aggregate === null || typeof event.aggregate !== 'object') {
    throw new ValidationError(`${label}.aggregate must be a VersionedRef`, { label });
  }
  if (typeof event.aggregate.id !== 'string' || event.aggregate.id.length === 0) {
    throw new ValidationError(`${label}.aggregate.id must be a non-empty string`, { label });
  }
  if (typeof event.aggregate.version !== 'bigint' || event.aggregate.version < 1n) {
    throw new ValidationError(`${label}.aggregate.version must be a bigint >= 1`, { label });
  }
  if (typeof event.occurredAt !== 'bigint') {
    throw new ValidationError(`${label}.occurredAt must be a bigint TimestampMs`, { label });
  }
  if (typeof event.schemaVersion !== 'number' || !Number.isInteger(event.schemaVersion) || event.schemaVersion < 1) {
    throw new ValidationError(`${label}.schemaVersion must be a positive integer`, { label });
  }
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return typeof a === 'bigint' && typeof b === 'bigint' && a === b;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (const [index, element] of a.entries()) {
      const other = b[index];
      if (other === undefined || !structurallyEqual(element, other)) return false;
    }
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!(key in right) || !structurallyEqual(left[key], right[key])) return false;
  }
  return true;
}

function freezeRecord(record: {
  eventId: EventId;
  event: DomainEventEnvelope<unknown>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt?: TimestampMs;
}): OutboxRecord {
  const frozen: {
    -readonly [K in keyof OutboxRecord]: OutboxRecord[K];
  } = {
    eventId: record.eventId,
    event: record.event,
    status: record.status,
    attempts: record.attempts,
  };
  if (record.nextAttemptAt !== undefined) frozen.nextAttemptAt = record.nextAttemptAt;
  return Object.freeze(frozen);
}

/**
 * Deterministic in-memory reference outbox. Enqueue is atomic
 * (all-or-nothing) and idempotent per event id; dispatcher transitions
 * enforce legal state; records are frozen copies on every read.
 */
export class InMemoryOutbox implements Outbox {
  private readonly _byId = new Map<EventId, OutboxRecord>();
  private readonly _order: OutboxRecord[] = [];

  get records(): readonly OutboxRecord[] {
    return Object.freeze([...this._order]);
  }

  get(eventId: EventId): OutboxRecord | undefined {
    const stored = this._byId.get(eventId);
    return stored === undefined ? undefined : stored;
  }

  enqueue(
    events: readonly DomainEventEnvelope<unknown>[],
    _tx?: OutboxTransactionHandle,
  ): void {
    if (!Array.isArray(events)) {
      throw new ValidationError('events must be an array of DomainEventEnvelopes');
    }
    // Validate the ENTIRE batch before inserting anything (atomic enqueue).
    const seen = new Map<EventId, DomainEventEnvelope<unknown>>();
    for (const [index, event] of events.entries()) {
      assertEventEnvelope(event, `events[${index}]`);
      const eventId = asEventId(event.id);
      const prior = this._byId.get(eventId);
      if (prior !== undefined && !structurallyEqual(prior.event, event)) {
        throw new OutboxEventConflictError(
          'event id already enqueued with different content',
          { eventId },
        );
      }
      seen.set(eventId, event);
    }
    for (const [eventId, event] of seen) {
      if (this._byId.has(eventId)) continue; // idempotent re-enqueue (INV-O01)
      const record = freezeRecord({
        eventId,
        event,
        status: 'PENDING',
        attempts: 0,
      });
      this._byId.set(record.eventId, record);
      this._order.push(record);
    }
  }

  markPublished(eventId: EventId): void {
    const record = this._byId.get(eventId);
    if (record === undefined) {
      throw new OutboxStateError('no outbox record for event id', { eventId });
    }
    if (record.status === 'PUBLISHED') {
      return; // idempotent re-mark after a successful retry (INV-O01)
    }
    if (record.status === 'FAILED') {
      throw new OutboxStateError('cannot publish a FAILED record without recovery', { eventId });
    }
    this.store(freezeRecord({
      eventId: record.eventId,
      event: record.event,
      status: 'PUBLISHED',
      attempts: record.attempts + 1,
    }));
  }

  scheduleRetry(eventId: EventId, nextAttemptAt: TimestampMs): void {
    const record = this._byId.get(eventId);
    if (record === undefined) {
      throw new OutboxStateError('no outbox record for event id', { eventId });
    }
    if (record.status !== 'PENDING') {
      throw new OutboxStateError('scheduleRetry is only legal from PENDING', {
        eventId,
        status: record.status,
      });
    }
    if (typeof nextAttemptAt !== 'bigint') {
      throw new ValidationError('nextAttemptAt must be a bigint TimestampMs');
    }
    this.store(freezeRecord({
      eventId: record.eventId,
      event: record.event,
      status: 'PENDING',
      attempts: record.attempts + 1,
      nextAttemptAt,
    }));
  }

  markFailed(eventId: EventId): void {
    const record = this._byId.get(eventId);
    if (record === undefined) {
      throw new OutboxStateError('no outbox record for event id', { eventId });
    }
    if (record.status !== 'PENDING') {
      throw new OutboxStateError('markFailed is only legal from PENDING', {
        eventId,
        status: record.status,
      });
    }
    this.store(freezeRecord({
      eventId: record.eventId,
      event: record.event,
      status: 'FAILED',
      attempts: record.attempts + 1,
    }));
  }

  private store(record: OutboxRecord): void {
    this._byId.set(record.eventId, record);
    const index = this._order.findIndex((candidate) => candidate.eventId === record.eventId);
    if (index >= 0) {
      this._order[index] = record;
    }
  }
}

/**
 * Drain the outbox through a publisher, in enqueue order (deterministic).
 *
 * - eligible records: PENDING with `nextAttemptAt` absent or ≤ the injected
 *   clock reading captured ONCE at the start of this pass;
 * - a record is marked PUBLISHED only after the publisher resolves;
 * - a definitive failure increments the attempt count and either schedules a
 *   deterministic exponential backoff or parks the record as FAILED
 *   (retained, never silently dropped);
 * - an `ExternalAmbiguityError` from the publisher fails the whole drain
 *   (INV-X01/X02): the record stays PENDING, untouched, and reconciliation
 *   is required before any further attempt.
 */
export async function drain(
  outbox: Outbox,
  publisher: OutboxPublisher,
  options: DrainOptions,
): Promise<DrainReport> {
  if (outbox === null || typeof outbox !== 'object') {
    throw new ValidationError('outbox must implement the Outbox contract');
  }
  if (publisher === null || typeof publisher !== 'object' || typeof publisher.publish !== 'function') {
    throw new ValidationError('publisher must implement the OutboxPublisher contract');
  }
  if (options === null || typeof options !== 'object' || typeof options.clock?.now !== 'function') {
    throw new ValidationError('options.clock must be a ProtocolClock');
  }
  const maxAttempts =
    options.maxAttempts === undefined ? DEFAULT_OUTBOX_MAX_ATTEMPTS : options.maxAttempts;
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ValidationError('options.maxAttempts must be a positive integer', { maxAttempts });
  }
  const backoffBaseMs =
    options.backoffBaseMs === undefined ? DEFAULT_OUTBOX_BACKOFF_BASE_MS : options.backoffBaseMs;
  if (typeof backoffBaseMs !== 'bigint' || backoffBaseMs <= 0n) {
    throw new ValidationError('options.backoffBaseMs must be a positive bigint', {
      backoffBaseMs: backoffBaseMs.toString(),
    });
  }

  const now = options.clock.now();
  const published: EventId[] = [];
  const failed: EventId[] = [];
  const deferred: EventId[] = [];

  for (const record of outbox.records) {
    if (record.status !== 'PENDING') continue;
    if (record.nextAttemptAt !== undefined && record.nextAttemptAt > now) continue;
    try {
      await publisher.publish(record.event);
    } catch (error) {
      if (error instanceof ExternalAmbiguityError) {
        // INV-X01: UNKNOWN is not FAILED. INV-X02: never blindly retried.
        // Fail-stop: nothing further is dispatched until reconciliation.
        throw new ExternalAmbiguityError(
          'outbox publication outcome is UNKNOWN; the record stays PENDING and reconciliation is required before any retry (INV-X02/X03)',
          { eventId: record.eventId },
        );
      }
      const attemptsAfter = record.attempts + 1;
      if (attemptsAfter >= maxAttempts) {
        outbox.markFailed(record.eventId);
        failed.push(record.eventId);
      } else {
        outbox.scheduleRetry(record.eventId, now + computeBackoffMs(attemptsAfter, backoffBaseMs));
        deferred.push(record.eventId);
      }
      continue;
    }
    outbox.markPublished(record.eventId);
    published.push(record.eventId);
  }

  return Object.freeze({
    published: Object.freeze(published),
    failed: Object.freeze(failed),
    deferred: Object.freeze(deferred),
  });
}
