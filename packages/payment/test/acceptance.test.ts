import { describe, expect, it } from 'vitest';
import { GHS, USD } from '@payswap/protocol';
import { asPaymentMethodId, definePaymentMethod } from '../src/method.js';
import {
  defineAcceptancePolicy,
  defineSettlementDestination,
  matchesAcceptance,
  type PaymentAcceptancePolicy,
} from '../src/acceptance.js';

const mobileMoney = definePaymentMethod({
  id: 'pm:mobile-money',
  kind: 'MOBILE_MONEY',
  displayName: 'Mobile Money',
  currencies: [GHS],
  credentialRequirements: [],
});

const bankTransfer = definePaymentMethod({
  id: 'pm:bank',
  kind: 'BANK_TRANSFER',
  displayName: 'Bank Transfer',
  currencies: [GHS, USD],
  credentialRequirements: [],
});

const destination = defineSettlementDestination({
  id: 'dest:merchant-gh',
  kind: 'MOBILE_MONEY_WALLET',
  currency: GHS,
  externalRef: 'momo:0244xxxxxxx',
  provenance: { source: 'merchant-onboarding', reference: 'onb-77', recordedAt: 1_000n },
});

const policy: PaymentAcceptancePolicy = defineAcceptancePolicy({
  id: 'accept:merchant-gh',
  merchantRef: 'merchant:acme',
  methods: ['MOBILE_MONEY', 'BANK_TRANSFER'],
  methodCatalog: [mobileMoney, bankTransfer],
  currencies: [GHS],
  recurring: { supported: true, maxIntervalMs: 2_592_000_000n },
  partialPayments: { supported: true, minAmountBasisPoints: 5_000n },
  refunds: { supported: true, cutoffMs: 1_209_600_000n },
  recourse: 'MERCHANT_DISPUTE_WINDOW',
  customerEligibility: [{ key: 'kyc-tier', requires: '2' }],
  settlementDestination: destination,
  timing: { maxCompletionMs: 86_400_000n },
  remittance: { requiredDocumentKinds: ['INVOICE'] },
  geography: ['GH', 'NG'],
});

describe('defineSettlementDestination', () => {
  it('describes an EXTERNAL destination with provenance — never PaySwap custody', () => {
    expect(destination.kind).toBe('MOBILE_MONEY_WALLET');
    expect(destination.externalRef).toBe('momo:0244xxxxxxx');
    expect(destination.provenance.source).toBe('merchant-onboarding');
    // There is no field on the destination that could represent custody.
    const keys = Object.keys(destination).sort();
    expect(keys).toEqual(['currency', 'externalRef', 'id', 'kind', 'provenance']);
  });

  it('rejects undeclared kinds and malformed provenance', () => {
    expect(() =>
      defineSettlementDestination({
        id: 'dest:x',
        kind: 'PAYSWAP_CUSTODY' as never,
        currency: GHS,
        externalRef: 'x',
        provenance: { source: 's', reference: 'r', recordedAt: 1n },
      }),
    ).toThrow(/kind is not declared/);
    expect(() =>
      defineSettlementDestination({
        id: 'dest:x',
        kind: 'BANK_ACCOUNT',
        currency: GHS,
        externalRef: 'x',
        provenance: { source: '', reference: 'r', recordedAt: 1n },
      }),
    ).toThrow(/provenance/);
  });
});

describe('defineAcceptancePolicy', () => {
  it('rejects catalog entries whose kind is not accepted', () => {
    expect(() =>
      defineAcceptancePolicy({
        ...policy,
        methods: ['MOBILE_MONEY'],
        methodCatalog: [mobileMoney, bankTransfer],
      }),
    ).toThrow(/kind not declared as accepted/);
  });

  it('requires geography, currencies and timing', () => {
    expect(() => defineAcceptancePolicy({ ...policy, geography: [] })).toThrow(/geography/);
    expect(() => defineAcceptancePolicy({ ...policy, currencies: [] })).toThrow(/currency/);
    expect(() =>
      defineAcceptancePolicy({ ...policy, timing: { maxCompletionMs: 0n } }),
    ).toThrow(/maxCompletionMs/);
  });
});

describe('matchesAcceptance (deterministic, explicit reasons)', () => {
  it('accepts a matching request and returns the resolved method', () => {
    const decision = matchesAcceptance(policy, {
      methodId: asPaymentMethodId('pm:mobile-money'),
      currency: GHS,
      country: 'GH',
      payerAttributes: { 'kyc-tier': '2' },
    });
    expect(decision.accepted).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.method?.id).toBe('pm:mobile-money');
  });

  it('rejects on method, currency, recurring, partial, eligibility and geography — with typed reasons', () => {
    const decision = matchesAcceptance(policy, {
      methodId: asPaymentMethodId('pm:bank'),
      currency: USD, // not accepted (only GHS)
      country: 'KE', // not served
      recurring: true, // supported, fine
      partial: true,
      partialBasisPoints: 1_000n, // below 5_000n minimum
      payerAttributes: { 'kyc-tier': '1' }, // unmet
    });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'CURRENCY_NOT_ACCEPTED',
        'GEOGRAPHY_NOT_SERVED',
        'PARTIAL_BELOW_MINIMUM',
        'ELIGIBILITY_CRITERION_UNMET',
      ]),
    );
    expect(decision.reasons).not.toContain('METHOD_NOT_IN_CATALOG');
    expect(decision.reasons).not.toContain('RECURRING_NOT_SUPPORTED');
  });

  it('rejects unknown methods and recurring requests when unsupported', () => {
    expect(
      matchesAcceptance(policy, { methodId: asPaymentMethodId('pm:nonexistent'), currency: GHS })
        .reasons,
    ).toContain('METHOD_NOT_IN_CATALOG');
    const noRecurring = defineAcceptancePolicy({
      ...policy,
      recurring: { supported: false },
    });
    expect(
      matchesAcceptance(noRecurring, {
        methodId: asPaymentMethodId('pm:bank'),
        currency: GHS,
        recurring: true,
      }).reasons,
    ).toContain('RECURRING_NOT_SUPPORTED');
    expect(
      matchesAcceptance(noRecurring, {
        methodId: asPaymentMethodId('pm:bank'),
        currency: GHS,
        recurring: false,
      }).accepted,
    ).toBe(true);
  });

  it('partial payments are rejected outright when unsupported', () => {
    const noPartial = defineAcceptancePolicy({
      ...policy,
      partialPayments: { supported: false },
    });
    expect(
      matchesAcceptance(noPartial, {
        methodId: asPaymentMethodId('pm:bank'),
        currency: GHS,
        partial: true,
        partialBasisPoints: 9_000n,
      }).reasons,
    ).toContain('PARTIAL_PAYMENTS_NOT_SUPPORTED');
  });

  it('is deterministic: identical requests yield identical decisions', () => {
    const request = {
      methodId: asPaymentMethodId('pm:bank'),
      currency: GHS,
      country: 'ng',
    } as const;
    expect(JSON.stringify(matchesAcceptance(policy, request))).toBe(
      JSON.stringify(matchesAcceptance(policy, request)),
    );
  });
});
