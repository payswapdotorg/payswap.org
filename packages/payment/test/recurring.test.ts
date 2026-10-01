import { describe, expect, it } from 'vitest';
import {
  IllegalMandateTransitionError,
  applyMandateEvent,
  chargeAdmissible,
  defineFallbackPolicy,
  defineMandate,
  evaluateFallback,
  recordCharge,
  type RecurringMandate,
} from '../src/recurring.js';

function mandate(): RecurringMandate {
  return defineMandate({
    id: 'mdt:1',
    payer: 'payer:alice',
    payee: 'merchant:acme',
    method: 'pm:mobile-money',
    schedule: { intervalMs: 2_592_000_000n, maxCharges: 12n },
    maxAmountPerCharge: { currency: 'GHS', value: 5_000n },
    scope: 'monthly subscription: acme-pro',
    validFrom: 1_000n,
    expiresAt: 400_000n,
  });
}

describe('defineMandate', () => {
  it('constructs a PENDING mandate with explicit schedule, maximum and scope', () => {
    const record = mandate();
    expect(record.state).toBe('PENDING');
    expect(record.schedule.maxCharges).toBe(12n);
    expect(record.maxAmountPerCharge.value).toBe(5_000n);
    expect(record.chargeCount).toBe(0n);
  });

  it('validates schedule, amount, scope and validity bounds', () => {
    expect(() =>
      defineMandate({
        id: 'mdt:x',
        payer: 'a',
        payee: 'b',
        method: 'pm:mobile-money',
        schedule: { intervalMs: 0n, maxCharges: 1n },
        maxAmountPerCharge: { currency: 'GHS', value: 100n },
        scope: 's',
        validFrom: 0n,
        expiresAt: 100n,
      }),
    ).toThrow(/intervalMs/);
    expect(() =>
      defineMandate({
        id: 'mdt:x',
        payer: 'a',
        payee: 'b',
        method: 'pm:mobile-money',
        schedule: { intervalMs: 10n, maxCharges: 1n },
        maxAmountPerCharge: { currency: 'GHS', value: 0n },
        scope: 's',
        validFrom: 0n,
        expiresAt: 100n,
      }),
    ).toThrow(/positive/);
    expect(() =>
      defineMandate({
        id: 'mdt:x',
        payer: 'a',
        payee: 'b',
        method: 'pm:mobile-money',
        schedule: { intervalMs: 10n, maxCharges: 1n },
        maxAmountPerCharge: { currency: 'GHS', value: 100n },
        scope: 's',
        validFrom: 100n,
        expiresAt: 100n,
      }),
    ).toThrow(/strictly after/);
  });
});

describe('mandate lifecycle (deterministic state machine)', () => {
  it('walks PENDING → ACTIVE → PAUSED → ACTIVE → CANCELLED', () => {
    let record = mandate();
    record = applyMandateEvent(record, 'ACTIVATE', 2_000n);
    expect(record.state).toBe('ACTIVE');
    record = applyMandateEvent(record, 'PAUSE', 3_000n);
    expect(record.state).toBe('PAUSED');
    record = applyMandateEvent(record, 'RESUME', 4_000n);
    expect(record.state).toBe('ACTIVE');
    record = applyMandateEvent(record, 'CANCEL', 5_000n);
    expect(record.state).toBe('CANCELLED');
    // terminal states are monotonic — no event leaves CANCELLED
    expect(() => applyMandateEvent(record, 'RESUME', 6_000n)).toThrow(
      IllegalMandateTransitionError,
    );
    expect(() => applyMandateEvent(record, 'EXPIRE', 999_999n)).toThrow(
      IllegalMandateTransitionError,
    );
  });

  it('PENDING can cancel directly; EXPIRE only at/after expiresAt', () => {
    const record = mandate();
    expect(() => applyMandateEvent(record, 'EXPIRE', 399_999n)).toThrow(
      IllegalMandateTransitionError,
    );
    const expired = applyMandateEvent(record, 'EXPIRE', 400_000n);
    expect(expired.state).toBe('EXPIRED');
    const cancelled = applyMandateEvent(mandate(), 'CANCEL', 1_500n);
    expect(cancelled.state).toBe('CANCELLED');
  });

  it('activation is refused once the mandate window is over', () => {
    const record = mandate();
    expect(() => applyMandateEvent(record, 'ACTIVATE', 500_000n)).toThrow(
      IllegalMandateTransitionError,
    );
  });

  it('there is deliberately NO renewal transition — renewal is a new mandate', () => {
    const expired = applyMandateEvent(mandate(), 'EXPIRE', 400_000n);
    expect(expired.state).toBe('EXPIRED');
    const events = ['ACTIVATE', 'PAUSE', 'RESUME', 'CANCEL', 'EXPIRE'] as const;
    for (const event of events) {
      expect(() => applyMandateEvent(expired, event, 400_001n)).toThrow(
        IllegalMandateTransitionError,
      );
    }
  });
});

describe('chargeAdmissible (authority never silently expands)', () => {
  it('accepts an in-window, under-maximum charge on an ACTIVE mandate', () => {
    const active = applyMandateEvent(mandate(), 'ACTIVATE', 2_000n);
    const decision = chargeAdmissible(active, { currency: 'GHS', value: 4_500n }, 3_000n);
    expect(decision.admissible).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it('rejects charges that exceed the maximum, mismatch currency, or leave validity', () => {
    const active = applyMandateEvent(mandate(), 'ACTIVATE', 2_000n);
    expect(
      chargeAdmissible(active, { currency: 'GHS', value: 5_001n }, 3_000n).reasons,
    ).toContain('CHARGE_EXCEEDS_MAXIMUM');
    expect(
      chargeAdmissible(active, { currency: 'USD', value: 100n }, 3_000n).reasons,
    ).toContain('CHARGE_CURRENCY_MISMATCH');
    expect(
      chargeAdmissible(active, { currency: 'GHS', value: 100n }, 500_000n).reasons,
    ).toContain('MANDATE_OUTSIDE_VALIDITY');
    expect(
      chargeAdmissible(mandate(), { currency: 'GHS', value: 100n }, 3_000n).reasons,
    ).toContain('MANDATE_NOT_ACTIVE:PENDING');
  });

  it('enforces the charge-count ceiling exactly', () => {
    const tiny = defineMandate({
      id: 'mdt:tiny',
      payer: 'a',
      payee: 'b',
      method: 'pm:mobile-money',
      schedule: { intervalMs: 10n, maxCharges: 2n },
      maxAmountPerCharge: { currency: 'GHS', value: 100n },
      scope: 's',
      validFrom: 0n,
      expiresAt: 1_000n,
    });
    let record = applyMandateEvent(tiny, 'ACTIVATE', 1n);
    record = recordCharge(record);
    expect(chargeAdmissible(record, { currency: 'GHS', value: 100n }, 2n).admissible).toBe(true);
    record = recordCharge(record);
    const decision = chargeAdmissible(record, { currency: 'GHS', value: 100n }, 3n);
    expect(decision.admissible).toBe(false);
    expect(decision.reasons).toContain('CHARGE_CEILING_REACHED');
    expect(() => recordCharge(mandate())).toThrow(IllegalMandateTransitionError);
  });
});

describe('PaymentFallbackPolicy and evaluateFallback', () => {
  const policy = defineFallbackPolicy({
    mode: 'AUTOMATIC',
    permittedAlternateMethods: ['pm:bank', 'pm:wallet'],
    maxExtraCostBasisPoints: 150n,
    maxDelayMs: 600_000n,
    recourseRequirements: ['MERCHANT_DISPUTE_WINDOW'],
  });

  it('permits automatic fallback within thresholds on a permitted method', () => {
    const decision = evaluateFallback(policy, {
      alternateMethod: 'pm:bank',
      extraCostBasisPoints: 100n,
      extraDelayMs: 300_000n,
    });
    expect(decision.automatic).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it('blocks unlisted methods and out-of-threshold cost/delay — never silent', () => {
    expect(
      evaluateFallback(policy, {
        alternateMethod: 'pm:card',
        extraCostBasisPoints: 0n,
        extraDelayMs: 0n,
      }).reasons,
    ).toContain('ALTERNATE_METHOD_NOT_PERMITTED');
    expect(
      evaluateFallback(policy, {
        alternateMethod: 'pm:bank',
        extraCostBasisPoints: 200n,
        extraDelayMs: 0n,
      }).reasons,
    ).toContain('EXTRA_COST_BEYOND_THRESHOLD');
    expect(
      evaluateFallback(policy, {
        alternateMethod: 'pm:bank',
        extraCostBasisPoints: 0n,
        extraDelayMs: 700_000n,
      }).reasons,
    ).toContain('EXTRA_DELAY_BEYOND_THRESHOLD');
  });

  it('APPROVAL_REQUIRED mode never falls back automatically', () => {
    const strict = defineFallbackPolicy({
      mode: 'APPROVAL_REQUIRED',
      permittedAlternateMethods: ['pm:bank'],
      maxExtraCostBasisPoints: 150n,
      maxDelayMs: 600_000n,
      recourseRequirements: [],
    });
    const decision = evaluateFallback(strict, {
      alternateMethod: 'pm:bank',
      extraCostBasisPoints: 0n,
      extraDelayMs: 0n,
    });
    expect(decision.automatic).toBe(false);
    expect(decision.reasons).toContain('FALLBACK_REQUIRES_APPROVAL');
  });

  it('validates the policy itself', () => {
    expect(() =>
      defineFallbackPolicy({
        mode: 'SILENT' as never,
        permittedAlternateMethods: [],
        maxExtraCostBasisPoints: 0n,
        maxDelayMs: 0n,
        recourseRequirements: [],
      }),
    ).toThrow(/mode/);
  });
});
