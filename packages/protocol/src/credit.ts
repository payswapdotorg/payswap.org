/**
 * @payswap/protocol — explicit credit lines and exposure (W1-003).
 *
 * FROZEN-ARCHITECTURE §9: "If a third party fronts value, create explicit
 * CreditExposure. Delay is not hidden credit."
 *
 * INV-F08: credit is explicit; no hidden temporary borrowing. This module
 * makes that structural:
 * - utilization of a `CreditLine` can ONLY move through
 *   `frontValueForDelay` (draw, returns a `CreditExposure`) and
 *   `repayCredit` (repayment, returns an explicit `CreditRepayment`);
 * - every draw returns a fresh, self-describing `CreditExposure` carrying
 *   the exact derivation (utilization before, amount drawn, the obligation
 *   being backed) and the collateral securing it;
 * - there is no code path that increases third-party value in flight
 *   without producing an exposure record.
 *
 * All arithmetic is exact bigint money (INV-F01); all time comes from the
 * injected clock; nothing here executes rails or mints balances.
 */

import { add, compare, isPositive, sub, type CurrencyCode, type Money } from './money.js';
import { PaySwapError, ValidationError, type PaySwapErrorDetails } from './errors.js';
import { InvalidIdentifierError } from './identifiers.js';
import type { IdFactory } from './identifiers.js';
import type { ProtocolClock, TimestampMs } from './clock.js';
import type { Obligation, ObligationId, PartyId } from './obligation.js';
import type { CollateralRecord } from './collateral.js';

declare const CreditLineIdBrand: unique symbol;

/** Branded id of one credit line. */
export type CreditLineId = string & { readonly [CreditLineIdBrand]: 'CreditLineId' };

declare const CreditExposureIdBrand: unique symbol;

/** Branded id of one credit exposure. */
export type CreditExposureId = string & { readonly [CreditExposureIdBrand]: 'CreditExposureId' };

declare const CreditRepaymentIdBrand: unique symbol;

/** Branded id of one credit repayment. */
export type CreditRepaymentId = string & { readonly [CreditRepaymentIdBrand]: 'CreditRepaymentId' };

/**
 * An explicit, bounded credit facility: `creditor` extends `debtor` up to
 * `limit` of `currency`. `utilized` moves ONLY via
 * `frontValueForDelay`/`repayCredit` (INV-F08) — there is no silent path.
 */
export interface CreditLine {
  readonly id: CreditLineId;
  /** The party extending the credit (the third party fronting value). */
  readonly creditor: PartyId;
  /** The party drawing the credit. */
  readonly debtor: PartyId;
  readonly limit: Money;
  readonly utilized: Money;
  readonly currency: CurrencyCode;
  /** The line is unusable strictly after this instant. */
  readonly expiry: TimestampMs;
  /** Collateral securing the line (may be empty for unsecured lines). */
  readonly collateral: readonly CollateralRecord[];
}

/** The exact derivation of one credit exposure (why value was fronted). */
export interface CreditExposureDerivation {
  /** Utilization before the draw (exact). */
  readonly utilizationBefore: Money;
  /** The amount fronted (exact). */
  readonly amountDrawn: Money;
  /** Why the draw happened, e.g. `DELAYED_SETTLEMENT_BACKING`. */
  readonly reason: string;
  /** The obligation whose delay is being backed, when applicable. */
  readonly backingObligation?: ObligationId;
}

/**
 * INV-F08 record: one explicit use of third-party value. Every draw creates
 * exactly one exposure; exposures are never implicit and never hidden.
 */
export interface CreditExposure {
  readonly id: CreditExposureId;
  readonly lineId: CreditLineId;
  readonly creditor: PartyId;
  readonly debtor: PartyId;
  /** Total outstanding on the line after this draw. */
  readonly outstanding: Money;
  /** The collateral securing the line, restated on the exposure. */
  readonly collateral: readonly CollateralRecord[];
  readonly createdAt: TimestampMs;
  readonly derivation: CreditExposureDerivation;
}

/** An explicit repayment reducing line utilization. */
export interface CreditRepayment {
  readonly id: CreditRepaymentId;
  readonly lineId: CreditLineId;
  readonly amount: Money;
  readonly utilizedAfter: Money;
  readonly repaidAt: TimestampMs;
  /** What the repayment settles against, when applicable. */
  readonly settlementRef?: string;
}

/** A draw would exceed the line limit. */
export class CreditLimitExceededError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'CREDIT_LIMIT_EXCEEDED', category: 'CONFLICT', message, details });
  }
}

/** The credit line is expired (or not yet usable) at the evaluation time. */
export class CreditLineExpiredError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'CREDIT_LINE_EXPIRED', category: 'CONFLICT', message, details });
  }
}

/** Repayment exceeds current utilization. */
export class CreditRepaymentExceedsUtilizationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'CREDIT_REPAYMENT_EXCEEDS_UTILIZATION', category: 'CONFLICT', message, details });
  }
}

/** Brand a validated string as a `CreditLineId`. */
export function asCreditLineId(value: string): CreditLineId {
  return brandSimpleId(value, 'CreditLineId');
}

/** Brand a validated string as a `CreditExposureId`. */
export function asCreditExposureId(value: string): CreditExposureId {
  return brandSimpleId(value, 'CreditExposureId');
}

/** Brand a validated string as a `CreditRepaymentId`. */
export function asCreditRepaymentId(value: string): CreditRepaymentId {
  return brandSimpleId(value, 'CreditRepaymentId');
}

function brandSimpleId<TBranded extends string>(value: string, kind: string): TBranded {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError(`${kind} must be a non-empty string`, { kind, value });
  }
  if (value.length > 256) {
    throw new InvalidIdentifierError(`${kind} exceeds 256 characters`, { kind, value });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError(`${kind} must not carry surrounding whitespace`, {
      kind,
      value,
    });
  }
  return value as TBranded;
}

function freezeLine(line: CreditLine): CreditLine {
  return Object.freeze({
    id: line.id,
    creditor: line.creditor,
    debtor: line.debtor,
    limit: line.limit,
    utilized: line.utilized,
    currency: line.currency,
    expiry: line.expiry,
    collateral: Object.freeze([...line.collateral]),
  });
}

/**
 * Open an explicit credit line. `limit` must be positive, `utilized` starts
 * at zero (an opening utilization would be an unrecorded exposure —
 * INV-F08 forbids it), creditor ≠ debtor, and the line must not be already
 * expired at `clock.now()`.
 */
export function openCreditLine(
  input: {
    readonly id: string;
    readonly creditor: PartyId;
    readonly debtor: PartyId;
    readonly limit: Money;
    readonly currency: CurrencyCode;
    readonly expiry: TimestampMs;
    readonly collateral?: readonly CollateralRecord[];
  },
  clock: ProtocolClock,
): CreditLine {
  const id = asCreditLineId(input.id);
  if (typeof input.creditor !== 'string' || input.creditor.length === 0) {
    throw new ValidationError('creditor must be a PartyId', { id });
  }
  if (typeof input.debtor !== 'string' || input.debtor.length === 0) {
    throw new ValidationError('debtor must be a PartyId', { id });
  }
  if (input.creditor === input.debtor) {
    throw new ValidationError('a credit line cannot creditor and debtor the same party', { id });
  }
  if (input.limit === null || typeof input.limit !== 'object') {
    throw new ValidationError('limit must be a Money object', { id });
  }
  if (typeof input.limit.value !== 'bigint') {
    throw new ValidationError('limit.value must be a bigint (INV-F01)', { id });
  }
  if (!isPositive(input.limit)) {
    throw new ValidationError('credit line limit must be positive', { id });
  }
  if (input.limit.currency !== input.currency) {
    throw new ValidationError('credit line limit currency must match the line currency', { id });
  }
  if (typeof input.expiry !== 'bigint') {
    throw new ValidationError('expiry must be a bigint TimestampMs', { id });
  }
  if (input.expiry <= clock.now()) {
    throw new CreditLineExpiredError('credit line expiry must lie in the future', {
      id,
      expiry: input.expiry.toString(),
      now: clock.now().toString(),
    });
  }
  return freezeLine({
    id,
    creditor: input.creditor,
    debtor: input.debtor,
    limit: input.limit,
    utilized: { currency: input.currency, value: 0n } as Money,
    currency: input.currency,
    expiry: input.expiry,
    collateral: input.collateral === undefined ? [] : Object.freeze([...input.collateral]),
  });
}

/**
 * INV-F08: front third-party value to back a DELAYED settlement.
 *
 * The obligation must be PENDING and owned by the line's debtor (the debtor
 * of the obligation is the party whose settlement is delayed); the draw
 * must fit within limit − utilized; the line must not be expired at
 * `clock.now()`. On success this returns BOTH the updated line (utilized
 * increased by exactly `amount`) AND a fresh explicit `CreditExposure`
 * describing the draw. There is no variant of this operation that returns
 * value without the exposure — delay is never hidden credit.
 */
export function frontValueForDelay(
  line: CreditLine,
  obligation: Obligation,
  amount: Money,
  clock: ProtocolClock,
  ids: IdFactory,
): { readonly line: CreditLine; readonly exposure: CreditExposure } {
  if (line === null || typeof line !== 'object') {
    throw new ValidationError('line must be a CreditLine');
  }
  if (obligation === null || typeof obligation !== 'object') {
    throw new ValidationError('obligation must be an Obligation');
  }
  if (amount === null || typeof amount !== 'object') {
    throw new ValidationError('amount must be a Money object');
  }
  if (typeof amount.value !== 'bigint') {
    throw new ValidationError('amount.value must be a bigint (INV-F01)');
  }
  if (!isPositive(amount)) {
    throw new ValidationError('a credit draw must be a positive amount');
  }
  if (amount.currency !== line.currency) {
    throw new ValidationError('draw currency must match the credit line currency', {
      lineId: line.id,
      lineCurrency: line.currency,
      drawCurrency: amount.currency,
    });
  }
  if (obligation.state !== 'PENDING') {
    throw new ValidationError('only a PENDING obligation can be backed by fronted value', {
      obligationId: obligation.id,
      state: obligation.state,
    });
  }
  if (obligation.debtor !== line.debtor) {
    throw new ValidationError(
      'the credit line debtor must be the obligation debtor whose delay is being backed',
      { lineId: line.id, obligationId: obligation.id, lineDebtor: line.debtor, obligationDebtor: obligation.debtor },
    );
  }
  const now = clock.now();
  if (now >= line.expiry) {
    throw new CreditLineExpiredError('credit line is expired at draw time', {
      lineId: line.id,
      expiry: line.expiry.toString(),
      now: now.toString(),
    });
  }
  const utilizationBefore = line.utilized;
  const projectedUtilized = add(utilizationBefore, amount);
  if (compare(projectedUtilized, line.limit) > 0) {
    throw new CreditLimitExceededError('credit draw exceeds the line limit', {
      lineId: line.id,
      limit: line.limit.value.toString(),
      utilized: utilizationBefore.value.toString(),
      requested: amount.value.toString(),
    });
  }
  const updated = freezeLine({ ...line, utilized: projectedUtilized });
  const exposure: CreditExposure = Object.freeze({
    id: asCreditExposureId(ids.mintId('cex')),
    lineId: line.id,
    creditor: line.creditor,
    debtor: line.debtor,
    outstanding: projectedUtilized,
    collateral: Object.freeze([...line.collateral]),
    createdAt: now,
    derivation: Object.freeze({
      utilizationBefore,
      amountDrawn: amount,
      reason: 'DELAYED_SETTLEMENT_BACKING',
      backingObligation: obligation.id,
    }),
  });
  return Object.freeze({ line: updated, exposure });
}

/**
 * Explicit repayment: reduces utilization by exactly `amount` and returns a
 * `CreditRepayment` record. Over-repayment is rejected — credit never goes
 * negative. Repayment is never silent either.
 */
export function repayCredit(
  line: CreditLine,
  amount: Money,
  clock: ProtocolClock,
  ids: IdFactory,
  settlementRef?: string,
): { readonly line: CreditLine; readonly repayment: CreditRepayment } {
  if (line === null || typeof line !== 'object') {
    throw new ValidationError('line must be a CreditLine');
  }
  if (amount === null || typeof amount !== 'object') {
    throw new ValidationError('amount must be a Money object');
  }
  if (typeof amount.value !== 'bigint') {
    throw new ValidationError('amount.value must be a bigint (INV-F01)');
  }
  if (!isPositive(amount)) {
    throw new ValidationError('a credit repayment must be a positive amount');
  }
  if (amount.currency !== line.currency) {
    throw new ValidationError('repayment currency must match the credit line currency', {
      lineId: line.id,
    });
  }
  if (compare(amount, line.utilized) > 0) {
    throw new CreditRepaymentExceedsUtilizationError(
      'repayment exceeds current utilization',
      {
        lineId: line.id,
        utilized: line.utilized.value.toString(),
        requested: amount.value.toString(),
      },
    );
  }
  const utilizedAfter = sub(line.utilized, amount);
  const updated = freezeLine({ ...line, utilized: utilizedAfter });
  const now = clock.now();
  const repayment: CreditRepayment = Object.freeze({
    id: asCreditRepaymentId(ids.mintId('crp')),
    lineId: line.id,
    amount,
    utilizedAfter,
    repaidAt: now,
    ...(settlementRef !== undefined ? { settlementRef } : {}),
  });
  return Object.freeze({ line: updated, repayment });
}

/**
 * The explicit exposure VIEW of a line at a point in time: outstanding
 * utilization plus the securing collateral. Read-only projection — it can
 * never replace the per-draw `CreditExposure` records (INV-F08 requires a
 * record per use of third-party value, not merely a running total).
 */
export function creditExposureView(
  line: CreditLine,
  clock: ProtocolClock,
): { readonly line: CreditLine; readonly outstanding: Money; readonly collateral: readonly CollateralRecord[]; readonly asOf: TimestampMs } {
  return Object.freeze({
    line,
    outstanding: line.utilized,
    collateral: Object.freeze([...line.collateral]),
    asOf: clock.now(),
  });
}
