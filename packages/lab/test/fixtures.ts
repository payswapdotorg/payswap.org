/**
 * Shared deterministic fixtures for the @payswap/lab test suite. All
 * identifiers, timestamps and amounts are fixed constants — no clock, no
 * randomness.
 */

import type {
  CertificationRecord,
  ServiceAccessCapability,
  SmartContractExtension,
} from "@payswap/capabilities";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectedCapabilityInstance,
  ProviderCatalogueEntry,
} from "@payswap/connectors";
import { observeCapability } from "@payswap/connectors";
import type {
  ObserveCapabilityInput,
} from "@payswap/connectors";
import type { CapabilityState, SourceAvailability } from "@payswap/capabilities";
import type { AgentPrincipalRef, VersionedRef, AgentBody } from "@payswap/agents";

// ---------------------------------------------------------------------------
// Connector capability definitions
// ---------------------------------------------------------------------------

function baseDefinition(input: {
  capabilityId: string;
  summary: string;
  nativeOptimization?: CapabilityDefinition["nativeOptimization"];
}): CapabilityDefinition {
  return {
    capabilityId: input.capabilityId,
    capabilityVersion: "1.0.0",
    summary: input.summary,
    kind: "WRITE",
    requiredPermissions: ["payments:write"],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: "payments.create_authorization",
      stateMachine: { documentRef: "sm:payments", version: "1.0.0" },
      description: "create a payment authorization on the provider",
    },
    preconditions: ["connected account ACTIVE", "protocol authorization present"],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["payments:write"],
      customerConsent: "IMPLICIT",
    },
    sideEffects: [
      {
        effect: "external payment authorization created",
        financialEffect: "RESERVES_VALUE",
        reversible: true,
      },
    ],
    idempotency: {
      idempotent: true,
      keyScope: "REQUEST",
      duplicateBehavior: "RETURNED_SAME_RESULT",
      retryPolicy: "SAFE_TO_RETRY",
    },
    compensation: {
      compensable: true,
      compensationCapabilityId: "psp.refunds",
      cancellation: "BEFORE_EXECUTION",
      partialExecution: {
        possible: true,
        granularity: "LINE_ITEM",
        onPartial: "DISCLOSED",
      },
    },
    requiredCustomerActions: [],
    providerVocabulary: {
      actions: [{ action: "capture", description: "capture an authorization" }],
      states: [
        {
          providerState: "requires_action",
          canonicalState: "USER_ACTION_REQUIRED",
          requiresCustomerAction: true,
          isTerminal: false,
        },
      ],
    },
    externalObjects: [
      { objectType: "payment_intent", idFormat: "pi_[a-z0-9]+", revisioned: false },
    ],
    evidence: {
      produced: ["EXECUTION", "RECEIPT"],
      required: ["AUTHORIZATION"],
    },
    economics: {
      feeModel: "HYBRID",
      limits: [
        { dimension: "AMOUNT", description: "max 1M minor units per payment" },
      ],
      settlementImplications: "T+0 on provider settlement rails",
    },
    constraints: [
      { kind: "JURISDICTION", description: "SEPA only", countryCodes: ["DE", "FR"] },
    ],
    ...(input.nativeOptimization !== undefined
      ? { nativeOptimization: input.nativeOptimization }
      : {}),
  };
}

/** The incumbent provider-native routing capability (INV-C08). */
export function makeNativeRoutingDefinition(): CapabilityDefinition {
  return baseDefinition({
    capabilityId: "psp.native-routing",
    summary: "provider-native payment routing optimization",
    nativeOptimization: {
      optimizationKind: "ROUTING",
      benchmarkBaseline: true,
    },
  });
}

/** A plain (non-native) payout capability. */
export function makeComposedPayoutDefinition(input?: {
  capabilityId?: string;
}): CapabilityDefinition {
  return baseDefinition({
    capabilityId: input?.capabilityId ?? "psp.payouts",
    summary: "provider payout execution capability",
  });
}

// ---------------------------------------------------------------------------
// Connected instances + observations
// ---------------------------------------------------------------------------

export function makeInstance(input: {
  instanceId: string;
  capabilityId: string;
  simulatedRailId?: string;
  currencies?: readonly string[];
  authorizationStatus?: ConnectedCapabilityInstance["authorization"]["status"];
  eligible?: boolean;
}): ConnectedCapabilityInstance {
  return {
    instanceId: input.instanceId,
    capabilityId: input.capabilityId,
    implementationId: `${input.capabilityId}:impl:1`,
    providerName: "psp-mock",
    providerVersion: "2024-01",
    accountRef: "acct-123",
    tenantRef: "tenant-1",
    authorization: {
      status: input.authorizationStatus ?? "ACTIVE",
      grantedAt: "2026-01-01T00:00:00Z",
    },
    credentialScope: {
      credentialRef: "cred-1",
      credentialKind: "API_KEY",
    },
    geography: { countries: ["DE", "FR", "US"] },
    currencies: [...(input.currencies ?? ["EUR", "USD"])],
    permissionState: { granted: ["payments:write"], requested: ["payments:write"], missing: [] },
    eligibility: {
      eligible: input.eligible ?? true,
      reasons: [],
    },
    configuration:
      input.simulatedRailId !== undefined
        ? { simulatedRailId: input.simulatedRailId }
        : {},
  };
}

export function makeObservation(input: {
  instanceId: string;
  observationVersion?: number;
  capabilityState?: CapabilityState;
  sourceAvailability?: SourceAvailability;
}): CapabilityObservation {
  return observeCapability({
    instanceId: input.instanceId,
    observedAt: "2026-10-01T00:00:00Z",
    observationVersion: input.observationVersion ?? 1,
    capabilityState: input.capabilityState ?? "AVAILABLE",
    sourceAvailability: input.sourceAvailability ?? "REACHABLE",
    eligibility: "ELIGIBLE",
    health: { status: "HEALTHY", lastCheckedAt: "2026-10-01T00:00:00Z" },
    provenance: {
      providerName: "psp-mock",
      source: "PROVIDER_API",
      capturedAt: "2026-10-01T00:00:00Z",
    },
  } satisfies ObserveCapabilityInput);
}

// ---------------------------------------------------------------------------
// Catalogue entries (INV-C05 negative path)
// ---------------------------------------------------------------------------

export function makeCatalogueEntry(input: {
  capabilityId: string;
}): ProviderCatalogueEntry {
  return {
    catalogueEntryId: `cat-${input.capabilityId}`,
    providerName: "psp-mock",
    providerVersion: "2024-01",
    capabilityId: input.capabilityId,
    summary: "advertised platform-wide capability",
    advertisedScope: {
      platformWide: true,
      advertisedGeographies: ["DE", "FR", "US"],
      advertisedCurrencies: ["EUR", "USD"],
    },
  };
}

// ---------------------------------------------------------------------------
// Certification records + smart-contract extensions
// ---------------------------------------------------------------------------

export function makeCertification(input: {
  subjectId: string;
  version?: string;
  status?: CertificationRecord["status"];
}): CertificationRecord {
  return {
    recordId: `cert-${input.subjectId}`,
    subject: {
      kind: "capability",
      subjectId: input.subjectId,
      version: input.version ?? "1.0.0",
    },
    status: input.status ?? "CERTIFIED",
    evidence: [
      {
        evidenceId: `ev-${input.subjectId}-1`,
        kind: "TEST_RUN",
        artifactRef: "artifacts/test-run-1",
        contentHash: "hash-1",
      },
    ],
    certifiedAt: "2026-09-01T00:00:00Z",
  };
}

export function makeSmartContractExtension(input?: {
  searchable?: boolean;
}): SmartContractExtension {
  const searchable = input?.searchable ?? true;
  return {
    kind: "smart_contract_extension",
    chainRef: "ethereum:mainnet",
    contractAddress: "0x1234567890abcdef1234567890abcdef12345678",
    sourceHash: "0x" + "a1".repeat(32),
    bytecodeHash: "0x" + "b2".repeat(32),
    upgradeAuthority: { kind: "IMMUTABLE", description: "no upgrade path" },
    adminAuthority: { kind: "MULTISIG", description: "3-of-5 operations multisig" },
    pausePowers: [{ actor: "operations-multisig", scope: "full" }],
    oracleDependencies: [],
    custody: {
      custodial: false,
      withdrawalAuthority: "none — non-custodial",
      keyManagement: "user-controlled",
    },
    searchableByLabAfterCertification: searchable,
  };
}

// ---------------------------------------------------------------------------
// ServiceAccessCapability fixture
// ---------------------------------------------------------------------------

export function makeServiceAccessCapability(input?: {
  id?: string;
}): ServiceAccessCapability {
  const id = input?.id ?? "svc.fraud-scoring";
  return {
    id,
    capabilityClass: "developer_service",
    conditions: [
      {
        kind: "eligibility",
        description: "tenant onboarded",
        hardConstraint: true,
      },
    ],
    cost: [{ componentId: "usage-fee", kind: "per_use_fee", bps: 0n }],
    risk: {
      riskClass: "operational",
      severity: "low",
      mitigations: [],
    },
    provenance: {
      declaredBy: "lab-fixture",
      artifactRef: "artifacts/lab-fixture",
      contentHash: "hash-fixture",
    },
    economicAccountability: {
      accountablePartyRef: "party:ops",
      ledgerAccountRef: "ledger:ops",
      recoursePolicyRef: "policy:ops-recourse",
    },
    proofRequirements: [],
    serviceId: "fraud-scoring-v1",
    fundingCredential: {
      kind: "funding_credential",
      credentialRef: "cred-funding-1",
      credentialType: "budget",
    },
    serviceCredential: {
      kind: "service_credential",
      credentialRef: "cred-service-1",
      credentialType: "subscription",
    },
    subscriptionModel: "SUBSCRIPTION",
  };
}

// ---------------------------------------------------------------------------
// Agents fixtures (candidate composition)
// ---------------------------------------------------------------------------

export const CANDIDATE_BODY_REF: VersionedRef<AgentBody> = {
  id: "body.routing-agent",
  version: 1,
};

export const CANDIDATE_PRINCIPAL: AgentPrincipalRef = {
  agentKeyFingerprint: "sha256:fixedfingerprint",
  ownerRef: "owner-1",
};
