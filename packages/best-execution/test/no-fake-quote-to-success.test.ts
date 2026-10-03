import { describe, expect, it } from "vitest";
import { BestExecutionEngine } from "../src/engine.js";
import { RouteExecutionRecord } from "../src/execution-record.js";
import { ExecutionTransitionError } from "../src/errors.js";
import type { BestExecutionDecision } from "../src/engine.js";
import {
  BENEFICIARY,
  CHAIN,
  NOW,
  OWNER,
  baseBestExecutionPolicy,
  baseSecurityPolicy,
  baseSecurityState,
  baseSwapRequest,
  connectedProtocolInstance,
  syntheticVenue,
} from "./helpers.js";

/**
 * NO FAKE QUOTE-TO-SUCCESS (P4-W2-002 hard requirement 7): a quote that
 * was never executable may never be reported as a successful outcome. The
 * transition quote→executed REQUIRES a real execution observation (finality
 * CANDIDATE or UNKNOWN — never assumed final). These tests attack exactly
 * that seam, adversarially.
 */

function selectedDecision(): BestExecutionDecision {
  const engine = new BestExecutionEngine();
  engine.register(
    syntheticVenue({
      venueId: "venue-a",
      protocolKey: "synth-alpha",
      quoteConfig: { quoteId: "q-alpha-1", worstCaseOutputMinorUnits: "990000" },
    }),
  );
  const decision = engine.execute({
    executionId: "execution-001",
    swap: baseSwapRequest(),
    policy: baseBestExecutionPolicy(),
    security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
    instances: [connectedProtocolInstance({ protocolKey: "synth-alpha" })],
    owner: OWNER,
    beneficiary: BENEFICIARY,
    requestedBy: "agent:agent-key-1",
    routeExpiryMs: NOW + 300_000,
    at: NOW,
  });
  if (decision.decision !== "ROUTE_SELECTED") {
    throw new Error("fixture must select a route");
  }
  return decision;
}

function drivenRecord(decision: BestExecutionDecision): RouteExecutionRecord {
  const record = RouteExecutionRecord.open(decision);
  record.recordPreparedWrite(decision.decision === "ROUTE_SELECTED" ? decision.selected.write : undefined as never, NOW);
  record.recordGateDecision(
    decision.decision === "ROUTE_SELECTED" ? decision.selected.gateDecision : undefined as never,
    NOW,
  );
  record.recordBroadcastHandoff("handoff:signing-001", NOW);
  return record;
}

describe("the execution observation is the ONLY path to an executed state", () => {
  it("a fresh record is ROUTE_SELECTED — not executed", () => {
    const record = RouteExecutionRecord.open(selectedDecision());
    expect(record.status).toBe("ROUTE_SELECTED");
    expect(record.isExecutedCandidate).toBe(false);
  });

  it("driving the full happy path without an observation never executes", () => {
    const decision = selectedDecision();
    const record = drivenRecord(decision);
    expect(record.status).toBe("EXECUTION_SUBMITTED");
    expect(record.isExecutedCandidate).toBe(false);
  });

  it("a BROADCAST observation produces EXECUTION_BROADCAST — submitted is NOT finality (rule 29)", () => {
    const decision = selectedDecision();
    const record = drivenRecord(decision);
    const status = record.recordExecutionObservation(
      {
        observationId: "obs-001",
        executionRef: record.executionRef,
        observedAt: "2026-10-03T00:00:02Z",
        chainKey: CHAIN,
        outcome: "BROADCAST",
        externalOperationRef: "tx:001",
        evidenceRefs: ["evidence:broadcast:001"],
        provenance: { providerName: "chain-observer", source: "PROVIDER_API", capturedAt: "2026-10-03T00:00:02Z" },
      },
      NOW + 1_000,
    );
    expect(status).toBe("EXECUTION_BROADCAST");
    expect(record.isExecutedCandidate).toBe(false);
  });

  it("a CONFIRMED observation WITHOUT a finality candidate does NOT execute", () => {
    const decision = selectedDecision();
    const record = drivenRecord(decision);
    const status = record.recordExecutionObservation(
      {
        observationId: "obs-002",
        executionRef: record.executionRef,
        observedAt: "2026-10-03T00:00:03Z",
        chainKey: CHAIN,
        outcome: "CONFIRMED",
        externalOperationRef: "tx:001",
        evidenceRefs: ["evidence:confirmed:001"],
        provenance: { providerName: "chain-observer", source: "PROVIDER_API", capturedAt: "2026-10-03T00:00:03Z" },
      },
      NOW + 2_000,
    );
    expect(status).toBe("EXECUTION_CONFIRMED_OBSERVED");
    expect(record.isExecutedCandidate).toBe(false);
  });

  it("a CONFIRMED observation WITH a finality CANDIDATE executes as CANDIDATE ONLY", () => {
    const decision = selectedDecision();
    const record = drivenRecord(decision);
    const status = record.recordExecutionObservation(
      {
        observationId: "obs-003",
        executionRef: record.executionRef,
        observedAt: "2026-10-03T00:00:04Z",
        chainKey: CHAIN,
        outcome: "CONFIRMED",
        externalOperationRef: "tx:001",
        finalityCandidate: {
          candidateOnly: true,
          requiresProtocolFinality: true,
          confirmationDepth: 12,
          finalityModel: "PROBABILISTIC",
          reorgDetected: false,
        },
        evidenceRefs: ["evidence:confirmed:002"],
        provenance: { providerName: "chain-observer", source: "PROVIDER_API", capturedAt: "2026-10-03T00:00:04Z" },
      },
      NOW + 3_000,
    );
    expect(status).toBe("EXECUTED_CANDIDATE");
    expect(record.isExecutedCandidate).toBe(true);
    // The candidate is structurally candidate-only (INV-F06).
    expect(record.finalityCandidate?.candidateOnly).toBe(true);
    expect(record.finalityCandidate?.requiresProtocolFinality).toBe(true);
  });

  it("an OUTCOME_UNKNOWN observation produces a reconciliation-requiring state — never success or failure", () => {
    const decision = selectedDecision();
    const record = drivenRecord(decision);
    const status = record.recordExecutionObservation(
      {
        observationId: "obs-004",
        executionRef: record.executionRef,
        observedAt: "2026-10-03T00:00:05Z",
        chainKey: CHAIN,
        outcome: "OUTCOME_UNKNOWN",
        unknownReason: "transport error after submission",
        evidenceRefs: ["evidence:unknown:001"],
        provenance: { providerName: "chain-observer", source: "PROVIDER_API", capturedAt: "2026-10-03T00:00:05Z" },
      },
      NOW + 4_000,
    );
    expect(status).toBe("EXECUTION_OUTCOME_UNKNOWN");
    expect(record.isExecutedCandidate).toBe(false);
    // ...and a later CONFIRMED observation resolves it (reconciliation by
    // new evidence, exactly INV-X02/X03).
    const resolved = record.recordExecutionObservation(
      {
        observationId: "obs-005",
        executionRef: record.executionRef,
        observedAt: "2026-10-03T00:01:00Z",
        chainKey: CHAIN,
        outcome: "CONFIRMED",
        externalOperationRef: "tx:001",
        finalityCandidate: {
          candidateOnly: true,
          requiresProtocolFinality: true,
          confirmationDepth: 12,
          finalityModel: "PROBABILISTIC",
          reorgDetected: false,
        },
        evidenceRefs: ["evidence:confirmed:003"],
        provenance: { providerName: "chain-observer", source: "PROVIDER_API", capturedAt: "2026-10-03T00:01:00Z" },
      },
      NOW + 5_000,
    );
    expect(resolved).toBe("EXECUTED_CANDIDATE");
  });

  it("a FAILED observation is terminal and definitive", () => {
    const decision = selectedDecision();
    const record = drivenRecord(decision);
    const status = record.recordExecutionObservation(
      {
        observationId: "obs-006",
        executionRef: record.executionRef,
        observedAt: "2026-10-03T00:00:06Z",
        chainKey: CHAIN,
        outcome: "FAILED",
        failure: {
          failureClass: "REVERTED",
          description: "reverted on-chain",
          retryGuidance: "REQUIRES_RECONCILIATION",
        },
        evidenceRefs: ["evidence:failed:001"],
        provenance: { providerName: "chain-observer", source: "PROVIDER_API", capturedAt: "2026-10-03T00:00:06Z" },
      },
      NOW + 6_000,
    );
    expect(status).toBe("EXECUTION_FAILED");
    expect(record.isExecutedCandidate).toBe(false);
    // Terminal: no further observation mutates the record.
    expect(() =>
      record.recordExecutionObservation(
        {
          observationId: "obs-007",
          executionRef: record.executionRef,
          observedAt: "2026-10-03T00:00:07Z",
          chainKey: CHAIN,
          outcome: "CONFIRMED",
          evidenceRefs: ["evidence:x"],
          provenance: { providerName: "chain-observer", source: "PROVIDER_API", capturedAt: "2026-10-03T00:00:07Z" },
        },
        NOW + 7_000,
      ),
    ).toThrow(ExecutionTransitionError);
  });
});

describe("negative attacks on the seam (a quote is never an execution)", () => {
  it("an observation binding to a DIFFERENT execution is rejected", () => {
    const decision = selectedDecision();
    const record = drivenRecord(decision);
    expect(() =>
      record.recordExecutionObservation(
        {
          observationId: "obs-forged",
          executionRef: "best-execution:some-other-execution",
          observedAt: "2026-10-03T00:00:02Z",
          chainKey: CHAIN,
          outcome: "CONFIRMED",
          finalityCandidate: {
            candidateOnly: true,
            requiresProtocolFinality: true,
            finalityModel: "PROBABILISTIC",
            reorgDetected: false,
          },
          evidenceRefs: ["evidence:forged"],
          provenance: { providerName: "chain-observer", source: "PROVIDER_API", capturedAt: "2026-10-03T00:00:02Z" },
        },
        NOW + 1_000,
      ),
    ).toThrow(/executionRef/);
    expect(record.isExecutedCandidate).toBe(false);
  });

  it("an observation on the wrong chain is rejected", () => {
    const decision = selectedDecision();
    const record = drivenRecord(decision);
    expect(() =>
      record.recordExecutionObservation(
        {
          observationId: "obs-wrong-chain",
          executionRef: record.executionRef,
          observedAt: "2026-10-03T00:00:02Z",
          chainKey: "solana:mainnet-beta",
          outcome: "CONFIRMED",
          finalityCandidate: {
            candidateOnly: true,
            requiresProtocolFinality: true,
            finalityModel: "PROBABILISTIC",
            reorgDetected: false,
          },
          evidenceRefs: ["evidence:wrong-chain"],
          provenance: { providerName: "chain-observer", source: "PROVIDER_API", capturedAt: "2026-10-03T00:00:02Z" },
        },
        NOW + 1_000,
      ),
    ).toThrow(/chain/);
  });

  it("a malformed observation shape is rejected by the canonical domain validator", () => {
    const decision = selectedDecision();
    const record = drivenRecord(decision);
    // A BROADCAST outcome carrying a finality candidate violates the domain
    // coupling rules — rejected before any transition is considered.
    expect(() =>
      record.recordExecutionObservation(
        {
          observationId: "obs-malformed",
          executionRef: record.executionRef,
          observedAt: "2026-10-03T00:00:02Z",
          chainKey: CHAIN,
          outcome: "BROADCAST",
          finalityCandidate: {
            candidateOnly: true,
            requiresProtocolFinality: true,
            finalityModel: "PROBABILISTIC",
            reorgDetected: false,
          },
          evidenceRefs: [],
          provenance: { providerName: "", source: "PROVIDER_API", capturedAt: "x" },
        },
        NOW + 1_000,
      ),
    ).toThrow();
    expect(record.status).toBe("EXECUTION_SUBMITTED");
  });

  it("observations are not recordable before the broadcast handoff", () => {
    const decision = selectedDecision();
    const record = RouteExecutionRecord.open(decision);
    expect(() =>
      record.recordExecutionObservation(
        {
          observationId: "obs-premature",
          executionRef: record.executionRef,
          observedAt: "2026-10-03T00:00:02Z",
          chainKey: CHAIN,
          outcome: "CONFIRMED",
          evidenceRefs: ["evidence:premature"],
          provenance: { providerName: "chain-observer", source: "PROVIDER_API", capturedAt: "2026-10-03T00:00:02Z" },
        },
        NOW,
      ),
    ).toThrow(ExecutionTransitionError);
  });

  it("the record exposes NO method that accepts a quote and produces an executed state", () => {
    const decision = selectedDecision();
    const record = RouteExecutionRecord.open(decision);
    const methodNames = Object.getOwnPropertyNames(RouteExecutionRecord.prototype);
    // Every mutating method is enumerated; none of them takes a quote.
    for (const name of methodNames) {
      expect(String(name).toLowerCase().includes("quote")).toBe(false);
    }
    // And the quote object itself is useless as an observation input.
    expect(() =>
      record.recordExecutionObservation(decision.decision === "ROUTE_SELECTED" ? decision.selected.quote : null, NOW),
    ).toThrow();
  });

  it("an INDICATIVE quote is never selectable as an execution route in the first place", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-indicative",
        protocolKey: "synth-alpha",
        quoteConfig: {
          quoteId: "q-indicative",
          worstCaseOutputMinorUnits: "999999",
          quoteSemantics: "INDICATIVE",
        },
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-executable",
        protocolKey: "synth-beta",
        quoteConfig: { quoteId: "q-executable", worstCaseOutputMinorUnits: "950000" },
      }),
    );
    const decision = engine.execute({
      executionId: "execution-002",
      swap: baseSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances: [
        connectedProtocolInstance({ protocolKey: "synth-alpha" }),
        connectedProtocolInstance({ protocolKey: "synth-beta" }),
      ],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe(
      "venue-executable",
    );
    const indicative = decision.ranking.find(
      (trace) => trace.venueId === "venue-indicative",
    );
    expect(indicative?.status).toBe("DISQUALIFIED");
    expect(indicative?.disqualifications?.map((reason) => reason.code)).toContain(
      "quote_not_executable",
    );
  });

  it("opening a record on a NO_EXECUTABLE_ROUTE decision is impossible", () => {
    const engine = new BestExecutionEngine();
    const decision = engine.execute({
      executionId: "execution-003",
      swap: baseSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances: [],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(decision.decision).toBe("NO_EXECUTABLE_ROUTE");
    expect(() => RouteExecutionRecord.open(decision)).toThrow(ExecutionTransitionError);
  });

  it("a BLOCKed gate decision at the record level refuses to proceed (rule 27)", () => {
    const decision = selectedDecision();
    const record = RouteExecutionRecord.open(decision);
    record.recordPreparedWrite(
      decision.decision === "ROUTE_SELECTED" ? decision.selected.write : (undefined as never),
      NOW,
    );
    const blockedDecision = {
      decision: "BLOCK",
      reasons: [{ dimension: "route", code: "route_not_certified", message: "x", invariantRefs: [] }],
      checks: [],
      evidenceRefs: [],
    } as never;
    expect(() => record.recordGateDecision(blockedDecision, NOW)).toThrow(
      /BLOCKed route never proceeds/,
    );
    // The failed transition did not advance the record toward execution.
    expect(record.status).toBe("ROUTE_BLOCKED");
  });

  it("an UNKNOWN gate decision at the record level refuses to proceed (INV-X01)", () => {
    const decision = selectedDecision();
    const record = RouteExecutionRecord.open(decision);
    record.recordPreparedWrite(
      decision.decision === "ROUTE_SELECTED" ? decision.selected.write : (undefined as never),
      NOW,
    );
    const unknownDecision = {
      decision: "UNKNOWN",
      dimensions: [{ dimension: "route", code: "route_certification_unknown", message: "x" }],
      checks: [],
      evidenceRefs: [],
    } as never;
    expect(() => record.recordGateDecision(unknownDecision, NOW)).toThrow(
      /UNKNOWN is never converted/,
    );
    expect(record.status).toBe("WRITE_PREPARED");
  });

  it("a prepared write that does not bind to the selected route's digest is rejected", () => {
    const decision = selectedDecision();
    const record = RouteExecutionRecord.open(decision);
    const foreignWrite = {
      ...(decision.decision === "ROUTE_SELECTED" ? decision.selected.write : {}),
      writeDigest: "fnv1a64:deadbeefdeadbeef",
    } as never;
    expect(() => record.recordPreparedWrite(foreignWrite, NOW)).toThrow(
      /does not bind to the selected route/,
    );
  });
});
