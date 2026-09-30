import { describe, expect, it } from 'vitest';
import {
  DeterministicClock,
  GHS,
  TerminalStateViolationError,
  TransitionGuardError,
  USD,
  createIdFactory,
  fromMinorUnits,
  type Money,
} from '../src/index.js';
import {
  InMemoryObligationBook,
  UnknownObligationError,
  applyObligationEvent,
  asClearingRecordId,
  asFulfillmentActivityId,
  asObligationId,
  asPartyId,
  cancelObligation,
  defaultObligation,
  deriveObligations,
  settleObligation,
  type ClearingRecord,
  type FulfillmentActivity,
  type Obligation,
  type ObligationId,
} from '../src/obligation.js';

function usd(minorUnits: bigint): Money {
  return fromMinorUnits(USD, minorUnits);
}

function activity(
  id: string,
  debtor: string,
  creditor: string,
  amount: Money,
  occurredAt = 1_000n,
): FulfillmentActivity {
  return {
    id: asFulfillmentActivityId(id),
    activityType: 'PAYMENT_FULFILLED',
    debtor: asPartyId(debtor),
    creditor: asPartyId(creditor),
    amount,
    occurredAt,
  };
}

const DUE_WINDOW = { opensAt: 1_500n, closesAt: 5_000n } as const;

function oneObligation(): Obligation {
  const record: ClearingRecord = {
    id: asClearingRecordId('clr-1'),
    activities: [activity('act-1', 'alice', 'bob', usd(100n))],
    netted: false,
  };
  const obligations = deriveObligations([record], { dueWindow: DUE_WINDOW });
  const first = obligations[0];
  if (first === undefined) {
    throw new Error('test setup failed: expected one derived obligation');
  }
  return first;
}

function freshBook(): { book: InMemoryObligationBook; id: ObligationId } {
  const book = new InMemoryObligationBook();
  book.add(oneObligation());
  const id = book.all[0]?.id;
  if (id === undefined) {
    throw new Error('test setup failed: expected a stored obligation');
  }
  return { book, id };
}

describe('obligation: deterministic derivation from clearing records', () => {
  it('nets a debtor/creditor pair into one obligation and preserves gross (INV-F07)', () => {
    const record: ClearingRecord = {
      id: asClearingRecordId('clr-1'),
      activities: [
        activity('act-1', 'alice', 'bob', usd(100n)),
        activity('act-2', 'bob', 'alice', usd(30n)),
      ],
      netted: false,
    };
    const before = record.activities.map((a) => [a.id, a.amount.currency, a.amount.value.toString()]);
    const obligations = deriveObligations([record], { dueWindow: DUE_WINDOW });

    expect(obligations).toHaveLength(1);
    const obligation = obligations[0];
    expect(obligation?.debtor).toBe('alice');
    expect(obligation?.creditor).toBe('bob');
    expect(obligation?.amount.value).toBe(70n);
    expect(obligation?.state).toBe('PENDING');
    expect(obligation?.derivedFrom).toBe('clr-1');
    expect(obligation?.dueWindow.opensAt).toBe(1_500n);
    // The gross activities are untouched by the netting derivation.
    expect(
      record.activities.map((a) => [a.id, a.amount.currency, a.amount.value.toString()]),
    ).toEqual(before);
  });

  it('a fully-offset pair derives no obligation at all', () => {
    const record: ClearingRecord = {
      id: asClearingRecordId('clr-1'),
      activities: [
        activity('act-1', 'alice', 'bob', usd(100n)),
        activity('act-2', 'bob', 'alice', usd(100n)),
      ],
      netted: false,
    };
    expect(deriveObligations([record], { dueWindow: DUE_WINDOW })).toHaveLength(0);
  });

  it('nets per (pair, currency): a mixed-currency pair yields two obligations', () => {
    const record: ClearingRecord = {
      id: asClearingRecordId('clr-mix'),
      activities: [
        activity('act-1', 'alice', 'bob', usd(100n)),
        activity('act-2', 'alice', 'bob', fromMinorUnits(GHS, 250n)),
        activity('act-3', 'bob', 'alice', usd(40n)),
      ],
      netted: false,
    };
    const obligations = deriveObligations([record], { dueWindow: DUE_WINDOW });
    expect(obligations).toHaveLength(2);
    const usdObligation = obligations.find((o) => o.amount.currency === USD);
    const ghsObligation = obligations.find((o) => o.amount.currency === GHS);
    expect(usdObligation?.amount.value).toBe(60n);
    expect(ghsObligation?.amount.value).toBe(250n);
  });

  it('derives independent obligations per clearing record with deterministic order and ids', () => {
    const recordA: ClearingRecord = {
      id: asClearingRecordId('clr-a'),
      activities: [activity('act-1', 'alice', 'bob', usd(10n))],
      netted: false,
    };
    const recordB: ClearingRecord = {
      id: asClearingRecordId('clr-b'),
      activities: [
        activity('act-2', 'carol', 'alice', usd(20n)),
        activity('act-3', 'bob', 'carol', usd(5n)),
      ],
      netted: true,
    };
    const obligations = deriveObligations([recordA, recordB], { dueWindow: DUE_WINDOW });
    expect(obligations.map((o) => o.derivedFrom)).toEqual(['clr-a', 'clr-b', 'clr-b']);
    expect(obligations[0]?.id).toBe('OBL:clr-a:alice>bob:USD');
    expect(obligations[1]?.id).toBe('OBL:clr-b:alice>carol:USD');
    expect(obligations[2]?.id).toBe('OBL:clr-b:bob>carol:USD');
    // Deterministic replay: identical output.
    expect(deriveObligations([recordA, recordB], { dueWindow: DUE_WINDOW })).toEqual(obligations);
  });

  it('mints unique factory ids when an injected id factory is provided', () => {
    const clock = new DeterministicClock(1_000n);
    const ids = createIdFactory(clock);
    const record: ClearingRecord = {
      id: asClearingRecordId('clr-f'),
      activities: [activity('act-1', 'alice', 'bob', usd(10n))],
      netted: false,
    };
    const obligations = deriveObligations([record], { dueWindow: DUE_WINDOW, ids });
    const id = obligations[0]?.id ?? '';
    expect(id.startsWith('obl_')).toBe(true);
    expect(id).not.toBe('OBL:clr-f:alice>bob:USD');
  });
});

describe('obligation: derivation input validation', () => {
  const baseRecord: ClearingRecord = {
    id: asClearingRecordId('clr-1'),
    activities: [activity('act-1', 'alice', 'bob', usd(100n))],
    netted: false,
  };

  it('rejects self-referential activities (debtor === creditor)', () => {
    const record: ClearingRecord = {
      ...baseRecord,
      activities: [activity('act-1', 'alice', 'alice', usd(1n))],
    };
    expect(() => deriveObligations([record], { dueWindow: DUE_WINDOW })).toThrow(/same party/);
  });

  it('rejects non-positive activity amounts', () => {
    const record: ClearingRecord = {
      ...baseRecord,
      activities: [activity('act-1', 'alice', 'bob', usd(0n))],
    };
    expect(() => deriveObligations([record], { dueWindow: DUE_WINDOW })).toThrow(/positive/);
  });

  it('rejects duplicate clearing record ids and duplicate activity ids', () => {
    expect(() => deriveObligations([baseRecord, baseRecord], { dueWindow: DUE_WINDOW })).toThrow(
      /duplicate clearing record/,
    );
    const dupActivity: ClearingRecord = {
      id: asClearingRecordId('clr-2'),
      activities: [
        activity('act-1', 'alice', 'bob', usd(1n)),
        activity('act-1', 'bob', 'carol', usd(1n)),
      ],
      netted: false,
    };
    expect(() => deriveObligations([dupActivity], { dueWindow: DUE_WINDOW })).toThrow(
      /duplicate fulfillment activity/,
    );
  });

  it('rejects a due window that opens before the latest activity occurred', () => {
    expect(() =>
      deriveObligations([baseRecord], { dueWindow: { opensAt: 999n, closesAt: 5_000n } }),
    ).toThrow(/before the latest underlying activity/);
  });

  it('rejects a closed window and empty activity lists', () => {
    expect(() =>
      deriveObligations([baseRecord], { dueWindow: { opensAt: 5_000n, closesAt: 1_500n } }),
    ).toThrow(/closes before it opens/);
    const empty: ClearingRecord = {
      id: asClearingRecordId('clr-3'),
      activities: [],
      netted: false,
    };
    expect(() => deriveObligations([empty], { dueWindow: DUE_WINDOW })).toThrow(
      /at least one activity/,
    );
  });
});

describe('obligation: lifecycle state machine (explicit rules, INV-X04)', () => {
  it('settles inside the due window and stays terminal afterwards', () => {
    const { book, id } = freshBook();
    const clock = new DeterministicClock(1_500n);

    expect(settleObligation(book, id, clock).state).toBe('SETTLED');
    expect(() => settleObligation(book, id, clock)).toThrow(TerminalStateViolationError);
    expect(() => cancelObligation(book, id, clock)).toThrow(TerminalStateViolationError);
    expect(() => defaultObligation(book, id, clock)).toThrow(TerminalStateViolationError);
  });

  it('refuses settlement outside the window and default before the window closes', () => {
    const { book, id } = freshBook();

    const early = new DeterministicClock(1_400n); // before opensAt
    expect(() => settleObligation(book, id, early)).toThrow(TransitionGuardError);
    expect(() => defaultObligation(book, id, early)).toThrow(TransitionGuardError);

    const late = new DeterministicClock(5_001n); // after closesAt
    expect(() => settleObligation(book, id, late)).toThrow(TransitionGuardError);
    expect(defaultObligation(book, id, late).state).toBe('DEFAULTED');
  });

  it('cancels while pending at any time; window bounds are inclusive', () => {
    const { book, id } = freshBook();
    expect(cancelObligation(book, id, new DeterministicClock(0n)).state).toBe('CANCELLED');

    const second = freshBook();
    // closesAt itself is still inside the window.
    expect(settleObligation(second.book, second.id, new DeterministicClock(5_000n)).state).toBe(
      'SETTLED',
    );
  });

  it('applyObligationEvent throws for unknown ids', () => {
    const book = new InMemoryObligationBook();
    expect(() =>
      applyObligationEvent(
        book,
        asObligationId('obligation-missing'),
        'CANCEL',
        new DeterministicClock(0n),
      ),
    ).toThrow(UnknownObligationError);
  });
});
