import { describe, expect, it } from 'vitest';
import { ValidationError, currencyCode, fromMinorUnits } from '@payswap/protocol';
import { asRailCapabilityRef, defineSettlementDestination } from '@payswap/payment';
import { ConnectorAuthorityError } from '@payswap/connectors';
import type { ConnectedCapabilityInstance, ProviderCatalogueEntry } from '@payswap/connectors';
import {
  PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID,
  STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID,
  RouteFamilyConflationError,
  SyntheticStripeBalanceError,
  asCryptoAssetId,
  assertRouteFamilyDiscriminated,
  defineExternalConversionSettlementRoute,
  defineNativeStripeCryptoSettlementRoute,
  isExternalConversionRoute,
  isNativeStripeCryptoRoute,
  isProviderVerifiedStripeSettlement,
  recordStripeSettlementConfirmation,
} from '../src/index.js';

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

const destination = defineSettlementDestination({
  id: 'dest-1',
  kind: 'BANK_ACCOUNT',
  currency: currencyCode('USD'),
  externalRef: 'bank://us/000123',
  provenance: { source: 'merchant-onboarding', reference: 'ref-1', recordedAt: 1n },
});

describe('defineNativeStripeCryptoSettlementRoute', () => {
  it('builds a provider-verified native route on the happy path', () => {
    const route = defineNativeStripeCryptoSettlementRoute(baseNativeInput(), connectedInstance);
    expect(route.routeFamily).toBe('NATIVE_STRIPE_CRYPTO');
    expect(route.providerVerified).toBe(true);
    expect(route.capabilityId).toBe(STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID);
    expect(route.connectedInstanceId).toBe('inst-1');
    expect(route.stripeAccountRef).toBe('acct-1');
    expect(route.settlementCurrency).toBe('USD');
    expect(route.supportedAssets).toEqual([asCryptoAssetId('asset.usdc')]);
    expect(route.evidenceRefs).toEqual(['obs-1']);
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.supportedAssets)).toBe(true);
    expect(Object.isFrozen(route.evidenceRefs)).toBe(true);
    expect(isNativeStripeCryptoRoute(route)).toBe(true);
    expect(isExternalConversionRoute(route)).toBe(false);
  });

  it('rejects a provider catalogue entry with ConnectorAuthorityError (INV-C05)', () => {
    const asInstance = catalogueEntry as unknown as ConnectedCapabilityInstance;
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(baseNativeInput(), asInstance),
    ).toThrow(ConnectorAuthorityError);
    let caught: unknown;
    try {
      defineNativeStripeCryptoSettlementRoute(baseNativeInput(), asInstance);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConnectorAuthorityError);
    expect((caught as ConnectorAuthorityError).name).toBe('ConnectorAuthorityError');
    expect((caught as ConnectorAuthorityError).code).toBe('CATALOGUE_ENTRY_IS_NOT_EXECUTION_AUTHORITY');
  });

  it('rejects a REVOKED authorization with ValidationError', () => {
    const revoked: ConnectedCapabilityInstance = {
      ...connectedInstance,
      authorization: { status: 'REVOKED' },
    };
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(baseNativeInput(), revoked),
    ).toThrow(ValidationError);
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(baseNativeInput(), revoked),
    ).toThrow(/ACTIVE connected instance authorization/);
  });

  it('rejects an ineligible instance with ValidationError carrying the reasons', () => {
    const ineligible: ConnectedCapabilityInstance = {
      ...connectedInstance,
      eligibility: { eligible: false, reasons: ['crypto-payments-not-enabled'] },
    };
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(baseNativeInput(), ineligible),
    ).toThrow(ValidationError);
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(baseNativeInput(), ineligible),
    ).toThrow(/crypto-payments-not-enabled/);
  });

  it('rejects a settlement currency outside the instance scope', () => {
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(
        baseNativeInput({ settlementCurrency: 'EUR' }),
        connectedInstance,
      ),
    ).toThrow(ValidationError);
  });

  it('rejects a connectedInstanceId mismatch', () => {
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(
        baseNativeInput({ connectedInstanceId: 'inst-2' }),
        connectedInstance,
      ),
    ).toThrow(ValidationError);
  });

  it('rejects empty evidence refs with SyntheticStripeBalanceError', () => {
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(
        baseNativeInput({ evidenceRefs: [] }),
        connectedInstance,
      ),
    ).toThrow(SyntheticStripeBalanceError);
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(
        baseNativeInput({ evidenceRefs: [''] }),
        connectedInstance,
      ),
    ).toThrow(SyntheticStripeBalanceError);
  });

  it('rejects empty or repeating supported assets with ValidationError', () => {
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(
        baseNativeInput({ supportedAssets: [] }),
        connectedInstance,
      ),
    ).toThrow(ValidationError);
    expect(() =>
      defineNativeStripeCryptoSettlementRoute(
        baseNativeInput({ supportedAssets: ['asset.usdc', 'asset.usdc'] }),
        connectedInstance,
      ),
    ).toThrow(ValidationError);
  });
});

describe('defineExternalConversionSettlementRoute', () => {
  it('builds an external conversion route on the happy path', () => {
    const route = defineExternalConversionSettlementRoute({
      destination,
      conversionChain: ['cap.fx.swap', 'cap.rail.payout'],
    });
    expect(route.routeFamily).toBe('EXTERNAL_PAYSWAP_CONVERSION');
    expect(route.capabilityId).toBe(PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID);
    expect(route.destination).toBe(destination);
    expect(route.conversionChain).toEqual([
      asRailCapabilityRef('cap.fx.swap'),
      asRailCapabilityRef('cap.rail.payout'),
    ]);
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.conversionChain)).toBe(true);
    expect(isExternalConversionRoute(route)).toBe(true);
    expect(isNativeStripeCryptoRoute(route)).toBe(false);
  });

  it('rejects an empty conversion chain with ValidationError', () => {
    expect(() =>
      defineExternalConversionSettlementRoute({ destination, conversionChain: [] }),
    ).toThrow(ValidationError);
  });

  it('rejects repeating conversion chain references with ValidationError', () => {
    expect(() =>
      defineExternalConversionSettlementRoute({
        destination,
        conversionChain: ['cap.fx.swap', 'cap.fx.swap'],
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a structurally malformed destination with ValidationError', () => {
    expect(() =>
      defineExternalConversionSettlementRoute({
        destination: { kind: 'BANK_ACCOUNT' } as unknown as typeof destination,
        conversionChain: ['cap.fx.swap'],
      }),
    ).toThrow(ValidationError);
  });
});

describe('assertRouteFamilyDiscriminated', () => {
  const nativeRoute = defineNativeStripeCryptoSettlementRoute(baseNativeInput(), connectedInstance);
  const externalRoute = defineExternalConversionSettlementRoute({
    destination,
    conversionChain: ['cap.fx.swap'],
  });

  it('passes both constructor outputs', () => {
    expect(() => assertRouteFamilyDiscriminated(nativeRoute)).not.toThrow();
    expect(() => assertRouteFamilyDiscriminated(externalRoute)).not.toThrow();
  });

  it('rejects a native-shaped object carrying a conversionChain with RouteFamilyConflationError', () => {
    const conflated = {
      routeFamily: 'NATIVE_STRIPE_CRYPTO',
      connectedInstanceId: 'inst-1',
      stripeAccountRef: 'acct-1',
      settlementCurrency: 'USD',
      supportedAssets: ['asset.usdc'],
      providerVerified: true,
      evidenceRefs: ['obs-1'],
      capabilityId: STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID,
      conversionChain: ['cap.fx.swap'],
    };
    expect(() => assertRouteFamilyDiscriminated(conflated)).toThrow(RouteFamilyConflationError);
  });

  it('rejects an external-shaped object carrying stripeAccountRef with RouteFamilyConflationError', () => {
    const conflated = {
      routeFamily: 'EXTERNAL_PAYSWAP_CONVERSION',
      destination,
      conversionChain: ['cap.fx.swap'],
      capabilityId: PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID,
      stripeAccountRef: 'acct-1',
    };
    expect(() => assertRouteFamilyDiscriminated(conflated)).toThrow(RouteFamilyConflationError);
  });

  it('rejects an external-shaped object carrying settlementCurrency with RouteFamilyConflationError', () => {
    const conflated = {
      routeFamily: 'EXTERNAL_PAYSWAP_CONVERSION',
      destination,
      conversionChain: ['cap.fx.swap'],
      capabilityId: PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID,
      settlementCurrency: 'USD',
    };
    expect(() => assertRouteFamilyDiscriminated(conflated)).toThrow(RouteFamilyConflationError);
  });

  it('rejects an external-shaped object carrying evidenceRefs with RouteFamilyConflationError', () => {
    const conflated = {
      routeFamily: 'EXTERNAL_PAYSWAP_CONVERSION',
      destination,
      conversionChain: ['cap.fx.swap'],
      capabilityId: PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID,
      evidenceRefs: ['obs-1'],
    };
    expect(() => assertRouteFamilyDiscriminated(conflated)).toThrow(RouteFamilyConflationError);
  });

  it('rejects an external-shaped object carrying providerVerified with RouteFamilyConflationError', () => {
    const conflated = {
      routeFamily: 'EXTERNAL_PAYSWAP_CONVERSION',
      destination,
      conversionChain: ['cap.fx.swap'],
      capabilityId: PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID,
      providerVerified: true,
    };
    expect(() => assertRouteFamilyDiscriminated(conflated)).toThrow(RouteFamilyConflationError);
  });

  it('rejects garbage with ValidationError', () => {
    expect(() => assertRouteFamilyDiscriminated(null)).toThrow(ValidationError);
    expect(() => assertRouteFamilyDiscriminated({})).toThrow(ValidationError);
    expect(() => assertRouteFamilyDiscriminated({ routeFamily: 'MYSTERY_FAMILY' })).toThrow(
      ValidationError,
    );
  });
});

describe('recordStripeSettlementConfirmation', () => {
  type ConfirmationInput = Parameters<typeof recordStripeSettlementConfirmation>[0];

  function baseConfirmationInput(
    overrides: Partial<ConfirmationInput> = {},
  ): ConfirmationInput {
    return {
      confirmationId: 'conf-1',
      connectedInstanceId: 'inst-1',
      stripeBalanceTxRef: 'txn_123',
      amount: fromMinorUnits(currencyCode('USD'), 2500n),
      providerStateEnvelopeRef: 'psev-1',
      evidenceIds: ['ev-1'],
      ...overrides,
    };
  }

  it('records a provider-verified confirmation on the happy path', () => {
    const confirmation = recordStripeSettlementConfirmation(baseConfirmationInput());
    expect(confirmation.confirmedByProvider).toBe(true);
    expect(confirmation.routeFamily).toBe('NATIVE_STRIPE_CRYPTO');
    expect(confirmation.confirmationId).toBe('conf-1');
    expect(confirmation.connectedInstanceId).toBe('inst-1');
    expect(confirmation.stripeBalanceTxRef).toBe('txn_123');
    expect(confirmation.amount.value).toBe(2500n);
    expect(confirmation.providerStateEnvelopeRef).toBe('psev-1');
    expect(confirmation.evidenceIds).toEqual(['ev-1']);
    expect(Object.isFrozen(confirmation)).toBe(true);
    expect(Object.isFrozen(confirmation.evidenceIds)).toBe(true);
  });

  it('rejects empty evidence ids with SyntheticStripeBalanceError', () => {
    expect(() =>
      recordStripeSettlementConfirmation(baseConfirmationInput({ evidenceIds: [] })),
    ).toThrow(SyntheticStripeBalanceError);
  });

  it('rejects a missing providerStateEnvelopeRef with ValidationError (shape before evidence)', () => {
    const withoutEnvelope = {
      confirmationId: 'conf-1',
      connectedInstanceId: 'inst-1',
      stripeBalanceTxRef: 'txn_123',
      amount: fromMinorUnits(currencyCode('USD'), 2500n),
      evidenceIds: ['ev-1'],
    } as unknown as ConfirmationInput;
    expect(() => recordStripeSettlementConfirmation(withoutEnvelope)).toThrow(ValidationError);
    expect(() => recordStripeSettlementConfirmation(withoutEnvelope)).not.toThrow(
      SyntheticStripeBalanceError,
    );
  });

  it('rejects a non-positive amount with ValidationError', () => {
    expect(() =>
      recordStripeSettlementConfirmation(
        baseConfirmationInput({ amount: fromMinorUnits(currencyCode('USD'), 0n) }),
      ),
    ).toThrow(ValidationError);
  });
});

describe('isProviderVerifiedStripeSettlement', () => {
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

  it('rejects a hand-crafted object with empty evidenceIds', () => {
    const confirmation = recordStripeSettlementConfirmation({
      confirmationId: 'conf-1',
      connectedInstanceId: 'inst-1',
      stripeBalanceTxRef: 'txn_123',
      amount: fromMinorUnits(currencyCode('USD'), 2500n),
      providerStateEnvelopeRef: 'psev-1',
      evidenceIds: ['ev-1'],
    });
    expect(isProviderVerifiedStripeSettlement({ ...confirmation, evidenceIds: [] })).toBe(false);
  });

  it('rejects a hand-crafted object without confirmedByProvider', () => {
    const confirmation = recordStripeSettlementConfirmation({
      confirmationId: 'conf-1',
      connectedInstanceId: 'inst-1',
      stripeBalanceTxRef: 'txn_123',
      amount: fromMinorUnits(currencyCode('USD'), 2500n),
      providerStateEnvelopeRef: 'psev-1',
      evidenceIds: ['ev-1'],
    });
    const { confirmedByProvider: _omitted, ...rest } = confirmation;
    expect(isProviderVerifiedStripeSettlement(rest)).toBe(false);
    expect(isProviderVerifiedStripeSettlement(null)).toBe(false);
    expect(isProviderVerifiedStripeSettlement({})).toBe(false);
  });
});
