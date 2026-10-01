/**
 * W3-004 test helpers — fully deterministic fixtures.
 *
 * Determinism discipline: every clock is a `DeterministicClock`, every id
 * factory is seeded from that clock, every journal balance is posted through
 * the real protocol journal (no fake balances). No Math.random, no ambient
 * host time, no timers.
 */

import {
  DeterministicClock,
  USD,
  asPartyId,
  createIdFactory,
  fromMinorUnits,
  InMemoryLedgerJournal,
  InMemoryObligationBook,
  InMemoryReservationBook,
  accountId,
  createJournalEntry,
  postJournal,
  type IdFactory,
  type LedgerJournal,
  type Money,
  type ObligationBook,
  type PartyId,
  type ReservationLedgerState,
  type TimestampMs,
} from '@payswap/protocol';
import { IncentiveBudgetLedger } from '../src/budget.js';
import { incentiveFundingAccount } from '../src/budget.js';
import { asContributionId } from '../src/contributions.js';
import type { EvidenceReference, ProofLevel } from '../src/evidence.js';
import type { ContributionRecord } from '../src/contributions.js';
import type { ProgramVersionRef } from '../src/programs.js';

export const T0 = 1_000_000n;

export function usd(minorUnits: bigint): Money {
  return fromMinorUnits(USD, minorUnits);
}

export interface FixtureState {
  readonly clock: DeterministicClock;
  readonly ids: IdFactory;
  readonly journal: LedgerJournal;
  readonly reservationState: ReservationLedgerState;
  readonly budgets: IncentiveBudgetLedger;
  readonly obligations: ObligationBook;
}

/**
 * Deterministic fixture: a journal with the funder's incentive account
 * seeded through a balanced double-entry posting (real INV-F03 discipline),
 * the protocol reservation state, the budget ledger and an obligation book.
 */
export function fixture(funderBalanceMinorUnits: bigint, seedMs: TimestampMs = T0): FixtureState {
  const clock = new DeterministicClock(seedMs);
  const ids = createIdFactory(clock);
  const journal = new InMemoryLedgerJournal();
  if (funderBalanceMinorUnits > 0n) {
    const funding = incentiveFundingAccount(asPartyId('sponsor-1'));
    const equity = accountId('EQUITY', 'opening.usd');
    postJournal(
      journal,
      createJournalEntry(
        {
          lines: [
            { accountId: funding, amount: usd(funderBalanceMinorUnits) },
            { accountId: equity, amount: usd(-funderBalanceMinorUnits) },
          ],
          memo: 'deterministic funder seeding',
        },
        { ids, clock },
      ),
    );
  }
  const reservationState: ReservationLedgerState = {
    journal,
    reservations: new InMemoryReservationBook(),
    ids: createIdFactory(clock),
    clock,
  };
  return {
    clock,
    ids,
    journal,
    reservationState,
    budgets: new IncentiveBudgetLedger(reservationState),
    obligations: new InMemoryObligationBook(),
  };
}

export function evidence(kind: string, locator: string, level: ProofLevel): EvidenceReference {
  return { kind, locator, level };
}

export interface ContributionSpec {
  readonly id: string;
  readonly actor: string;
  readonly actorRole?: ContributionRecord['actorRole'];
  readonly behavior?: string;
  readonly quantity?: bigint;
  readonly value?: Money;
  readonly occurredAt?: TimestampMs;
  readonly outcome?: ContributionRecord['outcome'];
  readonly counterparty?: PartyId;
  readonly programVersion?: ProgramVersionRef;
  readonly evidenceLevel?: ProofLevel;
}

/**
 * A minimal qualifying contribution: P2 rail evidence, direct attribution,
 * VERIFIED_COMPLETED outcome. Everything is overridable per test.
 */
export function contribution(spec: ContributionSpec): ContributionRecord {
  const actorRole = spec.actorRole ?? 'SENDER';
  const refs: readonly EvidenceReference[] = [
    evidence('rail_receipt', `evd:${spec.id}:receipt`, spec.evidenceLevel ?? 'P2'),
  ];
  const attribution = {
    attributedActor: spec.actor as PartyId,
    creditedRole: actorRole,
    basis: 'DIRECT_EVIDENCE' as const,
    evidenceRefs: refs.map((reference) => reference.locator),
    decisionTrace: [
      {
        ruleId: 'direct:participant',
        matched: true,
        note: 'direct participation evidence matched',
      },
    ],
  };
  const record: {
    -readonly [K in keyof ContributionRecord]: ContributionRecord[K];
  } = {
    id: asContributionId(spec.id),
    actor: spec.actor as PartyId,
    actorRole,
    behavior: spec.behavior ?? 'PAYMENT_METHOD_ADOPTED',
    affectedObjects: [{ objectType: 'payment_intent', objectId: `pi_${spec.id}` }],
    quantity: spec.quantity ?? 1n,
    occurredAt: spec.occurredAt ?? T0,
    outcome: spec.outcome ?? 'VERIFIED_COMPLETED',
    evidence: refs,
    attribution,
  };
  if (spec.value !== undefined) record.value = spec.value;
  if (spec.counterparty !== undefined) record.counterparty = spec.counterparty;
  if (spec.programVersion !== undefined) record.programVersion = spec.programVersion;
  return Object.freeze(record);
}
