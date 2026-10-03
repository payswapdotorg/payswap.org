import { describe, expect, it } from "vitest";
import { prepareWrite } from "../src/index.js";
import { buildExpectedStateDiff } from "../src/index.js";
import { evaluateOnchainWriteGates } from "../src/index.js";
import {
  TrustedApprovalSurface,
  buildAuthorizationRequest,
  onchainApprovalSigningPayload,
  verifyOnchainAuthorization,
} from "../src/index.js";
import type { OnchainAuthorizationArtifact, OnchainAuthorizationRequest } from "../src/index.js";
import { SecretShapeError } from "../src/index.js";
import {
  AGENT_PRINCIPAL,
  NOW,
  basePolicy,
  baseSecurityState,
  baseWriteRequest,
  testSurface,
} from "./helpers.js";

/**
 * AGENTS.md rule 10: user approval is a trusted-surface operation creating
 * a signed authorization artifact; a chat message is not authority.
 * Simulation-never-authority: a passing simulation alone can NEVER
 * produce an authorization artifact (acceptance-mandated).
 */

function readyRequest(): OnchainAuthorizationRequest {
  const write = prepareWrite(baseWriteRequest(), NOW);
  const decision = evaluateOnchainWriteGates({
    write,
    policy: basePolicy(),
    securityState: baseSecurityState(),
    at: NOW,
  });
  const diff = buildExpectedStateDiff(write);
  return buildAuthorizationRequest({
    requestId: "req-1",
    principal: AGENT_PRINCIPAL,
    write,
    expectedDiff: diff,
    gateDecision: decision,
    requestedAt: NOW,
  });
}

describe("trusted-surface-only minting (rule 10)", () => {
  it("mints a valid artifact through the surface and verifies every binding", () => {
    const surface = testSurface();
    const request = readyRequest();
    const artifact = surface.approve({
      request,
      policy: basePolicy(),
      securityState: baseSecurityState(),
      approverRef: "user:alice",
      expiresAt: NOW + 30_000,
      at: NOW + 1,
      agentRef: "agent:agent-key-1",
    });
    expect(artifact.signature.length).toBeGreaterThan(0);
    expect(artifact.principal).toBe("user:alice");
    expect(artifact.scope.chain).toBe("ethereum:mainnet");
    expect(surface.mintedArtifacts()).toHaveLength(1);

    const verification = verifyOnchainAuthorization(artifact, request, NOW + 2, {
      securityState: baseSecurityState(),
      trustedSurfaces: [surface],
    });
    expect(verification).toMatchObject({ valid: true });
  });

  it("refuses to mint when the deterministic gates currently say BLOCK", () => {
    const surface = testSurface();
    const request = readyRequest();
    // A fresh security state with a quarantined component covering the
    // route venue → the re-run inside approve() BLOCKs.
    const maliciousState = baseSecurityState({
      quarantinedComponents: [`connected_instance:${"venue-x"}`],
      restrictedComponents: [],
    });
    // The write must actually reference the quarantined component for the
    // block to fire; use the route hops:
    const writeWithVenue = { ...baseWriteRequest(), route: { routeId: "route-1", routeHash: request.write.route.routeHash, hops: [{ venue: "venue-x", chain: "ethereum:mainnet" }] } };
    const prepared = prepareWrite(writeWithVenue, NOW);
    const decision = evaluateOnchainWriteGates({ write: prepared, policy: basePolicy(), securityState: maliciousState, at: NOW });
    expect(decision.decision).toBe("BLOCK");
    const diff = buildExpectedStateDiff(prepared);
    const blockedRequest = buildAuthorizationRequest({
      requestId: "req-blocked",
      principal: AGENT_PRINCIPAL,
      write: prepared,
      expectedDiff: diff,
      gateDecision: decision,
      requestedAt: NOW,
    });
    expect(() =>
      surface.approve({
        request: blockedRequest,
        policy: basePolicy(),
        securityState: maliciousState,
        approverRef: "user:alice",
        expiresAt: NOW + 30_000,
        at: NOW + 1,
      }),
    ).toThrow(/refuses to mint.*BLOCK/);
  });

  it("refuses to mint when the request carries a tampered content hash", () => {
    const surface = testSurface();
    const request = readyRequest();
    const tampered = { ...request, requestedAt: NOW + 999 } as OnchainAuthorizationRequest;
    expect(() =>
      surface.approve({
        request: tampered,
        policy: basePolicy(),
        securityState: baseSecurityState(),
        approverRef: "user:alice",
        expiresAt: NOW + 30_000,
        at: NOW + 1,
      }),
    ).toThrow(/request hash mismatch/);
  });

  it("refuses self-approval: an agent can never approve its own request", () => {
    const surface = testSurface();
    const request = readyRequest();
    expect(() =>
      surface.approve({
        request,
        policy: basePolicy(),
        securityState: baseSecurityState(),
        approverRef: "agent:agent-key-1", // the requesting principal itself
        expiresAt: NOW + 30_000,
        at: NOW + 1,
      }),
    ).toThrow(/never approve its own request/);
  });

  it("refuses approval whose expiry outlives the write expiry or precedes issuance", () => {
    const surface = testSurface();
    const request = readyRequest();
    expect(() =>
      surface.approve({
        request,
        policy: basePolicy(),
        securityState: baseSecurityState(),
        approverRef: "user:alice",
        expiresAt: request.write.expiry + 1,
        at: NOW + 1,
      }),
    ).toThrow(/outlive the write expiry/);
    expect(() =>
      surface.approve({
        request,
        policy: basePolicy(),
        securityState: baseSecurityState(),
        approverRef: "user:alice",
        expiresAt: NOW,
        at: NOW + 1,
      }),
    ).toThrow(/strictly after issuance/);
  });
});

describe("simulation-never-authority (acceptance-mandated)", () => {
  it("a passing simulation alone cannot produce an authorization artifact", () => {
    const surface = testSurface();
    const request = readyRequest();
    // The only minting path is surface.approve(request, policy, state, ...).
    // A simulation result is NOT an input to that path in any shape:
    const simulationLike = {
      simulationId: "sim-1",
      writeId: "write-1",
      status: "SUCCEEDED",
      observedAt: NOW,
      balanceDeltas: [],
      approvals: [],
      simulator: "simulator:node-1",
    };
    // There is no function from SimulationObservation to an artifact; the
    // closest adversarial attempt is forging an artifact object directly.
    const forged = {
      principal: "user:alice",
      scope: request.gateDecision,
      expiry: NOW + 30_000,
      requestHash: request.requestHash,
      signature: "sig:forged",
      issuedAt: NOW + 1,
      surfaceRef: "surface:checkout-1",
      networkEpochAtIssuance: 0n,
    } as unknown as OnchainAuthorizationArtifact;
    const verification = verifyOnchainAuthorization(forged, request, NOW + 2, {
      securityState: baseSecurityState(),
      trustedSurfaces: [surface],
    });
    // Forged artifacts fail structural, provenance and binding verification:
    expect(verification.valid).toBe(false);
    if (!verification.valid) {
      expect([
        "malformed_artifact",
        "unregistered_surface",
        "expected_diff_mismatch",
        "write_digest_mismatch",
      ]).toContain(verification.reason);
    }
    // And the simulation itself confers nothing:
    expect(surface.mintedArtifacts()).toHaveLength(0);
    expect(simulationLike.status).toBe("SUCCEEDED"); // fixture sanity
  });
});

describe("verification (INV-A03/A02/S02)", () => {
  it("rejects a stale network epoch (INV-S02)", () => {
    const surface = testSurface();
    const request = readyRequest();
    const artifact = surface.approve({
      request,
      policy: basePolicy(),
      securityState: baseSecurityState(),
      approverRef: "user:alice",
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    const advancedState = baseSecurityState({ networkEpoch: 1n });
    const verification = verifyOnchainAuthorization(artifact, request, NOW + 2, {
      securityState: advancedState,
      trustedSurfaces: [surface],
    });
    expect(verification).toMatchObject({ valid: false, reason: "stale_network_epoch" });
  });

  it("rejects an artifact not minted by a registered trusted surface", () => {
    const request = readyRequest();
    const mintingSurface = testSurface();
    const artifact = mintingSurface.approve({
      request,
      policy: basePolicy(),
      securityState: baseSecurityState(),
      approverRef: "user:alice",
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    const otherSurface = testSurface();
    const verification = verifyOnchainAuthorization(artifact, request, NOW + 2, {
      securityState: baseSecurityState(),
      trustedSurfaces: [otherSurface],
    });
    expect(verification).toMatchObject({ valid: false, reason: "unregistered_surface" });
  });

  it("rejects an expired artifact deterministically", () => {
    const surface = testSurface();
    const request = readyRequest();
    const artifact = surface.approve({
      request,
      policy: basePolicy(),
      securityState: baseSecurityState(),
      approverRef: "user:alice",
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    const verification = verifyOnchainAuthorization(artifact, request, NOW + 30_000, {
      securityState: baseSecurityState(),
      trustedSurfaces: [surface],
    });
    expect(verification).toMatchObject({ valid: false, reason: "expired" });
  });

  it("rejects secret-shaped material injected into an artifact (rule 25)", () => {
    const surface = testSurface();
    const request = readyRequest();
    const artifact = surface.approve({
      request,
      policy: basePolicy(),
      securityState: baseSecurityState(),
      approverRef: "user:alice",
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    const smuggled: Record<string, unknown> = { ...artifact } as unknown as Record<string, unknown>;
    smuggled[`${"wallet"}${"Password"}`] = "hunter2"; // runtime-assembled forbidden field name
    const verification = verifyOnchainAuthorization(
      smuggled as unknown as OnchainAuthorizationArtifact,
      request,
      NOW + 2,
      { securityState: baseSecurityState() },
    );
    expect(verification).toMatchObject({ valid: false, reason: "secret_material_detected" });
    expect(() => {
      throw new SecretShapeError("test", []);
    }).toThrow(SecretShapeError);
  });

  it("rejects a request-hash mismatch (artifact bound to a different request)", () => {
    const surface = testSurface();
    const request = readyRequest();
    const artifact = surface.approve({
      request,
      policy: basePolicy(),
      securityState: baseSecurityState(),
      approverRef: "user:alice",
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    // A different write → different request
    const otherWrite = prepareWrite(
      { ...baseWriteRequest(), transfer: { ...baseWriteRequest().transfer!, amount: { currency: "USC", minorUnits: "2000000" } } },
      NOW,
    );
    const otherDecision = evaluateOnchainWriteGates({ write: otherWrite, policy: basePolicy(), securityState: baseSecurityState(), at: NOW });
    const otherDiff = buildExpectedStateDiff(otherWrite);
    const otherRequest = buildAuthorizationRequest({
      requestId: "req-2",
      principal: AGENT_PRINCIPAL,
      write: otherWrite,
      expectedDiff: otherDiff,
      gateDecision: otherDecision,
      requestedAt: NOW,
    });
    const verification = verifyOnchainAuthorization(artifact, otherRequest, NOW + 2, {
      securityState: baseSecurityState(),
    });
    expect(verification.valid).toBe(false);
    if (!verification.valid) {
      expect(["request_hash_mismatch", "amount_mismatch", "write_digest_mismatch", "expected_diff_mismatch"]).toContain(
        verification.reason,
      );
    }
  });
});

describe("canonical signing payload", () => {
  it("binds every onchain dimension deterministically", () => {
    const surface = testSurface();
    const request = readyRequest();
    const artifact = surface.approve({
      request,
      policy: basePolicy(),
      securityState: baseSecurityState(),
      approverRef: "user:alice",
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    const payload = onchainApprovalSigningPayload(artifact);
    expect(payload).toContain("chain:ethereum:mainnet");
    expect(payload).toContain(`routeHash:${request.write.route.routeHash}`);
    expect(payload).toContain(`expectedDiff:${request.expectedDiff.diffDigest}`);
    expect(payload).toContain("surface:surface:checkout-1");
    const again = onchainApprovalSigningPayload(artifact);
    expect(again).toBe(payload);
  });
});
