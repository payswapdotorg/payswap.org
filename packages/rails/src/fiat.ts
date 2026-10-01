/**
 * Fiat rail adapter — payment-intent lifecycle on the RailAdapter framework
 * (W1-005; INTEGRATIONS.md "Rail adapter"; LOSSLESS-CONNECTOR-CAPABILITY-
 * MODEL; PSP-ADAPTER-NETWORK "PSP-neutral principle": Stripe is ONE adapter
 * example — provider objects are never domain primitives).
 *
 * Lifecycle mapping (INV-C06 — lossless): the provider's payment-intent
 * states (`requires_payment_method`, `requires_confirmation`,
 * `requires_action`, `processing`, `requires_capture`, `succeeded`,
 * `canceled`) are preserved VERBATIM in the ProviderStateEnvelope raw state
 * with an ADDITIVE classification (family + lifecycle step). The
 * customer-action surface (`requires_action` → provider challenge), the
 * capture semantics (`requires_capture` → capture family) and cancellation
 * semantics are NEVER flattened into generic CRUD outcomes.
 *
 * Real-network policy: the fiat provider is credential-gated. Without a
 * provisioned secret-store reference the adapter reports UNKNOWN
 * availability with provenance (INV-C01/C02 — see BLOCKED-RAILS.md) and
 * every effectful operation fails closed with `RailNotAuthorizedError`
 * BEFORE any provider call (INV-NC04). No settlement effect is ever
 * fabricated. Evidence is captured per effect (INV-E02) and the credential
 * rotation surface is env-driven and documented (CREDENTIAL-ROTATION.md).
 */

import { ValidationError } from "@payswap/protocol";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectorCapabilityPack,
  ProviderIdentity,
  ProviderStateEnvelope,
} from "@payswap/connectors";
import { validateCapabilityDefinition } from "@payswap/connectors";
import { observeCapability, unknownReachabilityObservation } from "@payswap/connectors";
import { BaseRailAdapter, ConnectorSDK, classifyOutcome } from "@payswap/adapters";
import type {
  ConnectorHealthReport,
  CredentialRotationResult,
  SdkCallContext,
  SdkCallResult,
} from "@payswap/adapters";
import type { ProviderExecutionEvidenceDraft } from "@payswap/execution";
import {
  RailNotAuthorizedError,
  RailProviderError,
  RailTransportError,
  railEnvelope,
  railEvidence,
  realHttpTransport,
  routableRailImplication,
  isoTimestamp,
} from "./support.js";
import type { HttpTransport, RailImplication } from "./support.js";

// ---------------------------------------------------------------------------
// Capability + pack (consumed W2-003 vocabulary, never redefined)
// ---------------------------------------------------------------------------

export const FIAT_RAIL_CAPABILITY_ID = "cap.rails.fiat.payment_intent" as const;
export const FIAT_RAIL_ADAPTER_ID = "rail.fiat.stripe-shape" as const;
export const FIAT_RAIL_IMPLEMENTATION_ID = "impl.rails.fiat.stripe-shape" as const;
export const FIAT_RAIL_PROVIDER_NAME = "stripe-shape" as const;
export const FIAT_RAIL_PROVIDER_VERSION = "1.0.0" as const;

/** The canonical capability definition consumed by the fiat rail adapter. */
export function fiatRailCapabilityDefinition(): CapabilityDefinition {
  return validateCapabilityDefinition({
    capabilityId: FIAT_RAIL_CAPABILITY_ID,
    capabilityVersion: "1.0.0",
    summary: "Fiat collection through a PSP payment-intent lifecycle",
    kind: "ACTION",
    requiredPermissions: ["payments:write"],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: "rails.fiat.payment_intent.create_and_confirm",
      stateMachine: {
        documentRef: "spec/architecture/PAYMENT-OPERATING-PLANE.md",
        version: "1",
      },
      description:
        "Create/confirm a payment intent on a PSP fiat rail; capture where the provider separates authorization from capture",
    },
    preconditions: [
      "connected instance authorized and eligible",
      "credential reference provisioned (env-driven, CREDENTIAL-ROTATION.md)",
    ],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["payments:execute"],
      customerConsent: "EXPLICIT",
    },
    sideEffects: [
      { effect: "moves payer value on confirmation", financialEffect: "MOVES_VALUE", reversible: false },
      { effect: "reserves authorized value until capture", financialEffect: "RESERVES_VALUE", reversible: true },
    ],
    idempotency: {
      idempotent: true,
      keyScope: "REQUEST",
      duplicateBehavior: "RETURNED_SAME_RESULT",
      retryPolicy: "REQUIRES_RECONCILIATION",
    },
    compensation: {
      compensable: false,
      cancellation: "UNTIL_SETTLEMENT",
      partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
    },
    requiredCustomerActions: [
      {
        action: "complete_provider_challenge",
        actor: "CUSTOMER",
        description: "Complete the provider-required challenge (e.g. 3-D Secure redirect)",
        surfaceHint: "provider_next_action",
      },
    ],
    providerVocabulary: {
      actions: [
        { action: "confirm", description: "Confirm the payment intent toward the provider" },
        { action: "capture", description: "Capture a previously authorized (requires_capture) intent" },
        { action: "cancel", description: "Cancel an uncaptured intent" },
      ],
      states: [
        { providerState: "requires_payment_method", canonicalState: "other:requires_payment_method", requiresCustomerAction: false, isTerminal: false },
        { providerState: "requires_confirmation", canonicalState: "other:requires_confirmation", requiresCustomerAction: false, isTerminal: false },
        { providerState: "requires_action", canonicalState: "customer_action_required:requires_action", requiresCustomerAction: true, isTerminal: false },
        { providerState: "processing", canonicalState: "async_processing:processing", requiresCustomerAction: false, isTerminal: false },
        { providerState: "requires_capture", canonicalState: "capture:requires_capture", requiresCustomerAction: false, isTerminal: false },
        { providerState: "succeeded", canonicalState: "other:succeeded", requiresCustomerAction: false, isTerminal: true },
        { providerState: "canceled", canonicalState: "other:canceled", requiresCustomerAction: false, isTerminal: true },
      ],
    },
    externalObjects: [
      {
        objectType: "payment_intent",
        idFormat: "pi_[A-Za-z0-9]+",
        revisioned: true,
        revisionFormat: "provider-etag",
      },
    ],
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "PSP settlement schedule" },
    constraints: [],
  });
}

/** The connector capability pack backing the fiat rail (payments family). */
export function fiatRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.fiat",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: [{ capabilityId: FIAT_RAIL_CAPABILITY_ID, capabilityVersion: "1.0.0" }],
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.fiat.payment_intent", version: "1.0.0" }],
    objectMappings: [
      {
        externalObjectType: "payment_intent",
        canonicalObjectRef: "payswap:payment",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 100, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-01T00:00:00.000Z",
      contentHash: "hash:rails-fiat-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Payment-intent lifecycle classification (INV-C06 — additive, lossless)
// ---------------------------------------------------------------------------

/** Provider-native payment-intent states (raw vocabulary, preserved verbatim). */
export const FIAT_PAYMENT_INTENT_STATES = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
  "succeeded",
  "canceled",
] as const;

export type FiatPaymentIntentState = (typeof FIAT_PAYMENT_INTENT_STATES)[number];

/** The raw provider payment-intent object as the adapter observes it (opaque). */
export interface FiatPaymentIntentProviderObject {
  readonly id: string;
  readonly status: string;
  readonly currency?: string;
  readonly amount?: number;
  readonly client_secret?: string;
  readonly latest_charge?: string;
  readonly next_action?: {
    readonly type: string;
    readonly redirect_to_url?: { readonly url: string };
  };
  readonly [key: string]: unknown;
}

/** The envelope input the deterministic lifecycle mapper derives from. */
export interface FiatPaymentIntentEnvelopeInput {
  readonly intent: FiatPaymentIntentProviderObject;
  readonly revision: string;
  readonly observedAt: string;
  readonly fetchId?: string;
}

/**
 * Deterministic, additive classification of one payment-intent provider
 * object into a lossless ProviderStateEnvelope. The RAW provider object is
 * carried verbatim as `state`; classification/family/actionRequired/failure
 * are ADDITIVE metadata (INV-C06). `canceled` carries failure metadata
 * {retryable: false, ambiguity: NONE} — a definitive no-effect outcome,
 * while the raw provider state remains "canceled" for reconciliation,
 * support and audit. Unknown provider states fall through to the total
 * 'other' family VERBATIM — never dropped, never guessed.
 */
export function fiatPaymentIntentEnvelope(
  input: FiatPaymentIntentEnvelopeInput,
): ProviderStateEnvelope {
  const status = input.intent.status;
  const base = {
    providerName: FIAT_RAIL_PROVIDER_NAME,
    providerVersion: FIAT_RAIL_PROVIDER_VERSION,
    objectType: "payment_intent",
    externalId: input.intent.id,
    revision: input.revision,
    state: input.intent,
    observedAt: input.observedAt,
    provenanceSource: "PROVIDER_API" as const,
    ...(input.fetchId !== undefined ? { fetchId: input.fetchId } : {}),
  };
  switch (status) {
    case "requires_action":
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: "requires_action",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind:
            input.intent.next_action?.type === "redirect_to_url"
              ? "PROVIDER_CHALLENGE_REDIRECT"
              : "PROVIDER_CHALLENGE",
          message:
            input.intent.next_action?.type === "redirect_to_url"
              ? "Complete the provider challenge at the redirect URL"
              : "Complete the provider-required challenge",
          ...(input.intent.next_action?.redirect_to_url?.url !== undefined
            ? { deepLink: input.intent.next_action.redirect_to_url.url }
            : {}),
        },
      });
    case "processing":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "processing",
        isTerminal: false,
        requiresCustomerAction: false,
      });
    case "requires_capture":
      return railEnvelope({
        ...base,
        family: "capture",
        lifecycleStep: "requires_capture",
        isTerminal: false,
        requiresCustomerAction: false,
      });
    case "succeeded":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "succeeded",
        isTerminal: true,
        requiresCustomerAction: false,
      });
    case "canceled":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "canceled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payment_intent_canceled",
          retryable: false,
          ambiguity: "NONE",
        },
      });
    default:
      // requires_payment_method / requires_confirmation / any unknown
      // provider state: preserved VERBATIM under the total 'other' family.
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: status,
        isTerminal: false,
        requiresCustomerAction: false,
      });
  }
}

// ---------------------------------------------------------------------------
// The RailAdapter (provider-neutral surface on the W3-003 framework)
// ---------------------------------------------------------------------------

/** The fiat rail adapter: a BaseRailAdapter wired to the consumed vocabulary. */
export class StripeShapeFiatRail extends BaseRailAdapter {
  readonly adapterId = FIAT_RAIL_ADAPTER_ID;
  readonly implementationId = FIAT_RAIL_IMPLEMENTATION_ID;

  constructor() {
    super(fiatRailCapabilityPack(), new Map([[FIAT_RAIL_CAPABILITY_ID, fiatRailCapabilityDefinition()]]));
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK framework; credential-gated)
// ---------------------------------------------------------------------------

export interface StripeShapeFiatClientConfig {
  readonly clock: ProtocolClock;
  /** Provider API base (default: the real PSP endpoint). */
  readonly apiBase?: string;
  readonly apiVersion?: string;
  /** Env var naming the secret-store reference (CREDENTIAL-ROTATION.md). */
  readonly credentialEnvVar?: string;
  /** Injectable environment (tests) — defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable HTTP transport (tests) — defaults to the real fetch. */
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

interface FiatCallRequest {
  readonly kind:
    | "create_intent"
    | "read_intent"
    | "capture_intent"
    | "cancel_intent"
    | "reconcile_intent";
  readonly intentId?: string;
  readonly amountMinor?: string;
  readonly currency?: string;
}

/** Provider-neutral SDK call request shapes (never provider SDK types). */
export type FiatSdkRequest = FiatCallRequest;

/**
 * The fiat provider client on the ConnectorSDK framework. Provider API
 * names, payloads and quirks stay INSIDE this implementation (AGENTS.md
 * rule 17): the SDK call contract is provider-neutral
 * ({ kind, intentId, amountMinor, currency }).
 *
 * Effectful operations run behind `requireAuthority` (INV-C04/INV-F06,
 * INV-F05) and fail closed when the credential surface is not provisioned
 * (INV-NC04) — before any provider call, so no fabricated outcome and no
 * settlement effect can exist for a blocked rail.
 */
export class StripeShapeFiatClient extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialEnvVar: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  #cachedCredentialRef: string | undefined;

  constructor(config: StripeShapeFiatClientConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase = config.apiBase ?? "https://api.stripe.com";
    this.#apiVersion = config.apiVersion ?? FIAT_RAIL_PROVIDER_VERSION;
    this.#credentialEnvVar = config.credentialEnvVar ?? "PAYSWAP_RAILS_FIAT_SECRET_REF";
    this.#env = config.env ?? process.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: FIAT_RAIL_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "Stripe-shaped fiat rail (provider-neutral adapter)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return fiatRailCapabilityPack();
  }

  // -- availability (INV-C01/C02 — two-axis, never fabricated) ---------------

  /** The rail's credential surface declaration (refs only — never values). */
  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialEnvVar, kind: "API_KEY" as const }),
    ]);
  }

  /**
   * Two-axis availability observation. Without a provisioned credential
   * reference the source axis is UNKNOWN and the derived availability is
   * UNKNOWN (INV-C01/C02) — the catalogue capability state is carried as the
   * last-known axis, never presented as routability. With credentials, a
   * caller-supplied live probe may upgrade the source axis to REACHABLE;
   * without a probe the source axis stays UNKNOWN (never fabricated).
   */
  availabilityObservation(input: {
    readonly instanceId: string;
    readonly observationVersion: number;
    readonly probe?: { readonly reachable: boolean; readonly checkedAt: string };
  }): CapabilityObservation {
    const credentialRef = this.#currentCredentialRef();
    const observedAt = isoTimestamp(this.now());
    if (credentialRef === undefined) {
      return unknownReachabilityObservation({
        instanceId: input.instanceId,
        observedAt,
        observationVersion: input.observationVersion,
        lastKnownCapabilityState: "AVAILABLE",
        reason:
          "credential reference not provisioned — source availability UNKNOWN (INV-C01/C02); see packages/rails/BLOCKED-RAILS.md",
        provenance: {
          providerName: FIAT_RAIL_PROVIDER_NAME,
          source: "INTERNAL",
          capturedAt: observedAt,
        },
      });
    }
    if (input.probe === undefined) {
      return unknownReachabilityObservation({
        instanceId: input.instanceId,
        observedAt,
        observationVersion: input.observationVersion,
        lastKnownCapabilityState: "AVAILABLE",
        reason:
          "credentials provisioned but no live probe supplied — source reachability not yet established (INV-C02: never fabricated)",
        provenance: {
          providerName: FIAT_RAIL_PROVIDER_NAME,
          source: "INTERNAL",
          capturedAt: observedAt,
        },
      });
    }
    return observeCapability({
      instanceId: input.instanceId,
      observedAt,
      observationVersion: input.observationVersion,
      capabilityState: input.probe.reachable ? "AVAILABLE" : "UNAVAILABLE",
      sourceAvailability: input.probe.reachable ? "REACHABLE" : "UNREACHABLE",
      eligibility: "UNKNOWN",
      health: {
        status: input.probe.reachable ? "HEALTHY" : "UNHEALTHY",
        lastCheckedAt: input.probe.checkedAt,
      },
      provenance: {
        providerName: FIAT_RAIL_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /**
   * INV-NC04 gate: the strongest routability implication a caller may draw
   * from one availability observation. UNKNOWN (unreachable/unauthorized)
   * is never routable.
   */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(FIAT_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface ---------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "fiat rail search is not implemented in Stage 5 (listing is a certification concern, not an execution effect)",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "read_intent");
    if (request.intentId === undefined) {
      throw new ValidationError("read_intent requires intentId");
    }
    const intent = await this.#providerGetIntent(request.intentId);
    return this.#sdkResult(intent, `fiat:read:${request.intentId}`);
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_intent");
    if (request.amountMinor === undefined || request.currency === undefined) {
      throw new ValidationError("create_intent requires amountMinor and currency (exact minor units)");
    }
    const intent = await this.#providerPost("/v1/payment_intents", {
      amount: request.amountMinor,
      currency: request.currency,
      "idempotency-key": ctx.idempotencyKey,
    });
    return this.#sdkResult(intent, `fiat:create:${intent.id}`);
  }

  async update(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "update");
    const request = this.#request(ctx, "capture_intent");
    if (request.intentId === undefined) {
      throw new ValidationError("capture_intent requires intentId");
    }
    const intent = await this.#providerPost(`/v1/payment_intents/${request.intentId}/capture`, {
      "idempotency-key": ctx.idempotencyKey,
    });
    return this.#sdkResult(intent, `fiat:capture:${intent.id}`);
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "cancel_intent");
    if (request.intentId === undefined) {
      throw new ValidationError("cancel_intent requires intentId");
    }
    const intent = await this.#providerPost(`/v1/payment_intents/${request.intentId}/cancel`, {
      "idempotency-key": ctx.idempotencyKey,
    });
    return this.#sdkResult(intent, `fiat:cancel:${intent.id}`);
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "fiat rail event subscription is handled by the webhook ingestion framework (@payswap/adapters webhooks), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "reconcile_intent");
    if (request.intentId === undefined) {
      throw new ValidationError("reconcile_intent requires intentId");
    }
    // Reconciliation-as-authority (INV-X03): re-fetch by external object id —
    // the webhook-loss recovery connector drives exactly this re-fetch.
    const intent = await this.#providerGetIntent(request.intentId);
    return this.#sdkResult(intent, `fiat:reconcile:${request.intentId}`);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "fiat rail disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and the credential reference); this provider surface offers no self-disconnect endpoint in Stage 5",
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md): re-reads the secret-store
   * reference; a rotation is only real when the reference CHANGED since the
   * last resolved one (the provisioning step happens at the provider, never
   * here). Returns the new opaque ref plus rotation evidence (INV-E02); the
   * old credential must be revoked only after a successful health probe on
   * the new one (documented procedure step d).
   */
  async rotateCredentials(ctx: SdkCallContext): Promise<CredentialRotationResult> {
    this.requireAuthority(ctx, "credential_rotation");
    const current = this.#currentCredentialRef();
    if (current === undefined) {
      throw new RailNotAuthorizedError(
        "cannot rotate credentials: no credential reference is provisioned for the fiat rail (packages/rails/BLOCKED-RAILS.md)",
        { railId: FIAT_RAIL_ADAPTER_ID, envVar: this.#credentialEnvVar },
      );
    }
    const previous = this.#cachedCredentialRef;
    if (previous === undefined) {
      // First resolution records the baseline; a rotation requires a NEW
      // reference to appear afterwards.
      this.#cachedCredentialRef = current;
      throw new ValidationError(
        "credential baseline recorded on first use; rotation requires a subsequently provisioned NEW reference (CREDENTIAL-ROTATION.md step b)",
      );
    }
    if (current === previous) {
      throw new ValidationError(
        "credential rotation requires a NEW provisioned reference: the env var still resolves to the previous reference (CREDENTIAL-ROTATION.md step b)",
      );
    }
    this.#cachedCredentialRef = current;
    const rotatedAt = this.now();
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId: `fiat:cred-rotation:${rotatedAt}`,
      evidenceRef: `credential-rotation:${this.#credentialEnvVar}`,
      kind: "AUDIT_LOG",
      providerState: railEnvelope({
        providerName: FIAT_RAIL_PROVIDER_NAME,
        providerVersion: this.#apiVersion,
        objectType: "credential_rotation",
        externalId: this.#credentialEnvVar,
        revision: `rotation-${rotatedAt}`,
        state: { rotated: true, envVar: this.#credentialEnvVar },
        family: "other",
        lifecycleStep: "rotated",
        isTerminal: false,
        requiresCustomerAction: false,
        observedAt: isoTimestamp(rotatedAt),
        provenanceSource: "OPERATOR",
      }),
      recordedAt: rotatedAt,
    });
    return {
      rotatedAt,
      newCredentialRef: current,
      evidence,
    };
  }

  /**
   * Read-only provider probe — a provider-reachability projection ONLY,
   * never a business outcome. Without credentials the probe documents the
   * blocked state (endpoint reachable but unauthorized → DEGRADED with
   * reasons; INV-C01/C02, INV-NC04). A transport failure is UNKNOWN.
   */
  async health(): Promise<ConnectorHealthReport> {
    const credentialRef = this.#currentCredentialRef();
    const lastCheckedAt = isoTimestamp(this.now());
    const base = {
      connectorId: "connector.rails.fiat",
      providerName: FIAT_RAIL_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (credentialRef === undefined) {
      // Probe without credentials: any HTTP answer proves endpoint
      // reachability; the rail itself stays non-serving (documented).
      let endpointAnswered: boolean;
      try {
        await this.#http(`${this.#apiBase}/v1/charges`, {
          method: "GET",
          headers: {},
          timeoutMs: this.#timeoutMs,
        });
        endpointAnswered = true;
      } catch {
        endpointAnswered = false;
      }
      return {
        ...base,
        status: endpointAnswered ? "DEGRADED" : "UNKNOWN",
        lastCheckedAt,
        degradedReasons: endpointAnswered
          ? [
              "credentials absent: provider endpoint reachable (probe answered) but rail authorization cannot be established — availability UNKNOWN (INV-C01/C02; packages/rails/BLOCKED-RAILS.md)",
            ]
          : ["provider endpoint unreachable — availability UNKNOWN (INV-C02)"],
      };
    }
    try {
      await this.#providerGetIntent("health_probe");
      return { ...base, status: "HEALTHY", lastCheckedAt, degradedReasons: [] };
    } catch (error) {
      if (error instanceof RailTransportError) {
        return {
          ...base,
          status: "UNKNOWN",
          lastCheckedAt,
          degradedReasons: ["provider transport unreachable (INV-C02: never a business outcome)"],
        };
      }
      return {
        ...base,
        status: "DEGRADED",
        lastCheckedAt,
        degradedReasons: [
          `provider answered with an error (never a business outcome): ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  // -- internals -------------------------------------------------------------------

  #currentCredentialRef(): string | undefined {
    const value = this.#env[this.#credentialEnvVar];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  #requireCredentials(): { readonly secretRef: string } {
    const secretRef = this.#currentCredentialRef();
    if (secretRef === undefined) {
      throw new RailNotAuthorizedError(
        "fiat rail is not authorized: credential reference not provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md)",
        { railId: FIAT_RAIL_ADAPTER_ID, envVar: this.#credentialEnvVar },
      );
    }
    if (this.#cachedCredentialRef === undefined) {
      this.#cachedCredentialRef = secretRef;
    }
    return { secretRef };
  }

  #request(ctx: SdkCallContext, kind: FiatCallRequest["kind"]): FiatCallRequest {
    const candidate = (ctx.request ?? {}) as Partial<FiatCallRequest>;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ValidationError("fiat rail call request must be an object");
    }
    if (candidate.amountMinor !== undefined && !/^\d+$/.test(candidate.amountMinor)) {
      throw new ValidationError("amountMinor must be an exact integer minor-units string (INV-F01)");
    }
    return { ...candidate, kind };
  }

  #sdkResult(
    intent: FiatPaymentIntentProviderObject,
    evidenceId: string,
  ): SdkCallResult {
    const now: TimestampMs = this.#clock.now();
    const envelope = fiatPaymentIntentEnvelope({
      intent,
      revision: intent.id,
      observedAt: isoTimestamp(now),
    });
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId,
      evidenceRef: `payment_intent:${intent.id}`,
      kind: "EXECUTION",
      providerState: envelope,
      recordedAt: now,
    });
    // The canonical classifier consumed from the adapter framework
    // (INV-X01 discipline — UNKNOWN is never FAILED).
    return {
      providerState: envelope,
      outcome: classifyOutcome(envelope),
      evidence,
    };
  }

  async #providerGetIntent(intentId: string): Promise<FiatPaymentIntentProviderObject> {
    const credentials = this.#requireCredentials();
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}/v1/payment_intents/${intentId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${credentials.secretRef}` },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(
        "fiat rail provider transport unreachable",
        { intentId, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (response.status === 404) {
      throw new RailProviderError(`payment intent '${intentId}' not found`, { intentId });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `fiat rail provider answered HTTP ${response.status}`,
        { intentId, httpStatus: response.status },
      );
    }
    return this.#parseIntent(response.bodyText, intentId);
  }

  async #providerPost(
    path: string,
    form: Readonly<Record<string, string>>,
  ): Promise<FiatPaymentIntentProviderObject> {
    const credentials = this.#requireCredentials();
    const body = new URLSearchParams(form).toString();
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.secretRef}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(
        "fiat rail provider transport unreachable",
        { path, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `fiat rail provider answered HTTP ${response.status}`,
        { path, httpStatus: response.status },
      );
    }
    return this.#parseIntent(response.bodyText, path);
  }

  #parseIntent(bodyText: string, contextRef: string): FiatPaymentIntentProviderObject {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (cause) {
      throw new RailProviderError("fiat rail provider response is not JSON", {
        contextRef,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const candidate = parsed as Partial<FiatPaymentIntentProviderObject>;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      typeof candidate.id !== "string" ||
      typeof candidate.status !== "string"
    ) {
      throw new RailProviderError("fiat rail provider response is not a payment intent", {
        contextRef,
      });
    }
    return parsed as FiatPaymentIntentProviderObject;
  }
}
