import { describe, expect, it } from "vitest";
import { EUR, USD, fromMinorUnits } from "@payswap/protocol";
import { observeCapability } from "@payswap/connectors";
import { isPaySwapExecutedSettlement, recordOffNetworkPayment } from "@payswap/payment";
import { ExecutionAttemptLedger } from "../src/attempts.js";
import {
  derivePaymentMethodOffer,
  ingestOffNetworkPaymentRecord,
  isAwaitingCustomerAction,
  pendingCustomerActions,
} from "../src/offers.js";
import {
  makeAcceptanceContext,
  makeCapability,
  makeEnvelope,
  makeInstance,
  makeObservation,
  NOW,
  PRINCIPAL,
} from "./fixtures.js";

const CAPABILITY = makeCapability();

describe("Payment-method offers (W3-003)", () => {
  it("derives an offer from authoritative acceptance + capability state, showing the actual rail path", () => {
    const { acceptance, request, translation } = makeAcceptanceContext();
    const instance = makeInstance();
    const result = derivePaymentMethodOffer({
      offerId: "offer_1",
      acceptance,
      request,
      instance,
      observation: makeObservation(instance.instanceId),
      translation,
      capability: CAPABILITY,
      amount: fromMinorUnits(USD, 10_000n),
      fees: fromMinorUnits(USD, 100n),
      executionMode: "COMPOSED_PAYSWAP",
      expiresAt: NOW + 60_000n,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.offer.railPath).toEqual([
        "cap.mobile_money.collect",
        "payswap.fx.convert",
      ]);
      expect(result.offer.basedOnInstanceId).toBe("inst-mm-1");
      expect(result.offer.basedOnObservationVersion).toBe(1);
      expect(result.offer.settlementDestinationId).toBe("dest_bank_1");
      expect(result.offer.executionMode).toBe("COMPOSED_PAYSWAP");
    }
  });

  it("never fabricates offers: unaccepted requests yield typed rejections", () => {
    const { acceptance, request, translation } = makeAcceptanceContext();
    const instance = makeInstance();
    const rejected = derivePaymentMethodOffer({
      offerId: "offer_2",
      acceptance,
      request: { ...request, currency: EUR },
      instance,
      observation: makeObservation(instance.instanceId),
      translation,
      amount: fromMinorUnits(EUR, 10_000n),
      fees: fromMinorUnits(EUR, 100n),
      executionMode: "COMPOSED_PAYSWAP",
      expiresAt: NOW + 60_000n,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toBe("ACCEPTANCE_REJECTED");
      expect(rejected.message).toContain("CURRENCY_NOT_ACCEPTED");
    }
  });

  it("INV-C02: unknown reachability is never success — no offer is fabricated", () => {
    const { acceptance, request, translation } = makeAcceptanceContext();
    const instance = makeInstance();
    const unknownObservation = observeCapability({
      instanceId: instance.instanceId,
      observedAt: "2026-01-01T00:00:00.000Z",
      observationVersion: 2,
      capabilityState: "AVAILABLE",
      sourceAvailability: "UNKNOWN",
      eligibility: "ELIGIBLE",
      health: { status: "UNKNOWN", lastCheckedAt: "2026-01-01T00:00:00.000Z" },
      provenance: { providerName: "test-psp", source: "PROVIDER_API", capturedAt: "2026-01-01T00:00:00.000Z" },
    });
    const result = derivePaymentMethodOffer({
      offerId: "offer_3",
      acceptance,
      request,
      instance,
      observation: unknownObservation,
      translation,
      amount: fromMinorUnits(USD, 10_000n),
      fees: fromMinorUnits(USD, 100n),
      executionMode: "COMPOSED_PAYSWAP",
      expiresAt: NOW + 60_000n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CAPABILITY_AVAILABILITY_UNKNOWN");
      expect(result.message).toContain("INV-C02");
    }
  });

  it("INV-C05: unauthorized / ineligible / under-permitted instances yield no offer", () => {
    const { acceptance, request, translation } = makeAcceptanceContext();
    const revoked = makeInstance({ authorization: { status: "REVOKED" } });
    const revokedResult = derivePaymentMethodOffer({
      offerId: "offer_4",
      acceptance,
      request,
      instance: revoked,
      observation: makeObservation(revoked.instanceId),
      translation,
      amount: fromMinorUnits(USD, 10_000n),
      fees: fromMinorUnits(USD, 100n),
      executionMode: "COMPOSED_PAYSWAP",
      expiresAt: NOW + 60_000n,
    });
    expect(revokedResult.ok).toBe(false);
    if (!revokedResult.ok) {
      expect(revokedResult.reason).toBe("CAPABILITY_INSTANCE_NOT_AUTHORIZED");
    }

    const missingPermissions = makeInstance({
      permissionState: { granted: [], requested: ["payments:write"], missing: ["payments:write"] },
    });
    const missingResult = derivePaymentMethodOffer({
      offerId: "offer_5",
      acceptance,
      request,
      instance: missingPermissions,
      observation: makeObservation(missingPermissions.instanceId),
      translation,
      amount: fromMinorUnits(USD, 10_000n),
      fees: fromMinorUnits(USD, 100n),
      executionMode: "COMPOSED_PAYSWAP",
      expiresAt: NOW + 60_000n,
    });
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.reason).toBe("CAPABILITY_INSTANCE_MISSING_PERMISSIONS");
    }
  });

  it("ingests off-network records without claiming PaySwap execution", () => {
    const record = recordOffNetworkPayment({
      id: "off_1",
      source: "CHECK",
      reporter: "merchant staff",
      amount: fromMinorUnits(USD, 25_000n),
      externalRef: "check-1042",
      evidence: [{ kind: "image", reference: "img:1", recordedAt: NOW }],
      reconciliationState: "UNRECONCILED",
      businessDocumentRefs: [{ documentKind: "INVOICE", documentId: "inv_1" }],
      recordedAt: NOW,
    });
    const ingested = ingestOffNetworkPaymentRecord(record);
    expect(ingested.attributedToPaySwap).toBe(false);
    expect(isPaySwapExecutedSettlement(ingested.record)).toBe(false);
    expect(ingested.record.orchestratedBy).toBe("EXTERNAL_PARTY");
  });

  it("keeps async/customer-action-required provider states actionable (INV-C06)", () => {
    const ledger = new ExecutionAttemptLedger();
    const outcome = ledger.begin({
      attemptId: "att_offer_action",
      planId: "plan_1",
      stepId: "step_1",
      executionMode: "COMPOSED_PAYSWAP",
      capabilityInstanceId: "inst-mm-1",
      capabilityId: CAPABILITY.capabilityId,
      retryPolicy: "SAFE_TO_RETRY",
      cancellation: "UNTIL_SETTLEMENT",
      compensation: CAPABILITY.compensation,
      idempotencyKey: "idem-offer-action",
      principal: PRINCIPAL,
      now: NOW,
    });
    const challenge = makeEnvelope({
      family: "customer_action_required",
      lifecycleStep: "3ds_challenge",
      requiresCustomerAction: true,
      actionRequired: { kind: "three_d_secure", message: "complete the challenge" },
    });
    ledger.advance(outcome.attempt.attemptId, "START", { now: NOW + 1n });
    const waiting = ledger.advance(outcome.attempt.attemptId, "PROVIDER_ACTION_REQUIRED", {
      now: NOW + 1n,
      evidence: [
        {
          evidenceId: "ev_challenge",
          kind: "STATE_OBSERVATION",
          evidenceRef: "provider-state:1",
          providerState: challenge,
          recordedAt: NOW + 1n,
        },
      ],
    });
    expect(isAwaitingCustomerAction(waiting)).toBe(true);
    const actions = pendingCustomerActions(waiting);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("three_d_secure");
    // The action surfaces the preserved provider state verbatim — not a flattened error.
    expect(waiting.providerState?.actionRequired?.deepLink).toBeUndefined();
    expect(waiting.providerState?.actionRequired?.message).toBe("complete the challenge");
  });
});
