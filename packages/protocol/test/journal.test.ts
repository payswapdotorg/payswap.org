import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  DeterministicClock,
  FloatMoneyRejectedError,
  GHS,
  createIdFactory,
  fromMinorUnits,
  USD,
  type Money,
} from '../src/index.js';
import {
  InMemoryLedgerJournal,
  JournalEntryIdConflictError,
  MixedCurrencyAccountError,
  UnbalancedJournalEntryError,
  accountTypeOf,
  accountId,
  asAccountId,
  asJournalEntryId,
  createJournalEntry,
  parseAccountId,
  postJournal,
  type AccountId,
  type JournalEntry,
  type JournalEntryInput,
  type JournalLineInput,
} from '../src/ledger/journal.js';

const clock = new DeterministicClock(1_000n);
const ids = createIdFactory(clock);

const ASSET_POOL = accountId('ASSET', 'pool.usd');
const EQUITY_OPENING = accountId('EQUITY', 'opening.usd');
const LIABILITY_OBLIGATIONS = accountId('LIABILITY', 'obligations.usd');
const INCOME_FEES = accountId('INCOME', 'fees.usd');

function usd(minorUnits: bigint): Money {
  return fromMinorUnits(USD, minorUnits);
}

function line(account: AccountId, minorUnits: bigint): JournalLineInput {
  return { accountId: account, amount: usd(minorUnits) };
}

function post(journal: InMemoryLedgerJournal, input: JournalEntryInput): JournalEntry {
  return postJournal(journal, createJournalEntry(input, { ids, clock }));
}

describe('journal: account chart convention', () => {
  it('builds and parses TYPE:name account ids over the closed type set', () => {
    expect(ASSET_POOL).toBe('ASSET:pool.usd');
    expect(parseAccountId(ASSET_POOL)).toEqual({ accountType: 'ASSET', name: 'pool.usd' });
    expect(accountTypeOf(LIABILITY_OBLIGATIONS)).toBe('LIABILITY');
    expect(accountTypeOf(accountId('PROTOCOL_OBLIGATION', 'net-1'))).toBe('PROTOCOL_OBLIGATION');
    expect(accountTypeOf(accountId('RESERVE', 'hold-1'))).toBe('RESERVE');
  });

  it('rejects malformed account ids', () => {
    expect(() => asAccountId('pool.usd')).toThrow();
    expect(() => asAccountId('ASSET:')).toThrow();
    expect(() => asAccountId('CUSTODIAL:pool')).toThrow();
    expect(() => asAccountId('ASSET:bad name')).toThrow();
    expect(() => asAccountId('')).toThrow();
    expect(() => accountId('ASSET', 'ok')).not.toThrow();
  });
});

describe('journal: posting and balance (INV-F03)', () => {
  it('posts a balanced entry and stores it immutably with memo and source refs', () => {
    const journal = new InMemoryLedgerJournal();
    const stored = post(journal, {
      lines: [line(ASSET_POOL, 10_000n), line(EQUITY_OPENING, -10_000n)],
      memo: 'genesis funding',
      source: { correlationId: 'corr-1' },
    });

    expect(journal.size).toBe(1);
    expect(stored.memo).toBe('genesis funding');
    expect(stored.source?.correlationId).toBe('corr-1');
    expect(stored.occurredAt).toBe(1_000n);
    expect(stored.lines).toHaveLength(2);
    expect(stored.lines[0]?.amount.value).toBe(10_000n);
    expect(stored.lines[0]?.entryId).toBe(stored.entryId);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.lines)).toBe(true);
    expect(Object.isFrozen(stored.lines[0])).toBe(true);
  });

  it('REJECTS an unbalanced entry and mutates nothing (INV-F03)', () => {
    const journal = new InMemoryLedgerJournal();
    expect(() =>
      post(journal, { lines: [line(ASSET_POOL, 100n), line(EQUITY_OPENING, -90n)] }),
    ).toThrow(UnbalancedJournalEntryError);

    const error = new UnbalancedJournalEntryError('x');
    expect(error.code).toBe('UNBALANCED_JOURNAL_ENTRY');
    expect(journal.size).toBe(0);
    expect(journal.entries).toHaveLength(0);
  });

  it('rejects entries with fewer than two lines, zero lines and zero amounts', () => {
    const journal = new InMemoryLedgerJournal();
    expect(() => post(journal, { lines: [line(ASSET_POOL, 5n)] })).toThrow(/two lines/);
    expect(() =>
      post(journal, { lines: [line(ASSET_POOL, 0n), line(EQUITY_OPENING, 0n)] }),
    ).toThrow(/zero-amount/);
    expect(journal.size).toBe(0);
  });

  it('rejects a line whose entryId disagrees with its entry', () => {
    const journal = new InMemoryLedgerJournal();
    const draft = createJournalEntry(
      { lines: [line(ASSET_POOL, 7n), line(EQUITY_OPENING, -7n)] },
      { ids, clock },
    );
    const forged: JournalEntry = {
      ...draft,
      entryId: asJournalEntryId('jrn_forged'),
      lines: draft.lines.map((l) => ({ ...l, amount: l.amount })),
    };
    expect(() => postJournal(journal, forged)).toThrow(/different entryId/);
  });

  it('rejects floating-point money values (INV-F01 defense in depth)', () => {
    const journal = new InMemoryLedgerJournal();
    const draft = createJournalEntry(
      { lines: [line(ASSET_POOL, 7n), line(EQUITY_OPENING, -7n)] },
      { ids, clock },
    );
    const floated: JournalEntry = {
      ...draft,
      lines: [
        { accountId: ASSET_POOL, amount: { currency: USD, value: 0.1 } as unknown as Money, entryId: draft.entryId },
        { accountId: EQUITY_OPENING, amount: usd(-7n), entryId: draft.entryId },
      ],
    };
    expect(() => postJournal(journal, floated)).toThrow(FloatMoneyRejectedError);
  });
});

describe('journal: append-only discipline (INV-F02)', () => {
  it('has no update/delete surface: the read view is frozen and ids never repeat', () => {
    const journal = new InMemoryLedgerJournal();
    const first = post(journal, { lines: [line(ASSET_POOL, 5n), line(EQUITY_OPENING, -5n)] });
    const view = journal.entries;
    expect(() => (view as unknown as JournalEntry[]).pop()).toThrow(TypeError);
    expect(() => {
      (first as { memo?: string }).memo = 'rewrite';
    }).toThrow(TypeError);

    // Same entry id again (reposting the identical immutable object) → conflict.
    expect(() => postJournal(journal, first)).toThrow(JournalEntryIdConflictError);
    expect(journal.size).toBe(1);
    expect(journal.get(first.entryId)).toBeDefined();
  });

  it('rejects a duplicate id even with different content', () => {
    const journal = new InMemoryLedgerJournal();
    const first = post(journal, { lines: [line(ASSET_POOL, 5n), line(EQUITY_OPENING, -5n)] });
    const clone: JournalEntry = {
      entryId: first.entryId,
      occurredAt: first.occurredAt,
      lines: [
        { accountId: INCOME_FEES, amount: usd(9n), entryId: first.entryId },
        { accountId: EQUITY_OPENING, amount: usd(-9n), entryId: first.entryId },
      ],
    };
    expect(() => postJournal(journal, clone)).toThrow(JournalEntryIdConflictError);
    expect(journal.size).toBe(1);
  });
});

describe('journal: currency discipline', () => {
  it('rejects mixed currencies within one entry', () => {
    const journal = new InMemoryLedgerJournal();
    expect(() =>
      post(journal, {
        lines: [
          { accountId: ASSET_POOL, amount: fromMinorUnits(USD, 5n) },
          { accountId: EQUITY_OPENING, amount: fromMinorUnits(GHS, -5n) },
        ],
      }),
    ).toThrow(CurrencyMismatchError);
    expect(journal.size).toBe(0);
  });

  it('rejects introducing a second currency to an account (chart violation)', () => {
    const journal = new InMemoryLedgerJournal();
    post(journal, { lines: [line(ASSET_POOL, 5n), line(EQUITY_OPENING, -5n)] });
    expect(() =>
      post(journal, {
        lines: [
          { accountId: ASSET_POOL, amount: fromMinorUnits(GHS, 3n) },
          { accountId: accountId('EQUITY', 'opening.ghs'), amount: fromMinorUnits(GHS, -3n) },
        ],
      }),
    ).toThrow(MixedCurrencyAccountError);
    expect(journal.size).toBe(1);
  });
});

describe('journal: determinism', () => {
  it('the entry factory is deterministic for a fixed (clock, ids) pair and call order', () => {
    const clockA = new DeterministicClock(50n);
    const clockB = new DeterministicClock(50n);
    const factoryA = createIdFactory(clockA);
    const factoryB = createIdFactory(clockB);
    const input: JournalEntryInput = {
      lines: [line(ASSET_POOL, 2n), line(EQUITY_OPENING, -2n)],
    };
    const a = createJournalEntry(input, { ids: factoryA, clock: clockA });
    const b = createJournalEntry(input, { ids: factoryB, clock: clockB });
    expect(a.entryId).toBe(b.entryId);
    expect(a.occurredAt).toBe(b.occurredAt);
  });
});
