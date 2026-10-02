/**
 * Stripe production connector (P2-W2-001) — the REAL Stripe adapter on the
 * v1.5 capability hierarchy and ProviderStateEnvelope.
 *
 * Authority: spec/phase-2/work-items/P2-W2-001.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md and the LIVE probe
 * facts in spec/development-state/provider-probes-20261002.json (test-mode
 * account acct_1FPs7UAkPdhgtN6I, FR, sole_prop, charges_enabled; the
 * paypal-on-Stripe ELIGIBLE datum; the GHS negative datum). This module is
 * the production-grade sibling of `fiat.ts` (the provider-neutral
 * Stripe-SHAPE rail): same RailAdapter/ConnectorSDK framework, same
 * fail-closed credential gating, but speaking the REAL Stripe v1 REST API
 * over the injected HTTP transport — NO Stripe SDK, no ambient fetch in
 * unit-testable paths, no Stripe SDK types anywhere.
 *
 * Laws implemented here:
 * - INV-C06 (lossless): every provider object (PaymentIntent pi_*, Refund
 *   re_*, Dispute du_*, Payout po_*, Subscription sub_*, BalanceTransaction
 *   txn_*, webhook Event evt_*) is carried VERBATIM in the envelope `state`
 *   with an ADDITIVE classification. Provider statuses are never renamed,
 *   never dropped; UNKNOWN provider statuses stay `other`/verbatim.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (ambiguity
 *   OUTCOME_UNKNOWN, requires reconciliation) — NEVER collapsed to FAILED.
 * - INV-C09: /v1/balance and /v1/payouts produce ExternalFundsPosition
 *   Observations ONLY — observations of provider-held external funds, never
 *   PaySwap custody and never a balance PaySwap owes anyone.
 * - INV-NC04: no credential → availability UNKNOWN (INV-C01/C02), health
 *   DEGRADED/UNKNOWN with reasons, every effectful operation throws
 *   RailNotAuthorizedError BEFORE any provider call.
 * - Credential isolation (phase-2): key material is consumed through the
 *   P2-W1-001 control plane — `PROVIDER_STRIPE_CREDENTIAL_REF` bound to a
 *   vault:// reference, resolved through the CredentialBroker to a SEALED
 *   bundle opened only inside `withSealedBundle` with a ConnectorRuntimeKey.
 *   A direct env fallback (the W1-005 rails convention) exists for
 *   deployments that inject the resolved key under the same config key; the
 *   material NEVER enters any envelope, log line or evidence record.
 * - Scope is OBSERVED, not assumed: the account capability scope comes from
 *   a live GET /v1/account (or the recorded probe datum), and the negative
 *   GHS datum is encoded as a non-routable eligibility fact.
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
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
import type {
  ConnectedInstanceActivationState,
  CustomerActionRequirement,
} from "@payswap/connectors";
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
  railEnvelope,
  railEvidence,
  realHttpTransport,
  routableRailImplication,
  isoTimestamp,
} from "./support.js";
import type { HttpTransport, RailImplication } from "./support.js";

// ---------------------------------------------------------------------------
// Identity (pinned — the API version is part of the provider contract)
// ---------------------------------------------------------------------------

export const STRIPE_PROVIDER_NAME = "stripe" as const;
/**
 * The pinned Stripe API version (Stripe-Version header). Pinning is a
 * connector contract: an unpinned account default would make envelope
 * mappings version-dependent. Verified live 2026-10-02 against the connected
 * test account (probe record: spec/development-state/provider-probes-20261002.json).
 */
export const STRIPE_API_VERSION = "2025-08-27.basil" as const;
export const STRIPE_RAIL_ADAPTER_ID = "rail.stripe" as const;
export const STRIPE_RAIL_IMPLEMENTATION_ID = "impl.rails.stripe.2025-08-27.basil" as const;
export const STRIPE_CONNECTOR_ID = "connector.rails.stripe" as const;
export const STRIPE_DEFAULT_API_BASE = "https://api.stripe.com" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("stripe")` —
 * `PROVIDER_STRIPE_CREDENTIAL_REF`, bound to
 * `vault://payswap/providers/stripe/test-20261002`.
 */
export const STRIPE_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(STRIPE_PROVIDER_NAME);

// ---------------------------------------------------------------------------
// Capability definitions (consumed W2-003 vocabulary — never redefined)
// ---------------------------------------------------------------------------

export const STRIPE_PAYMENT_INTENT_CAPABILITY_ID = "cap.rails.stripe.payment_intent" as const;
export const STRIPE_REFUND_CAPABILITY_ID = "cap.rails.stripe.refund" as const;
export const STRIPE_DISPUTE_CAPABILITY_ID = "cap.rails.stripe.dispute" as const;
export const STRIPE_PAYOUT_OBSERVATION_CAPABILITY_ID =
  "cap.rails.stripe.payout_observation" as const;
export const STRIPE_SUBSCRIPTION_CAPABILITY_ID = "cap.rails.stripe.subscription" as const;
export const STRIPE_PAYPAL_ON_STRIPE_CAPABILITY_ID =
  "cap.rails.stripe.paypal_on_stripe" as const;

/**
 * The provider-state vocabulary this connector maps (INV-C06): every Stripe
 * PaymentIntent status with its additive classification. Exported as data so
 * certification/conformance surfaces can diff the mapping without reading
 * the implementation.
 */
export const STRIPE_PAYMENT_INTENT_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "requires_payment_method", family: "other", lifecycleStep: "requires_payment_method", isTerminal: false, requiresCustomerAction: false },
  { providerState: "requires_confirmation", family: "customer_action_required", lifecycleStep: "requires_confirmation", isTerminal: false, requiresCustomerAction: true },
  { providerState: "requires_action", family: "customer_action_required", lifecycleStep: "requires_action", isTerminal: false, requiresCustomerAction: true },
  { providerState: "processing", family: "async_processing", lifecycleStep: "processing", isTerminal: false, requiresCustomerAction: false },
  { providerState: "requires_capture", family: "capture", lifecycleStep: "requires_capture", isTerminal: false, requiresCustomerAction: false },
  { providerState: "succeeded", family: "other", lifecycleStep: "succeeded", isTerminal: true, requiresCustomerAction: false },
  { providerState: "canceled", family: "other", lifecycleStep: "canceled", isTerminal: true, requiresCustomerAction: false },
]);

function stripeCapabilityDefinition(input: {
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
      "credential reference provisioned through the control plane (PROVIDER_STRIPE_CREDENTIAL_REF)",
      "account capability scope observed active (GET /v1/account), not assumed",
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
      duplicateBehavior: "RETURNED_SAME_RESULT",
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
        { action: "confirm", description: "Confirm the PaymentIntent toward Stripe" },
        { action: "capture", description: "Capture a previously authorized (requires_capture) intent" },
        { action: "cancel", description: "Cancel an uncaptured intent" },
      ],
      states: input.providerStates,
    },
    externalObjects: input.externalObjects.map((object) => ({
      objectType: object.objectType,
      idFormat: object.idFormat,
      revisioned: true,
      revisionFormat: "provider-etag",
    })),
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "Stripe settlement schedule" },
    constraints: [],
  });
}

/** The canonical capability definitions consumed by the Stripe connector. */
export function stripeCapabilityDefinitions(): readonly CapabilityDefinition[] {
  const confirmAction = customerActionRequirement(
    "requires_confirmation",
    "CONFIRM_PAYMENT_INTENT",
    "Confirm the PaymentIntent so Stripe can run the payment (the intent was created unconfirmed)",
  );
  const challengeAction = customerActionRequirement(
    "requires_action",
    "PROVIDER_CHALLENGE",
    "Complete the Stripe-required customer challenge (e.g. 3-D Secure) before the payment can proceed",
  );
  return Object.freeze([
    stripeCapabilityDefinition({
      capabilityId: STRIPE_PAYMENT_INTENT_CAPABILITY_ID,
      summary: "Fiat collection through the real Stripe PaymentIntent lifecycle",
      operation: "rails.stripe.payment_intent.create_confirm_capture",
      description:
        "Create/confirm/capture/cancel Stripe PaymentIntents; asynchronous, customer-action-required and capture semantics preserved losslessly",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: STRIPE_PAYMENT_INTENT_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "payment_intent", idFormat: "pi_[A-Za-z0-9]+" }],
      sideEffects: [
        { effect: "moves payer value on confirmation", financialEffect: "MOVES_VALUE", reversible: false },
        { effect: "reserves authorized value until capture", financialEffect: "RESERVES_VALUE", reversible: true },
      ],
      requiredCustomerActions: [confirmAction, challengeAction],
    }),
    stripeCapabilityDefinition({
      capabilityId: STRIPE_REFUND_CAPABILITY_ID,
      summary: "Refunds (re_*) on Stripe charges/payment intents, with reconciliation queries",
      operation: "rails.stripe.refund.create_and_read",
      description:
        "Create and observe Stripe refunds; reconcile against balance transactions as provider evidence",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: [
        { providerState: "pending", canonicalState: "refund:pending", requiresCustomerAction: false, isTerminal: false },
        { providerState: "succeeded", canonicalState: "refund:succeeded", requiresCustomerAction: false, isTerminal: true },
        { providerState: "failed", canonicalState: "refund:failed", requiresCustomerAction: false, isTerminal: true },
        { providerState: "canceled", canonicalState: "refund:canceled", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "refund", idFormat: "re_[A-Za-z0-9]+" }],
      sideEffects: [
        { effect: "returns previously collected value to the payer", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    stripeCapabilityDefinition({
      capabilityId: STRIPE_DISPUTE_CAPABILITY_ID,
      summary: "Disputes (du_*) — chargeback lifecycle observation and reconciliation",
      operation: "rails.stripe.dispute.read_and_reconcile",
      description:
        "Observe Stripe dispute lifecycle states (needs_response/under_review/won/lost/…) and reconcile through balance-transaction evidence; PaySwap never creates disputes (only issuers do)",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      providerStates: [
        { providerState: "needs_response", canonicalState: "dispute:needs_response", requiresCustomerAction: true, isTerminal: false },
        { providerState: "warning_needs_response", canonicalState: "dispute:warning_needs_response", requiresCustomerAction: true, isTerminal: false },
        { providerState: "under_review", canonicalState: "dispute:under_review", requiresCustomerAction: false, isTerminal: false },
        { providerState: "warning_under_review", canonicalState: "dispute:warning_under_review", requiresCustomerAction: false, isTerminal: false },
        { providerState: "charge_refunded", canonicalState: "dispute:charge_refunded", requiresCustomerAction: false, isTerminal: true },
        { providerState: "unresolved", canonicalState: "dispute:unresolved", requiresCustomerAction: false, isTerminal: true },
        { providerState: "won", canonicalState: "dispute:won", requiresCustomerAction: false, isTerminal: true },
        { providerState: "lost", canonicalState: "dispute:lost", requiresCustomerAction: false, isTerminal: true },
        { providerState: "warning_closed", canonicalState: "dispute:warning_closed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "dispute", idFormat: "du_[A-Za-z0-9]+" }],
      sideEffects: [],
    }),
    stripeCapabilityDefinition({
      capabilityId: STRIPE_PAYOUT_OBSERVATION_CAPABILITY_ID,
      summary: "Payout/external-funds OBSERVATION on the Stripe account (never custody)",
      operation: "rails.stripe.payout.observe",
      description:
        "Observe the Stripe balance and payout lifecycle as ExternalFundsPositionObservations — external provider-held funds, never PaySwap custody (INV-C09)",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      providerStates: [
        { providerState: "paid", canonicalState: "payout:paid", requiresCustomerAction: false, isTerminal: true },
        { providerState: "pending", canonicalState: "payout:pending", requiresCustomerAction: false, isTerminal: false },
        { providerState: "in_transit", canonicalState: "payout:in_transit", requiresCustomerAction: false, isTerminal: false },
        { providerState: "canceled", canonicalState: "payout:canceled", requiresCustomerAction: false, isTerminal: true },
        { providerState: "failed", canonicalState: "payout:failed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "payout", idFormat: "po_[A-Za-z0-9]+" }],
      sideEffects: [],
    }),
    stripeCapabilityDefinition({
      capabilityId: STRIPE_SUBSCRIPTION_CAPABILITY_ID,
      summary: "Recurring subscriptions (sub_*) mapped to the mandate family",
      operation: "rails.stripe.subscription.create_and_read",
      description:
        "Create/cancel/observe Stripe subscriptions; recurring-debit authority preserved through the mandate state family (INV-C06)",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: [
        { providerState: "incomplete", canonicalState: "mandate:incomplete", requiresCustomerAction: true, isTerminal: false },
        { providerState: "incomplete_expired", canonicalState: "mandate:incomplete_expired", requiresCustomerAction: false, isTerminal: true },
        { providerState: "trialing", canonicalState: "mandate:trialing", requiresCustomerAction: false, isTerminal: false },
        { providerState: "active", canonicalState: "mandate:active", requiresCustomerAction: false, isTerminal: false },
        { providerState: "past_due", canonicalState: "mandate:past_due", requiresCustomerAction: true, isTerminal: false },
        { providerState: "canceled", canonicalState: "mandate:canceled", requiresCustomerAction: false, isTerminal: true },
        { providerState: "unpaid", canonicalState: "mandate:unpaid", requiresCustomerAction: true, isTerminal: false },
      ],
      externalObjects: [{ objectType: "subscription", idFormat: "sub_[A-Za-z0-9]+" }],
      sideEffects: [
        { effect: "collects recurring value under a customer-authorized mandate", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    stripeCapabilityDefinition({
      capabilityId: STRIPE_PAYPAL_ON_STRIPE_CAPABILITY_ID,
      summary: "PayPal settled through Stripe — DISTINCT from PayPal Direct (never conflated)",
      operation: "rails.stripe.paypal_on_stripe.payment_intent",
      description:
        "PayPal as a Stripe payment method (payment_method_types=[paypal]) on accounts where the eligibility probe says ELIGIBLE. This is a Stripe-settled capability: the provider is stripe, the funds settle in the Stripe balance — it is NOT the PayPal Direct provider (paypal-direct) and the two are never interchangeable in routing",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: STRIPE_PAYMENT_INTENT_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "payment_intent", idFormat: "pi_[A-Za-z0-9]+" }],
      sideEffects: [
        { effect: "moves payer value on confirmation (settled into the Stripe balance)", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      requiredCustomerActions: [
        customerActionRequirement(
          "requires_action",
          "PROVIDER_CHALLENGE_REDIRECT",
          "Complete the PayPal authorization redirect Stripe requires for the payer",
        ),
      ],
    }),
  ]);
}

/** The connector capability pack backing the Stripe rail (payments family). */
export function stripeRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.stripe",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: stripeCapabilityDefinitions().map((definition) => ({
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
    })),
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "payments:read"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.stripe.provider_state", version: "1.0.0" }],
    objectMappings: [
      {
        externalObjectType: "payment_intent",
        canonicalObjectRef: "payswap:payment",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "refund",
        canonicalObjectRef: "payswap:refund",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "dispute",
        canonicalObjectRef: "payswap:dispute",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "payout",
        canonicalObjectRef: "payswap:external_funds_observation",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "subscription",
        canonicalObjectRef: "payswap:recurring_mandate",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 100, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-stripe-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Observed account scope + eligibility facts (observed, never assumed)
// ---------------------------------------------------------------------------

/**
 * The account capability scope OBSERVED on the connected account (from
 * GET /v1/account or the recorded probe datum). A capability's status is
 * whatever the provider reported — `active`, `pending`, `inactive` or any
 * other provider-declared value, preserved verbatim.
 */
export interface StripeAccountCapabilityScope {
  readonly accountId: string;
  readonly country?: string;
  readonly businessType?: string;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean | null;
  readonly livemode: boolean;
  readonly defaultCurrency?: string;
  /** Provider-declared capability statuses, verbatim (observed, not assumed). */
  readonly capabilities: Readonly<Record<string, string>>;
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "OPERATOR";
}

/** The raw Stripe account object as observed (opaque passthrough). */
export interface StripeAccountProviderObject {
  readonly id: string;
  readonly charges_enabled?: boolean;
  readonly payouts_enabled?: boolean | null;
  readonly livemode?: boolean;
  readonly country?: string;
  readonly business_type?: string;
  readonly default_currency?: string;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** The raw Stripe balance object as observed (opaque passthrough). */
export interface StripeBalanceProviderObject {
  readonly object?: string;
  readonly available?: readonly {
    readonly amount?: number;
    readonly currency?: string;
  }[];
  readonly pending?: readonly {
    readonly amount?: number;
    readonly currency?: string;
  }[];
  readonly [key: string]: unknown;
}

/** The raw Stripe payout object as observed (opaque passthrough). */
export interface StripePayoutProviderObject {
  readonly id: string;
  readonly status?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly destination?: string;
  readonly arrival_date?: number;
  readonly created?: number;
  readonly [key: string]: unknown;
}

/** The raw Stripe PaymentIntent as observed (opaque passthrough). */
export interface StripePaymentIntentProviderObject {
  readonly id: string;
  readonly status: string;
  readonly currency?: string;
  readonly amount?: number;
  readonly amount_received?: number;
  readonly client_secret?: string;
  readonly latest_charge?: string;
  readonly next_action?: {
    readonly type?: string;
    readonly redirect_to_url?: { readonly url?: string };
  };
  readonly last_payment_error?: { readonly code?: string; readonly message?: string };
  readonly [key: string]: unknown;
}

/** The raw Stripe refund as observed (opaque passthrough). */
export interface StripeRefundProviderObject {
  readonly id: string;
  readonly status?: string;
  readonly payment_intent?: string;
  readonly charge?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

/** The raw Stripe dispute as observed (opaque passthrough). */
export interface StripeDisputeProviderObject {
  readonly id: string;
  readonly status?: string;
  readonly payment_intent?: string;
  readonly charge?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly [key: string]: unknown;
}

/** The raw Stripe subscription as observed (opaque passthrough). */
export interface StripeSubscriptionProviderObject {
  readonly id: string;
  readonly status?: string;
  readonly customer?: string;
  readonly latest_invoice?: string;
  readonly [key: string]: unknown;
}

/** The raw Stripe balance transaction as observed (opaque passthrough). */
export interface StripeBalanceTransactionProviderObject {
  readonly id: string;
  readonly type?: string;
  readonly amount?: number;
  readonly net?: number;
  readonly currency?: string;
  readonly source?: string;
  readonly [key: string]: unknown;
}

/**
 * Derives the OBSERVED account capability scope from a live GET /v1/account
 * response. Capability values are preserved verbatim (string statuses in the
 * pinned API version; objects with a `status` field are reduced to that
 * status so older/newer shapes both stay observable).
 */
export function stripeAccountCapabilityScope(
  account: StripeAccountProviderObject,
  observedAt: string,
  provenanceSource: "PROVIDER_API" | "OPERATOR" = "PROVIDER_API",
): StripeAccountCapabilityScope {
  const capabilities: Record<string, string> = {};
  const raw = account.capabilities ?? {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === "string") {
      capabilities[key] = value;
    } else if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { readonly status?: unknown }).status === "string"
    ) {
      capabilities[key] = (value as { readonly status: string }).status;
    }
    // Any other shape stays unobserved (never guessed).
  }
  return Object.freeze({
    accountId: account.id,
    ...(account.country !== undefined ? { country: account.country } : {}),
    ...(account.business_type !== undefined ? { businessType: account.business_type } : {}),
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled:
      account.payouts_enabled === true || account.payouts_enabled === false
        ? account.payouts_enabled
        : null,
    livemode: account.livemode === true,
    ...(account.default_currency !== undefined
      ? { defaultCurrency: account.default_currency }
      : {}),
    capabilities: Object.freeze(capabilities),
    observedAt,
    provenanceSource,
  });
}

/**
 * The RECORDED probe datum for the connected test account (2026-10-02) —
 * the live-observed scope at connector-writing time. The connector NEVER
 * assumes this: it re-observes through GET /v1/account; this record exists
 * so eligibility surfaces have evidence provenance when no fresh probe ran.
 */
export const STRIPE_PROBED_ACCOUNT_SCOPE_20261002: StripeAccountCapabilityScope =
  stripeAccountCapabilityScope(
    Object.freeze({
      id: "acct_1FPs7UAkPdhgtN6I",
      country: "FR",
      business_type: "sole_prop",
      charges_enabled: true,
      payouts_enabled: null,
      livemode: false,
      default_currency: "usd",
      capabilities: Object.freeze({
        bancontact_payments: "active",
        blik_payments: "active",
        card_payments: "active",
        cartes_bancaires_payments: "pending",
        eps_payments: "active",
        giropay_payments: "active",
        ideal_payments: "active",
        klarna_payments: "active",
        link_payments: "active",
        p24_payments: "active",
        sepa_debit_payments: "inactive",
        sofort_payments: "active",
        transfers: "active",
      }),
    }),
    "2026-10-02T06:37:38Z",
    "OPERATOR",
  );

/**
 * PayPal-on-Stripe eligibility datum — ELIGIBLE on the connected account,
 * proven by the 2026-10-02 live probe. Structurally DISTINCT from PayPal
 * Direct: different provider name (stripe vs paypal-direct), different
 * capability id, different settlement (Stripe balance). Never conflated.
 */
export const STRIPE_PAYPAL_ON_STRIPE_ELIGIBILITY: {
  readonly eligible: true;
  readonly probedAt: string;
  readonly probe: string;
  readonly probeExternalId: string;
  readonly distinctFrom: "paypal_direct";
  readonly note: string;
} = Object.freeze({
  eligible: true,
  probedAt: "2026-10-02T06:37:38Z",
  probe: "test-mode PaymentIntent payment_method_types=[paypal] accepted, then canceled",
  probeExternalId: "pi_3UM04TAkPdhgtN6I0CQcJZZg",
  distinctFrom: "paypal_direct",
  note:
    "Stripe-settled PayPal (the provider is stripe; funds land in the Stripe balance). PayPal Direct is a SEPARATE provider/capability (paypal-direct, P2-W3-001 scope) — the two are never interchangeable in routing, comparison or fallback",
});

/**
 * The GHS negative datum — a NON-ROUTABLE eligibility fact on this account.
 * Probed live 2026-10-02: Stripe rejects GHS PaymentIntents for FR accounts
 * with "Stripe accounts in FR do not support ghs". Ghana-local collection
 * routes via Paystack/Flutterwave/MTN (see the coverage matrix).
 */
export const STRIPE_GHS_ELIGIBILITY: {
  readonly currency: "GHS";
  readonly eligible: false;
  readonly probedAt: string;
  readonly providerError: string;
  readonly routingNote: string;
} = Object.freeze({
  currency: "GHS",
  eligible: false,
  probedAt: "2026-10-02T06:37:38Z",
  providerError: "Stripe accounts in FR do not support ghs",
  routingNote:
    "Ghana-local collection is non-routable on this Stripe account — route via Paystack/Flutterwave/MTN (coverage-matrix negative datum)",
});

/** The currency eligibility verdict for one observed account scope. */
export interface StripeCurrencyEligibility {
  readonly currency: string;
  readonly eligible: boolean;
  /** "NEGATIVE_DATUM" (probe-proven not routable) | "ACTIVE_CAPABILITY" | "UNKNOWN" (never assumed). */
  readonly basis: "NEGATIVE_DATUM" | "ACTIVE_CAPABILITY" | "UNKNOWN";
  readonly reason: string;
}

/**
 * Currency eligibility against an OBSERVED account scope. Only two positive
 * derivations exist: the probe-proven negative datum (GHS on the recorded
 * account) and an active `*_payments` capability implying the currency's
 * payment method family. Everything else is UNKNOWN — never assumed
 * eligible, never assumed ineligible.
 */
export function stripeCurrencyEligibility(
  currency: string,
  scope: StripeAccountCapabilityScope = STRIPE_PROBED_ACCOUNT_SCOPE_20261002,
): StripeCurrencyEligibility {
  const upper = currency.toUpperCase();
  if (
    scope.accountId === STRIPE_PROBED_ACCOUNT_SCOPE_20261002.accountId &&
    upper === "GHS"
  ) {
    return Object.freeze({
      currency: upper,
      eligible: false,
      basis: "NEGATIVE_DATUM",
      reason: `${STRIPE_GHS_ELIGIBILITY.providerError} (negative probe datum ${STRIPE_GHS_ELIGIBILITY.probedAt}; account ${scope.accountId})`,
    });
  }
  // Card payments are the account's universal method: an active card_payments
  // capability makes charge-supported currencies routable at the card family.
  if (scope.capabilities["card_payments"] === "active" && scope.chargesEnabled) {
    return Object.freeze({
      currency: upper,
      eligible: true,
      basis: "ACTIVE_CAPABILITY",
      reason: `card_payments active and charges enabled on observed account ${scope.accountId} (observed ${scope.observedAt}; card-family currencies routable — method-specific confirmation stays with the provider)`,
    });
  }
  return Object.freeze({
    currency: upper,
    eligible: false,
    basis: "UNKNOWN",
    reason:
      "no active card_payments capability in the OBSERVED scope and no recorded datum — eligibility UNKNOWN, never assumed (INV-NC04)",
  });
}

/**
 * Raised when an effectful operation targets a currency the observed scope
 * proves non-routable (the GHS negative datum) — refused BEFORE any
 * provider call.
 */
export class StripeIneligibleCurrencyError extends PaySwapError {
  constructor(message: string, details?: PaySwapError["details"]) {
    super({
      code: "RAIL_CURRENCY_NOT_ELIGIBLE",
      category: "POLICY_BLOCKED",
      message,
      details,
    });
    this.name = "StripeIneligibleCurrencyError";
  }
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object)
// ---------------------------------------------------------------------------

/** PaymentIntent revision: id + status + latest charge (status revision). */
export function stripePaymentIntentRevision(intent: StripePaymentIntentProviderObject): string {
  const charge =
    typeof intent.latest_charge === "string" ? intent.latest_charge : "no_charge";
  return `${intent.id}:${intent.status}:${charge}`;
}

/** Refund revision: id + status. */
export function stripeRefundRevision(refund: StripeRefundProviderObject): string {
  return `${refund.id}:${refund.status ?? "unknown"}`;
}

/** Dispute revision: id + status. */
export function stripeDisputeRevision(dispute: StripeDisputeProviderObject): string {
  return `${dispute.id}:${dispute.status ?? "unknown"}`;
}

/** Payout revision: id + status. */
export function stripePayoutRevision(payout: StripePayoutProviderObject): string {
  return `${payout.id}:${payout.status ?? "unknown"}`;
}

/** Subscription revision: id + status. */
export function stripeSubscriptionRevision(
  subscription: StripeSubscriptionProviderObject,
): string {
  return `${subscription.id}:${subscription.status ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface StripeEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK";
  readonly fetchId?: string;
}

function stripeEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: StripeEnvelopeContext,
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
    providerName: STRIPE_PROVIDER_NAME,
    providerVersion: STRIPE_API_VERSION,
    objectType,
    externalId,
    revision,
    state,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
}

/** Envelope shareable-field surface for Stripe provider objects. */
const STRIPE_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "status",
  "id",
  "amount",
  "currency",
  "latest_charge",
]);

/**
 * Deterministic, additive classification of a Stripe PaymentIntent into a
 * lossless ProviderStateEnvelope (INV-C06). The RAW intent is carried
 * VERBATIM as `state`. Mapping (recorded in STRIPE_PAYMENT_INTENT_STATUS_MAPPING):
 *
 * | Stripe status            | family                   | isTerminal | requiresCustomerAction |
 * |--------------------------|--------------------------|------------|------------------------|
 * | requires_payment_method  | other                    | false      | false                  |
 * | requires_confirmation    | customer_action_required | false      | true                   |
 * | requires_action          | customer_action_required | false      | true                   |
 * | processing               | async_processing         | false      | false                  |
 * | requires_capture         | capture                  | false      | false                  |
 * | succeeded                | other                    | true       | false                  |
 * | canceled                 | other                    | true       | false                  |
 * | (unknown)                | other                    | false      | false (verbatim step)  |
 *
 * `requires_confirmation` is classified customer_action_required in the REAL
 * connector (a deliberate, documented divergence from the provider-neutral
 * stripe-SHAPE rail `fiat.ts`: on the real provider an unconfirmed intent
 * means the customer-facing confirmation step has not run — a first-class
 * CustomerActionRequirement, not an inert intermediate state).
 * `canceled` carries failure {retryable: false, ambiguity: NONE} — a
 * definitive no-effect outcome with the raw status preserved verbatim.
 */
export function stripePaymentIntentEnvelope(
  intent: StripePaymentIntentProviderObject,
  context: StripeEnvelopeContext,
): ProviderStateEnvelope {
  const base = stripeEnvelopeBase(
    "payment_intent",
    intent.id,
    stripePaymentIntentRevision(intent),
    intent,
    context,
  );
  switch (intent.status) {
    case "requires_confirmation":
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: "requires_confirmation",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "CONFIRM_PAYMENT_INTENT",
          message:
            "Confirm the PaymentIntent so Stripe can run the payment (the intent was created unconfirmed)",
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "requires_action":
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: "requires_action",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind:
            intent.next_action?.type === "redirect_to_url"
              ? "PROVIDER_CHALLENGE_REDIRECT"
              : "PROVIDER_CHALLENGE",
          message:
            intent.next_action?.type === "redirect_to_url"
              ? "Complete the Stripe-required challenge at the redirect URL (e.g. 3-D Secure or PayPal authorization)"
              : "Complete the Stripe-required customer challenge (e.g. 3-D Secure)",
          ...(intent.next_action?.redirect_to_url?.url !== undefined
            ? { deepLink: intent.next_action.redirect_to_url.url }
            : {}),
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "processing":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "processing",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "requires_capture":
      return railEnvelope({
        ...base,
        family: "capture",
        lifecycleStep: "requires_capture",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "succeeded":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "succeeded",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
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
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    default:
      // requires_payment_method / any UNKNOWN provider status: preserved
      // VERBATIM under the total 'other' family — never dropped, never
      // guessed, never collapsed (INV-C06/INV-X01).
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: intent.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
  }
}

/** First-class customer-action requirement derived from a PI envelope. */
export function stripePaymentIntentCustomerAction(
  intent: StripePaymentIntentProviderObject,
): CustomerActionRequirement | undefined {
  switch (intent.status) {
    case "requires_confirmation":
      return customerActionRequirement(
        "requires_confirmation",
        "CONFIRM_PAYMENT_INTENT",
        "Confirm the PaymentIntent so Stripe can run the payment",
      );
    case "requires_action":
      return customerActionRequirement(
        "requires_action",
        intent.next_action?.type === "redirect_to_url"
          ? "PROVIDER_CHALLENGE_REDIRECT"
          : "PROVIDER_CHALLENGE",
        "Complete the Stripe-required customer challenge before the payment can proceed",
      );
    default:
      return undefined;
  }
}

/**
 * Stripe Refund (re_*) → refund-family envelope. `succeeded`/`failed`/
 * `canceled` are terminal; `pending` is asynchronous; unknown statuses stay
 * verbatim under the refund family with no invented terminality.
 */
export function stripeRefundEnvelope(
  refund: StripeRefundProviderObject,
  context: StripeEnvelopeContext,
): ProviderStateEnvelope {
  const base = stripeEnvelopeBase(
    "refund",
    refund.id,
    stripeRefundRevision(refund),
    refund,
    context,
  );
  switch (refund.status) {
    case "pending":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "pending",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "succeeded":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "succeeded",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "failed":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "failed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "refund_failed",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "canceled":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "canceled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "refund_canceled",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: refund.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
  }
}

/**
 * Stripe Dispute (du_*) → dispute-family envelope. `needs_response`/
 * `warning_needs_response` are first-class customer-action-required states
 * (the connected merchant must submit evidence) — the family stays
 * `dispute` (provider-object family) while `requiresCustomerAction` and
 * `actionRequired` carry the merchant-action surface (INV-C06: family and
 * action flag are additive, independent dimensions).
 */
export function stripeDisputeEnvelope(
  dispute: StripeDisputeProviderObject,
  context: StripeEnvelopeContext,
): ProviderStateEnvelope {
  const base = stripeEnvelopeBase(
    "dispute",
    dispute.id,
    stripeDisputeRevision(dispute),
    dispute,
    context,
  );
  const needsResponse = customerActionRequirement(
    dispute.status ?? "needs_response",
    "DISPUTE_EVIDENCE_REQUIRED",
    "Submit dispute evidence before the provider deadline or the dispute is lost",
  );
  switch (dispute.status) {
    case "needs_response":
    case "warning_needs_response":
      return railEnvelope({
        ...base,
        family: "dispute",
        lifecycleStep: dispute.status,
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "DISPUTE_EVIDENCE_REQUIRED",
          message: needsResponse.message,
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "under_review":
    case "warning_under_review":
      return railEnvelope({
        ...base,
        family: "dispute",
        lifecycleStep: dispute.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "charge_refunded":
    case "unresolved":
    case "won":
    case "lost":
    case "warning_closed":
      return railEnvelope({
        ...base,
        family: "dispute",
        lifecycleStep: dispute.status,
        isTerminal: true,
        requiresCustomerAction: false,
        ...(dispute.status === "lost"
          ? {
              failure: {
                providerErrorCode: "dispute_lost",
                retryable: false,
                ambiguity: "NONE" as const,
              },
            }
          : {}),
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "dispute",
        lifecycleStep: dispute.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
  }
}

/** Stripe Payout (po_*) → payout-family envelope (external funds movement). */
export function stripePayoutEnvelope(
  payout: StripePayoutProviderObject,
  context: StripeEnvelopeContext,
): ProviderStateEnvelope {
  const base = stripeEnvelopeBase(
    "payout",
    payout.id,
    stripePayoutRevision(payout),
    payout,
    context,
  );
  switch (payout.status) {
    case "paid":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "paid",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "pending":
    case "in_transit":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: payout.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "canceled":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "canceled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payout_canceled",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "failed":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "failed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payout_failed",
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: payout.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
  }
}

/**
 * Stripe Subscription (sub_*) → mandate-family envelope. `incomplete`/
 * `past_due`/`unpaid` are first-class customer-action-required states (the
 * payer must complete the first authorization / update the payment method);
 * `canceled`/`incomplete_expired` are terminal.
 */
export function stripeSubscriptionEnvelope(
  subscription: StripeSubscriptionProviderObject,
  context: StripeEnvelopeContext,
): ProviderStateEnvelope {
  const base = stripeEnvelopeBase(
    "subscription",
    subscription.id,
    stripeSubscriptionRevision(subscription),
    subscription,
    context,
  );
  switch (subscription.status) {
    case "incomplete":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "incomplete",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "MANDATE_CONFIRMATION_REQUIRED",
          message:
            "Complete the first-payment authorization (e.g. 3-D Secure) so the subscription mandate can activate",
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "incomplete_expired":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "incomplete_expired",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "subscription_incomplete_expired",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "trialing":
    case "active":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: subscription.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "past_due":
    case "unpaid":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: subscription.status,
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "MANDATE_PAYMENT_REQUIRED",
          message:
            "The recurring payment failed — the payer must complete payment (update the payment method or approve the retry) before the mandate resumes",
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    case "canceled":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "canceled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "subscription_canceled",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: subscription.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: STRIPE_SHAREABLE_FIELDS,
      });
  }
}

/**
 * Stripe BalanceTransaction (txn_*) → reconciliation-evidence envelope. The
 * family follows the transaction's effect on the linked object: `refund`
 * entries map to the refund family, `dispute`/adjustment entries to the
 * dispute family, everything else stays `other` (lossless: the raw
 * transaction is carried verbatim either way).
 */
export function stripeBalanceTransactionEnvelope(
  transaction: StripeBalanceTransactionProviderObject,
  context: StripeEnvelopeContext,
): ProviderStateEnvelope {
  const base = stripeEnvelopeBase(
    "balance_transaction",
    transaction.id,
    `${transaction.id}:${transaction.type ?? "unknown"}`,
    transaction,
    context,
  );
  const family =
    transaction.type === "refund"
      ? ("refund" as const)
      : transaction.type === "dispute" || transaction.type === "dispute_reversal"
        ? ("dispute" as const)
        : transaction.type === "payout" || transaction.type === "payout_cancel" ||
            transaction.type === "payout_failure"
          ? ("payout" as const)
          : ("other" as const);
  return railEnvelope({
    ...base,
    family,
    lifecycleStep: transaction.type ?? "unknown",
    isTerminal: true,
    requiresCustomerAction: false,
    shareableFields: STRIPE_SHAREABLE_FIELDS,
  });
}

/**
 * Maps a Stripe webhook event payload ({ id: "evt_...", type, data: { object } })
 * to the lossless envelope for its inner object. Unknown/unmapped event types
 * produce an `event`-typed envelope carrying the WHOLE event verbatim —
 * nothing is dropped (INV-C06).
 */
export function stripeWebhookEventEnvelope(
  event: {
    readonly id?: string;
    readonly type?: string;
    readonly data?: { readonly object?: unknown };
    readonly [key: string]: unknown;
  },
  context: StripeEnvelopeContext,
): ProviderStateEnvelope {
  const inner = event.data?.object;
  const webhookContext: StripeEnvelopeContext = {
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
  if (event.type !== undefined && inner !== null && typeof inner === "object") {
    if (event.type.startsWith("payment_intent.")) {
      const intent = inner as StripePaymentIntentProviderObject;
      if (typeof intent.id === "string" && typeof intent.status === "string") {
        return stripePaymentIntentEnvelope(intent, webhookContext);
      }
    }
    if (event.type.startsWith("charge.refund.") || event.type === "refund.updated") {
      const refund = inner as StripeRefundProviderObject;
      if (typeof refund.id === "string") {
        return stripeRefundEnvelope(refund, webhookContext);
      }
    }
    if (event.type.startsWith("charge.dispute.")) {
      const dispute = inner as StripeDisputeProviderObject;
      if (typeof dispute.id === "string") {
        return stripeDisputeEnvelope(dispute, webhookContext);
      }
    }
    if (event.type.startsWith("payout.")) {
      const payout = inner as StripePayoutProviderObject;
      if (typeof payout.id === "string") {
        return stripePayoutEnvelope(payout, webhookContext);
      }
    }
    if (event.type.startsWith("customer.subscription.")) {
      const subscription = inner as StripeSubscriptionProviderObject;
      if (typeof subscription.id === "string") {
        return stripeSubscriptionEnvelope(subscription, webhookContext);
      }
    }
  }
  return railEnvelope({
    providerName: STRIPE_PROVIDER_NAME,
    providerVersion: STRIPE_API_VERSION,
    objectType: "event",
    externalId: event.id ?? `evt_unknown:${event.type ?? "untyped"}`,
    revision: `${event.id ?? "unknown"}:${event.type ?? "untyped"}`,
    state: event,
    family: "other",
    lifecycleStep: event.type ?? "untyped",
    isTerminal: false,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    shareableFields: STRIPE_SHAREABLE_FIELDS,
  });
}

// ---------------------------------------------------------------------------
// External funds observations (INV-C09 — observations, NEVER custody)
// ---------------------------------------------------------------------------

/**
 * Maps a GET /v1/balance response to ExternalFundsPositionObservations — one
 * per (bucket, currency). These are observations of PROVIDER-HELD funds on
 * the connected account: they are NOT PaySwap custody, NOT a balance PaySwap
 * owes anyone, and cannot create a false PaySwap balance (nominal
 * observationKind brand + mandatory freshness/provenance).
 */
export function stripeBalanceObservations(input: {
  readonly balance: StripeBalanceProviderObject;
  readonly accountRef: string;
  readonly observedAt: string;
  /** Consumer-side maximum tolerated age for these observations. */
  readonly maxAgeSeconds?: number;
  readonly observationIdPrefix?: string;
}): readonly ExternalFundsPositionObservation[] {
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  const prefix = input.observationIdPrefix ?? "stripe-balance";
  const observations: ExternalFundsPositionObservation[] = [];
  for (const bucket of ["available", "pending"] as const) {
    const entries = input.balance[bucket] ?? [];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.amount !== "number" ||
        typeof entry.currency !== "string" ||
        entry.currency.length === 0
      ) {
        continue;
      }
      observations.push(
        Object.freeze({
          observationKind: "ExternalFundsPositionObservation" as const,
          observationId: `${prefix}:${bucket}:${entry.currency}`,
          observedAt: input.observedAt,
          freshness: Object.freeze({
            asOf: input.observedAt,
            maxAgeSeconds,
          }),
          location: Object.freeze({
            providerName: STRIPE_PROVIDER_NAME,
            accountRef: input.accountRef,
            instrumentRef: `balance:${bucket}`,
            description: `Stripe ${bucket} balance (provider-held external funds — observation, never custody)`,
          }),
          observedAmount: Object.freeze({
            currency: entry.currency.toUpperCase(),
            minorUnits: String(entry.amount),
          }),
          provenance: Object.freeze({
            providerName: STRIPE_PROVIDER_NAME,
            source: "PROVIDER_API" as const,
            capturedAt: input.observedAt,
          }),
          reconciliationState: "NOT_RECONCILED" as const,
        }),
      );
    }
  }
  return Object.freeze(observations);
}

/**
 * Maps Stripe payouts to ExternalFundsPositionObservations — the funds
 * movement the provider reports (to the destination bank account), observed
 * per payout. Never custody; a payout observation asserts nothing about
 * PaySwap-held value.
 */
export function stripePayoutObservations(input: {
  readonly payouts: readonly StripePayoutProviderObject[];
  readonly accountRef: string;
  readonly observedAt: string;
  readonly maxAgeSeconds?: number;
  readonly observationIdPrefix?: string;
}): readonly ExternalFundsPositionObservation[] {
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  const prefix = input.observationIdPrefix ?? "stripe-payout";
  const observations: ExternalFundsPositionObservation[] = [];
  for (const payout of input.payouts) {
    if (
      typeof payout.amount !== "number" ||
      typeof payout.currency !== "string" ||
      payout.currency.length === 0
    ) {
      continue;
    }
    const asOf =
      typeof payout.arrival_date === "number" && payout.arrival_date > 0
        ? isoTimestamp(BigInt(payout.arrival_date) * 1000n)
        : input.observedAt;
    observations.push(
      Object.freeze({
        observationKind: "ExternalFundsPositionObservation" as const,
        observationId: `${prefix}:${payout.id}`,
        observedAt: input.observedAt,
        freshness: Object.freeze({
          asOf,
          maxAgeSeconds,
        }),
        location: Object.freeze({
          providerName: STRIPE_PROVIDER_NAME,
          accountRef: input.accountRef,
          ...(typeof payout.destination === "string"
            ? { instrumentRef: `payout:${payout.id}->${payout.destination}` }
            : { instrumentRef: `payout:${payout.id}` }),
          description: `Stripe payout in state '${payout.status ?? "unknown"}' (external funds movement — observation, never custody)`,
        }),
        observedAmount: Object.freeze({
          currency: payout.currency.toUpperCase(),
          minorUnits: String(payout.amount),
        }),
        provenance: Object.freeze({
          providerName: STRIPE_PROVIDER_NAME,
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
// Webhook verification (Stripe-Signature scheme)
// ---------------------------------------------------------------------------

/** Default replay tolerance window (seconds) — matches Stripe's documented 5-minute default. */
export const STRIPE_WEBHOOK_DEFAULT_TOLERANCE_SECONDS = 300;

/** Deterministic Stripe webhook signature: HMAC-SHA256 over `${t}.${payload}`. */
export function stripeSignWebhookPayload(
  secret: string,
  timestamp: string,
  rawPayload: string,
): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.${rawPayload}`);
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

/** A parsed Stripe-Signature header (`t=<ts>,v1=<hex>[,v1=<hex>…]`). */
export interface ParsedStripeSignatureHeader {
  readonly timestamp: string;
  readonly signatures: readonly string[];
}

/** Parses a Stripe-Signature header value into its t=/v1= elements. */
export function parseStripeSignatureHeader(header: string): ParsedStripeSignatureHeader | undefined {
  if (typeof header !== "string" || header.length === 0) {
    return undefined;
  }
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const element of header.split(",")) {
    const trimmed = element.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const prefix = trimmed.substring(0, separator);
    const value = trimmed.substring(separator + 1);
    if (prefix === "t" && timestamp === undefined) {
      timestamp = value;
    } else if (prefix === "v1" && value.length > 0) {
      signatures.push(value);
    }
  }
  if (timestamp === undefined || timestamp.length === 0 || signatures.length === 0) {
    return undefined;
  }
  return Object.freeze({ timestamp, signatures: Object.freeze(signatures) });
}

/** The byte-exact verification result for one Stripe webhook delivery. */
export type StripeWebhookDeliveryVerification =
  | { readonly valid: true; readonly timestamp: string }
  | {
      readonly valid: false;
      readonly reason:
        | "MALFORMED_SIGNATURE_HEADER"
        | "TIMESTAMP_OUTSIDE_TOLERANCE"
        | "FUTURE_TIMESTAMP"
        | "SIGNATURE_INVALID";
    };

/**
 * Byte-exact Stripe webhook delivery verification (the primitive for real
 * deliveries, where Stripe signs the RAW payload bytes):
 * - parses the `Stripe-Signature` header (`t=<epoch>,v1=<hex>…` — multiple
 *   v1 entries are honored: Stripe emits them during webhook-secret
 *   rotation, ANY matching v1 is valid);
 * - enforces the tolerance window around `nowMs` (stale → outside tolerance;
 *   unreasonably future → future timestamp);
 * - verifies HMAC-SHA256(`${t}.${rawPayload}`, secret) with a constant-time
 *   compare against every v1.
 */
export function verifyStripeWebhookDelivery(
  delivery: { readonly signatureHeader: string; readonly rawPayload: string },
  deps: { readonly secret: string; readonly nowMs: number; readonly toleranceSeconds?: number },
): StripeWebhookDeliveryVerification {
  const parsed = parseStripeSignatureHeader(delivery.signatureHeader);
  if (parsed === undefined) {
    return { valid: false, reason: "MALFORMED_SIGNATURE_HEADER" };
  }
  const eventSeconds = Number(parsed.timestamp);
  if (!Number.isFinite(eventSeconds)) {
    return { valid: false, reason: "MALFORMED_SIGNATURE_HEADER" };
  }
  const nowSeconds = deps.nowMs / 1000;
  const tolerance = deps.toleranceSeconds ?? STRIPE_WEBHOOK_DEFAULT_TOLERANCE_SECONDS;
  const futureSkew = 5;
  if (eventSeconds > nowSeconds + futureSkew) {
    return { valid: false, reason: "FUTURE_TIMESTAMP" };
  }
  if (nowSeconds - eventSeconds > tolerance) {
    return { valid: false, reason: "TIMESTAMP_OUTSIDE_TOLERANCE" };
  }
  const expected = stripeSignWebhookPayload(deps.secret, parsed.timestamp, delivery.rawPayload);
  const anyMatch = parsed.signatures.some((signature) =>
    constantTimeHexEquals(signature, expected),
  );
  if (!anyMatch) {
    return { valid: false, reason: "SIGNATURE_INVALID" };
  }
  return { valid: true, timestamp: parsed.timestamp };
}

/**
 * Adapts a verified Stripe delivery into the adapters' ProviderWebhookRawEvent
 * (the ingestor's dedupe key is the provider event id; the timestamp is the
 * header's t= so the ingestor's replay window and the signature window agree).
 */
export function stripeWebhookRawEvent(delivery: {
  readonly eventId: string;
  readonly payload: unknown;
  readonly signatureHeader: string;
}): ProviderWebhookRawEvent | undefined {
  const parsed = parseStripeSignatureHeader(delivery.signatureHeader);
  if (parsed === undefined) {
    return undefined;
  }
  return Object.freeze({
    providerName: STRIPE_PROVIDER_NAME,
    eventId: delivery.eventId,
    timestamp: parsed.timestamp,
    payload: delivery.payload,
    headers: Object.freeze({ signature: delivery.signatureHeader, timestamp: parsed.timestamp }),
  });
}

/**
 * The Stripe signature verifier on the adapters' WebhookSignatureVerifier
 * hook. The ingestor hands the CANONICAL body (JSON.stringify of the parsed
 * payload): verification succeeds exactly when the canonical serialization
 * equals the delivered bytes (the transport must preserve the raw body; use
 * {@link verifyStripeWebhookDelivery} for byte-exact verification of raw
 * deliveries).
 */
export class StripeWebhookVerifier implements WebhookSignatureVerifier {
  readonly #secret: string;

  constructor(secret: string) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new ValidationError("a Stripe webhook verifier requires a non-empty secret");
    }
    this.#secret = secret;
  }

  verify(
    event: ProviderWebhookRawEvent,
    canonicalBody: string,
  ): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
    const parsed = parseStripeSignatureHeader(event.headers.signature);
    if (parsed === undefined) {
      return { valid: false, reason: "SIGNATURE_INVALID" };
    }
    const expected = stripeSignWebhookPayload(this.#secret, parsed.timestamp, canonicalBody);
    const anyMatch = parsed.signatures.some((signature) =>
      constantTimeHexEquals(signature, expected),
    );
    return anyMatch ? { valid: true } : { valid: false, reason: "SIGNATURE_INVALID" };
  }
}

/**
 * Wires a ProviderWebhookIngestor for Stripe: Stripe-Signature verification,
 * replay window, (provider, eventId) dedupe and append-only evidence — the
 * adapters ingestor pattern with the Stripe scheme plugged in.
 */
export function createStripeWebhookIngestor(deps: {
  readonly secret: string;
  readonly clock: ProtocolClock;
  readonly replayWindowSeconds?: number;
  readonly futureSkewSeconds?: number;
}): ProviderWebhookIngestor {
  return new WebhookIngestor({
    verifier: new StripeWebhookVerifier(deps.secret),
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
// Idempotency (Stripe Idempotency-Key over the protocol key)
// ---------------------------------------------------------------------------

/**
 * Derives the Stripe Idempotency-Key header from the protocol idempotency
 * key (INV-F05): namespaced so a protocol key can never collide with an
 * unrelated provider-side idempotency key. Deterministic: same protocol key
 * → same header on every retry.
 */
export function stripeIdempotencyKey(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap:${protocolIdempotencyKey}`;
}

/**
 * A Stripe idempotency conflict: the SAME idempotency key was submitted with
 * a DIFFERENT body. Stripe answers HTTP 409 `idempotency_error` — the
 * request was NOT executed (the original request holding the key was). This
 * is an ERROR STATE, never a silent success.
 */
export class StripeIdempotencyConflictError extends RailProviderError {
  constructor(message: string, details?: PaySwapError["details"]) {
    super(message, details);
    this.name = "StripeIdempotencyConflictError";
  }
}

// ---------------------------------------------------------------------------
// The RailAdapter surface (provider-neutral framework registration)
// ---------------------------------------------------------------------------

/** The Stripe production rail adapter on the BaseRailAdapter framework. */
export class StripeProductionRail extends BaseRailAdapter {
  readonly adapterId = STRIPE_RAIL_ADAPTER_ID;
  readonly implementationId = STRIPE_RAIL_IMPLEMENTATION_ID;

  constructor() {
    const definitions = new Map<string, CapabilityDefinition>();
    for (const definition of stripeCapabilityDefinitions()) {
      definitions.set(definition.capabilityId, definition);
    }
    super(stripeRailCapabilityPack(), definitions);
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK; credential-gated, fail-closed)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface StripeControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface StripeConnectorConfig {
  readonly clock: ProtocolClock;
  readonly apiBase?: string;
  /** Overrides the pinned API version (tests only — production pins). */
  readonly apiVersion?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("stripe")` = PROVIDER_STRIPE_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: StripeControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type StripeSdkRequest =
  | { readonly kind: "read_account" }
  | { readonly kind: "read_intent"; readonly intentId: string }
  | {
      readonly kind: "create_intent";
      readonly amountMinor: string;
      readonly currency: string;
      readonly paymentMethodTypes?: readonly string[];
      readonly confirm?: boolean;
      readonly customerId?: string;
    }
  | { readonly kind: "confirm_intent"; readonly intentId: string }
  | { readonly kind: "capture_intent"; readonly intentId: string; readonly amountMinor?: string }
  | { readonly kind: "cancel_intent"; readonly intentId: string }
  | {
      readonly kind: "create_refund";
      readonly paymentIntentId?: string;
      readonly chargeId?: string;
      readonly amountMinor?: string;
      readonly reason?: string;
    }
  | { readonly kind: "read_refund"; readonly refundId: string }
  | { readonly kind: "read_dispute"; readonly disputeId: string }
  | { readonly kind: "read_subscription"; readonly subscriptionId: string }
  | {
      readonly kind: "create_subscription";
      readonly customerId: string;
      readonly priceId: string;
    }
  | { readonly kind: "cancel_subscription"; readonly subscriptionId: string }
  | { readonly kind: "reconcile_intent"; readonly intentId: string }
  | { readonly kind: "reconcile_refund"; readonly refundId: string }
  | { readonly kind: "reconcile_dispute"; readonly disputeId: string }
  | { readonly kind: "reconcile_payout"; readonly payoutId: string }
  | { readonly kind: "reconcile_subscription"; readonly subscriptionId: string }
  | { readonly kind: "balance_transactions"; readonly sourceId: string; readonly limit?: number }
  | { readonly kind: "list_payouts"; readonly limit?: number };

function isStripeSdkRequest(candidate: unknown): candidate is StripeSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** Which credential path is live (observability — NEVER material). */
export type StripeCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/**
 * The real Stripe connector (ConnectorSDK framework). Stripe API names,
 * payloads, response shapes and quirks stay INSIDE this implementation: the
 * SDK call contract is the provider-neutral `StripeSdkRequest` union. Every
 * effectful operation runs behind `requireAuthority` (INV-C04/F05/F06) and
 * fails closed with `RailNotAuthorizedError` BEFORE any provider call when
 * no credential path is live (INV-NC04).
 */
export class StripeConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: StripeControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  #credentialBaseline: string | undefined;

  constructor(config: StripeConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase = config.apiBase ?? STRIPE_DEFAULT_API_BASE;
    this.#apiVersion = config.apiVersion ?? STRIPE_API_VERSION;
    this.#credentialConfigKey =
      config.credentialConfigKey ?? STRIPE_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: STRIPE_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "Stripe (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return stripeRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): StripeCredentialResolutionState {
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
          providerName: STRIPE_PROVIDER_NAME,
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
          providerName: STRIPE_PROVIDER_NAME,
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
        providerName: STRIPE_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(STRIPE_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface --------------------------------------------------

  async search(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "search");
    const request = this.#request(ctx, "list_payouts");
    if (request.kind !== "list_payouts") {
      throw new ValidationError("stripe search supports only { kind: 'list_payouts' }");
    }
    const list = await this.#providerGet(
      `/v1/payouts?limit=${request.limit ?? 10}`,
      ctx.idempotencyKey,
    );
    const payouts = this.#listData(list) as unknown as readonly StripePayoutProviderObject[];
    return this.#sdkResult(
      stripePayoutListEnvelope(payouts, this.#envelopeContext()),
      `stripe:list-payouts:${this.#clock.now()}`,
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(
      ctx,
      "read_intent",
    );
    const observedAt = this.#envelopeContext();
    switch (request.kind) {
      case "read_account": {
        const account = await this.#providerGet("/v1/account", ctx.idempotencyKey);
        return this.#sdkResult(
          stripeAccountEnvelope(account as StripeAccountProviderObject, observedAt),
          `stripe:read-account:${this.#clock.now()}`,
        );
      }
      case "read_intent":
      case "reconcile_intent": {
        if (request.intentId === undefined) {
          throw new ValidationError("read_intent/reconcile_intent requires intentId");
        }
        const intent = await this.#providerGet(
          `/v1/payment_intents/${encodeURIComponent(request.intentId ?? "")}`,
          ctx.idempotencyKey,
        );
        return this.#sdkResult(
          stripePaymentIntentEnvelope(intent as StripePaymentIntentProviderObject, observedAt),
          `stripe:read-intent:${request.intentId}`,
        );
      }
      case "read_refund":
      case "reconcile_refund": {
        if (request.refundId === undefined) {
          throw new ValidationError("read_refund/reconcile_refund requires refundId");
        }
        const refund = await this.#providerGet(
          `/v1/refunds/${encodeURIComponent(request.refundId ?? "")}`,
          ctx.idempotencyKey,
        );
        return this.#sdkResult(
          stripeRefundEnvelope(refund as StripeRefundProviderObject, observedAt),
          `stripe:read-refund:${request.refundId}`,
        );
      }
      case "read_dispute":
      case "reconcile_dispute": {
        if (request.disputeId === undefined) {
          throw new ValidationError("read_dispute/reconcile_dispute requires disputeId");
        }
        const dispute = await this.#providerGet(
          `/v1/disputes/${encodeURIComponent(request.disputeId ?? "")}`,
          ctx.idempotencyKey,
        );
        return this.#sdkResult(
          stripeDisputeEnvelope(dispute as StripeDisputeProviderObject, observedAt),
          `stripe:read-dispute:${request.disputeId}`,
        );
      }
      case "read_subscription": {
        if (request.subscriptionId === undefined) {
          throw new ValidationError("read_subscription requires subscriptionId");
        }
        const subscription = await this.#providerGet(
          `/v1/subscriptions/${encodeURIComponent(request.subscriptionId ?? "")}`,
          ctx.idempotencyKey,
        );
        return this.#sdkResult(
          stripeSubscriptionEnvelope(
            subscription as StripeSubscriptionProviderObject,
            observedAt,
          ),
          `stripe:read-subscription:${request.subscriptionId}`,
        );
      }
      default:
        throw new ValidationError(
          `stripe read supports read_account/read_intent/read_refund/read_dispute/read_subscription — got kind '${request.kind}'`,
        );
    }
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_intent");
    const observedAt = this.#envelopeContext();
    if (request.kind === "create_intent") {
      if (request.amountMinor === undefined || request.currency === undefined) {
        throw new ValidationError("create_intent requires amountMinor and currency (exact minor units)");
      }
      this.#requireRoutableCurrency(request.currency);
      const form: Record<string, string> = {
        amount: request.amountMinor,
        currency: request.currency.toLowerCase(),
      };
      if (request.paymentMethodTypes !== undefined) {
        for (let index = 0; index < request.paymentMethodTypes.length; index += 1) {
          form[`payment_method_types[${index}]`] = request.paymentMethodTypes[index] ?? "";
        }
      }
      if (request.confirm === true) {
        form.confirm = "true";
      }
      if (request.customerId !== undefined) {
        form.customer = request.customerId;
      }
      const intent = await this.#withCredentials(async (material) =>
        this.#providerPost("/v1/payment_intents", form, ctx.idempotencyKey, material),
      );
      return this.#sdkResult(
        stripePaymentIntentEnvelope(intent as StripePaymentIntentProviderObject, observedAt),
        `stripe:create-intent:${(intent as StripePaymentIntentProviderObject).id}`,
      );
    }
    if (request.kind === "create_subscription") {
      if (request.customerId === undefined || request.priceId === undefined) {
        throw new ValidationError("create_subscription requires customerId and priceId");
      }
      const subscription = await this.#withCredentials(async (material) =>
        this.#providerPost(
          "/v1/subscriptions",
          { customer: request.customerId ?? "", "items[0][price]": request.priceId ?? "" },
          ctx.idempotencyKey,
          material,
        ),
      );
      return this.#sdkResult(
        stripeSubscriptionEnvelope(
          subscription as StripeSubscriptionProviderObject,
          observedAt,
        ),
        `stripe:create-subscription:${(subscription as StripeSubscriptionProviderObject).id}`,
      );
    }
    throw new ValidationError(
      `stripe create supports create_intent/create_subscription — got kind '${request.kind}'`,
    );
  }

  async update(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "update");
    const request = this.#request(ctx, "confirm_intent");
    if (request.kind !== "confirm_intent" && request.kind !== "capture_intent") {
      throw new ValidationError(
        `stripe update supports confirm_intent/capture_intent — got kind '${request.kind}'`,
      );
    }
    const intentId = request.intentId;
    if (intentId === undefined) {
      throw new ValidationError("confirm_intent/capture_intent requires intentId");
    }
    const path =
      request.kind === "confirm_intent"
        ? `/v1/payment_intents/${encodeURIComponent(intentId ?? "")}/confirm`
        : `/v1/payment_intents/${encodeURIComponent(intentId ?? "")}/capture`;
    const form: Record<string, string> = {};
    if (request.kind === "capture_intent" && request.amountMinor !== undefined) {
      form.amount_to_capture = request.amountMinor;
    }
    const observedAt = this.#envelopeContext();
    // INV-X01: a transport failure mid-confirm/mid-capture is OUTCOME_UNKNOWN
    // — the effect MAY have landed at the provider. Never FAILED.
    try {
      const intent = await this.#withCredentials(async (material) =>
        this.#providerPost(path, form, ctx.idempotencyKey, material),
      );
      return this.#sdkResult(
        stripePaymentIntentEnvelope(intent as StripePaymentIntentProviderObject, observedAt),
        `stripe:${request.kind}:${intentId}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "payment_intent",
          externalId: intentId ?? "",
          operation: request.kind,
          idempotencyKey: ctx.idempotencyKey,
          transportError: error.message,
          observedAt: observedAt.observedAt,
        });
      }
      // A 402 with the PaymentIntent in the error body is a DEFINITIVE
      // provider answer (e.g. card_declined): map the returned intent.
      const declined = this.#declinedIntentFromError(error);
      if (declined !== undefined) {
        return this.#sdkResult(
          stripePaymentIntentEnvelope(declined, observedAt),
          `stripe:${request.kind}:declined:${declined.id}`,
        );
      }
      throw error;
    }
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "cancel_intent");
    const observedAt = this.#envelopeContext();
    switch (request.kind) {
      case "cancel_intent": {
        if (request.intentId === undefined) {
          throw new ValidationError("cancel_intent requires intentId");
        }
        try {
          const intent = await this.#withCredentials(async (material) =>
            this.#providerPost(
              `/v1/payment_intents/${encodeURIComponent(request.intentId ?? "")}/cancel`,
              {},
              ctx.idempotencyKey,
              material,
            ),
          );
          return this.#sdkResult(
            stripePaymentIntentEnvelope(intent as StripePaymentIntentProviderObject, observedAt),
            `stripe:cancel-intent:${request.intentId}`,
          );
        } catch (error) {
          if (error instanceof RailTransportError) {
            return this.#outcomeUnknownResult({
              objectType: "payment_intent",
              externalId: request.intentId ?? "",
              operation: "cancel_intent",
              idempotencyKey: ctx.idempotencyKey,
              transportError: error.message,
              observedAt: observedAt.observedAt,
            });
          }
          throw error;
        }
      }
      case "create_refund": {
        if (request.paymentIntentId === undefined && request.chargeId === undefined) {
          throw new ValidationError("create_refund requires paymentIntentId or chargeId");
        }
        const form: Record<string, string> = {};
        if (request.paymentIntentId !== undefined) {
          form.payment_intent = request.paymentIntentId;
        }
        if (request.chargeId !== undefined) {
          form.charge = request.chargeId;
        }
        if (request.amountMinor !== undefined) {
          form.amount = request.amountMinor;
        }
        if (request.reason !== undefined) {
          form.reason = request.reason;
        }
        try {
          const refund = await this.#withCredentials(async (material) =>
            this.#providerPost("/v1/refunds", form, ctx.idempotencyKey, material),
          );
          return this.#sdkResult(
            stripeRefundEnvelope(refund as StripeRefundProviderObject, observedAt),
            `stripe:create-refund:${(refund as StripeRefundProviderObject).id}`,
          );
        } catch (error) {
          if (error instanceof RailTransportError) {
            return this.#outcomeUnknownResult({
              objectType: "refund",
              externalId: request.paymentIntentId ?? request.chargeId ?? "",
              operation: "create_refund",
              idempotencyKey: ctx.idempotencyKey,
              transportError: error.message,
              observedAt: observedAt.observedAt,
            });
          }
          throw error;
        }
      }
      case "cancel_subscription": {
        if (request.subscriptionId === undefined) {
          throw new ValidationError("cancel_subscription requires subscriptionId");
        }
        try {
          const subscription = await this.#withCredentials(async (material) =>
            this.#providerDelete(
              `/v1/subscriptions/${encodeURIComponent(request.subscriptionId ?? "")}`,
              ctx.idempotencyKey,
              material,
            ),
          );
          return this.#sdkResult(
            stripeSubscriptionEnvelope(
              subscription as StripeSubscriptionProviderObject,
              observedAt,
            ),
            `stripe:cancel-subscription:${request.subscriptionId}`,
          );
        } catch (error) {
          if (error instanceof RailTransportError) {
            return this.#outcomeUnknownResult({
              objectType: "subscription",
              externalId: request.subscriptionId ?? "",
              operation: "cancel_subscription",
              idempotencyKey: ctx.idempotencyKey,
              transportError: error.message,
              observedAt: observedAt.observedAt,
            });
          }
          throw error;
        }
      }
      default:
        throw new ValidationError(
          `stripe executeAction supports cancel_intent/create_refund/cancel_subscription — got kind '${request.kind}'`,
        );
    }
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "stripe event subscription is handled by the webhook ingestion framework (createStripeWebhookIngestor + @payswap/adapters ProviderWebhookIngestor), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "reconcile_intent");
    const observedAt = this.#envelopeContext();
    switch (request.kind) {
      // Reconciliation-as-authority (INV-X03): re-fetch by external object id.
      case "reconcile_intent":
      case "reconcile_refund":
      case "reconcile_dispute":
      case "reconcile_payout":
      case "reconcile_subscription":
      case "read_intent":
      case "read_refund":
      case "read_dispute":
      case "read_subscription":
        return this.read(ctx);
      case "balance_transactions": {
        if (request.sourceId === undefined) {
          throw new ValidationError("balance_transactions requires sourceId");
        }
        const list = await this.#providerGet(
          `/v1/balance_transactions?source=${encodeURIComponent(request.sourceId ?? "")}&limit=${request.limit ?? 10}`,
          ctx.idempotencyKey,
        );
        const transactions = this.#listData(list) as unknown as readonly (
          | StripeBalanceTransactionProviderObject
          | StripePayoutProviderObject
        )[];
        const first = transactions[0];
        const externalId = first !== undefined ? first.id : (request.sourceId ?? "");
        return this.#sdkResult(
          stripeBalanceTransactionListEnvelope(transactions, externalId, observedAt),
          `stripe:balance-transactions:${request.sourceId}`,
        );
      }
      default:
        throw new ValidationError(
          `stripe reconcile supports reconcile_*/balance_transactions — got kind '${request.kind}'`,
        );
    }
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "stripe disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and release the sealed credential handle); the provider surface offers no self-disconnect",
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md, Stripe path —
   * swap-reference-then-verify): the vault binding for the control-plane
   * config key is swapped to a NEW reference at the vault; the connector
   * re-resolves per call, so the rotation is real exactly when the NEW
   * reference resolves and serves a successful health probe. The old
   * credential is revoked at Stripe only after that verification.
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
          evidenceId: `stripe:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: STRIPE_PROVIDER_NAME,
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
        "cannot rotate credentials: no credential path is provisioned for the stripe rail (packages/rails/BLOCKED-RAILS.md)",
        { railId: STRIPE_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = createHmac("sha256", "payswap-stripe-rotation-baseline")
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
        evidenceId: `stripe:cred-rotation:${rotatedAt}`,
        evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
        kind: "AUDIT_LOG",
        providerState: railEnvelope({
          providerName: STRIPE_PROVIDER_NAME,
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
   * never a business outcome. Without credentials: endpoint reachability via
   * an unauthenticated GET (any HTTP answer proves reachability) → DEGRADED
   * with reasons; transport failure → UNKNOWN. With credentials: an
   * authenticated GET /v1/account (the real probe) → HEALTHY.
   */
  async health(): Promise<ConnectorHealthReport> {
    const resolution = this.credentialResolutionState();
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: STRIPE_CONNECTOR_ID,
      providerName: STRIPE_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (resolution.kind === "NOT_PROVISIONED") {
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
      await this.#withCredentials(async (material) =>
        this.#providerGet("/v1/account", "health-probe", material),
      );
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
   * OBSERVED account capability scope — a live GET /v1/account reduced to
   * the capability statuses the provider actually reports (never assumed
   * from a catalogue). Fails closed without credentials.
   */
  async accountScope(): Promise<StripeAccountCapabilityScope> {
    const account = await this.#withCredentials(async (material) =>
      this.#providerGet("/v1/account", "account-scope", material),
    );
    return stripeAccountCapabilityScope(
      account as StripeAccountProviderObject,
      isoTimestamp(this.#clock.now()),
    );
  }

  /**
   * External funds observations from GET /v1/balance — one observation per
   * (bucket, currency) of PROVIDER-HELD funds on the connected account.
   * Observations ONLY (INV-C09): never custody, never a PaySwap balance.
   */
  async observeExternalFunds(): Promise<readonly ExternalFundsPositionObservation[]> {
    const observedAt = isoTimestamp(this.#clock.now());
    const { balance, accountRef } = await this.#withCredentials(async (material) => {
      const account = (await this.#providerGet("/v1/account", "balance-account", material)) as {
        readonly id?: string;
      };
      const bal = await this.#providerGet("/v1/balance", "balance", material);
      return { balance: bal, accountRef: account.id ?? "unknown_account" };
    });
    return stripeBalanceObservations({
      balance: balance as StripeBalanceProviderObject,
      accountRef,
      observedAt,
    });
  }

  /**
   * External funds observations from GET /v1/payouts — the provider-reported
   * funds movements toward the destination bank accounts. Observations ONLY
   * (INV-C09).
   */
  async observePayouts(limit = 10): Promise<readonly ExternalFundsPositionObservation[]> {
    const observedAt = isoTimestamp(this.#clock.now());
    const { payouts, accountRef } = await this.#withCredentials(async (material) => {
      const account = (await this.#providerGet("/v1/account", "payouts-account", material)) as {
        readonly id?: string;
      };
      const list = await this.#providerGet(`/v1/payouts?limit=${limit}`, "payouts", material);
      return { payouts: this.#listData(list), accountRef: account.id ?? "unknown_account" };
    });
    return stripePayoutObservations({
      payouts: payouts as unknown as readonly StripePayoutProviderObject[],
      accountRef,
      observedAt,
    });
  }

  // -- internals -------------------------------------------------------------------

  #envelopeContext(): StripeEnvelopeContext {
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
  async #withCredentials<T>(
    fn: (material: string) => Promise<T>,
  ): Promise<T> {
    if (this.#controlPlane !== undefined) {
      let handle: ReturnType<CredentialBroker["resolveProviderCredential"]>;
      try {
        handle = this.#controlPlane.broker.resolveProviderCredential(
          this.#credentialConfigKey,
        );
      } catch (error) {
        throw new RailNotAuthorizedError(
          "stripe rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: STRIPE_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => fn(extractStripeKeyMaterial(opened.material)),
      );
    }
    const material = this.#envMaterial();
    if (material === undefined) {
      throw new RailNotAuthorizedError(
        "stripe rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md)",
        { railId: STRIPE_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    return fn(material);
  }

  #request(ctx: SdkCallContext, expectedKind: string): StripeSdkRequest {
    const candidate = ctx.request;
    if (!isStripeSdkRequest(candidate)) {
      throw new ValidationError(
        `stripe rail call request must be a StripeSdkRequest object (expected kind '${expectedKind}')`,
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

  /**
   * Fail-closed currency gate: a currency proven non-routable by the
   * observed scope (the GHS negative datum) is refused BEFORE any provider
   * call. Unknown-basis currencies pass through to the provider (the
   * provider is the authority; the connector never fabricates eligibility).
   */
  #requireRoutableCurrency(currency: string): void {
    const eligibility = stripeCurrencyEligibility(currency);
    if (eligibility.basis === "NEGATIVE_DATUM" && !eligibility.eligible) {
      throw new StripeIneligibleCurrencyError(
        `stripe rail cannot route currency ${eligibility.currency}: ${eligibility.reason}`,
        { currency: eligibility.currency, basis: eligibility.basis },
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
      providerName: STRIPE_PROVIDER_NAME,
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
      shareableFields: STRIPE_SHAREABLE_FIELDS,
    });
    return this.#sdkResult(envelope, `stripe:outcome-unknown:${input.operation}:${input.idempotencyKey}`);
  }

  /**
   * A 402 answer (e.g. card_declined) carries the definitive post-decline
   * PaymentIntent in error.payment_intent — extract it for lossless mapping.
   */
  #declinedIntentFromError(error: unknown): StripePaymentIntentProviderObject | undefined {
    if (error instanceof RailProviderError) {
      const intent = (error.details as { readonly payment_intent?: unknown } | undefined)
        ?.payment_intent;
      if (
        intent !== null &&
        typeof intent === "object" &&
        typeof (intent as StripePaymentIntentProviderObject).id === "string" &&
        typeof (intent as StripePaymentIntentProviderObject).status === "string"
      ) {
        return intent as StripePaymentIntentProviderObject;
      }
    }
    return undefined;
  }

  #listData(list: unknown): readonly unknown[] {
    if (list !== null && typeof list === "object" && Array.isArray((list as { readonly data?: unknown }).data)) {
      return (list as { readonly data: readonly unknown[] }).data;
    }
    throw new RailProviderError("stripe list response is malformed (expected { object: 'list', data: [...] })");
  }

  async #providerGet(path: string, callRef: string, material?: string): Promise<unknown> {
    const run = async (key: string): Promise<unknown> => {
      let response: { readonly status: number; readonly bodyText: string };
      try {
        response = await this.#http(`${this.#apiBase}${path}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
            "Stripe-Version": this.#apiVersion,
          },
          timeoutMs: this.#timeoutMs,
        });
      } catch (cause) {
        throw new RailTransportError("stripe provider transport unreachable", {
          path,
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
      return this.#parseResponse(response, path, callRef);
    };
    if (material !== undefined) {
      return run(material);
    }
    return this.#withCredentials(run);
  }

  async #providerPost(
    path: string,
    form: Readonly<Record<string, string>>,
    idempotencyKey: string,
    material: string,
  ): Promise<unknown> {
    const body = new URLSearchParams(form).toString();
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${material}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Stripe-Version": this.#apiVersion,
          "Idempotency-Key": stripeIdempotencyKey(idempotencyKey),
        },
        body,
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("stripe provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return this.#parseResponse(response, path, idempotencyKey);
  }

  async #providerDelete(path: string, idempotencyKey: string, material: string): Promise<unknown> {
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${material}`,
          "Stripe-Version": this.#apiVersion,
          "Idempotency-Key": stripeIdempotencyKey(idempotencyKey),
        },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("stripe provider transport unreachable", {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("stripe provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const error = (parsed as { readonly error?: { readonly type?: string; readonly message?: string; readonly code?: string; readonly payment_intent?: unknown } })
      .error;
    if (error !== undefined && error !== null && typeof error === "object") {
      if (response.status === 409 && error.type === "idempotency_error") {
        // Same idempotency key + different body: NOT executed — an error
        // state, never a silent success.
        throw new StripeIdempotencyConflictError(
          "stripe idempotency conflict: this idempotency key was already used with a different request body — the request was NOT executed",
          { path, idempotencyKey: callRef, httpStatus: response.status },
        );
      }
      if (response.status === 404) {
        throw new RailProviderError(
          `stripe object not found: ${error.message ?? "not found"}`,
          { path, httpStatus: response.status },
        );
      }
      throw new RailProviderError(
        `stripe provider answered HTTP ${response.status}: ${error.message ?? "provider error"}`,
        {
          path,
          httpStatus: response.status,
          providerErrorType: error.type,
          ...(error.code !== undefined ? { providerErrorCode: error.code } : {}),
          ...(error.payment_intent !== undefined ? { payment_intent: error.payment_intent } : {}),
        },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(`stripe provider answered HTTP ${response.status}`, {
        path,
        httpStatus: response.status,
      });
    }
    return parsed;
  }
}

/** Account → connected_account-family envelope (lossless). */
export function stripeAccountEnvelope(
  account: StripeAccountProviderObject,
  context: StripeEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: STRIPE_PROVIDER_NAME,
    providerVersion: STRIPE_API_VERSION,
    objectType: "account",
    externalId: account.id,
    revision: `${account.id}:${account.charges_enabled === true ? "charges_on" : "charges_off"}`,
    state: account,
    family: "connected_account",
    lifecycleStep: account.charges_enabled === true ? "charges_enabled" : "charges_disabled",
    isTerminal: false,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: STRIPE_SHAREABLE_FIELDS,
  });
}

/** A payout list → one lossless list envelope (state = the raw list). */
export function stripePayoutListEnvelope(
  payouts: readonly StripePayoutProviderObject[],
  context: StripeEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: STRIPE_PROVIDER_NAME,
    providerVersion: STRIPE_API_VERSION,
    objectType: "payout_list",
    externalId: `payouts:${context.observedAt}`,
    revision: `payouts:${payouts.length}:${context.observedAt}`,
    state: Object.freeze({ object: "list", data: payouts }),
    family: "payout",
    lifecycleStep: "listed",
    isTerminal: false,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: STRIPE_SHAREABLE_FIELDS,
  });
}

/** A balance-transaction list → one lossless evidence envelope. */
export function stripeBalanceTransactionListEnvelope(
  transactions: readonly (StripeBalanceTransactionProviderObject | StripePayoutProviderObject)[],
  externalId: string,
  context: StripeEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: STRIPE_PROVIDER_NAME,
    providerVersion: STRIPE_API_VERSION,
    objectType: "balance_transaction_list",
    externalId,
    revision: `balance_transactions:${externalId}:${transactions.length}`,
    state: Object.freeze({ object: "list", data: transactions }),
    family: "other",
    lifecycleStep: "reconciliation_evidence",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: STRIPE_SHAREABLE_FIELDS,
  });
}

/**
 * Extracts the Stripe key material from a vault bundle shape. The control
 * plane hands the connector whatever the vault object holds: a plain string
 * key, or a bundle record ({ secretKey } / { secret_key } / { apiKey }). Any
 * other shape refuses the call (fail-closed, no guessing).
 */
export function extractStripeKeyMaterial(material: unknown): string {
  if (typeof material === "string" && material.length > 0) {
    return material;
  }
  if (material !== null && typeof material === "object") {
    const record = material as Readonly<Record<string, unknown>>;
    for (const key of ["secretKey", "secret_key", "apiKey", "api_key"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  throw new ValidationError(
    "the sealed credential bundle does not contain Stripe key material (expected a string key or { secretKey | secret_key | apiKey | api_key })",
  );
}
