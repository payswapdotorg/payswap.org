import { describe, expect, it } from "vitest";
import { createProviderStateEnvelope } from "@payswap/connectors";
import {
  ProviderWebhookIngestor,
  canonicalWebhookBody,
  createHmacVerifier,
  signProviderWebhook,
} from "../src/webhooks.js";
import { ExecutionAttemptLedger, asExecutionAttemptId } from "@payswap/execution";
import { DeterministicClock } from "@payswap/protocol";
import { MOBILE_MONEY_CAPABILITY } from "./fixtures.js";

const SECRET = "whsec_test_1";
const NOW_SECONDS = 1_700_000_000n;
const NOW_MS = NOW_SECONDS * 1000n;

function signedEvent(eventId: string, payload: unknown, timestampSeconds = NOW_SECONDS) {
  const timestamp = timestampSeconds.toString();
  const signature = signProviderWebhook(SECRET, timestamp, canonicalWebhookBody(payload));
  return {
    providerName: "stripe-shape",
    eventId,
    timestamp,
    payload,
    headers: { signature, timestamp },
  };
}

function ingestor(clock = new DeterministicClock(NOW_MS)) {
  return new ProviderWebhookIngestor({
    verifier: createHmacVerifier(SECRET),
    clock,
    replayWindowSeconds: 300,
    futureSkewSeconds: 5,
  });
}

describe("Provider webhook ingestion (W3-003)", () => {
  it("ingests a correctly signed, fresh event and produces attempt-linked evidence (INV-E02)", () => {
    const ingestorInstance = ingestor();
    const payload = { event: "payment_intent.succeeded", paymentIntent: "pi_1" };
    const attemptId = asExecutionAttemptId("att_webhook_1");
    const outcome = ingestorInstance.ingest(signedEvent("evt_1", payload), {
      attemptId,
    });
    expect(outcome.kind).toBe("INGESTED");
    if (outcome.kind === "INGESTED") {
      expect(outcome.evidence.kind).toBe("WEBHOOK_EVENT");
      expect(outcome.evidence.evidenceRef).toBe("provider-event:stripe-shape:evt_1");
      expect(outcome.event.payload).toEqual(payload);
      expect(outcome.event.attemptId).toBe(attemptId);
      // The evidence links onto the attempt through the execution ledger.
      const ledger = new ExecutionAttemptLedger();
      const attempt = ledger.begin({
        attemptId: "att_webhook_1",
        planId: "plan_1",
        stepId: "step_1",
        executionMode: "COMPOSED_PAYSWAP",
        capabilityInstanceId: "inst-mm-1",
        capabilityId: MOBILE_MONEY_CAPABILITY.capabilityId,
        retryPolicy: "SAFE_TO_RETRY",
        cancellation: "UNTIL_SETTLEMENT",
        compensation: MOBILE_MONEY_CAPABILITY.compensation,
        idempotencyKey: "idem-webhook-1",
        principal: { principalType: "user", principalId: "user_1" },
        now: NOW_MS,
      }).attempt;
      const withEvidence = ledger.attachEvidence(attempt.attemptId, [outcome.evidence]);
      expect(withEvidence.evidence[0]!.attemptId).toBe(attemptId);
    }
  });

  it("idempotent ingestion: a duplicate delivery is acknowledged, never ingested twice", () => {
    const ingestorInstance = ingestor();
    const payload = { event: "payment_intent.processing" };
    const first = ingestorInstance.ingest(signedEvent("evt_dup", payload));
    expect(first.kind).toBe("INGESTED");
    const duplicate = ingestorInstance.ingest(signedEvent("evt_dup", payload));
    expect(duplicate.kind).toBe("ALREADY_INGESTED");
    // The append-only log holds exactly one entry (INV-E05).
    expect(ingestorInstance.ingestedEvents()).toHaveLength(1);
    // A different event id ingests separately.
    expect(ingestorInstance.ingest(signedEvent("evt_other", payload)).kind).toBe("INGESTED");
    expect(ingestorInstance.ingestedEvents()).toHaveLength(2);
  });

  it("replay protection: stale and future timestamps are rejected", () => {
    const ingestorInstance = ingestor();
    const payload = { event: "charge.dispute.created" };
    const stale = ingestorInstance.ingest(signedEvent("evt_stale", payload, NOW_SECONDS - 400n));
    expect(stale.kind === "REJECTED" ? stale.reason : undefined).toBe("TIMESTAMP_OUTSIDE_WINDOW");
    const future = ingestorInstance.ingest(signedEvent("evt_future", payload, NOW_SECONDS + 60n));
    expect(future.kind === "REJECTED" ? future.reason : undefined).toBe("FUTURE_TIMESTAMP");
    // Inside the window is accepted.
    const fresh = ingestorInstance.ingest(signedEvent("evt_fresh", payload, NOW_SECONDS - 100n));
    expect(fresh.kind).toBe("INGESTED");
  });

  it("signature verification fails closed on tampered signatures and bodies", () => {
    const ingestorInstance = ingestor();
    const payload = { event: "payment_intent.succeeded" };
    const event = signedEvent("evt_tamper", payload);
    // Tampered payload (signature covers the original body).
    const tampered = ingestorInstance.ingest({
      ...event,
      payload: { event: "payment_intent.HACKED" },
    });
    expect(tampered.kind === "REJECTED" ? tampered.reason : undefined).toBe("SIGNATURE_INVALID");
    // A wrong secret fails too.
    const otherIngestor = new ProviderWebhookIngestor({
      verifier: createHmacVerifier("whsec_OTHER"),
      clock: new DeterministicClock(NOW_MS),
    });
    const rejected = otherIngestor.ingest(event);
    expect(rejected.kind === "REJECTED" ? rejected.reason : undefined).toBe("SIGNATURE_INVALID");
    // Malformed events are rejected before anything else.
    const malformed = ingestorInstance.ingest({
      providerName: "",
      eventId: "",
      timestamp: "not-a-number",
      payload: null,
      headers: { signature: "", timestamp: "" },
    });
    expect(malformed.kind).toBe("REJECTED");
  });

  it("preserves a mapped ProviderStateEnvelope on the ingested evidence (INV-C06)", () => {
    const ingestorInstance = ingestor();
    const payload = { event: "payment_intent.amount_capturable_updated" };
    const envelope = createProviderStateEnvelope({
      provider: { name: "stripe-shape", version: "1.0.0" },
      object: { objectType: "payment", externalId: "pi_1" },
      revision: "rev_1",
      state: payload,
      classification: { family: "capture", lifecycleStep: "amount_capturable", isTerminal: false, requiresCustomerAction: false },
      history: [],
      privacy: { dataClassification: "PARTNER", constraints: [], shareableFields: [] },
      timestamps: { observedAt: "2026-01-01T00:00:00.000Z" },
      provenance: { source: "PROVIDER_WEBHOOK" },
    });
    const outcome = ingestorInstance.ingest(signedEvent("evt_state", payload), {
      providerState: envelope,
    });
    expect(outcome.kind).toBe("INGESTED");
    if (outcome.kind === "INGESTED") {
      expect(outcome.evidence.providerState).toBe(envelope);
      expect(outcome.event.providerState).toBe(envelope);
    }
  });
});
