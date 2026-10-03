import { describe, expect, it } from "vitest";
import { BestExecutionEngine } from "../src/engine.js";
import type { BestExecutionRequest } from "../src/engine.js";
import {
  BENEFICIARY,
  NOW,
  OWNER,
  SYNTHETIC_ROUTER,
  baseBestExecutionPolicy,
  baseSecurityPolicy,
  baseSecurityState,
  baseSwapRequest,
  connectedProtocolInstance,
  syntheticContractExtension,
  syntheticVenue,
} from "./helpers.js";

/**
 * Security-gate integration (P4-W2-002 hard requirement 5): candidate
 * routes flow through the @payswap/onchain-security prepare/simulate/diff
 * stages and the deterministic BLOCK/ALLOW/UNKNOWN gates. A security BLOCK
 * kills a route; UNKNOWN surfaces and is never converted; NO venue path
 * bypasses the gate.
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

describe("a security BLOCK kills a route (deterministic, terminal for the candidate)", () => {
  it("a BLOCKed best quote loses to the runner-up; the block reasons are recorded", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { quoteId: "q-alpha-1", worstCaseOutputMinorUnits: "999000" },
        contractAddress: "0x9999999999999999999999999999999999999999",
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "venue-b",
        protocolKey: "synth-beta",
        quoteConfig: { quoteId: "q-beta-1", worstCaseOutputMinorUnits: "980000" },
      }),
    );
    // The security policy does NOT allowlist venue-a's (different) router
    // address: the spender_approval dimension BLOCKs its write.
    const decision = engine.execute(baseRequest());
    expect(decision.decision).toBe("ROUTE_SELECTED");
    if (decision.decision !== "ROUTE_SELECTED") {
      return;
    }
    expect(decision.selected.venueId).toBe("venue-b");
    const blocked = decision.ranking.find((trace) => trace.venueId === "venue-a");
    expect(blocked?.status).toBe("SECURITY_BLOCKED");
    expect(blocked?.security.gateDecision).toBe("BLOCK");
    expect(blocked?.security.blockReasonCodes).toContain("spender_not_permitted");
    // The gate evaluated the real prepared write.
    expect(blocked?.security.writeDigest).toBeDefined();
  });

  it("a quarantined component (immune system) BLOCKs every route touching it", () => {
    const engine = new BestExecutionEngine();
    engine.register(syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" }));
    const decision = engine.execute(
      baseRequest({
        security: {
          policy: baseSecurityPolicy(),
          state: baseSecurityState({
            quarantinedComponents: [`protocol:${SYNTHETIC_ROUTER}`],
          }),
        },
      }),
    );
    expect(decision.decision).toBe("NO_EXECUTABLE_ROUTE");
    const trace = decision.ranking[0];
    expect(trace?.status).toBe("SECURITY_BLOCKED");
    expect(trace?.security.blockReasonCodes).toContain(
      "component_quarantined_or_restricted",
    );
  });

  it("a reverted simulation BLOCKs the route (simulation is not production truth)", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        simulateStatus: "REVERTED",
      }),
    );
    engine.register(syntheticVenue({ venueId: "venue-b", protocolKey: "synth-beta" }));
    const decision = engine.execute(baseRequest());
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe(
      "venue-b",
    );
    expect(decision.ranking.find((trace) => trace.venueId === "venue-a")?.status).toBe(
      "SECURITY_BLOCKED",
    );
  });
});

describe("UNKNOWN gates surface — never converted (INV-X01)", () => {
  it("an uncertified protocol with escalate policy holds the candidate UNKNOWN; it is never selected", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { worstCaseOutputMinorUnits: "999000" },
      }),
    );
    engine.register(syntheticVenue({ venueId: "venue-b", protocolKey: "synth-beta" }));
    const decision = engine.execute(
      baseRequest({
        security: {
          policy: baseSecurityPolicy({
            certifiedProtocols: [
              {
                protocolId: "synth-alpha",
                version: "1.0.0",
                contract: syntheticContractExtension(),
              },
              {
                protocolId: "some-other-protocol",
                version: "1.0.0",
                contract: syntheticContractExtension(),
              },
            ],
            unknownContractPolicy: "escalate",
            unknownRoutePolicy: "escalate",
          }),
          state: baseSecurityState(),
        },
      }),
    );
    // venue-beta's protocol is not in the certified list -> UNKNOWN.
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe(
      "venue-a",
    );
    const beta = decision.ranking.find((trace) => trace.venueId === "venue-b");
    expect(beta?.status).toBe("UNKNOWN");
    expect(beta?.security.gateDecision).toBe("UNKNOWN");
    expect(beta?.unknownDimensions?.map((dimension) => dimension.code)).toContain(
      "security_gate_unknown",
    );
  });

  it("a stale security state holds every candidate UNKNOWN (stale state is not failure)", () => {
    const engine = new BestExecutionEngine();
    engine.register(syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" }));
    const decision = engine.execute(
      baseRequest({
        security: {
          policy: baseSecurityPolicy({ maxSecurityStateAgeMs: 1_000 }),
          state: baseSecurityState({ observedAt: NOW - 60_000 }),
        },
      }),
    );
    expect(decision.decision).toBe("NO_EXECUTABLE_ROUTE");
    expect(decision.ranking[0]?.status).toBe("UNKNOWN");
    if (decision.decision === "NO_EXECUTABLE_ROUTE") {
      expect(decision.detail).toContain("UNKNOWN");
    }
  });
});

describe("no venue path bypasses the gate (structural)", () => {
  it("selection requires a recorded ALLOW bound to the prepared write digest", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { quoteId: "q-alpha-1", worstCaseOutputMinorUnits: "990000" },
      }),
    );
    const decision = engine.execute(baseRequest());
    expect(decision.decision).toBe("ROUTE_SELECTED");
    if (decision.decision !== "ROUTE_SELECTED") {
      return;
    }
    // The selected route's gate decision is ALLOW and the write digest
    // recorded in the security trace binds to the selected write.
    expect(decision.selected.gateDecision.decision).toBe("ALLOW");
    const trace = decision.ranking.find(
      (candidate) => candidate.venueId === decision.selected.venueId,
    );
    expect(trace?.security.gateDecision).toBe("ALLOW");
    expect(trace?.security.writeDigest).toBe(decision.selected.write.writeDigest);
  });

  it("a venue that fails to produce a gate-evaluable write is disqualified, never selected", () => {
    const engine = new BestExecutionEngine();
    const brokenVenue = {
      ...syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" }),
      planWrite(): never {
        throw new Error("venue planning exploded");
      },
    };
    engine.register(brokenVenue as never);
    engine.register(syntheticVenue({ venueId: "venue-b", protocolKey: "synth-beta" }));
    const decision = engine.execute(baseRequest());
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe(
      "venue-b",
    );
    const alpha = decision.ranking.find((trace) => trace.venueId === "venue-a");
    expect(alpha?.status).toBe("DISQUALIFIED");
    expect(alpha?.disqualifications?.map((reason) => reason.code)).toContain(
      "gate_evaluation_failed",
    );
  });

  it("a malformed quote from a venue disqualifies that candidate without crashing the decision", () => {
    const engine = new BestExecutionEngine();
    const base = syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" });
    const garbageVenue = {
      ...base,
      quote(): { kind: "QUOTE"; quote: unknown } {
        return { kind: "QUOTE", quote: { quoteId: "" } };
      },
    };
    engine.register(garbageVenue as never);
    engine.register(syntheticVenue({ venueId: "venue-b", protocolKey: "synth-beta" }));
    const decision = engine.execute(baseRequest());
    expect(decision.decision === "ROUTE_SELECTED" ? decision.selected.venueId : "").toBe(
      "venue-b",
    );
    expect(
      decision.ranking.find((trace) => trace.venueId === "venue-a")?.disqualifications?.map(
        (reason) => reason.code,
      ),
    ).toContain("quote_validation_failed");
  });
});
