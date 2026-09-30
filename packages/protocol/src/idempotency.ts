/**
 * @payswap/protocol — idempotency contracts (W1-001).
 *
 * INV-F05: one idempotency key maps to one authoritative command result.
 * INV-O01: async commands are retry-safe.
 *
 * A scope is (commandType, principal, key): the same logical command issued
 * twice by the same principal must produce exactly one authoritative result.
 * `begin` is the single decision point:
 *
 * | existing record          | same commandHash            | different commandHash |
 * |--------------------------|-----------------------------|-----------------------|
 * | none                     | BEGIN                       | BEGIN                 |
 * | IN_FLIGHT                | REPLAY (record, in flight)  | CONFLICT               |
 * | COMPLETED                | REPLAY (record, with result)| CONFLICT               |
 * | FAILED                   | BEGIN (retry re-arms)       | CONFLICT               |
 *
 * - same key + different command hash → CONFLICT (INV-F05 violation attempt);
 * - retry after completion → exact REPLAY of the recorded result hash;
 * - retry after failure → BEGIN again (transient failures are retryable);
 * - duplicate while in flight → REPLAY so the caller waits instead of
 *   double-executing (never a silent second execution).
 */

import { PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';
import {
  asIdempotencyScopeId,
  type IdempotencyScopeId,
  type PrincipalRef,
} from './identifiers.js';

export type IdempotencyStatus = 'IN_FLIGHT' | 'COMPLETED' | 'FAILED';

/** The idempotency scope of a command: what command, issued by whom, under which key. */
export interface IdempotencyScope {
  readonly commandType: string;
  readonly principal: PrincipalRef;
  readonly key: string;
}

/** Durable record of the idempotency decision for one scope. */
export interface IdempotencyRecord {
  readonly scope: IdempotencyScope;
  readonly commandHash: string;
  readonly status: IdempotencyStatus;
  readonly resultHash?: string;
}

export type BeginOutcome =
  | { readonly kind: 'BEGIN' }
  | { readonly kind: 'REPLAY'; readonly record: IdempotencyRecord }
  | { readonly kind: 'CONFLICT'; readonly record: IdempotencyRecord };

/** Raised when complete/fail is called against an impossible record state. */
export class IdempotencyStateError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'IDEMPOTENCY_STATE_CONFLICT', category: 'CONFLICT', message, details });
  }
}

/** Raised when a scope has no record at all. */
export class UnknownIdempotencyScopeError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'UNKNOWN_IDEMPOTENCY_SCOPE', category: 'NOT_FOUND', message, details });
  }
}

/**
 * Storage-agnostic registrar contract. PostgreSQL-backed implementations
 * (later Work Orders) MUST decide `begin` atomically under the same
 * transaction that executes the command.
 */
export interface IdempotencyRegistrar {
  begin(scope: IdempotencyScope, commandHash: string): BeginOutcome;
  complete(scope: IdempotencyScope, resultHash: string): void;
  fail(scope: IdempotencyScope): void;
}

/** Deterministic canonical key for a scope (JSON array form is unambiguous). */
export function canonicalScopeKey(scope: IdempotencyScope): string {
  return JSON.stringify([
    scope.commandType,
    scope.principal.principalType,
    scope.principal.principalId,
    scope.key,
  ]);
}

/** Branded canonical scope id, usable as a primary key. */
export function idempotencyScopeId(scope: IdempotencyScope): IdempotencyScopeId {
  return asIdempotencyScopeId(canonicalScopeKey(scope));
}

function validateScope(scope: IdempotencyScope): void {
  if (scope === null || typeof scope !== 'object') {
    throw new ValidationError('scope must be an IdempotencyScope object', { scope });
  }
  if (typeof scope.commandType !== 'string' || scope.commandType.length === 0) {
    throw new ValidationError('scope.commandType must be a non-empty string');
  }
  if (typeof scope.key !== 'string' || scope.key.length === 0) {
    throw new ValidationError('scope.key must be a non-empty string');
  }
  if (
    scope.principal === null ||
    typeof scope.principal !== 'object' ||
    typeof scope.principal.principalType !== 'string' ||
    scope.principal.principalType.length === 0 ||
    typeof scope.principal.principalId !== 'string' ||
    scope.principal.principalId.length === 0
  ) {
    throw new ValidationError('scope.principal must be a valid PrincipalRef');
  }
}

function copyScope(scope: IdempotencyScope): IdempotencyScope {
  return Object.freeze({
    commandType: scope.commandType,
    principal: Object.freeze({ ...scope.principal }),
    key: scope.key,
  });
}

function freezeRecord(record: {
  scope: IdempotencyScope;
  commandHash: string;
  status: IdempotencyStatus;
  resultHash?: string;
}): IdempotencyRecord {
  const frozen: {
    -readonly [K in keyof IdempotencyRecord]: IdempotencyRecord[K];
  } = {
    scope: copyScope(record.scope),
    commandHash: record.commandHash,
    status: record.status,
  };
  if (record.resultHash !== undefined) {
    frozen.resultHash = record.resultHash;
  }
  return Object.freeze(frozen);
}

/**
 * Deterministic in-memory reference registrar (Stage 0). Production uses a
 * PostgreSQL-backed registrar under the same interface; this implementation
 * exists so the contract semantics are executable and testable without a
 * database. Records are stored as frozen deep copies — callers cannot mutate
 * registrar state through returned records.
 */
export class InMemoryIdempotencyRegistrar implements IdempotencyRegistrar {
  private readonly records = new Map<string, IdempotencyRecord>();

  begin(scope: IdempotencyScope, commandHash: string): BeginOutcome {
    validateScope(scope);
    if (typeof commandHash !== 'string' || commandHash.length === 0) {
      throw new ValidationError('commandHash must be a non-empty string', { commandHash });
    }
    const key = canonicalScopeKey(scope);
    const existing = this.records.get(key);
    if (existing === undefined) {
      this.records.set(key, freezeRecord({ scope, commandHash, status: 'IN_FLIGHT' }));
      return { kind: 'BEGIN' };
    }
    if (existing.commandHash !== commandHash) {
      // INV-F05: same key, different command — a conflict, never a re-execution.
      return { kind: 'CONFLICT', record: existing };
    }
    if (existing.status === 'FAILED') {
      // Retry-safety: a transient failure may be retried under the same hash.
      this.records.set(key, freezeRecord({ scope, commandHash, status: 'IN_FLIGHT' }));
      return { kind: 'BEGIN' };
    }
    // IN_FLIGHT duplicate (caller must wait) or COMPLETED (exact replay).
    return { kind: 'REPLAY', record: existing };
  }

  complete(scope: IdempotencyScope, resultHash: string): void {
    validateScope(scope);
    if (typeof resultHash !== 'string' || resultHash.length === 0) {
      throw new ValidationError('resultHash must be a non-empty string', { resultHash });
    }
    const key = canonicalScopeKey(scope);
    const existing = this.records.get(key);
    if (existing === undefined) {
      throw new UnknownIdempotencyScopeError('no idempotency record for scope', { scope: key });
    }
    if (existing.status === 'COMPLETED') {
      if (existing.resultHash === resultHash) {
        return; // idempotent double-complete with the identical result
      }
      throw new IdempotencyStateError(
        'scope already completed with a different result hash — results must be deterministic',
        { scope: key, recorded: existing.resultHash, attempted: resultHash },
      );
    }
    if (existing.status === 'FAILED') {
      throw new IdempotencyStateError('cannot complete a failed idempotency record', {
        scope: key,
      });
    }
    this.records.set(
      key,
      freezeRecord({ scope, commandHash: existing.commandHash, status: 'COMPLETED', resultHash }),
    );
  }

  fail(scope: IdempotencyScope): void {
    validateScope(scope);
    const key = canonicalScopeKey(scope);
    const existing = this.records.get(key);
    if (existing === undefined) {
      throw new UnknownIdempotencyScopeError('no idempotency record for scope', { scope: key });
    }
    if (existing.status !== 'IN_FLIGHT') {
      throw new IdempotencyStateError(
        `cannot fail a record that is already ${existing.status}`,
        { scope: key, status: existing.status },
      );
    }
    this.records.set(
      key,
      freezeRecord({ scope, commandHash: existing.commandHash, status: 'FAILED' }),
    );
  }
}
