/**
 * @payswap/protocol — append-only double-entry journal (W1-002).
 *
 * FROZEN-ARCHITECTURE §8 / §8A: the journal is immutable double-entry
 * **accountability accounting** for obligations, fees, FX, incentives, credit,
 * escrow positions and settlement records. It is NOT a custodial user-balance
 * ledger: projections describe network obligations/positions and settlement
 * status, never a claim that PaySwap possesses customer funds.
 *
 * Invariants enforced here:
 * - INV-F02: the journal is append-only — no update or delete API exists on
 *   `LedgerJournal`; entries are frozen on store and the read view is a frozen
 *   copy. History is never rewritten.
 * - INV-F03: every journal entry balances — the sum of signed line amounts
 *   must be exactly zero, or `postJournal` rejects with
 *   `UnbalancedJournalEntryError`.
 * - INV-F01 (inherited from money.ts): line amounts are exact `Money`
 *   (integer minor units, bigint); JS `number` values are rejected with
 *   `FloatMoneyRejectedError`.
 *
 * Chart convention: an `AccountId` is `TYPE:name` where TYPE is one of
 * ASSET / LIABILITY / EQUITY / INCOME / EXPENSE (classical accountability
 * types) plus PROTOCOL_OBLIGATION (network obligations owed to/from
 * participants) and RESERVE (protocol capacity held by reservations). One
 * account carries exactly one currency; posting a second currency to an
 * account is rejected with `MixedCurrencyAccountError`.
 */

import {
  CurrencyMismatchError,
  FloatMoneyRejectedError,
  getCurrencyInfo,
  type CurrencyCode,
  type Money,
} from '../money.js';
import { PaySwapError, ValidationError, type PaySwapErrorDetails } from '../errors.js';
import { InvalidIdentifierError } from '../identifiers.js';
import type { CommandId, EventId, IdFactory, IntentId } from '../identifiers.js';
import type { ProtocolClock, TimestampMs } from '../clock.js';

declare const AccountIdBrand: unique symbol;

/**
 * Branded account identifier of the form `TYPE:name`
 * (e.g. `LIABILITY:obligations.payin-42` — see the chart convention above).
 */
export type AccountId = string & { readonly [AccountIdBrand]: 'AccountId' };

declare const JournalEntryIdBrand: unique symbol;

/** Branded id of one journal entry. */
export type JournalEntryId = string & { readonly [JournalEntryIdBrand]: 'JournalEntryId' };

/** Accountability account types (FROZEN §8: NOT custodial balances). */
export type AccountType =
  | 'ASSET'
  | 'LIABILITY'
  | 'EQUITY'
  | 'INCOME'
  | 'EXPENSE'
  | 'PROTOCOL_OBLIGATION'
  | 'RESERVE';

/** The closed set of account types in the chart convention. */
export const ACCOUNT_TYPES: readonly AccountType[] = Object.freeze([
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'INCOME',
  'EXPENSE',
  'PROTOCOL_OBLIGATION',
  'RESERVE',
]);

const ACCOUNT_TYPE_SET: ReadonlySet<string> = new Set<string>(ACCOUNT_TYPES);
const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ID_LENGTH = 256;
const MAX_MEMO_LENGTH = 1024;

/** Parsed components of an `AccountId`. */
export interface ParsedAccountId {
  readonly accountType: AccountType;
  readonly name: string;
}

/** INV-F03: the signed line amounts of an entry do not sum to zero. */
export class UnbalancedJournalEntryError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'UNBALANCED_JOURNAL_ENTRY', category: 'VALIDATION', message, details });
  }
}

/** An entry id that already exists in the journal (append-only, INV-F02). */
export class JournalEntryIdConflictError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'JOURNAL_ENTRY_ID_CONFLICT', category: 'CONFLICT', message, details });
  }
}

/** An account would hold more than one currency (chart violation). */
export class MixedCurrencyAccountError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'ACCOUNT_CURRENCY_MIXED', category: 'CONFLICT', message, details });
  }
}

/** The account has no projected balance in the journal at all. */
export class UnknownAccountError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'UNKNOWN_ACCOUNT', category: 'NOT_FOUND', message, details });
  }
}

/** Lineage of a journal entry: what command/event caused it. */
export interface JournalEntrySource {
  readonly causationId?: CommandId | EventId;
  readonly correlationId?: string;
  readonly intentId?: IntentId;
}

/**
 * One signed debit/credit line. `amount` is exact `Money` in integer minor
 * units; the sign convention is fixed by the entry's balance rule — the sum
 * over all lines of an entry must be zero.
 */
export interface JournalLine {
  readonly accountId: AccountId;
  readonly amount: Money;
  readonly entryId: JournalEntryId;
}

/** One balanced, immutable journal entry (INV-F03). */
export interface JournalEntry {
  readonly entryId: JournalEntryId;
  readonly occurredAt: TimestampMs;
  readonly lines: readonly JournalLine[];
  readonly memo?: string;
  readonly source?: JournalEntrySource;
}

/** Line spec before the entry id is stamped by `createJournalEntry`. */
export interface JournalLineInput {
  readonly accountId: AccountId;
  readonly amount: Money;
}

/** Entry spec before ids/timestamps are stamped by `createJournalEntry`. */
export interface JournalEntryInput {
  readonly lines: readonly JournalLineInput[];
  readonly memo?: string;
  readonly source?: JournalEntrySource;
}

/** Injected dependencies for the pure entry factory. */
export interface CreateJournalEntryDeps {
  readonly ids: IdFactory;
  readonly clock: ProtocolClock;
}

/**
 * The append-only journal contract (INV-F02). There is deliberately NO
 * update or delete operation: the only mutation is `append`, and the
 * reference implementation validates every entry with the same rules as
 * `postJournal` so the store cannot be bypassed.
 */
export interface LedgerJournal {
  /** Entries in append order — frozen copies; the journal cannot be mutated through them. */
  readonly entries: readonly JournalEntry[];
  /** Number of entries appended since genesis. */
  get size(): number;
  /** Look up one stored entry by id. */
  get(entryId: JournalEntryId): JournalEntry | undefined;
  /**
   * Append one entry. Implementations MUST enforce the full `postJournal`
   * validation (balance INV-F03, currency consistency, id uniqueness) before
   * storing; returns the frozen stored entry.
   */
  append(entry: JournalEntry): JournalEntry;
}

/** Brand a validated string as an `AccountId` (format `TYPE:name`). */
export function asAccountId(value: string): AccountId {
  parseAccountIdShape(value);
  return value as AccountId;
}

/** Build an `AccountId` from a declared account type and chart name. */
export function accountId(accountType: AccountType, name: string): AccountId {
  if (typeof accountType !== 'string' || !ACCOUNT_TYPE_SET.has(accountType)) {
    throw new InvalidIdentifierError('accountType must be one of ACCOUNT_TYPES', { accountType });
  }
  if (typeof name !== 'string' || !ACCOUNT_NAME_PATTERN.test(name)) {
    throw new InvalidIdentifierError(
      'account name must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}',
      { name },
    );
  }
  return `${accountType}:${name}` as AccountId;
}

/** Split an `AccountId` into its account type and chart name. */
export function parseAccountId(value: AccountId): ParsedAccountId {
  parseAccountIdShape(value);
  const separator = value.indexOf(':');
  const accountType = value.slice(0, separator) as AccountType;
  return Object.freeze({ accountType, name: value.slice(separator + 1) });
}

/** The chart-declared account type of an `AccountId`. */
export function accountTypeOf(value: AccountId): AccountType {
  return parseAccountId(value).accountType;
}

/** Brand a validated string as a `JournalEntryId`. */
export function asJournalEntryId(value: string): JournalEntryId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError('JournalEntryId must be a non-empty string', { value });
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new InvalidIdentifierError(`JournalEntryId exceeds ${MAX_ID_LENGTH} characters`, {
      value,
    });
  }
  if (value.trim() !== value) {
    throw new InvalidIdentifierError('JournalEntryId must not carry surrounding whitespace', {
      value,
    });
  }
  return value as JournalEntryId;
}

function parseAccountIdShape(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidIdentifierError('AccountId must be a non-empty string', { value });
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new InvalidIdentifierError(`AccountId exceeds ${MAX_ID_LENGTH} characters`, { value });
  }
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new InvalidIdentifierError('AccountId must be of the form TYPE:name', { value });
  }
  const type = value.slice(0, separator);
  if (!ACCOUNT_TYPE_SET.has(type)) {
    throw new InvalidIdentifierError('AccountId carries an account type outside ACCOUNT_TYPES', {
      value,
      accountType: type,
    });
  }
  const name = value.slice(separator + 1);
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new InvalidIdentifierError(
      'AccountId name segment must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}',
      { value },
    );
  }
}

function assertMoneyAmount(amount: Money, label: string): CurrencyCode {
  if (amount === null || typeof amount !== 'object') {
    throw new ValidationError(`${label} must be a Money object`, { label });
  }
  if (typeof amount.currency !== 'string' || amount.currency.length === 0) {
    throw new ValidationError(`${label}.currency must be a non-empty string`, { label });
  }
  if (typeof amount.value === 'number') {
    throw new FloatMoneyRejectedError(
      `${label}.value is a JS number; floating-point money is forbidden (INV-F01)`,
      { label },
    );
  }
  if (typeof amount.value !== 'bigint') {
    throw new ValidationError(`${label}.value must be a bigint of integer minor units`, { label });
  }
  // Rejects unregistered currency codes with UnknownCurrencyError.
  return getCurrencyInfo(amount.currency).code;
}

function assertSourceShape(source: JournalEntrySource): void {
  if (source === null || typeof source !== 'object') {
    throw new ValidationError('source must be a JournalEntrySource object');
  }
  const { causationId, correlationId, intentId } = source;
  if (causationId !== undefined && (typeof causationId !== 'string' || causationId.length === 0)) {
    throw new ValidationError('source.causationId must be a non-empty string when present');
  }
  if (
    correlationId !== undefined &&
    (typeof correlationId !== 'string' ||
      correlationId.length === 0 ||
      correlationId.length > MAX_ID_LENGTH)
  ) {
    throw new ValidationError('source.correlationId must be 1..256 characters when present');
  }
  if (intentId !== undefined && (typeof intentId !== 'string' || intentId.length === 0)) {
    throw new ValidationError('source.intentId must be a non-empty string when present');
  }
}

function freezeSource(source: JournalEntrySource): JournalEntrySource {
  const frozen: {
    -readonly [K in keyof JournalEntrySource]: JournalEntrySource[K];
  } = {};
  if (source.causationId !== undefined) frozen.causationId = source.causationId;
  if (source.correlationId !== undefined) frozen.correlationId = source.correlationId;
  if (source.intentId !== undefined) frozen.intentId = source.intentId;
  return Object.freeze(frozen);
}

function freezeEntry(entry: JournalEntry): JournalEntry {
  const frozen: {
    -readonly [K in keyof JournalEntry]: JournalEntry[K];
  } = {
    entryId: entry.entryId,
    occurredAt: entry.occurredAt,
    lines: Object.freeze(
      entry.lines.map((line) =>
        Object.freeze({ accountId: line.accountId, amount: line.amount, entryId: entry.entryId }),
      ),
    ),
  };
  if (entry.memo !== undefined) frozen.memo = entry.memo;
  if (entry.source !== undefined) frozen.source = freezeSource(entry.source);
  return Object.freeze(frozen);
}

function assertChartConsistency(
  journal: LedgerJournal,
  entry: JournalEntry,
  currency: CurrencyCode,
): void {
  const touched = new Set<string>(entry.lines.map((line) => line.accountId));
  const seen = new Map<string, CurrencyCode>();
  for (const existing of journal.entries) {
    for (const line of existing.lines) {
      if (!touched.has(line.accountId)) continue;
      const prior = seen.get(line.accountId);
      if (prior === undefined) {
        seen.set(line.accountId, line.amount.currency);
      } else if (prior !== line.amount.currency) {
        // Defensive: the stored journal itself would already be inconsistent.
        throw new MixedCurrencyAccountError(
          'stored journal already mixes currencies on one account',
          { accountId: line.accountId, stored: prior, incoming: line.amount.currency },
        );
      }
    }
  }
  for (const accountId of touched) {
    const prior = seen.get(accountId);
    if (prior !== undefined && prior !== currency) {
      throw new MixedCurrencyAccountError(
        'journal entry introduces a second currency to an account',
        { accountId, existing: prior, incoming: currency },
      );
    }
  }
}

/**
 * Validate one journal entry against the journal it is being posted to:
 * shape, per-line rules, single-currency entry, zero-sum balance (INV-F03),
 * entry-id uniqueness (INV-F02) and account-currency chart consistency.
 * Throws before any mutation is made — posting is atomic.
 */
export function validateJournalEntry(journal: LedgerJournal, entry: JournalEntry): void {
  if (entry === null || typeof entry !== 'object') {
    throw new ValidationError('entry must be a JournalEntry object');
  }
  const entryId = asJournalEntryId(entry.entryId);
  if (typeof entry.occurredAt !== 'bigint') {
    throw new ValidationError('entry.occurredAt must be a bigint TimestampMs');
  }
  if (entry.memo !== undefined) {
    if (
      typeof entry.memo !== 'string' ||
      entry.memo.length === 0 ||
      entry.memo.length > MAX_MEMO_LENGTH
    ) {
      throw new ValidationError('entry.memo must be 1..1024 characters when present');
    }
  }
  if (entry.source !== undefined) {
    assertSourceShape(entry.source);
  }
  if (!Array.isArray(entry.lines) || entry.lines.length < 2) {
    throw new ValidationError('a double-entry journal entry requires at least two lines');
  }
  let currency: CurrencyCode | undefined;
  let sum = 0n;
  for (const [index, line] of entry.lines.entries()) {
    if (line === null || typeof line !== 'object') {
      throw new ValidationError(`lines[${index}] must be a JournalLine object`, { index });
    }
    asAccountId(line.accountId);
    const lineCurrency = assertMoneyAmount(line.amount, `lines[${index}].amount`);
    if (currency === undefined) {
      currency = lineCurrency;
    } else if (lineCurrency !== currency) {
      throw new CurrencyMismatchError(
        'all lines of one journal entry must share a single currency',
        { entry: entryId, first: currency, offending: lineCurrency },
      );
    }
    if (line.entryId !== entryId) {
      throw new ValidationError('journal line carries a different entryId than its entry', {
        entry: entryId,
        line: index,
      });
    }
    if (line.amount.value === 0n) {
      throw new ValidationError('zero-amount journal lines are forbidden', { entry: entryId, index });
    }
    sum += line.amount.value;
  }
  if (currency === undefined) {
    throw new ValidationError('journal entry carries no lines');
  }
  if (sum !== 0n) {
    throw new UnbalancedJournalEntryError(
      'journal entry does not balance: the sum of signed line amounts must be zero (INV-F03)',
      { entry: entryId, currency, sum: sum.toString() },
    );
  }
  if (journal.get(entryId) !== undefined) {
    throw new JournalEntryIdConflictError('journal entry id already exists (append-only, INV-F02)', {
      entry: entryId,
    });
  }
  assertChartConsistency(journal, entry, currency);
}

/**
 * Post one entry to the journal. REJECTS unbalanced entries (INV-F03),
 * duplicate ids (INV-F02) and chart violations BEFORE any mutation, then
 * appends immutably. Returns the frozen stored entry.
 */
export function postJournal(journal: LedgerJournal, entry: JournalEntry): JournalEntry {
  return journal.append(entry);
}

/**
 * Pure factory: stamps a fresh `JournalEntryId` (via the injected id factory)
 * and `occurredAt` (via the injected clock) onto the line spec, producing a
 * draft entry ready for `postJournal`. Deterministic for a given (ids, clock)
 * pair and call order.
 */
export function createJournalEntry(
  input: JournalEntryInput,
  deps: CreateJournalEntryDeps,
): JournalEntry {
  if (input === null || typeof input !== 'object') {
    throw new ValidationError('input must be a JournalEntryInput object');
  }
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new ValidationError('a double-entry journal entry requires at least two lines');
  }
  if (input.memo !== undefined) {
    if (
      typeof input.memo !== 'string' ||
      input.memo.length === 0 ||
      input.memo.length > MAX_MEMO_LENGTH
    ) {
      throw new ValidationError('input.memo must be 1..1024 characters when present');
    }
  }
  if (input.source !== undefined) {
    assertSourceShape(input.source);
  }
  const entryId = asJournalEntryId(deps.ids.mintId('jrn'));
  const draft: {
    -readonly [K in keyof JournalEntry]: JournalEntry[K];
  } = {
    entryId,
    occurredAt: deps.clock.now(),
    lines: Object.freeze(
      input.lines.map((line) =>
        Object.freeze({
          accountId: asAccountId(line.accountId),
          amount: line.amount,
          entryId,
        }),
      ),
    ),
  };
  if (input.memo !== undefined) draft.memo = input.memo;
  if (input.source !== undefined) draft.source = freezeSource(input.source);
  return Object.freeze(draft);
}

/**
 * Deterministic in-memory reference journal (Stage 1). Entries are stored as
 * frozen deep copies; the read view is a fresh frozen array on every access.
 * Append runs the full `validateJournalEntry` rule set, so posting through
 * `postJournal` or `append` is equally safe.
 */
export class InMemoryLedgerJournal implements LedgerJournal {
  private readonly _entries: JournalEntry[] = [];
  private readonly _byId = new Map<JournalEntryId, JournalEntry>();

  get entries(): readonly JournalEntry[] {
    return Object.freeze([...this._entries]);
  }

  get size(): number {
    return this._entries.length;
  }

  get(entryId: JournalEntryId): JournalEntry | undefined {
    const stored = this._byId.get(entryId);
    return stored === undefined ? undefined : stored;
  }

  append(entry: JournalEntry): JournalEntry {
    validateJournalEntry(this, entry);
    const stored = freezeEntry(entry);
    this._entries.push(stored);
    this._byId.set(stored.entryId, stored);
    return stored;
  }
}
