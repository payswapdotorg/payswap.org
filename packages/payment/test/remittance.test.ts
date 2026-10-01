import { describe, expect, it } from 'vitest';
import { GHS, USD, fromMinorUnits } from '@payswap/protocol';
import {
  amountAllocatedTo,
  allocateRemittance,
  asRemittanceAllocationId,
  documentsSettledBy,
  type DocumentAllocation,
} from '../src/remittance.js';

function allocations(input: readonly [string, string, bigint][]): readonly DocumentAllocation[] {
  return input.map(([documentKind, documentId, value]) =>
    Object.freeze({
      documentKind: documentKind as DocumentAllocation['documentKind'],
      documentId,
      allocatedAmount: fromMinorUnits(GHS, value),
    }),
  );
}

describe('allocateRemittance', () => {
  it('preserves payment → invoice/order/project links verbatim', () => {
    const allocation = allocateRemittance({
      id: 'rem:1',
      paymentRef: 'pay:77',
      method: 'pm:mobile-money',
      paymentAmount: fromMinorUnits(GHS, 10_000n),
      allocations: allocations([
        ['INVOICE', 'inv:2026-001', 6_000n],
        ['ORDER', 'ord:88', 3_000n],
        ['PROJECT_MILESTONE', 'proj:acme:phase-2', 1_000n],
      ]),
      remittanceInfo: 'invoice 2026-001 balance settlement',
    });
    expect(allocation.paymentRef).toBe('pay:77');
    expect(allocation.id).toBe(asRemittanceAllocationId('rem:1'));
    expect(allocation.method).toBe('pm:mobile-money');
    expect(allocation.remittanceInfo).toBe('invoice 2026-001 balance settlement');
    expect(documentsSettledBy(allocation).length).toBe(3);
  });

  it('allocations must sum EXACTLY to the payment amount (no dust, no padding)', () => {
    expect(() =>
      allocateRemittance({
        id: 'rem:short',
        paymentRef: 'pay:1',
        method: 'pm:mobile-money',
        paymentAmount: fromMinorUnits(GHS, 10_000n),
        allocations: allocations([['INVOICE', 'inv:1', 9_999n]]),
      }),
    ).toThrow(/sum exactly/);
    expect(() =>
      allocateRemittance({
        id: 'rem:over',
        paymentRef: 'pay:1',
        method: 'pm:mobile-money',
        paymentAmount: fromMinorUnits(GHS, 10_000n),
        allocations: allocations([['INVOICE', 'inv:1', 10_001n]]),
      }),
    ).toThrow(/sum exactly/);
    // the exact split is accepted
    const exact = allocateRemittance({
      id: 'rem:exact',
      paymentRef: 'pay:1',
      method: 'pm:mobile-money',
      paymentAmount: fromMinorUnits(GHS, 10_000n),
      allocations: allocations([
        ['INVOICE', 'inv:1', 3_333n],
        ['INVOICE', 'inv:2', 3_333n],
        ['INVOICE', 'inv:3', 3_334n],
      ]),
    });
    expect(exact.allocations.length).toBe(3);
  });

  it('rejects mixed currencies, duplicate documents and undeclared kinds', () => {
    expect(() =>
      allocateRemittance({
        id: 'rem:currency',
        paymentRef: 'pay:1',
        method: 'pm:mobile-money',
        paymentAmount: fromMinorUnits(GHS, 100n),
        allocations: [
          {
            documentKind: 'INVOICE',
            documentId: 'inv:1',
            allocatedAmount: fromMinorUnits(USD, 100n),
          },
        ],
      }),
    ).toThrow(/exact Money in GHS/);
    expect(() =>
      allocateRemittance({
        id: 'rem:dup',
        paymentRef: 'pay:1',
        method: 'pm:mobile-money',
        paymentAmount: fromMinorUnits(GHS, 100n),
        allocations: allocations([
          ['INVOICE', 'inv:1', 50n],
          ['INVOICE', 'inv:1', 50n],
        ]),
      }),
    ).toThrow(/at most once/);
    expect(() =>
      allocateRemittance({
        id: 'rem:kind',
        paymentRef: 'pay:1',
        method: 'pm:mobile-money',
        paymentAmount: fromMinorUnits(GHS, 100n),
        allocations: allocations([['CARRIER_PIGEON_NOTE', 'x', 100n] as never]),
      }),
    ).toThrow(/documentKind/);
  });
});

describe('document lookups (links preserved across translation)', () => {
  const allocation = allocateRemittance({
    id: 'rem:1',
    paymentRef: 'pay:77',
    method: 'pm:mobile-money',
    paymentAmount: fromMinorUnits(GHS, 10_000n),
    allocations: allocations([
      ['INVOICE', 'inv:2026-001', 6_000n],
      ['ORDER', 'ord:88', 4_000n],
    ]),
  });

  it('answers how much settled a given document, explicitly zero otherwise', () => {
    expect(amountAllocatedTo(allocation, 'INVOICE', 'inv:2026-001', GHS).value).toBe(6_000n);
    expect(amountAllocatedTo(allocation, 'ORDER', 'ord:88', GHS).value).toBe(4_000n);
    const absent = amountAllocatedTo(allocation, 'INVOICE', 'inv:does-not-exist', GHS);
    expect(absent.value).toBe(0n);
    expect(absent.currency).toBe(GHS);
  });

  it('is deterministic: identical inputs yield identical records', () => {
    const build = () =>
      JSON.stringify(allocation, (key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
    expect(build()).toBe(build());
  });
});
