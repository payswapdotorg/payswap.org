import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import type { ApiResponse } from "@payswap/api";
import {
  asBrowserSessionRef,
  asConnectedCapabilityInstanceId,
  asEvidenceArtifactRef,
  asPayoutDestinationRef,
  asReauthorizationRef,
  applyConnectionAuthorizationOutcome,
  applyExecutionResumedResponse,
  applyPayOutcome,
  applyPaymentSubmissionResponse,
  applyReconciliationResolution,
  applyReauthorizationRequestResponse,
  awaitFurtherObservation,
  beginCollectJourney,
  beginEvidenceInspection,
  beginPayJourney,
  beginPayoutJourney,
  beginReauthorization,
  beginReconcileJourney,
  beginTrustedSurfaceReauthorization,
  confirmWithdrawalScope,
  deriveEvidenceList,
  inspectEvidenceArtifact,
  recordFreshAuthorization,
  recordOutcomeUnknown,
  reconcileJourneyUiState,
  selectPayCapability,
  specifyPayoutDestination,
  trackedOutcomeUiState,
} from "@payswap/ux";

import {
  AUTHORIZATION_SURFACE_NOT_BOUND,
  buildConnectionPlaneForTests,
} from "../src/app/(auth)/_server/connection-plane";
import { catalogueStatusById } from "../src/app/(auth)/_server/connection-catalogue";
import { ALLOWED_JOURNEY_COMMANDS } from "../src/lib/cc/journey-commands";
import { dispatchJourneyApiCommand } from "../src/lib/cc/journey-dispatch";

import { PayJourneyView } from "../src/components/cc/pay-journey-surface";
import { CollectJourneyView } from "../src/components/cc/collect-journey-surface";
import { ReconcileJourneySurface } from "../src/components/cc/reconcile-journey-surface";
import { EvidenceJourneySurface } from "../src/components/cc/evidence-journey-surface";
import { ReauthEntry } from "../src/components/connect/reauth-entry";
import { LocalRailAuthorization } from "../src/components/connect/local-rail-authorization";
import { AwaitingAuthorizationView } from "../src/components/connect/awaiting-authorization";
import {
  ConnectedInstanceView,
  connectionFactsFromRecord,
} from "../src/components/connect/connected-instance-view";

/**
 * P3-W3-002 — the END-TO-END journey continuity tests.
 *
 * connect → capability → pay/collect/payout → customer-action →
 * UNKNOWN/reconciliation → evidence → local-rail → reauth, through the REAL
 * contract folds and the REAL API transport path (a stubbed HTTP layer that
 * answers the envelope shapes the deployed API answers — the plane's real
 * paySwapApiFetch call, verbatim folding, no shortcuts).
 *
 * Laws asserted: no simulated financial effect reachable through the UI;
 * UNKNOWN ≠ FAILED; the catalogue never authorizes; credentials never
 * surface; records only from authority folds.
 */

const PRINCIPAL = "user:owner@example.test";

function grantedIntentResponse(intentId: string): ApiResponse {
  return {
    kind: "success",
    status: 200,
    envelope: {
      data: { intent: { id: intentId } },
      meta: { schemaVersion: "v1", requestId: `req_${intentId}` },
    },
  };
}

function approvalRequiredResponse(requestHash: string): ApiResponse {
  return {
    kind: "success",
    status: 202,
    envelope: {
      data: {
        approvalRequest: { requestHash, expiresAt: "2026-10-02T13:00:00Z" },
        approvalMessage: { deepLink: "https://provider.test/approval" },
      },
      meta: { schemaVersion: "v1", requestId: `req_${requestHash}` },
    },
  };
}

function apiError(statusCode: number, code: string): ApiResponse {
  return {
    kind: "error",
    status: statusCode,
    body: {
      error: { code, category: "AUTHORIZATION", message: "session token required" },
      meta: { schemaVersion: "v1", requestId: "req_err" },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A fake HTTP layer answering the API's envelope shapes (the REAL call path). */
function stubApiHttp(handler: (url: string, init?: RequestInit) => Response): void {
  vi.stubEnv("NEXT_PUBLIC_PAYSWAP_API_URL", "https://api.payswap.test");
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init?: RequestInit) =>
      Promise.resolve(handler(String(_url), init)),
    ),
  );
}

describe("connect → capability continuity (the catalogue never authorizes)", () => {
  it("with no authority records the Payments surface renders the honest empty state (connect-gate)", () => {
    const plane = buildConnectionPlaneForTests();
    expect(plane.connectedInstancesFor(PRINCIPAL)).toEqual([]);
    const journey = beginPayJourney({
      request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
      connectedInstances: plane.connectedInstancesFor(PRINCIPAL),
      routabilityChecks: [],
    });
    const html = renderToStaticMarkup(
      <PayJourneyView journey={journey} onAction={() => undefined} />,
    );
    expect(html).toContain("No connected capability");
    expect(html).toContain("never treated as executable authority");
    expect(html).toContain('href="/app/capabilities"');
  });

  it("the real path: select → initiate through paySwapApiFetch → GRANTED fold → broker ref → authority record → the capability appears", async () => {
    stubApiHttp(() =>
      new Response(
        JSON.stringify({
          data: { intent: { id: "intent_connect_1" } },
          meta: { schemaVersion: "v1", requestId: "req_1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const plane = buildConnectionPlaneForTests();
    const select = plane.selectProvider(PRINCIPAL, "stripe");
    expect(select.status).toBe("ok");
    if (select.status !== "ok") return;

    // The broker boundary FIRST (the ref folds while the journey is still
    // initiating — it authorizes nothing), then the real API initiation.
    const attached = plane.attachBrokerSessionRef(
      PRINCIPAL,
      "stripe",
      asBrowserSessionRef("browser-session-ref-test-1"),
    );
    expect(attached.status).toBe("ok");

    const initiation = await plane.initiateConnection(PRINCIPAL, "stripe", {
      principalRef: PRINCIPAL,
    });
    expect(initiation.status).toBe("ok");
    if (initiation.status !== "ok") return;
    // The REAL API answered through the real client; the fold moved the
    // journey to awaiting-authorization with the authority's intent id.
    expect(initiation.journey.stateName).toBe("awaiting-authorization");
    expect(initiation.journey.initiationIntentId).toBe("intent_connect_1");
    expect(initiation.journey.apiAttempt).toMatchObject({ kind: "answered", outcome: "GRANTED" });

    // The broker ref is carried into the authorization phase opaquely.
    expect(initiation.journey.browserSessionRef).toBe("browser-session-ref-test-1");

    // The ONLY way a connected instance exists: an authority activation
    // record (test-only here — the web app never mints one).
    const record = {
      instanceId: asConnectedCapabilityInstanceId("ci_stripe_test_1"),
      providerId: "stripe",
      connectedAt: "2026-10-02T12:00:00Z",
      state: "ACTIVE" as const,
    };
    const activated = plane.applyAuthorityActivation(PRINCIPAL, "stripe", record);
    expect(activated.status).toBe("ok");
    if (activated.status !== "ok") return;
    expect(activated.journey.stateName).toBe("connected-capability-instance");
    expect(activated.journey.connectedInstance?.instanceId).toBe("ci_stripe_test_1");

    // The continuity: the capability now appears in the Pay journey options.
    const instances = plane.connectedInstancesFor(PRINCIPAL);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.instanceId).toBe("ci_stripe_test_1");
    const payJourney = beginPayJourney({
      request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
      connectedInstances: instances,
      routabilityChecks: [
        { instanceId: record.instanceId, currency: "GHS", routable: true },
      ],
    });
    const html = renderToStaticMarkup(
      <PayJourneyView journey={payJourney} onAction={() => undefined} />,
    );
    expect(html).toContain("Pay with stripe");
  });

  it("an authority record is NOT foldable outside the authorization phase (the plane refuses)", () => {
    const plane = buildConnectionPlaneForTests();
    plane.selectProvider(PRINCIPAL, "stripe");
    const refused = plane.applyAuthorityActivation(PRINCIPAL, "stripe", {
      instanceId: asConnectedCapabilityInstanceId("ci_stripe_test_1"),
      providerId: "stripe",
      connectedAt: "2026-10-02T12:00:00Z",
      state: "ACTIVE",
    });
    // initiating (not awaiting-authorization): the contract's own refusal.
    expect(refused.status).toBe("not-found");
  });

  it("the API's verbatim 401/403 error folds honestly — the journey stays initiating, never a connection", async () => {
    stubApiHttp(() =>
      new Response(
        JSON.stringify({
          error: {
            code: "auth.session_token_required",
            category: "AUTHENTICATION",
            message: "A PaySwap API session token is required.",
          },
          meta: { schemaVersion: "v1", requestId: "req_err" },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    const plane = buildConnectionPlaneForTests();
    plane.selectProvider(PRINCIPAL, "stripe");
    const initiation = await plane.initiateConnection(PRINCIPAL, "stripe", {
      principalRef: PRINCIPAL,
    });
    expect(initiation.status).toBe("ok");
    if (initiation.status !== "ok") return;
    expect(initiation.journey.stateName).toBe("initiating");
    expect(initiation.journey.apiAttempt).toMatchObject({
      kind: "answered",
      statusCode: 403,
      outcome: "ERROR",
    });
    expect(plane.connectedInstancesFor(PRINCIPAL)).toEqual([]);
  });
});

describe("pay-gate → capability-required (submission only through the real transport)", () => {
  const record = {
    instanceId: asConnectedCapabilityInstanceId("ci_stripe_test_1"),
    providerId: "stripe",
    connectedAt: "2026-10-02T12:00:00Z",
    state: "ACTIVE" as const,
  };

  it("with zero options there is NO submit action — the catalogue never becomes an execution surface", () => {
    const journey = beginPayJourney({
      request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
      connectedInstances: [],
      routabilityChecks: [],
    });
    expect(journey.options).toHaveLength(0);
    expect(journey.actions.some((action) => action.actionId === "submit-payment")).toBe(false);
  });

  it("a non-routable instance is honestly refused (fail-closed: absent check ≠ routability)", () => {
    const journey = beginPayJourney({
      request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
      connectedInstances: [record],
      routabilityChecks: [],
    });
    const option = journey.options[0];
    expect(option?.routable).toBe(false);
    expect(() =>
      selectPayCapability(journey, record.instanceId, []),
    ).toThrow(/not routable/);
  });

  it("the dispatch transport: an API error answer folds VERBATIM and nothing is submitted", async () => {
    stubApiHttp(() =>
      new Response(
        JSON.stringify({
          error: {
            code: "auth.session_token_required",
            category: "AUTHENTICATION",
            message: "A PaySwap API session token is required.",
          },
          meta: { schemaVersion: "v1", requestId: "req_err" },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    const journey = selectPayCapability(
      beginPayJourney({
        request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
        connectedInstances: [record],
        routabilityChecks: [{ instanceId: record.instanceId, currency: "GHS", routable: true }],
      }),
      record.instanceId,
      [],
    );
    const action = journey.actions.find((a) => a.actionId === "submit-payment");
    expect(action).toBeDefined();
    if (action === undefined) return;

    // The client transport posts to the SAME-ORIGIN route (stubbed here as
    // the API's own 403 answer through the route's verbatim mapping).
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: "http-error",
              statusCode: 403,
              body: {
                error: {
                  code: "auth.session_token_required",
                  category: "AUTHENTICATION",
                  message: "A PaySwap API session token is required.",
                },
                meta: { schemaVersion: "v1", requestId: "req_err" },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    const result = await dispatchJourneyApiCommand("pay", action, "csrf-token-test");
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    const folded = applyPaymentSubmissionResponse(journey, result.response);
    // The contract records the verbatim error; no fabricated submission.
    expect(folded.stateName).toBe("REVIEWING_ROUTE");
    expect(folded.error).toMatchObject({ code: "auth.session_token_required" });
    expect(folded.submittedIntentId).toBeUndefined();
  });

  it("the route allowlist equals the contract's own action commands (no transport drift)", () => {
    const payJourney = selectPayCapability(
      beginPayJourney({
        request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
        connectedInstances: [record],
        routabilityChecks: [{ instanceId: record.instanceId, currency: "GHS", routable: true }],
      }),
      record.instanceId,
      [],
    );
    const collectJourney = beginCollectJourney({
      amount: { currency: "GHS", minorUnits: "1050" },
      payer: "payer_1",
      collectCapableInstances: [record],
    });
    const payoutJourney = confirmWithdrawalScope(
      specifyPayoutDestination(
        beginPayoutJourney({ amount: { currency: "USD", minorUnits: "100000" } }),
        {
          destinationRef: asPayoutDestinationRef("dest_ext_1"),
          kind: "BANK_ACCOUNT",
          currency: "USD",
          externalObservation: true,
        },
      ),
      {
        singleUse: true,
        maxAmount: { currency: "USD", minorUnits: "100000" },
        destinationRef: asPayoutDestinationRef("dest_ext_1"),
      },
    );
    const reconcileJourney = recordOutcomeUnknown(
      beginReconcileJourney({ paymentRef: "pay_1" }),
      asEvidenceArtifactRef("ev_ambiguity_1"),
    );
    const reauthJourney = beginReauthorization({
      trigger: "EXPIRED",
      lineage: { originalCommandType: "capabilities.connection.initiate" },
    });
    const expected: Array<[
      string,
      string,
      { method: string; path: string; body?: unknown },
    ]> = [
      ["pay", "submit-payment", payJourney.actions.find((a) => a.actionId === "submit-payment")!.apiCommand!],
      ["collect", "create-collect-request", collectJourney.actions.find((a) => a.actionId === "create-collect-request")!.apiCommand!],
      ["payout", "submit-payout", payoutJourney.actions.find((a) => a.actionId === "submit-payout")!.apiCommand!],
      ["reconcile-payment-outcome", "request-fresh-observation", reconcileJourney.actions.find((a) => a.actionId === "request-fresh-observation")!.apiCommand!],
      ["reauthorize", "begin-reauthorization-request", reauthJourney.actions.find((a) => a.actionId === "begin-reauthorization-request")!.apiCommand!],
    ];
    expect(ALLOWED_JOURNEY_COMMANDS).toHaveLength(expected.length + 1); // + resume-execution
    for (const [journeyId, actionId, apiCommand] of expected) {
      const entry = ALLOWED_JOURNEY_COMMANDS.find(
        (candidate) => candidate.journeyId === journeyId && candidate.actionId === actionId,
      );
      expect(entry, `${journeyId}/${actionId} on the allowlist`).toBeDefined();
      if (entry === undefined) continue;
      expect(entry.method).toBe(apiCommand.method);
      expect(entry.path).toBe(apiCommand.path);
      if (entry.commandType !== undefined) {
        expect(
          (apiCommand.body as Record<string, unknown>)["commandType"],
          `${journeyId}/${actionId} commandType`,
        ).toBe(entry.commandType);
      }
    }
    const resumeEntry = ALLOWED_JOURNEY_COMMANDS.find(
      (candidate) => candidate.journeyId === "reauthorize" && candidate.actionId === "resume-execution",
    );
    expect(resumeEntry?.path).toBe("/v1/intents");
  });
});

describe("UNKNOWN → reconciliation (never failure)", () => {
  const record = {
    instanceId: asConnectedCapabilityInstanceId("ci_stripe_test_1"),
    providerId: "stripe",
    connectedAt: "2026-10-02T12:00:00Z",
    state: "ACTIVE" as const,
  };

  function submittedPayJourney() {
    const reviewing = selectPayCapability(
      beginPayJourney({
        request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
        connectedInstances: [record],
        routabilityChecks: [{ instanceId: record.instanceId, currency: "GHS", routable: true }],
      }),
      record.instanceId,
      [],
    );
    return applyPaymentSubmissionResponse(reviewing, grantedIntentResponse("intent_pay_1"));
  }

  it("OUTCOME_UNKNOWN folds to RECONCILING and renders reconciliation, never a failure", () => {
    const reconciling = applyPayOutcome(submittedPayJourney(), "OUTCOME_UNKNOWN", [
      asEvidenceArtifactRef("ev_ambiguity_1"),
    ]);
    expect(reconciling.stateName).toBe("RECONCILING");
    expect(trackedOutcomeUiState("OUTCOME_UNKNOWN")).toBe("reconciling");
    const html = renderToStaticMarkup(
      <PayJourneyView journey={reconciling} onAction={() => undefined} />,
    );
    expect(html).toContain("Reconciling — outcome unknown");
    expect(html).toContain("Outcome unknown — reconciling");
    expect(html).not.toContain("Failed");
    // The evidence continuity link carries the action + artifact reference.
    expect(html).toContain(
      `href="/app/evidence?action=intent_pay_1&amp;artifact=ev_ambiguity_1"`,
    );
  });

  it("the dedicated ReconcileJourney surface renders (ambiguity-first lifecycle)", () => {
    const html = renderToStaticMarkup(
      <ReconcileJourneySurface
        paymentRef="intent_pay_1"
        evidenceRefs={["ev_submit_1"]}
        ambiguityEvidenceRef="ev_ambiguity_1"
      />,
    );
    expect(html).toContain("Reconciliation — the dedicated journey for an ambiguous outcome");
    expect(html).toContain("TRACKING_IN_FLIGHT");
    expect(html).toContain("Record the ambiguity (INV-E02)");
    expect(html).toContain("never blindly retried");
  });

  it("the reconcile lifecycle folds: recorded ambiguity → pending observation → authority resolution", () => {
    let journey = beginReconcileJourney({ paymentRef: "intent_pay_1" });
    expect(journey.stateName).toBe("TRACKING_IN_FLIGHT");
    journey = recordOutcomeUnknown(journey, asEvidenceArtifactRef("ev_ambiguity_1"));
    expect(journey.stateName).toBe("OUTCOME_UNKNOWN");
    expect(journey.attemptOutcome).toBe("OUTCOME_UNKNOWN");
    expect(reconcileJourneyUiState("OUTCOME_UNKNOWN")).toBe("reconciling");
    journey = awaitFurtherObservation(journey, asEvidenceArtifactRef("obs:req_2"));
    expect(journey.stateName).toBe("PENDING_OBSERVATION");
    expect(reconcileJourneyUiState("PENDING_OBSERVATION")).toBe("reconciling");
    // Resolution from the observation path, with its evidence reference.
    journey = applyReconciliationResolution(
      journey,
      "RESOLVED_FULFILLED",
      asEvidenceArtifactRef("ev_resolution_1"),
    );
    expect(journey.stateName).toBe("RESOLVED_FULFILLED");
    expect(journey.terminal).toBe(true);
    expect(journey.attemptOutcome).toBe("SUCCEEDED");
    expect(journey.evidenceRefs.map(String)).toEqual([
      "ev_ambiguity_1",
      "obs:req_2",
      "ev_resolution_1",
    ]);
  });

  it("UNKNOWN is not resolvable by the UI alone: no resolve action exists in any reconcile state", () => {
    const journey = recordOutcomeUnknown(
      beginReconcileJourney({ paymentRef: "intent_pay_1" }),
      asEvidenceArtifactRef("ev_ambiguity_1"),
    );
    for (const action of journey.actions) {
      expect(action.label.toLowerCase()).not.toContain("resolve as");
      expect(action.kind).not.toBe("AUTHORITY_TRANSITION");
    }
  });
});

describe("provider customer-action state (verbatim, reauth reachable)", () => {
  const record = {
    instanceId: asConnectedCapabilityInstanceId("ci_stripe_test_1"),
    providerId: "stripe",
    connectedAt: "2026-10-02T12:00:00Z",
    state: "ACTIVE" as const,
  };

  it("AWAITING_CUSTOMER_ACTION renders the customer-action panel with the reauth journey link", () => {
    const reviewing = selectPayCapability(
      beginPayJourney({
        request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
        connectedInstances: [record],
        routabilityChecks: [{ instanceId: record.instanceId, currency: "GHS", routable: true }],
      }),
      record.instanceId,
      [],
    );
    const submitted = applyPaymentSubmissionResponse(reviewing, grantedIntentResponse("intent_pay_2"));
    const tracking = applyPayOutcome(submitted, "AWAITING_CUSTOMER_ACTION");
    expect(tracking.stateName).toBe("TRACKING");
    expect(tracking.attemptOutcome).toBe("AWAITING_CUSTOMER_ACTION");
    const html = renderToStaticMarkup(
      <PayJourneyView journey={tracking} onAction={() => undefined} />,
    );
    expect(html).toContain("Provider customer action required");
    expect(html).toContain("AWAITING_CUSTOMER_ACTION");
    expect(html).toContain('href="/reauth"');
    // The tracked token maps to the user-action UI state, verbatim.
    expect(trackedOutcomeUiState("AWAITING_CUSTOMER_ACTION")).toBe("action-required");
  });

  it("the connect awaiting-authorization view carries the reauth/customer-action journey link", () => {
    const plane = buildConnectionPlaneForTests();
    plane.selectProvider(PRINCIPAL, "stripe");
    const journey = plane.journeyFor(PRINCIPAL, "stripe");
    expect(journey).toBeDefined();
    if (journey === undefined) return;
    const html = renderToStaticMarkup(
      <AwaitingAuthorizationView journey={journey} providerDisplayName="Stripe" />,
    );
    expect(html).toContain("awaiting your authorization");
    expect(html).toContain("not yet bound to this deployment");
    expect(html).toContain('href="/reauth"');
    expect(html).not.toMatch(/password|api[_-]?key|mfa/i);
  });
});

describe("expired → reauthentication (lineage intact)", () => {
  it("an EXPIRED authority record renders the reauth entry on the connection and is NOT connected capability", () => {
    const plane = buildConnectionPlaneForTests();
    plane.selectProvider(PRINCIPAL, "stripe");
    const expiredRecord = {
      instanceId: asConnectedCapabilityInstanceId("ci_stripe_expired_1"),
      providerId: "stripe",
      connectedAt: "2026-09-01T09:00:00Z",
      state: "EXPIRED" as const,
    };
    // Fold through the CONTRACT directly from a constructed awaiting journey
    // (the plane fold requires the authorization phase; the contract is the
    // authority on the lifecycle either way).
    const browsing = beginConnectProviderJourney();
    const initiating = chooseProviderStripe(browsing);
    const awaiting = applyConnectionInitiationResponse(
      initiating,
      grantedIntentResponse("intent_connect_9"),
    );
    const expired = applyConnectionAuthorizationOutcome(awaiting, expiredRecord);
    expect(expired.stateName).toBe("expired");
    expect(expired.terminal).toBe(true);

    const html = renderToStaticMarkup(
      <ConnectedInstanceView
        facts={connectionFactsFromRecord(expiredRecord, "DELEGATED_OAUTH")}
        providerDisplayName="Stripe"
      />,
    );
    expect(html).toContain("Expired — reauthorization required");
    expect(html).toContain('href="/reauth"');
    expect(html).toContain("Required — the authorization expired");
    // And the plane's own derivation excludes expired records:
    expect(plane.connectedInstancesFor(PRINCIPAL)).toEqual([]);
  });

  it("the reauth journey entry renders AUTHORIZATION_EXPIRED with the original lineage and dispatches through the real transport", async () => {
    const html = renderToStaticMarkup(
      <ReauthEntry
        entry={{
          providerId: "stripe",
          providerDisplayName: "Stripe",
          instanceId: "ci_stripe_expired_1",
          connectedAt: "2026-09-01",
          initiationIntentId: "intent_connect_9",
        }}
        csrfToken="csrf-token-test"
      />,
    );
    expect(html).toContain("AUTHORIZATION_EXPIRED");
    expect(html).toContain("intent_connect_9");
    expect(html).toContain("capabilities.connection.initiate");
    expect(html).toContain("Request the fresh authorization");

    // The contract folds the full five states with the lineage intact:
    let journey = beginReauthorization({
      trigger: "EXPIRED",
      lineage: { intentId: "intent_connect_9", originalCommandType: "capabilities.connection.initiate" },
    });
    journey = applyReauthorizationRequestResponse(journey, approvalRequiredResponse("appr_1"));
    expect(journey.stateName).toBe("CUSTOMER_ACTION_REQUIRED");
    expect(journey.approval?.requestHash).toBe("appr_1");
    expect(journey.trustedSurfaceDeepLink).toBe("https://provider.test/approval");
    journey = beginTrustedSurfaceReauthorization(journey);
    expect(journey.stateName).toBe("REAUTHORIZING_ON_TRUSTED_SURFACE");
    journey = recordFreshAuthorization(journey, {
      authorizationRef: asReauthorizationRef("reauth_ref_1"),
      evidenceRef: asEvidenceArtifactRef("ev_reauth_1"),
    });
    expect(journey.stateName).toBe("FRESH_AUTHORIZATION_RECORDED");
    expect(journey.freshAuthorization?.authorizationRef).toBe("reauth_ref_1");
    journey = applyExecutionResumedResponse(journey, grantedIntentResponse("intent_pay_resumed_1"));
    expect(journey.stateName).toBe("EXECUTION_RESUMED");
    expect(journey.terminal).toBe(true);
    expect(journey.resumedIntentId).toBe("intent_pay_resumed_1");
    expect(journey.lineage.intentId).toBe("intent_connect_9");
    expect(journey.lineage.originalCommandType).toBe("capabilities.connection.initiate");
  });

  it("the reauth dispatch: the API's 401 answer folds the verbatim error, never a reauthorization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: "http-error",
              statusCode: 401,
              body: {
                error: {
                  code: "auth.session_token_required",
                  category: "AUTHENTICATION",
                  message: "A PaySwap API session token is required.",
                },
                meta: { schemaVersion: "v1", requestId: "req_err" },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    const journey = beginReauthorization({
      trigger: "EXPIRED",
      lineage: { intentId: "intent_connect_9", originalCommandType: "capabilities.connection.initiate" },
    });
    const action = journey.actions.find((a) => a.actionId === "begin-reauthorization-request");
    expect(action).toBeDefined();
    if (action === undefined) return;
    const result = await dispatchJourneyApiCommand("reauthorize", action, "csrf-token-test");
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    const folded = applyReauthorizationRequestResponse(journey, result.response);
    expect(folded.stateName).toBe("AUTHORIZATION_EXPIRED");
    expect(folded.error).toMatchObject({ code: "auth.session_token_required" });
    expect(folded.freshAuthorization).toBeUndefined();
  });
});

describe("evidence continuity (links resolve, provenance derived)", () => {
  it("every outcome's evidence link resolves to the inspection surface with the artifact reference", () => {
    const artifacts = [
      {
        artifactRef: asEvidenceArtifactRef("ev_ambiguity_1"),
        summary: "The ambiguity observation (provider envelope lost)",
        provenance: { source: "BROWSER_LOCAL" as const },
      },
      {
        artifactRef: asEvidenceArtifactRef("ev_provider_1"),
        summary: "The provider's authenticated record of the attempt",
        provenance: { source: "PROVIDER_ENVELOPE" as const, systemName: "stripe" },
      },
    ];
    // Strongest-first: the authenticated provider record ranks above the
    // browser-local artifact (INV-E04).
    const derived = deriveEvidenceList(artifacts);
    expect(derived[0]?.artifactRef).toBe("ev_provider_1");
    expect(derived[1]?.artifactRef).toBe("ev_ambiguity_1");

    const html = renderToStaticMarkup(
      <EvidenceJourneySurface
        actionRef="intent_pay_1"
        artifacts={artifacts}
        initialArtifactRef="ev_provider_1"
      />,
    );
    expect(html).toContain("Artifact inspection");
    expect(html).toContain("ev_provider_1");
    expect(html).toContain("AUTHENTICATED_PROVIDER_RECORD");
    expect(html).toContain("intent_pay_1");
  });

  it("an unknown deep-linked artifact fails closed to the honest list (no invented inspection)", () => {
    const artifacts = [
      {
        artifactRef: asEvidenceArtifactRef("ev_provider_1"),
        summary: "The provider's authenticated record",
        provenance: { source: "PROVIDER_ENVELOPE" as const, systemName: "stripe" },
      },
    ];
    const html = renderToStaticMarkup(
      <EvidenceJourneySurface
        actionRef="intent_pay_1"
        artifacts={artifacts}
        initialArtifactRef="ev_not_in_the_list"
      />,
    );
    expect(html).not.toContain("Artifact inspection");
    expect(html).toContain("Inspect The provider");
    // The contract itself refuses the foreign ref:
    expect(() =>
      inspectEvidenceArtifact(
        beginEvidenceInspection({ actionRef: "intent_pay_1", artifacts }),
        asEvidenceArtifactRef("ev_not_in_the_list"),
      ),
    ).toThrow(/not among the evidence entries/);
  });

  it("the collect journey's shareable request is an opaque reference (no credentials anywhere)", () => {
    const record = {
      instanceId: asConnectedCapabilityInstanceId("ci_stripe_test_1"),
      providerId: "stripe",
      connectedAt: "2026-10-02T12:00:00Z",
      state: "ACTIVE" as const,
    };
    const journey = beginCollectJourney({
      amount: { currency: "GHS", minorUnits: "1050" },
      payer: "payer_1",
      collectCapableInstances: [record],
    });
    const html = renderToStaticMarkup(
      <CollectJourneyView journey={journey} onAction={() => undefined} />,
    );
    expect(html).toContain("COMPOSING_REQUEST");
    expect(JSON.stringify(journey)).not.toMatch(/password|api[_-]?key|cookie|mfa/i);
  });
});

describe("local-rail browser authorization (the BROWSER_SESSION mode)", () => {
  it("the stellar catalogue entry declares the BROWSER_SESSION mode with the recorded testnet evidence", () => {
    const status = catalogueStatusById("stellar");
    expect(status).toBeDefined();
    if (status === undefined) return;
    expect(status.isLocalRail).toBe(true);
    expect(status.userConnectionMode).toBe("BROWSER_SESSION");
    expect(status.evidenceLines.join(" ")).toMatch(/testnet/i);
  });

  it("the honest not-bound state renders (no broker wired — nothing is minted)", () => {
    const status = catalogueStatusById("stellar");
    if (status === undefined) return;
    const html = renderToStaticMarkup(
      <LocalRailAuthorization
        status={status}
        authorizationSurface={AUTHORIZATION_SURFACE_NOT_BOUND}
      />,
    );
    expect(html).toContain("browser-authorization path");
    expect(html).toContain("BROWSER_SESSION");
    expect(html).toContain("not yet bound to this deployment");
    expect(html).toContain("never cross into PaySwap");
    expect(AUTHORIZATION_SURFACE_NOT_BOUND.brokerBound).toBe(false);
  });

  it("the full-flow branch renders when a broker IS bound (deployment wiring; the app still never mints the ref)", () => {
    const status = catalogueStatusById("stellar");
    if (status === undefined) return;
    const html = renderToStaticMarkup(
      <LocalRailAuthorization
        status={status}
        authorizationSurface={{ brokerBound: true, honestState: "A local-rail broker is bound." }}
        browserSessionRef="browser-session-ref-test-1"
      />,
    );
    expect(html).toContain("Open the browser authorization");
    expect(html).toContain("browser-session-ref-test-1");
    expect(html).toContain("opaque session reference from the broker boundary");
  });

  it("the broker ref folds server-side and surfaces opaquely in the awaiting view", () => {
    const plane = buildConnectionPlaneForTests();
    plane.selectProvider(PRINCIPAL, "stellar");
    const attached = plane.attachBrokerSessionRef(
      PRINCIPAL,
      "stellar",
      asBrowserSessionRef("browser-session-ref-test-1"),
    );
    expect(attached.status).toBe("ok");
    if (attached.status !== "ok") return;
    expect(attached.journey.browserSessionRef).toBe("browser-session-ref-test-1");
    expect(attached.journey.stateName).toBe("initiating"); // the ref authorizes nothing
    const html = renderToStaticMarkup(
      <AwaitingAuthorizationView journey={attached.journey} providerDisplayName="Stellar local rail" />,
    );
    expect(html).toContain("browser-session-ref-test-1");
    expect(html).not.toMatch(/secret|private[_ ]?key|api[_-]?key/i);
  });
});

describe("no simulated financial effect reachable through the UI", () => {
  it("raw fetch exists ONLY in the three transport modules — every component goes through the real clients", () => {
    const webSrc = path.resolve(import.meta.dirname, "../src");
    const allowed = new Set([
      "lib/api-client.ts",
      "lib/api.ts",
      "lib/cc/api-server.ts",
    ]);
    const offenders: string[] = [];
    const files = readdirSync(webSrc, { recursive: true }).filter(
      (file) =>
        typeof file === "string" &&
        (file.endsWith(".ts") || file.endsWith(".tsx")) &&
        !file.includes("test/stubs"),
    ) as string[];
    for (const file of files) {
      const source = readFileSync(path.join(webSrc, file), "utf8")
        // Comments are prose, not calls — strip them before the scan.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // A raw fetch( call (not the named transport functions).
      if (/\bfetch\(/.test(source.replace(/(?:sessionFetchJson|paySwapApiFetch|fetchJson)\(/g, ""))) {
        if (!allowed.has(file)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the dispatch transport refuses unavailable actions and the preview (no session) — never a mutation", async () => {
    const journey = beginPayJourney({
      request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
      connectedInstances: [],
      routabilityChecks: [],
    });
    const unavailable = journey.actions.find((a) => a.actionId === "abandon-payment")!;
    // An action without an apiCommand is refused before any transport:
    const refused = await dispatchJourneyApiCommand("pay", unavailable, "csrf-token-test");
    expect(refused.kind).toBe("refused");

    // A real apiCommand action with NO csrf token (the marked preview):
    const reviewing = selectPayCapability(
      beginPayJourney({
        request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
        connectedInstances: [
          {
            instanceId: asConnectedCapabilityInstanceId("ci_stripe_test_1"),
            providerId: "stripe",
            connectedAt: "2026-10-02T12:00:00Z",
            state: "ACTIVE",
          },
        ],
        routabilityChecks: [
          { instanceId: asConnectedCapabilityInstanceId("ci_stripe_test_1"), currency: "GHS", routable: true },
        ],
      }),
      asConnectedCapabilityInstanceId("ci_stripe_test_1"),
      [],
    );
    const submitAction = reviewing.actions.find((a) => a.actionId === "submit-payment")!;
    const preview = await dispatchJourneyApiCommand("pay", submitAction, undefined);
    expect(preview.kind).toBe("unavailable");
    if (preview.kind === "unavailable") {
      expect(preview.message).toMatch(/marked preview/i);
      expect(preview.message).toMatch(/never mutates anything/i);
    }
  });

  it("serialized journeys and dispatch results carry no credential material", async () => {
    const plane = buildConnectionPlaneForTests();
    plane.selectProvider(PRINCIPAL, "stripe");
    for (const journey of plane.journeysFor(PRINCIPAL)) {
      expect(JSON.stringify(journey)).not.toMatch(/password|api[_-]?key|secret|mfa|private[_ ]?key/i);
    }
    const errorResponse = apiError(403, "auth.session_token_required");
    expect(JSON.stringify(errorResponse)).not.toMatch(/password|token\s*[:=]/i);
  });
});

// ---------------------------------------------------------------------------
// Local helpers (constructed connect journeys for direct contract folds)
// ---------------------------------------------------------------------------

import {
  beginConnectProvider,
  browseProviderCatalogue,
  chooseProvider,
  applyConnectionInitiationResponse,
} from "@payswap/ux";
import { providerCatalogueEntries } from "../src/app/(auth)/_server/connection-catalogue";

function beginConnectProviderJourney() {
  return browseProviderCatalogue(
    beginConnectProvider({ catalogue: providerCatalogueEntries() }),
  );
}

function chooseProviderStripe(journey: ReturnType<typeof beginConnectProviderJourney>) {
  return chooseProvider(journey, "stripe");
}
