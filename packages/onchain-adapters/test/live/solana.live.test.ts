import { describe, expect, it } from "vitest";
import { SolanaChainAdapter, SOLANA_MAINNET_PUBLIC_ENDPOINTS } from "../../src/solana/index.js";
import { HttpJsonRpcTransport } from "../../src/transport.js";
import { chainCapabilityId } from "@payswap/onchain-domain";
import type { ConnectedChainInstance, OnchainExecutionDirective } from "@payswap/onchain-domain";
import { capture } from "./capture.js";

/**
 * LIVE Solana family proof (P4-W2-001): READ-ONLY observations against the
 * PUBLIC mainnet-beta cluster RPC (Solana Labs + PublicNode — provider
 * diversity; no credentials). NO broadcast, NO simulation with signed
 * payloads, NO financial effect. Cluster identity (getGenesisHash
 * cross-check against the well-known mainnet-beta genesis), slots, latest
 * blockhash, balances AS OBSERVATIONS and SIGNATURE_FEE semantics via
 * getFeeForMessage are genuinely observed; values are captured to
 * evidence/live-capture.jsonl (machine-generated provenance).
 */
const ACCOUNT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // public mainnet account
const NOW = Date.now();

function liveInstance(): ConnectedChainInstance {
  return {
    instanceId: "instance:solana:mainnet-beta:live-observation",
    capabilityId: chainCapabilityId("solana:mainnet-beta"),
    implementationId: "impl:solana:mainnet-beta:json-rpc",
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
    chainKey: "solana:mainnet-beta",
    family: "SOLANA",
  };
}

function liveSolanaAdapter(): SolanaChainAdapter {
  return new SolanaChainAdapter({
    adapterId: "adapter:solana:mainnet-beta:live",
    chainKey: "solana:mainnet-beta",
    transport: new HttpJsonRpcTransport({
      transportId: "transport:solana:mainnet-beta:live",
      endpoints: SOLANA_MAINNET_PUBLIC_ENDPOINTS,
    }),
    slotConfirmationTarget: 32,
  });
}

describe("LIVE Solana mainnet-beta (read-only public endpoints)", () => {
  it("observes the chain head (slot + latest blockhash) with provenance", async () => {
    const adapter = liveSolanaAdapter();
    const probe = await adapter.observeChainHead({ at: new Date(NOW).toISOString() });
    expect(probe.kind).toBe("HEAD_OBSERVED");
    if (probe.kind !== "HEAD_OBSERVED") throw new Error("unreachable");
    expect(probe.head.height).toBeGreaterThan(450_000_000);
    expect(probe.head.headHash.length).toBe(44);
    expect(probe.head.environmentClass).toBe("PRODUCTION");
    capture({
      family: "SOLANA",
      chainKey: "solana:mainnet-beta",
      stage: "observeChainHead",
      endpointId: probe.head.provenance.endpointId,
      providerName: probe.head.provenance.providerName,
      slot: probe.head.height,
      latestBlockhash: probe.head.headHash,
    });
  });

  it("observes a SOL balance as an OBSERVATION (INV-C09 — never custody)", async () => {
    const adapter = liveSolanaAdapter();
    const probe = await adapter.observeAssetPosition({
      accountRef: ACCOUNT,
      assetId: "solana:mainnet-beta/asset:SOL",
      at: new Date(NOW).toISOString(),
    });
    expect(probe.kind).toBe("POSITION_OBSERVED");
    if (probe.kind !== "POSITION_OBSERVED") throw new Error("unreachable");
    expect(probe.observation.observedAmount.minorUnits).toMatch(/^(0|[1-9][0-9]*)$/);
    capture({
      family: "SOLANA",
      chainKey: "solana:mainnet-beta",
      stage: "observeAssetPosition",
      accountRef: ACCOUNT,
      observedLamports: probe.observation.observedAmount.minorUnits,
      endpointProvider: probe.observation.provenance.providerName,
    });
  });

  it("prepares with a LIVE genesis-hash identity cross-check and SIGNATURE_FEE semantics", async () => {
    const adapter = liveSolanaAdapter();
    const headProbe = await adapter.observeChainHead({ at: new Date(NOW).toISOString() });
    if (headProbe.kind !== "HEAD_OBSERVED") throw new Error("head unreachable");
    const directive: OnchainExecutionDirective = {
      operation: "onchain.transfer",
      chainKey: "solana:mainnet-beta",
      family: "SOLANA",
      destination: ACCOUNT,
      assetId: "solana:mainnet-beta/asset:SOL",
      amount: { assetId: "solana:mainnet-beta/asset:SOL", minorUnits: "1000000" },
      expiresAt: new Date(NOW + 60_000).toISOString(),
      signerHandle: {
        handleId: "signer.handle.live.002",
        capabilityInstanceId: "instance:signer:live-002",
        custodyModel: "NON_CUSTODIAL_EXTERNAL",
      },
    };
    const prepared = await adapter.prepare({
      directive,
      instance: liveInstance(),
      signerAccountRef: ACCOUNT,
      head: headProbe.head,
      at: NOW,
      requestedBy: "agent:live-observation",
    });
    // The live endpoint's genesis hash must match the well-known registry.
    expect(prepared.familyPlan.observedGenesisHash).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    expect(prepared.familyPlan.lastValidBlockHeight).toBeGreaterThan(0);
    capture({
      family: "SOLANA",
      chainKey: "solana:mainnet-beta",
      stage: "prepare",
      observedGenesisHash: prepared.familyPlan.observedGenesisHash,
      recentBlockhash: prepared.familyPlan.recentBlockhash,
      lastValidBlockHeight: prepared.familyPlan.lastValidBlockHeight,
      fee: prepared.familyPlan.fee,
    });
    if (prepared.familyPlan.fee.expressible) {
      expect(Number(prepared.familyPlan.fee.lamportsPerSignature)).toBeGreaterThan(0);
    }
  });
});
