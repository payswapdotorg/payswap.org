import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
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
  InMemoryLedgerJournal,
  UnknownAccountError,
  accountId,
  createJournalEntry,
  postJournal,
  type LedgerJournal,
} from '../src/ledger/journal.js';
import {
  InMemoryReservationBook,
  InsufficientAvailableFundsError,
  UnknownReservationError,
  activateReservation,
  asReservationId,
  availableFunds,
  captureReservation,
  expireDueReservations,
  expireReservation,
  releaseReservation,
  reserve,
  type ReservationLedgerState,
} from '../src/reservation.js';

const POOL = accountId('ASSET', 'pool.usd');
const EQUITY = accountId('EQUITY', 'opening.usd');
const OTHER_POOL = accountId('ASSET', 'other.usd');

function usd(minorUnits: bigint): Money {
  return fromMinorUnits(USD, minorUnits);
}

function fundedLedger(balanceMinorUnits: bigint): LedgerJournal {
  const journal = new InMemoryLedgerJournal();
  const clock = new DeterministicClock(1_000n);
  const ids = createIdFactory(clock);
  postJournal(
    journal,
    createJournalEntry(
      { lines: [{ accountId: POOL, amount: usd(balanceMinorUnits) }, { accountId: EQUITY, amount: usd(-balanceMinorUnits) }] },
      { ids, clock },
    ),
  );
  return journal;
}

function ledgerState(journal: LedgerJournal, seedMs = 2_000n): ReservationLedgerState {
  const clock = new DeterministicClock(seedMs);
  return {
    journal,
    reservations: new InMemoryReservationBook(),
    ids: createIdFactory(clock),
    clock,
  };
}

describe('reservation: atomic holds and INV-F04', () => {
  it('reserves within available funds and reports the availability breakdown', () => {
    const state = ledgerState(fundedLedger(10_000n));
    const reservation = reserve(state, { accountId: POOL, amount: usd(6_000n) });

    expect(reservation.state).toBe('PENDING');
    expect(reservation.amount.value).toBe(6_000n);
    expect(reservation.createdAt).toBe(2_000n);
    expect(state.reservations.all).toHaveLength(1);

    const funds = availableFunds(state, POOL);
    expect(funds.currency).toBe(USD);
    expect(funds.balance.value).toBe(10_000n);
    expect(funds.held.value).toBe(6_000n);
    expect(funds.available.value).toBe(4_000n);
  });

  it('REJECTS a reservation exceeding available funds and mutates nothing (INV-F04)', () => {
    const state = ledgerState(fundedLedger(10_000n));
    reserve(state, { accountId: POOL, amount: usd(6_000n) });

    expect(() => reserve(state, { accountId: POOL, amount: usd(4_001n) })).toThrow(
      InsufficientAvailableFundsError,
    );
    // Atomicity: the failed attempt left the book untouched.
    expect(state.reservations.all).toHaveLength(1);

    reserve(state, { accountId: POOL, amount: usd(4_000n) });
    expect(() => reserve(state, { accountId: POOL, amount: usd(1n) })).toThrow(
      InsufficientAvailableFundsError,
    );
    expect(state.reservations.all).toHaveLength(2);
  });

  it('rejects a reservation on an account with no projected balance', () => {
    const state = ledgerState(fundedLedger(10_000n));
    expect(() => reserve(state, { accountId: OTHER_POOL, amount: usd(1n) })).toThrow(
      InsufficientAvailableFundsError,
    );
    expect(() => availableFunds(state, OTHER_POOL)).toThrow(UnknownAccountError);
  });

  it('rejects reservations in a currency foreign to the account', () => {
    const state = ledgerState(fundedLedger(10_000n));
    expect(() =>
      reserve(state, { accountId: POOL, amount: fromMinorUnits(GHS, 100n) }),
    ).toThrow(CurrencyMismatchError);
  });

  it('rejects non-positive amounts and past expiries', () => {
    const state = ledgerState(fundedLedger(10_000n));
    expect(() => reserve(state, { accountId: POOL, amount: usd(0n) })).toThrow(/positive/);
    expect(() => reserve(state, { accountId: POOL, amount: usd(-5n) })).toThrow(/positive/);
    expect(() =>
      reserve(state, { accountId: POOL, amount: usd(5n), expiresAt: 1_000n }),
    ).toThrow(/strictly after/);
    expect(() =>
      reserve(state, { accountId: POOL, amount: usd(5n), expiresAt: 2_000n }),
    ).toThrow(/strictly after/);
    expect(state.reservations.all).toHaveLength(0);
  });
});

describe('reservation: concurrent double-spend of the same capacity', () => {
  it('interleaved command application: the second spend of the same capacity fails', () => {
    // Two actors interleaving reserve commands against one ledger state.
    const state = ledgerState(fundedLedger(10_000n));
    const firstSpend = reserve(state, { accountId: POOL, amount: usd(7_000n) });
    activateReservation(state, firstSpend.id);
    expect(() => reserve(state, { accountId: POOL, amount: usd(3_001n) })).toThrow(
      InsufficientAvailableFundsError,
    );
    const secondSpend = reserve(state, { accountId: POOL, amount: usd(3_000n) });
    expect(secondSpend.state).toBe('PENDING');
    // Both holds together exactly consume the balance; a third always fails.
    expect(() => reserve(state, { accountId: POOL, amount: usd(1n) })).toThrow(
      InsufficientAvailableFundsError,
    );
  });

  it('replaying the same interleaved command sequence is fully deterministic', () => {
    const run = () => {
      const state = ledgerState(fundedLedger(10_000n));
      const a = reserve(state, { accountId: POOL, amount: usd(6_000n) });
      activateReservation(state, a.id);
      let secondFailed = false;
      try {
        reserve(state, { accountId: POOL, amount: usd(5_000n) });
      } catch (error) {
        secondFailed = error instanceof InsufficientAvailableFundsError;
      }
      const b = reserve(state, { accountId: POOL, amount: usd(4_000n) });
      captureReservation(state, a.id);
      return {
        secondFailed,
        states: state.reservations.all.map((r) => [r.id, r.state, r.amount.value.toString()]),
      };
    };
    const first = run();
    const second = run();
    expect(first).toEqual(second);
    expect(first.secondFailed).toBe(true);
    expect(first.states).toHaveLength(2);
  });
});

describe('reservation: lifecycle and terminality (INV-X04)', () => {
  it('walks PENDING → ACTIVE → CAPTURED and then refuses every further transition', () => {
    const state = ledgerState(fundedLedger(10_000n));
    const reservation = reserve(state, { accountId: POOL, amount: usd(1_000n) });
    expect(activateReservation(state, reservation.id).state).toBe('ACTIVE');
    expect(captureReservation(state, reservation.id).state).toBe('CAPTURED');

    expect(() => activateReservation(state, reservation.id)).toThrow(TerminalStateViolationError);
    expect(() => releaseReservation(state, reservation.id)).toThrow(TerminalStateViolationError);
    expect(() => expireReservation(state, reservation.id)).toThrow(TerminalStateViolationError);
  });

  it('releases a PENDING hold directly, restoring capacity', () => {
    const state = ledgerState(fundedLedger(10_000n));
    const reservation = reserve(state, { accountId: POOL, amount: usd(10_000n) });
    expect(() => reserve(state, { accountId: POOL, amount: usd(1n) })).toThrow(
      InsufficientAvailableFundsError,
    );
    expect(releaseReservation(state, reservation.id).state).toBe('RELEASED');
    // Released capacity is available again.
    expect(availableFunds(state, POOL).available.value).toBe(10_000n);
    expect(() => reserve(state, { accountId: POOL, amount: usd(1n) })).not.toThrow();
  });

  it('throws UnknownReservationError for unknown ids', () => {
    const state = ledgerState(fundedLedger(10_000n));
    expect(() => activateReservation(state, asReservationId('rsv_unknown'))).toThrow(
      UnknownReservationError,
    );
  });
});

describe('reservation: expiry via the injected clock (never setTimeout)', () => {
  it('expired holds cannot be captured or activated — they must be expired first', () => {
    const state = ledgerState(fundedLedger(10_000n));
    // Hold A is activated while still valid; hold B stays PENDING.
    const active = reserve(state, {
      accountId: POOL,
      amount: usd(1_000n),
      expiresAt: 2_500n,
    });
    activateReservation(state, active.id);
    const pending = reserve(state, {
      accountId: POOL,
      amount: usd(500n),
      expiresAt: 2_400n,
    });
    (state.clock as DeterministicClock).advanceMs(600n); // now = 2_600n past both expiries

    expect(() => captureReservation(state, active.id)).toThrow(TransitionGuardError);
    expect(() => activateReservation(state, pending.id)).toThrow(TransitionGuardError);
    expect(expireReservation(state, active.id).state).toBe('EXPIRED');
    expect(expireReservation(state, pending.id).state).toBe('EXPIRED');
  });

  it('EXPIRE is refused strictly before the expiry passes', () => {
    const state = ledgerState(fundedLedger(10_000n));
    const reservation = reserve(state, {
      accountId: POOL,
      amount: usd(1_000n),
      expiresAt: 2_500n,
    });
    (state.clock as DeterministicClock).advanceMs(100n); // now = 2_100n < expiresAt
    expect(() => expireReservation(state, reservation.id)).toThrow(TransitionGuardError);
    (state.clock as DeterministicClock).advanceMs(400n); // now = 2_500n === expiresAt → due
    expect(expireReservation(state, reservation.id).state).toBe('EXPIRED');
  });

  it('expiring a hold restores its capacity to the account', () => {
    const state = ledgerState(fundedLedger(10_000n));
    const reservation = reserve(state, {
      accountId: POOL,
      amount: usd(9_000n),
      expiresAt: 2_500n,
    });
    expect(availableFunds(state, POOL).available.value).toBe(1_000n);
    (state.clock as DeterministicClock).advanceMs(600n);
    expireReservation(state, reservation.id);
    expect(availableFunds(state, POOL).available.value).toBe(10_000n);
    expect(() => reserve(state, { accountId: POOL, amount: usd(10_000n) })).not.toThrow();
  });

  it('expireDueReservations sweeps exactly the due holds in creation order', () => {
    const state = ledgerState(fundedLedger(100_000n));
    const due1 = reserve(state, { accountId: POOL, amount: usd(1n), expiresAt: 2_100n });
    const notDue = reserve(state, { accountId: POOL, amount: usd(1n), expiresAt: 9_999n });
    const noExpiry = reserve(state, { accountId: POOL, amount: usd(1n) });
    const due2 = reserve(state, { accountId: POOL, amount: usd(1n), expiresAt: 2_050n });
    (state.clock as DeterministicClock).advanceMs(200n); // now = 2_200n

    const expired = expireDueReservations(state, POOL);
    expect(expired).toEqual([due1.id, due2.id]); // creation order, not expiry order
    expect(state.reservations.get(due1.id)?.state).toBe('EXPIRED');
    expect(state.reservations.get(due2.id)?.state).toBe('EXPIRED');
    expect(state.reservations.get(notDue.id)?.state).toBe('PENDING');
    expect(state.reservations.get(noExpiry.id)?.state).toBe('PENDING');
  });

  it('an ACTIVE hold that expires frees its capacity only after the sweep', () => {
    const state = ledgerState(fundedLedger(5_000n));
    const reservation = reserve(state, {
      accountId: POOL,
      amount: usd(4_000n),
      expiresAt: 2_400n,
    });
    activateReservation(state, reservation.id);
    expect(availableFunds(state, POOL).available.value).toBe(1_000n);
    (state.clock as DeterministicClock).advanceMs(500n);
    // Still held before the explicit sweep — expiry is declarative, not spontaneous.
    expect(availableFunds(state, POOL).available.value).toBe(1_000n);
    expireDueReservations(state);
    expect(availableFunds(state, POOL).available.value).toBe(5_000n);
  });
});
