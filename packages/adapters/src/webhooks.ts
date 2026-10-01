/**
 * Webhook/event ingestion (W3-003; INTEGRATIONS.md; PSP-ADAPTER-NETWORK
 * "Reconciliation": no external processor webhook becomes truth without
 * adapter verification and protocol reconciliation).
 *
 * Provider → PaySwap event ingestion with, in order:
 * 1. signature verification through an injected hook
 *    (`WebhookSignatureVerifier`) — the deterministic reference
 *    implementation is HMAC-SHA256 over `${timestamp}.${canonicalBody}`;
 * 2. replay protection: a timestamp outside the ingestion window (stale or
 *    unreasonably in the future) is REJECTED;
 * 3. idempotent ingestion: the (provider, eventId) pair is the dedupe key —
 *    a duplicate delivery is acknowledged as ALREADY_INGESTED, never
 *    ingested twice;
 * 4. provider evidence preservation: every ingested event produces a
 *    ProviderExecutionEvidence draft (kind WEBHOOK_EVENT) that the caller
 *    attaches to the linked ExecutionAttempt through the execution ledger
 *    (INV-E02), carrying the optional lossless ProviderStateEnvelope mapped
 *    from the raw payload (INV-C06). The evidence log is append-only
 *    (INV-E05).
 *
 * Deterministic: all time flows through the injected protocol clock; the
 * reference HMAC verifier uses node:crypto only (a builtin — no runtime
 * dependency, no network).
 */

import { createHmac } from "node:crypto";
import { ValidationError } from "@payswap/protocol";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import type { ProviderStateEnvelope } from "@payswap/connectors";
import type { ExecutionAttemptId, ProviderExecutionEvidenceDraft } from "@payswap/execution";

// ---------------------------------------------------------------------------
// Raw provider events
// ---------------------------------------------------------------------------

/** Signature headers attached by the provider to a webhook delivery. */
export interface ProviderWebhookHeaders {
  readonly signature: string;
  /** Provider-issued epoch seconds (string-encoded). */
  readonly timestamp: string;
}

/** A raw provider webhook delivery, exactly as received. */
export interface ProviderWebhookRawEvent {
  readonly providerName: string;
  /** The provider's event id — the idempotency (dedupe) key. */
  readonly eventId: string;
  /** Provider-issued epoch seconds (string-encoded). */
  readonly timestamp: string;
  /** Raw provider payload, preserved verbatim. */
  readonly payload: unknown;
  readonly headers: ProviderWebhookHeaders;
}

/** The preserved record of one ingested event (append-only log entry). */
export interface PreservedProviderEvent {
  readonly providerName: string;
  readonly eventId: string;
  readonly ingestedAt: TimestampMs;
  readonly payload: unknown;
  readonly attemptId?: ExecutionAttemptId;
  readonly providerState?: ProviderStateEnvelope;
}

// ---------------------------------------------------------------------------
// Signature verification hook
// ---------------------------------------------------------------------------

export type WebhookSignatureVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * The signature-verification hook. Implementations are provider-specific and
 * stay inside connector implementations; the ingestor only requires the
 * boolean outcome and a reason on failure.
 */
export interface WebhookSignatureVerifier {
  verify(event: ProviderWebhookRawEvent, canonicalBody: string): WebhookSignatureVerification;
}

/**
 * Deterministic canonical body for signature purposes: JSON serialization of
 * the payload. Providers sign bytes; this framework signs the canonical
 * serialization so signatures are reproducible without byte-level capture.
 */
export function canonicalWebhookBody(payload: unknown): string {
  return JSON.stringify(payload ?? null);
}

/** Deterministic HMAC-SHA256 signature over `${timestamp}.${canonicalBody}`. */
export function signProviderWebhook(
  secret: string,
  timestamp: string,
  canonicalBody: string,
): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.${canonicalBody}`);
  return mac.digest("hex");
}

/** Constant-time hex comparison (no early exit on first differing byte). */
function constantTimeEqualsHex(left: string, right: string): boolean {
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
 * The reference HMAC-SHA256 verifier (deterministic; node:crypto builtin).
 * Production connectors inject their provider's scheme through the same hook.
 */
export function createHmacVerifier(secret: string): WebhookSignatureVerifier {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new ValidationError("an HMAC verifier requires a non-empty secret");
  }
  return {
    verify(event: ProviderWebhookRawEvent, canonicalBody: string): WebhookSignatureVerification {
      const expected = signProviderWebhook(secret, event.timestamp, canonicalBody);
      if (
        typeof event.headers.signature !== "string" ||
        event.headers.signature.length === 0 ||
        !constantTimeEqualsHex(event.headers.signature, expected)
      ) {
        return { valid: false, reason: "SIGNATURE_INVALID" };
      }
      return { valid: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export type WebhookRejectionReason =
  | "MALFORMED_EVENT"
  | "SIGNATURE_INVALID"
  | "TIMESTAMP_OUTSIDE_WINDOW"
  | "FUTURE_TIMESTAMP";

export type WebhookIngestionOutcome =
  | {
      readonly kind: "INGESTED";
      readonly event: PreservedProviderEvent;
      readonly evidence: ProviderExecutionEvidenceDraft;
    }
  | {
      readonly kind: "ALREADY_INGESTED";
      readonly providerName: string;
      readonly eventId: string;
    }
  | {
      readonly kind: "REJECTED";
      readonly reason: WebhookRejectionReason;
    };

export interface ProviderWebhookIngestorDeps {
  readonly verifier: WebhookSignatureVerifier;
  readonly clock: ProtocolClock;
  /** Replay window in seconds (default 300). */
  readonly replayWindowSeconds?: number;
  /** Maximum tolerated future skew in seconds (default 5). */
  readonly futureSkewSeconds?: number;
}

export interface IngestWebhookOptions {
  /** Links the produced evidence to an execution attempt (INV-E02). */
  readonly attemptId?: ExecutionAttemptId;
  /** The lossless provider state mapped from the raw payload (INV-C06). */
  readonly providerState?: ProviderStateEnvelope;
}

const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
const DEFAULT_FUTURE_SKEW_SECONDS = 5;

/**
 * The provider webhook ingestor: signature verification, replay protection,
 * idempotent ingestion and provider evidence preservation. The ingested
 * event log is append-only (INV-E05).
 */
export class ProviderWebhookIngestor {
  readonly #verifier: WebhookSignatureVerifier;
  readonly #clock: ProtocolClock;
  readonly #replayWindowSeconds: number;
  readonly #futureSkewSeconds: number;
  readonly #ingested = new Map<string, PreservedProviderEvent>();
  readonly #log: PreservedProviderEvent[] = [];

  constructor(deps: ProviderWebhookIngestorDeps) {
    this.#verifier = deps.verifier;
    this.#clock = deps.clock;
    this.#replayWindowSeconds = deps.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;
    this.#futureSkewSeconds = deps.futureSkewSeconds ?? DEFAULT_FUTURE_SKEW_SECONDS;
    if (this.#replayWindowSeconds < 1) {
      throw new ValidationError("replayWindowSeconds must be positive");
    }
    if (this.#futureSkewSeconds < 0) {
      throw new ValidationError("futureSkewSeconds must be non-negative");
    }
  }

  /** Ingest one raw provider webhook delivery. */
  ingest(
    raw: ProviderWebhookRawEvent,
    options?: IngestWebhookOptions,
  ): WebhookIngestionOutcome {
    if (raw === null || typeof raw !== "object") {
      return { kind: "REJECTED", reason: "MALFORMED_EVENT" };
    }
    if (
      typeof raw.providerName !== "string" ||
      raw.providerName.length === 0 ||
      typeof raw.eventId !== "string" ||
      raw.eventId.length === 0 ||
      typeof raw.timestamp !== "string" ||
      raw.timestamp.length === 0 ||
      typeof raw.payload !== "object"
    ) {
      return { kind: "REJECTED", reason: "MALFORMED_EVENT" };
    }
    if (
      raw.headers === null ||
      typeof raw.headers !== "object" ||
      typeof raw.headers.signature !== "string" ||
      raw.headers.signature.length === 0
    ) {
      return { kind: "REJECTED", reason: "MALFORMED_EVENT" };
    }

    // 1. Signature verification (fail closed).
    const canonicalBody = canonicalWebhookBody(raw.payload);
    const verification = this.#verifier.verify(raw, canonicalBody);
    if (!verification.valid) {
      return { kind: "REJECTED", reason: "SIGNATURE_INVALID" };
    }

    // 2. Replay protection: the timestamp must be inside the window.
    const eventSeconds = Number(raw.timestamp);
    const nowSeconds = Number(this.#clock.now() / 1000n);
    if (!Number.isFinite(eventSeconds)) {
      return { kind: "REJECTED", reason: "MALFORMED_EVENT" };
    }
    if (eventSeconds > nowSeconds + this.#futureSkewSeconds) {
      return { kind: "REJECTED", reason: "FUTURE_TIMESTAMP" };
    }
    if (nowSeconds - eventSeconds > this.#replayWindowSeconds) {
      return { kind: "REJECTED", reason: "TIMESTAMP_OUTSIDE_WINDOW" };
    }

    // 3. Idempotent ingestion: a duplicate delivery is acknowledged, never
    //    re-ingested (no second evidence record).
    const dedupeKey = `${raw.providerName}:${raw.eventId}`;
    if (this.#ingested.has(dedupeKey)) {
      return { kind: "ALREADY_INGESTED", providerName: raw.providerName, eventId: raw.eventId };
    }

    // 4. Provider evidence preservation (INV-E02/E05): the evidence draft is
    //    stamped with the attempt link by the caller's execution ledger.
    const now = this.#clock.now();
    const event: PreservedProviderEvent = Object.freeze({
      providerName: raw.providerName,
      eventId: raw.eventId,
      ingestedAt: now,
      payload: raw.payload,
      ...(options?.attemptId !== undefined ? { attemptId: options.attemptId } : {}),
      ...(options?.providerState !== undefined ? { providerState: options.providerState } : {}),
    });
    this.#ingested.set(dedupeKey, event);
    this.#log.push(event);
    const evidence: ProviderExecutionEvidenceDraft = Object.freeze({
      evidenceId: `webhook:${dedupeKey}`,
      kind: "WEBHOOK_EVENT",
      evidenceRef: `provider-event:${dedupeKey}`,
      ...(options?.providerState !== undefined
        ? { providerState: options.providerState }
        : {}),
      recordedAt: now,
    });
    return { kind: "INGESTED", event, evidence };
  }

  /** The append-only log of ingested events, in ingestion order (INV-E05). */
  ingestedEvents(): readonly PreservedProviderEvent[] {
    return Object.freeze([...this.#log]);
  }
}
