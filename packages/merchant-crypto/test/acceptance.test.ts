import { describe, expect, it } from 'vitest';
import { ValidationError, currencyCode, fromMinorUnits } from '@payswap/protocol';
import {
  defineAcceptancePolicy,
  defineCredentialCapability,
  definePaymentMethod,
  defineSettlementDestination,
} from '@payswap/payment';
import {
  asChainId,
  asCryptoAssetId,
  defineCryptoAmount,
  defineCryptoAsset,
  defineCryptoAssetAcceptance,
  defineCryptoQuote,
  defineMerchantCryptoAcceptancePolicy,
  evaluateCryptoAcceptance,
  matchesCryptoAcceptance,
  offeredAssets,
  type CryptoAcceptanceRequest,
} from '../src/index.js';

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');

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

const cardMethod = definePaymentMethod({
  id: 'pm:card',
  kind: 'CARD',
  displayName: 'Card',
  currencies: [EUR],
  credentialRequirements: [],
});

const destination = defineSettlementDestination({
  id: 'dest-1',
  kind: 'STABLECOIN_WALLET',
  currency: EUR,
  externalRef: 'wallet:0xabc',
  provenance: { source: 'merchant-onboarding', reference: 'ref-1', recordedAt: 1n },
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
  settlementDestination: destination,
  timing: { maxCompletionMs: 3600000n },
  remittance: { requiredDocumentKinds: ['INVOICE'] },
  geography: ['US'],
});

const cardOnlyBasePolicy = defineAcceptancePolicy({
  id: 'ap-card',
  merchantRef: 'merchant-1',
  methods: ['CARD'],
  methodCatalog: [cardMethod],
  currencies: [EUR],
  recurring: { supported: false },
  partialPayments: { supported: false },
  refunds: { supported: true },
  recourse: 'MERCHANT_DISPUTE_WINDOW',
  customerEligibility: [],
  settlementDestination: destination,
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

const usdcAcceptance = defineCryptoAssetAcceptance({
  assetId: 'asset:usdc',
  chains: ['chain.ethereum', 'chain.base'],
  minAmount: defineCryptoAmount(usdc, 1000000n),
  requiredConfirmations: 12n,
});

const policy = defineMerchantCryptoAcceptancePolicy(
  {
    id: 'mcap-1',
    merchantRef: 'merchant-1',
    basePolicyId: 'ap-1',
    assets: [usdcAcceptance],
    quoteValidityMs: 30000n,
  },
  basePolicy,
);

const usdcQuote = defineCryptoQuote({
  id: 'quote:usdc:eur:001',
  assetId: 'asset:usdc',
  chainId: 'chain.ethereum',
  fiatAmount: fromMinorUnits(EUR, 10000n),
  cryptoAmount: defineCryptoAmount(usdc, 110000000n),
  ratio: { numerator: 10000n, denominator: 110000000n },
  fees: fromMinorUnits(EUR, 150n),
  quotedAt: 1000n,
  validUntil: 61000n,
  sourceRef: 'source:fx-desk:a1',
});

const usdtQuote = defineCryptoQuote({
  id: 'quote:usdt:eur:001',
  assetId: 'asset:usdt',
  chainId: 'chain.ethereum',
  fiatAmount: fromMinorUnits(EUR, 10000n),
  cryptoAmount: defineCryptoAmount(usdt, 110000000n),
  ratio: { numerator: 10000n, denominator: 110000000n },
  fees: fromMinorUnits(EUR, 150n),
  quotedAt: 1000n,
  validUntil: 61000n,
  sourceRef: 'source:fx-desk:a1',
});

const baseChainUsdcQuote = defineCryptoQuote({
  id: 'quote:usdc:eur:002',
  assetId: 'asset:usdc',
  chainId: 'chain.base',
  fiatAmount: fromMinorUnits(EUR, 10000n),
  cryptoAmount: defineCryptoAmount(usdc, 110000000n),
  ratio: { numerator: 10000n, denominator: 110000000n },
  fees: fromMinorUnits(EUR, 150n),
  quotedAt: 1000n,
  validUntil: 61000n,
  sourceRef: 'source:fx-desk:a1',
});

function request(overrides: Partial<CryptoAcceptanceRequest> = {}): CryptoAcceptanceRequest {
  return {
    assetId: asCryptoAssetId('asset:usdc'),
    chainId: asChainId('chain.ethereum'),
    amount: defineCryptoAmount(usdc, 2000000n),
    ...overrides,
  };
}

describe('defineCryptoAssetAcceptance', () => {
  it('builds a frozen acceptance with branded chains and conditional bounds', () => {
    const acceptance = defineCryptoAssetAcceptance({
      assetId: 'asset:usdc',
      chains: ['chain.ethereum', 'chain.base'],
      minAmount: defineCryptoAmount(usdc, 1000000n),
      maxAmount: defineCryptoAmount(usdc, 5000000n),
      requiredConfirmations: 12n,
    });
    expect(acceptance.assetId).toBe(asCryptoAssetId('asset:usdc'));
    expect(acceptance.chains).toEqual([asChainId('chain.ethereum'), asChainId('chain.base')]);
    expect(acceptance.minAmount?.value).toBe(1000000n);
    expect(acceptance.maxAmount?.value).toBe(5000000n);
    expect(acceptance.confirmations.requiredConfirmations).toBe(12n);
    expect(Object.isFrozen(acceptance)).toBe(true);
    expect(Object.isFrozen(acceptance.chains)).toBe(true);
    expect(Object.isFrozen(acceptance.confirmations)).toBe(true);
  });

  it('rejects an empty chain list', () => {
    expect(() =>
      defineCryptoAssetAcceptance({
        assetId: 'asset:usdc',
        chains: [],
        requiredConfirmations: 12n,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects duplicate chains', () => {
    expect(() =>
      defineCryptoAssetAcceptance({
        assetId: 'asset:usdc',
        chains: ['chain.ethereum', 'chain.ethereum'],
        requiredConfirmations: 12n,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects requiredConfirmations below one', () => {
    expect(() =>
      defineCryptoAssetAcceptance({
        assetId: 'asset:usdc',
        chains: ['chain.ethereum'],
        requiredConfirmations: 0n,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects min greater than max', () => {
    expect(() =>
      defineCryptoAssetAcceptance({
        assetId: 'asset:usdc',
        chains: ['chain.ethereum'],
        minAmount: defineCryptoAmount(usdc, 5000000n),
        maxAmount: defineCryptoAmount(usdc, 1000000n),
        requiredConfirmations: 12n,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a min bound denominated in a different asset', () => {
    expect(() =>
      defineCryptoAssetAcceptance({
        assetId: 'asset:usdc',
        chains: ['chain.ethereum'],
        minAmount: defineCryptoAmount(usdt, 1000000n),
        requiredConfirmations: 12n,
      }),
    ).toThrow(ValidationError);
  });
});

describe('defineMerchantCryptoAcceptancePolicy', () => {
  it('builds a frozen policy on the happy path', () => {
    expect(policy.id).toBe('mcap-1');
    expect(policy.merchantRef).toBe('merchant-1');
    expect(policy.basePolicyId).toBe('ap-1');
    expect(policy.assets).toEqual([usdcAcceptance]);
    expect(policy.quoteValidityMs).toBe(30000n);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.assets)).toBe(true);
  });

  it('rejects a base policy without the STABLECOIN_CRYPTO method kind', () => {
    expect(() =>
      defineMerchantCryptoAcceptancePolicy(
        {
          id: 'mcap-x',
          merchantRef: 'merchant-1',
          basePolicyId: 'ap-card',
          assets: [usdcAcceptance],
          quoteValidityMs: 30000n,
        },
        cardOnlyBasePolicy,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      defineMerchantCryptoAcceptancePolicy(
        {
          id: 'mcap-x',
          merchantRef: 'merchant-1',
          basePolicyId: 'ap-card',
          assets: [usdcAcceptance],
          quoteValidityMs: 30000n,
        },
        cardOnlyBasePolicy,
      ),
    ).toThrow(/STABLECOIN_CRYPTO/);
  });

  it('rejects a basePolicyId that does not reference the base policy', () => {
    expect(() =>
      defineMerchantCryptoAcceptancePolicy(
        {
          id: 'mcap-x',
          merchantRef: 'merchant-1',
          basePolicyId: 'ap-someone-else',
          assets: [usdcAcceptance],
          quoteValidityMs: 30000n,
        },
        basePolicy,
      ),
    ).toThrow(ValidationError);
  });

  it('rejects an empty asset list', () => {
    expect(() =>
      defineMerchantCryptoAcceptancePolicy(
        {
          id: 'mcap-x',
          merchantRef: 'merchant-1',
          basePolicyId: 'ap-1',
          assets: [],
          quoteValidityMs: 30000n,
        },
        basePolicy,
      ),
    ).toThrow(ValidationError);
  });

  it('rejects duplicate asset ids', () => {
    const secondUsdc = defineCryptoAssetAcceptance({
      assetId: 'asset:usdc',
      chains: ['chain.solana'],
      requiredConfirmations: 32n,
    });
    expect(() =>
      defineMerchantCryptoAcceptancePolicy(
        {
          id: 'mcap-x',
          merchantRef: 'merchant-1',
          basePolicyId: 'ap-1',
          assets: [usdcAcceptance, secondUsdc],
          quoteValidityMs: 30000n,
        },
        basePolicy,
      ),
    ).toThrow(ValidationError);
  });

  it('rejects a non-positive quoteValidityMs', () => {
    expect(() =>
      defineMerchantCryptoAcceptancePolicy(
        {
          id: 'mcap-x',
          merchantRef: 'merchant-1',
          basePolicyId: 'ap-1',
          assets: [usdcAcceptance],
          quoteValidityMs: 0n,
        },
        basePolicy,
      ),
    ).toThrow(ValidationError);
  });
});

describe('matchesCryptoAcceptance', () => {
  it('accepts a coherent in-bounds request and resolves the asset', () => {
    const decision = matchesCryptoAcceptance(policy, request(), 20000n);
    expect(decision.accepted).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.asset?.assetId).toBe(asCryptoAssetId('asset:usdc'));
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.reasons)).toBe(true);
  });

  it('rejects an asset the policy does not accept', () => {
    const decision = matchesCryptoAcceptance(
      policy,
      request({ assetId: asCryptoAssetId('asset:usdt') }),
      20000n,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(['ASSET_NOT_ACCEPTED']);
    expect(decision.asset).toBeUndefined();
  });

  it('rejects a chain the asset is not accepted on', () => {
    const decision = matchesCryptoAcceptance(
      policy,
      request({ chainId: asChainId('chain.solana') }),
      20000n,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(['CHAIN_NOT_ACCEPTED']);
  });

  it('rejects an amount below the minimum', () => {
    const decision = matchesCryptoAcceptance(
      policy,
      request({ amount: defineCryptoAmount(usdc, 500000n) }),
      20000n,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(['AMOUNT_BELOW_MINIMUM']);
  });

  it('rejects an amount above the maximum', () => {
    const capped = defineMerchantCryptoAcceptancePolicy(
      {
        id: 'mcap-capped',
        merchantRef: 'merchant-1',
        basePolicyId: 'ap-1',
        assets: [
          defineCryptoAssetAcceptance({
            assetId: 'asset:usdc',
            chains: ['chain.ethereum'],
            minAmount: defineCryptoAmount(usdc, 1000000n),
            maxAmount: defineCryptoAmount(usdc, 5000000n),
            requiredConfirmations: 12n,
          }),
        ],
        quoteValidityMs: 30000n,
      },
      basePolicy,
    );
    const decision = matchesCryptoAcceptance(
      capped,
      request({ amount: defineCryptoAmount(usdc, 6000000n) }),
      20000n,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(['AMOUNT_ABOVE_MAXIMUM']);
  });

  it('rejects an expired quote (expiry at the boundary)', () => {
    const decision = matchesCryptoAcceptance(policy, request({ quote: usdcQuote }), 61000n);
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(['QUOTE_EXPIRED']);
  });

  it('accepts the same quote one instant before expiry', () => {
    const decision = matchesCryptoAcceptance(policy, request({ quote: usdcQuote }), 60999n);
    expect(decision.accepted).toBe(true);
  });

  it('rejects a quote denominated in a different asset', () => {
    const decision = matchesCryptoAcceptance(policy, request({ quote: usdtQuote }), 20000n);
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(['QUOTE_ASSET_MISMATCH']);
  });

  it('rejects a quote for a different chain', () => {
    const decision = matchesCryptoAcceptance(policy, request({ quote: baseChainUsdcQuote }), 20000n);
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(['QUOTE_CHAIN_MISMATCH']);
  });

  it('treats an amount denominated in a different asset as ASSET_NOT_ACCEPTED', () => {
    const decision = matchesCryptoAcceptance(
      policy,
      request({ amount: defineCryptoAmount(usdt, 500000n) }),
      20000n,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(['ASSET_NOT_ACCEPTED']);
  });

  it('deduplicates reasons and never throws on mixed-asset bounds', () => {
    const decision = matchesCryptoAcceptance(
      policy,
      request({ assetId: asCryptoAssetId('asset:usdt'), amount: defineCryptoAmount(usdt, 500000n) }),
      20000n,
    );
    expect(decision.reasons).toEqual(['ASSET_NOT_ACCEPTED']);
  });
});

describe('evaluateCryptoAcceptance', () => {
  it('unions BASE_POLICY_REJECTED with the crypto reasons when the base policy rejects', () => {
    const decision = evaluateCryptoAcceptance(
      policy,
      basePolicy,
      request({ assetId: asCryptoAssetId('asset:usdt') }),
      { methodId: cryptoMethod.id, currency: USD },
      20000n,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(['BASE_POLICY_REJECTED', 'ASSET_NOT_ACCEPTED']);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.reasons)).toBe(true);
  });

  it('accepts when both the base policy and the crypto policy accept', () => {
    const decision = evaluateCryptoAcceptance(
      policy,
      basePolicy,
      request(),
      { methodId: cryptoMethod.id, currency: EUR },
      20000n,
    );
    expect(decision.accepted).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.asset?.assetId).toBe(asCryptoAssetId('asset:usdc'));
  });

  it('reports only the crypto reasons when the base policy accepts but crypto rejects', () => {
    const decision = evaluateCryptoAcceptance(
      policy,
      basePolicy,
      request({ chainId: asChainId('chain.solana') }),
      { methodId: cryptoMethod.id, currency: EUR },
      20000n,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(['CHAIN_NOT_ACCEPTED']);
    expect(decision.reasons).not.toContain('BASE_POLICY_REJECTED');
  });
});

describe('offeredAssets', () => {
  it('returns a distinct frozen snapshot equal to the policy assets', () => {
    const snapshot = offeredAssets(policy);
    expect(snapshot).toEqual(policy.assets);
    expect(snapshot).not.toBe(policy.assets);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.length).toBe(1);
    expect(snapshot[0]).not.toBe(policy.assets[0]);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(snapshot[0]?.assetId).toBe(asCryptoAssetId('asset:usdc'));
  });

  it('keeps the policy immutable — the snapshot cannot alias it', () => {
    const snapshot = offeredAssets(policy);
    expect(() => {
      (snapshot as unknown as string[]).push('x');
    }).toThrow();
    expect(policy.assets.length).toBe(1);
    expect(offeredAssets(policy).length).toBe(1);
  });
});
