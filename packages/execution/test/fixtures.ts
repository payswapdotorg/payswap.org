/**
 * Shared deterministic fixtures for @payswap/execution tests. All shapes are
 * CONSUMED from the canonical packages: @payswap/connectors (W2-003
 * vocabulary), @payswap/payment (W1-003 payment plane), @payswap/protocol
 * (W1-001 kernel). Nothing here redefines vocabulary.
 */
import {
  createProviderStateEnvelope,
  observeCapability,
  validateCapabilityDefinition,
  validateConnectedCapabilityInstance,
} from "@payswap/connectors";
import type {
  CapabilityDefinition,
  ConnectedCapabilityInstance,
  ProviderActionRequired,
  ProviderCatalogueEntry,
  ProviderFailureMetadata,
  ProviderStateEnvelope,
  ProviderStateFamily,
} from "@payswap/connectors";
import {
  defineAcceptancePolicy,
  defineCredentialCapability,
  defineMaterialTerms,
  definePaymentMethod,
  defineSettlementDestination,
  defineTranslation,
} from "@payswap/payment";
import type {
  AcceptanceRequest,
  PaymentAcceptancePolicy,
  PaymentMethodTranslation,
} from "@payswap/payment";
import type { PrincipalRef, TimestampMs } from "@payswap/protocol";
import { USD, fromMinorUnits } from "@payswap/protocol";

export const PRINCIPAL: PrincipalRef = Object.freeze({
  principalType: "user",
  principalId: "user_1",
});

export const AGENT: PrincipalRef = Object.freeze({
  principalType: "agent",
  principalId: "agent_1",
});

export const NOW: TimestampMs = 1_700_000_000_000n;

/** A full, valid CapabilityDefinition (W2-003 shape). */
export function makeCapability(
  overrides?: Partial<CapabilityDefinition>,
): CapabilityDefinition {
  const definition: CapabilityDefinition = {
    capabilityId: "cap.mobile_money.collect",
    capabilityVersion: "1.0.0",
    summary: "Collect a mobile money payment",
    kind: "ACTION",
    requiredPermissions: ["payments:write"],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: "payments.create_authorization",
      stateMachine: { documentRef: "spec/architecture/PAYMENT-OPERATING-PLANE.md", version: "1" },
      description: "Authorize and capture a mobile money payment",
    },
    preconditions: ["connected instance authorized and eligible"],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["payments:execute"],
      customerConsent: "EXPLICIT",
    },
    sideEffects: [
      { effect: "moves payer value to merchant settlement", financialEffect: "MOVES_VALUE", reversible: false },
    ],
    idempotency: {
      idempotent: true,
      keyScope: "REQUEST",
      duplicateBehavior: "RETURNED_SAME_RESULT",
      retryPolicy: "SAFE_TO_RETRY",
    },
    compensation: {
      compensable: false,
      cancellation: "UNTIL_SETTLEMENT",
      partialExecution: { possible: true, granularity: "ATOMIC", onPartial: "DISCLOSED" },
    },
    requiredCustomerActions: [],
    providerVocabulary: {
      actions: [{ action: "collect", description: "collect a payment" }],
      states: [{ providerState: "pending", canonicalState: "IN_FLIGHT", requiresCustomerAction: false, isTerminal: false }],
    },
    externalObjects: [
      { objectType: "payment", idFormat: "pay_[0-9]+", revisioned: true, revisionFormat: "rev_[0-9]+" },
    ],
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "VARIABLE_BPS", limits: [], settlementImplications: "merchant settles T+0 to destination" },
    constraints: [],
    ...overrides,
  };
  return validateCapabilityDefinition(definition);
}

/** A capability with a different id (second rail for multi-provider plans). */
export function makeSecondCapability(): CapabilityDefinition {
  return makeCapability({
    capabilityId: "cap.stablecoin.transfer",
    summary: "Transfer a stablecoin payment",
    semantics: {
      operation: "rails.stablecoin.transfer",
      stateMachine: { documentRef: "spec/architecture/PAYMENT-OPERATING-PLANE.md", version: "1" },
      description: "Transfer stablecoin value",
    },
  });
}

/** A genuinely connected capability instance (INV-C05 shape). */
export function makeInstance(
  overrides?: Partial<ConnectedCapabilityInstance>,
): ConnectedCapabilityInstance {
  return validateConnectedCapabilityInstance({
    instanceId: "inst-mm-1",
    capabilityId: "cap.mobile_money.collect",
    implementationId: "impl-1",
    providerName: "test-psp",
    providerVersion: "1.0.0",
    accountRef: "acct_merchant_1",
    tenantRef: "tenant_1",
    authorization: { status: "ACTIVE" },
    credentialScope: { credentialRef: "cred-1", credentialKind: "API_KEY" },
    geography: { countries: ["US"] },
    currencies: ["USD"],
    permissionState: { granted: ["payments:write"], requested: ["payments:write"], missing: [] },
    eligibility: { eligible: true, reasons: [] },
    configuration: {},
    ...overrides,
  });
}

export function makeSecondInstance(): ConnectedCapabilityInstance {
  return makeInstance({
    instanceId: "inst-usdc-1",
    capabilityId: "cap.stablecoin.transfer",
    implementationId: "impl-2",
    providerName: "test-psp-2",
  });
}

/** A provider catalogue entry — an advertisement, NEVER execution authority (INV-C05). */
export function makeCatalogueEntry(): ProviderCatalogueEntry {
  return {
    catalogueEntryId: "cat-1",
    providerName: "test-psp",
    providerVersion: "1.0.0",
    capabilityId: "cap.mobile_money.collect",
    summary: "Advertised platform-wide",
    advertisedScope: {
      platformWide: true,
      advertisedGeographies: ["US"],
      advertisedCurrencies: ["USD"],
    },
  };
}

/** A lossless provider state envelope (INV-C06). */
export function makeEnvelope(
  overrides?: {
    readonly family?: ProviderStateFamily;
    readonly lifecycleStep?: string;
    readonly isTerminal?: boolean;
    readonly requiresCustomerAction?: boolean;
    readonly state?: unknown;
    readonly failure?: ProviderFailureMetadata;
    readonly actionRequired?: ProviderActionRequired;
    readonly externalId?: string;
  },
): ProviderStateEnvelope {
  const input = overrides ?? {};
  return createProviderStateEnvelope({
    provider: { name: "test-psp", version: "1.0.0" },
    object: { objectType: "payment", externalId: input.externalId ?? "pay_ext_1" },
    revision: "rev_1",
    state: input.state ?? { providerNativeStatus: "processing", nested: { detail: true } },
    classification: {
      family: input.family ?? "capture",
      lifecycleStep: input.lifecycleStep ?? "pending_capture",
      isTerminal: input.isTerminal ?? false,
      requiresCustomerAction: input.requiresCustomerAction ?? false,
    },
    history: [],
    ...(input.actionRequired !== undefined ? { actionRequired: input.actionRequired } : {}),
    ...(input.failure !== undefined ? { failure: input.failure } : {}),
    privacy: { dataClassification: "PARTNER", constraints: [], shareableFields: ["state"] },
    timestamps: { observedAt: "2026-01-01T00:00:00.000Z" },
    provenance: { source: "PROVIDER_API", fetchId: "fetch_1" },
  });
}

/** A REACHABLE, AVAILABLE, ELIGIBLE observation of an instance. */
export function makeObservation(instanceId: string, version = 1) {
  return observeCapability({
    instanceId,
    observedAt: "2026-01-01T00:00:00.000Z",
    observationVersion: version,
    capabilityState: "AVAILABLE",
    sourceAvailability: "REACHABLE",
    eligibility: "ELIGIBLE",
    health: { status: "HEALTHY", lastCheckedAt: "2026-01-01T00:00:00.000Z" },
    provenance: { providerName: "test-psp", source: "PROVIDER_API", capturedAt: "2026-01-01T00:00:00.000Z" },
  });
}

/** The merchant acceptance policy + request + translation (W1-003 shapes). */
export function makeAcceptanceContext(): {
  acceptance: PaymentAcceptancePolicy;
  request: AcceptanceRequest;
  translation: PaymentMethodTranslation;
} {
  const credential = defineCredentialCapability({
    id: "cred-mobile-money",
    kind: "MOBILE_MONEY_AUTHORIZATION",
    required: true,
    scope: "authorize one mobile money collection",
  });
  const method = definePaymentMethod({
    id: "pm_mobile_money",
    kind: "MOBILE_MONEY",
    displayName: "Mobile Money",
    currencies: [USD],
    credentialRequirements: [credential],
  });
  const destination = defineSettlementDestination({
    id: "dest_bank_1",
    kind: "BANK_ACCOUNT",
    currency: USD,
    externalRef: "bank://external/1",
    provenance: { source: "merchant-onboarding", reference: "onboarding-1", recordedAt: 1n },
  });
  const acceptance = defineAcceptancePolicy({
    id: "policy_1",
    merchantRef: "merchant_1",
    methods: ["MOBILE_MONEY"],
    methodCatalog: [method],
    currencies: [USD],
    recurring: { supported: false },
    partialPayments: { supported: false },
    refunds: { supported: true },
    recourse: "CHARGEBACK_ONLY",
    customerEligibility: [],
    settlementDestination: destination,
    timing: { maxCompletionMs: 600_000n },
    remittance: { requiredDocumentKinds: ["INVOICE"] },
    geography: ["US"],
  });
  const request: AcceptanceRequest = {
    methodId: method.id,
    currency: USD,
    country: "US",
  };
  const terms = defineMaterialTerms({
    amount: fromMinorUnits(USD, 10_000n),
    currency: "USD",
    fees: fromMinorUnits(USD, 100n),
    completionMs: 600_000n,
    recourse: "CHARGEBACK_ONLY",
    settlementDestinationId: "dest_bank_1",
  });
  const translation = defineTranslation({
    id: "tr_1",
    requestedMethod: "pm_mobile_money",
    selectedCapabilityChain: [
      { order: 1, capability: "cap.mobile_money.collect", role: "collect" },
      { order: 2, capability: "payswap.fx.convert", role: "fx-convert" },
    ],
    actualRailEffects: [],
    merchantSettlementResult: {
      destinationId: "dest_bank_1",
      destinationKind: "BANK_ACCOUNT",
      currency: "USD",
      externalRef: "bank://external/1",
    },
    materialTerms: terms,
  });
  return { acceptance, request, translation };
}
