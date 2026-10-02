/**
 * Mobile-money rail adapter — collection (request-to-pay) + mandate
 * semantics on the RailAdapter framework (W1-005; REAL API mapping + honest
 * BLOCKED state extended P2-W3-001).
 *
 * PAYMENT-OPERATING-PLANE + LOSSLESS-CONNECTOR-CAPABILITY-MODEL: the
 * customer-action-required pattern is CONSEQUENTIAL in mobile money — the
 * payer must approve a USSD/push prompt on their handset before any value
 * moves. The adapter represents that through the provider state (family
 * `customer_action_required` with a `USSD_APPROVAL` action + the provider's
 * prompt reference), NEVER flattened into a generic "pending" or error
 * (INV-C06). Recurring-debit mandates preserve their own lifecycle family
 * (`mandate`), so renewal/authority checks (reconcileMandateRenewal on the
 * settlement plane) keep operating on real provider semantics.
 *
 * P2-W3-001 REAL API MAPPING (the MTN MoMo contract, live-observed shape):
 * - OAuth2 Basic token acquisition POST /collection/token/ (API user + API
 *   key → Bearer access token), per product, through the credential surface;
 * - requesttopay lifecycle POST /collection/v1_0/requesttopay: X-Reference-Id
 *   (a UUID) is the request's idempotency key, X-Target-Environment scopes
 *   the market, `externalId` carries the merchant reference; the provider
 *   answers 202 Accepted with an EMPTY body (the synthesized PENDING state
 *   documents that answer); status polling GET
 *   /collection/v1_0/requesttopay/{referenceId} is the reconciliation path
 *   (PENDING/ONGOING/SUCCESSFUL/FAILED/TIMEOUT with reason codes preserved
 *   VERBATIM in the failure metadata);
 * - GET /collection/v1_0/account/balance is observed as an
 *   ExternalFundsPositionObservation ONLY (INV-C09 — provider-held funds,
 *   never custody), converted to exact minor units with bigint arithmetic
 *   (INV-F01).
 *
 * THE HONEST BLOCKED STATE: the LIVE probe of 2026-10-02 recorded the
 * sandbox subscription key REJECTED at the APIM gate (HTTP 401 "Access
 * denied due to invalid subscription key") across the collection,
 * disbursement and remittance products — the API user/key pair was never
 * evaluated (spec/development-state/provider-probes-20261002.json). The
 * connector therefore proceeds FAIL-CLOSED: availability stays UNKNOWN
 * (INV-C01/C02), and on the control-plane path (whose vault reference names
 * exactly the probe-blocked credential) every provider-calling operation
 * REFUSES with `MtnMomoBlockedProbeError` citing the recorded datum until a
 * successful authenticated re-probe (`probeAuthentication`) or explicit
 * newer evidence lifts the gate. NO simulated substitute exists.
 *
 * Real-network policy: MTN MoMo is credential-gated (subscription key +
 * provisioned API user). Without provisioned references the rail reports
 * UNKNOWN availability with provenance (INV-C01/C02 — BLOCKED-RAILS.md) and
 * fails closed (INV-NC04). No simulated settlement ever occurs.
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
import {
  RailNotAuthorizedError,
  RailProviderError,
  RailTransportError,
  exactRationalFromDecimal,
  railEnvelope,
  railEvidence,
  realHttpTransport,
  resolveCredentialRefs,
  routableRailImplication,
  isoTimestamp,
} from "./support.js";
import type { HttpTransport, RailImplication, CredentialSourceDeclaration } from "./support.js";

// ---------------------------------------------------------------------------
// Capability + pack (consumed W2-003 vocabulary, never redefined)
// ---------------------------------------------------------------------------

export const MOBILE_MONEY_RAIL_CAPABILITY_ID = "cap.rails.mobile_money.collect" as const;
export const MOBILE_MONEY_RAIL_ADAPTER_ID = "rail.mobile_money.mtn_momo" as const;
export const MOBILE_MONEY_RAIL_IMPLEMENTATION_ID = "impl.rails.mobile_money.mtn_momo" as const;
export const MOBILE_MONEY_PROVIDER_NAME = "mtn-momo" as const;
export const MOBILE_MONEY_PROVIDER_VERSION = "1.0.0" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("mtn-momo")` —
 * `PROVIDER_MTN_MOMO_CREDENTIAL_REF`, bound to
 * `vault://payswap/providers/mtn-momo/sandbox-20261002` (the credential the
 * 2026-10-02 live probe recorded as BLOCKED at the APIM gate).
 */
export const MTN_MOMO_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  MOBILE_MONEY_PROVIDER_NAME,
);

// ---------------------------------------------------------------------------
// The honest BLOCKED state (recorded live-probe datum — P2-W3-001)
// ---------------------------------------------------------------------------

/** The evidence state of the authenticated provider probe. */
export type MtnMomoProbeEvidenceStatus = "BLOCKED" | "VERIFIED" | "UNKNOWN" | "UNPROBED";

/** One authenticated-probe evidence record governing the blocked gate. */
export interface MtnMomoProbeEvidence {
  readonly status: MtnMomoProbeEvidenceStatus;
  /** ISO-8601 UTC — when the probe ran (or was recorded). */
  readonly probedAt: string;
  readonly detail: string;
  /** The recorded HTTP status when the provider answered, if known. */
  readonly httpStatus?: number;
}

/**
 * The RECORDED blocked-probe datum (2026-10-02): the sandbox subscription
 * key was REJECTED at the APIM gate (HTTP 401 "Access denied due to invalid
 * subscription key") across the collection, disbursement and remittance
 * products — the API user/key pair was never evaluated. Honest consequences
 * encoded verbatim from the probe record: availability UNKNOWN, effectful
 * operations refused (fail-closed), NO simulated substitute; re-probe when
 * a valid subscription key is supplied.
 */
export const MTN_MOMO_BLOCKED_PROBE_20261002: MtnMomoProbeEvidence = Object.freeze({
  status: "BLOCKED",
  probedAt: "2026-10-02T06:37:38Z",
  detail:
    "subscription key rejected at the APIM gate (HTTP 401 'Access denied due to invalid subscription key') on collection, disbursement and remittance products; API-user/API-key never evaluated",
  httpStatus: 401,
});

/**
 * Raised while the governing probe evidence says the provider credential is
 * BLOCKED: every provider-calling operation refuses BEFORE any provider
 * call, citing the recorded datum — availability stays UNKNOWN (INV-C01/C02)
 * and NO simulated substitute exists. Lifted only by a successful
 * authenticated re-probe (`probeAuthentication`) or newer explicit evidence
 * supplied at construction.
 */
export class MtnMomoBlockedProbeError extends RailNotAuthorizedError {
  constructor(message: string, details?: ConstructorParameters<typeof RailNotAuthorizedError>[1]) {
    super(message, details);
    this.name = "MtnMomoBlockedProbeError";
  }
}

/** The MTN MoMo credential material shape (both bundle naming conventions). */
export interface MtnMomoCredentialMaterial {
  readonly subscriptionKey: string;
  readonly apiUser: string;
  readonly apiKey: string;
  /** X-Target-Environment (e.g. "sandbox", a production market id). */
  readonly targetEnvironment?: string;
}

/**
 * Extracts the MTN MoMo credential material from a vault bundle shape: a
 * record carrying subscriptionKey/subscription_key, apiUser/api_user and
 * apiKey/api_key (targetEnvironment/target_environment optional). The
 * subscription key, API user and API key are ALL required — a partial bundle
 * refuses the call (fail-closed, no guessing, no empty-string credentials).
 */
export function extractMtnMomoCredentialBundle(material: unknown): MtnMomoCredentialMaterial {
  if (material === null || typeof material !== "object") {
    throw new ValidationError(
      "the sealed credential bundle must be an MTN MoMo credential record ({ subscriptionKey, apiUser, apiKey, targetEnvironment? })",
    );
  }
  const record = material as Readonly<Record<string, unknown>>;
  const read = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    return undefined;
  };
  const subscriptionKey = read(["subscriptionKey", "subscription_key"]);
  const apiUser = read(["apiUser", "api_user"]);
  const apiKey = read(["apiKey", "api_key"]);
  const targetEnvironment = read(["targetEnvironment", "target_environment"]);
  if (subscriptionKey === undefined || apiUser === undefined || apiKey === undefined) {
    throw new ValidationError(
      "the sealed credential bundle does not contain the complete MTN MoMo credential material (subscriptionKey + apiUser + apiKey are all required — a partial bundle refuses the call)",
    );
  }
  return Object.freeze({
    subscriptionKey,
    apiUser,
    apiKey,
    ...(targetEnvironment !== undefined ? { targetEnvironment } : {}),
  });
}

// ---------------------------------------------------------------------------
// Account-balance observation (INV-C09 — provider-held funds, never custody)
// ---------------------------------------------------------------------------

/**
 * The minor-unit exponents for the MTN MoMo collection currencies (ISO 4217;
 * EUR/UGX/GHS are the sandbox-documented set). A currency outside this
 * table has an UNKNOWN exponent — the observation refuses rather than
 * guessing (INV-F01).
 */
export const MTN_MOMO_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  EUR: 2,
  GHS: 2,
  UGX: 0,
  XOF: 0,
  XAF: 0,
  RWF: 0,
  TZS: 2,
  ZMW: 2,
});

/** The raw MoMo account-balance answer (opaque passthrough). */
export interface MtnMomoAccountBalanceProviderObject {
  readonly availableBalance?: string | number;
  readonly currency?: string;
  readonly [key: string]: unknown;
}

/** The exact minor-units conversion of a MoMo major-unit decimal string. */
export function mtnMomoMinorUnits(majorDecimal: string, currency: string): string {
  const exponent = MTN_MOMO_CURRENCY_EXPONENTS[currency.toUpperCase()];
  if (exponent === undefined) {
    throw new ValidationError(
      `unknown minor-unit exponent for MoMo balance currency '${currency.toUpperCase()}' — never guessed (INV-F01; add the exponent when the provider documents it)`,
    );
  }
  const { numerator, denominator } = exactRationalFromDecimal(String(majorDecimal));
  const d = BigInt(denominator.toString().length - 1);
  const e = BigInt(exponent);
  if (e >= d) {
    return (numerator * 10n ** (e - d)).toString();
  }
  const factor = 10n ** (d - e);
  if (numerator % factor !== 0n) {
    throw new ValidationError(
      `MoMo balance '${String(majorDecimal)}' ${currency.toUpperCase()} carries sub-minor precision — cannot be represented in exact minor units (INV-F01)`,
    );
  }
  return (numerator / factor).toString();
}

/**
 * Maps a GET /collection/v1_0/account/balance answer to ONE
 * ExternalFundsPositionObservation of PROVIDER-HELD funds on the collection
 * account (INV-C09): an observation of provider-held external funds — NOT
 * PaySwap custody, NOT a balance PaySwap owes anyone. The balance converts
 * to exact minor units at the currency's exponent (INV-F01); an unknown
 * currency exponent refuses the whole observation (single datum — a
 * fail-closed refusal is the honest answer, never a skipped balance).
 */
export function mtnMomoBalanceObservation(input: {
  readonly balance: MtnMomoAccountBalanceProviderObject;
  readonly accountRef: string;
  readonly observedAt: string;
  readonly maxAgeSeconds?: number;
}): ExternalFundsPositionObservation {
  if (
    input.balance === null ||
    typeof input.balance !== "object" ||
    typeof input.balance.currency !== "string" ||
    input.balance.currency.length === 0 ||
    (typeof input.balance.availableBalance !== "string" &&
      typeof input.balance.availableBalance !== "number")
  ) {
    throw new RailProviderError(
      "MoMo account balance answer is malformed (expected { availableBalance, currency })",
    );
  }
  const currency = input.balance.currency.toUpperCase();
  const minorUnits = mtnMomoMinorUnits(String(input.balance.availableBalance), currency);
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  return Object.freeze({
    observationKind: "ExternalFundsPositionObservation" as const,
    observationId: `mtn-momo-balance:collection:${currency}`,
    observedAt: input.observedAt,
    freshness: Object.freeze({
      asOf: input.observedAt,
      maxAgeSeconds,
    }),
    location: Object.freeze({
      providerName: MOBILE_MONEY_PROVIDER_NAME,
      accountRef: input.accountRef,
      instrumentRef: `collection:balance:${currency}`,
      description:
        "MTN MoMo collection account balance (provider-held external funds — observation, never custody)",
    }),
    observedAmount: Object.freeze({
      currency,
      minorUnits,
    }),
    provenance: Object.freeze({
      providerName: MOBILE_MONEY_PROVIDER_NAME,
      source: "PROVIDER_API" as const,
      capturedAt: input.observedAt,
    }),
    reconciliationState: "NOT_RECONCILED" as const,
  });
}

/** The canonical capability definition consumed by the mobile-money rail. */
export function mobileMoneyRailCapabilityDefinition(): CapabilityDefinition {
  return validateCapabilityDefinition({
    capabilityId: MOBILE_MONEY_RAIL_CAPABILITY_ID,
    capabilityVersion: "1.0.0",
    summary: "Mobile-money collection (request-to-pay) with handset approval and recurring mandates",
    kind: "ACTION",
    requiredPermissions: ["payments:write"],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: "rails.mobile_money.request_to_pay",
      stateMachine: {
        documentRef: "spec/architecture/PAYMENT-OPERATING-PLANE.md",
        version: "1",
      },
      description:
        "Request a mobile-money payment from a payer who must approve a USSD/push prompt on their handset; recurring debits run under an explicit provider mandate",
    },
    preconditions: [
      "connected instance authorized and eligible",
      "credential references provisioned (control-plane PROVIDER_MTN_MOMO_CREDENTIAL_REF sealed bundle, or the env-driven refs — CREDENTIAL-ROTATION.md)",
      "the governing authenticated-probe evidence is not BLOCKED (the 2026-10-02 subscription-key rejection at the APIM gate — BLOCKED-RAILS.md; no simulated substitute)",
      "payer MSISDN reachable on the provider network",
    ],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["payments:execute", "collections:write"],
      customerConsent: "EXPLICIT",
    },
    sideEffects: [
      { effect: "moves payer wallet value on handset approval", financialEffect: "MOVES_VALUE", reversible: false },
    ],
    idempotency: {
      idempotent: true,
      keyScope: "PROVIDER_ACCOUNT",
      duplicateBehavior: "RETURNED_SAME_RESULT",
      retryPolicy: "REQUIRES_RECONCILIATION",
    },
    compensation: {
      compensable: false,
      cancellation: "BEFORE_EXECUTION",
      partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
    },
    requiredCustomerActions: [
      {
        action: "approve_handset_prompt",
        actor: "CUSTOMER",
        description: "Approve the USSD/push payment prompt sent to the payer handset",
        surfaceHint: "provider_prompt_reference",
      },
    ],
    providerVocabulary: {
      actions: [
        { action: "request_to_pay", description: "Create a collection request toward the payer" },
        { action: "mandate.create", description: "Create a recurring-debit mandate" },
        { action: "mandate.cancel", description: "Cancel a recurring-debit mandate" },
      ],
      states: [
        { providerState: "PENDING", canonicalState: "customer_action_required:handset_approval_pending", requiresCustomerAction: true, isTerminal: false },
        { providerState: "ONGOING", canonicalState: "async_processing:ongoing", requiresCustomerAction: false, isTerminal: false },
        { providerState: "SUCCESSFUL", canonicalState: "other:successful", requiresCustomerAction: false, isTerminal: true },
        { providerState: "FAILED", canonicalState: "other:failed", requiresCustomerAction: false, isTerminal: true },
        { providerState: "TIMEOUT", canonicalState: "other:timeout", requiresCustomerAction: false, isTerminal: true },
        { providerState: "mandate.created", canonicalState: "mandate:created", requiresCustomerAction: true, isTerminal: false },
        { providerState: "mandate.active", canonicalState: "mandate:active", requiresCustomerAction: false, isTerminal: false },
        { providerState: "mandate.suspended", canonicalState: "mandate:suspended", requiresCustomerAction: false, isTerminal: false },
        { providerState: "mandate.cancelled", canonicalState: "mandate:cancelled", requiresCustomerAction: false, isTerminal: true },
      ],
    },
    externalObjects: [
      {
        objectType: "request_to_pay",
        idFormat: "uuid",
        revisioned: true,
        revisionFormat: "provider-status-etag",
      },
      {
        objectType: "mandate",
        idFormat: "mandate_[A-Za-z0-9]+",
        revisioned: true,
        revisionFormat: "provider-status-etag",
      },
    ],
    evidence: { produced: ["EXECUTION", "STATE_OBSERVATION"], required: ["AUTHORIZATION"] },
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "MNO wallet settlement" },
    constraints: [
      {
        kind: "JURISDICTION",
        description: "Mobile-money collection availability follows the operator's licensed markets",
      },
    ],
  });
}

/** The connector capability pack backing the mobile-money rail. */
export function mobileMoneyRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.mobile_money",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: [
      { capabilityId: MOBILE_MONEY_RAIL_CAPABILITY_ID, capabilityVersion: "1.0.0" },
    ],
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "collections:write"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [
      { schemaId: "schema.rails.mobile_money.request_to_pay", version: "1.0.0" },
      { schemaId: "schema.rails.mobile_money.mandate", version: "1.0.0" },
    ],
    objectMappings: [
      {
        externalObjectType: "request_to_pay",
        canonicalObjectRef: "payswap:payment",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "mandate",
        canonicalObjectRef: "payswap:recurring_mandate",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 60, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-01T00:00:00.000Z",
      contentHash: "hash:rails-momo-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Provider state classification (INV-C06 — USSD/push + mandate preserved)
// ---------------------------------------------------------------------------

/** Provider-native request-to-pay statuses (raw vocabulary, preserved verbatim). */
export const MOBILE_MONEY_REQUEST_STATES = [
  "PENDING",
  "ONGOING",
  "SUCCESSFUL",
  "FAILED",
  "TIMEOUT",
] as const;

export type MobileMoneyRequestState = (typeof MOBILE_MONEY_REQUEST_STATES)[number];

/** Provider-native recurring-debit mandate states. */
export const MOBILE_MONEY_MANDATE_STATES = [
  "mandate.created",
  "mandate.active",
  "mandate.suspended",
  "mandate.cancelled",
] as const;

export type MobileMoneyMandateState = (typeof MOBILE_MONEY_MANDATE_STATES)[number];

/** The raw provider request-to-pay object as observed (opaque passthrough). */
export interface MobileMoneyRequestProviderObject {
  readonly referenceId: string;
  readonly status: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly payer?: { readonly partyIdType?: string; readonly partyId?: string };
  readonly reason?: { readonly code?: string; readonly message?: string };
  readonly [key: string]: unknown;
}

/** The raw provider mandate object as observed (opaque passthrough). */
export interface MobileMoneyMandateProviderObject {
  readonly mandateId: string;
  readonly status: string;
  readonly payer?: { readonly partyIdType?: string; readonly partyId?: string };
  readonly [key: string]: unknown;
}

/** The envelope input the deterministic mapper derives from. */
export interface MobileMoneyEnvelopeInput {
  readonly objectType: "request_to_pay" | "mandate";
  readonly externalId: string;
  readonly rawState: unknown;
  readonly status: string;
  readonly revision: string;
  readonly observedAt: string;
  /** The provider's prompt reference for the handset approval, when present. */
  readonly promptReference?: string;
  /** USSD deep link the provider surfaces for the approval prompt, if any. */
  readonly ussdDeepLink?: string;
  readonly failureReason?: { readonly code?: string; readonly message?: string };
  readonly fetchId?: string;
}

/**
 * Deterministic, additive classification of one mobile-money provider object
 * into a lossless ProviderStateEnvelope (INV-C06):
 *
 * - `PENDING` → family `customer_action_required` with a `USSD_APPROVAL`
 *   action carrying the provider's prompt reference / deep link — the
 *   handset-approval pattern is preserved as provider state, not flattened;
 * - `ONGOING` → `async_processing`;
 * - `SUCCESSFUL` → terminal;
 * - `FAILED` / `TIMEOUT` → terminal with definitive failure metadata
 *   (ambiguity NONE — the provider documents these as final statuses; the
 *   raw status and reason stay verbatim for support/audit);
 * - `mandate.*` → the `mandate` family so recurring-authority semantics
 *   (renewal, suspension, cancellation) round-trip losslessly.
 * Unknown statuses fall through to the total 'other' family VERBATIM.
 */
export function mobileMoneyEnvelope(input: MobileMoneyEnvelopeInput): ProviderStateEnvelope {
  const base = {
    providerName: MOBILE_MONEY_PROVIDER_NAME,
    providerVersion: MOBILE_MONEY_PROVIDER_VERSION,
    objectType: input.objectType,
    externalId: input.externalId,
    revision: input.revision,
    state: input.rawState,
    observedAt: input.observedAt,
    provenanceSource: "PROVIDER_API" as const,
    ...(input.fetchId !== undefined ? { fetchId: input.fetchId } : {}),
  };
  switch (input.status) {
    case "PENDING":
      return railEnvelope({
        ...base,
        family: "customer_action_required",
        lifecycleStep: "handset_approval_pending",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "USSD_APPROVAL",
          message:
            input.promptReference !== undefined
              ? `Approve the payment prompt on your handset (provider prompt reference: ${input.promptReference})`
              : "Approve the payment prompt on your handset",
          ...(input.ussdDeepLink !== undefined ? { deepLink: input.ussdDeepLink } : {}),
        },
      });
    case "ONGOING":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "ongoing",
        isTerminal: false,
        requiresCustomerAction: false,
      });
    case "SUCCESSFUL":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "successful",
        isTerminal: true,
        requiresCustomerAction: false,
      });
    case "FAILED":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "failed",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: input.failureReason?.code ?? "MOBILE_MONEY_FAILED",
          ...(input.failureReason?.message !== undefined
            ? { providerErrorMessage: input.failureReason.message }
            : {}),
          retryable: true,
          ambiguity: "NONE",
        },
      });
    case "TIMEOUT":
      // Provider-documented final status for request-to-pay: the prompt
      // expired without approval. Definitive no-effect; a NEW request under
      // a NEW idempotency key is a new attempt (the raw status stays
      // verbatim — INV-C06).
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "timeout",
        isTerminal: true,
        requiresCustomerAction: false,
        failure: {
          providerErrorCode: "MOBILE_MONEY_PROMPT_TIMEOUT",
          retryable: true,
          ambiguity: "NONE",
        },
      });
    case "mandate.created":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "created",
        isTerminal: false,
        requiresCustomerAction: true,
        actionRequired: {
          kind: "USSD_APPROVAL",
          message:
            "Approve the recurring-debit mandate authorization prompt on your handset",
          ...(input.ussdDeepLink !== undefined ? { deepLink: input.ussdDeepLink } : {}),
        },
      });
    case "mandate.active":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "active",
        isTerminal: false,
        requiresCustomerAction: false,
      });
    case "mandate.suspended":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "suspended",
        isTerminal: false,
        requiresCustomerAction: false,
      });
    case "mandate.cancelled":
      return railEnvelope({
        ...base,
        family: "mandate",
        lifecycleStep: "cancelled",
        isTerminal: true,
        requiresCustomerAction: false,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: input.status,
        isTerminal: false,
        requiresCustomerAction: false,
      });
  }
}

// ---------------------------------------------------------------------------
// The RailAdapter
// ---------------------------------------------------------------------------

/** The mobile-money rail adapter on the W3-003 framework. */
export class MtnMomoRail extends BaseRailAdapter {
  readonly adapterId = MOBILE_MONEY_RAIL_ADAPTER_ID;
  readonly implementationId = MOBILE_MONEY_RAIL_IMPLEMENTATION_ID;

  constructor() {
    super(mobileMoneyRailCapabilityPack(), new Map([[MOBILE_MONEY_RAIL_CAPABILITY_ID, mobileMoneyRailCapabilityDefinition()]]));
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK framework; credential-gated)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface MtnMomoControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface MtnMomoClientConfig {
  readonly clock: ProtocolClock;
  /** Provider API base (default: the real MTN MoMo sandbox). */
  readonly apiBase?: string;
  readonly apiVersion?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("mtn-momo")` = PROVIDER_MTN_MOMO_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: MtnMomoControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
  /**
   * X-Target-Environment for the collection product (default "sandbox";
   * production uses the provider's market ids, e.g. "mtnuganda").
   */
  readonly targetEnvironment?: string;
  /**
   * The governing authenticated-probe evidence. DEFAULTS: on the
   * control-plane path (whose vault reference names exactly the credential
   * the 2026-10-02 probe recorded as BLOCKED) to
   * MTN_MOMO_BLOCKED_PROBE_20261002; on the env path to an UNPROBED record
   * (unattributed material — the provider answer is the truth, availability
   * stays UNKNOWN). A caller holding NEWER verified evidence supplies it
   * here; `probeAuthentication()` updates it live.
   */
  readonly probeEvidence?: MtnMomoProbeEvidence;
}

interface MomoCallRequest {
  readonly kind:
    | "request_to_pay"
    | "read_request"
    | "read_mandate"
    | "create_mandate"
    | "cancel_mandate"
    | "reconcile_request";
  readonly referenceId?: string;
  readonly mandateId?: string;
  readonly amountMinor?: string;
  readonly currency?: string;
  readonly payerMsisdn?: string;
  readonly payerNote?: string;
  readonly payeeNote?: string;
}

export type MobileMoneySdkRequest = MomoCallRequest;

/** The honest evidence record when no probe has run (env path default). */
const MTN_MOMO_UNPROBED_EVIDENCE: MtnMomoProbeEvidence = Object.freeze({
  status: "UNPROBED",
  probedAt: "1970-01-01T00:00:00.000Z",
  detail:
    "no authenticated probe evidence recorded for this credential path — availability UNKNOWN (INV-C01/C02); run probeAuthentication() to establish the truth",
});

/**
 * The MTN MoMo provider client on the ConnectorSDK framework. Provider API
 * paths, headers and quirks stay INSIDE this implementation. Effectful
 * operations run behind `requireAuthority` (INV-C04/INV-F06, INV-F05) and
 * fail closed when the credential surface is not provisioned (INV-NC04) or
 * when the governing probe evidence says the credential is BLOCKED (the
 * recorded 2026-10-02 APIM-gate rejection — no simulated substitute).
 */
export class MtnMomoClient extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: MtnMomoControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  readonly #targetEnvironment: string;
  #probeEvidence: MtnMomoProbeEvidence;
  readonly #credentialDeclarations: readonly CredentialSourceDeclaration[] = Object.freeze([
    Object.freeze({
      railId: MOBILE_MONEY_RAIL_ADAPTER_ID,
      envVar: "PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF",
      kind: "API_KEY" as const,
      description: "MTN MoMo product subscription key reference",
    }),
    Object.freeze({
      railId: MOBILE_MONEY_RAIL_ADAPTER_ID,
      envVar: "PAYSWAP_RAILS_MOMO_API_USER_REF",
      kind: "PROVIDER_DEFINED" as const,
      description: "Provisioned MTN MoMo API user id reference",
    }),
    Object.freeze({
      railId: MOBILE_MONEY_RAIL_ADAPTER_ID,
      envVar: "PAYSWAP_RAILS_MOMO_API_KEY_REF",
      kind: "PROVIDER_DEFINED" as const,
      description: "Provisioned MTN MoMo API user secret reference",
    }),
  ]);
  #cachedCredentialRefs: Readonly<Record<string, string>> | undefined;

  constructor(config: MtnMomoClientConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase = config.apiBase ?? "https://sandbox.momodeveloper.mtn.com";
    this.#apiVersion = config.apiVersion ?? MOBILE_MONEY_PROVIDER_VERSION;
    this.#credentialConfigKey =
      config.credentialConfigKey ?? MTN_MOMO_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env ?? process.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
    this.#targetEnvironment = config.targetEnvironment ?? "sandbox";
    this.#probeEvidence =
      config.probeEvidence ??
      (config.credentials !== undefined
        ? MTN_MOMO_BLOCKED_PROBE_20261002
        : MTN_MOMO_UNPROBED_EVIDENCE);
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: MOBILE_MONEY_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "MTN Mobile Money (collection rail)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return mobileMoneyRailCapabilityPack();
  }

  // -- availability (INV-C01/C02 — two-axis, never fabricated) ---------------

  /** The rail's credential surface declaration (refs only — never values). */
  credentialSurface(): readonly CredentialSourceDeclaration[] {
    return this.#credentialDeclarations;
  }

  /**
   * The governing authenticated-probe evidence (the honest BLOCKED state
   * surface — never material, never a credential value).
   */
  currentProbeEvidence(): MtnMomoProbeEvidence {
    return this.#probeEvidence;
  }

  /**
   * Two-axis availability observation: without ALL provisioned credential
   * references the source axis is UNKNOWN → derived availability UNKNOWN
   * (INV-C01/C02 — BLOCKED-RAILS.md). With the control-plane credential
   * whose governing probe evidence is BLOCKED (the recorded 2026-10-02 APIM
   * gate rejection), availability stays UNKNOWN citing the datum. A
   * caller-supplied live probe may upgrade the source axis; nothing
   * fabricates it.
   */
  availabilityObservation(input: {
    readonly instanceId: string;
    readonly observationVersion: number;
    readonly probe?: { readonly reachable: boolean; readonly checkedAt: string };
  }): CapabilityObservation {
    const credentials = this.#currentCredentialRefs();
    const observedAt = isoTimestamp(this.now());
    if (!credentials.provisioned) {
      return unknownReachabilityObservation({
        instanceId: input.instanceId,
        observedAt,
        observationVersion: input.observationVersion,
        lastKnownCapabilityState: "AVAILABLE",
        reason:
          "mobile-money credential references not fully provisioned (subscription key + API user) — source availability UNKNOWN (INV-C01/C02); see packages/rails/BLOCKED-RAILS.md",
        provenance: {
          providerName: MOBILE_MONEY_PROVIDER_NAME,
          source: "INTERNAL",
          capturedAt: observedAt,
        },
      });
    }
    if (this.#probeEvidence.status === "BLOCKED") {
      return unknownReachabilityObservation({
        instanceId: input.instanceId,
        observedAt,
        observationVersion: input.observationVersion,
        lastKnownCapabilityState: "AVAILABLE",
        reason: `mobile-money credential BLOCKED by recorded probe evidence (${this.#probeEvidence.probedAt}): ${this.#probeEvidence.detail} — source availability UNKNOWN (INV-C01/C02); no simulated substitute (packages/rails/BLOCKED-RAILS.md)`,
        provenance: {
          providerName: MOBILE_MONEY_PROVIDER_NAME,
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
          providerName: MOBILE_MONEY_PROVIDER_NAME,
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
        providerName: MOBILE_MONEY_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN availability is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(MOBILE_MONEY_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface ---------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "mobile-money rail search is not implemented (the provider collection API exposes no listing surface)",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "read_request");
    if (request.referenceId === undefined) {
      throw new ValidationError("read_request requires referenceId");
    }
    const raw = await this.#providerGet(`/collection/v1_0/requesttopay/${request.referenceId}`);
    return this.#requestResult(raw, request.referenceId, `momo:read:${request.referenceId}`);
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "request_to_pay");
    if (
      request.amountMinor === undefined ||
      request.currency === undefined ||
      request.payerMsisdn === undefined
    ) {
      throw new ValidationError(
        "request_to_pay requires amountMinor, currency and payerMsisdn (exact minor units)",
      );
    }
    // X-Reference-Id is the request's idempotency key at MTN (a UUID): it
    // defaults to the protocol idempotency key (callers SHOULD use
    // UUID-shaped keys) and may be overridden per request. The body's
    // externalId carries the merchant reference (the protocol key).
    const referenceId = request.referenceId ?? ctx.idempotencyKey;
    // The provider answers 202 Accepted with an EMPTY body — the payment
    // then waits for the payer's handset approval (customer-action-required
    // semantics preserved; INV-C06). The synthesized state documents that
    // answer honestly.
    const raw = await this.#providerPost(
      "/collection/v1_0/requesttopay",
      {
        amount: request.amountMinor,
        currency: request.currency,
        payer: { partyIdType: "MSISDN", partyId: request.payerMsisdn },
        ...(request.payerNote !== undefined ? { payerNote: request.payerNote } : {}),
        ...(request.payeeNote !== undefined ? { payeeNote: request.payeeNote } : {}),
        externalId: ctx.idempotencyKey,
      },
      referenceId,
    );
    const candidate = raw as Partial<MobileMoneyRequestProviderObject>;
    const referenceId2 =
      typeof candidate.referenceId === "string" && candidate.referenceId.length > 0
        ? candidate.referenceId
        : referenceId;
    return this.#requestResult(
      { ...(raw as Readonly<Record<string, unknown>>), referenceId: referenceId2 },
      referenceId2,
      `momo:request:${referenceId2}`,
    );
  }

  async update(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "mobile-money request-to-pay objects are not mutable at the provider (create/read/cancel semantics only)",
    );
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "cancel_mandate");
    if (request.mandateId === undefined) {
      throw new ValidationError("cancel_mandate requires mandateId");
    }
    const raw = await this.#providerPost(
      `/collection/v1_0/mandate/${request.mandateId}/cancel`,
      {},
      ctx.idempotencyKey,
    );
    return this.#mandateResult(raw, request.mandateId, `momo:mandate-cancel:${request.mandateId}`);
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "mobile-money event subscription is handled by the webhook ingestion framework (@payswap/adapters webhooks), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "reconcile_request");
    if (request.referenceId === undefined) {
      throw new ValidationError("reconcile_request requires referenceId");
    }
    // INV-X03: reconciliation re-fetches by external reference id — exactly
    // what the webhook-loss recovery connector drives (status polling is
    // THE reconciliation path at MTN MoMo).
    const raw = await this.#providerGet(`/collection/v1_0/requesttopay/${request.referenceId}`);
    return this.#requestResult(raw, request.referenceId, `momo:reconcile:${request.referenceId}`);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "mobile-money disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and the credential references); no provider self-disconnect endpoint exists",
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md): all three references must
   * be re-provisioned (subscription key, API user, API user secret); the
   * rotation is only real when at least one reference CHANGED since the last
   * resolution. Evidence records WHICH refs rotated (names only — never
   * values). On the control-plane path the rotation follows the
   * swap-reference-then-verify discipline, and the blocked gate REQUIRES a
   * fresh authenticated re-probe after rotation (the recorded datum names
   * the OLD credential).
   */
  async rotateCredentials(ctx: SdkCallContext): Promise<CredentialRotationResult> {
    this.requireAuthority(ctx, "credential_rotation");
    if (this.#controlPlane !== undefined) {
      const handle = this.#controlPlane.broker.resolveProviderCredential(
        this.#credentialConfigKey,
      );
      const current = handle.descriptor.vaultReference;
      const previous = this.#cachedCredentialRefs?.[this.#credentialConfigKey];
      if (previous === undefined) {
        this.#cachedCredentialRefs = { [this.#credentialConfigKey]: current };
        throw new ValidationError(
          "credential baseline recorded on first use; rotation requires a subsequently swapped NEW vault reference (CREDENTIAL-ROTATION.md, swap-reference-then-verify; then probeAuthentication before any provider call)",
        );
      }
      if (current === previous) {
        throw new ValidationError(
          "credential rotation requires a NEW vault reference bound to the control-plane config key: the broker still resolves the previous reference (CREDENTIAL-ROTATION.md, swap-reference-then-verify)",
        );
      }
      this.#cachedCredentialRefs = { [this.#credentialConfigKey]: current };
      const rotatedAt = this.now();
      return {
        rotatedAt,
        newCredentialRef: current,
        evidence: railEvidence({
          evidenceId: `momo:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${MOBILE_MONEY_RAIL_ADAPTER_ID}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: MOBILE_MONEY_PROVIDER_NAME,
            providerVersion: this.#apiVersion,
            objectType: "credential_rotation",
            externalId: MOBILE_MONEY_RAIL_ADAPTER_ID,
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
    const current = this.#currentCredentialRefs();
    if (!current.provisioned) {
      throw new RailNotAuthorizedError(
        "cannot rotate credentials: mobile-money credential references are not fully provisioned (packages/rails/BLOCKED-RAILS.md)",
        { railId: MOBILE_MONEY_RAIL_ADAPTER_ID },
      );
    }
    const previous = this.#cachedCredentialRefs;
    if (previous === undefined) {
      this.#cachedCredentialRefs = current.refs;
      throw new ValidationError(
        "credential baseline recorded on first use; rotation requires subsequently provisioned NEW references (CREDENTIAL-ROTATION.md step b)",
      );
    }
    const changedEnvVars = this.#credentialDeclarations
      .filter((declaration) => current.refs[declaration.envVar] !== previous[declaration.envVar])
      .map((declaration) => declaration.envVar);
    if (changedEnvVars.length === 0) {
      throw new ValidationError(
        "credential rotation requires at least one NEW provisioned reference (CREDENTIAL-ROTATION.md step b)",
      );
    }
    this.#cachedCredentialRefs = current.refs;
    const rotatedAt = this.now();
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId: `momo:cred-rotation:${rotatedAt}`,
      evidenceRef: `credential-rotation:${MOBILE_MONEY_RAIL_ADAPTER_ID}`,
      kind: "AUDIT_LOG",
      providerState: railEnvelope({
        providerName: MOBILE_MONEY_PROVIDER_NAME,
        providerVersion: this.#apiVersion,
        objectType: "credential_rotation",
        externalId: MOBILE_MONEY_RAIL_ADAPTER_ID,
        revision: `rotation-${rotatedAt}`,
        // Names of rotated refs only — values never appear.
        state: { rotatedEnvVars: changedEnvVars },
        family: "other",
        lifecycleStep: "rotated",
        isTerminal: false,
        requiresCustomerAction: false,
        observedAt: isoTimestamp(rotatedAt),
        provenanceSource: "OPERATOR",
      }),
      recordedAt: rotatedAt,
    });
    return {
      rotatedAt,
      newCredentialRef: current.refs["PAYSWAP_RAILS_MOMO_API_KEY_REF"] ?? "momo-rotated",
      evidence,
    };
  }

  /**
   * Read-only probe of the provider token endpoint WITHOUT credentials —
   * reachability projection only, never a business outcome. An HTTP answer
   * (any status) proves reachability; transport failure is UNKNOWN.
   */
  async health(): Promise<ConnectorHealthReport> {
    const credentials = this.#currentCredentialRefs();
    const lastCheckedAt = isoTimestamp(this.now());
    const base = {
      connectorId: "connector.rails.mobile_money",
      providerName: MOBILE_MONEY_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    let endpointAnswered: boolean;
    try {
      await this.#http(`${this.#apiBase}/collection/token/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: this.#timeoutMs,
      });
      endpointAnswered = true;
    } catch {
      endpointAnswered = false;
    }
    if (!endpointAnswered) {
      return {
        ...base,
        status: "UNKNOWN",
        lastCheckedAt,
        degradedReasons: ["provider endpoint unreachable — availability UNKNOWN (INV-C02)"],
      };
    }
    if (!credentials.provisioned) {
      return {
        ...base,
        status: "DEGRADED",
        lastCheckedAt,
        degradedReasons: [
          "credentials absent: provider endpoint reachable (probe answered) but rail authorization cannot be established — availability UNKNOWN (INV-C01/C02; packages/rails/BLOCKED-RAILS.md)",
        ],
      };
    }
    if (this.#probeEvidence.status === "BLOCKED") {
      return {
        ...base,
        status: "DEGRADED",
        lastCheckedAt,
        degradedReasons: [
          `credential BLOCKED by recorded probe evidence (${this.#probeEvidence.probedAt}): ${this.#probeEvidence.detail} — availability UNKNOWN, effectful operations refuse, no simulated substitute (packages/rails/BLOCKED-RAILS.md)`,
        ],
      };
    }
    return { ...base, status: "HEALTHY", lastCheckedAt, degradedReasons: [] };
  }

  // -- the blocked state + the re-probe path -----------------------------------

  /**
   * THE AUTHENTICATED RE-PROBE (the honest lift path for the blocked gate):
   * attempts REAL bearer-token issuance at POST /collection/token/ with the
   * provisioned credential material and records the evidence. On success
   * the governing evidence becomes VERIFIED and provider-calling operations
   * proceed through the real API; on a provider rejection it becomes
   * BLOCKED with the provider's answer; on transport failure UNKNOWN (the
   * previous evidence's consequence stands — a BLOCKED datum is never
   * silently lifted by an unreachable probe). Never a business outcome.
   */
  async probeAuthentication(): Promise<MtnMomoProbeEvidence> {
    const material = this.#requireCredentialMaterial();
    const probedAt = isoTimestamp(this.now());
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#tokenRequest(material);
    } catch (cause) {
      const evidence: MtnMomoProbeEvidence = Object.freeze({
        status: "UNKNOWN",
        probedAt,
        detail: `token endpoint unreachable during the authenticated probe — availability UNKNOWN, the previous evidence consequence stands (INV-C02): ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      if (this.#probeEvidence.status !== "BLOCKED") {
        this.#probeEvidence = evidence;
      }
      return evidence;
    }
    if (response.status < 200 || response.status >= 300) {
      this.#probeEvidence = Object.freeze({
        status: "BLOCKED",
        probedAt,
        detail: `token issuance rejected: provider answered HTTP ${response.status} — credential not accepted at the ${this.#targetEnvironment} collection product${response.status === 401 ? " (APIM gate subscription-key rejection, as recorded in the 2026-10-02 probe)" : ""}`,
        ...(Number.isInteger(response.status) ? { httpStatus: response.status } : {}),
      });
      return this.#probeEvidence;
    }
    this.#probeEvidence = Object.freeze({
      status: "VERIFIED",
      probedAt,
      detail: `token issuance succeeded at ${this.#targetEnvironment} collection — bearer-token issuance verified, provider-calling operations proceed through the real API`,
    });
    return this.#probeEvidence;
  }

  // -- dedicated observation method (read-only; INV-C09) ------------------------

  /**
   * External funds observation from GET /collection/v1_0/account/balance —
   * the collection account's provider-held balance as ONE
   * ExternalFundsPositionObservation (INV-C09: an observation, never
   * custody, never a PaySwap balance). Gated by the credential surface AND
   * the blocked-probe evidence like every provider call.
   */
  async observeAccountBalance(): Promise<readonly ExternalFundsPositionObservation[]> {
    const material = this.#requireCredentialMaterial();
    this.#requireNotBlocked();
    const raw = await this.#collectionGet(
      "/collection/v1_0/account/balance",
      material,
    );
    const accountRef = this.#accountRef();
    const observedAt = isoTimestamp(this.now());
    return Object.freeze([
      mtnMomoBalanceObservation({
        balance: raw as MtnMomoAccountBalanceProviderObject,
        accountRef,
        observedAt,
      }),
    ]);
  }

  // -- internals -------------------------------------------------------------------

  /** A credential-attributed account reference (never the secret material). */
  #accountRef(): string {
    if (this.#controlPlane !== undefined) {
      try {
        const handle = this.#controlPlane.broker.resolveProviderCredential(
          this.#credentialConfigKey,
        );
        return handle.descriptor.vaultReference;
      } catch {
        return `vault:${this.#credentialConfigKey}`;
      }
    }
    return `env:PAYSWAP_RAILS_MOMO_API_USER_REF`;
  }

  #currentCredentialRefs(): {
    readonly provisioned: boolean;
    readonly refs: Readonly<Record<string, string>>;
  } {
    if (this.#controlPlane !== undefined) {
      try {
        this.#controlPlane.broker.resolveProviderCredential(this.#credentialConfigKey);
        return { provisioned: true, refs: {} };
      } catch {
        return { provisioned: false, refs: {} };
      }
    }
    return resolveCredentialRefs(this.#credentialDeclarations, this.#env);
  }

  /**
   * The credential material from either path: the control plane opens the
   * SEALED bundle per call (material exists only inside the returned value's
   * usage frame — never stored, never logged, never in an envelope); the env
   * fallback reads the resolved material the env vars inject. With neither,
   * the operation fails closed BEFORE any provider call (INV-NC04).
   */
  #requireCredentialMaterial(): MtnMomoCredentialMaterial {
    if (this.#controlPlane !== undefined) {
      let handle: ReturnType<CredentialBroker["resolveProviderCredential"]>;
      try {
        handle = this.#controlPlane.broker.resolveProviderCredential(
          this.#credentialConfigKey,
        );
      } catch (error) {
        throw new RailNotAuthorizedError(
          "mobile-money rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: MOBILE_MONEY_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => extractMtnMomoCredentialBundle(opened.material),
      );
    }
    const current = this.#currentCredentialRefs();
    if (!current.provisioned) {
      throw new RailNotAuthorizedError(
        "mobile-money rail is not authorized: credential references not fully provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md)",
        { railId: MOBILE_MONEY_RAIL_ADAPTER_ID },
      );
    }
    if (this.#cachedCredentialRefs === undefined) {
      this.#cachedCredentialRefs = current.refs;
    }
    return {
      subscriptionKey: current.refs["PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF"] ?? "",
      apiUser: current.refs["PAYSWAP_RAILS_MOMO_API_USER_REF"] ?? "",
      apiKey: current.refs["PAYSWAP_RAILS_MOMO_API_KEY_REF"] ?? "",
      targetEnvironment: this.#targetEnvironment,
    };
  }

  /**
   * The honest blocked gate: while the governing probe evidence says the
   * credential is BLOCKED, every provider-calling operation refuses BEFORE
   * any provider call, citing the recorded datum. No simulated substitute.
   */
  #requireNotBlocked(): void {
    if (this.#probeEvidence.status === "BLOCKED") {
      throw new MtnMomoBlockedProbeError(
        `mobile-money rail refuses the provider call: the governing probe evidence says the credential is BLOCKED (${this.#probeEvidence.probedAt}: ${this.#probeEvidence.detail}) — availability stays UNKNOWN, NO simulated substitute exists; lift only through a successful authenticated re-probe (probeAuthentication) or newer verified evidence`,
        {
          railId: MOBILE_MONEY_RAIL_ADAPTER_ID,
          probedAt: this.#probeEvidence.probedAt,
          ...(this.#probeEvidence.httpStatus !== undefined
            ? { httpStatus: this.#probeEvidence.httpStatus }
            : {}),
        },
      );
    }
  }

  #request(ctx: SdkCallContext, kind: MomoCallRequest["kind"]): MomoCallRequest {
    const candidate = (ctx.request ?? {}) as Partial<MomoCallRequest>;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ValidationError("mobile-money rail call request must be an object");
    }
    if (candidate.amountMinor !== undefined && !/^\d+(\.\d+)?$/.test(candidate.amountMinor)) {
      throw new ValidationError(
        "amountMinor must be an exact decimal string in the provider's currency exponent (INV-F01)",
      );
    }
    return { ...candidate, kind };
  }

  #requestResult(raw: unknown, referenceId: string, evidenceId: string): SdkCallResult {
    const now: TimestampMs = this.#clock.now();
    const candidate = raw as Partial<MobileMoneyRequestProviderObject>;
    const envelope = mobileMoneyEnvelope({
      objectType: "request_to_pay",
      externalId: referenceId,
      rawState: raw,
      status: typeof candidate.status === "string" ? candidate.status : "PENDING",
      revision: typeof candidate.status === "string" ? candidate.status : "PENDING",
      observedAt: isoTimestamp(now),
      ...(candidate.reason !== undefined ? { failureReason: candidate.reason } : {}),
    });
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId,
      evidenceRef: `request_to_pay:${referenceId}`,
      kind: "EXECUTION",
      providerState: envelope,
      recordedAt: now,
    });
    return { providerState: envelope, outcome: classifyOutcome(envelope), evidence };
  }

  #mandateResult(raw: unknown, mandateId: string, evidenceId: string): SdkCallResult {
    const now: TimestampMs = this.#clock.now();
    const candidate = raw as Partial<MobileMoneyMandateProviderObject>;
    const envelope = mobileMoneyEnvelope({
      objectType: "mandate",
      externalId: mandateId,
      rawState: raw,
      status: typeof candidate.status === "string" ? candidate.status : "mandate.active",
      revision: typeof candidate.status === "string" ? candidate.status : "mandate.active",
      observedAt: isoTimestamp(now),
    });
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId,
      evidenceRef: `mandate:${mandateId}`,
      kind: "EXECUTION",
      providerState: envelope,
      recordedAt: now,
    });
    return { providerState: envelope, outcome: classifyOutcome(envelope), evidence };
  }

  /** One authenticated collection-product GET (token → Bearer call). */
  async #collectionGet(path: string, material: MtnMomoCredentialMaterial): Promise<unknown> {
    const token = await this.#providerToken(material);
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Target-Environment": material.targetEnvironment ?? this.#targetEnvironment,
          "Ocp-Apim-Subscription-Key": material.subscriptionKey,
        },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(
        "mobile-money provider transport unreachable",
        { path, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `mobile-money provider answered HTTP ${response.status}`,
        { path, httpStatus: response.status },
      );
    }
    return this.#parseJson(response.bodyText, path);
  }

  async #providerGet(path: string): Promise<unknown> {
    const material = this.#requireCredentialMaterial();
    this.#requireNotBlocked();
    return this.#collectionGet(path, material);
  }

  async #providerPost(
    path: string,
    body: Readonly<Record<string, unknown>>,
    referenceId: string,
  ): Promise<unknown> {
    const material = this.#requireCredentialMaterial();
    this.#requireNotBlocked();
    const token = await this.#providerToken(material);
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(`${this.#apiBase}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Target-Environment": material.targetEnvironment ?? this.#targetEnvironment,
          "Ocp-Apim-Subscription-Key": material.subscriptionKey,
          // X-Reference-Id: the request's idempotency key at MTN (a UUID).
          "X-Reference-Id": referenceId,
        },
        body: JSON.stringify(body),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(
        "mobile-money provider transport unreachable",
        { path, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `mobile-money provider answered HTTP ${response.status}`,
        { path, httpStatus: response.status },
      );
    }
    if (response.bodyText.length === 0) {
      // 202 Accepted with an EMPTY body: the provider-documented answer for
      // requesttopay — the object exists and awaits the payer's handset
      // approval. The synthesized state documents that answer honestly.
      return {
        status: "PENDING",
        referenceId,
        note: "202 Accepted with an empty body — request accepted, awaiting payer handset approval (provider-documented semantics)",
      };
    }
    return this.#parseJson(response.bodyText, path);
  }

  /** One raw token-endpoint request (no error conversion — the caller decides). */
  async #tokenRequest(material: MtnMomoCredentialMaterial): Promise<{
    readonly status: number;
    readonly bodyText: string;
  }> {
    const basic = Buffer.from(`${material.apiUser}:${material.apiKey}`, "utf8").toString("base64");
    try {
      return await this.#http(`${this.#apiBase}/collection/token/`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Ocp-Apim-Subscription-Key": material.subscriptionKey,
        },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(
        "mobile-money token endpoint unreachable",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  }

  /** Bearer-token issuance over the provider's Basic-auth token endpoint. */
  async #providerToken(material: MtnMomoCredentialMaterial): Promise<string> {
    const response = await this.#tokenRequest(material);
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `mobile-money token endpoint answered HTTP ${response.status} (credentials rejected)`,
        { httpStatus: response.status },
      );
    }
    const parsed = this.#parseJson(response.bodyText, "/collection/token/") as Partial<{
      access_token: string;
    }>;
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      throw new RailProviderError("mobile-money token response carries no access_token");
    }
    return parsed.access_token;
  }

  #parseJson(bodyText: string, contextRef: string): unknown {
    try {
      return JSON.parse(bodyText);
    } catch (cause) {
      throw new RailProviderError("mobile-money provider response is not JSON", {
        contextRef,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}
