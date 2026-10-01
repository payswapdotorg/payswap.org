/**
 * @payswap/payment — recurring mandate semantics and fallback policy
 * (W1-003).
 *
 * PAYMENT-OPERATING-PLANE: recurring payments use EXPLICIT mandates with a
 * recurrence schedule, maximum amount, merchant/service scope, validity,
 * cancellation, renewal authority and fallback policy. No recurring renewal
 * may silently expand authority.
 *
 * Mandate lifecycle (deterministic state machine built on the protocol
 * kernel):
 *
 *   PENDING --ACTIVATE--> ACTIVE --PAUSE--> PAUSED --RESUME--> ACTIVE
 *   PENDING --CANCEL-->  CANCELLED        PAUSED --CANCEL--> CANCELLED
 *   PENDING --EXPIRE-->  EXPIRED          ACTIVE  --EXPIRE--> EXPIRED
 *   ACTIVE  --CANCEL-->  CANCELLED        PAUSED  --EXPIRE--> EXPIRED
 *
 * CANCELLED and EXPIRED are terminal and monotonic (INV-X04). EXPIRE is
 * guarded to `now >= expiresAt`; renewal from EXPIRED is a NEW mandate
 * requiring fresh authorization — there is deliberately no renewal
 * transition, so authority can never silently extend.
 */

import { defineStateMachine, type StateMachine, type TimestampMs } from '@payswap/protocol';
import { asPaymentMethodId, type PaymentMethodId } from './method.js';

declare const MandateIdBrand: unique symbol;

/** Branded id of one recurring mandate. */
export type MandateId = string & { readonly [MandateIdBrand]: 'MandateId' };

/** Lifecycle states of a recurring mandate. */
export type MandateState = 'PENDING' | 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'EXPIRED';

/** Events the mandate state machine declares. */
export type MandateEvent = 'ACTIVATE' | 'PAUSE' | 'RESUME' | 'CANCEL' | 'EXPIRE';

/** Guard context: injected clock reading plus the mandate's expiry. */
export interface MandateMachineContext {
  readonly now: TimestampMs;
  readonly expiresAt: TimestampMs;
}

/** The recurrence schedule (declarative, deterministic). */
export interface RecurrenceSchedule {
  /** Interval between charges, in milliseconds. */
  readonly intervalMs: bigint;
  /** Maximum number of charges the mandate permits (0 = until expiry). */
  readonly maxCharges: bigint;
}

/** One explicit recurring mandate. */
export interface RecurringMandate {
  readonly id: MandateId;
  readonly payer: string;
  readonly payee: string;
  readonly method: PaymentMethodId;
  readonly schedule: RecurrenceSchedule;
  /** Maximum permitted charge amount (exact Money, single currency). */
  readonly maxAmountPerCharge: { readonly currency: string; readonly value: bigint };
  /** What the mandate authorizes (merchant/service scope). */
  readonly scope: string;
  readonly validFrom: TimestampMs;
  readonly expiresAt: TimestampMs;
  readonly state: MandateState;
  /** Charges executed under this mandate so far. */
  readonly chargeCount: bigint;
}

/**
 * Fallback semantics when the primary method fails (PAYMENT-OPERATING-PLANE):
 * permitted alternate methods, automatic vs approval-required fallback,
 * material-term thresholds, max extra cost, max delay, recourse
 * requirements. A material change ALWAYS requires re-authorization —
 * `AUTOMATIC` fallback is only legal within the declared thresholds.
 */
export interface PaymentFallbackPolicy {
  readonly mode: 'AUTOMATIC' | 'APPROVAL_REQUIRED';
  readonly permittedAlternateMethods: readonly PaymentMethodId[];
  /** Max extra cost tolerated for automatic fallback, basis points. */
  readonly maxExtraCostBasisPoints: bigint;
  /** Max extra delay tolerated for automatic fallback, in ms. */
  readonly maxDelayMs: bigint;
  readonly recourseRequirements: readonly string[];
}

/** Illegal mandate transition under the machine. */
export class IllegalMandateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalMandateTransitionError';
  }
}

/** A mandate-level validation failure. */
export class InvalidMandateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMandateError';
  }
}

/**
 * The deterministic mandate lifecycle machine. EXPIRE is declarative and
 * guarded to `now >= expiresAt`; terminal states have NO recovery rules —
 * renewal is a new mandate with fresh authorization, never a transition.
 */
export const mandateStateMachine: StateMachine<
  MandateState,
  MandateEvent,
  MandateMachineContext
> = defineStateMachine<MandateState, MandateEvent, MandateMachineContext>({
  name: 'recurring-mandate',
  initial: 'PENDING',
  states: ['PENDING', 'ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED'],
  events: ['ACTIVATE', 'PAUSE', 'RESUME', 'CANCEL', 'EXPIRE'],
  transitions: [
    {
      from: 'PENDING',
      on: 'ACTIVATE',
      to: 'ACTIVE',
      guard: (context) => context.now < context.expiresAt,
      description: 'activation requires the mandate to be within its validity window',
    },
    { from: 'PENDING', on: 'CANCEL', to: 'CANCELLED', description: 'cancellation before activation' },
    {
      from: 'PENDING',
      on: 'EXPIRE',
      to: 'EXPIRED',
      guard: (context) => context.now >= context.expiresAt,
      description: 'expiry is declarative: only at/after expiresAt',
    },
    { from: 'ACTIVE', on: 'PAUSE', to: 'PAUSED', description: 'pause an active mandate' },
    { from: 'ACTIVE', on: 'CANCEL', to: 'CANCELLED', description: 'cancel an active mandate' },
    {
      from: 'ACTIVE',
      on: 'EXPIRE',
      to: 'EXPIRED',
      guard: (context) => context.now >= context.expiresAt,
      description: 'expiry is declarative: only at/after expiresAt',
    },
    { from: 'PAUSED', on: 'RESUME', to: 'ACTIVE', description: 'resume a paused mandate' },
    { from: 'PAUSED', on: 'CANCEL', to: 'CANCELLED', description: 'cancel a paused mandate' },
    {
      from: 'PAUSED',
      on: 'EXPIRE',
      to: 'EXPIRED',
      guard: (context) => context.now >= context.expiresAt,
      description: 'expiry is declarative: only at/after expiresAt',
    },
  ],
  terminalStates: ['CANCELLED', 'EXPIRED'],
});

/** Brand a validated string as a `MandateId`. */
export function asMandateId(value: string): MandateId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidMandateError('MandateId must be a non-empty string');
  }
  if (value.length > 256) {
    throw new InvalidMandateError('MandateId exceeds 256 characters');
  }
  if (value.trim() !== value) {
    throw new InvalidMandateError('MandateId must not carry surrounding whitespace');
  }
  return value as MandateId;
}

/** Construct a validated, frozen recurring mandate in the PENDING state. */
export function defineMandate(input: {
  readonly id: string;
  readonly payer: string;
  readonly payee: string;
  readonly method: string;
  readonly schedule: RecurrenceSchedule;
  readonly maxAmountPerCharge: { readonly currency: string; readonly value: bigint };
  readonly scope: string;
  readonly validFrom: TimestampMs;
  readonly expiresAt: TimestampMs;
}): RecurringMandate {
  const id = asMandateId(input.id);
  if (typeof input.payer !== 'string' || input.payer.length === 0) {
    throw new InvalidMandateError('mandate payer must be a non-empty string');
  }
  if (typeof input.payee !== 'string' || input.payee.length === 0) {
    throw new InvalidMandateError('mandate payee must be a non-empty string');
  }
  if (input.payer === input.payee) {
    throw new InvalidMandateError('mandate payer and payee must differ');
  }
  if (
    input.schedule === null ||
    typeof input.schedule !== 'object' ||
    typeof input.schedule.intervalMs !== 'bigint' ||
    input.schedule.intervalMs <= 0n ||
    typeof input.schedule.maxCharges !== 'bigint' ||
    input.schedule.maxCharges < 0n
  ) {
    throw new InvalidMandateError('mandate schedule must carry intervalMs > 0 and maxCharges >= 0');
  }
  const amount = input.maxAmountPerCharge;
  if (
    amount === null ||
    typeof amount !== 'object' ||
    typeof amount.currency !== 'string' ||
    amount.currency.length !== 3 ||
    typeof amount.value !== 'bigint' ||
    amount.value <= 0n
  ) {
    throw new InvalidMandateError('mandate maxAmountPerCharge must be positive exact money');
  }
  if (typeof input.scope !== 'string' || input.scope.length === 0) {
    throw new InvalidMandateError('mandate scope must be a non-empty string');
  }
  if (typeof input.validFrom !== 'bigint' || typeof input.expiresAt !== 'bigint') {
    throw new InvalidMandateError('mandate validity bounds must be bigint TimestampMs');
  }
  if (input.expiresAt <= input.validFrom) {
    throw new InvalidMandateError('mandate must expire strictly after it becomes valid');
  }
  return Object.freeze({
    id,
    payer: input.payer,
    payee: input.payee,
    method: asPaymentMethodId(input.method),
    schedule: Object.freeze({
      intervalMs: input.schedule.intervalMs,
      maxCharges: input.schedule.maxCharges,
    }),
    maxAmountPerCharge: Object.freeze({
      currency: input.maxAmountPerCharge.currency,
      value: input.maxAmountPerCharge.value,
    }),
    scope: input.scope,
    validFrom: input.validFrom,
    expiresAt: input.expiresAt,
    state: 'PENDING',
    chargeCount: 0n,
  });
}

/** Apply one mandate event under the deterministic machine. */
export function applyMandateEvent(
  mandate: RecurringMandate,
  event: MandateEvent,
  now: TimestampMs,
): RecurringMandate {
  if (mandate === null || typeof mandate !== 'object') {
    throw new InvalidMandateError('mandate must be a RecurringMandate');
  }
  if (typeof now !== 'bigint') {
    throw new InvalidMandateError('now must be a bigint TimestampMs');
  }
  let record;
  try {
    record = mandateStateMachine.transition(mandate.state, event, { now, expiresAt: mandate.expiresAt });
  } catch (error) {
    throw new IllegalMandateTransitionError(
      error instanceof Error ? error.message : 'illegal mandate transition',
    );
  }
  return Object.freeze({ ...mandate, state: record.to });
}

/**
 * Deterministic charge admissibility under the mandate — a charge is
 * admissible only while ACTIVE, within validity, below the per-charge
 * maximum and below the charge-count ceiling. Authority never silently
 * expands: every dimension is checked explicitly.
 */
export function chargeAdmissible(
  mandate: RecurringMandate,
  chargeAmount: { readonly currency: string; readonly value: bigint },
  now: TimestampMs,
): { readonly admissible: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (mandate.state !== 'ACTIVE') {
    reasons.push(`MANDATE_NOT_ACTIVE:${mandate.state}`);
  }
  if (now < mandate.validFrom || now >= mandate.expiresAt) {
    reasons.push('MANDATE_OUTSIDE_VALIDITY');
  }
  if (chargeAmount.currency !== mandate.maxAmountPerCharge.currency) {
    reasons.push('CHARGE_CURRENCY_MISMATCH');
  }
  if (chargeAmount.value > mandate.maxAmountPerCharge.value) {
    reasons.push('CHARGE_EXCEEDS_MAXIMUM');
  }
  if (mandate.schedule.maxCharges > 0n && mandate.chargeCount >= mandate.schedule.maxCharges) {
    reasons.push('CHARGE_CEILING_REACHED');
  }
  return Object.freeze({ admissible: reasons.length === 0, reasons: Object.freeze(reasons) });
}

/** Record one executed charge (advances the count; never changes authority). */
export function recordCharge(mandate: RecurringMandate): RecurringMandate {
  if (mandate.state !== 'ACTIVE') {
    throw new IllegalMandateTransitionError('charges can only be recorded on an ACTIVE mandate');
  }
  return Object.freeze({ ...mandate, chargeCount: mandate.chargeCount + 1n });
}

/** Construct a validated, frozen fallback policy. */
export function defineFallbackPolicy(input: {
  readonly mode: 'AUTOMATIC' | 'APPROVAL_REQUIRED';
  readonly permittedAlternateMethods: readonly string[];
  readonly maxExtraCostBasisPoints: bigint;
  readonly maxDelayMs: bigint;
  readonly recourseRequirements: readonly string[];
}): PaymentFallbackPolicy {
  if (input.mode !== 'AUTOMATIC' && input.mode !== 'APPROVAL_REQUIRED') {
    throw new Error('fallback mode must be AUTOMATIC or APPROVAL_REQUIRED');
  }
  if (!Array.isArray(input.permittedAlternateMethods)) {
    throw new Error('permittedAlternateMethods must be an array');
  }
  const methods = input.permittedAlternateMethods.map((method) => asPaymentMethodId(method));
  if (new Set(methods).size !== methods.length) {
    throw new Error('permitted alternate methods must not repeat');
  }
  if (typeof input.maxExtraCostBasisPoints !== 'bigint' || input.maxExtraCostBasisPoints < 0n) {
    throw new Error('fallback maxExtraCostBasisPoints must be a non-negative bigint');
  }
  if (typeof input.maxDelayMs !== 'bigint' || input.maxDelayMs < 0n) {
    throw new Error('fallback maxDelayMs must be a non-negative bigint');
  }
  if (
    !Array.isArray(input.recourseRequirements) ||
    input.recourseRequirements.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new Error('fallback recourseRequirements must be non-empty strings');
  }
  return Object.freeze({
    mode: input.mode,
    permittedAlternateMethods: Object.freeze(methods),
    maxExtraCostBasisPoints: input.maxExtraCostBasisPoints,
    maxDelayMs: input.maxDelayMs,
    recourseRequirements: Object.freeze([...input.recourseRequirements]),
  });
}

/**
 * Deterministic fallback decision: may the given alternate method be used
 * automatically? Only when the policy is AUTOMATIC, the method is
 * permitted, and the extra cost/delay stay within thresholds. Anything else
 * requires explicit approval — fallback is never silent and never
 * unbounded.
 */
export function evaluateFallback(
  policy: PaymentFallbackPolicy,
  input: {
    readonly alternateMethod: string;
    readonly extraCostBasisPoints: bigint;
    readonly extraDelayMs: bigint;
  },
): { readonly automatic: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (policy.mode !== 'AUTOMATIC') {
    reasons.push('FALLBACK_REQUIRES_APPROVAL');
  }
  const alternate = asPaymentMethodId(input.alternateMethod);
  if (!policy.permittedAlternateMethods.includes(alternate)) {
    reasons.push('ALTERNATE_METHOD_NOT_PERMITTED');
  }
  if (input.extraCostBasisPoints > policy.maxExtraCostBasisPoints) {
    reasons.push('EXTRA_COST_BEYOND_THRESHOLD');
  }
  if (input.extraDelayMs > policy.maxDelayMs) {
    reasons.push('EXTRA_DELAY_BEYOND_THRESHOLD');
  }
  return Object.freeze({ automatic: reasons.length === 0, reasons: Object.freeze(reasons) });
}
