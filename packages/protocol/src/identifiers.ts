/**
 * @payswap/protocol — branded identifiers and deterministic id factory (W1-001).
 *
 * Identifiers are branded strings: structurally strings at runtime, distinct
 * at the type level so a `CommandId` can never be passed where an `EventId`
 * or `AggregateId` is expected. Ids are minted exclusively through an
 * injected `IdFactory` (prefix + injected clock + monotonic sequence);
 * domain logic never invents identifiers from entropy or the host clock.
 */

import { ValidationError } from './errors.js';
import type { ProtocolClock } from './clock.js';

declare const CommandIdBrand: unique symbol;
declare const EventIdBrand: unique symbol;
declare const AggregateIdBrand: unique symbol;
declare const IntentIdBrand: unique symbol;
declare const IdempotencyScopeIdBrand: unique symbol;

/** Branded id of a command envelope. */
export type CommandId = string & { readonly [CommandIdBrand]: 'CommandId' };
/** Branded id of a domain event envelope. */
export type EventId = string & { readonly [EventIdBrand]: 'EventId' };
/** Branded id of an aggregate stream. */
export type AggregateId = string & { readonly [AggregateIdBrand]: 'AggregateId' };
/** Branded id of a payment/economic intent. */
export type IntentId = string & { readonly [IntentIdBrand]: 'IntentId' };
/** Branded canonical key of an idempotency scope. */
export type IdempotencyScopeId = string & { readonly [IdempotencyScopeIdBrand]: 'IdempotencyScopeId' };

/** Reference to an authoritative object at a specific committed version. */
export interface VersionedRef<TId extends string = string> {
  readonly id: TId;
  readonly version: bigint;
}

/** Who issued a command: a user, service or system principal. */
export interface PrincipalRef {
  readonly principalType: string;
  readonly principalId: string;
}

const MAX_ID_LENGTH = 256;

/** Raised when a value cannot be branded as the requested identifier kind. */
export class InvalidIdentifierError extends ValidationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.name = 'InvalidIdentifierError';
  }
}

function brandId<TBranded extends string>(value: string, kind: string): TBranded {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError(`${kind} must be a non-empty string`, { kind, value });
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new InvalidIdentifierError(`${kind} exceeds ${MAX_ID_LENGTH} characters`, {
      kind,
      length: value.length,
    });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError(`${kind} must not carry surrounding whitespace`, { kind, value });
  }
  return value as TBranded;
}

/** Brand a validated string as a `CommandId`. */
export function asCommandId(value: string): CommandId {
  return brandId(value, 'CommandId');
}

/** Brand a validated string as an `EventId`. */
export function asEventId(value: string): EventId {
  return brandId(value, 'EventId');
}

/** Brand a validated string as an `AggregateId`. */
export function asAggregateId(value: string): AggregateId {
  return brandId(value, 'AggregateId');
}

/** Brand a validated string as an `IntentId`. */
export function asIntentId(value: string): IntentId {
  return brandId(value, 'IntentId');
}

/** Brand a validated string as an `IdempotencyScopeId`. */
export function asIdempotencyScopeId(value: string): IdempotencyScopeId {
  return brandId(value, 'IdempotencyScopeId');
}

/**
 * Deterministic identifier factory: `${prefix}${separator}${now}${separator}${monotonic}`.
 *
 * Uniqueness comes from the injected clock's monotonic sequence — never from
 * entropy — so given the same clock and the same call order, the same ids are
 * produced (deterministic replay / contract freezing). Two factories sharing
 * one clock still mint distinct ids because the monotonic sequence advances
 * on every mint.
 */
export interface IdFactory {
  mintId(prefix: string): string;
}

const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export interface IdFactoryOptions {
  readonly separator?: string;
}

export function createIdFactory(clock: ProtocolClock, options?: IdFactoryOptions): IdFactory {
  const separator = options?.separator ?? '_';
  if (separator.length === 0 || separator.length > 8) {
    throw new ValidationError('separator must be between 1 and 8 characters', { separator });
  }
  return {
    mintId(prefix: string): string {
      if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) {
        throw new InvalidIdentifierError(
          'id prefix must match [A-Za-z0-9][A-Za-z0-9._-]{0,31}',
          { prefix },
        );
      }
      return `${prefix}${separator}${clock.now()}${separator}${clock.monotonic()}`;
    },
  };
}
