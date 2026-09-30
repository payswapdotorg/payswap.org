/**
 * @payswap/protocol — command and event envelopes (W1-001).
 *
 * Every command entering the protocol and every event leaving it travels in
 * a frozen envelope with full lineage: `causationId` (what caused this) and
 * `correlationId` (the conversation it belongs to) survive end-to-end, so
 * authorization lineage and evidence lineage can always be reconstructed
 * (AGENTS.md rule 2).
 *
 * Envelopes are created exclusively through the pure factories below, which
 * take an injected `IdFactory` and `ProtocolClock` — never ambient entropy
 * or ambient time.
 */

import {
  ValidationError,
} from './errors.js';
import type { TimestampMs, ProtocolClock } from './clock.js';
import {
  asCommandId,
  asEventId,
  type AggregateId,
  type CommandId,
  type EventId,
  type IdFactory,
  type PrincipalRef,
  type VersionedRef,
} from './identifiers.js';

/** Current schema version of the protocol envelope contracts. */
export const PROTOCOL_SCHEMA_VERSION = 1;

/** Causation/correlation lineage optionally attached to a new envelope. */
export interface EventLineage {
  readonly causationId?: CommandId | EventId;
  readonly correlationId?: string;
}

export interface CommandEnvelope<TPayload> {
  readonly id: CommandId;
  readonly commandType: string;
  readonly payload: TPayload;
  readonly principalRef: PrincipalRef;
  readonly idempotencyKey: string;
  readonly causationId?: CommandId | EventId;
  readonly correlationId?: string;
  readonly issuedAt: TimestampMs;
  readonly schemaVersion: number;
}

export interface DomainEventEnvelope<TPayload> {
  readonly id: EventId;
  readonly eventType: string;
  readonly payload: TPayload;
  readonly aggregate: VersionedRef<AggregateId>;
  readonly causationId?: CommandId | EventId;
  readonly correlationId?: string;
  readonly occurredAt: TimestampMs;
  readonly schemaVersion: number;
}

export interface EnvelopeDependencies {
  readonly ids: IdFactory;
  readonly clock: ProtocolClock;
}

export interface CreateCommandEnvelopeOptions<TPayload> {
  readonly commandType: string;
  readonly payload: TPayload;
  readonly principalRef: PrincipalRef;
  readonly idempotencyKey: string;
  readonly causationId?: CommandId | EventId;
  readonly correlationId?: string;
  readonly schemaVersion: number;
}

export interface CreateEventEnvelopeOptions<TPayload> {
  readonly eventType: string;
  readonly payload: TPayload;
  readonly aggregate: VersionedRef<AggregateId>;
  readonly causationId?: CommandId | EventId;
  readonly correlationId?: string;
  readonly schemaVersion: number;
}

const MAX_TYPE_LENGTH = 128;
const MAX_KEY_LENGTH = 256;

function requireTypeName(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TYPE_LENGTH) {
    throw new ValidationError(`${label} must be a non-empty string of at most ${MAX_TYPE_LENGTH} characters`, {
      [label]: value,
    });
  }
  if (value.trim() !== value) {
    throw new ValidationError(`${label} must not carry surrounding whitespace`, { [label]: value });
  }
}

function requireKey(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH) {
    throw new ValidationError(`${label} must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`, {
      [label]: value,
    });
  }
}

function requireSchemaVersion(value: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ValidationError('schemaVersion must be a positive integer', { schemaVersion: value });
  }
}

function requirePrincipalRef(principalRef: PrincipalRef): void {
  if (principalRef === null || typeof principalRef !== 'object') {
    throw new ValidationError('principalRef must be an object', { principalRef });
  }
  if (typeof principalRef.principalType !== 'string' || principalRef.principalType.length === 0) {
    throw new ValidationError('principalRef.principalType must be a non-empty string');
  }
  if (typeof principalRef.principalId !== 'string' || principalRef.principalId.length === 0) {
    throw new ValidationError('principalRef.principalId must be a non-empty string');
  }
}

/** Pure factory for command envelopes (injected ids + clock). */
export function createCommandEnvelope<TPayload>(
  options: CreateCommandEnvelopeOptions<TPayload>,
  deps: EnvelopeDependencies,
): CommandEnvelope<TPayload> {
  requireTypeName(options.commandType, 'commandType');
  requireKey(options.idempotencyKey, 'idempotencyKey');
  requirePrincipalRef(options.principalRef);
  requireSchemaVersion(options.schemaVersion);
  if (options.correlationId !== undefined) {
    requireKey(options.correlationId, 'correlationId');
  }

  const envelope: {
    -readonly [K in keyof CommandEnvelope<TPayload>]: CommandEnvelope<TPayload>[K];
  } = {
    id: asCommandId(deps.ids.mintId('cmd')),
    commandType: options.commandType,
    payload: options.payload,
    principalRef: Object.freeze({ ...options.principalRef }),
    idempotencyKey: options.idempotencyKey,
    issuedAt: deps.clock.now(),
    schemaVersion: options.schemaVersion,
  };
  if (options.causationId !== undefined) {
    envelope.causationId = options.causationId;
  }
  if (options.correlationId !== undefined) {
    envelope.correlationId = options.correlationId;
  }
  return Object.freeze(envelope);
}

/** Pure factory for event envelopes (injected ids + clock). */
export function createEventEnvelope<TPayload>(
  options: CreateEventEnvelopeOptions<TPayload>,
  deps: EnvelopeDependencies,
): DomainEventEnvelope<TPayload> {
  requireTypeName(options.eventType, 'eventType');
  requireSchemaVersion(options.schemaVersion);
  if (options.correlationId !== undefined) {
    requireKey(options.correlationId, 'correlationId');
  }
  if (options.aggregate === null || typeof options.aggregate !== 'object') {
    throw new ValidationError('aggregate must be a VersionedRef', { aggregate: options.aggregate });
  }
  if (typeof options.aggregate.id !== 'string' || options.aggregate.id.length === 0) {
    throw new ValidationError('aggregate.id must be a non-empty string');
  }
  if (typeof options.aggregate.version !== 'bigint' || options.aggregate.version < 1n) {
    throw new ValidationError('aggregate.version must be a bigint >= 1 (event versions are 1-based)', {
      version: options.aggregate.version,
    });
  }

  const envelope: {
    -readonly [K in keyof DomainEventEnvelope<TPayload>]: DomainEventEnvelope<TPayload>[K];
  } = {
    id: asEventId(deps.ids.mintId('evt')),
    eventType: options.eventType,
    payload: options.payload,
    aggregate: Object.freeze({ ...options.aggregate }),
    occurredAt: deps.clock.now(),
    schemaVersion: options.schemaVersion,
  };
  if (options.causationId !== undefined) {
    envelope.causationId = options.causationId;
  }
  if (options.correlationId !== undefined) {
    envelope.correlationId = options.correlationId;
  }
  return Object.freeze(envelope);
}
