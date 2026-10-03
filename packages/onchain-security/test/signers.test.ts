import { describe, expect, it } from "vitest";
import { prepareWrite } from "../src/index.js";
import { buildExpectedStateDiff } from "../src/index.js";
import { evaluateOnchainWriteGates } from "../src/index.js";
import { buildAuthorizationRequest } from "../src/index.js";
import { TrustedApprovalSurface } from "../src/index.js";
import { TEST_SURFACE_SIGNER } from "./helpers.js";
import {
  Eip712SignerAdapter,
  buildEip712Domain,
  ONCHAIN_AUTHORIZATION_PRIMARY_TYPE,
  FAIL_CLOSED_CHAIN_ID_RESOLVER,
} from "../src/adapters/eip712.js";
import {
  ERC1271_MAGIC_VALUE,
  Erc1271SignerAdapter,
  parseErc1271Envelope,
} from "../src/adapters/erc1271.js";
import { adapterSupportsChain, buildSigningRequest } from "../src/index.js";
import { performPreBroadcastRecheck } from "../src/index.js";
import {
  AGENT_PRINCIPAL,
  CHAIN,
  NOW,
  USC_ASSET,
  MERCHANT,
  basePolicy,
  baseSecurityState,
  baseWriteRequest,
} from "./helpers.js";

/**
 * Signer adapter contracts: EIP-712 typed data and ERC-1271 envelopes are
 * deterministic pure payload builders; adapters stay isolated from core
 * contracts (proved by the boundary test); signing secrets never appear.
 */

function authorizedArtifacts() {
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
  const surface = new TrustedApprovalSurface(TEST_SURFACE_SIGNER);
  const artifact = surface.approve({
    request,
    policy: basePolicy(),
    securityState: baseSecurityState(),
    approverRef: "user:alice",
    expiresAt: NOW + 30_000,
    at: NOW + 1,
  });
  return { request, artifact };
}

function passingRecheck(
  artifact: ReturnType<typeof authorizedArtifacts>["artifact"],
  request: ReturnType<typeof buildAuthorizationRequest>,
) {
  const write = request.write;
  return performPreBroadcastRecheck(
    artifact,
    request,
    {
      writeId: write.writeId,
      observedAt: NOW + 2,
      chain: write.chain,
      writeDigest: write.writeDigest,
      ...(write.transfer !== undefined
        ? { transfer: { asset: write.transfer.asset, amount: write.transfer.amount, to: write.transfer.to } }
        : {}),
      approvals: write.approvals,
      routeHash: write.route.routeHash,
      securityState: baseSecurityState({ observedAt: NOW + 2 }),
    },
    NOW + 2,
  );
}

describe("EIP-712 adapter (typed data behind the adapter)", () => {
  const resolver = { resolve: (chain: string) => (chain === CHAIN ? 1n : undefined) };

  it("builds deterministic typed data binding every authorization field", () => {
    const { request, artifact } = authorizedArtifacts();
    const adapter = new Eip712SignerAdapter({ chainIdResolver: resolver });
    const payload = adapter.buildSigningPayload({ artifact, request });
    const parsed = JSON.parse(payload) as {
      primaryType: string;
      domain: { chainId: string; verifyingContract: string };
      message: Record<string, string>;
    };
    expect(parsed.primaryType).toBe(ONCHAIN_AUTHORIZATION_PRIMARY_TYPE);
    expect(parsed.domain.chainId).toBe("1");
    expect(parsed.message["writeDigest"]).toBe(artifact.scope.writeDigest);
    expect(parsed.message["requestHash"]).toBe(artifact.requestHash);
    expect(parsed.message["chain"]).toBe(CHAIN);
    expect(parsed.message["amountMinorUnits"]).toBe("1000000");
    expect(parsed.message["destination"]).toBe(MERCHANT);
    // Deterministic: same inputs, same payload.
    expect(adapter.buildSigningPayload({ artifact, request })).toBe(payload);
  });

  it("fails closed for chains with no registered EVM chain id", () => {
    expect(() => buildEip712Domain(CHAIN, FAIL_CLOSED_CHAIN_ID_RESOLVER, "0xabc")).toThrow(/fail closed/);
    const adapter = new Eip712SignerAdapter(); // default resolver fails closed
    const { request, artifact } = authorizedArtifacts();
    expect(() => adapter.buildSigningPayload({ artifact, request })).toThrow(/no EVM chain id/);
  });

  it("supports chain wildcards for the ethereum family only", () => {
    const adapter = new Eip712SignerAdapter({ chainIdResolver: resolver });
    expect(adapterSupportsChain(adapter, "ethereum:mainnet")).toBe(true);
    expect(adapterSupportsChain(adapter, "ethereum:sepolia")).toBe(true);
    expect(adapterSupportsChain(adapter, "solana:mainnet")).toBe(false);
  });
});

describe("ERC-1271 adapter (contract signatures behind the adapter)", () => {
  it("builds a deterministic verification envelope for the smart account", () => {
    const { request, artifact } = authorizedArtifacts();
    const adapter = new Erc1271SignerAdapter();
    const payload = adapter.buildSigningPayload({ artifact, request });
    const envelope = parseErc1271Envelope(payload);
    expect(envelope.account).toBe("0x1111111111111111111111111111111111111111");
    expect(envelope.requestHash).toBe(artifact.requestHash);
    expect(envelope.writeDigest).toBe(artifact.scope.writeDigest);
    expect(adapter.buildSigningPayload({ artifact, request })).toBe(payload);
  });

  it("the magic value is the canonical ERC-1271 constant", () => {
    expect(ERC1271_MAGIC_VALUE).toBe("0x1626ba7e");
  });
});

describe("signing request construction (kernel never broadcasts)", () => {
  it("builds a secret-free signing request bound to artifact + recheck evidence", () => {
    const { request, artifact } = authorizedArtifacts();
    const recheck = passingRecheck(artifact, request);
    expect(recheck.outcome).toBe("RECHECK_OK");
    const adapter = new Eip712SignerAdapter({ chainIdResolver: { resolve: () => 1n } });
    const signingRequest = buildSigningRequest({
      requestId: "sign-1",
      artifact,
      request,
      recheck,
      adapter,
      at: NOW + 3,
    });
    expect(signingRequest.chain).toBe(CHAIN);
    expect(signingRequest.authorizationRef).toBe(artifact.requestHash);
    expect(signingRequest.deadline).toBe(request.write.expiry);
  });

  it("refuses to build a signing request from a VOIDED recheck", () => {
    const { request, artifact } = authorizedArtifacts();
    const write = request.write;
    const voidedRecheck = performPreBroadcastRecheck(
      artifact,
      request,
      {
        writeId: write.writeId,
        observedAt: NOW + 2,
        chain: write.chain,
        writeDigest: "fnv1a64:drifted",
        approvals: write.approvals,
        routeHash: write.route.routeHash,
        securityState: baseSecurityState({ observedAt: NOW + 2 }),
      },
      NOW + 2,
    );
    expect(voidedRecheck.outcome).toBe("AUTHORIZATION_VOIDED");
    const adapter = new Erc1271SignerAdapter();
    expect(() =>
      buildSigningRequest({ requestId: "sign-x", artifact, request, recheck: voidedRecheck, adapter, at: NOW + 3 }),
    ).toThrow(/PASSING pre-broadcast recheck/);
  });

  it("refuses to build after the authorization artifact expired", () => {
    const { request, artifact } = authorizedArtifacts();
    const recheck = passingRecheck(artifact, request);
    const adapter = new Erc1271SignerAdapter();
    expect(() =>
      buildSigningRequest({ requestId: "sign-x", artifact, request, recheck, adapter, at: NOW + 60_000 }),
    ).toThrow(/expired/);
  });

  it("refuses adapters that do not support the write's chain", () => {
    const { request, artifact } = authorizedArtifacts();
    const recheck = passingRecheck(artifact, request);
    const solanaOnlyAdapter = new Erc1271SignerAdapter({ supportedChains: ["solana:mainnet"] });
    expect(() =>
      buildSigningRequest({ requestId: "sign-x", artifact, request, recheck, adapter: solanaOnlyAdapter, at: NOW + 3 }),
    ).toThrow(/does not support chain/);
  });
});
