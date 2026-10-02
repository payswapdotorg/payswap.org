/**
 * Airwallex production connector (P2-W3-002) — the REAL Airwallex adapter
 * on the v1.5 capability hierarchy and ProviderStateEnvelope.
 *
 * Authority: spec/phase-2/work-items/P2-W3-002.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md and the recorded
 * 2026-10-02 reachability datum (HTTP 403 on
 * https://api-demo.airwallex.com — endpoint REACHABLE, authentication
 * required; spec/development-state/phase-2-state.json wave_2_status). NO
 * Airwallex credential exists in this deployment: the connector is REAL but
 * fail-closed (INV-NC04) — no mock, no simulated outcome.
 *
 * API surface pinned: Airwallex API v1 (/api/v1/…), demo base
 * https://api-demo.airwallex.com, production base
 * https://api.airwallex.com.
 *
 * Laws implemented here:
 * - INV-C06 (lossless): every provider object (payment intent with its `id`
 *   and status, payout, beneficiary, balance item, webhook event) is
 *   carried VERBATIM in the envelope `state` with an ADDITIVE
 *   classification. Statuses are never renamed, never dropped; an UNKNOWN
 *   status stays `other`/verbatim — NEVER FAILED.
 * - INV-C09: GET /api/v1/accounts/current/balances produces
 *   ExternalFundsPositionObservation ONLY — observations of provider-held
 *   external funds, never PaySwap custody and never a balance PaySwap owes
 *   anyone. Payouts are a DISTINCT capability family (POST
 *   /api/v1/payouts/create with an EXPLICIT beneficiary); pay-in and payout
 *   are never conflated.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (ambiguity
 *   OUTCOME_UNKNOWN, requires reconciliation) — NEVER collapsed to FAILED.
 * - INV-NC04: no credential → availability UNKNOWN (INV-C01/C02), health
 *   DEGRADED/UNKNOWN with reasons, every effectful operation throws
 *   RailNotAuthorizedError BEFORE any provider call.
 * - Credential isolation (phase-2): `PROVIDER_AIRWALLEX_CREDENTIAL_REF`
 *   bound to a vault:// reference, resolved through the P2-W1-001
 *   CredentialBroker to a SEALED bundle (client_id + client_secret pair)
 *   opened only inside `withSealedBundle` with a ConnectorRuntimeKey; an
 *   env fallback exists for deployments that inject the resolved pair under
 *   the same config key. Material NEVER enters any envelope, log line or
 *   evidence record.
 * - Auth mapping (recorded here exactly as implemented): POST
 *   /api/v1/authentication/login with `Authorization: Basic
 *   base64(client_id:client_secret)` and an empty JSON body → { token,
 *   expires_at }; every subsequent call carries `Authorization: Bearer
 *   <token>`. The token is cached until the provider-declared expiry and
 *   re-acquired per credential epoch — material exists only inside the
 *   credential callback frame.
 * - Webhook verification (the documented scheme, recorded here exactly):
 *   the `X-Signature` header must equal hex(HMAC-SHA256(webhook signing
 *   secret, RAW request body)), compared CONSTANT-TIME. Event types (e.g.
 *   payment_intent.status_changed, payout.status_changed) are preserved
 *   VERBATIM; replay/duplication defense is the (provider, eventId) dedupe
 *   at the ingestor — the scheme carries no timestamp.
 * - Idempotency honesty: the `request_id` is derived deterministically from
 *   the protocol idempotency key (INV-F05) — Airwallex ENFORCES request_id
 *   uniqueness; a duplicate surfaces as the
 *   AirwallexDuplicateRequestIdError provider error class, never a silent
 *   success.
 */

import { ValidationError } from "@payswap/protocol";
import type { PaySwapErrorDetails, ProtocolClock, TimestampMs } from "@payswap/protocol";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectorCapabilityPack,
  ProviderIdentity,
  ProviderStateEnvelope,
} from "@payswap/connectors";
import { validateCapabilityDefinition } from "@payswap/connectors";
import { observeCapability, unknownReachabilityObservation } from "@payswap/connectors";
import type { ExternalFundsPositionObservation } from "@payswap/connectors";
import { BaseRailAdapter, ConnectorSDK, classifyOutcome } from "@payswap/adapters";
import type {
  ConnectorHealthReport,
  ConnectorRuntimeKey,
  CredentialBroker,
  CredentialRotationResult,
  ProviderWebhookIngestor,
  ProviderWebhookRawEvent,
  SdkCallContext,
  SdkCallResult,
  WebhookSignatureVerifier,
} from "@payswap/adapters";
import { ProviderWebhookIngestor as WebhookIngestor } from "@payswap/adapters";
import { providerCredentialConfigKey } from "@payswap/adapters";
import type { ProviderExecutionEvidenceDraft } from "@payswap/execution";
import { createHmac } from "node:crypto";
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
// Identity (pinned — the API generation is part of the provider contract)
// ---------------------------------------------------------------------------

export const AIRWALLEX_PROVIDER_NAME = "airwallex" as const;
/** The pinned Airwallex API version (the /api/v1 surface). */
export const AIRWALLEX_API_VERSION = "v1" as const;
export const AIRWALLEX_RAIL_ADAPTER_ID = "rail.airwallex" as const;
export const AIRWALLEX_RAIL_IMPLEMENTATION_ID = "impl.rails.airwallex.v1" as const;
export const AIRWALLEX_CONNECTOR_ID = "connector.rails.airwallex" as const;
export const AIRWALLEX_DEFAULT_API_BASE_DEMO = "https://api-demo.airwallex.com" as const;
export const AIRWALLEX_DEFAULT_API_BASE_PROD = "https://api.airwallex.com" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("airwallex")` —
 * `PROVIDER_AIRWALLEX_CREDENTIAL_REF`, bound to
 * `vault://payswap/providers/airwallex/test-20261002` (ABSENT in this
 * deployment — the rail fails closed).
 */
export const AIRWALLEX_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  AIRWALLEX_PROVIDER_NAME,
);

/**
 * The recorded reachability datum (probed 2026-10-02): the Airwallex DEMO
 * API endpoint answered HTTP 403 without credentials — the endpoint is
 * REACHABLE and authentication is the missing authorization. Named
 * evidence, never an assumption; `health()` re-probes live.
 */
export const AIRWALLEX_DEMO_REACHABILITY_20261002: Readonly<{
  readonly probedAt: "2026-10-02";
  readonly baseUrl: string;
  readonly httpStatus: 403;
  readonly reachable: true;
  readonly interpretation: string;
}> = Object.freeze({
  probedAt: "2026-10-02",
  baseUrl: AIRWALLEX_DEFAULT_API_BASE_DEMO,
  httpStatus: 403,
  reachable: true,
  interpretation:
    "api-demo.airwallex.com answered HTTP 403 without credentials — endpoint reachable, client_id/client_secret authentication required (INV-C01/C02: availability stays UNKNOWN until credentials are provisioned)",
});

// ---------------------------------------------------------------------------
// Capability definitions (distinct pay-in vs payout families)
// ---------------------------------------------------------------------------

export const AIRWALLEX_PAYMENT_INTENT_CAPABILITY_ID =
  "cap.rails.airwallex.payment_intent" as const;
export const AIRWALLEX_PAYOUT_CAPABILITY_ID = "cap.rails.airwallex.payout" as const;
export const AIRWALLEX_BALANCE_OBSERVATION_CAPABILITY_ID =
  "cap.rails.airwallex.balance_observation" as const;

/**
 * The provider-state vocabulary this connector maps (INV-C06): every
 * Airwallex payment-intent status with its additive classification.
 *
 * | Airwallex status | family            | isTerminal | customerAction |
 * |------------------|-------------------|------------|----------------|
 * | PENDING          | async_processing  | false      | false          |
 * | AUTHORIZED       | capture           | false      | false          |
 * | CAPTURED         | other (settled-external) | true | false         |
 * | SETTLED          | other (settled-external) | true | false         |
 * | FAILED           | other             | true       | false          |
 * | CANCELLED        | other             | true       | false          |
 * | EXPIRED          | other             | true       | false          |
 * | (unknown)        | other             | false      | false (verbatim)|
 */
export const AIRWALLEX_PAYMENT_INTENT_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "PENDING", family: "async_processing", lifecycleStep: "pending", isTerminal: false, requiresCustomerAction: false },
  { providerState: "AUTHORIZED", family: "capture", lifecycleStep: "authorized", isTerminal: false, requiresCustomerAction: false },
  { providerState: "CAPTURED", family: "other", lifecycleStep: "settled_external", isTerminal: true, requiresCustomerAction: false },
  { providerState: "SETTLED", family: "other", lifecycleStep: "settled_external", isTerminal: true, requiresCustomerAction: false },
  { providerState: "FAILED", family: "other", lifecycleStep: "failed", isTerminal: true, requiresCustomerAction: false },
  { providerState: "CANCELLED", family: "other", lifecycleStep: "cancelled", isTerminal: true, requiresCustomerAction: false },
  { providerState: "EXPIRED", family: "other", lifecycleStep: "expired", isTerminal: true, requiresCustomerAction: false },
]);

/**
 * The Airwallex payout-status vocabulary (DISTINCT payout family): the raw
 * codes are preserved verbatim; PENDING is in flight, COMPLETED and
 * RECONCILED are terminal at the provider, CANCELLED/FAILED are terminal
 * (FAILED carries definitive failure).
 */
export const AIRWALLEX_PAYOUT_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "PENDING", family: "payout", lifecycleStep: "pending", isTerminal: false, requiresCustomerAction: false },
  { providerState: "COMPLETED", family: "payout", lifecycleStep: "completed", isTerminal: true, requiresCustomerAction: false },
  { providerState: "RECONCILED", family: "payout", lifecycleStep: "reconciled", isTerminal: true, requiresCustomerAction: false },
  { providerState: "CANCELLED", family: "payout", lifecycleStep: "cancelled", isTerminal: true, requiresCustomerAction: false },
  { providerState: "FAILED", family: "payout", lifecycleStep: "failed", isTerminal: true, requiresCustomerAction: false },
]);

function airwallexCapabilityDefinition(input: {
  readonly capabilityId: string;
  readonly summary: string;
  readonly operation: string;
  readonly description: string;
  readonly requiredPermissions: readonly string[];
  readonly requiredScopes: readonly string[];
  readonly providerStates: readonly {
    readonly providerState: string;
    readonly canonicalState: string;
    readonly requiresCustomerAction: boolean;
    readonly isTerminal: boolean;
  }[];
  readonly externalObjects: readonly {
    readonly objectType: string;
    readonly idFormat: string;
  }[];
  readonly sideEffects: readonly {
    readonly effect: string;
    readonly financialEffect: "MOVES_VALUE" | "RESERVES_VALUE" | "NONE";
    readonly reversible: boolean;
  }[];
  readonly requiredCustomerActions?: readonly {
    readonly lifecycleStep: string;
    readonly kind: string;
    readonly message: string;
  }[];
}): CapabilityDefinition {
  return validateCapabilityDefinition({
    capabilityId: input.capabilityId,
    capabilityVersion: "1.0.0",
    summary: input.summary,
    kind: "ACTION",
    requiredPermissions: input.requiredPermissions,
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: input.operation,
      stateMachine: {
        documentRef: "spec/architecture/PAYMENT-OPERATING-PLANE.md",
        version: "1",
      },
      description: input.description,
    },
    preconditions: [
      "connected instance authorized and eligible",
      "credential reference provisioned through the control plane (PROVIDER_AIRWALLEX_CREDENTIAL_REF)",
      "payment-method eligibility OBSERVED through GET /api/v1/payment_methods/current (transaction_currency/transaction_country context) — never assumed",
    ],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: input.requiredScopes,
      customerConsent: "EXPLICIT",
    },
    sideEffects: input.sideEffects.map((effect) => ({
      effect: effect.effect,
      financialEffect: effect.financialEffect,
      reversible: effect.reversible,
    })),
    idempotency: {
      idempotent: true,
      keyScope: "REQUEST",
      duplicateBehavior: "PROVIDER_DEFINED",
      retryPolicy: "REQUIRES_RECONCILIATION",
    },
    compensation: {
      compensable: false,
      cancellation: "UNTIL_SETTLEMENT",
      partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
    },
    ...(input.requiredCustomerActions !== undefined && input.requiredCustomerActions.length > 0
      ? {
          requiredCustomerActions: input.requiredCustomerActions.map((action) => ({
            action: action.kind,
            actor: "CUSTOMER" as const,
            description: action.message,
            surfaceHint: action.lifecycleStep,
          })),
        }
      : { requiredCustomerActions: [] }),
    providerVocabulary: {
      actions: [
        { action: "create_payment_intent", description: "POST /api/v1/payment_intents (request_id idempotent)" },
        { action: "confirm_intent", description: "POST /api/v1/payment_intents/{id}/confirm" },
        { action: "capture_intent", description: "POST /api/v1/payment_intents/{id}/capture" },
        { action: "read_intent", description: "GET /api/v1/payment_intents/{id}" },
        { action: "observe_payment_methods", description: "GET /api/v1/payment_methods/current (OBSERVED eligibility)" },
        { action: "create_payout", description: "POST /api/v1/payouts/create (explicit beneficiary — DISTINCT family)" },
        { action: "read_beneficiary", description: "GET /api/v1/beneficiaries/{id}" },
        { action: "observe_balances", description: "GET /api/v1/accounts/current/balances (never custody)" },
      ],
      states: input.providerStates,
    },
    externalObjects: input.externalObjects.map((object) => ({
      objectType: object.objectType,
      idFormat: object.idFormat,
      revisioned: true,
      revisionFormat: "provider-id-status",
    })),
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "Airwallex settlement schedule" },
    constraints: [
      {
        kind: "JURISDICTION",
        description:
          "local payment methods and currencies are exposed ONLY when the connected account has them enabled — observed through GET /api/v1/payment_methods/current, never assumed",
      },
    ],
  });
}

/** The canonical capability definitions consumed by the Airwallex connector. */
export function airwallexCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return Object.freeze([
    airwallexCapabilityDefinition({
      capabilityId: AIRWALLEX_PAYMENT_INTENT_CAPABILITY_ID,
      summary: "Payment-intent lifecycle on the real Airwallex API v1",
      operation: "rails.airwallex.payment.intent",
      description:
        "POST /api/v1/payment_intents { request_id, amount (exact decimal string), currency, merchant_order_id } → { id, status }; POST …/{id}/confirm and …/{id}/capture complete the intent; statuses stay VERBATIM (PENDING/AUTHORIZED/CAPTURED/FAILED/CANCELLED/EXPIRED/SETTLED); a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: AIRWALLEX_PAYMENT_INTENT_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "payment_intent", idFormat: "int_[A-Za-z0-9]+" },
      ],
      sideEffects: [
        { effect: "moves payer value when the intent is confirmed and captured at Airwallex", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      requiredCustomerActions: [
        {
          lifecycleStep: "pending",
          kind: "PROVIDER_CHALLENGE_REDIRECT",
          message: "Complete the payment at the provider surface the intent was created for (the provider directs the customer journey)",
        },
      ],
    }),
    airwallexCapabilityDefinition({
      capabilityId: AIRWALLEX_PAYOUT_CAPABILITY_ID,
      summary: "Payouts with EXPLICIT beneficiaries — the DISTINCT payout family",
      operation: "rails.airwallex.payout.create",
      description:
        "POST /api/v1/payouts/create { payout_method, beneficiary_id, amount, currency, request_id } — the beneficiary is EXPLICIT (GET /api/v1/beneficiaries/{id}); payout statuses stay VERBATIM (PENDING/COMPLETED/CANCELLED/FAILED/RECONCILED…); balances are OBSERVATIONS ONLY (INV-C09 — never custody)",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: AIRWALLEX_PAYOUT_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "payout", idFormat: "po_[A-Za-z0-9]+" },
        { objectType: "beneficiary", idFormat: "bene_[A-Za-z0-9]+" },
      ],
      sideEffects: [
        { effect: "moves account value to an explicit beneficiary when the payout completes at Airwallex", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    airwallexCapabilityDefinition({
      capabilityId: AIRWALLEX_BALANCE_OBSERVATION_CAPABILITY_ID,
      summary: "Account-balance OBSERVATION (never custody)",
      operation: "rails.airwallex.balance.observe",
      description:
        "Observe the connected account's balances (GET /api/v1/accounts/current/balances) as ExternalFundsPositionObservations ONLY: provider-held external funds, never PaySwap custody (INV-C09)",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      providerStates: [
        { providerState: "observed", canonicalState: "other:observed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "balance_list", idFormat: "balances:[0-9]+" }],
      sideEffects: [],
    }),
  ]);
}

/** The connector capability pack backing the Airwallex rail. */
export function airwallexRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.airwallex",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: airwallexCapabilityDefinitions().map((definition) => ({
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
    })),
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "payments:read"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.airwallex.provider_state", version: "1.0.0" }],
    objectMappings: [
      { externalObjectType: "payment_intent", canonicalObjectRef: "payswap:payment", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payout", canonicalObjectRef: "payswap:external_funds_observation", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "beneficiary", canonicalObjectRef: "payswap:external_counterparty", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "balance_list", canonicalObjectRef: "payswap:external_funds_observation", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 50, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-airwallex-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Provider object shapes (opaque passthrough — never domain primitives)
// ---------------------------------------------------------------------------

/** The raw Airwallex payment-intent object (opaque passthrough). */
export interface AirwallexPaymentIntentProviderObject {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: string | number;
  readonly currency?: string;
  readonly merchant_order_id?: string;
  readonly request_id?: string;
  readonly [key: string]: unknown;
}

/** The raw Airwallex payout object (opaque passthrough). */
export interface AirwallexPayoutProviderObject {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: string | number;
  readonly currency?: string;
  readonly beneficiary_id?: string;
  readonly payout_method?: string;
  readonly request_id?: string;
  readonly [key: string]: unknown;
}

/** The raw Airwallex beneficiary object (opaque passthrough). */
export interface AirwallexBeneficiaryProviderObject {
  readonly id?: string;
  readonly beneficiary_type?: string;
  readonly [key: string]: unknown;
}

/** One raw Airwallex balance item (opaque passthrough). */
export interface AirwallexBalanceItemProviderObject {
  readonly currency?: string;
  readonly available_balance?: string | number;
  readonly pending_balance?: string | number;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object — Airwallex's own
// revision source is the object id + status, documented here)
// ---------------------------------------------------------------------------

/** Payment-intent revision: id + status + request_id. */
export function airwallexPaymentIntentRevision(
  intent: AirwallexPaymentIntentProviderObject,
): string {
  return `${intent.id ?? "no_id"}:${intent.status ?? "unknown"}:${intent.request_id ?? "no_request_id"}`;
}

/** Payout revision: id + status + beneficiary. */
export function airwallexPayoutRevision(payout: AirwallexPayoutProviderObject): string {
  return `${payout.id ?? "no_id"}:${payout.status ?? "unknown"}:${payout.beneficiary_id ?? "no_beneficiary"}`;
}

/** Beneficiary revision: id + type. */
export function airwallexBeneficiaryRevision(
  beneficiary: AirwallexBeneficiaryProviderObject,
): string {
  return `${beneficiary.id ?? "no_id"}:${beneficiary.beneficiary_type ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface AirwallexEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK" | "OPERATOR";
  readonly fetchId?: string;
}

const AIRWALLEX_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "id",
  "status",
  "amount",
  "currency",
  "request_id",
  "beneficiary_id",
]);

function airwallexEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: AirwallexEnvelopeContext,
): {
  readonly providerName: string;
  readonly providerVersion: string;
  readonly objectType: string;
  readonly externalId: string;
  readonly revision: string;
  readonly state: unknown;
  readonly observedAt: string;
  readonly provenanceSource: AirwallexEnvelopeContext["provenanceSource"];
  readonly fetchId?: string;
} {
  return {
    providerName: AIRWALLEX_PROVIDER_NAME,
    providerVersion: AIRWALLEX_API_VERSION,
    objectType,
    externalId,
    revision,
    state,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
}

/**
 * Deterministic, additive classification of an Airwallex payment intent
 * into a lossless ProviderStateEnvelope (INV-C06). The RAW intent is
 * carried VERBATIM as `state`; the external id is the provider's intent id.
 * Statuses map per AIRWALLEX_PAYMENT_INTENT_STATUS_MAPPING; CAPTURED and
 * SETTLED are settled-EXTERNAL (the value sits at the provider — the
 * connector claims no custody, INV-C09); an UNKNOWN status →
 * `other`/verbatim, non-terminal — NEVER FAILED.
 */
export function airwallexPaymentIntentEnvelope(
  intent: AirwallexPaymentIntentProviderObject,
  context: AirwallexEnvelopeContext,
): ProviderStateEnvelope {
  const base = airwallexEnvelopeBase(
    "payment_intent",
    intent.id ?? "no_id",
    airwallexPaymentIntentRevision(intent),
    intent,
    context,
  );
  switch (intent.status) {
    case "PENDING":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "pending",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
    case "AUTHORIZED":
      // Authorized at the provider — capture/settlement continues; the
      // connector claims NO settled funds (INV-C09), so non-terminal.
      return railEnvelope({
        ...base,
        family: "capture",
        lifecycleStep: "authorized",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
    case "CAPTURED":
    case "SETTLED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "settled_external",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
    case "FAILED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "failed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "intent_failed",
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
    case "CANCELLED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "cancelled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: { providerErrorCode: "intent_cancelled", retryable: false, ambiguity: "NONE" },
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
    case "EXPIRED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "expired",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: { providerErrorCode: "intent_expired", retryable: false, ambiguity: "NONE" },
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: intent.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
  }
}

/**
 * An Airwallex payout → the payout-family envelope (the DISTINCT payout
 * capability). The RAW payout rides the state VERBATIM with the explicit
 * beneficiary_id; statuses map per AIRWALLEX_PAYOUT_STATUS_MAPPING; an
 * unknown status stays verbatim, non-terminal (never guessed).
 */
export function airwallexPayoutEnvelope(
  payout: AirwallexPayoutProviderObject,
  context: AirwallexEnvelopeContext,
): ProviderStateEnvelope {
  const base = airwallexEnvelopeBase(
    "payout",
    payout.id ?? "no_id",
    airwallexPayoutRevision(payout),
    payout,
    context,
  );
  switch (payout.status) {
    case "PENDING":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "pending",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
    case "COMPLETED":
    case "RECONCILED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: payout.status === "COMPLETED" ? "completed" : "reconciled",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
    case "CANCELLED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "cancelled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: { providerErrorCode: "payout_cancelled", retryable: false, ambiguity: "NONE" },
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
    case "FAILED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "failed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: { providerErrorCode: "payout_failed", retryable: true, ambiguity: "NONE" },
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: payout.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
      });
  }
}

/** A beneficiary object → the external-counterparty observation envelope. */
export function airwallexBeneficiaryEnvelope(
  beneficiary: AirwallexBeneficiaryProviderObject,
  context: AirwallexEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: AIRWALLEX_PROVIDER_NAME,
    providerVersion: AIRWALLEX_API_VERSION,
    objectType: "beneficiary",
    externalId: beneficiary.id ?? "no_id",
    revision: airwallexBeneficiaryRevision(beneficiary),
    state: beneficiary,
    family: "other",
    lifecycleStep: "observed",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
  });
}

/**
 * Maps a balance item list to ExternalFundsPositionObservations — one per
 * (currency, balance kind). Observations of PROVIDER-HELD external funds
 * ONLY (INV-C09): never PaySwap custody, never a balance PaySwap owes
 * anyone. Airwallex reports balances as MAJOR-unit decimal strings: the
 * conversion to exact integer minor units is bigint-arithmetic per ISO 4217
 * exponent (INV-F01); an unknown exponent or sub-minor precision is
 * honestly reported in `unconverted` — never guessed, never fabricated.
 */
export function airwallexBalanceObservations(input: {
  readonly items: readonly AirwallexBalanceItemProviderObject[];
  readonly accountRef: string;
  readonly observedAt: string;
  readonly maxAgeSeconds?: number;
  readonly observationIdPrefix?: string;
}): {
  readonly observations: readonly ExternalFundsPositionObservation[];
  readonly unconverted: readonly { readonly currency: string; readonly reason: string }[];
} {
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  const prefix = input.observationIdPrefix ?? "airwallex-balance";
  const observations: ExternalFundsPositionObservation[] = [];
  const unconverted: { readonly currency: string; readonly reason: string }[] = [];
  for (const item of input.items) {
    const currency = item.currency;
    if (typeof currency !== "string" || currency.length === 0) {
      unconverted.push({ currency: "UNKNOWN", reason: "MALFORMED_BALANCE" });
      continue;
    }
    for (const bucket of ["available_balance", "pending_balance"] as const) {
      const balance = item[bucket];
      if (typeof balance !== "string" && typeof balance !== "number") {
        continue;
      }
      const majorDecimal = String(balance);
      let minorUnits: string;
      try {
        minorUnits = airwallexMinorUnits(majorDecimal, currency);
      } catch (error) {
        unconverted.push({
          currency: currency.toUpperCase(),
          reason: error instanceof Error ? error.message : "UNCONVERTED",
        });
        continue;
      }
      observations.push(
        Object.freeze({
          observationKind: "ExternalFundsPositionObservation" as const,
          observationId: `${prefix}:${bucket}:${currency.toUpperCase()}`,
          observedAt: input.observedAt,
          freshness: Object.freeze({
            asOf: input.observedAt,
            maxAgeSeconds,
          }),
          location: Object.freeze({
            providerName: AIRWALLEX_PROVIDER_NAME,
            accountRef: input.accountRef,
            instrumentRef: `account:${bucket}:${currency.toUpperCase()}`,
            description: `Airwallex ${bucket === "available_balance" ? "available" : "pending"} ${currency.toUpperCase()} account balance (provider-held external funds — observation, never custody)`,
          }),
          observedAmount: Object.freeze({
            currency: currency.toUpperCase(),
            minorUnits,
          }),
          provenance: Object.freeze({
            providerName: AIRWALLEX_PROVIDER_NAME,
            source: "PROVIDER_API" as const,
            capturedAt: input.observedAt,
          }),
          reconciliationState: "NOT_RECONCILED" as const,
        }),
      );
    }
  }
  return Object.freeze({
    observations: Object.freeze(observations),
    unconverted: Object.freeze(unconverted),
  });
}

/**
 * The ISO 4217 minor-unit exponents for the currencies the connector
 * converts (the Airwallex multi-currency surface). A currency outside this
 * table has an UNKNOWN exponent — honestly unconverted, never guessed.
 */
export const AIRWALLEX_MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, NZD: 2, SGD: 2, HKD: 2, CHF: 2, SEK: 2,
  NOK: 2, DKK: 2, JPY: 0, KRW: 0, VND: 0, INR: 2, CNY: 2, THB: 2, MYR: 2, PHP: 2,
  IDR: 2, BRL: 2, MXN: 2, ZAR: 2, KES: 2, GHS: 2, NGN: 2, AED: 2, TRY: 2, PLN: 2,
});

/**
 * Converts a major-unit decimal string to exact integer minor units
 * (INV-F01 — bigint arithmetic, never floats). Throws on an unknown
 * exponent or sub-minor precision — both are honest refusals.
 */
export function airwallexMinorUnits(majorDecimal: string, currency: string): string {
  const exponent = AIRWALLEX_MINOR_UNIT_EXPONENTS[currency.toUpperCase()];
  if (exponent === undefined) {
    throw new ValidationError(
      `unknown minor-unit exponent for currency '${currency.toUpperCase()}' — never guessed (INV-F01; add the exponent when the provider documents it)`,
    );
  }
  const [whole, fraction = ""] = majorDecimal.split(".");
  if (!/^\d+$/.test(whole ?? "") || (fraction.length > 0 && !/^\d+$/.test(fraction))) {
    throw new ValidationError(`malformed balance decimal '${majorDecimal}' (INV-F01)`);
  }
  const numerator = BigInt(`${whole ?? "0"}${fraction}`);
  const digits = BigInt(fraction.length);
  const target = BigInt(exponent);
  if (target >= digits) {
    return (numerator * 10n ** (target - digits)).toString();
  }
  const factor = 10n ** (digits - target);
  if (numerator % factor !== 0n) {
    throw new ValidationError(
      `balance '${majorDecimal}' ${currency.toUpperCase()} carries sub-minor precision — cannot be represented in exact minor units (INV-F01)`,
    );
  }
  return (numerator / factor).toString();
}

// ---------------------------------------------------------------------------
// Webhook verification (X-Signature: hex HMAC-SHA256 over the RAW body)
// ---------------------------------------------------------------------------

/**
 * The documented Airwallex webhook signature (recorded here exactly as
 * implemented): expected = hex(HMAC-SHA256(webhook signing secret, RAW
 * request body)). The raw body is REQUIRED — a re-serialized payload
 * changes the bytes and correctly fails.
 */
export function airwallexSignWebhookPayload(secret: string, rawPayload: string): string {
  const mac = createHmac("sha256", secret);
  mac.update(rawPayload);
  return mac.digest("hex");
}

/** Constant-time hex comparison (no early exit on the first differing byte). */
function constantTimeHexEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** The byte-exact verification result for one Airwallex webhook delivery. */
export type AirwallexWebhookDeliveryVerification =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: "MISSING_SIGNATURE" | "SIGNATURE_INVALID";
    };

/**
 * Byte-exact Airwallex webhook delivery verification: the `X-Signature`
 * header must equal hex(HMAC-SHA256(secret, rawPayload)), compared
 * CONSTANT-TIME. No timestamp exists in the scheme — replay defense is the
 * (provider, eventId) dedupe at the ingestor.
 */
export function verifyAirwallexWebhookDelivery(
  delivery: { readonly signatureHeader: string | undefined; readonly rawPayload: string },
  deps: { readonly secret: string },
): AirwallexWebhookDeliveryVerification {
  if (
    typeof delivery.signatureHeader !== "string" ||
    delivery.signatureHeader.length === 0
  ) {
    return { valid: false, reason: "MISSING_SIGNATURE" };
  }
  const expected = airwallexSignWebhookPayload(deps.secret, delivery.rawPayload);
  if (!constantTimeHexEquals(delivery.signatureHeader, expected)) {
    return { valid: false, reason: "SIGNATURE_INVALID" };
  }
  return { valid: true };
}

/**
 * The deterministic dedupe event id for one Airwallex webhook payload:
 * `${eventType}:${eventId}` — the provider's own event identity. Airwallex
 * carries the event type under `name` (documented) with `type`/`event_type`
 * accepted as documented aliases; the id under `id` with `event_id`
 * accepted the same way. Non-objects produce undefined (malformed input
 * never reaches the ledger).
 */
export function airwallexWebhookEventId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as {
    readonly name?: unknown;
    readonly type?: unknown;
    readonly event_type?: unknown;
    readonly id?: unknown;
    readonly event_id?: unknown;
  };
  const eventType =
    typeof record.name === "string" && record.name.length > 0
      ? record.name
      : typeof record.type === "string" && record.type.length > 0
        ? record.type
        : typeof record.event_type === "string" && record.event_type.length > 0
          ? record.event_type
          : undefined;
  if (eventType === undefined) {
    return undefined;
  }
  const id =
    typeof record.id === "string" || typeof record.id === "number"
      ? String(record.id)
      : typeof record.event_id === "string" || typeof record.event_id === "number"
        ? String(record.event_id)
        : "no-id";
  return `${eventType}:${id}`;
}

/**
 * Extracts the provider-declared event time (created_at, ISO 8601) as epoch
 * SECONDS — the deterministic, clock-free source the ingestor's replay
 * window consumes. Undefined when the payload declares none.
 */
export function airwallexWebhookEventTimestamp(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const createdAt = (payload as { readonly created_at?: unknown; readonly createdAt?: unknown })
    .created_at ?? (payload as { readonly createdAt?: unknown }).createdAt;
  if (typeof createdAt !== "string" || createdAt.length === 0) {
    return undefined;
  }
  const parsedMs = Date.parse(createdAt);
  if (!Number.isFinite(parsedMs)) {
    return undefined;
  }
  return String(Math.floor(parsedMs / 1000));
}

/**
 * Adapts one webhook payload into the adapters' ProviderWebhookRawEvent.
 * `headers.signature` carries the X-Signature value for the verifier.
 */
export function airwallexWebhookRawEvent(delivery: {
  readonly eventId: string;
  readonly payload: unknown;
  readonly signatureHeader: string;
  readonly timestampSeconds: string;
}): ProviderWebhookRawEvent {
  return Object.freeze({
    providerName: AIRWALLEX_PROVIDER_NAME,
    eventId: delivery.eventId,
    timestamp: delivery.timestampSeconds,
    payload: delivery.payload,
    headers: Object.freeze({
      signature: delivery.signatureHeader,
      timestamp: delivery.timestampSeconds,
    }),
  });
}

/**
 * The Airwallex X-Signature verifier on the adapters'
 * WebhookSignatureVerifier hook. The ingestor hands the CANONICAL body
 * (JSON.stringify of the parsed payload): verification succeeds exactly
 * when the canonical serialization equals the delivered bytes (the
 * transport must preserve the raw body; use
 * {@link verifyAirwallexWebhookDelivery} for byte-exact verification of raw
 * deliveries).
 */
export class AirwallexWebhookVerifier implements WebhookSignatureVerifier {
  readonly #secret: string;

  constructor(secret: string) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new ValidationError("an Airwallex webhook verifier requires a non-empty signing secret");
    }
    this.#secret = secret;
  }

  verify(
    event: ProviderWebhookRawEvent,
    canonicalBody: string,
  ): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
    const expected = airwallexSignWebhookPayload(this.#secret, canonicalBody);
    if (
      typeof event.headers.signature !== "string" ||
      event.headers.signature.length === 0 ||
      !constantTimeHexEquals(event.headers.signature, expected)
    ) {
      return { valid: false, reason: "SIGNATURE_INVALID" };
    }
    return { valid: true };
  }
}

/**
 * Wires a ProviderWebhookIngestor for Airwallex: X-Signature verification,
 * replay window over the provider-declared event time, (provider, eventId)
 * dedupe and append-only evidence — the adapters ingestor pattern with the
 * Airwallex scheme plugged in.
 */
export function createAirwallexWebhookIngestor(deps: {
  readonly secret: string;
  readonly clock: ProtocolClock;
  readonly replayWindowSeconds?: number;
  readonly futureSkewSeconds?: number;
}): ProviderWebhookIngestor {
  return new WebhookIngestor({
    verifier: new AirwallexWebhookVerifier(deps.secret),
    clock: deps.clock,
    ...(deps.replayWindowSeconds !== undefined
      ? { replayWindowSeconds: deps.replayWindowSeconds }
      : {}),
    ...(deps.futureSkewSeconds !== undefined
      ? { futureSkewSeconds: deps.futureSkewSeconds }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Idempotency (request_id derivation — INV-F05; provider-ENFORCED unique)
// ---------------------------------------------------------------------------

/**
 * Derives the Airwallex `request_id` from the protocol idempotency key
 * (INV-F05). Airwallex ENFORCES request_id uniqueness: a replayed create
 * surfaces as a duplicate-request provider error (mapped to
 * AirwallexDuplicateRequestIdError), never a silent success.
 */
export function airwallexRequestId(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap-${protocolIdempotencyKey}`;
}

/**
 * The provider error class for a REJECTED duplicate request_id — the
 * idempotency-honesty surface: the provider refused the replay, and the
 * caller reconciles by the existing object (INV-F05/INV-X03).
 */
export class AirwallexDuplicateRequestIdError extends RailProviderError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = "AirwallexDuplicateRequestIdError";
  }
}

// ---------------------------------------------------------------------------
// The RailAdapter surface (provider-neutral framework registration)
// ---------------------------------------------------------------------------

/** The Airwallex production rail adapter on the BaseRailAdapter framework. */
export class AirwallexProductionRail extends BaseRailAdapter {
  readonly adapterId = AIRWALLEX_RAIL_ADAPTER_ID;
  readonly implementationId = AIRWALLEX_RAIL_IMPLEMENTATION_ID;

  constructor() {
    const definitions = new Map<string, CapabilityDefinition>();
    for (const definition of airwallexCapabilityDefinitions()) {
      definitions.set(definition.capabilityId, definition);
    }
    super(airwallexRailCapabilityPack(), definitions);
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK; credential-gated, fail-closed)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface AirwallexControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface AirwallexConnectorConfig {
  readonly clock: ProtocolClock;
  /** Overrides the API base (defaults: DEMO base; PROD base constant). */
  readonly apiBase?: string;
  readonly environment?: "DEMO" | "PROD";
  /** Overrides the pinned API version (tests only — production pins v1). */
  readonly apiVersion?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("airwallex")` = PROVIDER_AIRWALLEX_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: AirwallexControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type AirwallexSdkRequest =
  | {
      readonly kind: "create_payment_intent";
      readonly amount: string;
      readonly currency: string;
      /** Overrides the derived request_id (airwallexRequestId). */
      readonly requestId?: string;
      readonly merchantOrderId?: string;
      readonly orderType?: string;
    }
  | { readonly kind: "confirm_intent"; readonly intentId: string }
  | {
      readonly kind: "capture_intent";
      readonly intentId: string;
      readonly amount?: string;
      readonly currency?: string;
    }
  | { readonly kind: "read_intent"; readonly intentId: string }
  | {
      readonly kind: "create_payout";
      readonly payoutMethod: string;
      readonly beneficiaryId: string;
      readonly amount: string;
      readonly currency: string;
      /** Overrides the derived request_id (airwallexRequestId). */
      readonly requestId?: string;
    }
  | { readonly kind: "read_beneficiary"; readonly beneficiaryId: string }
  | { readonly kind: "read_payout"; readonly payoutId: string };

function isAirwallexSdkRequest(candidate: unknown): candidate is AirwallexSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** The client_id/client_secret pair extracted from a credential bundle. */
export interface AirwallexClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Which credential path is live (observability — NEVER material). */
export type AirwallexCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/** One cached bearer token with its provider-declared expiry. */
interface CachedAuthToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/**
 * The real Airwallex connector (ConnectorSDK framework). Airwallex API
 * names, payloads, response shapes and quirks stay INSIDE this
 * implementation: the SDK call contract is the provider-neutral
 * `AirwallexSdkRequest` union. Every effectful operation runs behind
 * `requireAuthority` (INV-C04/F05/F06) and fails closed with
 * `RailNotAuthorizedError` BEFORE any provider call when no credential path
 * is live (INV-NC04). The bearer token is acquired per credential epoch via
 * POST /api/v1/authentication/login (Basic base64(client_id:client_secret))
 * and cached until the provider-declared expiry — material exists only
 * inside the credential callback frame.
 */
export class AirwallexConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: AirwallexControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  #credentialBaseline: string | undefined;
  #cachedToken: CachedAuthToken | undefined;

  constructor(config: AirwallexConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase =
      config.apiBase ??
      (config.environment === "PROD"
        ? AIRWALLEX_DEFAULT_API_BASE_PROD
        : AIRWALLEX_DEFAULT_API_BASE_DEMO);
    this.#apiVersion = config.apiVersion ?? AIRWALLEX_API_VERSION;
    this.#credentialConfigKey =
      config.credentialConfigKey ?? AIRWALLEX_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: AIRWALLEX_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "Airwallex (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return airwallexRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): AirwallexCredentialResolutionState {
    if (this.#controlPlane !== undefined) {
      return Object.freeze({
        kind: "CONTROL_PLANE_SEALED",
        configKey: this.#credentialConfigKey,
      });
    }
    const envMaterial = this.#envMaterial();
    if (envMaterial !== undefined) {
      return Object.freeze({
        kind: "ENV_RESOLVED_MATERIAL",
        configKey: this.#credentialConfigKey,
      });
    }
    return Object.freeze({
      kind: "NOT_PROVISIONED",
      configKey: this.#credentialConfigKey,
      reason:
        "no control-plane credentials and no env-resolved material under the config key — rail fails closed (INV-NC04; packages/rails/BLOCKED-RAILS.md §11)",
    });
  }

  // -- availability (INV-C01/C02 — two-axis, never fabricated) ---------------

  availabilityObservation(input: {
    readonly instanceId: string;
    readonly observationVersion: number;
    readonly probe?: { readonly reachable: boolean; readonly checkedAt: string };
  }): CapabilityObservation {
    const resolution = this.credentialResolutionState();
    const observedAt = isoTimestamp(this.#clock.now());
    if (resolution.kind === "NOT_PROVISIONED") {
      return unknownReachabilityObservation({
        instanceId: input.instanceId,
        observedAt,
        observationVersion: input.observationVersion,
        lastKnownCapabilityState: "AVAILABLE",
        reason:
          "credential reference not provisioned — source availability UNKNOWN (INV-C01/C02); the 2026-10-02 reachability datum recorded HTTP 403 on api-demo.airwallex.com (reachable, authentication required); see packages/rails/BLOCKED-RAILS.md §11",
        provenance: {
          providerName: AIRWALLEX_PROVIDER_NAME,
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
          providerName: AIRWALLEX_PROVIDER_NAME,
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
        providerName: AIRWALLEX_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(AIRWALLEX_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface --------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "airwallex search is not implemented — no listing surface is in the connector contract; reconciliation is by the intent id (GET /api/v1/payment_intents/{id}, INV-X03)",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "read_intent");
    if (request.kind !== "read_intent") {
      throw new ValidationError("airwallex read supports only { kind: 'read_intent' }");
    }
    const observedAt = this.#envelopeContext();
    const data = await this.#withCredentials(async (credentials) =>
      this.#providerGet(`/api/v1/payment_intents/${encodeURIComponent(request.intentId)}`, credentials),
    );
    return this.#sdkResult(
      airwallexPaymentIntentEnvelope((data ?? {}) as AirwallexPaymentIntentProviderObject, observedAt),
      `airwallex:read-intent:${request.intentId}`,
    );
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_payment_intent");
    if (request.kind !== "create_payment_intent") {
      throw new ValidationError("airwallex create supports only { kind: 'create_payment_intent' }");
    }
    const requestId = request.requestId ?? airwallexRequestId(ctx.idempotencyKey);
    const body: Record<string, unknown> = {
      request_id: requestId,
      amount: this.#exactAmount(request.amount),
      currency: request.currency.toUpperCase(),
      ...(request.merchantOrderId !== undefined
        ? { merchant_order_id: request.merchantOrderId }
        : {}),
      ...(request.orderType !== undefined ? { order_type: request.orderType } : {}),
    };
    const observedAt = this.#envelopeContext();
    // INV-X01: a transport failure mid-create is OUTCOME_UNKNOWN — the
    // intent may exist at the provider under this request_id; reconcile by
    // the intent id. NEVER FAILED.
    try {
      const data = await this.#withCredentials(async (credentials) =>
        this.#providerPost("/api/v1/payment_intents", body, credentials),
      );
      const intent = (data ?? {}) as AirwallexPaymentIntentProviderObject;
      return this.#sdkResult(
        airwallexPaymentIntentEnvelope(intent, observedAt),
        `airwallex:create-intent:${intent.id ?? requestId}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "payment_intent",
          externalId: requestId,
          operation: "create_payment_intent",
          idempotencyKey: ctx.idempotencyKey,
          transportError: error.message,
          observedAt: observedAt.observedAt,
        });
      }
      throw error;
    }
  }

  async update(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "update");
    const request = this.#request(ctx, "confirm_intent");
    if (request.kind !== "confirm_intent" && request.kind !== "capture_intent") {
      throw new ValidationError(
        "airwallex update supports only { kind: 'confirm_intent' | 'capture_intent' }",
      );
    }
    const suffix = request.kind === "confirm_intent" ? "confirm" : "capture";
    const body: Record<string, unknown> = {};
    if (request.kind === "capture_intent" && request.amount !== undefined) {
      if (request.currency === undefined) {
        throw new ValidationError("a capture amount requires the currency");
      }
      body.amount = this.#exactAmount(request.amount);
      body.currency = request.currency.toUpperCase();
    }
    const observedAt = this.#envelopeContext();
    // INV-X01: confirm/capture can move value — OUTCOME_UNKNOWN.
    try {
      const data = await this.#withCredentials(async (credentials) =>
        this.#providerPost(
          `/api/v1/payment_intents/${encodeURIComponent(request.intentId)}/${suffix}`,
          body,
          credentials,
        ),
      );
      const intent = (data ?? {}) as AirwallexPaymentIntentProviderObject;
      return this.#sdkResult(
        airwallexPaymentIntentEnvelope(intent, observedAt),
        `airwallex:${request.kind}:${request.intentId}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "payment_intent",
          externalId: request.intentId,
          operation: request.kind,
          idempotencyKey: ctx.idempotencyKey,
          transportError: error.message,
          observedAt: observedAt.observedAt,
        });
      }
      throw error;
    }
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "create_payout");
    if (
      request.kind !== "create_payout" &&
      request.kind !== "read_beneficiary" &&
      request.kind !== "read_payout"
    ) {
      throw new ValidationError(
        "airwallex executeAction supports only { kind: 'create_payout' | 'read_beneficiary' | 'read_payout' } — the DISTINCT payout family (explicit beneficiary) and its observations",
      );
    }
    const observedAt = this.#envelopeContext();
    if (request.kind === "read_beneficiary") {
      const data = await this.#withCredentials(async (credentials) =>
        this.#providerGet(
          `/api/v1/beneficiaries/${encodeURIComponent(request.beneficiaryId)}`,
          credentials,
        ),
      );
      return this.#sdkResult(
        airwallexBeneficiaryEnvelope((data ?? {}) as AirwallexBeneficiaryProviderObject, observedAt),
        `airwallex:read-beneficiary:${request.beneficiaryId}`,
      );
    }
    if (request.kind === "read_payout") {
      const data = await this.#withCredentials(async (credentials) =>
        this.#providerGet(`/api/v1/payouts/${encodeURIComponent(request.payoutId)}`, credentials),
      );
      const payout = (data ?? {}) as AirwallexPayoutProviderObject;
      return this.#sdkResult(
        airwallexPayoutEnvelope(payout, observedAt),
        `airwallex:read-payout:${request.payoutId}`,
      );
    }
    const requestId = request.requestId ?? airwallexRequestId(ctx.idempotencyKey);
    const body: Record<string, unknown> = {
      payout_method: request.payoutMethod,
      beneficiary_id: request.beneficiaryId,
      amount: this.#exactAmount(request.amount),
      currency: request.currency.toUpperCase(),
      request_id: requestId,
    };
    // INV-X01: a payout moves account value — OUTCOME_UNKNOWN, never FAILED.
    try {
      const data = await this.#withCredentials(async (credentials) =>
        this.#providerPost("/api/v1/payouts/create", body, credentials),
      );
      const payout = (data ?? {}) as AirwallexPayoutProviderObject;
      return this.#sdkResult(
        airwallexPayoutEnvelope(payout, observedAt),
        `airwallex:create-payout:${payout.id ?? requestId}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "payout",
          externalId: requestId,
          operation: "create_payout",
          idempotencyKey: ctx.idempotencyKey,
          transportError: error.message,
          observedAt: observedAt.observedAt,
        });
      }
      throw error;
    }
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "airwallex event subscription is handled by the webhook ingestion framework (createAirwallexWebhookIngestor + @payswap/adapters ProviderWebhookIngestor), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "read_intent");
    if (request.kind !== "read_intent") {
      throw new ValidationError("airwallex reconcile supports only { kind: 'read_intent' }");
    }
    // Reconciliation-as-authority (INV-X03): re-fetch by external object id.
    return this.read(ctx);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "airwallex disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and release the sealed credential handle); the provider surface offers no self-disconnect",
    );
  }

  // -- dedicated observation methods (read-only; OBSERVED eligibility) --------

  /**
   * OBSERVED payment-method eligibility: GET
   * /api/v1/payment_methods/current answers the payment methods ENABLED on
   * the connected account (scoped by transaction_currency /
   * transaction_country when supplied). This is the ONLY eligibility
   * authority — local methods and currencies are exposed only when enabled,
   * never assumed. Fail-closed without credentials (INV-NC04).
   */
  async observePaymentMethods(input: {
    readonly transactionCurrency?: string;
    readonly transactionCountry?: string;
  }): Promise<ProviderStateEnvelope> {
    const query: string[] = [];
    if (input.transactionCurrency !== undefined) {
      query.push(`transaction_currency=${encodeURIComponent(input.transactionCurrency.toUpperCase())}`);
    }
    if (input.transactionCountry !== undefined) {
      query.push(`transaction_country=${encodeURIComponent(input.transactionCountry.toUpperCase())}`);
    }
    const suffix = query.length > 0 ? `?${query.join("&")}` : "";
    const observedAt = this.#envelopeContext();
    const data = await this.#withCredentials(async (credentials) =>
      this.#providerGet(`/api/v1/payment_methods/current${suffix}`, credentials),
    );
    return railEnvelope({
      providerName: AIRWALLEX_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      objectType: "payment_methods_list",
      externalId: `payment-methods:current`,
      revision: `payment-methods:${query.toString()}`,
      state: data,
      family: "other",
      lifecycleStep: "observed",
      isTerminal: true,
      requiresCustomerAction: false,
      observedAt: observedAt.observedAt,
      provenanceSource: "PROVIDER_API",
      shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
    });
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md, Airwallex path —
   * swap-reference-then-verify): the vault binding for the control-plane
   * config key is swapped to a NEW reference at the vault; the connector
   * re-resolves per call (and drops the cached bearer token), so the
   * rotation is real exactly when the NEW reference resolves and serves a
   * successful health probe. The old client pair is revoked at Airwallex
   * only after that verification.
   */
  async rotateCredentials(ctx: SdkCallContext): Promise<CredentialRotationResult> {
    this.requireAuthority(ctx, "credential_rotation");
    if (this.#controlPlane !== undefined) {
      const handle = this.#controlPlane.broker.resolveProviderCredential(
        this.#credentialConfigKey,
      );
      const current = handle.descriptor.vaultReference;
      const previous = this.#credentialBaseline;
      if (previous === undefined) {
        this.#credentialBaseline = current;
        throw new ValidationError(
          "credential baseline recorded on first use; rotation requires a subsequently swapped NEW vault reference (CREDENTIAL-ROTATION.md, swap-reference-then-verify)",
        );
      }
      if (current === previous) {
        throw new ValidationError(
          "credential rotation requires a NEW vault reference bound to the control-plane config key: the broker still resolves the previous reference (CREDENTIAL-ROTATION.md, swap-reference-then-verify)",
        );
      }
      this.#credentialBaseline = current;
      this.#cachedToken = undefined; // the new credential epoch re-authenticates
      const rotatedAt = this.#clock.now();
      return {
        rotatedAt,
        newCredentialRef: current,
        evidence: railEvidence({
          evidenceId: `airwallex:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: AIRWALLEX_PROVIDER_NAME,
            providerVersion: this.#apiVersion,
            objectType: "credential_rotation",
            externalId: this.#credentialConfigKey,
            revision: `rotation-${rotatedAt}`,
            state: { rotated: true, configKey: this.#credentialConfigKey, vaultReference: current },
            family: "other",
            lifecycleStep: "rotated",
            isTerminal: false,
            requiresCustomerAction: false,
            observedAt: isoTimestamp(rotatedAt),
            provenanceSource: "OPERATOR",
          }),
          recordedAt: rotatedAt,
        }),
      };
    }
    const envMaterial = this.#envMaterial();
    if (envMaterial === undefined) {
      throw new RailNotAuthorizedError(
        "cannot rotate credentials: no credential path is provisioned for the airwallex rail (packages/rails/BLOCKED-RAILS.md §11)",
        { railId: AIRWALLEX_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = createHmac("sha256", "payswap-airwallex-rotation-baseline")
      .update(`${envMaterial.clientId}:${envMaterial.clientSecret}`)
      .digest("hex");
    const previous = this.#credentialBaseline;
    if (previous === undefined) {
      this.#credentialBaseline = fingerprint;
      throw new ValidationError(
        "credential baseline recorded on first use; rotation requires a subsequently provisioned NEW reference (CREDENTIAL-ROTATION.md step b)",
      );
    }
    if (fingerprint === previous) {
      throw new ValidationError(
        "credential rotation requires a NEW provisioned reference: the env var still resolves to the previous credential (CREDENTIAL-ROTATION.md step b)",
      );
    }
    this.#credentialBaseline = fingerprint;
    this.#cachedToken = undefined;
    const rotatedAt = this.#clock.now();
    return {
      rotatedAt,
      newCredentialRef: `env:${this.#credentialConfigKey}`,
      evidence: railEvidence({
        evidenceId: `airwallex:cred-rotation:${rotatedAt}`,
        evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
        kind: "AUDIT_LOG",
        providerState: railEnvelope({
          providerName: AIRWALLEX_PROVIDER_NAME,
          providerVersion: this.#apiVersion,
          objectType: "credential_rotation",
          externalId: this.#credentialConfigKey,
          revision: `rotation-${rotatedAt}`,
          state: { rotated: true, configKey: this.#credentialConfigKey, path: "env" },
          family: "other",
          lifecycleStep: "rotated",
          isTerminal: false,
          requiresCustomerAction: false,
          observedAt: isoTimestamp(rotatedAt),
          provenanceSource: "OPERATOR",
        }),
        recordedAt: rotatedAt,
      }),
    };
  }

  /**
   * Read-only provider probe — a provider-reachability projection ONLY,
   * never a business outcome. Without credentials: endpoint reachability
   * via an unauthenticated GET (any HTTP answer proves reachability — the
   * 2026-10-02 datum recorded HTTP 403 on the demo host) → DEGRADED with
   * reasons; transport failure → UNKNOWN. With credentials: the
   * authenticated login (the real probe) → HEALTHY.
   */
  async health(): Promise<ConnectorHealthReport> {
    const resolution = this.credentialResolutionState();
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: AIRWALLEX_CONNECTOR_ID,
      providerName: AIRWALLEX_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (resolution.kind === "NOT_PROVISIONED") {
      let endpointAnswered: boolean;
      try {
        await this.#http(`${this.#apiBase}/api/v1/payment_methods/current`, {
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
              `credentials absent: provider endpoint reachable (the 2026-10-02 probe recorded HTTP ${String(AIRWALLEX_DEMO_REACHABILITY_20261002.httpStatus)} — authentication required) but rail authorization cannot be established — availability UNKNOWN (INV-C01/C02; packages/rails/BLOCKED-RAILS.md §11)`,
            ]
          : ["provider endpoint unreachable — availability UNKNOWN (INV-C02)"],
      };
    }
    try {
      await this.#withCredentials(async () => undefined);
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

  // -- dedicated observation methods (read-only; INV-C09) ----------------------

  /**
   * External funds observations from GET /api/v1/accounts/current/balances —
   * one observation per (currency, balance kind) of PROVIDER-HELD funds on
   * the connected account. Observations ONLY (INV-C09): never custody,
   * never a PaySwap balance. Unconvertible balances are honestly reported.
   */
  async observeExternalFunds(): Promise<readonly ExternalFundsPositionObservation[]> {
    const observedAt = isoTimestamp(this.#clock.now());
    const data = await this.#withCredentials(async (credentials) =>
      this.#providerGet("/api/v1/accounts/current/balances", credentials),
    );
    const items = extractAirwallexBalanceItems(data);
    const accountRef = `vault:${AIRWALLEX_CREDENTIAL_CONFIG_KEY}`;
    const { observations } = airwallexBalanceObservations({
      items,
      accountRef,
      observedAt,
    });
    return observations;
  }

  /**
   * The honest observation report: the ExternalFundsPositionObservations
   * PLUS the unconverted-balance report (a currency with no known
   * minor-unit exponent, or a balance with sub-minor precision — reported,
   * never fabricated).
   */
  async observeExternalFundsWithGaps(): Promise<{
    readonly observations: readonly ExternalFundsPositionObservation[];
    readonly unconverted: readonly { readonly currency: string; readonly reason: string }[];
  }> {
    const observedAt = isoTimestamp(this.#clock.now());
    const data = await this.#withCredentials(async (credentials) =>
      this.#providerGet("/api/v1/accounts/current/balances", credentials),
    );
    const items = extractAirwallexBalanceItems(data);
    const accountRef = `vault:${AIRWALLEX_CREDENTIAL_CONFIG_KEY}`;
    return airwallexBalanceObservations({
      items,
      accountRef,
      observedAt,
    });
  }

  // -- internals -------------------------------------------------------------------

  #envelopeContext(): AirwallexEnvelopeContext {
    return {
      observedAt: isoTimestamp(this.#clock.now()),
      provenanceSource: "PROVIDER_API",
    };
  }

  #envMaterial(): AirwallexClientCredentials | undefined {
    if (this.#env === undefined) {
      return undefined;
    }
    const value = this.#env[this.#credentialConfigKey];
    if (typeof value !== "string" || value.length === 0) {
      return undefined;
    }
    return extractAirwallexClientCredentials(value);
  }

  /**
   * Runs one provider interaction with the client credential pair. The
   * control plane opens the SEALED bundle per call (material exists only
   * inside the callback frame); the env fallback injects the resolved pair
   * directly. With neither, the operation fails closed BEFORE any provider
   * call (INV-NC04). The bearer token is acquired (and cached until the
   * provider-declared expiry) INSIDE the callback.
   */
  async #withCredentials<T>(
    fn: (credentials: AirwallexClientCredentials) => Promise<T>,
  ): Promise<T> {
    if (this.#controlPlane !== undefined) {
      let handle: ReturnType<CredentialBroker["resolveProviderCredential"]>;
      try {
        handle = this.#controlPlane.broker.resolveProviderCredential(
          this.#credentialConfigKey,
        );
      } catch (error) {
        throw new RailNotAuthorizedError(
          "airwallex rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: AIRWALLEX_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => fn(extractAirwallexClientCredentials(opened.material)),
      );
    }
    const material = this.#envMaterial();
    if (material === undefined) {
      throw new RailNotAuthorizedError(
        "airwallex rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md §11)",
        { railId: AIRWALLEX_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    return fn(material);
  }

  /**
   * Acquires (or reuses) the bearer token for one credential epoch: POST
   * /api/v1/authentication/login with Basic base64(client_id:client_secret)
   * and an empty JSON body → { token, expires_at }.
   */
  async #bearerToken(credentials: AirwallexClientCredentials): Promise<string> {
    const nowMs = Number(this.#clock.now());
    if (
      this.#cachedToken !== undefined &&
      this.#cachedToken.expiresAtMs > nowMs + 1_000
    ) {
      return this.#cachedToken.token;
    }
    const basic = Buffer.from(
      `${credentials.clientId}:${credentials.clientSecret}`,
      "utf8",
    ).toString("base64");
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}/api/v1/authentication/login`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("airwallex authentication transport unreachable", {
        path: "/api/v1/authentication/login",
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("airwallex authentication response is not JSON", {
        path: "/api/v1/authentication/login",
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status < 200 || response.status >= 300) {
      const errorBody = parsed as { readonly message?: string; readonly code?: string };
      throw new RailProviderError(
        `airwallex authentication answered HTTP ${String(response.status)}: ${errorBody?.message ?? "provider error"}`,
        { path: "/api/v1/authentication/login", httpStatus: response.status },
      );
    }
    const body = parsed as { readonly token?: unknown; readonly expires_at?: unknown };
    if (typeof body.token !== "string" || body.token.length === 0) {
      throw new RailProviderError(
        "airwallex authentication response carries no token (malformed)",
        { path: "/api/v1/authentication/login", httpStatus: response.status },
      );
    }
    let expiresAtMs = nowMs + 25 * 60 * 1000; // fallback: re-auth well inside 30 min
    if (typeof body.expires_at === "string") {
      const parsedExpiry = Date.parse(body.expires_at);
      if (Number.isFinite(parsedExpiry)) {
        expiresAtMs = parsedExpiry;
      }
    } else if (typeof body.expires_at === "number" && Number.isFinite(body.expires_at)) {
      expiresAtMs = body.expires_at <= 1e12 ? body.expires_at * 1000 : body.expires_at;
    }
    this.#cachedToken = { token: body.token, expiresAtMs };
    return body.token;
  }

  #request(ctx: SdkCallContext, expectedKind: string): AirwallexSdkRequest {
    const candidate = ctx.request;
    if (!isAirwallexSdkRequest(candidate)) {
      throw new ValidationError(
        `airwallex rail call request must be an AirwallexSdkRequest object (expected kind '${expectedKind}')`,
      );
    }
    if ("amount" in candidate && candidate.amount !== undefined) {
      const amount = candidate.amount;
      if (!/^\d+(\.\d+)?$/.test(String(amount))) {
        throw new ValidationError(
          "amount must be an exact non-negative decimal string in the provider's currency units (INV-F01)",
        );
      }
    }
    return candidate;
  }

  /** Exact decimal amount passthrough (Airwallex takes decimal strings). */
  #exactAmount(amount: string): string {
    if (!/^\d+(\.\d+)?$/.test(amount)) {
      throw new ValidationError(
        "amount must be an exact non-negative decimal string (INV-F01)",
      );
    }
    return amount;
  }

  #sdkResult(providerState: ProviderStateEnvelope, evidenceId: string): SdkCallResult {
    const now: TimestampMs = this.#clock.now();
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId,
      evidenceRef: `${providerState.object.objectType}:${providerState.object.externalId}`,
      kind: "EXECUTION",
      providerState,
      recordedAt: now,
    });
    return {
      providerState,
      outcome: classifyOutcome(providerState),
      evidence,
    };
  }

  /** INV-X01: the OUTCOME_UNKNOWN envelope for a mid-effect transport failure. */
  #outcomeUnknownResult(input: {
    readonly objectType: string;
    readonly externalId: string;
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly transportError: string;
    readonly observedAt: string;
  }): SdkCallResult {
    const envelope = railEnvelope({
      providerName: AIRWALLEX_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      objectType: input.objectType,
      externalId: input.externalId,
      revision: `outcome-unknown:${input.operation}:${input.idempotencyKey}`,
      state: Object.freeze({
        outcomeUnknown: true,
        operation: input.operation,
        externalId: input.externalId,
        idempotencyKey: input.idempotencyKey,
        transportError: input.transportError,
        note: "transport failed mid-effect — the provider effect may have landed; reconcile by the intent/payout id (INV-X01/INV-X03); never coerced to FAILED",
      }),
      family: "other",
      lifecycleStep: "outcome_unknown",
      isTerminal: false,
      requiresCustomerAction: false,
      failure: {
        providerErrorCode: "transport_failed_mid_effect",
        retryable: true,
        ambiguity: "OUTCOME_UNKNOWN",
      },
      observedAt: input.observedAt,
      provenanceSource: "OPERATOR",
      shareableFields: AIRWALLEX_SHAREABLE_FIELDS,
    });
    return this.#sdkResult(envelope, `airwallex:outcome-unknown:${input.operation}:${input.idempotencyKey}`);
  }

  async #providerGet(
    path: string,
    credentials: AirwallexClientCredentials,
  ): Promise<unknown> {
    const token = await this.#bearerToken(credentials);
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("airwallex provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return this.#parseResponse(response, path);
  }

  async #providerPost(
    path: string,
    body: Readonly<Record<string, unknown>>,
    credentials: AirwallexClientCredentials,
  ): Promise<unknown> {
    const token = await this.#bearerToken(credentials);
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("airwallex provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return this.#parseResponse(response, path);
  }

  #parseResponse(
    response: { readonly status: number; readonly bodyText: string },
    path: string,
  ): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("airwallex provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status < 200 || response.status >= 300) {
      const errorBody = parsed as {
        readonly code?: string;
        readonly message?: string;
      };
      // Duplicate request_id: the provider-ENFORCED idempotency refusal —
      // its own error class, never a silent success (INV-F05).
      if (
        errorBody?.code === "duplicate_request" ||
        (errorBody?.message !== undefined &&
          /duplicate.*request_id|request_id.*duplicate/i.test(errorBody.message))
      ) {
        throw new AirwallexDuplicateRequestIdError(
          `airwallex rejected a duplicate request_id: ${errorBody.message ?? "duplicate_request"}`,
          { path, httpStatus: response.status },
        );
      }
      throw new RailProviderError(
        `airwallex provider answered HTTP ${String(response.status)}: ${errorBody?.message ?? "provider error"}`,
        { path, httpStatus: response.status },
      );
    }
    return parsed;
  }
}

/** Extracts the balance items from a /balances response (tolerant, honest). */
function extractAirwallexBalanceItems(data: unknown): readonly AirwallexBalanceItemProviderObject[] {
  if (data === null || typeof data !== "object") {
    return [];
  }
  const items = (data as { readonly items?: unknown }).items;
  if (Array.isArray(items)) {
    return items as readonly AirwallexBalanceItemProviderObject[];
  }
  if (Array.isArray(data)) {
    return data as readonly AirwallexBalanceItemProviderObject[];
  }
  return [];
}

/**
 * Extracts the Airwallex client credential pair from a vault bundle shape:
 * { clientId, clientSecret } (camelCase), { client_id, client_secret }
 * (snake_case), or a JSON-encoded object carrying either pair. Any other
 * shape refuses the call (fail-closed, no guessing).
 */
export function extractAirwallexClientCredentials(material: unknown): AirwallexClientCredentials {
  let record: unknown = material;
  if (typeof material === "string" && material.trim().startsWith("{")) {
    try {
      record = JSON.parse(material) as unknown;
    } catch {
      record = material;
    }
  }
  if (record !== null && typeof record === "object") {
    const candidate = record as Readonly<Record<string, unknown>>;
    const clientId = candidate["clientId"] ?? candidate["client_id"];
    const clientSecret = candidate["clientSecret"] ?? candidate["client_secret"];
    if (typeof clientId === "string" && clientId.length > 0 && typeof clientSecret === "string" && clientSecret.length > 0) {
      return Object.freeze({ clientId, clientSecret });
    }
  }
  throw new ValidationError(
    "the sealed credential bundle does not contain the Airwallex client pair (expected { clientId | client_id, clientSecret | client_secret })",
  );
}
