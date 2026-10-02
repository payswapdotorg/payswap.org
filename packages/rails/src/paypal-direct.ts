/**
 * PayPal Direct production connector (P2-W1-002) — the REAL native PayPal
 * REST adapter on the v1.5 connector vocabulary.
 *
 * Authority: spec/phase-2/work-items/P2-W1-002.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md and the FROZEN
 * v1.5 vocabulary owned by W2-003 (ProviderStateEnvelope,
 * ConnectedCapabilityInstance, CapabilityObservation, ExternalFundsPosition
 * Observation — all CONSUMED from @payswap/connectors, never redefined).
 *
 * PayPal Direct is a SEPARATE provider identity — the native PayPal REST
 * provider, DISTINCT from the Stripe-settled "Stripe PayPal" capability: the
 * provider name is `paypal-direct`, the funds settle in the PayPal account
 * (NOT a Stripe balance), and the capability ids never overlap the
 * `cap.rails.stripe.paypal_on_stripe` capability. The two are selectable
 * ONLY through their own ConnectedCapabilityInstance eligibility and are
 * never interchangeable in routing (see `src/stripe.ts`
 * STRIPE_PAYPAL_ON_STRIPE_ELIGIBILITY.distinctFrom === "paypal_direct").
 *
 * Provider surface implemented (native PayPal REST):
 * - OAuth2 client-credentials token acquisition (POST /v1/oauth2/token,
 *   Basic client_id:client_secret) — SCOPED_API_CREDENTIAL mode;
 *   CONNECTED_ACCOUNT mode (partner referrals) is declared on the
 *   authorization-mode surface where applicable;
 * - v2 checkout orders: CREATE → APPROVED → capture/authorize → COMPLETED,
 *   VOIDED terminal, PAYER_ACTION_REQUIRED first-class customer action;
 * - v2 payments: authorizations (capture / reauthorize / void),
 *   captures (read), refunds (create + read) with
 *   seller-payable-breakdown reconciliation evidence preserved verbatim;
 * - Payouts API (POST /v1/payments/payouts, GET /v1/payments/payouts/{id},
 *   GET /v1/payments/payouts-item/{id}): recipient_type EMAIL/PAYPAL_ID
 *   EXPLICIT, per-item sender_item_id, item-level fees/statuses verbatim.
 *   NOTE (honest versioning): the PayPal Payouts surface is versioned v1 at
 *   the provider even though it belongs to the same v2-era REST program —
 *   the paths are used verbatim and the deviation is documented here.
 * - Webhook verification: PayPal's own scheme — POST
 *   /v1/notifications/verify-webhook-signature (transmission-id/time
 *   correlation, tolerance window, replay dedupe, event-type mapping).
 *
 * Laws implemented here:
 * - INV-C06 (lossless): every provider object (checkout order, v2
 *   authorization, v2 capture, v2 refund, payout batch, payout item,
 *   webhook event) is carried VERBATIM in the envelope `state` with an
 *   ADDITIVE classification. Provider statuses are never renamed, never
 *   dropped; UNKNOWN provider statuses stay verbatim under the total
 *   'other' family.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (ambiguity
 *   OUTCOME_UNKNOWN, requires reconciliation) — NEVER collapsed to FAILED.
 * - INV-C09: payout batch/item states produce ExternalFundsPosition
 *   Observations ONLY — observations of provider-held external funds in
 *   motion toward an EXPLICIT external destination, never PaySwap custody
 *   and never a balance PaySwap owes anyone. There is deliberately NO
 *   balance observation: PayPal exposes no REST balance endpoint on this
 *   surface, and none is fabricated.
 * - INV-NC04 + fail-closed (phase-2 "no Wave-2 credentials held"): no
 *   credential ⇒ availability UNKNOWN (INV-C01/C02), health DEGRADED/UNKNOWN
 *   with reasons, every effectful operation throws RailNotAuthorizedError
 *   BEFORE any provider call. Nothing is simulated.
 * - CONNECTION ≠ DEBIT (P2-W1-001 control plane): a payout (transfer-out)
 *   requires a SEPARATE `TransferOutAuthorization` on an ACTIVE
 *   ConnectedCapabilityInstance activation — asserted through the canonical
 *   `assertTransferOutAuthorized` BEFORE any provider call. Connecting an
 *   account never grants withdrawal authority. The payout destination is
 *   EXTERNAL and EXPLICIT by construction (`destinationKind: "EXTERNAL"`).
 * - INV-F05/INV-F01: money is exact integer minor units at the boundary
 *   (decimal PayPal strings converted losslessly); the PayPal-Request-Id
 *   header and the payout sender_batch_id are derived deterministically
 *   from the protocol idempotency key; duplicate submits map to ERROR /
 *   duplicate states — never silent success.
 * - Credential isolation (phase-2): client_id/client_secret material is
 *   consumed through the P2-W1-001 control plane —
 *   `PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF` bound to a vault:// reference,
 *   resolved through the CredentialBroker to a SEALED bundle opened only
 *   inside `withSealedBundle` with a ConnectorRuntimeKey. An env fallback
 *   (the W1-005 rails convention) exists for deployments that inject the
 *   resolved credential under the same config key; the material NEVER
 *   enters any envelope, log line or evidence record.
 * - Country eligibility is FACTS-ONLY: merchant/account-country support is
 *   represented as eligibility facts on the connected instance. This
 *   connector holds ZERO probe evidence (no PayPal credential is held),
 *   so `paypalDirectCountryEligibility` answers UNKNOWN for every country
 *   — never assumed, never routable (INV-C05/INV-NC04).
 *
 * Deterministic only: no ambient clock, no entropy, no Math.random. All
 * time flows through the injected ProtocolClock.
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectedInstanceActivation,
  ConnectorCapabilityPack,
  ProviderIdentity,
  ProviderStateEnvelope,
} from "@payswap/connectors";
import { validateCapabilityDefinition } from "@payswap/connectors";
import { observeCapability, unknownReachabilityObservation } from "@payswap/connectors";
import { assertTransferOutAuthorized } from "@payswap/connectors";
import type { CustomerActionRequirement } from "@payswap/connectors";
import { customerActionRequirement } from "@payswap/connectors";
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
  exactRationalFromDecimal,
  railEnvelope,
  railEvidence,
  realHttpTransport,
  routableRailImplication,
  isoTimestamp,
} from "./support.js";
import type { HttpTransport, RailImplication } from "./support.js";

// ---------------------------------------------------------------------------
// Identity (pinned — the REST surface version is part of the provider contract)
// ---------------------------------------------------------------------------

export const PAYPAL_DIRECT_PROVIDER_NAME = "paypal-direct" as const;
/**
 * The pinned PayPal Direct REST surface version. The connector speaks the
 * v2 checkout-orders/payments program plus the v1-payments Payouts surface
 * (the provider's own versioning, documented in the module header). Pinning
 * is a connector contract: an unpinned account default would make envelope
 * mappings version-dependent.
 */
export const PAYPAL_DIRECT_API_VERSION = "2.0" as const;
export const PAYPAL_DIRECT_RAIL_ADAPTER_ID = "rail.paypal-direct" as const;
export const PAYPAL_DIRECT_RAIL_IMPLEMENTATION_ID =
  "impl.rails.paypal-direct.2.0" as const;
export const PAYPAL_DIRECT_CONNECTOR_ID = "connector.rails.paypal-direct" as const;
export const PAYPAL_DIRECT_DEFAULT_API_BASE = "https://api-m.paypal.com" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("paypal-direct")` —
 * `PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF`, bound at the vault (never in the
 * repo) to a `vault://…` reference.
 */
export const PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY: string =
  providerCredentialConfigKey(PAYPAL_DIRECT_PROVIDER_NAME);

/**
 * The authorization modes this connector declares (P2-W1-001 vocabulary,
 * consumed — never redefined):
 * - SCOPED_API_CREDENTIAL — OAuth2 client-credentials (client_id +
 *   client_secret), vault-backed references only;
 * - CONNECTED_ACCOUNT — provider-native connected accounts via PayPal
 *   partner referrals (POST /v2/customer/referrals), where applicable: the
 *   connected-account flow carries its own authorization artifact reference
 *   and an explicit accountRef (enforced by the CredentialBroker descriptor
 *   mode contract).
 */
export const PAYPAL_DIRECT_AUTHORIZATION_MODES = [
  "SCOPED_API_CREDENTIAL",
  "CONNECTED_ACCOUNT",
] as const;

// ---------------------------------------------------------------------------
// Capability definitions (consumed W2-003 vocabulary — never redefined)
// ---------------------------------------------------------------------------

export const PAYPAL_DIRECT_CHECKOUT_ORDER_CAPABILITY_ID =
  "cap.rails.paypal-direct.checkout_order" as const;
export const PAYPAL_DIRECT_AUTHORIZATION_CAPABILITY_ID =
  "cap.rails.paypal-direct.authorization" as const;
export const PAYPAL_DIRECT_CAPTURE_CAPABILITY_ID =
  "cap.rails.paypal-direct.capture" as const;
export const PAYPAL_DIRECT_REFUND_CAPABILITY_ID =
  "cap.rails.paypal-direct.refund" as const;
export const PAYPAL_DIRECT_PAYOUT_CAPABILITY_ID =
  "cap.rails.paypal-direct.payout_transfer_out" as const;

function paypalDirectCapabilityDefinition(input: {
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
    readonly financialEffect: "MOVES_VALUE" | "RESERVES_VALUE" | "ADJUSTS_VALUE";
    readonly reversible: boolean;
  }[];
  readonly idempotency: {
    readonly idempotent: boolean;
    readonly keyScope: "REQUEST" | "CONNECTED_INSTANCE" | "PROVIDER_ACCOUNT";
    readonly duplicateBehavior: "REJECTED" | "RETURNED_SAME_RESULT" | "PROVIDER_DEFINED";
    readonly retryPolicy: "SAFE_TO_RETRY" | "REQUIRES_RECONCILIATION";
  };
  readonly requiredCustomerActions?: readonly CustomerActionRequirement[];
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
      "credential reference provisioned through the control plane (PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF)",
      "for payouts: a SEPARATE transfer-out authorization on an ACTIVE connected-instance activation (connection scope alone never authorizes debit)",
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
    idempotency: input.idempotency,
    compensation: {
      compensable: false,
      cancellation: "PROVIDER_DEFINED",
      partialExecution: { possible: true, granularity: "LINE_ITEM", onPartial: "DISCLOSED" },
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
        { action: "approve", description: "The payer approves the order at the provider surface" },
        { action: "capture", description: "Capture an APPROVED order or a CREATED authorization" },
        { action: "authorize", description: "Authorize an APPROVED order instead of capturing" },
        { action: "void", description: "Void a created (uncaptured) authorization" },
        { action: "refund", description: "Refund a completed capture" },
      ],
      states: input.providerStates,
    },
    externalObjects: input.externalObjects.map((object) => ({
      objectType: object.objectType,
      idFormat: object.idFormat,
      revisioned: true,
      revisionFormat: "provider-status-revision",
    })),
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "PayPal account settlement (funds land in the PayPal balance, then payout to an explicit external destination)" },
    constraints: [],
  });
}

// ---------------------------------------------------------------------------
// Provider-state vocabulary (INV-C06): status mapping tables as data
// ---------------------------------------------------------------------------

/**
 * Every v2 checkout-order status with its additive classification. Exported
 * as data so certification/conformance surfaces can diff the mapping without
 * reading the implementation.
 *
 * | PayPal order status   | family                   | isTerminal | requiresCustomerAction |
 * |-----------------------|--------------------------|------------|------------------------|
 * | CREATED               | other                    | false      | false                  |
 * | SAVED                 | other                    | false      | false                  |
 * | APPROVED              | capture                  | false      | false                  |
 * | COMPLETED             | other                    | true       | false                  |
 * | VOIDED                | other                    | true       | false                  |
 * | PAYER_ACTION_REQUIRED | customer_action_required | false      | true                   |
 * | (unknown)             | other                    | false      | false (verbatim step)  |
 */
export const PAYPAL_DIRECT_ORDER_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "CREATED", family: "other", lifecycleStep: "CREATED", isTerminal: false, requiresCustomerAction: false },
  { providerState: "SAVED", family: "other", lifecycleStep: "SAVED", isTerminal: false, requiresCustomerAction: false },
  { providerState: "APPROVED", family: "capture", lifecycleStep: "APPROVED", isTerminal: false, requiresCustomerAction: false },
  { providerState: "COMPLETED", family: "other", lifecycleStep: "COMPLETED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "VOIDED", family: "other", lifecycleStep: "VOIDED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "PAYER_ACTION_REQUIRED", family: "customer_action_required", lifecycleStep: "PAYER_ACTION_REQUIRED", isTerminal: false, requiresCustomerAction: true },
]);

/** v2 payments authorization statuses (additive classification, as data). */
export const PAYPAL_DIRECT_AUTHORIZATION_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "CREATED", family: "other", lifecycleStep: "CREATED", isTerminal: false, requiresCustomerAction: false },
  { providerState: "PENDING", family: "async_processing", lifecycleStep: "PENDING", isTerminal: false, requiresCustomerAction: false },
  { providerState: "CAPTURED", family: "other", lifecycleStep: "CAPTURED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "PARTIALLY_CAPTURED", family: "other", lifecycleStep: "PARTIALLY_CAPTURED", isTerminal: false, requiresCustomerAction: false },
  { providerState: "DENIED", family: "other", lifecycleStep: "DENIED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "EXPIRED", family: "other", lifecycleStep: "EXPIRED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "VOIDED", family: "other", lifecycleStep: "VOIDED", isTerminal: true, requiresCustomerAction: false },
]);

/** v2 payments capture statuses (additive classification, as data). */
export const PAYPAL_DIRECT_CAPTURE_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "COMPLETED", family: "other", lifecycleStep: "COMPLETED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "DECLINED", family: "other", lifecycleStep: "DECLINED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "PENDING", family: "async_processing", lifecycleStep: "PENDING", isTerminal: false, requiresCustomerAction: false },
  { providerState: "PARTIALLY_REFUNDED", family: "refund", lifecycleStep: "PARTIALLY_REFUNDED", isTerminal: false, requiresCustomerAction: false },
  { providerState: "REFUNDED", family: "refund", lifecycleStep: "REFUNDED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "FAILED", family: "other", lifecycleStep: "FAILED", isTerminal: true, requiresCustomerAction: false },
]);

/** v2 refund statuses (additive classification, as data). */
export const PAYPAL_DIRECT_REFUND_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "PENDING", family: "refund", lifecycleStep: "PENDING", isTerminal: false, requiresCustomerAction: false },
  { providerState: "COMPLETED", family: "refund", lifecycleStep: "COMPLETED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "CANCELLED", family: "refund", lifecycleStep: "CANCELLED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "FAILED", family: "refund", lifecycleStep: "FAILED", isTerminal: true, requiresCustomerAction: false },
]);

/** Payouts API batch statuses (additive classification, as data). */
export const PAYPAL_DIRECT_PAYOUT_BATCH_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "PENDING", family: "payout", lifecycleStep: "PENDING", isTerminal: false, requiresCustomerAction: false },
  { providerState: "PROCESSING", family: "payout", lifecycleStep: "PROCESSING", isTerminal: false, requiresCustomerAction: false },
  { providerState: "SUCCESS", family: "payout", lifecycleStep: "SUCCESS", isTerminal: true, requiresCustomerAction: false },
  { providerState: "DENIED", family: "payout", lifecycleStep: "DENIED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "CANCELED", family: "payout", lifecycleStep: "CANCELED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "ERROR", family: "payout", lifecycleStep: "ERROR", isTerminal: true, requiresCustomerAction: false },
]);

/**
 * Payouts API item statuses (additive classification, as data). UNCLAIMED is
 * a first-class customer-action state: the recipient must claim the funds —
 * the destination stays EXTERNAL, so only the recipient can act.
 */
export const PAYPAL_DIRECT_PAYOUT_ITEM_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "PENDING", family: "payout", lifecycleStep: "PENDING", isTerminal: false, requiresCustomerAction: false },
  { providerState: "UNCLAIMED", family: "customer_action_required", lifecycleStep: "UNCLAIMED", isTerminal: false, requiresCustomerAction: true },
  { providerState: "ONHOLD", family: "payout", lifecycleStep: "ONHOLD", isTerminal: false, requiresCustomerAction: false },
  { providerState: "SUCCESS", family: "payout", lifecycleStep: "SUCCESS", isTerminal: true, requiresCustomerAction: false },
  { providerState: "FAILED", family: "payout", lifecycleStep: "FAILED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "BLOCKED", family: "payout", lifecycleStep: "BLOCKED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "RETURNED", family: "payout", lifecycleStep: "RETURNED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "REVERSED", family: "refund", lifecycleStep: "REVERSED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "REFUNDED", family: "refund", lifecycleStep: "REFUNDED", isTerminal: true, requiresCustomerAction: false },
]);

/**
 * The webhook event-type routing table (longest prefix first): event types
 * map to the object mapper for their `resource` payload; unknown event types
 * produce an `event`-typed envelope carrying the WHOLE event verbatim —
 * nothing is dropped (INV-C06).
 */
export const PAYPAL_WEBHOOK_EVENT_TYPE_MAPPING: readonly {
  readonly prefix: string;
  readonly objectType:
    | "order"
    | "authorization"
    | "capture"
    | "refund"
    | "dispute"
    | "payout_item"
    | "payout_batch";
}[] = Object.freeze([
  { prefix: "CHECKOUT.ORDER.", objectType: "order" },
  { prefix: "PAYMENT.CAPTURE.REFUNDED", objectType: "refund" },
  { prefix: "PAYMENT.CAPTURE.REVERSED", objectType: "refund" },
  { prefix: "PAYMENT.AUTHORIZATION.", objectType: "authorization" },
  { prefix: "PAYMENT.CAPTURE.", objectType: "capture" },
  { prefix: "CUSTOMER.DISPUTE.", objectType: "dispute" },
  { prefix: "PAYMENT.PAYOUTS.", objectType: "payout_item" },
]);

// ---------------------------------------------------------------------------
// Raw provider objects (opaque passthrough — INV-C06)
// ---------------------------------------------------------------------------

/** The raw v2 checkout order as observed (opaque passthrough). */
export interface PayPalOrderProviderObject {
  readonly id: string;
  readonly status: string;
  readonly intent?: string;
  readonly purchase_units?: readonly unknown[];
  readonly payment_source?: Readonly<Record<string, unknown>>;
  readonly links?: readonly { readonly rel?: string; readonly href?: string }[];
  readonly create_time?: string;
  readonly update_time?: string;
  readonly [key: string]: unknown;
}

/** The raw v2 payments authorization as observed (opaque passthrough). */
export interface PayPalAuthorizationProviderObject {
  readonly id: string;
  readonly status: string;
  readonly amount?: { readonly value?: string; readonly currency_code?: string };
  readonly seller_protection?: unknown;
  readonly create_time?: string;
  readonly update_time?: string;
  readonly [key: string]: unknown;
}

/** The raw v2 payments capture as observed (opaque passthrough). */
export interface PayPalCaptureProviderObject {
  readonly id: string;
  readonly status: string;
  readonly amount?: { readonly value?: string; readonly currency_code?: string };
  readonly final_capture?: boolean;
  readonly seller_payable_breakdown?: unknown;
  readonly create_time?: string;
  readonly update_time?: string;
  readonly [key: string]: unknown;
}

/** The raw v2 refund as observed (opaque passthrough). */
export interface PayPalRefundProviderObject {
  readonly id: string;
  readonly status: string;
  readonly amount?: { readonly value?: string; readonly currency_code?: string };
  readonly note_to_payer?: string;
  readonly seller_payable_breakdown?: unknown;
  readonly create_time?: string;
  readonly update_time?: string;
  readonly [key: string]: unknown;
}

/** The raw Payouts API batch response as observed (opaque passthrough). */
export interface PayPalPayoutBatchProviderObject {
  readonly batch_header?: {
    readonly payout_batch_id?: string;
    readonly batch_status?: string;
    readonly sender_batch_header?: unknown;
    readonly [key: string]: unknown;
  };
  readonly items?: readonly {
    readonly payout_item_id?: string;
    readonly status?: string;
    readonly payout_item_fee?: { readonly value?: string; readonly currency_code?: string };
    readonly amount?: { readonly value?: string; readonly currency_code?: string };
    readonly errors?: unknown;
    readonly [key: string]: unknown;
  }[];
  readonly links?: readonly unknown[];
  readonly [key: string]: unknown;
}

/** The raw Payouts API item as observed (opaque passthrough). */
export interface PayPalPayoutItemProviderObject {
  readonly payout_item_id?: string;
  readonly payout_batch_id?: string;
  readonly status?: string;
  readonly amount?: { readonly value?: string; readonly currency_code?: string };
  readonly payout_item_fee?: { readonly value?: string; readonly currency_code?: string };
  readonly recipient_type?: string;
  readonly receiver?: string;
  readonly sender_item_id?: string;
  readonly errors?: unknown;
  readonly [key: string]: unknown;
}

/** The raw OAuth2 token response as observed (opaque passthrough). */
export interface PayPalTokenProviderObject {
  readonly access_token?: string;
  readonly app_id?: string;
  readonly expires_in?: number;
  readonly token_type?: string;
  readonly nonce?: string;
  readonly scope?: string;
  readonly [key: string]: unknown;
}

/** The raw PayPal webhook event as observed (opaque passthrough). */
export interface PayPalWebhookEventObject {
  readonly id?: string;
  readonly event_type?: string;
  readonly event_version?: string;
  readonly resource_type?: string;
  readonly summary?: string;
  readonly create_time?: string;
  readonly resource?: unknown;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Canonical capability definitions
// ---------------------------------------------------------------------------

/** The canonical capability definitions consumed by the PayPal Direct connector. */
export function paypalDirectCapabilityDefinitions(): readonly CapabilityDefinition[] {
  const payerAction = customerActionRequirement(
    "PAYER_ACTION_REQUIRED",
    "COMPLETE_PAYER_ACTION",
    "The payer must complete the PayPal-required action (e.g. confirm the shipping address or funding source) before the order can proceed",
  );
  const unclaimedPayout = customerActionRequirement(
    "UNCLAIMED",
    "RECIPIENT_CLAIM_REQUIRED",
    "The payout recipient must claim the funds at PayPal before the payout item can complete — the destination is external, so only the recipient can act",
  );
  return Object.freeze([
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_CHECKOUT_ORDER_CAPABILITY_ID,
      summary: "Collection through the real PayPal v2 checkout-order lifecycle",
      operation: "rails.paypal-direct.checkout_order.create_capture_authorize",
      description:
        "Create/capture/authorize/observe PayPal checkout orders; PAYER_ACTION_REQUIRED preserved as a first-class customer action, statuses verbatim",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: PAYPAL_DIRECT_ORDER_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "checkout_order", idFormat: "ORDERID-[0-9A-Z]+|[0-9]{10,}" }],
      sideEffects: [
        { effect: "moves payer value on capture (settles into the PayPal balance)", financialEffect: "MOVES_VALUE", reversible: false },
        { effect: "reserves authorized value until capture (authorize intent)", financialEffect: "RESERVES_VALUE", reversible: true },
      ],
      idempotency: {
        idempotent: false,
        keyScope: "REQUEST",
        duplicateBehavior: "REJECTED",
        retryPolicy: "REQUIRES_RECONCILIATION",
      },
      requiredCustomerActions: [payerAction],
    }),
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_AUTHORIZATION_CAPABILITY_ID,
      summary: "v2 payment authorizations — capture, reauthorize, void",
      operation: "rails.paypal-direct.authorization.capture_reauthorize_void",
      description:
        "Operate the v2 authorization lifecycle; DENIED/EXPIRED/VOIDED terminal, CAPTURED hands over to the capture capability",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: PAYPAL_DIRECT_AUTHORIZATION_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "authorization", idFormat: "[0-9A-Z]{10,}" }],
      sideEffects: [
        { effect: "reserves authorized value until captured or voided", financialEffect: "RESERVES_VALUE", reversible: true },
      ],
      idempotency: {
        idempotent: false,
        keyScope: "REQUEST",
        duplicateBehavior: "REJECTED",
        retryPolicy: "REQUIRES_RECONCILIATION",
      },
    }),
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_CAPTURE_CAPABILITY_ID,
      summary: "v2 captures — the money objects, read and reconciled",
      operation: "rails.paypal-direct.capture.read_and_reconcile",
      description:
        "Observe capture lifecycle states with seller-payable-breakdown reconciliation evidence preserved verbatim; PaySwap never creates captures directly (orders and authorizations do)",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      providerStates: PAYPAL_DIRECT_CAPTURE_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "capture", idFormat: "[0-9A-Z]{10,}" }],
      sideEffects: [],
      idempotency: {
        idempotent: true,
        keyScope: "REQUEST",
        duplicateBehavior: "RETURNED_SAME_RESULT",
        retryPolicy: "SAFE_TO_RETRY",
      },
    }),
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_REFUND_CAPABILITY_ID,
      summary: "v2 refunds on captures, with reconciliation evidence",
      operation: "rails.paypal-direct.refund.create_and_read",
      description:
        "Create and observe PayPal refunds; reconcile through the seller-payable-breakdown carried verbatim in the provider state",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: PAYPAL_DIRECT_REFUND_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "refund", idFormat: "[0-9A-Z]{10,}" }],
      sideEffects: [
        { effect: "returns previously collected value to the payer", financialEffect: "ADJUSTS_VALUE", reversible: false },
      ],
      idempotency: {
        idempotent: false,
        keyScope: "REQUEST",
        duplicateBehavior: "REJECTED",
        retryPolicy: "REQUIRES_RECONCILIATION",
      },
    }),
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_PAYOUT_CAPABILITY_ID,
      summary: "Payouts (transfer-out) with an EXPLICIT external destination — separately scoped",
      operation: "rails.paypal-direct.payout.transfer_out",
      description:
        "Submit and observe PayPal payout batches/items. The destination is EXTERNAL and EXPLICIT (EMAIL/PAYPAL_ID recipient) by construction; transfer-out authority is a SEPARATE control-plane authorization (connection scope never grants debit); item states are ExternalFundsPositionObservations ONLY — never custody (INV-C09)",
      requiredPermissions: ["payouts:write"],
      requiredScopes: ["payouts:execute", "transfer_out:execute"],
      providerStates: PAYPAL_DIRECT_PAYOUT_ITEM_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "payout_batch", idFormat: "PAYOUTBATCH-[0-9A-Z]+|[0-9]{10,}" },
        { objectType: "payout_item", idFormat: "PAYOUTITEM-[0-9A-Z]+|[0-9]{10,}" },
      ],
      sideEffects: [
        { effect: "moves provider-held funds OUT to an explicit external recipient", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      idempotency: {
        idempotent: true,
        keyScope: "REQUEST",
        duplicateBehavior: "PROVIDER_DEFINED",
        retryPolicy: "REQUIRES_RECONCILIATION",
      },
      requiredCustomerActions: [unclaimedPayout],
    }),
  ]);
}

/** The connector capability pack backing the PayPal Direct rail (payments family + payouts sub-pack). */
export function paypalDirectRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.paypal-direct",
    family: "payments",
    version: "1.0.0",
    subPacks: [
      Object.freeze({
        packId: "pack.rails.paypal-direct.payouts",
        family: "payouts",
        version: "1.0.0",
        subPacks: [],
        capabilityRefs: [
          Object.freeze({
            capabilityId: PAYPAL_DIRECT_PAYOUT_CAPABILITY_ID,
            capabilityVersion: "1.0.0",
          }),
        ],
        auth: {
          authKind: "OAUTH" as const,
          scopes: ["payouts:execute", "transfer_out:execute"],
          rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
        },
        schemas: [{ schemaId: "schema.rails.paypal-direct.payout", version: "1.0.0" }],
        objectMappings: [
          {
            externalObjectType: "payout_batch",
            canonicalObjectRef: "payswap:external_funds_observation",
            sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
          },
          {
            externalObjectType: "payout_item",
            canonicalObjectRef: "payswap:external_funds_observation",
            sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
          },
        ],
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
        rateLimits: [{ limit: 50, windowSeconds: 60, scope: "account" }],
        provenance: {
          publisher: "payswap",
          publishedAt: "2026-10-02T00:00:00.000Z",
          contentHash: "hash:rails-paypal-direct-payouts-1",
        },
        evidence: [],
      }),
    ],
    capabilityRefs: paypalDirectCapabilityDefinitions()
      .filter((definition) => definition.capabilityId !== PAYPAL_DIRECT_PAYOUT_CAPABILITY_ID)
      .map((definition) => ({
        capabilityId: definition.capabilityId,
        capabilityVersion: definition.capabilityVersion,
      })),
    auth: {
      authKind: "OAUTH" as const,
      scopes: ["payments:write", "payments:read", "payouts:execute", "transfer_out:execute"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.paypal-direct.provider_state", version: "1.0.0" }],
    objectMappings: [
      {
        externalObjectType: "checkout_order",
        canonicalObjectRef: "payswap:payment",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "authorization",
        canonicalObjectRef: "payswap:payment",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "capture",
        canonicalObjectRef: "payswap:payment",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "refund",
        canonicalObjectRef: "payswap:refund",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 100, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-paypal-direct-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object)
// ---------------------------------------------------------------------------

/** Order revision: id + status + update_time (status revision). */
export function paypalOrderRevision(order: PayPalOrderProviderObject): string {
  const updateTime = typeof order.update_time === "string" ? order.update_time : "no_update_time";
  return `${order.id}:${order.status}:${updateTime}`;
}

/** Authorization revision: id + status. */
export function paypalAuthorizationRevision(
  authorization: PayPalAuthorizationProviderObject,
): string {
  return `${authorization.id}:${authorization.status}`;
}

/** Capture revision: id + status. */
export function paypalCaptureRevision(capture: PayPalCaptureProviderObject): string {
  return `${capture.id}:${capture.status}`;
}

/** Refund revision: id + status. */
export function paypalRefundRevision(refund: PayPalRefundProviderObject): string {
  return `${refund.id}:${refund.status}`;
}

/** Payout batch revision: payout_batch_id + batch_status + item count. */
export function paypalPayoutBatchRevision(batch: PayPalPayoutBatchProviderObject): string {
  const id = batch.batch_header?.payout_batch_id ?? "unknown_batch";
  const status = batch.batch_header?.batch_status ?? "unknown";
  return `${id}:${status}:${batch.items?.length ?? 0}`;
}

/** Payout item revision: payout_item_id + status. */
export function paypalPayoutItemRevision(item: PayPalPayoutItemProviderObject): string {
  return `${item.payout_item_id ?? "unknown_item"}:${item.status ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface PayPalEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK";
  readonly fetchId?: string;
}

function paypalEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: PayPalEnvelopeContext,
): {
  readonly providerName: string;
  readonly providerVersion: string;
  readonly objectType: string;
  readonly externalId: string;
  readonly revision: string;
  readonly state: unknown;
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK";
  readonly fetchId?: string;
} {
  return {
    providerName: PAYPAL_DIRECT_PROVIDER_NAME,
    providerVersion: PAYPAL_DIRECT_API_VERSION,
    objectType,
    externalId,
    revision,
    state,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
}

/** Envelope shareable-field surface for PayPal Direct provider objects (metadata only). */
const PAYPAL_DIRECT_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "id",
  "status",
  "intent",
  "amount",
  "currency_code",
  "create_time",
  "update_time",
  "payout_batch_id",
  "payout_item_id",
  "batch_status",
  "sender_batch_id",
  "payout_item_fee",
  "final_capture",
]);

/**
 * Deterministic, additive classification of a PayPal v2 checkout order into
 * a lossless ProviderStateEnvelope (INV-C06). The RAW order is carried
 * VERBATIM as `state`. Mapping (recorded in
 * PAYPAL_DIRECT_ORDER_STATUS_MAPPING):
 *
 * | PayPal status        | family                   | isTerminal | requiresCustomerAction |
 * |----------------------|--------------------------|------------|------------------------|
 * | CREATED              | other                    | false      | false                  |
 * | SAVED                | other                    | false      | false                  |
 * | APPROVED             | capture                  | false      | false                  |
 * | COMPLETED            | other                    | true       | false                  |
 * | VOIDED               | other                    | true       | false                  |
 * | PAYER_ACTION_REQUIRED| customer_action_required | false      | true                   |
 * | (unknown)            | other                    | false      | false (verbatim step)  |
 */
export function paypalOrderEnvelope(
  order: PayPalOrderProviderObject,
  context: PayPalEnvelopeContext,
): ProviderStateEnvelope {
  const base = paypalEnvelopeBase(
    "checkout_order",
    order.id,
    paypalOrderRevision(order),
    order,
    context,
  );
  switch (order.status) {
    case "PAYER_ACTION_REQUIRED": {
      const approveLink = approveLinkFrom(order);
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: "PAYER_ACTION_REQUIRED",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "COMPLETE_PAYER_ACTION",
          message:
            "The payer must complete the PayPal-required action (e.g. confirm the shipping address or funding source) before the order can proceed",
          ...(approveLink !== undefined ? { deepLink: approveLink } : {}),
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    }
    case "APPROVED":
      return railEnvelope({
        ...base,
        family: "capture",
        lifecycleStep: "APPROVED",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "COMPLETED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "COMPLETED",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "VOIDED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "VOIDED",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "order_voided",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    default:
      // CREATED / SAVED / any UNKNOWN provider status: preserved VERBATIM
      // under the total 'other' family — never dropped, never guessed,
      // never collapsed (INV-C06/INV-X01).
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: order.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/** The payer-approve link (rel=approve) from an order's HATEOAS links, when present. */
function approveLinkFrom(order: PayPalOrderProviderObject): string | undefined {
  for (const link of order.links ?? []) {
    if (link.rel === "approve" && typeof link.href === "string") {
      return link.href;
    }
  }
  return undefined;
}

/** First-class customer-action requirement derived from an order envelope. */
export function paypalOrderCustomerAction(
  order: PayPalOrderProviderObject,
): CustomerActionRequirement | undefined {
  if (order.status === "PAYER_ACTION_REQUIRED") {
    return customerActionRequirement(
      "PAYER_ACTION_REQUIRED",
      "COMPLETE_PAYER_ACTION",
      "The payer must complete the PayPal-required action before the order can proceed",
    );
  }
  return undefined;
}

/**
 * PayPal v2 authorization → lossless envelope. CAPTURED/DENIED/EXPIRED/VOIDED
 * are terminal; PENDING is asynchronous; unknown statuses stay verbatim under
 * the total 'other' family with no invented terminality.
 */
export function paypalAuthorizationEnvelope(
  authorization: PayPalAuthorizationProviderObject,
  context: PayPalEnvelopeContext,
): ProviderStateEnvelope {
  const base = paypalEnvelopeBase(
    "authorization",
    authorization.id,
    paypalAuthorizationRevision(authorization),
    authorization,
    context,
  );
  switch (authorization.status) {
    case "PENDING":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "PENDING",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "CAPTURED":
    case "PARTIALLY_CAPTURED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: authorization.status,
        isTerminal: authorization.status === "CAPTURED",
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "DENIED":
    case "EXPIRED":
    case "VOIDED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: authorization.status,
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: `authorization_${authorization.status.toLowerCase()}`,
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: authorization.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/**
 * PayPal v2 capture → lossless envelope. REFUNDED/PARTIALLY_REFUNDED map to
 * the refund family (the capture's refund-side state); DECLINED/FAILED are
 * definitive terminal failures; the seller-payable-breakdown reconciliation
 * evidence rides the verbatim `state` (INV-C06).
 */
export function paypalCaptureEnvelope(
  capture: PayPalCaptureProviderObject,
  context: PayPalEnvelopeContext,
): ProviderStateEnvelope {
  const base = paypalEnvelopeBase(
    "capture",
    capture.id,
    paypalCaptureRevision(capture),
    capture,
    context,
  );
  switch (capture.status) {
    case "COMPLETED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "COMPLETED",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "PENDING":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "PENDING",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "DECLINED":
    case "FAILED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: capture.status,
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: `capture_${capture.status.toLowerCase()}`,
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: capture.status,
        isTerminal: capture.status === "REFUNDED",
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: capture.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/**
 * PayPal v2 refund → refund-family envelope. `succeeded`-equivalent COMPLETED
 * and failure-equivalent CANCELLED/FAILED are terminal; PENDING is
 * asynchronous; the seller_payable_breakdown is preserved verbatim inside
 * `state` as balance-transaction-class reconciliation evidence.
 */
export function paypalRefundEnvelope(
  refund: PayPalRefundProviderObject,
  context: PayPalEnvelopeContext,
): ProviderStateEnvelope {
  const base = paypalEnvelopeBase(
    "refund",
    refund.id,
    paypalRefundRevision(refund),
    refund,
    context,
  );
  switch (refund.status) {
    case "PENDING":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "PENDING",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "COMPLETED":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "COMPLETED",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "CANCELLED":
    case "FAILED":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: refund.status,
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: `refund_${refund.status.toLowerCase()}`,
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: refund.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/**
 * PayPal Payouts batch → payout-family envelope. The RAW batch response
 * (batch_header + items verbatim) is carried as `state`; item-level fees and
 * statuses are preserved untouched (INV-C06). Item states are ALSO available
 * as ExternalFundsPositionObservations (see paypalPayoutItemObservations) —
 * an observation of external funds in motion, never custody.
 */
export function paypalPayoutBatchEnvelope(
  batch: PayPalPayoutBatchProviderObject,
  context: PayPalEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = batch.batch_header?.payout_batch_id ?? `payout_batch_unknown:${context.observedAt}`;
  const batchStatus = batch.batch_header?.batch_status ?? "unknown";
  const base = paypalEnvelopeBase(
    "payout_batch",
    externalId,
    paypalPayoutBatchRevision(batch),
    batch,
    context,
  );
  switch (batchStatus) {
    case "SUCCESS":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "SUCCESS",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "DENIED":
    case "CANCELED":
    case "ERROR":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: batchStatus,
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: `payout_batch_${batchStatus.toLowerCase()}`,
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "PENDING":
    case "PROCESSING":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: batchStatus,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: batchStatus,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/**
 * PayPal Payouts item → lossless envelope. UNCLAIMED is a first-class
 * customer-action-required state (the EXTERNAL recipient must claim);
 * REVERSED/REFUNDED map to the refund family; the recipient_type/receiver
 * ride the verbatim `state` only (never the observation metadata).
 */
export function paypalPayoutItemEnvelope(
  item: PayPalPayoutItemProviderObject,
  context: PayPalEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = item.payout_item_id ?? `payout_item_unknown:${context.observedAt}`;
  const status = item.status ?? "unknown";
  const base = paypalEnvelopeBase(
    "payout_item",
    externalId,
    paypalPayoutItemRevision(item),
    item,
    context,
  );
  switch (status) {
    case "UNCLAIMED":
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: "UNCLAIMED",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "RECIPIENT_CLAIM_REQUIRED",
          message:
            "The payout recipient must claim the funds at PayPal before the item can complete — the destination is external, so only the recipient can act",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "PENDING":
    case "ONHOLD":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "SUCCESS":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "SUCCESS",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "FAILED":
    case "BLOCKED":
    case "RETURNED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: status,
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: `payout_item_${status.toLowerCase()}`,
          retryable: status === "FAILED",
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "REVERSED":
    case "REFUNDED":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: status,
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/**
 * Maps a PayPal webhook event payload ({ id, event_type, resource, … }) to
 * the lossless envelope for its resource object, routing by event-type
 * prefix (PAYPAL_WEBHOOK_EVENT_TYPE_MAPPING, longest prefix first) and
 * verifying the resource carries the ids the mapper needs. Unknown event
 * types (or unrecognizable resources) produce an `event`-typed envelope
 * carrying the WHOLE event verbatim — nothing is dropped (INV-C06).
 */
export function paypalWebhookEventEnvelope(
  event: PayPalWebhookEventObject,
  context: PayPalEnvelopeContext,
): ProviderStateEnvelope {
  const webhookContext: PayPalEnvelopeContext = {
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
  const eventType = event.event_type;
  if (typeof eventType === "string" && eventType.length > 0) {
    const route = PAYPAL_WEBHOOK_EVENT_TYPE_MAPPING.find((entry) =>
      eventType.startsWith(entry.prefix),
    );
    const resource = event.resource;
    if (route !== undefined && resource !== null && typeof resource === "object") {
      const record = resource as Readonly<Record<string, unknown>>;
      switch (route.objectType) {
        case "order": {
          if (typeof record.id === "string" && typeof record.status === "string") {
            return paypalOrderEnvelope(resource as PayPalOrderProviderObject, webhookContext);
          }
          break;
        }
        case "authorization": {
          if (typeof record.id === "string" && typeof record.status === "string") {
            return paypalAuthorizationEnvelope(
              resource as PayPalAuthorizationProviderObject,
              webhookContext,
            );
          }
          break;
        }
        case "capture": {
          if (typeof record.id === "string" && typeof record.status === "string") {
            return paypalCaptureEnvelope(resource as PayPalCaptureProviderObject, webhookContext);
          }
          break;
        }
        case "refund": {
          if (typeof record.id === "string" && typeof record.status === "string") {
            return paypalRefundEnvelope(resource as PayPalRefundProviderObject, webhookContext);
          }
          break;
        }
        case "dispute": {
          // The dispute resource is preserved VERBATIM under the dispute
          // family; lifecycle step = the provider-declared dispute state
          // (never invented), action flags never fabricated.
          const disputeStatus =
            typeof record.status === "string" ? record.status : "unknown_dispute_state";
          return railEnvelope({
            providerName: PAYPAL_DIRECT_PROVIDER_NAME,
            providerVersion: PAYPAL_DIRECT_API_VERSION,
            objectType: "dispute",
            externalId:
              typeof record.dispute_id === "string"
                ? record.dispute_id
                : event.id ?? `dispute_unknown:${eventType}`,
            revision: `${String(record.dispute_id ?? "unknown")}:${disputeStatus}`,
            state: resource,
            family: "dispute",
            lifecycleStep: disputeStatus,
            isTerminal: disputeStatus === "RESOLVED",
            requiresCustomerAction: false,
            observedAt: context.observedAt,
            provenanceSource: "PROVIDER_WEBHOOK",
            ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
            shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
          });
        }
        case "payout_item":
        case "payout_batch": {
          // PAYMENT.PAYOUTS.* events carry a payout resource: item when it
          // has payout_item_id, batch when it has batch_header.
          if (record.payout_item_id !== undefined) {
            return paypalPayoutItemEnvelope(resource as PayPalPayoutItemProviderObject, webhookContext);
          }
          if (record.batch_header !== undefined) {
            return paypalPayoutBatchEnvelope(resource as PayPalPayoutBatchProviderObject, webhookContext);
          }
          break;
        }
      }
    }
  }
  return railEnvelope({
    providerName: PAYPAL_DIRECT_PROVIDER_NAME,
    providerVersion: PAYPAL_DIRECT_API_VERSION,
    objectType: "event",
    externalId: event.id ?? `evt_unknown:${event.event_type ?? "untyped"}`,
    revision: `${event.id ?? "unknown"}:${event.event_type ?? "untyped"}`,
    state: event,
    family: "other",
    lifecycleStep: event.event_type ?? "untyped",
    isTerminal: false,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
  });
}

// ---------------------------------------------------------------------------
// Exact money (INV-F01 — no floating-point money anywhere)
// ---------------------------------------------------------------------------

/**
 * Minor-unit digits for the PayPal-supported currencies this connector
 * handles. Currencies NOT in this table are refused (fail-closed: exactness
 * is never guessed). ISO-4217 digit counts, verified against the PayPal
 * currency documentation.
 */
export const PAYPAL_CURRENCY_MINOR_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  // 2-digit (default family)
  AED: 2, AUD: 2, BGN: 2, BRL: 2, CAD: 2, CHF: 2, CNY: 2, CZK: 2, DKK: 2,
  EGP: 2, EUR: 2, GBP: 2, GHS: 2, HKD: 2, HRK: 2, HUF: 2, ILS: 2, INR: 2,
  KES: 2, MAD: 2, MXN: 2, MYR: 2, NGN: 2, NOK: 2, NZD: 2, PHP: 2, PLN: 2,
  RON: 2, RUB: 2, SAR: 2, SGD: 2, THB: 2, TRY: 2, TWD: 2, TZS: 2, USD: 2,
  ZAR: 2,
  // 0-digit
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0,
  UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3-digit
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
});

/** Exact minor-unit digits for a currency (fail-closed on unlisted currencies). */
export function paypalMinorUnitDigits(currency: string): number {
  const upper = currency.toUpperCase();
  const digits = PAYPAL_CURRENCY_MINOR_DIGITS[upper];
  if (digits === undefined) {
    throw new ValidationError(
      `minor-unit digits are not certified for currency '${upper}' (INV-F01: exactness is never guessed — extend PAYPAL_CURRENCY_MINOR_DIGITS with provider-verified digits)`,
    );
  }
  return digits;
}

/**
 * Converts a PayPal decimal money string ("123.45") + currency into EXACT
 * integer minor units. Fail-closed on malformed values, more fractional
 * digits than the currency supports, and uncertified currencies.
 */
export function paypalMoneyToMinorUnits(
  money: { readonly value?: string; readonly currency_code?: string },
): { readonly currency: string; readonly minorUnits: string } {
  if (typeof money.value !== "string" || money.value.length === 0) {
    throw new ValidationError("a PayPal money value must be a non-empty decimal string (INV-F01)");
  }
  if (typeof money.currency_code !== "string" || money.currency_code.length !== 3) {
    throw new ValidationError("a PayPal money amount requires a 3-letter currency_code (INV-F01)");
  }
  const currency = money.currency_code.toUpperCase();
  const digits = paypalMinorUnitDigits(currency);
  // exactRationalFromDecimal validates the plain non-negative decimal shape.
  const rational = exactRationalFromDecimal(money.value);
  const scaled = (rational.numerator * 10n ** BigInt(digits)) / rational.denominator;
  if ((rational.numerator * 10n ** BigInt(digits)) % rational.denominator !== 0n) {
    throw new ValidationError(
      `PayPal money value '${money.value}' does not convert exactly to ${currency} minor units (INV-F01)`,
    );
  }
  return Object.freeze({ currency, minorUnits: scaled.toString() });
}

/**
 * Converts EXACT integer minor units into a PayPal decimal money string with
 * the currency's declared digits ("123.45"). Fail-closed on malformed input.
 */
export function minorUnitsToPayPalValue(amountMinor: string, currency: string): string {
  if (typeof amountMinor !== "string" || !/^\d+$/.test(amountMinor)) {
    throw new ValidationError("amountMinor must be an exact non-negative integer minor-units string (INV-F01)");
  }
  const upper = currency.toUpperCase();
  const digits = paypalMinorUnitDigits(upper);
  const minor = BigInt(amountMinor);
  const scale = 10n ** BigInt(digits);
  const whole = minor / scale;
  if (digits === 0) {
    return whole.toString();
  }
  const fraction = (minor % scale).toString().padStart(digits, "0");
  return `${whole.toString()}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Country eligibility FACTS (observed, never assumed — INV-C05/INV-NC04)
// ---------------------------------------------------------------------------

/**
 * A merchant/account-country eligibility FACT a connected instance carries.
 * A fact exists ONLY with an evidence reference — verified merchant/account
 * country support, recorded on the ConnectedCapabilityInstance (rule 18:
 * catalogue capability ≠ connected instance).
 */
export interface PayPalDirectCountryEligibilityFact {
  readonly country: string;
  /** Evidence artifact reference proving the fact (never empty). */
  readonly evidenceRef: string;
  readonly verifiedAt: string;
}

/** The verdict for one country against the eligibility facts the connector can see. */
export interface PayPalDirectCountryEligibility {
  readonly country: string;
  readonly eligible: boolean;
  /** "CONNECTED_INSTANCE_FACT" (evidence-backed) | "UNKNOWN" (never assumed). */
  readonly basis: "CONNECTED_INSTANCE_FACT" | "UNKNOWN";
  readonly reason: string;
  readonly evidenceRef?: string;
}

/**
 * The honest EMPTY facts set: this connector holds ZERO PayPal probe
 * evidence (phase-2 fail-closed law: no Wave-2 credentials held), so no
 * country fact is asserted anywhere in this module.
 */
export const PAYPAL_DIRECT_COUNTRY_FACTS_NONE: readonly PayPalDirectCountryEligibilityFact[] =
  Object.freeze([]);

/**
 * Country eligibility against the facts the connected instance carries.
 * Fail-closed: with no fact for the country, the verdict is basis UNKNOWN,
 * eligible false — merchant/account-country support is an eligibility FACT,
 * never routable coverage without connected-instance evidence.
 */
export function paypalDirectCountryEligibility(
  country: string,
  facts: readonly PayPalDirectCountryEligibilityFact[] = PAYPAL_DIRECT_COUNTRY_FACTS_NONE,
): PayPalDirectCountryEligibility {
  const upper = country.toUpperCase();
  const fact = facts.find((candidate) => candidate.country.toUpperCase() === upper);
  if (fact !== undefined && fact.evidenceRef.length > 0) {
    return Object.freeze({
      country: upper,
      eligible: true,
      basis: "CONNECTED_INSTANCE_FACT",
      reason: `merchant/account-country support verified on the connected instance (evidence ${fact.evidenceRef}, verified ${fact.verifiedAt})`,
      evidenceRef: fact.evidenceRef,
    });
  }
  return Object.freeze({
    country: upper,
    eligible: false,
    basis: "UNKNOWN",
    reason:
      "no connected-instance eligibility fact for this country — merchant/account-country support is UNKNOWN, never assumed (INV-C05/INV-NC04; fact requires connected-instance evidence)",
  });
}

// ---------------------------------------------------------------------------
// Observed account capability scope (from the OAuth2 token response)
// ---------------------------------------------------------------------------

/**
 * The account/app capability scope OBSERVED from a live OAuth2 token
 * acquisition: the app_id, the scope string the provider ACTUALLY granted
 * (a subset of the requested scopes is legal and observable — scope is
 * observed, never assumed), and the token lifetime. This is the PayPal
 * counterpart of GET /v1/account on Stripe: the token response is the
 * authenticated account-scope observation.
 */
export interface PayPalDirectAccountCapabilityScope {
  readonly appId: string;
  readonly observedScopes: readonly string[];
  readonly tokenType: string;
  readonly expiresInSeconds: number;
  readonly receivedAt: string;
  readonly provenanceSource: "PROVIDER_API";
}

/**
 * Derives the OBSERVED account capability scope from an OAuth2 token
 * response. Fail-closed: a response without an access_token is not a scope
 * observation.
 */
export function paypalDirectAccountScope(
  tokenResponse: PayPalTokenProviderObject,
  receivedAt: string,
): PayPalDirectAccountCapabilityScope {
  if (typeof tokenResponse.access_token !== "string" || tokenResponse.access_token.length === 0) {
    throw new ValidationError(
      "an OAuth2 token response without access_token is not an account-scope observation (fail-closed)",
    );
  }
  const scopeString = typeof tokenResponse.scope === "string" ? tokenResponse.scope : "";
  return Object.freeze({
    appId: tokenResponse.app_id ?? "unknown_app",
    observedScopes: Object.freeze(
      scopeString.split(" ").filter((scope) => scope.length > 0),
    ),
    tokenType: tokenResponse.token_type ?? "unknown",
    expiresInSeconds:
      typeof tokenResponse.expires_in === "number" && Number.isFinite(tokenResponse.expires_in)
        ? tokenResponse.expires_in
        : -1,
    receivedAt,
    provenanceSource: "PROVIDER_API",
  });
}

// ---------------------------------------------------------------------------
// External funds observations (INV-C09 — observations, NEVER custody)
// ---------------------------------------------------------------------------

/**
 * Maps a Payouts API response (create or read) to
 * ExternalFundsPositionObservations — one per item carrying an amount. These
 * are observations of PROVIDER-HELD funds in motion toward an EXPLICIT
 * external recipient: they are NOT PaySwap custody, NOT a balance PaySwap
 * owes anyone, and cannot create a false PaySwap balance (nominal
 * observationKind brand + mandatory freshness/provenance).
 *
 * Privacy: the observation metadata deliberately carries NO recipient
 * address — the raw item state (lossless, INV-C06) holds it; observations
 * hold only the item id, status class and exact amount.
 */
export function paypalPayoutItemObservations(input: {
  readonly batch: PayPalPayoutBatchProviderObject;
  readonly accountRef: string;
  readonly observedAt: string;
  /** Consumer-side maximum tolerated age for these observations. */
  readonly maxAgeSeconds?: number;
  readonly observationIdPrefix?: string;
}): readonly ExternalFundsPositionObservation[] {
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  const prefix = input.observationIdPrefix ?? "paypal-direct-payout";
  const observations: ExternalFundsPositionObservation[] = [];
  for (const item of input.batch.items ?? []) {
    if (
      item.amount === null ||
      typeof item.amount !== "object" ||
      typeof item.amount.value !== "string" ||
      item.amount.value.length === 0 ||
      typeof item.amount.currency_code !== "string" ||
      item.amount.currency_code.length === 0
    ) {
      continue;
    }
    let minorUnits: string;
    try {
      minorUnits = paypalMoneyToMinorUnits(item.amount).minorUnits;
    } catch {
      // Uncertified currency digits: the item stays lossless in the
      // envelope state; the OBSERVATION is skipped (an unverifiable exact
      // amount can never create a false balance — INV-C09).
      continue;
    }
    observations.push(
      Object.freeze({
        observationKind: "ExternalFundsPositionObservation" as const,
        observationId: `${prefix}:${item.payout_item_id ?? "unknown_item"}`,
        observedAt: input.observedAt,
        freshness: Object.freeze({
          asOf: input.observedAt,
          maxAgeSeconds,
        }),
        location: Object.freeze({
          providerName: PAYPAL_DIRECT_PROVIDER_NAME,
          accountRef: input.accountRef,
          instrumentRef: `payout-item:${item.payout_item_id ?? "unknown_item"}`,
          description: `PayPal payout item in state '${item.status ?? "unknown"}' toward an EXPLICIT external recipient (external funds in motion — observation, never custody)`,
        }),
        observedAmount: Object.freeze({
          currency: item.amount.currency_code.toUpperCase(),
          minorUnits,
        }),
        provenance: Object.freeze({
          providerName: PAYPAL_DIRECT_PROVIDER_NAME,
          source: "PROVIDER_API" as const,
          capturedAt: input.observedAt,
        }),
        reconciliationState: "NOT_RECONCILED" as const,
      }),
    );
  }
  return Object.freeze(observations);
}

// ---------------------------------------------------------------------------
// Idempotency (PayPal-Request-Id / sender_batch_id over the protocol key)
// ---------------------------------------------------------------------------

/**
 * Derives the PayPal-Request-Id header value from the protocol idempotency
 * key (INV-F05): namespaced so a protocol key can never collide with an
 * unrelated provider-side request id. Deterministic: same protocol key →
 * same header on every retry.
 */
export function paypalRequestId(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap:${protocolIdempotencyKey}`;
}

/**
 * Derives the payout sender_batch_id from the protocol idempotency key: the
 * provider's OWN dedupe field for payout batches (a duplicate
 * sender_batch_id is rejected by the provider — mapped to an error state,
 * never a silent success). Sanitized to the provider's accepted character
 * class, deterministically.
 */
export function paypalSenderBatchId(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  const sanitized = protocolIdempotencyKey.replace(/[^A-Za-z0-9_-]/g, "-");
  return `payswap-${sanitized}`;
}

/**
 * A PayPal idempotency conflict: the SAME protocol idempotency key was
 * submitted with a DIFFERENT body. This is an ERROR STATE, never a silent
 * success — the original submission holding the key stands.
 */
export class PayPalIdempotencyConflictError extends RailProviderError {
  constructor(message: string, details?: PaySwapError["details"]) {
    super(message, details);
    this.name = "PayPalIdempotencyConflictError";
  }
}

/**
 * A duplicate-submit answer from the provider (DUPLICATE_REQUEST error
 * name, or a duplicate sender_batch_id rejection on payouts): the request
 * was NOT executed as a new object — an ERROR/duplicate state, never a
 * silent success.
 */
export class PayPalDuplicateSubmitError extends RailProviderError {
  constructor(message: string, details?: PaySwapError["details"]) {
    super(message, details);
    this.name = "PayPalDuplicateSubmitError";
  }
}

/**
 * A payout-controls violation: the payout destination is not an EXPLICIT
 * EXTERNAL destination (missing recipient type, empty receiver, or an
 * internal/implicit destination shape). Refused BEFORE any provider call.
 */
export class PayPalPayoutDestinationError extends PaySwapError {
  constructor(message: string, details?: PaySwapError["details"]) {
    super({
      code: "PAYOUT_DESTINATION_NOT_EXPLICIT",
      category: "POLICY_BLOCKED",
      message,
      details,
    });
    this.name = "PayPalPayoutDestinationError";
  }
}

// ---------------------------------------------------------------------------
// Webhook verification (the PayPal scheme — provider-side verification)
// ---------------------------------------------------------------------------

/** Default transmission-time tolerance window (seconds). */
export const PAYPAL_WEBHOOK_DEFAULT_TOLERANCE_SECONDS = 600;

/**
 * A raw PayPal webhook delivery, exactly as received: the transmission
 * headers PayPal attaches plus the RAW payload bytes.
 */
export interface PayPalWebhookDelivery {
  readonly rawPayload: string;
  readonly headers: {
    /** PAYPAL-AUTH-ALGO. */
    readonly authAlgo?: string;
    /** PAYPAL-CERT-URL. */
    readonly certUrl?: string;
    /** PAYPAL-TRANSMISSION-ID. */
    readonly transmissionId?: string;
    /** PAYPAL-TRANSMISSION-SIG. */
    readonly transmissionSig?: string;
    /** PAYPAL-TRANSMISSION-TIME (ISO-8601, provider-issued). */
    readonly transmissionTime?: string;
    /** PAYPAL-WEBHOOK-ID (the configured webhook's id). */
    readonly webhookId?: string;
  };
}

/**
 * The byte-verified result of one PayPal webhook delivery: PayPal verifies
 * webhooks provider-side (POST /v1/notifications/verify-webhook-signature),
 * so verification needs an authenticated provider call. A delivery that
 * cannot be verified is REJECTED — a rejected webhook is never truth
 * (PSP-ADAPTER-NETWORK "Reconciliation": no external processor webhook
 * becomes truth without adapter verification).
 */
export type PayPalWebhookVerificationResult =
  | {
      readonly valid: true;
      readonly verificationStatus: "SUCCESS";
      readonly transmissionId: string;
      readonly transmissionTime: string;
      readonly webhookId: string;
      /** The RAW event mapped to its lossless envelope (INV-C06). */
      readonly providerState: ProviderStateEnvelope;
      /** Provider evidence for the verified delivery (INV-E02). */
      readonly evidence: ProviderExecutionEvidenceDraft;
    }
  | {
      readonly valid: false;
      readonly reason:
        | "MISSING_TRANSMISSION_HEADERS"
        | "MALFORMED_TRANSMISSION_TIME"
        | "FUTURE_TRANSMISSION_TIME"
        | "TRANSMISSION_TIME_OUTSIDE_TOLERANCE"
        | "REPLAYED_TRANSMISSION"
        | "PROVIDER_VERIFICATION_FAILED"
        | "PROVIDER_TRANSPORT_UNREACHABLE"
        | "MALFORMED_EVENT";
    };

/**
 * PayPalWebhookVerifier — the REAL PayPal webhook verification scheme
 * (spec/phase-2 work order: transmission-id/time correlation, event-type
 * mapping, replay dedupe, tolerance window):
 *
 * 1. header completeness: auth algo, cert URL, transmission id, transmission
 *    sig, transmission time and webhook id must ALL be present;
 * 2. transmission-time correlation: the provider-declared transmission time
 *    must be inside the tolerance window around the injected clock, and not
 *    unreasonably in the future (replay/freshness);
 * 3. replay dedupe: a transmission id already verified by THIS verifier is
 *    rejected as a replay (PayPal re-delivers with the same transmission id);
 * 4. provider-side verification: POST /v1/notifications/verify-webhook-signature
 *    with the transmission headers + webhook id + the raw event — the ONLY
 *    authority on the signature (the certificate chain is the provider's);
 * 5. event-type mapping: a VERIFIED delivery's payload maps losslessly to its
 *    provider-state envelope (INV-C06) and produces execution evidence.
 *
 * Deterministic: all time flows through the injected clock; the token is
 * acquired through the injected token acquirer (the connector's
 * OAuth2 client-credentials path).
 */
export class PayPalWebhookVerifier {
  readonly #http: HttpTransport;
  readonly #apiBase: string;
  readonly #clock: ProtocolClock;
  readonly #toleranceSeconds: number;
  readonly #futureSkewSeconds: number;
  readonly #webhookId: string;
  readonly #acquireToken: () => Promise<string>;
  readonly #verifiedTransmissions = new Map<string, string>();
  #verificationSequence = 1;

  constructor(deps: {
    readonly http: HttpTransport;
    readonly apiBase: string;
    readonly clock: ProtocolClock;
    readonly webhookId: string;
    readonly acquireToken: () => Promise<string>;
    readonly toleranceSeconds?: number;
    readonly futureSkewSeconds?: number;
  }) {
    if (typeof deps.webhookId !== "string" || deps.webhookId.length === 0) {
      throw new ValidationError("a PayPal webhook verifier requires the configured webhook id");
    }
    if (typeof deps.acquireToken !== "function") {
      throw new ValidationError("a PayPal webhook verifier requires a token acquirer");
    }
    this.#http = deps.http;
    this.#apiBase = deps.apiBase;
    this.#clock = deps.clock;
    this.#webhookId = deps.webhookId;
    this.#acquireToken = deps.acquireToken;
    this.#toleranceSeconds = deps.toleranceSeconds ?? PAYPAL_WEBHOOK_DEFAULT_TOLERANCE_SECONDS;
    this.#futureSkewSeconds = deps.futureSkewSeconds ?? 5;
    if (this.#toleranceSeconds < 1) {
      throw new ValidationError("toleranceSeconds must be positive");
    }
    if (this.#futureSkewSeconds < 0) {
      throw new ValidationError("futureSkewSeconds must be non-negative");
    }
  }

  /** Verifies one delivery end-to-end (replay dedupe + provider-side verification). */
  async verifyDelivery(delivery: PayPalWebhookDelivery): Promise<PayPalWebhookVerificationResult> {
    const h = delivery.headers;
    if (
      typeof h.authAlgo !== "string" || h.authAlgo.length === 0 ||
      typeof h.certUrl !== "string" || h.certUrl.length === 0 ||
      typeof h.transmissionId !== "string" || h.transmissionId.length === 0 ||
      typeof h.transmissionSig !== "string" || h.transmissionSig.length === 0 ||
      typeof h.transmissionTime !== "string" || h.transmissionTime.length === 0
    ) {
      return { valid: false, reason: "MISSING_TRANSMISSION_HEADERS" };
    }
    const transmissionMs = Date.parse(h.transmissionTime);
    const nowMs = Number(this.#clock.now());
    if (Number.isNaN(transmissionMs)) {
      return { valid: false, reason: "MALFORMED_TRANSMISSION_TIME" };
    }
    if (transmissionMs > nowMs + this.#futureSkewSeconds * 1000) {
      return { valid: false, reason: "FUTURE_TRANSMISSION_TIME" };
    }
    if (nowMs - transmissionMs > this.#toleranceSeconds * 1000) {
      return { valid: false, reason: "TRANSMISSION_TIME_OUTSIDE_TOLERANCE" };
    }
    let parsedEvent: PayPalWebhookEventObject;
    try {
      parsedEvent = JSON.parse(delivery.rawPayload) as PayPalWebhookEventObject;
    } catch {
      return { valid: false, reason: "MALFORMED_EVENT" };
    }
    if (
      parsedEvent === null ||
      typeof parsedEvent !== "object" ||
      typeof parsedEvent.id !== "string" ||
      parsedEvent.id.length === 0
    ) {
      return { valid: false, reason: "MALFORMED_EVENT" };
    }
    const replayedEventId = this.#verifiedTransmissions.get(h.transmissionId);
    if (replayedEventId !== undefined) {
      return { valid: false, reason: "REPLAYED_TRANSMISSION" };
    }
    // The provider is the ONLY signature authority: ask it to verify.
    let token: string;
    try {
      token = await this.#acquireToken();
    } catch {
      // Credential path unavailable: verification CANNOT be established —
      // the delivery is rejected (never truth without verification).
      return { valid: false, reason: "PROVIDER_TRANSPORT_UNREACHABLE" };
    }
    const body = JSON.stringify({
      auth_algo: h.authAlgo,
      cert_url: h.certUrl,
      transmission_id: h.transmissionId,
      transmission_sig: h.transmissionSig,
      transmission_time: h.transmissionTime,
      webhook_id: this.#webhookId,
      webhook_event: parsedEvent,
    });
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        timeoutMs: 15_000,
      });
    } catch {
      return { valid: false, reason: "PROVIDER_TRANSPORT_UNREACHABLE" };
    }
    let answer: { readonly verification_status?: string };
    try {
      answer = JSON.parse(response.bodyText) as { readonly verification_status?: string };
    } catch {
      return { valid: false, reason: "PROVIDER_VERIFICATION_FAILED" };
    }
    if (
      response.status < 200 ||
      response.status >= 300 ||
      answer.verification_status !== "SUCCESS"
    ) {
      return { valid: false, reason: "PROVIDER_VERIFICATION_FAILED" };
    }
    this.#verifiedTransmissions.set(h.transmissionId, parsedEvent.id);
    const observedAt = isoTimestamp(this.#clock.now());
    const providerState = paypalWebhookEventEnvelope(parsedEvent, {
      observedAt,
      provenanceSource: "PROVIDER_WEBHOOK",
      fetchId: `${h.transmissionId}:${this.#verificationSequence}`,
    });
    this.#verificationSequence += 1;
    const now: TimestampMs = this.#clock.now();
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId: `paypal-direct:webhook:${h.transmissionId}`,
      evidenceRef: `provider-event:${PAYPAL_DIRECT_PROVIDER_NAME}:${parsedEvent.id}`,
      kind: "WEBHOOK_EVENT",
      providerState,
      recordedAt: now,
    });
    return {
      valid: true,
      verificationStatus: "SUCCESS",
      transmissionId: h.transmissionId,
      transmissionTime: h.transmissionTime,
      webhookId: this.#webhookId,
      providerState,
      evidence,
    };
  }

  /** The transmission ids this verifier has verified (replay-dedupe observability). */
  verifiedTransmissionIds(): readonly string[] {
    return Object.freeze([...this.#verifiedTransmissions.keys()]);
  }
}

/**
 * A pass-through signature verifier for the adapters' ProviderWebhookIngestor
 * hook, for deliveries ALREADY verified provider-side by
 * PayPalWebhookVerifier (the provider is the signature authority, so the
 * ingestor-side verifier only checks that the transmission signature is the
 * one that was provider-verified). The canonical path is
 * PayPalWebhookVerifier.verifyDelivery — this adapter exists so a verified
 * delivery can also flow through the standard ingestor machinery (replay
 * window + (provider, eventId) dedupe + append-only evidence).
 */
export class PayPalVerifiedDeliveryVerifier implements WebhookSignatureVerifier {
  readonly #verifiedSigs: ReadonlySet<string>;

  constructor(verifiedSignatures: readonly string[]) {
    this.#verifiedSigs = new Set(verifiedSignatures);
  }

  verify(
    event: ProviderWebhookRawEvent,
    _canonicalBody: string,
  ): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
    if (this.#verifiedSigs.has(event.headers.signature)) {
      return { valid: true };
    }
    return {
      valid: false,
      reason:
        "SIGNATURE_INVALID — the delivery was not provider-verified (run PayPalWebhookVerifier.verifyDelivery first; PayPal signatures verify provider-side)",
    };
  }
}

/**
 * Wires a ProviderWebhookIngestor for PayPal over deliveries already verified
 * provider-side: the transmission signature is the dedupe/verification key,
 * the header timestamp is the transmission time (replay window), the provider
 * event id is the (provider, eventId) dedupe key.
 */
export function createPayPalWebhookIngestor(deps: {
  readonly verifiedSignatures: readonly string[];
  readonly clock: ProtocolClock;
  readonly replayWindowSeconds?: number;
  readonly futureSkewSeconds?: number;
}): ProviderWebhookIngestor {
  return new WebhookIngestor({
    verifier: new PayPalVerifiedDeliveryVerifier(deps.verifiedSignatures),
    clock: deps.clock,
    ...(deps.replayWindowSeconds !== undefined
      ? { replayWindowSeconds: deps.replayWindowSeconds }
      : {}),
    ...(deps.futureSkewSeconds !== undefined
      ? { futureSkewSeconds: deps.futureSkewSeconds }
      : {}),
  });
}

/** Adapts a provider-verified delivery into the adapters' ProviderWebhookRawEvent. */
export function paypalWebhookRawEvent(delivery: {
  readonly eventId: string;
  readonly payload: unknown;
  readonly transmissionId: string;
  readonly transmissionTime: string;
  readonly transmissionSig: string;
}): ProviderWebhookRawEvent {
  return Object.freeze({
    providerName: PAYPAL_DIRECT_PROVIDER_NAME,
    eventId: delivery.eventId,
    timestamp: String(Math.floor(Date.parse(delivery.transmissionTime) / 1000)),
    payload: delivery.payload,
    headers: Object.freeze({
      signature: delivery.transmissionSig,
      timestamp: String(Math.floor(Date.parse(delivery.transmissionTime) / 1000)),
    }),
  });
}

// ---------------------------------------------------------------------------
// Credential material extraction (vault bundle shapes; fail-closed)
// ---------------------------------------------------------------------------

/**
 * The OAuth2 client-credentials material this connector consumes: a
 * client_id/client_secret pair. NEVER a raw value in any contract — this
 * interface exists only inside the sealed-bundle callback frame.
 */
export interface PayPalDirectCredentialMaterial {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Extracts the PayPal Direct client-credentials material from a vault
 * bundle shape. The control plane hands the connector whatever the vault
 * object holds: a bundle record ({ clientId, clientSecret } /
 * { client_id, client_secret }) or the env-convention "id:secret" string.
 * Any other shape refuses the call (fail-closed, no guessing).
 */
export function extractPayPalCredentialMaterial(material: unknown): PayPalDirectCredentialMaterial {
  if (typeof material === "string" && material.length > 0) {
    const separator = material.indexOf(":");
    if (separator > 0 && separator < material.length - 1) {
      return Object.freeze({
        clientId: material.substring(0, separator),
        clientSecret: material.substring(separator + 1),
      });
    }
    throw new ValidationError(
      'the env credential material must be the "clientId:clientSecret" pair (fail-closed, no guessing)',
    );
  }
  if (material !== null && typeof material === "object") {
    const record = material as Readonly<Record<string, unknown>>;
    const clientId = record["clientId"] ?? record["client_id"];
    const clientSecret = record["clientSecret"] ?? record["client_secret"];
    if (typeof clientId === "string" && clientId.length > 0 && typeof clientSecret === "string" && clientSecret.length > 0) {
      return Object.freeze({ clientId, clientSecret });
    }
  }
  throw new ValidationError(
    "the sealed credential bundle does not contain PayPal client-credentials material (expected { clientId, clientSecret } or the id:secret string)",
  );
}

// ---------------------------------------------------------------------------
// The RailAdapter surface (provider-neutral framework registration)
// ---------------------------------------------------------------------------

/** The PayPal Direct production rail adapter on the BaseRailAdapter framework. */
export class PayPalDirectProductionRail extends BaseRailAdapter {
  readonly adapterId = PAYPAL_DIRECT_RAIL_ADAPTER_ID;
  readonly implementationId = PAYPAL_DIRECT_RAIL_IMPLEMENTATION_ID;

  constructor() {
    const definitions = new Map<string, CapabilityDefinition>();
    for (const definition of paypalDirectCapabilityDefinitions()) {
      definitions.set(definition.capabilityId, definition);
    }
    super(paypalDirectRailCapabilityPack(), definitions);
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK; credential-gated, fail-closed)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface PayPalDirectControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface PayPalDirectConnectorConfig {
  readonly clock: ProtocolClock;
  readonly apiBase?: string;
  /** The control-plane credential configuration key. Defaults to PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY. */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: PayPalDirectControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
  /** Token-cache safety margin in ms (default 60s before the provider-declared expiry). */
  readonly tokenExpiryMarginMs?: number;
}

/**
 * The payout destination: EXTERNAL and EXPLICIT by construction. The literal
 * `destinationKind: "EXTERNAL"` makes an internal/implicit destination
 * unrepresentable — a payout without an explicit external recipient is a
 * POLICY_BLOCKED refusal before any provider call.
 */
export interface PayPalDirectPayoutDestination {
  readonly destinationKind: "EXTERNAL";
  /** The provider's recipient_type: EMAIL address or PayPal account (PAYER_ID). */
  readonly recipientType: "EMAIL" | "PAYPAL_ID";
  readonly receiver: string;
}

/** One payout item: exact minor units + an explicit external destination + the caller's per-item id. */
export interface PayPalDirectPayoutItemInput {
  readonly amountMinor: string;
  readonly currency: string;
  readonly destination: PayPalDirectPayoutDestination;
  readonly note?: string;
  /** The caller's per-item reference (provider sender_item_id — per-item correlation). */
  readonly senderItemId: string;
}

/** The payout submission product: the SDK result plus the external-funds observations. */
export interface PayPalDirectPayoutSubmission {
  readonly result: SdkCallResult;
  readonly observations: readonly ExternalFundsPositionObservation[];
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type PayPalDirectSdkRequest =
  | { readonly kind: "read_order"; readonly orderId: string }
  | { readonly kind: "read_authorization"; readonly authorizationId: string }
  | { readonly kind: "read_capture"; readonly captureId: string }
  | { readonly kind: "read_refund"; readonly refundId: string }
  | { readonly kind: "read_payout_batch"; readonly payoutBatchId: string }
  | { readonly kind: "read_payout_item"; readonly payoutItemId: string }
  | {
      readonly kind: "create_order";
      readonly amountMinor: string;
      readonly currency: string;
      readonly intent: "CAPTURE" | "AUTHORIZE";
      readonly referenceId?: string;
      readonly description?: string;
      readonly customId?: string;
      readonly invoiceId?: string;
    }
  | {
      readonly kind: "create_payout";
      readonly items: readonly PayPalDirectPayoutItemInput[];
      readonly emailSubject?: string;
      readonly emailMessage?: string;
      /** REQUIRED: the separately-scoped transfer-out authorization (control plane). */
      readonly transferOut: ConnectedInstanceActivation;
    }
  | { readonly kind: "capture_order"; readonly orderId: string }
  | { readonly kind: "authorize_order"; readonly orderId: string }
  | {
      readonly kind: "capture_authorization";
      readonly authorizationId: string;
      readonly amountMinor?: string;
    }
  | { readonly kind: "void_authorization"; readonly authorizationId: string }
  | { readonly kind: "reauthorize_authorization"; readonly authorizationId: string }
  | {
      readonly kind: "refund_capture";
      readonly captureId: string;
      readonly amountMinor?: string;
      readonly noteToPayer?: string;
    }
  | { readonly kind: "reconcile_order"; readonly orderId: string }
  | { readonly kind: "reconcile_authorization"; readonly authorizationId: string }
  | { readonly kind: "reconcile_capture"; readonly captureId: string }
  | { readonly kind: "reconcile_refund"; readonly refundId: string }
  | { readonly kind: "reconcile_payout_batch"; readonly payoutBatchId: string }
  | { readonly kind: "reconcile_payout_item"; readonly payoutItemId: string };

function isPayPalDirectSdkRequest(candidate: unknown): candidate is PayPalDirectSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** Which credential path is live (observability — NEVER material). */
export type PayPalDirectCredentialResolutionState =
  | {
      readonly kind: "CONTROL_PLANE_SEALED";
      readonly configKey: string;
      readonly authorizationMode: "SCOPED_API_CREDENTIAL" | "CONNECTED_ACCOUNT";
    }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/**
 * The real PayPal Direct connector (ConnectorSDK framework). PayPal API
 * names, payloads, response shapes and quirks stay INSIDE this
 * implementation: the SDK call contract is the provider-neutral
 * `PayPalDirectSdkRequest` union. Every effectful operation runs behind
 * `requireAuthority` (INV-C04/F05/F06) and fails closed with
 * `RailNotAuthorizedError` BEFORE any provider call when no credential path
 * is live (INV-NC04). Payouts additionally require the SEPARATE
 * transfer-out authorization (assertTransferOutAuthorized — connection
 * scope alone never authorizes debit).
 */
export class PayPalDirectConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: PayPalDirectControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  readonly #tokenExpiryMarginMs: number;
  #credentialBaseline: string | undefined;
  #tokenCache: { readonly response: PayPalTokenProviderObject; readonly expiresAtMs: TimestampMs } | undefined;
  /** Local idempotency registry: protocol key → canonical request hash (INV-F05). */
  readonly #submittedKeys = new Map<string, string>();

  constructor(config: PayPalDirectConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase = config.apiBase ?? PAYPAL_DIRECT_DEFAULT_API_BASE;
    this.#credentialConfigKey =
      config.credentialConfigKey ?? PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
    this.#tokenExpiryMarginMs = config.tokenExpiryMarginMs ?? 60_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: PAYPAL_DIRECT_PROVIDER_NAME,
      providerVersion: PAYPAL_DIRECT_API_VERSION,
      systemKind: "psp",
      displayName: "PayPal Direct (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return paypalDirectRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): PayPalDirectCredentialResolutionState {
    if (this.#controlPlane !== undefined) {
      // Peek the descriptor (a reference, not material) to observe the
      // authorization mode; release the minted handle immediately.
      try {
        const handle = this.#controlPlane.broker.resolveProviderCredential(
          this.#credentialConfigKey,
        );
        const mode = handle.descriptor.authorizationMode;
        this.#controlPlane.broker.releaseSealedHandle(handle);
        const authorizationMode =
          mode === "CONNECTED_ACCOUNT" ? "CONNECTED_ACCOUNT" : "SCOPED_API_CREDENTIAL";
        return Object.freeze({
          kind: "CONTROL_PLANE_SEALED",
          configKey: this.#credentialConfigKey,
          authorizationMode,
        });
      } catch (error) {
        return Object.freeze({
          kind: "NOT_PROVISIONED",
          configKey: this.#credentialConfigKey,
          reason: `the control-plane credential config key does not resolve to a sealed bundle (fail-closed — INV-NC04): ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
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
        "no control-plane credentials and no env-resolved material under the config key — rail fails closed (INV-NC04; packages/rails/BLOCKED-RAILS.md)",
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
          "credential reference not provisioned — source availability UNKNOWN (INV-C01/C02); see packages/rails/BLOCKED-RAILS.md",
        provenance: {
          providerName: PAYPAL_DIRECT_PROVIDER_NAME,
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
          providerName: PAYPAL_DIRECT_PROVIDER_NAME,
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
        providerName: PAYPAL_DIRECT_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(PAYPAL_DIRECT_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface --------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "the PayPal Direct REST surface exposes no search/list family: reads are by explicit external object id (order/authorization/capture/refund/payout batch/payout item)",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "read_order");
    const observedAt = this.#envelopeContext();
    switch (request.kind) {
      case "read_order":
      case "reconcile_order": {
        const order = (await this.#providerGet(
          `/v2/checkout/orders/${encodeURIComponent(request.orderId)}`,
          ctx.idempotencyKey,
        )) as PayPalOrderProviderObject;
        this.#requireOrderId(order);
        return this.#sdkResult(
          paypalOrderEnvelope(order, observedAt),
          `paypal-direct:read-order:${request.orderId}`,
        );
      }
      case "read_authorization":
      case "reconcile_authorization": {
        const authorization = (await this.#providerGet(
          `/v2/payments/authorizations/${encodeURIComponent(request.authorizationId)}`,
          ctx.idempotencyKey,
        )) as PayPalAuthorizationProviderObject;
        return this.#sdkResult(
          paypalAuthorizationEnvelope(authorization, observedAt),
          `paypal-direct:read-authorization:${request.authorizationId}`,
        );
      }
      case "read_capture":
      case "reconcile_capture": {
        const capture = (await this.#providerGet(
          `/v2/payments/captures/${encodeURIComponent(request.captureId)}`,
          ctx.idempotencyKey,
        )) as PayPalCaptureProviderObject;
        return this.#sdkResult(
          paypalCaptureEnvelope(capture, observedAt),
          `paypal-direct:read-capture:${request.captureId}`,
        );
      }
      case "read_refund":
      case "reconcile_refund": {
        const refund = (await this.#providerGet(
          `/v2/payments/refunds/${encodeURIComponent(request.refundId)}`,
          ctx.idempotencyKey,
        )) as PayPalRefundProviderObject;
        return this.#sdkResult(
          paypalRefundEnvelope(refund, observedAt),
          `paypal-direct:read-refund:${request.refundId}`,
        );
      }
      case "read_payout_batch":
      case "reconcile_payout_batch": {
        const batch = (await this.#providerGet(
          `/v1/payments/payouts/${encodeURIComponent(request.payoutBatchId)}`,
          ctx.idempotencyKey,
        )) as PayPalPayoutBatchProviderObject;
        return this.#sdkResult(
          paypalPayoutBatchEnvelope(batch, observedAt),
          `paypal-direct:read-payout-batch:${request.payoutBatchId}`,
        );
      }
      case "read_payout_item":
      case "reconcile_payout_item": {
        const item = (await this.#providerGet(
          `/v1/payments/payouts-item/${encodeURIComponent(request.payoutItemId)}`,
          ctx.idempotencyKey,
        )) as PayPalPayoutItemProviderObject;
        return this.#sdkResult(
          paypalPayoutItemEnvelope(item, observedAt),
          `paypal-direct:read-payout-item:${request.payoutItemId}`,
        );
      }
      default:
        throw new ValidationError(
          `paypal-direct read supports read_order/read_authorization/read_capture/read_refund/read_payout_batch/read_payout_item (and their reconcile_* counterparts) — got kind '${request.kind}'`,
        );
    }
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_order");
    const observedAt = this.#envelopeContext();
    if (request.kind === "create_order") {
      if (request.amountMinor === undefined || request.currency === undefined) {
        throw new ValidationError("create_order requires amountMinor and currency (exact minor units)");
      }
      const body = {
        intent: request.intent,
        purchase_units: [
          {
            amount: {
              currency_code: request.currency.toUpperCase(),
              value: minorUnitsToPayPalValue(request.amountMinor, request.currency),
            },
            ...(request.referenceId !== undefined ? { reference_id: request.referenceId } : {}),
            ...(request.description !== undefined ? { description: request.description } : {}),
            ...(request.customId !== undefined ? { custom_id: request.customId } : {}),
            ...(request.invoiceId !== undefined ? { invoice_id: request.invoiceId } : {}),
          },
        ],
      };
      this.#recordSubmittedKey(ctx.idempotencyKey, body);
      // INV-X01: a transport failure mid-create is OUTCOME_UNKNOWN — the
      // provider effect MAY have landed. Never FAILED.
      try {
        const order = (await this.#providerPost(
          "/v2/checkout/orders",
          body,
          ctx.idempotencyKey,
        )) as PayPalOrderProviderObject;
        this.#requireOrderId(order);
        return this.#sdkResult(
          paypalOrderEnvelope(order, observedAt),
          `paypal-direct:create-order:${order.id}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "checkout_order",
            externalId: "order_not_yet_created",
            operation: "create_order",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    if (request.kind === "create_payout") {
      const submission = await this.#submitPayoutCore(ctx, request);
      return submission.result;
    }
    throw new ValidationError(
      `paypal-direct create supports create_order/create_payout — got kind '${request.kind}'`,
    );
  }

  async update(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "update");
    const request = this.#request(ctx, "capture_order");
    const observedAt = this.#envelopeContext();
    switch (request.kind) {
      case "capture_order": {
        try {
          const order = (await this.#providerPost(
            `/v2/checkout/orders/${encodeURIComponent(request.orderId)}/capture`,
            {},
            ctx.idempotencyKey,
          )) as PayPalOrderProviderObject;
          this.#requireOrderId(order);
          return this.#sdkResult(
            paypalOrderEnvelope(order, observedAt),
            `paypal-direct:capture-order:${request.orderId}`,
          );
        } catch (error) {
          return this.#effectfulErrorResult(error, {
            objectType: "checkout_order",
            externalId: request.orderId,
            operation: "capture_order",
            idempotencyKey: ctx.idempotencyKey,
            observedAt: observedAt.observedAt,
          });
        }
      }
      case "authorize_order": {
        try {
          const order = (await this.#providerPost(
            `/v2/checkout/orders/${encodeURIComponent(request.orderId)}/authorize`,
            {},
            ctx.idempotencyKey,
          )) as PayPalOrderProviderObject;
          this.#requireOrderId(order);
          return this.#sdkResult(
            paypalOrderEnvelope(order, observedAt),
            `paypal-direct:authorize-order:${request.orderId}`,
          );
        } catch (error) {
          return this.#effectfulErrorResult(error, {
            objectType: "checkout_order",
            externalId: request.orderId,
            operation: "authorize_order",
            idempotencyKey: ctx.idempotencyKey,
            observedAt: observedAt.observedAt,
          });
        }
      }
      case "capture_authorization": {
        const body: Record<string, unknown> = {};
        if (request.amountMinor !== undefined) {
          // The authorization amount carries the currency; the connector
          // re-reads it losslessly below via the provider answer.
          body.amount = { value: request.amountMinor };
        }
        try {
          const capture = (await this.#providerPost(
            `/v2/payments/authorizations/${encodeURIComponent(request.authorizationId)}/capture`,
            body,
            ctx.idempotencyKey,
          )) as PayPalCaptureProviderObject;
          return this.#sdkResult(
            paypalCaptureEnvelope(capture, observedAt),
            `paypal-direct:capture-authorization:${request.authorizationId}`,
          );
        } catch (error) {
          return this.#effectfulErrorResult(error, {
            objectType: "authorization",
            externalId: request.authorizationId,
            operation: "capture_authorization",
            idempotencyKey: ctx.idempotencyKey,
            observedAt: observedAt.observedAt,
          });
        }
      }
      case "void_authorization": {
        try {
          const voided = await this.#providerVoidAuthorization(
            request.authorizationId,
            ctx.idempotencyKey,
          );
          return this.#sdkResult(
            voided,
            `paypal-direct:void-authorization:${request.authorizationId}`,
          );
        } catch (error) {
          return this.#effectfulErrorResult(error, {
            objectType: "authorization",
            externalId: request.authorizationId,
            operation: "void_authorization",
            idempotencyKey: ctx.idempotencyKey,
            observedAt: observedAt.observedAt,
          });
        }
      }
      case "reauthorize_authorization": {
        try {
          const authorization = (await this.#providerPost(
            `/v2/payments/authorizations/${encodeURIComponent(request.authorizationId)}/reauthorize`,
            {},
            ctx.idempotencyKey,
          )) as PayPalAuthorizationProviderObject;
          return this.#sdkResult(
            paypalAuthorizationEnvelope(authorization, observedAt),
            `paypal-direct:reauthorize-authorization:${request.authorizationId}`,
          );
        } catch (error) {
          return this.#effectfulErrorResult(error, {
            objectType: "authorization",
            externalId: request.authorizationId,
            operation: "reauthorize_authorization",
            idempotencyKey: ctx.idempotencyKey,
            observedAt: observedAt.observedAt,
          });
        }
      }
      default:
        throw new ValidationError(
          `paypal-direct update supports capture_order/authorize_order/capture_authorization/void_authorization/reauthorize_authorization — got kind '${request.kind}'`,
        );
    }
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "refund_capture");
    const observedAt = this.#envelopeContext();
    if (request.kind !== "refund_capture") {
      throw new ValidationError(
        `paypal-direct executeAction supports refund_capture — got kind '${request.kind}'`,
      );
    }
    if (request.captureId === undefined) {
      throw new ValidationError("refund_capture requires captureId");
    }
    const body: Record<string, unknown> = {};
    if (request.amountMinor !== undefined) {
      // The capture's currency is the refund currency (provider rule); the
      // minor-units value is preserved exactly and the provider answer
      // carries the authoritative currency_code.
      body.amount = { value: request.amountMinor };
    }
    if (request.noteToPayer !== undefined) {
      body.note_to_payer = request.noteToPayer;
    }
    this.#recordSubmittedKey(ctx.idempotencyKey, body);
    try {
      const refund = (await this.#providerPost(
        `/v2/payments/captures/${encodeURIComponent(request.captureId)}/refund`,
        body,
        ctx.idempotencyKey,
      )) as PayPalRefundProviderObject;
      return this.#sdkResult(
        paypalRefundEnvelope(refund, observedAt),
        `paypal-direct:refund-capture:${refund.id}`,
      );
    } catch (error) {
      return this.#effectfulErrorResult(error, {
        objectType: "refund",
        externalId: request.captureId,
        operation: "refund_capture",
        idempotencyKey: ctx.idempotencyKey,
        observedAt: observedAt.observedAt,
      });
    }
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "paypal-direct event subscription is handled by the webhook verification framework (PayPalWebhookVerifier + createPayPalWebhookIngestor + @payswap/adapters ProviderWebhookIngestor), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "reconcile_order");
    switch (request.kind) {
      // Reconciliation-as-authority (INV-X03): re-fetch by external object id.
      case "reconcile_order":
      case "reconcile_authorization":
      case "reconcile_capture":
      case "reconcile_refund":
      case "reconcile_payout_batch":
      case "reconcile_payout_item":
      case "read_order":
      case "read_authorization":
      case "read_capture":
      case "read_refund":
      case "read_payout_batch":
      case "read_payout_item":
        return this.read(ctx);
      default:
        throw new ValidationError(
          `paypal-direct reconcile supports reconcile_* (re-fetch by external object id — INV-X03) — got kind '${request.kind}'`,
        );
    }
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "paypal-direct disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and release the sealed credential handle); the provider surface offers no self-disconnect",
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md, PayPal Direct path —
   * swap-reference-then-verify): the vault binding for the control-plane
   * config key is swapped to a NEW reference at the vault; the connector
   * re-resolves per call, so the rotation is real exactly when the NEW
   * reference resolves and serves a successful token acquisition. The old
   * credential is revoked at PayPal only after that verification.
   */
  async rotateCredentials(ctx: SdkCallContext): Promise<CredentialRotationResult> {
    this.requireAuthority(ctx, "credential_rotation");
    if (this.#controlPlane !== undefined) {
      const handle = this.#controlPlane.broker.resolveProviderCredential(
        this.#credentialConfigKey,
      );
      const current = handle.descriptor.vaultReference;
      this.#controlPlane.broker.releaseSealedHandle(handle);
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
          evidenceId: `paypal-direct:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: PAYPAL_DIRECT_PROVIDER_NAME,
            providerVersion: PAYPAL_DIRECT_API_VERSION,
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
        "cannot rotate credentials: no credential path is provisioned for the paypal-direct rail (packages/rails/BLOCKED-RAILS.md)",
        { railId: PAYPAL_DIRECT_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = this.#materialFingerprint(envMaterial);
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
        evidenceId: `paypal-direct:cred-rotation:${rotatedAt}`,
        evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
        kind: "AUDIT_LOG",
        providerState: railEnvelope({
          providerName: PAYPAL_DIRECT_PROVIDER_NAME,
          providerVersion: PAYPAL_DIRECT_API_VERSION,
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
   * never a business outcome. Without credentials: endpoint reachability via
   * an unauthenticated GET (any HTTP answer proves reachability) → DEGRADED
   * with reasons; transport failure → UNKNOWN. With credentials: a REAL
   * OAuth2 client-credentials token acquisition → HEALTHY.
   */
  async health(): Promise<ConnectorHealthReport> {
    const resolution = this.credentialResolutionState();
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: PAYPAL_DIRECT_CONNECTOR_ID,
      providerName: PAYPAL_DIRECT_PROVIDER_NAME,
      providerVersion: PAYPAL_DIRECT_API_VERSION,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (resolution.kind === "NOT_PROVISIONED") {
      let endpointAnswered: boolean;
      try {
        await this.#http(`${this.#apiBase}/v2/checkout/orders`, {
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
      await this.#acquireTokenResponse();
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

  // -- dedicated observation methods --------------------------------------------

  /**
   * OBSERVED account capability scope — the live OAuth2 token acquisition's
   * app id and the scope string the provider ACTUALLY granted (observed,
   * not assumed: a subset of the requested scopes is legal). Fails closed
   * without credentials.
   */
  async accountScope(): Promise<PayPalDirectAccountCapabilityScope> {
    const tokenResponse = await this.#acquireTokenResponse();
    return paypalDirectAccountScope(tokenResponse, isoTimestamp(this.#clock.now()));
  }

  /**
   * A PayPalWebhookVerifier wired to THIS connector's credential path and
   * transport: webhook verification is an authenticated provider call
   * (POST /v1/notifications/verify-webhook-signature).
   */
  webhookVerifier(deps: {
    readonly webhookId: string;
    readonly toleranceSeconds?: number;
    readonly futureSkewSeconds?: number;
  }): PayPalWebhookVerifier {
    return new PayPalWebhookVerifier({
      http: this.#http,
      apiBase: this.#apiBase,
      clock: this.#clock,
      webhookId: deps.webhookId,
      acquireToken: () => this.#acquireToken(),
      ...(deps.toleranceSeconds !== undefined ? { toleranceSeconds: deps.toleranceSeconds } : {}),
      ...(deps.futureSkewSeconds !== undefined ? { futureSkewSeconds: deps.futureSkewSeconds } : {}),
    });
  }

  // -- global payout controls (the generic transfer-out surface) ---------------

  /**
   * Submits a payout batch under the GLOBAL PAYOUT CONTROLS:
   * 1. the destination of every item is EXTERNAL and EXPLICIT
   *    (EMAIL/PAYPAL_ID recipient — PayPalPayoutDestinationError otherwise);
   * 2. transfer-out authority is SEPARATE: the P2-W1-001
   *    `assertTransferOutAuthorized` gate runs on the supplied
   *    ConnectedInstanceActivation for EVERY item (currency + amount) —
   *    connection scope alone never authorizes debit;
   * 3. item states are observed as ExternalFundsPositionObservation ONLY
   *    (INV-C09 — external funds in motion, never custody).
   */
  async submitPayout(
    ctx: SdkCallContext,
    input: {
      readonly items: readonly PayPalDirectPayoutItemInput[];
      readonly transferOut: ConnectedInstanceActivation;
      readonly emailSubject?: string;
      readonly emailMessage?: string;
      /** Observation location accountRef override (defaults to the control-plane descriptor accountRef, honestly unobserved otherwise). */
      readonly accountRef?: string;
    },
  ): Promise<PayPalDirectPayoutSubmission> {
    this.requireAuthority(ctx, "create");
    return this.#submitPayoutCore(ctx, {
      kind: "create_payout",
      items: input.items,
      transferOut: input.transferOut,
      ...(input.emailSubject !== undefined ? { emailSubject: input.emailSubject } : {}),
      ...(input.emailMessage !== undefined ? { emailMessage: input.emailMessage } : {}),
    });
  }

  async #submitPayoutCore(
    ctx: SdkCallContext,
    request: Extract<PayPalDirectSdkRequest, { readonly kind: "create_payout" }> & {
      readonly accountRef?: string;
    },
  ): Promise<PayPalDirectPayoutSubmission> {
    if (request.items === undefined || request.items.length === 0) {
      throw new ValidationError("create_payout requires at least one payout item");
    }
    if (request.transferOut === undefined) {
      throw new ValidationError(
        "create_payout requires the transferOut ConnectedInstanceActivation — connection scope alone never authorizes debit (P2-W1-001 control plane)",
      );
    }
    const observedAt = this.#envelopeContext();
    // 1. Destination law: EXTERNAL + EXPLICIT, item by item, BEFORE any
    //    provider call and BEFORE the money/authorization gates (destination
    //    shape errors are neither exactness nor authorization errors).
    for (const item of request.items) {
      if (item === null || typeof item !== "object") {
        throw new ValidationError("every payout item must be a PayPalDirectPayoutItemInput");
      }
      if (item.destination === null || typeof item.destination !== "object") {
        throw new PayPalPayoutDestinationError(
          "every payout item requires an explicit EXTERNAL destination (destinationKind: 'EXTERNAL', recipientType EMAIL/PAYPAL_ID, receiver)",
        );
      }
      if (item.destination.destinationKind !== "EXTERNAL") {
        throw new PayPalPayoutDestinationError(
          `the payout destination kind must be 'EXTERNAL' — got '${String(item.destination.destinationKind)}' (a payout destination is never internal or implicit)`,
        );
      }
      if (item.destination.recipientType !== "EMAIL" && item.destination.recipientType !== "PAYPAL_ID") {
        throw new PayPalPayoutDestinationError(
          `the payout recipientType must be 'EMAIL' or 'PAYPAL_ID' — got '${String(item.destination.recipientType)}'`,
        );
      }
      if (typeof item.destination.receiver !== "string" || item.destination.receiver.length === 0) {
        throw new PayPalPayoutDestinationError(
          "the payout destination requires a non-empty explicit receiver (the external recipient)",
        );
      }
    }
    // 2. Exact money: minor units → provider decimal strings (fail-closed on
    //    uncertified currencies and malformed amounts) — BEFORE the
    //    authorization gate so shape/exactness errors are never misread as
    //    authorization errors.
    const validatedItems = request.items.map((item) => {
      if (typeof item.amountMinor !== "string" || !/^\d+$/.test(item.amountMinor)) {
        throw new ValidationError("every payout item requires amountMinor as an exact integer minor-units string (INV-F01)");
      }
      if (typeof item.currency !== "string" || item.currency.length !== 3) {
        throw new ValidationError("every payout item requires a 3-letter currency");
      }
      return {
        item,
        providerValue: minorUnitsToPayPalValue(item.amountMinor, item.currency),
      };
    });
    // 3. Transfer-out scoping: the SEPARATE control-plane authorization, per
    //    item (currency + exact amount), BEFORE any provider call.
    const nowIso = isoTimestamp(this.#clock.now());
    for (const { item } of validatedItems) {
      const amountMinorNumber = Number(item.amountMinor);
      if (!Number.isSafeInteger(amountMinorNumber)) {
        throw new ValidationError(
          `payout item amount ${item.amountMinor} exceeds the safe transfer-out limit-check range (INV-F01)`,
        );
      }
      assertTransferOutAuthorized(request.transferOut, nowIso, {
        currency: item.currency.toUpperCase(),
        amountMinor: amountMinorNumber,
      });
    }
    // 4. Build the provider body with the pre-validated exact values.
    const providerItems = validatedItems.map(({ item, providerValue }) => ({
      recipient_type: item.destination.recipientType,
      amount: {
        currency_code: item.currency.toUpperCase(),
        value: providerValue,
      },
      receiver: item.destination.receiver,
      ...(item.note !== undefined ? { note: item.note } : {}),
      sender_item_id: item.senderItemId,
    }));
    const body = {
      sender_batch_header: {
        sender_batch_id: paypalSenderBatchId(ctx.idempotencyKey),
        ...(request.emailSubject !== undefined ? { email_subject: request.emailSubject } : {}),
        ...(request.emailMessage !== undefined ? { email_message: request.emailMessage } : {}),
      },
      items: providerItems,
    };
    this.#recordSubmittedKey(ctx.idempotencyKey, body);
    // 5. Provider call; mid-effect transport failure → OUTCOME_UNKNOWN (INV-X01).
    let batch: PayPalPayoutBatchProviderObject;
    try {
      batch = (await this.#providerPost(
        "/v1/payments/payouts",
        body,
        ctx.idempotencyKey,
      )) as PayPalPayoutBatchProviderObject;
    } catch (error) {
      if (error instanceof RailTransportError) {
        return {
          result: this.#outcomeUnknownResult({
            objectType: "payout_batch",
            externalId: `sender-batch:${paypalSenderBatchId(ctx.idempotencyKey)}`,
            operation: "create_payout",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          }),
          observations: Object.freeze([]),
        };
      }
      throw error;
    }
    const envelope = paypalPayoutBatchEnvelope(batch, observedAt);
    const accountRef =
      request.accountRef ?? this.#controlPlaneAccountRef() ?? "paypal-direct:account-unobserved";
    const observations = paypalPayoutItemObservations({
      batch,
      accountRef,
      observedAt: observedAt.observedAt,
    });
    return {
      result: this.#sdkResult(
        envelope,
        `paypal-direct:create-payout:${batch.batch_header?.payout_batch_id ?? "unknown_batch"}`,
      ),
      observations,
    };
  }

  // -- internals -------------------------------------------------------------------

  #envelopeContext(): PayPalEnvelopeContext {
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

  /** HMAC fingerprint of the env material — the material itself is never stored. */
  #materialFingerprint(material: string): string {
    return createHmac("sha256", "payswap-paypal-direct-rotation-baseline")
      .update(material)
      .digest("hex");
  }

  /** The control-plane descriptor's accountRef (a reference, not material), or undefined. */
  #controlPlaneAccountRef(): string | undefined {
    if (this.#controlPlane === undefined) {
      return undefined;
    }
    try {
      const handle = this.#controlPlane.broker.resolveProviderCredential(
        this.#credentialConfigKey,
      );
      const accountRef = handle.descriptor.accountRef;
      this.#controlPlane.broker.releaseSealedHandle(handle);
      return accountRef;
    } catch {
      return undefined;
    }
  }

  /**
   * Local idempotency registry (INV-F05): the canonical request body hash is
   * recorded under the protocol key; a DIFFERENT body under the SAME key is
   * an error state (never a silent success), refused BEFORE any provider call.
   */
  #recordSubmittedKey(protocolKey: string, body: unknown): void {
    const canonical = JSON.stringify(body);
    const hash = createHmac("sha256", "payswap-paypal-direct-idempotency")
      .update(canonical)
      .digest("hex");
    const previous = this.#submittedKeys.get(protocolKey);
    if (previous !== undefined && previous !== hash) {
      throw new PayPalIdempotencyConflictError(
        `paypal-direct idempotency conflict: protocol key '${protocolKey}' was already submitted with a different request body — the new submission is refused (never a silent success)`,
        { protocolKey },
      );
    }
    this.#submittedKeys.set(protocolKey, hash);
  }

  /**
   * The OAuth2 client-credentials token acquisition (POST /v1/oauth2/token).
   * The client_id/client_secret travel ONLY in the Basic Authorization header
   * of this single provider call — never in envelopes, logs or evidence.
   * Cached until the provider-declared expiry minus the safety margin.
   */
  async #acquireTokenResponse(): Promise<PayPalTokenProviderObject> {
    const cached = this.#tokenCache;
    if (cached !== undefined && this.#clock.now() < cached.expiresAtMs) {
      return cached.response;
    }
    const material = await this.#resolveMaterial();
    const basic = Buffer.from(`${material.clientId}:${material.clientSecret}`, "utf8").toString(
      "base64",
    );
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("paypal provider transport unreachable (oauth2 token)", {
        path: "/v1/oauth2/token",
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("paypal oauth2 token response is not JSON", {
        path: "/v1/oauth2/token",
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const tokenResponse = parsed as PayPalTokenProviderObject;
    if (
      response.status < 200 ||
      response.status >= 300 ||
      typeof tokenResponse.access_token !== "string" ||
      tokenResponse.access_token.length === 0
    ) {
      const error = (parsed as { readonly error?: string; readonly error_description?: string }).error;
      throw new RailProviderError(
        `paypal oauth2 token acquisition failed (HTTP ${response.status})${error !== undefined ? `: ${error}` : ""}`,
        {
          path: "/v1/oauth2/token",
          httpStatus: response.status,
          ...(error !== undefined ? { providerErrorType: error } : {}),
        },
      );
    }
    if (
      typeof tokenResponse.expires_in === "number" &&
      Number.isFinite(tokenResponse.expires_in) &&
      tokenResponse.expires_in > 0
    ) {
      this.#tokenCache = {
        response: tokenResponse,
        expiresAtMs: this.#clock.now() + BigInt(Math.floor(tokenResponse.expires_in * 1000)) -
          BigInt(this.#tokenExpiryMarginMs),
      };
    }
    return tokenResponse;
  }

  async #acquireToken(): Promise<string> {
    const response = await this.#acquireTokenResponse();
    return response.access_token as string;
  }

  /**
   * Resolves the client-credentials material. The control plane opens the
   * SEALED bundle per call (material exists only inside the callback frame);
   * the env fallback parses the resolved material directly. With neither, the
   * operation fails closed BEFORE any provider call (INV-NC04).
   */
  async #resolveMaterial(): Promise<PayPalDirectCredentialMaterial> {
    if (this.#controlPlane !== undefined) {
      let handle: ReturnType<CredentialBroker["resolveProviderCredential"]>;
      try {
        handle = this.#controlPlane.broker.resolveProviderCredential(
          this.#credentialConfigKey,
        );
      } catch (error) {
        throw new RailNotAuthorizedError(
          "paypal-direct rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: PAYPAL_DIRECT_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => extractPayPalCredentialMaterial(opened.material),
      );
    }
    const material = this.#envMaterial();
    if (material === undefined) {
      throw new RailNotAuthorizedError(
        "paypal-direct rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md)",
        { railId: PAYPAL_DIRECT_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    return extractPayPalCredentialMaterial(material);
  }

  #request(ctx: SdkCallContext, expectedKind: string): PayPalDirectSdkRequest {
    const candidate = ctx.request;
    if (!isPayPalDirectSdkRequest(candidate)) {
      throw new ValidationError(
        `paypal-direct rail call request must be a PayPalDirectSdkRequest object (expected kind '${expectedKind}')`,
      );
    }
    if (
      "amountMinor" in candidate &&
      candidate.amountMinor !== undefined &&
      !/^\d+$/.test(String(candidate.amountMinor))
    ) {
      throw new ValidationError("amountMinor must be an exact integer minor-units string (INV-F01)");
    }
    return candidate;
  }

  #requireOrderId(order: PayPalOrderProviderObject): void {
    if (typeof order.id !== "string" || order.id.length === 0) {
      throw new RailProviderError(
        "paypal order response is malformed (missing id)",
      );
    }
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
      providerName: PAYPAL_DIRECT_PROVIDER_NAME,
      providerVersion: PAYPAL_DIRECT_API_VERSION,
      objectType: input.objectType,
      externalId: input.externalId,
      revision: `outcome-unknown:${input.operation}:${input.idempotencyKey}`,
      state: Object.freeze({
        outcomeUnknown: true,
        operation: input.operation,
        externalId: input.externalId,
        idempotencyKey: input.idempotencyKey,
        transportError: input.transportError,
        note: "transport failed mid-effect — the provider effect may have landed; reconcile by external id (INV-X01/INV-X03); never coerced to FAILED",
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
      shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
    });
    return this.#sdkResult(
      envelope,
      `paypal-direct:outcome-unknown:${input.operation}:${input.idempotencyKey}`,
    );
  }

  /** Effectful-op error handling: transport → OUTCOME_UNKNOWN; everything else propagates. */
  #effectfulErrorResult(
    error: unknown,
    input: {
      readonly objectType: string;
      readonly externalId: string;
      readonly operation: string;
      readonly idempotencyKey: string;
      readonly observedAt: string;
    },
  ): SdkCallResult {
    if (error instanceof RailTransportError) {
      return this.#outcomeUnknownResult({
        objectType: input.objectType,
        externalId: input.externalId,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        transportError: error.message,
        observedAt: input.observedAt,
      });
    }
    throw error;
  }

  /**
   * POST /v2/payments/authorizations/{id}/void: the provider answers HTTP 204
   * No Content (documented contract — no response body). The envelope records
   * the documented VOIDED semantic with the 204 answer preserved verbatim in
   * the state; the raw provider contract is cited, not fabricated.
   */
  async #providerVoidAuthorization(
    authorizationId: string,
    idempotencyKey: string,
  ): Promise<ProviderStateEnvelope> {
    let response: { readonly status: number; readonly bodyText: string };
    const path = `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`;
    const token = await this.#acquireToken();
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": paypalRequestId(idempotencyKey),
        },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("paypal provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status === 204 || (response.status === 200 && response.bodyText.trim() === "")) {
      const observedAt = isoTimestamp(this.#clock.now());
      return railEnvelope({
        providerName: PAYPAL_DIRECT_PROVIDER_NAME,
        providerVersion: PAYPAL_DIRECT_API_VERSION,
        objectType: "authorization",
        externalId: authorizationId,
        revision: `${authorizationId}:VOIDED:204`,
        state: Object.freeze({
          id: authorizationId,
          status: "VOIDED",
          httpStatus: 204,
          note: "provider answered 204 No Content per the documented void contract (no response body)",
        }),
        family: "other",
        lifecycleStep: "VOIDED",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "authorization_voided",
          retryable: false,
          ambiguity: "NONE",
        },
        observedAt,
        provenanceSource: "PROVIDER_API",
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    }
    const parsed = this.#parseResponse(response, path, idempotencyKey);
    return paypalAuthorizationEnvelope(parsed as PayPalAuthorizationProviderObject, {
      observedAt: isoTimestamp(this.#clock.now()),
      provenanceSource: "PROVIDER_API",
    });
  }

  async #providerGet(path: string, callRef: string): Promise<unknown> {
    const token = await this.#acquireToken();
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("paypal provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return this.#parseResponse(response, path, callRef);
  }

  async #providerPost(path: string, body: unknown, idempotencyKey: string): Promise<unknown> {
    const token = await this.#acquireToken();
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": paypalRequestId(idempotencyKey),
        },
        body: JSON.stringify(body),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("paypal provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return this.#parseResponse(response, path, idempotencyKey);
  }

  #parseResponse(
    response: { readonly status: number; readonly bodyText: string },
    path: string,
    callRef: string,
  ): unknown {
    if (response.status === 204) {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("paypal provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const error = (parsed as {
      readonly name?: string;
      readonly message?: string;
      readonly debug_id?: string;
      readonly details?: readonly unknown[];
    }).name;
    if (error !== undefined && error !== null && typeof error === "string") {
      const message = (parsed as { readonly message?: string }).message;
      // Duplicate-submit answers are ERROR states — never silent success.
      const messageText = message ?? "";
      if (
        error === "DUPLICATE_REQUEST" ||
        (path.startsWith("/v1/payments/payouts") && /duplicate/i.test(messageText))
      ) {
        throw new PayPalDuplicateSubmitError(
          `paypal duplicate submit: the request was NOT executed as a new object (provider answer: ${error}${messageText.length > 0 ? ` — ${messageText}` : ""})`,
          { path, idempotencyKey: callRef, providerErrorName: error },
        );
      }
      throw new RailProviderError(
        `paypal provider answered HTTP ${response.status}: ${message ?? error}`,
        {
          path,
          httpStatus: response.status,
          providerErrorName: error,
          ...(message !== undefined ? { providerErrorMessage: message } : {}),
          ...((parsed as { readonly debug_id?: string }).debug_id !== undefined
            ? { providerDebugId: (parsed as { readonly debug_id?: string }).debug_id as string }
            : {}),
        },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(`paypal provider answered HTTP ${response.status}`, {
        path,
        httpStatus: response.status,
      });
    }
    return parsed;
  }
}
