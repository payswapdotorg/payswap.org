/**
 * @payswap/merchant-crypto — merchant payment intent (P4-W1-003).
 * A merchant-scoped, fiat-priced payment demand that maps onto the canonical
 * MoneyMovementIntent/intent-compiler plane (it references the acceptance
 * policies; it never re-implements intent compilation). Lifecycle is a
 * deterministic state machine with UNKNOWN as a first-class non-terminal
 * state (INV-X01): OUTCOME_UNKNOWN can only be exited through reconciliation
 * resolution (INV-X03); terminal states are monotonic (INV-X04).
 */

import { ValidationError, defineStateMachine } from '@payswap/protocol';
import type { Money, StateMachine, TimestampMs } from '@payswap/protocol';

declare const MerchantPaymentIntentIdBrand: unique symbol;

/** Branded id of one merchant payment intent. */
export type MerchantPaymentIntentId = string & {
  readonly [MerchantPaymentIntentIdBrand]: 'MerchantPaymentIntentId';
};

/** Lifecycle states of a merchant payment intent. */
export type MerchantPaymentIntentState =
  | 'REQUIRES_PAYMENT_METHOD'
  | 'REQUIRES_CONFIRMATION'
  | 'PROCESSING'
  | 'OUTCOME_UNKNOWN'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED'
  | 'EXPIRED';

/** Events the merchant payment intent state machine declares. */
export type MerchantPaymentIntentEvent =
  | 'ATTACH_METHOD'
  | 'CONFIRM'
  | 'CONFIRM_SUCCEEDED'
  | 'CONFIRM_FAILED'
  | 'REPORT_UNKNOWN'
  | 'RESOLVE_SUCCEEDED'
  | 'RESOLVE_FAILED'
  | 'CANCEL'
  | 'EXPIRE';

/** Guard context: injected clock reading plus the intent's expiry. */
export interface MerchantPaymentIntentMachineContext {
  readonly now: TimestampMs;
  readonly expiresAt: TimestampMs;
}

/**
 * The deterministic merchant payment intent lifecycle machine.
 *
 * OUTCOME_UNKNOWN is a first-class NON-TERMINAL state (INV-X01): it is
 * reachable from PROCESSING via REPORT_UNKNOWN and can ONLY be exited
 * through a reconciliation resolution (RESOLVE_SUCCEEDED / RESOLVE_FAILED,
 * INV-X03) — there is no other declared exit from ambiguity.
 *
 * PROCESSING deliberately has NO EXPIRE transition — an in-flight payment
 * must resolve (through confirmation or reconciliation), never expire: a
 * payment already submitted to a rail cannot be un-sent by the clock.
 *
 * EXPIRE is declarative and guarded to `now >= expiresAt` (the recurring
 * mandate pattern); terminal states are monotonic with no recovery rules
 * (INV-X04).
 */
export const merchantPaymentIntentStateMachine: StateMachine<
  MerchantPaymentIntentState,
  MerchantPaymentIntentEvent,
  MerchantPaymentIntentMachineContext
> = defineStateMachine<MerchantPaymentIntentState, MerchantPaymentIntentEvent, MerchantPaymentIntentMachineContext>({
  name: 'merchant-payment-intent',
  initial: 'REQUIRES_PAYMENT_METHOD',
  states: [
    'REQUIRES_PAYMENT_METHOD',
    'REQUIRES_CONFIRMATION',
    'PROCESSING',
    'OUTCOME_UNKNOWN',
    'SUCCEEDED',
    'FAILED',
    'CANCELED',
    'EXPIRED',
  ],
  events: [
    'ATTACH_METHOD',
    'CONFIRM',
    'CONFIRM_SUCCEEDED',
    'CONFIRM_FAILED',
    'REPORT_UNKNOWN',
    'RESOLVE_SUCCEEDED',
    'RESOLVE_FAILED',
    'CANCEL',
    'EXPIRE',
  ],
  transitions: [
    {
      from: 'REQUIRES_PAYMENT_METHOD',
      on: 'ATTACH_METHOD',
      to: 'REQUIRES_CONFIRMATION',
      description: 'a payment method (crypto asset/chain/quote) was attached',
    },
    {
      from: 'REQUIRES_CONFIRMATION',
      on: 'CONFIRM',
      to: 'PROCESSING',
      description: 'the payer confirmed; execution is in flight',
    },
    {
      from: 'PROCESSING',
      on: 'CONFIRM_SUCCEEDED',
      to: 'SUCCEEDED',
      description: 'definitive success observed with evidence',
    },
    {
      from: 'PROCESSING',
      on: 'CONFIRM_FAILED',
      to: 'FAILED',
      description: 'definitive failure observed with evidence',
    },
    {
      from: 'PROCESSING',
      on: 'REPORT_UNKNOWN',
      to: 'OUTCOME_UNKNOWN',
      description: 'the outcome is ambiguous — UNKNOWN is first-class, never FAILED (INV-X01)',
    },
    {
      from: 'OUTCOME_UNKNOWN',
      on: 'RESOLVE_SUCCEEDED',
      to: 'SUCCEEDED',
      description: 'reconciliation resolved the ambiguity as success (INV-X03)',
    },
    {
      from: 'OUTCOME_UNKNOWN',
      on: 'RESOLVE_FAILED',
      to: 'FAILED',
      description: 'reconciliation resolved the ambiguity as failure (INV-X03)',
    },
    { from: 'REQUIRES_PAYMENT_METHOD', on: 'CANCEL', to: 'CANCELED', description: 'cancelled before a method was attached' },
    { from: 'REQUIRES_CONFIRMATION', on: 'CANCEL', to: 'CANCELED', description: 'cancelled before confirmation' },
    { from: 'PROCESSING', on: 'CANCEL', to: 'CANCELED', description: 'cancelled while processing (merchant-side abandonment)' },
    {
      from: 'REQUIRES_PAYMENT_METHOD',
      on: 'EXPIRE',
      to: 'EXPIRED',
      guard: (context) => context.now >= context.expiresAt,
      description: 'expiry is declarative: only at/after expiresAt',
    },
    {
      from: 'REQUIRES_CONFIRMATION',
      on: 'EXPIRE',
      to: 'EXPIRED',
      guard: (context) => context.now >= context.expiresAt,
      description: 'expiry is declarative: only at/after expiresAt',
    },
  ],
  terminalStates: ['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED'],
});

/** One merchant payment intent (fiat-priced payment demand). */
export interface MerchantPaymentIntent {
  readonly id: MerchantPaymentIntentId;
  readonly merchantRef: string;
  readonly acceptancePolicyId: string;
  readonly cryptoAcceptancePolicyId: string;
  readonly amount: Money;
  readonly customerRef?: string;
  readonly state: MerchantPaymentIntentState;
  readonly createdAt: TimestampMs;
  readonly expiresAt: TimestampMs;
}

/** Brand a validated string as a `MerchantPaymentIntentId`. */
export function asMerchantPaymentIntentId(value: string): MerchantPaymentIntentId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('MerchantPaymentIntentId must be a non-empty string', { value });
  }
  if (value.length > 256) {
    throw new ValidationError('MerchantPaymentIntentId exceeds 256 characters', { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError('MerchantPaymentIntentId must not carry surrounding whitespace', {
      value,
    });
  }
  return value as MerchantPaymentIntentId;
}

/**
 * Construct a validated, frozen merchant payment intent in the
 * REQUIRES_PAYMENT_METHOD state. The amount must be positive exact Money;
 * the intent must expire strictly after it was created.
 */
export function defineMerchantPaymentIntent(input: {
  readonly id: string;
  readonly merchantRef: string;
  readonly acceptancePolicyId: string;
  readonly cryptoAcceptancePolicyId: string;
  readonly amount: Money;
  readonly customerRef?: string;
  readonly createdAt: bigint;
  readonly expiresAt: bigint;
}): MerchantPaymentIntent {
  const id = asMerchantPaymentIntentId(input.id);
  if (typeof input.merchantRef !== 'string' || input.merchantRef.length === 0) {
    throw new ValidationError('intent merchantRef must be a non-empty string', { id });
  }
  if (typeof input.acceptancePolicyId !== 'string' || input.acceptancePolicyId.length === 0) {
    throw new ValidationError('intent acceptancePolicyId must be a non-empty string', { id });
  }
  if (
    typeof input.cryptoAcceptancePolicyId !== 'string' ||
    input.cryptoAcceptancePolicyId.length === 0
  ) {
    throw new ValidationError('intent cryptoAcceptancePolicyId must be a non-empty string', { id });
  }
  const amount = input.amount;
  if (amount === null || typeof amount !== 'object' || typeof amount.value !== 'bigint') {
    throw new ValidationError('intent amount must be exact Money', { id });
  }
  if (typeof amount.currency !== 'string' || amount.currency.length === 0) {
    throw new ValidationError('intent amount needs a currency', { id });
  }
  if (amount.value <= 0n) {
    throw new ValidationError('intent amount must be positive', { id });
  }
  if (input.customerRef !== undefined) {
    if (typeof input.customerRef !== 'string' || input.customerRef.length === 0) {
      throw new ValidationError('intent customerRef must be a non-empty string when present', {
        id,
      });
    }
  }
  if (typeof input.createdAt !== 'bigint' || typeof input.expiresAt !== 'bigint') {
    throw new ValidationError('intent bounds must be bigint TimestampMs', { id });
  }
  if (input.expiresAt <= input.createdAt) {
    throw new ValidationError('intent must expire strictly after it was created', { id });
  }
  return Object.freeze({
    id,
    merchantRef: input.merchantRef,
    acceptancePolicyId: input.acceptancePolicyId,
    cryptoAcceptancePolicyId: input.cryptoAcceptancePolicyId,
    amount,
    ...(input.customerRef !== undefined ? { customerRef: input.customerRef } : {}),
    state: 'REQUIRES_PAYMENT_METHOD',
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}
