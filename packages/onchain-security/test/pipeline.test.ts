import { describe, expect, it } from "vitest";
import { OnchainWritePipeline, PipelineStateError } from "../src/index.js";
import { Eip712SignerAdapter } from "../src/adapters/eip712.js";
import { Erc1271SignerAdapter } from "../src/adapters/erc1271.js";
import type { SimulationObservation } from "../src/index.js";
import {
  AGENT_PRINCIPAL,
  CHAIN,
  MERCHANT,
  NOW,
  USC_ASSET,
  basePolicy,
  baseSecurityState,
  baseWriteRequest,
  testSurface,
} from "./helpers.js";

/**
 * The deterministic consequential-write pipeline:
 * prepare → simulate (when supported) → gates → diff → authorization →
 * recheck → broadcast handoff. Plus the negative paths the work order
 * mandates: no broadcast without authorization+recheck, BLOCKED terminal,
 * VOIDED terminal, agent flags advisory-only.
 */

const CHAIN_ID_RESOLVER = { resolve: () => 1n };

function newPipeline(overrides?: Partial<Parameters<typeof baseWriteRequest>[0]>) {
  return new OnchainWritePipeline({
    request: baseWriteRequest(overrides),
    policy: basePolicy(),
    trustedSurfaces: [testSurface()],
    at: NOW,
  });
}

function passingSimulation(): SimulationObservation {
  return {
    simulationId: "sim-1",
    writeId: "write-1",
    status: "SUCCEEDED",
    observedAt: NOW,
    balanceDeltas: [
      { holder: "0x1111111111111111111111111111111111111111", asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, direction: "debit" },
      { holder: MERCHANT, asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, direction: "credit" },
    ],
    approvals: [],
    simulator: "simulator:evm-node-1",
  };
}

function okRecheckObservation() {
  return {
    writeId: "write-1",
    observedAt: NOW + 2,
    chain: CHAIN,
    writeDigest: "", // filled by caller
    transfer: { asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, to: MERCHANT },
    approvals: [],
    routeHash: "fnv1a64:0000000000000001",
    securityState: baseSecurityState({ observedAt: NOW + 2 }),
  };
}

describe("golden path", () => {
  it("runs prepare → simulate → gates → diff → authorization → recheck → handoff", () => {
    const pipeline = newPipeline();
    expect(pipeline.state).toBe("PREPARED");

    pipeline.simulate(passingSimulation(), NOW);
    expect(pipeline.state).toBe("SIMULATED");

    const decision = pipeline.runGates(baseSecurityState(), NOW);
    expect(decision.decision).toBe("ALLOW");
    expect(pipeline.state).toBe("GATED_ALLOW");

    const diff = pipeline.buildExpectedDiff(NOW);
    expect(diff.entries.length).toBeGreaterThan(0);
    expect(pipeline.state).toBe("DIFF_READY");

    const request = pipeline.buildAuthorizationRequest({
      requestId: "req-1",
      principal: AGENT_PRINCIPAL,
      requestedAt: NOW,
    });
    const artifact = pipeline.authorize({
      surface: testSurface(),
      approverRef: "user:alice",
      securityState: baseSecurityState(),
      expiresAt: NOW + 30_000,
      at: NOW + 1,
      agentRef: "agent:agent-key-1",
    });
    expect(pipeline.state).toBe("AUTHORIZED");
    expect(artifact.requestHash).toBe(request.requestHash);

    const observation = { ...okRecheckObservation(), writeDigest: pipeline.prepared.writeDigest };
    const recheck = pipeline.recheck(observation, NOW + 2);
    expect(recheck.outcome).toBe("RECHECK_OK");
    expect(pipeline.state).toBe("RECHECKED");

    const adapter = new Eip712SignerAdapter({ chainIdResolver: CHAIN_ID_RESOLVER });
    const signingRequest = pipeline.handoffForBroadcast({ requestId: "sign-1", adapter, at: NOW + 3 });
    expect(pipeline.state).toBe("BROADCAST_HANDOFF");
    expect(signingRequest.signerAddress).toBe("0x1111111111111111111111111111111111111111");
    expect(signingRequest.authorizationRef).toBe(artifact.requestHash);
    expect(signingRequest.payload).toContain("PaySwapOnchainAuthorization");

    // Evidence log records the full lineage (INV-E01).
    const events = pipeline.evidence().map((entry) => entry.event);
    expect(events).toEqual(["PREPARE", "SIMULATE", "GATES_ALLOW", "BUILD_DIFF", "AUTHORIZE", "RECHECK_OK", "HANDOFF"]);
  });

  it("supports skipping simulation when unsupported (gates run directly from PREPARED)", () => {
    const pipeline = newPipeline();
    const decision = pipeline.runGates(baseSecurityState(), NOW);
    expect(decision.decision).toBe("ALLOW");
    expect(pipeline.state).toBe("GATED_ALLOW");
    pipeline.buildExpectedDiff(NOW);
    pipeline.buildAuthorizationRequest({ requestId: "req-1", principal: AGENT_PRINCIPAL, requestedAt: NOW });
    pipeline.authorize({
      surface: testSurface(),
      approverRef: "user:alice",
      securityState: baseSecurityState(),
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    const observation = { ...okRecheckObservation(), writeDigest: pipeline.prepared.writeDigest };
    expect(pipeline.recheck(observation, NOW + 2).outcome).toBe("RECHECK_OK");
    const signingRequest = pipeline.handoffForBroadcast({
      requestId: "sign-2",
      adapter: new Erc1271SignerAdapter(),
      at: NOW + 3,
    });
    expect(pipeline.state).toBe("BROADCAST_HANDOFF");
    expect(JSON.parse(signingRequest.payload)).toMatchObject({ account: "0x1111111111111111111111111111111111111111" });
  });
});

describe("no broadcast without the full lineage", () => {
  it("handoff is impossible before RECHECKED (no authorization → no broadcast)", () => {
    const pipeline = newPipeline();
    pipeline.runGates(baseSecurityState(), NOW);
    pipeline.buildExpectedDiff(NOW);
    expect(() =>
      pipeline.handoffForBroadcast({ requestId: "sign-x", adapter: new Eip712SignerAdapter(), at: NOW + 1 }),
    ).toThrow(PipelineStateError);
    expect(pipeline.state).toBe("DIFF_READY");
  });

  it("handoff is impossible after authorization without a passing recheck", () => {
    const pipeline = newPipeline();
    pipeline.runGates(baseSecurityState(), NOW);
    pipeline.buildExpectedDiff(NOW);
    pipeline.buildAuthorizationRequest({ requestId: "req-1", principal: AGENT_PRINCIPAL, requestedAt: NOW });
    pipeline.authorize({
      surface: testSurface(),
      approverRef: "user:alice",
      securityState: baseSecurityState(),
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    expect(() =>
      pipeline.handoffForBroadcast({ requestId: "sign-x", adapter: new Eip712SignerAdapter(), at: NOW + 1 }),
    ).toThrow(PipelineStateError);
    expect(pipeline.state).toBe("AUTHORIZED");
  });

  it("the kernel itself exposes no broadcast execution API (only handoff)", () => {
    const pipeline = newPipeline();
    // The ONLY execution-adjacent method is handoffForBroadcast, which
    // returns a SigningRequest and never submits anything.
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(pipeline));
    expect(methodNames).toContain("handoffForBroadcast");
    const broadcastLike = methodNames.filter(
      (name) => /^broadcast|^submit|^send|^execute/i.test(name),
    );
    expect(broadcastLike).toEqual([]);
  });
});

describe("BLOCKED is terminal (rule 27 + INV-X04 discipline)", () => {
  it("a BLOCK decision parks the pipeline in BLOCKED forever", () => {
    const pipeline = newPipeline({ transfer: { ...baseWriteRequest().transfer!, to: "0x4444444444444444444444444444444444444444" } });
    const decision = pipeline.runGates(baseSecurityState(), NOW);
    expect(decision.decision).toBe("BLOCK");
    expect(pipeline.state).toBe("BLOCKED");

    // Nothing works on a BLOCKED pipeline — not gates, not diff, not
    // authorization, not handoff, not even an agent flag.
    expect(() => pipeline.runGates(baseSecurityState(), NOW + 1)).toThrow(PipelineStateError);
    expect(() => pipeline.buildExpectedDiff(NOW)).toThrow(PipelineStateError);
    expect(() =>
      pipeline.buildAuthorizationRequest({ requestId: "req-x", principal: AGENT_PRINCIPAL, requestedAt: NOW }),
    ).toThrow(PipelineStateError);
    expect(() =>
      pipeline.handoffForBroadcast({ requestId: "sign-x", adapter: new Eip712SignerAdapter(), at: NOW }),
    ).toThrow(PipelineStateError);
  });

  it("a quarantined component appearing mid-flight BLOCKs the previously-allowed pipeline", () => {
    const pipeline = newPipeline();
    expect(pipeline.runGates(baseSecurityState(), NOW).decision).toBe("ALLOW");
    const quarantinedState = baseSecurityState({
      quarantinedComponents: ["extension:venue-x"],
      observedAt: NOW + 1,
    });
    const decision = pipeline.runGates(
      { ...quarantinedState },
      NOW + 1,
    );
    // The base write has no venue reference; quarantine of an unrelated
    // component does not BLOCK (deterministic scope matching).
    expect(decision.decision).toBe("ALLOW");

    const withVenue = new OnchainWritePipeline({
      request: {
        ...baseWriteRequest(),
        route: { routeId: "route-1", routeHash: "fnv1a64:0000000000000001", hops: [{ venue: "venue-x", chain: CHAIN }] },
      },
      policy: basePolicy(),
      at: NOW,
    });
    expect(withVenue.runGates(baseSecurityState(), NOW).decision).toBe("ALLOW");
    expect(withVenue.runGates(quarantinedState, NOW + 1).decision).toBe("BLOCK");
    expect(withVenue.state).toBe("BLOCKED");
  });
});

describe("UNKNOWN resolution requires new evidence, never approval", () => {
  it("an UNKNOWN gated pipeline cannot reach DIFF_READY by building a request", () => {
    const pipeline = new OnchainWritePipeline({
      request: {
        ...baseWriteRequest(),
        contractCall: { target: "0x5555555555555555555555555555555555555555", calldata: "0xdeadbeef", calldataDigest: "fnv1a64:a" },
      },
      policy: basePolicy({ unknownContractPolicy: "escalate" }),
      at: NOW,
    });
    const decision = pipeline.runGates(baseSecurityState(), NOW);
    expect(decision.decision).toBe("UNKNOWN");
    expect(pipeline.state).toBe("GATED_UNKNOWN");
    expect(() => pipeline.buildExpectedDiff(NOW)).toThrow(PipelineStateError);

    // Fresh evidence resolves it: policy escalation arrives via a NEW
    // versioned policy (deterministic policy input, never agent action).
    const escalatedPolicy = basePolicy({
      version: 2,
      unknownContractPolicy: "escalate",
      escalations: [
        {
          escalationId: "esc-1",
          dimension: "protocol_identity",
          targetRef: "0x5555555555555555555555555555555555555555",
          disposition: "allow_with_evidence",
          evidenceRefs: ["evidence:audit-1"],
          resolvedBy: "policy:operator",
          resolvedAt: NOW,
          expiresAt: NOW + 10_000,
        },
      ],
    });
    const fresh = new OnchainWritePipeline({
      request: {
        ...baseWriteRequest(),
        contractCall: { target: "0x5555555555555555555555555555555555555555", calldata: "0xdeadbeef", calldataDigest: "fnv1a64:a" },
      },
      policy: escalatedPolicy,
      at: NOW,
    });
    expect(fresh.runGates(baseSecurityState(), NOW).decision).toBe("ALLOW");
    expect(fresh.state).toBe("GATED_ALLOW");
  });
});

describe("VOIDED is terminal (stale-state invalidation)", () => {
  it("a drifted recheck voids the pipeline permanently; re-request means a NEW pipeline", () => {
    const pipeline = newPipeline();
    pipeline.runGates(baseSecurityState(), NOW);
    pipeline.buildExpectedDiff(NOW);
    pipeline.buildAuthorizationRequest({ requestId: "req-1", principal: AGENT_PRINCIPAL, requestedAt: NOW });
    pipeline.authorize({
      surface: testSurface(),
      approverRef: "user:alice",
      securityState: baseSecurityState(),
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    const drifted = {
      ...okRecheckObservation(),
      writeDigest: pipeline.prepared.writeDigest,
      transfer: { asset: USC_ASSET, amount: { currency: "USC", minorUnits: "2000000" }, to: MERCHANT },
    };
    const outcome = pipeline.recheck(drifted, NOW + 2);
    expect(outcome.outcome).toBe("AUTHORIZATION_VOIDED");
    expect(pipeline.state).toBe("VOIDED");

    // Nothing can revive it:
    expect(() => pipeline.recheck({ ...okRecheckObservation(), writeDigest: pipeline.prepared.writeDigest }, NOW + 3)).toThrow(
      PipelineStateError,
    );
    expect(() =>
      pipeline.handoffForBroadcast({ requestId: "sign-x", adapter: new Eip712SignerAdapter(), at: NOW + 3 }),
    ).toThrow(PipelineStateError);
    expect(() => pipeline.runGates(baseSecurityState(), NOW + 3)).toThrow(PipelineStateError);
  });
});

describe("agent flags ride along as evidence only (rule 27)", () => {
  it("flags never change state or decision", () => {
    const pipeline = newPipeline();
    const decision = pipeline.runGates(baseSecurityState(), NOW);
    expect(decision.decision).toBe("ALLOW");
    pipeline.attachAgentFlag(
      { flagId: "flag-1", flaggedBy: "agent:adversarial-1", dimension: "route", note: "suspicious hop pattern", flaggedAt: NOW + 1 },
      NOW + 1,
    );
    expect(pipeline.agentFlags).toHaveLength(1);
    expect(pipeline.gateDecision).toBe(decision);
    expect(pipeline.state).toBe("GATED_ALLOW");
    // The evidence log records the flag:
    expect(pipeline.evidence().some((entry) => entry.event === "FLAG")).toBe(true);
  });
});

describe("determinism", () => {
  it("identical inputs produce identical pipeline runs (replay equality)", () => {
    const run = () => {
      const pipeline = newPipeline();
      pipeline.simulate(passingSimulation(), NOW);
      pipeline.runGates(baseSecurityState(), NOW);
      pipeline.buildExpectedDiff(NOW);
      return pipeline.evidence();
    };
    const first = run();
    const second = run();
    expect(first).toEqual(second);
  });
});
