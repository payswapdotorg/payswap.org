import { describe, expect, expectTypeOf, it } from 'vitest';
import { GHS, fromMinorUnits } from '@payswap/protocol';
import {
  InvalidOffNetworkRecordError,
  advanceReconciliation,
  asOffNetworkPaymentRecordId,
  isPaySwapExecutedSettlement,
  recordOffNetworkPayment,
  type OffNetworkPaymentRecord,
  type PaySwapExecutedSettlement,
} from '../src/off-network.js';

function record(
  overrides?: Partial<Parameters<typeof recordOffNetworkPayment>[0]>,
): OffNetworkPaymentRecord {
  return recordOffNetworkPayment({
    id: 'off:1',
    source: 'CHECK',
    reporter: 'merchant:acme:staff-7',
    amount: fromMinorUnits(GHS, 25_000n),
    externalRef: 'check:000123',
    evidence: [
      { kind: 'check-image', reference: 'img:9f2c', recordedAt: 1_500n },
      { kind: 'deposit-slip', reference: 'slip:55', recordedAt: 1_600n },
    ],
    reconciliationState: 'UNRECONCILED',
    businessDocumentRefs: [
      { documentKind: 'INVOICE', documentId: 'inv:2026-001' },
      { documentKind: 'ORDER', documentId: 'ord:88' },
    ],
    recordedAt: 2_000n,
    ...overrides,
  });
}

describe('recordOffNetworkPayment', () => {
  it('records source, evidence, reconciliation state and business documents', () => {
    const entry = record();
    expect(entry.source).toBe('CHECK');
    expect(entry.evidence.length).toBe(2);
    expect(entry.reconciliationState).toBe('UNRECONCILED');
    expect(entry.businessDocumentRefs.map((doc) => doc.documentId)).toEqual([
      'inv:2026-001',
      'ord:88',
    ]);
  });

  it('validates source kinds, amounts, refs and states', () => {
    expect(() => record({ source: 'CARRIER_PIGEON' as never })).toThrow(/source kind/);
    expect(() => record({ externalRef: '' })).toThrow(/externalRef/);
    expect(() => record({ amount: fromMinorUnits(GHS, 0n) })).toThrow(/positive/);
    expect(() => record({ reporter: '' })).toThrow(/reporter/);
    expect(() => record({ reconciliationState: 'SETTLED' as never })).toThrow(/state/);
  });
});

describe('off-network records can NEVER be counted as PaySwap-executed settlements', () => {
  it('carries the EXTERNAL_PARTY attribution literal and no settlement instruction ref', () => {
    const entry = record();
    expect(entry.orchestratedBy).toBe('EXTERNAL_PARTY');
    expect('settlementInstructionRef' in entry).toBe(false);
    expect('executedBy' in entry).toBe(false);
  });

  it('is structurally unassignable to PaySwapExecutedSettlement (type-level proof)', () => {
    expectTypeOf<OffNetworkPaymentRecord>().not.toMatchTypeOf<PaySwapExecutedSettlement>();
    expectTypeOf<PaySwapExecutedSettlement>().not.toMatchTypeOf<OffNetworkPaymentRecord>();
    // A genuine PaySwap-executed settlement, for contrast:
    const executed: PaySwapExecutedSettlement = {
      executedBy: 'PAYSWAP_PROTOCOL',
      settlementInstructionRef: 'SI:ns-1:alice>bob:USD',
      amount: fromMinorUnits(GHS, 25_000n),
    };
    expect(executed.executedBy).toBe('PAYSWAP_PROTOCOL');
    // Off-network records are not interchangeable with it at the type level.
    expectTypeOf(record()).not.toMatchTypeOf<PaySwapExecutedSettlement>();
  });

  it('the type guard is honest: off-network records never qualify', () => {
    const entry = record();
    const candidate: OffNetworkPaymentRecord | PaySwapExecutedSettlement = entry;
    expect(isPaySwapExecutedSettlement(candidate)).toBe(false);
    const executed: OffNetworkPaymentRecord | PaySwapExecutedSettlement = {
      executedBy: 'PAYSWAP_PROTOCOL',
      settlementInstructionRef: 'SI:ns-1:alice>bob:USD',
      amount: fromMinorUnits(GHS, 25_000n),
    };
    expect(isPaySwapExecutedSettlement(executed)).toBe(true);
    // aggregation: counting only PaySwap-executed settlements excludes off-network records
    const everything: readonly (OffNetworkPaymentRecord | PaySwapExecutedSettlement)[] = [
      entry,
      executed,
    ];
    expect(everything.filter(isPaySwapExecutedSettlement).length).toBe(1);
  });

  it('the record cannot be constructed claiming PaySwap execution', () => {
    const entry = record();
    // even mutating the frozen record cannot smuggle the protocol attribution
    expect(() => {
      (entry as { orchestratedBy?: string }).orchestratedBy = 'PAYSWAP_PROTOCOL';
    }).toThrow();
    expect(entry.orchestratedBy).toBe('EXTERNAL_PARTY');
  });
});

describe('advanceReconciliation', () => {
  it('walks UNRECONCILED → RECONCILING → RECONCILED and stops there', () => {
    let entry = record();
    entry = advanceReconciliation(entry, 'RECONCILING');
    expect(entry.reconciliationState).toBe('RECONCILING');
    entry = advanceReconciliation(entry, 'RECONCILED');
    expect(entry.reconciliationState).toBe('RECONCILED');
    expect(() => advanceReconciliation(entry, 'RECONCILING')).toThrow(
      InvalidOffNetworkRecordError,
    );
  });

  it('flags discrepancies and can re-open them for re-reconciliation', () => {
    let entry = advanceReconciliation(record(), 'DISCREPANT');
    expect(entry.reconciliationState).toBe('DISCREPANT');
    entry = advanceReconciliation(entry, 'RECONCILING');
    expect(entry.reconciliationState).toBe('RECONCILING');
    expect(() => advanceReconciliation(record(), 'RECONCILED')).toThrow(/cannot advance/);
  });

  it('preserves identity and evidence across reconciliation transitions', () => {
    const original = record();
    const advanced = advanceReconciliation(original, 'RECONCILING');
    expect(advanced.id).toBe(asOffNetworkPaymentRecordId('off:1'));
    expect(advanced.evidence.length).toBe(original.evidence.length);
    expect(advanced.businessDocumentRefs).toEqual(original.businessDocumentRefs);
  });
});
