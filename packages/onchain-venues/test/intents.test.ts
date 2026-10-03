import { describe, expect, it } from "vitest";
import { validateOnchainExecutionObservation } from "@payswap/onchain-domain";
import { validateVenueQuote } from "@payswap/best-execution";
import { RouteExecutionRecord } from "@payswap/best-execution";
import { BestExecutionEngine } from "@payswap/best-execution";
import {
  INTENTS_PROTOCOL_KEY,
  INTENTS_SETTLEMENT_ADDRESS,
  INTENTS_VENUE_ID,
  buildIntentSettlementObservation,
  createIntentsVenuePack,
} from "../src/intents/index.js";
import { venueConnectedProtocolInstance } from "../src/index.js";
import {
  BENEFICIARY,
  CHAIN,
  NOW,
  OWNER,
  USC_ASSET,
  baseBestExecutionPolicy,
  baseSecurityPolicy,
  baseSecurityState,
  uscSwapRequest,
} from "./helpers.js";

/**
 * The intent/solver venue: batch-auction quotes (limit + modelled surplus),
 * the canonical IntentExecutionCapability flavor, and — critically — the
 * quote→executed seam: settlement observations are the ONLY evidence that
 * an intent executed.
 */

const pack = createIntentsVenuePack({
  limitBasisPoints: 5,
  surplusBasisPoints: 5,
  batchCadenceMs: 30_000,
});

describe("batch-auction quotes (limit is the guaranteed worst case)", () => {
  it("produces a valid executable quote whose worst case is the intent LIMIT", () => {
    const outcome = pack.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(() => validateVenueQuote(outcome.quote)).not.toThrow();
    // 1 USC reference, 5bps limit → 999500 guaranteed minimum.
    expect(outcome.quote.slippage.worstCaseOutput.minorUnits).toBe("999500");
    // 5bps modelled solver surplus → 1000500 expected (an estimate, never a promise).
    expect(outcome.quote.slippage.expectedOutput?.minorUnits).toBe("1000500");
    expect(outcome.quote.slippage.limitBasisPoints).toBe(5);
  });

  it("time-to-settlement carries the batch cadence plus inclusion", () => {
    const outcome = pack.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(outcome.quote.timeToSettlement.estimatedMs).toBe(75_000);
    expect(outcome.quote.timeToSettlement.description).toContain("30000ms");
  });

  it("failure risk is the declared escrow-returning profile", () => {
    const outcome = pack.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    expect(outcome.quote.failureRisk.riskClass).toBe("LOW");
    expect(outcome.quote.failureRisk.retryPolicy).toBe("SAFE_TO_RETRY");
    expect(outcome.quote.failureRisk.description).toContain("escrow-returning");
  });

  it("the solver-competition optimization is the declared incumbent baseline", () => {
    expect(pack.venue.descriptor.nativeOptimization).toEqual({
      optimizationKind: "OPEN_SOLVER_COMPETITION",
      benchmarkBaseline: true,
      description: expect.any(String),
    });
  });

  it("plans an onchain.intent write through the settlement contract", () => {
    const outcome = pack.venue.quote(uscSwapRequest(), NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("must quote");
    }
    const writeRequest = pack.venue.planWrite({
      quote: outcome.quote,
      instance: venueConnectedProtocolInstance({
        protocolKey: INTENTS_PROTOCOL_KEY,
        chainKey: CHAIN,
        instanceId: "instance:intents:001",
        providerName: "payswap-onchain-venues",
        accountRef: "acct:merchant-001",
        tenantRef: "tenant:merchant-001",
      }),
      owner: OWNER,
      beneficiary: BENEFICIARY,
      routeRef: "route/intent-1",
      routeHash: "fnv1a64:0000000000000002",
      expiryMs: NOW + 300_000,
      requestedBy: "agent:agent-key-1",
    });
    expect(writeRequest.action).toBe("onchain.intent");
    expect(writeRequest.contractCall?.target).toBe(INTENTS_SETTLEMENT_ADDRESS);
    expect(writeRequest.approvals[0]?.spender).toBe(INTENTS_SETTLEMENT_ADDRESS);
  });
});

describe("the quote→executed seam for intents (settlement observation REQUIRED)", () => {
  function selectedIntentDecision() {
    const engine = new BestExecutionEngine();
    engine.register(pack.venue);
    const decision = engine.execute({
      executionId: "execution-intents-001",
      swap: uscSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances: [
        venueConnectedProtocolInstance({
          protocolKey: INTENTS_PROTOCOL_KEY,
          chainKey: CHAIN,
          instanceId: "instance:intents:001",
          providerName: "payswap-onchain-venues",
          accountRef: "acct:merchant-001",
          tenantRef: "tenant:merchant-001",
        }),
      ],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    if (decision.decision !== "ROUTE_SELECTED") {
      throw new Error(`fixture must select the intent route (got ${decision.decision})`);
    }
    return decision;
  }

  it("an intent quote alone never executes (the full pre-observation lifecycle stays unexecuted)", () => {
    const decision = selectedIntentDecision();
    const record = RouteExecutionRecord.open(decision);
    record.recordPreparedWrite(decision.selected.write, NOW);
    record.recordGateDecision(decision.selected.gateDecision, NOW);
    record.recordBroadcastHandoff("handoff:intent-signing-001", NOW);
    expect(record.status).toBe("EXECUTION_SUBMITTED");
    expect(record.isExecutedCandidate).toBe(false);
  });

  it("the settlement observation executes the intent as a CANDIDATE ONLY", () => {
    const decision = selectedIntentDecision();
    const record = RouteExecutionRecord.open(decision);
    record.recordPreparedWrite(decision.selected.write, NOW);
    record.recordGateDecision(decision.selected.gateDecision, NOW);
    record.recordBroadcastHandoff("handoff:intent-signing-001", NOW);

    const settlement = buildIntentSettlementObservation({
      executionRef: record.executionRef,
      observationId: "settlement-obs-001",
      observedAtIso: "2026-10-03T00:01:00Z",
      settlementTxRef: "tx:settlement-batch-042",
      settledOutputMinorUnits: "1000200",
      outputCurrency: "USC",
      confirmationDepth: 12,
      reorgDetected: false,
    });
    // The settlement observation validates through the CANONICAL domain validator.
    expect(() => validateOnchainExecutionObservation(settlement)).not.toThrow();

    const status = record.recordExecutionObservation(settlement, NOW + 60_000);
    expect(status).toBe("EXECUTED_CANDIDATE");
    expect(record.finalityCandidate?.candidateOnly).toBe(true);
    expect(record.finalityCandidate?.requiresProtocolFinality).toBe(true);
    expect(record.observations()[0]?.observation.externalOperationRef).toBe(
      "tx:settlement-batch-042",
    );
  });

  it("a settlement observation for a DIFFERENT execution never executes this one", () => {
    const decision = selectedIntentDecision();
    const record = RouteExecutionRecord.open(decision);
    record.recordPreparedWrite(decision.selected.write, NOW);
    record.recordGateDecision(decision.selected.gateDecision, NOW);
    record.recordBroadcastHandoff("handoff:intent-signing-001", NOW);
    const foreign = buildIntentSettlementObservation({
      executionRef: "best-execution:someone-elses-intent",
      observationId: "settlement-obs-forged",
      observedAtIso: "2026-10-03T00:01:00Z",
      settlementTxRef: "tx:settlement-batch-999",
      settledOutputMinorUnits: "999999999",
      outputCurrency: "USC",
      confirmationDepth: 12,
      reorgDetected: false,
    });
    expect(() => record.recordExecutionObservation(foreign, NOW + 60_000)).toThrow(
      /executionRef/,
    );
    expect(record.isExecutedCandidate).toBe(false);
  });
});

describe("the canonical intent protocol declaration", () => {
  it("declares the INTENT_NETWORK class with the settlement contract", () => {
    expect(pack.protocol.protocol.protocolClass).toBe("INTENT_NETWORK");
    expect(pack.protocol.protocol.protocolKey).toBe(INTENTS_PROTOCOL_KEY);
    expect(pack.protocol.protocol.smartContracts[0]?.contractAddress).toBe(
      INTENTS_SETTLEMENT_ADDRESS,
    );
    expect(pack.venue.descriptor.venueId).toBe(INTENTS_VENUE_ID);
    // The escrow-return withdrawal authority is declared (INV-SC01 custody).
    expect(pack.protocol.protocol.smartContracts[0]?.custody.withdrawalAuthority).toContain(
      "withdraw unexecuted",
    );
  });
});
