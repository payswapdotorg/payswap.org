import { describe, expect, it } from 'vitest';
import {
  canonicalScopeKey,
  IdempotencyStateError,
  idempotencyScopeId,
  InMemoryIdempotencyRegistrar,
  UnknownIdempotencyScopeError,
  ValidationError,
  type IdempotencyScope,
} from '../src/index.js';

const scope: IdempotencyScope = {
  commandType: 'payments.initiate',
  principal: { principalType: 'USER', principalId: 'user-7' },
  key: 'cart-42',
};

const otherPrincipalScope: IdempotencyScope = {
  commandType: 'payments.initiate',
  principal: { principalType: 'USER', principalId: 'user-8' },
  key: 'cart-42',
};

describe('idempotency: begin / replay / conflict (INV-F05)', () => {
  it('returns BEGIN for a fresh scope and creates an IN_FLIGHT record', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    expect(registrar.begin(scope, 'hash-1')).toEqual({ kind: 'BEGIN' });
  });

  it('returns CONFLICT when the same key carries a different command hash', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    registrar.begin(scope, 'hash-1');
    const outcome = registrar.begin(scope, 'hash-2');
    expect(outcome.kind).toBe('CONFLICT');
    if (outcome.kind === 'CONFLICT') {
      expect(outcome.record.commandHash).toBe('hash-1');
      expect(outcome.record.status).toBe('IN_FLIGHT');
    }
  });

  it('returns REPLAY for a duplicate while the command is IN_FLIGHT (no silent double execution)', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    registrar.begin(scope, 'hash-1');
    const outcome = registrar.begin(scope, 'hash-1');
    expect(outcome.kind).toBe('REPLAY');
    if (outcome.kind === 'REPLAY') {
      expect(outcome.record.status).toBe('IN_FLIGHT');
    }
  });

  it('returns the exact recorded REPLAY after completion (retry-safety, INV-O01)', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    registrar.begin(scope, 'hash-1');
    registrar.complete(scope, 'result-9');
    const outcome = registrar.begin(scope, 'hash-1');
    expect(outcome.kind).toBe('REPLAY');
    if (outcome.kind === 'REPLAY') {
      expect(outcome.record.status).toBe('COMPLETED');
      expect(outcome.record.resultHash).toBe('result-9');
      expect(outcome.record.commandHash).toBe('hash-1');
    }
  });

  it('still CONFLICTS after completion when the hash differs', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    registrar.begin(scope, 'hash-1');
    registrar.complete(scope, 'result-9');
    expect(registrar.begin(scope, 'hash-2').kind).toBe('CONFLICT');
  });
});

describe('idempotency: failure and retry', () => {
  it('fail() marks an IN_FLIGHT record FAILED', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    registrar.begin(scope, 'hash-1');
    registrar.fail(scope);
    const outcome = registrar.begin(scope, 'hash-1');
    // FAILED + same hash → retry re-arms
    expect(outcome.kind).toBe('BEGIN');
  });

  it('retry after failure re-arms and can complete with one authoritative result', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    registrar.begin(scope, 'hash-1');
    registrar.fail(scope);
    expect(registrar.begin(scope, 'hash-1')).toEqual({ kind: 'BEGIN' });
    registrar.complete(scope, 'result-final');
    const replay = registrar.begin(scope, 'hash-1');
    expect(replay.kind).toBe('REPLAY');
    if (replay.kind === 'REPLAY') {
      expect(replay.record.status).toBe('COMPLETED');
      expect(replay.record.resultHash).toBe('result-final');
    }
  });

  it('complete() is idempotent for an identical result hash and divergent hashes throw', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    registrar.begin(scope, 'hash-1');
    registrar.complete(scope, 'result-9');
    expect(() => registrar.complete(scope, 'result-9')).not.toThrow();
    expect(() => registrar.complete(scope, 'result-different')).toThrow(IdempotencyStateError);
  });

  it('fail()/complete() guard impossible state transitions', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    registrar.begin(scope, 'hash-1');
    registrar.complete(scope, 'result-9');
    expect(() => registrar.fail(scope)).toThrow(IdempotencyStateError);
    // completed with result-9; completing with a different result must throw
    expect(() => registrar.complete(scope, 'result-different')).toThrow(IdempotencyStateError);
  });

  it('unknown scopes throw UnknownIdempotencyScopeError', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    expect(() => registrar.complete(scope, 'r')).toThrow(UnknownIdempotencyScopeError);
    expect(() => registrar.fail(scope)).toThrow(UnknownIdempotencyScopeError);
  });
});

describe('idempotency: scoping', () => {
  it('different principals are independent scopes', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    registrar.begin(scope, 'hash-1');
    expect(registrar.begin(otherPrincipalScope, 'hash-1')).toEqual({ kind: 'BEGIN' });
    registrar.complete(otherPrincipalScope, 'result-other');
    expect(registrar.begin(scope, 'hash-1').kind).toBe('REPLAY');
  });

  it('canonical keys are deterministic and unambiguous', () => {
    expect(canonicalScopeKey(scope)).toBe(canonicalScopeKey({ ...scope }));
    expect(canonicalScopeKey(scope)).not.toBe(canonicalScopeKey(otherPrincipalScope));
    expect(idempotencyScopeId(scope)).toBe(idempotencyScopeId({ ...scope }));
    expect(idempotencyScopeId(scope)).toMatch(/^\["payments\.initiate"/);
  });

  it('rejects malformed scopes and hashes', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    expect(() => registrar.begin({ ...scope, key: '' }, 'h')).toThrow(ValidationError);
    expect(() => registrar.begin(scope, '')).toThrow(ValidationError);
    expect(
      () => registrar.begin({ ...scope, principal: { principalType: '', principalId: 'x' } }, 'h'),
    ).toThrow(ValidationError);
  });
});

describe('idempotency: record integrity', () => {
  it('returned records are frozen snapshots that cannot corrupt registrar state', () => {
    const registrar = new InMemoryIdempotencyRegistrar();
    registrar.begin(scope, 'hash-1');
    registrar.complete(scope, 'result-9');
    const replay = registrar.begin(scope, 'hash-1');
    if (replay.kind !== 'REPLAY') {
      throw new Error('expected REPLAY');
    }
    expect(Object.isFrozen(replay.record)).toBe(true);
    expect(Object.isFrozen(replay.record.scope)).toBe(true);
    expect(Object.isFrozen(replay.record.scope.principal)).toBe(true);
    expect(() => {
      (replay.record as { status: string }).status = 'FAILED';
    }).toThrow();

    const after = registrar.begin(scope, 'hash-1');
    if (after.kind !== 'REPLAY') {
      throw new Error('expected REPLAY');
    }
    expect(after.record.status).toBe('COMPLETED');
  });
});
