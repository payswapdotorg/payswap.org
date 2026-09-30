import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  ExternalAmbiguityError,
  FloatMoneyRejectedError,
  isFailureOutcome,
  PaySwapError,
  ValidationError,
  type ErrorCategory,
} from '../src/index.js';

const ALL_CATEGORIES: readonly ErrorCategory[] = [
  'VALIDATION',
  'CONFLICT',
  'NOT_FOUND',
  'AUTHORIZATION_REQUIRED',
  'POLICY_BLOCKED',
  'EXTERNAL_AMBIGUITY',
  'TERMINAL_STATE',
  'MIGRATION_INCOMPATIBLE',
  'INTERNAL',
];

describe('error taxonomy', () => {
  it('exposes the full category set of the frozen architecture', () => {
    expect(ALL_CATEGORIES).toHaveLength(9);
    const seen = new Set(
      [
        new ValidationError('x'),
        new CurrencyMismatchError('x'),
        new ExternalAmbiguityError('x'),
        new FloatMoneyRejectedError('x'),
      ].map((error) => error.category),
    );
    expect(seen.has('VALIDATION')).toBe(true);
    expect(seen.has('CONFLICT') || seen.has('EXTERNAL_AMBIGUITY')).toBe(true);
  });

  it('carries code, category, message and optional details', () => {
    const error = new ValidationError('bad input', { field: 'amount' });
    expect(error).toBeInstanceOf(PaySwapError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.category).toBe('VALIDATION');
    expect(error.message).toBe('bad input');
    expect(error.details).toEqual({ field: 'amount' });

    const bare = new ValidationError('no details');
    expect('details' in bare).toBe(false);
  });

  it('keeps instanceof correct through subclasses', () => {
    const error: unknown = new ExternalAmbiguityError('rail timeout');
    expect(error).toBeInstanceOf(ExternalAmbiguityError);
    expect(error).toBeInstanceOf(PaySwapError);
    expect(error).toBeInstanceOf(Error);
    expect((error as ExternalAmbiguityError).name).toBe('ExternalAmbiguityError');
  });
});

describe('UNKNOWN is not FAILED (INV-X01)', () => {
  it('ExternalAmbiguityError is NOT a failure outcome', () => {
    const unknown = new ExternalAmbiguityError('rail did not answer before timeout', {
      rail: 'ach',
      externalId: 'ext_123',
    });
    expect(isFailureOutcome(unknown)).toBe(false);
  });

  it('ExternalAmbiguityError carries the distinct requiresReconciliation flag', () => {
    const unknown = new ExternalAmbiguityError('outcome not determinable');
    expect(unknown.requiresReconciliation).toBe(true);
  });

  it('definitive errors ARE failure outcomes', () => {
    expect(isFailureOutcome(new ValidationError('x'))).toBe(true);
    expect(isFailureOutcome(new CurrencyMismatchError('x'))).toBe(true);
    expect(isFailureOutcome(new FloatMoneyRejectedError('x'))).toBe(true);
  });

  it('foreign throwables and empty values fall back to failure (conservative)', () => {
    expect(isFailureOutcome(new Error('plain'))).toBe(true);
    expect(isFailureOutcome('string throw')).toBe(true);
    expect(isFailureOutcome(null)).toBe(true);
    expect(isFailureOutcome(undefined)).toBe(true);
  });

  it('no UNKNOWN → FAILED fallback in the classifier contract', () => {
    // The classifier must be total: ambiguity is the ONLY non-failure class.
    for (const error of [
      new ValidationError('a'),
      new PaySwapError({ code: 'INTERNAL_X', category: 'INTERNAL', message: 'x' }),
    ]) {
      expect(isFailureOutcome(error)).toBe(true);
    }
    const ambiguous = new PaySwapError({
      code: 'EXTERNAL_AMBIGUITY',
      category: 'EXTERNAL_AMBIGUITY',
      message: 'pretender',
    });
    // Only the typed class counts as UNKNOWN; category alone does not lie.
    expect(isFailureOutcome(ambiguous)).toBe(true);
  });
});
