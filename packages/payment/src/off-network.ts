/**
 * @payswap/payment — OffNetworkPaymentRecord (W1-003).
 *
 * PAYMENT-OPERATING-PLANE: `OffNetworkPaymentRecord` records a check, cash
 * payment, direct external bank payment or other movement NOT orchestrated
 * by PaySwap. It carries source, reporter, amount/currency, external
 * reference, evidence, business references and reconciliation state.
 *
 * It NEVER implies PaySwap execution — structurally:
 *
 * - `orchestratedBy` is the literal `'EXTERNAL_PARTY'` (a PaySwap-executed
 *   settlement is branded `PaySwapExecutedSettlement` with
 *   `executedBy: 'PAYSWAP_PROTOCOL'` and a protocol SettlementInstruction
 *   reference — the two types are mutually unassignable);
 * - there is no settlement-instruction field that could link the movement
 *   to protocol settlement execution;
 * - `isPaySwapExecutedSettlement` is a type guard that can only ever
 *   return `false` for off-network records, so aggregation code can never
 *   count them as PaySwap-executed settlements.
 */

import type { Money, TimestampMs } from '@payswap/protocol';

declare const OffNetworkPaymentRecordIdBrand: unique symbol;

/** Branded id of one off-network payment record. */
export type OffNetworkPaymentRecordId = string & {
  readonly [OffNetworkPaymentRecordIdBrand]: 'OffNetworkPaymentRecordId';
};

/** What kind of external movement this record documents. */
export type OffNetworkSourceKind =
  | 'CHECK'
  | 'CASH'
  | 'EXTERNAL_BANK_TRANSFER'
  | 'OTHER_EXTERNAL';

/** Reconciliation state of the record against its external evidence. */
export type OffNetworkReconciliationState =
  | 'UNRECONCILED'
  | 'RECONCILING'
  | 'RECONCILED'
  | 'DISCREPANT';

/** A reference to supporting evidence (image, statement line, attestation). */
export interface OffNetworkEvidenceRef {
  readonly kind: string;
  readonly reference: string;
  readonly recordedAt: TimestampMs;
}

/** A link to a business document (invoice, order, project…). */
export interface OffNetworkBusinessDocumentRef {
  readonly documentKind: string;
  readonly documentId: string;
}

/**
 * ATTRIBUTION MARKER for movements the PaySwap protocol itself executed.
 * A record qualifies only when the protocol issued a settlement
 * instruction and the movement was orchestrated by PaySwap. This interface
 * is intentionally UNREPRESENTABLE by OffNetworkPaymentRecord.
 */
export interface PaySwapExecutedSettlement {
  readonly executedBy: 'PAYSWAP_PROTOCOL';
  /** The protocol settlement instruction that drove the movement. */
  readonly settlementInstructionRef: string;
  readonly amount: Money;
}

/**
 * A payment that happened OUTSIDE PaySwap orchestration. The literal
 * `orchestratedBy: 'EXTERNAL_PARTY'` and the absence of any settlement
 * instruction reference make it structurally impossible to present this
 * record as a PaySwap-executed settlement.
 */
export interface OffNetworkPaymentRecord {
  readonly id: OffNetworkPaymentRecordId;
  readonly source: OffNetworkSourceKind;
  /** Who reported the record (e.g. merchant staff, payer, reconciler). */
  readonly reporter: string;
  readonly amount: Money;
  /** External reference (check number, statement line id…). */
  readonly externalRef: string;
  readonly evidence: readonly OffNetworkEvidenceRef[];
  readonly reconciliationState: OffNetworkReconciliationState;
  readonly businessDocumentRefs: readonly OffNetworkBusinessDocumentRef[];
  readonly recordedAt: TimestampMs;
  /** Attribution literal — always EXTERNAL_PARTY; never PaySwap. */
  readonly orchestratedBy: 'EXTERNAL_PARTY';
}

/** Validation failure for an off-network record. */
export class InvalidOffNetworkRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOffNetworkRecordError';
  }
}

/** Brand a validated string as an `OffNetworkPaymentRecordId`. */
export function asOffNetworkPaymentRecordId(value: string): OffNetworkPaymentRecordId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidOffNetworkRecordError('OffNetworkPaymentRecordId must be a non-empty string');
  }
  if (value.length > 256) {
    throw new InvalidOffNetworkRecordError('OffNetworkPaymentRecordId exceeds 256 characters');
  }
  if (value.trim() !== value) {
    throw new InvalidOffNetworkRecordError(
      'OffNetworkPaymentRecordId must not carry surrounding whitespace',
    );
  }
  return value as OffNetworkPaymentRecordId;
}

/**
 * Construct a validated, frozen off-network record. The attribution literal
 * `orchestratedBy: 'EXTERNAL_PARTY'` is set by the constructor — a caller
 * cannot construct an off-network record that claims PaySwap execution.
 */
export function recordOffNetworkPayment(input: {
  readonly id: string;
  readonly source: OffNetworkSourceKind;
  readonly reporter: string;
  readonly amount: Money;
  readonly externalRef: string;
  readonly evidence: readonly OffNetworkEvidenceRef[];
  readonly reconciliationState: OffNetworkReconciliationState;
  readonly businessDocumentRefs: readonly OffNetworkBusinessDocumentRef[];
  readonly recordedAt: TimestampMs;
}): OffNetworkPaymentRecord {
  const id = asOffNetworkPaymentRecordId(input.id);
  const SOURCES: readonly OffNetworkSourceKind[] = [
    'CHECK',
    'CASH',
    'EXTERNAL_BANK_TRANSFER',
    'OTHER_EXTERNAL',
  ];
  if (!SOURCES.includes(input.source)) {
    throw new InvalidOffNetworkRecordError(
      `off-network source kind is not declared: ${String(input.source)}`,
    );
  }
  if (typeof input.reporter !== 'string' || input.reporter.length === 0) {
    throw new InvalidOffNetworkRecordError('off-network reporter must be a non-empty string');
  }
  if (
    input.amount === null ||
    typeof input.amount !== 'object' ||
    typeof input.amount.value !== 'bigint' ||
    typeof input.amount.currency !== 'string' ||
    input.amount.currency.length !== 3
  ) {
    throw new InvalidOffNetworkRecordError('off-network amount must be exact Money');
  }
  if (input.amount.value <= 0n) {
    throw new InvalidOffNetworkRecordError('an off-network payment amount must be positive');
  }
  if (typeof input.externalRef !== 'string' || input.externalRef.length === 0) {
    throw new InvalidOffNetworkRecordError('off-network externalRef must be a non-empty string');
  }
  const STATES: readonly OffNetworkReconciliationState[] = [
    'UNRECONCILED',
    'RECONCILING',
    'RECONCILED',
    'DISCREPANT',
  ];
  if (!STATES.includes(input.reconciliationState)) {
    throw new InvalidOffNetworkRecordError(
      `reconciliation state is not declared: ${String(input.reconciliationState)}`,
    );
  }
  if (typeof input.recordedAt !== 'bigint') {
    throw new InvalidOffNetworkRecordError('recordedAt must be a bigint TimestampMs');
  }
  if (!Array.isArray(input.evidence)) {
    throw new InvalidOffNetworkRecordError('evidence must be an array of OffNetworkEvidenceRef');
  }
  for (const entry of input.evidence) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.kind !== 'string' ||
      entry.kind.length === 0 ||
      typeof entry.reference !== 'string' ||
      entry.reference.length === 0 ||
      typeof entry.recordedAt !== 'bigint'
    ) {
      throw new InvalidOffNetworkRecordError('each evidence entry must carry kind, reference, recordedAt');
    }
  }
  if (!Array.isArray(input.businessDocumentRefs)) {
    throw new InvalidOffNetworkRecordError(
      'businessDocumentRefs must be an array of OffNetworkBusinessDocumentRef',
    );
  }
  for (const entry of input.businessDocumentRefs) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.documentKind !== 'string' ||
      entry.documentKind.length === 0 ||
      typeof entry.documentId !== 'string' ||
      entry.documentId.length === 0
    ) {
      throw new InvalidOffNetworkRecordError(
        'each business document reference must carry documentKind and documentId',
      );
    }
  }
  return Object.freeze({
    id,
    source: input.source,
    reporter: input.reporter,
    amount: input.amount,
    externalRef: input.externalRef,
    evidence: Object.freeze([...input.evidence]),
    reconciliationState: input.reconciliationState,
    businessDocumentRefs: Object.freeze([...input.businessDocumentRefs]),
    recordedAt: input.recordedAt,
    orchestratedBy: 'EXTERNAL_PARTY',
  });
}

/**
 * Type guard proving an off-network record is NOT a PaySwap-executed
 * settlement. Always `false` for every OffNetworkPaymentRecord — the guard
 * exists so settlement-counting aggregation code has an explicit, honest
 * predicate instead of an implicit cast.
 */
export function isPaySwapExecutedSettlement(
  candidate: OffNetworkPaymentRecord | PaySwapExecutedSettlement,
): candidate is PaySwapExecutedSettlement {
  return (
    (candidate as PaySwapExecutedSettlement).executedBy === 'PAYSWAP_PROTOCOL' &&
    typeof (candidate as PaySwapExecutedSettlement).settlementInstructionRef === 'string'
  );
}

/**
 * Advance the reconciliation state of an off-network record
 * (UNRECONCILED → RECONCILING → RECONCILED, or → DISCREPANT when the
 * evidence disagrees). DISCREPANT and RECONCILED are terminal for the
 * record's current version — a re-reconciliation creates a new record
 * version rather than rewriting history (INV-E05-adjacent).
 */
export function advanceReconciliation(
  record: OffNetworkPaymentRecord,
  next: OffNetworkReconciliationState,
): OffNetworkPaymentRecord {
  const ALLOWED: Readonly<Record<OffNetworkReconciliationState, readonly OffNetworkReconciliationState[]>> = {
    UNRECONCILED: ['RECONCILING', 'DISCREPANT'],
    RECONCILING: ['RECONCILED', 'DISCREPANT'],
    RECONCILED: [],
    DISCREPANT: ['RECONCILING'],
  };
  const allowed = ALLOWED[record.reconciliationState];
  if (allowed === undefined || !allowed.includes(next)) {
    throw new InvalidOffNetworkRecordError(
      `reconciliation cannot advance from ${String(record.reconciliationState)} to ${String(next)}`,
    );
  }
  return Object.freeze({ ...record, reconciliationState: next });
}
