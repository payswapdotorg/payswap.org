/**
 * UX-002 — error-reason registry tests (contract 07 v1.1 §2 + §4 + §7):
 *
 * - the registry covers ALL EIGHT certified reasons, in contract table order;
 * - every reason has a human label + technical trigger + typed next-action
 *   family (+ one icon, one next-action label) — the single typed source;
 * - custom errors EXTEND the registry (pure `extendErrorReasons`), reusing the
 *   typed action families; validation is fail-closed (no untyped reasons,
 *   no duplicate ids, no inline free-text escape);
 * - the §4 anatomy composer derives the "what — why — what now" sentence from
 *   registry fields only.
 */

import { describe, expect, it } from 'vitest';

import {
  composeErrorSentence,
  ERROR_REASONS,
  ERROR_REASON_IDS,
  errorReasonById,
  extendErrorReasons,
  isErrorReasonId,
  type CustomErrorReason,
  type ErrorNextActionFamily,
} from '../src/error-reasons.js';

// ---------------------------------------------------------------------------
// The certified registry (contract 07 §2 table)
// ---------------------------------------------------------------------------

describe('the certified reason registry (contract 07 §2)', () => {
  it('covers ALL EIGHT reasons, in the contract table order', () => {
    expect(ERROR_REASON_IDS).toEqual([
      'insufficient-balance',
      'payment-reverted',
      'route-unavailable',
      'slippage-beyond-limit',
      'transaction-dropped',
      'timed-out-awaiting-confirmation',
      'blocked-by-security-policy',
      'cancelled-by-user',
    ]);
    expect(ERROR_REASONS.map((reason) => reason.id)).toEqual([...ERROR_REASON_IDS]);
    expect(ERROR_REASONS.every((reason) => reason.custom === false)).toBe(true);
  });

  it('every reason carries label + technical trigger + next-action family (+ icon, next-action label)', () => {
    for (const reason of ERROR_REASONS) {
      expect(reason.label.length).toBeGreaterThan(0);
      expect(reason.technicalTrigger.length).toBeGreaterThan(0);
      expect(reason.nextActionFamily.length).toBeGreaterThan(0);
      expect(reason.nextActionLabel.length).toBeGreaterThan(0);
      expect(reason.icon.length).toBeGreaterThan(0);
    }
  });

  it('the next-action families match the contract table (column 3, typed)', () => {
    const families: Readonly<Record<string, ErrorNextActionFamily>> = {
      'insufficient-balance': 'top-up-or-switch-rail',
      'payment-reverted': 'show-reason-and-retry-with-edit',
      'route-unavailable': 'show-ranked-alternatives',
      'slippage-beyond-limit': 'retry-with-adjusted-limit',
      'transaction-dropped': 'investigate',
      'timed-out-awaiting-confirmation': 'investigate-or-rebroadcast',
      'blocked-by-security-policy': 'explanation-and-appeal',
      'cancelled-by-user': 'none-recorded-as-event',
    };
    for (const reason of ERROR_REASONS) {
      const expected = families[reason.id];
      expect(expected).toBeDefined();
      expect(reason.nextActionFamily).toBe(expected);
    }
  });

  it('exactly ONE icon per reason (1:1, no sharing among the certified eight)', () => {
    const icons = ERROR_REASONS.map((reason) => reason.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('the contract labels are the human labels (no invented synonyms)', () => {
    expect(errorReasonById('insufficient-balance').label).toBe('Insufficient balance');
    expect(errorReasonById('payment-reverted').label).toBe('Payment reverted');
    expect(errorReasonById('route-unavailable').label).toBe('Route unavailable');
    expect(errorReasonById('slippage-beyond-limit').label).toBe('Slippage beyond limit');
    expect(errorReasonById('transaction-dropped').label).toBe('Transaction dropped');
    expect(errorReasonById('timed-out-awaiting-confirmation').label).toBe('Timed out awaiting confirmation');
    expect(errorReasonById('blocked-by-security-policy').label).toBe('Blocked by security policy');
    expect(errorReasonById('cancelled-by-user').label).toBe('Cancelled by user');
  });

  it('lookups fail closed — an unknown id throws, never free-text', () => {
    expect(() => errorReasonById('something-else')).toThrow(/unknown error reason/);
    expect(() => errorReasonById('')).toThrow(/unknown error reason/);
  });

  it('isErrorReasonId narrows', () => {
    expect(isErrorReasonId('route-unavailable')).toBe(true);
    expect(isErrorReasonId('route-unavailable ')).toBe(false);
    expect(isErrorReasonId(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Custom extension (contract 07 §2: "Custom errors MUST extend this table")
// ---------------------------------------------------------------------------

describe('custom errors extend the registry (never inline free-text)', () => {
  const validCustom: CustomErrorReason = {
    id: 'provider-maintenance-window',
    label: 'Provider maintenance',
    technicalTrigger: 'The provider is in a scheduled maintenance window.',
    nextActionFamily: 'investigate',
    nextActionLabel: 'Check the provider status page and retry after the window.',
    icon: 'wrench',
  };

  it('extends PURELY: a new registry value; the certified base is untouched', () => {
    const extended = extendErrorReasons([validCustom]);
    expect(extended).toHaveLength(ERROR_REASONS.length + 1);
    expect(extended[extended.length - 1]?.custom).toBe(true);
    // The base registry is unchanged (frozen, never mutated):
    expect(ERROR_REASONS).toHaveLength(8);
    expect(ERROR_REASONS.some((reason) => reason.id === 'provider-maintenance-window')).toBe(false);
    // The extension resolves through the SAME lookup path:
    expect(errorReasonById('provider-maintenance-window', extended).label).toBe('Provider maintenance');
  });

  it('rejects a custom reason that collides with a certified id', () => {
    expect(() =>
      extendErrorReasons([{ ...validCustom, id: 'insufficient-balance' }]),
    ).toThrow(/already exists/);
  });

  it('rejects duplicate custom ids within one extension', () => {
    expect(() => extendErrorReasons([validCustom, { ...validCustom, id: 'another-one' }])).not.toThrow();
    expect(() => extendErrorReasons([validCustom, validCustom])).toThrow(/already exists/);
  });

  it('rejects non-kebab ids and empty required fields (fail-closed validation)', () => {
    expect(() => extendErrorReasons([{ ...validCustom, id: 'Not Kebab' }])).toThrow(/kebab/);
    expect(() => extendErrorReasons([{ ...validCustom, id: 'shout' }])).not.toThrow();
    expect(() => extendErrorReasons([{ ...validCustom, label: '' }])).toThrow(/label/);
    expect(() => extendErrorReasons([{ ...validCustom, technicalTrigger: '' }])).toThrow(/trigger/);
    expect(() => extendErrorReasons([{ ...validCustom, nextActionLabel: '' }])).toThrow(/next-action label/);
    expect(() => extendErrorReasons([{ ...validCustom, icon: '' }])).toThrow(/icon/);
  });

  it('a custom reason reuses the TYPED next-action families (a new action shape is a contract change)', () => {
    // Type-level: nextActionFamily is the union — this assignment compiles only
    // for real family members; here we assert the certified reasons all use it.
    const certifiedFamilies = ERROR_REASONS.map((reason) => reason.nextActionFamily);
    const allFamilies: readonly ErrorNextActionFamily[] = [
      'top-up-or-switch-rail',
      'show-reason-and-retry-with-edit',
      'show-ranked-alternatives',
      'retry-with-adjusted-limit',
      'investigate',
      'investigate-or-rebroadcast',
      'explanation-and-appeal',
      'none-recorded-as-event',
    ];
    for (const family of certifiedFamilies) {
      expect(allFamilies).toContain(family);
    }
  });
});

// ---------------------------------------------------------------------------
// The §4 anatomy composer
// ---------------------------------------------------------------------------

describe('error message anatomy (contract 07 §4)', () => {
  it('composes [what happened] — [why] — [what you can do now] from registry fields', () => {
    const sentence = composeErrorSentence(errorReasonById('payment-reverted'));
    expect(sentence).toContain('Payment reverted — ');
    expect(sentence).toContain('reverted the transfer');
    expect(sentence).toContain('You can:');
    expect(sentence).toContain('retry with an edit');
  });

  it('cancelled-by-user states the event record honestly instead of offering a fake action', () => {
    const sentence = composeErrorSentence(errorReasonById('cancelled-by-user'));
    expect(sentence).toContain('Cancelled by user');
    expect(sentence).toContain('recorded as an event');
    expect(sentence).not.toContain('You can:');
  });

  it('never emits a raw code alone (the sentence is always the full anatomy)', () => {
    for (const reason of ERROR_REASONS) {
      const sentence = composeErrorSentence(reason);
      expect(sentence.startsWith(reason.label)).toBe(true);
      expect(sentence.length).toBeGreaterThan(reason.label.length + 10);
    }
  });
});
