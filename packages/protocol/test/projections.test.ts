import { describe, expect, it } from 'vitest';
import { DeterministicClock, USD, createIdFactory, fromMinorUnits, type Money } from '../src/index.js';
import {
  InMemoryLedgerJournal,
  accountId,
  createJournalEntry,
  postJournal,
  type AccountId,
  type JournalEntry,
  type JournalEntryInput,
  type JournalLineInput,
  type LedgerJournal,
} from '../src/ledger/journal.js';
import {
  foldJournalEntry,
  projectBalances,
  rebuildProjection,
} from '../src/ledger/projections.js';

const clock = new DeterministicClock(0n);
const ids = createIdFactory(clock);

const ACCOUNTS: readonly AccountId[] = Object.freeze([
  accountId('ASSET', 'pool.usd'),
  accountId('ASSET', 'receivables.usd'),
  accountId('LIABILITY', 'obligations.usd'),
  accountId('INCOME', 'fees.usd'),
  accountId('EXPENSE', 'rail-costs.usd'),
  accountId('EQUITY', 'opening.usd'),
]);

function usd(minorUnits: bigint): Money {
  return fromMinorUnits(USD, minorUnits);
}

function balancedInput(amount: bigint, debitIndex: number, creditIndex: number): JournalEntryInput {
  const lines: JournalLineInput[] = [
    { accountId: ACCOUNTS[debitIndex] as AccountId, amount: usd(amount) },
    { accountId: ACCOUNTS[creditIndex] as AccountId, amount: usd(-amount) },
  ];
  return { lines, memo: 'seeded' };
}

/** Deterministic xorshift32 — seeded, never Math.random. */
function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function buildSeededJournal(entryCount: number): LedgerJournal {
  const journal = new InMemoryLedgerJournal();
  const next = xorshift32(0x9e3779b9);
  for (let i = 0; i < entryCount; i += 1) {
    const debit = next() % ACCOUNTS.length;
    let credit = next() % ACCOUNTS.length;
    if (credit === debit) credit = (debit + 1) % ACCOUNTS.length;
    const amount = BigInt(next() % 5000) + 1n;
    postJournal(journal, createJournalEntry(balancedInput(amount, debit, credit), { ids, clock }));
  }
  return journal;
}

describe('projections: deterministic fold (INV-F02/O04)', () => {
  it('projects exact balances over a known journal', () => {
    const journal = new InMemoryLedgerJournal();
    const pool = accountId('ASSET', 'pool.usd');
    const obligations = accountId('LIABILITY', 'obligations.usd');
    const fees = accountId('INCOME', 'fees.usd');
    postJournal(
      journal,
      createJournalEntry(
        { lines: [{ accountId: pool, amount: usd(10_000n) }, { accountId: obligations, amount: usd(-10_000n) }] },
        { ids, clock },
      ),
    );
    postJournal(
      journal,
      createJournalEntry(
        { lines: [{ accountId: pool, amount: usd(-250n) }, { accountId: fees, amount: usd(250n) }] },
        { ids, clock },
      ),
    );

    const balances = projectBalances(journal);
    expect(balances.get(pool)?.value).toBe(9_750n);
    expect(balances.get(obligations)?.value).toBe(-10_000n);
    expect(balances.get(fees)?.value).toBe(250n);
    expect(balances.size).toBe(3);
  });

  it('keeps a fully-offset account present with a zero balance', () => {
    const journal = new InMemoryLedgerJournal();
    const pool = accountId('ASSET', 'pool.usd');
    const equity = accountId('EQUITY', 'opening.usd');
    postJournal(
      journal,
      createJournalEntry({ lines: [{ accountId: pool, amount: usd(100n) }, { accountId: equity, amount: usd(-100n) }] }, { ids, clock }),
    );
    postJournal(
      journal,
      createJournalEntry({ lines: [{ accountId: pool, amount: usd(-100n) }, { accountId: equity, amount: usd(100n) }] }, { ids, clock }),
    );
    const balances = projectBalances(journal);
    expect(balances.get(pool)?.value).toBe(0n);
    expect(balances.has(pool)).toBe(true);
  });

  it('folds a scoped projection for a single account', () => {
    const journal = new InMemoryLedgerJournal();
    const pool = accountId('ASSET', 'pool.usd');
    const fees = accountId('INCOME', 'fees.usd');
    const equity = accountId('EQUITY', 'opening.usd');
    postJournal(
      journal,
      createJournalEntry({ lines: [{ accountId: pool, amount: usd(100n) }, { accountId: equity, amount: usd(-100n) }] }, { ids, clock }),
    );
    postJournal(
      journal,
      createJournalEntry({ lines: [{ accountId: pool, amount: usd(-30n) }, { accountId: fees, amount: usd(30n) }] }, { ids, clock }),
    );
    const scoped = projectBalances(journal, fees);
    expect(scoped.size).toBe(1);
    expect(scoped.get(fees)?.value).toBe(30n);
  });

  it('returns a fresh map on every call — mutating a projection cannot touch the journal', () => {
    const journal = buildSeededJournal(5);
    const first = projectBalances(journal);
    const snapshot = new Map(first);
    (first as Map<AccountId, Money>).set(accountId('ASSET', 'forged.usd'), usd(1n));
    const second = projectBalances(journal);
    expect(second.size).toBe(snapshot.size);
    for (const [accountId, money] of snapshot) {
      expect(second.get(accountId)).toEqual(money);
    }
  });
});

describe('projections: incremental === full rebuild (INV-O04)', () => {
  it('a seeded 60-entry random-ish sequence: incremental fold equals rebuildProjection', () => {
    const journal = buildSeededJournal(60);
    const incremental = new Map<AccountId, Money>();
    for (const entry of journal.entries) {
      foldJournalEntry(incremental, entry as JournalEntry);
    }
    const rebuild = rebuildProjection(journal);

    expect(incremental.size).toBe(rebuild.size);
    for (const [accountId, money] of rebuild) {
      expect(incremental.get(accountId)).toEqual(money);
    }
  });

  it('per-step incremental snapshots always equal a rebuild of the same prefix', () => {
    const journal = buildSeededJournal(25);
    const incremental = new Map<AccountId, Money>();
    const prefix = new InMemoryLedgerJournal();
    const prefixClock = new DeterministicClock(0n);
    const prefixIds = createIdFactory(prefixClock);
    for (const entry of journal.entries) {
      foldJournalEntry(incremental, entry as JournalEntry);
      postJournal(prefix, createJournalEntry({ lines: entry.lines.map((l) => ({ accountId: l.accountId, amount: l.amount })) }, { ids: prefixIds, clock: prefixClock }));
      const rebuild = rebuildProjection(prefix);
      expect(rebuild.size).toBe(incremental.size);
      for (const [accountId, money] of incremental) {
        expect(rebuild.get(accountId)).toEqual(money);
      }
    }
  });
});
