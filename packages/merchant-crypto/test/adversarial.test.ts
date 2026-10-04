import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ValidationError, currencyCode, fromMinorUnits } from '@payswap/protocol';
import { ConnectorAuthorityError } from '@payswap/connectors';
import type { ConnectedCapabilityInstance, ProviderCatalogueEntry } from '@payswap/connectors';
import { defineSettlementDestination } from '@payswap/payment';
import {
  SyntheticStripeBalanceError,
  RouteFamilyConflationError,
  asCryptoAssetId,
  assertRouteFamilyDiscriminated,
  attemptOutcome,
  beginMerchantPaymentAttempt,
  confirmMerchantPaymentAttemptFailed,
  defineCryptoAmount,
  defineCryptoAsset,
  defineCryptoQuote,
  defineExternalConversionSettlementRoute,
  defineMerchantPaymentIntent,
  defineNativeStripeCryptoSettlementRoute,
  isProviderVerifiedStripeSettlement,
  recordStripeSettlementConfirmation,
  reportMerchantPaymentAttemptUnknown,
  submitMerchantPaymentAttempt,
} from '../src/index.js';

/**
 * P4-W1-003 adversarial probes: synthetic-balance prohibition, route-family
 * conflation, secret-field structural scan, catalogue-never-authorizes,
 * UNKNOWN-not-FAILED. These tests attack the package's own contracts; every
 * probe must FAIL to break the invariants.
 */

const EUR = currencyCode('EUR');

const connectedInstance: ConnectedCapabilityInstance = {
  instanceId: 'inst-1',
  capabilityId: 'cap-1',
  implementationId: 'impl-1',
  providerName: 'stripe',
  providerVersion: '1.0.0',
  accountRef: 'acct-1',
  tenantRef: 'tenant-1',
  authorization: { status: 'ACTIVE' },
  credentialScope: { credentialRef: 'cred-1', credentialKind: 'API_KEY' },
  geography: { countries: ['US'] },
  currencies: ['USD'],
  permissionState: { granted: [], requested: [], missing: [] },
  eligibility: { eligible: true, reasons: [] },
  configuration: {},
};

const catalogueEntry: ProviderCatalogueEntry = {
  catalogueEntryId: 'cat-1',
  providerName: 'stripe',
  providerVersion: '1.0.0',
  capabilityId: 'cap-1',
  summary: 'ad',
  advertisedScope: {
    platformWide: true,
    advertisedGeographies: ['US'],
    advertisedCurrencies: ['USD'],
  },
};

type NativeRouteInput = Parameters<typeof defineNativeStripeCryptoSettlementRoute>[0];

function baseNativeInput(overrides: Partial<NativeRouteInput> = {}): NativeRouteInput {
  return {
    connectedInstanceId: 'inst-1',
    stripeAccountRef: 'acct-1',
    settlementCurrency: 'USD',
    supportedAssets: [asCryptoAssetId('asset.usdc')],
    evidenceRefs: ['obs-1'],
    ...overrides,
  };
}

const externalRoute = defineExternalConversionSettlementRoute({
  destination: defineSettlementDestination({
    id: 'dest-1',
    kind: 'BANK_ACCOUNT',
    currency: currencyCode('USD'),
    externalRef: 'bank://us/000123',
    provenance: { source: 'merchant-onboarding', reference: 'ref-1', recordedAt: 1n },
  }),
  conversionChain: ['cap.fx.swap'],
});

describe('probe 1 — synthetic-balance prohibition', () => {
  it('rejects a confirmation without evidence with SyntheticStripeBalanceError', () => {
    expect(() =>
      recordStripeSettlementConfirmation({
        confirmationId: 'conf-1',
        connectedInstanceId: 'inst-1',
        stripeBalanceTxRef: 'txn_123',
        amount: fromMinorUnits(currencyCode('USD'), 2500n),
        providerStateEnvelopeRef: 'psev-1',
        evidenceIds: [],
      }),
    ).toThrow(SyntheticStripeBalanceError);
  });

  it('rejects a hand-crafted confirmation object with empty evidenceIds', () => {
    const handCrafted = {
      confirmationId: 'x',
      routeFamily: 'NATIVE_STRIPE_CRYPTO',
      connectedInstanceId: 'x',
      stripeBalanceTxRef: 'x',
      amount: { currency: 'USD', value: 1n },
      providerStateEnvelopeRef: 'x',
      evidenceIds: [],
      confirmedByProvider: true,
    };
    expect(isProviderVerifiedStripeSettlement(handCrafted)).toBe(false);
  });

  it('accepts the constructor output', () => {
    const confirmation = recordStripeSettlementConfirmation({
      confirmationId: 'conf-1',
      connectedInstanceId: 'inst-1',
      stripeBalanceTxRef: 'txn_123',
      amount: fromMinorUnits(currencyCode('USD'), 2500n),
      providerStateEnvelopeRef: 'psev-1',
      evidenceIds: ['ev-1'],
    });
    expect(isProviderVerifiedStripeSettlement(confirmation)).toBe(true);
  });

  it('always emits providerVerified true and non-empty evidence — even from hostile input', () => {
    const hostileInput = {
      ...baseNativeInput(),
      providerVerified: false,
    } as unknown as NativeRouteInput;
    const route = defineNativeStripeCryptoSettlementRoute(hostileInput, connectedInstance);
    expect(route.providerVerified).toBe(true);
    expect(route.evidenceRefs.length).toBeGreaterThanOrEqual(1);
    const normalRoute = defineNativeStripeCryptoSettlementRoute(
      baseNativeInput(),
      connectedInstance,
    );
    expect(normalRoute.providerVerified).toBe(true);
    expect(normalRoute.evidenceRefs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('probe 2 — route-family conflation', () => {
  it('rejects a native-shaped object carrying a conversionChain', () => {
    const conflated = {
      routeFamily: 'NATIVE_STRIPE_CRYPTO',
      connectedInstanceId: 'inst-1',
      stripeAccountRef: 'acct-1',
      settlementCurrency: 'USD',
      supportedAssets: ['asset.usdc'],
      providerVerified: true,
      evidenceRefs: ['obs-1'],
      conversionChain: ['cap.fx.swap'],
    };
    expect(() => assertRouteFamilyDiscriminated(conflated)).toThrow(RouteFamilyConflationError);
  });

  it('rejects an external-shaped object carrying stripeAccountRef', () => {
    const conflated = {
      routeFamily: 'EXTERNAL_PAYSWAP_CONVERSION',
      destination: externalRoute.destination,
      conversionChain: ['cap.fx.swap'],
      stripeAccountRef: 'acct-1',
    };
    expect(() => assertRouteFamilyDiscriminated(conflated)).toThrow(RouteFamilyConflationError);
  });

  it('passes both constructor outputs through the guard', () => {
    const nativeRoute = defineNativeStripeCryptoSettlementRoute(
      baseNativeInput(),
      connectedInstance,
    );
    expect(() => assertRouteFamilyDiscriminated(nativeRoute)).not.toThrow();
    expect(() => assertRouteFamilyDiscriminated(externalRoute)).not.toThrow();
  });

  it('rejects a typoed routeFamily with ValidationError', () => {
    const typoed = {
      routeFamily: 'NATIVE_STRIPE',
      connectedInstanceId: 'inst-1',
      stripeAccountRef: 'acct-1',
      settlementCurrency: 'USD',
      supportedAssets: ['asset.usdc'],
      providerVerified: true,
      evidenceRefs: ['obs-1'],
    };
    expect(() => assertRouteFamilyDiscriminated(typoed)).toThrow(ValidationError);
  });
});

describe('probe 3 — secret-field structural scan of src/**', () => {
  function listSourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        found.push(...listSourceFiles(full));
      } else if (entry.endsWith('.ts')) {
        found.push(full);
      }
    }
    return found;
  }

  it('contains no secret-bearing field names anywhere in src/**', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(join(process.cwd(), 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (/apiSecret|secretKey|privateKey|password|mnemonic|seedPhrase|apiKey|accessToken|refreshToken|sessionCookie|clientSecret/i.test(source)) {
        offenders.push(`${file}: secret-bearing field name`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('contains no live/test credential literals anywhere in src/**', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(join(process.cwd(), 'src'))) {
      const source = readFileSync(file, 'utf8');
      if (/sk_live|sk_test|whsec_|ghp_/.test(source)) {
        offenders.push(`${file}: credential literal`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });
});

describe('probe 4 — a provider catalogue entry never authorizes', () => {
  it('throws ConnectorAuthorityError when a catalogue entry is used as authority', () => {
    const asInstance = catalogueEntry as unknown as ConnectedCapabilityInstance;
    let caught: unknown;
    try {
      defineNativeStripeCryptoSettlementRoute(baseNativeInput(), asInstance);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConnectorAuthorityError);
    expect((caught as ConnectorAuthorityError).name).toBe('ConnectorAuthorityError');
  });
});

describe('probe 5 — UNKNOWN is never FAILED', () => {
  const usdc = defineCryptoAsset({
    id: 'asset:usdc',
    displayName: 'USD Coin',
    symbol: 'USDC',
    decimals: 6,
    kind: 'STABLECOIN',
  });

  const quote = defineCryptoQuote({
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

  const intent = defineMerchantPaymentIntent({
    id: 'intent-1',
    merchantRef: 'merchant-1',
    acceptancePolicyId: 'ap-1',
    cryptoAcceptancePolicyId: 'mcap-1',
    amount: fromMinorUnits(EUR, 10000n),
    createdAt: 1000n,
    expiresAt: 61000n,
  });

  function unknownAttempt() {
    const pending = beginMerchantPaymentAttempt({
      id: 'attempt-1',
      intent,
      quote,
      now: 2000n,
    });
    const submitted = submitMerchantPaymentAttempt(pending, quote, 60000n);
    return reportMerchantPaymentAttemptUnknown(submitted, {
      evidenceIds: ['ev-obs-1'],
      now: 60100n,
    });
  }

  it('reports OUTCOME_UNKNOWN strictly, never FAILED', () => {
    const unknown = unknownAttempt();
    expect(attemptOutcome(unknown) === 'OUTCOME_UNKNOWN').toBe(true);
    expect(attemptOutcome(unknown)).not.toBe('FAILED');
  });

  it('declares no exit from OUTCOME_UNKNOWN except RESOLVE_*', () => {
    const unknown = unknownAttempt();
    expect(() =>
      confirmMerchantPaymentAttemptFailed(unknown, { evidenceIds: ['ev-1'], now: 60200n }),
    ).toThrow();
  });
});

describe('probe 6 — money exactness (INV-F01)', () => {
  const usdc = defineCryptoAsset({
    id: 'asset:usdc',
    displayName: 'USD Coin',
    symbol: 'USDC',
    decimals: 6,
    kind: 'STABLECOIN',
  });

  const quote = defineCryptoQuote({
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

  it('keeps every CryptoAmount.value a bigint in the fixtures', () => {
    const amounts = [
      quote.cryptoAmount,
      defineCryptoAmount(usdc, 1000000n),
      defineCryptoAmount(usdc, 0n),
    ];
    for (const amount of amounts) {
      expect(typeof amount.value).toBe('bigint');
    }
    expect(typeof quote.fiatAmount.value).toBe('bigint');
    expect(typeof quote.fees.value).toBe('bigint');
  });

  it('still rejects an inexact (tampered) ratio', () => {
    expect(() =>
      defineCryptoQuote({
        id: 'quote:usdc:eur:bad',
        assetId: 'asset:usdc',
        chainId: 'chain.ethereum',
        fiatAmount: fromMinorUnits(EUR, 10000n),
        cryptoAmount: defineCryptoAmount(usdc, 111000000n),
        ratio: { numerator: 10000n, denominator: 110000000n },
        fees: fromMinorUnits(EUR, 150n),
        quotedAt: 1000n,
        validUntil: 61000n,
        sourceRef: 'source:fx-desk:a1',
      }),
    ).toThrow(/ratio is inconsistent/);
  });
});
