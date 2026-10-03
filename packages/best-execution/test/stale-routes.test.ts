import { describe, expect, it } from "vitest";
import {
  BestExecutionEngine,
  assertSelectedRouteValid,
  checkSelectedRouteValidity,
} from "../src/engine.js";
import { RouteInvalidatedError } from "../src/errors.js";
import { isHealthObservationStale, isQuoteStale } from "../src/index.js";
import { validateQuoteFreshness } from "../src/index.js";
import {
  BENEFICIARY,
  NOW,
  OWNER,
  baseBestExecutionPolicy,
  baseSecurityPolicy,
  baseSecurityState,
  baseSwapRequest,
  connectedProtocolInstance,
  healthyObservation,
  syntheticVenue,
} from "./helpers.js";

/**
 * Stale-route invalidation (P4-W2-002 hard requirement 6): quotes and
 * observations carry MANDATORY freshness (the onchain-domain observation
 * law); a route whose inputs age out is invalidated deterministically, and
 * re-validation happens by re-running best execution on refreshed
 * observations — never by repairing the old route.
 */

function engineWithVenue(quoteConfig?: { asOfMs?: number }) {
  const engine = new BestExecutionEngine();
  engine.register(
    syntheticVenue({
      venueId: "venue-a",
      protocolKey: "synth-alpha",
      quoteConfig: {
        quoteId: "q-alpha-1",
        worstCaseOutputMinorUnits: "990000",
        ...(quoteConfig?.asOfMs !== undefined ? { asOfMs: quoteConfig.asOfMs } : {}),
      },
    }),
  );
  return engine;
}

function baseRequest(at: number) {
  return {
    executionId: "execution-001",
    swap: baseSwapRequest(),
    policy: baseBestExecutionPolicy(),
    security: {
      policy: baseSecurityPolicy(),
      state: baseSecurityState(),
    },
    instances: [connectedProtocolInstance({ protocolKey: "synth-alpha" })],
    owner: OWNER,
    beneficiary: BENEFICIARY,
    requestedBy: "agent:agent-key-1",
    routeExpiryMs: NOW + 300_000,
    at,
  };
}

describe("mandatory quote freshness (the observation law)", () => {
  it("a quote without freshness never validates", () => {
    expect(() => validateQuoteFreshness({ asOfMs: -1, maxAgeMs: 1000 } as never)).toThrow();
    expect(() => validateQuoteFreshness({ asOfMs: 1000, maxAgeMs: 0 } as never)).toThrow();
    expect(() =>
      validateQuoteFreshness({ asOfMs: 1000.5, maxAgeMs: 1000 } as never),
    ).toThrow();
  });

  it("staleness is the deterministic bound: stale ⟺ (at − asOf) > maxAge", () => {
    const freshness = { asOfMs: NOW, maxAgeMs: 10_000 };
    expect(isQuoteStale(freshness, NOW)).toBe(false);
    expect(isQuoteStale(freshness, NOW + 10_000)).toBe(false); // inclusive bound
    expect(isQuoteStale(freshness, NOW + 10_001)).toBe(true); // one ms later: stale
  });

  it("health observations carry the same mandatory freshness law", () => {
    const health = healthyObservation({ observedAtMs: NOW, maxAgeMs: 5_000 });
    expect(isHealthObservationStale(health, NOW + 5_000)).toBe(false);
    expect(isHealthObservationStale(health, NOW + 5_001)).toBe(true);
    expect(() =>
      isHealthObservationStale(
        { ...health, maxAgeMs: 0 } as never,
        NOW,
      ),
    ).toThrow();
  });

  it("a stale quote is disqualified deterministically (never repaired)", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { quoteId: "q-old", worstCaseOutputMinorUnits: "999000", asOfMs: NOW - 60_000 },
      }),
    );
    const decision = engine.execute(baseRequest(NOW));
    expect(decision.decision).toBe("NO_EXECUTABLE_ROUTE");
    const trace = decision.ranking[0];
    expect(trace?.status).toBe("DISQUALIFIED");
    expect(trace?.disqualifications?.map((reason) => reason.code)).toContain("quote_stale");
  });
});

describe("selected-route invalidation after the decision", () => {
  it("a selected route is valid at decision time and deterministic afterwards", () => {
    const engine = engineWithVenue();
    const decision = engine.execute(baseRequest(NOW));
    expect(decision.decision).toBe("ROUTE_SELECTED");
    expect(checkSelectedRouteValidity(decision, NOW).valid).toBe(true);
    expect(checkSelectedRouteValidity(decision, NOW + 10_000).valid).toBe(true);
  });

  it("the route invalidates exactly one millisecond past the quote freshness bound", () => {
    const engine = engineWithVenue();
    const decision = engine.execute(baseRequest(NOW));
    // Default quote freshness: asOf NOW, maxAge 10_000.
    const invalidated = checkSelectedRouteValidity(decision, NOW + 10_001);
    expect(invalidated.valid).toBe(false);
    if (!invalidated.valid) {
      expect(invalidated.reasons.map((reason) => reason.code)).toEqual(["QUOTE_STALE"]);
      expect(invalidated.reasons[0]?.venueId).toBe("venue-a");
      expect(invalidated.reasons[0]?.quoteId).toBe("q-alpha-1");
    }
  });

  it("a stale health observation also invalidates the route (all inputs age out)", () => {
    const engine = new BestExecutionEngine();
    engine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: { quoteId: "q-alpha-1", worstCaseOutputMinorUnits: "990000", asOfMs: NOW },
        health: healthyObservation({ observedAtMs: NOW, maxAgeMs: 5_000 }),
      }),
    );
    const decision = engine.execute(baseRequest(NOW));
    const invalidated = checkSelectedRouteValidity(decision, NOW + 5_001);
    expect(invalidated.valid).toBe(false);
    if (!invalidated.valid) {
      expect(invalidated.reasons.map((reason) => reason.code)).toEqual([
        "HEALTH_OBSERVATION_STALE",
      ]);
    }
    // But the quote itself (maxAge 10s) is still fresh at +5001.
    expect(isQuoteStale(decision.decision === "ROUTE_SELECTED"
      ? decision.selected.quote.freshness
      : { asOfMs: 0, maxAgeMs: 1 }, NOW + 5_001)).toBe(false);
  });

  it("assertSelectedRouteValid throws for an invalidated route (fail closed)", () => {
    const engine = engineWithVenue();
    const decision = engine.execute(baseRequest(NOW));
    expect(() => assertSelectedRouteValid(decision, NOW + 10_001)).toThrow(
      RouteInvalidatedError,
    );
    expect(() => assertSelectedRouteValid(decision, NOW)).not.toThrow();
  });
});

describe("re-validation after refresh (fresh observations, new decision)", () => {
  it("an invalidated route re-validates by RE-RUNNING best execution on refreshed quotes", () => {
    // Time advances: the original decision's quote ages out.
    const later = NOW + 60_000;
    const firstEngine = engineWithVenue();
    const firstDecision = firstEngine.execute(baseRequest(NOW));
    expect(firstDecision.decision).toBe("ROUTE_SELECTED");
    expect(checkSelectedRouteValidity(firstDecision, later).valid).toBe(false);

    // The venue serves a REFRESHED quote (new asOf, new quote id). The
    // engine re-runs at the later instant and produces a fresh, valid
    // decision — the old route is never repaired.
    const refreshedEngine = new BestExecutionEngine();
    refreshedEngine.register(
      syntheticVenue({
        venueId: "venue-a",
        protocolKey: "synth-alpha",
        quoteConfig: {
          quoteId: "q-alpha-2",
          worstCaseOutputMinorUnits: "989000",
          asOfMs: later,
        },
        health: healthyObservation({ observedAtMs: later }),
      }),
    );
    const request = baseRequest(later);
    request.security.state = baseSecurityState({ observedAt: later });
    const secondDecision = refreshedEngine.execute(request);
    expect(secondDecision.decision).toBe("ROUTE_SELECTED");
    if (secondDecision.decision !== "ROUTE_SELECTED") {
      return;
    }
    expect(secondDecision.selected.quoteId).toBe("q-alpha-2");
    expect(secondDecision.selected.quote.freshness.asOfMs).toBe(later);
    expect(checkSelectedRouteValidity(secondDecision, later).valid).toBe(true);
    // And the ORIGINAL decision remains invalidated (immutable history).
    expect(checkSelectedRouteValidity(firstDecision, later).valid).toBe(false);
  });
});
