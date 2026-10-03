/**
 * @payswap/onchain-adapters — vendor-neutral transport ports (P4-W2-001).
 *
 * NO single RPC/indexer/simulation vendor is a core dependency: every
 * provider shape (JSON-RPC endpoint, REST explorer) lives BEHIND these ports.
 * The SDK core depends only on the neutral onchain-domain contracts and these
 * ports; family adapters are wired with concrete endpoint profiles that
 * callers inject. No vendor SDK is imported anywhere in this package —
 * JSON-RPC and REST are spoken directly through the injected fetch port.
 *
 * Endpoint diversity law: a PRODUCTION transport must configure endpoints
 * from at least two DISTINCT providers (providerName), structurally
 * expressing that no single vendor can become a core dependency. The first
 * reachable endpoint serves the call; every answer records WHICH endpoint
 * served it (provenance). TRANSPORT_UNREACHABLE (all endpoints down) is a
 * reachability fact — callers surface it as availability UNKNOWN, never as
 * success or failure (INV-C01/C02).
 */

import { ValidationError } from "@payswap/protocol";
import { classifyChainEnvironment, type RailEnvironmentClass } from "./environment.js";
import { RailUnreachableError } from "./errors.js";

/** Transport protocol an endpoint speaks. */
export type TransportProtocol = "JSON_RPC" | "REST";

/**
 * A declared endpoint profile: who runs it, where it is, what it serves.
 * Endpoints for PUBLIC rails carry no credentials — an endpoint profile is
 * public descriptive data, never a secret (AGENTS.md rule 25).
 */
export interface EndpointProfile {
  readonly endpointId: string;
  /** Distinct provider identity (e.g. "PublicNode", "Blockstream"). */
  readonly providerName: string;
  readonly url: string;
  readonly protocol: TransportProtocol;
  /** The chainKey this endpoint is declared to serve. */
  readonly chainKey: string;
}

/** Which endpoint served a call (call-level provenance). */
export interface ServedBy {
  readonly transportId: string;
  readonly endpointId: string;
  readonly providerName: string;
}

export type RpcCallResult =
  | {
      readonly kind: "RPC_OK";
      readonly result: unknown;
      /** Raw response text — exact-numeric extraction without JSON double round-trip. */
      readonly raw: string;
      readonly servedBy: ServedBy;
    }
  | {
      readonly kind: "RPC_ERROR";
      readonly code?: number;
      readonly message: string;
      readonly servedBy: ServedBy;
    }
  | {
      readonly kind: "TRANSPORT_UNREACHABLE";
      readonly message: string;
      readonly attempted: readonly EndpointProfile[];
    };

/** The JSON-RPC transport port (vendor-neutral). */
export interface RpcTransport {
  readonly transportId: string;
  endpoints(): readonly EndpointProfile[];
  call(method: string, params: readonly unknown[]): Promise<RpcCallResult>;
}

export type RestCallResult =
  | {
      readonly kind: "REST_OK";
      readonly status: number;
      readonly body: unknown;
      /** Raw response text — exact-numeric extraction (fee rates) without float round-trip. */
      readonly raw: string;
      readonly servedBy: ServedBy;
    }
  | {
      readonly kind: "REST_ERROR";
      readonly status: number;
      readonly body?: unknown;
      readonly message: string;
      readonly servedBy: ServedBy;
    }
  | {
      readonly kind: "TRANSPORT_UNREACHABLE";
      readonly message: string;
      readonly attempted: readonly EndpointProfile[];
    };

/** The REST/explorer transport port (vendor-neutral; UTXO explorers, fee APIs). */
export interface RestTransport {
  readonly transportId: string;
  endpoints(): readonly EndpointProfile[];
  get(path: string): Promise<RestCallResult>;
  post(path: string, body: string, contentType: string): Promise<RestCallResult>;
}

function validateEndpoints(endpoints: readonly EndpointProfile[]): void {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new ValidationError("a transport requires at least one declared endpoint profile");
  }
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    for (const field of ["endpointId", "providerName", "url"] as const) {
      const value = endpoint[field];
      if (typeof value !== "string" || value.length === 0) {
        throw new ValidationError(`endpoint profile field '${field}' must be a non-empty string`);
      }
    }
    if (seen.has(endpoint.endpointId)) {
      throw new ValidationError(`duplicate endpointId '${endpoint.endpointId}'`);
    }
    seen.add(endpoint.endpointId);
    // Fail-closed: an endpoint serving an unclassified chainKey is a wiring
    // error (classifyChainEnvironment throws on unknown keys).
    classifyChainEnvironment(endpoint.chainKey);
  }
}

/**
 * Endpoint-provider diversity law for PRODUCTION transports: at least two
 * DISTINCT providerNames must be configured — no single vendor is a core
 * dependency. Non-production (testnet/regtest/simulation) transports are
 * exempt (single testnet faucets exist) but still recorded.
 */
export function assertEndpointProviderDiversity(
  endpoints: readonly EndpointProfile[],
  environmentClass: RailEnvironmentClass,
): void {
  validateEndpoints(endpoints);
  if (environmentClass !== "PRODUCTION") {
    return;
  }
  const providers = new Set(endpoints.map((endpoint) => endpoint.providerName));
  if (providers.size < 2) {
    throw new ValidationError(
      `a PRODUCTION transport must configure endpoints from at least two DISTINCT providers (found ${providers.size}: [${[...providers].join(", ")}]) — no single RPC/indexer vendor may become a core dependency`,
    );
  }
}

/** Injectable fetch port: production uses global fetch; tests script it. */
export type FetchLike = (
  url: string,
  init?: { readonly method?: string; readonly body?: string; readonly headers?: Record<string, string> },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

const DEFAULT_FETCH: FetchLike = (url, init) => {
  const requestInit: RequestInit = {};
  if (init?.method !== undefined) {
    requestInit.method = init.method;
  }
  if (init?.body !== undefined) {
    requestInit.body = init.body;
  }
  if (init?.headers !== undefined) {
    requestInit.headers = init.headers;
  }
  return globalThis.fetch(url, requestInit);
};

function requestUrl(endpoint: EndpointProfile, method: string): string {
  return endpoint.protocol === "JSON_RPC"
    ? endpoint.url
    : `${endpoint.url.replace(/\/$/, "")}${method}`;
}

async function callWithFailover(
  transportId: string,
  endpoints: readonly EndpointProfile[],
  makeRequest: (endpoint: EndpointProfile) => Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly text: () => Promise<string>;
  }>,
  options?: {
    /** HTTP statuses that fail over to the NEXT endpoint (provider-side pressure). */
    readonly failoverStatuses?: readonly number[];
  },
): Promise<{
  readonly endpoint: EndpointProfile;
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}> {
  const failoverStatuses = options?.failoverStatuses ?? [429, 500, 502, 503, 504];
  const failures: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const response = await makeRequest(endpoint);
      if (!response.ok && failoverStatuses.includes(response.status)) {
        failures.push(`${endpoint.endpointId}: HTTP ${response.status} (provider-side pressure — failing over)`);
        continue;
      }
      return { endpoint, ok: response.ok, status: response.status, text: await response.text() };
    } catch (error) {
      failures.push(`${endpoint.endpointId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new RailUnreachableError(
    `no endpoint of transport '${transportId}' was reachable (attempted ${endpoints.length}: ${endpoints.map((e) => e.endpointId).join(", ")}) — reachability UNKNOWN, never success/failure (INV-C02)`,
    { failures },
  );
}

/**
 * The concrete HTTP transport: speaks plain JSON-RPC 2.0 over the injected
 * fetch port with endpoint failover. Vendor shapes (provider SDKs) are never
 * imported; the first reachable endpoint serves the call and is recorded as
 * provenance. JSON-RPC-level errors (node rejections) are returned as
 * RPC_ERROR facts for the caller's deterministic classification — transport
 * ambiguity stays OUTSIDE the error surface (INV-X01 discipline).
 */
export class HttpJsonRpcTransport implements RpcTransport {
  readonly transportId: string;
  readonly #endpoints: readonly EndpointProfile[];
  readonly #fetch: FetchLike;

  constructor(input: {
    readonly transportId: string;
    readonly endpoints: readonly EndpointProfile[];
    readonly fetch?: FetchLike;
  }) {
    validateEndpoints(input.endpoints);
    this.transportId = input.transportId;
    this.#endpoints = Object.freeze([...input.endpoints]);
    this.#fetch = input.fetch ?? DEFAULT_FETCH;
  }

  endpoints(): readonly EndpointProfile[] {
    return this.#endpoints;
  }

  async call(method: string, params: readonly unknown[]): Promise<RpcCallResult> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const failures: string[] = [];
    let last: { ok: boolean; status: number; text: string; endpoint: EndpointProfile } | undefined;
    for (const endpoint of this.#endpoints) {
      try {
        const response = await this.#fetch(requestUrl(endpoint, method), {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json" },
        });
        const text = await response.text();
        last = { ok: response.ok, status: response.status, text, endpoint };
        // Provider-side pressure (HTTP-level) fails over to the next endpoint.
        if (!response.ok && [429, 500, 502, 503, 504].includes(response.status)) {
          failures.push(`${endpoint.endpointId}: HTTP ${response.status} (failing over)`);
          continue;
        }
        // Provider-side pressure (JSON-RPC-level rate limiting) also fails over.
        let parsedRateLimited = false;
        try {
          const record = JSON.parse(text) as { error?: { code?: number } } | null;
          if (record !== null && typeof record === "object" && record.error?.code === 429) {
            parsedRateLimited = true;
          }
        } catch {
          // non-JSON handled below for the final attempt
        }
        if (parsedRateLimited) {
          failures.push(`${endpoint.endpointId}: JSON-RPC 429 (rate limited — failing over)`);
          continue;
        }
        break;
      } catch (error) {
        failures.push(`${endpoint.endpointId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (last === undefined) {
      throw new RailUnreachableError(
        `no endpoint of transport '${this.transportId}' was reachable (attempted ${this.#endpoints.length}: ${this.#endpoints.map((e) => e.endpointId).join(", ")}) — reachability UNKNOWN, never success/failure (INV-C02)`,
        { failures },
      );
    }
    const attempt = last;
    const servedBy: ServedBy = Object.freeze({
      transportId: this.transportId,
      endpointId: attempt.endpoint.endpointId,
      providerName: attempt.endpoint.providerName,
    });
    if (!attempt.ok) {
      return {
        kind: "RPC_ERROR",
        code: attempt.status,
        message: `HTTP ${attempt.status} from endpoint '${attempt.endpoint.endpointId}'`,
        servedBy,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(attempt.text);
    } catch (error) {
      return {
        kind: "RPC_ERROR",
        message: `non-JSON response from endpoint '${attempt.endpoint.endpointId}': ${error instanceof Error ? error.message : String(error)}`,
        servedBy,
      };
    }
    const record = parsed as { error?: { code?: number; message?: string }; result?: unknown } | null;
    if (record !== null && typeof record === "object" && record.error !== undefined) {
      return {
        kind: "RPC_ERROR",
        ...(record.error.code !== undefined ? { code: record.error.code } : {}),
        message: String(record.error.message ?? "unspecified JSON-RPC error"),
        servedBy,
      };
    }
    return { kind: "RPC_OK", result: record?.result, raw: attempt.text, servedBy };
  }
}

/**
 * The concrete HTTP REST transport (UTXO explorer APIs, fee-estimate feeds).
 * Same failover and provenance discipline as the JSON-RPC transport.
 */
export class HttpRestTransport implements RestTransport {
  readonly transportId: string;
  readonly #endpoints: readonly EndpointProfile[];
  readonly #fetch: FetchLike;

  constructor(input: {
    readonly transportId: string;
    readonly endpoints: readonly EndpointProfile[];
    readonly fetch?: FetchLike;
  }) {
    validateEndpoints(input.endpoints);
    this.transportId = input.transportId;
    this.#endpoints = Object.freeze([...input.endpoints]);
    this.#fetch = input.fetch ?? DEFAULT_FETCH;
  }

  endpoints(): readonly EndpointProfile[] {
    return this.#endpoints;
  }

  async get(path: string): Promise<RestCallResult> {
    return this.#request("GET", path, undefined);
  }

  async post(path: string, body: string, contentType: string): Promise<RestCallResult> {
    return this.#request("POST", path, { body, contentType });
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    payload: { readonly body: string; readonly contentType: string } | undefined,
  ): Promise<RestCallResult> {
    const attempt = await callWithFailover(this.transportId, this.#endpoints, (endpoint) =>
      this.#fetch(requestUrl(endpoint, path), {
        method,
        ...(payload !== undefined ? { body: payload.body } : {}),
        headers:
          payload !== undefined
            ? { "Content-Type": payload.contentType }
            : { Accept: "application/json" },
      }),
    );
    const servedBy: ServedBy = Object.freeze({
      transportId: this.transportId,
      endpointId: attempt.endpoint.endpointId,
      providerName: attempt.endpoint.providerName,
    });
    if (!attempt.ok) {
      return {
        kind: "REST_ERROR",
        status: attempt.status,
        message: `HTTP ${attempt.status} from endpoint '${attempt.endpoint.endpointId}'`,
        servedBy,
      };
    }
    const text = attempt.text;
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text; // plain-text bodies (tx broadcast returns the txid as text)
    }
    return { kind: "REST_OK", status: attempt.status, body: parsed, raw: attempt.text, servedBy };
  }
}

// ---------------------------------------------------------------------------
// Exact-integer helpers for transport payloads (no float parsing on wire money)
// ---------------------------------------------------------------------------

const EXACT_DECIMAL = /^(0|[1-9][0-9]*)$/;

/** Parses a non-negative exact decimal string (INV-F01 shape guard). */
export function parseExactDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !EXACT_DECIMAL.test(value)) {
    throw new ValidationError(
      `${label} must be a non-negative exact decimal string without leading zeros (INV-F01: no floating-point money), got '${String(value)}'`,
    );
  }
  return value;
}

/** Converts a hex quantity (0x…) from an EVM RPC into an exact decimal string. */
export function hexQuantityToDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ValidationError(
      `${label} must be an EVM hex quantity string (0x-prefixed), got '${String(value)}'`,
    );
  }
  const decimal = BigInt(value).toString(10);
  return decimal;
}
