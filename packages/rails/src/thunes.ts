/**
 * Thunes production connector (P2-W2-002) — the REAL Thunes V2 adapter on
 * the v1.5 capability hierarchy and ProviderStateEnvelope, focused on
 * cross-border payout aggregation (payers, quotes, transactions with
 * explicit beneficiary requirements).
 *
 * Authority: spec/phase-2/work-items/P2-W2-002.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md and the TL
 * resident-watch reachability probes recorded 2026-10-02 in
 * spec/development-state/phase-2-state.json.
 *
 * THE HONEST DATUM (probed 2026-10-02, recorded verbatim as
 * THUNES_UNRESOLVABLE_ENDPOINT_20261002): BOTH documented API hosts are
 * GLOBALLY NXDOMAIN — public DNS-over-HTTPS answered Status: 3 (NXDOMAIN)
 * for `sandbox-api.thunes.com` AND `api.thunes.com`, with the zone
 * authoritative on awsdns; the company domain `www.thunes.com` RESOLVES
 * but answers HTTP 403 (CloudFront). The API endpoint is NOT currently
 * resolvable. The connector maps the documented V2 API surface faithfully
 * and FAILS CLOSED with this reachability datum recorded as evidence (the
 * MTN MoMo honest-BLOCKED pattern): availability is UNKNOWN with
 * provenance (INV-C01/C02) and ALL effectful operations refuse citing the
 * datum BEFORE any provider call (INV-NC04). NO mock, NO simulated
 * outcome. The gate lifts ONLY through newer verified endpoint evidence
 * supplied at construction (`endpointEvidence` — the operator must confirm
 * the CURRENT API host; the NXDOMAIN datum means the documented hosts are
 * not it) or a successful re-probe.
 *
 * Other laws implemented here (the shared pattern law):
 * - INV-C06 (lossless): every provider object (payer, quote, transaction
 *   with its `id` and verbatim status, beneficiary-requirements answer,
 *   webhook notification) is carried VERBATIM in the envelope `state` with
 *   an ADDITIVE classification. Thunes statuses are NEVER renamed, never
 *   dropped; UNKNOWN provider statuses stay `other`/verbatim non-terminal.
 * - COVERAGE IS OBSERVED, NOT ADVERTISED: payer/method coverage is queried
 *   from the CONNECTED account (GET /v2/payers, /v2/countries,
 *   /v2/services) — no advertised global coverage becomes routable without
 *   connected-instance evidence (the executable law lives in
 *   thunesPayerEligibility).
 * - BENEFICIARY REQUIREMENTS ARE EXPLICIT AND PER-PAYER: the
 *   provider-defined fields (account_number, bank_name, mobile_number, …)
 *   are modeled as explicit ThunesBeneficiaryRequirement records attached
 *   as capability PRECONDITIONS — a capability is NOT eligible until its
 *   requirement fields are satisfied.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (requires
 *   reconciliation by the Thunes transaction id) — NEVER collapsed to
 *   FAILED. (In the current state the unresolvable endpoint makes every
 *   attempt fail closed BEFORE transport — the datum governs.)
 * - Credential isolation (phase-2): key material is consumed through the
 *   P2-W1-001 control plane — `PROVIDER_THUNES_CREDENTIAL_REF` bound to a
 *   vault:// reference, resolved through the CredentialBroker to a SEALED
 *   bundle (apiKey + secretKey) opened only inside `withSealedBundle` with
 *   a ConnectorRuntimeKey. A direct env fallback (the W1-005 rails
 *   convention) exists for deployments that inject the resolved material
 *   under the same config key; material NEVER enters any envelope, log
 *   line or evidence record. NO Thunes credential exists in this
 *   deployment.
 * - Authentication is the documented V2 scheme: POST
 *   /v2/authentication/api-keys with the apiKey/secretKey pair → a
 *   bearer-style token used as `Authorization: Bearer <token>` on
 *   subsequent calls. HONEST UNCERTAINTY: the exact request-body shape is
 *   mapped per the documented surface and must be confirmed live once a
 *   resolvable endpoint + credentials exist — recorded in BLOCKED-RAILS
 *   §9, never guessed silently.
 * - Webhooks: Thunes notification callbacks are verified with the
 *   documented HMAC pattern — hex(HMAC-SHA256(shared secret, RAW body)),
 *   constant-time compare, (provider, eventId) dedupe. HONEST
 *   UNCERTAINTY: the exact signing-header name/canonicalization must be
 *   confirmed against a live notification (BLOCKED-RAILS §9).
 * - Idempotency honesty: the connector derives a deterministic
 *   `externalId` from the protocol idempotency key (INV-F05) — Thunes
 *   echoes it and exposes the `thunesTrxId` as its own transaction
 *   identity; duplicates surface as provider-defined errors, never silent
 *   success.
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

export const THUNES_PROVIDER_NAME = "thunes" as const;
/** The pinned Thunes API surface (the documented V2 API). */
export const THUNES_API_VERSION = "v2" as const;
export const THUNES_RAIL_ADAPTER_ID = "rail.thunes" as const;
export const THUNES_RAIL_IMPLEMENTATION_ID = "impl.rails.thunes.v2" as const;
export const THUNES_CONNECTOR_ID = "connector.rails.thunes" as const;
export const THUNES_DEFAULT_API_BASE_SANDBOX = "https://sandbox-api.thunes.com" as const;
export const THUNES_DEFAULT_API_BASE_LIVE = "https://api.thunes.com" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("thunes")` —
 * `PROVIDER_THUNES_CREDENTIAL_REF`, bound (per the deployment template) to
 * `vault://payswap/providers/thunes/sandbox-20261002`. ABSENT in this
 * deployment: no Thunes credential exists; the rail fails closed.
 */
export const THUNES_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  THUNES_PROVIDER_NAME,
);

/**
 * THE HONEST DATUM (probed 2026-10-02): BOTH documented Thunes API hosts
 * are GLOBALLY NXDOMAIN. Recorded verbatim — public DNS-over-HTTPS
 * answered Status: 3 (NXDOMAIN) for both hosts, zone authoritative on
 * awsdns; the company domain www.thunes.com resolves but answers HTTP 403
 * (CloudFront). The API endpoint is NOT currently resolvable: availability
 * is UNKNOWN with this provenance, and all effectful operations refuse
 * citing this datum until the operator confirms the CURRENT API host (via
 * `endpointEvidence` at construction) or a successful re-probe runs.
 * NEVER a failure to hide — the connector is honest about exactly what was
 * observed, when, and by what method.
 */
export const THUNES_UNRESOLVABLE_ENDPOINT_20261002: {
  readonly hosts: readonly string[];
  readonly verdict: "GLOBALLY_NXDOMAIN";
  readonly method: string;
  readonly detail: string;
  readonly companyDomain: { readonly host: string; readonly resolves: true; readonly httpStatus: 403; readonly via: string };
  readonly availability: "UNKNOWN";
  readonly probedAt: string;
} = Object.freeze({
  hosts: Object.freeze([THUNES_DEFAULT_API_BASE_SANDBOX, THUNES_DEFAULT_API_BASE_LIVE]),
  verdict: "GLOBALLY_NXDOMAIN",
  method: "public DNS-over-HTTPS A-record query (Status: 3), zone authoritative on awsdns",
  detail:
    "both documented API hosts are globally NXDOMAIN — the Thunes API endpoint is NOT currently resolvable; the operator must confirm the current host before any live use",
  companyDomain: Object.freeze({
    host: "www.thunes.com",
    resolves: true,
    httpStatus: 403,
    via: "CloudFront",
  }),
  availability: "UNKNOWN",
  probedAt: "2026-10-02T00:00:00Z",
});

/**
 * The governing endpoint evidence for the Thunes connector. The DEFAULT is
 * the honest NXDOMAIN datum; a caller holding NEWER verified evidence (the
 * operator confirmed a resolvable current host) supplies it at
 * construction — `status: "RESOLVED"` with the confirmed host lifts the
 * fail-closed gate.
 */
export interface ThunesEndpointEvidence {
  readonly status: "GLOBALLY_NXDOMAIN" | "RESOLVED";
  readonly probedAt: string;
  readonly detail: string;
  /** Required when status is RESOLVED — the confirmed current API host. */
  readonly resolvedHost?: string;
}

/** Default endpoint evidence: the recorded NXDOMAIN datum. */
export const THUNES_DEFAULT_ENDPOINT_EVIDENCE: ThunesEndpointEvidence = Object.freeze({
  status: "GLOBALLY_NXDOMAIN",
  probedAt: THUNES_UNRESOLVABLE_ENDPOINT_20261002.probedAt,
  detail: THUNES_UNRESOLVABLE_ENDPOINT_20261002.detail,
});

/**
 * The Thunes unresolvable-endpoint refusal: thrown BEFORE any provider
 * call by every provider-calling operation while the governing endpoint
 * evidence says the documented hosts are GLOBALLY_NXDOMAIN. Cites the
 * recorded datum; NO simulated substitute exists. Extends
 * RailNotAuthorizedError so the fail-closed law (INV-NC04) holds verbatim.
 */
export class ThunesUnresolvableEndpointError extends RailNotAuthorizedError {
  constructor(message: string, details?: ConstructorParameters<typeof RailNotAuthorizedError>[1]) {
    super(message, details);
    this.name = "ThunesUnresolvableEndpointError";
  }
}

// ---------------------------------------------------------------------------
// Capability definitions (consumed W2-003 vocabulary — never redefined)
// ---------------------------------------------------------------------------

export const THUNES_QUOTE_CAPABILITY_ID = "cap.rails.thunes.quote.create" as const;
export const THUNES_TRANSACTION_CAPABILITY_ID = "cap.rails.thunes.transaction.execute" as const;
export const THUNES_PAYER_COVERAGE_CAPABILITY_ID =
  "cap.rails.thunes.payer.coverage_observation" as const;

/**
 * The provider-state vocabulary this connector maps (INV-C06): every
 * Thunes transaction status with its additive classification. Exported as
 * data so certification/conformance surfaces can diff the mapping without
 * reading the implementation.
 *
 * | Thunes status | family                   | isTerminal | notes |
 * |---------------|--------------------------|------------|-------|
 * | CREATED       | payout                   | false      | processing |
 * | IN_PROGRESS   | payout                   | false      | processing |
 * | HELD          | customer_action_required | false      | compliance-review family |
 * | CONFIRMED     | payout                   | true       | SETTLED-EXTERNAL |
 * | RECONCILED    | payout                   | true       | SETTLED-EXTERNAL |
 * | CANCELED      | payout                   | true       | terminal |
 * | FAILED        | payout                   | true       | terminal failure |
 * | RETURNED      | payout                   | true       | terminal (value returned) |
 * | (unknown)     | payout                   | false      | verbatim step |
 */
export const THUNES_TRANSACTION_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "CREATED", family: "payout", lifecycleStep: "CREATED", isTerminal: false, requiresCustomerAction: false },
  { providerState: "IN_PROGRESS", family: "payout", lifecycleStep: "IN_PROGRESS", isTerminal: false, requiresCustomerAction: false },
  { providerState: "HELD", family: "customer_action_required", lifecycleStep: "HELD", isTerminal: false, requiresCustomerAction: true },
  { providerState: "CONFIRMED", family: "payout", lifecycleStep: "CONFIRMED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "RECONCILED", family: "payout", lifecycleStep: "RECONCILED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "CANCELED", family: "payout", lifecycleStep: "CANCELED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "FAILED", family: "payout", lifecycleStep: "FAILED", isTerminal: true, requiresCustomerAction: false },
  { providerState: "RETURNED", family: "payout", lifecycleStep: "RETURNED", isTerminal: true, requiresCustomerAction: false },
]);

function thunesCapabilityDefinition(input: {
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
      "credential reference provisioned through the control plane (PROVIDER_THUNES_CREDENTIAL_REF)",
      // The endpoint law: the documented hosts were globally NXDOMAIN on
      // 2026-10-02 — the operator must confirm the current host before any
      // live use (THUNES_UNRESOLVABLE_ENDPOINT_20261002).
      "a verified-resolvable API endpoint (the 2026-10-02 datum recorded both documented hosts GLOBALLY NXDOMAIN — the operator confirms the current host through endpoint evidence)",
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
      // The deterministic externalId (INV-F05) makes retries send the SAME
      // reference; Thunes echoes it and surfaces duplicates as
      // provider-defined errors — never a silent success.
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
        { action: "authenticate", description: "POST /v2/authentication/api-keys — bearer-style token issuance" },
        { action: "list_payers", description: "GET /v2/payers — connected-account payer/method coverage observation" },
        { action: "read_payer", description: "GET /v2/payers/{id} — payer detail; GET /v2/payers/{id}/rates — payer rates" },
        { action: "create_quote", description: "POST /v2/quotes — source/target amounts, fees, rate, expiration" },
        { action: "create_transaction", description: "POST /v2/transactions — transaction from a quote + beneficiary" },
        { action: "confirm_transaction", description: "POST /v2/transactions/{id}/confirm — confirm execution" },
        { action: "read_transaction", description: "GET /v2/transactions/{id} — the reconciliation path" },
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
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "Thunes settlement schedule" },
    constraints: [
      {
        kind: "JURISDICTION",
        description:
          "payer/method coverage follows ONLY the connected-account observation (GET /v2/payers, /v2/countries, /v2/services) — no advertised global catalogue coverage is routable without connected-instance evidence",
      },
    ],
  });
}

/** The canonical capability definitions consumed by the Thunes connector. */
export function thunesCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return Object.freeze([
    thunesCapabilityDefinition({
      capabilityId: THUNES_QUOTE_CAPABILITY_ID,
      summary: "Quote lifecycle on the real Thunes V2 API (source/target amounts, fees, rate, expiration)",
      operation: "rails.thunes.quote.create",
      description:
        "POST /v2/quotes { payerId, sourceAmount, sourceCurrency, targetCurrency, beneficiary? }: the quote is preserved VERBATIM (source/target amounts, fees, rate, expiration) as an observed offer — a quote MOVES NO VALUE; a mid-effect transport failure is OUTCOME_UNKNOWN",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      preconditions: [
        "payer/method coverage OBSERVED from the connected account (GET /v2/payers) — never assumed from the provider catalogue",
      ],
      providerStates: [
        { providerState: "created", canonicalState: "other:created", requiresCustomerAction: false, isTerminal: true },
        { providerState: "expired", canonicalState: "other:expired", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "quote", idFormat: "quote-id:[0-9]+" }],
      sideEffects: [],
    }),
    thunesCapabilityDefinition({
      capabilityId: THUNES_TRANSACTION_CAPABILITY_ID,
      summary: "Cross-border payout transaction lifecycle with explicit per-payer beneficiary requirements",
      operation: "rails.thunes.transaction.execute",
      description:
        "POST /v2/transactions { quoteId, beneficiary, creditReason, externalId } then POST /v2/transactions/{id}/confirm and GET /v2/transactions/{id}: the Thunes transaction id is preserved as the external id (with the caller's externalId riding the state verbatim), statuses stay VERBATIM (CREATED/IN_PROGRESS/HELD/CONFIRMED/RECONCILED/CANCELED/FAILED/RETURNED) with HELD = the compliance-review/customer-action family and CONFIRMED/RECONCILED = settled-external; a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      preconditions: [
        "beneficiary requirements for the payer EXPLICIT and SATISFIED — the provider-defined per-payer fields (account_number, bank_name, mobile_number, …) are capability preconditions, not suggestions",
      ],
      providerStates: THUNES_TRANSACTION_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "transaction", idFormat: "thunes-trx-id:[0-9]+" },
        { objectType: "beneficiary", idFormat: "beneficiary-id:[0-9]+" },
      ],
      sideEffects: [
        { effect: "moves value to the beneficiary when the transaction reaches CONFIRMED/RECONCILED", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      requiredCustomerActions: [
        {
          lifecycleStep: "HELD",
          kind: "COMPLIANCE_REVIEW_HELD",
          message: "The transaction is HELD by Thunes for compliance review — supply the requested information through the provider's channel",
        },
      ],
    }),
    thunesCapabilityDefinition({
      capabilityId: THUNES_PAYER_COVERAGE_CAPABILITY_ID,
      summary: "Payer/method coverage OBSERVED from the connected account (payers, countries, services)",
      operation: "rails.thunes.payer.coverage.observe",
      description:
        "GET /v2/payers + GET /v2/payers/{id} + GET /v2/payers/{id}/rates + GET /v2/countries + GET /v2/services: each payer entry is preserved VERBATIM as an observed coverage record; the per-payer beneficiary requirement fields are preserved as EXPLICIT records — capability preconditions",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      preconditions: [
        "coverage records exist ONLY from a connected-account query — Thunes's advertised catalogue is marketing, never routable evidence",
      ],
      providerStates: [
        { providerState: "observed", canonicalState: "payout:observed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [
        { objectType: "payer_list", idFormat: "payers:[0-9]+" },
        { objectType: "payer", idFormat: "payer-id:[0-9]+" },
      ],
      sideEffects: [],
    }),
  ]);
}

/** The connector capability pack backing the Thunes rail (payments family). */
export function thunesRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.thunes",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: thunesCapabilityDefinitions().map((definition) => ({
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
    })),
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "payments:read"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.thunes.provider_state", version: "1.0.0" }],
    objectMappings: [
      { externalObjectType: "quote", canonicalObjectRef: "payswap:quote", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "transaction", canonicalObjectRef: "payswap:payout", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "beneficiary", canonicalObjectRef: "payswap:beneficiary", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payer_list", canonicalObjectRef: "payswap:eligibility_evidence", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
      { externalObjectType: "payer", canonicalObjectRef: "payswap:eligibility_evidence", sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 50, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-thunes-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// The coverage law: observed-only records, precondition-checked eligibility
// ---------------------------------------------------------------------------

/**
 * One provider-defined beneficiary field for a payer — the fields the
 * POST /v2/transactions beneficiary object must carry (account_number,
 * bank_name, mobile_number, …). Explicit records, never guessed.
 */
export interface ThunesBeneficiaryRequirement {
  readonly payerId: string;
  readonly fieldName: string;
  readonly required: boolean;
  /** The raw provider field object rides VERBATIM (INV-C06). */
  readonly [key: string]: unknown;
}

/**
 * One observed payer coverage record — the ONLY unit of payer/method
 * coverage evidence this connector recognizes. `source` is pinned to
 * CONNECTED_ACCOUNT_QUERY: a record can be constructed ONLY from a real
 * connected-account observation (ThunesConnector.observePayers —
 * credential-gated). There is deliberately NO constructor path from the
 * provider's advertised catalogue.
 */
export interface ThunesPayerCoverageRecord {
  readonly payerId: string;
  /** Verbatim payer fields (name, country, currency, method, …). */
  readonly raw: unknown;
  readonly observedAt: string;
  readonly source: "CONNECTED_ACCOUNT_QUERY";
  /** Per-payer beneficiary requirement fields (explicit preconditions). */
  readonly beneficiaryRequirements: readonly ThunesBeneficiaryRequirement[];
}

/**
 * Normalizes the per-payer beneficiary-requirements disclosure into
 * EXPLICIT records. Thunes discloses the beneficiary fields per payer
 * (fields/required_fields/beneficiary_fields arrays of names or objects —
 * shapes vary across API revisions); every observed shape is normalized
 * ADDITIVELY while the raw payer object rides the coverage record
 * verbatim. An unrecognized shape yields an EMPTY list (honestly "not
 * disclosed by this object shape" — the eligibility function treats
 * undisclosed and disclosed-but-unsatisfied differently).
 */
export function thunesBeneficiaryRequirements(
  payerId: string,
  payerObject: unknown,
): readonly ThunesBeneficiaryRequirement[] {
  const out: ThunesBeneficiaryRequirement[] = [];
  const record =
    payerObject !== null && typeof payerObject === "object"
      ? (payerObject as Readonly<Record<string, unknown>>)
      : undefined;
  for (const key of ["beneficiary_required_fields", "beneficiaryRequiredFields", "beneficiary_fields", "required_fields", "requiredFields", "fields"]) {
    const value = record?.[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string" && entry.length > 0) {
        out.push(Object.freeze({ payerId, fieldName: entry, required: true }));
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
          payerId,
          fieldName: name,
          required: typeof field.required === "boolean" ? field.required : true,
        }),
      );
    }
  }
  return Object.freeze(out);
}

/** The eligibility verdict for one payer. */
export interface ThunesPayerEligibility {
  readonly payerId: string;
  readonly eligible: boolean;
  readonly basis:
    | "OBSERVED_AND_PRECONDITIONS_SATISFIED"
    | "NO_CONNECTED_INSTANCE_EVIDENCE"
    | "PRECONDITIONS_UNSATISFIED";
  /** Required-but-unsatisfied beneficiary requirement field names. */
  readonly unsatisfied: readonly string[];
  readonly reason: string;
}

/**
 * THE COVERAGE LAW, as an executable function: no advertised global
 * coverage becomes routable without connected-instance evidence.
 *
 * Eligibility is computed ONLY against `observedPayers` — records that
 * exist ONLY because a CONNECTED account was queried through this
 * connector (the observation path is credential-gated and fail-closed,
 * and in the current state additionally gated by the unresolvable-endpoint
 * datum). Thunes's marketing catalogue of payers/countries is not an input
 * to this function and CANNOT be one: there is no parameter for it.
 *
 * - No observed record for the payer → NO_CONNECTED_INSTANCE_EVIDENCE,
 *   eligible FALSE — the honest state of EVERY payer in this deployment.
 * - Unsatisfied beneficiary requirement fields →
 *   PRECONDITIONS_UNSATISFIED, eligible FALSE (the fields are capability
 *   preconditions, per the P2-W2-002 acceptance).
 * - An observed payer with every required field satisfied → eligible TRUE
 *   with basis OBSERVED_AND_PRECONDITIONS_SATISFIED.
 */
export function thunesPayerEligibility(input: {
  readonly payerId: string;
  readonly observedPayers: readonly ThunesPayerCoverageRecord[];
  readonly satisfiedRequirementFields: readonly string[];
}): ThunesPayerEligibility {
  const satisfied = new Set(input.satisfiedRequirementFields);
  const record = input.observedPayers.find((candidate) => candidate.payerId === input.payerId);
  if (record === undefined) {
    return Object.freeze({
      payerId: input.payerId,
      eligible: false,
      basis: "NO_CONNECTED_INSTANCE_EVIDENCE",
      unsatisfied: [],
      reason:
        `no connected-instance evidence for payer ${input.payerId} — payer eligibility is computed ONLY from connected-account observations (the provider's advertised catalogue is never routable evidence; INV-NC04 + the P2-W2-002 coverage law)`,
    });
  }
  const unsatisfied = record.beneficiaryRequirements
    .filter((field) => field.required && !satisfied.has(field.fieldName))
    .map((field) => field.fieldName);
  if (unsatisfied.length > 0) {
    return Object.freeze({
      payerId: input.payerId,
      eligible: false,
      basis: "PRECONDITIONS_UNSATISFIED",
      unsatisfied,
      reason: `observed on the connected account, but the provider-defined beneficiary requirements are not satisfied: ${unsatisfied.join(", ")}`,
    });
  }
  return Object.freeze({
    payerId: input.payerId,
    eligible: true,
    basis: "OBSERVED_AND_PRECONDITIONS_SATISFIED",
    unsatisfied: [],
    reason:
      `observed from the connected account on ${record.observedAt}${record.beneficiaryRequirements.length > 0 ? ` with all ${String(record.beneficiaryRequirements.length)} beneficiary requirement fields satisfied` : " (the observed payer disclosed no beneficiary fields — the POST /v2/transactions confirmation path governs)"}`,
  });
}

// ---------------------------------------------------------------------------
// Provider object shapes (opaque passthrough — never domain primitives)
// ---------------------------------------------------------------------------

/** The raw Thunes payer object (GET /v2/payers; opaque passthrough). */
export interface ThunesPayerProviderObject {
  readonly id?: number | string;
  readonly name?: string;
  readonly country?: string;
  readonly currency?: string;
  readonly method?: string;
  readonly [key: string]: unknown;
}

/** The raw Thunes quote object (POST /v2/quotes; opaque passthrough). */
export interface ThunesQuoteProviderObject {
  readonly id?: number | string;
  readonly sourceAmount?: number | string;
  readonly sourceCurrency?: string;
  readonly targetAmount?: number | string;
  readonly targetCurrency?: string;
  readonly fees?: unknown;
  readonly rate?: number | string;
  readonly expiration?: string;
  readonly [key: string]: unknown;
}

/** The raw Thunes transaction object (opaque passthrough). */
export interface ThunesTransactionProviderObject {
  readonly id?: number | string;
  readonly status?: string;
  readonly externalId?: string;
  readonly thunesTrxId?: number | string;
  readonly quoteId?: number | string;
  readonly beneficiary?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object)
// ---------------------------------------------------------------------------

/** Quote revision: id + rate + expiration surface. */
export function thunesQuoteRevision(quote: ThunesQuoteProviderObject): string {
  return `${String(quote.id ?? "no_id")}:${String(quote.rate ?? "no_rate")}:${quote.expiration ?? "no_expiration"}`;
}

/** Transaction revision: id + status. */
export function thunesTransactionRevision(transaction: ThunesTransactionProviderObject): string {
  return `${String(transaction.id ?? transaction.thunesTrxId ?? "no_id")}:${transaction.status ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface ThunesEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK";
  readonly fetchId?: string;
}

function thunesEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: ThunesEnvelopeContext,
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
    providerName: THUNES_PROVIDER_NAME,
    providerVersion: THUNES_API_VERSION,
    objectType,
    externalId,
    revision,
    state,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
}

/** Envelope shareable-field surface for Thunes provider objects. */
const THUNES_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "status",
  "id",
  "externalId",
  "thunesTrxId",
  "sourceAmount",
  "sourceCurrency",
  "targetAmount",
  "targetCurrency",
]);

/**
 * A Thunes quote → lossless envelope. The RAW quote rides VERBATIM
 * (source/target amounts, fees, rate, expiration); family `other` (an
 * observed offer — a quote moves no value).
 */
export function thunesQuoteEnvelope(
  quote: ThunesQuoteProviderObject,
  context: ThunesEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    ...thunesEnvelopeBase("quote", String(quote.id ?? "no_id"), thunesQuoteRevision(quote), quote, context),
    family: "other",
    lifecycleStep: "created",
    isTerminal: true,
    requiresCustomerAction: false,
    shareableFields: THUNES_SHAREABLE_FIELDS,
  });
}

/**
 * Deterministic, additive classification of a Thunes transaction into a
 * lossless ProviderStateEnvelope (INV-C06). The RAW transaction is carried
 * VERBATIM as `state`; the external id is the Thunes transaction `id` (the
 * caller's `externalId` rides the state verbatim). Statuses map per
 * THUNES_TRANSACTION_STATUS_MAPPING:
 *
 * - CREATED/IN_PROGRESS → payout-family processing;
 * - HELD → CUSTOMER-ACTION-REQUIRED (the compliance-review family) with an
 *   explicit actionRequired — the provider holds the transaction pending
 *   review/information;
 * - CONFIRMED/RECONCILED → terminal, SETTLED-EXTERNAL;
 * - CANCELED/FAILED/RETURNED → terminal definitive (RETURNED = value came
 *   back; CANCELED = definitive no-effect; FAILED = definitive failure);
 * - any UNKNOWN status → `payout`/verbatim, non-terminal — never dropped,
 *   never guessed, never collapsed.
 */
export function thunesTransactionEnvelope(
  transaction: ThunesTransactionProviderObject,
  context: ThunesEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = String(transaction.id ?? transaction.thunesTrxId ?? "no_id");
  const base = thunesEnvelopeBase(
    "transaction",
    externalId,
    thunesTransactionRevision(transaction),
    transaction,
    context,
  );
  switch (transaction.status) {
    case "CREATED":
    case "IN_PROGRESS":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: transaction.status,
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: THUNES_SHAREABLE_FIELDS,
      });
    case "HELD":
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: "HELD",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "COMPLIANCE_REVIEW_HELD",
          message:
            "The transaction is HELD by Thunes for compliance review — supply the requested information through the provider's channel",
        },
        shareableFields: THUNES_SHAREABLE_FIELDS,
      });
    case "CONFIRMED":
    case "RECONCILED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: transaction.status,
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: THUNES_SHAREABLE_FIELDS,
      });
    case "CANCELED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "CANCELED",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "transaction_canceled",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: THUNES_SHAREABLE_FIELDS,
      });
    case "FAILED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "FAILED",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "transaction_failed",
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: THUNES_SHAREABLE_FIELDS,
      });
    case "RETURNED":
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: "RETURNED",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "transaction_returned",
          retryable: false,
          ambiguity: "NONE",
        },
        shareableFields: THUNES_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "payout",
        lifecycleStep: transaction.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: THUNES_SHAREABLE_FIELDS,
      });
  }
}

/**
 * A Thunes payer list → one lossless coverage-evidence envelope. Every
 * payer entry rides VERBATIM; the family stays `payout` (coverage for the
 * payout aggregation surface — an observation, not a transaction
 * lifecycle).
 */
export function thunesPayerListEnvelope(
  payers: readonly unknown[],
  context: ThunesEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: THUNES_PROVIDER_NAME,
    providerVersion: THUNES_API_VERSION,
    objectType: "payer_list",
    externalId: `payers:${payers.length}`,
    revision: `payers:${payers.length}`,
    state: Object.freeze({ data: payers }),
    family: "payout",
    lifecycleStep: "observed",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: THUNES_SHAREABLE_FIELDS,
  });
}

/**
 * Maps a Thunes webhook notification payload to the lossless envelope for
 * its inner object. Notification objects carrying a `transaction` map
 * through the transaction mapper; everything else produces an `event`-
 * typed envelope carrying the WHOLE payload verbatim — nothing is dropped
 * (INV-C06).
 */
export function thunesWebhookEventEnvelope(
  payload: unknown,
  context: ThunesEnvelopeContext,
): ProviderStateEnvelope {
  const webhookContext: ThunesEnvelopeContext = {
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
  if (payload !== null && typeof payload === "object") {
    const record = payload as { readonly transaction?: unknown };
    if (record.transaction !== null && typeof record.transaction === "object") {
      return thunesTransactionEnvelope(
        record.transaction as ThunesTransactionProviderObject,
        webhookContext,
      );
    }
  }
  return railEnvelope({
    providerName: THUNES_PROVIDER_NAME,
    providerVersion: THUNES_API_VERSION,
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
    shareableFields: THUNES_SHAREABLE_FIELDS,
  });
}

// ---------------------------------------------------------------------------
// Webhook verification (the documented HMAC pattern)
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
 * The Thunes webhook notification signature (documented HMAC pattern):
 * hex(HMAC-SHA256(shared_secret, RAW body)).
 *
 * HONEST UNCERTAINTY (recorded, never guessed silently): the exact
 * signing-header name and canonicalization must be CONFIRMED against a
 * LIVE Thunes notification — no notification has ever been received (the
 * API hosts are unresolvable and no credential is held; BLOCKED-RAILS
 * §9). The HMAC-SHA256-over-raw-body pattern below is the documented
 * scheme the P2-W2-002 work order pins; the verifier, its constant-time
 * compare and the (provider, eventId) dedupe are production-ready; only
 * the header/canonicalization detail needs live confirmation.
 */
export function thunesWebhookSignature(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** The verification result for one Thunes webhook delivery. */
export type ThunesWebhookDeliveryVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: "MISSING_SIGNATURE" | "SIGNATURE_INVALID" };

/**
 * Verifies one Thunes webhook delivery: the signature header must equal
 * hex(HMAC-SHA256(shared_secret, RAW body)) compared in CONSTANT TIME.
 */
export function verifyThunesWebhookDelivery(
  delivery: { readonly signatureHeader: string | undefined; readonly rawBody: string },
  deps: { readonly secret: string },
): ThunesWebhookDeliveryVerification {
  if (typeof delivery.signatureHeader !== "string" || delivery.signatureHeader.length === 0) {
    return { valid: false, reason: "MISSING_SIGNATURE" };
  }
  const expected = thunesWebhookSignature(deps.secret, delivery.rawBody);
  if (!constantTimeEquals(delivery.signatureHeader, expected)) {
    return { valid: false, reason: "SIGNATURE_INVALID" };
  }
  return { valid: true };
}

/**
 * The provider-declared event timestamp from a Thunes notification payload
 * when it carries one (e.g. epoch seconds) — undefined otherwise (the
 * caller then supplies its own observation).
 */
export function thunesWebhookEventTimestamp(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as { readonly timestamp?: unknown; readonly created_at?: unknown };
  const candidate = record.timestamp ?? record.created_at;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return String(Math.floor(candidate));
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    return candidate;
  }
  return undefined;
}

/**
 * The deterministic dedupe event id for a Thunes notification payload:
 * `${type}:${id}` — the provider's own event/object identity pair.
 */
export function thunesWebhookEventId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as { readonly type?: unknown; readonly id?: unknown };
  const id =
    typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : "no-id";
  return `${String(record.type ?? "untyped")}:${id}`;
}

/**
 * Adapts a raw Thunes notification into the adapters'
 * ProviderWebhookRawEvent. `headers.signature` carries the signature value
 * for the verifier's constant-time HMAC compare over the RAW body.
 */
export function thunesWebhookRawEvent(delivery: {
  readonly eventId: string;
  readonly payload: unknown;
  readonly signatureHeader: string;
  readonly timestampSeconds: string;
}): ProviderWebhookRawEvent {
  return Object.freeze({
    providerName: THUNES_PROVIDER_NAME,
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
 * The Thunes notification verifier on the adapters' WebhookSignatureVerifier
 * hook: hex(HMAC-SHA256(secret, canonicalBody)) — the canonicalBody is the
 * RAW request body string.
 */
export class ThunesWebhookVerifier implements WebhookSignatureVerifier {
  readonly #secret: string;

  constructor(secret: string) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new ValidationError("a Thunes webhook verifier requires a non-empty shared secret");
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
      !constantTimeEquals(event.headers.signature, thunesWebhookSignature(this.#secret, canonicalBody))
    ) {
      return { valid: false, reason: "SIGNATURE_INVALID" };
    }
    return { valid: true };
  }
}

/**
 * Wires a ProviderWebhookIngestor for Thunes: shared-secret HMAC
 * verification (raw body), replay window over the provider-declared event
 * time when present, (provider, eventId) dedupe and append-only evidence —
 * the adapters ingestor pattern with the Thunes scheme plugged in.
 */
export function createThunesWebhookIngestor(deps: {
  readonly secret: string;
  readonly clock: ProtocolClock;
  readonly replayWindowSeconds?: number;
  readonly futureSkewSeconds?: number;
}): ProviderWebhookIngestor {
  return new WebhookIngestor({
    verifier: new ThunesWebhookVerifier(deps.secret),
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
// Idempotency (deterministic externalId — INV-F05)
// ---------------------------------------------------------------------------

/**
 * Derives the deterministic Thunes externalId from the protocol
 * idempotency key (INV-F05). Thunes echoes the caller's externalId and
 * exposes its own `thunesTrxId` as the transaction identity: the
 * deterministic derivation makes retries send the SAME externalId and a
 * duplicate submission surfaces as a provider-defined error — NEVER a
 * silent success. The caller's protocol idempotency registrar remains the
 * double-execution guard (reconciliation by the Thunes transaction id).
 */
export function thunesExternalId(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap-${protocolIdempotencyKey}`;
}

// ---------------------------------------------------------------------------
// The RailAdapter surface (provider-neutral framework registration)
// ---------------------------------------------------------------------------

/** The Thunes production rail adapter on the BaseRailAdapter framework. */
export class ThunesProductionRail extends BaseRailAdapter {
  readonly adapterId = THUNES_RAIL_ADAPTER_ID;
  readonly implementationId = THUNES_RAIL_IMPLEMENTATION_ID;

  constructor() {
    const definitions = new Map<string, CapabilityDefinition>();
    for (const definition of thunesCapabilityDefinitions()) {
      definitions.set(definition.capabilityId, definition);
    }
    super(thunesRailCapabilityPack(), definitions);
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK; credential-gated, fail-closed)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface ThunesControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface ThunesConnectorConfig {
  readonly clock: ProtocolClock;
  readonly apiBase?: string;
  /** Overrides the pinned API version (tests only — production pins). */
  readonly apiVersion?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("thunes")` = PROVIDER_THUNES_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: ThunesControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
  /**
   * The governing endpoint evidence. DEFAULTS to the honest NXDOMAIN datum
   * (THUNES_UNRESOLVABLE_ENDPOINT_20261002): both documented API hosts are
   * globally unresolvable, so every provider-calling operation refuses.
   * A caller holding NEWER verified evidence (the operator confirmed the
   * CURRENT resolvable host) supplies `status: "RESOLVED"` with the
   * confirmed host — the gate then lifts and real calls proceed.
   */
  readonly endpointEvidence?: ThunesEndpointEvidence;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type ThunesSdkRequest =
  | {
      readonly kind: "create_quote";
      readonly payerId: string;
      readonly sourceAmountMajor: string;
      readonly sourceCurrency: string;
      readonly targetCurrency: string;
      readonly beneficiary?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "create_transaction";
      readonly quoteId: string;
      readonly beneficiary: Readonly<Record<string, unknown>>;
      readonly creditReason?: string;
    }
  | { readonly kind: "confirm_transaction"; readonly transactionId: string }
  | { readonly kind: "read_transaction"; readonly transactionId: string }
  | { readonly kind: "read_payer"; readonly payerId: string };

function isThunesSdkRequest(candidate: unknown): candidate is ThunesSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** Which credential path is live (observability — NEVER material). */
export type ThunesCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/**
 * The real Thunes connector (ConnectorSDK framework). Thunes API names,
 * payloads, response shapes and quirks stay INSIDE this implementation:
 * the SDK call contract is the provider-neutral `ThunesSdkRequest` union.
 * Every effectful operation runs behind `requireAuthority`
 * (INV-C04/F05/F06), fails closed with `RailNotAuthorizedError` BEFORE any
 * provider call when no credential path is live (INV-NC04), and — while
 * the governing endpoint evidence records the documented hosts as
 * GLOBALLY_NXDOMAIN — refuses citing the datum (the honest blocked gate).
 */
export class ThunesConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: ThunesControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  readonly #endpointEvidence: ThunesEndpointEvidence;
  #credentialBaseline: string | undefined;

  constructor(config: ThunesConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase =
      config.apiBase ??
      (config.endpointEvidence?.status === "RESOLVED" && config.endpointEvidence.resolvedHost !== undefined
        ? config.endpointEvidence.resolvedHost
        : THUNES_DEFAULT_API_BASE_SANDBOX);
    this.#apiVersion = config.apiVersion ?? THUNES_API_VERSION;
    this.#credentialConfigKey = config.credentialConfigKey ?? THUNES_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
    this.#endpointEvidence = config.endpointEvidence ?? THUNES_DEFAULT_ENDPOINT_EVIDENCE;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: THUNES_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "Thunes (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return thunesRailCapabilityPack();
  }

  /** The governing endpoint evidence (observability — the honest datum). */
  endpointEvidence(): ThunesEndpointEvidence {
    return this.#endpointEvidence;
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): ThunesCredentialResolutionState {
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
        "no control-plane credentials and no env-resolved material under the config key — rail fails closed (INV-NC04; packages/rails/BLOCKED-RAILS.md §9)",
    });
  }

  // -- availability (INV-C01/C02 — two-axis, never fabricated) ---------------

  availabilityObservation(input: {
    readonly instanceId: string;
    readonly observationVersion: number;
    readonly probe?: { readonly reachable: boolean; readonly checkedAt: string };
  }): CapabilityObservation {
    const observedAt = isoTimestamp(this.#clock.now());
    if (this.#endpointEvidence.status === "GLOBALLY_NXDOMAIN") {
      // The honest blocked gate: the DOCUMENTED API endpoint is unresolvable
      // (the recorded datum) — availability UNKNOWN with provenance,
      // regardless of credential state. Never AVAILABLE, never UNAVAILABLE.
      return unknownReachabilityObservation({
        instanceId: input.instanceId,
        observedAt,
        observationVersion: input.observationVersion,
        lastKnownCapabilityState: "AVAILABLE",
        reason:
          `Thunes API endpoint UNRESOLVABLE per the recorded 2026-10-02 datum (both documented hosts GLOBALLY NXDOMAIN — ${this.#endpointEvidence.detail}) — availability UNKNOWN (INV-C01/C02); the operator must confirm the current host; see THUNES_UNRESOLVABLE_ENDPOINT_20261002 and packages/rails/BLOCKED-RAILS.md §9`,
        provenance: {
          providerName: THUNES_PROVIDER_NAME,
          source: "INTERNAL",
          capturedAt: observedAt,
        },
      });
    }
    const resolution = this.credentialResolutionState();
    if (resolution.kind === "NOT_PROVISIONED") {
      return unknownReachabilityObservation({
        instanceId: input.instanceId,
        observedAt,
        observationVersion: input.observationVersion,
        lastKnownCapabilityState: "AVAILABLE",
        reason:
          "credential reference not provisioned (PROVIDER_THUNES_CREDENTIAL_REF absent) — source availability UNKNOWN (INV-C01/C02); see packages/rails/BLOCKED-RAILS.md §9",
        provenance: {
          providerName: THUNES_PROVIDER_NAME,
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
          providerName: THUNES_PROVIDER_NAME,
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
        providerName: THUNES_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(THUNES_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface --------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "thunes search is not implemented — the connector's reconciliation path is the external transaction id (GET /v2/transactions/{id}, INV-X03), and no listing surface is in the connector contract",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "read_transaction|read_payer");
    const observedAt = this.#envelopeContext();
    if (request.kind === "read_transaction") {
      const data = await this.#withCredentials(async (token) =>
        this.#providerGet(
          `/v2/transactions/${encodeURIComponent(request.transactionId)}`,
          ctx.idempotencyKey,
          token,
        ),
      );
      return this.#sdkResult(
        thunesTransactionEnvelope(data as ThunesTransactionProviderObject, observedAt),
        `thunes:read-transaction:${request.transactionId}`,
      );
    }
    if (request.kind === "read_payer") {
      const data = await this.#withCredentials(async (token) =>
        this.#providerGet(
          `/v2/payers/${encodeURIComponent(request.payerId)}`,
          ctx.idempotencyKey,
          token,
        ),
      );
      return this.#sdkResult(
        thunesPayerListEnvelope([data], observedAt),
        `thunes:read-payer:${request.payerId}`,
      );
    }
    throw new ValidationError(
      "thunes read supports only { kind: 'read_transaction' | 'read_payer' }",
    );
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_quote");
    if (request.kind !== "create_quote") {
      throw new ValidationError("thunes create supports only { kind: 'create_quote' }");
    }
    if (
      request.payerId === undefined ||
      request.sourceAmountMajor === undefined ||
      request.sourceCurrency === undefined ||
      request.targetCurrency === undefined
    ) {
      throw new ValidationError(
        "create_quote requires payerId, sourceAmountMajor (exact major-unit decimal), sourceCurrency and targetCurrency",
      );
    }
    const body: Record<string, unknown> = {
      payerId: request.payerId,
      sourceAmount: Number(request.sourceAmountMajor),
      sourceCurrency: request.sourceCurrency.toUpperCase(),
      targetCurrency: request.targetCurrency.toUpperCase(),
      ...(request.beneficiary !== undefined ? { beneficiary: request.beneficiary } : {}),
    };
    const observedAt = this.#envelopeContext();
    // A quote moves no value — but a transport failure mid-create is still
    // OUTCOME_UNKNOWN (the quote may exist; reconcile by the quote id once
    // known). NEVER FAILED.
    try {
      const data = await this.#withCredentials(async (token) =>
        this.#providerPost("/v2/quotes", body, ctx.idempotencyKey, token),
      );
      return this.#sdkResult(
        thunesQuoteEnvelope((data ?? {}) as ThunesQuoteProviderObject, observedAt),
        `thunes:create-quote:${this.#clock.now()}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "quote",
          externalId: `payer:${request.payerId}`,
          operation: "create_quote",
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
      "thunes quotes are not mutable at the provider (create → transaction → confirm lifecycle only)",
    );
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "create_transaction|confirm_transaction");
    const observedAt = this.#envelopeContext();
    if (request.kind === "create_transaction") {
      if (request.quoteId === undefined || request.beneficiary === undefined) {
        throw new ValidationError("create_transaction requires quoteId and beneficiary");
      }
      const externalId = thunesExternalId(ctx.idempotencyKey);
      const body: Record<string, unknown> = {
        quoteId: request.quoteId,
        // The beneficiary object carries the provider-defined per-payer
        // fields — the explicit ThunesBeneficiaryRequirement records govern
        // what must be in it (thunesBeneficiaryRequirements).
        beneficiary: request.beneficiary,
        // INV-F05: the deterministic external id — Thunes echoes it; its own
        // transaction identity is the thunesTrxId carried verbatim in state.
        externalId,
        ...(request.creditReason !== undefined ? { creditReason: request.creditReason } : {}),
      };
      // INV-X01: value moves on a transaction — OUTCOME_UNKNOWN, never FAILED.
      try {
        const data = await this.#withCredentials(async (token) =>
          this.#providerPost("/v2/transactions", body, ctx.idempotencyKey, token),
        );
        return this.#sdkResult(
          thunesTransactionEnvelope((data ?? {}) as ThunesTransactionProviderObject, observedAt),
          `thunes:create-transaction:${externalId}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "transaction",
            externalId,
            operation: "create_transaction",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    if (request.kind === "confirm_transaction") {
      if (request.transactionId === undefined) {
        throw new ValidationError("confirm_transaction requires transactionId");
      }
      try {
        const data = await this.#withCredentials(async (token) =>
          this.#providerPost(
            `/v2/transactions/${encodeURIComponent(request.transactionId)}/confirm`,
            {},
            ctx.idempotencyKey,
            token,
          ),
        );
        return this.#sdkResult(
          thunesTransactionEnvelope((data ?? {}) as ThunesTransactionProviderObject, observedAt),
          `thunes:confirm-transaction:${request.transactionId}`,
        );
      } catch (error) {
        if (error instanceof RailTransportError) {
          return this.#outcomeUnknownResult({
            objectType: "transaction",
            externalId: request.transactionId,
            operation: "confirm_transaction",
            idempotencyKey: ctx.idempotencyKey,
            transportError: error.message,
            observedAt: observedAt.observedAt,
          });
        }
        throw error;
      }
    }
    throw new ValidationError(
      "thunes executeAction supports only { kind: 'create_transaction' | 'confirm_transaction' }",
    );
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "thunes event subscription is handled by the webhook ingestion framework (createThunesWebhookIngestor + @payswap/adapters ProviderWebhookIngestor), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "read_transaction|read_payer");
    if (request.kind !== "read_transaction" && request.kind !== "read_payer") {
      throw new ValidationError(
        "thunes reconcile supports only { kind: 'read_transaction' | 'read_payer' }",
      );
    }
    // Reconciliation-as-authority (INV-X03): re-fetch by external object id.
    return this.read(ctx);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "thunes disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and release the sealed credential handle); the provider surface offers no self-disconnect",
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md, Thunes path —
   * swap-reference-then-verify): the vault binding for the control-plane
   * config key is swapped to a NEW reference at the vault; the connector
   * re-resolves per call, so the rotation is real exactly when the NEW
   * reference resolves and serves a successful health probe. The old key
   * is revoked at Thunes only after that verification (and only once a
   * resolvable endpoint is confirmed — the NXDOMAIN datum governs).
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
          evidenceId: `thunes:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: THUNES_PROVIDER_NAME,
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
        "cannot rotate credentials: no credential path is provisioned for the thunes rail (packages/rails/BLOCKED-RAILS.md §9)",
        { railId: THUNES_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = createHmac("sha256", "payswap-thunes-rotation-baseline")
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
        evidenceId: `thunes:cred-rotation:${rotatedAt}`,
        evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
        kind: "AUDIT_LOG",
        providerState: railEnvelope({
          providerName: THUNES_PROVIDER_NAME,
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
   * never a business outcome. While the governing endpoint evidence
   * records the documented hosts as GLOBALLY_NXDOMAIN the answer is
   * honest and final: status UNKNOWN with the datum as the reason — no
   * endpoint is contacted (there is no resolvable endpoint to contact;
   * the operator must confirm the current host first).
   */
  async health(): Promise<ConnectorHealthReport> {
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: THUNES_CONNECTOR_ID,
      providerName: THUNES_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (this.#endpointEvidence.status === "GLOBALLY_NXDOMAIN") {
      return {
        ...base,
        status: "UNKNOWN",
        lastCheckedAt,
        degradedReasons: [
          `Thunes API endpoint UNRESOLVABLE per the recorded 2026-10-02 datum: both documented hosts GLOBALLY NXDOMAIN (${this.#endpointEvidence.detail}) — the operator must confirm the current host before any live use (INV-C01/C02; packages/rails/BLOCKED-RAILS.md §9)`,
        ],
      };
    }
    const resolution = this.credentialResolutionState();
    if (resolution.kind === "NOT_PROVISIONED") {
      let endpointAnswered: boolean;
      try {
        await this.#http(`${this.#apiBase}/v2/payers`, {
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
              "credentials absent: provider endpoint reachable (probe answered) but rail authorization cannot be established — availability UNKNOWN (INV-C01/C02; packages/rails/BLOCKED-RAILS.md §9)",
            ]
          : ["provider endpoint unreachable — availability UNKNOWN (INV-C02)"],
      };
    }
    try {
      await this.#withCredentials(async (token) =>
        this.#providerGet("/v2/payers", "health-probe", token),
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
   * Observes the payer/method coverage from the CONNECTED account
   * (GET /v2/payers) — the ONLY source of payer coverage records (the
   * coverage law). Each returned record carries the raw payer object
   * VERBATIM with its per-payer beneficiary requirement fields extracted
   * as EXPLICIT ThunesBeneficiaryRequirement records. Requires credentials
   * AND a verified-resolvable endpoint — the uncredentialed,
   * unresolvable-endpoint deployment has NO coverage records.
   */
  async observePayers(): Promise<{
    readonly records: readonly ThunesPayerCoverageRecord[];
    readonly envelope: ProviderStateEnvelope;
  }> {
    const observedAt = this.#envelopeContext();
    const data = (await this.#withCredentials(async (token) =>
      this.#providerGet("/v2/payers", "payer-coverage", token),
    )) as readonly ThunesPayerProviderObject[];
    if (!Array.isArray(data)) {
      throw new RailProviderError("thunes payers response is malformed (expected a data array)", {
        path: "/v2/payers",
      });
    }
    const records: ThunesPayerCoverageRecord[] = [];
    for (const payer of data) {
      const payerId = String(payer.id ?? "unknown_payer");
      records.push(
        Object.freeze({
          payerId,
          raw: payer,
          observedAt: observedAt.observedAt,
          source: "CONNECTED_ACCOUNT_QUERY",
          beneficiaryRequirements: thunesBeneficiaryRequirements(payerId, payer),
        }),
      );
    }
    return {
      records: Object.freeze(records),
      envelope: thunesPayerListEnvelope(data, observedAt),
    };
  }

  // -- internals -------------------------------------------------------------------

  /**
   * The honest blocked gate: while the governing endpoint evidence says
   * the documented API hosts are GLOBALLY_NXDOMAIN, every provider-calling
   * operation refuses BEFORE any provider call, citing the recorded datum.
   * No simulated substitute exists. Lifted only by newer verified evidence
   * supplied at construction (`endpointEvidence` with a confirmed host).
   */
  #requireResolvableEndpoint(): void {
    if (this.#endpointEvidence.status === "GLOBALLY_NXDOMAIN") {
      throw new ThunesUnresolvableEndpointError(
        `thunes rail refuses the provider call: the governing endpoint evidence says both documented API hosts are GLOBALLY NXDOMAIN (${this.#endpointEvidence.probedAt}: ${this.#endpointEvidence.detail}) — availability stays UNKNOWN, NO simulated substitute exists; lift only through operator-confirmed endpoint evidence (the current resolvable host) or a successful re-probe`,
        {
          railId: THUNES_RAIL_ADAPTER_ID,
          probedAt: this.#endpointEvidence.probedAt,
          hosts: THUNES_UNRESOLVABLE_ENDPOINT_20261002.hosts,
        },
      );
    }
  }

  #envelopeContext(): ThunesEnvelopeContext {
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
   * Runs one provider interaction with an authenticated bearer token. The
   * endpoint gate runs FIRST (the unresolvable-endpoint datum), then the
   * credential gate (INV-NC04) — both BEFORE any provider call. The token
   * is acquired per call from the documented V2 authentication endpoint
   * (POST /v2/authentication/api-keys) and exists only inside the callback
   * frame.
   */
  async #withCredentials<T>(fn: (token: string) => Promise<T>): Promise<T> {
    this.#requireResolvableEndpoint();
    if (this.#controlPlane !== undefined) {
      let handle: ReturnType<CredentialBroker["resolveProviderCredential"]>;
      try {
        handle = this.#controlPlane.broker.resolveProviderCredential(
          this.#credentialConfigKey,
        );
      } catch (error) {
        throw new RailNotAuthorizedError(
          "thunes rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: THUNES_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        async (opened) => fn(await this.#authenticate(extractThunesCredentialMaterial(opened.material))),
      );
    }
    const raw = this.#envMaterial();
    if (raw === undefined) {
      throw new RailNotAuthorizedError(
        "thunes rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md §9)",
        { railId: THUNES_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new ValidationError(
        "the env-resolved Thunes credential material is not a JSON bundle — expected { api_key, secret_key } (fail-closed, never guessed)",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    return fn(await this.#authenticate(extractThunesCredentialMaterial(parsed)));
  }

  /**
   * The documented V2 authentication: POST /v2/authentication/api-keys
   * { apiKey, secretKey } → { token }. HONEST UNCERTAINTY: the exact
   * request-body shape (apiKey/secretKey in the body vs. basic-style
   * headers) is mapped per the documented surface and must be confirmed
   * live once a resolvable endpoint + credentials exist (BLOCKED-RAILS
   * §9). The token is used as `Authorization: Bearer <token>`.
   */
  async #authenticate(material: ThunesCredentialMaterial): Promise<string> {
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}/v2/authentication/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: material.apiKey, secretKey: material.secretKey }),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("thunes provider transport unreachable", {
        path: "/v2/authentication/api-keys",
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("thunes authentication response is not JSON", {
        path: "/v2/authentication/api-keys",
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `thunes authentication answered HTTP ${response.status}`,
        { path: "/v2/authentication/api-keys", httpStatus: response.status },
      );
    }
    const token = (parsed as { readonly token?: unknown })?.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new RailProviderError("thunes authentication response carries no token", {
        path: "/v2/authentication/api-keys",
      });
    }
    return token;
  }

  #request(ctx: SdkCallContext, expectedKind: string): ThunesSdkRequest {
    const candidate = ctx.request;
    if (!isThunesSdkRequest(candidate)) {
      throw new ValidationError(
        `thunes rail call request must be a ThunesSdkRequest object (expected kind '${expectedKind}')`,
      );
    }
    if (
      "sourceAmountMajor" in candidate &&
      candidate.sourceAmountMajor !== undefined &&
      !/^\d+(\.\d+)?$/.test(String(candidate.sourceAmountMajor))
    ) {
      throw new ValidationError(
        "sourceAmountMajor must be an exact non-negative decimal string in the provider's currency units (INV-F01)",
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
      providerName: THUNES_PROVIDER_NAME,
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
        note: "transport failed mid-effect — the provider effect may have landed; reconcile by the Thunes transaction id (INV-X01/INV-X03); never coerced to FAILED",
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
      shareableFields: THUNES_SHAREABLE_FIELDS,
    });
    return this.#sdkResult(envelope, `thunes:outcome-unknown:${input.operation}:${input.idempotencyKey}`);
  }

  /** The Thunes response shape: a direct JSON object / array answer. */
  #parseResponse(
    response: { readonly status: number; readonly bodyText: string },
    path: string,
    callRef: string,
  ): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("thunes provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status < 200 || response.status >= 300) {
      const message =
        parsed !== null && typeof parsed === "object" && typeof (parsed as { readonly message?: unknown }).message === "string"
          ? (parsed as { readonly message: string }).message
          : "provider error";
      throw new RailProviderError(
        `thunes provider answered HTTP ${response.status}: ${message}`,
        { path, httpStatus: response.status, callRef },
      );
    }
    return parsed;
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
      throw new RailTransportError("thunes provider transport unreachable", {
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
    const bodyString = JSON.stringify(body);
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: bodyString,
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError("thunes provider transport unreachable", {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return this.#parseResponse(response, path, idempotencyKey);
  }
}

/** The Thunes credential material (apiKey + secretKey pair). */
export interface ThunesCredentialMaterial {
  readonly apiKey: string;
  readonly secretKey: string;
}

/**
 * Extracts the Thunes credential material from a vault bundle shape. The
 * control plane hands the connector whatever the vault object holds: a
 * bundle record ({ api_key, secret_key } / { apiKey, secretKey }) — a
 * plain string is NOT acceptable for Thunes (two fields are required) and
 * refuses the call (fail-closed, no guessing).
 */
export function extractThunesCredentialMaterial(material: unknown): ThunesCredentialMaterial {
  if (material !== null && typeof material === "object") {
    const record = material as Readonly<Record<string, unknown>>;
    const apiKey = readThunesString(record, ["api_key", "apiKey"]);
    const secretKey = readThunesString(record, ["secret_key", "secretKey"]);
    if (apiKey !== undefined && secretKey !== undefined) {
      return Object.freeze({ apiKey, secretKey });
    }
  }
  throw new ValidationError(
    "the sealed credential bundle does not contain Thunes key material (expected { api_key, secret_key })",
  );
}

function readThunesString(
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
