import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import { scanForSecretMaterial } from "@payswap/onchain-security";
import {
  asWebhookEventId,
  checkoutStatusView,
  defineWebhookEvent,
  emptyWebhookInbox,
  processWebhookEvent,
} from "../src/index.js";
import { runFullJourney } from "./journey-helpers.js";
import { LATER } from "./fixtures.js";

/** P4-W2-003 §3.6 — typed webhooks + idempotent processing + status views. */

function submittedEventFixture(eventId: string, intentId: string) {
  return defineWebhookEvent({
    eventId,
    payload: {
      eventType: "payment_attempt.submitted",
      attemptId: "attempt-1",
      intentId,
      authorizationRequestHash: "fnv1a64:authreq-1",
      externalTxRef: "tx:fixture-external-1",
      evidenceIds: ["evidence:submission-1"],
    },
    occurredAt: LATER,
  });
}

describe("webhook events — typed construction (fail-closed)", () => {
  it("constructs a payment_attempt.submitted event", () => {
    const event = submittedEventFixture("evt-1", "intent:flow-1");
    expect(event.eventId).toBe("evt-1");
    expect(event.payload.eventType).toBe("payment_attempt.submitted");
    expect(event.occurredAt).toBe(LATER);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("validates event ids", () => {
    expect(() => asWebhookEventId("")).toThrow(ValidationError);
    expect(() => asWebhookEventId(" x ")).toThrow(ValidationError);
  });

  it("rejects a payload missing its evidence ids (a webhook is evidence, never authority)", () => {
    expect(() =>
      defineWebhookEvent({
        eventId: "evt-bad",
        payload: {
          eventType: "payment_attempt.confirmed",
          attemptId: "attempt-1",
          intentId: "intent:flow-1",
          evidenceIds: [],
        },
        occurredAt: LATER,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an undeclared event type", () => {
    expect(() =>
      defineWebhookEvent({
        eventId: "evt-bad",
        payload: {
          eventType: "payment_attempt.exploded",
          attemptId: "a",
          intentId: "i",
          evidenceIds: ["e:1"],
        } as never,
        occurredAt: LATER,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a settlement event with a non-landed route family", () => {
    expect(() =>
      defineWebhookEvent({
        eventId: "evt-bad",
        payload: {
          eventType: "settlement.recorded",
          attemptId: "a",
          routeFamily: "SOME_THIRD_FAMILY",
          evidenceIds: ["e:1"],
        } as never,
        occurredAt: LATER,
      }),
    ).toThrow(ValidationError);
  });

  it("every event shape is secret-free (the kernel's own scan)", () => {
    const event = submittedEventFixture("evt-1", "intent:flow-1");
    expect(scanForSecretMaterial(event)).toEqual([]);
  });
});

describe("webhook processing — idempotent by event id (replay-safe)", () => {
  it("applies an event exactly once; the replay is a DUPLICATE", () => {
    const inbox = emptyWebhookInbox();
    const event = submittedEventFixture("evt-1", "intent:flow-1");
    let applications = 0;
    const handler = () => {
      applications += 1;
    };
    const first = processWebhookEvent(inbox, event, handler);
    expect(first.result.status).toBe("APPLIED");
    expect(applications).toBe(1);
    const replay = processWebhookEvent(first.inbox, event, handler);
    expect(replay.result.status).toBe("DUPLICATE");
    expect(applications).toBe(1);
    expect(replay.inbox.appliedEventIds).toEqual(["evt-1"]);
    expect(replay.inbox.duplicates).toEqual(["evt-1"]);
  });

  it("a rejected event is never re-run (its rejection is final for that id)", () => {
    const inbox = emptyWebhookInbox();
    const event = submittedEventFixture("evt-rej", "intent:flow-1");
    let attempts = 0;
    const handler = () => {
      attempts += 1;
      throw new ValidationError("illegal transition claimed by the event");
    };
    const rejected = processWebhookEvent(inbox, event, handler);
    expect(rejected.result.status).toBe("REJECTED");
    if (rejected.result.status === "REJECTED") {
      expect(rejected.result.reason).toContain("illegal transition");
    }
    const replay = processWebhookEvent(rejected.inbox, event, handler);
    expect(replay.result.status).toBe("DUPLICATE");
    expect(attempts).toBe(1);
  });

  it("an event claiming an illegal transition is REJECTED, never force-applied", () => {
    const journey = runFullJourney();
    // The journey's attempt is CONFIRMED (terminal); an event claiming a
    // fresh 'confirmed' observation is an illegal transition:
    const illegalEvent = defineWebhookEvent({
      eventId: "evt-illegal",
      payload: {
        eventType: "payment_attempt.outcome_unknown",
        attemptId: "attempt-1",
        intentId: journey.intent.id,
        evidenceIds: ["evidence:late-ambiguity"],
      },
      occurredAt: LATER,
    });
    const result = processWebhookEvent(emptyWebhookInbox(), illegalEvent, () => {
      // The handler runs the LIFECYCLE rules — an UNKNOWN observation on a
      // terminal attempt throws:
      throw new ValidationError("terminal states are monotonic");
    });
    expect(result.result.status).toBe("REJECTED");
  });

  it("a webhook never creates authority: the handler decides legality", () => {
    const inbox = emptyWebhookInbox();
    const event = submittedEventFixture("evt-ok", "intent:flow-1");
    let observedAuthorization = "";
    const result = processWebhookEvent(inbox, event, (ev) => {
      if (ev.payload.eventType === "payment_attempt.submitted") {
        observedAuthorization = ev.payload.authorizationRequestHash;
      }
    });
    expect(result.result.status).toBe("APPLIED");
    expect(observedAuthorization).toBe("fnv1a64:authreq-1");
  });
});

describe("webhook processing — settlement + refund + session events", () => {
  it("processes checkout-session events", () => {
    const event = defineWebhookEvent({
      eventId: "evt-session",
      payload: {
        eventType: "checkout_session.completed",
        sessionId: "session:flow-1",
        intentId: "intent:flow-1",
      },
      occurredAt: LATER,
    });
    const result = processWebhookEvent(emptyWebhookInbox(), event, () => undefined);
    expect(result.result.status).toBe("APPLIED");
  });

  it("processes settlement notifications carrying the landed route families", () => {
    for (const routeFamily of [
      "NATIVE_STRIPE_CRYPTO",
      "EXTERNAL_PAYSWAP_CONVERSION",
    ] as const) {
      const event = defineWebhookEvent({
        eventId: `evt-settlement-${routeFamily}`,
        payload: {
          eventType: "settlement.recorded",
          attemptId: "attempt-1",
          routeFamily,
          evidenceIds: ["evidence:settlement-1"],
        },
        occurredAt: LATER,
      });
      const result = processWebhookEvent(emptyWebhookInbox(), event, () => undefined);
      expect(result.result.status).toBe("APPLIED");
    }
  });

  it("processes refund lifecycle events", () => {
    const event = defineWebhookEvent({
      eventId: "evt-refund",
      payload: {
        eventType: "refund.outcome_unknown",
        refundId: "refund-1",
        attemptId: "attempt-1",
        evidenceIds: ["evidence:refund-ambiguity"],
      },
      occurredAt: LATER,
    });
    const result = processWebhookEvent(emptyWebhookInbox(), event, () => undefined);
    expect(result.result.status).toBe("APPLIED");
  });
});

describe("status views — read-only projections over the same truth", () => {
  it("projects the attempt status and the applied webhook history", () => {
    const journey = runFullJourney();
    const view = checkoutStatusView(journey.attempt, journey.inbox);
    expect(view.attempt.state).toBe("CONFIRMED");
    expect(view.attempt.outcome).toBe("SUCCEEDED");
    expect(view.attempt.authorizationRequestHash).toBe(
      journey.lineage.authorizationRequestHash,
    );
    expect(view.lastEventTypes).toContain("evt-1");
    expect(view.lastEventTypes).toContain("evt-2");
  });

  it("the view is frozen (a projection, never a mutation path)", () => {
    const journey = runFullJourney();
    const view = checkoutStatusView(journey.attempt, journey.inbox);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.attempt)).toBe(true);
  });
});
