import { describe, expect, it } from 'vitest';
import {
  AggregateMismatchError,
  add,
  asAggregateId,
  createIdFactory,
  createEventEnvelope,
  currencyCode,
  DeterministicClock,
  EventSourcedAggregate,
  EventVersionConflictError,
  fromMinorUnits,
  requiresReconciliation,
  TerminalState,
  USD,
  ValidationError,
  zero,
  type AggregateId,
  type DomainEventEnvelope,
  type IdFactory,
  type Money,
  type ProtocolClock,
  type TerminalStateRequiringReconciliation,
} from '../src/index.js';

interface CreditPayload {
  readonly currency: string;
  readonly minorUnits: string;
}

/** Concrete test aggregate: an append-only ledger line. */
class LedgerLine extends EventSourcedAggregate {
  state: 'EMPTY' | 'CREDITED' = 'EMPTY';
  total: Money = zero(USD);

  constructor(id: AggregateId, ids: IdFactory, clock: ProtocolClock) {
    super({ aggregateType: 'ledger.line', id, ids, clock });
  }

  protected override evolve(event: DomainEventEnvelope<unknown>): void {
    if (event.eventType === 'ledger.credited') {
      const payload = event.payload as CreditPayload;
      this.state = 'CREDITED';
      this.total = add(
        this.total,
        fromMinorUnits(currencyCode(payload.currency), BigInt(payload.minorUnits)),
      );
    }
  }

  credit(amount: Money, correlationId?: string): DomainEventEnvelope<unknown> {
    return this.raise(
      'ledger.credited',
      { currency: amount.currency, minorUnits: amount.value.toString() } satisfies CreditPayload,
      correlationId === undefined ? undefined : { correlationId },
    );
  }
}

function freshLedger(seed = 1n): { ledger: LedgerLine; clock: DeterministicClock } {
  const clock = new DeterministicClock(seed);
  return { ledger: new LedgerLine(asAggregateId('agg-ledger-1'), createIdFactory(clock), clock), clock };
}

describe('rehydrate determinism', () => {
  it('the same history folds to the same state and version on a fresh instance', () => {
    const a = freshLedger();
    a.ledger.credit(fromMinorUnits(USD, 100n));
    a.ledger.credit(fromMinorUnits(USD, 233n));
    const history = a.ledger.pendingEvents;
    expect(history).toHaveLength(2);

    const b = freshLedger();
    b.ledger.rehydrate(history);
    expect(b.ledger.version).toBe(a.ledger.version);
    expect(b.ledger.total.value).toBe(333n);
    expect(b.ledger.state).toBe('CREDITED');
    // rehydrated events are already committed: never pending
    expect(b.ledger.pendingEvents).toHaveLength(0);
  });

  it('identical seeds produce byte-identical event ids (deterministic authority)', () => {
    const a = freshLedger();
    const b = freshLedger();
    a.ledger.credit(fromMinorUnits(USD, 1n));
    b.ledger.credit(fromMinorUnits(USD, 1n));
    const idA = a.ledger.pendingEvents[0]?.id;
    const idB = b.ledger.pendingEvents[0]?.id;
    expect(idA).toBe(idB);
  });

  it('empty history rehydrates to version 0 with pristine state', () => {
    const { ledger } = freshLedger();
    ledger.rehydrate([]);
    expect(ledger.version).toBe(0n);
    expect(ledger.state).toBe('EMPTY');
  });

  it('rehydrate supports continuation from an already-folded prefix', () => {
    const source = freshLedger();
    source.ledger.credit(fromMinorUnits(USD, 5n));
    source.ledger.credit(fromMinorUnits(USD, 6n));
    const history = source.ledger.pendingEvents;

    const target = freshLedger();
    target.ledger.rehydrate(history.slice(0, 1));
    expect(target.ledger.version).toBe(1n);
    target.ledger.rehydrate(history.slice(1));
    expect(target.ledger.version).toBe(2n);
    expect(target.ledger.total.value).toBe(11n);
  });
});

describe('optimistic concurrency (apply / version checks)', () => {
  it('raise assigns consecutive 1-based versions', () => {
    const { ledger } = freshLedger();
    expect(ledger.version).toBe(0n);
    ledger.credit(fromMinorUnits(USD, 1n));
    ledger.credit(fromMinorUnits(USD, 2n));
    const versions = ledger.pendingEvents.map((event) => event.aggregate.version);
    expect(versions).toEqual([1n, 2n]);
    expect(ledger.version).toBe(2n);
  });

  it('apply rejects an event whose version is not exactly next', () => {
    const { ledger } = freshLedger();
    const clock = new DeterministicClock(9n);
    const wrongVersion = createEventEnvelope(
      {
        eventType: 'ledger.credited',
        payload: { currency: 'USD', minorUnits: '1' },
        aggregate: { id: ledger.id, version: 99n },
        schemaVersion: 1,
      },
      { ids: createIdFactory(clock), clock },
    );
    expect(() => ledger.apply(wrongVersion)).toThrow(EventVersionConflictError);
    try {
      ledger.apply(wrongVersion);
      expect.unreachable('must throw');
    } catch (error) {
      expect((error as EventVersionConflictError).details?.expected).toBe('1');
      expect((error as EventVersionConflictError).details?.actual).toBe('99');
    }
  });

  it('rehydrate rejects gaps and repeats in history', () => {
    const { ledger } = freshLedger();
    const clock = new DeterministicClock(9n);
    const ids = createIdFactory(clock);
    const atVersion = (version: bigint): DomainEventEnvelope<unknown> =>
      createEventEnvelope(
        {
          eventType: 'ledger.credited',
          payload: { currency: 'USD', minorUnits: '1' },
          aggregate: { id: ledger.id, version },
          schemaVersion: 1,
        },
        { ids, clock },
      );
    expect(() => ledger.rehydrate([atVersion(1n), atVersion(3n)])).toThrow(EventVersionConflictError);
    expect(() => ledger.rehydrate([atVersion(1n), atVersion(1n)])).toThrow(EventVersionConflictError);
    expect(() => ledger.rehydrate([atVersion(2n)])).toThrow(EventVersionConflictError);
  });

  it('events from another stream are rejected (AggregateMismatchError)', () => {
    const { ledger } = freshLedger();
    const clock = new DeterministicClock(9n);
    const foreign = createEventEnvelope(
      {
        eventType: 'ledger.credited',
        payload: { currency: 'USD', minorUnits: '1' },
        aggregate: { id: asAggregateId('agg-somewhere-else'), version: 1n },
        schemaVersion: 1,
      },
      { ids: createIdFactory(clock), clock },
    );
    expect(() => ledger.apply(foreign)).toThrow(AggregateMismatchError);
  });
});

describe('pendingEvents / markCommitted', () => {
  it('pending events accumulate, are exposed as frozen copies, and clear on commit', () => {
    const { ledger } = freshLedger();
    ledger.credit(fromMinorUnits(USD, 1n));
    const pendingFirst = ledger.pendingEvents;
    ledger.credit(fromMinorUnits(USD, 2n));
    expect(ledger.pendingEvents).toHaveLength(2);
    expect(pendingFirst).toHaveLength(1); // earlier copy is not aliased
    expect(Object.isFrozen(ledger.pendingEvents)).toBe(true);

    ledger.markCommitted();
    expect(ledger.pendingEvents).toHaveLength(0);
    expect(ledger.version).toBe(2n); // version survives the commit

    // the stream continues at version 3 after a commit
    ledger.credit(fromMinorUnits(USD, 3n));
    expect(ledger.pendingEvents.map((event) => event.aggregate.version)).toEqual([3n]);
  });

  it('rehydrating an aggregate with pending events is forbidden', () => {
    const { ledger } = freshLedger();
    ledger.credit(fromMinorUnits(USD, 1n));
    expect(() => ledger.rehydrate([])).toThrow(ValidationError);
  });

  it('raise propagates lineage into the event envelope', () => {
    const { ledger } = freshLedger();
    const event = ledger.credit(fromMinorUnits(USD, 1n), 'corr-42');
    expect(event.correlationId).toBe('corr-42');
    expect('causationId' in event).toBe(false);
  });
});

describe('§22 terminal states', () => {
  it('exports the frozen architecture terminal state set', () => {
    const expected = [
      'FULFILLED',
      'WAITING',
      'USER_ACTION_REQUIRED',
      'NO_VIABLE_ROUTE',
      'COMPLIANCE_BLOCKED',
      'EXPIRED',
      'CANCELLED',
      'FAILED',
      'UNKNOWN',
    ];
    expect(Object.values(TerminalState)).toEqual(expected);
    expect(TerminalState.UNKNOWN).toBe('UNKNOWN');
  });

  it('UNKNOWN is the reconciliation-required terminal state (INV-X01/X03)', () => {
    expect(requiresReconciliation(TerminalState.UNKNOWN)).toBe(true);
    for (const state of Object.values(TerminalState)) {
      if (state !== TerminalState.UNKNOWN) {
        expect(requiresReconciliation(state)).toBe(false);
      }
    }
  });

  it('the type-level marker binds reconciliation obligations to UNKNOWN exactly', () => {
    // Compile-time proof: TerminalStateRequiringReconciliation is exactly
    // TerminalState.UNKNOWN. The assertion would fail to typecheck otherwise.
    type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
      ? true
      : false;
    const unknownRequiresReconciliation: Equals<
      TerminalStateRequiringReconciliation,
      TerminalState.UNKNOWN
    > = true;
    expect(unknownRequiresReconciliation).toBe(true);
  });
});
