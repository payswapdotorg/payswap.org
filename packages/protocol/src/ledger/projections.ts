/**
 * @payswap/protocol — deterministic balance projections (W1-002).
 *
 * INV-F02: balances are PROJECTIONS, never stored truth. INV-O04: any
 * authoritative state can be reconstructed by replaying the journal —
 * `rebuildProjection` is by definition `projectBalances` folded from genesis.
 *
 * The fold is a pure, order-deterministic function of the append-only
 * journal: entries are consumed in append order, lines are summed per
 * account with exact bigint arithmetic, and an account that would receive
 * lines in two currencies fails loudly (`MixedCurrencyAccountError`) instead
 * of producing an ambiguous balance.
 *
 * FROZEN §8 / §8A reminder: these balances describe network
 * obligations/positions and protocol capacity. They are NOT custodial
 * customer balances and never evidence that PaySwap holds customer funds.
 */

import { add, type CurrencyCode, type Money } from '../money.js';
import { MixedCurrencyAccountError } from './journal.js';
import type { AccountId, JournalEntry, LedgerJournal } from './journal.js';

/** Projection of signed balances per account (one currency per account). */
export type AccountBalances = ReadonlyMap<AccountId, Money>;

/**
 * Fold ONE entry into a mutable accumulator (the incremental projection
 * primitive). Deterministic: same entry order, same result. Throws
 * `MixedCurrencyAccountError` when an account would cross currencies.
 */
export function foldJournalEntry(balances: Map<AccountId, Money>, entry: JournalEntry): void {
  for (const line of entry.lines) {
    const current = balances.get(line.accountId);
    if (current === undefined) {
      balances.set(line.accountId, line.amount);
    } else {
      if (current.currency !== line.amount.currency) {
        throw new MixedCurrencyAccountError(
          'projection encountered a second currency on one account',
          {
            accountId: line.accountId,
            projected: current.currency,
            incoming: line.amount.currency,
            entry: entry.entryId,
          },
        );
      }
      balances.set(line.accountId, add(current, line.amount));
    }
  }
}

/**
 * Deterministic fold over the whole journal in append order. With
 * `accountId`, only that account's lines are folded (a scoped projection).
 * Returns a fresh `Map` on every call — mutating it can never affect the
 * journal.
 */
export function projectBalances(journal: LedgerJournal, accountId?: AccountId): AccountBalances {
  const balances = new Map<AccountId, Money>();
  for (const entry of journal.entries) {
    for (const line of entry.lines) {
      if (accountId !== undefined && line.accountId !== accountId) continue;
      const current = balances.get(line.accountId);
      if (current === undefined) {
        balances.set(line.accountId, line.amount);
      } else {
        if (current.currency !== line.amount.currency) {
          throw new MixedCurrencyAccountError(
            'projection encountered a second currency on one account',
            {
              accountId: line.accountId,
              projected: current.currency,
              incoming: line.amount.currency,
              entry: entry.entryId,
            },
          );
        }
        balances.set(line.accountId, add(current, line.amount));
      }
    }
  }
  return balances;
}

/**
 * Full rebuild from genesis (INV-O04: restore/replay reconstructs
 * authoritative state). By construction identical to `projectBalances` over
 * the same journal — the incremental projection and the full rebuild are the
 * same deterministic fold, so they can never disagree.
 */
export function rebuildProjection(journal: LedgerJournal, accountId?: AccountId): AccountBalances {
  return projectBalances(journal, accountId);
}
