import { describe, expect, expectTypeOf, it } from 'vitest';
import { GHS, USD, fromMinorUnits } from '@payswap/protocol';
import {
  asPaymentMethodId,
  asRailCapabilityRef,
  defineCredentialCapability,
  definePaymentMethod,
  methodSupportsCurrency,
  requiredCredentialKinds,
  type PaymentCredentialCapability,
  type PaymentMethod,
} from '../src/method.js';

/**
 * TEST-LOCAL structural fixture describing what a rail capability looks
 * like in the capability plane (W2-003 owns the canonical vocabulary; this
 * local shape exists ONLY to prove the type separation and is NOT a
 * contract of this package).
 */
interface RailCapabilityFixture {
  readonly id: string;
  readonly rail: string;
  readonly supportedCurrencies: readonly string[];
  readonly executionMode: 'PASS_THROUGH_NATIVE' | 'COMPOSED_PAYSWAP' | 'OPTIMIZED_MULTI_PROVIDER';
}

const mobileMoneyMethod: PaymentMethod = definePaymentMethod({
  id: 'pm:mobile-money',
  kind: 'MOBILE_MONEY',
  displayName: 'Mobile Money',
  currencies: [GHS, USD],
  credentialRequirements: [
    defineCredentialCapability({
      id: 'cred:mm-auth',
      kind: 'MOBILE_MONEY_AUTHORIZATION',
      required: true,
      scope: 'charge the payer mobile-money wallet up to the presented amount',
    }),
    defineCredentialCapability({
      id: 'cred:mm-token',
      kind: 'TOKEN',
      required: false,
      scope: 'stored token for faster re-authorization',
    }),
  ],
});

describe('PaymentMethod vs RailCapability separation (FROZEN §6A)', () => {
  it('PaymentMethod is NOT assignable to a rail capability type, and vice versa', () => {
    const railCapability: RailCapabilityFixture = {
      id: 'rail:mobile-money:gh',
      rail: 'mobile-money',
      supportedCurrencies: [GHS],
      executionMode: 'COMPOSED_PAYSWAP',
    };
    // A PaymentMethod is not a RailCapability…
    expectTypeOf(mobileMoneyMethod).not.toMatchTypeOf<RailCapabilityFixture>();
    // …and a RailCapability is not a PaymentMethod.
    expectTypeOf(railCapability).not.toMatchTypeOf<PaymentMethod>();
    // Runtime sanity: the two objects genuinely differ in shape.
    expect(mobileMoneyMethod.kind).toBe('MOBILE_MONEY');
    expect(railCapability.executionMode).toBe('COMPOSED_PAYSWAP');
    expect('executionMode' in mobileMoneyMethod).toBe(false);
    expect('credentialRequirements' in railCapability).toBe(false);
  });

  it('brands keep method ids and rail refs from being interchangeable', () => {
    const methodId = asPaymentMethodId('pm:mobile-money');
    const railRef = asRailCapabilityRef('rail:mobile-money:gh');
    expectTypeOf(methodId).not.toMatchTypeOf<typeof railRef>();
    expect(methodId).toBe('pm:mobile-money');
    expect(railRef).toBe('rail:mobile-money:gh');
  });

  it('railHint stays an opaque reference the payment plane never interprets', () => {
    const method = definePaymentMethod({
      id: 'pm:card',
      kind: 'CARD',
      displayName: 'Card',
      currencies: [USD],
      credentialRequirements: [],
      railHint: 'rail:card-scheme:visa',
    });
    expect(method.railHint).toBe(asRailCapabilityRef('rail:card-scheme:visa'));
    // The method still does not expose capability-plane execution fields.
    expectTypeOf(method).not.toMatchTypeOf<RailCapabilityFixture>();
  });
});

describe('definePaymentMethod / defineCredentialCapability', () => {
  it('validates kinds, currencies and credential uniqueness', () => {
    expect(() =>
      definePaymentMethod({
        id: 'pm:x',
        kind: 'CARRIER_PIGEON' as never,
        displayName: 'X',
        currencies: [USD],
        credentialRequirements: [],
      }),
    ).toThrow(/kind is not declared/);
    expect(() =>
      definePaymentMethod({
        id: 'pm:x',
        kind: 'CARD',
        displayName: 'X',
        currencies: [],
        credentialRequirements: [],
      }),
    ).toThrow(/at least one currency/);
    const duplicated: readonly PaymentCredentialCapability[] = [
      defineCredentialCapability({
        id: 'cred:dup',
        kind: 'TOKEN',
        required: true,
        scope: 'a',
      }),
      defineCredentialCapability({
        id: 'cred:dup',
        kind: 'MANDATE',
        required: true,
        scope: 'b',
      }),
    ];
    expect(() =>
      definePaymentMethod({
        id: 'pm:x',
        kind: 'CARD',
        displayName: 'X',
        currencies: [USD],
        credentialRequirements: duplicated,
      }),
    ).toThrow(/must not repeat/);
  });

  it('lists required credential kinds deterministically in declared order', () => {
    expect(requiredCredentialKinds(mobileMoneyMethod)).toEqual(['MOBILE_MONEY_AUTHORIZATION']);
  });

  it('checks presentation currency support deterministically', () => {
    expect(methodSupportsCurrency(mobileMoneyMethod, GHS)).toBe(true);
    expect(methodSupportsCurrency(mobileMoneyMethod, USD)).toBe(true);
    expect(methodSupportsCurrency(mobileMoneyMethod, 'JPY' as never)).toBe(false);
  });

  it('exact money fixtures stay exact (INV-F01 sanity for this package)', () => {
    expect(fromMinorUnits(GHS, 10n).value).toBe(10n);
  });
});
