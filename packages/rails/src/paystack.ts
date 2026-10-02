/**
 * Paystack production connector (P2-W3-001) — the REAL Paystack adapter on
 * the v1.5 capability hierarchy and ProviderStateEnvelope.
 *
 * Authority: spec/phase-2/work-items/P2-W3-001.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md and the LIVE probe
 * facts in spec/development-state/provider-probes-20261002.json (test-mode
 * scoped credential; authenticated GET /v1/bank enumeration: GHS ghipss
 * rails live — e.g. Absa Bank Ghana code 030100 supports_transfer — NGN 287
 * banks, KES 54, ZAR 33; verdict ELIGIBLE for GH/NG/KE/ZA local collection).
 * Same framework and fail-closed laws as the Stripe production connector
 * (`src/stripe.ts`, P2-W2-001) — NO Paystack SDK, no ambient fetch in
 * unit-testable paths, no provider SDK types anywhere.
 *
 * Laws implemented here:
 * - INV-C06 (lossless): every provider object (initialized payment with its
 *   `reference`, verified transaction, refund, webhook event, bank entry) is
 *   carried VERBATIM in the envelope `state` with an ADDITIVE
 *   classification. Provider statuses are never renamed, never dropped;
 *   UNKNOWN provider statuses stay `other`/verbatim.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (ambiguity
 *   OUTCOME_UNKNOWN, requires reconciliation) — NEVER collapsed to FAILED. A
 *   verify-timeout never produces a FAILED payment either: reads propagate
 *   RailTransportError (no fabricated provider state), effects produce the
 *   OUTCOME_UNKNOWN envelope.
 * - INV-NC04: no credential → availability UNKNOWN (INV-C01/C02), health
 *   DEGRADED/UNKNOWN with reasons, every effectful operation throws
 *   RailNotAuthorizedError BEFORE any provider call.
 * - Credential isolation (phase-2): key material is consumed through the
 *   P2-W1-001 control plane — `PROVIDER_PAYSTACK_CREDENTIAL_REF` bound to a
 *   vault:// reference, resolved through the CredentialBroker to a SEALED
 *   bundle opened only inside `withSealedBundle` with a ConnectorRuntimeKey.
 *   A direct env fallback (the W1-005 rails convention) exists for
 *   deployments that inject the resolved key under the same config key; the
 *   material NEVER enters any envelope, log line or evidence record.
 * - Eligibility is OBSERVED, not assumed: the probe-verified bank rails
 *   (GHS/NGN/KES/ZAR) are encoded as evidence-backed eligibility facts;
 *   every other country/currency is UNKNOWN — never assumed eligible, never
 *   assumed ineligible. Paystack amounts are MINOR UNITS (kobo/pesewas/
 *   cents) natively: the mapping is the documented identity pass-through
 *   (INV-F01 exact integer strings only).
 * - Webhook verification is provider-correct: `X-Paystack-Signature` =
 *   HMAC-SHA512(secret_key, RAW body bytes) hex, constant-time compare, RAW
 *   body required. The scheme carries NO timestamp — replay defense is the
 *   (provider, eventId) dedupe at the ingestor, never a fabricated window.
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
// Identity (pinned — the observed API surface is part of the provider contract)
// ---------------------------------------------------------------------------

export const PAYSTACK_PROVIDER_NAME = "paystack" as const;
/**
 * The pinned Paystack API surface contract. Paystack publishes no global
 * API-version header (endpoints span /v1, /v2 and /v3); this pin records the
 * OBSERVED surface the connector speaks — the shape live-verified in the
 * 2026-10-02 probe (spec/development-state/provider-probes-20261002.json).
 */
export const PAYSTACK_API_VERSION = "2026-10-02" as const;
export const PAYSTACK_RAIL_ADAPTER_ID = "rail.paystack" as const;
export const PAYSTACK_RAIL_IMPLEMENTATION_ID = "impl.rails.paystack.2026-10-02" as const;
export const PAYSTACK_CONNECTOR_ID = "connector.rails.paystack" as const;
export const PAYSTACK_DEFAULT_API_BASE = "https://api.paystack.co" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("paystack")` —
 * `PROVIDER_PAYSTACK_CREDENTIAL_REF`, bound to
 * `vault://payswap/providers/paystack/test-20261002`.
 */
export const PAYSTACK_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  PAYSTACK_PROVIDER_NAME,
);

// ---------------------------------------------------------------------------
// Capability definitions (consumed W2-003 vocabulary — never redefined)
// ---------------------------------------------------------------------------

export const PAYSTACK_PAYMENT_INIT_CAPABILITY_ID = "cap.rails.paystack.payment_init" as const;
export const PAYSTACK_RECURRING_CHARGE_CAPABILITY_ID =
  "cap.rails.paystack.recurring_charge" as const;
export const PAYSTACK_REFUND_CAPABILITY_ID = "cap.rails.paystack.refund" as const;
export const PAYSTACK_BANK_ENUMERATION_CAPABILITY_ID =
  "cap.rails.paystack.bank_enumeration" as const;

/**
 * The provider-state vocabulary this connector maps (INV-C06): every
 * Paystack transaction status (the verify/charge surface) with its additive
 * classification. Exported as data so certification/conformance surfaces can
 * diff the mapping without reading the implementation.
 *
 * | Paystack status | family                   | isTerminal | requiresCustomerAction |
 * |-----------------|--------------------------|------------|------------------------|
 * | pending         | customer_action_required | false      | true                   |
 * | processing      | async_processing         | false      | false                  |
 * | ongoing         | async_processing         | false      | false                  |
 * | success         | other                    | true       | false                  |
 * | paid            | other                    | true       | false                  |
 * | failed          | other                    | true       | false (definitive)     |
 * | abandoned       | other                    | true       | false (definitive)     |
 * | reversed        | other                    | true       | false (definitive)     |
 * | (unknown)       | other                    | false      | false (verbatim step)  |
 */
export const PAYSTACK_TRANSACTION_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "pending", family: "customer_action_required", lifecycleStep: "pending", isTerminal: false, requiresCustomerAction: true },
  { providerState: "processing", family: "async_processing", lifecycleStep: "processing", isTerminal: false, requiresCustomerAction: false },
  { providerState: "ongoing", family: "async_processing", lifecycleStep: "ongoing", isTerminal: false, requiresCustomerAction: false },
  { providerState: "success", family: "other", lifecycleStep: "success", isTerminal: true, requiresCustomerAction: false },
  { providerState: "paid", family: "other", lifecycleStep: "paid", isTerminal: true, requiresCustomerAction: false },
  { providerState: "failed", family: "other", lifecycleStep: "failed", isTerminal: true, requiresCustomerAction: false },
  { providerState: "abandoned", family: "other", lifecycleStep: "abandoned", isTerminal: true, requiresCustomerAction: false },
  { providerState: "reversed", family: "other", lifecycleStep: "reversed", isTerminal: true, requiresCustomerAction: false },
]);

function paystackCapabilityDefinition(input: {
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
      "credential reference provisioned through the control plane (PROVIDER_PAYSTACK_CREDENTIAL_REF)",
      "collection eligibility observed through the probe-verified bank rails (GHS/NGN/KES/ZAR) — never assumed for unproven countries",
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
      duplicateBehavior: "REJECTED",
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
        { action: "initialize", description: "Create a hosted payment (authorization URL) toward the payer" },
        { action: "verify", description: "Verify a payment by its reference (the reconciliation path)" },
        { action: "charge", description: "Charge a saved authorization (recurring) or a direct method" },
        { action: "refund", description: "Refund a transaction" },
      ],
      states: input.providerStates,
    },
    externalObjects: input.externalObjects.map((object) => ({
      objectType: object.objectType,
      idFormat: object.idFormat,
      revisioned: true,
      revisionFormat: "provider-status-etag",
    })),
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "Paystack settlement schedule" },
    constraints: [
      {
        kind: "JURISDICTION",
        description:
          "local collection availability follows the probe-verified bank rails (GHS/NGN/KES/ZAR); other countries are UNKNOWN, never assumed",
      },
    ],
  });
}

/** The canonical capability definitions consumed by the Paystack connector. */
export function paystackCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return Object.freeze([
    paystackCapabilityDefinition({
      capabilityId: PAYSTACK_PAYMENT_INIT_CAPABILITY_ID,
      summary: "Hosted payment initialization + verify lifecycle on the real Paystack API",
      operation: "rails.paystack.payment.initialize_and_verify",
      description:
        "POST /v3/payment/initialize (amount in exact minor units — kobo/pesewas/cents; channel selection covers card, bank/local methods, bank transfer, USSD, QR, mobile money, EFT) then GET /v2/payment/verify/{reference}: the reference is preserved as the external id, statuses stay verbatim (pending/processing/ongoing/success/paid/failed/abandoned/reversed), and a verify-timeout never becomes FAILED",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: PAYSTACK_TRANSACTION_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "payment_init", idFormat: "reference:[A-Za-z0-9._~-]+" }],
      sideEffects: [
        { effect: "moves payer value when the payer completes the hosted authorization", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      requiredCustomerActions: [
        {
          lifecycleStep: "pending",
          kind: "PROVIDER_CHALLENGE_REDIRECT",
          message: "Complete the payment at the Paystack authorization URL before the session expires",
        },
      ],
    }),
    paystackCapabilityDefinition({
      capabilityId: PAYSTACK_RECURRING_CHARGE_CAPABILITY_ID,
      summary: "Recurring charges over a saved Paystack authorization (POST /v3/charge)",
      operation: "rails.paystack.charge.authorization",
      description:
        "Charge a previously saved authorization code (the Paystack recurring path): the reusable authorization stays provider-owned and is carried verbatim in the transaction state; the charge lifecycle reuses the lossless transaction status mapping",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: PAYSTACK_TRANSACTION_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "transaction", idFormat: "reference:[A-Za-z0-9._~-]+" }],
      sideEffects: [
        { effect: "collects recurring value under a customer-authorized saved authorization", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    paystackCapabilityDefinition({
      capabilityId: PAYSTACK_REFUND_CAPABILITY_ID,
      summary: "Refunds on Paystack transactions (POST /v3/refund)",
      operation: "rails.paystack.refund.create",
      description:
        "Create Paystack refunds by transaction reference (optionally partial, in exact minor units); refund statuses (pending/processed/failed/abandoned) map to the refund family losslessly",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: [
        { providerState: "pending", canonicalState: "refund:pending", requiresCustomerAction: false, isTerminal: false },
        { providerState: "processed", canonicalState: "refund:processed", requiresCustomerAction: false, isTerminal: true },
        { providerState: "failed", canonicalState: "refund:failed", requiresCustomerAction: false, isTerminal: true },
        { providerState: "abandoned", canonicalState: "refund:abandoned", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "refund", idFormat: "refund-reference:[A-Za-z0-9._~-]+" }],
      sideEffects: [
        { effect: "returns previously collected value to the payer", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    paystackCapabilityDefinition({
      capabilityId: PAYSTACK_BANK_ENUMERATION_CAPABILITY_ID,
      summary: "Bank enumeration as collection eligibility evidence (GET /v1/bank?currency=…)",
      operation: "rails.paystack.banks.enumerate",
      description:
        "Enumerate the provider's bank rails per currency (GHS ghipss, NGN, KES, ZAR observed live 2026-10-02): each bank entry — name, code, supports_transfer, active/is_delisted — is preserved verbatim as capability/eligibility evidence; the probe-verified currencies are the only eligibility facts the connector asserts",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      providerStates: [
        { providerState: "enumerated", canonicalState: "other:enumerated", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "bank_list", idFormat: "bank-list:[A-Z]{3}" }],
      sideEffects: [],
    }),
  ]);
}

/** The connector capability pack backing the Paystack rail (payments family). */
export function paystackRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.paystack",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: paystackCapabilityDefinitions().map((definition) => ({
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
    })),
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "payments:read"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.paystack.provider_state", version: "1.0.0" }],
    objectMappings: [
      {
        externalObjectType: "payment_init",
        canonicalObjectRef: "payswap:payment",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "transaction",
        canonicalObjectRef: "payswap:payment",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "refund",
        canonicalObjectRef: "payswap:refund",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "bank_list",
        canonicalObjectRef: "payswap:eligibility_evidence",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 50, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-paystack-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Probe-verified bank-rail facts (observed, never assumed)
// ---------------------------------------------------------------------------

/** One probe-verified local-collection bank rail (the 2026-10-02 live probe). */
export interface PaystackBankRailProbeDatum {
  readonly currency: "GHS" | "NGN" | "KES" | "ZAR";
  readonly country: "GH" | "NG" | "KE" | "ZA";
  /** Bank count observed in the probe (null when the probe recorded the live rail without a count). */
  readonly bankCount: number | null;
  /** An exemplar bank proving the rail is live (the GHS ghipss datum). */
  readonly exemplarBank:
    | { readonly name: string; readonly code: string; readonly supportsTransfer: boolean }
    | null;
  readonly probedAt: string;
  readonly verdict: "ELIGIBLE";
}

/**
 * The RECORDED bank-rail probe data (2026-10-02, authenticated GET /v1/bank):
 * GHS ghipss rails live (Absa Bank Ghana code 030100 supports_transfer);
 * NGN 287 banks; KES 54; ZAR 33. The connector NEVER assumes these stay
 * true — `bankEnumeration(currency)` re-observes live — this record is the
 * eligibility evidence provenance when no fresh enumeration ran.
 */
export const PAYSTACK_PROBED_BANK_RAILS_20261002: readonly PaystackBankRailProbeDatum[] =
  Object.freeze([
    Object.freeze({
      currency: "GHS",
      country: "GH",
      bankCount: null,
      exemplarBank: Object.freeze({
        name: "Absa Bank Ghana",
        code: "030100",
        supportsTransfer: true,
      }),
      probedAt: "2026-10-02T06:37:38Z",
      verdict: "ELIGIBLE",
    }),
    Object.freeze({
      currency: "NGN",
      country: "NG",
      bankCount: 287,
      exemplarBank: null,
      probedAt: "2026-10-02T06:37:38Z",
      verdict: "ELIGIBLE",
    }),
    Object.freeze({
      currency: "KES",
      country: "KE",
      bankCount: 54,
      exemplarBank: null,
      probedAt: "2026-10-02T06:37:38Z",
      verdict: "ELIGIBLE",
    }),
    Object.freeze({
      currency: "ZAR",
      country: "ZA",
      bankCount: 33,
      exemplarBank: null,
      probedAt: "2026-10-02T06:37:38Z",
      verdict: "ELIGIBLE",
    }),
  ]);

/** The local-collection eligibility verdict for one currency/country. */
export interface PaystackCollectionEligibility {
  readonly currency: string;
  readonly eligible: boolean;
  /** "PROBE_VERIFIED_BANK_RAIL" | "UNKNOWN" (never assumed either way). */
  readonly basis: "PROBE_VERIFIED_BANK_RAIL" | "UNKNOWN";
  readonly reason: string;
}

/**
 * Local-collection eligibility against the RECORDED probe evidence. Only the
 * four probe-verified currencies (GHS/NGN/KES/ZAR) are eligible with basis
 * PROBE_VERIFIED_BANK_RAIL; every other currency/country is UNKNOWN — never
 * assumed eligible, never assumed ineligible (INV-NC04 honesty: the provider
 * is the authority; the connector fabricates nothing).
 */
export function paystackCollectionEligibility(
  currency: string,
): PaystackCollectionEligibility {
  const upper = currency.toUpperCase();
  const datum = PAYSTACK_PROBED_BANK_RAILS_20261002.find(
    (candidate) => candidate.currency === upper,
  );
  if (datum !== undefined) {
    const exemplar =
      datum.exemplarBank !== null
        ? ` (exemplar: ${datum.exemplarBank.name} code ${datum.exemplarBank.code}, supports_transfer=${String(datum.exemplarBank.supportsTransfer)})`
        : "";
    return Object.freeze({
      currency: upper,
      eligible: true,
      basis: "PROBE_VERIFIED_BANK_RAIL",
      reason: `authenticated bank enumeration verified the ${datum.country} local rail live on ${datum.probedAt}${exemplar}${datum.bankCount !== null ? ` (${String(datum.bankCount)} banks observed)` : ""}`,
    });
  }
  return Object.freeze({
    currency: upper,
    eligible: false,
    basis: "UNKNOWN",
    reason:
      "no probe evidence for this currency — collection eligibility UNKNOWN, never assumed (INV-NC04; re-observe through bankEnumeration before routing)",
  });
}

// ---------------------------------------------------------------------------
// Provider object shapes (opaque passthrough — never domain primitives)
// ---------------------------------------------------------------------------

/** The raw Paystack initialize response data (opaque passthrough). */
export interface PaystackPaymentInitProviderObject {
  readonly authorization_url?: string;
  readonly access_code?: string;
  readonly reference?: string;
  readonly [key: string]: unknown;
}

/** The raw Paystack transaction object (verify/charge surfaces; opaque). */
export interface PaystackTransactionProviderObject {
  readonly id?: number | string;
  readonly status?: string;
  readonly reference?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly channel?: string;
  readonly gateway_response?: string;
  readonly authorization?: { readonly authorization_code?: string; readonly reusable?: boolean };
  readonly [key: string]: unknown;
}

/** The raw Paystack refund object (opaque passthrough). */
export interface PaystackRefundProviderObject {
  readonly transaction_id?: number | string;
  readonly transaction_reference?: string;
  readonly refund_reference?: string;
  readonly status?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly [key: string]: unknown;
}

/** One raw Paystack bank entry (opaque passthrough). */
export interface PaystackBankProviderObject {
  readonly name?: string;
  readonly slug?: string;
  readonly code?: string;
  readonly active?: boolean;
  readonly is_delisted?: boolean;
  readonly country?: string;
  readonly currency?: string;
  readonly type?: string;
  readonly supports_transfer?: boolean;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object)
// ---------------------------------------------------------------------------

/** Payment-init revision: reference + the checkout surface it produced. */
export function paystackPaymentInitRevision(init: PaystackPaymentInitProviderObject): string {
  return `${init.reference ?? "no_reference"}:${init.access_code ?? "no_access_code"}`;
}

/** Transaction revision: reference + status + provider id (status revision). */
export function paystackTransactionRevision(tx: PaystackTransactionProviderObject): string {
  return `${tx.reference ?? "no_reference"}:${tx.status ?? "unknown"}:${String(tx.id ?? "no_id")}`;
}

/** Refund revision: refund reference + status. */
export function paystackRefundRevision(refund: PaystackRefundProviderObject): string {
  return `${refund.refund_reference ?? refund.transaction_reference ?? "no_reference"}:${refund.status ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface PaystackEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK";
  readonly fetchId?: string;
}

function paystackEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: PaystackEnvelopeContext,
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
    providerName: PAYSTACK_PROVIDER_NAME,
    providerVersion: PAYSTACK_API_VERSION,
    objectType,
    externalId,
    revision,
    state,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
}

/** Envelope shareable-field surface for Paystack provider objects. */
const PAYSTACK_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "status",
  "reference",
  "amount",
  "currency",
  "channel",
]);

/**
 * Deterministic, additive classification of a Paystack initialize response
 * into a lossless ProviderStateEnvelope (INV-C06). The RAW data is carried
 * VERBATIM as `state`; the external id is the payment `reference` (the
 * caller-visible idempotent join key across the whole lifecycle). A freshly
 * initialized payment is customer-action-required: the payer must complete
 * the hosted authorization at `authorization_url` before any value moves.
 */
export function paystackPaymentInitEnvelope(
  init: PaystackPaymentInitProviderObject,
  context: PaystackEnvelopeContext,
): ProviderStateEnvelope {
  const reference = init.reference ?? "no_reference";
  const base = paystackEnvelopeBase(
    "payment_init",
    reference,
    paystackPaymentInitRevision(init),
    init,
    context,
  );
  if (typeof init.authorization_url === "string" && init.authorization_url.length > 0) {
    return railEnvelope({
      ...base,
      family: "customer_action_required",
      lifecycleStep: "pending",
      isTerminal: false,
      requiresCustomerAction: true,
      actionRequired: {
        kind: "PROVIDER_CHALLENGE_REDIRECT",
        message:
          "Complete the payment at the Paystack authorization URL before the session expires",
        deepLink: init.authorization_url,
      },
      shareableFields: PAYSTACK_SHAREABLE_FIELDS,
    });
  }
  // No hosted URL in the answer: the payment object exists but the customer
  // surface is not disclosed — asynchronous, never guessed further.
  return railEnvelope({
    ...base,
    family: "async_processing",
    lifecycleStep: "initiated",
    isTerminal: false,
    requiresCustomerAction: false,
    shareableFields: PAYSTACK_SHAREABLE_FIELDS,
  });
}

/**
 * Deterministic, additive classification of a Paystack transaction (verify /
 * charge / webhook `charge.*` surfaces) into a lossless ProviderStateEnvelope
 * (INV-C06). The RAW transaction is carried VERBATIM as `state`; the
 * external id is the `reference`; statuses map per
 * PAYSTACK_TRANSACTION_STATUS_MAPPING and stay verbatim in lifecycleStep:
 *
 * - `pending` → customer_action_required (the payer must complete);
 * - `processing` / `ongoing` → async_processing;
 * - `success` / `paid` → terminal;
 * - `failed` → terminal with definitive failure (ambiguity NONE);
 * - `abandoned` → terminal definitive no-effect (a NEW attempt is a NEW
 *   transaction under a NEW reference; the raw status stays verbatim);
 * - `reversed` → terminal definitive (value returned by the provider);
 * - any UNKNOWN status → `other`/verbatim, non-terminal — never dropped,
 *   never guessed, never collapsed (INV-C06/INV-X01).
 */
export function paystackTransactionEnvelope(
  tx: PaystackTransactionProviderObject,
  context: PaystackEnvelopeContext,
): ProviderStateEnvelope {
  const reference = tx.reference ?? "no_reference";
  const base = paystackEnvelopeBase(
    "transaction",
    reference,
    paystackTransactionRevision(tx),
    tx,
    context,
  );
  switch (tx.status) {
    case "pending":
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: "pending",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "PROVIDER_CHALLENGE_REDIRECT",
          message: "Complete the payment authorization — the transaction is awaiting the payer",
        },
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
    case "processing":
    case "ongoing":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: tx.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
    case "success":
    case "paid":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: tx.status,
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
    case "failed":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "failed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "transaction_failed",
          ...(typeof tx.gateway_response === "string" && tx.gateway_response.length > 0
            ? { providerErrorMessage: tx.gateway_response }
            : {}),
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
    case "abandoned":
      // Provider-documented final status: the payer never completed the
      // authorization. Definitive no-effect; a NEW attempt is a NEW
      // transaction (the raw status stays verbatim — INV-C06).
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "abandoned",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "transaction_abandoned",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
    case "reversed":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "reversed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "transaction_reversed",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: tx.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
  }
}

/**
 * Paystack refund → refund-family envelope. `pending` is asynchronous;
 * `processed` is terminal; `failed`/`abandoned` are terminal with definitive
 * failure metadata; unknown statuses stay verbatim under the refund family
 * with no invented terminality.
 */
export function paystackRefundEnvelope(
  refund: PaystackRefundProviderObject,
  context: PaystackEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = refund.refund_reference ?? refund.transaction_reference ?? "no_reference";
  const base = paystackEnvelopeBase(
    "refund",
    externalId,
    paystackRefundRevision(refund),
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
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
    case "processed":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "processed",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
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
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
    case "abandoned":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "abandoned",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "refund_abandoned",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: refund.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: PAYSTACK_SHAREABLE_FIELDS,
      });
  }
}

/**
 * A Paystack bank list → one lossless eligibility-evidence envelope. Every
 * bank entry (name, code, supports_transfer, active/is_delisted) is carried
 * VERBATIM in `state.data`; the family stays `other` (an observation, not a
 * payment lifecycle).
 */
export function paystackBankListEnvelope(
  banks: readonly PaystackBankProviderObject[],
  currency: string,
  context: PaystackEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: PAYSTACK_PROVIDER_NAME,
    providerVersion: PAYSTACK_API_VERSION,
    objectType: "bank_list",
    externalId: `bank-list:${currency.toUpperCase()}`,
    revision: `bank-list:${currency.toUpperCase()}:${banks.length}`,
    state: Object.freeze({ currency: currency.toUpperCase(), data: banks }),
    family: "other",
    lifecycleStep: "enumerated",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: PAYSTACK_SHAREABLE_FIELDS,
  });
}

/** The eligibility evidence derived from one observed bank enumeration. */
export interface PaystackBankRailEvidence {
  readonly currency: string;
  readonly bankCount: number;
  readonly banksSupportingTransfer: number;
  readonly activeBanks: number;
  readonly delistedBanks: number;
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "OPERATOR";
  /** Exemplar bank proving the rail is live (supports_transfer true). */
  readonly exemplarTransferBank:
    | { readonly name: string; readonly code: string; readonly supportsTransfer: boolean }
    | null;
}

/**
 * Derives the bank-rail eligibility evidence from an OBSERVED enumeration
 * (INV-C06: counts are derived, bank entries never become domain
 * primitives; the raw list rides the envelope verbatim).
 */
export function paystackBankRailEvidence(
  banks: readonly PaystackBankProviderObject[],
  currency: string,
  observedAt: string,
  provenanceSource: "PROVIDER_API" | "OPERATOR" = "PROVIDER_API",
): PaystackBankRailEvidence {
  let banksSupportingTransfer = 0;
  let activeBanks = 0;
  let delistedBanks = 0;
  let exemplar: PaystackBankRailEvidence["exemplarTransferBank"] = null;
  for (const bank of banks) {
    if (bank.supports_transfer === true) {
      banksSupportingTransfer += 1;
      if (exemplar === null && typeof bank.name === "string" && typeof bank.code === "string") {
        exemplar = Object.freeze({
          name: bank.name,
          code: bank.code,
          supportsTransfer: true,
        });
      }
    }
    if (bank.active === true) {
      activeBanks += 1;
    }
    if (bank.is_delisted === true) {
      delistedBanks += 1;
    }
  }
  return Object.freeze({
    currency: currency.toUpperCase(),
    bankCount: banks.length,
    banksSupportingTransfer,
    activeBanks,
    delistedBanks,
    observedAt,
    provenanceSource,
    exemplarTransferBank: exemplar,
  });
}

/**
 * Maps a Paystack webhook payload ({ event, data }) to the lossless envelope
 * for its inner object. `charge.*` events carry a transaction; refund events
 * carry a refund; everything else produces an `event`-typed envelope carrying
 * the WHOLE payload verbatim — nothing is dropped (INV-C06).
 */
export function paystackWebhookEventEnvelope(
  payload: {
    readonly event?: string;
    readonly data?: unknown;
    readonly [key: string]: unknown;
  },
  context: PaystackEnvelopeContext,
): ProviderStateEnvelope {
  const webhookContext: PaystackEnvelopeContext = {
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
  const data = payload.data;
  if (payload.event !== undefined && data !== null && typeof data === "object") {
    if (payload.event.startsWith("charge.")) {
      const tx = data as PaystackTransactionProviderObject;
      if (typeof tx.reference === "string" || typeof tx.status === "string") {
        return paystackTransactionEnvelope(tx, webhookContext);
      }
    }
    if (payload.event.startsWith("refund.")) {
      const refund = data as PaystackRefundProviderObject;
      if (
        typeof refund.refund_reference === "string" ||
        typeof refund.transaction_reference === "string"
      ) {
        return paystackRefundEnvelope(refund, webhookContext);
      }
    }
  }
  return railEnvelope({
    providerName: PAYSTACK_PROVIDER_NAME,
    providerVersion: PAYSTACK_API_VERSION,
    objectType: "event",
    externalId: `event:${payload.event ?? "untyped"}`,
    revision: `${payload.event ?? "untyped"}`,
    state: payload,
    family: "other",
    lifecycleStep: payload.event ?? "untyped",
    isTerminal: false,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    shareableFields: PAYSTACK_SHAREABLE_FIELDS,
  });
}

// ---------------------------------------------------------------------------
// Webhook verification (X-Paystack-Signature: HMAC-SHA512 over the RAW body)
// ---------------------------------------------------------------------------

/**
 * Deterministic Paystack webhook signature: HMAC-SHA512(secret, rawBody) hex.
 * Per public documentation Paystack signs the RAW request bytes with the
 * account's SECRET KEY — there is NO timestamp in the scheme (replay defense
 * is the (provider, eventId) dedupe at the ingestor, not a signed window).
 */
export function paystackSignWebhookPayload(secret: string, rawPayload: string): string {
  const mac = createHmac("sha512", secret);
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

/** The byte-exact verification result for one Paystack webhook delivery. */
export type PaystackWebhookDeliveryVerification =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: "MISSING_SIGNATURE" | "SIGNATURE_INVALID";
    };

/**
 * Byte-exact Paystack webhook delivery verification: the `X-Paystack-Signature`
 * header must equal HMAC-SHA512(secret, rawPayload) hex, compared
 * CONSTANT-TIME. The RAW body is required — a re-serialized payload changes
 * the bytes and correctly fails. No timestamp exists in the scheme.
 */
export function verifyPaystackWebhookDelivery(
  delivery: { readonly signatureHeader: string | undefined; readonly rawPayload: string },
  deps: { readonly secret: string },
): PaystackWebhookDeliveryVerification {
  if (
    typeof delivery.signatureHeader !== "string" ||
    delivery.signatureHeader.length === 0
  ) {
    return { valid: false, reason: "MISSING_SIGNATURE" };
  }
  const expected = paystackSignWebhookPayload(deps.secret, delivery.rawPayload);
  if (!constantTimeHexEquals(delivery.signatureHeader, expected)) {
    return { valid: false, reason: "SIGNATURE_INVALID" };
  }
  return { valid: true };
}

/**
 * Extracts the provider-declared event timestamp (epoch seconds, string) from
 * a Paystack webhook payload's `data.created_at` — the deterministic,
 * clock-free source the ingestor's replay window consumes. Undefined when the
 * payload declares none (the caller then supplies its own observation).
 */
export function paystackWebhookEventTimestamp(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const data = (payload as { readonly data?: unknown }).data;
  if (data === null || typeof data !== "object") {
    return undefined;
  }
  const createdAt = (data as { readonly created_at?: unknown; readonly createdAt?: unknown })
    .created_at ?? (data as { readonly createdAt?: unknown }).createdAt;
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
 * Adapts a raw Paystack delivery into the adapters' ProviderWebhookRawEvent.
 * `timestampSeconds` is the provider-declared event time
 * (paystackWebhookEventTimestamp) — the ingestor's replay window runs on it.
 */
export function paystackWebhookRawEvent(delivery: {
  readonly eventId: string;
  readonly payload: unknown;
  readonly signatureHeader: string;
  readonly timestampSeconds: string;
}): ProviderWebhookRawEvent {
  return Object.freeze({
    providerName: PAYSTACK_PROVIDER_NAME,
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
 * The Paystack signature verifier on the adapters' WebhookSignatureVerifier
 * hook. The ingestor hands the CANONICAL body (JSON.stringify of the parsed
 * payload): verification succeeds exactly when the canonical serialization
 * equals the delivered bytes (the transport must preserve the raw body; use
 * {@link verifyPaystackWebhookDelivery} for byte-exact verification of raw
 * deliveries).
 */
export class PaystackWebhookVerifier implements WebhookSignatureVerifier {
  readonly #secret: string;

  constructor(secret: string) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new ValidationError("a Paystack webhook verifier requires a non-empty secret");
    }
    this.#secret = secret;
  }

  verify(
    event: ProviderWebhookRawEvent,
    canonicalBody: string,
  ): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
    const expected = paystackSignWebhookPayload(this.#secret, canonicalBody);
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
 * Wires a ProviderWebhookIngestor for Paystack: X-Paystack-Signature
 * verification, replay window over the provider-declared event time,
 * (provider, eventId) dedupe and append-only evidence — the adapters
 * ingestor pattern with the Paystack scheme plugged in.
 */
export function createPaystackWebhookIngestor(deps: {
  readonly secret: string;
  readonly clock: ProtocolClock;
  readonly replayWindowSeconds?: number;
  readonly futureSkewSeconds?: number;
}): ProviderWebhookIngestor {
  return new WebhookIngestor({
    verifier: new PaystackWebhookVerifier(deps.secret),
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
// Idempotency (the payment reference IS the idempotency key at Paystack)
// ---------------------------------------------------------------------------

/**
 * Derives the Paystack payment reference from the protocol idempotency key
 * (INV-F05). Paystack has no Idempotency-Key header: the caller-supplied
 * `reference` is the idempotency mechanism (a duplicate reference is
 * rejected by the provider). Deterministic: same protocol key → same
 * reference on every retry.
 */
export function paystackPaymentReference(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap:${protocolIdempotencyKey}`;
}

/**
 * A duplicate-reference rejection: the SAME reference was submitted to
 * /v3/payment/initialize twice. The second request was NOT executed (the
 * original transaction holding the reference was) — an ERROR STATE, never a
 * silent success; reconcile by verifying the reference.
 */
export class PaystackDuplicateReferenceError extends RailProviderError {
  constructor(message: string, details?: PaySwapError["details"]) {
    super(message, details);
    this.name = "PaystackDuplicateReferenceError";
  }
}

// ---------------------------------------------------------------------------
// The RailAdapter surface (provider-neutral framework registration)
// ---------------------------------------------------------------------------

/** The Paystack production rail adapter on the BaseRailAdapter framework. */
export class PaystackProductionRail extends BaseRailAdapter {
  readonly adapterId = PAYSTACK_RAIL_ADAPTER_ID;
  readonly implementationId = PAYSTACK_RAIL_IMPLEMENTATION_ID;

  constructor() {
    const definitions = new Map<string, CapabilityDefinition>();
    for (const definition of paystackCapabilityDefinitions()) {
      definitions.set(definition.capabilityId, definition);
    }
    super(paystackRailCapabilityPack(), definitions);
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK; credential-gated, fail-closed)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface PaystackControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface PaystackConnectorConfig {
  readonly clock: ProtocolClock;
  readonly apiBase?: string;
  /** Overrides the pinned API version (tests only — production pins). */
  readonly apiVersion?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("paystack")` = PROVIDER_PAYSTACK_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: PaystackControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type PaystackSdkRequest =
  | {
      readonly kind: "initialize_payment";
      readonly amountMinor: string;
      readonly currency: string;
      readonly email: string;
      /** Overrides the derived reference (paystackPaymentReference). */
      readonly reference?: string;
      readonly callbackUrl?: string;
      /** Channel selection: card, bank/local methods, USSD, QR, mobile money, EFT. */
      readonly channels?: readonly string[];
    }
  | {
      readonly kind: "charge_authorization";
      readonly amountMinor: string;
      readonly currency?: string;
      readonly email: string;
      /** The saved Paystack authorization code (the recurring path). */
      readonly authorizationCode: string;
      readonly reference?: string;
    }
  | { readonly kind: "verify_payment"; readonly reference: string }
  | {
      readonly kind: "create_refund";
      /** The transaction reference (or id) to refund. */
      readonly transaction: string;
      readonly amountMinor?: string;
      readonly customerNote?: string;
      readonly merchantNote?: string;
    }
  | { readonly kind: "list_banks"; readonly currency: string };

function isPaystackSdkRequest(candidate: unknown): candidate is PaystackSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** Which credential path is live (observability — NEVER material). */
export type PaystackCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/**
 * The real Paystack connector (ConnectorSDK framework). Paystack API names,
 * payloads, response shapes and quirks stay INSIDE this implementation: the
 * SDK call contract is the provider-neutral `PaystackSdkRequest` union.
 * Every effectful operation runs behind `requireAuthority` (INV-C04/F05/F06)
 * and fails closed with `RailNotAuthorizedError` BEFORE any provider call
 * when no credential path is live (INV-NC04).
 */
export class PaystackConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: PaystackControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  #credentialBaseline: string | undefined;

  constructor(config: PaystackConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase = config.apiBase ?? PAYSTACK_DEFAULT_API_BASE;
    this.#apiVersion = config.apiVersion ?? PAYSTACK_API_VERSION;
    this.#credentialConfigKey =
      config.credentialConfigKey ?? PAYSTACK_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: PAYSTACK_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "Paystack (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return paystackRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): PaystackCredentialResolutionState {
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
          providerName: PAYSTACK_PROVIDER_NAME,
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
          providerName: PAYSTACK_PROVIDER_NAME,
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
        providerName: PAYSTACK_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(PAYSTACK_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface --------------------------------------------------

  async search(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "search");
    const request = this.#request(ctx, "list_banks");
    if (request.kind !== "list_banks") {
      throw new ValidationError("paystack search supports only { kind: 'list_banks' }");
    }
    const observedAt = this.#envelopeContext();
    const list = await this.#withCredentials(async (material) =>
      this.#providerGet(
        `/v1/bank?currency=${encodeURIComponent(request.currency.toUpperCase())}&perPage=100`,
        ctx.idempotencyKey,
        material,
      ),
    );
    const banks = this.#responseData(list) as unknown as readonly PaystackBankProviderObject[];
    return this.#sdkResult(
      paystackBankListEnvelope(banks, request.currency, observedAt),
      `paystack:list-banks:${request.currency.toUpperCase()}:${this.#clock.now()}`,
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "verify_payment");
    if (request.kind !== "verify_payment") {
      throw new ValidationError("paystack read supports only { kind: 'verify_payment' }");
    }
    const observedAt = this.#envelopeContext();
    // A verify read that cannot reach the provider propagates
    // RailTransportError — NO fabricated provider state, and never a FAILED
    // payment from a timeout (INV-X01).
    const data = await this.#withCredentials(async (material) =>
      this.#providerGet(
        `/v2/payment/verify/${encodeURIComponent(request.reference)}`,
        ctx.idempotencyKey,
        material,
      ),
    );
    return this.#sdkResult(
      paystackTransactionEnvelope(
        data as PaystackTransactionProviderObject,
        observedAt,
      ),
      `paystack:verify-payment:${request.reference}`,
    );
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "initialize_payment");
    const observedAt = this.#envelopeContext();
    if (request.kind === "initialize_payment") {
      if (request.amountMinor === undefined || request.currency === undefined || request.email === undefined) {
        throw new ValidationError(
          "initialize_payment requires amountMinor (exact minor units), currency and email",
        );
      }
      const reference = request.reference ?? paystackPaymentReference(ctx.idempotencyKey);
      const body: Record<string, unknown> = {
        amount: Number(request.amountMinor),
        currency: request.currency.toUpperCase(),
        email: request.email,
        reference,
      };
      if (request.callbackUrl !== undefined) {
        body.callback_url = request.callbackUrl;
      }
      if (request.channels !== undefined && request.channels.length > 0) {
        body.channels = [...request.channels];
      }
      // INV-X01: a transport failure mid-initialize is OUTCOME_UNKNOWN — an
      // object with this reference may exist at the provider; reconcile by
      // verifying the reference. NEVER FAILED.
      try {
        const data = await this.#withCredentials(async (material) =>
          this.#providerPost("/v3/payment/initialize", body, ctx.idempotencyKey, material),
        );
        const initData = (data ?? {}) as PaystackPaymentInitProviderObject;
        const state =
          typeof initData.reference === "string" && initData.reference.length > 0
            ? initData
            : { ...initData, reference };
        return this.#sdkResult(
          paystackPaymentInitEnvelope(state, observedAt),
          `paystack:initialize-payment:${reference}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "payment_init",
            externalId: reference,
            operation: "initialize_payment",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    if (request.kind === "charge_authorization") {
      if (
        request.amountMinor === undefined ||
        request.email === undefined ||
        request.authorizationCode === undefined
      ) {
        throw new ValidationError(
          "charge_authorization requires amountMinor, email and authorizationCode",
        );
      }
      const reference = request.reference ?? paystackPaymentReference(ctx.idempotencyKey);
      const body: Record<string, unknown> = {
        amount: Number(request.amountMinor),
        email: request.email,
        authorization_code: request.authorizationCode,
        reference,
        ...(request.currency !== undefined ? { currency: request.currency.toUpperCase() } : {}),
      };
      // INV-X01: value CAN move on a recurring charge — a mid-charge
      // transport failure is OUTCOME_UNKNOWN, never FAILED.
      try {
        const data = await this.#withCredentials(async (material) =>
          this.#providerPost("/v3/charge", body, ctx.idempotencyKey, material),
        );
        const tx = (data ?? {}) as PaystackTransactionProviderObject;
        const state =
          typeof tx.reference === "string" && tx.reference.length > 0
            ? tx
            : { ...tx, reference };
        return this.#sdkResult(
          paystackTransactionEnvelope(state, observedAt),
          `paystack:charge-authorization:${reference}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "transaction",
            externalId: reference,
            operation: "charge_authorization",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    throw new ValidationError(
      `paystack create supports initialize_payment/charge_authorization — got kind '${request.kind}'`,
    );
  }

  async update(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "paystack payment objects are not mutable at the provider (initialize → payer authorization → verify lifecycle only)",
    );
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "create_refund");
    if (request.kind !== "create_refund") {
      throw new ValidationError("paystack executeAction supports only { kind: 'create_refund' }");
    }
    if (request.transaction === undefined) {
      throw new ValidationError("create_refund requires transaction (the transaction reference or id)");
    }
    const observedAt = this.#envelopeContext();
    const body: Record<string, unknown> = { transaction: request.transaction };
    if (request.amountMinor !== undefined) {
      body.amount = Number(request.amountMinor);
    }
    if (request.customerNote !== undefined) {
      body.customer_note = request.customerNote;
    }
    if (request.merchantNote !== undefined) {
      body.merchant_note = request.merchantNote;
    }
    // INV-X01: value can move on a refund — OUTCOME_UNKNOWN, never FAILED.
    try {
      const data = await this.#withCredentials(async (material) =>
        this.#providerPost("/v3/refund", body, ctx.idempotencyKey, material),
      );
      const refundData = (data ?? {}) as PaystackRefundProviderObject;
      const state =
        typeof refundData.refund_reference !== "string" &&
        typeof refundData.transaction_reference !== "string"
          ? { ...refundData, transaction_reference: request.transaction }
          : refundData;
      return this.#sdkResult(
        paystackRefundEnvelope(state, observedAt),
        `paystack:create-refund:${request.transaction}:${this.#clock.now()}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "refund",
          externalId: request.transaction,
          operation: "create_refund",
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
      "paystack event subscription is handled by the webhook ingestion framework (createPaystackWebhookIngestor + @payswap/adapters ProviderWebhookIngestor), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "verify_payment");
    if (request.kind !== "verify_payment") {
      throw new ValidationError("paystack reconcile supports only { kind: 'verify_payment' }");
    }
    // Reconciliation-as-authority (INV-X03): re-fetch by external reference.
    return this.read(ctx);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "paystack disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and release the sealed credential handle); the provider surface offers no self-disconnect",
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md, Paystack path —
   * swap-reference-then-verify): the vault binding for the control-plane
   * config key is swapped to a NEW reference at the vault; the connector
   * re-resolves per call, so the rotation is real exactly when the NEW
   * reference resolves and serves a successful health probe. The old key is
   * revoked at Paystack only after that verification.
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
          evidenceId: `paystack:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: PAYSTACK_PROVIDER_NAME,
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
        "cannot rotate credentials: no credential path is provisioned for the paystack rail (packages/rails/BLOCKED-RAILS.md)",
        { railId: PAYSTACK_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = createHmac("sha256", "payswap-paystack-rotation-baseline")
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
        evidenceId: `paystack:cred-rotation:${rotatedAt}`,
        evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
        kind: "AUDIT_LOG",
        providerState: railEnvelope({
          providerName: PAYSTACK_PROVIDER_NAME,
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
   * authenticated bank enumeration (the real probe) → HEALTHY.
   */
  async health(): Promise<ConnectorHealthReport> {
    const resolution = this.credentialResolutionState();
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: PAYSTACK_CONNECTOR_ID,
      providerName: PAYSTACK_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (resolution.kind === "NOT_PROVISIONED") {
      let endpointAnswered: boolean;
      try {
        await this.#http(`${this.#apiBase}/v1/bank?currency=NGN`, {
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
        this.#providerGet("/v1/bank?currency=NGN&perPage=1", "health-probe", material),
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

  // -- dedicated observation methods (read-only eligibility evidence) ----------

  /**
   * OBSERVED bank enumeration for one currency — the live eligibility
   * evidence (GET /v1/bank?currency=…), preserving every bank entry
   * verbatim. Fails closed without credentials. An unsupported currency is
   * whatever the provider answers (an error or an empty list — honest
   * either way, never fabricated).
   */
  async bankEnumeration(
    currency: string,
  ): Promise<{
    readonly evidence: PaystackBankRailEvidence;
    readonly envelope: ProviderStateEnvelope;
  }> {
    const observedAt = this.#envelopeContext();
    const data = await this.#withCredentials(async (material) =>
      this.#providerGet(
        `/v1/bank?currency=${encodeURIComponent(currency.toUpperCase())}&perPage=100`,
        "bank-enumeration",
        material,
      ),
    );
    const banks = this.#responseData(data) as unknown as readonly PaystackBankProviderObject[];
    return Object.freeze({
      evidence: paystackBankRailEvidence(
        banks,
        currency,
        observedAt.observedAt,
        "PROVIDER_API",
      ),
      envelope: paystackBankListEnvelope(banks, currency, observedAt),
    });
  }

  // -- internals -------------------------------------------------------------------

  #envelopeContext(): PaystackEnvelopeContext {
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
          "paystack rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: PAYSTACK_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => fn(extractPaystackKeyMaterial(opened.material)),
      );
    }
    const material = this.#envMaterial();
    if (material === undefined) {
      throw new RailNotAuthorizedError(
        "paystack rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md)",
        { railId: PAYSTACK_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    return fn(material);
  }

  #request(ctx: SdkCallContext, expectedKind: string): PaystackSdkRequest {
    const candidate = ctx.request;
    if (!isPaystackSdkRequest(candidate)) {
      throw new ValidationError(
        `paystack rail call request must be a PaystackSdkRequest object (expected kind '${expectedKind}')`,
      );
    }
    if (
      "amountMinor" in candidate &&
      candidate.amountMinor !== undefined &&
      !/^\d+$/.test(String(candidate.amountMinor))
    ) {
      throw new ValidationError(
        "amountMinor must be an exact integer minor-units string (kobo/pesewas/cents — INV-F01)",
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
      providerName: PAYSTACK_PROVIDER_NAME,
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
        note: "transport failed mid-effect — the provider effect may have landed; reconcile by verifying the reference (INV-X01/INV-X03); never coerced to FAILED",
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
      shareableFields: PAYSTACK_SHAREABLE_FIELDS,
    });
    return this.#sdkResult(envelope, `paystack:outcome-unknown:${input.operation}:${input.idempotencyKey}`);
  }

  #responseData(body: unknown): unknown {
    if (body !== null && typeof body === "object" && "data" in body) {
      return (body as { readonly data?: unknown }).data;
    }
    throw new RailProviderError(
      "paystack response is malformed (expected { status, message, data })",
    );
  }

  async #providerGet(path: string, callRef: string, material?: string): Promise<unknown> {
    const run = async (key: string): Promise<unknown> => {
      let response: { readonly status: number; readonly bodyText: string };
      try {
        response = await this.#http(`${this.#apiBase}${path}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
          timeoutMs: this.#timeoutMs,
        });
      } catch (cause) {
        throw new RailTransportError("paystack provider transport unreachable", {
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
    body: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    material: string,
  ): Promise<unknown> {
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${material}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("paystack provider transport unreachable", {
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
      throw new RailProviderError("paystack provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const body = parsed as {
      readonly status?: boolean;
      readonly message?: string;
      readonly data?: unknown;
    };
    if (body !== null && typeof body === "object" && body.status === false) {
      if (/duplicate reference/i.test(body.message ?? "")) {
        // The reference already holds a transaction: the request was NOT
        // executed — an error state, never a silent success (reconcile by
        // verifying the reference).
        throw new PaystackDuplicateReferenceError(
          "paystack duplicate reference: this reference already holds a transaction — the initialize was NOT executed; verify the reference to observe the original",
          { path, idempotencyKey: callRef, httpStatus: response.status },
        );
      }
      throw new RailProviderError(
        `paystack provider answered HTTP ${response.status}: ${body.message ?? "provider error"}`,
        { path, httpStatus: response.status },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(`paystack provider answered HTTP ${response.status}`, {
        path,
        httpStatus: response.status,
      });
    }
    return body.data;
  }
}

/**
 * Extracts the Paystack key material from a vault bundle shape. The control
 * plane hands the connector whatever the vault object holds: a plain string
 * key (sk_test_…/sk_live_…), or a bundle record ({ secretKey } /
 * { secret_key } / { apiKey } / { api_key }). Any other shape refuses the
 * call (fail-closed, no guessing).
 */
export function extractPaystackKeyMaterial(material: unknown): string {
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
    "the sealed credential bundle does not contain Paystack key material (expected a string key or { secretKey | secret_key | apiKey | api_key })",
  );
}
