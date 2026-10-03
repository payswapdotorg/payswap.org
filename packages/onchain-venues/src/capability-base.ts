/**
 * @payswap/onchain-venues — the shared venue-neutral §2A capability base
 * (P4-W2-002). INTERNAL helper for the venue packs: builds the canonical
 * CapabilityDefinition bases (the full §2A layer-1 declaration) that venue
 * protocol definitions extend. This file is VENUE-NEUTRAL (no venue
 * vocabulary — the concrete venue packs live in their own subpath
 * directories; adversarially scanned in test/adversarial.test.ts).
 */

import type { CapabilityDefinition } from "@payswap/connectors";
import type { ConnectedProtocolInstance } from "@payswap/onchain-domain";
import { protocolCapabilityId } from "@payswap/onchain-domain";

/**
 * The canonical §2A ACTION capability base a venue's protocol definition
 * extends: an executable onchain capability that moves value through a
 * connected instance, protocol-authorized on every execution mode
 * (INV-C07), reconciliation-requiring on retry (INV-X02).
 */
export function venueActionCapabilityDefinition(
  capabilityId: string,
  summary: string,
): CapabilityDefinition {
  return {
    capabilityId,
    capabilityVersion: "1.0.0",
    summary,
    kind: "ACTION",
    requiredPermissions: ["onchain:write"],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: "onchain.swap",
      stateMachine: {
        documentRef: "spec/architecture/FROZEN-ARCHITECTURE.md",
        version: "1.6-frozen-2026-10-02",
      },
      description:
        "Executes a venue swap/intent through a connected protocol instance; every effect maps into canonical settlement machinery as observations.",
    },
    preconditions: [
      "The venue protocol is certified in the capability graph.",
      "A genuinely connected protocol instance with ACTIVE authorization exists (INV-C05).",
    ],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["onchain:write"],
      customerConsent: "EXPLICIT",
    },
    sideEffects: [
      {
        effect: "Moves value on an external chain through the venue's contracts.",
        financialEffect: "MOVES_VALUE",
        reversible: false,
      },
    ],
    idempotency: {
      idempotent: false,
      keyScope: "REQUEST",
      duplicateBehavior: "REJECTED",
      retryPolicy: "REQUIRES_RECONCILIATION",
    },
    compensation: {
      compensable: false,
      cancellation: "NOT_SUPPORTED",
      partialExecution: {
        possible: false,
        granularity: "ATOMIC",
        onPartial: "DISCLOSED",
      },
    },
    requiredCustomerActions: [],
    providerVocabulary: {
      actions: [],
      states: [],
    },
    externalObjects: [],
    evidence: {
      produced: ["EXECUTION", "STATE_OBSERVATION", "RECONCILIATION"],
      required: ["AUTHORIZATION"],
    },
    economics: {
      feeModel: "PROVIDER_SCHEDULE",
      limits: [],
      settlementImplications:
        "External onchain effect mapped into canonical settlement machinery as observations.",
    },
    constraints: [],
  };
}

/**
 * A genuinely connected protocol instance bound to a venue pack's protocol
 * (§2A layer 3 — the ONLY protocol-shaped authorization scope; INV-C05).
 * Production instances are minted by the connector machinery; venue packs
 * construct them for their own protocol scopes in tests and wiring.
 */
export function venueConnectedProtocolInstance(input: {
  readonly protocolKey: string;
  readonly chainKey: string;
  readonly instanceId: string;
  readonly providerName: string;
  readonly accountRef: string;
  readonly tenantRef: string;
  readonly authorizationStatus?: "ACTIVE" | "PENDING" | "REVOKED" | "EXPIRED" | "UNKNOWN";
  readonly eligible?: boolean;
}): ConnectedProtocolInstance {
  return {
    instanceId: input.instanceId,
    capabilityId: protocolCapabilityId(input.protocolKey, input.chainKey),
    implementationId: `impl:${input.protocolKey}:${input.providerName}`,
    providerName: input.providerName,
    providerVersion: "1.0.0",
    accountRef: input.accountRef,
    tenantRef: input.tenantRef,
    authorization: {
      status: input.authorizationStatus ?? "ACTIVE",
      grantedAt: "2026-10-01T00:00:00Z",
      authorizationRef: `authz:${input.instanceId}`,
    },
    credentialScope: {
      credentialRef: `cred:${input.instanceId}`,
      credentialKind: "API_KEY",
    },
    geography: { countries: ["US"] },
    currencies: ["USC"],
    permissionState: {
      granted: ["onchain:write"],
      requested: ["onchain:write"],
      missing: [],
    },
    eligibility: {
      eligible: input.eligible ?? true,
      reasons: [],
    },
    configuration: { venueKind: "extension-pack" },
    protocolKey: input.protocolKey,
    chainKey: input.chainKey,
  };
}
