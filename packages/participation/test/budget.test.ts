import { describe, expect, it } from 'vitest';
import { asPartyId, InsufficientAvailableFundsError } from '@payswap/protocol';
import {
  BudgetStateConflictError,
  incentiveFundingAccount,
  IncentiveBudgetExhaustedError,
  UnfundedBudgetError,
} from '../src/budget.js';
import { ProgramVersionRegistry, type IncentiveProgramVersion } from '../src/programs.js';
import { fixture, usd } from './helpers.js';

function monetaryProgram(
  overrides?: {
    programId?: IncentiveProgramVersion['programId'];
    totalAmount?: ReturnType<typeof usd>;
    funding?: 'REQUIRES_FUNDED_RESERVATION' | 'EXPLICITLY_CONTINGENT';
    sponsor?: string;
  },
): IncentiveProgramVersion {
  const registry = new ProgramVersionRegistry();
  const programId = overrides?.programId;
  return registry.registerProgram(
    {
      ...(programId !== undefined ? { programId } : {}),
      effectiveFrom: 1_000n,
      sponsor: asPartyId(overrides?.sponsor ?? 'sponsor-1'),
      objective: 'raise verified adoption',
      eligibleRole: 'SENDER',
      eligibilityRules: [{ kind: 'MIN_PROOF_LEVEL', level: 'P1' }],
      contributionEvents: ['PAYMENT_METHOD_ADOPTED'],
      proofRequirements: { minProofLevel: 'P1' },
      reward: {
        mechanism: 'FEE_REBATE',
        formula: { kind: 'FIXED_PER_CONTRIBUTION', amount: usd(500n) },
      },
      budget: {
        totalAmount: overrides?.totalAmount ?? usd(10_000n),
        funding: overrides?.funding ?? 'REQUIRES_FUNDED_RESERVATION',
      },
      antiGamingPolicy: { forbidSelfReferral: true, requireIdentityLinkageChecks: true },
      clawbackPolicy: { clawbackWindowMs: 1_000_000n, requiresDisputeRecord: false },
    },
    'ACTIVE',
  );
}

describe('budget: reservations over the protocol discipline (INV-P01)', () => {
  it('establishes a FUNDED budget as a real protocol reservation + activation', () => {
    const fx = fixture(50_000n);
    const program = monetaryProgram();
    const budget = fx.budgets.establishFundedBudget(program);

    expect(budget.fundingStatus).toBe('FUNDED');
    expect(budget.reservationId).toBeDefined();
    expect(budget.totalAmount.value).toBe(10_000n);
    expect(budget.committed.value).toBe(0n);
    expect(budget.available.value).toBe(10_000n);

    // The hold is visible in the protocol reservation book as ACTIVE.
    const reservationId = budget.reservationId;
    expect(reservationId).toBeDefined();
    const reservation =
      reservationId !== undefined ? fx.reservationState.reservations.get(reservationId) : undefined;
    expect(reservation?.state).toBe('ACTIVE');
    expect(reservation?.accountId).toBe(incentiveFundingAccount(asPartyId('sponsor-1')));
    expect(reservation?.amount.value).toBe(10_000n);
  });

  it('INV-F04 (consumed): funding beyond the funder balance is refused by the protocol', () => {
    const fx = fixture(4_000n); // funder holds only 4_000
    const program = monetaryProgram({ totalAmount: usd(10_000n) });
    expect(() => fx.budgets.establishFundedBudget(program)).toThrow(
      InsufficientAvailableFundsError,
    );
    // Nothing was half-applied: no budget registered, no hold left behind.
    expect(fx.budgets.all()).toHaveLength(0);
    expect(fx.reservationState.reservations.all).toHaveLength(0);
  });

  it('commits are capped at the declared total (no unfunded promises)', () => {
    const fx = fixture(50_000n);
    const program = monetaryProgram();
    fx.budgets.establishFundedBudget(program);
    const ref = { programId: program.programId, version: program.version };

    fx.budgets.commit(ref, usd(6_000n));
    expect(fx.budgets.get(ref.programId, ref.version).committed.value).toBe(6_000n);
    expect(fx.budgets.get(ref.programId, ref.version).available.value).toBe(4_000n);

    expect(() => fx.budgets.commit(ref, usd(4_001n))).toThrow(IncentiveBudgetExhaustedError);
    // The failed commit left the budget untouched.
    expect(fx.budgets.get(ref.programId, ref.version).committed.value).toBe(6_000n);

    fx.budgets.commit(ref, usd(4_000n));
    expect(fx.budgets.get(ref.programId, ref.version).committed.value).toBe(10_000n);
  });

  it('contingency is explicit: declare, accrue-blocked-finalization, then fund', () => {
    const fx = fixture(50_000n);
    const program = monetaryProgram({ funding: 'EXPLICITLY_CONTINGENT' });
    const budget = fx.budgets.declareContingentBudget(program);
    expect(budget.fundingStatus).toBe('CONTINGENT');
    expect(budget.reservationId).toBeUndefined();
    expect(budget.fundingEvents.map((event) => event.kind)).toEqual(['DECLARED_CONTINGENT']);

    // Contingent budgets cannot pass the funding gate…
    expect(() => fx.budgets.assertFunded({ programId: program.programId, version: program.version })).toThrow(
      UnfundedBudgetError,
    );
    // …but they CAN be funded later (append-only funding history).
    const funded = fx.budgets.fundContingentBudget({
      programId: program.programId,
      version: program.version,
    });
    expect(funded.fundingStatus).toBe('FUNDED');
    expect(funded.fundingEvents.map((event) => event.kind)).toEqual([
      'DECLARED_CONTINGENT',
      'CONTINGENT_FUNDED',
    ]);
    expect(() =>
      fx.budgets.assertFunded({ programId: program.programId, version: program.version }),
    ).not.toThrow();
  });

  it('rejects double establishment and unknown budgets', () => {
    const fx = fixture(50_000n);
    const program = monetaryProgram();
    fx.budgets.establishFundedBudget(program);
    expect(() => fx.budgets.establishFundedBudget(program)).toThrow(BudgetStateConflictError);
    expect(() => fx.budgets.get(program.programId, 99n)).toThrow();
    expect(() => fx.budgets.commit({ programId: program.programId, version: 99n }, usd(1n))).toThrow();
  });
  it('releases the remaining reservation at close-out and records the event', () => {
    const fx = fixture(50_000n);
    const program = monetaryProgram();
    fx.budgets.establishFundedBudget(program);
    const ref = { programId: program.programId, version: program.version };
    fx.budgets.commit(ref, usd(3_000n));

    const released = fx.budgets.releaseBudget(ref);
    expect(released.fundingEvents.map((event) => event.kind)).toEqual([
      'ESTABLISHED_FUNDED',
      'RELEASED',
    ]);
    const releasedId = released.reservationId;
    const reservation =
      releasedId !== undefined ? fx.reservationState.reservations.get(releasedId) : undefined;
    expect(reservation?.state).toBe('RELEASED');
    // Funding history was appended, never rewritten.
    expect(released.committed.value).toBe(3_000n);
  });
});
