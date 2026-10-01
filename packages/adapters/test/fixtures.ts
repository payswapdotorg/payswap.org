/**
 * Shared deterministic fixtures for @payswap/adapters tests. All shapes are
 * CONSUMED from the canonical packages: @payswap/connectors (W2-003
 * vocabulary), @payswap/execution (W3-003 execution graph), @payswap/protocol
 * (W1-001 kernel). Nothing here redefines vocabulary.
 */
import {
  observeCapability,
  validateCapabilityDefinition,
} from "@payswap/connectors";
import type {
  CapabilityDefinition,
  ConnectedCapabilityInstance,
  ConnectorCapabilityPack,
  ConnectorRegistry,
  ProviderIdentity,
} from "@payswap/connectors";
import { ConnectorRegistry as Registry } from "@payswap/connectors";
import { ExecutionGrantAuthority } from "@payswap/execution";
import type { AdapterExecutionAuthority } from "@payswap/execution";
import { ConnectorSDK } from "../src/sdk.js";
import type {
  ConnectorHealthReport,
  CredentialRotationResult,
  SdkCallContext,
  SdkCallResult,
} from "../src/sdk.js";
import { DeterministicClock, asCommandId } from "@payswap/protocol";
import type { CommandEnvelope, ProtocolClock } from "@payswap/protocol";

export const CLOCK: ProtocolClock = new DeterministicClock(1_700_000_000_000n);

export const PRINCIPAL = Object.freeze({
  principalType: "user",
  principalId: "user_1",
});

export const COMMAND: CommandEnvelope<unknown> = Object.freeze({
  id: asCommandId("cmd_1"),
  commandType: "execution.executePlan",
  payload: { planId: "plan_1" },
  principalRef: PRINCIPAL,
  idempotencyKey: "idem-1",
  issuedAt: 1_700_000_000_000n,
  schemaVersion: 1,
});

/** A full, valid CapabilityDefinition (W2-003 shape). */
export function makeCapability(
  capabilityId: string,
  operation: string,
): CapabilityDefinition {
  return validateCapabilityDefinition({
    capabilityId,
    capabilityVersion: "1.0.0",
    summary: `Capability ${capabilityId}`,
    kind: "ACTION",
    requiredPermissions: ["payments:write"],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation,
      stateMachine: { documentRef: "spec/architecture/PAYMENT-OPERATING-PLANE.md", version: "1" },
      description: `Rail operation ${operation}`,
    },
    preconditions: ["connected instance authorized and eligible"],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["payments:execute"],
      customerConsent: "EXPLICIT",
    },
    sideEffects: [
      { effect: "moves payer value", financialEffect: "MOVES_VALUE", reversible: false },
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
      partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
    },
    requiredCustomerActions: [],
    providerVocabulary: { actions: [], states: [] },
    externalObjects: [
      { objectType: "payment", idFormat: "pay_[0-9]+", revisioned: true, revisionFormat: "rev_[0-9]+" },
    ],
    evidence: { produced: ["EXECUTION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "VARIABLE_BPS", limits: [], settlementImplications: "T+0" },
    constraints: [],
  });
}

export const MOBILE_MONEY_CAPABILITY = makeCapability(
  "cap.mobile_money.collect",
  "rails.mobile_money.collect",
);

export const STABLECOIN_CAPABILITY = makeCapability(
  "cap.stablecoin.transfer",
  "rails.stablecoin.transfer",
);

export function makeInstance(overrides?: {
  readonly instanceId?: string;
  readonly capabilityId?: string;
  readonly implementationId?: string;
  readonly providerName?: string;
  readonly authorizationStatus?: "ACTIVE" | "PENDING" | "REVOKED" | "EXPIRED" | "UNKNOWN";
}): ConnectedCapabilityInstance {
  return {
    instanceId: overrides?.instanceId ?? "inst-mm-1",
    capabilityId: overrides?.capabilityId ?? MOBILE_MONEY_CAPABILITY.capabilityId,
    implementationId: overrides?.implementationId ?? "impl-psp-mm",
    providerName: overrides?.providerName ?? "stripe-shape",
    providerVersion: "1.0.0",
    accountRef: "acct_merchant_1",
    tenantRef: "tenant_1",
    authorization: { status: overrides?.authorizationStatus ?? "ACTIVE" },
    credentialScope: { credentialRef: "cred-1", credentialKind: "API_KEY" },
    geography: { countries: ["US"] },
    currencies: ["USD"],
    permissionState: { granted: ["payments:write"], requested: ["payments:write"], missing: [] },
    eligibility: { eligible: true, reasons: [] },
    configuration: {},
  };
}

export const PSP_PROVIDER: ProviderIdentity = Object.freeze({
  providerName: "stripe-shape",
  providerVersion: "1.0.0",
  systemKind: "psp",
  displayName: "Stripe (reference shape)",
});

export function makePack(capabilityId: string): ConnectorCapabilityPack {
  return {
    packId: `pack.${capabilityId}`,
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: [{ capabilityId, capabilityVersion: "1.0.0" }],
    auth: { authKind: "API_KEY", scopes: ["payments:write"] },
    schemas: [{ schemaId: "schema.payment", version: "1.0.0" }],
    objectMappings: [
      {
        externalObjectType: "payment",
        canonicalObjectRef: "payswap:payment",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE",
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE",
    rateLimits: [{ limit: 100, windowSeconds: 60, scope: "account" }],
    provenance: { publisher: "payswap", publishedAt: "2026-01-01T00:00:00.000Z", contentHash: "hash:1" },
    evidence: [],
  };
}

export function definitionsMap(
  ...definitions: readonly CapabilityDefinition[]
): ReadonlyMap<string, CapabilityDefinition> {
  return new Map(definitions.map((definition) => [definition.capabilityId, definition]));
}

/**
 * A fully wired registry: provider + implementations + instances +
 * observations, following the chain rules (definition → implementation →
 * instance → observation).
 */
export function makeRegistry(): ConnectorRegistry {
  const registry = new Registry();
  registry.registerProvider(PSP_PROVIDER);
  registry.registerProvider({
    providerName: "another-psp",
    providerVersion: "1.0.0",
    systemKind: "psp",
    displayName: "Another PSP (extension proof)",
  });
  registry.registerDefinition(MOBILE_MONEY_CAPABILITY);
  registry.registerDefinition(STABLECOIN_CAPABILITY);
  registry.registerImplementation({
    implementationId: "impl-psp-mm",
    providerName: PSP_PROVIDER.providerName,
    providerVersion: PSP_PROVIDER.providerVersion,
    capabilityId: MOBILE_MONEY_CAPABILITY.capabilityId,
    version: "1.0.0",
    adapterRef: "adapter.shape.stripe",
    corridors: [{ currencies: ["USD"], description: "USD collection" }],
    knownDeviations: [],
  });
  registry.registerImplementation({
    implementationId: "impl-psp-usdc",
    providerName: PSP_PROVIDER.providerName,
    providerVersion: PSP_PROVIDER.providerVersion,
    capabilityId: STABLECOIN_CAPABILITY.capabilityId,
    version: "1.0.0",
    adapterRef: "adapter.shape.stripe",
    corridors: [],
    knownDeviations: [],
  });
  const mm = makeInstance();
  registry.registerInstance(mm);
  registry.recordObservation(
    observeCapability({
      instanceId: mm.instanceId,
      observedAt: "2026-01-01T00:00:00.000Z",
      observationVersion: 1,
      capabilityState: "AVAILABLE",
      sourceAvailability: "REACHABLE",
      eligibility: "ELIGIBLE",
      health: { status: "HEALTHY", lastCheckedAt: "2026-01-01T00:00:00.000Z" },
      provenance: {
        providerName: PSP_PROVIDER.providerName,
        source: "PROVIDER_API",
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
    }),
  );
  return registry;
}

/** An adapter execution authority issued through the execution grant authority. */
export function makeAdapterAuthority(): AdapterExecutionAuthority {
  const grants = new ExecutionGrantAuthority();
  grants.issue({
    grantId: "grant_1",
    command: COMMAND,
    scope: {
      capabilityInstanceIds: ["inst-mm-1", "inst-usdc-1"],
      executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    },
    requestHash: "req_hash_1",
    expiresAt: COMMAND.issuedAt + 3_600_000n,
    authorizationEvidenceRef: "evidence:auth-1",
  });
  return grants.attenuateForAdapter("grant_1", COMMAND.issuedAt + 1n);
}

/**
 * A generic minimal SDK used to prove that NEW providers join through the
 * SAME framework classes without any domain rewrite: each new provider
 * brings only its own SDK implementation and registry entries.
 */
export class GenericPspSdkShape extends ConnectorSDK {
  readonly #identity: ProviderIdentity;
  constructor(identity: ProviderIdentity, clock: ProtocolClock) {
    super({ clock });
    this.#identity = identity;
  }
  providerIdentity(): ProviderIdentity {
    return this.#identity;
  }
  capabilityPack() {
    return makePack(MOBILE_MONEY_CAPABILITY.capabilityId);
  }
  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not exercised");
  }
  async read(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not exercised");
  }
  async create(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not exercised");
  }
  async update(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not exercised");
  }
  async executeAction(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not exercised");
  }
  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not exercised");
  }
  async reconcile(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not exercised");
  }
  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new Error("deterministic stub — not exercised");
  }
  async rotateCredentials(_ctx: SdkCallContext): Promise<CredentialRotationResult> {
    throw new Error("deterministic stub — not exercised");
  }
  async health(): Promise<ConnectorHealthReport> {
    return {
      connectorId: `connector.${this.#identity.providerName}`,
      providerName: this.#identity.providerName,
      providerVersion: this.#identity.providerVersion,
      status: "HEALTHY",
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
      capabilityStatuses: [],
      degradedReasons: [],
    };
  }
}
