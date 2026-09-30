/**
 * Webhook boundary contract (provider/application edge, FROZEN-ARCHITECTURE §20).
 *
 * Delivery contract:
 * - events are delivered as a versioned WebhookEventEnvelope;
 * - every delivery carries X-PaySwap-Signature and X-PaySwap-Timestamp
 *   headers;
 * - the signature is v1 = hex(HMAC-SHA256(secret, `${timestamp}.${canonicalJson(envelope)}`))
 *   where canonicalJson is the canonicalization documented in
 *   canonical-json.ts (sorted keys, no whitespace). Because the signed bytes
 *   are the canonical serialization, JSON key order at the transport layer
 *   does not affect verification;
 * - the timestamp is Unix epoch seconds; receivers reject timestamps outside
 *   the replay window (default 300 seconds) to bound replay attacks.
 *
 * Delivery attempts are recorded (WebhookDeliveryAttempt) for observability
 * and outbox-style reliability (INV-O02 adjacent).
 *
 * Webhooks are edge adapters, not domain authority (§20): receiving an event
 * never mutates financial truth by itself; reconciliation resolves ambiguous
 * external effects (INV-X03).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';

/** Transport header carrying the HMAC signature (v1 = hex digest). */
export const SIGNATURE_HEADER = 'X-PaySwap-Signature';

/** Transport header carrying the Unix-epoch-seconds signing timestamp. */
export const TIMESTAMP_HEADER = 'X-PaySwap-Timestamp';

export const SIGNATURE_SCHEME = 'v1';

/** Default replay window for signature timestamps (seconds). */
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

/** Versioned webhook event envelope. */
export interface WebhookEventEnvelope<TData = unknown> {
  readonly id: string;
  readonly type: string;
  /** RFC 3339 timestamp of the recorded occurrence. */
  readonly occurredAt: string;
  readonly schemaVersion: string;
  readonly data: TData;
}

/** Record of one delivery attempt of one envelope. */
export interface WebhookDeliveryAttempt {
  readonly envelopeId: string;
  readonly attemptNumber: number;
  readonly attemptedAt: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'RETRY_SCHEDULED';
  readonly responseStatus?: number;
  readonly nextAttemptAt?: string;
}

/** Signature headers for one signed delivery. */
export interface WebhookSignatureHeaders {
  /** Value for X-PaySwap-Signature: `v1=<hex hmac-sha256>`. */
  readonly signature: string;
  /** Value for X-PaySwap-Timestamp: Unix epoch seconds. */
  readonly timestamp: string;
}

export interface WebhookVerificationOptions {
  /** Verification time (epoch seconds); defaults to now. */
  readonly nowSeconds?: number;
  /** Replay tolerance in seconds; defaults to DEFAULT_REPLAY_WINDOW_SECONDS. */
  readonly replayWindowSeconds?: number;
}

export type WebhookVerification =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason:
        | 'MALFORMED_SIGNATURE'
        | 'MALFORMED_TIMESTAMP'
        | 'SIGNATURE_MISMATCH'
        | 'TIMESTAMP_OUTSIDE_REPLAY_WINDOW';
    };

function signedPayload(timestampSeconds: number, envelope: WebhookEventEnvelope<unknown>): string {
  return `${timestampSeconds}.${canonicalJson(envelope)}`;
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 127) {
      throw new Error('signature material must be ASCII');
    }
    bytes[index] = code;
  }
  return bytes;
}

/**
 * Signs a webhook envelope with HMAC-SHA256 over the canonical JSON of the
 * envelope joined with the timestamp. Conformance helper for producers; the
 * canonicalization is part of the wire contract.
 */
export function signWebhookEvent<TData>(
  envelope: WebhookEventEnvelope<TData>,
  secret: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): WebhookSignatureHeaders {
  const mac = createHmac('sha256', secret)
    .update(signedPayload(timestampSeconds, envelope), 'utf8')
    .digest('hex');
  return { signature: `${SIGNATURE_SCHEME}=${mac}`, timestamp: String(timestampSeconds) };
}

/**
 * Verifies webhook signature headers against an envelope.
 *
 * Failure modes: malformed timestamp/signature, signature mismatch (covers
 * tampered payloads and wrong secrets), timestamp outside the replay window.
 * Comparison is constant-time over the hex digests.
 */
export function verifyWebhookEvent<TData>(
  envelope: WebhookEventEnvelope<TData>,
  secret: string,
  headers: WebhookSignatureHeaders,
  options?: WebhookVerificationOptions,
): WebhookVerification {
  if (typeof headers?.timestamp !== 'string' || !/^\d+$/.test(headers.timestamp)) {
    return { valid: false, reason: 'MALFORMED_TIMESTAMP' };
  }
  const timestamp = Number.parseInt(headers.timestamp, 10);
  if (typeof headers.signature !== 'string' || !headers.signature.startsWith(`${SIGNATURE_SCHEME}=`)) {
    return { valid: false, reason: 'MALFORMED_SIGNATURE' };
  }
  const presented = headers.signature.slice(SIGNATURE_SCHEME.length + 1);
  if (!/^[0-9a-f]+$/.test(presented)) {
    return { valid: false, reason: 'MALFORMED_SIGNATURE' };
  }
  const expected = createHmac('sha256', secret)
    .update(signedPayload(timestamp, envelope), 'utf8')
    .digest('hex');
  const presentedBytes = asciiBytes(presented);
  const expectedBytes = asciiBytes(expected);
  if (presentedBytes.length !== expectedBytes.length || !timingSafeEqual(presentedBytes, expectedBytes)) {
    return { valid: false, reason: 'SIGNATURE_MISMATCH' };
  }
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const replayWindowSeconds = options?.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;
  if (Math.abs(nowSeconds - timestamp) > replayWindowSeconds) {
    return { valid: false, reason: 'TIMESTAMP_OUTSIDE_REPLAY_WINDOW' };
  }
  return { valid: true };
}
