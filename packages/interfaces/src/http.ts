/**
 * REST boundary contract (application edge, FROZEN-ARCHITECTURE §20).
 *
 * Contract summary:
 * - Every request is authenticated (RequestAuth) and pins an explicit
 *   external API version via the X-PaySwap-API-Version header. There is no
 *   implicit/unversioned default.
 * - Every mutating request (POST/PUT/PATCH/DELETE) carries an idempotency
 *   key (Idempotency-Key header). One idempotency key maps to one
 *   authoritative command result (INV-F05). A mutation without an idempotency
 *   key is a contract violation (see validateRequestEnvelope).
 * - Successful responses use the envelope { data, meta } where meta carries
 *   schemaVersion, requestId and, on idempotent replay, idempotentReplay.
 * - Errors use the ApiError model with one of eight categories and a
 *   deterministic category → HTTP status mapping. EXTERNAL_AMBIGUITY maps to
 *   409 plus the response marker header X-PaySwap-Outcome: unknown — never a
 *   generic 500 — because an unknown external outcome must be surfaced for
 *   reconciliation (INV-X01/INV-X03: unknown external writes are never
 *   blindly retried and never presented as plain failure).
 *
 * Category → status mapping (deterministic, exhaustive):
 *   VALIDATION → 400          CONFLICT → 409
 *   NOT_FOUND → 404           EXTERNAL_AMBIGUITY → 409 (+ X-PaySwap-Outcome: unknown)
 *   AUTHORIZATION → 403       RATE_LIMITED → 429
 *   POLICY → 422              INTERNAL → 500
 */

import { CURRENT_API_VERSION } from './version.js';

/** Request header carrying the pinned external API version. */
export const API_VERSION_HEADER = 'X-PaySwap-API-Version';

/** Response marker header for externally ambiguous outcomes. */
export const OUTCOME_HEADER = 'X-PaySwap-Outcome';

/** Standard idempotency key header (required on mutations). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export const ERROR_CATEGORIES = [
  'VALIDATION',
  'CONFLICT',
  'NOT_FOUND',
  'AUTHORIZATION',
  'POLICY',
  'EXTERNAL_AMBIGUITY',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Documented status for externally ambiguous outcomes (never a generic 500). */
export const EXTERNAL_AMBIGUITY_HTTP_STATUS = 409;

/** Marker value for the X-PaySwap-Outcome header on EXTERNAL_AMBIGUITY. */
export const EXTERNAL_AMBIGUITY_OUTCOME_MARKER = 'unknown';

const CATEGORY_HTTP_STATUS: Readonly<Record<ErrorCategory, number>> = {
  VALIDATION: 400,
  CONFLICT: 409,
  NOT_FOUND: 404,
  AUTHORIZATION: 403,
  POLICY: 422,
  EXTERNAL_AMBIGUITY: EXTERNAL_AMBIGUITY_HTTP_STATUS,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/**
 * Deterministic, exhaustive category → HTTP status mapping.
 * EXTERNAL_AMBIGUITY → 409 with the outcome marker, never 500.
 */
export function mapErrorCategoryToHttpStatus(category: ErrorCategory): number {
  return CATEGORY_HTTP_STATUS[category];
}

/**
 * Returns the X-PaySwap-Outcome marker for an error category, or undefined
 * when no marker applies. Only EXTERNAL_AMBIGUITY carries a marker
 * ("unknown") today.
 */
export function outcomeMarkerForErrorCategory(category: ErrorCategory): string | undefined {
  return category === 'EXTERNAL_AMBIGUITY' ? EXTERNAL_AMBIGUITY_OUTCOME_MARKER : undefined;
}

/** REST error model. `code` is stable/machine-readable, `message` is human. */
export interface ApiError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  /** Structured, category-specific supplementary details. */
  readonly details?: Readonly<Record<string, unknown>>;
  /**
   * Reference to the reconciliation case tracking an externally ambiguous
   * outcome. Expected for EXTERNAL_AMBIGUITY errors.
   */
  readonly reconciliationRef?: string;
}

/** Response metadata shared by success and error envelopes. */
export interface ResponseMeta {
  /** Version of the payload schema for the returned object. */
  readonly schemaVersion: string;
  /** Server-assigned unique request identifier (also echoed for support). */
  readonly requestId: string;
  /** True when this response replays the authoritative result of a prior, identical idempotent mutation (INV-F05). */
  readonly idempotentReplay?: boolean;
}

/** Success response envelope. */
export interface ResponseEnvelope<TData> {
  readonly data: TData;
  readonly meta: ResponseMeta;
}

/** Error response envelope. */
export interface ErrorResponse {
  readonly error: ApiError;
  readonly meta: {
    readonly schemaVersion: string;
    readonly requestId: string;
  };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const MUTATING_HTTP_METHODS: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function isMutatingHttpMethod(method: string): boolean {
  return (MUTATING_HTTP_METHODS as readonly string[]).includes(method);
}

/** How the request was authenticated and on behalf of which principal. */
export interface RequestAuth {
  readonly principal: string;
  readonly scheme: 'SESSION' | 'API_KEY' | 'SERVICE_TOKEN';
}

/**
 * REST request envelope (transport-neutral shape of an authenticated call).
 *
 * - auth and apiVersion are required on every request;
 * - idempotencyKey is REQUIRED on mutations (INV-F05);
 * - body is optional (GET) or payload-bearing (mutations).
 */
export interface RequestEnvelope<TBody = unknown> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly auth: RequestAuth;
  /** The API version pinned via X-PaySwap-API-Version. Explicit; no default. */
  readonly apiVersion: string;
  /** REQUIRED on mutating requests: one key maps to one authoritative result. */
  readonly idempotencyKey?: string;
  readonly body?: TBody;
}

export type RequestValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly string[] };

export interface RequestValidationOptions {
  /** API versions the receiver currently accepts. Defaults to [CURRENT_API_VERSION]. */
  readonly supportedApiVersions?: readonly string[];
}

/**
 * Validates a request envelope against the REST contract.
 *
 * Contract violations detected:
 * - missing auth principal;
 * - missing/unsupported API version (explicit external versioning);
 * - mutating request without a non-empty idempotency key (INV-F05).
 */
export function validateRequestEnvelope(
  request: RequestEnvelope<unknown>,
  options?: RequestValidationOptions,
): RequestValidation {
  const violations: string[] = [];
  const auth = request?.auth;
  if (auth === undefined || auth === null || typeof auth.principal !== 'string' || auth.principal === '') {
    violations.push('auth.principal is required on every request');
  }
  const supported = options?.supportedApiVersions ?? [CURRENT_API_VERSION];
  if (typeof request.apiVersion !== 'string' || request.apiVersion === '') {
    violations.push(`apiVersion is required (${API_VERSION_HEADER}); external versioning is explicit`);
  } else if (!supported.includes(request.apiVersion)) {
    violations.push(`api.version_unsupported: ${request.apiVersion} (supported: ${supported.join(', ')})`);
  }
  if (
    isMutatingHttpMethod(request.method) &&
    (typeof request.idempotencyKey !== 'string' || request.idempotencyKey === '')
  ) {
    violations.push(
      `idempotencyKey is REQUIRED on mutating requests (${IDEMPOTENCY_KEY_HEADER}); one idempotency key maps to one authoritative command result (INV-F05)`,
    );
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
