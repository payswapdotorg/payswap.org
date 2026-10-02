/**
 * Flutterwave production connector (P2-W3-001) — the REAL Flutterwave
 * adapter on the v1.5 capability hierarchy and ProviderStateEnvelope.
 *
 * Authority: spec/phase-2/work-items/P2-W3-001.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md and the LIVE probe
 * facts in spec/development-state/provider-probes-20261002.json
 * (authenticated GET /v3/balances: 31 currency wallets incl. NGN/KES/GHS/
 * USD/EUR/ZAR/XOF/XAF/UGX/TZS/RWF/ETB/ZMW/MWK/MZN/MAD/AED/EGP/MUR and the
 * stablecoin wallets USDC 1234.56 / USDT 789.01 / RLUSD 20004.01 test
 * balances; verdict ELIGIBLE for pan-African + multi-currency collection).
 * Same framework and fail-closed laws as the Stripe production connector
 * (`src/stripe.ts`, P2-W2-001) — NO Flutterwave SDK, no ambient fetch in
 * unit-testable paths, no provider SDK types anywhere.
 *
 * Laws implemented here:
 * - INV-C06 (lossless): every provider object (hosted checkout with its
 *   `tx_ref`, transaction with its numeric `id` and status, refund, webhook
 *   event, wallet balance entry) is carried VERBATIM in the envelope `state`
 *   with an ADDITIVE classification. Provider statuses are never renamed,
 *   never dropped; UNKNOWN provider statuses stay `other`/verbatim.
 * - INV-C09: GET /v3/balances produces ExternalFundsPositionObservation
 *   ONLY — observations of provider-held external wallet funds (including
 *   the stablecoin wallets — an honest datum), never PaySwap custody and
 *   never a balance PaySwap owes anyone. Flutterwave reports wallet
 *   balances in MAJOR units: the conversion to exact integer minor units is
 *   bigint-arithmetic per currency exponent (INV-F01 — no floating-point
 *   money anywhere); a wallet whose currency has no known exponent (or
 *   sub-minor precision) is honestly reported as unconverted, never
 *   fabricated.
 * - INV-X01: a transport failure mid-effect is OUTCOME_UNKNOWN (ambiguity
 *   OUTCOME_UNKNOWN, requires reconciliation) — NEVER collapsed to FAILED.
 * - INV-NC04: no credential → availability UNKNOWN (INV-C01/C02), health
 *   DEGRADED/UNKNOWN with reasons, every effectful operation throws
 *   RailNotAuthorizedError BEFORE any provider call.
 * - Credential isolation (phase-2): key material is consumed through the
 *   P2-W1-001 control plane — `PROVIDER_FLUTTERWAVE_CREDENTIAL_REF` bound
 *   to a vault:// reference, resolved through the CredentialBroker to a
 *   SEALED bundle opened only inside `withSealedBundle` with a
 *   ConnectorRuntimeKey. A direct env fallback (the W1-005 rails
 *   convention) exists for deployments that inject the resolved key under
 *   the same config key; the material NEVER enters any envelope, log line
 *   or evidence record.
 * - Webhook verification is provider-correct: the `verif-hash` header is a
 *   DASHBOARD-CONFIGURED SECRET, compared against the vault webhook secret
 *   in CONSTANT TIME. There is NO payload signature in the scheme (the
 *   digest is not over the body) — integrity controls are the secret
 *   compare plus the (provider, eventId) dedupe at the ingestor, never a
 *   fabricated body signature.
 * - Idempotency honesty: Flutterwave enforces NO unique constraint on
 *   `tx_ref` at the standard checkout — the connector derives a
 *   deterministic tx_ref from the protocol idempotency key (INV-F05) and
 *   the capability declares duplicateBehavior PROVIDER_DEFINED; the
 *   caller's protocol idempotency registrar remains the double-execution
 *   guard (reconciliation is by the numeric transaction id — INV-X03).
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
// Identity (pinned — the API generation is part of the provider contract)
// ---------------------------------------------------------------------------

export const FLUTTERWAVE_PROVIDER_NAME = "flutterwave" as const;
/**
 * The pinned Flutterwave API version: the provider's own versioned API root
 * (/v3), observed live in the 2026-10-02 probe. Pinning is a connector
 * contract: an unpinned surface would make envelope mappings
 * version-dependent.
 */
export const FLUTTERWAVE_API_VERSION = "v3" as const;
export const FLUTTERWAVE_RAIL_ADAPTER_ID = "rail.flutterwave" as const;
export const FLUTTERWAVE_RAIL_IMPLEMENTATION_ID = "impl.rails.flutterwave.v3" as const;
export const FLUTTERWAVE_CONNECTOR_ID = "connector.rails.flutterwave" as const;
export const FLUTTERWAVE_DEFAULT_API_BASE = "https://api.flutterwave.com" as const;

/**
 * The control-plane credential configuration key for this connector
 * (P2-W1-001 vocabulary): `providerCredentialConfigKey("flutterwave")` —
 * `PROVIDER_FLUTTERWAVE_CREDENTIAL_REF`, bound to
 * `vault://payswap/providers/flutterwave/test-20261002`.
 */
export const FLUTTERWAVE_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  FLUTTERWAVE_PROVIDER_NAME,
);

// ---------------------------------------------------------------------------
// Capability definitions (consumed W2-003 vocabulary — never redefined)
// ---------------------------------------------------------------------------

export const FLUTTERWAVE_HOSTED_CHECKOUT_CAPABILITY_ID =
  "cap.rails.flutterwave.hosted_checkout" as const;
export const FLUTTERWAVE_REFUND_CAPABILITY_ID = "cap.rails.flutterwave.refund" as const;
export const FLUTTERWAVE_WALLET_OBSERVATION_CAPABILITY_ID =
  "cap.rails.flutterwave.wallet_observation" as const;

/**
 * The provider-state vocabulary this connector maps (INV-C06): every
 * Flutterwave transaction status with its additive classification.
 * Exported as data so certification/conformance surfaces can diff the
 * mapping without reading the implementation.
 *
 * | Flutterwave status | family           | isTerminal | requiresCustomerAction |
 * |--------------------|------------------|------------|------------------------|
 * | pending            | async_processing | false      | false                  |
 * | successful         | other            | true       | false                  |
 * | failed             | other            | true       | false (definitive)     |
 * | reversed           | other            | true       | false (definitive)     |
 * | (unknown)          | other            | false      | false (verbatim step)  |
 */
export const FLUTTERWAVE_TRANSACTION_STATUS_MAPPING: readonly {
  readonly providerState: string;
  readonly family: ProviderStateEnvelope["classification"]["family"];
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
}[] = Object.freeze([
  { providerState: "pending", family: "async_processing", lifecycleStep: "pending", isTerminal: false, requiresCustomerAction: false },
  { providerState: "successful", family: "other", lifecycleStep: "successful", isTerminal: true, requiresCustomerAction: false },
  { providerState: "failed", family: "other", lifecycleStep: "failed", isTerminal: true, requiresCustomerAction: false },
  { providerState: "reversed", family: "other", lifecycleStep: "reversed", isTerminal: true, requiresCustomerAction: false },
]);

function flutterwaveCapabilityDefinition(input: {
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
      "credential reference provisioned through the control plane (PROVIDER_FLUTTERWAVE_CREDENTIAL_REF)",
      "collection eligibility observed through the probe-verified wallet currencies — never assumed for unproven currencies",
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
        { action: "create_payment", description: "Generate a hosted checkout link toward the payer" },
        { action: "read_transaction", description: "Fetch a transaction by its numeric id (the reconciliation path)" },
        { action: "refund", description: "Refund a transaction (where the flow supports it)" },
        { action: "observe_balances", description: "Observe the multi-currency wallet balances (never custody)" },
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
    economics: { feeModel: "PROVIDER_SCHEDULE", limits: [], settlementImplications: "Flutterwave settlement schedule" },
    constraints: [
      {
        kind: "JURISDICTION",
        description:
          "pan-African + multi-currency collection availability follows the probe-verified wallet currencies; unproven currencies are UNKNOWN, never assumed",
      },
    ],
  });
}

/** The canonical capability definitions consumed by the Flutterwave connector. */
export function flutterwaveCapabilityDefinitions(): readonly CapabilityDefinition[] {
  return Object.freeze([
    flutterwaveCapabilityDefinition({
      capabilityId: FLUTTERWAVE_HOSTED_CHECKOUT_CAPABILITY_ID,
      summary: "Hosted-checkout payment lifecycle on the real Flutterwave v3 API",
      operation: "rails.flutterwave.payment.hosted_checkout",
      description:
        "POST /v3/payments (hosted checkout link generation; amount in exact MAJOR-unit decimal strings) then GET /v3/transactions/{id}: the numeric transaction id is preserved as the external id, statuses stay verbatim (pending/successful/failed/reversed), the tx_ref rides the state verbatim, and a mid-effect transport failure is OUTCOME_UNKNOWN — never FAILED",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: FLUTTERWAVE_TRANSACTION_STATUS_MAPPING.map((entry) => ({
        providerState: entry.providerState,
        canonicalState: `${entry.family}:${entry.lifecycleStep}`,
        requiresCustomerAction: entry.requiresCustomerAction,
        isTerminal: entry.isTerminal,
      })),
      externalObjects: [
        { objectType: "hosted_checkout", idFormat: "tx-ref:[A-Za-z0-9._~-]+" },
        { objectType: "transaction", idFormat: "tx-id:[0-9]+" },
      ],
      sideEffects: [
        { effect: "moves payer value when the payer completes the hosted checkout", financialEffect: "MOVES_VALUE", reversible: false },
      ],
      requiredCustomerActions: [
        {
          lifecycleStep: "link_generated",
          kind: "PROVIDER_CHALLENGE_REDIRECT",
          message: "Complete the payment at the Flutterwave hosted checkout link before it expires",
        },
      ],
    }),
    flutterwaveCapabilityDefinition({
      capabilityId: FLUTTERWAVE_REFUND_CAPABILITY_ID,
      summary: "Refunds where the flow supports them (POST /v3/refunds)",
      operation: "rails.flutterwave.refund.create",
      description:
        "Create Flutterwave refunds by numeric transaction id (optionally partial, in exact major-unit decimal strings); the refund lifecycle stays provider-owned and is observed losslessly",
      requiredPermissions: ["payments:write"],
      requiredScopes: ["payments:execute"],
      providerStates: [
        { providerState: "pending", canonicalState: "refund:pending", requiresCustomerAction: false, isTerminal: false },
        { providerState: "completed", canonicalState: "refund:completed", requiresCustomerAction: false, isTerminal: true },
        { providerState: "failed", canonicalState: "refund:failed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "refund", idFormat: "refund-id:[0-9]+" }],
      sideEffects: [
        { effect: "returns previously collected value to the payer (where the flow supports it)", financialEffect: "MOVES_VALUE", reversible: false },
      ],
    }),
    flutterwaveCapabilityDefinition({
      capabilityId: FLUTTERWAVE_WALLET_OBSERVATION_CAPABILITY_ID,
      summary: "Multi-currency wallet OBSERVATION (31 wallets incl. stablecoins — never custody)",
      operation: "rails.flutterwave.wallet.observe",
      description:
        "Observe the Flutterwave wallet balances (GET /v3/balances — 31 currencies incl. the USDC/USDT/RLUSD stablecoin wallets) as ExternalFundsPositionObservations ONLY: provider-held external funds, never PaySwap custody (INV-C09)",
      requiredPermissions: ["payments:read"],
      requiredScopes: ["payments:read"],
      providerStates: [
        { providerState: "observed", canonicalState: "other:observed", requiresCustomerAction: false, isTerminal: true },
      ],
      externalObjects: [{ objectType: "wallet_balance_list", idFormat: "wallet-balances:[0-9]+" }],
      sideEffects: [],
    }),
  ]);
}

/** The connector capability pack backing the Flutterwave rail (payments family). */
export function flutterwaveRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.flutterwave",
    family: "payments",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: flutterwaveCapabilityDefinitions().map((definition) => ({
      capabilityId: definition.capabilityId,
      capabilityVersion: definition.capabilityVersion,
    })),
    auth: {
      authKind: "API_KEY" as const,
      scopes: ["payments:write", "payments:read"],
      rotationPolicyRef: "packages/rails/CREDENTIAL-ROTATION.md",
    },
    schemas: [{ schemaId: "schema.rails.flutterwave.provider_state", version: "1.0.0" }],
    objectMappings: [
      {
        externalObjectType: "hosted_checkout",
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
        externalObjectType: "wallet_balance_list",
        canonicalObjectRef: "payswap:external_funds_observation",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 50, windowSeconds: 60, scope: "account" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-flutterwave-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// Probe-verified wallet facts (observed, never assumed)
// ---------------------------------------------------------------------------

/**
 * The RECORDED wallet-currency probe datum (authenticated GET /v3/balances,
 * 2026-10-02): 31 currency wallets — the 27 fiat currencies below plus the
 * USDC/USDT/RLUSD stablecoin wallets. The connector NEVER assumes these
 * stay true — `observeExternalFunds()` re-observes live; this record is the
 * eligibility evidence provenance when no fresh observation ran.
 */
export const FLUTTERWAVE_PROBED_WALLET_CURRENCIES_20261002: readonly string[] = Object.freeze([
  "NGN", "KES", "GHS", "USD", "EUR", "ZAR", "BRL", "XAF", "XOF", "MWK", "EGP", "AED",
  "MAD", "AUD", "CAD", "MYR", "CNY", "ZMW", "INR", "MUR", "ETB", "JPY", "GBP", "TZS",
  "UGX", "MZN", "RWF", "USDC", "USDT", "RLUSD",
]);

/**
 * The honest stablecoin datum from the same probe: the test balances
 * observed on the stablecoin wallets (major-unit decimals, verbatim from the
 * probe record) — materially relevant to the Stellar USDC local-rail path
 * and recorded as an observation fact, never as PaySwap-held value.
 */
export const FLUTTERWAVE_PROBED_STABLECOIN_BALANCES_20261002: readonly {
  readonly currency: "USDC" | "USDT" | "RLUSD";
  readonly majorUnits: string;
}[] = Object.freeze([
  Object.freeze({ currency: "USDC", majorUnits: "1234.56" }),
  Object.freeze({ currency: "USDT", majorUnits: "789.01" }),
  Object.freeze({ currency: "RLUSD", majorUnits: "20004.01" }),
]);

/** The collection eligibility verdict for one currency. */
export interface FlutterwaveCollectionEligibility {
  readonly currency: string;
  readonly eligible: boolean;
  /** "PROBE_VERIFIED_WALLET" | "UNKNOWN" (never assumed either way). */
  readonly basis: "PROBE_VERIFIED_WALLET" | "UNKNOWN";
  readonly reason: string;
}

/**
 * Collection eligibility against the RECORDED probe evidence. Only the 30
 * probe-verified wallet currencies (27 fiat + USDC/USDT/RLUSD) are eligible
 * with basis PROBE_VERIFIED_WALLET; every other currency is UNKNOWN — never
 * assumed eligible, never assumed ineligible (INV-NC04 honesty: the
 * provider is the authority; the connector fabricates nothing).
 */
export function flutterwaveCollectionEligibility(
  currency: string,
): FlutterwaveCollectionEligibility {
  const upper = currency.toUpperCase();
  if ((FLUTTERWAVE_PROBED_WALLET_CURRENCIES_20261002 as readonly string[]).includes(upper)) {
    return Object.freeze({
      currency: upper,
      eligible: true,
      basis: "PROBE_VERIFIED_WALLET",
      reason: `authenticated GET /v3/balances observed the ${upper} wallet live on 2026-10-02 (31 wallet currencies on the connected account)`,
    });
  }
  return Object.freeze({
    currency: upper,
    eligible: false,
    basis: "UNKNOWN",
    reason:
      "no probe evidence for this currency — collection eligibility UNKNOWN, never assumed (INV-NC04; re-observe through the provider before routing)",
  });
}

// ---------------------------------------------------------------------------
// Minor-unit conversion (INV-F01 — exact bigint arithmetic, never floats)
// ---------------------------------------------------------------------------

/**
 * The minor-unit exponents for the probe-verified Flutterwave wallet
 * currencies (ISO 4217 for fiat; the stablecoin wallets are quoted with two
 * decimals on the observed account). A currency outside this table has an
 * UNKNOWN exponent — its wallet is honestly reported as unconverted, never
 * guessed.
 */
export const FLUTTERWAVE_WALLET_MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> =
  Object.freeze({
    NGN: 2, KES: 2, GHS: 2, USD: 2, EUR: 2, ZAR: 2, BRL: 2, MWK: 2, EGP: 2, AED: 2,
    MAD: 2, AUD: 2, CAD: 2, MYR: 2, CNY: 2, ZMW: 2, INR: 2, MUR: 2, ETB: 2, GBP: 2,
    TZS: 2, MZN: 2, XAF: 0, XOF: 0, UGX: 0, RWF: 0, JPY: 0,
    USDC: 2, USDT: 2, RLUSD: 2,
  });

/** The exact minor-units conversion of a major-unit decimal string. */
export function flutterwaveMinorUnits(majorDecimal: string, currency: string): string {
  const exponent = FLUTTERWAVE_WALLET_MINOR_UNIT_EXPONENTS[currency.toUpperCase()];
  if (exponent === undefined) {
    throw new ValidationError(
      `unknown minor-unit exponent for wallet currency '${currency.toUpperCase()}' — never guessed (INV-F01; add the exponent when the provider documents it)`,
    );
  }
  const { numerator, denominator } = exactRationalFromDecimal(majorDecimal);
  // denominator === 10^d where d = decimals in the string; minor = numerator * 10^e / 10^d.
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

// ---------------------------------------------------------------------------
// Provider object shapes (opaque passthrough — never domain primitives)
// ---------------------------------------------------------------------------

/** The raw Flutterwave hosted-checkout response data (opaque passthrough). */
export interface FlutterwaveHostedCheckoutProviderObject {
  readonly link?: string;
  readonly [key: string]: unknown;
}

/** The raw Flutterwave transaction object (opaque passthrough). */
export interface FlutterwaveTransactionProviderObject {
  readonly id?: number | string;
  readonly tx_ref?: string;
  readonly status?: string;
  readonly amount?: number | string;
  readonly currency?: string;
  readonly payment_type?: string;
  readonly [key: string]: unknown;
}

/** The raw Flutterwave refund object (opaque passthrough). */
export interface FlutterwaveRefundProviderObject {
  readonly refund_id?: number | string;
  readonly transaction_id?: number | string;
  readonly tx_ref?: string;
  readonly status?: string;
  readonly amount?: number | string;
  readonly currency?: string;
  readonly [key: string]: unknown;
}

/** One raw Flutterwave wallet balance entry (opaque passthrough). */
export interface FlutterwaveWalletBalanceProviderObject {
  readonly id?: number | string;
  readonly account_id?: number | string;
  readonly currency?: string;
  readonly available_balance?: number | string;
  readonly ledger_balance?: number | string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Revision derivation (deterministic per provider object)
// ---------------------------------------------------------------------------

/** Hosted-checkout revision: tx_ref + the link surface it produced. */
export function flutterwaveHostedCheckoutRevision(
  checkout: FlutterwaveHostedCheckoutProviderObject,
  txRef: string,
): string {
  return `${txRef}:${typeof checkout.link === "string" ? "link" : "no_link"}`;
}

/** Transaction revision: numeric id + status + tx_ref (status revision). */
export function flutterwaveTransactionRevision(
  tx: FlutterwaveTransactionProviderObject,
): string {
  return `${String(tx.id ?? "no_id")}:${tx.status ?? "unknown"}:${tx.tx_ref ?? "no_tx_ref"}`;
}

/** Refund revision: refund id + status. */
export function flutterwaveRefundRevision(refund: FlutterwaveRefundProviderObject): string {
  return `${String(refund.refund_id ?? "no_refund_id")}:${refund.status ?? "unknown"}`;
}

// ---------------------------------------------------------------------------
// Envelope mappers (INV-C06 — additive, lossless, total)
// ---------------------------------------------------------------------------

/** Shared envelope-mapper input: provenance and observation time. */
export interface FlutterwaveEnvelopeContext {
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK";
  readonly fetchId?: string;
}

function flutterwaveEnvelopeBase(
  objectType: string,
  externalId: string,
  revision: string,
  state: unknown,
  context: FlutterwaveEnvelopeContext,
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
    providerName: FLUTTERWAVE_PROVIDER_NAME,
    providerVersion: FLUTTERWAVE_API_VERSION,
    objectType,
    externalId,
    revision,
    state,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
}

/** Envelope shareable-field surface for Flutterwave provider objects. */
const FLUTTERWAVE_SHAREABLE_FIELDS: readonly string[] = Object.freeze([
  "status",
  "id",
  "tx_ref",
  "amount",
  "currency",
]);

/**
 * Deterministic, additive classification of a POST /v3/payments answer into
 * a lossless ProviderStateEnvelope (INV-C06). The RAW data is carried
 * VERBATIM as `state`; the external id is the caller's `tx_ref`. A hosted
 * checkout with a link is customer-action-required: the payer must complete
 * the checkout at the provider's link before any value moves.
 */
export function flutterwaveHostedCheckoutEnvelope(
  checkout: FlutterwaveHostedCheckoutProviderObject,
  txRef: string,
  context: FlutterwaveEnvelopeContext,
): ProviderStateEnvelope {
  const base = flutterwaveEnvelopeBase(
    "hosted_checkout",
    txRef,
    flutterwaveHostedCheckoutRevision(checkout, txRef),
    checkout,
    context,
  );
  if (typeof checkout.link === "string" && checkout.link.length > 0) {
    return railEnvelope({
      ...base,
      family: "customer_action_required",
      lifecycleStep: "link_generated",
      isTerminal: false,
      requiresCustomerAction: true,
      actionRequired: {
        kind: "PROVIDER_CHALLENGE_REDIRECT",
        message: "Complete the payment at the Flutterwave hosted checkout link before it expires",
        deepLink: checkout.link,
      },
      shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
    });
  }
  // No link in the answer: the payment object exists but the customer
  // surface is not disclosed — asynchronous, never guessed further.
  return railEnvelope({
    ...base,
    family: "async_processing",
    lifecycleStep: "initiated",
    isTerminal: false,
    requiresCustomerAction: false,
    shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
  });
}

/**
 * Deterministic, additive classification of a Flutterwave transaction
 * (GET /v3/transactions/{id} and webhook `charge.completed` surfaces) into a
 * lossless ProviderStateEnvelope (INV-C06). The RAW transaction is carried
 * VERBATIM as `state`; the external id is the NUMERIC transaction id (the
 * provider's own object identity — the tx_ref rides the state verbatim);
 * statuses map per FLUTTERWAVE_TRANSACTION_STATUS_MAPPING:
 *
 * - `pending` → async_processing (keep polling);
 * - `successful` → terminal;
 * - `failed` → terminal with definitive failure (ambiguity NONE);
 * - `reversed` → terminal definitive (value returned by the provider);
 * - any UNKNOWN status → `other`/verbatim, non-terminal — never dropped,
 *   never guessed, never collapsed (INV-C06/INV-X01).
 */
export function flutterwaveTransactionEnvelope(
  tx: FlutterwaveTransactionProviderObject,
  context: FlutterwaveEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = String(tx.id ?? "no_id");
  const base = flutterwaveEnvelopeBase(
    "transaction",
    externalId,
    flutterwaveTransactionRevision(tx),
    tx,
    context,
  );
  switch (tx.status) {
    case "pending":
      return railEnvelope({
        ...base,
        family: "async_processing",
        lifecycleStep: "pending",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
      });
    case "successful":
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: "successful",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
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
          retryable: true,
          ambiguity: "NONE",
        },
        shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
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
        shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "other",
        lifecycleStep: tx.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
      });
  }
}

/**
 * Flutterwave refund → refund-family envelope. `pending` is asynchronous;
 * `completed` is terminal; `failed` is terminal with definitive failure;
 * unknown statuses stay verbatim under the refund family with no invented
 * terminality (refund support is flow-dependent at the provider — the
 * connector never invents a status).
 */
export function flutterwaveRefundEnvelope(
  refund: FlutterwaveRefundProviderObject,
  context: FlutterwaveEnvelopeContext,
): ProviderStateEnvelope {
  const externalId = String(refund.refund_id ?? refund.transaction_id ?? "no_refund_id");
  const base = flutterwaveEnvelopeBase(
    "refund",
    externalId,
    flutterwaveRefundRevision(refund),
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
        shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
      });
    case "completed":
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: "completed",
        isTerminal: true,
        requiresCustomerAction: false,
        shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
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
        shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
      });
    default:
      return railEnvelope({
        ...base,
        family: "refund",
        lifecycleStep: refund.status ?? "unknown",
        isTerminal: false,
        requiresCustomerAction: false,
        shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
      });
  }
}

/**
 * A Flutterwave wallet-balance list → one lossless envelope. Every wallet
 * entry (currency, available/ledger balance) is carried VERBATIM in
 * `state.data`; the family stays `other` (an observation, not a payment
 * lifecycle).
 */
export function flutterwaveWalletListEnvelope(
  balances: readonly FlutterwaveWalletBalanceProviderObject[],
  context: FlutterwaveEnvelopeContext,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: FLUTTERWAVE_PROVIDER_NAME,
    providerVersion: FLUTTERWAVE_API_VERSION,
    objectType: "wallet_balance_list",
    externalId: `wallet-balances:${balances.length}`,
    revision: `wallet-balances:${balances.length}`,
    state: Object.freeze({ data: balances }),
    family: "other",
    lifecycleStep: "observed",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt: context.observedAt,
    provenanceSource: context.provenanceSource,
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
    shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
  });
}

/**
 * Maps a Flutterwave webhook payload ({ event, data }) to the lossless
 * envelope for its inner object. `charge.completed` (and other charge.*)
 * events carry a transaction; everything else produces an `event`-typed
 * envelope carrying the WHOLE payload verbatim — nothing is dropped
 * (INV-C06).
 */
export function flutterwaveWebhookEventEnvelope(
  payload: {
    readonly event?: string;
    readonly data?: unknown;
    readonly [key: string]: unknown;
  },
  context: FlutterwaveEnvelopeContext,
): ProviderStateEnvelope {
  const webhookContext: FlutterwaveEnvelopeContext = {
    observedAt: context.observedAt,
    provenanceSource: "PROVIDER_WEBHOOK",
    ...(context.fetchId !== undefined ? { fetchId: context.fetchId } : {}),
  };
  const data = payload.data;
  if (payload.event !== undefined && data !== null && typeof data === "object") {
    if (payload.event.startsWith("charge.") || payload.event.startsWith("transfer.")) {
      const tx = data as FlutterwaveTransactionProviderObject;
      if (typeof tx.id !== "undefined" || typeof tx.status === "string") {
        return flutterwaveTransactionEnvelope(tx, webhookContext);
      }
    }
  }
  return railEnvelope({
    providerName: FLUTTERWAVE_PROVIDER_NAME,
    providerVersion: FLUTTERWAVE_API_VERSION,
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
    shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
  });
}

// ---------------------------------------------------------------------------
// External funds observations (INV-C09 — observations, NEVER custody)
// ---------------------------------------------------------------------------

/** The honest report of wallets that could NOT be converted to minor units. */
export interface FlutterwaveUnconvertedWallet {
  readonly currency: string;
  readonly reason: "UNKNOWN_EXPONENT" | "SUB_MINOR_PRECISION" | "MALFORMED_BALANCE";
}

/**
 * Maps a GET /v3/balances response to ExternalFundsPositionObservations —
 * one per (wallet, balance kind). These are observations of PROVIDER-HELD
 * funds in the connected account's wallets (including the stablecoin
 * wallets — an honest datum): they are NOT PaySwap custody, NOT a balance
 * PaySwap owes anyone, and cannot create a false PaySwap balance.
 *
 * Flutterwave reports balances in MAJOR units: each observation's
 * `observedAmount.minorUnits` is the EXACT bigint conversion at the
 * currency's exponent (INV-F01). A wallet whose currency has no known
 * exponent, or whose balance carries sub-minor precision, is honestly
 * reported in `unconverted` — never guessed, never fabricated, never
 * silently dropped (the raw list rides the wallet-list envelope verbatim).
 */
export function flutterwaveBalanceObservations(input: {
  readonly balances: readonly FlutterwaveWalletBalanceProviderObject[];
  readonly accountRef: string;
  readonly observedAt: string;
  /** Consumer-side maximum tolerated age for these observations. */
  readonly maxAgeSeconds?: number;
  readonly observationIdPrefix?: string;
}): {
  readonly observations: readonly ExternalFundsPositionObservation[];
  readonly unconverted: readonly FlutterwaveUnconvertedWallet[];
} {
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  const prefix = input.observationIdPrefix ?? "flutterwave-wallet";
  const observations: ExternalFundsPositionObservation[] = [];
  const unconverted: FlutterwaveUnconvertedWallet[] = [];
  for (const wallet of input.balances) {
    if (
      wallet === null ||
      typeof wallet !== "object" ||
      typeof wallet.currency !== "string" ||
      wallet.currency.length === 0
    ) {
      unconverted.push({ currency: "UNKNOWN", reason: "MALFORMED_BALANCE" });
      continue;
    }
    const currency = wallet.currency.toUpperCase();
    for (const bucket of ["available_balance", "ledger_balance"] as const) {
      const balance = wallet[bucket];
      if (typeof balance !== "number" && typeof balance !== "string") {
        continue;
      }
      const majorDecimal = String(balance);
      let minorUnits: string;
      try {
        minorUnits = flutterwaveMinorUnits(majorDecimal, currency);
      } catch (error) {
        if (error instanceof ValidationError) {
          const reason: FlutterwaveUnconvertedWallet["reason"] = /sub-minor precision/.test(
            error.message,
          )
            ? "SUB_MINOR_PRECISION"
            : /non-negative decimal/.test(error.message)
              ? "MALFORMED_BALANCE"
              : "UNKNOWN_EXPONENT";
          unconverted.push({ currency, reason });
          continue;
        }
        unconverted.push({ currency, reason: "MALFORMED_BALANCE" });
        continue;
      }
      observations.push(
        Object.freeze({
          observationKind: "ExternalFundsPositionObservation" as const,
          observationId: `${prefix}:${bucket}:${currency}`,
          observedAt: input.observedAt,
          freshness: Object.freeze({
            asOf: input.observedAt,
            maxAgeSeconds,
          }),
          location: Object.freeze({
            providerName: FLUTTERWAVE_PROVIDER_NAME,
            accountRef: input.accountRef,
            instrumentRef: `wallet:${bucket}:${currency}`,
            description: `Flutterwave ${bucket === "available_balance" ? "available" : "ledger"} ${currency} wallet balance (provider-held external funds${currency === "USDC" || currency === "USDT" || currency === "RLUSD" ? " — stablecoin wallet, an honest datum for the Stellar USDC local-rail path" : ""} — observation, never custody)`,
          }),
          observedAmount: Object.freeze({
            currency,
            minorUnits,
          }),
          provenance: Object.freeze({
            providerName: FLUTTERWAVE_PROVIDER_NAME,
            source: "PROVIDER_API" as const,
            capturedAt: input.observedAt,
          }),
          reconciliationState: "NOT_RECONCILED" as const,
        }),
      );
    }
  }
  return Object.freeze({
    observations: Object.freeze(observations),
    unconverted: Object.freeze(unconverted),
  });
}

// ---------------------------------------------------------------------------
// Webhook verification (verif-hash: a dashboard-configured SECRET compare)
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

/** The verification result for one Flutterwave webhook delivery. */
export type FlutterwaveWebhookDeliveryVerification =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: "MISSING_VERIF_HASH" | "VERIF_HASH_INVALID";
    };

/**
 * Flutterwave webhook delivery verification: the `verif-hash` header is a
 * SECRET configured in the Flutterwave dashboard — verification compares it
 * against the vault webhook secret in CONSTANT TIME. There is NO payload
 * signature in this scheme (the digest is not over the body): replay and
 * duplication defense is the (provider, eventId) dedupe at the ingestor,
 * and the raw body is still required for the envelope mapping. Never a
 * fabricated body signature.
 */
export function verifyFlutterwaveWebhookDelivery(
  delivery: { readonly verifHashHeader: string | undefined },
  deps: { readonly secret: string },
): FlutterwaveWebhookDeliveryVerification {
  if (typeof delivery.verifHashHeader !== "string" || delivery.verifHashHeader.length === 0) {
    return { valid: false, reason: "MISSING_VERIF_HASH" };
  }
  if (!constantTimeEquals(delivery.verifHashHeader, deps.secret)) {
    return { valid: false, reason: "VERIF_HASH_INVALID" };
  }
  return { valid: true };
}

/**
 * Extracts the provider-declared event timestamp (epoch seconds, string)
 * from a Flutterwave webhook payload's `data.created_at` — the
 * deterministic, clock-free source the ingestor's replay window consumes.
 * Undefined when the payload declares none (the caller then supplies its
 * own observation).
 */
export function flutterwaveWebhookEventTimestamp(payload: unknown): string | undefined {
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
 * The deterministic dedupe event id for a Flutterwave webhook payload:
 * `${event}:${data.id}` — the provider's own event/object identity pair.
 */
export function flutterwaveWebhookEventId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const event = (payload as { readonly event?: unknown }).event;
  const data = (payload as { readonly data?: unknown }).data;
  if (typeof event !== "string" || event.length === 0) {
    return undefined;
  }
  if (data === null || typeof data !== "object") {
    return `${event}:no-data`;
  }
  const id = (data as { readonly id?: unknown }).id;
  return `${event}:${typeof id === "string" || typeof id === "number" ? String(id) : "no-id"}`;
}

/**
 * Adapts a raw Flutterwave delivery into the adapters'
 * ProviderWebhookRawEvent. `timestampSeconds` is the provider-declared event
 * time (flutterwaveWebhookEventTimestamp); `headers.signature` carries the
 * verif-hash value for the verifier's constant-time secret compare.
 */
export function flutterwaveWebhookRawEvent(delivery: {
  readonly eventId: string;
  readonly payload: unknown;
  readonly verifHashHeader: string;
  readonly timestampSeconds: string;
}): ProviderWebhookRawEvent {
  return Object.freeze({
    providerName: FLUTTERWAVE_PROVIDER_NAME,
    eventId: delivery.eventId,
    timestamp: delivery.timestampSeconds,
    payload: delivery.payload,
    headers: Object.freeze({
      signature: delivery.verifHashHeader,
      timestamp: delivery.timestampSeconds,
    }),
  });
}

/**
 * The Flutterwave verif-hash verifier on the adapters'
 * WebhookSignatureVerifier hook. NOTE: the scheme signs NO payload — the
 * `canonicalBody` argument is deliberately unused (the constant-time secret
 * compare is the provider-correct verification); the ingestor's eventId
 * dedupe and this secret compare are the integrity controls.
 */
export class FlutterwaveWebhookVerifier implements WebhookSignatureVerifier {
  readonly #secret: string;

  constructor(secret: string) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new ValidationError("a Flutterwave webhook verifier requires a non-empty verif-hash secret");
    }
    this.#secret = secret;
  }

  verify(
    event: ProviderWebhookRawEvent,
    _canonicalBody: string,
  ): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
    if (
      typeof event.headers.signature !== "string" ||
      event.headers.signature.length === 0 ||
      !constantTimeEquals(event.headers.signature, this.#secret)
    ) {
      return { valid: false, reason: "VERIF_HASH_INVALID" };
    }
    return { valid: true };
  }
}

/**
 * Wires a ProviderWebhookIngestor for Flutterwave: verif-hash secret
 * verification, replay window over the provider-declared event time,
 * (provider, eventId) dedupe and append-only evidence — the adapters
 * ingestor pattern with the Flutterwave scheme plugged in.
 */
export function createFlutterwaveWebhookIngestor(deps: {
  readonly secret: string;
  readonly clock: ProtocolClock;
  readonly replayWindowSeconds?: number;
  readonly futureSkewSeconds?: number;
}): ProviderWebhookIngestor {
  return new WebhookIngestor({
    verifier: new FlutterwaveWebhookVerifier(deps.secret),
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
// Idempotency (tx_ref derivation — the merchant-side reference)
// ---------------------------------------------------------------------------

/**
 * Derives the Flutterwave tx_ref from the protocol idempotency key
 * (INV-F05). Flutterwave enforces no unique constraint on tx_ref at the
 * standard checkout (duplicateBehavior PROVIDER_DEFINED): the deterministic
 * derivation makes retries send the SAME reference, and the caller's
 * protocol idempotency registrar remains the double-execution guard.
 */
export function flutterwaveTxRef(protocolIdempotencyKey: string): string {
  if (typeof protocolIdempotencyKey !== "string" || protocolIdempotencyKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  return `payswap:${protocolIdempotencyKey}`;
}

// ---------------------------------------------------------------------------
// The RailAdapter surface (provider-neutral framework registration)
// ---------------------------------------------------------------------------

/** The Flutterwave production rail adapter on the BaseRailAdapter framework. */
export class FlutterwaveProductionRail extends BaseRailAdapter {
  readonly adapterId = FLUTTERWAVE_RAIL_ADAPTER_ID;
  readonly implementationId = FLUTTERWAVE_RAIL_IMPLEMENTATION_ID;

  constructor() {
    const definitions = new Map<string, CapabilityDefinition>();
    for (const definition of flutterwaveCapabilityDefinitions()) {
      definitions.set(definition.capabilityId, definition);
    }
    super(flutterwaveRailCapabilityPack(), definitions);
  }
}

// ---------------------------------------------------------------------------
// The provider-facing client (ConnectorSDK; credential-gated, fail-closed)
// ---------------------------------------------------------------------------

/** Control-plane credentials (P2-W1-001): broker + registered runtime key. */
export interface FlutterwaveControlPlaneCredentials {
  readonly broker: CredentialBroker;
  readonly runtimeKey: ConnectorRuntimeKey;
}

export interface FlutterwaveConnectorConfig {
  readonly clock: ProtocolClock;
  readonly apiBase?: string;
  /** Overrides the pinned API version (tests only — production pins). */
  readonly apiVersion?: string;
  /**
   * The control-plane credential configuration key. Defaults to
   * `providerCredentialConfigKey("flutterwave")` = PROVIDER_FLUTTERWAVE_CREDENTIAL_REF.
   */
  readonly credentialConfigKey?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: FlutterwaveControlPlaneCredentials;
  /** Injectable environment (the W1-005 direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type FlutterwaveSdkRequest =
  | {
      readonly kind: "create_hosted_checkout";
      readonly amountMajor: string;
      readonly currency: string;
      readonly customer: { readonly email: string; readonly name?: string; readonly phoneNumber?: string };
      /** Overrides the derived tx_ref (flutterwaveTxRef). */
      readonly txRef?: string;
      readonly redirectUrl?: string;
      /** Payment-options channel filter, provider vocabulary (e.g. "mobilemoneyghana", "card", "banktransfer"). */
      readonly paymentOptions?: readonly string[];
    }
  | { readonly kind: "read_transaction"; readonly transactionId: string }
  | {
      readonly kind: "create_refund";
      readonly transactionId?: string;
      readonly txRef?: string;
      readonly amountMajor?: string;
    };

function isFlutterwaveSdkRequest(candidate: unknown): candidate is FlutterwaveSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/** Which credential path is live (observability — NEVER material). */
export type FlutterwaveCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

/**
 * The real Flutterwave connector (ConnectorSDK framework). Flutterwave API
 * names, payloads, response shapes and quirks stay INSIDE this
 * implementation: the SDK call contract is the provider-neutral
 * `FlutterwaveSdkRequest` union. Every effectful operation runs behind
 * `requireAuthority` (INV-C04/F05/F06) and fails closed with
 * `RailNotAuthorizedError` BEFORE any provider call when no credential path
 * is live (INV-NC04).
 */
export class FlutterwaveConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #apiBase: string;
  readonly #apiVersion: string;
  readonly #credentialConfigKey: string;
  readonly #controlPlane: FlutterwaveControlPlaneCredentials | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  #credentialBaseline: string | undefined;

  constructor(config: FlutterwaveConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#apiBase = config.apiBase ?? FLUTTERWAVE_DEFAULT_API_BASE;
    this.#apiVersion = config.apiVersion ?? FLUTTERWAVE_API_VERSION;
    this.#credentialConfigKey =
      config.credentialConfigKey ?? FLUTTERWAVE_CREDENTIAL_CONFIG_KEY;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: FLUTTERWAVE_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      systemKind: "psp",
      displayName: "Flutterwave (production connector)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return flutterwaveRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: this.#credentialConfigKey, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): FlutterwaveCredentialResolutionState {
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
          providerName: FLUTTERWAVE_PROVIDER_NAME,
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
          providerName: FLUTTERWAVE_PROVIDER_NAME,
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
        providerName: FLUTTERWAVE_PROVIDER_NAME,
        source: "PROVIDER_API",
        capturedAt: input.probe.checkedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(FLUTTERWAVE_RAIL_ADAPTER_ID, availability);
  }

  // -- SDK operation surface --------------------------------------------------

  async search(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "flutterwave search is not implemented — the connector's reconciliation path is the external transaction id (GET /v3/transactions/{id}, INV-X03), and no listing surface is in the connector contract",
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "read_transaction");
    if (request.kind !== "read_transaction") {
      throw new ValidationError("flutterwave read supports only { kind: 'read_transaction' }");
    }
    const observedAt = this.#envelopeContext();
    const data = await this.#withCredentials(async (material) =>
      this.#providerGet(
        `/v3/transactions/${encodeURIComponent(request.transactionId)}`,
        ctx.idempotencyKey,
        material,
      ),
    );
    return this.#sdkResult(
      flutterwaveTransactionEnvelope(data as FlutterwaveTransactionProviderObject, observedAt),
      `flutterwave:read-transaction:${request.transactionId}`,
    );
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "create_hosted_checkout");
    if (request.kind !== "create_hosted_checkout") {
      throw new ValidationError(
        "flutterwave create supports only { kind: 'create_hosted_checkout' }",
      );
    }
    if (
      request.amountMajor === undefined ||
      request.currency === undefined ||
      request.customer?.email === undefined
    ) {
      throw new ValidationError(
        "create_hosted_checkout requires amountMajor (exact major-unit decimal), currency and customer.email",
      );
    }
    const txRef = request.txRef ?? flutterwaveTxRef(ctx.idempotencyKey);
    const body: Record<string, unknown> = {
      tx_ref: txRef,
      amount: request.amountMajor,
      currency: request.currency.toUpperCase(),
      customer: {
        email: request.customer.email,
        ...(request.customer.name !== undefined ? { name: request.customer.name } : {}),
        ...(request.customer.phoneNumber !== undefined
          ? { phonenumber: request.customer.phoneNumber }
          : {}),
      },
      ...(request.redirectUrl !== undefined ? { redirect_url: request.redirectUrl } : {}),
      ...(request.paymentOptions !== undefined && request.paymentOptions.length > 0
        ? { payment_options: request.paymentOptions.join(",") }
        : {}),
    };
    const observedAt = this.#envelopeContext();
    // INV-X01: a transport failure mid-create is OUTCOME_UNKNOWN — a
    // checkout for this tx_ref may exist at the provider; reconcile by the
    // transaction id once known. NEVER FAILED.
    try {
      const data = await this.#withCredentials(async (material) =>
        this.#providerPost("/v3/payments", body, ctx.idempotencyKey, material),
      );
      const checkoutData = (data ?? {}) as FlutterwaveHostedCheckoutProviderObject;
      return this.#sdkResult(
        flutterwaveHostedCheckoutEnvelope(checkoutData, txRef, observedAt),
        `flutterwave:create-checkout:${txRef}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "hosted_checkout",
          externalId: txRef,
          operation: "create_hosted_checkout",
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
      "flutterwave hosted-checkout transactions are not mutable at the provider (create → payer checkout → read lifecycle only)",
    );
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "create_refund");
    if (request.kind !== "create_refund") {
      throw new ValidationError("flutterwave executeAction supports only { kind: 'create_refund' }");
    }
    if (request.transactionId === undefined && request.txRef === undefined) {
      throw new ValidationError("create_refund requires transactionId or txRef");
    }
    const observedAt = this.#envelopeContext();
    const body: Record<string, unknown> = {};
    if (request.transactionId !== undefined) {
      // The provider's refund surface keys on the numeric transaction id.
      const numeric = Number(request.transactionId);
      if (!Number.isInteger(numeric) || numeric <= 0) {
        throw new ValidationError("transactionId must be the provider's numeric transaction id");
      }
      body.transaction_id = numeric;
    }
    if (request.txRef !== undefined) {
      body.tx_ref = request.txRef;
    }
    if (request.amountMajor !== undefined) {
      body.amount = request.amountMajor;
    }
    // INV-X01: value can move on a refund — OUTCOME_UNKNOWN, never FAILED.
    try {
      const data = await this.#withCredentials(async (material) =>
        this.#providerPost("/v3/refunds", body, ctx.idempotencyKey, material),
      );
      const refundData = (data ?? {}) as FlutterwaveRefundProviderObject;
      return this.#sdkResult(
        flutterwaveRefundEnvelope(refundData, observedAt),
        `flutterwave:create-refund:${String(refundData.refund_id ?? request.transactionId ?? request.txRef ?? "pending")}:${this.#clock.now()}`,
      );
    } catch (error) {
      if (error instanceof RailTransportError) {
        return this.#outcomeUnknownResult({
          objectType: "refund",
          externalId: request.transactionId ?? request.txRef ?? "",
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
      "flutterwave event subscription is handled by the webhook ingestion framework (createFlutterwaveWebhookIngestor + @payswap/adapters ProviderWebhookIngestor), not the SDK subscribe surface",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "read_transaction");
    if (request.kind !== "read_transaction") {
      throw new ValidationError("flutterwave reconcile supports only { kind: 'read_transaction' }");
    }
    // Reconciliation-as-authority (INV-X03): re-fetch by external object id.
    return this.read(ctx);
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "flutterwave disconnection is a connector-registry lifecycle operation (revoke the ConnectedCapabilityInstance authorization and release the sealed credential handle); the provider surface offers no self-disconnect",
    );
  }

  // -- lifecycle operations ------------------------------------------------------

  /**
   * Credential rotation (CREDENTIAL-ROTATION.md, Flutterwave path —
   * swap-reference-then-verify): the vault binding for the control-plane
   * config key is swapped to a NEW reference at the vault; the connector
   * re-resolves per call, so the rotation is real exactly when the NEW
   * reference resolves and serves a successful health probe. The old key is
   * revoked at Flutterwave only after that verification.
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
          evidenceId: `flutterwave:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: FLUTTERWAVE_PROVIDER_NAME,
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
        "cannot rotate credentials: no credential path is provisioned for the flutterwave rail (packages/rails/BLOCKED-RAILS.md)",
        { railId: FLUTTERWAVE_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    const fingerprint = createHmac("sha256", "payswap-flutterwave-rotation-baseline")
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
        evidenceId: `flutterwave:cred-rotation:${rotatedAt}`,
        evidenceRef: `credential-rotation:${this.#credentialConfigKey}`,
        kind: "AUDIT_LOG",
        providerState: railEnvelope({
          providerName: FLUTTERWAVE_PROVIDER_NAME,
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
   * authenticated GET /v3/balances (the real probe) → HEALTHY.
   */
  async health(): Promise<ConnectorHealthReport> {
    const resolution = this.credentialResolutionState();
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: FLUTTERWAVE_CONNECTOR_ID,
      providerName: FLUTTERWAVE_PROVIDER_NAME,
      providerVersion: this.#apiVersion,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    if (resolution.kind === "NOT_PROVISIONED") {
      let endpointAnswered: boolean;
      try {
        await this.#http(`${this.#apiBase}/v3/balances`, {
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
        this.#providerGet("/v3/balances", "health-probe", material),
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
   * External funds observations from GET /v3/balances — one observation per
   * (wallet, balance kind) of PROVIDER-HELD funds on the connected
   * account's wallets (the 31-currency surface incl. the stablecoin
   * wallets). Observations ONLY (INV-C09): never custody, never a PaySwap
   * balance. Unconvertible wallets are honestly reported (never guessed).
   */
  async observeExternalFunds(): Promise<readonly ExternalFundsPositionObservation[]> {
    const observedAt = isoTimestamp(this.#clock.now());
    // #providerGet ALREADY unwraps the { status, message, data } envelope and
    // returns body.data — the balances array itself (no double unwrap)
    const balances = (await this.#withCredentials(async (material) =>
      this.#providerGet("/v3/balances", "balances", material),
    )) as readonly (
      | FlutterwaveWalletBalanceProviderObject
      | { readonly currency?: unknown }
    )[];
    const accountRef = `vault:${FLUTTERWAVE_CREDENTIAL_CONFIG_KEY}`;
    const { observations } = flutterwaveBalanceObservations({
      balances: balances as readonly FlutterwaveWalletBalanceProviderObject[],
      accountRef,
      observedAt,
    });
    return observations;
  }

  /**
   * The honest observation report: the ExternalFundsPositionObservations
   * PLUS the unconverted-wallet report (a wallet whose currency has no
   * known minor-unit exponent, or whose balance carries sub-minor precision
   * — reported, never fabricated).
   */
  async observeExternalFundsWithGaps(): Promise<{
    readonly observations: readonly ExternalFundsPositionObservation[];
    readonly unconverted: readonly FlutterwaveUnconvertedWallet[];
  }> {
    const observedAt = isoTimestamp(this.#clock.now());
    // #providerGet ALREADY unwraps the { status, message, data } envelope and
    // returns body.data — the balances array itself (no double unwrap)
    const balances = (await this.#withCredentials(async (material) =>
      this.#providerGet("/v3/balances", "balances", material),
    )) as readonly (
      | FlutterwaveWalletBalanceProviderObject
      | { readonly currency?: unknown }
    )[];
    const accountRef = `vault:${FLUTTERWAVE_CREDENTIAL_CONFIG_KEY}`;
    return flutterwaveBalanceObservations({
      balances: balances as readonly FlutterwaveWalletBalanceProviderObject[],
      accountRef,
      observedAt,
    });
  }

  // -- internals -------------------------------------------------------------------

  #envelopeContext(): FlutterwaveEnvelopeContext {
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
          "flutterwave rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any provider call — INV-NC04)",
          {
            railId: FLUTTERWAVE_RAIL_ADAPTER_ID,
            configKey: this.#credentialConfigKey,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => fn(extractFlutterwaveKeyMaterial(opened.material)),
      );
    }
    const material = this.#envMaterial();
    if (material === undefined) {
      throw new RailNotAuthorizedError(
        "flutterwave rail is not authorized: no credential path is provisioned — effectful operations fail closed before any provider call (INV-NC04; packages/rails/BLOCKED-RAILS.md)",
        { railId: FLUTTERWAVE_RAIL_ADAPTER_ID, envVar: this.#credentialConfigKey },
      );
    }
    return fn(material);
  }

  #request(ctx: SdkCallContext, expectedKind: string): FlutterwaveSdkRequest {
    const candidate = ctx.request;
    if (!isFlutterwaveSdkRequest(candidate)) {
      throw new ValidationError(
        `flutterwave rail call request must be a FlutterwaveSdkRequest object (expected kind '${expectedKind}')`,
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
      providerName: FLUTTERWAVE_PROVIDER_NAME,
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
        note: "transport failed mid-effect — the provider effect may have landed; reconcile by the transaction id (INV-X01/INV-X03); never coerced to FAILED",
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
      shareableFields: FLUTTERWAVE_SHAREABLE_FIELDS,
    });
    return this.#sdkResult(envelope, `flutterwave:outcome-unknown:${input.operation}:${input.idempotencyKey}`);
  }

  #responseData(body: unknown): unknown {
    if (body !== null && typeof body === "object" && "data" in body) {
      return (body as { readonly data?: unknown }).data;
    }
    throw new RailProviderError(
      "flutterwave response is malformed (expected { status, message, data })",
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
        throw new RailTransportError("flutterwave provider transport unreachable", {
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
      throw new RailTransportError("flutterwave provider transport unreachable", {
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
      throw new RailProviderError("flutterwave provider response is not JSON", {
        path,
        httpStatus: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const body = parsed as {
      readonly status?: string;
      readonly message?: string;
      readonly data?: unknown;
    };
    if (body !== null && typeof body === "object" && body.status === "error") {
      throw new RailProviderError(
        `flutterwave provider answered HTTP ${response.status}: ${body.message ?? "provider error"}`,
        { path, httpStatus: response.status, callRef },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(`flutterwave provider answered HTTP ${response.status}`, {
        path,
        httpStatus: response.status,
      });
    }
    return body.data;
  }
}

/**
 * Extracts the Flutterwave key material from a vault bundle shape. The
 * control plane hands the connector whatever the vault object holds: a
 * plain string key (FLWSECK-…), or a bundle record ({ secretKey } /
 * { secret_key } / { apiKey } / { api_key }). Any other shape refuses the
 * call (fail-closed, no guessing).
 */
export function extractFlutterwaveKeyMaterial(material: unknown): string {
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
    "the sealed credential bundle does not contain Flutterwave key material (expected a string key or { secretKey | secret_key | apiKey | api_key })",
  );
}
