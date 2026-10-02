/**
 * Adyen production connector (P2-W3-002) — the REAL Adyen adapter on the
 * v1.5 capability hierarchy and ProviderStateEnvelope.
 *
 * Authority: spec/phase-2/work-items/P2-W3-002.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md and the recorded
 * 2026-10-02 reachability datum (HTTP 401 on
 * https://checkout-test.adyen.com — endpoint REACHABLE, API key required;
 * spec/development-state/phase-2-state.json wave_2_status). NO Adyen
 * credential exists in this deployment: the connector is REAL but
 * fail-closed (INV-NC04) — no mock, no simulated outcome.
 *
 * API generation pinned: Adyen Checkout API v70
 * (https://checkout-test.adyen.com/v70/… live counterpart
 * https://checkout-live.adyen.com/v70/…). Pinning is a connector contract —
 * an unpinned surface would make the resultCode/envelope mappings
 * version-dependent.
 *
 * Laws implemented here:
 * - INV-C06 (lossless): every provider object (payment response with its
 *   `pspReference`/`resultCode`/`action`/`details`, modification response,
 *   paymentMethods listing, webhook NotificationRequestItem, payout object)
 *   is carried VERBATIM in the envelope `state` with an ADDITIVE
 *   classification. resultCodes are never renamed, never dropped; an
 *   UNKNOWN resultCode stays `other`/verbatim — NEVER FAILED.
 * - INV-C09: Adyen payouts are a DISTINCT capability family (the /payout
 *   suite is a separate API permission at Adyen) represented as
 *   ExternalFundsPositionObservation + payout-status observation ONLY —
 *   PaySwap is non-custodial and executes NO payout on this connector.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (ambiguity
 *   OUTCOME_UNKNOWN, requires reconciliation) — NEVER collapsed to FAILED.
 * - INV-NC04: no credential → availability UNKNOWN (INV-C01/C02), health
 *   DEGRADED/UNKNOWN with reasons, every effectful operation throws
 *   RailNotAuthorizedError BEFORE any provider call.
 * - Credential isolation (phase-2): `PROVIDER_ADYEN_CREDENTIAL_REF` bound
 *   to a vault:// reference, resolved through the P2-W1-001 CredentialBroker
 *   to a SEALED bundle opened only inside `withSealedBundle` with a
 *   ConnectorRuntimeKey; an env fallback exists for deployments that inject
 *   the resolved key under the same config key. Material NEVER enters any
 *   envelope, log line or evidence record.
 * - Webhook verification (the documented scheme, recorded here exactly):
 *   the expected signature is base64(HMAC-SHA256(webhook secret, RAW
 *   request body)) compared CONSTANT-TIME against the notification's
 *   `hmacSignature` field (NotificationRequestItem.additionalData.
 *   hmacSignature) or the `Signature` header. Replay/duplication defense is
 *   the (provider, eventId) dedupe at the ingestor — the signature covers
 *   the payload, not a timestamp window.
 * - Idempotency honesty: the merchant `reference` AND the `Idempotency-Key`
 *   header are derived deterministically from the protocol idempotency key
 *   (INV-F05) — Adyen dedupes by the Idempotency-Key header WHEN present;
 *   duplicateBehavior stays PROVIDER_DEFINED and the caller's protocol
 *   idempotency registrar remains the double-execution guard.
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

export const ADYEN_PROVIDER_NAME = "adyen" as const;
/** The pinned Adyen Checkout API version (v70). */
export const ADYEN_API_VERSION = "v70" as const;
export const ADYEN_RAIL_ADAPTER_ID = "rail.adyen" as const;
export const ADYEN_RAIL_IMPLEMENTATION_ID = "impl.rails.adyen.v70" as const;
export const ADYEN_CONNECTOR_ID = "connector.rails.adyen" as const;
export const ADYEN_DEFAULT_CHECKOUT_BASE_TEST = "https://checkout-test.adyen.com" as const;
export const ADYEN_DEFAULT_CHECKOUT_BASE_LIVE = "https://checkout-live.adyen.com" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("adyen")` —
 * `PROVIDER_ADYEN_CREDENTIAL_REF`, bound to
 * `vault://payswap/providers/adyen/test-20261002` (ABSENT in this
 * deployment — the rail fails closed).
 */
export const ADYEN_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  ADYEN_PROVIDER_NAME,
);

/**
 * The recorded reachability datum (probed 2026-10-02): the Adyen TEST
 * checkout endpoint answered HTTP 401 without credentials — the endpoint is
 * REACHABLE and the API key is the missing authorization. This is named
 * evidence, never an assumption; `health()` re-probes live.
 */
export const ADYEN_TEST_REACHABILITY_20261002: Readonly<{
  readonly probedAt: "2026-10-02";
  readonly baseUrl: string;
  readonly httpStatus: 401;
  readonly reachable: true;
  readonly interpretation: string;
}> = Object.freeze({
  probedAt: "2026-10-02",
  baseUrl: ADYEN_DEFAULT_CHECKOUT_BASE_TEST,
  httpStatus: 401,
  reachable: true,
  interpretation:
    "checkout-test.adyen.com answered HTTP 401 without an API key — endpoint reachable, X-API-Key authorization required (INV-C01/C02: availability stays UNKNOWN until credentials are provisioned)",
});

// ---------------------------------------------------------------------------
// Capability definitions (distinct pay-in vs payout families)
// ---------------------------------------------------------------------------

export const ADYEN_CHECKOUT_PAYMENT_CAPABILITY_ID =
  "cap.rails.adyen.checkout_payment" as const;
export const ADYEN_PAYOUT_OBSERVATION_CAPABILITY_ID =
  "cap.rails.adyen.payout_observation" as const;
export const ADYEN_PAYMENT_METHODS_OBSERVATION_CAPABILITY_ID =
  "cap.rails.adyen.payment_methods_observation" as const;

/**
 * The provider-state vocabulary this connector maps (INV-C06): every Adyen
 * Checkout resultCode with its additive classification. Exported as data so
 * certification/conformance surfaces can diff the mapping without reading
 * the implementation.
 *
 * | Adyen resultCode   | family                   | isTerminal | customerAction |
 * |--------------------|--------------------------|------------|----------------|
 * | Authorised         | capture                  | false      | false          |
 * | Refused            | other                    | true       | false          |
 * | Received           | async_processing         | false      | false          |
 * | Pending            | async_processing         | false      | false          |
 * | ConfirmationPending| async_processing         | false      | false          |
 * | RedirectShopper    | customer_action_required | false      | true           |
 * | ChallengeShopper   | customer_action_required | false      | true           |
 * | IdentifyShopper    | customer_action_required | false      | true           |
 * | PresentToShopper   | customer_action_required | false      | true           |
 * | Cancelled          | other                    | true       | false          |
 * | (unknown)          | other                    | false      | false (verbatim)|
 */
export const ADYEN_RESULT_CODE_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "Authorised", family: "capture", lifecycleStep: "authorised", isTerminal: false, requiresCustomerAction: false },
  { providerState: "Refused", family: "other", lifecycleStep: "refused", isTerminal: true, requiresCustomerAction: false },
  { providerState: "Received", family: "async_processing", lifecycleStep: "received", isTerminal: false, requiresCustomerAction: false },
  { providerState: "Pending", family: "async_processing", lifecycleStep: "pending", isTerminal: false, requiresCustomerAction: false },
  { providerState: "ConfirmationPending", family: "async_processing", lifecycleStep: "confirmation_pending", isTerminal: false, requiresCustomerAction: false },
  { providerState: "RedirectShopper", family: "customer_action_required", lifecycleStep: "redirect_shopper", isTerminal: false, requiresCustomerAction: true },
  { providerState: "ChallengeShopper", family: "customer_action_required", lifecycleStep: "challenge_shopper", isTerminal: false, requiresCustomerAction: true },
  { providerState: "IdentifyShopper", family: "customer_action_required", lifecycleStep: "identify_shopper", isTerminal: false, requiresCustomerAction: true },
  { providerState: "PresentToShopper", family: "customer_action_required", lifecycleStep: "present_to_shopper", isTerminal: false, requiresCustomerAction: true },
  { providerState: "Cancelled", family: "other", lifecycleStep: "cancelled", isTerminal: true, requiresCustomerAction: false },
]);

/**
 * The Adyen standard-webhook eventCode vocabulary (raw codes preserved
 * verbatim in every envelope/evidence). Family classification:
 * AUTHORISATION → capture (the payment authorisation event), CAPTURE /
 * CAPTURE_FAILED → capture, REFUND* / CANCELLATION* → refund, chargeback
 * and dispute lifecycle codes → dispute, payout lifecycle codes → payout,
 * anything unmapped → other/verbatim (never guessed).
 */
export const ADYEN_WEBHOOK_EVENT_CODE_MAPPING: readonly {
  readonly eventCode: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
}[] = Object.freeze([
  { eventCode: "AUTHORISATION", family: "capture", lifecycleStep: "authorisation" },
  { eventCode: "CAPTURE", family: "capture", lifecycleStep: "captured" },
  { eventCode: "CAPTURE_FAILED", family: "capture", lifecycleStep: "capture_failed" },
  { eventCode: "CANCELLATION", family: "refund", lifecycleStep: "cancelled" },
  { eventCode: "CANCEL_OR_REFUND", family: "refund", lifecycleStep: "cancel_or_refund" },
  { eventCode: "REFUND", family: "refund", lifecycleStep: "refunded" },
  { eventCode: "REFUND_FAILED", family: "refund", lifecycleStep: "refund_failed" },
  { eventCode: "REFUNDED_REVERSED", family: "refund", lifecycleStep: "refunded_reversed" },
  { eventCode: "NOTIFICATION_OF_CHARGEBACK", family: "dispute", lifecycleStep: "chargeback_notified" },
  { eventCode: "CHARGEBACK", family: "dispute", lifecycleStep: "charged_back" },
  { eventCode: "CHARGEBACK_REVERSED", family: "dispute", lifecycleStep: "chargeback_reversed" },
  { eventCode: "SECOND_CHARGEBACK", family: "dispute", lifecycleStep: "second_chargeback" },
  { eventCode: "PREARBITRATION_WON", family: "dispute", lifecycleStep: "prearbitration_won" },
  { eventCode: "PREARBITRATION_LOST", family: "dispute", lifecycleStep: "prearbitration_lost" },
  { eventCode: "OFFER_CLOSED", family: "dispute", lifecycleStep: "offer_closed" },
  { eventCode: "PAYOUT_EXPIRE", family: "payout", lifecycleStep: "expired" },
  { eventCode: "PAYOUT_DECLINE", family: "payout", lifecycleStep: "declined" },
  { eventCode: "PAYOUT_THIRDPARTY", family: "payout", lifecycleStep: "third_party" },
  { eventCode: "REPORT_AVAILABLE", family: "other", lifecycleStep: "report_available" },
]);

function adyenCapabilityDefinition(input: {
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
      "credential reference provisioned through the control plane (PROVIDER_ADYEN_CREDENTIAL_REF)",
      "merchant/entity eligibility OBSERVED through the provider (POST /v70/paymentMethods answers the enabled methods for the merchant account) — never assumed",
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
        { action: "create_payment", description: "POST /v70/payments (Checkout API v70)" },
        { action: "submit_payment_details", description: "POST /v70/payments/details (3DS/redirect completion)" },
        { action: "capture", description: "POST /v70/payments/{pspReference}/captures" },
        { action: "refund", description: "POST /v70/payments/{pspReference}/refunds" },
        { action: "cancel", description: "POST /v70/payments/{pspReference}/cancels (pre-capture)" },
        { action: "reverse", description: "POST /v70/payments/{pspReference}/reversals (post-capture)" },
        { action: "observe_payment_methods", description: "POST /v70/paymentMethods (OBSERVED eligibility)" },
        { action: "observe_payout", description: "payout-status observation ONLY (INV-C09 — no payout execution)" },
      ],
      states: input.providerStates,
    },
    externalObjects: input.externalObjects.map((object) => ({
      objectType: object.objectType,
      idFormat: object.idFormat,
      revisioned: true,
      revisionFormat: "provider-psp-reference-status",
    })),
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "Adyen settlement schedule" },
    constraints: [
      {
        kind: "JURISDICTION",
        description:
          "local payment methods and currencies are exposed ONLY when the merchant account has them enabled — observed through POST /v70/paymentMethods, never assumed",
      },
    ],
  });
}

/** The canonical capability definitions consumed by the Adyen connector. */
export function adyenCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return Object.freeze([
    adyenCapabilityDefinition({
      capabilityId: ADYEN_CHECKOUT_PAYMENT_CAPABILITY_ID,
      summary: "Checkout payment lifecycle on the real Adyen Checkout API v70",
      operation: "rails.adyen.payment.checkout",
      description:
        "POST /v70/payments { amount: { value (minor units), currency }, reference, paymentMethod, returnUrl } → { pspReference, resultCode, action?, details? } with every resultCode preserved verbatim (Authorised/Refused/Received/Pending/ConfirmationPending/RedirectShopper/ChallengeShopper/IdentifyShopper/PresentToShopper/Cancelled); POST /v70/payments/details completes 3DS/redirect returns; modifications (captures/refunds/cancels/reversals) are ASYNCHRONOUS — status 'received' means processing until webhook evidence; a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: ADYEN_RESULT_CODE_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "payment", idFormat: "pspReference:[A-Za-z0-9]+" },
        { objectType: "modification", idFormat: "pspReference:[A-Za-z0-9]+" },
      ],
      sideEffects: [
        { effect: "moves payer value when the payment is authorised and captured at Adyen", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      requiredCustomerActions: [
        {
          lifecycleStep: "redirect_shopper",
          kind: "PROVIDER_CHALLENGE_REDIRECT",
          message: "Complete the Adyen-required action (redirect/3-D Secure/voucher) — the action object rides the state verbatim",
        },
      ],
    }),
    adyenCapabilityDefinition({
      capabilityId: ADYEN_PAYOUT_OBSERVATION_CAPABILITY_ID,
      summary: "Payout OBSERVATION ONLY — the DISTINCT payout family (no payout execution)",
      operation: "rails.adyen.payout.observe",
      description:
        "Adyen payouts are a separate API permission and endpoint suite (POST /payout/…) from pay-ins; PaySwap is non-custodial and EXECUTES NO payout — payouts are represented as payout-status observations and ExternalFundsPositionObservations of provider-held funds ONLY (INV-C09)",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      providerStates: [
        { providerState: "PENDING", canonicalState: "payout:pending", requiresCustomerAction: false, isTerminal: false },
        { providerState: "COMPLETED", canonicalState: "payout:completed", requiresCustomerAction: false, isTerminal: true },
        { providerState: "FAILED", canonicalState: "payout:failed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "payout", idFormat: "pspReference:[A-Za-z0-9]+" }],
      sideEffects: [],
    }),
    adyenCapabilityDefinition({
      capabilityId: ADYEN_PAYMENT_METHODS_OBSERVATION_CAPABILITY_ID,
      summary: "Merchant-observed payment-method eligibility (POST /v70/paymentMethods)",
      operation: "rails.adyen.payment_methods.observe",
      description:
        "POST /v70/paymentMethods answers the payment methods ENABLED for the merchant account (with country/currency/amount context) — the OBSERVED eligibility surface: local methods and currencies are exposed only when the merchant has them enabled, never assumed",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      providerStates: [
        { providerState: "observed", canonicalState: "other:observed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "payment_methods_list", idFormat: "payment-methods:[0-9]+" }],
      sideEffects: [],
    }),
  ]);
}

/** The connector capability pack backing the Adyen rail (payments family). */
export function adyenRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.adyen",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: adyenCapabilityDefinitions().map((definition) => ({
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
    })),
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "payments:read"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.adyen.provider_state", version: "1.0.0" }],
    objectMappings: [
      { externalObjectType: "payment", canonicalObjectRef: "payswap:payment", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "modification", canonicalObjectRef: "payswap:payment", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payout", canonicalObjectRef: "payswap:external_funds_observation", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payment_methods_list", canonicalObjectRef: "payswap:capability_observation", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 100, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-adyen-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Provider object shapes (opaque passthrough — never domain primitives)
// ---------------------------------------------------------------------------

/** The raw Adyen /payments and /payments/details response (opaque passthrough). */
export interface AdyenPaymentResponseProviderObject {
  readonly pspReference?: string;
  readonly resultCode?: string;
  readonly action?: {
    readonly type?: string;
    readonly url?: string;
    readonly [key: string]: unknown;
  };
  readonly details?: unknown;
  readonly refusalReason?: string;
  readonly additionalData?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** The raw Adyen modification response (captures/refunds/cancels/reversals). */
export interface AdyenModificationResponseProviderObject {
  readonly pspReference?: string;
  readonly status?: string;
  readonly response?: string;
  readonly [key: string]: unknown;
}

/** The raw Adyen /paymentMethods response (observed eligibility). */
export interface AdyenPaymentMethodsResponseProviderObject {
  readonly paymentMethods?: readonly {
    readonly type?: string;
    readonly name?: string;
    readonly [key: string]: unknown;
  }[];
  readonly storedPaymentMethods?: readonly unknown[];
  readonly [key: string]: unknown;
}

/** One raw Adyen webhook NotificationRequestItem (opaque passthrough). */
export interface AdyenNotificationItemProviderObject {
  readonly pspReference?: string;
  readonly eventCode?: string;
  readonly success?: string;
  readonly eventDate?: string;
  readonly reason?: string;
  readonly amount?: { readonly value?: number | string; readonly currency?: string };
  readonly originalReference?: string;
  readonly additionalData?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** The raw Adyen payout object (opaque passthrough; observation ONLY). */
export interface AdyenPayoutProviderObject {
  readonly pspReference?: string;
  readonly status?: string;
  readonly amount?: { readonly value?: number | string; readonly currency?: string };
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object — Adyen's own
// revision source is the pspReference + resultCode/status, documented here)
// ---------------------------------------------------------------------------

/** Payment revision: pspReference + resultCode + action type. */
export function adyenPaymentRevision(payment: AdyenPaymentResponseProviderObject): string {
  return `${payment.pspReference ?? "no_psp"}:${payment.resultCode ?? "unknown"}:${
    typeof payment.action?.type === "string" ? payment.action.type : "no_action"
  }`;
}

/** Modification revision: pspReference + status (async until webhook). */
export function adyenModificationRevision(
  modification: AdyenModificationResponseProviderObject,
): string {
  return `${modification.pspReference ?? "no_psp"}:${modification.status ?? "unknown"}`;
}

/** Notification-item revision: pspReference + eventCode + success. */
export function adyenNotificationItemRevision(item: AdyenNotificationItemProviderObject): string {
  return `${item.pspReference ?? "no_psp"}:${item.eventCode ?? "unknown"}:${item.success ?? "unknown"}`;
}

/** Payout revision: pspReference + status. */
export function adyenPayoutRevision(payout: AdyenPayoutProviderObject): string {
  return `${payout.pspReference ?? "no_psp"}:${payout.status ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface AdyenEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK" | "OPERATOR";
  readonly fetchId?: string;
}

const ADYEN_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "pspReference",
  "resultCode",
  "status",
  "refusalReason",
  "eventCode",
  "success",
]);

function adyenEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: AdyenEnvelopeContext,
): {
  readonly providerName: string;
  readonly providerVersion: string;
  readonly objectType: string;
  readonly externalId: string;
  readonly revision: string;
  readonly state: unknown;
  readonly observedAt: string;
  readonly provenanceSource: AdyenEnvelopeContext["provenanceSource"];
  readonly fetchId?: string;
} {
  return {
    providerName: ADYEN_PROVIDER_NAME,
    providerVersion: ADYEN_API_VERSION,
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
 * The first-class customer-action requirement for an action resultCode: the
 * kind follows the action surface (redirect / 3-D Secure challenge /
 * identity verification / voucher presentation) and the ACTION OBJECT rides
 * the raw state VERBATIM — nothing is flattened (INV-C06).
 */
function adyenActionRequired(
  resultCode: string,
  action: AdyenPaymentResponseProviderObject["action"],
): {
  readonly kind: string;
  readonly message: string;
  readonly deepLink?: string;
} {
  const actionType = typeof action?.type === "string" ? action.type : "";
  if (resultCode === "RedirectShopper" || actionType === "redirect") {
    return {
      kind: "PROVIDER_CHALLENGE_REDIRECT",
      message: "Complete the redirect action at Adyen (the action object rides the state verbatim)",
      ...(typeof action?.url === "string" && action.url.length > 0 ? { deepLink: action.url } : {}),
    };
  }
  if (resultCode === "ChallengeShopper" || actionType.startsWith("threeDS2")) {
    return {
      kind: "PROVIDER_CHALLENGE",
      message: "Complete the 3-D Secure challenge (the action object rides the state verbatim)",
    };
  }
  if (resultCode === "IdentifyShopper") {
    return {
      kind: "PROVIDER_IDENTITY_VERIFICATION",
      message: "Complete the shopper identification challenge (the action object rides the state verbatim)",
    };
  }
  return {
    kind: "PROVIDER_VOUCHER_PRESENTATION",
    message: "Present the voucher/QR output to the shopper (the action object rides the state verbatim)",
  };
}

/**
 * Deterministic, additive classification of a POST /v70/payments (or
 * /v70/payments/details) answer into a lossless ProviderStateEnvelope
 * (INV-C06). The RAW response is carried VERBATIM as `state`; the external
 * id is the provider's pspReference. resultCodes map per
 * ADYEN_RESULT_CODE_MAPPING; an UNKNOWN resultCode → `other`/verbatim,
 * non-terminal — NEVER FAILED, never guessed.
 */
export function adyenPaymentEnvelope(
  payment: AdyenPaymentResponseProviderObject,
  context: AdyenEnvelopeContext,
): ProviderStateEnvelope {
  const base = adyenEnvelopeBase(
    "payment",
    payment.pspReference ?? "no_psp",
    adyenPaymentRevision(payment),
    payment,
    context,
  );
  switch (payment.resultCode) {
    case "Authorised":
      // Authorized at Adyen — capture/settlement continues at the provider
      // (observed via CAPTURE webhooks); the connector claims NO settled
      // funds (INV-C09), so this step is deliberately non-terminal.
      return railEnvelope({
        ...base,
        family: "capture",
        lifecycleStep: "authorised",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: ADYEN_SHAREABLE_FIELDS,
      });
    case "Refused":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "refused",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: payment.refusalReason ?? "refused",
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: ADYEN_SHAREABLE_FIELDS,
      });
    case "Received":
    case "Pending":
    case "ConfirmationPending":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep:
          ADYEN_RESULT_CODE_MAPPING.find((row) => row.providerState === payment.resultCode)
            ?.lifecycleStep ?? "processing",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: ADYEN_SHAREABLE_FIELDS,
      });
    case "RedirectShopper":
    case "ChallengeShopper":
    case "IdentifyShopper":
    case "PresentToShopper": {
      const action = adyenActionRequired(payment.resultCode, payment.action);
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep:
          ADYEN_RESULT_CODE_MAPPING.find((row) => row.providerState === payment.resultCode)
            ?.lifecycleStep ?? "action_required",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: action,
        shareableFields: ADYEN_SHAREABLE_FIELDS,
      });
    }
    case "Cancelled":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "cancelled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "cancelled",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: ADYEN_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: payment.resultCode ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: ADYEN_SHAREABLE_FIELDS,
      });
  }
}

/**
 * A modification answer (captures/refunds/cancels/reversals) → the
 * modification envelope. Adyen modifications are ASYNCHRONOUS: the response
 * carries { pspReference, status: "received" } and the TERMINAL state
 * arrives via webhook (CAPTURE / REFUND / CANCELLATION event codes) — the
 * connector represents `received` as async_processing, terminal=false, and
 * NEVER invents the terminal state (INV-C06/INV-X03).
 */
export function adyenModificationEnvelope(
  modification: AdyenModificationResponseProviderObject,
  context: AdyenEnvelopeContext,
): ProviderStateEnvelope {
  const base = adyenEnvelopeBase(
    "modification",
    modification.pspReference ?? "no_psp",
    adyenModificationRevision(modification),
    modification,
    context,
  );
  return railEnvelope({
    ...base,
    family: "async_processing",
    lifecycleStep: modification.status ?? "unknown",
    isTerminal: false,
    requiresCustomerAction: false,
    shareableFields: ADYEN_SHAREABLE_FIELDS,
  });
}

/** A /paymentMethods answer → the observed-eligibility envelope. */
export function adyenPaymentMethodsEnvelope(
  methods: AdyenPaymentMethodsResponseProviderObject,
  context: AdyenEnvelopeContext,
): ProviderStateEnvelope {
  const count = methods.paymentMethods?.length ?? 0;
  return railEnvelope({
    providerName: ADYEN_PROVIDER_NAME,
    providerVersion: ADYEN_API_VERSION,
    objectType: "payment_methods_list",
    externalId: `payment-methods:${count}`,
    revision: `payment-methods:${count}`,
    state: methods,
    family: "other",
    lifecycleStep: "observed",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: ADYEN_SHAREABLE_FIELDS,
  });
}

/**
 * Maps one Adyen webhook NotificationRequestItem to a lossless envelope.
 * The raw eventCode is preserved VERBATIM in the state AND drives the
 * family per ADYEN_WEBHOOK_EVENT_CODE_MAPPING; `success: "false"` on a
 * known-failure-family event carries definitive failure metadata; an
 * unknown eventCode → `other`/verbatim, non-terminal (never guessed).
 */
export function adyenWebhookItemEnvelope(
  item: AdyenNotificationItemProviderObject,
  context: AdyenEnvelopeContext,
): ProviderStateEnvelope {
  const base = adyenEnvelopeBase(
    "notification_item",
    `${item.pspReference ?? "no_psp"}:${item.eventCode ?? "unknown"}`,
    adyenNotificationItemRevision(item),
    item,
    { ...context, provenanceSource: "PROVIDER_WEBHOOK" },
  );
  const row = ADYEN_WEBHOOK_EVENT_CODE_MAPPING.find((entry) => entry.eventCode === item.eventCode);
  // Adyen's NotificationRequestItem.success is the string "true"/"false".
  const succeeded = item.success === "true";
  if (row === undefined) {
    return railEnvelope({
      ...base,
      family: "other",
      lifecycleStep: item.eventCode ?? "unknown",
      isTerminal: false,
      requiresCustomerAction: false,
      shareableFields: ADYEN_SHAREABLE_FIELDS,
    });
  }
  const failureFamily =
    row.family === "capture" ||
    row.family === "refund" ||
    row.family === "payout" ||
    row.family === "dispute";
  return railEnvelope({
    ...base,
    family: row.family,
    lifecycleStep: row.lifecycleStep,
    isTerminal: succeeded,
    requiresCustomerAction: false,
    ...(failureFamily && !succeeded
      ? {
          failure: {
            providerErrorCode: `${item.eventCode}_FAILED`,
            ...(item.reason !== undefined ? { providerErrorMessage: item.reason } : {}),
            retryable: true,
            ambiguity: "NONE",
          } as const,
        }
      : {}),
    shareableFields: ADYEN_SHAREABLE_FIELDS,
  });
}

/**
 * An Adyen payout object → the payout-family STATUS envelope. This is an
 * OBSERVATION of a provider-side payout (INV-C09): PaySwap executes no
 * payout; the raw object rides the state verbatim.
 */
export function adyenPayoutStatusEnvelope(
  payout: AdyenPayoutProviderObject,
  context: AdyenEnvelopeContext,
): ProviderStateEnvelope {
  const base = adyenEnvelopeBase(
    "payout",
    payout.pspReference ?? "no_psp",
    adyenPayoutRevision(payout),
    payout,
    context,
  );
  switch (payout.status) {
    case "COMPLETED":
    case "Confirmed":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "completed",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: ADYEN_SHAREABLE_FIELDS,
      });
    case "FAILED":
    case "Refused":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "failed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: { providerErrorCode: "payout_failed", retryable: true, ambiguity: "NONE" },
        shareableFields: ADYEN_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: payout.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: ADYEN_SHAREABLE_FIELDS,
      });
  }
}

// ---------------------------------------------------------------------------
// External funds observations (INV-C09 — observations, NEVER custody)
// ---------------------------------------------------------------------------

/**
 * Maps an Adyen payout object to an ExternalFundsPositionObservation of the
 * PAYOUT VALUE held/moving at the provider — an observation of provider-held
 * external funds ONLY (INV-C09): never PaySwap custody, never a balance
 * PaySwap owes anyone, and never a payout PaySwap executed. The amount is
 * converted at ISO 4217 exponents with exact bigint arithmetic (INV-F01);
 * an unknown exponent is honestly reported, never guessed.
 */
export function adyenPayoutObservation(input: {
  readonly payout: AdyenPayoutProviderObject;
  readonly accountRef: string;
  readonly observedAt: string;
  readonly maxAgeSeconds?: number;
  readonly observationIdPrefix?: string;
}): ExternalFundsPositionObservation | { readonly unconverted: true; readonly reason: string } {
  const currency = input.payout.amount?.currency;
  const value = input.payout.amount?.value;
  if (typeof currency !== "string" || currency.length === 0 || value === undefined) {
    return {
      unconverted: true,
      reason: "payout amount/currency absent or malformed in the provider object — never guessed (INV-F01)",
    };
  }
  const minorUnits = adyenMinorUnitsFromIntegerValue(value, currency);
  if (typeof minorUnits !== "string") {
    return {
      unconverted: true,
      reason: `payout amount for ${currency.toUpperCase()} is not an exact integer minor-unit value — honestly unconverted (INV-F01)`,
    };
  }
  const prefix = input.observationIdPrefix ?? "adyen-payout";
  return Object.freeze({
    observationKind: "ExternalFundsPositionObservation" as const,
    observationId: `${prefix}:${input.payout.pspReference ?? "no_psp"}`,
    observedAt: input.observedAt,
    freshness: Object.freeze({
      asOf: input.observedAt,
      maxAgeSeconds: input.maxAgeSeconds ?? 300,
    }),
    location: Object.freeze({
      providerName: ADYEN_PROVIDER_NAME,
      accountRef: input.accountRef,
      instrumentRef: `payout:${input.payout.pspReference ?? "no_psp"}`,
      description:
        "Adyen payout value at the provider (observation of provider-held external funds — PaySwap executes no payout; never custody, INV-C09)",
    }),
    observedAmount: Object.freeze({
      currency: currency.toUpperCase(),
      minorUnits,
    }),
    provenance: Object.freeze({
      providerName: ADYEN_PROVIDER_NAME,
      source: "PROVIDER_API" as const,
      capturedAt: input.observedAt,
    }),
    reconciliationState: "NOT_RECONCILED" as const,
  });
}

/**
 * Adyen amounts are INTEGER MINOR UNITS already ({ value: 1000, currency:
 * "EUR" }): the exact conversion is a bigint pass-through of the integer
 * value. A non-integer or unsafe value is refused — never floated (INV-F01).
 */
export function adyenMinorUnitsFromIntegerValue(
  value: number | string,
  currency: string,
): string | undefined {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      return undefined;
    }
    return value.toString();
  }
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Webhook verification (base64 HMAC-SHA256 over the RAW body)
// ---------------------------------------------------------------------------

/**
 * The documented Adyen webhook signature (recorded here exactly as
 * implemented): expected = base64(HMAC-SHA256(webhook secret, RAW request
 * body)). The raw body is REQUIRED — a re-serialized payload changes the
 * bytes and correctly fails.
 */
export function adyenSignWebhookPayload(secret: string, rawPayload: string): string {
  const mac = createHmac("sha256", secret);
  mac.update(rawPayload);
  // The ambient node:crypto declaration exposes hex digests; the base64
  // encoding required by the Adyen scheme is the exact byte-level
  // transformation of that digest (never a re-hash).
  return Buffer.from(mac.digest("hex"), "hex").toString("base64");
}

/** Constant-time string comparison (no early exit, no length oracle). */
function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** The verification result for one Adyen webhook delivery. */
export type AdyenWebhookDeliveryVerification =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: "MISSING_HMAC_SIGNATURE" | "HMAC_SIGNATURE_INVALID";
    };

/**
 * Byte-exact Adyen webhook delivery verification: the notification's
 * `hmacSignature` (or `Signature` header) must equal
 * base64(HMAC-SHA256(secret, rawPayload)), compared CONSTANT-TIME over the
 * RAW body. There is NO timestamp in the scheme — replay defense is the
 * (provider, eventId) dedupe at the ingestor.
 */
export function verifyAdyenWebhookDelivery(
  delivery: {
    readonly hmacSignature: string | undefined;
    readonly rawPayload: string;
  },
  deps: { readonly secret: string },
): AdyenWebhookDeliveryVerification {
  if (typeof delivery.hmacSignature !== "string" || delivery.hmacSignature.length === 0) {
    return { valid: false, reason: "MISSING_HMAC_SIGNATURE" };
  }
  const expected = adyenSignWebhookPayload(deps.secret, delivery.rawPayload);
  if (!constantTimeEquals(delivery.hmacSignature, expected)) {
    return { valid: false, reason: "HMAC_SIGNATURE_INVALID" };
  }
  return { valid: true };
}

/**
 * Extracts the hmacSignature the notification carries: either the
 * `Signature` header value or NotificationRequestItem.additionalData.
 * hmacSignature of the FIRST notification item (the documented locations).
 */
export function adyenExtractHmacSignature(rawPayload: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const items = (parsed as { readonly notificationItems?: unknown }).notificationItems;
  if (!Array.isArray(items) || items.length === 0) {
    return undefined;
  }
  const first = items[0];
  if (first === null || typeof first !== "object") {
    return undefined;
  }
  const item = (first as { readonly NotificationRequestItem?: unknown }).NotificationRequestItem;
  if (item === null || typeof item !== "object") {
    return undefined;
  }
  const additionalData = (item as { readonly additionalData?: unknown }).additionalData;
  if (additionalData === null || typeof additionalData !== "object") {
    return undefined;
  }
  const signature = (additionalData as { readonly hmacSignature?: unknown }).hmacSignature;
  return typeof signature === "string" && signature.length > 0 ? signature : undefined;
}

/**
 * The deterministic dedupe event id for one Adyen notification item:
 * `${eventCode}:${pspReference}` — the provider's own event/object identity
 * pair. Returns `eventCode:no-psp` for malformed items, undefined for
 * non-objects (malformed input never reaches the ledger).
 */
export function adyenWebhookEventId(item: unknown): string | undefined {
  if (item === null || typeof item !== "object") {
    return undefined;
  }
  const record = item as { readonly eventCode?: unknown; readonly pspReference?: unknown };
  if (typeof record.eventCode !== "string" || record.eventCode.length === 0) {
    return undefined;
  }
  const psp =
    typeof record.pspReference === "string" && record.pspReference.length > 0
      ? record.pspReference
      : "no-psp";
  return `${record.eventCode}:${psp}`;
}

/**
 * Extracts the provider-declared event time (eventDate, ISO 8601) as epoch
 * SECONDS — the deterministic, clock-free source the ingestor's replay
 * window consumes. Undefined when the item declares none.
 */
export function adyenWebhookEventTimestamp(item: unknown): string | undefined {
  if (item === null || typeof item !== "object") {
    return undefined;
  }
  const eventDate = (item as { readonly eventDate?: unknown }).eventDate;
  if (typeof eventDate !== "string" || eventDate.length === 0) {
    return undefined;
  }
  const parsedMs = Date.parse(eventDate);
  if (!Number.isFinite(parsedMs)) {
    return undefined;
  }
  return String(Math.floor(parsedMs / 1000));
}

/**
 * Adapts one notification item into the adapters' ProviderWebhookRawEvent.
 * `headers.signature` carries the extracted hmacSignature for the verifier.
 */
export function adyenWebhookRawEvent(delivery: {
  readonly eventId: string;
  readonly payload: unknown;
  readonly hmacSignature: string;
  readonly timestampSeconds: string;
}): ProviderWebhookRawEvent {
  return Object.freeze({
    providerName: ADYEN_PROVIDER_NAME,
    eventId: delivery.eventId,
    timestamp: delivery.timestampSeconds,
    payload: delivery.payload,
    headers: Object.freeze({
      signature: delivery.hmacSignature,
      timestamp: delivery.timestampSeconds,
    }),
  });
}

/**
 * The Adyen HMAC verifier on the adapters' WebhookSignatureVerifier hook.
 * The ingestor hands the CANONICAL body (JSON.stringify of the parsed
 * payload): verification succeeds exactly when the canonical serialization
 * equals the delivered bytes (the transport must preserve the raw body; use
 * {@link verifyAdyenWebhookDelivery} for byte-exact verification of raw
 * deliveries).
 */
export class AdyenWebhookVerifier implements WebhookSignatureVerifier {
  readonly #secret: string;

  constructor(secret: string) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new ValidationError("an Adyen webhook verifier requires a non-empty webhook HMAC secret");
    }
    this.#secret = secret;
  }

  verify(
    event: ProviderWebhookRawEvent,
    canonicalBody: string,
  ): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
    const expected = adyenSignWebhookPayload(this.#secret, canonicalBody);
    if (
      typeof event.headers.signature !== "string" ||
      event.headers.signature.length === 0 ||
      !constantTimeEquals(event.headers.signature, expected)
    ) {
      return { valid: false, reason: "HMAC_SIGNATURE_INVALID" };
    }
    return { valid: true };
  }
}

/**
 * Wires a ProviderWebhookIngestor for Adyen: base64-HMAC verification,
 * replay window over the provider-declared eventDate, (provider, eventId)
 * dedupe and append-only evidence — the adapters ingestor pattern with the
 * Adyen scheme plugged in.
 */
export function createAdyenWebhookIngestor(deps: {
  readonly secret: string;
  readonly clock: ProtocolClock;
  readonly replayWindowSeconds?: number;
  readonly futureSkewSeconds?: number;
}): ProviderWebhookIngestor {
  return new WebhookIngestor({
    verifier: new AdyenWebhookVerifier(deps.secret),
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
// Idempotency (reference + Idempotency-Key derivation — INV-F05)
// ---------------------------------------------------------------------------

/**
 * Derives the Adyen merchant `reference` from the protocol idempotency key
 * (INV-F05): retries send the SAME reference, so the payment is joinable at
 * Adyen by reference regardless of the header dedupe.
 */
export function adyenMerchantReference(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap:${protocolIdempotencyKey}`;
}

/**
 * Derives the `Idempotency-Key` header value from the protocol idempotency
 * key (INV-F05). Adyen dedupes by the header WHEN present; the connector
 * always sends it, deterministically — duplicateBehavior stays
 * PROVIDER_DEFINED and the caller's registrar remains the guard.
 */
export function adyenIdempotencyKeyHeader(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap-idem:${protocolIdempotencyKey}`;
}

// ---------------------------------------------------------------------------
// The RailAdapter surface (provider-neutral framework registration)
// ---------------------------------------------------------------------------

/** The Adyen production rail adapter on the BaseRailAdapter framework. */
export class AdyenProductionRail extends BaseRailAdapter {
  readonly adapterId = ADYEN_RAIL_ADAPTER_ID;
  readonly implementationId = ADYEN_RAIL_IMPLEMENTATION_ID;

  constructor() {
    const definitions = new Map<string, CapabilityDefinition>();
    for (const definition of adyenCapabilityDefinitions()) {
      definitions.set(definition.capabilityId, definition);
    }
    super(adyenRailCapabilityPack(), definitions);
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK; credential-gated, fail-closed)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface AdyenControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface AdyenConnectorConfig {
  readonly clock: ProtocolClock;
  /** Overrides the checkout base (defaults: TEST base; LIVE base constant). */
  readonly apiBase?: string;
  readonly environment?: "TEST" | "LIVE";
  /** Overrides the pinned API version (tests only — production pins v70). */
  readonly apiVersion?: string;
  /** The Adyen merchant account code (account configuration, not a secret). */
  readonly merchantAccount?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("adyen")` = PROVIDER_ADYEN_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: AdyenControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type AdyenSdkRequest =
  | {
      readonly kind: "create_payment";
      readonly amountMinor: string;
      readonly currency: string;
      /** The paymentMethod object, provider vocabulary, verbatim passthrough. */
      readonly paymentMethod: Readonly<Record<string, unknown>>;
      readonly returnUrl: string;
      /** Overrides the derived reference (adyenMerchantReference). */
      readonly reference?: string;
      readonly shopperInteraction?: string;
      readonly additionalData?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "submit_payment_details";
      readonly paymentData?: string;
      readonly details: Readonly<Record<string, unknown>>;
      readonly pspReference?: string;
    }
  | {
      readonly kind: "capture_payment";
      readonly pspReference: string;
      readonly amountMinor?: string;
      readonly currency?: string;
    }
  | {
      readonly kind: "refund_payment";
      readonly pspReference: string;
      readonly amountMinor?: string;
      readonly currency?: string;
    }
  | { readonly kind: "cancel_payment"; readonly pspReference: string }
  | { readonly kind: "reverse_payment"; readonly pspReference: string };

function isAdyenSdkRequest(candidate: unknown): candidate is AdyenSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** Which credential path is live (observability — NEVER material). */
export type AdyenCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/**
 * The real Adyen connector (ConnectorSDK framework). Adyen API names,
 * payloads, response shapes and quirks stay INSIDE this implementation: the
 * SDK call contract is the provider-neutral `AdyenSdkRequest` union. Every
 * effectful operation runs behind `requireAuthority` (INV-C04/F05/F06) and
 * fails closed with `RailNotAuthorizedError` BEFORE any provider call when
 * no credential path is live (INV-NC04).
 */
export class AdyenConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #merchantAccount: string | undefined;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: AdyenControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  #credentialBaseline: string | undefined;

  constructor(config: AdyenConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase =
      config.apiBase ??
      (config.environment === "LIVE"
        ? ADYEN_DEFAULT_CHECKOUT_BASE_LIVE
        : ADYEN_DEFAULT_CHECKOUT_BASE_TEST);
    this.#apiVersion = config.apiVersion ?? ADYEN_API_VERSION;
    this.#merchantAccount = config.merchantAccount;
    this.#credentialConfigKey = config.credentialConfigKey ?? ADYEN_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: ADYEN_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "Adyen (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return adyenRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): AdyenCredentialResolutionState {
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
        "no control-plane credentials and no env-resolved material under the config key — rail fails closed (INV-NC04; packages/rails/BLOCKED-RAILS.md §10)",
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
          "credential reference not provisioned — source availability UNKNOWN (INV-C01/C02); the 2026-10-02 reachability datum recorded HTTP 401 on checkout-test.adyen.com (reachable, API key required); see packages/rails/BLOCKED-RAILS.md §10",
        provenance: {
          providerName: ADYEN_PROVIDER_NAME,
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
          providerName: ADYEN_PROVIDER_NAME,
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
        providerName: ADYEN_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(ADYEN_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface --------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "adyen search is not implemented — no listing surface is in the connector contract; reconciliation is by pspReference through the webhook stream and /v70/payments/details (INV-X03)",
    );
  }

  async read(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "adyen checkout v70 exposes no GET-payment-by-pspReference surface — read the payment by completing details (submit_payment_details) or observe the webhook stream; the pspReference rides every envelope verbatim (INV-X03)",
    );
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_payment");
    if (request.kind !== "create_payment") {
      throw new ValidationError("adyen create supports only { kind: 'create_payment' }");
    }
    if (this.#merchantAccount === undefined) {
      throw new ValidationError(
        "adyen create_payment requires the merchantAccount configuration (the Adyen merchant account code — account configuration, not a secret)",
      );
    }
    const reference = request.reference ?? adyenMerchantReference(ctx.idempotencyKey);
    const body: Record<string, unknown> = {
      merchantAccount: this.#merchantAccount,
      amount: { value: this.#exactMinorUnits(request.amountMinor), currency: request.currency.toUpperCase() },
      reference,
      paymentMethod: request.paymentMethod,
      returnUrl: request.returnUrl,
      ...(request.shopperInteraction !== undefined
        ? { shopperInteraction: request.shopperInteraction }
        : {}),
      ...(request.additionalData !== undefined ? { additionalData: request.additionalData } : {}),
    };
    const observedAt = this.#envelopeContext();
    // INV-X01: a transport failure mid-create is OUTCOME_UNKNOWN — the
    // payment may exist at Adyen under this reference; reconcile by
    // pspReference/reference. NEVER FAILED.
    try {
      const data = await this.#withCredentials(async (material) =>
        this.#providerPost(
          `/${this.#apiVersion}/payments`,
          body,
          adyenIdempotencyKeyHeader(ctx.idempotencyKey),
          material,
        ),
      );
      return this.#sdkResult(
        adyenPaymentEnvelope((data ?? {}) as AdyenPaymentResponseProviderObject, observedAt),
        `adyen:create-payment:${reference}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "payment",
          externalId: reference,
          operation: "create_payment",
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
    const request = this.#request(ctx, "submit_payment_details");
    if (request.kind !== "submit_payment_details") {
      throw new ValidationError("adyen update supports only { kind: 'submit_payment_details' }");
    }
    const body: Record<string, unknown> = {
      details: request.details,
      ...(request.paymentData !== undefined ? { paymentData: request.paymentData } : {}),
    };
    const observedAt = this.#envelopeContext();
    // INV-X01: the details completion can authorise value — OUTCOME_UNKNOWN.
    try {
      const data = await this.#withCredentials(async (material) =>
        this.#providerPost(
          `/${this.#apiVersion}/payments/details`,
          body,
          adyenIdempotencyKeyHeader(ctx.idempotencyKey),
          material,
        ),
      );
      const payment = (data ?? {}) as AdyenPaymentResponseProviderObject;
      return this.#sdkResult(
        adyenPaymentEnvelope(payment, observedAt),
        `adyen:submit-details:${payment.pspReference ?? request.pspReference ?? "pending"}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "payment",
          externalId: request.pspReference ?? request.paymentData ?? "",
          operation: "submit_payment_details",
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
    const request = this.#request(ctx, "capture_payment");
    if (
      request.kind !== "capture_payment" &&
      request.kind !== "refund_payment" &&
      request.kind !== "cancel_payment" &&
      request.kind !== "reverse_payment"
    ) {
      throw new ValidationError(
        "adyen executeAction supports only { kind: 'capture_payment' | 'refund_payment' | 'cancel_payment' | 'reverse_payment' } — pay-ins only: payouts are a DISTINCT observation-only family on this connector (INV-C09)",
      );
    }
    const suffix =
      request.kind === "capture_payment"
        ? "captures"
        : request.kind === "refund_payment"
          ? "refunds"
          : request.kind === "cancel_payment"
            ? "cancels"
            : "reversals";
    const body: Record<string, unknown> = {};
    if (
      (request.kind === "capture_payment" || request.kind === "refund_payment") &&
      request.amountMinor !== undefined
    ) {
      if (request.currency === undefined) {
        throw new ValidationError("a partial capture/refund amount requires the currency");
      }
      body.amount = {
        value: this.#exactMinorUnits(request.amountMinor),
        currency: request.currency.toUpperCase(),
      };
    }
    const observedAt = this.#envelopeContext();
    // INV-X01: modifications move value — OUTCOME_UNKNOWN, never FAILED.
    try {
      const data = await this.#withCredentials(async (material) =>
        this.#providerPost(
          `/${this.#apiVersion}/payments/${encodeURIComponent(request.pspReference)}/${suffix}`,
          body,
          adyenIdempotencyKeyHeader(ctx.idempotencyKey),
          material,
        ),
      );
      const modification = (data ?? {}) as AdyenModificationResponseProviderObject;
      return this.#sdkResult(
        adyenModificationEnvelope(modification, observedAt),
        `adyen:${request.kind}:${modification.pspReference ?? request.pspReference}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "modification",
          externalId: request.pspReference,
          operation: request.kind,
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
      "adyen event subscription is handled by the webhook ingestion framework (createAdyenWebhookIngestor + @payswap/adapters ProviderWebhookIngestor), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "submit_payment_details");
    if (request.kind !== "submit_payment_details") {
      throw new ValidationError(
        "adyen reconcile supports only { kind: 'submit_payment_details' } — the checkout v70 query-back surface for in-flight payments (terminal evidence is the webhook stream, INV-X03)",
      );
    }
    return this.update(ctx);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "adyen disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and release the sealed credential handle); the provider surface offers no self-disconnect",
    );
  }

  // -- dedicated observation methods (read-only; OBSERVED eligibility) --------

  /**
   * OBSERVED merchant/entity eligibility: POST /v70/paymentMethods answers
   * the payment methods ENABLED for the merchant account (with the
   * country/currency/amount context supplied). This is the ONLY eligibility
   * authority — local methods and currencies are exposed only when the
   * merchant has them enabled, never assumed. Fail-closed without
   * credentials (INV-NC04).
   */
  async observePaymentMethods(input: {
    readonly countryCode?: string;
    readonly amountMinor?: string;
    readonly currency?: string;
    readonly channel?: string;
  }): Promise<ProviderStateEnvelope> {
    if (this.#merchantAccount === undefined) {
      throw new ValidationError(
        "adyen observePaymentMethods requires the merchantAccount configuration (the merchant account code whose ENABLED methods are being observed)",
      );
    }
    const body: Record<string, unknown> = { merchantAccount: this.#merchantAccount };
    if (input.countryCode !== undefined) {
      body.countryCode = input.countryCode.toUpperCase();
    }
    if (input.channel !== undefined) {
      body.channel = input.channel;
    }
    if (input.amountMinor !== undefined) {
      if (input.currency === undefined) {
        throw new ValidationError("an amount context requires the currency");
      }
      body.amount = {
        value: this.#exactMinorUnits(input.amountMinor),
        currency: input.currency.toUpperCase(),
      };
    }
    const observedAt = this.#envelopeContext();
    const data = await this.#withCredentials(async (material) =>
      this.#providerPost(`/${this.#apiVersion}/paymentMethods`, body, undefined, material),
    );
    return adyenPaymentMethodsEnvelope(
      (data ?? {}) as AdyenPaymentMethodsResponseProviderObject,
      observedAt,
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md, Adyen path —
   * swap-reference-then-verify): the vault binding for the control-plane
   * config key is swapped to a NEW reference at the vault; the connector
   * re-resolves per call, so the rotation is real exactly when the NEW
   * reference resolves and serves a successful health probe. The old key is
   * revoked in the Adyen Customer Area only after that verification.
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
      const rotatedAt = this.#clock.now();
      return {
        rotatedAt,
        newCredentialRef: current,
        evidence: railEvidence({
          evidenceId: `adyen:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: ADYEN_PROVIDER_NAME,
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
        "cannot rotate credentials: no credential path is provisioned for the adyen rail (packages/rails/BLOCKED-RAILS.md §10)",
        { railId: ADYEN_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = createHmac("sha256", "payswap-adyen-rotation-baseline")
      .update(envMaterial)
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
    const rotatedAt = this.#clock.now();
    return {
      rotatedAt,
      newCredentialRef: `env:${this.#credentialConfigKey}`,
      evidence: railEvidence({
        evidenceId: `adyen:cred-rotation:${rotatedAt}`,
        evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
        kind: "AUDIT_LOG",
        providerState: railEnvelope({
          providerName: ADYEN_PROVIDER_NAME,
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
   * 2026-10-02 datum recorded HTTP 401 on the test host) → DEGRADED with
   * reasons; transport failure → UNKNOWN. With credentials: the
   * authenticated paymentMethods observation (the real probe) → HEALTHY.
   */
  async health(): Promise<ConnectorHealthReport> {
    const resolution = this.credentialResolutionState();
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: ADYEN_CONNECTOR_ID,
      providerName: ADYEN_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (resolution.kind === "NOT_PROVISIONED") {
      let endpointAnswered: boolean;
      try {
        await this.#http(`${this.#apiBase}/${this.#apiVersion}/paymentMethods`, {
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
              `credentials absent: provider endpoint reachable (the 2026-10-02 probe recorded HTTP ${String(ADYEN_TEST_REACHABILITY_20261002.httpStatus)} — API key required) but rail authorization cannot be established — availability UNKNOWN (INV-C01/C02; packages/rails/BLOCKED-RAILS.md §10)`,
            ]
          : ["provider endpoint unreachable — availability UNKNOWN (INV-C02)"],
      };
    }
    try {
      if (this.#merchantAccount === undefined) {
        return {
          ...base,
          status: "DEGRADED",
          lastCheckedAt,
          degradedReasons: [
            "credentials provisioned but the merchantAccount configuration is absent — the authenticated probe (POST /v70/paymentMethods) cannot run",
          ],
        };
      }
      await this.observePaymentMethods({});
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

  #envelopeContext(): AdyenEnvelopeContext {
    return {
      observedAt: isoTimestamp(this.#clock.now()),
      provenanceSource: "PROVIDER_API",
    };
  }

  #envMaterial(): string | undefined {
    if (this.#env === undefined) {
      return undefined;
    }
    const value = this.#env[this.#credentialConfigKey];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  /**
   * Runs one provider interaction with credential material. The control
   * plane opens the SEALED bundle per call (material exists only inside the
   * callback frame); the env fallback injects the resolved material
   * directly. With neither, the operation fails closed BEFORE any provider
   * call (INV-NC04).
   */
  async #withCredentials<T>(fn: (material: string) => Promise<T>): Promise<T> {
    if (this.#controlPlane !== undefined) {
      let handle: ReturnType<CredentialBroker["resolveProviderCredential"]>;
      try {
        handle = this.#controlPlane.broker.resolveProviderCredential(
          this.#credentialConfigKey,
        );
      } catch (error) {
        throw new RailNotAuthorizedError(
          "adyen rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: ADYEN_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => fn(extractAdyenKeyMaterial(opened.material)),
      );
    }
    const material = this.#envMaterial();
    if (material === undefined) {
      throw new RailNotAuthorizedError(
        "adyen rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md §10)",
        { railId: ADYEN_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    return fn(material);
  }

  #request(ctx: SdkCallContext, expectedKind: string): AdyenSdkRequest {
    const candidate = ctx.request;
    if (!isAdyenSdkRequest(candidate)) {
      throw new ValidationError(
        `adyen rail call request must be an AdyenSdkRequest object (expected kind '${expectedKind}')`,
      );
    }
    if (
      "amountMinor" in candidate &&
      candidate.amountMinor !== undefined &&
      !/^\d+$/.test(String(candidate.amountMinor))
    ) {
      throw new ValidationError(
        "amountMinor must be an exact non-negative INTEGER minor-unit string (Adyen amounts are integer minor units; INV-F01)",
      );
    }
    return candidate;
  }

  /** Integer minor units, exactly (Adyen's amount.value). */
  #exactMinorUnits(amountMinor: string): number {
    if (!/^\d+$/.test(amountMinor)) {
      throw new ValidationError(
        "amountMinor must be an exact non-negative integer minor-unit string (INV-F01)",
      );
    }
    const value = Number(amountMinor);
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError(
        "amountMinor exceeds the safe integer range — refuse rather than round (INV-F01)",
      );
    }
    return value;
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
      providerName: ADYEN_PROVIDER_NAME,
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
        note: "transport failed mid-effect — the provider effect may have landed; reconcile by pspReference/reference (INV-X01/INV-X03); never coerced to FAILED",
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
      shareableFields: ADYEN_SHAREABLE_FIELDS,
    });
    return this.#sdkResult(envelope, `adyen:outcome-unknown:${input.operation}:${input.idempotencyKey}`);
  }

  async #providerPost(
    path: string,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey: string | undefined,
    material: string,
  ): Promise<unknown> {
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: {
          "X-API-Key": material,
          "Content-Type": "application/json",
          ...(idempotencyKey !== undefined ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("adyen provider transport unreachable", {
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
      throw new RailProviderError("adyen provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status < 200 || response.status >= 300) {
      const errorBody = parsed as {
        readonly status?: number;
        readonly errorCode?: string;
        readonly message?: string;
        readonly errorType?: string;
      };
      throw new RailProviderError(
        `adyen provider answered HTTP ${String(response.status)}: ${errorBody?.message ?? "provider error"}`,
        {
          path,
          httpStatus: response.status,
          ...(errorBody?.errorCode !== undefined ? { providerErrorCode: errorBody.errorCode } : {}),
          ...(errorBody?.errorType !== undefined ? { providerErrorType: errorBody.errorType } : {}),
        },
      );
    }
    return parsed;
  }
}

/**
 * Extracts the Adyen key material from a vault bundle shape. The control
 * plane hands the connector whatever the vault object holds: a plain string
 * API key (from the Adyen Customer Area), or a bundle record ({ apiKey } /
 * { api_key } / { checkoutApiKey }). Any other shape refuses the call
 * (fail-closed, no guessing).
 */
export function extractAdyenKeyMaterial(material: unknown): string {
  if (typeof material === "string" && material.length > 0) {
    return material;
  }
  if (material !== null && typeof material === "object") {
    const record = material as Readonly<Record<string, unknown>>;
    for (const key of ["apiKey", "api_key", "checkoutApiKey", "checkout_api_key"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  throw new ValidationError(
    "the sealed credential bundle does not contain Adyen key material (expected a string API key or { apiKey | api_key | checkoutApiKey })",
  );
}
