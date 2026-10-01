/**
 * Shared support for the real rail adapters (W1-005).
 *
 * This module is PACKAGE-INTERNAL infrastructure: transports (HTTP and
 * JSON-RPC), the env-driven credential-reference surface (CREDENTIAL-
 * ROTATION.md), provider-state envelope construction helpers and execution-
 * evidence helpers. It defines NO new capability vocabulary (W2-003 owns
 * that) and NO provider-state model (ProviderStateEnvelope is consumed
 * verbatim from @payswap/connectors).
 *
 * Binding rules implemented here:
 * - INV-C01/C02: rail availability is derived through the canonical two-axis
 *   observation constructor (`unknownReachabilityObservation`) — an
 *   unreachable or uncredentialed source is UNKNOWN, never success/failure;
 * - INV-NC04: `RailNotAuthorizedError` fails every effectful operation
 *   closed when the credential surface is not provisioned — a rail that is
 *   not reachable AND authorized is never implied to be routable;
 * - INV-F01: monetary parsing helpers are exact string/bigint arithmetic;
 *   no floating-point money exists in this package;
 * - INV-E02: every provider effect is accompanied by an evidence draft.
 */

import { PaySwapError } from "@payswap/protocol";
import type { PaySwapErrorDetails, TimestampMs } from "@payswap/protocol";
import type {
  EvidenceKind,
  ProviderActionRequired,
  ProviderFailureMetadata,
  ProviderStateEnvelope,
  ProviderStateFamily,
  ProviderStateTransition,
} from "@payswap/connectors";
import { createProviderStateEnvelope } from "@payswap/connectors";
import type { ProviderExecutionEvidenceDraft } from "@payswap/execution";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * INV-NC04: an effectful rail operation was attempted while the rail is not
 * both reachable and authorized. The operation is refused BEFORE any
 * provider call — no fabricated outcome, no settlement effect.
 */
export class RailNotAuthorizedError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "RAIL_NOT_AUTHORIZED",
      category: "AUTHORIZATION_REQUIRED",
      message,
      details,
    });
    this.name = "RailNotAuthorizedError";
  }
}

/** The provider transport failed (network-level) — no provider state was obtained. */
export class RailTransportError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "RAIL_TRANSPORT_UNREACHABLE",
      category: "EXTERNAL_AMBIGUITY",
      message,
      details,
    });
    this.name = "RailTransportError";
  }
}

/** A provider answered with a protocol-level error the adapter cannot classify. */
export class RailProviderError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "RAIL_PROVIDER_ERROR",
      category: "EXTERNAL_AMBIGUITY",
      message,
      details,
    });
    this.name = "RailProviderError";
  }
}

// ---------------------------------------------------------------------------
// Transports (injectable; production uses the real global fetch)
// ---------------------------------------------------------------------------

/** A minimal HTTP transport — injectable so tests stay offline-deterministic. */
export type HttpTransport = (
  url: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly timeoutMs?: number;
  },
) => Promise<{ readonly status: number; readonly bodyText: string }>;

/** The default real HTTP transport over the platform fetch (Node >= 22). */
export const realHttpTransport: HttpTransport = async (url, init) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: controller.signal,
      cache: "no-store",
    });
    return { status: response.status, bodyText: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
};

/** One JSON-RPC 2.0 response (result XOR error). */
export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** An injectable JSON-RPC transport (method + params → response). */
export type JsonRpcTransport = (
  method: string,
  params: readonly unknown[],
) => Promise<JsonRpcResponse>;

/**
 * Builds a real JSON-RPC/HTTP transport for one endpoint. The request id is
 * a plain incrementing counter (deterministic per transport instance — no
 * Math.random anywhere in this package).
 */
export function jsonRpcOverHttp(
  endpoint: string,
  http: HttpTransport = realHttpTransport,
  timeoutMs = 15_000,
): JsonRpcTransport {
  let nextId = 1;
  return async (method, params) => {
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await http(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params }),
        timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(
        `JSON-RPC endpoint unreachable: ${endpoint}`,
        { endpoint, method, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    nextId += 1;
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(
        `JSON-RPC endpoint answered HTTP ${response.status}`,
        { endpoint, method, httpStatus: response.status },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError(
        "JSON-RPC response body is not JSON",
        { endpoint, method, cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    const candidate = parsed as Partial<JsonRpcResponse>;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      (candidate.error === undefined && !("result" in candidate))
    ) {
      throw new RailProviderError("JSON-RPC response is malformed", {
        endpoint,
        method,
      });
    }
    return parsed as JsonRpcResponse;
  };
}

// ---------------------------------------------------------------------------
// Credential-reference surface (CREDENTIAL-ROTATION.md — env-driven)
// ---------------------------------------------------------------------------

/** The declared credential surface of one rail (refs only — never values). */
export interface CredentialSourceDeclaration {
  readonly railId: string;
  /** Environment variable naming the secret-store reference. */
  readonly envVar: string;
  readonly kind: "API_KEY" | "OAUTH" | "DELEGATED_TOKEN" | "SESSION" | "PROVIDER_DEFINED";
  readonly description: string;
}

/** The full declared credential surface of this package (CREDENTIAL-ROTATION.md). */
export const RAIL_CREDENTIAL_ENV_VARS: readonly CredentialSourceDeclaration[] = Object.freeze([
  Object.freeze({
    railId: "rail.fiat.stripe-shape",
    envVar: "PAYSWAP_RAILS_FIAT_SECRET_REF",
    kind: "API_KEY",
    description: "Secret-store reference holding the PSP secret API key for the fiat payment-intent rail",
  }),
  Object.freeze({
    railId: "rail.mobile_money.mtn_momo",
    envVar: "PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF",
    kind: "API_KEY",
    description: "Secret-store reference holding the MTN MoMo product subscription key",
  }),
  Object.freeze({
    railId: "rail.mobile_money.mtn_momo",
    envVar: "PAYSWAP_RAILS_MOMO_API_USER_REF",
    kind: "PROVIDER_DEFINED",
    description: "Secret-store reference holding the provisioned MTN MoMo API user id",
  }),
  Object.freeze({
    railId: "rail.mobile_money.mtn_momo",
    envVar: "PAYSWAP_RAILS_MOMO_API_KEY_REF",
    kind: "PROVIDER_DEFINED",
    description: "Secret-store reference holding the provisioned MTN MoMo API user secret",
  }),
]);

/** Reads the secret-store reference for an env var, or undefined when absent. */
export function credentialRefFromEnv(
  envVar: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[envVar];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolves the credential-ref presence for one rail. Absence is an explicit
 * state ("NOT_PROVISIONED"), never an empty credential: the rail fails
 * closed (INV-NC04) and its availability is UNKNOWN (INV-C01/C02).
 */
export function resolveCredentialRefs(
  declarations: readonly CredentialSourceDeclaration[],
  env: NodeJS.ProcessEnv = process.env,
): { readonly provisioned: boolean; readonly refs: Readonly<Record<string, string>> } {
  const refs: Record<string, string> = {};
  let provisioned = true;
  for (const declaration of declarations) {
    const ref = credentialRefFromEnv(declaration.envVar, env);
    if (ref === undefined) {
      provisioned = false;
    } else {
      refs[declaration.envVar] = ref;
    }
  }
  return { provisioned, refs: Object.freeze(refs) };
}

// ---------------------------------------------------------------------------
// Envelope + evidence helpers (INV-C06 / INV-E02)
// ---------------------------------------------------------------------------

/** Minimal input for constructing a validated provider state envelope. */
export interface RailEnvelopeInput {
  readonly providerName: string;
  readonly providerVersion: string;
  readonly objectType: string;
  readonly externalId: string;
  readonly revision: string;
  /** Raw provider-native state — carried VERBATIM (INV-C06). */
  readonly state: unknown;
  readonly family: ProviderStateFamily;
  readonly lifecycleStep: string;
  readonly isTerminal: boolean;
  readonly requiresCustomerAction: boolean;
  readonly observedAt: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK" | "OPERATOR";
  readonly fetchId?: string;
  readonly actionRequired?: ProviderActionRequired;
  readonly failure?: ProviderFailureMetadata;
  readonly history?: readonly ProviderStateTransition[];
}

/**
 * Constructs a validated ProviderStateEnvelope with a PUBLIC privacy scope
 * over provider-technical payloads (rail adapters carry no regulated PII in
 * state objects; PSP-specific metadata may be re-scoped by the connector).
 */
export function railEnvelope(input: RailEnvelopeInput): ProviderStateEnvelope {
  return createProviderStateEnvelope({
    provider: { name: input.providerName, version: input.providerVersion },
    object: { objectType: input.objectType, externalId: input.externalId },
    revision: input.revision,
    state: input.state,
    classification: {
      family: input.family,
      lifecycleStep: input.lifecycleStep,
      isTerminal: input.isTerminal,
      requiresCustomerAction: input.requiresCustomerAction,
    },
    history: input.history ?? [],
    ...(input.actionRequired !== undefined ? { actionRequired: input.actionRequired } : {}),
    ...(input.failure !== undefined ? { failure: input.failure } : {}),
    privacy: {
      dataClassification: "PUBLIC",
      constraints: ["provider-technical-payload"],
      shareableFields: ["status", "revision", "blockHash", "confirmations"],
    },
    timestamps: { observedAt: input.observedAt },
    provenance: {
      source: input.provenanceSource,
      ...(input.fetchId !== undefined ? { fetchId: input.fetchId } : {}),
    },
  });
}

/**
 * INV-E02: an execution-evidence draft for one provider effect/observation.
 * The draft is what callers attach to attempt ledgers / evidence graphs.
 */
export function railEvidence(input: {
  readonly evidenceId: string;
  readonly evidenceRef: string;
  readonly kind: EvidenceKind;
  readonly providerState: ProviderStateEnvelope;
  readonly recordedAt: TimestampMs;
}): ProviderExecutionEvidenceDraft {
  return Object.freeze({
    evidenceId: input.evidenceId,
    kind: input.kind,
    evidenceRef: input.evidenceRef,
    providerState: input.providerState,
    recordedAt: input.recordedAt,
  });
}

// ---------------------------------------------------------------------------
// Exact number parsing (INV-F01 — no floating-point money anywhere)
// ---------------------------------------------------------------------------

/**
 * Parses a non-negative decimal string (e.g. "1.1355") into an EXACT
 * rational { numerator, denominator } of bigints. Throws on anything that is
 * not a plain non-negative decimal — floats never appear.
 */
export function exactRationalFromDecimal(decimal: string): {
  readonly numerator: bigint;
  readonly denominator: bigint;
} {
  if (typeof decimal !== "string" || !/^\d+(\.\d+)?$/.test(decimal)) {
    throw new PaySwapError({
      code: "INVALID_EXACT_DECIMAL",
      category: "VALIDATION",
      message: `expected a non-negative decimal string, got: ${String(decimal)}`,
    });
  }
  const [wholePart, fractionalPart = ""] = decimal.split(".");
  const numerator = BigInt(`${wholePart ?? "0"}${fractionalPart}`);
  const denominator = 10n ** BigInt(fractionalPart.length);
  return Object.freeze({ numerator, denominator });
}

/** Parses a hexadecimal quantity (JSON-RPC "0x…" values) into an exact bigint. */
export function exactBigintFromHex(hex: string): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new PaySwapError({
      code: "INVALID_HEX_QUANTITY",
      category: "VALIDATION",
      message: `expected a 0x-prefixed hex quantity, got: ${String(hex)}`,
    });
  }
  return BigInt(hex);
}

/** Converts a bigint to a minimal 0x-prefixed hex quantity. */
export function hexFromBigint(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/** ISO timestamp (UTC) for a bigint TimestampMs. */
export function isoTimestamp(ms: TimestampMs): string {
  return new Date(Number(ms)).toISOString();
}

// ---------------------------------------------------------------------------
// Rail-implication gate (INV-NC04)
// ---------------------------------------------------------------------------

/** The routability implication a caller may draw for one rail. */
export interface RailImplication {
  readonly railId: string;
  /** True ONLY when the observed effective availability is AVAILABLE. */
  readonly routable: boolean;
  readonly reason: string;
}

/**
 * INV-NC04: a connector cannot imply support for a rail that is not actually
 * reachable and authorized. This gate maps an observed effective
 * availability to the strongest implication a caller may draw: anything but
 * `AVAILABLE` (including and especially `UNKNOWN`) is NOT routable, with the
 * reason recorded so routing/support surfaces never present an unroutable
 * rail as supported.
 */
export function routableRailImplication(
  railId: string,
  availability: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN",
): RailImplication {
  switch (availability) {
    case "AVAILABLE":
      return Object.freeze({ railId, routable: true, reason: "observed AVAILABLE" });
    case "DEGRADED":
      return Object.freeze({
        railId,
        routable: false,
        reason: "rail observed DEGRADED — not routable (INV-NC04)",
      });
    case "UNAVAILABLE":
      return Object.freeze({
        railId,
        routable: false,
        reason: "rail observed UNAVAILABLE — not routable (INV-NC04)",
      });
    case "UNKNOWN":
      return Object.freeze({
        railId,
        routable: false,
        reason:
          "rail availability UNKNOWN (source unreachable or unauthorized) — a connector cannot imply support for an unroutable rail (INV-NC04; INV-C01/C02)",
      });
  }
}
