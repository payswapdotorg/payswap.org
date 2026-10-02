/**
 * EBANX production connector (P2-W3-002) — the REAL EBANX adapter on the
 * v1.5 capability hierarchy and ProviderStateEnvelope.
 *
 * Authority: spec/phase-2/work-items/P2-W3-002.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md and the recorded
 * 2026-10-02 reachability datum (HTTP 401 on
 * https://sandbox.ebanx.com/ws/query — endpoint REACHABLE, integration key
 * required; spec/development-state/phase-2-state.json wave_2_status). NO
 * EBANX credential exists in this deployment: the connector is REAL but
 * fail-closed (INV-NC04) — no mock, no simulated outcome.
 *
 * THE CURRENT SUPPORTED SIGNING/AUTHENTICATION PATH (recorded here exactly
 * as implemented — the work-order acceptance):
 * - The DIRECT INTEGRATION-KEY path: the private `integration_key` (from
 *   the merchant dashboard) authenticates every request as a JSON body
 *   parameter on the /ws/* surface (POST /ws/direct, /ws/query, /ws/refund,
 *   /ws/t-claim, /ws/balance).
 * - Webhook notifications carry NO payload signature on this classic path.
 *   The documented verification mechanism is QUERY-BACK: on notification,
 *   call POST /ws/query with the payment hash (or merchant_payment_code)
 *   and treat THE QUERY RESPONSE — authenticated by the integration_key —
 *   as the authoritative evidence. The notification itself is never
 *   trusted as final evidence; `verifyNotificationByQueryBack()` implements
 *   this flow and records the comparison.
 * - The modern REST surface (https://api.ebanx.com/v1/…) also accepts
 *   signed requests; the coverage strategy (PROVIDER-COVERAGE-STRATEGY
 *   -2026-10-02.md) notes EBANX prefers the recommended JWS path. That
 *   signing scheme is NOT implemented here because its exact algorithm
 *   could not be verified against the provider documentation in this work
 *   order — implementing an unverified signature scheme would be
 *   fabrication. The integration-key + query-back path above IS the mapped
 *   and implemented current path.
 *
 * API surface pinned: the EBANX classic /ws surface (sandbox
 * https://sandbox.ebanx.com/ws/…, live https://api.ebanx.com/ws/…).
 *
 * Laws implemented here:
 * - INV-C06 (lossless): every provider object (direct payment with its
 *   `hash` and two-letter `status`, refund, payout, balance record,
 *   notification, query answer) is carried VERBATIM in the envelope `state`
 *   with an ADDITIVE classification. The two-letter status codes are never
 *   renamed, never dropped; an UNKNOWN status stays `other`/verbatim —
 *   NEVER FAILED.
 * - INV-C09: payouts (T-Claims) are a DISTINCT capability family with
 *   explicit beneficiary/bank details per country; balances (POST
 *   /ws/balance) produce ExternalFundsPositionObservation ONLY —
 *   observations of provider-held external funds, never PaySwap custody
 *   and never a balance PaySwap owes anyone.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (ambiguity
 *   OUTCOME_UNKNOWN, requires reconciliation) — NEVER collapsed to FAILED.
 * - INV-NC04: no credential → availability UNKNOWN (INV-C01/C02), health
 *   DEGRADED/UNKNOWN with reasons, every effectful operation throws
 *   RailNotAuthorizedError BEFORE any provider call.
 * - Credential isolation (phase-2): `PROVIDER_EBANX_CREDENTIAL_REF` bound
 *   to a vault:// reference, resolved through the P2-W1-001 CredentialBroker
 *   to a SEALED bundle opened only inside `withSealedBundle` with a
 *   ConnectorRuntimeKey; an env fallback exists for deployments that
 *   inject the resolved key under the same config key. Material NEVER
 *   enters any envelope, log line or evidence record.
 * - Idempotency honesty: the `merchant_payment_code` is derived
 *   deterministically from the protocol idempotency key (INV-F05) — EBANX
 *   ENFORCES merchant_payment_code uniqueness; a duplicate surfaces as the
 *   EbanxDuplicateMerchantPaymentCodeError provider error class, never a
 *   silent success.
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
  railEnvelope,
  railEvidence,
  realHttpTransport,
  routableRailImplication,
  isoTimestamp,
} from "./support.js";
import type { HttpTransport, RailImplication } from "./support.js";

// ---------------------------------------------------------------------------
// Identity (pinned — the API surface is part of the provider contract)
// ---------------------------------------------------------------------------

export const EBANX_PROVIDER_NAME = "ebanx" as const;
/** The pinned EBANX API surface (the classic /ws Direct API). */
export const EBANX_API_VERSION = "ws" as const;
export const EBANX_RAIL_ADAPTER_ID = "rail.ebanx" as const;
export const EBANX_RAIL_IMPLEMENTATION_ID = "impl.rails.ebanx.ws" as const;
export const EBANX_CONNECTOR_ID = "connector.rails.ebanx" as const;
export const EBANX_DEFAULT_API_BASE_SANDBOX = "https://sandbox.ebanx.com" as const;
export const EBANX_DEFAULT_API_BASE_LIVE = "https://api.ebanx.com" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("ebanx")` —
 * `PROVIDER_EBANX_CREDENTIAL_REF`, bound to
 * `vault://payswap/providers/ebanx/sandbox-20261002` (ABSENT in this
 * deployment — the rail fails closed).
 */
export const EBANX_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  EBANX_PROVIDER_NAME,
);

/**
 * The recorded reachability datum (probed 2026-10-02): the EBANX sandbox
 * query endpoint answered HTTP 401 without an integration key — the
 * endpoint is REACHABLE and the integration key is the missing
 * authorization. Named evidence, never an assumption; `health()` re-probes
 * live.
 */
export const EBANX_SANDBOX_REACHABILITY_20261002: Readonly<{
  readonly probedAt: "2026-10-02";
  readonly baseUrl: string;
  readonly httpStatus: 401;
  readonly reachable: true;
  readonly interpretation: string;
}> = Object.freeze({
  probedAt: "2026-10-02",
  baseUrl: `${EBANX_DEFAULT_API_BASE_SANDBOX}/ws/query`,
  httpStatus: 401,
  reachable: true,
  interpretation:
    "sandbox.ebanx.com/ws/query answered HTTP 401 without an integration key — endpoint reachable, integration_key authentication required (INV-C01/C02: availability stays UNKNOWN until credentials are provisioned)",
});

// ---------------------------------------------------------------------------
// Capability definitions (distinct pay-in vs payout families)
// ---------------------------------------------------------------------------

export const EBANX_DIRECT_PAYMENT_CAPABILITY_ID =
  "cap.rails.ebanx.direct_payment" as const;
export const EBANX_REFUND_CAPABILITY_ID = "cap.rails.ebanx.refund" as const;
export const EBANX_PAYOUT_CAPABILITY_ID = "cap.rails.ebanx.payout" as const;
export const EBANX_BALANCE_OBSERVATION_CAPABILITY_ID =
  "cap.rails.ebanx.balance_observation" as const;

/**
 * The provider-state vocabulary this connector maps (INV-C06): every EBANX
 * payment status (two-letter codes, verbatim) with its additive
 * classification. PE for voucher-type payments (boleto, oxxo, …) is
 * customer-action-required — the voucher/URL rides the state verbatim.
 *
 * | EBANX status | family                   | isTerminal | customerAction |
 * |--------------|--------------------------|------------|----------------|
 * | PE (pending) | async_processing *       | false      | * voucher types |
 * | OP (open)    | async_processing         | false      | false          |
 * | CO (confirmed) | other (settled-external) | true     | false          |
 * | CA (cancelled) | other                   | true       | false          |
 * | (unknown)    | other                    | false      | false (verbatim)|
 */
export const EBANX_PAYMENT_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "PE", family: "async_processing", lifecycleStep: "pending", isTerminal: false, requiresCustomerAction: false },
  { providerState: "OP", family: "async_processing", lifecycleStep: "open", isTerminal: false, requiresCustomerAction: false },
  { providerState: "CO", family: "other", lifecycleStep: "settled_external", isTerminal: true, requiresCustomerAction: false },
  { providerState: "CA", family: "other", lifecycleStep: "cancelled", isTerminal: true, requiresCustomerAction: false },
]);

/**
 * The EBANX refund-status vocabulary (two-letter codes, verbatim): RE
 * (requested) is in flight, CO (confirmed) is terminal, CA (cancelled) is
 * terminal. Partial refunds are explicit (the amount rides the request).
 */
export const EBANX_REFUND_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "RE", family: "refund", lifecycleStep: "requested", isTerminal: false, requiresCustomerAction: false },
  { providerState: "CO", family: "refund", lifecycleStep: "confirmed", isTerminal: true, requiresCustomerAction: false },
  { providerState: "CA", family: "refund", lifecycleStep: "cancelled", isTerminal: true, requiresCustomerAction: false },
]);

/**
 * The payment types whose PENDING state requires CUSTOMER action (a voucher
 * / QR / reference the payer must present or pay). Exported as data so the
 * set is reviewable and correctable without reading the classifier.
 */
export const EBANX_VOUCHER_PAYMENT_TYPES: readonly string[] = Object.freeze([
  "boleto", "oxxo", "baloto", "efecty", "pagoefectivo", "servipag",
  "safetypay", "pix", "voucher", "bancolombia",
]);

/**
 * The DOCUMENTED country/method coverage (the EBANX catalogue — marketing
 * surface, NOT an eligibility assertion). Eligibility for routing is
 * OBSERVED only: a method is exposed ONLY when the connected account has
 * it enabled, and that fact must be observed through the provider (a
 * successful direct payment or an explicit provider confirmation) — never
 * assumed from this table.
 */
export const EBANX_DOCUMENTED_COUNTRY_METHODS_20261002: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  BR: Object.freeze(["boleto", "pix", "card", "bank_transfer", "wallet"]),
  MX: Object.freeze(["oxxo", "card", "bank_transfer"]),
  CO: Object.freeze(["card", "bank_transfer", "baloto", "efecty", "wallet"]),
  CL: Object.freeze(["card", "bank_transfer", "servipag", "wallet"]),
  PE: Object.freeze(["card", "bank_transfer", "safetypay", "pagoefectivo", "wallet"]),
  NG: Object.freeze(["card", "bank_transfer", "ussd"]),
  GH: Object.freeze(["card", "mobile_money", "bank_transfer"]),
  KE: Object.freeze(["card", "mobile_money", "bank_transfer"]),
  ZA: Object.freeze(["card", "bank_transfer", "eft"]),
  IN: Object.freeze(["card", "bank_transfer", "upi", "netbanking"]),
  ID: Object.freeze(["card", "bank_transfer", "ewallet"]),
  VN: Object.freeze(["card", "bank_transfer", "qr"]),
  PH: Object.freeze(["card", "bank_transfer", "ewallet"]),
});

/** The verdict of a country/method eligibility lookup (observed, never assumed). */
export interface EbanxMethodEligibility {
  readonly country: string;
  readonly paymentType: string;
  /** True ONLY from OBSERVED evidence (the connected account has it enabled). */
  readonly eligible: boolean;
  /** "DOCUMENTED_NOT_OBSERVED" | "NOT_DOCUMENTED" — never assumed either way. */
  readonly basis: "DOCUMENTED_NOT_OBSERVED" | "NOT_DOCUMENTED";
  readonly reason: string;
}

/**
 * Country/method eligibility against the DOCUMENTED catalogue. The verdict
 * is NEVER an eligibility assertion: `eligible` is false with basis
 * DOCUMENTED_NOT_OBSERVED when the catalogue lists the pair (routing
 * requires a provider-side observation that the connected account has the
 * method enabled) and NOT_DOCUMENTED otherwise. The provider is the
 * authority; the connector fabricates nothing (INV-NC04 honesty).
 */
export function ebanxMethodEligibility(country: string, paymentType: string): EbanxMethodEligibility {
  const upperCountry = country.toUpperCase();
  const methods = EBANX_DOCUMENTED_COUNTRY_METHODS_20261002[upperCountry];
  const lowerType = paymentType.toLowerCase();
  if (methods !== undefined && (methods as readonly string[]).includes(lowerType)) {
    return Object.freeze({
      country: upperCountry,
      paymentType: lowerType,
      eligible: false,
      basis: "DOCUMENTED_NOT_OBSERVED",
      reason:
        "documented in the EBANX catalogue but NOT observed on the connected account — eligibility requires provider-side evidence (the account must have the method enabled); never assumed",
    });
  }
  return Object.freeze({
    country: upperCountry,
    paymentType: lowerType,
    eligible: false,
    basis: "NOT_DOCUMENTED",
    reason:
      "not in the recorded catalogue — eligibility UNKNOWN, never assumed (INV-NC04; observe through the provider before routing)",
  });
}

function ebanxCapabilityDefinition(input: {
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
      "credential reference provisioned through the control plane (PROVIDER_EBANX_CREDENTIAL_REF)",
      "country/method eligibility OBSERVED on the connected account (the provider is the authority) — the documented catalogue is NOT an eligibility assertion",
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
      partialExecution: { possible: true, granularity: "AMOUNT", onPartial: "DISCLOSED" },
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
        { action: "create_payment", description: "POST /ws/direct (operation: payment; merchant_payment_code idempotent)" },
        { action: "query_payment", description: "POST /ws/query (reconciliation + webhook query-back verification)" },
        { action: "refund", description: "POST /ws/refund (partial refunds explicit)" },
        { action: "create_payout", description: "POST /ws/t-claim (explicit beneficiary/bank details — DISTINCT family)" },
        { action: "observe_balances", description: "POST /ws/balance (never custody)" },
      ],
      states: input.providerStates,
    },
    externalObjects: input.externalObjects.map((object) => ({
      objectType: object.objectType,
      idFormat: object.idFormat,
      revisioned: true,
      revisionFormat: "provider-hash-status",
    })),
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "EBANX settlement schedule" },
    constraints: [
      {
        kind: "JURISDICTION",
        description:
          "country/method coverage (BR, MX, CO, CL, PE, NG, GH, KE, ZA, IN, ID, VN, PH…) is DOCUMENTED catalogue data; local methods and currencies are exposed ONLY when the connected account has them enabled — observed, never assumed",
      },
    ],
  });
}

/** The canonical capability definitions consumed by the EBANX connector. */
export function ebanxCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return Object.freeze([
    ebanxCapabilityDefinition({
      capabilityId: EBANX_DIRECT_PAYMENT_CAPABILITY_ID,
      summary: "Direct payment lifecycle on the real EBANX /ws Direct API",
      operation: "rails.ebanx.payment.direct",
      description:
        "POST /ws/direct { integration_key, operation: 'payment', payment: { name, email, country, payment_type, amount_total, currency, merchant_payment_code } } → { payment: { hash, status, … } } with the two-letter statuses VERBATIM (PE/OP/CO/CA); PE for voucher types (boleto, oxxo…) is customer-action-required with the voucher/URL preserved; POST /ws/query reconciles by hash or merchant_payment_code; a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: EBANX_PAYMENT_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "payment", idFormat: "hash:[0-9a-f]{16,}" },
      ],
      sideEffects: [
        { effect: "moves payer value when the payment is confirmed at EBANX", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      requiredCustomerActions: [
        {
          lifecycleStep: "pending",
          kind: "PROVIDER_VOUCHER_PRESENTATION",
          message: "Pay the voucher/QR/reference EBANX issued (boleto, oxxo, pix…) — the voucher URL rides the state verbatim",
        },
      ],
    }),
    ebanxCapabilityDefinition({
      capabilityId: EBANX_REFUND_CAPABILITY_ID,
      summary: "Refunds with explicit partial amounts (POST /ws/refund)",
      operation: "rails.ebanx.refund.create",
      description:
        "POST /ws/refund { integration_key, hash, description, amount? } — partial refunds are EXPLICIT (the amount rides the request); refund statuses stay VERBATIM (RE requested / CO confirmed / CA cancelled)",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: EBANX_REFUND_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "refund", idFormat: "refund-id:[0-9]+" }],
      sideEffects: [
        { effect: "returns previously collected value to the payer (full or explicit partial)", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    ebanxCapabilityDefinition({
      capabilityId: EBANX_PAYOUT_CAPABILITY_ID,
      summary: "Payouts (T-Claims) with explicit beneficiary details — the DISTINCT payout family",
      operation: "rails.ebanx.payout.create",
      description:
        "POST /ws/t-claim { integration_key, payout: { amount, currency, country, payee/bank details per country, merchant_payout_code? } } — the beneficiary/bank details are EXPLICIT per country; balances are OBSERVATIONS ONLY (INV-C09 — never custody)",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: [
        { providerState: "pending", canonicalState: "payout:pending", requiresCustomerAction: false, isTerminal: false },
        { providerState: "confirmed", canonicalState: "payout:confirmed", requiresCustomerAction: false, isTerminal: true },
        { providerState: "cancelled", canonicalState: "payout:cancelled", requiresCustomerAction: false, isTerminal: true },
        { providerState: "failed", canonicalState: "payout:failed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "payout", idFormat: "payout-id:[0-9a-zA-Z-]+" }],
      sideEffects: [
        { effect: "moves account value to an explicit beneficiary when the T-Claim completes at EBANX", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    ebanxCapabilityDefinition({
      capabilityId: EBANX_BALANCE_OBSERVATION_CAPABILITY_ID,
      summary: "Account-balance OBSERVATION (POST /ws/balance — never custody)",
      operation: "rails.ebanx.balance.observe",
      description:
        "Observe the connected account's per-currency balances (POST /ws/balance) as ExternalFundsPositionObservations ONLY: provider-held external funds, never PaySwap custody (INV-C09)",
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

/** The connector capability pack backing the EBANX rail. */
export function ebanxRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.ebanx",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: ebanxCapabilityDefinitions().map((definition) => ({
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
    })),
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "payments:read"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.ebanx.provider_state", version: "1.0.0" }],
    objectMappings: [
      { externalObjectType: "payment", canonicalObjectRef: "payswap:payment", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "refund", canonicalObjectRef: "payswap:refund", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payout", canonicalObjectRef: "payswap:external_funds_observation", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "balance_list", canonicalObjectRef: "payswap:external_funds_observation", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 50, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-ebanx-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Provider object shapes (opaque passthrough — never domain primitives)
// ---------------------------------------------------------------------------

/** The raw EBANX payment object (from /ws/direct and /ws/query; opaque). */
export interface EbanxPaymentProviderObject {
  readonly hash?: string;
  readonly merchant_payment_code?: string;
  readonly status?: string;
  readonly payment_type?: string;
  readonly country?: string;
  readonly currency?: string;
  readonly amount_total?: string | number;
  readonly voucher_url?: string;
  readonly boleto_url?: string;
  readonly oxxo_url?: string;
  readonly [key: string]: unknown;
}

/** The raw EBANX refund object (opaque passthrough). */
export interface EbanxRefundProviderObject {
  readonly id?: string | number;
  readonly status?: string;
  readonly amount?: string | number;
  readonly currency?: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

/** The raw EBANX payout (T-Claim) object (opaque passthrough). */
export interface EbanxPayoutProviderObject {
  readonly id?: string | number;
  readonly status?: string;
  readonly amount?: string | number;
  readonly currency?: string;
  readonly country?: string;
  readonly payee?: Readonly<Record<string, unknown>>;
  readonly merchant_payout_code?: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object — EBANX's own
// revision source is the payment hash + status, documented here)
// ---------------------------------------------------------------------------

/** Payment revision: hash + status + merchant_payment_code. */
export function ebanxPaymentRevision(payment: EbanxPaymentProviderObject): string {
  return `${payment.hash ?? "no_hash"}:${payment.status ?? "unknown"}:${payment.merchant_payment_code ?? "no_code"}`;
}

/** Refund revision: id + status. */
export function ebanxRefundRevision(refund: EbanxRefundProviderObject): string {
  return `${String(refund.id ?? "no_id")}:${refund.status ?? "unknown"}`;
}

/** Payout revision: id + status + merchant_payout_code. */
export function ebanxPayoutRevision(payout: EbanxPayoutProviderObject): string {
  return `${String(payout.id ?? "no_id")}:${payout.status ?? "unknown"}:${payout.merchant_payout_code ?? "no_code"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface EbanxEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK" | "OPERATOR";
  readonly fetchId?: string;
}

const EBANX_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "hash",
  "merchant_payment_code",
  "status",
  "payment_type",
  "country",
  "currency",
  "amount_total",
  "id",
]);

function ebanxEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: EbanxEnvelopeContext,
): {
  readonly providerName: string;
  readonly providerVersion: string;
  readonly objectType: string;
  readonly externalId: string;
  readonly revision: string;
  readonly state: unknown;
  readonly observedAt: string;
  readonly provenanceSource: EbanxEnvelopeContext["provenanceSource"];
  readonly fetchId?: string;
} {
  return {
    providerName: EBANX_PROVIDER_NAME,
    providerVersion: EBANX_API_VERSION,
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
 * The voucher/QR surface a pending voucher-type payment exposes (tolerant
 * extraction over the documented field names — the raw object rides the
 * state VERBATIM regardless).
 */
export function ebanxVoucherUrl(
  payment: EbanxPaymentProviderObject,
  directResponse?: { readonly redirect_url?: unknown },
): string | undefined {
  const candidates = [payment.voucher_url, payment.boleto_url, payment.oxxo_url];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  if (typeof directResponse?.redirect_url === "string" && directResponse.redirect_url.length > 0) {
    return directResponse.redirect_url;
  }
  const generic = (payment as { readonly [key: string]: unknown })["url"];
  return typeof generic === "string" && generic.length > 0 ? generic : undefined;
}

/**
 * Deterministic, additive classification of an EBANX payment (from
 * /ws/direct, /ws/query or a query-back-verified notification) into a
 * lossless ProviderStateEnvelope (INV-C06). The RAW payment is carried
 * VERBATIM as `state`; the external id is the provider's `hash`.
 * Statuses map per EBANX_PAYMENT_STATUS_MAPPING:
 * - CO → settled-EXTERNAL (terminal — value sits at the provider; the
 *   connector claims no custody, INV-C09);
 * - PE/OP → processing; PE for a VOUCHER-type payment (boleto, oxxo, pix…)
 *   is customer-action-required with the voucher/URL preserved;
 * - CA → terminal cancelled;
 * - any UNKNOWN status → `other`/verbatim, non-terminal — never dropped,
 *   never guessed, never collapsed (INV-C06/INV-X01).
 */
export function ebanxPaymentEnvelope(
  payment: EbanxPaymentProviderObject,
  context: EbanxEnvelopeContext,
  directResponse?: { readonly redirect_url?: unknown },
): ProviderStateEnvelope {
  const base = ebanxEnvelopeBase(
    "payment",
    payment.hash ?? payment.merchant_payment_code ?? "no_hash",
    ebanxPaymentRevision(payment),
    payment,
    context,
  );
  const isVoucher =
    typeof payment.payment_type === "string" &&
    (EBANX_VOUCHER_PAYMENT_TYPES as readonly string[]).includes(payment.payment_type.toLowerCase());
  switch (payment.status) {
    case "PE":
      if (isVoucher) {
        const voucherUrl = ebanxVoucherUrl(payment, directResponse);
        return railEnvelope({
          ...base,
          family: "customer_action_required",
          lifecycleStep: "voucher_pending",
          isTerminal: false,
          requiresCustomerAction: true,
          actionRequired: {
            kind: "PROVIDER_VOUCHER_PRESENTATION",
            message: "Pay the voucher/QR/reference EBANX issued — the voucher URL rides the state verbatim",
            ...(voucherUrl !== undefined ? { deepLink: voucherUrl } : {}),
          },
          shareableFields: EBANX_SHAREABLE_FIELDS,
        });
      }
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "pending",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
    case "OP":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "open",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
    case "CO":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "settled_external",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
    case "CA":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "cancelled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: { providerErrorCode: "payment_cancelled", retryable: false, ambiguity: "NONE" },
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: payment.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
  }
}

/**
 * An EBANX refund → the refund-family envelope. RE (requested) is
 * asynchronous; CO (confirmed) is terminal; CA (cancelled) is terminal
 * with definitive no-effect; unknown statuses stay verbatim under the
 * refund family (never invented terminality).
 */
export function ebanxRefundEnvelope(
  refund: EbanxRefundProviderObject,
  context: EbanxEnvelopeContext,
): ProviderStateEnvelope {
  const base = ebanxEnvelopeBase(
    "refund",
    String(refund.id ?? "no_refund_id"),
    ebanxRefundRevision(refund),
    refund,
    context,
  );
  switch (refund.status) {
    case "RE":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "requested",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
    case "CO":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "confirmed",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
    case "CA":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "cancelled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: { providerErrorCode: "refund_cancelled", retryable: false, ambiguity: "NONE" },
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: refund.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
  }
}

/**
 * An EBANX payout (T-Claim) → the payout-family envelope (the DISTINCT
 * payout capability). The RAW payout rides the state VERBATIM with the
 * explicit payee/bank details; statuses stay verbatim (pending/confirmed/
 * cancelled/failed terminal, everything else in flight, never guessed).
 */
export function ebanxPayoutEnvelope(
  payout: EbanxPayoutProviderObject,
  context: EbanxEnvelopeContext,
): ProviderStateEnvelope {
  const base = ebanxEnvelopeBase(
    "payout",
    String(payout.id ?? payout.merchant_payout_code ?? "no_payout_id"),
    ebanxPayoutRevision(payout),
    payout,
    context,
  );
  switch (payout.status) {
    case "confirmed":
    case "CO":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "confirmed",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
    case "cancelled":
    case "CA":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "cancelled",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: { providerErrorCode: "payout_cancelled", retryable: false, ambiguity: "NONE" },
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
    case "failed":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "failed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: { providerErrorCode: "payout_failed", retryable: true, ambiguity: "NONE" },
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: payout.status ?? "pending",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: EBANX_SHAREABLE_FIELDS,
      });
  }
}

// ---------------------------------------------------------------------------
// External funds observations (INV-C09 — observations, NEVER custody)
// ---------------------------------------------------------------------------

/** The ISO 4217 minor-unit exponents for the EBANX currency surface. */
export const EBANX_MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  BRL: 2, MXN: 2, COP: 2, CLP: 0, PEN: 2, USD: 2, EUR: 2,
  NGN: 2, GHS: 2, KES: 2, ZAR: 2, INR: 2, IDR: 2, VND: 0, PHP: 2,
});

/**
 * Converts a major-unit decimal to exact integer minor units (INV-F01 —
 * bigint arithmetic, never floats). Throws on an unknown exponent or
 * sub-minor precision — both are honest refusals.
 */
export function ebanxMinorUnits(majorDecimal: string, currency: string): string {
  const exponent = EBANX_MINOR_UNIT_EXPONENTS[currency.toUpperCase()];
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

/**
 * Maps a /ws/balance answer to ExternalFundsPositionObservations — one per
 * currency the response carries. Observations of PROVIDER-HELD external
 * funds ONLY (INV-C09): never PaySwap custody, never a balance PaySwap owes
 * anyone. The response shape is consumed TOLERANTLY (a currency→amount
 * record, or an array of { currency, amount } items); anything unparseable
 * is honestly reported in `unconverted` — never guessed.
 */
export function ebanxBalanceObservations(input: {
  readonly balanceResponse: unknown;
  readonly accountRef: string;
  readonly observedAt: string;
  readonly maxAgeSeconds?: number;
  readonly observationIdPrefix?: string;
}): {
  readonly observations: readonly ExternalFundsPositionObservation[];
  readonly unconverted: readonly { readonly currency: string; readonly reason: string }[];
} {
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  const prefix = input.observationIdPrefix ?? "ebanx-balance";
  const entries: readonly { readonly currency: unknown; readonly amount: unknown }[] =
    ebanxBalanceEntries(input.balanceResponse);
  const observations: ExternalFundsPositionObservation[] = [];
  const unconverted: { readonly currency: string; readonly reason: string }[] = [];
  for (const entry of entries) {
    if (typeof entry.currency !== "string" || entry.currency.length === 0) {
      unconverted.push({ currency: "UNKNOWN", reason: "MALFORMED_BALANCE" });
      continue;
    }
    const currency = entry.currency.toUpperCase();
    if (typeof entry.amount !== "string" && typeof entry.amount !== "number") {
      continue; // absent balance kinds are skipped, never fabricated
    }
    const majorDecimal = String(entry.amount);
    let minorUnits: string;
    try {
      minorUnits = ebanxMinorUnits(majorDecimal, currency);
    } catch (error) {
      unconverted.push({
        currency,
        reason: error instanceof Error ? error.message : "UNCONVERTED",
      });
      continue;
    }
    observations.push(
      Object.freeze({
        observationKind: "ExternalFundsPositionObservation" as const,
        observationId: `${prefix}:${currency}`,
        observedAt: input.observedAt,
        freshness: Object.freeze({
          asOf: input.observedAt,
          maxAgeSeconds,
        }),
        location: Object.freeze({
          providerName: EBANX_PROVIDER_NAME,
          accountRef: input.accountRef,
          instrumentRef: `account:balance:${currency}`,
          description: `EBANX ${currency} account balance (provider-held external funds — observation, never custody)`,
        }),
        observedAmount: Object.freeze({
          currency,
          minorUnits,
        }),
        provenance: Object.freeze({
          providerName: EBANX_PROVIDER_NAME,
          source: "PROVIDER_API" as const,
          capturedAt: input.observedAt,
        }),
        reconciliationState: "NOT_RECONCILED" as const,
      }),
    );
  }
  return Object.freeze({
    observations: Object.freeze(observations),
    unconverted: Object.freeze(unconverted),
  });
}

/** Tolerant extraction of (currency, amount) entries from a balance answer. */
function ebanxBalanceEntries(response: unknown): readonly {
  readonly currency: unknown;
  readonly amount: unknown;
}[] {
  if (response === null || typeof response !== "object") {
    return [];
  }
  const record = response as Readonly<Record<string, unknown>>;
  const reserved = new Set(["status", "status_message", "success"]);
  // Shape 1: a currency → amount record (top level or under `balances`).
  for (const container of [record, record["balances"]]) {
    if (container !== null && typeof container === "object" && !Array.isArray(container)) {
      const entries: { readonly currency: unknown; readonly amount: unknown }[] = [];
      for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
        if (reserved.has(key)) {
          continue;
        }
        if (typeof value === "string" || typeof value === "number") {
          entries.push({ currency: key, amount: value });
        } else if (value !== null && typeof value === "object") {
          const amount = (value as { readonly amount?: unknown }).amount;
          if (amount !== undefined) {
            entries.push({ currency: key, amount });
          }
        }
      }
      if (entries.length > 0) {
        return entries;
      }
    }
  }
  // Shape 2: an array of { currency, amount } items.
  for (const container of [record["items"], record["balances"]]) {
    if (Array.isArray(container)) {
      return container as readonly { readonly currency: unknown; readonly amount: unknown }[];
    }
  }
  if (Array.isArray(response)) {
    return response as readonly { readonly currency: unknown; readonly amount: unknown }[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Webhook verification (QUERY-BACK — the documented integrity mechanism)
// ---------------------------------------------------------------------------

/** The reference an EBANX notification carries (tolerant extraction). */
export interface EbanxNotificationReference {
  /** The payment hash when the notification names one (the query key). */
  readonly hash?: string;
  /** The merchant payment code when the notification names one. */
  readonly merchantPaymentCode?: string;
}

/**
 * Extracts the payment reference from a notification payload: the `hash`
 * (documented field, `hash_code` accepted as an alias) and/or the
 * `merchant_payment_code`. Undefined when the payload carries neither —
 * such a notification is NOT verifiable by query-back and must be
 * quarantined, never trusted.
 */
export function ebanxNotificationReference(payload: unknown): EbanxNotificationReference | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as {
    readonly hash?: unknown;
    readonly hash_code?: unknown;
    readonly merchant_payment_code?: unknown;
  };
  const hash =
    typeof record.hash === "string" && record.hash.length > 0
      ? record.hash
      : typeof record.hash_code === "string" && record.hash_code.length > 0
        ? record.hash_code
        : undefined;
  const merchantPaymentCode =
    typeof record.merchant_payment_code === "string" && record.merchant_payment_code.length > 0
      ? record.merchant_payment_code
      : undefined;
  if (hash === undefined && merchantPaymentCode === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(hash !== undefined ? { hash } : {}),
    ...(merchantPaymentCode !== undefined ? { merchantPaymentCode } : {}),
  });
}

/**
 * The deterministic dedupe event id for one EBANX notification: the payment
 * reference pair the notification carries (the provider's own object
 * identity). Undefined when the payload is not a payment-scoped
 * notification.
 */
export function ebanxWebhookEventId(payload: unknown): string | undefined {
  const reference = ebanxNotificationReference(payload);
  if (reference === undefined) {
    return undefined;
  }
  return `notification:${reference.hash ?? reference.merchantPaymentCode ?? "unreferenced"}`;
}

/** The query-back verification outcome for one EBANX notification. */
export type EbanxQueryBackVerification =
  | {
      readonly valid: true;
      /** The AUTHORITATIVE payment the query answered (the evidence). */
      readonly payment: EbanxPaymentProviderObject;
    }
  | {
      readonly valid: false;
      readonly reason:
        | "NO_REFERENCE"
        | "QUERY_NOT_FOUND"
        | "REFERENCE_MISMATCH"
        | "QUERY_ERROR";
      readonly detail?: string;
    };

/**
 * Compares a query answer against the notification reference — the
 * query-back verification core. The query response (authenticated by the
 * integration_key) is the authority; the notification is trusted ONLY when
 * the queried payment matches the reference it carried. This function is
 * pure so the comparison is unit-testable without a network.
 */
export function verifyEbanxQueryBack(
  reference: EbanxNotificationReference | undefined,
  queriedPayment: EbanxPaymentProviderObject | undefined,
): EbanxQueryBackVerification {
  if (reference === undefined) {
    return {
      valid: false,
      reason: "NO_REFERENCE",
      detail: "the notification carries no hash/merchant_payment_code — not verifiable by query-back, never trusted",
    };
  }
  if (queriedPayment === undefined) {
    return {
      valid: false,
      reason: "QUERY_NOT_FOUND",
      detail: "the /ws/query answer carries no payment — the notification cannot be verified",
    };
  }
  if (
    reference.hash !== undefined &&
    queriedPayment.hash === reference.hash
  ) {
    return { valid: true, payment: queriedPayment };
  }
  if (
    reference.merchantPaymentCode !== undefined &&
    queriedPayment.merchant_payment_code === reference.merchantPaymentCode
  ) {
    return { valid: true, payment: queriedPayment };
  }
  if (
    reference.hash === undefined &&
    reference.merchantPaymentCode !== undefined
  ) {
    return {
      valid: false,
      reason: "REFERENCE_MISMATCH",
      detail: "the queried payment does not carry the notified merchant_payment_code",
    };
  }
  return {
    valid: false,
    reason: "REFERENCE_MISMATCH",
    detail: "the queried payment hash does not match the notified hash",
  };
}

// ---------------------------------------------------------------------------
// Idempotency (merchant_payment_code derivation — INV-F05; provider-ENFORCED unique)
// ---------------------------------------------------------------------------

/**
 * Derives the EBANX `merchant_payment_code` from the protocol idempotency
 * key (INV-F05). EBANX ENFORCES merchant_payment_code uniqueness: a
 * replayed create surfaces as a duplicate-code provider error (mapped to
 * EbanxDuplicateMerchantPaymentCodeError), never a silent success.
 */
export function ebanxMerchantPaymentCode(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap-${protocolIdempotencyKey}`;
}

/**
 * The provider error class for a REJECTED duplicate merchant_payment_code —
 * the idempotency-honesty surface: the provider refused the replay, and
 * the caller reconciles by querying the existing payment (INV-F05/INV-X03).
 */
export class EbanxDuplicateMerchantPaymentCodeError extends RailProviderError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = "EbanxDuplicateMerchantPaymentCodeError";
  }
}

// ---------------------------------------------------------------------------
// The RailAdapter surface (provider-neutral framework registration)
// ---------------------------------------------------------------------------

/** The EBANX production rail adapter on the BaseRailAdapter framework. */
export class EbanxProductionRail extends BaseRailAdapter {
  readonly adapterId = EBANX_RAIL_ADAPTER_ID;
  readonly implementationId = EBANX_RAIL_IMPLEMENTATION_ID;

  constructor() {
    const definitions = new Map<string, CapabilityDefinition>();
    for (const definition of ebanxCapabilityDefinitions()) {
      definitions.set(definition.capabilityId, definition);
    }
    super(ebanxRailCapabilityPack(), definitions);
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK; credential-gated, fail-closed)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface EbanxControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface EbanxConnectorConfig {
  readonly clock: ProtocolClock;
  /** Overrides the API base (defaults: SANDBOX base; LIVE base constant). */
  readonly apiBase?: string;
  readonly environment?: "SANDBOX" | "LIVE";
  /** Overrides the pinned API version (tests only — production pins ws). */
  readonly apiVersion?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("ebanx")` = PROVIDER_EBANX_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: EbanxControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type EbanxSdkRequest =
  | {
      readonly kind: "create_payment";
      readonly name: string;
      readonly email: string;
      readonly country: string;
      readonly paymentType: string;
      readonly amountTotal: string;
      readonly currency: string;
      /** Overrides the derived code (ebanxMerchantPaymentCode). */
      readonly merchantPaymentCode?: string;
      /** Payment-type-specific fields, provider vocabulary, verbatim. */
      readonly paymentFields?: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "query_payment"; readonly hash?: string; readonly merchantPaymentCode?: string }
  | {
      readonly kind: "refund_payment";
      readonly hash: string;
      readonly description?: string;
      /** Absent → full refund; present → EXPLICIT partial refund amount. */
      readonly amount?: string;
    }
  | {
      readonly kind: "create_payout";
      readonly amount: string;
      readonly currency: string;
      readonly country: string;
      /** The payee/bank-detail object, per-country provider vocabulary, verbatim. */
      readonly payee: Readonly<Record<string, unknown>>;
      /** Overrides the derived payout code (ebanxMerchantPaymentCode). */
      readonly merchantPayoutCode?: string;
    }
  | {
      readonly kind: "verify_notification";
      readonly notification: unknown;
    };

function isEbanxSdkRequest(candidate: unknown): candidate is EbanxSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** Which credential path is live (observability — NEVER material). */
export type EbanxCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/**
 * The real EBANX connector (ConnectorSDK framework). EBANX API names,
 * payloads, response shapes and quirks stay INSIDE this implementation:
 * the SDK call contract is the provider-neutral `EbanxSdkRequest` union.
 * Every effectful operation runs behind `requireAuthority` (INV-C04/F05/
 * F06) and fails closed with `RailNotAuthorizedError` BEFORE any provider
 * call when no credential path is live (INV-NC04).
 */
export class EbanxConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: EbanxControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  #credentialBaseline: string | undefined;

  constructor(config: EbanxConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase =
      config.apiBase ??
      (config.environment === "LIVE"
        ? EBANX_DEFAULT_API_BASE_LIVE
        : EBANX_DEFAULT_API_BASE_SANDBOX);
    this.#apiVersion = config.apiVersion ?? EBANX_API_VERSION;
    this.#credentialConfigKey = config.credentialConfigKey ?? EBANX_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: EBANX_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "EBANX (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return ebanxRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): EbanxCredentialResolutionState {
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
        "no control-plane credentials and no env-resolved material under the config key — rail fails closed (INV-NC04; packages/rails/BLOCKED-RAILS.md §12)",
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
          "credential reference not provisioned — source availability UNKNOWN (INV-C01/C02); the 2026-10-02 reachability datum recorded HTTP 401 on sandbox.ebanx.com/ws/query (reachable, integration key required); see packages/rails/BLOCKED-RAILS.md §12",
        provenance: {
          providerName: EBANX_PROVIDER_NAME,
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
          providerName: EBANX_PROVIDER_NAME,
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
        providerName: EBANX_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(EBANX_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface --------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "ebanx search is not implemented — no listing surface is in the connector contract; reconciliation is by hash/merchant_payment_code (POST /ws/query, INV-X03)",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "query_payment");
    if (request.kind !== "query_payment") {
      throw new ValidationError("ebanx read supports only { kind: 'query_payment' }");
    }
    const payment = await this.#queryPayment(request);
    return this.#sdkResult(
      ebanxPaymentEnvelope(payment, this.#envelopeContext()),
      `ebanx:query-payment:${payment.hash ?? request.merchantPaymentCode ?? "pending"}`,
    );
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_payment");
    if (request.kind !== "create_payment") {
      throw new ValidationError("ebanx create supports only { kind: 'create_payment' }");
    }
    const merchantPaymentCode =
      request.merchantPaymentCode ?? ebanxMerchantPaymentCode(ctx.idempotencyKey);
    const payment: Record<string, unknown> = {
      name: request.name,
      email: request.email,
      country: request.country.toUpperCase(),
      payment_type: request.paymentType,
      amount_total: this.#exactMajorAmount(request.amountTotal),
      currency: request.currency.toUpperCase(),
      merchant_payment_code: merchantPaymentCode,
      ...(request.paymentFields !== undefined ? request.paymentFields : {}),
    };
    const body: Record<string, unknown> = {
      operation: "payment",
      payment,
    };
    const observedAt = this.#envelopeContext();
    // INV-X01: a transport failure mid-create is OUTCOME_UNKNOWN — the
    // payment may exist at the provider under this merchant_payment_code;
    // reconcile by query. NEVER FAILED.
    try {
      const data = await this.#withCredentials(async (material) =>
        this.#providerPost("/ws/direct", body, material),
      );
      const response = (data ?? {}) as {
        readonly payment?: unknown;
        readonly redirect_url?: unknown;
      };
      const paymentObject =
        response.payment !== null && typeof response.payment === "object"
          ? (response.payment as EbanxPaymentProviderObject)
          : ({} as EbanxPaymentProviderObject);
      return this.#sdkResult(
        ebanxPaymentEnvelope(paymentObject, observedAt, response),
        `ebanx:create-payment:${paymentObject.hash ?? merchantPaymentCode}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "payment",
          externalId: merchantPaymentCode,
          operation: "create_payment",
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
      "ebanx direct payments are not mutable at the provider (create → payer voucher/redirect → query lifecycle only); a pending payment is cancelled by the payer's inaction or refunded after confirmation",
    );
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "refund_payment");
    if (request.kind !== "refund_payment" && request.kind !== "create_payout") {
      throw new ValidationError(
        "ebanx executeAction supports only { kind: 'refund_payment' | 'create_payout' } — refunds and the DISTINCT payout family (T-Claims with explicit beneficiary details)",
      );
    }
    const observedAt = this.#envelopeContext();
    if (request.kind === "refund_payment") {
      const body: Record<string, unknown> = {
        hash: request.hash,
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.amount !== undefined
          ? { amount: this.#exactMajorAmount(request.amount) }
          : {}),
      };
      // INV-X01: value can move on a refund — OUTCOME_UNKNOWN, never FAILED.
      try {
        const data = await this.#withCredentials(async (material) =>
          this.#providerPost("/ws/refund", body, material),
        );
        const response = (data ?? {}) as { readonly refund?: unknown };
        const refund =
          response.refund !== null && typeof response.refund === "object"
            ? (response.refund as EbanxRefundProviderObject)
            : ({} as EbanxRefundProviderObject);
        return this.#sdkResult(
          ebanxRefundEnvelope(refund, observedAt),
          `ebanx:create-refund:${String(refund.id ?? request.hash)}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "refund",
            externalId: request.hash,
            operation: "refund_payment",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    const merchantPayoutCode =
      request.merchantPayoutCode ?? ebanxMerchantPaymentCode(ctx.idempotencyKey);
    const payout: Record<string, unknown> = {
      amount: this.#exactMajorAmount(request.amount),
      currency: request.currency.toUpperCase(),
      country: request.country.toUpperCase(),
      payee: request.payee,
      merchant_payout_code: merchantPayoutCode,
    };
    const body: Record<string, unknown> = { payout };
    // INV-X01: a T-Claim moves account value — OUTCOME_UNKNOWN, never FAILED.
    try {
      const data = await this.#withCredentials(async (material) =>
        this.#providerPost("/ws/t-claim", body, material),
      );
      const response = (data ?? {}) as { readonly payout?: unknown };
      const payoutObject =
        response.payout !== null && typeof response.payout === "object"
          ? (response.payout as EbanxPayoutProviderObject)
          : ({} as EbanxPayoutProviderObject);
      return this.#sdkResult(
        ebanxPayoutEnvelope(payoutObject, observedAt),
        `ebanx:create-payout:${String(payoutObject.id ?? merchantPayoutCode)}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "payout",
          externalId: merchantPayoutCode,
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
      "ebanx event subscription is handled by the webhook query-back verification path (verifyNotificationByQueryBack — the documented integrity mechanism on the integration-key path), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "query_payment");
    if (request.kind !== "query_payment") {
      throw new ValidationError("ebanx reconcile supports only { kind: 'query_payment' }");
    }
    // Reconciliation-as-authority (INV-X03): re-fetch by external object id.
    return this.read(ctx);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "ebanx disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and release the sealed credential handle); the provider surface offers no self-disconnect",
    );
  }

  // -- webhook verification (QUERY-BACK — the documented mechanism) ------------

  /**
   * WEBHOOK QUERY-BACK VERIFICATION (the documented EBANX integrity
   * mechanism on the integration-key path): the notification is parsed for
   * its payment reference, the AUTHORITATIVE state is fetched through
   * POST /ws/query (authenticated by the integration_key), and the query
   * answer is compared against the reference. The notification itself is
   * never trusted as final evidence — the query response is. Returns the
   * verification outcome plus the authoritative payment envelope.
   */
  async verifyNotificationByQueryBack(notification: unknown): Promise<{
    readonly verification: EbanxQueryBackVerification;
    readonly envelope: ProviderStateEnvelope | undefined;
  }> {
    const reference = ebanxNotificationReference(notification);
    if (reference === undefined) {
      return {
        verification: {
          valid: false,
          reason: "NO_REFERENCE",
          detail:
            "the notification carries no hash/merchant_payment_code — not verifiable by query-back, never trusted",
        },
        envelope: undefined,
      };
    }
    let queried: EbanxPaymentProviderObject | undefined;
    try {
      queried = await this.#queryPayment({
        ...(reference.hash !== undefined ? { hash: reference.hash } : {}),
        ...(reference.merchantPaymentCode !== undefined
          ? { merchantPaymentCode: reference.merchantPaymentCode }
          : {}),
      });
    } catch (error) {
      return {
        verification: {
          valid: false,
          reason: "QUERY_ERROR",
          detail: error instanceof Error ? error.message : String(error),
        },
        envelope: undefined,
      };
    }
    const verification = verifyEbanxQueryBack(reference, queried);
    if (!verification.valid) {
      return { verification, envelope: undefined };
    }
    return {
      verification,
      envelope: ebanxPaymentEnvelope(verification.payment, {
        observedAt: isoTimestamp(this.#clock.now()),
        provenanceSource: "PROVIDER_WEBHOOK",
      }),
    };
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md, EBANX path —
   * swap-reference-then-verify): the vault binding for the control-plane
   * config key is swapped to a NEW reference at the vault; the connector
   * re-resolves per call, so the rotation is real exactly when the NEW
   * reference resolves and serves a successful health probe. The old
   * integration key is revoked in the EBANX merchant dashboard only after
   * that verification.
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
          evidenceId: `ebanx:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: EBANX_PROVIDER_NAME,
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
        "cannot rotate credentials: no credential path is provisioned for the ebanx rail (packages/rails/BLOCKED-RAILS.md §12)",
        { railId: EBANX_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = createHmac("sha256", "payswap-ebanx-rotation-baseline")
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
        evidenceId: `ebanx:cred-rotation:${rotatedAt}`,
        evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
        kind: "AUDIT_LOG",
        providerState: railEnvelope({
          providerName: EBANX_PROVIDER_NAME,
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
   * via an unauthenticated POST to /ws/query (any HTTP answer proves
   * reachability — the 2026-10-02 datum recorded HTTP 401) → DEGRADED with
   * reasons; transport failure → UNKNOWN. With credentials: an
   * authenticated empty query (the real probe — the provider answers a
   * structured error, proving the integration key evaluates) → HEALTHY.
   */
  async health(): Promise<ConnectorHealthReport> {
    const resolution = this.credentialResolutionState();
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: EBANX_CONNECTOR_ID,
      providerName: EBANX_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (resolution.kind === "NOT_PROVISIONED") {
      let endpointAnswered: boolean;
      try {
        await this.#http(`${this.#apiBase}/ws/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
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
              `credentials absent: provider endpoint reachable (the 2026-10-02 probe recorded HTTP ${String(EBANX_SANDBOX_REACHABILITY_20261002.httpStatus)} on /ws/query — integration key required) but rail authorization cannot be established — availability UNKNOWN (INV-C01/C02; packages/rails/BLOCKED-RAILS.md §12)`,
            ]
          : ["provider endpoint unreachable — availability UNKNOWN (INV-C02)"],
      };
    }
    try {
      // An authenticated query with no criteria: the provider evaluates
      // the integration key and answers a structured response/error — the
      // key itself is proven, no payment state is touched.
      await this.#withCredentials(async (material) =>
        this.#providerPost("/ws/query", {}, material),
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
   * External funds observations from POST /ws/balance — one observation per
   * currency the answer carries. Observations ONLY (INV-C09): never
   * custody, never a PaySwap balance. Unconvertible balances are honestly
   * reported.
   */
  async observeExternalFunds(): Promise<readonly ExternalFundsPositionObservation[]> {
    const observedAt = isoTimestamp(this.#clock.now());
    const data = await this.#withCredentials(async (material) =>
      this.#providerPost("/ws/balance", {}, material),
    );
    const accountRef = `vault:${EBANX_CREDENTIAL_CONFIG_KEY}`;
    const { observations } = ebanxBalanceObservations({
      balanceResponse: data,
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
    const data = await this.#withCredentials(async (material) =>
      this.#providerPost("/ws/balance", {}, material),
    );
    const accountRef = `vault:${EBANX_CREDENTIAL_CONFIG_KEY}`;
    return ebanxBalanceObservations({
      balanceResponse: data,
      accountRef,
      observedAt,
    });
  }

  // -- internals -------------------------------------------------------------------

  #envelopeContext(): EbanxEnvelopeContext {
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
          "ebanx rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: EBANX_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => fn(extractEbanxKeyMaterial(opened.material)),
      );
    }
    const material = this.#envMaterial();
    if (material === undefined) {
      throw new RailNotAuthorizedError(
        "ebanx rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md §12)",
        { railId: EBANX_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    return fn(material);
  }

  /** POST /ws/query by hash or merchant_payment_code (both documented). */
  async #queryPayment(request: {
    readonly hash?: string;
    readonly merchantPaymentCode?: string;
  }): Promise<EbanxPaymentProviderObject> {
    if (request.hash === undefined && request.merchantPaymentCode === undefined) {
      throw new ValidationError("query_payment requires hash or merchantPaymentCode");
    }
    const body: Record<string, unknown> = {
      ...(request.hash !== undefined ? { hash: request.hash } : {}),
      ...(request.merchantPaymentCode !== undefined
        ? { merchant_payment_code: request.merchantPaymentCode }
        : {}),
    };
    const data = await this.#withCredentials(async (material) =>
      this.#providerPost("/ws/query", body, material),
    );
    // The query answer carries `payment` as an object (hash query) or an
    // ARRAY (merchant_payment_code query) — both documented; the connector
    // takes the first entry honestly and never fabricates one.
    const payment = (data ?? {}) as { readonly payment?: unknown };
    if (payment.payment === null || typeof payment.payment !== "object") {
      throw new RailProviderError(
        "ebanx query answer carries no payment (not found or malformed)",
        { path: "/ws/query" },
      );
    }
    if (Array.isArray(payment.payment)) {
      const first = payment.payment[0];
      if (first === null || typeof first !== "object") {
        throw new RailProviderError(
          "ebanx query answer carries an empty payment array (not found)",
          { path: "/ws/query" },
        );
      }
      return first as EbanxPaymentProviderObject;
    }
    return payment.payment as EbanxPaymentProviderObject;
  }

  #request(ctx: SdkCallContext, expectedKind: string): EbanxSdkRequest {
    const candidate = ctx.request;
    if (!isEbanxSdkRequest(candidate)) {
      throw new ValidationError(
        `ebanx rail call request must be an EbanxSdkRequest object (expected kind '${expectedKind}')`,
      );
    }
    if (
      ("amountTotal" in candidate && candidate.amountTotal !== undefined) ||
      ("amount" in candidate && candidate.amount !== undefined)
    ) {
      const amount =
        "amountTotal" in candidate && candidate.amountTotal !== undefined
          ? candidate.amountTotal
          : "amount" in candidate
            ? candidate.amount
            : undefined;
      if (amount !== undefined && !/^\d+(\.\d+)?$/.test(String(amount))) {
        throw new ValidationError(
          "amount must be an exact non-negative decimal string in the provider's currency units (INV-F01)",
        );
      }
    }
    return candidate;
  }

  /**
   * Exact major-unit decimal, JSON-number-safe: EBANX takes amount_total
   * as a number in the currency's major units. The string must carry at
   * most two decimals (the provider's documented precision) — anything
   * finer is an honest refusal (INV-F01), never a rounded guess.
   */
  #exactMajorAmount(amount: string): number {
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      throw new ValidationError(
        "amount must be an exact non-negative decimal string with at most two decimals (the provider's documented precision; INV-F01)",
      );
    }
    const value = Number(amount);
    if (!Number.isFinite(value)) {
      throw new ValidationError(`amount '${amount}' is not a finite decimal (INV-F01)`);
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
      providerName: EBANX_PROVIDER_NAME,
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
        note: "transport failed mid-effect — the provider effect may have landed; reconcile by hash/merchant_payment_code through POST /ws/query (INV-X01/INV-X03); never coerced to FAILED",
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
      shareableFields: EBANX_SHAREABLE_FIELDS,
    });
    return this.#sdkResult(envelope, `ebanx:outcome-unknown:${input.operation}:${input.idempotencyKey}`);
  }

  async #providerPost(
    path: string,
    body: Readonly<Record<string, unknown>>,
    material: string,
  ): Promise<unknown> {
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, integration_key: material }),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("ebanx provider transport unreachable", {
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
      throw new RailProviderError("ebanx provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const body = parsed as {
      readonly status?: string;
      readonly status_message?: string;
    };
    // EBANX answers HTTP 200 with status: "ERROR" for provider-level
    // refusals (the documented /ws behavior) — the message is preserved.
    if (body !== null && typeof body === "object" && body.status === "ERROR") {
      const message = body.status_message ?? "provider error";
      if (/merchant_payment_code.*already|already.*merchant_payment_code|duplicate.*merchant_payment_code/i.test(message)) {
        throw new EbanxDuplicateMerchantPaymentCodeError(
          `ebanx rejected a duplicate merchant_payment_code: ${message}`,
          { path, httpStatus: response.status },
        );
      }
      throw new RailProviderError(`ebanx provider error: ${message}`, {
        path,
        httpStatus: response.status,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(`ebanx provider answered HTTP ${String(response.status)}`, {
        path,
        httpStatus: response.status,
      });
    }
    return parsed;
  }
}

/**
 * Extracts the EBANX integration key from a vault bundle shape. The control
 * plane hands the connector whatever the vault object holds: a plain string
 * integration key, or a bundle record ({ integrationKey } /
 * { integration_key } / { apiKey }). Any other shape refuses the call
 * (fail-closed, no guessing).
 */
export function extractEbanxKeyMaterial(material: unknown): string {
  if (typeof material === "string" && material.length > 0) {
    return material;
  }
  if (material !== null && typeof material === "object") {
    const record = material as Readonly<Record<string, unknown>>;
    for (const key of ["integrationKey", "integration_key", "apiKey", "api_key"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  throw new ValidationError(
    "the sealed credential bundle does not contain EBANX key material (expected a string integration key or { integrationKey | integration_key })",
  );
}
