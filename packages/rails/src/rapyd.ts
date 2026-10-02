/**
 * Rapyd production connector (P2-W2-002) — the REAL Rapyd adapter on the
 * v1.5 capability hierarchy and ProviderStateEnvelope, focused on
 * cross-border collection (pay-in) and payout with local-method
 * aggregation.
 *
 * Authority: spec/phase-2/work-items/P2-W2-002.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md and the TL
 * resident-watch reachability probes recorded 2026-10-02 in
 * spec/development-state/phase-2-state.json (Rapyd sandbox
 * `https://sandboxapi.rapyd.net` answers HTTP 401 on
 * /v1/payment_methods_by_country without credentials — endpoint REACHABLE,
 * authorization ABSENT). NO Rapyd credential exists in this deployment
 * (PROVIDER_RAPYD_CREDENTIAL_REF →
 * vault://payswap/providers/rapyd/sandbox-20261002, ABSENT). Same framework
 * and fail-closed laws as the Stripe/Flutterwave/Paystack production
 * connectors — NO Rapyd SDK, no ambient fetch in unit-testable paths, no
 * provider SDK types anywhere.
 *
 * Laws implemented here:
 * - INV-C06 (lossless): every provider object (payment with its `id` and
 *   verbatim status, payout, beneficiary, payment-method-by-country entry,
 *   requirement field list, wallet, webhook event) is carried VERBATIM in
 *   the envelope `state` with an ADDITIVE classification. Rapyd statuses
 *   are NEVER renamed, never dropped; UNKNOWN provider statuses stay
 *   `other`/verbatim non-terminal.
 * - PAY-IN vs PAYOUT ARE SEPARATE: Rapyd payment methods (collection,
 *   GET /v1/payment_methods_by_country + POST /v1/payments) and payout
 *   method types (POST /v1/payouts with payout_method_type + beneficiary)
 *   are two DISTINCT capability families with SEPARATE coverage surfaces;
 *   neither is ever inferred from the other.
 * - KYC/DOCUMENT REQUIREMENTS ARE CAPABILITY PRECONDITIONS: the fields
 *   demanded by GET /v1/payment_method_types/{type}/requirements (e.g.
 *   proof_of_id, document_ssn) are preserved VERBATIM as
 *   RapydPaymentMethodRequirement records attached as capability
 *   preconditions — a capability is NOT eligible until its requirement
 *   fields are satisfied.
 * - BENEFICIARY REQUIREMENTS ARE EXPLICIT: the provider-defined per-payout-
 *   method fields behind POST /v1/beneficiaries are modeled as explicit
 *   RapydBeneficiaryRequirement records, never guessed.
 * - THE COVERAGE LAW: NO ADVERTISED GLOBAL COVERAGE BECOMES ROUTABLE
 *   WITHOUT CONNECTED-INSTANCE EVIDENCE. Coverage records exist ONLY from
 *   a connected-account query (`observePayInCoverage` /
 *   `observePayoutCoverage` — both credential-gated and fail-closed),
 *   NEVER from Rapyd's marketing catalogue. An uncredentialed deployment
 *   has an EMPTY observed-coverage registry and every eligibility verdict
 *   is NO_CONNECTED_INSTANCE_EVIDENCE — never eligible.
 * - INV-C09: GET /v1/user/wallets/{wallet_id} produces
 *   ExternalFundsPositionObservation ONLY — provider-held wallet funds,
 *   never PaySwap custody. Balances arrive in MAJOR units; conversion to
 *   exact integer minor units is bigint arithmetic per currency exponent
 *   (INV-F01); an unknown exponent is honestly refused, never guessed.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (requires
 *   reconciliation by the Rapyd payment/payout id) — NEVER collapsed to
 *   FAILED.
 * - INV-NC04: no credential → availability UNKNOWN (INV-C01/C02), health
 *   DEGRADED/UNKNOWN with reasons, every effectful operation throws
 *   RailNotAuthorizedError BEFORE any provider call.
 * - Credential isolation (phase-2): key material is consumed through the
 *   P2-W1-001 control plane — `PROVIDER_RAPYD_CREDENTIAL_REF` bound to a
 *   vault:// reference, resolved through the CredentialBroker to a SEALED
 *   bundle (access_key + secret_key) opened only inside `withSealedBundle`
 *   with a ConnectorRuntimeKey. A direct env fallback (the W1-005 rails
 *   convention) exists for deployments that inject the resolved material
 *   under the same config key; material NEVER enters any envelope, log
 *   line or evidence record.
 * - Rapyd request signing is the documented salt/timestamp HMAC scheme
 *   (implemented + documented EXACTLY in rapydSignatureHeaders below):
 *   string_to_sign = lowercased(url_path) + salt + timestamp + access_key +
 *   secret_key + sorted-JSON body string; signature = HMAC-SHA256 hex over
 *   the string_to_sign with the SECRET KEY; headers salt, timestamp,
 *   access_key, signature, Content-Type: application/json.
 * - Webhooks: Rapyd webhook payloads carry { id, type, body, timestamp, … }
 *   and are verified with the SAME salt/timestamp HMAC construction over
 *   the body using the shared webhook secret (implemented verbatim in
 *   verifyRapydWebhookDelivery — constant-time compare, (provider,
 *   eventId) dedupe). The exact webhook signing detail must still be
 *   confirmed against a LIVE delivery once credentials exist (recorded in
 *   BLOCKED-RAILS.md §7 — never guessed silently).
 * - Idempotency honesty: Rapyd exposes NO global idempotency header — the
 *   connector derives a deterministic client reference (payment metadata
 *   `payswap_idempotency_key`) from the protocol key (INV-F05) so retries
 *   carry the SAME reference; duplicateBehavior is PROVIDER_DEFINED and
 *   the caller's protocol idempotency registrar remains the
 *   double-execution guard (reconciliation by the Rapyd payment id).
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
import { createHmac, randomBytes } from "node:crypto";
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
// Identity (pinned — the API generation is part of the provider contract)
// ---------------------------------------------------------------------------

export const RAPYD_PROVIDER_NAME = "rapyd" as const;
/** The pinned Rapyd API root (/v1) — the connector speaks this surface only. */
export const RAPYD_API_VERSION = "v1" as const;
export const RAPYD_RAIL_ADAPTER_ID = "rail.rapyd" as const;
export const RAPYD_RAIL_IMPLEMENTATION_ID = "impl.rails.rapyd.v1" as const;
export const RAPYD_CONNECTOR_ID = "connector.rails.rapyd" as const;
export const RAPYD_DEFAULT_API_BASE_SANDBOX = "https://sandboxapi.rapyd.net" as const;
export const RAPYD_DEFAULT_API_BASE_LIVE = "https://api.rapyd.net" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("rapyd")` —
 * `PROVIDER_RAPYD_CREDENTIAL_REF`, bound (per the deployment template) to
 * `vault://payswap/providers/rapyd/sandbox-20261002`. ABSENT in this
 * deployment: no Rapyd credential exists; the rail fails closed.
 */
export const RAPYD_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  RAPYD_PROVIDER_NAME,
);

/**
 * The RECORDED reachability datum (2026-10-02 TL resident-watch probe,
 * recorded in spec/development-state/phase-2-state.json): the Rapyd
 * sandbox host answers HTTP 401 on /v1/payment_methods_by_country without
 * credentials — endpoint REACHABLE, authorization ABSENT. Honest
 * consequences: availability stays UNKNOWN (INV-C01/C02 — the source is
 * reachable but unauthorized, which is still UNKNOWN, never
 * AVAILABLE/UNAVAILABLE), health is DEGRADED with this datum as the
 * reason, and no advertised coverage is routable (INV-NC04 + the coverage
 * law below).
 */
export const RAPYD_SANDBOX_REACHABILITY_DATUM_20261002: {
  readonly endpoint: string;
  readonly path: string;
  readonly httpStatus: 401;
  readonly verdict: "REACHABLE_AUTH_REQUIRED";
  readonly probedAt: string;
} = Object.freeze({
  endpoint: RAPYD_DEFAULT_API_BASE_SANDBOX,
  path: "/v1/payment_methods_by_country",
  httpStatus: 401,
  verdict: "REACHABLE_AUTH_REQUIRED",
  probedAt: "2026-10-02T00:00:00Z",
});

// ---------------------------------------------------------------------------
// Capability definitions (consumed W2-003 vocabulary — never redefined)
// ---------------------------------------------------------------------------

export const RAPYD_PAYIN_PAYMENT_CAPABILITY_ID = "cap.rails.rapyd.payin.payment" as const;
export const RAPYD_PAYOUT_CAPABILITY_ID = "cap.rails.rapyd.payout.transfer" as const;
export const RAPYD_PAYIN_COVERAGE_CAPABILITY_ID =
  "cap.rails.rapyd.payin.coverage_observation" as const;
export const RAPYD_PAYOUT_COVERAGE_CAPABILITY_ID =
  "cap.rails.rapyd.payout.coverage_observation" as const;
export const RAPYD_WALLET_OBSERVATION_CAPABILITY_ID =
  "cap.rails.rapyd.wallet_observation" as const;

/**
 * The provider-state vocabulary this connector maps (INV-C06): every Rapyd
 * payment status (and payout status — Rapyd reuses the same status codes
 * on payout objects) with its additive classification. Exported as data so
 * certification/conformance surfaces can diff the mapping without reading
 * the implementation.
 *
 * | Rapyd status | family           | isTerminal | requiresCustomerAction |
 * |--------------|------------------|------------|------------------------|
 * | ACT (active) | async_processing | false      | false (next_action may promote it) |
 * | CLO (closed) | other            | true       | false (completed)      |
 * | ERR (error)  | other            | true       | false (definitive)     |
 * | EXP (expired)| other            | true       | false (definitive)     |
 * | (unknown)    | other            | false      | false (verbatim step)  |
 */
export const RAPYD_PAYMENT_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "ACT", family: "async_processing", lifecycleStep: "ACT", isTerminal: false, requiresCustomerAction: false },
  { providerState: "CLO", family: "other", lifecycleStep: "CLO", isTerminal: true, requiresCustomerAction: false },
  { providerState: "ERR", family: "other", lifecycleStep: "ERR", isTerminal: true, requiresCustomerAction: false },
  { providerState: "EXP", family: "other", lifecycleStep: "EXP", isTerminal: true, requiresCustomerAction: false },
]);

/** The same status codes on the PAYOUT surface map into the payout family. */
export const RAPYD_PAYOUT_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "ACT", family: "payout", lifecycleStep: "ACT", isTerminal: false, requiresCustomerAction: false },
  { providerState: "CLO", family: "payout", lifecycleStep: "CLO", isTerminal: true, requiresCustomerAction: false },
  { providerState: "ERR", family: "payout", lifecycleStep: "ERR", isTerminal: true, requiresCustomerAction: false },
  { providerState: "EXP", family: "payout", lifecycleStep: "EXP", isTerminal: true, requiresCustomerAction: false },
]);

function rapydCapabilityDefinition(input: {
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
      "credential reference provisioned through the control plane (PROVIDER_RAPYD_CREDENTIAL_REF)",
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
      // Rapyd exposes NO global idempotency header: the deterministic
      // client reference (payment metadata) + the caller's protocol
      // idempotency registrar are the guards; duplicates surface as
      // provider-defined errors, never silent success.
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
        { action: "create_payment", description: "POST /v1/payments — collection payment toward a payment method type" },
        { action: "read_payment", description: "GET /v1/payments/{id} — the reconciliation path" },
        { action: "create_payout", description: "POST /v1/payouts — payout with payout_method_type + beneficiary" },
        { action: "read_payout", description: "GET /v1/payouts/{id} — the payout reconciliation path" },
        { action: "create_beneficiary", description: "POST /v1/beneficiaries — register a payout beneficiary with the provider-defined fields" },
        { action: "list_payment_methods_by_country", description: "GET /v1/payment_methods_by_country — connected-account pay-in coverage observation" },
        { action: "payment_method_requirements", description: "GET /v1/payment_method_types/{type}/requirements — KYC/document precondition fields" },
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
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "Rapyd settlement schedule" },
    constraints: [
      {
        kind: "JURISDICTION",
        description:
          "country/method coverage follows ONLY the connected-account observation (payment methods by country / payout method types) — no advertised global catalogue coverage is routable without connected-instance evidence",
      },
    ],
  });
}

/** The canonical capability definitions consumed by the Rapyd connector. */
export function rapydCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return Object.freeze([
    rapydCapabilityDefinition({
      capabilityId: RAPYD_PAYIN_PAYMENT_CAPABILITY_ID,
      summary: "Cross-border collection payment lifecycle on the real Rapyd v1 API (pay-in family)",
      operation: "rails.rapyd.payin.payment",
      description:
        "POST /v1/payments { amount, currency, payment_method, complete_payment_url, error_payment_url } then GET /v1/payments/{id}: the Rapyd payment id is preserved as the external id, statuses stay VERBATIM (ACT/CLO/ERR/EXP), payment_method_data.next_action flows are customer-action-required first-class, and a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      preconditions: [
        "pay-in country/method coverage OBSERVED from the connected account (GET /v1/payment_methods_by_country) — never assumed from the provider catalogue",
        "provider KYC/document requirement fields for the payment method type (GET /v1/payment_method_types/{type}/requirements) SATISFIED — they are capability preconditions, not suggestions",
      ],
      providerStates: RAPYD_PAYMENT_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "payment", idFormat: "payment-id:[A-Za-z0-9_-]+" },
        { objectType: "payment_method", idFormat: "payment-method-id:[A-Za-z0-9_-]+" },
      ],
      sideEffects: [
        { effect: "moves payer value when the payment closes (CLO)", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      requiredCustomerActions: [
        {
          lifecycleStep: "ACT",
          kind: "PROVIDER_CHALLENGE_REDIRECT",
          message: "Complete the payment at the Rapyd next_action redirect before the payment expires (ACT → EXP)",
        },
      ],
    }),
    rapydCapabilityDefinition({
      capabilityId: RAPYD_PAYOUT_CAPABILITY_ID,
      summary: "Payout lifecycle with explicit beneficiary requirements (payout family — separate from pay-in)",
      operation: "rails.rapyd.payout.transfer",
      description:
        "POST /v1/payouts { payout_method_type, amount, currency, beneficiary, … } then GET /v1/payouts/{id}: payout statuses stay VERBATIM (ACT/CLO/ERR/EXP on the payout surface), the beneficiary object and its provider-defined required fields are modeled explicitly (POST /v1/beneficiaries), and a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      preconditions: [
        "payout method-type coverage OBSERVED from the connected account — the payout coverage surface is SEPARATE from pay-in; a pay-in observation never authorizes a payout",
        "beneficiary requirements for the payout method type EXPLICIT and SATISFIED (the provider-defined fields behind POST /v1/beneficiaries)",
      ],
      providerStates: RAPYD_PAYOUT_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "payout", idFormat: "payout-id:[A-Za-z0-9_-]+" },
        { objectType: "beneficiary", idFormat: "beneficiary-id:[A-Za-z0-9_-]+" },
      ],
      sideEffects: [
        { effect: "moves value to the beneficiary when the payout closes (CLO)", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    rapydCapabilityDefinition({
      capabilityId: RAPYD_PAYIN_COVERAGE_CAPABILITY_ID,
      summary: "Pay-in country/method coverage OBSERVED from the connected account (pay-in family)",
      operation: "rails.rapyd.payin.coverage.observe",
      description:
        "GET /v1/payment_methods_by_country?country=XX + GET /v1/payment_method_types/{type}/requirements: each payment-method entry is preserved VERBATIM as an observed coverage record; the KYC/document requirement fields (proof_of_id, document_ssn, …) are preserved VERBATIM as capability PRECONDITIONS — a capability is not eligible until they are satisfied",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      preconditions: [
        "coverage records exist ONLY from a connected-account query — Rapyd's advertised catalogue is marketing, never routable evidence",
      ],
      providerStates: [
        { providerState: "observed", canonicalState: "other:observed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [
        { objectType: "payment_methods_by_country", idFormat: "pm-by-country:[A-Z]{2}" },
        { objectType: "payment_method_requirements", idFormat: "pm-requirements:[a-z0-9_]+" },
      ],
      sideEffects: [],
    }),
    rapydCapabilityDefinition({
      capabilityId: RAPYD_PAYOUT_COVERAGE_CAPABILITY_ID,
      summary: "Payout method-type coverage OBSERVED from the connected account (payout family — separate surface)",
      operation: "rails.rapyd.payout.coverage.observe",
      description:
        "Observe the payout method types available on the connected account per country, with the provider-defined beneficiary requirement fields extracted as EXPLICIT records; the payout coverage surface is separate from pay-in and is never inferred from it",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      preconditions: [
        "coverage records exist ONLY from a connected-account query — never from the provider catalogue",
      ],
      providerStates: [
        { providerState: "observed", canonicalState: "payout:observed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "payout_method_types", idFormat: "payout-method-types:[A-Z]{2}" }],
      sideEffects: [],
    }),
    rapydCapabilityDefinition({
      capabilityId: RAPYD_WALLET_OBSERVATION_CAPABILITY_ID,
      summary: "Rapyd wallet OBSERVATION (GET /v1/user/wallets/{wallet_id} — never custody)",
      operation: "rails.rapyd.wallet.observe",
      description:
        "Observe one Rapyd wallet (balance in exact minor units via bigint major→minor conversion) as an ExternalFundsPositionObservation ONLY: provider-held external funds, never PaySwap custody (INV-C09)",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      preconditions: [],
      providerStates: [
        { providerState: "observed", canonicalState: "other:observed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "wallet", idFormat: "wallet-id:[A-Za-z0-9_-]+" }],
      sideEffects: [],
    }),
  ]);
}

/** The connector capability pack backing the Rapyd rail (payments family). */
export function rapydRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.rapyd",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: rapydCapabilityDefinitions().map((definition) => ({
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
    })),
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "payments:read"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.rapyd.provider_state", version: "1.0.0" }],
    objectMappings: [
      { externalObjectType: "payment", canonicalObjectRef: "payswap:payment", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payout", canonicalObjectRef: "payswap:payout", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "beneficiary", canonicalObjectRef: "payswap:beneficiary", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payment_methods_by_country", canonicalObjectRef: "payswap:eligibility_evidence", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payout_method_types", canonicalObjectRef: "payswap:eligibility_evidence", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payment_method_requirements", canonicalObjectRef: "payswap:capability_precondition", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "wallet", canonicalObjectRef: "payswap:external_funds_observation", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 50, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-rapyd-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// The coverage law: observed-only records, precondition-checked eligibility
// ---------------------------------------------------------------------------

/** Which coverage surface a record belongs to (pay-in and payout are SEPARATE). */
export type RapydCoverageSurface = "PAY_IN" | "PAYOUT";

/**
 * One KYC/document requirement field demanded by Rapyd before a payment
 * method type may be used — preserved VERBATIM from
 * GET /v1/payment_method_types/{type}/requirements (e.g. proof_of_id,
 * document_ssn). These are CAPABILITY PRECONDITIONS: the eligibility
 * function refuses a capability whose required fields are unsatisfied.
 */
export interface RapydPaymentMethodRequirement {
  readonly fieldName: string;
  readonly required: boolean;
  /** The raw provider requirement object rides VERBATIM (INV-C06). */
  readonly [key: string]: unknown;
}

/**
 * One provider-defined beneficiary field for a payout method type — the
 * required fields behind POST /v1/beneficiaries {payout_method_type,
 * fields…}. Explicit records, never guessed.
 */
export interface RapydBeneficiaryRequirement {
  readonly payoutMethodType: string;
  readonly fieldName: string;
  readonly required: boolean;
  /** The raw provider field object rides VERBATIM (INV-C06). */
  readonly [key: string]: unknown;
}

/**
 * One observed coverage record — the ONLY unit of coverage evidence this
 * connector recognizes. `source` is pinned to CONNECTED_ACCOUNT_QUERY: a
 * record can be constructed ONLY from a real connected-account observation
 * (RapydConnector.observePayInCoverage / observePayoutCoverage — both
 * credential-gated). There is deliberately NO constructor path from the
 * provider's advertised catalogue.
 */
export interface RapydCoverageRecord {
  readonly surface: RapydCoverageSurface;
  readonly country: string;
  /** Verbatim Rapyd payment-method type (e.g. "ug_mobilemoney_ussd") or payout method type. */
  readonly paymentMethodType: string;
  readonly observedAt: string;
  readonly source: "CONNECTED_ACCOUNT_QUERY";
  /** KYC/document precondition fields (PAY_IN surface; payout records carry beneficiary fields instead). */
  readonly requirements: readonly RapydPaymentMethodRequirement[];
  /** The raw provider method object, carried VERBATIM. */
  readonly raw: unknown;
}

/**
 * Normalizes a requirements response from
 * GET /v1/payment_method_types/{type}/requirements into precondition
 * records. The provider's field naming has moved across API revisions
 * (arrays of names; { required_fields: […] }; { fields: […] } arrays of
 * objects) — every observed shape is normalized ADDITIVELY while the raw
 * response rides the coverage record verbatim. An unrecognized shape
 * yields an EMPTY list (honestly "no requirements disclosed by this
 * response shape" — the raw is preserved upstream for conformance diffing).
 */
export function rapydPaymentMethodRequirements(
  requirementsResponse: unknown,
): readonly RapydPaymentMethodRequirement[] {
  const out: RapydPaymentMethodRequirement[] = [];
  const pushField = (candidate: unknown, required: boolean): void => {
    if (typeof candidate === "string" && candidate.length > 0) {
      out.push(Object.freeze({ fieldName: candidate, required }));
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    const record = candidate as Readonly<Record<string, unknown>>;
    const name =
      typeof record.fieldName === "string"
        ? record.fieldName
        : typeof record.field_name === "string"
          ? record.field_name
          : typeof record.name === "string"
            ? record.name
            : typeof record.key === "string"
              ? record.key
              : undefined;
    if (name === undefined || name.length === 0) {
      return;
    }
    const isRequired =
      typeof record.required === "boolean" ? record.required : required;
    out.push(
      Object.freeze({
        ...(record as Record<string, unknown>),
        fieldName: name,
        required: isRequired,
      }),
    );
  };
  const consumeArray = (value: unknown, required: boolean): void => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const entry of value) {
      pushField(entry, required);
    }
  };
  if (Array.isArray(requirementsResponse)) {
    consumeArray(requirementsResponse, true);
    return Object.freeze(out);
  }
  if (requirementsResponse !== null && typeof requirementsResponse === "object") {
    const record = requirementsResponse as Readonly<Record<string, unknown>>;
    consumeArray(record.required_fields, true);
    consumeArray(record.requiredFields, true);
    consumeArray(record.fields, true);
  }
  return Object.freeze(out);
}

/**
 * Extracts EXPLICIT beneficiary requirements from an observed payout
 * method-type object: the provider-defined fields the
 * POST /v1/beneficiaries call must carry. Recognized shapes
 * (fields/required_fields arrays, or an array of field objects) are
 * normalized additively; the raw method-type object rides the coverage
 * record verbatim. NOT_DISCLOSED is an honest verdict, never a guessed
 * empty requirement set being treated as satisfied-implicitly — the
 * eligibility function treats disclosed-but-unsatisfied and undisclosed
 * differently (see rapydPayoutEligibility).
 */
export function rapydBeneficiaryRequirements(
  payoutMethodType: string,
  payoutMethodTypeObject: unknown,
): readonly RapydBeneficiaryRequirement[] {
  const out: RapydBeneficiaryRequirement[] = [];
  const record =
    payoutMethodTypeObject !== null && typeof payoutMethodTypeObject === "object"
      ? (payoutMethodTypeObject as Readonly<Record<string, unknown>>)
      : undefined;
  for (const key of ["fields", "required_fields", "requiredFields", "beneficiary_fields"]) {
    const value = record?.[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string" && entry.length > 0) {
        out.push(Object.freeze({ payoutMethodType, fieldName: entry, required: true }));
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
          payoutMethodType,
          fieldName: name,
          required: typeof field.required === "boolean" ? field.required : true,
        }),
      );
    }
  }
  return Object.freeze(out);
}

/** The eligibility verdict for one (surface, country, method type). */
export interface RapydCoverageEligibility {
  readonly surface: RapydCoverageSurface;
  readonly country: string;
  readonly paymentMethodType: string;
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
 * connector (both observation paths are credential-gated and fail-closed).
 * Rapyd's marketing catalogue of "100+ countries, 900+ methods" is not an
 * input to this function and CANNOT be one: there is no parameter for it.
 *
 * - No observed record for the (surface, country, type) →
 *   NO_CONNECTED_INSTANCE_EVIDENCE, eligible FALSE — the honest state of
 *   every method in this deployment (credential ABSENT → empty registry).
 * - PAY_IN with unsatisfied KYC/document requirement fields →
 *   PRECONDITIONS_UNSATISFIED, eligible FALSE (the requirement fields are
 *   capability preconditions, per the P2-W2-002 acceptance).
 * - PAYOUT with unsatisfied beneficiary fields → PRECONDITIONS_UNSATISFIED.
 * - An observed record with every required field satisfied → eligible TRUE
 *   with basis OBSERVED_AND_PRECONDITIONS_SATISFIED.
 */
export function rapydCoverageEligibility(input: {
  readonly surface: RapydCoverageSurface;
  readonly country: string;
  readonly paymentMethodType: string;
  readonly observedCoverage: readonly RapydCoverageRecord[];
  readonly satisfiedRequirementFields: readonly string[];
}): RapydCoverageEligibility {
  const country = input.country.toUpperCase();
  const type = input.paymentMethodType;
  const satisfied = new Set(input.satisfiedRequirementFields);
  const record = input.observedCoverage.find(
    (candidate) =>
      candidate.surface === input.surface &&
      candidate.country.toUpperCase() === country &&
      candidate.paymentMethodType === type,
  );
  if (record === undefined) {
    return Object.freeze({
      surface: input.surface,
      country,
      paymentMethodType: type,
      eligible: false,
      basis: "NO_CONNECTED_INSTANCE_EVIDENCE",
      unsatisfied: [],
      reason:
        `no connected-instance evidence for ${input.surface} ${country}/${type} — coverage eligibility is computed ONLY from connected-account observations (the provider's advertised catalogue is never routable evidence; INV-NC04 + the P2-W2-002 coverage law)`,
    });
  }
  if (input.surface === "PAYOUT") {
    const beneficiaryFields = rapydBeneficiaryRequirements(type, record.raw);
    const unsatisfied = beneficiaryFields
      .filter((field) => field.required && !satisfied.has(field.fieldName))
      .map((field) => field.fieldName);
    if (unsatisfied.length > 0) {
      return Object.freeze({
        surface: input.surface,
        country,
        paymentMethodType: type,
        eligible: false,
        basis: "PRECONDITIONS_UNSATISFIED",
        unsatisfied,
        reason: `observed on the connected account, but the provider-defined beneficiary requirements are not satisfied: ${unsatisfied.join(", ")}`,
      });
    }
    return Object.freeze({
      surface: input.surface,
      country,
      paymentMethodType: type,
      eligible: true,
      basis: "OBSERVED_AND_PRECONDITIONS_SATISFIED",
      unsatisfied: [],
      reason:
        `observed from the connected account on ${record.observedAt}${beneficiaryFields.length > 0 ? ` with all ${String(beneficiaryFields.length)} beneficiary requirement fields satisfied` : " (the observed payout method type disclosed no beneficiary fields — the POST /v1/beneficiaries confirmation path governs)"}`,
    });
  }
  const unsatisfied = record.requirements
    .filter((field) => field.required && !satisfied.has(field.fieldName))
    .map((field) => field.fieldName);
  if (unsatisfied.length > 0) {
    return Object.freeze({
      surface: input.surface,
      country,
      paymentMethodType: type,
      eligible: false,
      basis: "PRECONDITIONS_UNSATISFIED",
      unsatisfied,
      reason: `observed on the connected account, but the provider KYC/document preconditions are not satisfied: ${unsatisfied.join(", ")}`,
    });
  }
  return Object.freeze({
    surface: input.surface,
    country,
    paymentMethodType: type,
    eligible: true,
    basis: "OBSERVED_AND_PRECONDITIONS_SATISFIED",
    unsatisfied: [],
    reason:
      `observed from the connected account on ${record.observedAt}${record.requirements.length > 0 ? ` with all ${String(record.requirements.length)} KYC/document preconditions satisfied` : " (the observed payment method type disclosed no requirement fields)"}`,
  });
}

// ---------------------------------------------------------------------------
// Request signing — the documented salt/timestamp HMAC scheme
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON with RECURSIVELY SORTED object keys, no whitespace —
 * the documented Rapyd body canonicalization. Key order in the request
 * body the caller serialized does NOT need to match: Rapyd's signature
 * check re-sorts server-side, and this function produces the exact string
 * that must be signed.
 */
export function rapydSortedJsonString(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => rapydSortedJsonString(entry)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${rapydSortedJsonString(record[key])}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * The EXACT Rapyd string_to_sign (documented scheme, implemented verbatim):
 *
 * ```text
 * string_to_sign = url_path + salt + timestamp + access_key + secret_key + body_string
 * ```
 *
 * - `url_path` is the request path LOWERCASED (e.g. "/v1/payments" —
 *   including the "/v1" prefix, excluding host and query string);
 * - `salt` is a random hex string; `timestamp` is unix SECONDS;
 * - `body_string` is the sorted-JSON canonicalization (rapydSortedJsonString)
 *   of the request body, or "" for GET requests.
 */
export function rapydStringToSign(input: {
  readonly urlPath: string;
  readonly salt: string;
  readonly timestamp: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bodyString: string;
}): string {
  return `${input.urlPath.toLowerCase()}${input.salt}${input.timestamp}${input.accessKey}${input.secretKey}${input.bodyString}`;
}

/**
 * Builds the Rapyd request headers carrying the documented signature:
 * `signature` = hex(HMAC-SHA256(secret_key, string_to_sign)) with headers
 * salt, timestamp, access_key, signature and Content-Type: application/json.
 * The secret key never appears in a header — only inside the HMAC.
 */
export function rapydSignatureHeaders(input: {
  readonly urlPath: string;
  readonly salt: string;
  readonly timestamp: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly body?: unknown;
}): Readonly<Record<string, string>> {
  const bodyString =
    input.body === undefined ? "" : rapydSortedJsonString(input.body);
  const stringToSign = rapydStringToSign({
    urlPath: input.urlPath,
    salt: input.salt,
    timestamp: input.timestamp,
    accessKey: input.accessKey,
    secretKey: input.secretKey,
    bodyString,
  });
  const signature = createHmac("sha256", input.secretKey).update(stringToSign).digest("hex");
  return Object.freeze({
    salt: input.salt,
    timestamp: input.timestamp,
    access_key: input.accessKey,
    signature,
    "Content-Type": "application/json",
  });
}

// ---------------------------------------------------------------------------
// Provider object shapes (opaque passthrough — never domain primitives)
// ---------------------------------------------------------------------------

/** The raw Rapyd payment object (POST /v1/payments, GET /v1/payments/{id}). */
export interface RapydPaymentProviderObject {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: number | string;
  readonly currency?: string;
  readonly payment_method?: string;
  readonly payment_method_data?: {
    readonly next_action?: { readonly redirect_url?: string; readonly [key: string]: unknown };
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

/** The raw Rapyd payout object (POST /v1/payouts, GET /v1/payouts/{id}). */
export interface RapydPayoutProviderObject {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: number | string;
  readonly currency?: string;
  readonly payout_method_type?: string;
  readonly beneficiary?: { readonly id?: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

/** The raw Rapyd beneficiary object (POST /v1/beneficiaries). */
export interface RapydBeneficiaryProviderObject {
  readonly id?: string;
  readonly payout_method_type?: string;
  readonly status?: string;
  readonly [key: string]: unknown;
}

/** One raw payment-methods-by-country entry (opaque passthrough). */
export interface RapydPaymentMethodByCountryProviderObject {
  readonly type?: string;
  readonly name?: string;
  readonly category?: string;
  readonly [key: string]: unknown;
}

/** The raw Rapyd wallet object (GET /v1/user/wallets/{wallet_id}). */
export interface RapydWalletProviderObject {
  readonly id?: string;
  readonly balance?: number | string;
  readonly currency?: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object)
// ---------------------------------------------------------------------------

/** Payment revision: id + status + next-action surface. */
export function rapydPaymentRevision(payment: RapydPaymentProviderObject): string {
  const nextAction = payment.payment_method_data?.next_action;
  return `${payment.id ?? "no_id"}:${payment.status ?? "unknown"}:${nextAction !== undefined ? "next_action" : "no_next_action"}`;
}

/** Payout revision: id + status. */
export function rapydPayoutRevision(payout: RapydPayoutProviderObject): string {
  return `${payout.id ?? "no_id"}:${payout.status ?? "unknown"}`;
}

/** Beneficiary revision: id + status. */
export function rapydBeneficiaryRevision(beneficiary: RapydBeneficiaryProviderObject): string {
  return `${beneficiary.id ?? "no_id"}:${beneficiary.status ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface RapydEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK";
  readonly fetchId?: string;
}

function rapydEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: RapydEnvelopeContext,
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
    providerName: RAPYD_PROVIDER_NAME,
    providerVersion: RAPYD_API_VERSION,
    objectType,
    externalId,
    revision,
    state,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
}

/** Envelope shareable-field surface for Rapyd provider objects. */
const RAPYD_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "status",
  "id",
  "amount",
  "currency",
  "payment_method",
  "payout_method_type",
]);

/**
 * Deterministic, additive classification of a Rapyd payment into a lossless
 * ProviderStateEnvelope (INV-C06). The RAW payment is carried VERBATIM as
 * `state`; the external id is the Rapyd payment `id`. Statuses map per
 * RAPYD_PAYMENT_STATUS_MAPPING:
 *
 * - `ACT` (active) → async_processing; when
 *   `payment_method_data.next_action` discloses a redirect URL the payment
 *   is CUSTOMER-ACTION-REQUIRED first-class (actionRequired with the
 *   provider's deepLink) — the payer must complete the flow before ACT
 *   can become CLO;
 * - `CLO` (closed/completed) → terminal;
 * - `ERR` (error) → terminal definitive failure (ambiguity NONE — the
 *   provider explicitly errored; transport failures are a DIFFERENT thing
 *   and stay OUTCOME_UNKNOWN);
 * - `EXP` (expired) → terminal definitive;
 * - any UNKNOWN status → `other`/verbatim, non-terminal — never dropped,
 *   never guessed, never collapsed.
 */
export function rapydPaymentEnvelope(
  payment: RapydPaymentProviderObject,
  context: RapydEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = payment.id ?? "no_id";
  const base = rapydEnvelopeBase("payment", externalId, rapydPaymentRevision(payment), payment, context);
  const nextAction = payment.payment_method_data?.next_action;
  const redirectUrl =
    nextAction !== undefined && typeof nextAction.redirect_url === "string"
      ? nextAction.redirect_url
      : undefined;
  switch (payment.status) {
    case "ACT":
      if (redirectUrl !== undefined && redirectUrl.length > 0) {
        return railEnvelope({
          ...base,
          family: "customer_action_required",
          lifecycleStep: "ACT",
          isTerminal: false,
          requiresCustomerAction: true,
          actionRequired: {
            kind: "PROVIDER_CHALLENGE_REDIRECT",
            message: "Complete the payment at the Rapyd next_action redirect before it expires",
            deepLink: redirectUrl,
          },
          shareableFields: RAPYD_SHAREABLE_FIELDS,
        });
      }
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "ACT",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: RAPYD_SHAREABLE_FIELDS,
      });
    case "CLO":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "CLO",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: RAPYD_SHAREABLE_FIELDS,
      });
    case "ERR":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "ERR",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payment_ERR",
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: RAPYD_SHAREABLE_FIELDS,
      });
    case "EXP":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "EXP",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payment_expired",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: RAPYD_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: payment.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: RAPYD_SHAREABLE_FIELDS,
      });
  }
}

/**
 * Deterministic, additive classification of a Rapyd payout into a lossless
 * envelope. Payout statuses are the SAME codes (ACT/CLO/ERR/EXP) mapped
 * into the PAYOUT family — a completed payout (CLO) is settled value at
 * the provider (settled-external); ERR is a terminal definitive failure
 * verdict FROM THE PROVIDER (transport failures remain OUTCOME_UNKNOWN —
 * the two are never conflated); unknown statuses stay verbatim.
 */
export function rapydPayoutEnvelope(
  payout: RapydPayoutProviderObject,
  context: RapydEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = payout.id ?? "no_id";
  const base = rapydEnvelopeBase("payout", externalId, rapydPayoutRevision(payout), payout, context);
  switch (payout.status) {
    case "ACT":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "ACT",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: RAPYD_SHAREABLE_FIELDS,
      });
    case "CLO":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "CLO",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: RAPYD_SHAREABLE_FIELDS,
      });
    case "ERR":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "ERR",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payout_ERR",
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: RAPYD_SHAREABLE_FIELDS,
      });
    case "EXP":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "EXP",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "payout_expired",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: RAPYD_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: payout.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: RAPYD_SHAREABLE_FIELDS,
      });
  }
}

/**
 * A Rapyd beneficiary → envelope. The provider-defined fields ride the raw
 * object VERBATIM; `ACT`-family statuses are observed asynchronously.
 */
export function rapydBeneficiaryEnvelope(
  beneficiary: RapydBeneficiaryProviderObject,
  context: RapydEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = beneficiary.id ?? "no_id";
  return railEnvelope({
    ...rapydEnvelopeBase(
      "beneficiary",
      externalId,
      rapydBeneficiaryRevision(beneficiary),
      beneficiary,
      context,
    ),
    family: "other",
    lifecycleStep: beneficiary.status ?? "unknown",
    isTerminal: false,
    requiresCustomerAction: false,
    shareableFields: RAPYD_SHAREABLE_FIELDS,
  });
}

/**
 * A payment-methods-by-country answer → one lossless coverage-evidence
 * envelope. Every method entry rides VERBATIM; the family stays `other`
 * (an observation, not a payment lifecycle). The external id names the
 * (surface, country) pair this observation covers.
 */
export function rapydCoverageEnvelope(
  surface: RapydCoverageSurface,
  country: string,
  methods: readonly unknown[],
  context: RapydEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: RAPYD_PROVIDER_NAME,
    providerVersion: RAPYD_API_VERSION,
    objectType: surface === "PAY_IN" ? "payment_methods_by_country" : "payout_method_types",
    externalId: `${surface === "PAY_IN" ? "pm-by-country" : "payout-method-types"}:${country.toUpperCase()}`,
    revision: `${surface}:${country.toUpperCase()}:${methods.length}`,
    state: Object.freeze({ surface, country: country.toUpperCase(), data: methods }),
    family: surface === "PAY_IN" ? "other" : "payout",
    lifecycleStep: "observed",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: RAPYD_SHAREABLE_FIELDS,
  });
}

/**
 * A payment-method requirements answer → one lossless
 * capability-precondition envelope: the raw requirements response rides
 * VERBATIM in `state.data`, the normalized RapydPaymentMethodRequirement
 * records ride `state.preconditions` (additive, INV-C06).
 */
export function rapydRequirementsEnvelope(
  paymentMethodType: string,
  requirementsResponse: unknown,
  context: RapydEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: RAPYD_PROVIDER_NAME,
    providerVersion: RAPYD_API_VERSION,
    objectType: "payment_method_requirements",
    externalId: `pm-requirements:${paymentMethodType}`,
    revision: `pm-requirements:${paymentMethodType}:${rapydPaymentMethodRequirements(requirementsResponse).length}`,
    state: Object.freeze({
      paymentMethodType,
      data: requirementsResponse,
      preconditions: rapydPaymentMethodRequirements(requirementsResponse),
    }),
    family: "other",
    lifecycleStep: "observed",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: RAPYD_SHAREABLE_FIELDS,
  });
}

/**
 * A Rapyd wallet → one lossless envelope (the observation's raw object,
 * carried verbatim; family `other` — an observation, not a lifecycle).
 */
export function rapydWalletEnvelope(
  wallet: RapydWalletProviderObject,
  context: RapydEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: RAPYD_PROVIDER_NAME,
    providerVersion: RAPYD_API_VERSION,
    objectType: "wallet",
    externalId: wallet.id ?? "no_id",
    revision: `wallet:${wallet.id ?? "no_id"}:${String(wallet.balance ?? "no_balance")}`,
    state: wallet,
    family: "other",
    lifecycleStep: "observed",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: RAPYD_SHAREABLE_FIELDS,
  });
}

/**
 * Maps a Rapyd webhook payload ({ id, type, body, timestamp, … }) to the
 * lossless envelope for its inner object. `body.payment` maps through the
 * payment mapper; `body.payout` through the payout mapper; everything else
 * produces an `event`-typed envelope carrying the WHOLE payload verbatim —
 * nothing is dropped (INV-C06).
 */
export function rapydWebhookEventEnvelope(
  payload: {
    readonly id?: string;
    readonly type?: string;
    readonly body?: unknown;
    readonly [key: string]: unknown;
  },
  context: RapydEnvelopeContext,
): ProviderStateEnvelope {
  const webhookContext: RapydEnvelopeContext = {
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
  const body = payload.body;
  if (body !== null && typeof body === "object") {
    const record = body as { readonly payment?: unknown; readonly payout?: unknown };
    if (record.payment !== null && typeof record.payment === "object") {
      return rapydPaymentEnvelope(record.payment as RapydPaymentProviderObject, webhookContext);
    }
    if (record.payout !== null && typeof record.payout === "object") {
      return rapydPayoutEnvelope(record.payout as RapydPayoutProviderObject, webhookContext);
    }
  }
  return railEnvelope({
    providerName: RAPYD_PROVIDER_NAME,
    providerVersion: RAPYD_API_VERSION,
    objectType: "event",
    externalId: `event:${payload.id ?? "no_id"}`,
    revision: `${payload.type ?? "untyped"}:${payload.id ?? "no_id"}`,
    state: payload,
    family: "other",
    lifecycleStep: payload.type ?? "untyped",
    isTerminal: false,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    shareableFields: RAPYD_SHAREABLE_FIELDS,
  });
}

// ---------------------------------------------------------------------------
// External funds observations (INV-C09 — observations, NEVER custody)
// ---------------------------------------------------------------------------

/**
 * The minor-unit exponents for currencies a Rapyd wallet may hold (ISO
 * 4217). A currency outside this table has an UNKNOWN exponent — the
 * wallet is honestly reported as unconverted, never guessed.
 */
export const RAPYD_WALLET_MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  USD: 2, EUR: 2, GBP: 2, NGN: 2, KES: 2, GHS: 2, ZAR: 2, INR: 2, BRL: 2, MXN: 2,
  AED: 2, SAR: 2, ILS: 2, TRY: 2, EGP: 2, MAD: 2, XOF: 0, XAF: 0, UGX: 0, TZS: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, SGD: 2, HKD: 2, CAD: 2, AUD: 2, CHF: 2, SEK: 2,
  NOK: 2, DKK: 2, PLN: 2, CZK: 2, HUF: 2, RON: 2, PHP: 2, IDR: 2, THB: 2, MYR: 2,
});

/** The exact minor-units conversion of a major-unit decimal string. */
export function rapydMinorUnits(majorDecimal: string, currency: string): string {
  const exponent = RAPYD_WALLET_MINOR_UNIT_EXPONENTS[currency.toUpperCase()];
  if (exponent === undefined) {
    throw new ValidationError(
      `unknown minor-unit exponent for wallet currency '${currency.toUpperCase()}' — never guessed (INV-F01; add the exponent when the provider documents it)`,
    );
  }
  const { numerator, denominator } = exactRationalFromDecimal(majorDecimal);
  const d = BigInt(denominator.toString().length - 1);
  const e = BigInt(exponent);
  if (e >= d) {
    return (numerator * 10n ** (e - d)).toString();
  }
  const factor = 10n ** (d - e);
  if (numerator % factor !== 0n) {
    throw new ValidationError(
      `wallet balance '${majorDecimal}' ${currency.toUpperCase()} carries sub-minor precision — cannot be represented in exact minor units (INV-F01)`,
    );
  }
  return (numerator / factor).toString();
}

/** The honest report of a wallet that could NOT be converted to minor units. */
export interface RapydUnconvertedWallet {
  readonly currency: string;
  readonly reason: "UNKNOWN_EXPONENT" | "SUB_MINOR_PRECISION" | "MALFORMED_BALANCE";
}

/**
 * Maps a Rapyd wallet to an ExternalFundsPositionObservation — an
 * observation of PROVIDER-HELD funds in the connected account's wallet:
 * NOT PaySwap custody, NOT a balance PaySwap owes anyone, and unable to
 * create a false PaySwap balance (INV-C09). The provider reports balances
 * in MAJOR units; `observedAmount.minorUnits` is the EXACT bigint
 * conversion at the currency's exponent (INV-F01). A wallet with no known
 * exponent or sub-minor precision is honestly reported in `unconverted`.
 */
export function rapydWalletObservation(input: {
  readonly wallet: RapydWalletProviderObject;
  readonly accountRef: string;
  readonly observedAt: string;
  readonly maxAgeSeconds?: number;
  readonly observationIdPrefix?: string;
}): {
  readonly observation: ExternalFundsPositionObservation | undefined;
  readonly unconverted: RapydUnconvertedWallet | undefined;
} {
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  const prefix = input.observationIdPrefix ?? "rapyd-wallet";
  const currency =
    typeof input.wallet.currency === "string" && input.wallet.currency.length > 0
      ? input.wallet.currency.toUpperCase()
      : undefined;
  if (currency === undefined || (typeof input.wallet.balance !== "number" && typeof input.wallet.balance !== "string")) {
    return {
      observation: undefined,
      unconverted: { currency: currency ?? "UNKNOWN", reason: "MALFORMED_BALANCE" },
    };
  }
  let minorUnits: string;
  try {
    minorUnits = rapydMinorUnits(String(input.wallet.balance), currency);
  } catch (error) {
    if (error instanceof ValidationError) {
      const reason: RapydUnconvertedWallet["reason"] = /sub-minor precision/.test(error.message)
        ? "SUB_MINOR_PRECISION"
        : /non-negative decimal/.test(error.message)
          ? "MALFORMED_BALANCE"
          : "UNKNOWN_EXPONENT";
      return { observation: undefined, unconverted: { currency, reason } };
    }
    return { observation: undefined, unconverted: { currency, reason: "MALFORMED_BALANCE" } };
  }
  return {
    observation: Object.freeze({
      observationKind: "ExternalFundsPositionObservation" as const,
      observationId: `${prefix}:balance:${currency}`,
      observedAt: input.observedAt,
      freshness: Object.freeze({ asOf: input.observedAt, maxAgeSeconds }),
      location: Object.freeze({
        providerName: RAPYD_PROVIDER_NAME,
        accountRef: input.accountRef,
        instrumentRef: `wallet:${input.wallet.id ?? "no_id"}:${currency}`,
        description:
          "Rapyd wallet balance (provider-held external funds — observation, never custody; INV-C09)",
      }),
      observedAmount: Object.freeze({ currency, minorUnits }),
      provenance: Object.freeze({
        providerName: RAPYD_PROVIDER_NAME,
        source: "PROVIDER_API" as const,
        capturedAt: input.observedAt,
      }),
      reconciliationState: "NOT_RECONCILED" as const,
    }),
    unconverted: undefined,
  };
}

// ---------------------------------------------------------------------------
// Webhook verification (the SAME salt/timestamp HMAC construction)
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

/**
 * The documented Rapyd webhook signature: the SAME salt/timestamp HMAC
 * construction as API requests, computed over the raw body with the shared
 * webhook secret:
 *
 * ```text
 * webhook_signature = hex(HMAC-SHA256(webhook_secret, salt + timestamp + raw_body))
 * ```
 *
 * The delivery carries `salt`, `timestamp` and `signature` headers/values
 * alongside the JSON payload `{ id, type, body, timestamp, … }`.
 *
 * HONEST UNCERTAINTY (recorded, never guessed silently): the exact webhook
 * signing string must be CONFIRMED against a live Rapyd delivery once
 * credentials exist — no webhook endpoint is registered in this deployment
 * and the scheme above is implemented per the documented construction the
 * P2-W2-002 work order pins (BLOCKED-RAILS.md §7 carries the same caveat).
 * The verifier itself, its constant-time compare and the (provider,
 * eventId) dedupe are production-ready; only the canonicalization string
 * needs live confirmation.
 */
export function rapydWebhookSignature(
  secret: string,
  salt: string,
  timestamp: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret).update(`${salt}${timestamp}${rawBody}`).digest("hex");
}

/** The verification result for one Rapyd webhook delivery. */
export type RapydWebhookDeliveryVerification =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: "MISSING_SIGNATURE_PARTS" | "SIGNATURE_INVALID";
    };

/**
 * Verifies one Rapyd webhook delivery: the `signature` value must equal
 * hex(HMAC-SHA256(webhook_secret, salt + timestamp + rawBody)) compared in
 * CONSTANT TIME. Missing salt/timestamp/signature → MISSING_SIGNATURE_PARTS
 * (fail-closed); a mismatch → SIGNATURE_INVALID.
 */
export function verifyRapydWebhookDelivery(
  delivery: {
    readonly saltHeader: string | undefined;
    readonly timestampHeader: string | undefined;
    readonly signatureHeader: string | undefined;
    readonly rawBody: string;
  },
  deps: { readonly secret: string },
): RapydWebhookDeliveryVerification {
  const { saltHeader, timestampHeader, signatureHeader } = delivery;
  if (
    typeof saltHeader !== "string" || saltHeader.length === 0 ||
    typeof timestampHeader !== "string" || timestampHeader.length === 0 ||
    typeof signatureHeader !== "string" || signatureHeader.length === 0
  ) {
    return { valid: false, reason: "MISSING_SIGNATURE_PARTS" };
  }
  const expected = rapydWebhookSignature(deps.secret, saltHeader, timestampHeader, delivery.rawBody);
  if (!constantTimeEquals(signatureHeader, expected)) {
    return { valid: false, reason: "SIGNATURE_INVALID" };
  }
  return { valid: true };
}

/**
 * The provider-declared event timestamp (epoch seconds) from a Rapyd
 * webhook payload's `timestamp` — the deterministic, clock-free source the
 * ingestor's replay window consumes. Undefined when the payload declares
 * none (the caller then supplies its own observation).
 */
export function rapydWebhookEventTimestamp(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const timestamp = (payload as { readonly timestamp?: unknown }).timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return String(Math.floor(timestamp));
  }
  if (typeof timestamp === "string" && /^\d+$/.test(timestamp)) {
    return timestamp;
  }
  return undefined;
}

/**
 * The deterministic dedupe event id for a Rapyd webhook payload:
 * `${type}:${id}` — the provider's own event/object identity pair.
 */
export function rapydWebhookEventId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as { readonly type?: unknown; readonly id?: unknown };
  if (typeof record.type !== "string" || record.type.length === 0) {
    return undefined;
  }
  const id =
    typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : "no-id";
  return `${record.type}:${id}`;
}

/**
 * Adapts a raw Rapyd delivery into the adapters' ProviderWebhookRawEvent.
 *
 * The framework's header surface is { signature, timestamp } while Rapyd's
 * scheme needs a third delivery part (the salt): the adapter encodes
 * `salt|signature` into the single signature field with the documented
 * separator below — RapydWebhookVerifier decodes it. The RAW delivery can
 * always be verified directly through verifyRapydWebhookDelivery for
 * non-framework callers.
 */
export const RAPYD_WEBHOOK_SIGNATURE_SEPARATOR = "|";

export function rapydWebhookRawEvent(delivery: {
  readonly eventId: string;
  readonly payload: unknown;
  readonly saltHeader: string;
  readonly timestampHeader: string;
  readonly signatureHeader: string;
  readonly timestampSeconds: string;
}): ProviderWebhookRawEvent {
  return Object.freeze({
    providerName: RAPYD_PROVIDER_NAME,
    eventId: delivery.eventId,
    timestamp: delivery.timestampSeconds,
    payload: delivery.payload,
    headers: Object.freeze({
      signature: `${delivery.saltHeader}${RAPYD_WEBHOOK_SIGNATURE_SEPARATOR}${delivery.signatureHeader}`,
      timestamp: delivery.timestampSeconds,
    }),
  });
}

/**
 * The Rapyd webhook verifier on the adapters' WebhookSignatureVerifier
 * hook. The canonicalBody argument is the RAW request body string; the
 * verifier recomputes salt+timestamp+body HMAC and compares constant-time.
 */
export class RapydWebhookVerifier implements WebhookSignatureVerifier {
  readonly #secret: string;

  constructor(secret: string) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new ValidationError("a Rapyd webhook verifier requires a non-empty shared webhook secret");
    }
    this.#secret = secret;
  }

  verify(
    event: ProviderWebhookRawEvent,
    canonicalBody: string,
  ): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
    if (typeof event.headers.signature !== "string" || event.headers.signature.length === 0) {
      return { valid: false, reason: "MISSING_SIGNATURE_PARTS" };
    }
    const separatorIndex = event.headers.signature.indexOf(RAPYD_WEBHOOK_SIGNATURE_SEPARATOR);
    if (separatorIndex <= 0 || separatorIndex >= event.headers.signature.length - 1) {
      return { valid: false, reason: "MISSING_SIGNATURE_PARTS" };
    }
    const salt = event.headers.signature.slice(0, separatorIndex);
    const signature = event.headers.signature.slice(separatorIndex + 1);
    const result = verifyRapydWebhookDelivery(
      {
        saltHeader: salt,
        timestampHeader:
          typeof event.headers.timestamp === "string" ? event.headers.timestamp : undefined,
        signatureHeader: signature,
        rawBody: canonicalBody,
      },
      { secret: this.#secret },
    );
    if (result.valid) {
      return { valid: true };
    }
    return { valid: false, reason: result.reason };
  }
}

/**
 * Wires a ProviderWebhookIngestor for Rapyd: shared-secret HMAC
 * verification (salt + timestamp + raw body), replay window over the
 * provider-declared event time, (provider, eventId) dedupe and append-only
 * evidence — the adapters ingestor pattern with the Rapyd scheme plugged
 * in.
 */
export function createRapydWebhookIngestor(deps: {
  readonly secret: string;
  readonly clock: ProtocolClock;
  readonly replayWindowSeconds?: number;
  readonly futureSkewSeconds?: number;
}): ProviderWebhookIngestor {
  return new WebhookIngestor({
    verifier: new RapydWebhookVerifier(deps.secret),
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
// Idempotency (deterministic client reference — INV-F05)
// ---------------------------------------------------------------------------

/**
 * Derives the deterministic Rapyd client reference from the protocol
 * idempotency key (INV-F05). Rapyd exposes NO global idempotency header;
 * the reference rides payment metadata (`payswap_idempotency_key`) so
 * retries carry the SAME value and reconciliation can join by it. The
 * caller's protocol idempotency registrar remains the double-execution
 * guard (duplicateBehavior PROVIDER_DEFINED).
 */
export function rapydClientReference(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap:${protocolIdempotencyKey}`;
}

// ---------------------------------------------------------------------------
// The RailAdapter surface (provider-neutral framework registration)
// ---------------------------------------------------------------------------

/** The Rapyd production rail adapter on the BaseRailAdapter framework. */
export class RapydProductionRail extends BaseRailAdapter {
  readonly adapterId = RAPYD_RAIL_ADAPTER_ID;
  readonly implementationId = RAPYD_RAIL_IMPLEMENTATION_ID;

  constructor() {
    const definitions = new Map<string, CapabilityDefinition>();
    for (const definition of rapydCapabilityDefinitions()) {
      definitions.set(definition.capabilityId, definition);
    }
    super(rapydRailCapabilityPack(), definitions);
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK; credential-gated, fail-closed)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface RapydControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface RapydConnectorConfig {
  readonly clock: ProtocolClock;
  readonly apiBase?: string;
  /** Defaults to the SANDBOX base; production deployments pin the live base explicitly. */
  readonly environment?: "sandbox" | "live";
  /** Overrides the pinned API version (tests only — production pins). */
  readonly apiVersion?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("rapyd")` = PROVIDER_RAPYD_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: RapydControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type RapydSdkRequest =
  | {
      readonly kind: "create_payment";
      readonly amountMajor: string;
      readonly currency: string;
      readonly country?: string;
      readonly paymentMethodType: string;
      readonly paymentMethodData?: Readonly<Record<string, unknown>>;
      readonly completePaymentUrl?: string;
      readonly errorPaymentUrl?: string;
      readonly capture?: boolean;
    }
  | { readonly kind: "read_payment"; readonly paymentId: string }
  | {
      readonly kind: "create_payout";
      readonly payoutMethodType: string;
      readonly amountMajor: string;
      readonly currency: string;
      readonly beneficiary: Readonly<Record<string, unknown>>;
      readonly beneficiaryId?: string;
      readonly description?: string;
    }
  | { readonly kind: "read_payout"; readonly payoutId: string }
  | {
      readonly kind: "create_beneficiary";
      readonly payoutMethodType: string;
      readonly fields: Readonly<Record<string, unknown>>;
    };

function isRapydSdkRequest(candidate: unknown): candidate is RapydSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** Which credential path is live (observability — NEVER material). */
export type RapydCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/**
 * The real Rapyd connector (ConnectorSDK framework). Rapyd API names,
 * payloads, response shapes and quirks stay INSIDE this implementation:
 * the SDK call contract is the provider-neutral `RapydSdkRequest` union.
 * Every effectful operation runs behind `requireAuthority`
 * (INV-C04/F05/F06) and fails closed with `RailNotAuthorizedError` BEFORE
 * any provider call when no credential path is live (INV-NC04).
 */
export class RapydConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: RapydControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  #credentialBaseline: string | undefined;

  constructor(config: RapydConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase =
      config.apiBase ??
      (config.environment === "live"
        ? RAPYD_DEFAULT_API_BASE_LIVE
        : RAPYD_DEFAULT_API_BASE_SANDBOX);
    this.#apiVersion = config.apiVersion ?? RAPYD_API_VERSION;
    this.#credentialConfigKey = config.credentialConfigKey ?? RAPYD_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: RAPYD_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "Rapyd (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return rapydRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): RapydCredentialResolutionState {
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
        "no control-plane credentials and no env-resolved material under the config key — rail fails closed (INV-NC04; packages/rails/BLOCKED-RAILS.md §7)",
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
          "credential reference not provisioned (PROVIDER_RAPYD_CREDENTIAL_REF absent) — source availability UNKNOWN (INV-C01/C02); the 2026-10-02 probe recorded the sandbox endpoint REACHABLE but AUTH-REQUIRED (HTTP 401), which is still UNKNOWN, never AVAILABLE; see packages/rails/BLOCKED-RAILS.md §7",
        provenance: {
          providerName: RAPYD_PROVIDER_NAME,
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
          providerName: RAPYD_PROVIDER_NAME,
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
        providerName: RAPYD_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(RAPYD_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface --------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "rapyd search is not implemented — the connector's reconciliation path is the external payment/payout id (GET /v1/payments/{id}, GET /v1/payouts/{id}, INV-X03), and no listing surface is in the connector contract",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "read_payment|read_payout");
    const observedAt = this.#envelopeContext();
    if (request.kind === "read_payment") {
      const data = await this.#withCredentials(async (material) =>
        this.#providerGet(
          `/v1/payments/${encodeURIComponent(request.paymentId)}`,
          ctx.idempotencyKey,
          material,
        ),
      );
      return this.#sdkResult(
        rapydPaymentEnvelope((data ?? {}) as RapydPaymentProviderObject, observedAt),
        `rapyd:read-payment:${request.paymentId}`,
      );
    }
    if (request.kind === "read_payout") {
      const data = await this.#withCredentials(async (material) =>
        this.#providerGet(
          `/v1/payouts/${encodeURIComponent(request.payoutId)}`,
          ctx.idempotencyKey,
          material,
        ),
      );
      return this.#sdkResult(
        rapydPayoutEnvelope((data ?? {}) as RapydPayoutProviderObject, observedAt),
        `rapyd:read-payout:${request.payoutId}`,
      );
    }
    throw new ValidationError("rapyd read supports only { kind: 'read_payment' | 'read_payout' }");
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_payment");
    if (request.kind !== "create_payment") {
      throw new ValidationError("rapyd create supports only { kind: 'create_payment' }");
    }
    if (
      request.amountMajor === undefined ||
      request.currency === undefined ||
      request.paymentMethodType === undefined
    ) {
      throw new ValidationError(
        "create_payment requires amountMajor (exact major-unit decimal), currency and paymentMethodType",
      );
    }
    const clientReference = rapydClientReference(ctx.idempotencyKey);
    const body: Record<string, unknown> = {
      amount: Number(request.amountMajor),
      currency: request.currency.toUpperCase(),
      payment_method: {
        type: request.paymentMethodType,
        ...(request.paymentMethodData !== undefined ? { fields: request.paymentMethodData } : {}),
      },
      ...(request.capture !== undefined ? { capture: request.capture } : {}),
      ...(request.completePaymentUrl !== undefined
        ? { complete_payment_url: request.completePaymentUrl }
        : {}),
      ...(request.errorPaymentUrl !== undefined
        ? { error_payment_url: request.errorPaymentUrl }
        : {}),
      // INV-F05: the deterministic client reference rides payment metadata —
      // Rapyd has NO global idempotency header; this is the retry join key.
      metadata: { payswap_idempotency_key: ctx.idempotencyKey, client_reference: clientReference },
    };
    const observedAt = this.#envelopeContext();
    // INV-X01: a transport failure mid-create is OUTCOME_UNKNOWN — the
    // payment may exist at the provider; reconcile by the Rapyd payment id
    // once known (and by the metadata reference). NEVER FAILED.
    try {
      const data = await this.#withCredentials(async (material) =>
        this.#providerPost("/v1/payments", body, ctx.idempotencyKey, material),
      );
      return this.#sdkResult(
        rapydPaymentEnvelope((data ?? {}) as RapydPaymentProviderObject, observedAt),
        `rapyd:create-payment:${clientReference}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "payment",
          externalId: clientReference,
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
      "rapyd payments are not mutable at the provider (create → next_action/ACT → read lifecycle only)",
    );
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "create_payout|create_beneficiary");
    const observedAt = this.#envelopeContext();
    if (request.kind === "create_payout") {
      if (
        request.amountMajor === undefined ||
        request.currency === undefined ||
        request.payoutMethodType === undefined
      ) {
        throw new ValidationError(
          "create_payout requires payoutMethodType, amountMajor and currency",
        );
      }
      const clientReference = rapydClientReference(ctx.idempotencyKey);
      const body: Record<string, unknown> = {
        payout_method_type: request.payoutMethodType,
        amount: Number(request.amountMajor),
        currency: request.currency.toUpperCase(),
        // The beneficiary object carries the provider-defined fields —
        // the explicit BeneficiaryRequirement records govern what must be
        // in it (rapydBeneficiaryRequirements).
        beneficiary: request.beneficiary,
        ...(request.beneficiaryId !== undefined
          ? { beneficiary_entity: request.beneficiaryId }
          : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        metadata: { payswap_idempotency_key: ctx.idempotencyKey, client_reference: clientReference },
      };
      // INV-X01: value moves on a payout — OUTCOME_UNKNOWN, never FAILED.
      try {
        const data = await this.#withCredentials(async (material) =>
          this.#providerPost("/v1/payouts", body, ctx.idempotencyKey, material),
        );
        const payoutData = (data ?? {}) as RapydPayoutProviderObject;
        return this.#sdkResult(
          rapydPayoutEnvelope(payoutData, observedAt),
          `rapyd:create-payout:${clientReference}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "payout",
            externalId: clientReference,
            operation: "create_payout",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    if (request.kind === "create_beneficiary") {
      const body: Record<string, unknown> = {
        payout_method_type: request.payoutMethodType,
        fields: request.fields,
      };
      try {
        const data = await this.#withCredentials(async (material) =>
          this.#providerPost("/v1/beneficiaries", body, ctx.idempotencyKey, material),
        );
        const beneficiaryData = (data ?? {}) as RapydBeneficiaryProviderObject;
        return this.#sdkResult(
          rapydBeneficiaryEnvelope(beneficiaryData, observedAt),
          `rapyd:create-beneficiary:${request.payoutMethodType}:${this.#clock.now()}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "beneficiary",
            externalId: request.payoutMethodType,
            operation: "create_beneficiary",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    throw new ValidationError(
      "rapyd executeAction supports only { kind: 'create_payout' | 'create_beneficiary' }",
    );
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "rapyd event subscription is handled by the webhook ingestion framework (createRapydWebhookIngestor + @payswap/adapters ProviderWebhookIngestor), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "read_payment|read_payout");
    if (request.kind !== "read_payment" && request.kind !== "read_payout") {
      throw new ValidationError(
        "rapyd reconcile supports only { kind: 'read_payment' | 'read_payout' }",
      );
    }
    // Reconciliation-as-authority (INV-X03): re-fetch by external object id.
    return this.read(ctx);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "rapyd disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and release the sealed credential handle); the provider surface offers no self-disconnect",
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md, Rapyd path —
   * swap-reference-then-verify): the vault binding for the control-plane
   * config key is swapped to a NEW reference at the vault; the connector
   * re-resolves per call, so the rotation is real exactly when the NEW
   * reference resolves and serves a successful health probe. The old key
   * is revoked at Rapyd (Client Portal) only after that verification.
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
          evidenceId: `rapyd:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: RAPYD_PROVIDER_NAME,
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
        "cannot rotate credentials: no credential path is provisioned for the rapyd rail (packages/rails/BLOCKED-RAILS.md §7)",
        { railId: RAPYD_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = createHmac("sha256", "payswap-rapyd-rotation-baseline")
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
        evidenceId: `rapyd:cred-rotation:${rotatedAt}`,
        evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
        kind: "AUDIT_LOG",
        providerState: railEnvelope({
          providerName: RAPYD_PROVIDER_NAME,
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
   * via an unauthenticated GET on the recorded probe path (any HTTP
   * answer — the recorded 401 datum — proves reachability) → DEGRADED
   * with reasons; transport failure → UNKNOWN. With credentials: an
   * authenticated GET /v1/payment_methods_by_country (the real probe) →
   * HEALTHY.
   */
  async health(): Promise<ConnectorHealthReport> {
    const resolution = this.credentialResolutionState();
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: RAPYD_CONNECTOR_ID,
      providerName: RAPYD_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (resolution.kind === "NOT_PROVISIONED") {
      let endpointAnswered: boolean;
      try {
        await this.#http(
          `${this.#apiBase}${RAPYD_SANDBOX_REACHABILITY_DATUM_20261002.path}?country=US`,
          { method: "GET", headers: {}, timeoutMs: this.#timeoutMs },
        );
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
              `credentials absent: provider endpoint reachable (the recorded 2026-10-02 probe answered HTTP 401 — auth required) but rail authorization cannot be established — availability UNKNOWN (INV-C01/C02; packages/rails/BLOCKED-RAILS.md §7)`,
            ]
          : ["provider endpoint unreachable — availability UNKNOWN (INV-C02)"],
      };
    }
    try {
      await this.#withCredentials(async (material) =>
        this.#providerGet("/v1/payment_methods_by_country?country=US", "health-probe", material),
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

  // -- dedicated coverage/precondition observation methods (the work order's core) --

  /**
   * Observes the PAY-IN coverage surface for one country from the
   * CONNECTED account (GET /v1/payment_methods_by_country?country=XX) —
   * the ONLY source of pay-in coverage records (the coverage law). Each
   * returned record carries the raw method object VERBATIM; the KYC/
   * document requirement fields are fetched per method type on demand via
   * observePaymentMethodRequirements and attached by the caller (or
   * satisfied-check directly through rapydCoverageEligibility). Requires
   * credentials — an uncredentialed deployment has NO coverage records.
   */
  async observePayInCoverage(country: string): Promise<{
    readonly records: readonly RapydCoverageRecord[];
    readonly envelope: ProviderStateEnvelope;
  }> {
    const upper = country.toUpperCase();
    const observedAt = this.#envelopeContext();
    const data = (await this.#withCredentials(async (material) =>
      this.#providerGet(
        `/v1/payment_methods_by_country?country=${encodeURIComponent(upper)}`,
        "payin-coverage",
        material,
      ),
    )) as readonly RapydPaymentMethodByCountryProviderObject[];
    if (!Array.isArray(data)) {
      throw new RailProviderError(
        "rapyd payment_methods_by_country response is malformed (expected a data array)",
        { path: "/v1/payment_methods_by_country", country: upper },
      );
    }
    const records: RapydCoverageRecord[] = [];
    for (const method of data) {
      records.push(
        Object.freeze({
          surface: "PAY_IN",
          country: upper,
          paymentMethodType: String(method.type ?? "unknown_type"),
          observedAt: observedAt.observedAt,
          source: "CONNECTED_ACCOUNT_QUERY",
          requirements: [],
          raw: method,
        }),
      );
    }
    return {
      records: Object.freeze(records),
      envelope: rapydCoverageEnvelope("PAY_IN", upper, data, observedAt),
    };
  }

  /**
   * Observes the KYC/document requirement fields for one payment method
   * type (GET /v1/payment_method_types/{type}/requirements) — the
   * CAPABILITY PRECONDITIONS for that method (proof_of_id,
   * document_ssn, …): preserved verbatim as
   * RapydPaymentMethodRequirement records. A capability is not eligible
   * until these are satisfied (rapydCoverageEligibility).
   */
  async observePaymentMethodRequirements(paymentMethodType: string): Promise<{
    readonly requirements: readonly RapydPaymentMethodRequirement[];
    readonly envelope: ProviderStateEnvelope;
  }> {
    const observedAt = this.#envelopeContext();
    const data = await this.#withCredentials(async (material) =>
      this.#providerGet(
        `/v1/payment_method_types/${encodeURIComponent(paymentMethodType)}/requirements`,
        "pm-requirements",
        material,
      ),
    );
    return {
      requirements: rapydPaymentMethodRequirements(data),
      envelope: rapydRequirementsEnvelope(paymentMethodType, data, observedAt),
    };
  }

  /**
   * Observes the PAYOUT coverage surface for one country from the
   * CONNECTED account — a SEPARATE surface from pay-in (a pay-in
   * observation never authorizes a payout). The beneficiary requirement
   * fields are extracted from the observed method-type objects as
   * EXPLICIT RapydBeneficiaryRequirement records
   * (rapydBeneficiaryRequirements); the raw objects ride the records
   * verbatim.
   *
   * HONEST UNCERTAINTY (recorded, never guessed silently): the payout
   * coverage endpoint path (/v1/payouts/method_types) is mapped per the
   * documented Rapyd surface and MUST be confirmed live once credentials
   * exist — no Rapyd credential is held in this deployment (BLOCKED-RAILS
   * §7). The connector refuses to fabricate coverage in the meantime.
   */
  async observePayoutCoverage(country: string): Promise<{
    readonly records: readonly RapydCoverageRecord[];
    readonly envelope: ProviderStateEnvelope;
  }> {
    const upper = country.toUpperCase();
    const observedAt = this.#envelopeContext();
    const data = (await this.#withCredentials(async (material) =>
      this.#providerGet(
        `/v1/payouts/method_types?country=${encodeURIComponent(upper)}`,
        "payout-coverage",
        material,
      ),
    )) as readonly unknown[];
    if (!Array.isArray(data)) {
      throw new RailProviderError(
        "rapyd payout method-types response is malformed (expected a data array)",
        { path: "/v1/payouts/method_types", country: upper },
      );
    }
    const records: RapydCoverageRecord[] = [];
    for (const methodType of data) {
      const type =
        methodType !== null && typeof methodType === "object"
          ? String(
              (methodType as { readonly payout_method_type?: unknown; readonly type?: unknown })
                .payout_method_type ??
                (methodType as { readonly type?: unknown }).type ??
                "unknown_type",
            )
          : "unknown_type";
      records.push(
        Object.freeze({
          surface: "PAYOUT",
          country: upper,
          paymentMethodType: type,
          observedAt: observedAt.observedAt,
          source: "CONNECTED_ACCOUNT_QUERY",
          requirements: [],
          raw: methodType,
        }),
      );
    }
    return {
      records: Object.freeze(records),
      envelope: rapydCoverageEnvelope("PAYOUT", upper, data, observedAt),
    };
  }

  // -- dedicated observation methods (read-only; INV-C09) ----------------------

  /**
   * External funds observation for one Rapyd wallet (GET
   * /v1/user/wallets/{wallet_id}) — provider-held funds on the connected
   * account. Observation ONLY (INV-C09): never custody, never a PaySwap
   * balance. An unconvertible wallet is honestly reported (never guessed).
   */
  async observeWallet(walletId: string): Promise<{
    readonly observation: ExternalFundsPositionObservation | undefined;
    readonly unconverted: RapydUnconvertedWallet | undefined;
    readonly envelope: ProviderStateEnvelope;
  }> {
    const observedAt = this.#envelopeContext();
    const wallet = (await this.#withCredentials(async (material) =>
      this.#providerGet(
        `/v1/user/wallets/${encodeURIComponent(walletId)}`,
        "wallet",
        material,
      ),
    ) ?? {}) as RapydWalletProviderObject;
    const { observation, unconverted } = rapydWalletObservation({
      wallet,
      accountRef: `vault:${RAPYD_CREDENTIAL_CONFIG_KEY}`,
      observedAt: observedAt.observedAt,
    });
    return {
      observation,
      unconverted,
      envelope: rapydWalletEnvelope(wallet, observedAt),
    };
  }

  // -- internals -------------------------------------------------------------------

  #envelopeContext(): RapydEnvelopeContext {
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
  async #withCredentials<T>(fn: (material: RapydCredentialMaterial) => Promise<T>): Promise<T> {
    if (this.#controlPlane !== undefined) {
      let handle: ReturnType<CredentialBroker["resolveProviderCredential"]>;
      try {
        handle = this.#controlPlane.broker.resolveProviderCredential(
          this.#credentialConfigKey,
        );
      } catch (error) {
        throw new RailNotAuthorizedError(
          "rapyd rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: RAPYD_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => fn(extractRapydCredentialMaterial(opened.material)),
      );
    }
    const raw = this.#envMaterial();
    if (raw === undefined) {
      throw new RailNotAuthorizedError(
        "rapyd rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md §7)",
        { railId: RAPYD_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new ValidationError(
        "the env-resolved Rapyd credential material is not a JSON bundle — expected { access_key, secret_key } (fail-closed, never guessed)",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    return fn(extractRapydCredentialMaterial(parsed));
  }

  #request(ctx: SdkCallContext, expectedKind: string): RapydSdkRequest {
    const candidate = ctx.request;
    if (!isRapydSdkRequest(candidate)) {
      throw new ValidationError(
        `rapyd rail call request must be a RapydSdkRequest object (expected kind '${expectedKind}')`,
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
      providerName: RAPYD_PROVIDER_NAME,
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
        note: "transport failed mid-effect — the provider effect may have landed; reconcile by the Rapyd payment/payout id (INV-X01/INV-X03); never coerced to FAILED",
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
      shareableFields: RAPYD_SHAREABLE_FIELDS,
    });
    return this.#sdkResult(envelope, `rapyd:outcome-unknown:${input.operation}:${input.idempotencyKey}`);
  }

  /** The Rapyd response shape: { status: { status, error_code, message, … }, data }. */
  #parseResponse(
    response: { readonly status: number; readonly bodyText: string },
    path: string,
    callRef: string,
  ): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("rapyd provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const body = parsed as {
      readonly status?: { readonly status?: string; readonly error_code?: string | number; readonly message?: string };
      readonly data?: unknown;
    };
    if (
      body !== null &&
      typeof body === "object" &&
      body.status !== null &&
      typeof body.status === "object" &&
      (body.status.status === "ERROR" ||
        (body.status.error_code !== undefined && String(body.status.error_code) !== "0"))
    ) {
      throw new RailProviderError(
        `rapyd provider answered HTTP ${response.status}: ${body.status.message ?? "provider error"} (error_code ${String(body.status.error_code)})`,
        { path, httpStatus: response.status, callRef },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(`rapyd provider answered HTTP ${response.status}`, {
        path,
        httpStatus: response.status,
      });
    }
    if (body === null || typeof body !== "object" || !("data" in body)) {
      // A 2xx answer that is not the Rapyd { status, data } envelope is
      // malformed — refuse rather than guess a payload shape (fail-closed).
      throw new RailProviderError(
        "rapyd response is malformed (expected { status, data })",
        { path, httpStatus: response.status },
      );
    }
    return body.data ?? null;
  }

  async #providerGet(path: string, callRef: string, material: RapydCredentialMaterial): Promise<unknown> {
    // The signed url_path excludes the query string (documented scheme).
    const urlPath = path.split("?")[0] ?? path;
    const headers = rapydSignatureHeaders({
      urlPath,
      salt: rapydSalt(),
      timestamp: rapydTimestamp(this.#clock),
      accessKey: material.accessKey,
      secretKey: material.secretKey,
    });
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "GET",
        headers,
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("rapyd provider transport unreachable", {
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
    material: RapydCredentialMaterial,
  ): Promise<unknown> {
    const headers = rapydSignatureHeaders({
      urlPath: path,
      salt: rapydSalt(),
      timestamp: rapydTimestamp(this.#clock),
      accessKey: material.accessKey,
      secretKey: material.secretKey,
      body,
    });
    const bodyString = JSON.stringify(body);
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers,
        body: bodyString,
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("rapyd provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return this.#parseResponse(response, path, idempotencyKey);
  }
}

/**
 * The salt for one signed request: a per-call random hex string. Rapyd
 * documents the salt as a random string the CLIENT generates — this is a
 * NONCE, not a secret (it rides the request header in clear). The nonce
 * comes from node:crypto randomBytes (the cryptographically-correct
 * source): the deterministic-battery law bans Math.random/Date.now in src
 * and governs reproducible envelopes/evidence, while a per-request clear
 * header nonce is REQUIRED by the provider scheme to be unguessable.
 */
function rapydSalt(): string {
  return randomBytes(16).toString("hex");
}

/** The timestamp for one signed request: unix SECONDS from the injected clock. */
function rapydTimestamp(clock: ProtocolClock): string {
  return String(Math.floor(Number(clock.now() / 1000n)));
}

/** The Rapyd credential material (access_key + secret_key pair). */
export interface RapydCredentialMaterial {
  readonly accessKey: string;
  readonly secretKey: string;
}

/**
 * Extracts the Rapyd credential material from a vault bundle shape. The
 * control plane hands the connector whatever the vault object holds: a
 * bundle record ({ access_key, secret_key } / { accessKey, secretKey }) —
 * a plain string is NOT acceptable for Rapyd (two fields are required) and
 * refuses the call (fail-closed, no guessing).
 */
export function extractRapydCredentialMaterial(material: unknown): RapydCredentialMaterial {
  if (material !== null && typeof material === "object") {
    const record = material as Readonly<Record<string, unknown>>;
    const accessKey = readString(record, ["access_key", "accessKey"]);
    const secretKey = readString(record, ["secret_key", "secretKey"]);
    if (accessKey !== undefined && secretKey !== undefined) {
      return Object.freeze({ accessKey, secretKey });
    }
  }
  throw new ValidationError(
    "the sealed credential bundle does not contain Rapyd key material (expected { access_key, secret_key })",
  );
}

function readString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
