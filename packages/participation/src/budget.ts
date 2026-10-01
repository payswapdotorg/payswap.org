/**
 * @payswap/participation — incentive budget reservations (W3-004).
 *
 * PARTICIPATION-ENGINEERING §Funding: a monetary campaign requires an
 * IncentiveBudgetReservation before rewards can become final unless the
 * program explicitly makes funding contingency visible.
 *
 * INV-P01 (monetary incentives are funded or explicitly contingent) is
 * implemented on top of the @payswap/protocol reservation discipline
 * (W1-002) — CONSUMED, never reimplemented:
 * - a FUNDED budget is a protocol `reserve()` hold on the funder's incentive
 *   funding account (an append-only journal projection, INV-F04: the hold can
 *   never exceed authorized available value) followed by `ACTIVATE`;
 * - an EXPLICITLY_CONTINGENT budget is a declared, visible state with NO
 *   reservation: rewards under it may exist at PROVISIONAL but can never be
 *   finalized (rewards.ts throws `UnfundedRewardFinalizationError`);
 * - funding events (establishment, contingency conversion, release) are
 *   recorded append-only — the funding ledger is never rewritten.
 *
 * Budget headroom discipline: `commit` reserves budget capacity for a
 * PROVISIONAL accrual the moment it is promised (AGENTS.md rule 13: budgets
 * are reserved before a program can promise funded monetary rewards); the
 * sum of committed amounts can never exceed the declared total.
 */

import {
  add,
  asAccountId,
  asPartyId,
  compare,
  fromMinorUnits,
  InsufficientAvailableFundsError,
  PaySwapError,
  reserve,
  activateReservation,
  captureReservation,
  releaseReservation,
  sub,
  ValidationError,
  type AccountId,
  type CurrencyCode,
  type Money,
  type PartyId,
  type ReservationId,
  type ReservationLedgerState,
} from '@payswap/protocol';
import type { IncentiveProgramVersion, ProgramVersionRef } from './programs.js';

/** Funding status of one program-version budget. */
export type IncentiveBudgetFundingStatus = 'FUNDED' | 'CONTINGENT';

/** Append-only funding event record (history is never rewritten). */
export interface FundingEvent {
  readonly kind: 'ESTABLISHED_FUNDED' | 'DECLARED_CONTINGENT' | 'CONTINGENT_FUNDED' | 'RELEASED' | 'CAPTURED';
  readonly at: bigint;
  readonly reservationId?: ReservationId;
  readonly note: string;
}

/** State of one program-version budget (a projection over funding events). */
export interface IncentiveBudgetState {
  readonly programId: string;
  readonly version: bigint;
  readonly funder: PartyId;
  readonly currency: CurrencyCode;
  readonly totalAmount: Money;
  readonly fundingStatus: IncentiveBudgetFundingStatus;
  readonly reservationId?: ReservationId;
  readonly committed: Money;
  readonly available: Money;
  readonly fundingEvents: readonly FundingEvent[];
}

/** No budget registered for the program version. */
export class UnknownBudgetError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'UNKNOWN_INCENTIVE_BUDGET', category: 'NOT_FOUND', message, details });
    this.name = 'UnknownBudgetError';
  }
}

/** Committing would exceed the declared budget total (INV-P01 headroom). */
export class IncentiveBudgetExhaustedError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'INCENTIVE_BUDGET_EXHAUSTED', category: 'POLICY_BLOCKED', message, details });
    this.name = 'IncentiveBudgetExhaustedError';
  }
}

/** The budget exists but is not funded (no active protocol reservation). */
export class UnfundedBudgetError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'UNFUNDED_INCENTIVE_BUDGET', category: 'POLICY_BLOCKED', message, details });
    this.name = 'UnfundedBudgetError';
  }
}

/** A budget already exists / is already funded for the program version. */
export class BudgetStateConflictError extends PaySwapError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'INCENTIVE_BUDGET_CONFLICT', category: 'CONFLICT', message, details });
    this.name = 'BudgetStateConflictError';
  }
}

/**
 * Deterministic mapping from a funder PartyId to its incentive funding
 * account in the protocol chart of accounts (`ASSET:incentive.<sanitized>`).
 * Characters outside the account-name alphabet are folded to `.` — the
 * mapping is injective enough for funding-account derivation and is stable
 * across runs.
 */
export function incentiveFundingAccount(funder: PartyId): AccountId {
  const sanitized = funder.replace(/[^A-Za-z0-9._-]/g, '.');
  const safeName = sanitized.length === 0 ? 'funder' : sanitized.slice(0, 120);
  return asAccountId(`ASSET:incentive.${safeName}`);
}

/**
 * The incentive budget ledger: establishes protocol reservations for funded
 * budgets, tracks contingency explicitly, and enforces commit headroom for
 * every reward promise made under a program version.
 */
export class IncentiveBudgetLedger {
  private readonly _protocol: ReservationLedgerState;
  private readonly _budgets = new Map<string, IncentiveBudgetState>();

  constructor(protocol: ReservationLedgerState) {
    this._protocol = protocol;
  }

  /**
   * Establish a FUNDED budget for a program version: places a protocol
   * reservation on the funder's incentive funding account (INV-F04 — throws
   * `InsufficientAvailableFundsError` when the funder lacks authorized
   * available value) and activates the hold.
   */
  establishFundedBudget(program: IncentiveProgramVersion): IncentiveBudgetState {
    this._assertNoBudget(program.programId, program.version);
    this._assertCurrency(program);
    const funder = asPartyId(program.sponsor);
    const now = this._protocol.clock.now();
    const reservation = reserve(this._protocol, {
      accountId: incentiveFundingAccount(funder),
      amount: program.budget.totalAmount,
      refs: {
        correlationId: `${program.programId}@${program.version}`,
      },
    });
    activateReservation(this._protocol, reservation.id);
    const budget: IncentiveBudgetState = Object.freeze({
      programId: program.programId,
      version: program.version,
      funder,
      currency: program.budget.totalAmount.currency,
      totalAmount: program.budget.totalAmount,
      fundingStatus: 'FUNDED',
      reservationId: reservation.id,
      committed: zeroOf(program.budget.totalAmount.currency),
      available: program.budget.totalAmount,
      fundingEvents: Object.freeze([
        Object.freeze({
          kind: 'ESTABLISHED_FUNDED' as const,
          at: now,
          reservationId: reservation.id,
          note: 'funded via protocol reservation + activation',
        }),
      ]),
    });
    this._budgets.set(this._key(program.programId, program.version), budget);
    return budget;
  }

  /**
   * Establish an EXPLICITLY CONTINGENT budget: funding is declared visible
   * but NOT reserved. Rewards under it stay PROVISIONAL — finalization is
   * impossible until `fundContingentBudget` succeeds (INV-P01).
   */
  declareContingentBudget(program: IncentiveProgramVersion): IncentiveBudgetState {
    this._assertNoBudget(program.programId, program.version);
    this._assertCurrency(program);
    const budget: IncentiveBudgetState = Object.freeze({
      programId: program.programId,
      version: program.version,
      funder: asPartyId(program.sponsor),
      currency: program.budget.totalAmount.currency,
      totalAmount: program.budget.totalAmount,
      fundingStatus: 'CONTINGENT',
      committed: zeroOf(program.budget.totalAmount.currency),
      available: zeroOf(program.budget.totalAmount.currency),
      fundingEvents: Object.freeze([
        Object.freeze({
          kind: 'DECLARED_CONTINGENT' as const,
          at: this._protocol.clock.now(),
          note: 'funding explicitly contingent — no reservation held',
        }),
      ]),
    });
    this._budgets.set(this._key(program.programId, program.version), budget);
    return budget;
  }

  /**
   * Convert a CONTINGENT budget to FUNDED by placing the protocol
   * reservation now. Funding events are appended (never rewritten).
   */
  fundContingentBudget(ref: ProgramVersionRef): IncentiveBudgetState {
    const budget = this.get(ref.programId, ref.version);
    if (budget.fundingStatus === 'FUNDED') {
      throw new BudgetStateConflictError('budget is already funded', {
        programId: budget.programId,
        version: budget.version,
      });
    }
    const reservation = reserve(this._protocol, {
      accountId: incentiveFundingAccount(budget.funder),
      amount: budget.totalAmount,
      refs: { correlationId: `${budget.programId}@${budget.version}` },
    });
    activateReservation(this._protocol, reservation.id);
    const funded: IncentiveBudgetState = Object.freeze({
      ...budget,
      fundingStatus: 'FUNDED',
      reservationId: reservation.id,
      available: sub(budget.totalAmount, budget.committed),
      fundingEvents: Object.freeze([
        ...budget.fundingEvents,
        Object.freeze({
          kind: 'CONTINGENT_FUNDED' as const,
          at: this._protocol.clock.now(),
          reservationId: reservation.id,
          note: 'contingency resolved: protocol reservation placed and activated',
        }),
      ]),
    });
    this._budgets.set(this._key(ref.programId, ref.version), funded);
    return funded;
  }

  /**
   * Commit budget headroom for one reward promise (called at accrual time).
   * Enforces committed + amount ≤ totalAmount — an over-promise throws
   * `IncentiveBudgetExhaustedError` and leaves the budget untouched.
   */
  commit(ref: ProgramVersionRef, amount: Money): IncentiveBudgetState {
    const budget = this.get(ref.programId, ref.version);
    if (amount.value <= 0n) {
      throw new ValidationError('committed amounts must be positive Money');
    }
    if (amount.currency !== budget.currency) {
      throw new ValidationError('committed currency differs from the budget currency', {
        budget: budget.currency,
        committed: amount.currency,
      });
    }
    if (compare(add(budget.committed, amount), budget.totalAmount) > 0) {
      throw new IncentiveBudgetExhaustedError(
        'committing this reward promise would exceed the declared incentive budget (INV-P01)',
        {
          programId: budget.programId,
          version: budget.version,
          total: budget.totalAmount.value.toString(),
          committed: budget.committed.value.toString(),
          attempted: amount.value.toString(),
        },
      );
    }
    const committed = add(budget.committed, amount);
    const updated: IncentiveBudgetState = Object.freeze({
      ...budget,
      committed,
      available: sub(budget.totalAmount, committed),
    });
    this._budgets.set(this._key(ref.programId, ref.version), updated);
    return updated;
  }

  /**
   * Release committed headroom when a provisional accrual expires or is
   * clawed back before finalization (the promise no longer binds budget).
   */
  releaseCommitment(ref: ProgramVersionRef, amount: Money): IncentiveBudgetState {
    const budget = this.get(ref.programId, ref.version);
    if (amount.value <= 0n) {
      throw new ValidationError('released amounts must be positive Money');
    }
    if (amount.currency !== budget.currency) {
      throw new ValidationError('released currency differs from the budget currency');
    }
    if (compare(amount, budget.committed) > 0) {
      throw new IncentiveBudgetExhaustedError(
        'cannot release more budget than is committed',
        { committed: budget.committed.value.toString(), attempted: amount.value.toString() },
      );
    }
    const committed = sub(budget.committed, amount);
    const updated: IncentiveBudgetState = Object.freeze({
      ...budget,
      committed,
      available: sub(budget.totalAmount, committed),
    });
    this._budgets.set(this._key(ref.programId, ref.version), updated);
    return updated;
  }

  /** Assert the budget is FUNDED — otherwise throw `UnfundedBudgetError`. */
  assertFunded(ref: ProgramVersionRef): void {
    const budget = this.get(ref.programId, ref.version);
    if (budget.fundingStatus !== 'FUNDED') {
      throw new UnfundedBudgetError(
        'the program version budget is explicitly contingent — unfunded rewards cannot become final (INV-P01)',
        { programId: budget.programId, version: budget.version, status: budget.fundingStatus },
      );
    }
  }

  /** Whether the program version budget is FUNDED right now. */
  isFunded(ref: ProgramVersionRef): boolean {
    return this.get(ref.programId, ref.version).fundingStatus === 'FUNDED';
  }

  /** Snapshot of one program-version budget (frozen). */
  get(programId: string, version: bigint): IncentiveBudgetState {
    const budget = this._budgets.get(this._key(programId, version));
    if (budget === undefined) {
      throw new UnknownBudgetError('no incentive budget registered for the program version', {
        programId,
        version: version.toString(),
      });
    }
    return budget;
  }

  /**
   * Release the remaining (uncaptured) protocol reservation for a program
   * version — used when a program version closes with unspent budget. The
   * funding history records the release; nothing is rewritten.
   */
  releaseBudget(ref: ProgramVersionRef): IncentiveBudgetState {
    const budget = this.get(ref.programId, ref.version);
    if (budget.reservationId === undefined) {
      throw new BudgetStateConflictError('contingent budgets hold no reservation to release', {
        programId: budget.programId,
      });
    }
    releaseReservation(this._protocol, budget.reservationId);
    const released: IncentiveBudgetState = Object.freeze({
      ...budget,
      fundingStatus: 'CONTINGENT',
      fundingEvents: Object.freeze([
        ...budget.fundingEvents,
        Object.freeze({
          kind: 'RELEASED' as const,
          at: this._protocol.clock.now(),
          reservationId: budget.reservationId,
          note: 'remaining reservation released',
        }),
      ]),
    });
    this._budgets.set(this._key(ref.programId, ref.version), released);
    return released;
  }

  /**
   * Capture the protocol reservation once the program version's funding is
   * settled (terminal close-out of the hold).
   */
  captureBudget(ref: ProgramVersionRef): IncentiveBudgetState {
    const budget = this.get(ref.programId, ref.version);
    if (budget.reservationId === undefined) {
      throw new BudgetStateConflictError('contingent budgets hold no reservation to capture', {
        programId: budget.programId,
      });
    }
    captureReservation(this._protocol, budget.reservationId);
    const captured: IncentiveBudgetState = Object.freeze({
      ...budget,
      fundingEvents: Object.freeze([
        ...budget.fundingEvents,
        Object.freeze({
          kind: 'CAPTURED' as const,
          at: this._protocol.clock.now(),
          reservationId: budget.reservationId,
          note: 'reservation captured at program close-out',
        }),
      ]),
    });
    this._budgets.set(this._key(ref.programId, ref.version), captured);
    return captured;
  }

  /** All budgets (frozen snapshots), keyed insertion order. */
  all(): readonly IncentiveBudgetState[] {
    return Object.freeze([...this._budgets.values()]);
  }

  private _assertNoBudget(programId: string, version: bigint): void {
    if (this._budgets.has(this._key(programId, version))) {
      throw new BudgetStateConflictError('a budget already exists for this program version', {
        programId,
        version: version.toString(),
      });
    }
  }

  private _assertCurrency(program: IncentiveProgramVersion): void {
    if (program.budget.totalAmount.value < 0n) {
      throw new ValidationError('program budget total must be non-negative');
    }
  }

  private _key(programId: string, version: bigint): string {
    return `${programId}@${version}`;
  }
}

function zeroOf(currency: CurrencyCode): Money {
  return fromMinorUnits(currency, 0n);
}

export { InsufficientAvailableFundsError };
