import { describe, expect, it } from "vitest";
import { prepareWrite } from "../src/index.js";
import { buildExpectedStateDiff } from "../src/index.js";
import { evaluateOnchainWriteGates } from "../src/index.js";
import {
  buildAuthorizationRequest,
  verifyOnchainAuthorization,
  performPreBroadcastRecheck,
} from "../src/index.js";
import type {
  OnchainAuthorizationArtifact,
  OnchainAuthorizationRequest,
  RecheckObservation,
  TrustedApprovalSurface,
} from "../src/index.js";
import {
  AGENT_PRINCIPAL,
  CHAIN,
  NOW,
  ROUTE_HASH,
  USC_ASSET,
  MERCHANT,
  PAYER,
  basePolicy,
  baseSecurityState,
  baseWriteRequest,
  testSurface,
} from "./helpers.js";

/**
 * P4-W1-002 acceptance: stale-state invalidation — mutated state between
 * authorization and recheck VOIDS the authorization; it must be
 * re-requested, never auto-repaired.
 */

function authorized(): { request: OnchainAuthorizationRequest; artifact: OnchainAuthorizationArtifact; surface: TrustedApprovalSurface } {
  const write = prepareWrite(baseWriteRequest(), NOW);
  const decision = evaluateOnchainWriteGates({ write, policy: basePolicy(), securityState: baseSecurityState(), at: NOW });
  const diff = buildExpectedStateDiff(write);
  const request = buildAuthorizationRequest({
    requestId: "req-1",
    principal: AGENT_PRINCIPAL,
    write,
    expectedDiff: diff,
    gateDecision: decision,
    requestedAt: NOW,
  });
  const surface = testSurface();
  const artifact = surface.approve({
    request,
    policy: basePolicy(),
    securityState: baseSecurityState(),
    approverRef: "user:alice",
    expiresAt: NOW + 30_000,
    at: NOW + 1,
  });
  return { request, artifact, surface };
}

function okObservation(overrides?: Partial<RecheckObservation>): RecheckObservation {
  const { request } = authorized();
  const write = request.write;
  return {
    writeId: write.writeId,
    observedAt: NOW + 2,
    chain: write.chain,
    writeDigest: write.writeDigest,
    ...(write.transfer !== undefined
      ? { transfer: { asset: write.transfer.asset, amount: write.transfer.amount, to: write.transfer.to } }
      : {}),
    approvals: write.approvals,
    routeHash: write.route.routeHash,
    ...(write.nonce !== undefined ? { nonce: write.nonce } : {}),
    securityState: baseSecurityState(),
    ...overrides,
  };
}

describe("pre-broadcast recheck — clean state", () => {
  it("passes when nothing drifted", () => {
    const { request, artifact } = authorized();
    const outcome = performPreBroadcastRecheck(artifact, request, okObservation(), NOW + 2);
    expect(outcome.outcome).toBe("RECHECK_OK");
  });
});

describe("stale-state invalidation — every drift dimension voids", () => {
  const cases: readonly { name: string; drift: string; mutate: () => RecheckObservation }[] = [
    {
      name: "amount drift",
      drift: "amount_drift",
      mutate: () =>
        okObservation({
          transfer: { asset: USC_ASSET, amount: { currency: "USC", minorUnits: "2000000" }, to: MERCHANT },
        }),
    },
    {
      name: "destination drift",
      drift: "destination_drift",
      mutate: () =>
        okObservation({
          transfer: { asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, to: "0x9999999999999999999999999999999999999999" },
        }),
    },
    {
      name: "asset drift",
      drift: "asset_drift",
      mutate: () =>
        okObservation({
          transfer: {
            asset: { chain: CHAIN, assetId: "0xbbbb222222222222222222222222222222222222", symbol: "USC" },
            amount: { currency: "USC", minorUnits: "1000000" },
            to: MERCHANT,
          },
        }),
    },
    {
      name: "chain drift",
      drift: "chain_drift",
      mutate: () => okObservation({ chain: "polygon:mainnet" }),
    },
    {
      name: "route drift",
      drift: "route_drift",
      mutate: () => okObservation({ routeHash: "fnv1a64:0000000000000099" }),
    },
    {
      name: "nonce drift",
      drift: "nonce_drift",
      mutate: () => okObservation({ nonce: "42" }),
    },
    {
      name: "write payload drift",
      drift: "write_payload_drift",
      mutate: () => okObservation({ writeDigest: "fnv1a64:00000000000000ff" }),
    },
    {
      name: "spender/approval drift",
      drift: "approval_drift",
      mutate: () =>
        okObservation({
          approvals: [
            { asset: USC_ASSET, owner: PAYER, spender: "0x3333333333333333333333333333333333333333", amount: { currency: "USC", minorUnits: "1000" }, unlimited: false },
          ],
        }),
    },
    {
      name: "stale observation (observed before authorization)",
      drift: "stale_observation",
      mutate: () => okObservation({ observedAt: NOW - 1 }),
    },
    {
      name: "authorization expired",
      drift: "authorization_expired",
      mutate: () => okObservation({ observedAt: NOW + 2 }),
    },
    {
      name: "network epoch advanced",
      drift: "stale_network_epoch",
      mutate: () => okObservation({ securityState: baseSecurityState({ networkEpoch: 1n, observedAt: NOW + 2 }) }),
    },
    {
      name: "settlement instruction drift",
      drift: "settlement_instruction_drift",
      mutate: () =>
        okObservation({
          settlementInstruction: { instructionId: "si-1", instructionDigest: "fnv1a64:0000000000000011" },
        }),
    },
  ];

  for (const testCase of cases) {
    it(`VOIDS on ${testCase.name}`, () => {
      const { request, artifact } = authorized();
      let at = NOW + 2;
      if (testCase.drift === "authorization_expired") {
        at = NOW + 40_000; // past the approval expiry
      }
      const outcome = performPreBroadcastRecheck(artifact, request, testCase.mutate(), at);
      expect(outcome.outcome).toBe("AUTHORIZATION_VOIDED");
      if (outcome.outcome === "AUTHORIZATION_VOIDED") {
        expect(outcome.drift).toContain(testCase.drift);
        expect(outcome.detail).toContain("re-requested");
      }
    });
  }

  it("VOIDS on protocol identity drift when the write declared a protocol", () => {
    const write = prepareWrite(
      {
        ...baseWriteRequest(),
        protocol: {
          protocolId: "uniswap:v3",
          version: "1.0.0",
          contract: {
            kind: "smart_contract_extension",
            chainRef: CHAIN,
            contractAddress: "0x3333333333333333333333333333333333333333",
            sourceHash: "src-hash-1",
            bytecodeHash: "byte-hash-1",
            upgradeAuthority: { kind: "MULTISIG", description: "dao multisig" },
            adminAuthority: { kind: "MULTISIG", description: "dao multisig" },
            pausePowers: [],
            oracleDependencies: [],
            custody: { custodial: false, withdrawalAuthority: "owner-only", keyManagement: "non-custodial" },
            searchableByLabAfterCertification: true,
          },
        },
      },
      NOW,
    );
    const decision = evaluateOnchainWriteGates({ write, policy: basePolicy(), securityState: baseSecurityState(), at: NOW });
    const diff = buildExpectedStateDiff(write);
    const request = buildAuthorizationRequest({
      requestId: "req-proto",
      principal: AGENT_PRINCIPAL,
      write,
      expectedDiff: diff,
      gateDecision: decision,
      requestedAt: NOW,
    });
    const surface = testSurface();
    const artifact = surface.approve({
      request,
      policy: basePolicy(),
      securityState: baseSecurityState(),
      approverRef: "user:alice",
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    const drifted = okObservation({
      writeId: write.writeId,
      writeDigest: write.writeDigest,
      routeHash: write.route.routeHash,
      chain: write.chain,
      protocol: {
        protocolId: "uniswap:v3",
        version: "1.0.1",
        contract: {
          kind: "smart_contract_extension",
          chainRef: CHAIN,
          contractAddress: "0x3333333333333333333333333333333333333333",
          sourceHash: "src-hash-1",
          bytecodeHash: "byte-hash-CHANGED",
          upgradeAuthority: { kind: "MULTISIG", description: "dao multisig" },
          adminAuthority: { kind: "MULTISIG", description: "dao multisig" },
          pausePowers: [],
          oracleDependencies: [],
          custody: { custodial: false, withdrawalAuthority: "owner-only", keyManagement: "non-custodial" },
          searchableByLabAfterCertification: true,
        },
      },
    });
    const outcome = performPreBroadcastRecheck(artifact, request, drifted, NOW + 2);
    expect(outcome.outcome).toBe("AUTHORIZATION_VOIDED");
    if (outcome.outcome === "AUTHORIZATION_VOIDED") {
      expect(outcome.drift).toContain("protocol_identity_drift");
    }
  });

  it("multiple drifts are all reported", () => {
    const { request, artifact } = authorized();
    const observation = okObservation({
      routeHash: "fnv1a64:0000000000000099",
      transfer: { asset: USC_ASSET, amount: { currency: "USC", minorUnits: "5555555" }, to: "0x9999999999999999999999999999999999999999" },
    });
    const outcome = performPreBroadcastRecheck(artifact, request, observation, NOW + 2);
    expect(outcome.outcome).toBe("AUTHORIZATION_VOIDED");
    if (outcome.outcome === "AUTHORIZATION_VOIDED") {
      expect(outcome.drift).toEqual(expect.arrayContaining(["route_drift", "amount_drift", "destination_drift"]));
    }
  });
});

describe("no auto-repair exists (by construction)", () => {
  it("a VOIDED outcome carries no repair path: re-request is the only route", () => {
    const { request, artifact } = authorized();
    const outcome = performPreBroadcastRecheck(
      artifact,
      request,
      okObservation({ transfer: { asset: USC_ASSET, amount: { currency: "USC", minorUnits: "2000000" }, to: MERCHANT } }),
      NOW + 2,
    );
    expect(outcome.outcome).toBe("AUTHORIZATION_VOIDED");
    // Re-checking the SAME artifact against the SAME drifted observation
    // still voids — the artifact is dead for this content, permanently.
    const again = performPreBroadcastRecheck(
      artifact,
      request,
      okObservation({ transfer: { asset: USC_ASSET, amount: { currency: "USC", minorUnits: "2000000" }, to: MERCHANT } }),
      NOW + 3,
    );
    expect(again.outcome).toBe("AUTHORIZATION_VOIDED");
  });

  it("verification of the artifact still succeeds only for the ORIGINAL content", () => {
    const { request, artifact, surface } = authorized();
    // The artifact remains internally valid (signature/epoch/surface) —
    // what died is its binding to the drifted world. A NEW request for the
    // new amount cannot reuse this artifact:
    const newWrite = prepareWrite(
      { ...baseWriteRequest(), transfer: { ...baseWriteRequest().transfer!, amount: { currency: "USC", minorUnits: "2000000" } } },
      NOW,
    );
    const newDecision = evaluateOnchainWriteGates({ write: newWrite, policy: basePolicy(), securityState: baseSecurityState(), at: NOW });
    const newRequest = buildAuthorizationRequest({
      requestId: "req-new",
      principal: AGENT_PRINCIPAL,
      write: newWrite,
      expectedDiff: buildExpectedStateDiff(newWrite),
      gateDecision: newDecision,
      requestedAt: NOW,
    });
    const verification = verifyOnchainAuthorization(artifact, newRequest, NOW + 3, {
      securityState: baseSecurityState(),
      trustedSurfaces: [surface],
    });
    expect(verification.valid).toBe(false);
  });
});
