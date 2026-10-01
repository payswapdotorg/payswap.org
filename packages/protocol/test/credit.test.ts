import { describe, expect, it } from 'vitest';
import {
  DeterministicClock,
  USD,
  createIdFactory,
  fromMinorUnits,
  type Money,
} from '../src/index.js';
import {
  CreditLimitExceededError,
  CreditLineExpiredError,
  CreditRepaymentExceedsUtilizationError,
  asCreditLineId,
  frontValueForDelay,
  openCreditLine,
  repayCredit,
  type CreditLine,
} from '../src/credit.js';
import { defineCollateral, asCollateralId } from '../src/collateral.js';
import { asClearingRecordId, asObligationId, asPartyId, type Obligation } from '../src/obligation.js';
import { canDelay, type DelayPolicy } from '../src/netting.js';

function usd(minorUnits: bigint): Money {
  return fromMinorUnits(USD, minorUnits);
}

function pendingObligation(id: string, debtor: string, creditor: string, amount: Money): Obligation {
  return Object.freeze({
    id: asObligationId(id),
    debtor: asPartyId(debtor),
    creditor: asPartyId(creditor),
    amount,
    dueWindow: { opensAt: 1_500n, closesAt: 10_000n },
    state: 'PENDING',
    derivedFrom: asClearingRecordId('clr-test'),
  });
}

function collateral(): ReturnType<typeof defineCollateral> {
  return defineCollateral({
    id: 'col-1',
    kind: 'CASH_DEPOSIT',
    owner: asPartyId('bob'),
    description: 'cash deposit pledged against the delay-backing line',
    appraisedValue: usd(5_000n),
    appraisedAsOf: 1_000n,
    provenance: { source: 'custodian-statement', reference: 'stmt-42', recordedAt: 1_000n },
  });
}

describe('openCreditLine', () => {
  it('opens an explicit zero-utilization line with collateral attached', () => {
    const clock = new DeterministicClock(1_000n);
    const line = openCreditLine(
      {
        id: 'cl-1',
        creditor: asPartyId('fintech-fronting'),
        debtor: asPartyId('alice'),
        limit: usd(1_000n),
        currency: USD,
        expiry: 50_000n,
        collateral: [collateral()],
      },
      clock,
    );
    expect(line.id).toBe(asCreditLineId('cl-1'));
    expect(line.utilized.value).toBe(0n);
    expect(line.collateral.length).toBe(1);
    expect(line.collateral[0]?.id).toBe(asCollateralId('col-1'));
  });

  it('rejects already-expired lines, self-lines and non-positive limits', () => {
    const clock = new DeterministicClock(1_000n);
    expect(() =>
      openCreditLine(
        {
          id: 'cl-x',
          creditor: asPartyId('a'),
          debtor: asPartyId('b'),
          limit: usd(10n),
          currency: USD,
          expiry: 1_000n,
        },
        clock,
      ),
    ).toThrow(CreditLineExpiredError);
    expect(() =>
      openCreditLine(
        {
          id: 'cl-x',
          creditor: asPartyId('a'),
          debtor: asPartyId('a'),
          limit: usd(10n),
          currency: USD,
          expiry: 50_000n,
        },
        clock,
      ),
    ).toThrow(/same party/);
    expect(() =>
      openCreditLine(
        {
          id: 'cl-x',
          creditor: asPartyId('a'),
          debtor: asPartyId('b'),
          limit: usd(0n),
          currency: USD,
          expiry: 50_000n,
        },
        clock,
      ),
    ).toThrow(/positive/);
  });
});

describe('INV-F08: delayed settlement backed by a third party', () => {
  const policy: DelayPolicy = {
    delayAllowed: true,
    maxDelayMs: 10_000n,
    requiresExplicitBacking: true,
  };

  function line(): CreditLine {
    const clock = new DeterministicClock(1_000n);
    return openCreditLine(
      {
        id: 'cl-1',
        creditor: asPartyId('fintech-fronting'),
        debtor: asPartyId('alice'),
        limit: usd(1_000n),
        currency: USD,
        expiry: 50_000n,
        collateral: [collateral()],
      },
      clock,
    );
  }

  it('a permitted delay backed by a third party ALWAYS produces an explicit CreditExposure', () => {
    const clock = new DeterministicClock(2_000n);
    const ids = createIdFactory(clock);
    const obligation = pendingObligation('o-1', 'alice', 'merchant', usd(400n));

    // 1. the delay itself is permitted and flags explicit backing
    const decision = canDelay(obligation, 20_000n, policy, clock);
    expect(decision.canDelay).toBe(true);
    expect(decision.requiresExplicitBacking).toBe(true);

    // 2. backing the delay draws the line AND returns an exposure record
    const { line: updatedLine, exposure } = frontValueForDelay(
      line(),
      obligation,
      usd(400n),
      clock,
      ids,
    );
    expect(updatedLine.utilized.value).toBe(400n);
    expect(exposure.lineId).toBe(asCreditLineId('cl-1'));
    expect(exposure.outstanding.value).toBe(400n);
    expect(exposure.derivation.reason).toBe('DELAYED_SETTLEMENT_BACKING');
    expect(exposure.derivation.backingObligation).toBe(asObligationId('o-1'));
    expect(exposure.derivation.amountDrawn.value).toBe(400n);
    expect(exposure.derivation.utilizationBefore.value).toBe(0n);
    // the exposure restates the securing collateral — nothing is unsecured
    expect(exposure.collateral.length).toBe(1);
  });

  it('there is no silent path: the draw result ALWAYS couples line + exposure', () => {
    const clock = new DeterministicClock(2_000n);
    const ids = createIdFactory(clock);
    const obligation = pendingObligation('o-1', 'alice', 'merchant', usd(400n));
    const result = frontValueForDelay(line(), obligation, usd(100n), clock, ids);
    // structural coupling: the record exists on every draw, with a distinct id per use
    expect(typeof result.exposure.id).toBe('string');
    expect(result.exposure.id.length).toBeGreaterThan(0);
    const second = frontValueForDelay(result.line, obligation, usd(100n), clock, ids);
    expect(second.exposure.id).not.toBe(result.exposure.id);
    expect(second.exposure.outstanding.value).toBe(200n);
  });

  it('rejects draws over the limit, after expiry, and for foreign debtors', () => {
    const clock = new DeterministicClock(2_000n);
    const ids = createIdFactory(clock);
    const obligation = pendingObligation('o-1', 'alice', 'merchant', usd(400n));
    const small = { ...line(), limit: usd(150n) };
    expect(() => frontValueForDelay(small, obligation, usd(400n), clock, ids)).toThrow(
      CreditLimitExceededError,
    );
    const expired = { ...line(), expiry: 1_500n };
    expect(() => frontValueForDelay(expired, obligation, usd(10n), clock, ids)).toThrow(
      CreditLineExpiredError,
    );
    const foreignObligation = pendingObligation('o-2', 'bob', 'merchant', usd(10n));
    expect(() => frontValueForDelay(line(), foreignObligation, usd(10n), clock, ids)).toThrow(
      /obligation debtor/,
    );
    const settled = { ...obligation, state: 'SETTLED' as const };
    expect(() => frontValueForDelay(line(), settled, usd(10n), clock, ids)).toThrow(/PENDING/);
  });
});

describe('repayCredit', () => {
  it('reduces utilization explicitly and never overshoots', () => {
    const clock = new DeterministicClock(2_000n);
    const ids = createIdFactory(clock);
    const obligation = pendingObligation('o-1', 'alice', 'merchant', usd(400n));
    const base = openCreditLine(
      {
        id: 'cl-1',
        creditor: asPartyId('fintech-fronting'),
        debtor: asPartyId('alice'),
        limit: usd(1_000n),
        currency: USD,
        expiry: 50_000n,
      },
      new DeterministicClock(1_000n),
    );
    const { line: drawn } = frontValueForDelay(base, obligation, usd(300n), clock, ids);
    const { line: repaid, repayment } = repayCredit(
      drawn,
      usd(120n),
      clock,
      ids,
      'settlement:si-1',
    );
    expect(repaid.utilized.value).toBe(180n);
    expect(repayment.utilizedAfter.value).toBe(180n);
    expect(repayment.settlementRef).toBe('settlement:si-1');
    expect(() => repayCredit(repaid, usd(1_000n), clock, ids)).toThrow(
      CreditRepaymentExceedsUtilizationError,
    );
  });
});
