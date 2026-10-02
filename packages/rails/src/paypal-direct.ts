/**
 * PayPal Direct production connector (P2-W1-002) — the REAL PayPal adapter on
 * the v1.5 capability hierarchy and ProviderStateEnvelope.
 *
 * Authority: spec/phase-2/work-items/P2-W1-002.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md. Same framework and
 * fail-closed laws as the Stripe (`src/stripe.ts`, P2-W2-001) and Paystack
 * (`src/paystack.ts`, P2-W3-001) production connectors — NO PayPal SDK, no
 * ambient fetch in unit-testable paths, no provider SDK types anywhere.
 *
 * LAWS implemented here:
 * - INV-C06 (lossless): every provider object (order, authorization, capture,
 *   refund, payout batch, payout item, webhook event) is carried VERBATIM in
 *   the envelope `state` with an ADDITIVE classification. PayPal statuses are
 *   never renamed, never dropped; UNKNOWN provider statuses stay
 *   `other`/verbatim — never FAILED, never SUCCESS.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (requires
 *   reconciliation) — NEVER collapsed to FAILED. Reads propagate
 *   RailTransportError (no fabricated provider state); effects produce the
 *   OUTCOME_UNKNOWN envelope.
 * - INV-NC04 / FAIL-CLOSED: NO PayPal Direct credential exists in this
 *   deployment — availability UNKNOWN (INV-C01/C02), health DEGRADED/UNKNOWN
 *   with explicit reasons, every effectful operation throws
 *   RailNotAuthorizedError BEFORE any provider call. NO mock, NO simulated
 *   outcome, EVER. The honest reachability datum is recorded below (sandbox
 *   host probed 2026-10-02 → HTTP 401 on /v1/oauth2/token: endpoint
 *   reachable, authorization absent).
 * - Credential isolation (phase-2): the client/app credential PAIR
 *   (client_id + client_secret) and the webhook id are consumed through the
 *   P2-W1-001 control plane — `PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF` bound
 *   to `vault://payswap/providers/paypal-direct/sandbox-20261002` (currently
 *   ABSENT — no vault ref material exists), resolved through the
 *   CredentialBroker to a SEALED bundle opened only inside `withSealedBundle`
 *   with a ConnectorRuntimeKey. The material NEVER enters any envelope, log
 *   line or evidence record.
 * - INV-C09 (payouts are OBSERVATION ONLY): the PayPal Payouts API
 *   (POST /v1/payments/payouts) is DELIBERATELY NOT IMPLEMENTED as an
 *   executable operation — PaySwap never executes payouts on its own
 *   authority (non-custodial law). Batch/item reads map to
 *   ExternalFundsPositionObservation + payout-status observation envelopes.
 * - Eligibility is OBSERVED, never assumed: merchant/account country
 *   eligibility exists only as an observed PayPalAccountCapabilityScope from
 *   a connected instance; payer eligibility errors (COUNTRY_NOT_SUPPORTED /
 *   currency refusals) are carried VERBATIM as provider evidence.
 * - INV-F01: amounts are exact — the PaySwap surface speaks integer minor
 *   units; the PayPal REST surface speaks decimal strings
 *   (`amount.value`), converted losslessly at the documented currency
 *   exponent. Sub-minor precision is REFUSED, never rounded.
 * - INV-F05: PayPal Orders has NO universal idempotency-key header —
 *   duplicate protection is REFERENCE-BASED: purchase_units[0].reference_id
 *   and custom_id are derived deterministically from the protocol key, and
 *   duplicates are resolved by verification-by-query (GET the order).
 *
 * PAYPAL DIRECT ≠ STRIPE PAYPAL (structurally enforced below): Stripe's
 * `cap.rails.stripe.paypal_on_stripe` is a Stripe payment method (provider
 * `stripe`, funds settle in the Stripe balance); PayPal Direct is its OWN
 * provider (`paypal_direct`, OAuth2 client credentials, PayPal REST,
 * settlement at PayPal). Different credentials, different APIs, different
 * settlement — never conflated (see
 * {@link PAYPAL_DIRECT_VS_STRIPE_PAYPAL_DISTINCTION} and
 * {@link assertPayPalDirectNotConflatedWithStripePayPal}).
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
  SdkCallContext,
  SdkCallResult,
} from "@payswap/adapters";
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
// Identity (pinned — the observed API surface is part of the provider contract)
// ---------------------------------------------------------------------------

export const PAYPAL_DIRECT_PROVIDER_NAME = "paypal_direct" as const;
/**
 * The pinned PayPal REST API surface contract. PayPal publishes no global
 * API-version header for the Orders/Payments/Payouts surfaces (the API family
 * is versioned in the path: /v1, /v2); this pin records the OBSERVED surface
 * the connector speaks — Orders v2, Payments v2, Notifications v1 (webhook
 * verification), OAuth2 /v1/oauth2/token, Payouts v1 READ-ONLY.
 */
export const PAYPAL_DIRECT_API_VERSION = "rest-v2-2026-10-02" as const;
export const PAYPAL_DIRECT_RAIL_ADAPTER_ID = "rail.paypal-direct" as const;
export const PAYPAL_DIRECT_RAIL_IMPLEMENTATION_ID =
  "impl.rails.paypal-direct.2026-10-02" as const;
export const PAYPAL_DIRECT_CONNECTOR_ID = "connector.rails.paypal-direct" as const;
export const PAYPAL_DIRECT_DEFAULT_API_BASE_SANDBOX =
  "https://api-m.sandbox.paypal.com" as const;
export const PAYPAL_DIRECT_DEFAULT_API_BASE_LIVE = "https://api-m.paypal.com" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("paypal_direct")` —
 * `PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF`, intended to bind
 * `vault://payswap/providers/paypal-direct/sandbox-20261002` (ABSENT in this
 * deployment — see BLOCKED-RAILS.md §6).
 */
export const PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  PAYPAL_DIRECT_PROVIDER_NAME,
);

// ---------------------------------------------------------------------------
// PayPal Direct vs Stripe PayPal — the structural distinction
// ---------------------------------------------------------------------------

/**
 * The DISTINCTNESS CONTRACT between PayPal Direct and PayPal-on-Stripe,
 * encoded as data so any routing/selection surface can diff it:
 *
 * - `cap.rails.stripe.paypal_on_stripe` (provider `stripe`, defined in
 *   `src/stripe.ts`) is a STRIPE payment method: Stripe credentials, Stripe
 *   PaymentIntent lifecycle, funds settle in the Stripe balance.
 * - PayPal Direct (provider `paypal_direct`, this file) is its OWN provider:
 *   PayPal OAuth2 client/app credentials, PayPal Orders v2 lifecycle,
 *   settlement at PayPal (external funds, INV-C09).
 *
 * The two are NEVER interchangeable in routing: selecting one never implies
 * the other's credentials, scope, eligibility or settlement. The constant is
 * byte-scannable documentation; the runtime guards are
 * {@link isStripePayPalOnStripeCapabilityId} and
 * {@link assertPayPalDirectNotConflatedWithStripePayPal}.
 */
export const PAYPAL_DIRECT_VS_STRIPE_PAYPAL_DISTINCTION: Readonly<{
  readonly payPalDirectProvider: typeof PAYPAL_DIRECT_PROVIDER_NAME;
  readonly payPalDirectCapabilityFamily: "cap.rails.paypal-direct.*";
  readonly stripePayPalProvider: "stripe";
  readonly stripePayPalCapabilityId: "cap.rails.stripe.paypal_on_stripe";
  readonly distinction:
    "different provider, different credentials (PayPal client_id/client_secret vs Stripe API key), different API (PayPal REST vs Stripe v1), different settlement (PayPal vs Stripe balance) — never conflated";
}> = Object.freeze({
  payPalDirectProvider: PAYPAL_DIRECT_PROVIDER_NAME,
  payPalDirectCapabilityFamily: "cap.rails.paypal-direct.*",
  stripePayPalProvider: "stripe",
  stripePayPalCapabilityId: "cap.rails.stripe.paypal_on_stripe",
  distinction:
    "different provider, different credentials (PayPal client_id/client_secret vs Stripe API key), different API (PayPal REST vs Stripe v1), different settlement (PayPal vs Stripe balance) — never conflated",
});

/** The Stripe PayPal-on-Stripe capability id (the conflation hazard). */
export const STRIPE_PAYPAL_ON_STRIPE_CAPABILITY_ID_LITERAL =
  "cap.rails.stripe.paypal_on_stripe" as const;

/** Whether a capability id belongs to Stripe's PayPal-on-Stripe surface. */
export function isStripePayPalOnStripeCapabilityId(candidate: string): boolean {
  return candidate === STRIPE_PAYPAL_ON_STRIPE_CAPABILITY_ID_LITERAL;
}

/**
 * The anti-conflation GUARD: any capability id or provider name fed to the
 * PayPal Direct connector must NOT be Stripe's. Passing a Stripe PayPal
 * surface here is a category error (wrong credentials, wrong API, wrong
 * settlement) and fails closed with an explicit message.
 */
export function assertPayPalDirectNotConflatedWithStripePayPal(candidate: {
  readonly providerName?: string;
  readonly capabilityId?: string;
}): void {
  if (candidate.providerName === "stripe") {
    throw new ValidationError(
      "provider 'stripe' is the PayPal-on-Stripe provider, NOT PayPal Direct — different credentials, API and settlement (P2-W1-002 distinctness law; use the Stripe connector for cap.rails.stripe.paypal_on_stripe)",
      { providerName: candidate.providerName },
    );
  }
  if (
    candidate.capabilityId !== undefined &&
    (isStripePayPalOnStripeCapabilityId(candidate.capabilityId) ||
      candidate.capabilityId.startsWith("cap.rails.stripe."))
  ) {
    throw new ValidationError(
      `capability id '${candidate.capabilityId}' belongs to the Stripe connector (Stripe PayPal-on-Stripe is a Stripe payment method) — PayPal Direct capabilities are cap.rails.paypal-direct.* (P2-W1-002 distinctness law)`,
      { capabilityId: candidate.capabilityId },
    );
  }
}

// ---------------------------------------------------------------------------
// Capability definitions (consumed W2-003 vocabulary — never redefined)
// ---------------------------------------------------------------------------

export const PAYPAL_DIRECT_PAYMENT_ORDER_CAPABILITY_ID =
  "cap.rails.paypal-direct.payment_order" as const;
export const PAYPAL_DIRECT_CAPTURE_CAPABILITY_ID = "cap.rails.paypal-direct.capture" as const;
export const PAYPAL_DIRECT_AUTHORIZATION_CAPABILITY_ID =
  "cap.rails.paypal-direct.authorization" as const;
export const PAYPAL_DIRECT_REFUND_CAPABILITY_ID = "cap.rails.paypal-direct.refund" as const;
export const PAYPAL_DIRECT_WEBHOOK_CAPABILITY_ID = "cap.rails.paypal-direct.webhook" as const;
export const PAYPAL_DIRECT_PAYOUT_OBSERVATION_CAPABILITY_ID =
  "cap.rails.paypal-direct.payout_observation" as const;

/**
 * The provider-state vocabulary this connector maps (INV-C06): every PayPal
 * Orders v2 status with its additive classification. Exported as data so
 * certification/conformance surfaces can diff the mapping without reading
 * the implementation.
 *
 * | PayPal order status | family                     | isTerminal | requiresCustomerAction |
 * |---------------------|----------------------------|------------|------------------------|
 * | CREATED             | customer_action_required   | false      | true                   |
 * | SAVED               | customer_action_required   | false      | true                   |
 * | APPROVED            | capture                    | false      | false                  |
 * | COMPLETED           | other                      | true       | false                  |
 * | VOIDED              | other                      | true       | false                  |
 * | PAYER_ACTION_REQUIRED | customer_action_required | false      | true                   |
 * | (unknown)           | other                      | false      | false (verbatim step)  |
 */
export const PAYPAL_DIRECT_ORDER_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "CREATED", family: "customer_action_required", lifecycleStep: "created", isTerminal: false, requiresCustomerAction: true },
  { providerState: "SAVED", family: "customer_action_required", lifecycleStep: "saved", isTerminal: false, requiresCustomerAction: true },
  { providerState: "APPROVED", family: "capture", lifecycleStep: "approved", isTerminal: false, requiresCustomerAction: false },
  { providerState: "COMPLETED", family: "other", lifecycleStep: "completed", isTerminal: true, requiresCustomerAction: false },
  { providerState: "VOIDED", family: "other", lifecycleStep: "voided", isTerminal: true, requiresCustomerAction: false },
  { providerState: "PAYER_ACTION_REQUIRED", family: "customer_action_required", lifecycleStep: "payer_action_required", isTerminal: false, requiresCustomerAction: true },
]);

/** Payments v2 authorization statuses (VERBATIM, additive classification). */
export const PAYPAL_DIRECT_AUTHORIZATION_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "CREATED", family: "capture", lifecycleStep: "created", isTerminal: false, requiresCustomerAction: false },
  { providerState: "PENDING", family: "async_processing", lifecycleStep: "pending", isTerminal: false, requiresCustomerAction: false },
  { providerState: "CAPTURED", family: "other", lifecycleStep: "captured", isTerminal: true, requiresCustomerAction: false },
  { providerState: "VOIDED", family: "other", lifecycleStep: "voided", isTerminal: true, requiresCustomerAction: false },
]);

/** Payments v2 capture statuses (VERBATIM, additive classification). */
export const PAYPAL_DIRECT_CAPTURE_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "COMPLETED", family: "other", lifecycleStep: "completed", isTerminal: true, requiresCustomerAction: false },
  { providerState: "DECLINED", family: "other", lifecycleStep: "declined", isTerminal: true, requiresCustomerAction: false },
  { providerState: "REFUNDED", family: "other", lifecycleStep: "refunded", isTerminal: true, requiresCustomerAction: false },
  { providerState: "PARTIALLY_REFUNDED", family: "other", lifecycleStep: "partially_refunded", isTerminal: true, requiresCustomerAction: false },
]);

/**
 * Refund statuses (VERBATIM per the PayPal refunds surface):
 * CANCELLED | PENDING | COMPLETED, plus the verbatim catch-all.
 */
export const PAYPAL_DIRECT_REFUND_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "CANCELLED", family: "refund", lifecycleStep: "cancelled", isTerminal: true, requiresCustomerAction: false },
  { providerState: "PENDING", family: "refund", lifecycleStep: "pending", isTerminal: false, requiresCustomerAction: false },
  { providerState: "COMPLETED", family: "refund", lifecycleStep: "completed", isTerminal: true, requiresCustomerAction: false },
]);

/**
 * Payout ITEM statuses (VERBATIM per the PayPal Payouts v1 surface —
 * observation only, INV-C09):
 * UNCLAIMED, CLAIMED, PROCESSING, SUCCESS, FAILED, REVERSED, ONHOLD,
 * BLOCKED, RETURNED — plus the verbatim catch-all.
 */
export const PAYPAL_DIRECT_PAYOUT_ITEM_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "UNCLAIMED", family: "payout", lifecycleStep: "unclaimed", isTerminal: false, requiresCustomerAction: false },
  { providerState: "CLAIMED", family: "payout", lifecycleStep: "claimed", isTerminal: false, requiresCustomerAction: false },
  { providerState: "PROCESSING", family: "payout", lifecycleStep: "processing", isTerminal: false, requiresCustomerAction: false },
  { providerState: "SUCCESS", family: "payout", lifecycleStep: "success", isTerminal: true, requiresCustomerAction: false },
  { providerState: "FAILED", family: "payout", lifecycleStep: "failed", isTerminal: true, requiresCustomerAction: false },
  { providerState: "REVERSED", family: "payout", lifecycleStep: "reversed", isTerminal: true, requiresCustomerAction: false },
  { providerState: "ONHOLD", family: "payout", lifecycleStep: "onhold", isTerminal: false, requiresCustomerAction: false },
  { providerState: "BLOCKED", family: "payout", lifecycleStep: "blocked", isTerminal: true, requiresCustomerAction: false },
  { providerState: "RETURNED", family: "payout", lifecycleStep: "returned", isTerminal: true, requiresCustomerAction: false },
]);

/**
 * INV-C09 (non-custodial law): the PayPal Payouts CREATE surface
 * (POST /v1/payments/payouts) is DELIBERATELY NOT IMPLEMENTED. PaySwap never
 * executes payouts on its own authority; the Payouts API is consumed
 * READ-ONLY (GET /v1/payments/payouts/{batch_id} and
 * GET /v1/payments/payouts-item/{item_id}) as
 * ExternalFundsPositionObservation + payout-status observation envelopes.
 * This constant is the byte-scannable record of that decision.
 */
export const PAYPAL_DIRECT_PAYOUT_EXECUTION_DELIBERATELY_NOT_IMPLEMENTED: Readonly<{
  readonly provider: typeof PAYPAL_DIRECT_PROVIDER_NAME;
  readonly notImplemented: "POST /v1/payments/payouts";
  readonly implementedReadOnly: readonly ["GET /v1/payments/payouts/{batch_id}", "GET /v1/payments/payouts-item/{item_id}"];
  readonly reason:
    "INV-C09 — PaySwap is non-custodial and never executes payouts on its own authority; payouts are OBSERVED (ExternalFundsPositionObservation), never executed here";
}> = Object.freeze({
  provider: PAYPAL_DIRECT_PROVIDER_NAME,
  notImplemented: "POST /v1/payments/payouts",
  implementedReadOnly: Object.freeze([
    "GET /v1/payments/payouts/{batch_id}",
    "GET /v1/payments/payouts-item/{item_id}",
  ]) as readonly ["GET /v1/payments/payouts/{batch_id}", "GET /v1/payments/payouts-item/{item_id}"],
  reason:
    "INV-C09 — PaySwap is non-custodial and never executes payouts on its own authority; payouts are OBSERVED (ExternalFundsPositionObservation), never executed here",
});

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
    readonly financialEffect: "MOVES_VALUE" | "RESERVES_VALUE" | "NONE";
    readonly reversible: boolean;
  }[];
  readonly duplicateBehavior: "REJECTED" | "PROVIDER_DEFINED";
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
      "credential reference provisioned through the control plane (PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF)",
      "merchant/account country eligibility OBSERVED through a connected instance (never assumed — the provider is the authority)",
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
      duplicateBehavior: input.duplicateBehavior,
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
        { action: "create_order", description: "Create a PayPal order (POST /v2/checkout/orders)" },
        { action: "get_order", description: "Fetch an order by id (the reconciliation path)" },
        { action: "capture", description: "Capture an approved order or an authorization" },
        { action: "authorize", description: "Authorize an approved order" },
        { action: "void", description: "Void an order or an authorization" },
        { action: "refund", description: "Refund a capture (POST /v2/payments/captures/{id}/refund)" },
        { action: "verify_webhook", description: "Server-side webhook signature verification (POST /v1/notifications/verify-webhook-signature)" },
        { action: "observe_payout", description: "READ-ONLY payout batch/item observation (INV-C09)" },
      ],
      states: input.providerStates,
    },
    externalObjects: input.externalObjects.map((object) => ({
      objectType: object.objectType,
      idFormat: object.idFormat,
      revisioned: true,
      revisionFormat: "provider-update-time-etag",
    })),
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "PayPal settlement schedule (funds remain external — INV-C09)" },
    constraints: [
      {
        kind: "JURISDICTION",
        description:
          "merchant/account country eligibility is OBSERVED through a connected instance (payer eligibility errors like COUNTRY_NOT_SUPPORTED arrive verbatim as provider evidence); never assumed",
      },
      {
        kind: "COMMERCIAL",
        description:
          "PayPal Direct is its own provider (paypal_direct) — distinct from Stripe's PayPal-on-Stripe payment method (different credentials, API and settlement); the two are never conflated in routing",
      },
    ],
  });
}

/** The canonical capability definitions consumed by the PayPal Direct connector. */
export function paypalDirectCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return Object.freeze([
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_PAYMENT_ORDER_CAPABILITY_ID,
      summary: "PayPal Orders v2 lifecycle (create → payer approval → capture/authorize/void)",
      operation: "rails.paypal-direct.order.lifecycle",
      description:
        "POST /v2/checkout/orders {intent: CAPTURE|AUTHORIZE, purchase_units:[{reference_id, custom_id, amount:{currency_code, value}}]} → GET /v2/checkout/orders/{id}: order statuses stay VERBATIM (CREATED/SAVED/APPROVED/VOIDED/COMPLETED/PAYER_ACTION_REQUIRED); CREATED/SAVED/PAYER_ACTION_REQUIRED are customer-action-required (the payer must approve at the provider link), APPROVED is authorized-then-actionable, COMPLETED is captured/settled-external, VOIDED is cancelled; an UNKNOWN status is an UNKNOWN envelope — never FAILED",
      requiredPermissions: ["payments:write", "payments:read"],
      requiredScopes: ["payments:execute"],
      providerStates: PAYPAL_DIRECT_ORDER_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "order", idFormat: "[A-Z0-9]{5,30}" }],
      sideEffects: [
        { effect: "moves payer value on capture of the approved order", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      duplicateBehavior: "PROVIDER_DEFINED",
      requiredCustomerActions: [
        {
          lifecycleStep: "created",
          kind: "PROVIDER_CHALLENGE_REDIRECT",
          message: "Approve the payment at the PayPal approval link before the order can be captured",
        },
      ],
    }),
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_CAPTURE_CAPABILITY_ID,
      summary: "Capture of approved PayPal orders and authorizations",
      operation: "rails.paypal-direct.capture.execute",
      description:
        "POST /v2/checkout/orders/{id}/capture and POST /v2/payments/authorizations/{id}/capture: the captured funds settle at PayPal (external — INV-C09); capture statuses stay VERBATIM (COMPLETED/DECLINED/REFUNDED/PARTIALLY_REFUNDED); a mid-capture transport failure is OUTCOME_UNKNOWN, never FAILED",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: PAYPAL_DIRECT_CAPTURE_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "capture", idFormat: "[A-Z0-9]{5,30}" }],
      sideEffects: [
        { effect: "captures the approved amount (settles at PayPal)", financialEffect: "MOVES_VALUE", reversible: true },
      ],
      duplicateBehavior: "PROVIDER_DEFINED",
    }),
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_AUTHORIZATION_CAPABILITY_ID,
      summary: "PayPal payment authorizations (authorize → capture/void/reauthorize)",
      operation: "rails.paypal-direct.authorization.lifecycle",
      description:
        "POST /v2/checkout/orders/{id}/authorize → authorizations[0]; POST /v2/payments/authorizations/{id}/capture, /void, /reauthorize: authorization statuses stay VERBATIM (CREATED/PENDING/CAPTURED/VOIDED); an approved-then-actionable authorization is the capture family",
      requiredPermissions: ["payments:write", "payments:read"],
      requiredScopes: ["payments:execute"],
      providerStates: PAYPAL_DIRECT_AUTHORIZATION_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "authorization", idFormat: "[A-Z0-9]{5,30}" }],
      sideEffects: [
        { effect: "reserves the approved amount until captured or voided", financialEffect: "RESERVES_VALUE", reversible: true },
      ],
      duplicateBehavior: "PROVIDER_DEFINED",
    }),
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_REFUND_CAPABILITY_ID,
      summary: "Refunds of PayPal captures (POST /v2/payments/captures/{id}/refund)",
      operation: "rails.paypal-direct.refund.create",
      description:
        "Refund a capture (optionally partial, in exact minor units converted at the documented currency exponent): refund statuses stay VERBATIM (CANCELLED/PENDING/COMPLETED); dispute-class events (CUSTOMER.DISPUTE.*) map to the dispute family with the raw event carried verbatim",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: PAYPAL_DIRECT_REFUND_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "refund", idFormat: "[A-Z0-9]{5,30}" }],
      sideEffects: [
        { effect: "returns previously captured value to the payer", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      duplicateBehavior: "PROVIDER_DEFINED",
    }),
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_WEBHOOK_CAPABILITY_ID,
      summary: "PayPal webhook verification — SERVER-SIDE (POST /v1/notifications/verify-webhook-signature)",
      operation: "rails.paypal-direct.webhook.verify",
      description:
        "PayPal signs deliveries with the header set PAYPAL-AUTH-ALGO, PAYPAL-CERT-URL, PAYPAL-TRANSMISSION-ID, PAYPAL-TRANSMISSION-SIG, PAYPAL-TRANSMISSION-TIME; verification is SERVER-SIDE: the connector POSTs {auth_algo, cert_url, transmission_id, transmission_sig, transmission_time, webhook_id, webhook_event} to /v1/notifications/verify-webhook-signature and trusts ONLY the provider's verification_status (SUCCESS|FAILURE) — no local HMAC is fabricated; replay defense is the (provider, eventId) dedupe",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      providerStates: [
        { providerState: "VERIFIED", canonicalState: "other:verified", requiresCustomerAction: false, isTerminal: true },
        { providerState: "REJECTED", canonicalState: "other:rejected", requiresCustomerAction: false, isTerminal: true },
        { providerState: "DUPLICATE", canonicalState: "other:duplicate", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "webhook_event", idFormat: "WH-[A-Z0-9-]+" }],
      sideEffects: [],
      duplicateBehavior: "REJECTED",
    }),
    paypalDirectCapabilityDefinition({
      capabilityId: PAYPAL_DIRECT_PAYOUT_OBSERVATION_CAPABILITY_ID,
      summary: "Payout batch/item OBSERVATION (read-only — INV-C09; execution deliberately not implemented)",
      operation: "rails.paypal-direct.payout.observe",
      description:
        "READ-ONLY payout surfaces: GET /v1/payments/payouts/{batch_id} and GET /v1/payments/payouts-item/{item_id}. Payout item statuses stay VERBATIM (UNCLAIMED/CLAIMED/PROCESSING/SUCCESS/FAILED/REVERSED/ONHOLD/BLOCKED/RETURNED). Every item maps to an ExternalFundsPositionObservation — PaySwap never executes payouts (POST /v1/payments/payouts is deliberately not implemented; non-custodial law)",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      providerStates: PAYPAL_DIRECT_PAYOUT_ITEM_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "payout_batch", idFormat: "[A-Z0-9]{5,30}" },
        { objectType: "payout_item", idFormat: "[A-Z0-9]{5,30}" },
      ],
      sideEffects: [],
      duplicateBehavior: "REJECTED",
    }),
  ]);
}

/** The connector capability pack backing the PayPal Direct rail (payments family). */
export function paypalDirectRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.paypal-direct",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: paypalDirectCapabilityDefinitions().map((definition) => ({
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
    })),
    auth: {
      authKind: "OAUTH" as const,
      scopes: ["payments:write", "payments:read"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.paypal-direct.provider_state", version: "1.0.0" }],
    objectMappings: [
      {
        externalObjectType: "order",
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
      {
        externalObjectType: "webhook_event",
        canonicalObjectRef: "payswap:provider_event",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
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
      contentHash: "hash:rails-paypal-direct-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// The honest reachability datum (observed 2026-10-02 — no credential exists)
// ---------------------------------------------------------------------------

/**
 * The recorded PayPal Direct sandbox reachability datum: the sandbox host
 * answered HTTP 401 on POST /v1/oauth2/token WITHOUT credentials on
 * 2026-10-02 — the ENDPOINT is reachable, the AUTHORIZATION is absent.
 * Availability therefore stays UNKNOWN (INV-C01/C02: never success, never
 * failure) and every effectful operation fails closed (INV-NC04). This datum
 * is the honest evidence BLOCKED-RAILS.md §6 documents; it is a reachability
 * fact, NOT an authorization.
 */
export const PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002: Readonly<{
  readonly host: typeof PAYPAL_DIRECT_DEFAULT_API_BASE_SANDBOX;
  readonly endpoint: "/v1/oauth2/token";
  readonly probedAt: "2026-10-02T06:37:38Z";
  readonly httpStatus: 401;
  readonly verdict: "ENDPOINT_REACHABLE_AUTHORIZATION_ABSENT";
}> = Object.freeze({
  host: PAYPAL_DIRECT_DEFAULT_API_BASE_SANDBOX,
  endpoint: "/v1/oauth2/token",
  probedAt: "2026-10-02T06:37:38Z",
  httpStatus: 401,
  verdict: "ENDPOINT_REACHABLE_AUTHORIZATION_ABSENT",
});

/**
 * The OBSERVED account capability scope for a PayPal Direct connected
 * instance — shaped like StripeAccountCapabilityScope (`src/stripe.ts`) so
 * selection/routing surfaces treat the two identically. OBSERVED, never
 * assumed: it exists only when a connected instance produced it (a live
 * provider observation or an operator-recorded probe); a missing scope means
 * eligibility UNKNOWN.
 */
export interface PayPalAccountCapabilityScope {
  readonly payerId?: string;
  /** Account country as observed at PayPal (merchant/account eligibility axis). */
  readonly accountCountry?: string;
  readonly payerStatus?: string;
  readonly emailConfirmed?: boolean | null;
  /** Provider-declared capability statuses, verbatim (observed, not assumed). */
  readonly capabilities: Readonly<Record<string, string>>;
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "OPERATOR";
}

/** The merchant/account eligibility verdict for one country/currency. */
export interface PayPalDirectEligibility {
  readonly country?: string;
  readonly currency?: string;
  readonly eligible: boolean;
  /** "OBSERVED_ACCOUNT_SCOPE" | "UNKNOWN" (never assumed either way). */
  readonly basis: "OBSERVED_ACCOUNT_SCOPE" | "UNKNOWN";
  readonly reason: string;
}

/**
 * Merchant/account country eligibility against an OBSERVED account scope.
 * Eligibility comes ONLY from a connected-instance observation: when the
 * observed account country matches the requested country (or the scope
 * carries a positive provider-declared capability for the currency), the
 * verdict is OBSERVED_ACCOUNT_SCOPE; when NO scope is supplied the verdict is
 * UNKNOWN — never assumed eligible, never assumed ineligible (INV-NC04
 * honesty; the provider is the authority; payer-side refusals such as
 * COUNTRY_NOT_SUPPORTED arrive VERBATIM as provider errors, never fabricated
 * here).
 */
export function paypalDirectAccountEligibility(
  scope: PayPalAccountCapabilityScope | null | undefined,
  request: { readonly country?: string; readonly currency?: string },
): PayPalDirectEligibility {
  if (scope === null || scope === undefined) {
    return Object.freeze({
      ...(request.country !== undefined ? { country: request.country.toUpperCase() } : {}),
      ...(request.currency !== undefined ? { currency: request.currency.toUpperCase() } : {}),
      eligible: false,
      basis: "UNKNOWN",
      reason:
        "no connected-instance observation — merchant/account eligibility UNKNOWN, never assumed (INV-NC04; eligibility comes only from a connected instance observation)",
    });
  }
  if (
    request.country !== undefined &&
    scope.accountCountry !== undefined &&
    scope.accountCountry.toUpperCase() === request.country.toUpperCase()
  ) {
    return Object.freeze({
      country: request.country.toUpperCase(),
      ...(request.currency !== undefined ? { currency: request.currency.toUpperCase() } : {}),
      eligible: true,
      basis: "OBSERVED_ACCOUNT_SCOPE",
      reason: `account country ${scope.accountCountry} observed at PayPal on ${scope.observedAt} (${scope.provenanceSource})`,
    });
  }
  if (
    request.currency !== undefined &&
    scope.capabilities[`currency:${request.currency.toUpperCase()}`] === "ELIGIBLE"
  ) {
    return Object.freeze({
      ...(request.country !== undefined ? { country: request.country.toUpperCase() } : {}),
      currency: request.currency.toUpperCase(),
      eligible: true,
      basis: "OBSERVED_ACCOUNT_SCOPE",
      reason: `provider-declared capability currency:${request.currency.toUpperCase()}=ELIGIBLE observed on ${scope.observedAt}`,
    });
  }
  if (
    request.country !== undefined &&
    scope.accountCountry !== undefined &&
    scope.accountCountry.toUpperCase() !== request.country.toUpperCase()
  ) {
    return Object.freeze({
      country: request.country.toUpperCase(),
      ...(request.currency !== undefined ? { currency: request.currency.toUpperCase() } : {}),
      eligible: false,
      basis: "UNKNOWN",
      reason: `observed account country ${scope.accountCountry} does not match ${request.country.toUpperCase()} — the provider is the authority for cross-country eligibility; UNKNOWN, never assumed`,
    });
  }
  return Object.freeze({
    ...(request.country !== undefined ? { country: request.country.toUpperCase() } : {}),
    ...(request.currency !== undefined ? { currency: request.currency.toUpperCase() } : {}),
    eligible: false,
    basis: "UNKNOWN",
    reason: `the observed account scope (observed ${scope.observedAt}, ${scope.provenanceSource}) does not answer this country/currency — eligibility UNKNOWN, never assumed`,
  });
}

/**
 * Selection eligibility: PayPal Direct (and, symmetrically, Stripe PayPal) is
 * selectable ONLY when its OWN connected instance is eligible — the provider
 * name must be paypal_direct, the surface must NOT be Stripe's
 * PayPal-on-Stripe, and an OBSERVED account scope must exist. Never
 * conflated, never assumed.
 */
export function paypalDirectSelectionEligibility(input: {
  readonly providerName: string;
  readonly capabilityId?: string;
  readonly accountScope?: PayPalAccountCapabilityScope | null;
}): { readonly selectable: boolean; readonly reason: string } {
  assertPayPalDirectNotConflatedWithStripePayPal(input);
  if (input.providerName !== PAYPAL_DIRECT_PROVIDER_NAME) {
    return Object.freeze({
      selectable: false,
      reason: `provider '${input.providerName}' is not ${PAYPAL_DIRECT_PROVIDER_NAME} — this connector serves PayPal Direct only`,
    });
  }
  if (input.capabilityId !== undefined && !input.capabilityId.startsWith("cap.rails.paypal-direct.")) {
    return Object.freeze({
      selectable: false,
      reason: `capability '${input.capabilityId}' is not a PayPal Direct capability (cap.rails.paypal-direct.*)`,
    });
  }
  if (input.accountScope === null || input.accountScope === undefined) {
    return Object.freeze({
      selectable: false,
      reason:
        "no connected-instance account scope observed — PayPal Direct is selectable only when its connected instance is eligible (P2-W1-002 acceptance; never assumed)",
    });
  }
  return Object.freeze({
    selectable: true,
    reason: `connected instance observed at PayPal on ${input.accountScope.observedAt} (${input.accountScope.provenanceSource})`,
  });
}

// ---------------------------------------------------------------------------
// Minor-unit conversion (INV-F01 — exact bigint arithmetic, never floats)
// ---------------------------------------------------------------------------

/**
 * The minor-unit exponents for the PayPal REST currency surface (PayPal
 * quotes `amount.value` as a decimal string at the currency's documented
 * exponent): 0-decimal and 3-decimal currencies are listed explicitly,
 * everything else PayPal lists is 2-decimal. A currency outside this table
 * has an UNKNOWN exponent — conversion REFUSES (never guessed, INV-F01).
 */
export const PAYPAL_DIRECT_MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> =
  Object.freeze({
    // 2-decimal (the default family — listed for explicitness on majors)
    USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, CHF: 2, SGD: 2, HKD: 2,
    SEK: 2, NOK: 2, DKK: 2, PLN: 2, CZK: 2, HUF: 2, ILS: 2, MXN: 2, BRL: 2,
    MYR: 2, PHP: 2, THB: 2, TWD: 2, AED: 2, SAR: 2, QAR: 2, EGP: 2, MAD: 2,
    ZAR: 2, KES: 2, GHS: 2, NGN: 2, TZS: 2, UGX: 2, RWF: 2, ZMW: 2, MWK: 2,
    MZN: 2, ETB: 2, MUR: 2, INR: 2, IDR: 2, CNY: 2,
    // 0-decimal
    JPY: 0, KRW: 0, VND: 0, CLP: 0, XAF: 0, XOF: 0,
    // 3-decimal
    BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3, RSD: 3,
  });

/** The documented exponent for a PayPal-supported currency (or undefined). */
export function paypalDirectMinorUnitExponent(currency: string): number | undefined {
  return PAYPAL_DIRECT_MINOR_UNIT_EXPONENTS[currency.toUpperCase()];
}

/**
 * Exact minor-units (integer string) → PayPal decimal `value` string at the
 * currency's documented exponent. Lossless by construction: the minor-unit
 * integer is placed at the exponent (e.g. 10000 USD → "100.00"; 500 JPY →
 * "500"). REFUSES an unknown exponent (never guessed — INV-F01).
 */
export function paypalDirectDecimalValueFromMinorUnits(
  amountMinor: string,
  currency: string,
): string {
  if (!/^\d+$/.test(amountMinor)) {
    throw new ValidationError(
      "amountMinor must be an exact non-negative integer minor-units string (INV-F01)",
    );
  }
  const exponent = paypalDirectMinorUnitExponent(currency);
  if (exponent === undefined) {
    throw new ValidationError(
      `unknown minor-unit exponent for currency '${currency.toUpperCase()}' on the PayPal surface — never guessed (INV-F01; add the exponent when the provider documents it)`,
    );
  }
  if (exponent === 0) {
    return amountMinor;
  }
  const digits = amountMinor.padStart(exponent + 1, "0");
  return `${digits.slice(0, digits.length - exponent)}.${digits.slice(digits.length - exponent)}`;
}

/**
 * PayPal decimal `value` string → exact minor-units (integer string).
 * REFUSES sub-minor precision (a value carrying more decimals than the
 * currency's exponent cannot be represented in exact minor units — never
 * rounded, INV-F01) and unknown exponents.
 */
export function paypalDirectMinorUnitsFromDecimalValue(
  value: string,
  currency: string,
): string {
  const exponent = paypalDirectMinorUnitExponent(currency);
  if (exponent === undefined) {
    throw new ValidationError(
      `unknown minor-unit exponent for currency '${currency.toUpperCase()}' on the PayPal surface — never guessed (INV-F01)`,
    );
  }
  const { numerator, denominator } = exactRationalFromDecimal(value);
  const decimals = BigInt(denominator.toString().length - 1);
  const e = BigInt(exponent);
  if (e >= decimals) {
    return (numerator * 10n ** (e - decimals)).toString();
  }
  const factor = 10n ** (decimals - e);
  if (numerator % factor !== 0n) {
    throw new ValidationError(
      `PayPal amount '${value}' ${currency.toUpperCase()} carries sub-minor precision — cannot be represented in exact minor units (INV-F01; never rounded)`,
    );
  }
  return (numerator / factor).toString();
}

// ---------------------------------------------------------------------------
// Provider object shapes (opaque passthrough — never domain primitives)
// ---------------------------------------------------------------------------

/** The raw PayPal Orders v2 order object (opaque passthrough). */
export interface PaypalDirectOrderProviderObject {
  readonly id?: string;
  readonly status?: string;
  readonly intent?: string;
  readonly purchase_units?: readonly {
    readonly reference_id?: string;
    readonly custom_id?: string;
    readonly amount?: { readonly currency_code?: string; readonly value?: string };
    readonly payee?: { readonly email_address?: string; readonly merchant_id?: string };
    readonly payments?: {
      readonly authorizations?: readonly { readonly id?: string; readonly status?: string }[];
      readonly captures?: readonly { readonly id?: string; readonly status?: string }[];
      readonly refunds?: readonly { readonly id?: string; readonly status?: string }[];
    };
    readonly [key: string]: unknown;
  }[];
  readonly payer?: { readonly [key: string]: unknown };
  readonly links?: readonly {
    readonly href?: string;
    readonly rel?: string;
    readonly method?: string;
  }[];
  readonly create_time?: string;
  readonly update_time?: string;
  readonly [key: string]: unknown;
}

/** The raw PayPal Payments v2 authorization object (opaque passthrough). */
export interface PaypalDirectAuthorizationProviderObject {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: { readonly currency_code?: string; readonly value?: string };
  readonly create_time?: string;
  readonly update_time?: string;
  readonly [key: string]: unknown;
}

/** The raw PayPal Payments v2 capture object (opaque passthrough). */
export interface PaypalDirectCaptureProviderObject {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: { readonly currency_code?: string; readonly value?: string };
  readonly update_time?: string;
  readonly [key: string]: unknown;
}

/** The raw PayPal refund object (opaque passthrough). */
export interface PaypalDirectRefundProviderObject {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: { readonly currency_code?: string; readonly value?: string };
  readonly capture_id?: string;
  readonly note_to_payer?: string;
  readonly create_time?: string;
  readonly update_time?: string;
  readonly [key: string]: unknown;
}

/** The raw PayPal Payouts v1 batch object (READ surface only; opaque). */
export interface PaypalDirectPayoutBatchProviderObject {
  readonly batch_header?: {
    readonly payout_batch_id?: string;
    readonly batch_status?: string;
    readonly amount?: { readonly currency?: string; readonly value?: string };
    readonly fees?: { readonly currency?: string; readonly value?: string };
    readonly update_time?: string;
    readonly [key: string]: unknown;
  };
  readonly items?: readonly PaypalDirectPayoutItemProviderObject[];
  readonly links?: readonly { readonly href?: string; readonly rel?: string }[];
  readonly [key: string]: unknown;
}

/** One raw PayPal Payouts v1 item object (READ surface only; opaque). */
export interface PaypalDirectPayoutItemProviderObject {
  readonly payout_item_id?: string;
  readonly transaction_id?: string;
  readonly transaction_status?: string;
  readonly payout_item_fee?: { readonly currency?: string; readonly value?: string };
  readonly payout_batch_id?: string;
  readonly payout_item?: {
    readonly recipient_type?: string;
    readonly amount?: { readonly currency?: string; readonly value?: string };
    readonly receiver?: string;
    readonly [key: string]: unknown;
  };
  readonly time_processed?: string;
  readonly update_time?: string;
  readonly errors?: { readonly name?: string; readonly message?: string; readonly [key: string]: unknown };
  readonly links?: readonly { readonly href?: string; readonly rel?: string }[];
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object)
// ---------------------------------------------------------------------------

/** Order revision: id + status + update_time (the provider's own etch). */
export function paypalDirectOrderRevision(order: PaypalDirectOrderProviderObject): string {
  return `${order.id ?? "no_id"}:${order.status ?? "unknown"}:${order.update_time ?? "no_update_time"}`;
}

/** Authorization revision: id + status + update_time. */
export function paypalDirectAuthorizationRevision(
  authorization: PaypalDirectAuthorizationProviderObject,
): string {
  return `${authorization.id ?? "no_id"}:${authorization.status ?? "unknown"}:${authorization.update_time ?? "no_update_time"}`;
}

/** Capture revision: id + status + update_time. */
export function paypalDirectCaptureRevision(capture: PaypalDirectCaptureProviderObject): string {
  return `${capture.id ?? "no_id"}:${capture.status ?? "unknown"}:${capture.update_time ?? "no_update_time"}`;
}

/** Refund revision: id + status + update_time. */
export function paypalDirectRefundRevision(refund: PaypalDirectRefundProviderObject): string {
  return `${refund.id ?? "no_id"}:${refund.status ?? "unknown"}:${refund.update_time ?? "no_update_time"}`;
}

/** Payout batch revision: batch id + batch_status + update_time. */
export function paypalDirectPayoutBatchRevision(
  batch: PaypalDirectPayoutBatchProviderObject,
): string {
  return `${batch.batch_header?.payout_batch_id ?? "no_batch_id"}:${batch.batch_header?.batch_status ?? "unknown"}:${batch.batch_header?.update_time ?? "no_update_time"}`;
}

/** Payout item revision: item id + transaction_status + update_time. */
export function paypalDirectPayoutItemRevision(
  item: PaypalDirectPayoutItemProviderObject,
): string {
  return `${item.payout_item_id ?? "no_item_id"}:${item.transaction_status ?? "unknown"}:${item.update_time ?? item.time_processed ?? "no_update_time"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface PaypalDirectEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK";
  readonly fetchId?: string;
}

/** Envelope shareable-field surface for PayPal Direct provider objects. */
const PAYPAL_DIRECT_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "status",
  "id",
  "intent",
  "amount",
  "currency_code",
  "value",
  "update_time",
  "create_time",
]);

function paypalDirectEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: PaypalDirectEnvelopeContext,
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

/** The payer-approval link on an order (rel "approve" or "payer-action"). */
function paypalDirectApprovalLink(
  order: PaypalDirectOrderProviderObject,
): { readonly rel: string; readonly href: string } | undefined {
  for (const link of order.links ?? []) {
    if (
      (link.rel === "approve" || link.rel === "payer-action") &&
      typeof link.href === "string" &&
      link.href.length > 0
    ) {
      return Object.freeze({ rel: link.rel, href: link.href });
    }
  }
  return undefined;
}

/**
 * Deterministic, additive classification of a PayPal Orders v2 order into a
 * lossless ProviderStateEnvelope (INV-C06). The RAW order is carried VERBATIM
 * as `state`; the external id is the provider order `id`; statuses map per
 * PAYPAL_DIRECT_ORDER_STATUS_MAPPING and stay verbatim in lifecycleStep:
 *
 * - CREATED / SAVED / PAYER_ACTION_REQUIRED → customer_action_required (the
 *   payer must approve at the provider link — CustomerActionRequirement is
 *   first-class, with the deepLink when the provider discloses one);
 * - APPROVED → the capture family (authorized-then-actionable: capture or
 *   authorize next);
 * - COMPLETED → terminal (captured/settled-external);
 * - VOIDED → terminal cancelled (definitive, ambiguity NONE);
 * - any UNKNOWN status → `other`/verbatim, NON-terminal — never dropped,
 *   never guessed, never collapsed to FAILED (INV-C06/INV-X01).
 */
export function paypalDirectOrderEnvelope(
  order: PaypalDirectOrderProviderObject,
  context: PaypalDirectEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = order.id ?? "no_order_id";
  const base = paypalDirectEnvelopeBase(
    "order",
    externalId,
    paypalDirectOrderRevision(order),
    order,
    context,
  );
  const approval = paypalDirectApprovalLink(order);
  switch (order.status) {
    case "CREATED":
    case "SAVED":
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: order.status === "CREATED" ? "created" : "saved",
        isTerminal: false,
        requiresCustomerAction: true,
        ...(approval !== undefined
          ? {
              actionRequired: {
                kind: "PROVIDER_CHALLENGE_REDIRECT",
                message:
                  "Approve the payment at the PayPal approval link before the order can be captured",
                deepLink: approval.href,
              },
            }
          : {}),
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "PAYER_ACTION_REQUIRED":
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: "payer_action_required",
        isTerminal: false,
        requiresCustomerAction: true,
        ...(approval !== undefined
          ? {
              actionRequired: {
                kind: "PROVIDER_CHALLENGE_REDIRECT",
                message:
                  "Complete the payer action PayPal requires (additional authentication or confirmation) at the provider link",
                deepLink: approval.href,
              },
            }
          : {}),
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "APPROVED":
      return railEnvelope({
        ...base,
        family: "capture",
        lifecycleStep: "approved",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "COMPLETED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "completed",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "VOIDED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "voided",
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
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: order.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/** Payments v2 authorization → envelope (statuses VERBATIM). */
export function paypalDirectAuthorizationEnvelope(
  authorization: PaypalDirectAuthorizationProviderObject,
  context: PaypalDirectEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = authorization.id ?? "no_authorization_id";
  const base = paypalDirectEnvelopeBase(
    "authorization",
    externalId,
    paypalDirectAuthorizationRevision(authorization),
    authorization,
    context,
  );
  switch (authorization.status) {
    case "CREATED":
      // Approved-then-actionable: capture, void or reauthorize next.
      return railEnvelope({
        ...base,
        family: "capture",
        lifecycleStep: "created",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "PENDING":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "pending",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "CAPTURED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "captured",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "VOIDED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "voided",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "authorization_voided",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: authorization.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/** Payments v2 capture → envelope (statuses VERBATIM). */
export function paypalDirectCaptureEnvelope(
  capture: PaypalDirectCaptureProviderObject,
  context: PaypalDirectEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = capture.id ?? "no_capture_id";
  const base = paypalDirectEnvelopeBase(
    "capture",
    externalId,
    paypalDirectCaptureRevision(capture),
    capture,
    context,
  );
  switch (capture.status) {
    case "COMPLETED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "completed",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "DECLINED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "declined",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "capture_declined",
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: capture.status.toLowerCase(),
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: capture.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/**
 * PayPal refund → refund-family envelope. `PENDING` is asynchronous;
 * `COMPLETED` is terminal; `CANCELLED` is terminal with definitive failure
 * metadata; unknown statuses stay verbatim under the refund family with no
 * invented terminality.
 */
export function paypalDirectRefundEnvelope(
  refund: PaypalDirectRefundProviderObject,
  context: PaypalDirectEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = refund.id ?? refund.capture_id ?? "no_refund_id";
  const base = paypalDirectEnvelopeBase(
    "refund",
    externalId,
    paypalDirectRefundRevision(refund),
    refund,
    context,
  );
  switch (refund.status) {
    case "PENDING":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "pending",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "COMPLETED":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "completed",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "CANCELLED":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "cancelled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "refund_cancelled",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: refund.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/**
 * A PayPal Payouts batch (READ surface) → one lossless payout-family
 * observation envelope. The batch_header and every item ride `state`
 * VERBATIM (INV-C06); the family is `payout` — an OBSERVATION of external
 * funds movement, never custody, never an executable surface (INV-C09).
 */
export function paypalDirectPayoutBatchEnvelope(
  batch: PaypalDirectPayoutBatchProviderObject,
  context: PaypalDirectEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: PAYPAL_DIRECT_PROVIDER_NAME,
    providerVersion: PAYPAL_DIRECT_API_VERSION,
    objectType: "payout_batch",
    externalId: batch.batch_header?.payout_batch_id ?? "no_batch_id",
    revision: paypalDirectPayoutBatchRevision(batch),
    state: batch,
    family: "payout",
    lifecycleStep: batch.batch_header?.batch_status ?? "unknown",
    isTerminal: batch.batch_header?.batch_status === "SUCCESS",
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
  });
}

/** A PayPal payout item → payout-family observation envelope (statuses VERBATIM). */
export function paypalDirectPayoutItemEnvelope(
  item: PaypalDirectPayoutItemProviderObject,
  context: PaypalDirectEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = item.payout_item_id ?? "no_item_id";
  const base = paypalDirectEnvelopeBase(
    "payout_item",
    externalId,
    paypalDirectPayoutItemRevision(item),
    item,
    context,
  );
  switch (item.transaction_status) {
    case "SUCCESS":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "success",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "FAILED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "failed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode:
            item.errors?.name !== undefined && item.errors.name.length > 0
              ? item.errors.name
              : "payout_item_failed",
          ...(item.errors?.message !== undefined && item.errors.message.length > 0
            ? { providerErrorMessage: item.errors.message }
            : {}),
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "BLOCKED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "blocked",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payout_item_blocked",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    case "UNCLAIMED":
    case "CLAIMED":
    case "PROCESSING":
    case "REVERSED":
    case "ONHOLD":
    case "RETURNED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: item.transaction_status.toLowerCase(),
        isTerminal:
          item.transaction_status === "REVERSED" || item.transaction_status === "RETURNED",
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: item.transaction_status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
  }
}

/**
 * Maps a PayPal webhook payload to the lossless envelope for its inner
 * object. PAYMENT.CAPTURE.* events carry a capture (or an order);
 * PAYMENT.AUTHORIZATION.* an authorization; CUSTOMER.DISPUTE.* map to the
 * dispute family (the raw event rides the state verbatim — dispute evidence,
 * never flattened); REFUND.* a refund; everything else produces an
 * `event`-typed envelope carrying the WHOLE payload verbatim — nothing is
 * dropped (INV-C06).
 */
export function paypalDirectWebhookEventEnvelope(
  payload: {
    readonly event_type?: string;
    readonly resource?: unknown;
    readonly id?: string;
    readonly [key: string]: unknown;
  },
  context: PaypalDirectEnvelopeContext,
): ProviderStateEnvelope {
  const webhookContext: PaypalDirectEnvelopeContext = {
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
  const eventType = payload.event_type;
  const resource = payload.resource;
  if (eventType !== undefined && resource !== null && typeof resource === "object") {
    if (eventType.startsWith("PAYMENT.CAPTURE.") || eventType.startsWith("CHECKOUT.ORDER.")) {
      const candidate = resource as PaypalDirectCaptureProviderObject &
        PaypalDirectOrderProviderObject;
      if (typeof candidate.id === "string" && candidate.id.length > 0) {
        // Orders events carry {status: order-status}; capture events carry a
        // capture {status, amount}. Both map through their own mappers — the
        // additive classification stays per-surface.
        if (eventType.startsWith("CHECKOUT.ORDER.")) {
          return paypalDirectOrderEnvelope(candidate, webhookContext);
        }
        return paypalDirectCaptureEnvelope(candidate, webhookContext);
      }
    }
    if (eventType.startsWith("PAYMENT.AUTHORIZATION.")) {
      const candidate = resource as PaypalDirectAuthorizationProviderObject;
      if (typeof candidate.id === "string" && candidate.id.length > 0) {
        return paypalDirectAuthorizationEnvelope(candidate, webhookContext);
      }
    }
    if (eventType.startsWith("REFUND.")) {
      const candidate = resource as PaypalDirectRefundProviderObject;
      if (typeof candidate.id === "string" && candidate.id.length > 0) {
        return paypalDirectRefundEnvelope(candidate, webhookContext);
      }
    }
    if (eventType.startsWith("CUSTOMER.DISPUTE.")) {
      return railEnvelope({
        providerName: PAYPAL_DIRECT_PROVIDER_NAME,
        providerVersion: PAYPAL_DIRECT_API_VERSION,
        objectType: "dispute",
        externalId:
          (resource as { readonly dispute_id?: string }).dispute_id ??
          payload.id ??
          `dispute-event:${eventType}`,
        revision: `${eventType}:${payload.id ?? "no_event_id"}`,
        state: payload,
        family: "dispute",
        lifecycleStep: eventType,
        isTerminal: false,
        requiresCustomerAction: false,
        observedAt: context.observedAt,
        provenanceSource: "PROVIDER_WEBHOOK",
        shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
      });
    }
  }
  return railEnvelope({
    providerName: PAYPAL_DIRECT_PROVIDER_NAME,
    providerVersion: PAYPAL_DIRECT_API_VERSION,
    objectType: "event",
    externalId: payload.id ?? `event:${eventType ?? "untyped"}`,
    revision: `${eventType ?? "untyped"}:${payload.id ?? "no_event_id"}`,
    state: payload,
    family: "other",
    lifecycleStep: eventType ?? "untyped",
    isTerminal: false,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    shareableFields: PAYPAL_DIRECT_SHAREABLE_FIELDS,
  });
}

// ---------------------------------------------------------------------------
// Payout item → ExternalFundsPositionObservation (INV-C09 — observation only)
// ---------------------------------------------------------------------------

/**
 * Maps observed PayPal payout items to ExternalFundsPositionObservations —
 * the funds movement the provider reports, observed per item. NEVER custody;
 * a payout observation asserts nothing about PaySwap-held value. Amounts are
 * converted at the documented currency exponent (sub-minor precision in a
 * provider amount makes that item honestly unconverted — reported, never
 * rounded).
 */
export function paypalDirectPayoutObservations(input: {
  readonly items: readonly PaypalDirectPayoutItemProviderObject[];
  readonly accountRef: string;
  readonly observedAt: string;
  readonly maxAgeSeconds?: number;
  readonly observationIdPrefix?: string;
}): readonly ExternalFundsPositionObservation[] {
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  const prefix = input.observationIdPrefix ?? "paypal-direct-payout";
  const observations: ExternalFundsPositionObservation[] = [];
  for (const item of input.items) {
    const amount = item.payout_item?.amount;
    if (
      typeof amount?.currency !== "string" ||
      typeof amount.value !== "string" ||
      amount.currency.length === 0
    ) {
      continue;
    }
    let minorUnits: string;
    try {
      minorUnits = paypalDirectMinorUnitsFromDecimalValue(amount.value, amount.currency);
    } catch {
      // Sub-minor precision (or unknown exponent): the observation is
      // honestly skipped — the raw item still rides the batch envelope
      // VERBATIM (INV-C06); no rounded value is ever fabricated.
      continue;
    }
    const asOf = item.update_time ?? item.time_processed ?? input.observedAt;
    observations.push(
      Object.freeze({
        observationKind: "ExternalFundsPositionObservation" as const,
        observationId: `${prefix}:${item.payout_item_id ?? "no_item_id"}`,
        observedAt: input.observedAt,
        freshness: Object.freeze({
          asOf,
          maxAgeSeconds,
        }),
        location: Object.freeze({
          providerName: PAYPAL_DIRECT_PROVIDER_NAME,
          accountRef: input.accountRef,
          ...(item.payout_batch_id !== undefined
            ? { instrumentRef: `payout-item:${item.payout_item_id ?? "no_item_id"}@${item.payout_batch_id}` }
            : { instrumentRef: `payout-item:${item.payout_item_id ?? "no_item_id"}` }),
          description: `PayPal payout item in state '${item.transaction_status ?? "unknown"}' (external funds movement — observation, never custody; INV-C09)`,
        }),
        observedAmount: Object.freeze({
          currency: amount.currency.toUpperCase(),
          minorUnits,
        }),
        provenance: Object.freeze({
          providerName: PAYPAL_DIRECT_PROVIDER_NAME,
          source: "PROVIDER_API",
          capturedAt: input.observedAt,
        }),
      }),
    );
  }
  return Object.freeze(observations);
}

// ---------------------------------------------------------------------------
// Idempotency (reference-based — PayPal Orders has NO universal key header)
// ---------------------------------------------------------------------------

/** PayPal's documented max length for purchase_units[0].reference_id/custom_id. */
export const PAYPAL_DIRECT_REFERENCE_MAX_LENGTH = 127 as const;

/**
 * Derives the PayPal order reference (purchase_units[0].reference_id AND
 * custom_id) from the protocol idempotency key (INV-F05). PayPal Orders has
 * NO universal idempotency-key header: duplicate protection is
 * REFERENCE-BASED — the same protocol key deterministically produces the
 * same reference on every retry, and a suspected duplicate is resolved by
 * VERIFICATION-BY-QUERY (GET /v2/checkout/orders/{id} / GET by reference
 * through list surfaces). When the derived reference would exceed PayPal's
 * documented 127-char limit, a deterministic sha256-derived short form is
 * used (same key → same short form — idempotency is preserved).
 */
export function paypalDirectOrderReference(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  const base = `payswap:${protocolIdempotencyKey}`;
  if (base.length <= PAYPAL_DIRECT_REFERENCE_MAX_LENGTH) {
    return base;
  }
  const digest = createHmac("sha256", "payswap-paypal-direct-reference")
    .update(protocolIdempotencyKey)
    .digest("hex")
    .slice(0, 56);
  return `payswap-long:${digest}`;
}

// ---------------------------------------------------------------------------
// Webhook verification (SERVER-SIDE — no local HMAC is fabricated)
// ---------------------------------------------------------------------------

/** The five PayPal signature headers on a webhook delivery. */
export interface PaypalDirectWebhookDeliveryHeaders {
  readonly "PAYPAL-AUTH-ALGO": string;
  readonly "PAYPAL-CERT-URL": string;
  readonly "PAYPAL-TRANSMISSION-ID": string;
  readonly "PAYPAL-TRANSMISSION-SIG": string;
  readonly "PAYPAL-TRANSMISSION-TIME": string;
}

/** One PayPal webhook delivery as received (raw body + headers + event id). */
export interface PaypalDirectWebhookDelivery {
  /** The provider's event id — the (provider, eventId) dedupe key. */
  readonly eventId: string;
  readonly webhookEvent: unknown;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/**
 * Extracts and shape-checks the five PayPal signature headers from a
 * delivery's header map (case-sensitive per PayPal's documentation; the
 * canonical upper-case names are also accepted from lower-cased HTTP maps).
 * Fail-closed: ANY missing/empty header → the missing list, never a guess.
 */
export function paypalDirectWebhookDeliveryHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): { readonly headers: PaypalDirectWebhookDeliveryHeaders } | { readonly missing: readonly string[] } {
  const missing: string[] = [];
  const values: Record<string, string> = {};
  const mixedCase: Readonly<Record<string, string>> = {
    "PAYPAL-AUTH-ALGO": "Paypal-Auth-Algo",
    "PAYPAL-CERT-URL": "Paypal-Cert-Url",
    "PAYPAL-TRANSMISSION-ID": "Paypal-Transmission-Id",
    "PAYPAL-TRANSMISSION-SIG": "Paypal-Transmission-Sig",
    "PAYPAL-TRANSMISSION-TIME": "Paypal-Transmission-Time",
  };
  for (const canonical of [
    "PAYPAL-AUTH-ALGO",
    "PAYPAL-CERT-URL",
    "PAYPAL-TRANSMISSION-ID",
    "PAYPAL-TRANSMISSION-SIG",
    "PAYPAL-TRANSMISSION-TIME",
  ] as const) {
    const value =
      headers[canonical] ??
      headers[canonical.toLowerCase()] ??
      headers[mixedCase[canonical] ?? ""];
    if (typeof value !== "string" || value.length === 0) {
      missing.push(canonical);
    } else {
      values[canonical] = value;
    }
  }
  if (missing.length > 0) {
    return Object.freeze({ missing: Object.freeze(missing) });
  }
  return Object.freeze({
    headers: Object.freeze({
      "PAYPAL-AUTH-ALGO": values["PAYPAL-AUTH-ALGO"] as string,
      "PAYPAL-CERT-URL": values["PAYPAL-CERT-URL"] as string,
      "PAYPAL-TRANSMISSION-ID": values["PAYPAL-TRANSMISSION-ID"] as string,
      "PAYPAL-TRANSMISSION-SIG": values["PAYPAL-TRANSMISSION-SIG"] as string,
      "PAYPAL-TRANSMISSION-TIME": values["PAYPAL-TRANSMISSION-TIME"] as string,
    }),
  });
}

/** The provider-verified outcome of one PayPal webhook delivery. */
export type PaypalDirectWebhookVerification =
  | { readonly verificationStatus: "SUCCESS" }
  | { readonly verificationStatus: "FAILURE" };

/**
 * SERVER-SIDE PayPal webhook verification (the ONLY verification path — no
 * local HMAC is fabricated for a scheme PayPal does not offer): the connector
 * POSTs {auth_algo, cert_url, transmission_id, transmission_sig,
 * transmission_time, webhook_id, webhook_event} to
 * /v1/notifications/verify-webhook-signature and trusts ONLY the provider's
 * `verification_status` ("SUCCESS" | "FAILURE"). A malformed provider answer
 * is a RailProviderError (fail-closed — never guessed). The transport is
 * INJECTED: unit tests stub it; production uses the real HTTP transport.
 */
export async function verifyPaypalDirectWebhookDelivery(input: {
  readonly http: HttpTransport;
  readonly apiBase: string;
  /** The bearer token (already OAuth2-acquired). */
  readonly accessToken: string;
  /** The PayPal webhook id registered for the endpoint (from the sealed bundle). */
  readonly webhookId: string;
  readonly headers: PaypalDirectWebhookDeliveryHeaders;
  readonly webhookEvent: unknown;
  readonly timeoutMs?: number;
}): Promise<PaypalDirectWebhookVerification> {
  const body = JSON.stringify({
    auth_algo: input.headers["PAYPAL-AUTH-ALGO"],
    cert_url: input.headers["PAYPAL-CERT-URL"],
    transmission_id: input.headers["PAYPAL-TRANSMISSION-ID"],
    transmission_sig: input.headers["PAYPAL-TRANSMISSION-SIG"],
    transmission_time: input.headers["PAYPAL-TRANSMISSION-TIME"],
    webhook_id: input.webhookId,
    webhook_event: input.webhookEvent,
  });
  let response: { readonly status: number; readonly bodyText: string };
  try {
    response = await input.http(`${input.apiBase}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body,
      timeoutMs: input.timeoutMs ?? 15_000,
    });
  } catch (cause) {
    throw new RailTransportError("paypal-direct webhook verification transport unreachable", {
      path: "/v1/notifications/verify-webhook-signature",
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bodyText);
  } catch (cause) {
    throw new RailProviderError(
      "paypal-direct webhook verification response is not JSON (fail-closed — never guessed)",
      {
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    );
  }
  const verificationStatus = (parsed as { readonly verification_status?: unknown })
    .verification_status;
  if (response.status < 200 || response.status >= 300) {
    throw new RailProviderError(
      `paypal-direct webhook verification answered HTTP ${response.status}`,
      { httpStatus: response.status },
    );
  }
  if (verificationStatus === "SUCCESS") {
    return Object.freeze({ verificationStatus: "SUCCESS" });
  }
  if (verificationStatus === "FAILURE") {
    return Object.freeze({ verificationStatus: "FAILURE" });
  }
  throw new RailProviderError(
    `paypal-direct webhook verification returned an unrecognized verification_status '${String(
      verificationStatus,
    )}' (fail-closed — never guessed)`,
    { httpStatus: response.status, verificationStatus: String(verificationStatus) },
  );
}

/** The result of ingesting one PayPal webhook delivery. */
export type PaypalDirectWebhookIngestResult =
  | {
      readonly outcome: "ACCEPTED";
      readonly envelope: ProviderStateEnvelope;
      readonly verification: PaypalDirectWebhookVerification;
    }
  | { readonly outcome: "REJECTED"; readonly reason: string }
  | { readonly outcome: "DUPLICATE"; readonly eventId: string };

/**
 * The PayPal Direct webhook ingestor: header shape check (fail-closed on any
 * missing signature header) → SERVER-SIDE verification via
 * /v1/notifications/verify-webhook-signature (fail-closed on FAILURE) →
 * (provider, eventId) DEDUPE → the lossless event envelope. Every step is
 * honest: no local signature is fabricated, no unverifiable delivery is
 * accepted.
 */
export class PaypalDirectWebhookIngestor {
  readonly #http: HttpTransport;
  readonly #apiBase: string;
  readonly #webhookId: string;
  readonly #tokenProvider: () => Promise<string>;
  readonly #observedAt: () => string;
  readonly #timeoutMs: number;
  readonly #seenEventIds = new Set<string>();

  constructor(deps: {
    readonly http: HttpTransport;
    readonly apiBase: string;
    readonly webhookId: string;
    readonly tokenProvider: () => Promise<string>;
    readonly observedAt: () => string;
    readonly timeoutMs?: number;
  }) {
    if (typeof deps.webhookId !== "string" || deps.webhookId.length === 0) {
      throw new ValidationError(
        "the PayPal Direct webhook ingestor requires a non-empty webhook id (registered at the PayPal Developer Dashboard; carried in the sealed credential bundle)",
      );
    }
    this.#http = deps.http;
    this.#apiBase = deps.apiBase;
    this.#webhookId = deps.webhookId;
    this.#tokenProvider = deps.tokenProvider;
    this.#observedAt = deps.observedAt;
    this.#timeoutMs = deps.timeoutMs ?? 15_000;
  }

  async ingest(delivery: PaypalDirectWebhookDelivery): Promise<PaypalDirectWebhookIngestResult> {
    const shape = paypalDirectWebhookDeliveryHeaders(delivery.headers);
    if ("missing" in shape) {
      return Object.freeze({
        outcome: "REJECTED",
        reason: `missing PayPal signature headers: ${shape.missing.join(", ")} (fail-closed — server-side verification requires the full header set)`,
      });
    }
    const verification = await verifyPaypalDirectWebhookDelivery({
      http: this.#http,
      apiBase: this.#apiBase,
      accessToken: await this.#tokenProvider(),
      webhookId: this.#webhookId,
      headers: shape.headers,
      webhookEvent: delivery.webhookEvent,
      timeoutMs: this.#timeoutMs,
    });
    if (verification.verificationStatus === "FAILURE") {
      return Object.freeze({
        outcome: "REJECTED",
        reason:
          "provider verification_status FAILURE (server-side /v1/notifications/verify-webhook-signature)",
      });
    }
    if (this.#seenEventIds.has(delivery.eventId)) {
      return Object.freeze({ outcome: "DUPLICATE", eventId: delivery.eventId });
    }
    this.#seenEventIds.add(delivery.eventId);
    const payload =
      delivery.webhookEvent !== null && typeof delivery.webhookEvent === "object"
        ? (delivery.webhookEvent as { readonly [key: string]: unknown })
        : {};
    const envelope = paypalDirectWebhookEventEnvelope(payload, {
      observedAt: this.#observedAt(),
      provenanceSource: "PROVIDER_WEBHOOK",
    });
    return Object.freeze({ outcome: "ACCEPTED", envelope, verification });
  }
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

/** The opened PayPal Direct credential bundle (exists only inside the frame). */
export interface PaypalDirectCredentialMaterial {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The registered webhook id (optional — required only for webhook ingestion). */
  readonly webhookId?: string;
}

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface PaypalDirectControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface PayPalDirectConnectorConfig {
  readonly clock: ProtocolClock;
  /** "sandbox" (default) or "live" — selects the pinned API base when apiBase is absent. */
  readonly mode?: "sandbox" | "live";
  readonly apiBase?: string;
  /** Overrides the pinned API version (tests only — production pins). */
  readonly apiVersion?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("paypal_direct")` =
   * PROVIDER_PAYPAL_DIRECT_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: PaypalDirectControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type PaypalDirectSdkRequest =
  | {
      readonly kind: "create_order";
      readonly amountMinor: string;
      readonly currency: string;
      readonly intent?: "CAPTURE" | "AUTHORIZE";
      /** Overrides the derived reference (paypalDirectOrderReference). */
      readonly reference?: string;
      readonly returnUrl?: string;
      readonly cancelUrl?: string;
      readonly payee?: { readonly email?: string; readonly merchantId?: string };
    }
  | { readonly kind: "get_order"; readonly orderId: string }
  | { readonly kind: "capture_order"; readonly orderId: string }
  | { readonly kind: "authorize_order"; readonly orderId: string }
  | { readonly kind: "void_order"; readonly orderId: string }
  | { readonly kind: "get_authorization"; readonly authorizationId: string }
  | {
      readonly kind: "capture_authorization";
      readonly authorizationId: string;
      readonly amountMinor?: string;
      readonly currency?: string;
      readonly finalCapture?: boolean;
    }
  | { readonly kind: "void_authorization"; readonly authorizationId: string }
  | { readonly kind: "reauthorize_authorization"; readonly authorizationId: string }
  | { readonly kind: "get_capture"; readonly captureId: string }
  | {
      readonly kind: "refund_capture";
      readonly captureId: string;
      readonly amountMinor?: string;
      readonly currency?: string;
      readonly noteToPayer?: string;
      readonly invoiceId?: string;
    }
  | { readonly kind: "get_refund"; readonly refundId: string }
  | { readonly kind: "observe_payout_batch"; readonly batchId: string }
  | { readonly kind: "observe_payout_item"; readonly itemId: string };

function isPaypalDirectSdkRequest(candidate: unknown): candidate is PaypalDirectSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** Which credential path is live (observability — NEVER material). */
export type PaypalDirectCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/**
 * The real PayPal Direct connector (ConnectorSDK framework). PayPal REST
 * names, payloads, response shapes and quirks stay INSIDE this
 * implementation: the SDK call contract is the provider-neutral
 * `PaypalDirectSdkRequest` union. Every effectful operation runs behind
 * `requireAuthority` (INV-C04/F05/F06) and fails closed with
 * `RailNotAuthorizedError` BEFORE any provider call when no credential path
 * is live (INV-NC04) — NO PayPal credential exists in this deployment, so
 * that is the live behavior of this connector until the operator provisions
 * one through the control plane.
 *
 * OAuth2: POST /v1/oauth2/token with Basic base64(client_id:client_secret),
 * body grant_type=client_credentials → {access_token, expires_in,
 * token_type}; the token is cached in-memory until near-expiry and acquired
 * only inside an open credential frame.
 */
export class PayPalDirectConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: PaypalDirectControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  #credentialBaseline: string | undefined;
  #token: { readonly accessToken: string; readonly expiresAtMs: number } | undefined;

  constructor(config: PayPalDirectConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    const mode = config.mode ?? "sandbox";
    this.#apiBase =
      config.apiBase ??
      (mode === "live"
        ? PAYPAL_DIRECT_DEFAULT_API_BASE_LIVE
        : PAYPAL_DIRECT_DEFAULT_API_BASE_SANDBOX);
    this.#apiVersion = config.apiVersion ?? PAYPAL_DIRECT_API_VERSION;
    this.#credentialConfigKey =
      config.credentialConfigKey ?? PAYPAL_DIRECT_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: PAYPAL_DIRECT_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "PayPal Direct (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return paypalDirectRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "OAUTH" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "OAUTH" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): PaypalDirectCredentialResolutionState {
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
        "no control-plane credentials and no env-resolved bundle under the config key — rail fails closed (INV-NC04; packages/rails/BLOCKED-RAILS.md §6)",
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
          "credential reference not provisioned — source availability UNKNOWN (INV-C01/C02); the recorded reachability datum is PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002 (endpoint reachable, authorization absent); see packages/rails/BLOCKED-RAILS.md §6",
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

  async search(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "search");
    const request = this.#request(ctx, "observe_payout");
    const observedAt = this.#envelopeContext();
    if (request.kind === "observe_payout_batch") {
      const batch = (await this.#withCredentials(async (token) =>
        this.#providerGet(
          `/v1/payments/payouts/${encodeURIComponent(request.batchId)}`,
          ctx.idempotencyKey,
          token,
        ),
      )) as PaypalDirectPayoutBatchProviderObject;
      return this.#sdkResult(
        paypalDirectPayoutBatchEnvelope(batch, observedAt),
        `paypal-direct:observe-payout-batch:${request.batchId}`,
      );
    }
    if (request.kind === "observe_payout_item") {
      const item = (await this.#withCredentials(async (token) =>
        this.#providerGet(
          `/v1/payments/payouts-item/${encodeURIComponent(request.itemId)}`,
          ctx.idempotencyKey,
          token,
        ),
      )) as PaypalDirectPayoutItemProviderObject;
      return this.#sdkResult(
        paypalDirectPayoutItemEnvelope(item, observedAt),
        `paypal-direct:observe-payout-item:${request.itemId}`,
      );
    }
    throw new ValidationError(
      "paypal-direct search supports only { kind: 'observe_payout_batch' | 'observe_payout_item' } (READ-ONLY payout observation — INV-C09; execution is deliberately not implemented)",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "get_order");
    const observedAt = this.#envelopeContext();
    // A read that cannot reach the provider propagates RailTransportError —
    // NO fabricated provider state, and never a FAILED payment from a
    // timeout (INV-X01).
    if (request.kind === "get_order") {
      const order = (await this.#withCredentials(async (token) =>
        this.#providerGet(
          `/v2/checkout/orders/${encodeURIComponent(request.orderId)}`,
          ctx.idempotencyKey,
          token,
        ),
      )) as PaypalDirectOrderProviderObject;
      return this.#sdkResult(
        paypalDirectOrderEnvelope(order, observedAt),
        `paypal-direct:get-order:${request.orderId}`,
      );
    }
    if (request.kind === "get_authorization") {
      const authorization = (await this.#withCredentials(async (token) =>
        this.#providerGet(
          `/v2/payments/authorizations/${encodeURIComponent(request.authorizationId)}`,
          ctx.idempotencyKey,
          token,
        ),
      )) as PaypalDirectAuthorizationProviderObject;
      return this.#sdkResult(
        paypalDirectAuthorizationEnvelope(authorization, observedAt),
        `paypal-direct:get-authorization:${request.authorizationId}`,
      );
    }
    if (request.kind === "get_capture") {
      const capture = (await this.#withCredentials(async (token) =>
        this.#providerGet(
          `/v2/payments/captures/${encodeURIComponent(request.captureId)}`,
          ctx.idempotencyKey,
          token,
        ),
      )) as PaypalDirectCaptureProviderObject;
      return this.#sdkResult(
        paypalDirectCaptureEnvelope(capture, observedAt),
        `paypal-direct:get-capture:${request.captureId}`,
      );
    }
    if (request.kind === "get_refund") {
      const refund = (await this.#withCredentials(async (token) =>
        this.#providerGet(
          `/v2/payments/refunds/${encodeURIComponent(request.refundId)}`,
          ctx.idempotencyKey,
          token,
        ),
      )) as PaypalDirectRefundProviderObject;
      return this.#sdkResult(
        paypalDirectRefundEnvelope(refund, observedAt),
        `paypal-direct:get-refund:${request.refundId}`,
      );
    }
    throw new ValidationError(
      "paypal-direct read supports get_order / get_authorization / get_capture / get_refund",
    );
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_order");
    if (request.kind !== "create_order") {
      throw new ValidationError("paypal-direct create supports only { kind: 'create_order' }");
    }
    if (
      request.amountMinor === undefined ||
      request.currency === undefined
    ) {
      throw new ValidationError(
        "create_order requires amountMinor (exact minor units) and currency",
      );
    }
    const observedAt = this.#envelopeContext();
    const reference = request.reference ?? paypalDirectOrderReference(ctx.idempotencyKey);
    const value = paypalDirectDecimalValueFromMinorUnits(request.amountMinor, request.currency);
    const body: Record<string, unknown> = {
      intent: request.intent ?? "CAPTURE",
      purchase_units: [
        Object.freeze({
          reference_id: reference,
          custom_id: reference,
          amount: Object.freeze({
            currency_code: request.currency.toUpperCase(),
            value,
          }),
          ...(request.payee !== undefined
            ? {
                payee: Object.freeze({
                  ...(request.payee.email !== undefined
                    ? { email_address: request.payee.email }
                    : {}),
                  ...(request.payee.merchantId !== undefined
                    ? { merchant_id: request.payee.merchantId }
                    : {}),
                }),
              }
            : {}),
        }),
      ],
    };
    if (request.returnUrl !== undefined || request.cancelUrl !== undefined) {
      const experienceContext: Record<string, string> = {};
      if (request.returnUrl !== undefined) {
        experienceContext.return_url = request.returnUrl;
      }
      if (request.cancelUrl !== undefined) {
        experienceContext.cancel_url = request.cancelUrl;
      }
      body.payment_source = Object.freeze({
        paypal: Object.freeze({ experience_context: Object.freeze(experienceContext) }),
      });
    }
    // INV-X01: a transport failure mid-create is OUTCOME_UNKNOWN — an order
    // with this reference may exist at the provider; reconcile by querying
    // the order. NEVER FAILED.
    try {
      const order = (await this.#withCredentials(async (token) =>
        this.#providerPost("/v2/checkout/orders", body, ctx.idempotencyKey, token),
      )) as PaypalDirectOrderProviderObject;
      const state =
        typeof order.id === "string" && order.id.length > 0
          ? order
          : { ...order, id: `${reference}` };
      return this.#sdkResult(
        paypalDirectOrderEnvelope(state, observedAt),
        `paypal-direct:create-order:${reference}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "order",
          externalId: reference,
          operation: "create_order",
          idempotencyKey: ctx.idempotencyKey,
          transportError: error.message,
          observedAt: observedAt.observedAt,
        });
      }
      throw error;
    }
  }

  async update(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "paypal-direct order objects are not mutable through this surface (create → payer approval → capture/authorize/void lifecycle only; PayPal's order PATCH belongs to the provider dashboard flow)",
    );
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "capture_order");
    const observedAt = this.#envelopeContext();
    if (request.kind === "capture_order" || request.kind === "authorize_order" || request.kind === "void_order") {
      const path =
        request.kind === "capture_order"
          ? `/v2/checkout/orders/${encodeURIComponent(request.orderId)}/capture`
          : request.kind === "authorize_order"
            ? `/v2/checkout/orders/${encodeURIComponent(request.orderId)}/authorize`
            : `/v2/checkout/orders/${encodeURIComponent(request.orderId)}/void`;
      // INV-X01: value CAN move on capture — OUTCOME_UNKNOWN, never FAILED.
      try {
        const order = (await this.#withCredentials(async (token) =>
          this.#providerPost(path, {}, ctx.idempotencyKey, token),
        )) as PaypalDirectOrderProviderObject;
        return this.#sdkResult(
          paypalDirectOrderEnvelope(order, observedAt),
          `paypal-direct:${request.kind}:${request.orderId}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "order",
            externalId: request.orderId,
            operation: request.kind,
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    if (
      request.kind === "capture_authorization" ||
      request.kind === "void_authorization" ||
      request.kind === "reauthorize_authorization"
    ) {
      const path =
        request.kind === "capture_authorization"
          ? `/v2/payments/authorizations/${encodeURIComponent(request.authorizationId)}/capture`
          : request.kind === "void_authorization"
            ? `/v2/payments/authorizations/${encodeURIComponent(request.authorizationId)}/void`
            : `/v2/payments/authorizations/${encodeURIComponent(request.authorizationId)}/reauthorize`;
      const body: Record<string, unknown> = {};
      if (request.kind === "capture_authorization" && request.amountMinor !== undefined) {
        if (request.currency === undefined) {
          throw new ValidationError(
            "capture_authorization with an amount requires the currency (exact minor units at the documented exponent)",
          );
        }
        body.amount = Object.freeze({
          currency_code: request.currency.toUpperCase(),
          value: paypalDirectDecimalValueFromMinorUnits(request.amountMinor, request.currency),
        });
      }
      if (request.kind === "capture_authorization" && request.finalCapture !== undefined) {
        body.final_capture = request.finalCapture;
      }
      try {
        const capture = (await this.#withCredentials(async (token) =>
          this.#providerPost(path, body, ctx.idempotencyKey, token),
        )) as PaypalDirectCaptureProviderObject;
        return this.#sdkResult(
          paypalDirectCaptureEnvelope(capture, observedAt),
          `paypal-direct:${request.kind}:${request.authorizationId}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "authorization",
            externalId: request.authorizationId,
            operation: request.kind,
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    if (request.kind === "refund_capture") {
      const body: Record<string, unknown> = {};
      if (request.amountMinor !== undefined) {
        if (request.currency === undefined) {
          throw new ValidationError(
            "refund_capture with an amount requires the currency (exact minor units at the documented exponent)",
          );
        }
        body.amount = Object.freeze({
          currency_code: request.currency.toUpperCase(),
          value: paypalDirectDecimalValueFromMinorUnits(request.amountMinor, request.currency),
        });
      }
      if (request.noteToPayer !== undefined) {
        body.note_to_payer = request.noteToPayer;
      }
      if (request.invoiceId !== undefined) {
        body.invoice_id = request.invoiceId;
      }
      // INV-X01: value can move on a refund — OUTCOME_UNKNOWN, never FAILED.
      try {
        const refund = (await this.#withCredentials(async (token) =>
          this.#providerPost(
            `/v2/payments/captures/${encodeURIComponent(request.captureId)}/refund`,
            body,
            ctx.idempotencyKey,
            token,
          ),
        )) as PaypalDirectRefundProviderObject;
        const state =
          typeof refund.id === "string" && refund.id.length > 0
            ? refund
            : { ...refund, capture_id: request.captureId };
        return this.#sdkResult(
          paypalDirectRefundEnvelope(state, observedAt),
          `paypal-direct:refund-capture:${request.captureId}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "refund",
            externalId: request.captureId,
            operation: "refund_capture",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    throw new ValidationError(
      `paypal-direct executeAction supports capture_order/authorize_order/void_order/capture_authorization/void_authorization/reauthorize_authorization/refund_capture — got kind '${request.kind}'`,
    );
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "paypal-direct event subscription is handled by the server-side webhook verification framework (PaypalDirectWebhookIngestor + POST /v1/notifications/verify-webhook-signature); endpoint registration happens at the PayPal Developer Dashboard, not through this SDK surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "get_order");
    if (request.kind !== "get_order") {
      throw new ValidationError("paypal-direct reconcile supports only { kind: 'get_order' }");
    }
    // Reconciliation-as-authority (INV-X03): re-fetch by external order id —
    // the payment-status/refund reconciliation path.
    return this.read(ctx);
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
   * reference resolves and serves a successful health probe (a real OAuth2
   * token issuance). The old client_id/client_secret pair is revoked at
   * PayPal only after that verification.
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
      // A rotated credential invalidates any cached OAuth2 token.
      this.#token = undefined;
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
        "cannot rotate credentials: no credential path is provisioned for the paypal-direct rail (packages/rails/BLOCKED-RAILS.md §6)",
        { railId: PAYPAL_DIRECT_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = createHmac("sha256", "payswap-paypal-direct-rotation-baseline")
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
    this.#token = undefined;
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
   * never a business outcome. Without credentials: the recorded reachability
   * posture — POST /v1/oauth2/token WITHOUT credentials (any HTTP answer
   * proves reachability; the 2026-10-02 datum recorded HTTP 401: endpoint
   * reachable, authorization absent) → DEGRADED with the documented reasons;
   * transport failure → UNKNOWN. With credentials: a REAL OAuth2 token
   * issuance (POST /v1/oauth2/token with the sealed pair) → HEALTHY.
   */
  async health(): Promise<ConnectorHealthReport> {
    const resolution = this.credentialResolutionState();
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: PAYPAL_DIRECT_CONNECTOR_ID,
      providerName: PAYPAL_DIRECT_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (resolution.kind === "NOT_PROVISIONED") {
      let endpointAnswered: boolean;
      try {
        await this.#http(`${this.#apiBase}/v1/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=client_credentials",
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
              "credentials absent: provider endpoint reachable (probe answered; recorded datum PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002: HTTP 401 on /v1/oauth2/token — endpoint reachable, authorization absent) but rail authorization cannot be established — availability UNKNOWN (INV-C01/C02; packages/rails/BLOCKED-RAILS.md §6)",
            ]
          : ["provider endpoint unreachable — availability UNKNOWN (INV-C02)"],
      };
    }
    try {
      const material = await this.#openCredentialMaterial();
      await this.#acquireToken(material, "health-probe");
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

  // -- dedicated observation methods (read-only evidence) ----------------------

  /**
   * OBSERVED payout batch (GET /v1/payments/payouts/{batch_id}) — the
   * ExternalFundsPositionObservation view (INV-C09: observation ONLY; the
   * payout CREATE surface is deliberately not implemented). Fails closed
   * without credentials.
   */
  async payoutBatchObservation(batchId: string): Promise<{
    readonly envelope: ProviderStateEnvelope;
    readonly observations: readonly ExternalFundsPositionObservation[];
  }> {
    const observedAt = this.#envelopeContext();
    const batch = (await this.#withCredentials(async (material) =>
      this.#providerGet(
        `/v1/payments/payouts/${encodeURIComponent(batchId)}`,
        "payout-batch-observation",
        material,
      ),
    )) as PaypalDirectPayoutBatchProviderObject;
    return Object.freeze({
      envelope: paypalDirectPayoutBatchEnvelope(batch, observedAt),
      observations: paypalDirectPayoutObservations({
        items: batch.items ?? [],
        accountRef: batch.batch_header?.payout_batch_id ?? "paypal-direct-account",
        observedAt: observedAt.observedAt,
      }),
    });
  }

  /**
   * The server-side webhook ingestor bound to this connector's transport and
   * OAuth2 token source. The webhook id comes from the SEALED credential
   * bundle; when the bundle carries none, this refuses (fail-closed — the
   * dashboard registration datum is required evidence, never guessed).
   */
  async webhookIngestor(): Promise<PaypalDirectWebhookIngestor> {
    const material = await this.#openCredentialMaterial();
    if (material.webhookId === undefined) {
      throw new RailNotAuthorizedError(
        "paypal-direct webhook ingestion requires the registered webhook id in the sealed credential bundle (no dashboard registration is assumed — fail-closed)",
        { railId: PAYPAL_DIRECT_RAIL_ADAPTER_ID, configKey: this.#credentialConfigKey },
      );
    }
    return new PaypalDirectWebhookIngestor({
      http: this.#http,
      apiBase: this.#apiBase,
      webhookId: material.webhookId,
      tokenProvider: async () => this.#openCredentialToken(),
      observedAt: () => isoTimestamp(this.#clock.now()),
      timeoutMs: this.#timeoutMs,
    });
  }

  // -- internals -------------------------------------------------------------------

  #envelopeContext(): PaypalDirectEnvelopeContext {
    return {
      observedAt: isoTimestamp(this.#clock.now()),
      provenanceSource: "PROVIDER_API",
    };
  }

  /**
   * The env fallback (W1-005 rails convention): the config key may hold a
   * RESOLVED bundle — a JSON object string
   * {"clientId":…,"clientSecret":…,"webhookId"?…}. Any other shape refuses
   * (a PayPal credential is a PAIR, never a single string — fail-closed, no
   * guessing).
   */
  #envMaterial(): PaypalDirectCredentialMaterial | undefined {
    if (this.#env === undefined) {
      return undefined;
    }
    const value = this.#env[this.#credentialConfigKey];
    if (typeof value !== "string" || value.length === 0) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      // A malformed provisioned bundle is a config ERROR, not "absent" —
      // surfaced honestly and fail-closed (never guessed).
      throw new ValidationError(
        "the env-resolved PayPal Direct credential material is not a valid JSON bundle (expected {\"clientId\":…,\"clientSecret\":…[,\"webhookId\":…]})",
        { configKey: this.#credentialConfigKey, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    return extractPaypalDirectCredentialBundle(parsed);
  }

  /**
   * Opens the credential material WITHOUT running a provider interaction —
   * used by the webhook ingestor binding (the token acquisition happens
   * lazily through #openCredentialToken).
   */
  async #openCredentialMaterial(): Promise<PaypalDirectCredentialMaterial> {
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
      return await this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => extractPaypalDirectCredentialBundle(opened.material),
      );
    }
    const material = this.#envMaterial();
    if (material === undefined) {
      throw new RailNotAuthorizedError(
        "paypal-direct rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md §6)",
        { railId: PAYPAL_DIRECT_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    return material;
  }

  /** A bearer token acquired inside a FRESH credential frame (no cached pair across rotations). */
  async #openCredentialToken(): Promise<string> {
    const material = await this.#openCredentialMaterial();
    return this.#acquireToken(material, "webhook-verification");
  }

  /**
   * Runs one provider interaction with a bearer token: the OAuth2 token is
   * acquired (cached until near-expiry) inside a live credential frame and
   * the interaction runs with it. The control plane opens the SEALED bundle
   * per call (material exists only inside the callback frame); the env
   * fallback injects the resolved bundle directly. With neither, the
   * operation fails closed BEFORE any provider call (INV-NC04).
   */
  async #withCredentials<T>(fn: (bearerToken: string) => Promise<T>): Promise<T> {
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
        async (opened) => {
          const material = extractPaypalDirectCredentialBundle(opened.material);
          const token = await this.#acquireToken(material, "bearer");
          return fn(token);
        },
      );
    }
    const material = this.#envMaterial();
    if (material === undefined) {
      throw new RailNotAuthorizedError(
        "paypal-direct rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md §6)",
        { railId: PAYPAL_DIRECT_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const token = await this.#acquireToken(material, "bearer");
    return fn(token);
  }

  /** OAuth2: POST /v1/oauth2/token (Basic base64(client_id:client_secret)). */
  async #acquireToken(
    material: PaypalDirectCredentialMaterial,
    callRef: string,
  ): Promise<string> {
    const nowMs = this.#clock.now();
    if (this.#token !== undefined && nowMs < this.#token.expiresAtMs) {
      return this.#token.accessToken;
    }
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
      throw new RailTransportError("paypal-direct oauth2 token endpoint unreachable", {
        path: "/v1/oauth2/token",
        callRef,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("paypal-direct oauth2 response is not JSON", {
        path: "/v1/oauth2/token",
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status < 200 || response.status >= 300) {
      const body = parsed as {
        readonly error?: string;
        readonly error_description?: string;
      };
      throw new RailProviderError(
        `paypal-direct oauth2 answered HTTP ${response.status}${body.error !== undefined ? ` (${body.error})` : ""} — authorization absent or rejected`,
        { path: "/v1/oauth2/token", httpStatus: response.status },
      );
    }
    const token = parsed as {
      readonly access_token?: string;
      readonly expires_in?: number;
      readonly token_type?: string;
    };
    if (typeof token.access_token !== "string" || token.access_token.length === 0) {
      throw new RailProviderError(
        "paypal-direct oauth2 response carries no access_token (fail-closed — never guessed)",
        { path: "/v1/oauth2/token", httpStatus: response.status },
      );
    }
    const expiresInMs =
      typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
        ? BigInt(Math.floor(token.expires_in)) * 1000n
        : 0n;
    // 30s safety margin before the provider-declared expiry; a missing
    // expires_in (0n) means NO caching — every call re-authenticates.
    this.#token = Object.freeze({
      accessToken: token.access_token,
      expiresAtMs: Number(nowMs + (expiresInMs > 30_000n ? expiresInMs - 30_000n : 0n)),
    });
    return token.access_token;
  }

  #request(ctx: SdkCallContext, expectedKind: string): PaypalDirectSdkRequest {
    const candidate = ctx.request;
    if (!isPaypalDirectSdkRequest(candidate)) {
      throw new ValidationError(
        `paypal-direct rail call request must be a PaypalDirectSdkRequest object (expected kind '${expectedKind}')`,
      );
    }
    if (
      "amountMinor" in candidate &&
      candidate.amountMinor !== undefined &&
      !/^\d+$/.test(String(candidate.amountMinor))
    ) {
      throw new ValidationError(
        "amountMinor must be an exact integer minor-units string (INV-F01)",
      );
    }
    return candidate;
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
        note: "transport failed mid-effect — the provider effect may have landed; reconcile by querying the object (INV-X01/INV-X03); never coerced to FAILED",
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
    return this.#sdkResult(envelope, `paypal-direct:outcome-unknown:${input.operation}:${input.idempotencyKey}`);
  }

  async #providerGet(path: string, callRef: string, token: string): Promise<unknown> {
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("paypal-direct provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return this.#parseResponse(response, path, callRef);
  }

  async #providerPost(
    path: string,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    token: string,
  ): Promise<unknown> {
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
      throw new RailTransportError("paypal-direct provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return this.#parseResponse(response, path, idempotencyKey);
  }

  /**
   * PayPal REST responses carry NO { status, message, data } wrapper (unlike
   * Paystack): the parsed body IS the provider object; errors are
   * `{ name, message, details, debug_id }` with a 4xx/5xx status. Provider
   * error names/messages/debug ids are preserved VERBATIM in the error
   * details (INV-C06 discipline on the error path: payer eligibility errors
   * such as COUNTRY_NOT_SUPPORTED arrive verbatim as provider evidence).
   */
  #parseResponse(
    response: { readonly status: number; readonly bodyText: string },
    path: string,
    callRef: string,
  ): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("paypal-direct provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status < 200 || response.status >= 300) {
      const error = (parsed ?? {}) as {
        readonly name?: string;
        readonly message?: string;
        readonly debug_id?: string;
        readonly details?: readonly unknown[];
      };
      throw new RailProviderError(
        `paypal-direct provider answered HTTP ${response.status}${error.name !== undefined ? ` (${error.name})` : ""}${error.message !== undefined ? `: ${error.message}` : ""}`,
        {
          path,
          httpStatus: response.status,
          ...(error.name !== undefined ? { providerErrorName: error.name } : {}),
          ...(error.message !== undefined ? { providerErrorMessage: error.message } : {}),
          ...(error.debug_id !== undefined ? { providerDebugId: error.debug_id } : {}),
          ...(error.details !== undefined ? { providerErrorDetails: [...error.details] } : {}),
          callRef,
        },
      );
    }
    return parsed;
  }
}

/**
 * Extracts the PayPal Direct credential bundle from a vault/opened material
 * shape. The credential is a PAIR: client_id + client_secret (plus the
 * optional registered webhook id). Accepted shapes: { clientId, clientSecret,
 * webhookId? } / { client_id, client_secret, webhook_id? } / { clientId,
 * clientSecret, webhookId? } with snake_case fallbacks. A plain string or
 * any other shape REFUSES the call (fail-closed, no guessing — a single
 * string cannot carry an OAuth2 client pair).
 */
export function extractPaypalDirectCredentialBundle(
  material: unknown,
): PaypalDirectCredentialMaterial {
  if (material !== null && typeof material === "object") {
    const record = material as Readonly<Record<string, unknown>>;
    const clientId = readNonEmptyString(record, ["clientId", "client_id"]);
    const clientSecret = readNonEmptyString(record, ["clientSecret", "client_secret"]);
    const webhookId = readNonEmptyString(record, ["webhookId", "webhook_id"]);
    if (clientId !== undefined && clientSecret !== undefined) {
      return Object.freeze({
        clientId,
        clientSecret,
        ...(webhookId !== undefined ? { webhookId } : {}),
      });
    }
  }
  throw new ValidationError(
    "the credential material does not contain a PayPal Direct OAuth2 client pair (expected { clientId, clientSecret, webhookId? } or snake_case equivalents — a single string cannot carry a client pair)",
  );
}

function readNonEmptyString(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Re-exported for convenience of certification surfaces: the honest datum
 * that this connector's availability answer is built on when no credential
 * exists (INV-C01/C02 — UNKNOWN with provenance, never success/failure).
 */
export const PAYPAL_DIRECT_FAIL_CLOSED_NOTE: Readonly<{
  readonly law: "INV-NC04";
  readonly behavior:
    "availability UNKNOWN (INV-C01/C02), health DEGRADED/UNKNOWN with explicit reasons, every effectful operation throws RailNotAuthorizedError BEFORE any provider call — NO mock, NO simulated outcome, EVER";
  readonly recordedReachability: typeof PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002;
}> = Object.freeze({
  law: "INV-NC04",
  behavior:
    "availability UNKNOWN (INV-C01/C02), health DEGRADED/UNKNOWN with explicit reasons, every effectful operation throws RailNotAuthorizedError BEFORE any provider call — NO mock, NO simulated outcome, EVER",
  recordedReachability: PAYPAL_DIRECT_SANDBOX_REACHABILITY_20261002,
});

// The honest fail-closed record above is byte-scannable for certification:
// no credential exists for PayPal Direct in this deployment, and this
// connector fabricates no substitute (INV-NC04).
