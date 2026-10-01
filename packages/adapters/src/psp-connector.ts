/**
 * PspConnector — the PSP connector interface per the canonical model
 * (W3-003; PSP-ADAPTER-NETWORK; INTEGRATIONS.md; FROZEN-ARCHITECTURE §2A).
 *
 * THE CANONICAL MERCHANT PROMISE (PSP-ADAPTER-NETWORK):
 * "Integrate PaySwap once, then expose every payment capability you are
 * legally and operationally entitled to accept through PaySwap."
 *
 * - The merchant KEEPS an existing PSP; PaySwap becomes an additional payment
 *   method / processor / orchestration capability (the
 *   `merchantKeepsIncumbentPsp: true` literal). A merchant exposes PaySwap
 *   through ONE connector instead of integrating each underlying rail
 *   separately.
 * - INV-NC04: a PSP connector CANNOT imply support for rails that are not
 *   actually reachable AND authorized — `supportedRails()` derives rail
 *   claims exclusively from ConnectedCapabilityInstances that are authorized
 *   (ACTIVE) and currently observed AVAILABLE + ELIGIBLE in the
 *   @payswap/connectors registry; `assertRailReachable` fails closed for
 *   everything else. An existing PSP is never assumed to process every
 *   PaySwap rail.
 * - Health: the connector is health-checkable INDEPENDENTLY from PaySwap
 *   core — the health report is a projection of the connector-scoped
 *   observations only, and NEVER fabricates business outcomes.
 * - New providers are addable WITHOUT domain rewrites: the connector works
 *   against the registry + pack + rail adapter interfaces; registering a new
 *   provider requires no change to this class or any domain contract.
 * - External funds: provider balances surface ONLY as
 *   ExternalFundsPositionObservation (consumed W2-003 type — INV-C09:
 *   external observation, never PaySwap custody).
 *
 * `StripePspAdapterShape` is ONE reference adapter SHAPE: interface-level
 * only, deterministic stub behavior for tests, NO Stripe SDK, NO network
 * calls. Stripe is an example (PSP-neutral principle) — Stripe objects are
 * NOT domain primitives.
 */

import { ValidationError } from "@payswap/protocol";
import type { ProtocolClock } from "@payswap/protocol";
import { createProviderStateEnvelope, isExternalFundsPositionObservation } from "@payswap/connectors";
import type {
  AuthorizationDeclaration,
  CapabilityDefinition,
  ConnectorCapabilityPack,
  ConnectedCapabilityInstance,
  ConnectorRegistry,
  ExternalFundsPositionObservation,
  ExternalObjectIdentity,
  ProviderActionRequired,
  ProviderIdentity,
  ProviderStateClassification,
  ProviderStateEnvelope,
  SourceOfTruthPolicy,
} from "@payswap/connectors";
import type {
  ProviderExecutionEvidenceDraft,
  ProviderOutcomeClassification,
} from "@payswap/execution";
import { ConnectorSDK } from "./sdk.js";
import type {
  ConnectorHealthReport,
  ConnectorSdkOperation,
  CredentialRotationResult,
  SdkCallContext,
  SdkCallResult,
} from "./sdk.js";
import { classifyOutcome } from "./sdk.js";
import type { ProviderStateMapping, RailAdapter } from "./rail-adapter.js";
import { mapProviderStateToCanonical, requiredCustomerActionsFrom } from "./rail-adapter.js";

// ---------------------------------------------------------------------------
// Integration modes (PSP-ADAPTER-NETWORK "Supported integration modes")
// ---------------------------------------------------------------------------

export const PSP_INTEGRATION_MODES = [
  "PAYMENT_METHOD",
  "PROCESSOR_ORCHESTRATION",
  "PAYMENT_RECORD",
  "AGENTIC_COMMERCE",
  "RECURRING_OFF_SESSION",
] as const;

export type PspIntegrationMode = (typeof PSP_INTEGRATION_MODES)[number];

export function isPspIntegrationMode(value: unknown): value is PspIntegrationMode {
  return (
    typeof value === "string" &&
    (PSP_INTEGRATION_MODES as readonly unknown[]).includes(value)
  );
}

/** The merchant-facing descriptor of a PSP connector. */
export interface PspConnectorDescriptor {
  readonly connectorId: string;
  /** The incumbent PSP this connector faces (systemKind must be 'psp'). */
  readonly provider: ProviderIdentity;
  readonly integrationModes: readonly PspIntegrationMode[];
  /** Canonical model: the merchant keeps the existing PSP. */
  readonly merchantKeepsIncumbentPsp: true;
}

// ---------------------------------------------------------------------------
// Rail support (INV-NC04)
// ---------------------------------------------------------------------------

/** A rail-reachability claim derived exclusively from authoritative state. */
export interface RailSupportClaim {
  /** Rail reference (the capability's canonical operation). */
  readonly rail: string;
  readonly supported: boolean;
  readonly instanceIds: readonly string[];
  readonly reason:
    | "AUTHORIZED_AND_REACHABLE"
    | "NO_CONNECTED_INSTANCE"
    | "NOT_AUTHORIZED"
    | "NO_OBSERVATION"
    | "AVAILABILITY_UNKNOWN"
    | "UNAVAILABLE"
    | "ELIGIBILITY_NOT_ESTABLISHED"
    | "NOT_ELIGIBLE";
}

/** Raised when a rail is claimed that is not actually reachable and authorized (INV-NC04). */
export class RailNotReachableError extends ValidationError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.name = "RailNotReachableError";
  }
}

// ---------------------------------------------------------------------------
// The PSP connector
// ---------------------------------------------------------------------------

export interface PspConnectorDeps {
  readonly connectorId: string;
  /** The incumbent PSP this connector faces. */
  readonly provider: ProviderIdentity;
  readonly integrationModes: readonly PspIntegrationMode[];
  /** The connector's SDK implementation (provider specifics stay inside it). */
  readonly sdk: ConnectorSDK;
  /** The provider-neutral rail adapter realizing the provider's implementations. */
  readonly adapter: RailAdapter;
  /** The connector registry providing definitions/instances/observations (W2-003). */
  readonly registry: ConnectorRegistry;
  /** Rail references this connector's provider pack claims to serve. */
  readonly rails?: readonly string[];
}

/**
 * The PSP connector: exposes PaySwap through one connection over the
 * merchant's existing PSP stack. Derives rail support, payment-method
 * surfaces and health EXCLUSIVELY from the registry's authoritative
 * capability state — nothing is implied (INV-NC04), nothing is fabricated.
 */
export class PspConnector {
  readonly #deps: PspConnectorDeps;

  constructor(deps: PspConnectorDeps) {
    if (deps.provider.systemKind !== "psp") {
      throw new ValidationError(
        "a PspConnector faces a provider with systemKind 'psp' (non-PSP systems use the external-system connector interfaces)",
      );
    }
    if (deps.sdk.providerIdentity().providerName !== deps.provider.providerName) {
      throw new ValidationError(
        "the SDK implementation must belong to the connector's provider",
      );
    }
    if (
      !Array.isArray(deps.integrationModes) ||
      deps.integrationModes.length === 0 ||
      !deps.integrationModes.every(isPspIntegrationMode)
    ) {
      throw new ValidationError(
        "a PSP connector declares at least one supported integration mode",
      );
    }
    if (deps.rails !== undefined && deps.rails.length === 0) {
      throw new ValidationError("rails, when declared, must be non-empty");
    }
    this.#deps = deps;
  }

  /** The merchant-facing descriptor (canonical model literals). */
  descriptor(): PspConnectorDescriptor {
    return Object.freeze({
      connectorId: this.#deps.connectorId,
      provider: this.#deps.provider,
      integrationModes: Object.freeze([...this.#deps.integrationModes]),
      merchantKeepsIncumbentPsp: true,
    });
  }

  /** The connector's capability pack. */
  capabilityPack(): ConnectorCapabilityPack {
    return this.#deps.sdk.capabilityPack();
  }

  /** The rail adapter realizing this provider's implementations. */
  railAdapter(): RailAdapter {
    return this.#deps.adapter;
  }

  /**
   * INV-NC04: rail support claims derived EXCLUSIVELY from authorized,
   * currently-observed-reachable instances. A rail with no authorized +
   * reachable instance is claimed NOT supported — the connector never
   * implies support it cannot execute through an actual, authorized
   * provider relationship.
   */
  supportedRails(): readonly RailSupportClaim[] {
    const claims = new Map<string, RailSupportClaim>();
    const rails = this.#deps.rails ?? this.#allRailsInRegistry();
    for (const rail of rails) {
      claims.set(rail, {
        rail,
        supported: false,
        instanceIds: Object.freeze([]),
        reason: "NO_CONNECTED_INSTANCE",
      });
    }
    for (const instance of this.#providerInstances()) {
      const rail = this.#railOfInstance(instance);
      if (rail === undefined) {
        continue;
      }
      let claim: RailSupportClaim;
      if (instance.authorization.status !== "ACTIVE") {
        claim = {
          rail,
          supported: false,
          instanceIds: Object.freeze([instance.instanceId]),
          reason: "NOT_AUTHORIZED",
        };
      } else {
        const observation = this.#deps.registry.latestObservationFor(instance.instanceId);
        if (observation === undefined) {
          claim = {
            rail,
            supported: false,
            instanceIds: Object.freeze([instance.instanceId]),
            reason: "NO_OBSERVATION",
          };
        } else if (observation.availability === "UNKNOWN") {
          claim = {
            rail,
            supported: false,
            instanceIds: Object.freeze([instance.instanceId]),
            reason: "AVAILABILITY_UNKNOWN",
          };
        } else if (observation.availability === "UNAVAILABLE") {
          claim = {
            rail,
            supported: false,
            instanceIds: Object.freeze([instance.instanceId]),
            reason: "UNAVAILABLE",
          };
        } else if (observation.eligibility === "NOT_ELIGIBLE") {
          claim = {
            rail,
            supported: false,
            instanceIds: Object.freeze([instance.instanceId]),
            reason: "NOT_ELIGIBLE",
          };
        } else if (observation.eligibility !== "ELIGIBLE") {
          claim = {
            rail,
            supported: false,
            instanceIds: Object.freeze([instance.instanceId]),
            reason: "ELIGIBILITY_NOT_ESTABLISHED",
          };
        } else {
          claim = {
            rail,
            supported: true,
            instanceIds: Object.freeze([instance.instanceId]),
            reason: "AUTHORIZED_AND_REACHABLE",
          };
        }
      }
      const existing = claims.get(rail);
      if (existing === undefined || !existing.supported) {
        claims.set(rail, claim);
      } else {
        claims.set(rail, {
          ...existing,
          instanceIds: Object.freeze([...existing.instanceIds, ...claim.instanceIds]),
        });
      }
    }
    return Object.freeze([...claims.values()]);
  }

  /**
   * INV-NC04 (fail-closed form): assert a rail is actually reachable AND
   * authorized through this connector, or throw `RailNotReachableError`.
   * This is not "the incumbent PSP automatically accepts every PaySwap
   * rail" — it is "PaySwap handles the rails that are genuinely authorized
   * and reachable".
   */
  assertRailReachable(rail: string): RailSupportClaim {
    const claim = this.supportedRails().find((entry) => entry.rail === rail);
    if (claim === undefined) {
      throw new RailNotReachableError(
        `INV-NC04: rail '${rail}' is not served by any registered capability of this connector's provider`,
        { rail, provider: this.#deps.provider.providerName },
      );
    }
    if (!claim.supported) {
      throw new RailNotReachableError(
        `INV-NC04: rail '${rail}' is not currently reachable and authorized (reason: ${claim.reason}) — a PSP connector cannot imply support for rails that are not actually reachable and authorized`,
        { rail, reason: claim.reason, provider: this.#deps.provider.providerName },
      );
    }
    return claim;
  }

  /**
   * The PaySwap payment-method surfaces this ONE connector exposes for the
   * merchant: every rail that is actually reachable and authorized, derived
   * from authoritative state (INV-NC04) — the merchant integrates once
   * instead of integrating each underlying rail separately.
   */
  exposedPaymentMethodSurfaces(): readonly {
    readonly rail: string;
    readonly surface: string;
    readonly instanceIds: readonly string[];
  }[] {
    return Object.freeze(
      this.supportedRails()
        .filter((claim) => claim.supported)
        .map((claim) =>
          Object.freeze({
            rail: claim.rail,
            surface: `payswap-method:${claim.rail}`,
            instanceIds: claim.instanceIds,
          }),
        ),
    );
  }

  /**
   * Connector health, INDEPENDENT from PaySwap core: a projection of the
   * latest capability observations for this connector's instances only. An
   * instance with no observation reports UNKNOWN (INV-C02) — health never
   * fabricates business outcomes and never declares payment finality.
   */
  health(): ConnectorHealthReport {
    const capabilityStatuses: {
      instanceId: string;
      health: { status: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN"; lastCheckedAt: string };
    }[] = [];
    const degradedReasons: string[] = [];
    let status: ConnectorHealthReport["status"] = "HEALTHY";
    let lastCheckedAt = "never";
    for (const instance of this.#providerInstances()) {
      const observation = this.#deps.registry.latestObservationFor(instance.instanceId);
      const health = observation?.health ?? {
        status: "UNKNOWN" as const,
        lastCheckedAt: "never",
      };
      capabilityStatuses.push(
        Object.freeze({
          instanceId: instance.instanceId,
          health: Object.freeze({ ...health }),
        }),
      );
      if (health.lastCheckedAt > lastCheckedAt) {
        lastCheckedAt = health.lastCheckedAt;
      }
      if (health.status === "UNHEALTHY") {
        status = "UNHEALTHY";
        degradedReasons.push(`instance '${instance.instanceId}' is UNHEALTHY`);
      } else if (health.status === "DEGRADED" && status !== "UNHEALTHY") {
        status = "DEGRADED";
        degradedReasons.push(`instance '${instance.instanceId}' is DEGRADED`);
      } else if (health.status === "UNKNOWN" && status === "HEALTHY") {
        status = "UNKNOWN";
        degradedReasons.push(`instance '${instance.instanceId}' has no current health observation`);
      }
    }
    return Object.freeze({
      connectorId: this.#deps.connectorId,
      providerName: this.#deps.provider.providerName,
      providerVersion: this.#deps.provider.providerVersion,
      status,
      lastCheckedAt,
      capabilityStatuses: Object.freeze(capabilityStatuses),
      degradedReasons: Object.freeze(degradedReasons),
    });
  }

  // -- internals --------------------------------------------------------------

  #providerInstances(): readonly ConnectedCapabilityInstance[] {
    return this.#deps.registry
      .allInstances()
      .filter((instance) => instance.providerName === this.#deps.provider.providerName);
  }

  #railOfInstance(instance: ConnectedCapabilityInstance): string | undefined {
    return this.#deps.registry.definition(instance.capabilityId)?.semantics.operation;
  }

  #allRailsInRegistry(): readonly string[] {
    const rails = new Set<string>();
    for (const instance of this.#providerInstances()) {
      const rail = this.#railOfInstance(instance);
      if (rail !== undefined) {
        rails.add(rail);
      }
    }
    return [...rails];
  }
}

// ---------------------------------------------------------------------------
// The reference adapter shape (interface-level only — deterministic stub)
// ---------------------------------------------------------------------------

/** The deterministic request shape the reference adapter understands. */
export interface DeterministicStubRequest {
  readonly simulate:
    | "SUCCEEDED"
    | "FAILED"
    | "OUTCOME_UNKNOWN"
    | "CUSTOMER_ACTION_REQUIRED"
    | "ASYNC_PROCESSING";
  readonly externalRef?: string;
  readonly providerNativePayload?: unknown;
}

/**
 * `StripePspAdapterShape` — ONE reference adapter SHAPE demonstrating the
 * connector contract end to end (interface-level only):
 *
 * - NO Stripe SDK: no `stripe` types, no API client — only provider-neutral
 *   contracts and the canonical W2-003 vocabulary;
 * - NO network calls: behavior is a deterministic function of the request;
 * - every call returns a lossless ProviderStateEnvelope (INV-C06) plus the
 *   canonical outcome classification (INV-X01 discipline) and an execution
 *   evidence draft (INV-E02) for the caller's attempt ledger;
 * - provider-native payloads echo VERBATIM inside the envelope's raw state;
 * - external funds observations pass through as external observations with
 *   mandatory freshness/provenance (INV-C09) — never custody.
 *
 * Stripe is an example provider (the domain stays PSP-neutral): real adapters
 * follow exactly this shape with real SDKs hidden inside the implementation.
 */
export class StripePspAdapterShape extends ConnectorSDK implements RailAdapter {
  readonly adapterId = "adapter.shape.stripe";
  readonly implementationId = "impl.shape.stripe";
  readonly #pack: ConnectorCapabilityPack;
  readonly #definitions: ReadonlyMap<string, CapabilityDefinition>;

  constructor(
    clock: ProtocolClock,
    definitions: ReadonlyMap<string, CapabilityDefinition>,
    pack: ConnectorCapabilityPack,
  ) {
    super({ clock });
    this.#definitions = new Map(definitions);
    this.#pack = pack;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: "stripe-shape",
      providerVersion: "1.0.0",
      systemKind: "psp",
      displayName: "Stripe (reference shape — deterministic stub)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return this.#pack;
  }

  // -- RailAdapter surface (consumed vocabulary; additive mapping) -----------

  describePreconditions(capabilityId: string): readonly string[] {
    return this.#definitions.get(capabilityId)?.preconditions ?? [];
  }

  authorizationRequirements(capabilityId: string): AuthorizationDeclaration {
    const definition = this.#definitions.get(capabilityId);
    if (definition === undefined) {
      throw new ValidationError(
        `no CapabilityDefinition for '${capabilityId}' (the W2-003 vocabulary is consumed, never invented by an adapter)`,
      );
    }
    return definition.authorization;
  }

  mapProviderState(envelope: ProviderStateEnvelope): ProviderStateMapping {
    return mapProviderStateToCanonical(envelope);
  }

  requiredCustomerActions(
    envelope: ProviderStateEnvelope,
  ): readonly ProviderActionRequired[] {
    return requiredCustomerActionsFrom(envelope);
  }

  externalObjectIdentity(capabilityId: string): readonly ExternalObjectIdentity[] {
    return this.#definitions.get(capabilityId)?.externalObjects ?? [];
  }

  sourceOfTruthPolicy(externalObjectType: string): SourceOfTruthPolicy | undefined {
    for (const mapping of this.#pack.objectMappings) {
      if (mapping.externalObjectType === externalObjectType) {
        return mapping.sourceOfTruth;
      }
    }
    for (const sub of this.#pack.subPacks) {
      for (const mapping of sub.objectMappings) {
        if (mapping.externalObjectType === externalObjectType) {
          return mapping.sourceOfTruth;
        }
      }
    }
    return undefined;
  }

  // -- ConnectorSDK surface (deterministic; no network) -----------------------

  async search(ctx: SdkCallContext): Promise<SdkCallResult> {
    return this.#deterministicCall(ctx, "search", "payment_search_result");
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    return this.#deterministicCall(ctx, "read", "payment");
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    return this.#deterministicCall(ctx, "create", "payment");
  }

  async update(ctx: SdkCallContext): Promise<SdkCallResult> {
    return this.#deterministicCall(ctx, "update", "payment");
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    return this.#deterministicCall(ctx, "action", "payment");
  }

  async subscribe(ctx: SdkCallContext): Promise<SdkCallResult> {
    return this.#deterministicCall(ctx, "subscribe", "webhook_subscription");
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    return this.#deterministicCall(ctx, "reconcile", "reconciliation_report");
  }

  async disconnect(ctx: SdkCallContext): Promise<SdkCallResult> {
    return this.#deterministicCall(ctx, "disconnect", "connected_account");
  }

  async rotateCredentials(ctx: SdkCallContext): Promise<CredentialRotationResult> {
    this.requireAuthority(ctx, "credential_rotation");
    const request = this.#stubRequest(ctx);
    const evidence = this.#evidence(
      ctx,
      "credential_rotation",
      `vault:credential:${request.externalRef ?? "default"}`,
    );
    return Object.freeze({
      rotatedAt: this.now(),
      newCredentialRef: `vault:credential:${request.externalRef ?? "default"}`,
      evidence,
    });
  }

  async health(): Promise<ConnectorHealthReport> {
    return Object.freeze({
      connectorId: "connector.shape.stripe",
      providerName: this.providerIdentity().providerName,
      providerVersion: this.providerIdentity().providerVersion,
      status: "HEALTHY",
      lastCheckedAt: new Date(Number(this.now())).toISOString(),
      capabilityStatuses: Object.freeze([]),
      degradedReasons: Object.freeze([]),
    });
  }

  /**
   * INV-C09: observe an external funds position as an EXTERNAL OBSERVATION
   * with mandatory freshness and provenance — never PaySwap custody and
   * never proof of a PaySwap-held customer balance.
   */
  observeExternalFunds(
    observation: ExternalFundsPositionObservation,
  ): ExternalFundsPositionObservation {
    if (!isExternalFundsPositionObservation(observation)) {
      throw new ValidationError(
        "external funds observations must carry the nominal brand, freshness and provenance (INV-C09 — a bare balance-shaped object is rejected)",
      );
    }
    return observation;
  }

  // -- internals ---------------------------------------------------------------

  #deterministicCall(
    ctx: SdkCallContext,
    operation: ConnectorSdkOperation,
    objectType: string,
  ): SdkCallResult {
    this.requireAuthority(ctx, operation);
    const request = this.#stubRequest(ctx);
    const envelope = this.#envelopeFor(request, objectType);
    const outcome: ProviderOutcomeClassification = classifyOutcome(envelope);
    return Object.freeze({
      providerState: envelope,
      outcome,
      evidence: this.#evidence(
        ctx,
        operation,
        `provider-op:${operation}:${request.externalRef ?? "none"}`,
      ),
    });
  }

  #stubRequest(ctx: SdkCallContext): DeterministicStubRequest {
    const request = ctx.request as Partial<DeterministicStubRequest> | null;
    if (request === null || typeof request !== "object") {
      throw new ValidationError("the reference shape requires a DeterministicStubRequest");
    }
    if (
      request.simulate !== "SUCCEEDED" &&
      request.simulate !== "FAILED" &&
      request.simulate !== "OUTCOME_UNKNOWN" &&
      request.simulate !== "CUSTOMER_ACTION_REQUIRED" &&
      request.simulate !== "ASYNC_PROCESSING"
    ) {
      throw new ValidationError(
        "DeterministicStubRequest.simulate must name one of the five deterministic behaviors",
      );
    }
    return request as DeterministicStubRequest;
  }

  #envelopeFor(
    request: DeterministicStubRequest,
    objectType: string,
  ): ProviderStateEnvelope {
    const classification = this.#classificationFor(request.simulate);
    return createProviderStateEnvelope({
      provider: {
        name: this.providerIdentity().providerName,
        version: this.providerIdentity().providerVersion,
      },
      object: { objectType, externalId: request.externalRef ?? "ext_1" },
      revision: "rev_1",
      // The provider-native payload echoes VERBATIM (INV-C06, opaque passthrough).
      state: {
        simulate: request.simulate,
        providerNativePayload: request.providerNativePayload ?? null,
      },
      classification,
      history: [],
      ...(request.simulate === "CUSTOMER_ACTION_REQUIRED"
        ? {
            actionRequired: {
              kind: "three_d_secure",
              message: "the provider requires a customer challenge",
            },
          }
        : {}),
      ...(request.simulate === "FAILED" || request.simulate === "OUTCOME_UNKNOWN"
        ? {
            failure: {
              providerErrorCode:
                request.simulate === "FAILED" ? "card_declined" : "timeout",
              retryable: request.simulate === "OUTCOME_UNKNOWN",
              ambiguity:
                request.simulate === "OUTCOME_UNKNOWN"
                  ? ("OUTCOME_UNKNOWN" as const)
                  : ("NONE" as const),
            },
          }
        : {}),
      privacy: {
        dataClassification: "PARTNER",
        constraints: [],
        shareableFields: ["state.simulate"],
      },
      timestamps: { observedAt: new Date(Number(this.now())).toISOString() },
      provenance: { source: "PROVIDER_API", fetchId: "fetch_shape" },
    });
  }

  #classificationFor(simulate: DeterministicStubRequest["simulate"]): ProviderStateClassification {
    switch (simulate) {
      case "SUCCEEDED":
        return {
          family: "capture",
          lifecycleStep: "captured",
          isTerminal: true,
          requiresCustomerAction: false,
        };
      case "FAILED":
        return {
          family: "capture",
          lifecycleStep: "failed",
          isTerminal: true,
          requiresCustomerAction: false,
        };
      case "OUTCOME_UNKNOWN":
        return {
          family: "capture",
          lifecycleStep: "outcome_unknown",
          isTerminal: false,
          requiresCustomerAction: false,
        };
      case "CUSTOMER_ACTION_REQUIRED":
        return {
          family: "customer_action_required",
          lifecycleStep: "challenge_issued",
          isTerminal: false,
          requiresCustomerAction: true,
        };
      case "ASYNC_PROCESSING":
        return {
          family: "async_processing",
          lifecycleStep: "processing",
          isTerminal: false,
          requiresCustomerAction: false,
        };
    }
  }

  #evidence(
    ctx: SdkCallContext,
    operation: ConnectorSdkOperation,
    evidenceRef: string,
  ): ProviderExecutionEvidenceDraft {
    return {
      evidenceId: `ev:${ctx.idempotencyKey}:${operation}`,
      kind: "EXECUTION",
      evidenceRef,
      recordedAt: this.now(),
    };
  }
}
