import { describe, expect, it } from 'vitest';
import { currencyCode } from '@payswap/protocol';
import { defineSettlementDestination } from '@payswap/payment';
import type { ConnectedCapabilityInstance } from '@payswap/connectors';
import {
  PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID,
  STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID,
  defineExternalConversionSettlementRoute,
  defineNativeStripeCryptoSettlementRoute,
  nativeStripeCryptoEligibility,
  payswapExternalConversionSettlementCapabilityDefinition,
  settlementRouteCapabilityId,
  stripeNativeCryptoSettlementCapabilityDefinition,
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

const nativeRoute = defineNativeStripeCryptoSettlementRoute(
  {
    connectedInstanceId: 'inst-1',
    stripeAccountRef: 'acct-1',
    settlementCurrency: 'USD',
    supportedAssets: ['asset.usdc'],
    evidenceRefs: ['obs-1'],
  },
  connectedInstance,
);

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

describe('capability definitions validate on the canonical model', () => {
  it('both definitions pass validateCapabilityDefinition without throwing', () => {
    expect(() => stripeNativeCryptoSettlementCapabilityDefinition()).not.toThrow();
    expect(() => payswapExternalConversionSettlementCapabilityDefinition()).not.toThrow();
  });

  it('carries the constant capability ids and version 1.0.0', () => {
    const native = stripeNativeCryptoSettlementCapabilityDefinition();
    const external = payswapExternalConversionSettlementCapabilityDefinition();
    expect(native.capabilityId).toBe(STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID);
    expect(external.capabilityId).toBe(PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID);
    expect(native.capabilityVersion).toBe('1.0.0');
    expect(external.capabilityVersion).toBe('1.0.0');
  });
});

describe('stripeNativeCryptoSettlementCapabilityDefinition', () => {
  const definition = stripeNativeCryptoSettlementCapabilityDefinition();

  it('declares PASS_THROUGH_NATIVE as its only execution mode (INV-C08 baseline)', () => {
    expect(definition.executionModes).toEqual(['PASS_THROUGH_NATIVE']);
  });

  it('is an INV-C08 benchmark baseline', () => {
    expect(definition.nativeOptimization?.benchmarkBaseline).toBe(true);
    expect(definition.nativeOptimization?.optimizationKind).toBe('PROVIDER_DEFINED');
  });

  it('settles value and requires reconciliation on retry', () => {
    expect(
      definition.sideEffects.some((effect) => effect.financialEffect === 'SETTLES_VALUE'),
    ).toBe(true);
    expect(definition.idempotency.retryPolicy).toBe('REQUIRES_RECONCILIATION');
  });

  it('cannot bypass protocol authorization (INV-C07)', () => {
    expect(definition.authorization.protocolAuthorization).toBe(true);
  });
});

describe('payswapExternalConversionSettlementCapabilityDefinition', () => {
  const definition = payswapExternalConversionSettlementCapabilityDefinition();

  it('declares exactly the two composed execution modes and never PASS_THROUGH_NATIVE', () => {
    expect(definition.executionModes).toHaveLength(2);
    expect(definition.executionModes).toContain('COMPOSED_PAYSWAP');
    expect(definition.executionModes).toContain('OPTIMIZED_MULTI_PROVIDER');
    expect(definition.executionModes).not.toContain('PASS_THROUGH_NATIVE');
  });

  it('declares no nativeOptimization property at all', () => {
    expect('nativeOptimization' in definition).toBe(false);
  });

  it('declares both SETTLES_VALUE and MOVES_VALUE side effects', () => {
    expect(definition.sideEffects).toHaveLength(2);
    expect(
      definition.sideEffects.some((effect) => effect.financialEffect === 'SETTLES_VALUE'),
    ).toBe(true);
    expect(
      definition.sideEffects.some((effect) => effect.financialEffect === 'MOVES_VALUE'),
    ).toBe(true);
  });
});

describe('nativeStripeCryptoEligibility', () => {
  it('is eligible for an ACTIVE, eligible, in-scope instance', () => {
    const view = nativeStripeCryptoEligibility(connectedInstance, nativeRoute);
    expect(view.eligible).toBe(true);
    expect(view.reasons).toEqual([]);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.reasons)).toBe(true);
  });

  it('reports AUTHORIZATION_NOT_ACTIVE for a REVOKED instance', () => {
    const revoked: ConnectedCapabilityInstance = {
      ...connectedInstance,
      authorization: { status: 'REVOKED' },
    };
    const view = nativeStripeCryptoEligibility(revoked, nativeRoute);
    expect(view.eligible).toBe(false);
    expect(view.reasons).toContain('AUTHORIZATION_NOT_ACTIVE');
  });

  it('reports INSTANCE_NOT_ELIGIBLE with the instance reasons appended', () => {
    const ineligible: ConnectedCapabilityInstance = {
      ...connectedInstance,
      eligibility: { eligible: false, reasons: ['crypto-payments-not-enabled'] },
    };
    const view = nativeStripeCryptoEligibility(ineligible, nativeRoute);
    expect(view.eligible).toBe(false);
    const position = view.reasons.indexOf('INSTANCE_NOT_ELIGIBLE');
    expect(position).toBeGreaterThanOrEqual(0);
    expect(view.reasons.indexOf('crypto-payments-not-enabled')).toBeGreaterThan(position);
  });

  it('reports SETTLEMENT_CURRENCY_NOT_IN_INSTANCE_SCOPE on a currency mismatch', () => {
    const otherCurrency: ConnectedCapabilityInstance = {
      ...connectedInstance,
      currencies: ['EUR'],
    };
    const view = nativeStripeCryptoEligibility(otherCurrency, nativeRoute);
    expect(view.eligible).toBe(false);
    expect(view.reasons).toContain('SETTLEMENT_CURRENCY_NOT_IN_INSTANCE_SCOPE');
  });
});

describe('settlementRouteCapabilityId', () => {
  it('maps each route family to its capability constant', () => {
    expect(settlementRouteCapabilityId(nativeRoute)).toBe(
      STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID,
    );
    expect(settlementRouteCapabilityId(externalRoute)).toBe(
      PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID,
    );
  });
});
