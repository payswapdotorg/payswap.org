/**
 * @payswap/merchant-crypto — settlement capability definitions on the
 * canonical connector capability model (P4-W1-003). Two DISTINCT capability
 * families: native Stripe crypto settlement (PASS_THROUGH_NATIVE only — the
 * provider's incumbent path, INV-C08 baseline) and PaySwap external
 * conversion/off-ramp settlement (COMPOSED_PAYSWAP/OPTIMIZED_MULTI_PROVIDER
 * only — never PASS_THROUGH_NATIVE). Both validate through
 * @payswap/connectors' validateCapabilityDefinition; neither can bypass
 * protocol authorization (INV-C07).
 */

import { validateCapabilityDefinition } from '@payswap/connectors';
import type { CapabilityDefinition, ConnectedCapabilityInstance } from '@payswap/connectors';
import {
  PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID,
  STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID,
} from './settlement.js';
import type {
  MerchantCryptoSettlementRoute,
  NativeStripeCryptoSettlementRoute,
} from './settlement.js';

/**
 * Recursively freeze a declaration before it is validated (validation only
 * reads) so both capability definitions are immutable at the boundary.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      deepFreeze(record[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The native Stripe crypto settlement capability: the CONNECTED Stripe
 * account settles accepted crypto itself (INV-C08 incumbent baseline,
 * PASS_THROUGH_NATIVE only; provider-verified only, never synthesized).
 */
export function stripeNativeCryptoSettlementCapabilityDefinition(): CapabilityDefinition {
  const definition: CapabilityDefinition = {
    capabilityId: STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID,
    capabilityVersion: '1.0.0',
    summary:
      'Native Stripe crypto settlement: the connected Stripe account settles accepted stablecoin/crypto itself; provider-verified only, never synthesized',
    kind: 'ACTION',
    requiredPermissions: ['connectors:stripe:crypto-payments'],
    // INV-C08 baseline: the provider's incumbent path ONLY — never composed.
    executionModes: ['PASS_THROUGH_NATIVE'],
    nativeOptimization: { optimizationKind: 'PROVIDER_DEFINED', benchmarkBaseline: true },
    semantics: {
      operation: 'merchant-crypto.stripe.native-settle',
      stateMachine: {
        documentRef: 'spec/architecture/PAYMENT-OPERATING-PLANE.md',
        version: '1',
      },
      description:
        'Provider-native settlement of accepted crypto into the connected Stripe balance; PaySwap observes and records, never credits balances',
    },
    preconditions: [
      'connected Stripe account authorized for crypto payments (ConnectedCapabilityInstance, INV-C05)',
      'provider observation confirms asset and chain support for the connected account',
      'settlement currency is supported by the connected account',
    ],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ['merchant-crypto:settlement:execute'],
      customerConsent: 'IMPLICIT',
    },
    sideEffects: [
      {
        effect: 'provider settles accepted crypto into the connected Stripe balance',
        financialEffect: 'SETTLES_VALUE',
        reversible: false,
      },
    ],
    idempotency: {
      idempotent: true,
      keyScope: 'PROVIDER_ACCOUNT',
      duplicateBehavior: 'PROVIDER_DEFINED',
      retryPolicy: 'REQUIRES_RECONCILIATION',
    },
    compensation: {
      compensable: false,
      cancellation: 'NOT_SUPPORTED',
      partialExecution: { possible: false, granularity: 'ATOMIC', onPartial: 'DISCLOSED' },
    },
    requiredCustomerActions: [
      {
        action: 'activate crypto payments on the connected Stripe account',
        actor: 'MERCHANT_OPERATOR',
        description:
          'Activation is provider-gated (request + review); capability availability follows the connected instance, not the catalogue',
      },
    ],
    providerVocabulary: {
      actions: [
        {
          action: 'settle',
          description: 'provider settles accepted crypto to the connected balance',
        },
      ],
      states: [
        {
          providerState: 'pending',
          canonicalState: 'PROCESSING',
          requiresCustomerAction: false,
          isTerminal: false,
        },
        {
          providerState: 'settled',
          canonicalState: 'SUCCEEDED',
          requiresCustomerAction: false,
          isTerminal: true,
        },
        {
          providerState: 'unknown',
          canonicalState: 'OUTCOME_UNKNOWN',
          requiresCustomerAction: false,
          isTerminal: false,
        },
      ],
    },
    externalObjects: [
      {
        objectType: 'stripe.balance_transaction',
        idFormat: 'provider-prefixed opaque id',
        revisioned: false,
      },
    ],
    evidence: {
      produced: ['EXECUTION', 'STATE_OBSERVATION', 'RECEIPT'],
      required: ['STATE_OBSERVATION'],
    },
    economics: {
      feeModel: 'PROVIDER_SCHEDULE',
      limits: [
        {
          dimension: 'AMOUNT',
          description: 'per-transaction cap imposed by the provider (observed, not assumed)',
        },
      ],
      settlementImplications:
        'crypto accepted → provider-settled funds in the connected Stripe balance; PaySwap never credits any balance itself',
    },
    constraints: [
      {
        kind: 'JURISDICTION',
        description:
          'availability is provider-scoped: country/account gating observed through the connected instance and its observations',
      },
    ],
  };
  return validateCapabilityDefinition(deepFreeze(definition));
}

/**
 * The PaySwap external conversion/off-ramp settlement capability: accepted
 * crypto is converted through a selected capability chain and settled to an
 * EXTERNAL merchant destination (never PaySwap custody). Composed modes
 * ONLY — never PASS_THROUGH_NATIVE; no nativeOptimization is declared.
 */
export function payswapExternalConversionSettlementCapabilityDefinition(): CapabilityDefinition {
  const definition: CapabilityDefinition = {
    capabilityId: PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID,
    capabilityVersion: '1.0.0',
    summary:
      'PaySwap external conversion/off-ramp settlement: accepted crypto is converted through a selected capability chain and settled to an EXTERNAL merchant destination (never PaySwap custody)',
    kind: 'ACTION',
    requiredPermissions: ['connectors:stripe:crypto-payments'],
    // NEVER PASS_THROUGH_NATIVE — this family is PaySwap-composed by design.
    executionModes: ['COMPOSED_PAYSWAP', 'OPTIMIZED_MULTI_PROVIDER'],
    semantics: {
      operation: 'merchant-crypto.payswap.external-conversion-settle',
      stateMachine: {
        documentRef: 'spec/architecture/PAYMENT-OPERATING-PLANE.md',
        version: '1',
      },
      description:
        'PaySwap-composed conversion and settlement executing as protocol SettlementInstruction/SettlementAttempt with protocol-owned finality (INV-F06)',
    },
    preconditions: [
      'external merchant settlement destination configured (never PaySwap custody)',
      'exact quote covering the conversion terms (INV-F01)',
      'conversion capability chain reachable and eligible',
    ],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ['merchant-crypto:settlement:execute'],
      customerConsent: 'EXPLICIT',
    },
    sideEffects: [
      {
        effect: 'convert accepted crypto through the selected capability chain',
        financialEffect: 'SETTLES_VALUE',
        reversible: false,
      },
      {
        effect:
          'onchain rail effects observed by the protocol (finality is protocol-owned)',
        financialEffect: 'MOVES_VALUE',
        reversible: false,
      },
    ],
    idempotency: {
      idempotent: true,
      keyScope: 'CONNECTED_INSTANCE',
      duplicateBehavior: 'REJECTED',
      retryPolicy: 'REQUIRES_RECONCILIATION',
    },
    compensation: {
      compensable: false,
      cancellation: 'BEFORE_EXECUTION',
      partialExecution: {
        possible: false,
        granularity: 'ATOMIC',
        onPartial: 'MANUAL_RECONCILIATION',
      },
    },
    requiredCustomerActions: [
      {
        action: 'authorize the conversion terms',
        actor: 'CUSTOMER',
        description: 'material conversion terms require explicit consent',
      },
    ],
    providerVocabulary: {
      actions: [
        {
          action: 'convert-and-settle',
          description: 'execute the conversion chain and settle to the external destination',
        },
      ],
      states: [
        {
          providerState: 'pending',
          canonicalState: 'PROCESSING',
          requiresCustomerAction: false,
          isTerminal: false,
        },
        {
          providerState: 'succeeded',
          canonicalState: 'SUCCEEDED',
          requiresCustomerAction: false,
          isTerminal: true,
        },
        {
          providerState: 'failed',
          canonicalState: 'FAILED',
          requiresCustomerAction: false,
          isTerminal: true,
        },
        {
          providerState: 'unknown',
          canonicalState: 'OUTCOME_UNKNOWN',
          requiresCustomerAction: false,
          isTerminal: false,
        },
      ],
    },
    externalObjects: [
      {
        objectType: 'payswap.settlement_instruction',
        idFormat: 'protocol settlement instruction id',
        revisioned: true,
        revisionFormat: 'monotonic',
      },
    ],
    evidence: {
      produced: ['EXECUTION', 'RECONCILIATION'],
      required: ['EXECUTION'],
    },
    economics: {
      feeModel: 'HYBRID',
      limits: [],
      settlementImplications:
        'crypto → conversion chain → external destination; settlement executes through protocol settlement instructions and attempts (INV-F06)',
    },
    constraints: [
      {
        kind: 'COMMERCIAL',
        description:
          'route eligibility depends on reachable conversion capabilities and policy constraints at execution time',
      },
    ],
  };
  return validateCapabilityDefinition(deepFreeze(definition));
}

/** Deterministic eligibility view of a native Stripe crypto settlement route. */
export interface NativeStripeCryptoEligibilityView {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

/**
 * Deterministically evaluate a connected instance against a native Stripe
 * crypto settlement route. Reasons are machine keys; instance-level
 * disqualification reasons are appended after `INSTANCE_NOT_ELIGIBLE`.
 */
export function nativeStripeCryptoEligibility(
  instance: ConnectedCapabilityInstance,
  route: NativeStripeCryptoSettlementRoute,
): NativeStripeCryptoEligibilityView {
  const reasons: string[] = [];
  if (instance.authorization.status !== 'ACTIVE') {
    reasons.push('AUTHORIZATION_NOT_ACTIVE');
  }
  if (instance.eligibility.eligible !== true) {
    reasons.push('INSTANCE_NOT_ELIGIBLE');
    reasons.push(...instance.eligibility.reasons);
  }
  if (!instance.currencies.includes(route.settlementCurrency)) {
    reasons.push('SETTLEMENT_CURRENCY_NOT_IN_INSTANCE_SCOPE');
  }
  const view: NativeStripeCryptoEligibilityView = {
    eligible: reasons.length === 0,
    reasons: Object.freeze([...reasons]),
  };
  return Object.freeze(view);
}

/** The capability id a settlement route executes through, by route family. */
export function settlementRouteCapabilityId(route: MerchantCryptoSettlementRoute): string {
  return route.routeFamily === 'NATIVE_STRIPE_CRYPTO'
    ? STRIPE_NATIVE_CRYPTO_SETTLEMENT_CAPABILITY_ID
    : PAYSWAP_EXTERNAL_CONVERSION_SETTLEMENT_CAPABILITY_ID;
}
