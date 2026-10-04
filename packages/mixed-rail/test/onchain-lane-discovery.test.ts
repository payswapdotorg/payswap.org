import { describe, expect, it } from "vitest";
import { BestExecutionEngine } from "@payswap/best-execution";
import { protocolCapabilityId, onchainRailId } from "@payswap/onchain-domain";
import { validateConnectedProtocolInstance } from "@payswap/onchain-domain";
import { ValidationError } from "@payswap/protocol";
import { discoverOnchainLane, OnchainLaneDiscoveryError } from "../src/index.js";
import {
  BENEFICIARY,
  CHAIN,
  NOW,
  OWNER,
  baseBestExecutionPolicy,
  baseSecurityPolicy,
  baseSecurityState,
  createLabSimVenue,
  simProtocolInstance,
  uscAssetObservation,
  uscToEthSwapRequest,
} from "./fixtures.js";

/**
 * P4-W3-001 requirement 1: onchain lanes are discovered ONLY through the
 * REAL best-execution engine (the venue-port core) — eligibility,
 * authorization, security (gates) and evidence semantics are retained
 * because the KERNEL enforces them, not this package.
 */
describe("P4-W3-001 onchain-lane discovery through the real engine", () => {
  function engineWithSimVenue(input?: {
    readonly nativeBaseline?: boolean;
    readonly quoteOutcome?: "QUOTE" | "OUTCOME_UNKNOWN";
  }): BestExecutionEngine {
    const engine = new BestExecutionEngine();
    engine.register(
      createLabSimVenue({
        ...(input?.nativeBaseline !== undefined ? { nativeBaseline: input.nativeBaseline } : {}),
        ...(input?.quoteOutcome !== undefined ? { quoteOutcome: input.quoteOutcome } : {}),
      }),
    );
    return engine;
  }

  function discover(input?: {
    readonly engine?: BestExecutionEngine;
    readonly instance?: ReturnType<typeof simProtocolInstance>;
    readonly assetObservations?: readonly ReturnType<typeof uscAssetObservation>[];
    readonly securityPolicy?: ReturnType<typeof baseSecurityPolicy>;
    readonly securityState?: ReturnType<typeof baseSecurityState>;
    readonly at?: number;
  }) {
    return discoverOnchainLane({
      engine: input?.engine ?? engineWithSimVenue(),
      executionId: "discovery-test-001",
      swap: uscToEthSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: {
        policy: input?.securityPolicy ?? baseSecurityPolicy(),
        state: input?.securityState ?? baseSecurityState(),
      },
      instances: [input?.instance ?? simProtocolInstance()],
      assetObservations: input?.assetObservations ?? [uscAssetObservation()],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:mixed-rail-test",
      routeExpiryMs: (input?.at ?? NOW) + 300_000,
      at: input?.at ?? NOW,
    });
  }

  it("proves a lane with the kernel artifacts: gate ALLOW, prepared write, expected diff", () => {
    const result = discover();
    expect(result.status).toBe("LANE_PROVED");
    if (result.status !== "LANE_PROVED") {
      return;
    }
    const { lane } = result;
    // The kernel gate decision is carried verbatim (ALLOW — selection requires it).
    expect(lane.gateDecision.decision).toBe("ALLOW");
    // The kernel-prepared write and expected-state diff are present.
    expect(lane.write.writeDigest.length).toBeGreaterThan(0);
    expect(lane.expectedDiff.diffDigest.length).toBeGreaterThan(0);
    // The instance is the deterministic protocol capability scope.
    expect(lane.instance.capabilityId).toBe(protocolCapabilityId("lab-sim-dex", CHAIN));
    expect(lane.railId).toBe(onchainRailId(CHAIN));
    // Chain environment is re-derived from the kernel's frozen registry.
    expect(lane.environmentClass).toBe("PRODUCTION");
    // The observation law fields are carried.
    expect(lane.quote.freshness.maxAgeMs).toBeGreaterThan(0);
    expect(lane.inputAssetObservation.freshness.maxAgeSeconds).toBeGreaterThan(0);
    expect(lane.evidenceRefs.length).toBeGreaterThan(0);
  });

  it("the lane proof's instance passes the REAL kernel instance validator", () => {
    const result = discover();
    if (result.status !== "LANE_PROVED") {
      throw new Error("fixture lane must be proved");
    }
    expect(() => validateConnectedProtocolInstance(result.lane.instance)).not.toThrow();
  });

  it("retains AUTHORIZATION semantics: an inactive instance yields NO route (honest)", () => {
    const result = discover({
      instance: simProtocolInstance({ authorizationStatus: "REVOKED" }),
    });
    expect(result.status).toBe("NO_EXECUTABLE_ROUTE");
    if (result.status === "NO_EXECUTABLE_ROUTE") {
      // The full kernel provenance chain is returned verbatim — every venue
      // asked, every candidate's gate trace, nothing fabricated.
      expect(result.provenance.venues.length).toBe(1);
      expect(result.detail).toMatch(/no gate-ALLOWed executable route/);
    }
  });

  it("retains ELIGIBILITY semantics: an ineligible instance yields NO route (honest)", () => {
    const result = discover({
      instance: simProtocolInstance({ eligible: false }),
    });
    expect(result.status).toBe("NO_EXECUTABLE_ROUTE");
  });

  it("retains SECURITY semantics: a spender-not-permitted BLOCK kills the route (kernel gates)", () => {
    // The venue's router is NOT an allowed spender: the kernel gates BLOCK
    // the write and the engine cannot select the route (rule 27: a BLOCK
    // is terminal — no override exists anywhere).
    const result = discover({
      securityPolicy: baseSecurityPolicy({ allowedSpenders: ["0x9999999999999999999999999999999999999999"] }),
    });
    expect(result.status).toBe("NO_EXECUTABLE_ROUTE");
    if (result.status === "NO_EXECUTABLE_ROUTE") {
      const blocked = result.provenance.candidates.find(
        (candidate) => candidate.venueId === "lab-sim-dex",
      );
      expect(blocked?.status).toBe("SECURITY_BLOCKED");
      expect(blocked?.security.blockReasonCodes).toContain("spender_not_permitted");
    }
  });

  it("retains EVIDENCE semantics: the kernel provenance chain records every venue asked", () => {
    const result = discover();
    if (result.status !== "LANE_PROVED") {
      throw new Error("fixture lane must be proved");
    }
    expect(result.provenance.venues[0]?.outcome).toBe("QUOTED");
    expect(result.provenance.selection?.venueId).toBe("lab-sim-dex");
    expect(result.provenance.evidenceRefs.length).toBeGreaterThan(0);
  });

  it("retains provider-native baseline semantics: the venue declaration is carried (INV-C08)", () => {
    const result = discover({ engine: engineWithSimVenue({ nativeBaseline: true }) });
    expect(result.status).toBe("LANE_PROVED");
    if (result.status !== "LANE_PROVED") {
      return;
    }
    expect(result.lane.isVenueNativeBaseline).toBe(true);
  });

  it("a chain-unreachable quote stage is OUTCOME_UNKNOWN — never a fabricated route (honest)", () => {
    const result = discover({ engine: engineWithSimVenue({ quoteOutcome: "OUTCOME_UNKNOWN" }) });
    expect(result.status).toBe("NO_EXECUTABLE_ROUTE");
    if (result.status === "NO_EXECUTABLE_ROUTE") {
      // The venue's OUTCOME_UNKNOWN is recorded verbatim in the kernel
      // provenance chain — never converted into a failure or a route.
      expect(result.provenance.venues[0]?.outcome).toBe("OUTCOME_UNKNOWN");
    }
  });

  it("a MISSING input-asset observation grounding refuses to prove the lane (INV-C05 discipline)", () => {
    const result = discover({ assetObservations: [] });
    expect(result.status).toBe("LANE_UNPROVED_GROUNDING");
    if (result.status === "LANE_UNPROVED_GROUNDING") {
      expect(result.reason).toBe("INPUT_ASSET_OBSERVATION_MISSING");
      expect(result.detail).toMatch(/never grounds execution/);
    }
  });

  it("a STALE input-asset observation grounding refuses to prove the lane (freshness law)", () => {
    const result = discover({
      assetObservations: [
        uscAssetObservation({ asOf: "2026-10-03T00:00:00Z" }),
      ],
      // the security state stays fresh at the LATER instant so the only
      // stale input is the asset observation under test:
      securityState: baseSecurityState({ observedAt: NOW + 120_000 }),
      at: NOW + 120_000, // observation maxAge is 60s
    });
    expect(result.status).toBe("LANE_UNPROVED_GROUNDING");
    if (result.status === "LANE_UNPROVED_GROUNDING") {
      expect(result.reason).toBe("INPUT_ASSET_OBSERVATION_STALE");
      expect(result.detail).toMatch(/re-observed, never executed on stale state/);
    }
  });

  it("a grounded observation for the wrong account does not prove the lane (exact grounding)", () => {
    const wrongAccount = { ...uscAssetObservation(), location: { chainKey: CHAIN, accountRef: BENEFICIARY } };
    const result = discover({ assetObservations: [wrongAccount] });
    expect(result.status).toBe("LANE_UNPROVED_GROUNDING");
    if (result.status === "LANE_UNPROVED_GROUNDING") {
      expect(result.reason).toBe("INPUT_ASSET_OBSERVATION_MISSING");
    }
  });

  it("malformed kernel inputs fail closed BEFORE the engine runs (real validators)", () => {
    // A fake instance whose capability id disagrees with its protocol keys.
    const fakeInstance = {
      ...simProtocolInstance(),
      capabilityId: "protocol.ethereum:mainnet:not-the-real-key",
    };
    expect(() => discover({ instance: fakeInstance })).toThrow();
    // A fake asset observation missing the freshness law.
    const { freshness: _omittedFreshness, ...noFreshnessObservation } = uscAssetObservation();
    expect(() =>
      discover({
        assetObservations: [noFreshnessObservation as unknown as ReturnType<typeof uscAssetObservation>],
      }),
    ).toThrow();
  });

  it("invalid discovery input is rejected fail-closed", () => {
    expect(() =>
      discoverOnchainLane({
        engine: engineWithSimVenue(),
        executionId: "",
        swap: uscToEthSwapRequest(),
        policy: baseBestExecutionPolicy(),
        security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
        instances: [simProtocolInstance()],
        assetObservations: [uscAssetObservation()],
        owner: OWNER,
        beneficiary: BENEFICIARY,
        requestedBy: "agent:mixed-rail-test",
        routeExpiryMs: NOW + 300_000,
        at: NOW,
      }),
    ).toThrow();
    expect(() =>
      discoverOnchainLane({
        engine: engineWithSimVenue(),
        executionId: "discovery-test-001",
        swap: uscToEthSwapRequest(),
        policy: baseBestExecutionPolicy(),
        security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
        instances: [simProtocolInstance()],
        assetObservations: [uscAssetObservation()],
        owner: OWNER,
        beneficiary: BENEFICIARY,
        requestedBy: "agent:mixed-rail-test",
        routeExpiryMs: NOW + 300_000,
        at: -1,
      }),
    ).toThrow(OnchainLaneDiscoveryError);
  });
});
