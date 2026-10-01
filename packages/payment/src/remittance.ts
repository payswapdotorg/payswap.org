/**
 * @payswap/payment — remittance/document allocation (W1-003).
 *
 * PAYMENT-OPERATING-PLANE: `RemittanceAllocation` preserves business
 * meaning across payment translation — a payment links to the invoice,
 * order, project/milestone, contract, payroll batch, customer/account,
 * tax/fee, incentive or credit-repayment documents it settles.
 *
 * Determinism and exactness:
 * - allocation amounts are exact Money (INV-F01); no floating point;
 * - the sum of allocations MUST equal the payment amount exactly —
 *   over-allocation and under-allocation are both rejected (never silently
 *   padded or dusted);
 * - document links are preserved verbatim on the allocation record, so a
 *   translated payment (method → capability chain → settlement) can always
 *   answer "which business documents did this settle?".
 */

import type { CurrencyCode, Money } from '@payswap/protocol';
import { asPaymentMethodId, type PaymentMethodId } from './method.js';

declare const RemittanceAllocationIdBrand: unique symbol;

/** Branded id of one remittance allocation. */
export type RemittanceAllocationId = string & {
  readonly [RemittanceAllocationIdBrand]: 'RemittanceAllocationId';
};

/** The business documents a payment can be allocated against. */
export type RemittanceDocumentKind =
  | 'INVOICE'
  | 'ORDER'
  | 'PROJECT_MILESTONE'
  | 'CONTRACT'
  | 'PAYROLL_BATCH'
  | 'CUSTOMER_ACCOUNT'
  | 'TAX_FEE'
  | 'INCENTIVE'
  | 'CREDIT_REPAYMENT';

/** One document allocation: how much of the payment settles this document. */
export interface DocumentAllocation {
  readonly documentKind: RemittanceDocumentKind;
  readonly documentId: string;
  readonly allocatedAmount: Money;
}

/** The full remittance allocation for one payment. */
export interface RemittanceAllocation {
  readonly id: RemittanceAllocationId;
  readonly paymentRef: string;
  readonly method: PaymentMethodId;
  readonly paymentAmount: Money;
  readonly allocations: readonly DocumentAllocation[];
  /** Free-form remittance information the payer required (preserved verbatim). */
  readonly remittanceInfo?: string;
}

/** Validation failure for a remittance allocation. */
export class InvalidRemittanceAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRemittanceAllocationError';
  }
}

const DOCUMENT_KINDS: readonly RemittanceDocumentKind[] = [
  'INVOICE',
  'ORDER',
  'PROJECT_MILESTONE',
  'CONTRACT',
  'PAYROLL_BATCH',
  'CUSTOMER_ACCOUNT',
  'TAX_FEE',
  'INCENTIVE',
  'CREDIT_REPAYMENT',
];

/** Brand a validated string as a `RemittanceAllocationId`. */
export function asRemittanceAllocationId(value: string): RemittanceAllocationId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRemittanceAllocationError('RemittanceAllocationId must be a non-empty string');
  }
  if (value.length > 256) {
    throw new InvalidRemittanceAllocationError('RemittanceAllocationId exceeds 256 characters');
  }
  if (value.trim() !== value) {
    throw new InvalidRemittanceAllocationError(
      'RemittanceAllocationId must not carry surrounding whitespace',
    );
  }
  return value as RemittanceAllocationId;
}

/**
 * Construct a validated remittance allocation. The document allocations
 * must be non-empty, single-currency, non-duplicated per document, and sum
 * EXACTLY to the payment amount — partial or over allocation is an error,
 * never a silent adjustment.
 */
export function allocateRemittance(input: {
  readonly id: string;
  readonly paymentRef: string;
  readonly method: string;
  readonly paymentAmount: Money;
  readonly allocations: readonly DocumentAllocation[];
  readonly remittanceInfo?: string;
}): RemittanceAllocation {
  const id = asRemittanceAllocationId(input.id);
  if (typeof input.paymentRef !== 'string' || input.paymentRef.length === 0) {
    throw new InvalidRemittanceAllocationError('paymentRef must be a non-empty string');
  }
  if (
    input.paymentAmount === null ||
    typeof input.paymentAmount !== 'object' ||
    typeof input.paymentAmount.value !== 'bigint' ||
    typeof input.paymentAmount.currency !== 'string' ||
    input.paymentAmount.currency.length !== 3
  ) {
    throw new InvalidRemittanceAllocationError('paymentAmount must be exact Money');
  }
  if (input.paymentAmount.value <= 0n) {
    throw new InvalidRemittanceAllocationError('paymentAmount must be positive');
  }
  if (!Array.isArray(input.allocations) || input.allocations.length === 0) {
    throw new InvalidRemittanceAllocationError('at least one document allocation is required');
  }
  const seen = new Set<string>();
  let sum = 0n;
  for (const allocation of input.allocations) {
    if (
      allocation === null ||
      typeof allocation !== 'object' ||
      !DOCUMENT_KINDS.includes(allocation.documentKind) ||
      typeof allocation.documentId !== 'string' ||
      allocation.documentId.length === 0
    ) {
      throw new InvalidRemittanceAllocationError(
        'each allocation must carry a declared documentKind and non-empty documentId',
      );
    }
    const key = `${allocation.documentKind}:${allocation.documentId}`;
    if (seen.has(key)) {
      throw new InvalidRemittanceAllocationError(
        `a document may be allocated at most once per payment: ${key}`,
      );
    }
    seen.add(key);
    if (
      allocation.allocatedAmount === null ||
      typeof allocation.allocatedAmount !== 'object' ||
      typeof allocation.allocatedAmount.value !== 'bigint' ||
      allocation.allocatedAmount.currency !== input.paymentAmount.currency
    ) {
      throw new InvalidRemittanceAllocationError(
        `allocation for ${key} must be exact Money in ${input.paymentAmount.currency}`,
      );
    }
    if (allocation.allocatedAmount.value <= 0n) {
      throw new InvalidRemittanceAllocationError(`allocation for ${key} must be positive`);
    }
    sum += allocation.allocatedAmount.value;
  }
  if (sum !== input.paymentAmount.value) {
    throw new InvalidRemittanceAllocationError(
      'document allocations must sum exactly to the payment amount',
      );
  }
  if (
    input.remittanceInfo !== undefined &&
    (typeof input.remittanceInfo !== 'string' || input.remittanceInfo.length === 0)
  ) {
    throw new InvalidRemittanceAllocationError('remittanceInfo must be a non-empty string when present');
  }
  return Object.freeze({
    id,
    paymentRef: input.paymentRef,
    method: asPaymentMethodId(input.method),
    paymentAmount: input.paymentAmount,
    allocations: Object.freeze(
      input.allocations.map((allocation) => Object.freeze({ ...allocation })),
    ),
    ...(input.remittanceInfo !== undefined ? { remittanceInfo: input.remittanceInfo } : {}),
  });
}

/**
 * Deterministic lookup: which documents does this payment settle, and for
 * how much? Links are preserved verbatim across translation — this is the
 * answer a merchant's AR system consumes.
 */
export function documentsSettledBy(
  allocation: RemittanceAllocation,
): readonly DocumentAllocation[] {
  return Object.freeze(allocation.allocations.map((entry) => Object.freeze({ ...entry })));
}

/**
 * Deterministic single-document lookup: how much of the payment settled the
 * given document? Zero Money when the document is not part of the
 * allocation (explicit, not undefined — callers can sum safely).
 */
export function amountAllocatedTo(
  allocation: RemittanceAllocation,
  documentKind: RemittanceDocumentKind,
  documentId: string,
  currency: CurrencyCode,
): Money {
  const found = allocation.allocations.find(
    (entry) => entry.documentKind === documentKind && entry.documentId === documentId,
  );
  if (found !== undefined) {
    return found.allocatedAmount;
  }
  return Object.freeze({ currency, value: 0n }) as Money;
}
