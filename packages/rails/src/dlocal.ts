/**
 * dLocal production connector (P2-W2-002) — the REAL dLocal adapter on the
 * v1.5 capability hierarchy and ProviderStateEnvelope, focused on
 * cross-border collection and payout with local-method aggregation
 * (payments_api/v6 + payment-methods/v2 coverage).
 *
 * Authority: spec/phase-2/work-items/P2-W2-002.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md and the TL
 * resident-watch reachability probes recorded 2026-10-02 in
 * spec/development-state/phase-2-state.json (dLocal sandbox host
 * `https://sandbox.dlocal.com` REACHABLE — root answers 200 without
 * credentials; the API paths require auth headers). NO dLocal credential
 * exists in this deployment (PROVIDER_DLOCAL_CREDENTIAL_REF →
 * vault://payswap/providers/dlocal/sandbox-20261002, ABSENT). Same
 * framework and fail-closed laws as the Stripe/Flutterwave/Paystack/Rapyd
 * production connectors — NO dLocal SDK, no ambient fetch in unit-testable
 * paths, no provider SDK types anywhere.
 *
 * Laws implemented here:
 * - INV-C06 (lossless): every provider object (payment with its `id` and
 *   verbatim status, refund, payout, payment-method entry, KYC requirement
 *   field, webhook notification) is carried VERBATIM in the envelope
 *   `state` with an ADDITIVE classification. dLocal statuses are NEVER
 *   renamed, never dropped; UNKNOWN provider statuses stay `other`/
 *   verbatim non-terminal.
 * - PAY-IN vs PAYOUT ARE SEPARATE: payments (POST /payments_api/v6/
 *   authorize) and payouts (POST /payments_api/v6/payouts) are two
 *   DISTINCT capability families with SEPARATE coverage surfaces
 *   (payment-methods-v2 queried per country+currency); neither is ever
 *   inferred from the other.
 * - KYC/DOCUMENT REQUIREMENTS ARE CAPABILITY PRECONDITIONS: the
 *   per-method document requirements carried by the coverage objects are
 *   preserved VERBATIM as DlocalMethodRequirement records attached as
 *   capability preconditions — a capability is NOT eligible until its
 *   requirement fields are satisfied.
 * - BENEFICIARY REQUIREMENTS ARE EXPLICIT: the provider-defined payout
 *   beneficiary fields are modeled as explicit DlocalBeneficiaryRequirement
 *   records, never guessed.
 * - THE COVERAGE LAW: NO ADVERTISED GLOBAL COVERAGE BECOMES ROUTABLE
 *   WITHOUT CONNECTED-INSTANCE EVIDENCE. Coverage records exist ONLY from
 *   a connected-account query (`observeCoverage` — credential-gated and
 *   fail-closed), NEVER from dLocal's marketing catalogue. An
 *   uncredentialed deployment has an EMPTY observed-coverage registry and
 *   every eligibility verdict is NO_CONNECTED_INSTANCE_EVIDENCE — never
 *   eligible.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (requires
 *   reconciliation by the dLocal payment id) — NEVER collapsed to FAILED.
 *   The provider-status `ERROR` is a TERMINAL FAILURE VERDICT FROM THE
 *   PROVIDER (ambiguity NONE — dLocal explicitly answered); transport
 *   errors are a DIFFERENT thing and stay OUTCOME_UNKNOWN. The two are
 *   never conflated.
 * - INV-C01/C02 + INV-NC04: no credential → availability UNKNOWN, health
 *   DEGRADED/UNKNOWN with reasons, every effectful operation throws
 *   RailNotAuthorizedError BEFORE any provider call. NO mock, NO simulated
 *   outcome.
 * - Credential isolation (phase-2): key material is consumed through the
 *   P2-W1-001 control plane — `PROVIDER_DLOCAL_CREDENTIAL_REF` bound to a
 *   vault:// reference, resolved through the CredentialBroker to a SEALED
 *   bundle (X-Login + X-Trans-Key + secret) opened only inside
 *   `withSealedBundle` with a ConnectorRuntimeKey. A direct env fallback
 *   (the W1-005 rails convention) exists for deployments that inject the
 *   resolved material under the same config key; material NEVER enters any
 *   envelope, log line or evidence record.
 * - dLocal request authentication is the documented V2 scheme, implemented
 *   and documented EXACTLY in dlocalAuthHeaders below: headers X-Login,
 *   X-Trans-Key, X-Date (ISO-8601 UTC, `YYYY-MM-DDTHH:mm:ssZ`) and
 *   `Authorization: V2-HMAC-SHA256, Signature: <hex>` where the signature
 *   is HMAC-SHA256 over `${x_login}${x_date}${x_trans_key}${body}` with
 *   the SECRET KEY (body = the raw JSON request body string, "" for GET).
 *   HONEST UNCERTAINTY: the exact V2 canonicalization string is
 *   implemented faithfully per the documented scheme and MUST be confirmed
 *   live once credentials exist — recorded here and in BLOCKED-RAILS.md §8
 *   (never guessed silently; a wrong canonicalization surfaces as an
 *   authentication failure, never as a fabricated outcome).
 * - Webhooks: the `X-Signature` header is hex(HMAC-SHA256(secret, RAW
 *   body)) — constant-time compare, RAW body required, (provider,
 *   eventId) dedupe. The scheme carries NO timestamp — no fabricated
 *   replay window is invented.
 * - Idempotency honesty: the connector derives a deterministic
 *   `tracking_id` from the protocol idempotency key (INV-F05) so retries
 *   carry the SAME tracking id; a duplicate submission surfaces as a
 *   provider-defined error (duplicateBehavior PROVIDER_DEFINED) through
 *   the RailProviderError path — NEVER a silent success.
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

export const DLOCAL_PROVIDER_NAME = "dlocal" as const;
/** The pinned dLocal API surface (payments_api/v6 + payment-methods/v2). */
export const DLOCAL_API_VERSION = "v6" as const;
export const DLOCAL_RAIL_ADAPTER_ID = "rail.dlocal" as const;
export const DLOCAL_RAIL_IMPLEMENTATION_ID = "impl.rails.dlocal.v6" as const;
export const DLOCAL_CONNECTOR_ID = "connector.rails.dlocal" as const;
export const DLOCAL_DEFAULT_API_BASE_SANDBOX = "https://sandbox.dlocal.com" as const;
/**
 * The documented dLocal LIVE base. HONEST UNCERTAINTY: the live host is the
 * provider's documented production endpoint convention and is UNVERIFIED in
 * this deployment (the 2026-10-02 probe touched the sandbox host only) —
 * production activation must confirm it live (BLOCKED-RAILS.md §8).
 */
export const DLOCAL_DEFAULT_API_BASE_LIVE = "https://api.dlocal.com" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("dlocal")` —
 * `PROVIDER_DLOCAL_CREDENTIAL_REF`, bound (per the deployment template) to
 * `vault://payswap/providers/dlocal/sandbox-20261002`. ABSENT in this
 * deployment: no dLocal credential exists; the rail fails closed.
 */
export const DLOCAL_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  DLOCAL_PROVIDER_NAME,
);

/**
 * The RECORDED reachability datum (2026-10-02 TL resident-watch probe,
 * recorded in spec/development-state/phase-2-state.json): the dLocal
 * sandbox host is REACHABLE without credentials (root answers 200; the API
 * paths require the documented auth headers). Honest consequences:
 * availability stays UNKNOWN (INV-C01/C02 — reachable-but-unauthorized is
 * UNKNOWN, never AVAILABLE/UNAVAILABLE), health is DEGRADED with this
 * datum as the reason, and no advertised coverage is routable (INV-NC04 +
 * the coverage law).
 */
export const DLOCAL_SANDBOX_REACHABILITY_DATUM_20261002: {
  readonly endpoint: string;
  readonly rootHttpStatus: 200;
  readonly verdict: "REACHABLE_UNAUTHENTICATED_ROOT";
  readonly detail: string;
  readonly probedAt: string;
} = Object.freeze({
  endpoint: DLOCAL_DEFAULT_API_BASE_SANDBOX,
  rootHttpStatus: 200,
  verdict: "REACHABLE_UNAUTHENTICATED_ROOT",
  detail:
    "sandbox host reachable without credentials (root 200); the payments_api/v6 and payment-methods/v2 paths require the documented X-Login/X-Trans-Key/X-Date + V2-HMAC-SHA256 Authorization headers",
  probedAt: "2026-10-02T00:00:00Z",
});

// ---------------------------------------------------------------------------
// Capability definitions (consumed W2-003 vocabulary — never redefined)
// ---------------------------------------------------------------------------

export const DLOCAL_PAYMENT_CAPABILITY_ID = "cap.rails.dlocal.payment.authorize" as const;
export const DLOCAL_REFUND_CAPABILITY_ID = "cap.rails.dlocal.refund" as const;
export const DLOCAL_PAYOUT_CAPABILITY_ID = "cap.rails.dlocal.payout" as const;
export const DLOCAL_COVERAGE_CAPABILITY_ID = "cap.rails.dlocal.coverage_observation" as const;

/**
 * The provider-state vocabulary this connector maps (INV-C06): every dLocal
 * payment status (the v6 authorize/status surface — dLocal reuses the same
 * vocabulary on refunds) with its additive classification. Exported as data
 * so certification/conformance surfaces can diff the mapping without
 * reading the implementation.
 *
 * | dLocal status | family                   | isTerminal | notes |
 * |---------------|--------------------------|------------|-------|
 * | PENDING       | async_processing         | false      | processing |
 * | AUTHORIZED    | async_processing         | false      | authorized, not settled |
 * | VERIFIED      | async_processing         | false      | verified, not settled |
 * | IN_PROGRESS   | async_processing         | false      | processing |
 * | PAID          | other                    | true       | SETTLED-EXTERNAL |
 * | CHARGEBACK    | dispute                  | false      | dispute family |
 * | CANCELLED     | other                    | true       | definitive no-effect |
 * | DECLINED      | other                    | true       | definitive failure |
 * | REJECTED      | other                    | true       | definitive failure (risk) |
 * | ERROR         | other                    | true       | TERMINAL PROVIDER verdict |
 * | EXPIRED       | other                    | true       | definitive |
 * | (unknown)     | other                    | false      | verbatim step |
 */
export const DLOCAL_PAYMENT_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "PENDING", family: "async_processing", lifecycleStep: "PENDING", isTerminal: false, requiresCustomerAction: false },
  { providerState: "AUTHORIZED", family: "async_processing", lifecycleStep: "AUTHORIZED", isTerminal: false, requiresCustomerAction: false },
  { providerState: "VERIFIED", family: "async_processing", lifecycleStep: "VERIFIED", isTerminal: false, requiresCustomerAction: false },
  { providerState: "IN_PROGRESS", family: "async_processing", lifecycleStep: "IN_PROGRESS", isTerminal: false, requiresCustomerAction: false },
  { providerState: "PAID", family: "other", lifecycleStep: "PAID", isTerminal: true, requiresCustomerAction: false },
  { providerState: "CHARGEBACK", family: "dispute", lifecycleStep: "CHARGEBACK", isTerminal: false, requiresCustomerAction: false },
  { providerState: "CANCELLED", family: "other", lifecycleStep: "CANCELLED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "DECLINED", family: "other", lifecycleStep: "DECLINED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "REJECTED", family: "other", lifecycleStep: "REJECTED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "ERROR", family: "other", lifecycleStep: "ERROR", isTerminal: true, requiresCustomerAction: false },
  { providerState: "EXPIRED", family: "other", lifecycleStep: "EXPIRED", isTerminal: true, requiresCustomerAction: false },
]);

/** The same vocabulary on the PAYOUT surface maps into the payout family. */
export const DLOCAL_PAYOUT_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze(DLOCAL_PAYMENT_STATUS_MAPPING.map((row) =>
  row.providerState === "PAID" || row.providerState === "CHARGEBACK"
    ? row
    : { ...row, family: "payout" as const },
));

function dlocalCapabilityDefinition(input: {
  readonly capabilityId: string;
  readonly summary: string;
  readonly operation: string;
  readonly description: string;
  readonly requiredPermissions: readonly string[];
  readonly requiredScopes: readonly string[];
  readonly preconditions: readonly string[];
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
      "credential reference provisioned through the control plane (PROVIDER_DLOCAL_CREDENTIAL_REF)",
      ...input.preconditions,
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
      // dLocal deduplicates on the merchant tracking_id: the deterministic
      // derivation (INV-F05) makes retries send the SAME tracking id; a
      // duplicate submission surfaces as a provider-defined error through
      // the error path — never a silent success.
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
        { action: "authorize", description: "POST /payments_api/v6/authorize — collection payment toward a payment method id/flow" },
        { action: "status", description: "GET /payments_api/v6/status/{payment_id} — the reconciliation path" },
        { action: "refund", description: "POST /payments_api/v6/refunds — refund a payment" },
        { action: "cancel", description: "POST /payments_api/v6/payments/{id}/cancel — cancel where the flow supports it" },
        { action: "payout", description: "POST /payments_api/v6/payouts — payout with payout_method_id + beneficiary" },
        { action: "list_payment_methods", description: "GET /payment-methods/v2/payment-methods — connected-account coverage observation" },
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
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "dLocal settlement schedule" },
    constraints: [
      {
        kind: "JURISDICTION",
        description:
          "country/currency/method coverage follows ONLY the connected-account observation (payment-methods/v2) — no advertised global catalogue coverage is routable without connected-instance evidence",
      },
    ],
  });
}

/** The canonical capability definitions consumed by the dLocal connector. */
export function dlocalCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return Object.freeze([
    dlocalCapabilityDefinition({
      capabilityId: DLOCAL_PAYMENT_CAPABILITY_ID,
      summary: "Cross-border collection payment lifecycle on the real dLocal v6 API (pay-in family)",
      operation: "rails.dlocal.payment.authorize",
      description:
        "POST /payments_api/v6/authorize { amount, currency, country, payment_method_id | payment_method_flow, payer } then GET /payments_api/v6/status/{payment_id}: the dLocal payment id is preserved as the external id, statuses stay VERBATIM (PENDING/AUTHORIZED/VERIFIED/IN_PROGRESS/PAID/CHARGEBACK/CANCELLED/DECLINED/REJECTED/ERROR/EXPIRED), redirect/three_ds flows are customer-action-required first-class, and a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      preconditions: [
        "pay-in country/currency/method coverage OBSERVED from the connected account (GET /payment-methods/v2/payment-methods) — never assumed from the provider catalogue",
        "per-method KYC/document requirements SATISFIED — they are capability preconditions, not suggestions",
      ],
      providerStates: DLOCAL_PAYMENT_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "payment", idFormat: "payment-id:[A-Za-z0-9_-]+" },
      ],
      sideEffects: [
        { effect: "moves payer value when the payment reaches PAID", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      requiredCustomerActions: [
        {
          lifecycleStep: "PENDING",
          kind: "PROVIDER_CHALLENGE_REDIRECT",
          message: "Complete the payment at the dLocal redirect/three_ds URL before it expires",
        },
      ],
    }),
    dlocalCapabilityDefinition({
      capabilityId: DLOCAL_REFUND_CAPABILITY_ID,
      summary: "Refunds on dLocal payments (POST /payments_api/v6/refunds)",
      operation: "rails.dlocal.refund.create",
      description:
        "Create dLocal refunds by payment id (optionally partial, in exact minor units); refund objects carry the same status vocabulary as payments (PAID/PENDING/REJECTED/…) mapped losslessly into the refund family",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      preconditions: [],
      providerStates: [
        { providerState: "PENDING", canonicalState: "refund:PENDING", requiresCustomerAction: false, isTerminal: false },
        { providerState: "PAID", canonicalState: "refund:PAID", requiresCustomerAction: false, isTerminal: true },
        { providerState: "REJECTED", canonicalState: "refund:REJECTED", requiresCustomerAction: false, isTerminal: true },
        { providerState: "CANCELLED", canonicalState: "refund:CANCELLED", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "refund", idFormat: "refund-id:[A-Za-z0-9_-]+" }],
      sideEffects: [
        { effect: "returns previously collected value to the payer", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    dlocalCapabilityDefinition({
      capabilityId: DLOCAL_PAYOUT_CAPABILITY_ID,
      summary: "Payout lifecycle with explicit beneficiary requirements (payout family — separate from pay-in)",
      operation: "rails.dlocal.payout.transfer",
      description:
        "POST /payments_api/v6/payouts { payout_method_id, amount, currency, country, beneficiary } : payout statuses stay VERBATIM and map into the payout family; the beneficiary object's provider-defined fields are modeled explicitly as DlocalBeneficiaryRequirement records",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      preconditions: [
        "payout method coverage OBSERVED from the connected account — the payout coverage surface is SEPARATE from pay-in; a pay-in observation never authorizes a payout",
        "beneficiary requirements for the payout method EXPLICIT and SATISFIED (the provider-defined fields behind the payout beneficiary object)",
      ],
      providerStates: DLOCAL_PAYOUT_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [{ objectType: "payout", idFormat: "payout-id:[A-Za-z0-9_-]+" }],
      sideEffects: [
        { effect: "moves value to the beneficiary when the payout completes", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    dlocalCapabilityDefinition({
      capabilityId: DLOCAL_COVERAGE_CAPABILITY_ID,
      summary: "Country/currency/method coverage OBSERVED from the connected account (pay-in and payout surfaces)",
      operation: "rails.dlocal.coverage.observe",
      description:
        "GET /payment-methods/v2/payment-methods?country=XX&currency=XXX: each method entry is preserved VERBATIM as an observed coverage record; the per-method KYC/document requirements are preserved VERBATIM as capability PRECONDITIONS — a capability is not eligible until they are satisfied",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      preconditions: [
        "coverage records exist ONLY from a connected-account query — dLocal's advertised catalogue is marketing, never routable evidence",
      ],
      providerStates: [
        { providerState: "observed", canonicalState: "other:observed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "payment_methods", idFormat: "pm:[A-Z]{2}:[A-Z]{3}" }],
      sideEffects: [],
    }),
  ]);
}

/** The connector capability pack backing the dLocal rail (payments family). */
export function dlocalRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.dlocal",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: dlocalCapabilityDefinitions().map((definition) => ({
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
    })),
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "payments:read"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.dlocal.provider_state", version: "1.0.0" }],
    objectMappings: [
      { externalObjectType: "payment", canonicalObjectRef: "payswap:payment", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "refund", canonicalObjectRef: "payswap:refund", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payout", canonicalObjectRef: "payswap:payout", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payment_methods", canonicalObjectRef: "payswap:eligibility_evidence", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 50, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-dlocal-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// The coverage law: observed-only records, precondition-checked eligibility
// ---------------------------------------------------------------------------

/** Which coverage surface a record belongs to (pay-in and payout are SEPARATE). */
export type DlocalCoverageSurface = "PAY_IN" | "PAYOUT";

/**
 * One KYC/document requirement field demanded by dLocal before a payment
 * method may be used — preserved VERBATIM from the observed method object
 * (document_type / required fields disclosures). These are CAPABILITY
 * PRECONDITIONS: the eligibility function refuses a capability whose
 * required fields are unsatisfied.
 */
export interface DlocalMethodRequirement {
  readonly fieldName: string;
  readonly required: boolean;
  /** The raw provider requirement object rides VERBATIM (INV-C06). */
  readonly [key: string]: unknown;
}

/**
 * One provider-defined beneficiary field for a payout method — the fields
 * the POST /payments_api/v6/payouts beneficiary object must carry.
 * Explicit records, never guessed.
 */
export interface DlocalBeneficiaryRequirement {
  readonly payoutMethodId: string;
  readonly fieldName: string;
  readonly required: boolean;
  /** The raw provider field object rides VERBATIM (INV-C06). */
  readonly [key: string]: unknown;
}

/**
 * One observed coverage record — the ONLY unit of coverage evidence this
 * connector recognizes. `source` is pinned to CONNECTED_ACCOUNT_QUERY: a
 * record can be constructed ONLY from a real connected-account observation
 * (DlocalConnector.observeCoverage — credential-gated). There is
 * deliberately NO constructor path from the provider's advertised
 * catalogue.
 */
export interface DlocalCoverageRecord {
  readonly surface: DlocalCoverageSurface;
  readonly country: string;
  readonly currency: string;
  /** Verbatim dLocal payment_method_id. */
  readonly paymentMethodId: string;
  readonly observedAt: string;
  readonly source: "CONNECTED_ACCOUNT_QUERY";
  /** KYC/document precondition fields carried by the observed method object. */
  readonly requirements: readonly DlocalMethodRequirement[];
  /** The raw provider method object, carried VERBATIM. */
  readonly raw: unknown;
}

/**
 * Normalizes the requirement disclosures of an observed dLocal method
 * object into precondition records. dLocal's method objects disclose
 * document requirements under a variety of shapes across API revisions
 * (required_fields / document_types / kyc arrays; arrays of names or of
 * objects) — every observed shape is normalized ADDITIVELY while the raw
 * object rides the coverage record verbatim. An unrecognized shape yields
 * an EMPTY list (honestly "no requirements disclosed by this object
 * shape"; the raw is preserved upstream for conformance diffing).
 */
export function dlocalMethodRequirements(methodObject: unknown): readonly DlocalMethodRequirement[] {
  const out: DlocalMethodRequirement[] = [];
  const record =
    methodObject !== null && typeof methodObject === "object"
      ? (methodObject as Readonly<Record<string, unknown>>)
      : undefined;
  if (record === undefined) {
    return Object.freeze(out);
  }
  const pushField = (candidate: unknown, required: boolean): void => {
    if (typeof candidate === "string" && candidate.length > 0) {
      out.push(Object.freeze({ fieldName: candidate, required }));
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    const field = candidate as Readonly<Record<string, unknown>>;
    const name =
      typeof field.fieldName === "string"
        ? field.fieldName
        : typeof field.field_name === "string"
          ? field.field_name
          : typeof field.name === "string"
            ? field.name
            : typeof field.document_type === "string"
              ? field.document_type
              : typeof field.type === "string"
                ? field.type
                : undefined;
    if (name === undefined || name.length === 0) {
      return;
    }
    out.push(
      Object.freeze({
        ...(field as Record<string, unknown>),
        fieldName: name,
        required: typeof field.required === "boolean" ? field.required : required,
      }),
    );
  };
  for (const key of [
    "required_fields",
    "requiredFields",
    "document_types",
    "documentTypes",
    "kyc",
    "kyc_requirements",
    "requirements",
    "fields",
  ]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        pushField(entry, true);
      }
    } else if (typeof value === "string" && value.length > 0) {
      pushField(value, true);
    }
  }
  return Object.freeze(out);
}

/**
 * Extracts EXPLICIT beneficiary requirements from an observed payout
 * method object: the provider-defined fields the
 * POST /payments_api/v6/payouts beneficiary object must carry. The raw
 * object rides the coverage record verbatim. NOT_DISCLOSED is an honest
 * verdict — the eligibility function treats disclosed-but-unsatisfied and
 * undisclosed differently.
 */
export function dlocalBeneficiaryRequirements(
  payoutMethodId: string,
  payoutMethodObject: unknown,
): readonly DlocalBeneficiaryRequirement[] {
  const out: DlocalBeneficiaryRequirement[] = [];
  const record =
    payoutMethodObject !== null && typeof payoutMethodObject === "object"
      ? (payoutMethodObject as Readonly<Record<string, unknown>>)
      : undefined;
  for (const key of ["beneficiary_required_fields", "beneficiaryRequiredFields", "beneficiary_fields", "fields", "required_fields"]) {
    const value = record?.[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string" && entry.length > 0) {
        out.push(Object.freeze({ payoutMethodId, fieldName: entry, required: true }));
        continue;
      }
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      const field = entry as Readonly<Record<string, unknown>>;
      const name =
        typeof field.fieldName === "string"
          ? field.fieldName
          : typeof field.field_name === "string"
            ? field.field_name
            : typeof field.name === "string"
              ? field.name
              : typeof field.key === "string"
                ? field.key
                : undefined;
      if (name === undefined || name.length === 0) {
        continue;
      }
      out.push(
        Object.freeze({
          ...(field as Record<string, unknown>),
          payoutMethodId,
          fieldName: name,
          required: typeof field.required === "boolean" ? field.required : true,
        }),
      );
    }
  }
  return Object.freeze(out);
}

/** The eligibility verdict for one (surface, country, currency, method). */
export interface DlocalCoverageEligibility {
  readonly surface: DlocalCoverageSurface;
  readonly country: string;
  readonly currency: string;
  readonly paymentMethodId: string;
  readonly eligible: boolean;
  readonly basis:
    | "OBSERVED_AND_PRECONDITIONS_SATISFIED"
    | "NO_CONNECTED_INSTANCE_EVIDENCE"
    | "PRECONDITIONS_UNSATISFIED";
  /** Required-but-unsatisfied precondition field names (KYC or beneficiary). */
  readonly unsatisfied: readonly string[];
  readonly reason: string;
}

/**
 * THE COVERAGE LAW, as an executable function: no advertised global
 * coverage becomes routable without connected-instance evidence.
 *
 * Eligibility is computed ONLY against `observedCoverage` — records that
 * exist ONLY because a CONNECTED account was queried through this
 * connector (the observation path is credential-gated and fail-closed).
 * dLocal's marketing catalogue of countries and methods is not an input to
 * this function and CANNOT be one: there is no parameter for it.
 *
 * - No observed record → NO_CONNECTED_INSTANCE_EVIDENCE, eligible FALSE —
 *   the honest state of every method in this deployment (credential
 *   ABSENT → empty registry).
 * - PAY_IN with unsatisfied KYC/document requirement fields →
 *   PRECONDITIONS_UNSATISFIED, eligible FALSE (the requirement fields are
 *   capability preconditions, per the P2-W2-002 acceptance).
 * - PAYOUT with unsatisfied beneficiary fields → PRECONDITIONS_UNSATISFIED.
 * - An observed record with every required field satisfied → eligible TRUE
 *   with basis OBSERVED_AND_PRECONDITIONS_SATISFIED.
 */
export function dlocalCoverageEligibility(input: {
  readonly surface: DlocalCoverageSurface;
  readonly country: string;
  readonly currency: string;
  readonly paymentMethodId: string;
  readonly observedCoverage: readonly DlocalCoverageRecord[];
  readonly satisfiedRequirementFields: readonly string[];
}): DlocalCoverageEligibility {
  const country = input.country.toUpperCase();
  const currency = input.currency.toUpperCase();
  const satisfied = new Set(input.satisfiedRequirementFields);
  const record = input.observedCoverage.find(
    (candidate) =>
      candidate.surface === input.surface &&
      candidate.country.toUpperCase() === country &&
      candidate.currency.toUpperCase() === currency &&
      candidate.paymentMethodId === input.paymentMethodId,
  );
  if (record === undefined) {
    return Object.freeze({
      surface: input.surface,
      country,
      currency,
      paymentMethodId: input.paymentMethodId,
      eligible: false,
      basis: "NO_CONNECTED_INSTANCE_EVIDENCE",
      unsatisfied: [],
      reason:
        `no connected-instance evidence for ${input.surface} ${country}/${currency}/${input.paymentMethodId} — coverage eligibility is computed ONLY from connected-account observations (the provider's advertised catalogue is never routable evidence; INV-NC04 + the P2-W2-002 coverage law)`,
    });
  }
  if (input.surface === "PAYOUT") {
    const beneficiaryFields = dlocalBeneficiaryRequirements(input.paymentMethodId, record.raw);
    const unsatisfied = beneficiaryFields
      .filter((field) => field.required && !satisfied.has(field.fieldName))
      .map((field) => field.fieldName);
    if (unsatisfied.length > 0) {
      return Object.freeze({
        surface: input.surface,
        country,
        currency,
        paymentMethodId: input.paymentMethodId,
        eligible: false,
        basis: "PRECONDITIONS_UNSATISFIED",
        unsatisfied,
        reason: `observed on the connected account, but the provider-defined beneficiary requirements are not satisfied: ${unsatisfied.join(", ")}`,
      });
    }
    return Object.freeze({
      surface: input.surface,
      country,
      currency,
      paymentMethodId: input.paymentMethodId,
      eligible: true,
      basis: "OBSERVED_AND_PRECONDITIONS_SATISFIED",
      unsatisfied: [],
      reason:
        `observed from the connected account on ${record.observedAt}${beneficiaryFields.length > 0 ? ` with all ${String(beneficiaryFields.length)} beneficiary requirement fields satisfied` : " (the observed payout method disclosed no beneficiary fields — the POST /payments_api/v6/payouts confirmation path governs)"}`,
    });
  }
  const unsatisfied = record.requirements
    .filter((field) => field.required && !satisfied.has(field.fieldName))
    .map((field) => field.fieldName);
  if (unsatisfied.length > 0) {
    return Object.freeze({
      surface: input.surface,
      country,
      currency,
      paymentMethodId: input.paymentMethodId,
      eligible: false,
      basis: "PRECONDITIONS_UNSATISFIED",
      unsatisfied,
      reason: `observed on the connected account, but the provider KYC/document preconditions are not satisfied: ${unsatisfied.join(", ")}`,
    });
  }
  return Object.freeze({
    surface: input.surface,
    country,
    currency,
    paymentMethodId: input.paymentMethodId,
    eligible: true,
    basis: "OBSERVED_AND_PRECONDITIONS_SATISFIED",
    unsatisfied: [],
    reason:
      `observed from the connected account on ${record.observedAt}${record.requirements.length > 0 ? ` with all ${String(record.requirements.length)} KYC/document preconditions satisfied` : " (the observed method disclosed no requirement fields)"}`,
  });
}

// ---------------------------------------------------------------------------
// Request authentication — the documented V2 scheme
// ---------------------------------------------------------------------------

/**
 * The dLocal X-Date value: ISO-8601 UTC at SECOND precision,
 * `YYYY-MM-DDTHH:mm:ssZ` (the documented format — no milliseconds).
 */
export function dlocalXDate(nowMs: TimestampMs): string {
  return new Date(Number(nowMs)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The EXACT dLocal V2 signature (documented scheme, implemented verbatim):
 *
 * ```text
 * signature = hex(HMAC-SHA256(secret_key, x_login + x_date + x_trans_key + body))
 * ```
 *
 * - `x_login` is the X-Login header value (merchant id);
 * - `x_date` is the X-Date value (`YYYY-MM-DDTHH:mm:ssZ`, second precision);
 * - `x_trans_key` is the X-Trans-Key header value;
 * - `body` is the RAW JSON request body string, or "" for GET requests.
 *
 * HONEST UNCERTAINTY (recorded, never guessed silently): the exact V2
 * canonicalization must be CONFIRMED live once credentials exist — the
 * scheme above is implemented faithfully per the documented construction
 * and a deviation would surface as an authentication failure (fail-closed),
 * never as a fabricated outcome. Recorded in BLOCKED-RAILS.md §8.
 */
export function dlocalV2Signature(input: {
  readonly xLogin: string;
  readonly xDate: string;
  readonly xTransKey: string;
  readonly body: string;
  readonly secret: string;
}): string {
  const stringToSign = `${input.xLogin}${input.xDate}${input.xTransKey}${input.body}`;
  return createHmac("sha256", input.secret).update(stringToSign).digest("hex");
}

/**
 * Builds the full dLocal request headers: X-Login, X-Trans-Key, X-Date and
 * `Authorization: V2-HMAC-SHA256, Signature: <hex>` (plus Content-Type for
 * bodies). The secret key never appears in a header — only inside the HMAC.
 */
export function dlocalAuthHeaders(input: {
  readonly xLogin: string;
  readonly xTransKey: string;
  readonly secret: string;
  readonly nowMs: TimestampMs;
  readonly body?: string;
}): Readonly<Record<string, string>> {
  const xDate = dlocalXDate(input.nowMs);
  const signature = dlocalV2Signature({
    xLogin: input.xLogin,
    xDate,
    xTransKey: input.xTransKey,
    body: input.body ?? "",
    secret: input.secret,
  });
  return Object.freeze({
    "X-Login": input.xLogin,
    "X-Trans-Key": input.xTransKey,
    "X-Date": xDate,
    Authorization: `V2-HMAC-SHA256, Signature: ${signature}`,
    "Content-Type": "application/json",
  });
}

// ---------------------------------------------------------------------------
// Provider object shapes (opaque passthrough — never domain primitives)
// ---------------------------------------------------------------------------

/** The raw dLocal payment object (authorize/status surfaces; opaque). */
export interface DlocalPaymentProviderObject {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: number | string;
  readonly currency?: string;
  readonly country?: string;
  readonly payment_method_id?: string;
  readonly three_ds?: { readonly redirect_url?: string; readonly [key: string]: unknown };
  readonly redirect_url?: string;
  readonly [key: string]: unknown;
}

/** The raw dLocal refund object (opaque passthrough). */
export interface DlocalRefundProviderObject {
  readonly id?: string;
  readonly payment_id?: string;
  readonly status?: string;
  readonly amount?: number | string;
  readonly currency?: string;
  readonly [key: string]: unknown;
}

/** The raw dLocal payout object (POST /payments_api/v6/payouts; opaque). */
export interface DlocalPayoutProviderObject {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: number | string;
  readonly currency?: string;
  readonly country?: string;
  readonly payout_method_id?: string;
  readonly beneficiary?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** One raw payment-methods-v2 entry (opaque passthrough). */
export interface DlocalPaymentMethodProviderObject {
  readonly payment_method_id?: string;
  readonly payment_method_flow?: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object)
// ---------------------------------------------------------------------------

/** Payment revision: id + status + redirect surface. */
export function dlocalPaymentRevision(payment: DlocalPaymentProviderObject): string {
  const redirect =
    typeof payment.redirect_url === "string" ||
    typeof payment.three_ds?.redirect_url === "string"
      ? "redirect"
      : "no_redirect";
  return `${payment.id ?? "no_id"}:${payment.status ?? "unknown"}:${redirect}`;
}

/** Refund revision: id + status. */
export function dlocalRefundRevision(refund: DlocalRefundProviderObject): string {
  return `${refund.id ?? refund.payment_id ?? "no_id"}:${refund.status ?? "unknown"}`;
}

/** Payout revision: id + status. */
export function dlocalPayoutRevision(payout: DlocalPayoutProviderObject): string {
  return `${payout.id ?? "no_id"}:${payout.status ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface DlocalEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK";
  readonly fetchId?: string;
}

function dlocalEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: DlocalEnvelopeContext,
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
    providerName: DLOCAL_PROVIDER_NAME,
    providerVersion: DLOCAL_API_VERSION,
    objectType,
    externalId,
    revision,
    state,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
}

/** Envelope shareable-field surface for dLocal provider objects. */
const DLOCAL_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "status",
  "id",
  "amount",
  "currency",
  "country",
  "payment_method_id",
  "payout_method_id",
]);

/**
 * Deterministic, additive classification of a dLocal payment into a
 * lossless ProviderStateEnvelope (INV-C06). The RAW payment is carried
 * VERBATIM as `state`; the external id is the dLocal payment `id`;
 * statuses map per DLOCAL_PAYMENT_STATUS_MAPPING:
 *
 * - PENDING/AUTHORIZED/VERIFIED/IN_PROGRESS → async_processing;
 * - PAID → terminal, SETTLED-EXTERNAL (family `other`, terminal — the
 *   definitive settled observation);
 * - CHARGEBACK → the DISPUTE family, non-terminal (the dispute lifecycle
 *   is provider-owned and observed losslessly);
 * - CANCELLED/DECLINED/REJECTED/EXPIRED → terminal definitive;
 * - ERROR → terminal failure VERDICT FROM THE PROVIDER (ambiguity NONE —
 *   dLocal explicitly answered ERROR). This is deliberately distinct from
 *   a TRANSPORT failure, which produces OUTCOME_UNKNOWN envelopes — the
 *   two are never conflated;
 * - a redirect_url / three_ds.redirect_url surface while PENDING makes the
 *   payment CUSTOMER-ACTION-REQUIRED first-class (actionRequired with the
 *   provider's deepLink);
 * - any UNKNOWN status → `other`/verbatim, non-terminal — never dropped,
 *   never guessed, never collapsed.
 */
export function dlocalPaymentEnvelope(
  payment: DlocalPaymentProviderObject,
  context: DlocalEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = payment.id ?? "no_id";
  const base = dlocalEnvelopeBase("payment", externalId, dlocalPaymentRevision(payment), payment, context);
  const redirectUrl =
    typeof payment.redirect_url === "string" && payment.redirect_url.length > 0
      ? payment.redirect_url
      : typeof payment.three_ds?.redirect_url === "string" && payment.three_ds.redirect_url.length > 0
        ? payment.three_ds.redirect_url
        : undefined;
  switch (payment.status) {
    case "PENDING":
    case "AUTHORIZED":
    case "VERIFIED":
    case "IN_PROGRESS":
      if (redirectUrl !== undefined) {
        return railEnvelope({
          ...base,
          family: "customer_action_required",
          lifecycleStep: payment.status,
          isTerminal: false,
          requiresCustomerAction: true,
          actionRequired: {
            kind: "PROVIDER_CHALLENGE_REDIRECT",
            message: "Complete the payment at the dLocal redirect / three_ds URL before it expires",
            deepLink: redirectUrl,
          },
          shareableFields: DLOCAL_SHAREABLE_FIELDS,
        });
      }
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: payment.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "PAID":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "PAID",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "CHARGEBACK":
      return railEnvelope({
        ...base,
        family: "dispute",
        lifecycleStep: "CHARGEBACK",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "CANCELLED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "CANCELLED",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payment_cancelled",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "DECLINED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "DECLINED",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payment_declined",
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "REJECTED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "REJECTED",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payment_rejected",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "ERROR":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "ERROR",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          // A TERMINAL FAILURE VERDICT FROM THE PROVIDER — the provider
          // explicitly answered ERROR (ambiguity NONE). Transport failures
          // are OUTCOME_UNKNOWN envelopes (INV-X01) — never conflated.
          providerErrorCode: "payment_ERROR",
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "EXPIRED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "EXPIRED",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payment_expired",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: payment.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
  }
}

/**
 * A dLocal refund → refund-family envelope. Refund objects carry the same
 * status vocabulary as payments (PENDING/PAID/REJECTED/CANCELLED/…),
 * mapped into the refund family; unknown statuses stay verbatim with no
 * invented terminality.
 */
export function dlocalRefundEnvelope(
  refund: DlocalRefundProviderObject,
  context: DlocalEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = refund.id ?? refund.payment_id ?? "no_id";
  const base = dlocalEnvelopeBase("refund", externalId, dlocalRefundRevision(refund), refund, context);
  switch (refund.status) {
    case "PENDING":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "PENDING",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "PAID":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "PAID",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "REJECTED":
    case "CANCELLED":
    case "DECLINED":
    case "ERROR":
    case "EXPIRED":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: refund.status,
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: `refund_${refund.status}`,
          retryable: refund.status === "ERROR",
          ambiguity: "NONE",
        },
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: refund.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
  }
}

/**
 * A dLocal payout → payout-family envelope. The SAME status vocabulary
 * maps into the payout family; a completed payout (PAID on the payout
 * surface) is settled value at the provider (settled-external); ERROR is
 * a terminal provider failure verdict (transport failures remain
 * OUTCOME_UNKNOWN — never conflated); unknown statuses stay verbatim.
 */
export function dlocalPayoutEnvelope(
  payout: DlocalPayoutProviderObject,
  context: DlocalEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = payout.id ?? "no_id";
  const base = dlocalEnvelopeBase("payout", externalId, dlocalPayoutRevision(payout), payout, context);
  switch (payout.status) {
    case "PENDING":
    case "AUTHORIZED":
    case "VERIFIED":
    case "IN_PROGRESS":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: payout.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "PAID":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "PAID",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "CHARGEBACK":
      return railEnvelope({
        ...base,
        family: "dispute",
        lifecycleStep: "CHARGEBACK",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    case "CANCELLED":
    case "DECLINED":
    case "REJECTED":
    case "ERROR":
    case "EXPIRED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: payout.status,
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: `payout_${payout.status}`,
          retryable: payout.status === "ERROR" || payout.status === "DECLINED",
          ambiguity: "NONE",
        },
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: payout.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: DLOCAL_SHAREABLE_FIELDS,
      });
  }
}

/**
 * A payment-methods-v2 answer → one lossless coverage-evidence envelope.
 * Every method entry rides VERBATIM; the family stays `other` (an
 * observation, not a payment lifecycle).
 */
export function dlocalCoverageEnvelope(
  country: string,
  currency: string,
  methods: readonly unknown[],
  context: DlocalEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: DLOCAL_PROVIDER_NAME,
    providerVersion: DLOCAL_API_VERSION,
    objectType: "payment_methods",
    externalId: `pm:${country.toUpperCase()}:${currency.toUpperCase()}`,
    revision: `pm:${country.toUpperCase()}:${currency.toUpperCase()}:${methods.length}`,
    state: Object.freeze({
      country: country.toUpperCase(),
      currency: currency.toUpperCase(),
      data: methods,
    }),
    family: "other",
    lifecycleStep: "observed",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: DLOCAL_SHAREABLE_FIELDS,
  });
}

/**
 * Maps a dLocal webhook notification payload to the lossless envelope for
 * its inner object. Notification objects carrying a `payment` map through
 * the payment mapper; a notification whose top-level object IS a payment
 * (id + status, no wrapper) maps directly; everything else produces an
 * `event`-typed envelope carrying the WHOLE payload verbatim — nothing is
 * dropped (INV-C06).
 */
export function dlocalWebhookEventEnvelope(
  payload: unknown,
  context: DlocalEnvelopeContext,
): ProviderStateEnvelope {
  const webhookContext: DlocalEnvelopeContext = {
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
  if (payload !== null && typeof payload === "object") {
    const record = payload as { readonly payment?: unknown; readonly type?: unknown; readonly status?: unknown; readonly id?: unknown };
    if (record.payment !== null && typeof record.payment === "object") {
      return dlocalPaymentEnvelope(record.payment as DlocalPaymentProviderObject, webhookContext);
    }
    if (typeof record.id === "string" && typeof record.status === "string") {
      return dlocalPaymentEnvelope(payload as DlocalPaymentProviderObject, webhookContext);
    }
  }
  return railEnvelope({
    providerName: DLOCAL_PROVIDER_NAME,
    providerVersion: DLOCAL_API_VERSION,
    objectType: "event",
    externalId: `event:${String((payload as { readonly id?: unknown } | null)?.id ?? "no_id")}`,
    revision: String((payload as { readonly type?: unknown } | null)?.type ?? "untyped"),
    state: payload,
    family: "other",
    lifecycleStep: String((payload as { readonly type?: unknown } | null)?.type ?? "untyped"),
    isTerminal: false,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    shareableFields: DLOCAL_SHAREABLE_FIELDS,
  });
}

// ---------------------------------------------------------------------------
// Webhook verification (X-Signature: hex HMAC-SHA256 of the RAW body)
// ---------------------------------------------------------------------------

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

/** The documented dLocal webhook signature: hex(HMAC-SHA256(secret, raw body)). */
export function dlocalWebhookSignature(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** The verification result for one dLocal webhook delivery. */
export type DlocalWebhookDeliveryVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "MISSING_SIGNATURE" | "SIGNATURE_INVALID" };

/**
 * Verifies one dLocal webhook delivery: the `X-Signature` header must
 * equal hex(HMAC-SHA256(secret, RAW body)) compared in CONSTANT TIME. The
 * scheme carries NO timestamp — replay defense is the (provider, eventId)
 * dedupe at the ingestor, never a fabricated window.
 */
export function verifyDlocalWebhookDelivery(
  delivery: { readonly signatureHeader: string | undefined; readonly rawBody: string },
  deps: { readonly secret: string },
): DlocalWebhookDeliveryVerification {
  if (typeof delivery.signatureHeader !== "string" || delivery.signatureHeader.length === 0) {
    return { valid: false, reason: "MISSING_SIGNATURE" };
  }
  const expected = dlocalWebhookSignature(deps.secret, delivery.rawBody);
  if (!constantTimeEquals(delivery.signatureHeader, expected)) {
    return { valid: false, reason: "SIGNATURE_INVALID" };
  }
  return { valid: true };
}

/**
 * The deterministic dedupe event id for a dLocal webhook payload:
 * `${type}:${id}` — the provider's own event/object identity pair.
 */
export function dlocalWebhookEventId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as { readonly type?: unknown; readonly id?: unknown };
  const id =
    typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : "no-id";
  return `${String(record.type ?? "untyped")}:${id}`;
}

/**
 * The provider-declared event timestamp from a dLocal webhook payload, when
 * the payload carries one (e.g. `created_date` epoch seconds) — undefined
 * otherwise (the caller then supplies its own observation; the scheme
 * itself signs no timestamp).
 */
export function dlocalWebhookEventTimestamp(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as { readonly created_date?: unknown; readonly createdDate?: unknown };
  const candidate = record.created_date ?? record.createdDate;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return String(Math.floor(candidate));
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    return candidate;
  }
  return undefined;
}

/**
 * Adapts a raw dLocal delivery into the adapters' ProviderWebhookRawEvent.
 * `headers.signature` carries the X-Signature value for the verifier's
 * constant-time HMAC compare over the RAW body.
 */
export function dlocalWebhookRawEvent(delivery: {
  readonly eventId: string;
  readonly payload: unknown;
  readonly signatureHeader: string;
  readonly timestampSeconds: string;
}): ProviderWebhookRawEvent {
  return Object.freeze({
    providerName: DLOCAL_PROVIDER_NAME,
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
 * The dLocal X-Signature verifier on the adapters' WebhookSignatureVerifier
 * hook: hex(HMAC-SHA256(secret, canonicalBody)) — the canonicalBody is the
 * RAW request body string.
 */
export class DlocalWebhookVerifier implements WebhookSignatureVerifier {
  readonly #secret: string;

  constructor(secret: string) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new ValidationError("a dLocal webhook verifier requires a non-empty secret key");
    }
    this.#secret = secret;
  }

  verify(
    event: ProviderWebhookRawEvent,
    canonicalBody: string,
  ): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
    if (
      typeof event.headers.signature !== "string" ||
      event.headers.signature.length === 0 ||
      !constantTimeEquals(event.headers.signature, dlocalWebhookSignature(this.#secret, canonicalBody))
    ) {
      return { valid: false, reason: "SIGNATURE_INVALID" };
    }
    return { valid: true };
  }
}

/**
 * Wires a ProviderWebhookIngestor for dLocal: X-Signature HMAC-SHA256
 * verification (raw body), replay window over the provider-declared event
 * time when present, (provider, eventId) dedupe and append-only evidence —
 * the adapters ingestor pattern with the dLocal scheme plugged in.
 */
export function createDlocalWebhookIngestor(deps: {
  readonly secret: string;
  readonly clock: ProtocolClock;
  readonly replayWindowSeconds?: number;
  readonly futureSkewSeconds?: number;
}): ProviderWebhookIngestor {
  return new WebhookIngestor({
    verifier: new DlocalWebhookVerifier(deps.secret),
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
// Idempotency (deterministic tracking_id — INV-F05)
// ---------------------------------------------------------------------------

/**
 * Derives the deterministic dLocal tracking_id from the protocol
 * idempotency key (INV-F05). dLocal deduplicates on the merchant tracking
 * id: the deterministic derivation makes retries send the SAME tracking id
 * and a duplicate submission surfaces as a provider-defined error through
 * the error path — NEVER a silent success. The caller's protocol
 * idempotency registrar remains the double-execution guard.
 */
export function dlocalTrackingId(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap-${protocolIdempotencyKey}`;
}

// ---------------------------------------------------------------------------
// The RailAdapter surface (provider-neutral framework registration)
// ---------------------------------------------------------------------------

/** The dLocal production rail adapter on the BaseRailAdapter framework. */
export class DlocalProductionRail extends BaseRailAdapter {
  readonly adapterId = DLOCAL_RAIL_ADAPTER_ID;
  readonly implementationId = DLOCAL_RAIL_IMPLEMENTATION_ID;

  constructor() {
    const definitions = new Map<string, CapabilityDefinition>();
    for (const definition of dlocalCapabilityDefinitions()) {
      definitions.set(definition.capabilityId, definition);
    }
    super(dlocalRailCapabilityPack(), definitions);
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK; credential-gated, fail-closed)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface DlocalControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface DlocalConnectorConfig {
  readonly clock: ProtocolClock;
  readonly apiBase?: string;
  /** Defaults to the SANDBOX base; production deployments pin the live base explicitly. */
  readonly environment?: "sandbox" | "live";
  /** Overrides the pinned API version (tests only — production pins). */
  readonly apiVersion?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("dlocal")` = PROVIDER_DLOCAL_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: DlocalControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type DlocalSdkRequest =
  | {
      readonly kind: "create_payment";
      readonly amountMajor: string;
      readonly currency: string;
      readonly country: string;
      readonly paymentMethodId?: string;
      readonly paymentMethodFlow?: "DIRECT" | "REDIRECT";
      readonly payer: Readonly<Record<string, unknown>>;
      readonly callbackUrl?: string;
      readonly notificationUrl?: string;
    }
  | { readonly kind: "read_payment"; readonly paymentId: string }
  | {
      readonly kind: "create_refund";
      readonly paymentId: string;
      readonly amountMajor?: string;
    }
  | { readonly kind: "cancel_payment"; readonly paymentId: string }
  | {
      readonly kind: "create_payout";
      readonly payoutMethodId: string;
      readonly amountMajor: string;
      readonly currency: string;
      readonly country: string;
      readonly beneficiary: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "read_payout"; readonly payoutId: string };

function isDlocalSdkRequest(candidate: unknown): candidate is DlocalSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** Which credential path is live (observability — NEVER material). */
export type DlocalCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/**
 * The real dLocal connector (ConnectorSDK framework). dLocal API names,
 * payloads, response shapes and quirks stay INSIDE this implementation: the
 * SDK call contract is the provider-neutral `DlocalSdkRequest` union.
 * Every effectful operation runs behind `requireAuthority`
 * (INV-C04/F05/F06) and fails closed with `RailNotAuthorizedError` BEFORE
 * any provider call when no credential path is live (INV-NC04).
 */
export class DlocalConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: DlocalControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  #credentialBaseline: string | undefined;

  constructor(config: DlocalConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase =
      config.apiBase ??
      (config.environment === "live"
        ? DLOCAL_DEFAULT_API_BASE_LIVE
        : DLOCAL_DEFAULT_API_BASE_SANDBOX);
    this.#apiVersion = config.apiVersion ?? DLOCAL_API_VERSION;
    this.#credentialConfigKey = config.credentialConfigKey ?? DLOCAL_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: DLOCAL_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "dLocal (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return dlocalRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): DlocalCredentialResolutionState {
    if (this.#controlPlane !== undefined) {
      return Object.freeze({
        kind: "CONTROL_PLANE_SEALED",
        configKey: this.#credentialConfigKey,
      });
    }
    if (this.#envMaterial() !== undefined) {
      return Object.freeze({
        kind: "ENV_RESOLVED_MATERIAL",
        configKey: this.#credentialConfigKey,
      });
    }
    return Object.freeze({
      kind: "NOT_PROVISIONED",
      configKey: this.#credentialConfigKey,
      reason:
        "no control-plane credentials and no env-resolved material under the config key — rail fails closed (INV-NC04; packages/rails/BLOCKED-RAILS.md §8)",
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
          "credential reference not provisioned (PROVIDER_DLOCAL_CREDENTIAL_REF absent) — source availability UNKNOWN (INV-C01/C02); the 2026-10-02 probe recorded the sandbox host REACHABLE (root 200) with API paths requiring auth headers, which is still UNKNOWN, never AVAILABLE; see packages/rails/BLOCKED-RAILS.md §8",
        provenance: {
          providerName: DLOCAL_PROVIDER_NAME,
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
          providerName: DLOCAL_PROVIDER_NAME,
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
        providerName: DLOCAL_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(DLOCAL_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface --------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "dlocal search is not implemented — the connector's reconciliation path is the external payment id (GET /payments_api/v6/status/{payment_id}, INV-X03), and no listing surface is in the connector contract",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "read_payment|read_payout");
    const observedAt = this.#envelopeContext();
    if (request.kind === "read_payment") {
      const data = await this.#withCredentials(async (material) =>
        this.#providerGet(
          `/payments_api/v6/status/${encodeURIComponent(request.paymentId)}`,
          ctx.idempotencyKey,
          material,
        ),
      );
      return this.#sdkResult(
        dlocalPaymentEnvelope(data as DlocalPaymentProviderObject, observedAt),
        `dlocal:read-payment:${request.paymentId}`,
      );
    }
    if (request.kind === "read_payout") {
      const data = await this.#withCredentials(async (material) =>
        this.#providerGet(
          `/payments_api/v6/payouts/${encodeURIComponent(request.payoutId)}`,
          ctx.idempotencyKey,
          material,
        ),
      );
      return this.#sdkResult(
        dlocalPayoutEnvelope(data as DlocalPayoutProviderObject, observedAt),
        `dlocal:read-payout:${request.payoutId}`,
      );
    }
    throw new ValidationError("dlocal read supports only { kind: 'read_payment' | 'read_payout' }");
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_payment");
    if (request.kind !== "create_payment") {
      throw new ValidationError("dlocal create supports only { kind: 'create_payment' }");
    }
    if (
      request.amountMajor === undefined ||
      request.currency === undefined ||
      request.country === undefined ||
      request.payer === undefined
    ) {
      throw new ValidationError(
        "create_payment requires amountMajor (exact major-unit decimal), currency, country and payer",
      );
    }
    const trackingId = dlocalTrackingId(ctx.idempotencyKey);
    const body: Record<string, unknown> = {
      amount: Number(request.amountMajor),
      currency: request.currency.toUpperCase(),
      country: request.country.toUpperCase(),
      // INV-F05: the deterministic tracking id — dLocal's duplicate-submission
      // surface. Retries send the SAME tracking id; a duplicate surfaces as a
      // provider error, never a silent success.
      tracking_id: trackingId,
      payer: request.payer,
      ...(request.paymentMethodId !== undefined ? { payment_method_id: request.paymentMethodId } : {}),
      ...(request.paymentMethodFlow !== undefined
        ? { payment_method_flow: request.paymentMethodFlow }
        : {}),
      ...(request.callbackUrl !== undefined ? { callback_url: request.callbackUrl } : {}),
      ...(request.notificationUrl !== undefined
        ? { notification_url: request.notificationUrl }
        : {}),
    };
    const observedAt = this.#envelopeContext();
    // INV-X01: a transport failure mid-create is OUTCOME_UNKNOWN — the
    // payment may exist at the provider; reconcile by the dLocal payment id
    // (and the tracking id). NEVER FAILED.
    try {
      const data = await this.#withCredentials(async (material) =>
        this.#providerPost("/payments_api/v6/authorize", body, ctx.idempotencyKey, material),
      );
      return this.#sdkResult(
        dlocalPaymentEnvelope((data ?? {}) as DlocalPaymentProviderObject, observedAt),
        `dlocal:create-payment:${trackingId}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "payment",
          externalId: trackingId,
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
      "dlocal payments are mutated only through the provider's cancel/refund surfaces (executeAction) — no generic update exists",
    );
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "create_refund|cancel_payment|create_payout");
    const observedAt = this.#envelopeContext();
    if (request.kind === "create_refund") {
      if (request.paymentId === undefined) {
        throw new ValidationError("create_refund requires paymentId");
      }
      const body: Record<string, unknown> = {
        payment_id: request.paymentId,
        ...(request.amountMajor !== undefined ? { amount: Number(request.amountMajor) } : {}),
      };
      // INV-X01: value can move on a refund — OUTCOME_UNKNOWN, never FAILED.
      try {
        const data = await this.#withCredentials(async (material) =>
          this.#providerPost("/payments_api/v6/refunds", body, ctx.idempotencyKey, material),
        );
        const refundData = (data ?? {}) as DlocalRefundProviderObject;
        return this.#sdkResult(
          dlocalRefundEnvelope(refundData, observedAt),
          `dlocal:create-refund:${String(refundData.id ?? request.paymentId)}:${this.#clock.now()}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "refund",
            externalId: request.paymentId,
            operation: "create_refund",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    if (request.kind === "cancel_payment") {
      if (request.paymentId === undefined) {
        throw new ValidationError("cancel_payment requires paymentId");
      }
      try {
        const data = await this.#withCredentials(async (material) =>
          this.#providerPost(
            `/payments_api/v6/payments/${encodeURIComponent(request.paymentId)}/cancel`,
            {},
            ctx.idempotencyKey,
            material,
          ),
        );
        return this.#sdkResult(
          dlocalPaymentEnvelope((data ?? {}) as DlocalPaymentProviderObject, observedAt),
          `dlocal:cancel-payment:${request.paymentId}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "payment",
            externalId: request.paymentId,
            operation: "cancel_payment",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    if (request.kind === "create_payout") {
      if (
        request.amountMajor === undefined ||
        request.currency === undefined ||
        request.country === undefined ||
        request.payoutMethodId === undefined
      ) {
        throw new ValidationError(
          "create_payout requires payoutMethodId, amountMajor, currency and country",
        );
      }
      const trackingId = dlocalTrackingId(ctx.idempotencyKey);
      const body: Record<string, unknown> = {
        payout_method_id: request.payoutMethodId,
        amount: Number(request.amountMajor),
        currency: request.currency.toUpperCase(),
        country: request.country.toUpperCase(),
        // The beneficiary object carries the provider-defined fields — the
        // explicit DlocalBeneficiaryRequirement records govern what must be
        // in it (dlocalBeneficiaryRequirements).
        beneficiary: request.beneficiary,
        tracking_id: trackingId,
      };
      // INV-X01: value moves on a payout — OUTCOME_UNKNOWN, never FAILED.
      try {
        const data = await this.#withCredentials(async (material) =>
          this.#providerPost("/payments_api/v6/payouts", body, ctx.idempotencyKey, material),
        );
        const payoutData = (data ?? {}) as DlocalPayoutProviderObject;
        return this.#sdkResult(
          dlocalPayoutEnvelope(payoutData, observedAt),
          `dlocal:create-payout:${trackingId}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "payout",
            externalId: trackingId,
            operation: "create_payout",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    throw new ValidationError(
      "dlocal executeAction supports only { kind: 'create_refund' | 'cancel_payment' | 'create_payout' }",
    );
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "dlocal event subscription is handled by the webhook ingestion framework (createDlocalWebhookIngestor + @payswap/adapters ProviderWebhookIngestor), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "read_payment|read_payout");
    if (request.kind !== "read_payment" && request.kind !== "read_payout") {
      throw new ValidationError(
        "dlocal reconcile supports only { kind: 'read_payment' | 'read_payout' }",
      );
    }
    // Reconciliation-as-authority (INV-X03): re-fetch by external object id.
    return this.read(ctx);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "dlocal disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and release the sealed credential handle); the provider surface offers no self-disconnect",
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md, dLocal path —
   * swap-reference-then-verify): the vault binding for the control-plane
   * config key is swapped to a NEW reference at the vault; the connector
   * re-resolves per call, so the rotation is real exactly when the NEW
   * reference resolves and serves a successful health probe. The old key
   * is revoked at dLocal only after that verification.
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
          evidenceId: `dlocal:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: DLOCAL_PROVIDER_NAME,
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
        "cannot rotate credentials: no credential path is provisioned for the dlocal rail (packages/rails/BLOCKED-RAILS.md §8)",
        { railId: DLOCAL_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = createHmac("sha256", "payswap-dlocal-rotation-baseline")
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
        evidenceId: `dlocal:cred-rotation:${rotatedAt}`,
        evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
        kind: "AUDIT_LOG",
        providerState: railEnvelope({
          providerName: DLOCAL_PROVIDER_NAME,
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
   * never a business outcome. Without credentials: host reachability via
   * an unauthenticated GET on the recorded probe root (any HTTP answer
   * proves the host reachable) → DEGRADED with reasons; transport failure
   * → UNKNOWN. With credentials: an authenticated coverage query (the real
   * probe) → HEALTHY.
   */
  async health(): Promise<ConnectorHealthReport> {
    const resolution = this.credentialResolutionState();
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: DLOCAL_CONNECTOR_ID,
      providerName: DLOCAL_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (resolution.kind === "NOT_PROVISIONED") {
      let endpointAnswered: boolean;
      try {
        await this.#http(`${this.#apiBase}/`, {
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
              "credentials absent: provider host reachable (the recorded 2026-10-02 probe — root 200, API paths require auth headers) but rail authorization cannot be established — availability UNKNOWN (INV-C01/C02; packages/rails/BLOCKED-RAILS.md §8)",
            ]
          : ["provider host unreachable — availability UNKNOWN (INV-C02)"],
      };
    }
    try {
      await this.#withCredentials(async (material) =>
        this.#providerGet(
          "/payment-methods/v2/payment-methods?country=BR&currency=BRL",
          "health-probe",
          material,
        ),
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

  // -- dedicated coverage observation method (the work order's core) ----------

  /**
   * Observes the country/currency method coverage from the CONNECTED
   * account (GET /payment-methods/v2/payment-methods?country=XX&currency=
   * XXX) — the ONLY source of coverage records (the coverage law). The
   * `surface` parameter keeps PAY_IN and PAYOUT separate: the observed
   * method list is tagged with the surface the caller is investigating
   * (dLocal's single method list feeds both families; the eligibility
   * functions still require surface-matched records, so a pay-in record
   * never authorizes a payout and vice versa).
   */
  async observeCoverage(input: {
    readonly surface: DlocalCoverageSurface;
    readonly country: string;
    readonly currency: string;
  }): Promise<{
    readonly records: readonly DlocalCoverageRecord[];
    readonly envelope: ProviderStateEnvelope;
  }> {
    const country = input.country.toUpperCase();
    const currency = input.currency.toUpperCase();
    const observedAt = this.#envelopeContext();
    const data = (await this.#withCredentials(async (material) =>
      this.#providerGet(
        `/payment-methods/v2/payment-methods?country=${encodeURIComponent(country)}&currency=${encodeURIComponent(currency)}`,
        "coverage",
        material,
      ),
    )) as readonly DlocalPaymentMethodProviderObject[];
    if (!Array.isArray(data)) {
      throw new RailProviderError(
        "dlocal payment-methods response is malformed (expected a data array)",
        { path: "/payment-methods/v2/payment-methods", country, currency },
      );
    }
    const records: DlocalCoverageRecord[] = [];
    for (const method of data) {
      records.push(
        Object.freeze({
          surface: input.surface,
          country,
          currency,
          paymentMethodId: String(method.payment_method_id ?? "unknown_method"),
          observedAt: observedAt.observedAt,
          source: "CONNECTED_ACCOUNT_QUERY",
          requirements: dlocalMethodRequirements(method),
          raw: method,
        }),
      );
    }
    return {
      records: Object.freeze(records),
      envelope: dlocalCoverageEnvelope(country, currency, data, observedAt),
    };
  }

  // -- internals -------------------------------------------------------------------

  #envelopeContext(): DlocalEnvelopeContext {
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
   * plane opens the SEALED bundle per call (material exists only inside
   * the callback frame); the env fallback injects the RESOLVED material as
   * a JSON bundle string under the same config key (the W1-005 rails
   * convention — the shape is validated here, fail-closed). With neither,
   * the operation fails closed BEFORE any provider call (INV-NC04).
   */
  async #withCredentials<T>(fn: (material: DlocalCredentialMaterial) => Promise<T>): Promise<T> {
    if (this.#controlPlane !== undefined) {
      let handle: ReturnType<CredentialBroker["resolveProviderCredential"]>;
      try {
        handle = this.#controlPlane.broker.resolveProviderCredential(
          this.#credentialConfigKey,
        );
      } catch (error) {
        throw new RailNotAuthorizedError(
          "dlocal rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: DLOCAL_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => fn(extractDlocalCredentialMaterial(opened.material)),
      );
    }
    const raw = this.#envMaterial();
    if (raw === undefined) {
      throw new RailNotAuthorizedError(
        "dlocal rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md §8)",
        { railId: DLOCAL_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new ValidationError(
        "the env-resolved dLocal credential material is not a JSON bundle — expected { x_login, x_trans_key, secret_key } (fail-closed, never guessed)",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    return fn(extractDlocalCredentialMaterial(parsed));
  }

  #request(ctx: SdkCallContext, expectedKind: string): DlocalSdkRequest {
    const candidate = ctx.request;
    if (!isDlocalSdkRequest(candidate)) {
      throw new ValidationError(
        `dlocal rail call request must be a DlocalSdkRequest object (expected kind '${expectedKind}')`,
      );
    }
    if (
      "amountMajor" in candidate &&
      candidate.amountMajor !== undefined &&
      !/^\d+(\.\d+)?$/.test(String(candidate.amountMajor))
    ) {
      throw new ValidationError(
        "amountMajor must be an exact non-negative decimal string in the provider's currency units (INV-F01)",
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
      providerName: DLOCAL_PROVIDER_NAME,
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
        note: "transport failed mid-effect — the provider effect may have landed; reconcile by the dLocal payment id / tracking id (INV-X01/INV-X03); never coerced to FAILED",
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
      shareableFields: DLOCAL_SHAREABLE_FIELDS,
    });
    return this.#sdkResult(envelope, `dlocal:outcome-unknown:${input.operation}:${input.idempotencyKey}`);
  }

  /** The dLocal response shape: { code, message, payload } / { data } — payload unwrapped. */
  #parseResponse(
    response: { readonly status: number; readonly bodyText: string },
    path: string,
    callRef: string,
  ): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("dlocal provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (parsed === null || typeof parsed !== "object") {
      if (response.status < 200 || response.status >= 300) {
        throw new RailProviderError(`dlocal provider answered HTTP ${response.status}`, {
          path,
          httpStatus: response.status,
        });
      }
      return parsed;
    }
    const body = parsed as {
      readonly code?: string | number;
      readonly message?: string;
      readonly payload?: unknown;
      readonly data?: unknown;
    };
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `dlocal provider answered HTTP ${response.status}: ${body.message ?? "provider error"} (code ${String(body.code)})`,
        { path, httpStatus: response.status, callRef },
      );
    }
    if (body.payload !== undefined) {
      return body.payload;
    }
    if (body.data !== undefined) {
      return body.data;
    }
    return parsed;
  }

  async #providerGet(
    path: string,
    callRef: string,
    material: DlocalCredentialMaterial,
  ): Promise<unknown> {
    const headers = dlocalAuthHeaders({
      xLogin: material.xLogin,
      xTransKey: material.xTransKey,
      secret: material.secretKey,
      nowMs: this.#clock.now(),
    });
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "GET",
        headers,
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("dlocal provider transport unreachable", {
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
    material: DlocalCredentialMaterial,
  ): Promise<unknown> {
    const bodyString = JSON.stringify(body);
    const headers = dlocalAuthHeaders({
      xLogin: material.xLogin,
      xTransKey: material.xTransKey,
      secret: material.secretKey,
      nowMs: this.#clock.now(),
      body: bodyString,
    });
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers,
        body: bodyString,
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("dlocal provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return this.#parseResponse(response, path, idempotencyKey);
  }
}

/** The dLocal credential material (X-Login + X-Trans-Key + secret key). */
export interface DlocalCredentialMaterial {
  readonly xLogin: string;
  readonly xTransKey: string;
  readonly secretKey: string;
}

/**
 * Extracts the dLocal credential material from a vault bundle shape. The
 * control plane hands the connector whatever the vault object holds: a
 * bundle record ({ x_login, x_trans_key, secret_key } / { X-Login, … } /
 * camelCase equivalents) — a plain string is NOT acceptable for dLocal
 * (three fields are required) and refuses the call (fail-closed, no
 * guessing).
 */
export function extractDlocalCredentialMaterial(material: unknown): DlocalCredentialMaterial {
  if (material !== null && typeof material === "object") {
    const record = material as Readonly<Record<string, unknown>>;
    const xLogin = readDlocalString(record, ["x_login", "xLogin", "X-Login"]);
    const xTransKey = readDlocalString(record, ["x_trans_key", "xTransKey", "X-Trans-Key"]);
    const secretKey = readDlocalString(record, ["secret_key", "secretKey", "secret"]);
    if (xLogin !== undefined && xTransKey !== undefined && secretKey !== undefined) {
      return Object.freeze({ xLogin, xTransKey, secretKey });
    }
  }
  throw new ValidationError(
    "the sealed credential bundle does not contain dLocal key material (expected { x_login, x_trans_key, secret_key })",
  );
}

function readDlocalString(
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
