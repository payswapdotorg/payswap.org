import { describe, expect, it } from "vitest";
import { BestExecutionEngine } from "../src/engine.js";
import type { BestExecutionRequest } from "../src/engine.js";
import { VenueRegistryError } from "../src/errors.js";
import {
  BENEFICIARY,
  CHAIN,
  NOW,
  OWNER,
  USC_ASSET,
  baseBestExecutionPolicy,
  baseSecurityPolicy,
  baseSecurityState,
  baseSwapRequest,
  connectedProtocolInstance,
  healthyObservation,
  syntheticVenue,
} from "./helpers.js";

/**
 * The deterministic best-execution engine: end-to-end selection over
 * synthetic venues (the core is venue-agnostic — these venues carry no
 * real-world identity), with every dimension proven to influence the
 * decision and the full provenance chain recorded.
 */

function baseRequest(overrides?: Partial<BestExecutionRequest>): BestExecutionRequest {
  return {
    executionId: "execution-001",
    swap: baseSwapRequest(),
    policy: baseBestExecutionPolicy(),
    security: {
      policy: baseSecurityPolicy(),
      state: baseSecurityState(),
    },
    instances: [
      connectedProtocolInstance({ protocolKey: "synth-alpha" }),
      connectedProtocolInstance({ protocolKey: "synth-beta" }),
    ],
    owner: OWNER,
    beneficiary: BENEFICIARY,
    requestedBy: "agent:agent-key-1",
    routeExpiryMs: NOW + 300_000,
    at: NOW,
    ...overrides,
  };
}

describe("engine registration law", () => {
  it("registers venues and exposes them in registration order", () => {
    const engine = new BestExecutionEngine();
    engine.register(syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" }));
    engine.register(syntheticVenue({ venueId: "venue-b", protocolKey: "synth-beta" }));
    expect(engine.venues().map((venue) => venue.descriptor.venueId)).toEqual([
      "venue-a",
      "venue-b",
    ]);
  });

  it("rejects duplicate venue ids", () => {
    const engine = new BestExecutionEngine();
    engine.register(syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" }));
    expect(() =>
      engine.register(syntheticVenue({ venueId: "venue-a", protocolKey: "synth-beta" })),
    ).toThrow(VenueRegistryError);
  });

  it("rejects a venue declaring simulation support without a simulate function", () => {
    const venue = syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" });
    const lying = { ...venue, simulate: undefined };
    expect(() => new BestExecutionEngine().register(lying as never)).toThrow(/simulation/);
  });
});

describe("end-to-end selection", () => {
  it("selects the highest net executable outcome and records the margin", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { quoteId: "q-alpha-1", worstCaseOutputMinorUnits: "995000" },
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteConfig: { quoteId: "q-beta-1", worstCaseOutputMinorUnits: "980000" },
      }),
    );
    const decision = engine.execute(baseRequest());
    expect(decision.decision).toBe("ROUTE_SELECTED");
    if (decision.decision !== "ROUTE_SELECTED") {
      return;
    }
    expect(decision.selected.venueId).toBe("venue-a");
    expect(decision.selected.quoteId).toBe("q-alpha-1");
    expect(decision.selected.gateDecision.decision).toBe("ALLOW");
    expect(decision.selected.write.writeId).toBe("write:q-alpha-1");
    expect(decision.selected.routeRef).toBe("execution-001/route/venue-a/q-alpha-1");
    // Margin: (995000 - 150 - 60) - (980000 - 150 - 60) = 15000.
    expect(decision.provenance.selection?.marginOverRunnerUpMinorUnits).toBe("15000");
  });

  it("carries the selected route's expected-state diff (prepare/simulate/diff integration)", () => {
    const engine = new BestExecutionEngine();
    engine.register(syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" }));
    const decision = engine.execute(baseRequest());
    expect(decision.decision).toBe("ROUTE_SELECTED");
    if (decision.decision !== "ROUTE_SELECTED") {
      return;
    }
    expect(decision.selected.simulation?.simulationId).toBe("sim:write:quote-venue-a-001");
    // The diff exists and references the write.
    expect(decision.selected.expectedDiff).toBeDefined();
    expect(decision.selected.expectedDiff.diffDigest).toBeDefined();
  });

  it("records every venue outcome in the provenance chain", () => {
    const engine = new BestExecutionEngine();
    engine.register(syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" }));
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteOutcome: "UNAVAILABLE",
        outcomeReason: "chain not served",
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-c",
        protocolKey: "synth-gamma",
        quoteOutcome: "OUTCOME_UNKNOWN",
        outcomeReason: "quote source unreachable",
      }),
    );
    const decision = engine.execute({
      ...baseRequest(),
      instances: [connectedProtocolInstance({ protocolKey: "synth-alpha" })],
    });
    expect(decision.decision).toBe("ROUTE_SELECTED");
    const chain = decision.provenance.venues;
    expect(chain.map((venue) => [venue.venueId, venue.outcome])).toEqual([
      ["venue-a", "QUOTED"],
      ["venue-b", "UNAVAILABLE"],
      ["venue-c", "OUTCOME_UNKNOWN"],
    ]);
    // UNKNOWN is recorded with its reason — never converted to failure.
    expect(chain[2]?.reason).toBe("quote source unreachable");
  });

  it("returns NO_EXECUTABLE_ROUTE when no venue can quote (ambiguity preserved)", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteOutcome: "OUTCOME_UNKNOWN",
        outcomeReason: "unreachable",
      }),
    );
    const decision = engine.execute(baseRequest());
    expect(decision.decision).toBe("NO_EXECUTABLE_ROUTE");
    if (decision.decision === "NO_EXECUTABLE_ROUTE") {
      expect(decision.detail).toContain("OUTCOME_UNKNOWN");
      expect(decision.detail).toContain("never converted to failure");
    }
  });
});

describe("every dimension influences the decision (explicit typed inputs)", () => {
  it("output: the better worst-case output wins", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { worstCaseOutputMinorUnits: "995000" },
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteConfig: { worstCaseOutputMinorUnits: "970000" },
      }),
    );
    const decision = engine.execute(baseRequest());
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe("venue-a");
  });

  it("fees: equal outputs, the cheaper venue wins", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: {
          worstCaseOutputMinorUnits: "990000",
          fees: [{ feeKind: "VENUE_FEE", minorUnits: "5000", description: "alpha fee" }],
        },
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteConfig: { worstCaseOutputMinorUnits: "990000" },
      }),
    );
    const decision = engine.execute(baseRequest());
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe("venue-b");
  });

  it("gas: equal outputs, the leaner route wins", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { worstCaseOutputMinorUnits: "990000", gasUnits: "300000" },
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteConfig: { worstCaseOutputMinorUnits: "990000", gasUnits: "100000" },
      }),
    );
    const decision = engine.execute(baseRequest());
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe("venue-b");
  });

  it("failure/retry risk: the hard cap disqualifies above-tolerance classes", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: {
          worstCaseOutputMinorUnits: "998000",
          riskClass: "ELEVATED",
        },
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteConfig: { worstCaseOutputMinorUnits: "980000", riskClass: "LOW" },
      }),
    );
    const decision = engine.execute(baseRequest());
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe("venue-b");
    const alpha = decision.ranking.find((trace) => trace.venueId === "venue-a");
    expect(alpha?.status).toBe("DISQUALIFIED");
    expect(alpha?.disqualifications?.map((reason) => reason.code)).toContain(
      "failure_risk_above_tolerance",
    );
  });

  it("time/finality: the hard time budget disqualifies slow settlement", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { worstCaseOutputMinorUnits: "999000", estimatedSettlementMs: 900_000 },
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteConfig: { worstCaseOutputMinorUnits: "980000", estimatedSettlementMs: 60_000 },
      }),
    );
    const decision = engine.execute(baseRequest());
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe("venue-b");
    const alpha = decision.ranking.find((trace) => trace.venueId === "venue-a");
    expect(alpha?.disqualifications?.map((reason) => reason.code)).toContain(
      "settlement_too_slow",
    );
  });

  it("health: UNHEALTHY disqualifies; UNKNOWN health holds the candidate as UNKNOWN (never converted)", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { worstCaseOutputMinorUnits: "999000" },
        health: healthyObservation({ status: "UNHEALTHY" }),
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteConfig: { worstCaseOutputMinorUnits: "990000" },
        health: healthyObservation({ status: "UNKNOWN" }),
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-c",
        protocolKey: "synth-gamma",
        quoteConfig: { worstCaseOutputMinorUnits: "980000" },
      }),
    );
    const decision = engine.execute({
      ...baseRequest(),
      instances: [
        connectedProtocolInstance({ protocolKey: "synth-alpha" }),
        connectedProtocolInstance({ protocolKey: "synth-beta" }),
        connectedProtocolInstance({ protocolKey: "synth-gamma" }),
      ],
    });
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe("venue-c");
    expect(decision.ranking.find((trace) => trace.venueId === "venue-a")?.status).toBe(
      "DISQUALIFIED",
    );
    const unknownTrace = decision.ranking.find((trace) => trace.venueId === "venue-b");
    expect(unknownTrace?.status).toBe("UNKNOWN");
    expect(unknownTrace?.unknownDimensions?.map((dimension) => dimension.code)).toContain(
      "health_unknown",
    );
  });

  it("policy: the venue allowlist is a hard constraint before any optimization", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { worstCaseOutputMinorUnits: "999000" },
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteConfig: { worstCaseOutputMinorUnits: "980000" },
      }),
    );
    const decision = engine.execute(
      baseRequest({
        policy: baseBestExecutionPolicy({ allowedVenues: ["venue-b"] }),
      }),
    );
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe("venue-b");
    const alpha = decision.ranking.find((trace) => trace.venueId === "venue-a");
    expect(alpha?.policyCompliance.compliant).toBe(false);
    expect(alpha?.status).toBe("DISQUALIFIED");
  });

  it("execution scope: a venue with no connected, ACTIVE, eligible instance never executes (INV-C05)", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { worstCaseOutputMinorUnits: "999000" },
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteConfig: { worstCaseOutputMinorUnits: "980000" },
      }),
    );
    const decision = engine.execute(
      baseRequest({
        instances: [
          connectedProtocolInstance({
            protocolKey: "synth-alpha",
            authorizationStatus: "REVOKED",
          }),
          connectedProtocolInstance({ protocolKey: "synth-beta" }),
        ],
      }),
    );
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe("venue-b");
    const alpha = decision.ranking.find((trace) => trace.venueId === "venue-a");
    expect(alpha?.disqualifications?.map((reason) => reason.code)).toContain(
      "no_execution_scope",
    );
  });
});

describe("deterministic evaluation inputs (no ambient clock)", () => {
  it("request validation fails closed on a malformed request", () => {
    const engine = new BestExecutionEngine();
    engine.register(syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" }));
    expect(() =>
      engine.execute(baseRequest({ executionId: "" })),
    ).toThrow(/executionId/);
    expect(() =>
      engine.execute(baseRequest({ routeExpiryMs: NOW })),
    ).toThrow(/routeExpiryMs/);
    expect(() =>
      engine.execute(baseRequest({ at: -1 })),
    ).toThrow(/ambient clock|at/);
  });

  it("the same inputs at the same instant produce the identical decision digest", () => {
    const engine = new BestExecutionEngine();
    engine.register(syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" }));
    const first = engine.execute(baseRequest());
    const second = engine.execute(baseRequest());
    expect(JSON.stringify(first.provenance)).toBe(JSON.stringify(second.provenance));
  });
});
