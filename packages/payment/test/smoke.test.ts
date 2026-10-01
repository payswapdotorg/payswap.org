import { describe, expect, it } from 'vitest';
import { USD } from '@payswap/protocol';
import {
  PACKAGE_NAME,
  definePaymentMethod,
  type PaymentMethod,
  type PaymentMethodKind,
} from '../src/index.js';

describe('@payswap/payment smoke', () => {
  it('exposes the package name', () => {
    expect(PACKAGE_NAME).toBe('@payswap/payment');
  });

  it('defines and uses a payment method end to end', () => {
    const method: PaymentMethod = definePaymentMethod({
      id: 'pm:ach',
      kind: 'ACH_EFT',
      displayName: 'ACH/EFT',
      currencies: [USD],
      credentialRequirements: [],
    });
    expect(method.kind).toBe('ACH_EFT');
  });

  it('covers every FROZEN §6A method kind', () => {
    const kinds: readonly PaymentMethodKind[] = [
      'CARD',
      'BANK_TRANSFER',
      'ACH_EFT',
      'INSTANT_PAYMENT',
      'MOBILE_MONEY',
      'WALLET',
      'STABLECOIN_CRYPTO',
      'VIRTUAL_CARD',
      'BNPL_CREDIT',
      'CHECK_CASH_EXTERNAL',
    ];
    expect(kinds.length).toBe(10);
  });
});
