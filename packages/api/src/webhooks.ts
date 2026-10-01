/**
 * @payswap/api — webhook delivery (W3-002).
 *
 * Implements the W3-001 webhook boundary contract on the producer side:
 * - events are delivered as versioned WebhookEventEnvelopes;
 * - every delivery carries X-PaySwap-Signature / X-PaySwap-Timestamp headers
 *   produced by the contract helper `signWebhookEvent` (HMAC-SHA256 over
 *   `${timestamp}.${canonicalJson(envelope)}`) — the timestamp comes from the
 *   INJECTED clock, never ambient time;
 * - delivery goes through an injected `WebhookTransport` port (the production
 *   HTTP client is a composition-root concern; tests inject deterministic
 *   transports). Receiving an event is never domain authority (§20);
 * - failed deliveries retry with deterministic exponential backoff computed
 *   from the injected clock; every attempt is recorded
 *   (WebhookDeliveryAttempt) for observability; after maxAttempts the
 *   delivery is marked FAILED.
 *
 * Signature verification is delegated to the contract helper
 * `verifyWebhookEvent` (constant-time comparison, replay window).
 */

import type {
  WebhookDeliveryAttempt,
  WebhookEventEnvelope,
  WebhookSignatureHeaders,
  WebhookVerification,
  WebhookVerificationOptions,
} from '@payswap/interfaces';
import { signWebhookEvent, verifyWebhookEvent } from '@payswap/interfaces';
import type { IdFactory, ProtocolClock } from '@payswap/protocol';
import { ValidationError } from '@payswap/protocol';

/** A registered webhook delivery endpoint. */
export interface WebhookEndpointConfig {
  readonly endpointId: string;
  readonly url: string;
  /**
   * Endpoint signing secret. PRODUCTION: injected from a secrets vault by the
   * composition root; tests inject deterministic secrets.
   */
  readonly secret: string;
}

/** Outcome of one transport-level delivery attempt. */
export type WebhookTransportOutcome =
  | { readonly ok: true; readonly responseStatus: number }
  | { readonly ok: false; readonly responseStatus?: number };

/** The delivery port: how envelopes physically leave the system. */
export interface WebhookTransport {
  deliver(input: {
    readonly url: string;
    readonly envelope: WebhookEventEnvelope;
    readonly headers: WebhookSignatureHeaders;
  }): Promise<WebhookTransportOutcome>;
}

export interface WebhookDispatcherDeps {
  readonly clock: ProtocolClock;
  readonly transport: WebhookTransport;
  readonly ids: IdFactory;
}

export interface WebhookDispatcherOptions {
  /** Maximum attempts per delivery (default 5). */
  readonly maxAttempts?: number;
  /** Base backoff in ms after attempt n (default 1000; doubles per attempt). */
  readonly backoffBaseMs?: number;
}

interface ScheduledRetry {
  readonly envelope: WebhookEventEnvelope;
  readonly endpoint: WebhookEndpointConfig;
  readonly attemptNumber: number;
  readonly nextAttemptAtMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 1_000;

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
}

/**
 * Webhook dispatcher: endpoint registration, HMAC-signed delivery with
 * deterministic clock-based retry/backoff, and an append-only attempt log.
 */
export class WebhookDispatcher {
  readonly #clock: ProtocolClock;
  readonly #transport: WebhookTransport;
  readonly #ids: IdFactory;
  readonly #maxAttempts: number;
  readonly #backoffBaseMs: number;
  readonly #endpoints = new Map<string, WebhookEndpointConfig>();
  readonly #attemptLog: WebhookDeliveryAttempt[] = [];
  readonly #scheduled: ScheduledRetry[] = [];

  constructor(deps: WebhookDispatcherDeps, options?: WebhookDispatcherOptions) {
    this.#clock = deps.clock;
    this.#transport = deps.transport;
    this.#ids = deps.ids;
    this.#maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#backoffBaseMs = options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    if (this.#maxAttempts < 1) {
      throw new ValidationError('maxAttempts must be at least 1');
    }
    if (this.#backoffBaseMs <= 0) {
      throw new ValidationError('backoffBaseMs must be positive');
    }
  }

  registerEndpoint(config: WebhookEndpointConfig): void {
    requireNonEmpty(config.endpointId, 'endpointId');
    requireNonEmpty(config.url, 'url');
    requireNonEmpty(config.secret, 'secret');
    this.#endpoints.set(config.endpointId, Object.freeze({ ...config }));
  }

  getEndpoint(endpointId: string): WebhookEndpointConfig | undefined {
    return this.#endpoints.get(endpointId);
  }

  /**
   * Dispatch an envelope to a registered endpoint: one immediate signed
   * attempt; on failure a retry is scheduled with deterministic backoff
   * (advanced by runDueDeliveries once the injected clock passes the
   * scheduled time).
   */
  async dispatch(envelope: WebhookEventEnvelope, endpointId: string): Promise<WebhookDeliveryAttempt> {
    const endpoint = this.#endpoints.get(endpointId);
    if (endpoint === undefined) {
      throw new ValidationError(`unknown webhook endpoint: ${endpointId}`);
    }
    requireNonEmpty(envelope.id, 'envelope.id');
    return this.#attempt(envelope, endpoint, 1);
  }

  /** Process every scheduled retry whose backoff window has elapsed. */
  async runDueDeliveries(): Promise<readonly WebhookDeliveryAttempt[]> {
    const nowMs = this.#nowMs();
    const due = this.#scheduled.filter((entry) => entry.nextAttemptAtMs <= nowMs);
    if (due.length === 0) {
      return [];
    }
    for (const entry of due) {
      const index = this.#scheduled.indexOf(entry);
      if (index >= 0) {
        this.#scheduled.splice(index, 1);
      }
    }
    const attempts: WebhookDeliveryAttempt[] = [];
    for (const entry of due) {
      attempts.push(await this.#attempt(entry.envelope, entry.endpoint, entry.attemptNumber));
    }
    return attempts;
  }

  /** Append-only delivery attempt log (observability). */
  attempts(): readonly WebhookDeliveryAttempt[] {
    return [...this.#attemptLog];
  }

  /** Last recorded attempt for one envelope (observability). */
  lastAttemptFor(envelopeId: string): WebhookDeliveryAttempt | undefined {
    for (let index = this.#attemptLog.length - 1; index >= 0; index -= 1) {
      const attempt = this.#attemptLog[index];
      if (attempt !== undefined && attempt.envelopeId === envelopeId) {
        return attempt;
      }
    }
    return undefined;
  }

  /**
   * Verify a delivery's signature headers (receiver-side conformance helper;
   * constant-time, replay-window aware). Verification time defaults to the
   * injected clock.
   */
  verifyDelivery(
    envelope: WebhookEventEnvelope,
    secret: string,
    headers: WebhookSignatureHeaders,
    options?: WebhookVerificationOptions,
  ): WebhookVerification {
    const effectiveOptions: WebhookVerificationOptions | undefined =
      options === undefined
        ? { nowSeconds: this.#epochSeconds() }
        : { ...options, nowSeconds: options.nowSeconds ?? this.#epochSeconds() };
    return verifyWebhookEvent(envelope, secret, headers, effectiveOptions);
  }

  async #attempt(
    envelope: WebhookEventEnvelope,
    endpoint: WebhookEndpointConfig,
    attemptNumber: number,
  ): Promise<WebhookDeliveryAttempt> {
    const headers = signWebhookEvent(envelope, endpoint.secret, this.#epochSeconds());
    const outcome = await this.#transport.deliver({ url: endpoint.url, envelope, headers });
    const attemptedAt = this.#isoNow();
    if (outcome.ok) {
      const attempt: WebhookDeliveryAttempt = {
        envelopeId: envelope.id,
        attemptNumber,
        attemptedAt,
        outcome: 'SUCCEEDED',
        responseStatus: outcome.responseStatus,
      };
      this.#record(attempt);
      return attempt;
    }
    if (attemptNumber >= this.#maxAttempts) {
      const attempt: WebhookDeliveryAttempt = {
        envelopeId: envelope.id,
        attemptNumber,
        attemptedAt,
        outcome: 'FAILED',
        ...(outcome.responseStatus === undefined ? {} : { responseStatus: outcome.responseStatus }),
      };
      this.#record(attempt);
      return attempt;
    }
    const nextAttemptAtMs = this.#nowMs() + this.#backoffMsAfterAttempt(attemptNumber);
    const attempt: WebhookDeliveryAttempt = {
      envelopeId: envelope.id,
      attemptNumber,
      attemptedAt,
      outcome: 'RETRY_SCHEDULED',
      ...(outcome.responseStatus === undefined ? {} : { responseStatus: outcome.responseStatus }),
      nextAttemptAt: this.#isoFromMs(BigInt(nextAttemptAtMs)),
    };
    this.#record(attempt);
    this.#scheduled.push({
      envelope,
      endpoint,
      attemptNumber: attemptNumber + 1,
      nextAttemptAtMs,
    });
    return attempt;
  }

  #record(attempt: WebhookDeliveryAttempt): void {
    this.#attemptLog.push(Object.freeze({ ...attempt }));
  }

  /** Deterministic exponential backoff: base * 2^(attemptNumber - 1). */
  #backoffMsAfterAttempt(attemptNumber: number): number {
    return this.#backoffBaseMs * 2 ** (attemptNumber - 1);
  }

  #nowMs(): number {
    return Number(this.#clock.now());
  }

  #epochSeconds(): number {
    return Number(this.#clock.now() / 1000n);
  }

  #isoNow(): string {
    return this.#isoFromMs(this.#clock.now());
  }

  #isoFromMs(ms: bigint): string {
    return new Date(Number(ms)).toISOString();
  }
}
