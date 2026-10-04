import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  TerminalStateViolationError,
  TransitionGuardError,
  ValidationError,
  currencyCode,
  fromMinorUnits,
} from '@payswap/protocol';
import {
  defineMerchantPaymentIntent,
  merchantPaymentIntentStateMachine,
  type MerchantPaymentIntent,
} from '../src/index.js';

const EUR = currencyCode('EUR');

const context = { now: 1000n, expiresAt: 61000n };

function baseIntentInput() {
  return {
    id: 'intent-1',
    merchantRef: 'merchant-1',
    acceptancePolicyId: 'ap-1',
    cryptoAcceptancePolicyId: 'mcap-1',
    amount: fromMinorUnits(EUR, 10000n),
    createdAt: 1000n,
    expiresAt: 61000n,
  };
}

describe('merchantPaymentIntentStateMachine', () => {
  it('walks the full legal happy path to SUCCEEDED', () => {
    let state = merchantPaymentIntentStateMachine.initial;
    expect(state).toBe('REQUIRES_PAYMENT_METHOD');

    const attach = merchantPaymentIntentStateMachine.transition(state, 'ATTACH_METHOD', context);
    expect(attach).toEqual({
      from: 'REQUIRES_PAYMENT_METHOD',
      on: 'ATTACH_METHOD',
      to: 'REQUIRES_CONFIRMATION',
      viaRecovery: false,
    });
    state = attach.to;

    const confirm = merchantPaymentIntentStateMachine.transition(state, 'CONFIRM', context);
    expect(confirm.to).toBe('PROCESSING');
    state = confirm.to;

    const succeeded = merchantPaymentIntentStateMachine.transition(state, 'CONFIRM_SUCCEEDED', context);
    expect(succeeded.to).toBe('SUCCEEDED');
    expect(succeeded.viaRecovery).toBe(false);
    expect(merchantPaymentIntentStateMachine.isTerminal(succeeded.to)).toBe(true);
  });

  it('guards EXPIRE to now >= expiresAt from REQUIRES_PAYMENT_METHOD', () => {
    expect(() =>
      merchantPaymentIntentStateMachine.transition('REQUIRES_PAYMENT_METHOD', 'EXPIRE', {
        now: 60999n,
        expiresAt: 61000n,
      }),
    ).toThrow(TransitionGuardError);
    const expired = merchantPaymentIntentStateMachine.transition('REQUIRES_PAYMENT_METHOD', 'EXPIRE', {
      now: 61000n,
      expiresAt: 61000n,
    });
    expect(expired.to).toBe('EXPIRED');
  });

  it('guards EXPIRE to now >= expiresAt from REQUIRES_CONFIRMATION', () => {
    expect(() =>
      merchantPaymentIntentStateMachine.transition('REQUIRES_CONFIRMATION', 'EXPIRE', {
        now: 60999n,
        expiresAt: 61000n,
      }),
    ).toThrow(TransitionGuardError);
    const expired = merchantPaymentIntentStateMachine.transition('REQUIRES_CONFIRMATION', 'EXPIRE', {
      now: 61001n,
      expiresAt: 61000n,
    });
    expect(expired.to).toBe('EXPIRED');
  });

  it('allows CANCEL from all three non-terminal pre-states', () => {
    for (const from of ['REQUIRES_PAYMENT_METHOD', 'REQUIRES_CONFIRMATION', 'PROCESSING'] as const) {
      const cancelled = merchantPaymentIntentStateMachine.transition(from, 'CANCEL', context);
      expect(cancelled.to).toBe('CANCELED');
      expect(cancelled.from).toBe(from);
    }
  });

  it('reaches OUTCOME_UNKNOWN from PROCESSING and exits only via RESOLVE_*', () => {
    const unknown = merchantPaymentIntentStateMachine.transition('PROCESSING', 'REPORT_UNKNOWN', context);
    expect(unknown.to).toBe('OUTCOME_UNKNOWN');
    expect(merchantPaymentIntentStateMachine.isTerminal('OUTCOME_UNKNOWN')).toBe(false);

    const resolvedSucceeded = merchantPaymentIntentStateMachine.transition(
      'OUTCOME_UNKNOWN',
      'RESOLVE_SUCCEEDED',
      context,
    );
    expect(resolvedSucceeded.to).toBe('SUCCEEDED');

    const resolvedFailed = merchantPaymentIntentStateMachine.transition(
      'OUTCOME_UNKNOWN',
      'RESOLVE_FAILED',
      context,
    );
    expect(resolvedFailed.to).toBe('FAILED');
  });

  it('terminal states are monotonic: every event from SUCCEEDED throws', () => {
    for (const event of merchantPaymentIntentStateMachine.events) {
      expect(() =>
        merchantPaymentIntentStateMachine.transition('SUCCEEDED', event, context),
      ).toThrow(TerminalStateViolationError);
    }
    for (const event of merchantPaymentIntentStateMachine.events) {
      expect(() =>
        merchantPaymentIntentStateMachine.transition('FAILED', event, context),
      ).toThrow(TerminalStateViolationError);
    }
  });

  it('PROCESSING has no EXPIRE transition — an in-flight payment must resolve, never expire', () => {
    expect(() =>
      merchantPaymentIntentStateMachine.transition('PROCESSING', 'EXPIRE', {
        now: 999999n,
        expiresAt: 61000n,
      }),
    ).toThrow(IllegalTransitionError);
    expect(
      merchantPaymentIntentStateMachine.canTransition('PROCESSING', 'EXPIRE', {
        now: 999999n,
        expiresAt: 61000n,
      }),
    ).toBe(false);
  });
});

describe('defineMerchantPaymentIntent', () => {
  it('builds a frozen intent in the initial state on the happy path', () => {
    const intent: MerchantPaymentIntent = defineMerchantPaymentIntent(baseIntentInput());
    expect(intent.id).toBe('intent-1');
    expect(intent.merchantRef).toBe('merchant-1');
    expect(intent.acceptancePolicyId).toBe('ap-1');
    expect(intent.cryptoAcceptancePolicyId).toBe('mcap-1');
    expect(intent.amount.value).toBe(10000n);
    expect(intent.amount.currency).toBe('EUR');
    expect(intent.state).toBe('REQUIRES_PAYMENT_METHOD');
    expect(intent.createdAt).toBe(1000n);
    expect(intent.expiresAt).toBe(61000n);
    expect(intent.customerRef).toBeUndefined();
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it('conditionally carries customerRef', () => {
    const intent = defineMerchantPaymentIntent({
      ...baseIntentInput(),
      customerRef: 'customer-7',
    });
    expect(intent.customerRef).toBe('customer-7');
    expect('customerRef' in intent).toBe(true);
  });

  it('rejects expiresAt at or before createdAt', () => {
    expect(() =>
      defineMerchantPaymentIntent({ ...baseIntentInput(), expiresAt: 1000n }),
    ).toThrow(ValidationError);
    expect(() =>
      defineMerchantPaymentIntent({ ...baseIntentInput(), expiresAt: 999n }),
    ).toThrow(ValidationError);
  });

  it('rejects a non-positive amount', () => {
    expect(() =>
      defineMerchantPaymentIntent({
        ...baseIntentInput(),
        amount: fromMinorUnits(EUR, 0n),
      }),
    ).toThrow(ValidationError);
  });

  it('rejects empty ids and refs', () => {
    expect(() => defineMerchantPaymentIntent({ ...baseIntentInput(), id: '' })).toThrow(
      ValidationError,
    );
    expect(() => defineMerchantPaymentIntent({ ...baseIntentInput(), merchantRef: '' })).toThrow(
      ValidationError,
    );
    expect(() =>
      defineMerchantPaymentIntent({ ...baseIntentInput(), acceptancePolicyId: '' }),
    ).toThrow(ValidationError);
    expect(() =>
      defineMerchantPaymentIntent({ ...baseIntentInput(), cryptoAcceptancePolicyId: '' }),
    ).toThrow(ValidationError);
  });
});
