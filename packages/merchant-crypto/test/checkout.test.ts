import { describe, expect, it } from 'vitest';
import {
  TerminalStateViolationError,
  TransitionGuardError,
  ValidationError,
  currencyCode,
  fromMinorUnits,
} from '@payswap/protocol';
import {
  defineAcceptancePolicy,
  defineCredentialCapability,
  definePaymentMethod,
  defineSettlementDestination,
} from '@payswap/payment';
import {
  cancelMerchantCheckoutSession,
  completeMerchantCheckoutSession,
  defineCryptoAmount,
  defineCryptoAsset,
  defineCryptoAssetAcceptance,
  defineMerchantCryptoAcceptancePolicy,
  defineMerchantPaymentIntent,
  expireMerchantCheckoutSession,
  openMerchantCheckoutSession,
  type MerchantPaymentIntent,
} from '../src/index.js';

const EUR = currencyCode('EUR');

const cryptoMethod = definePaymentMethod({
  id: 'pm:stablecoin-crypto',
  kind: 'STABLECOIN_CRYPTO',
  displayName: 'Stablecoin (crypto)',
  currencies: [EUR],
  credentialRequirements: [
    defineCredentialCapability({
      id: 'cred-crypto',
      kind: 'TOKEN',
      required: true,
      scope: 'wallet authorization',
    }),
  ],
});

const basePolicy = defineAcceptancePolicy({
  id: 'ap-1',
  merchantRef: 'merchant-1',
  methods: ['STABLECOIN_CRYPTO'],
  methodCatalog: [cryptoMethod],
  currencies: [EUR],
  recurring: { supported: false },
  partialPayments: { supported: false },
  refunds: { supported: true },
  recourse: 'MERCHANT_DISPUTE_WINDOW',
  customerEligibility: [],
  settlementDestination: defineSettlementDestination({
    id: 'dest-1',
    kind: 'STABLECOIN_WALLET',
    currency: EUR,
    externalRef: 'wallet:0xabc',
    provenance: { source: 'merchant-onboarding', reference: 'ref-1', recordedAt: 1n },
  }),
  timing: { maxCompletionMs: 3600000n },
  remittance: { requiredDocumentKinds: ['INVOICE'] },
  geography: ['US'],
});

const usdc = defineCryptoAsset({
  id: 'asset:usdc',
  displayName: 'USD Coin',
  symbol: 'USDC',
  decimals: 6,
  kind: 'STABLECOIN',
});

const usdt = defineCryptoAsset({
  id: 'asset:usdt',
  displayName: 'Tether USD',
  symbol: 'USDT',
  decimals: 6,
  kind: 'STABLECOIN',
});

const cryptoPolicy = defineMerchantCryptoAcceptancePolicy(
  {
    id: 'mcap-1',
    merchantRef: 'merchant-1',
    basePolicyId: 'ap-1',
    assets: [
      defineCryptoAssetAcceptance({
        assetId: 'asset:usdc',
        chains: ['chain.ethereum', 'chain.base'],
        minAmount: defineCryptoAmount(usdc, 1000000n),
        requiredConfirmations: 12n,
      }),
      defineCryptoAssetAcceptance({
        assetId: 'asset:usdt',
        chains: ['chain.ethereum'],
        requiredConfirmations: 12n,
      }),
    ],
    quoteValidityMs: 30000n,
  },
  basePolicy,
);

function baseIntentInput() {
  return {
    id: 'intent-1',
    merchantRef: 'merchant-1',
    acceptancePolicyId: 'ap-1',
    cryptoAcceptancePolicyId: 'mcap-1',
    amount: fromMinorUnits(EUR, 10000n),
    createdAt: 1000n,
    expiresAt: 61000n,
  };
}

const intent = defineMerchantPaymentIntent(baseIntentInput());

/**
 * TEST-ONLY CAST: `defineMerchantPaymentIntent` fixes the initial state, so
 * intents in other lifecycle states are produced here by spreading a frozen
 * copy with an overridden `state` — simulating records returned by the
 * (unimplemented here) intent-advancing functions.
 */
function intentInState(state: MerchantPaymentIntent['state'], id = 'intent-1'): MerchantPaymentIntent {
  return { ...intent, id, state } as MerchantPaymentIntent;
}

describe('openMerchantCheckoutSession', () => {
  it('opens an OPEN session snapshotting the offered assets at open', () => {
    const session = openMerchantCheckoutSession({
      id: 'session-1',
      intent,
      cryptoPolicy,
      now: 2000n,
    });
    expect(session.id).toBe('session-1');
    expect(session.intentId).toBe('intent-1');
    expect(session.acceptancePolicyId).toBe('ap-1');
    expect(session.cryptoAcceptancePolicyId).toBe('mcap-1');
    expect(session.offeredAssets.length).toBe(2);
    expect(session.offeredAssets[0]?.assetId).toBe(usdc.id);
    expect(session.offeredAssets[1]?.assetId).toBe(usdt.id);
    expect(session.state).toBe('OPEN');
    expect(session.createdAt).toBe(2000n);
    // A session never outlives its intent.
    expect(session.expiresAt).toBe(intent.expiresAt);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.offeredAssets)).toBe(true);
  });

  it('rejects an intent that is not awaiting payment', () => {
    expect(() =>
      openMerchantCheckoutSession({
        id: 'session-x',
        intent: intentInState('PROCESSING'),
        cryptoPolicy,
        now: 2000n,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      openMerchantCheckoutSession({
        id: 'session-x',
        intent: intentInState('PROCESSING'),
        cryptoPolicy,
        now: 2000n,
      }),
    ).toThrow(/awaiting payment/);
  });

  it('opens on an intent awaiting confirmation', () => {
    const session = openMerchantCheckoutSession({
      id: 'session-2',
      intent: intentInState('REQUIRES_CONFIRMATION'),
      cryptoPolicy,
      now: 2000n,
    });
    expect(session.state).toBe('OPEN');
  });
});

describe('completeMerchantCheckoutSession', () => {
  it('completes an OPEN session once its intent has SUCCEEDED', () => {
    const session = openMerchantCheckoutSession({
      id: 'session-1',
      intent,
      cryptoPolicy,
      now: 2000n,
    });
    const completed = completeMerchantCheckoutSession(
      session,
      intentInState('SUCCEEDED'),
      30000n,
    );
    expect(completed.state).toBe('COMPLETED');
    expect(completed.offeredAssets).toBe(session.offeredAssets);
    expect(Object.isFrozen(completed)).toBe(true);
  });

  it('refuses to complete when the intent has FAILED', () => {
    const session = openMerchantCheckoutSession({
      id: 'session-1',
      intent,
      cryptoPolicy,
      now: 2000n,
    });
    expect(() =>
      completeMerchantCheckoutSession(session, intentInState('FAILED'), 30000n),
    ).toThrow(ValidationError);
    expect(() =>
      completeMerchantCheckoutSession(session, intentInState('FAILED'), 30000n),
    ).toThrow(/SUCCEEDED/);
  });

  it('refuses to complete on a different intent', () => {
    const session = openMerchantCheckoutSession({
      id: 'session-1',
      intent,
      cryptoPolicy,
      now: 2000n,
    });
    expect(() =>
      completeMerchantCheckoutSession(session, intentInState('SUCCEEDED', 'intent-2'), 30000n),
    ).toThrow(ValidationError);
  });
});

describe('cancelMerchantCheckoutSession', () => {
  it('cancels an OPEN session', () => {
    const session = openMerchantCheckoutSession({
      id: 'session-1',
      intent,
      cryptoPolicy,
      now: 2000n,
    });
    const cancelled = cancelMerchantCheckoutSession(session, 3000n);
    expect(cancelled.state).toBe('CANCELLED');
    expect(Object.isFrozen(cancelled)).toBe(true);
  });
});

describe('expireMerchantCheckoutSession', () => {
  it('refuses expiry before the boundary (guard throws)', () => {
    const session = openMerchantCheckoutSession({
      id: 'session-1',
      intent,
      cryptoPolicy,
      now: 2000n,
    });
    expect(() => expireMerchantCheckoutSession(session, 60999n)).toThrow(TransitionGuardError);
  });

  it('expires at/after the intent expiry', () => {
    const session = openMerchantCheckoutSession({
      id: 'session-1',
      intent,
      cryptoPolicy,
      now: 2000n,
    });
    const expired = expireMerchantCheckoutSession(session, 61000n);
    expect(expired.state).toBe('EXPIRED');
  });
});

describe('terminal monotonicity', () => {
  it('throws on CANCEL from a COMPLETED session', () => {
    const session = openMerchantCheckoutSession({
      id: 'session-1',
      intent,
      cryptoPolicy,
      now: 2000n,
    });
    const completed = completeMerchantCheckoutSession(session, intentInState('SUCCEEDED'), 30000n);
    expect(() => cancelMerchantCheckoutSession(completed, 40000n)).toThrow(
      TerminalStateViolationError,
    );
  });
});
