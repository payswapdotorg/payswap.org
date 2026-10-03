import { describe, expect, it } from "vitest";
import { EvmChainAdapter, ETHEREUM_MAINNET_PUBLIC_ENDPOINTS, nativeEtherBinding } from "../../src/evm/index.js";
import { HttpJsonRpcTransport } from "../../src/transport.js";
import { chainCapabilityId } from "@payswap/onchain-domain";
import type { ConnectedChainInstance, OnchainExecutionDirective } from "@payswap/onchain-domain";
import { capture } from "./capture.js";

/**
 * LIVE EVM family proof (P4-W2-001): READ-ONLY observations against PUBLIC
 * Ethereum mainnet JSON-RPC endpoints (PublicNode + Cloudflare — provider
 * diversity; no credentials). NO broadcast, NO signing, NO financial effect.
 * Chain heads, chain-id identity, balances AS OBSERVATIONS and EIP-1559 fee
 * semantics are genuinely observed; the observed values are captured to
 * evidence/live-capture.jsonl (machine-generated provenance).
 */
const PAYER = "0xd8dA6BF26964aF9D7eEd9e03E5341D47Da92db39"; // vitalik.eth — public address
const NOW = Date.now();

function liveInstance(): ConnectedChainInstance {
  return {
    instanceId: "instance:ethereum:mainnet:live-observation",
    capabilityId: chainCapabilityId("ethereum:mainnet"),
    implementationId: "impl:ethereum:mainnet:json-rpc",
    providerName: "public-rpc-observation",
    providerVersion: "1.0.0",
    accountRef: "acct:live-observation",
    tenantRef: "tenant:live-observation",
    authorization: {
      status: "ACTIVE",
      grantedAt: "2026-10-03T00:00:00Z",
      authorizationRef: "authz:live-observation",
    },
    credentialScope: { credentialRef: "cred:none:public-endpoint", credentialKind: "API_KEY" },
    geography: { countries: ["US"] },
    currencies: ["USD"],
    permissionState: { granted: ["onchain:read"], requested: ["onchain:read"], missing: [] },
    eligibility: { eligible: true, reasons: [] },
    configuration: { endpointKind: "public-rpc" },
    chainKey: "ethereum:mainnet",
    family: "EVM",
    familyExtension: { family: "EVM", evmChainId: "1" },
  };
}

function liveEvmAdapter(): EvmChainAdapter {
  return new EvmChainAdapter({
    adapterId: "adapter:evm:mainnet:live",
    chainKey: "ethereum:mainnet",
    evmChainId: "1",
    transport: new HttpJsonRpcTransport({
      transportId: "transport:evm:mainnet:live",
      endpoints: ETHEREUM_MAINNET_PUBLIC_ENDPOINTS,
    }),
    assetBindings: [nativeEtherBinding("ethereum:mainnet")],
    confirmationDepthTarget: 12,
  });
}

describe("LIVE EVM mainnet (read-only public endpoints)", () => {
  it("observes the chain head with provenance and environment class", async () => {
    const adapter = liveEvmAdapter();
    const probe = await adapter.observeChainHead({ at: new Date(NOW).toISOString() });
    expect(probe.kind).toBe("HEAD_OBSERVED");
    if (probe.kind !== "HEAD_OBSERVED") throw new Error("unreachable");
    expect(probe.head.height).toBeGreaterThan(20_000_000);
    expect(probe.head.headHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(probe.head.environmentClass).toBe("PRODUCTION");
    capture({
      family: "EVM",
      chainKey: "ethereum:mainnet",
      stage: "observeChainHead",
      endpointId: probe.head.provenance.endpointId,
      providerName: probe.head.provenance.providerName,
      height: probe.head.height,
      headHash: probe.head.headHash,
    });
  });

  it("observes an ETH balance as an OBSERVATION (INV-C09 — never custody)", async () => {
    const adapter = liveEvmAdapter();
    const probe = await adapter.observeAssetPosition({
      accountRef: PAYER,
      assetId: "ethereum:mainnet/asset:ETH",
      at: new Date(NOW).toISOString(),
    });
    expect(probe.kind).toBe("POSITION_OBSERVED");
    if (probe.kind !== "POSITION_OBSERVED") throw new Error("unreachable");
    expect(probe.observation.observedAmount.minorUnits).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(probe.observation.freshness.maxAgeSeconds).toBeGreaterThan(0);
    expect(probe.observation.observer.observerKind).toBe("RPC_PROVIDER");
    capture({
      family: "EVM",
      chainKey: "ethereum:mainnet",
      stage: "observeAssetPosition",
      accountRef: PAYER,
      assetId: probe.observation.assetId,
      observedMinorUnits: probe.observation.observedAmount.minorUnits,
      endpointProvider: probe.observation.provenance.providerName,
    });
  });

  it("prepares with a LIVE chain-id identity cross-check and explicit 1559 fee semantics", async () => {
    const adapter = liveEvmAdapter();
    const headProbe = await adapter.observeChainHead({ at: new Date(NOW).toISOString() });
    if (headProbe.kind !== "HEAD_OBSERVED") throw new Error("head unreachable");
    const directive: OnchainExecutionDirective = {
      operation: "onchain.transfer",
      chainKey: "ethereum:mainnet",
      family: "EVM",
      destination: "0x2222222222222222222222222222222222222222",
      assetId: "ethereum:mainnet/asset:ETH",
      amount: { assetId: "ethereum:mainnet/asset:ETH", minorUnits: "1000000" },
      expiresAt: new Date(NOW + 60_000).toISOString(),
      signerHandle: {
        handleId: "signer.handle.live.001",
        capabilityInstanceId: "instance:signer:live-001",
        custodyModel: "NON_CUSTODIAL_EXTERNAL",
      },
    };
    // Read-only prepare: eth_chainId + eth_getTransactionCount + block/fee
    // observation (NO submission happens at the prepare stage, ever).
    const prepared = await adapter.prepare({
      directive,
      instance: liveInstance(),
      signerAccountRef: PAYER,
      head: headProbe.head,
      at: NOW,
      requestedBy: "agent:live-observation",
    });
    expect(prepared.familyPlan.observedChainId).toBe("1");
    expect(prepared.familyPlan.nonce).toMatch(/^(0|[1-9][0-9]*)$/);
    capture({
      family: "EVM",
      chainKey: "ethereum:mainnet",
      stage: "prepare",
      observedChainId: prepared.familyPlan.observedChainId,
      nonce: prepared.familyPlan.nonce,
      fee: prepared.familyPlan.fee,
    });
    if (prepared.familyPlan.fee.expressible) {
      // Mainnet blocks carry baseFeePerGas: GAS_AUCTION 1559 semantics ARE
      // expressible on the observed block.
      expect(prepared.familyPlan.fee.eip1559).toBe(true);
      expect(Number(prepared.familyPlan.fee.baseFeePerGasMinorUnits)).toBeGreaterThan(0);
    }
  });
});
