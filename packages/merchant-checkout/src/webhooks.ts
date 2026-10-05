/**
 * @payswap/merchant-checkout — typed webhooks + status (P4-W2-003 §3.6).
 *
 * Typed webhook event contracts for the merchant flow (checkout-session
 * updates, attempt state transitions, settlement notifications, refund
 * lifecycle), with a deterministic IDEMPOTENT processor: the same event id
 * NEVER applies twice (replay-safe; a repeat delivery is classified
 * DUPLICATE and leaves state untouched — INV-F05's event-level twin).
 *
 * A webhook never CREATES authority: an event is EVIDENCE. Processing an
 * event runs the LIFECYCLE rules (the handler calls the lifecycle
 * functions); when the claimed transition is illegal against the current
 * records the event is REJECTED with the typed reason — never force-applied
 * and never silently converted. Status endpoints/projections are read-only
 * views over the same truth (attemptStatusView / checkoutStatusView).
 *
 * Deterministic only: no clock, no randomness; every event carries its own
 * occurredAt.
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
import type { TimestampMs } from "@payswap/protocol";
import { assertNoSecretMaterial } from "@payswap/onchain-security";
import type { CheckoutPaymentAttempt } from "./lifecycle.js";
import { attemptStatusView } from "./lifecycle.js";

declare const WebhookEventIdBrand: unique symbol;

/** Branded id of one webhook event (the idempotency key). */
export type WebhookEventId = string & {
  readonly [WebhookEventIdBrand]: "WebhookEventId";
};

/** Every webhook event type of the merchant checkout flow. */
export type MerchantCheckoutWebhookEventType =
  | "checkout_session.completed"
  | "checkout_session.expired"
  | "checkout_session.cancelled"
  | "payment_attempt.submitted"
  | "payment_attempt.confirmed"
  | "payment_attempt.failed"
  | "payment_attempt.outcome_unknown"
  | "payment_attempt.resolved"
  | "settlement.recorded"
  | "refund.created"
  | "refund.confirmed"
  | "refund.failed"
  | "refund.outcome_unknown";

/** Payload of one webhook event (typed per event family). */
export type MerchantCheckoutWebhookPayload =
  | { readonly eventType: "checkout_session.completed" | "checkout_session.expired" | "checkout_session.cancelled"; readonly sessionId: string; readonly intentId: string }
  | {
      readonly eventType: "payment_attempt.submitted";
      readonly attemptId: string;
      readonly intentId: string;
      readonly authorizationRequestHash: string;
      readonly externalTxRef: string;
      readonly evidenceIds: readonly string[];
    }
  | {
      readonly eventType: "payment_attempt.confirmed" | "payment_attempt.failed" | "payment_attempt.outcome_unknown";
      readonly attemptId: string;
      readonly intentId: string;
      readonly evidenceIds: readonly string[];
    }
  | {
      readonly eventType: "payment_attempt.resolved";
      readonly attemptId: string;
      readonly intentId: string;
      readonly resolvedOutcome: "CONFIRMED_SUCCEEDED" | "CONFIRMED_FAILED";
      readonly evidenceIds: readonly string[];
    }
  | {
      readonly eventType: "settlement.recorded";
      readonly attemptId: string;
      readonly routeFamily: "NATIVE_STRIPE_CRYPTO" | "EXTERNAL_PAYSWAP_CONVERSION";
      readonly evidenceIds: readonly string[];
    }
  | {
      readonly eventType: "refund.created" | "refund.confirmed" | "refund.failed" | "refund.outcome_unknown";
      readonly refundId: string;
      readonly attemptId: string;
      readonly evidenceIds: readonly string[];
    };

/** The typed webhook envelope. */
export interface MerchantCheckoutWebhookEvent {
  readonly eventId: WebhookEventId;
  readonly payload: MerchantCheckoutWebhookPayload;
  readonly occurredAt: TimestampMs;
}

/** Brand a validated string as a `WebhookEventId`. */
export function asWebhookEventId(value: string): WebhookEventId {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("WebhookEventId must be a non-empty string", { value });
  }
  if (value.length > 256) {
    throw new ValidationError("WebhookEventId exceeds 256 characters", { value });
  }
  if (value.trim() !== value) {
    throw new ValidationError("WebhookEventId must not carry surrounding whitespace", {
      value,
    });
  }
  return value as WebhookEventId;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireEvidenceIds(evidenceIds: unknown, eventId: string): readonly string[] {
  if (
    !Array.isArray(evidenceIds) ||
    evidenceIds.length === 0 ||
    !evidenceIds.every((id) => isNonEmptyString(id))
  ) {
    throw new ValidationError(
      "a webhook payload with state implications must carry non-empty evidence ids (a webhook is evidence, never authority)",
      { eventId },
    );
  }
  return Object.freeze([...evidenceIds]);
}

/**
 * Construct a validated, frozen webhook event. Fail-closed: the payload
 * must match its event type exactly (typed shape, evidence ids mandatory
 * wherever the event claims a state transition), and the whole envelope is
 * secret-scanned (no credentials in events, ever).
 */
export function defineWebhookEvent(input: {
  readonly eventId: string;
  readonly payload: MerchantCheckoutWebhookPayload;
  readonly occurredAt: TimestampMs;
}): MerchantCheckoutWebhookEvent {
  const eventId = asWebhookEventId(input.eventId);
  if (typeof input.occurredAt !== "bigint") {
    throw new ValidationError("webhook occurredAt must be a bigint TimestampMs", {
      eventId,
    });
  }
  const payload = input.payload;
  if (payload === null || typeof payload !== "object" || !isNonEmptyString(payload.eventType)) {
    throw new ValidationError("a webhook event requires a typed payload", { eventId });
  }
  switch (payload.eventType) {
    case "checkout_session.completed":
    case "checkout_session.expired":
    case "checkout_session.cancelled":
      if (!isNonEmptyString(payload.sessionId) || !isNonEmptyString(payload.intentId)) {
        throw new ValidationError(
          "a checkout-session webhook must reference its session and intent",
          { eventId },
        );
      }
      break;
    case "payment_attempt.submitted":
      if (
        !isNonEmptyString(payload.attemptId) ||
        !isNonEmptyString(payload.intentId) ||
        !isNonEmptyString(payload.authorizationRequestHash) ||
        !isNonEmptyString(payload.externalTxRef)
      ) {
        throw new ValidationError(
          "a payment_attempt.submitted webhook must carry the attempt, intent, authorization and external submission references",
          { eventId },
        );
      }
      requireEvidenceIds(payload.evidenceIds, eventId);
      break;
    case "payment_attempt.confirmed":
    case "payment_attempt.failed":
    case "payment_attempt.outcome_unknown":
      if (!isNonEmptyString(payload.attemptId) || !isNonEmptyString(payload.intentId)) {
        throw new ValidationError(
          "an attempt-transition webhook must reference its attempt and intent",
          { eventId },
        );
      }
      requireEvidenceIds(payload.evidenceIds, eventId);
      break;
    case "payment_attempt.resolved":
      if (!isNonEmptyString(payload.attemptId) || !isNonEmptyString(payload.intentId)) {
        throw new ValidationError(
          "a resolution webhook must reference its attempt and intent",
          { eventId },
        );
      }
      if (
        payload.resolvedOutcome !== "CONFIRMED_SUCCEEDED" &&
        payload.resolvedOutcome !== "CONFIRMED_FAILED"
      ) {
        throw new ValidationError(
          "a resolution webhook must declare a typed resolvedOutcome",
          { eventId },
        );
      }
      requireEvidenceIds(payload.evidenceIds, eventId);
      break;
    case "settlement.recorded":
      if (!isNonEmptyString(payload.attemptId)) {
        throw new ValidationError("a settlement webhook must reference its attempt", {
          eventId,
        });
      }
      if (
        payload.routeFamily !== "NATIVE_STRIPE_CRYPTO" &&
        payload.routeFamily !== "EXTERNAL_PAYSWAP_CONVERSION"
      ) {
        throw new ValidationError(
          "a settlement webhook must declare one of the two landed route families",
          { eventId, routeFamily: payload.routeFamily },
        );
      }
      requireEvidenceIds(payload.evidenceIds, eventId);
      break;
    case "refund.created":
    case "refund.confirmed":
    case "refund.failed":
    case "refund.outcome_unknown":
      if (!isNonEmptyString(payload.refundId) || !isNonEmptyString(payload.attemptId)) {
        throw new ValidationError("a refund webhook must reference its refund and attempt", {
          eventId,
        });
      }
      requireEvidenceIds(payload.evidenceIds, eventId);
      break;
    default:
      throw new ValidationError(
        "webhook eventType is not declared by the merchant checkout flow",
        { eventId, eventType: (payload as { eventType: string }).eventType },
      );
  }
  const event: MerchantCheckoutWebhookEvent = Object.freeze({
    eventId,
    payload: Object.freeze({ ...payload }) as MerchantCheckoutWebhookPayload,
    occurredAt: input.occurredAt,
  });
  assertNoSecretMaterial(event, "webhook event");
  return event;
}

/** The deterministic idempotent webhook inbox state (append-only). */
export interface WebhookInbox {
  /** Event ids already applied — the idempotency ledger (never applies twice). */
  readonly appliedEventIds: readonly string[];
  /** Event ids rejected with their typed reasons (audit trail). */
  readonly rejections: readonly { readonly eventId: string; readonly reason: string }[];
  /** Event ids observed as duplicates (replays), in arrival order. */
  readonly duplicates: readonly string[];
}

/** The empty inbox. */
export function emptyWebhookInbox(): WebhookInbox {
  return Object.freeze({
    appliedEventIds: Object.freeze([]),
    rejections: Object.freeze([]),
    duplicates: Object.freeze([]),
  });
}

/** The typed processing result for one event. */
export type WebhookProcessingResult =
  | { readonly status: "APPLIED"; readonly eventId: string }
  | { readonly status: "DUPLICATE"; readonly eventId: string }
  | { readonly status: "REJECTED"; readonly eventId: string; readonly reason: string };

/**
 * The webhook application handler: runs the LIFECYCLE rules for the event
 * (calling the lifecycle/settlement/refund functions over the current
 * records). It may throw a ValidationError/PaySwapError when the claimed
 * transition is illegal — the processor classifies that as REJECTED. The
 * handler NEVER receives authority from the event: the event only supplies
 * evidence ids and references.
 */
export type WebhookApplicationHandler = (
  event: MerchantCheckoutWebhookEvent,
) => void;

/**
 * Process one webhook event IDEMPOTENTLY by event id:
 * - a replayed event id is DUPLICATE — the handler is NOT run again and the
 *   inbox state is unchanged except for the duplicate audit entry;
 * - an event whose claimed transition is illegal (the handler throws a
 *   typed validation/governance error) is REJECTED with the reason — never
 *   force-applied;
 * - only a handler-legal event is APPLIED and its event id recorded.
 */
export function processWebhookEvent(
  inbox: WebhookInbox,
  event: MerchantCheckoutWebhookEvent,
  handler: WebhookApplicationHandler,
): { readonly inbox: WebhookInbox; readonly result: WebhookProcessingResult } {
  if (inbox === null || typeof inbox !== "object" || !Array.isArray(inbox.appliedEventIds)) {
    throw new ValidationError("processWebhookEvent requires a WebhookInbox");
  }
  if (event === null || typeof event !== "object" || !isNonEmptyString(event.eventId)) {
    throw new ValidationError("processWebhookEvent requires a webhook event");
  }
  if (typeof handler !== "function") {
    throw new ValidationError("processWebhookEvent requires an application handler");
  }
  if (
    inbox.appliedEventIds.includes(event.eventId) ||
    inbox.rejections.some((entry) => entry.eventId === event.eventId)
  ) {
    return {
      inbox: Object.freeze({
        ...inbox,
        duplicates: Object.freeze([...inbox.duplicates, event.eventId]),
      }),
      result: Object.freeze({ status: "DUPLICATE", eventId: event.eventId }),
    };
  }
  try {
    handler(event);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof PaySwapError) {
      const reason = `${error.name}: ${error.message}`;
      return {
        inbox: Object.freeze({
          ...inbox,
          rejections: Object.freeze([
            ...inbox.rejections,
            Object.freeze({ eventId: event.eventId, reason }),
          ]),
        }),
        result: Object.freeze({ status: "REJECTED", eventId: event.eventId, reason }),
      };
    }
    throw error;
  }
  return {
    inbox: Object.freeze({
      ...inbox,
      appliedEventIds: Object.freeze([...inbox.appliedEventIds, event.eventId]),
    }),
    result: Object.freeze({ status: "APPLIED", eventId: event.eventId }),
  };
}

/** The read-only status projection over one checkout payment attempt. */
export interface CheckoutStatusView {
  readonly attempt: ReturnType<typeof attemptStatusView>;
  readonly lastEventTypes: readonly string[];
}

/**
 * Read-only status view over one attempt + the inbox's applied events for
 * it (the webhook history is a projection input, never a mutation path).
 */
export function checkoutStatusView(
  record: CheckoutPaymentAttempt,
  inbox: WebhookInbox,
): CheckoutStatusView {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("checkoutStatusView requires a CheckoutPaymentAttempt");
  }
  if (inbox === null || typeof inbox !== "object" || !Array.isArray(inbox.appliedEventIds)) {
    throw new ValidationError("checkoutStatusView requires a WebhookInbox");
  }
  const view: CheckoutStatusView = Object.freeze({
    attempt: attemptStatusView(record),
    lastEventTypes: Object.freeze([...inbox.appliedEventIds]),
  });
  return view;
}
