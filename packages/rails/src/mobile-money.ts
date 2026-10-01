/**
 * Mobile-money rail adapter — collection (request-to-pay) + mandate
 * semantics on the RailAdapter framework (W1-005).
 *
 * PAYMENT-OPERATING-PLANE + LOSSLESS-CONNECTOR-CAPABILITY-MODEL: the
 * customer-action-required pattern is CONSEQUENTIAL in mobile money — the
 * payer must approve a USSD/push prompt on their handset before any value
 * moves. The adapter represents that through the provider state (family
 * `customer_action_required` with a `USSD_APPROVAL` action + the provider's
 * prompt reference), NEVER flattened into a generic "pending" or error
 * (INV-C06). Recurring-debit mandates preserve their own lifecycle family
 * (`mandate`), so renewal/authority checks (reconcileMandateRenewal on the
 * settlement plane) keep operating on real provider semantics.
 *
 * Real-network policy: MTN MoMo is credential-gated (subscription key +
 * provisioned API user). Without provisioned references the rail reports
 * UNKNOWN availability with provenance (INV-C01/C02 — BLOCKED-RAILS.md) and
 * fails closed (INV-NC04). No simulated settlement ever occurs.
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
  resolveCredentialRefs,
  routableRailImplication,
  isoTimestamp,
} from "./support.js";
import type { HttpTransport, RailImplication, CredentialSourceDeclaration } from "./support.js";

// ---------------------------------------------------------------------------
// Capability + pack (consumed W2-003 vocabulary, never redefined)
// ---------------------------------------------------------------------------

export const MOBILE_MONEY_RAIL_CAPABILITY_ID = "cap.rails.mobile_money.collect" as const;
export const MOBILE_MONEY_RAIL_ADAPTER_ID = "rail.mobile_money.mtn_momo" as const;
export const MOBILE_MONEY_RAIL_IMPLEMENTATION_ID = "impl.rails.mobile_money.mtn_momo" as const;
export const MOBILE_MONEY_PROVIDER_NAME = "mtn-momo" as const;
export const MOBILE_MONEY_PROVIDER_VERSION = "1.0.0" as const;

/** The canonical capability definition consumed by the mobile-money rail. */
export function mobileMoneyRailCapabilityDefinition(): CapabilityDefinition {
  return validateCapabilityDefinition({
    capabilityId: MOBILE_MONEY_RAIL_CAPABILITY_ID,
    capabilityVersion: "1.0.0",
    summary: "Mobile-money collection (request-to-pay) with handset approval and recurring mandates",
    kind: "ACTION",
    requiredPermissions: ["payments:write"],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: "rails.mobile_money.request_to_pay",
      stateMachine: {
        documentRef: "spec/architecture/PAYMENT-OPERATING-PLANE.md",
        version: "1",
      },
      description:
        "Request a mobile-money payment from a payer who must approve a USSD/push prompt on their handset; recurring debits run under an explicit provider mandate",
    },
    preconditions: [
      "connected instance authorized and eligible",
      "credential references provisioned (subscription key + API user, env-driven — CREDENTIAL-ROTATION.md)",
      "payer MSISDN reachable on the provider network",
    ],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["payments:execute", "collections:write"],
      customerConsent: "EXPLICIT",
    },
    sideEffects: [
      { effect: "moves payer wallet value on handset approval", financialEffect: "MOVES_VALUE", reversible: false },
    ],
    idempotency: {
      idempotent: true,
      keyScope: "PROVIDER_ACCOUNT",
      duplicateBehavior: "RETURNED_SAME_RESULT",
      retryPolicy: "REQUIRES_RECONCILIATION",
    },
    compensation: {
      compensable: false,
      cancellation: "BEFORE_EXECUTION",
      partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
    },
    requiredCustomerActions: [
      {
        action: "approve_handset_prompt",
        actor: "CUSTOMER",
        description: "Approve the USSD/push payment prompt sent to the payer handset",
        surfaceHint: "provider_prompt_reference",
      },
    ],
    providerVocabulary: {
      actions: [
        { action: "request_to_pay", description: "Create a collection request toward the payer" },
        { action: "mandate.create", description: "Create a recurring-debit mandate" },
        { action: "mandate.cancel", description: "Cancel a recurring-debit mandate" },
      ],
      states: [
        { providerState: "PENDING", canonicalState: "customer_action_required:handset_approval_pending", requiresCustomerAction: true, isTerminal: false },
        { providerState: "ONGOING", canonicalState: "async_processing:ongoing", requiresCustomerAction: false, isTerminal: false },
        { providerState: "SUCCESSFUL", canonicalState: "other:successful", requiresCustomerAction: false, isTerminal: true },
        { providerState: "FAILED", canonicalState: "other:failed", requiresCustomerAction: false, isTerminal: true },
        { providerState: "TIMEOUT", canonicalState: "other:timeout", requiresCustomerAction: false, isTerminal: true },
        { providerState: "mandate.created", canonicalState: "mandate:created", requiresCustomerAction: true, isTerminal: false },
        { providerState: "mandate.active", canonicalState: "mandate:active", requiresCustomerAction: false, isTerminal: false },
        { providerState: "mandate.suspended", canonicalState: "mandate:suspended", requiresCustomerAction: false, isTerminal: false },
        { providerState: "mandate.cancelled", canonicalState: "mandate:cancelled", requiresCustomerAction: false, isTerminal: true },
      ],
    },
    externalObjects: [
      {
        objectType: "request_to_pay",
        idFormat: "uuid",
        revisioned: true,
        revisionFormat: "provider-status-etag",
      },
      {
        objectType: "mandate",
        idFormat: "mandate_[A-Za-z0-9]+",
        revisioned: true,
        revisionFormat: "provider-status-etag",
      },
    ],
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "MNO wallet settlement" },
    constraints: [
      {
        kind: "JURISDICTION",
        description: "Mobile-money collection availability follows the operator's licensed markets",
      },
    ],
  });
}

/** The connector capability pack backing the mobile-money rail. */
export function mobileMoneyRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.mobile_money",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: [
      { capabilityId: MOBILE_MONEY_RAIL_CAPABILITY_ID, capabilityVersion: "1.0.0" },
    ],
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "collections:write"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [
      { schemaId: "schema.rails.mobile_money.request_to_pay", version: "1.0.0" },
      { schemaId: "schema.rails.mobile_money.mandate", version: "1.0.0" },
    ],
    objectMappings: [
      {
        externalObjectType: "request_to_pay",
        canonicalObjectRef: "payswap:payment",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "mandate",
        canonicalObjectRef: "payswap:recurring_mandate",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 60, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-01T00:00:00.000Z",
      contentHash: "hash:rails-momo-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Provider state classification (INV-C06 — USSD/push + mandate preserved)
// ---------------------------------------------------------------------------

/** Provider-native request-to-pay statuses (raw vocabulary, preserved verbatim). */
export const MOBILE_MONEY_REQUEST_STATES = [
  "PENDING",
  "ONGOING",
  "SUCCESSFUL",
  "FAILED",
  "TIMEOUT",
] as const;

export type MobileMoneyRequestState = (typeof MOBILE_MONEY_REQUEST_STATES)[number];

/** Provider-native recurring-debit mandate states. */
export const MOBILE_MONEY_MANDATE_STATES = [
  "mandate.created",
  "mandate.active",
  "mandate.suspended",
  "mandate.cancelled",
] as const;

export type MobileMoneyMandateState = (typeof MOBILE_MONEY_MANDATE_STATES)[number];

/** The raw provider request-to-pay object as observed (opaque passthrough). */
export interface MobileMoneyRequestProviderObject {
  readonly referenceId: string;
  readonly status: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly payer?: { readonly partyIdType?: string; readonly partyId?: string };
  readonly reason?: { readonly code?: string; readonly message?: string };
  readonly [key: string]: unknown;
}

/** The raw provider mandate object as observed (opaque passthrough). */
export interface MobileMoneyMandateProviderObject {
  readonly mandateId: string;
  readonly status: string;
  readonly payer?: { readonly partyIdType?: string; readonly partyId?: string };
  readonly [key: string]: unknown;
}

/** The envelope input the deterministic mapper derives from. */
export interface MobileMoneyEnvelopeInput {
  readonly objectType: "request_to_pay" | "mandate";
  readonly externalId: string;
  readonly rawState: unknown;
  readonly status: string;
  readonly revision: string;
  readonly observedAt: string;
  /** The provider's prompt reference for the handset approval, when present. */
  readonly promptReference?: string;
  /** USSD deep link the provider surfaces for the approval prompt, if any. */
  readonly ussdDeepLink?: string;
  readonly failureReason?: { readonly code?: string; readonly message?: string };
  readonly fetchId?: string;
}

/**
 * Deterministic, additive classification of one mobile-money provider object
 * into a lossless ProviderStateEnvelope (INV-C06):
 *
 * - `PENDING` → family `customer_action_required` with a `USSD_APPROVAL`
 *   action carrying the provider's prompt reference / deep link — the
 *   handset-approval pattern is preserved as provider state, not flattened;
 * - `ONGOING` → `async_processing`;
 * - `SUCCESSFUL` → terminal;
 * - `FAILED` / `TIMEOUT` → terminal with definitive failure metadata
 *   (ambiguity NONE — the provider documents these as final statuses; the
 *   raw status and reason stay verbatim for support/audit);
 * - `mandate.*` → the `mandate` family so recurring-authority semantics
 *   (renewal, suspension, cancellation) round-trip losslessly.
 * Unknown statuses fall through to the total 'other' family VERBATIM.
 */
export function mobileMoneyEnvelope(input: MobileMoneyEnvelopeInput): ProviderStateEnvelope {
  const base = {
    providerName: MOBILE_MONEY_PROVIDER_NAME,
    providerVersion: MOBILE_MONEY_PROVIDER_VERSION,
    objectType: input.objectType,
    externalId: input.externalId,
    revision: input.revision,
    state: input.rawState,
    observedAt: input.observedAt,
    provenanceSource: "PROVIDER_API" as const,
    ...(input.fetchId !== undefined ? { fetchId: input.fetchId } : {}),
  };
  switch (input.status) {
    case "PENDING":
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: "handset_approval_pending",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "USSD_APPROVAL",
          message:
            input.promptReference !== undefined
              ? `Approve the payment prompt on your handset (provider prompt reference: ${input.promptReference})`
              : "Approve the payment prompt on your handset",
          ...(input.ussdDeepLink !== undefined ? { deepLink: input.ussdDeepLink } : {}),
        },
      });
    case "ONGOING":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "ongoing",
        isTerminal: false,
        requiresCustomerAction: false,
      });
    case "SUCCESSFUL":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "successful",
        isTerminal: true,
        requiresCustomerAction: false,
      });
    case "FAILED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "failed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: input.failureReason?.code ?? "MOBILE_MONEY_FAILED",
          ...(input.failureReason?.message !== undefined
            ? { providerErrorMessage: input.failureReason.message }
            : {}),
          retryable: true,
          ambiguity: "NONE",
        },
      });
    case "TIMEOUT":
      // Provider-documented final status for request-to-pay: the prompt
      // expired without approval. Definitive no-effect; a NEW request under
      // a NEW idempotency key is a new attempt (the raw status stays
      // verbatim — INV-C06).
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "timeout",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "MOBILE_MONEY_PROMPT_TIMEOUT",
          retryable: true,
          ambiguity: "NONE",
        },
      });
    case "mandate.created":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "created",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "USSD_APPROVAL",
          message:
            "Approve the recurring-debit mandate authorization prompt on your handset",
          ...(input.ussdDeepLink !== undefined ? { deepLink: input.ussdDeepLink } : {}),
        },
      });
    case "mandate.active":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "active",
        isTerminal: false,
        requiresCustomerAction: false,
      });
    case "mandate.suspended":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "suspended",
        isTerminal: false,
        requiresCustomerAction: false,
      });
    case "mandate.cancelled":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "cancelled",
        isTerminal: true,
        requiresCustomerAction: false,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: input.status,
        isTerminal: false,
        requiresCustomerAction: false,
      });
  }
}

// ---------------------------------------------------------------------------
// The RailAdapter
// ---------------------------------------------------------------------------

/** The mobile-money rail adapter on the W3-003 framework. */
export class MtnMomoRail extends BaseRailAdapter {
  readonly adapterId = MOBILE_MONEY_RAIL_ADAPTER_ID;
  readonly implementationId = MOBILE_MONEY_RAIL_IMPLEMENTATION_ID;

  constructor() {
    super(mobileMoneyRailCapabilityPack(), new Map([[MOBILE_MONEY_RAIL_CAPABILITY_ID, mobileMoneyRailCapabilityDefinition()]]));
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK framework; credential-gated)
// ---------------------------------------------------------------------------

export interface MtnMomoClientConfig {
  readonly clock: ProtocolClock;
  /** Provider API base (default: the real MTN MoMo sandbox). */
  readonly apiBase?: string;
  readonly apiVersion?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

interface MomoCallRequest {
  readonly kind:
    | "request_to_pay"
    | "read_request"
    | "read_mandate"
    | "create_mandate"
    | "cancel_mandate"
    | "reconcile_request";
  readonly referenceId?: string;
  readonly mandateId?: string;
  readonly amountMinor?: string;
  readonly currency?: string;
  readonly payerMsisdn?: string;
  readonly payerNote?: string;
  readonly payeeNote?: string;
}

export type MobileMoneySdkRequest = MomoCallRequest;

/**
 * The MTN MoMo provider client on the ConnectorSDK framework. Provider API
 * paths, headers and quirks stay INSIDE this implementation. Effectful
 * operations run behind `requireAuthority` (INV-C04/INV-F06, INV-F05) and
 * fail closed when the credential surface is not provisioned (INV-NC04).
 */
export class MtnMomoClient extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  readonly #credentialDeclarations: readonly CredentialSourceDeclaration[] = Object.freeze([
    Object.freeze({
      railId: MOBILE_MONEY_RAIL_ADAPTER_ID,
      envVar: "PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF",
      kind: "API_KEY" as const,
      description: "MTN MoMo product subscription key reference",
    }),
    Object.freeze({
      railId: MOBILE_MONEY_RAIL_ADAPTER_ID,
      envVar: "PAYSWAP_RAILS_MOMO_API_USER_REF",
      kind: "PROVIDER_DEFINED" as const,
      description: "Provisioned MTN MoMo API user id reference",
    }),
    Object.freeze({
      railId: MOBILE_MONEY_RAIL_ADAPTER_ID,
      envVar: "PAYSWAP_RAILS_MOMO_API_KEY_REF",
      kind: "PROVIDER_DEFINED" as const,
      description: "Provisioned MTN MoMo API user secret reference",
    }),
  ]);
  #cachedCredentialRefs: Readonly<Record<string, string>> | undefined;

  constructor(config: MtnMomoClientConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase = config.apiBase ?? "https://sandbox.momodeveloper.mtn.com";
    this.#apiVersion = config.apiVersion ?? MOBILE_MONEY_PROVIDER_VERSION;
    this.#env = config.env ?? process.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: MOBILE_MONEY_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "MTN Mobile Money (collection rail)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return mobileMoneyRailCapabilityPack();
  }

  // -- availability (INV-C01/C02 — two-axis, never fabricated) ---------------

  /** The rail's credential surface declaration (refs only — never values). */
  credentialSurface(): readonly CredentialSourceDeclaration[] {
    return this.#credentialDeclarations;
  }

  /**
   * Two-axis availability observation: without ALL provisioned credential
   * references the source axis is UNKNOWN → derived availability UNKNOWN
   * (INV-C01/C02 — BLOCKED-RAILS.md). A caller-supplied live probe may
   * upgrade the source axis; nothing fabricates it.
   */
  availabilityObservation(input: {
    readonly instanceId: string;
    readonly observationVersion: number;
    readonly probe?: { readonly reachable: boolean; readonly checkedAt: string };
  }): CapabilityObservation {
    const credentials = this.#currentCredentialRefs();
    const observedAt = isoTimestamp(this.now());
    if (!credentials.provisioned) {
      return unknownReachabilityObservation({
        instanceId: input.instanceId,
        observedAt,
        observationVersion: input.observationVersion,
        lastKnownCapabilityState: "AVAILABLE",
        reason:
          "mobile-money credential references not fully provisioned (subscription key + API user) — source availability UNKNOWN (INV-C01/C02); see packages/rails/BLOCKED-RAILS.md",
        provenance: {
          providerName: MOBILE_MONEY_PROVIDER_NAME,
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
          providerName: MOBILE_MONEY_PROVIDER_NAME,
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
        providerName: MOBILE_MONEY_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN availability is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(MOBILE_MONEY_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface ---------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "mobile-money rail search is not implemented in Stage 5 (the provider collection API exposes no listing surface)",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "read_request");
    if (request.referenceId === undefined) {
      throw new ValidationError("read_request requires referenceId");
    }
    const raw = await this.#providerGet(`/collection/v1_0/requesttopay/${request.referenceId}`);
    return this.#requestResult(raw, request.referenceId, `momo:read:${request.referenceId}`);
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "request_to_pay");
    if (
      request.amountMinor === undefined ||
      request.currency === undefined ||
      request.payerMsisdn === undefined
    ) {
      throw new ValidationError(
        "request_to_pay requires amountMinor, currency and payerMsisdn (exact minor units)",
      );
    }
    // The provider answers 202 Accepted with a reference id — the payment
    // then waits for the payer's handset approval (customer-action-required
    // semantics preserved; INV-C06).
    const raw = await this.#providerPost("/collection/v1_0/requesttopay", {
      amount: request.amountMinor,
      currency: request.currency,
      payer: { partyIdType: "MSISDN", partyId: request.payerMsisdn },
      ...(request.payerNote !== undefined ? { payerNote: request.payerNote } : {}),
      ...(request.payeeNote !== undefined ? { payeeNote: request.payeeNote } : {}),
      externalId: ctx.idempotencyKey,
      "X-Reference-Id": ctx.idempotencyKey,
    });
    const referenceId =
      typeof (raw as Partial<MobileMoneyRequestProviderObject>).referenceId === "string"
        ? (raw as MobileMoneyRequestProviderObject).referenceId
        : ctx.idempotencyKey;
    return this.#requestResult(
      { ...(raw as Readonly<Record<string, unknown>>), referenceId },
      referenceId,
      `momo:request:${referenceId}`,
    );
  }

  async update(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "mobile-money request-to-pay objects are not mutable at the provider (create/read/cancel semantics only)",
    );
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "cancel_mandate");
    if (request.mandateId === undefined) {
      throw new ValidationError("cancel_mandate requires mandateId");
    }
    const raw = await this.#providerPost(
      `/collection/v1_0/mandate/${request.mandateId}/cancel`,
      {},
    );
    return this.#mandateResult(raw, request.mandateId, `momo:mandate-cancel:${request.mandateId}`);
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "mobile-money event subscription is handled by the webhook ingestion framework (@payswap/adapters webhooks), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "reconcile_request");
    if (request.referenceId === undefined) {
      throw new ValidationError("reconcile_request requires referenceId");
    }
    // INV-X03: reconciliation re-fetches by external reference id — exactly
    // what the webhook-loss recovery connector drives.
    const raw = await this.#providerGet(`/collection/v1_0/requesttopay/${request.referenceId}`);
    return this.#requestResult(raw, request.referenceId, `momo:reconcile:${request.referenceId}`);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "mobile-money disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and the credential references); no provider self-disconnect endpoint exists in Stage 5",
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md): all three references must
   * be re-provisioned (subscription key, API user, API user secret); the
   * rotation is only real when at least one reference CHANGED since the last
   * resolution. Evidence records WHICH refs rotated (names only — never
   * values).
   */
  async rotateCredentials(ctx: SdkCallContext): Promise<CredentialRotationResult> {
    this.requireAuthority(ctx, "credential_rotation");
    const current = this.#currentCredentialRefs();
    if (!current.provisioned) {
      throw new RailNotAuthorizedError(
        "cannot rotate credentials: mobile-money credential references are not fully provisioned (packages/rails/BLOCKED-RAILS.md)",
        { railId: MOBILE_MONEY_RAIL_ADAPTER_ID },
      );
    }
    const previous = this.#cachedCredentialRefs;
    if (previous === undefined) {
      this.#cachedCredentialRefs = current.refs;
      throw new ValidationError(
        "credential baseline recorded on first use; rotation requires subsequently provisioned NEW references (CREDENTIAL-ROTATION.md step b)",
      );
    }
    const changedEnvVars = this.#credentialDeclarations
      .filter((declaration) => current.refs[declaration.envVar] !== previous[declaration.envVar])
      .map((declaration) => declaration.envVar);
    if (changedEnvVars.length === 0) {
      throw new ValidationError(
        "credential rotation requires at least one NEW provisioned reference (CREDENTIAL-ROTATION.md step b)",
      );
    }
    this.#cachedCredentialRefs = current.refs;
    const rotatedAt = this.now();
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId: `momo:cred-rotation:${rotatedAt}`,
      evidenceRef: `credential-rotation:${MOBILE_MONEY_RAIL_ADAPTER_ID}`,
      kind: "AUDIT_LOG",
      providerState: railEnvelope({
        providerName: MOBILE_MONEY_PROVIDER_NAME,
        providerVersion: this.#apiVersion,
        objectType: "credential_rotation",
        externalId: MOBILE_MONEY_RAIL_ADAPTER_ID,
        revision: `rotation-${rotatedAt}`,
        // Names of rotated refs only — values never appear.
        state: { rotatedEnvVars: changedEnvVars },
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
      newCredentialRef: current.refs["PAYSWAP_RAILS_MOMO_API_KEY_REF"] ?? "momo-rotated",
      evidence,
    };
  }

  /**
   * Read-only probe of the provider token endpoint WITHOUT credentials —
   * reachability projection only, never a business outcome. An HTTP answer
   * (any status) proves reachability; transport failure is UNKNOWN.
   */
  async health(): Promise<ConnectorHealthReport> {
    const credentials = this.#currentCredentialRefs();
    const lastCheckedAt = isoTimestamp(this.now());
    const base = {
      connectorId: "connector.rails.mobile_money",
      providerName: MOBILE_MONEY_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    let endpointAnswered: boolean;
    try {
      await this.#http(`${this.#apiBase}/collection/token/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: this.#timeoutMs,
      });
      endpointAnswered = true;
    } catch {
      endpointAnswered = false;
    }
    if (!endpointAnswered) {
      return {
        ...base,
        status: "UNKNOWN",
        lastCheckedAt,
        degradedReasons: ["provider endpoint unreachable — availability UNKNOWN (INV-C02)"],
      };
    }
    return {
      ...base,
      status: credentials.provisioned ? "HEALTHY" : "DEGRADED",
      lastCheckedAt,
      degradedReasons: credentials.provisioned
        ? []
        : [
            "credentials absent: provider endpoint reachable (probe answered) but rail authorization cannot be established — availability UNKNOWN (INV-C01/C02; packages/rails/BLOCKED-RAILS.md)",
          ],
    };
  }

  // -- internals -------------------------------------------------------------------

  #currentCredentialRefs(): {
    readonly provisioned: boolean;
    readonly refs: Readonly<Record<string, string>>;
  } {
    return resolveCredentialRefs(this.#credentialDeclarations, this.#env);
  }

  #requireCredentials(): { readonly refs: Readonly<Record<string, string>> } {
    const current = this.#currentCredentialRefs();
    if (!current.provisioned) {
      throw new RailNotAuthorizedError(
        "mobile-money rail is not authorized: credential references not fully provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md)",
        { railId: MOBILE_MONEY_RAIL_ADAPTER_ID },
      );
    }
    if (this.#cachedCredentialRefs === undefined) {
      this.#cachedCredentialRefs = current.refs;
    }
    return { refs: current.refs };
  }

  #request(ctx: SdkCallContext, kind: MomoCallRequest["kind"]): MomoCallRequest {
    const candidate = (ctx.request ?? {}) as Partial<MomoCallRequest>;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ValidationError("mobile-money rail call request must be an object");
    }
    if (candidate.amountMinor !== undefined && !/^\d+(\.\d+)?$/.test(candidate.amountMinor)) {
      throw new ValidationError(
        "amountMinor must be an exact decimal string in the provider's currency exponent (INV-F01)",
      );
    }
    return { ...candidate, kind };
  }

  #requestResult(raw: unknown, referenceId: string, evidenceId: string): SdkCallResult {
    const now: TimestampMs = this.#clock.now();
    const candidate = raw as Partial<MobileMoneyRequestProviderObject>;
    const envelope = mobileMoneyEnvelope({
      objectType: "request_to_pay",
      externalId: referenceId,
      rawState: raw,
      status: typeof candidate.status === "string" ? candidate.status : "PENDING",
      revision: typeof candidate.status === "string" ? candidate.status : "PENDING",
      observedAt: isoTimestamp(now),
      ...(candidate.reason !== undefined ? { failureReason: candidate.reason } : {}),
    });
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId,
      evidenceRef: `request_to_pay:${referenceId}`,
      kind: "EXECUTION",
      providerState: envelope,
      recordedAt: now,
    });
    return { providerState: envelope, outcome: classifyOutcome(envelope), evidence };
  }

  #mandateResult(raw: unknown, mandateId: string, evidenceId: string): SdkCallResult {
    const now: TimestampMs = this.#clock.now();
    const candidate = raw as Partial<MobileMoneyMandateProviderObject>;
    const envelope = mobileMoneyEnvelope({
      objectType: "mandate",
      externalId: mandateId,
      rawState: raw,
      status: typeof candidate.status === "string" ? candidate.status : "mandate.active",
      revision: typeof candidate.status === "string" ? candidate.status : "mandate.active",
      observedAt: isoTimestamp(now),
    });
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId,
      evidenceRef: `mandate:${mandateId}`,
      kind: "EXECUTION",
      providerState: envelope,
      recordedAt: now,
    });
    return { providerState: envelope, outcome: classifyOutcome(envelope), evidence };
  }

  async #providerGet(path: string): Promise<unknown> {
    const credentials = this.#requireCredentials();
    const token = await this.#providerToken(credentials.refs);
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Target-Environment": "sandbox",
          "Ocp-Apim-Subscription-Key":
            credentials.refs["PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF"] ?? "",
        },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(
        "mobile-money provider transport unreachable",
        { path, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `mobile-money provider answered HTTP ${response.status}`,
        { path, httpStatus: response.status },
      );
    }
    return this.#parseJson(response.bodyText, path);
  }

  async #providerPost(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const credentials = this.#requireCredentials();
    const token = await this.#providerToken(credentials.refs);
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Target-Environment": "sandbox",
          "Ocp-Apim-Subscription-Key":
            credentials.refs["PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF"] ?? "",
          "X-Reference-Id": typeof body["X-Reference-Id"] === "string" ? body["X-Reference-Id"] : "",
        },
        body: JSON.stringify(body),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(
        "mobile-money provider transport unreachable",
        { path, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `mobile-money provider answered HTTP ${response.status}`,
        { path, httpStatus: response.status },
      );
    }
    if (response.bodyText.length === 0) {
      return { status: "PENDING" };
    }
    return this.#parseJson(response.bodyText, path);
  }

  /** Bearer-token issuance over the provider's Basic-auth token endpoint. */
  async #providerToken(refs: Readonly<Record<string, string>>): Promise<string> {
    const apiUser = refs["PAYSWAP_RAILS_MOMO_API_USER_REF"] ?? "";
    const apiKey = refs["PAYSWAP_RAILS_MOMO_API_KEY_REF"] ?? "";
    const basic = Buffer.from(`${apiUser}:${apiKey}`, "utf8").toString("base64");
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}/collection/token/`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Ocp-Apim-Subscription-Key": refs["PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF"] ?? "",
        },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(
        "mobile-money token endpoint unreachable",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `mobile-money token endpoint answered HTTP ${response.status} (credentials rejected)`,
        { httpStatus: response.status },
      );
    }
    const parsed = this.#parseJson(response.bodyText, "/collection/token/") as Partial<{
      access_token: string;
    }>;
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      throw new RailProviderError("mobile-money token response carries no access_token");
    }
    return parsed.access_token;
  }

  #parseJson(bodyText: string, contextRef: string): unknown {
    try {
      return JSON.parse(bodyText);
    } catch (cause) {
      throw new RailProviderError("mobile-money provider response is not JSON", {
        contextRef,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}
