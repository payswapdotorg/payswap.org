import { describe, expect, it } from "vitest";
import { UtxoChainAdapter, BITCOIN_MAINNET_PUBLIC_ENDPOINTS } from "../../src/utxo/index.js";
import { HttpRestTransport } from "../../src/transport.js";
import { chainCapabilityId } from "@payswap/onchain-domain";
import type { ConnectedChainInstance, OnchainExecutionDirective } from "@payswap/onchain-domain";
import { capture } from "./capture.js";

/**
 * LIVE UTXO family proof (P4-W2-001): READ-ONLY observations against PUBLIC
 * Bitcoin mainnet explorer APIs (Blockstream + mempool.emzy.de — provider
 * diversity; no credentials). NO broadcast, NO financial effect. Genesis
 * block verification (structural chain identity), tip observations, UTXO-set
 * sums as asset OBSERVATIONS and the exact-decimal fee-rate quote are
 * genuinely observed; values are captured to evidence/live-capture.jsonl
 * (machine-generated provenance). Broadcast (POST /tx) is NOT exercised live
 * — no signing keys exist in this package by law (rule 25); that stage is
 * proven by the deterministic fixture suite.
 */
const ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"; // genesis-coinbase address (public)
const NOW = Date.now();

function liveInstance(): ConnectedChainInstance {
  return {
    instanceId: "instance:bitcoin:mainnet:live-observation",
    capabilityId: chainCapabilityId("bitcoin:mainnet"),
    implementationId: "impl:bitcoin:mainnet:esplora-rest",
    providerName: "public-explorer-observation",
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
    configuration: { endpointKind: "public-explorer" },
    chainKey: "bitcoin:mainnet",
    family: "UTXO",
  };
}

function liveUtxoAdapter(): UtxoChainAdapter {
  return new UtxoChainAdapter({
    adapterId: "adapter:utxo:mainnet:live",
    chainKey: "bitcoin:mainnet",
    transport: new HttpRestTransport({
      transportId: "transport:utxo:mainnet:live",
      endpoints: BITCOIN_MAINNET_PUBLIC_ENDPOINTS,
    }),
    confirmationDepthTarget: 6,
    feeEstimateTargetBlocks: 6,
  });
}

describe("LIVE Bitcoin mainnet (read-only public explorers)", () => {
  it("observes the chain tip (height + hash) with provenance", async () => {
    const adapter = liveUtxoAdapter();
    const probe = await adapter.observeChainHead({ at: new Date(NOW).toISOString() });
    expect(probe.kind).toBe("HEAD_OBSERVED");
    if (probe.kind !== "HEAD_OBSERVED") throw new Error("unreachable");
    expect(probe.head.height).toBeGreaterThan(900_000);
    expect(probe.head.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(probe.head.environmentClass).toBe("PRODUCTION");
    capture({
      family: "UTXO",
      chainKey: "bitcoin:mainnet",
      stage: "observeChainHead",
      endpointId: probe.head.provenance.endpointId,
      providerName: probe.head.provenance.providerName,
      tipHeight: probe.head.height,
      tipHash: probe.head.headHash,
    });
  });

  it("observes a UTXO-set balance as an OBSERVATION (INV-C09 — never custody)", async () => {
    const adapter = liveUtxoAdapter();
    const probe = await adapter.observeAssetPosition({
      accountRef: ADDRESS,
      assetId: "bitcoin:mainnet/asset:BTC",
      at: new Date(NOW).toISOString(),
    });
    expect(probe.kind).toBe("POSITION_OBSERVED");
    if (probe.kind !== "POSITION_OBSERVED") throw new Error("unreachable");
    expect(probe.observation.observedAmount.minorUnits).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(probe.observation.observer.observerKind).toBe("INDEXER");
    capture({
      family: "UTXO",
      chainKey: "bitcoin:mainnet",
      stage: "observeAssetPosition",
      accountRef: ADDRESS,
      observedSatoshi: probe.observation.observedAmount.minorUnits,
      endpointProvider: probe.observation.provenance.providerName,
    });
  });

  it("prepares with LIVE genesis verification and the exact-decimal fee-rate quote", async () => {
    const adapter = liveUtxoAdapter();
    const headProbe = await adapter.observeChainHead({ at: new Date(NOW).toISOString() });
    if (headProbe.kind !== "HEAD_OBSERVED") throw new Error("head unreachable");
    const directive: OnchainExecutionDirective = {
      operation: "onchain.transfer",
      chainKey: "bitcoin:mainnet",
      family: "UTXO",
      destination: "bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      assetId: "bitcoin:mainnet/asset:BTC",
      amount: { assetId: "bitcoin:mainnet/asset:BTC", minorUnits: "10000" },
      expiresAt: new Date(NOW + 60_000).toISOString(),
      signerHandle: {
        handleId: "signer.handle.live.003",
        capabilityInstanceId: "instance:signer:live-003",
        custodyModel: "NON_CUSTODIAL_EXTERNAL",
      },
    };
    const prepared = await adapter.prepare({
      directive,
      instance: liveInstance(),
      signerAccountRef: ADDRESS,
      head: headProbe.head,
      at: NOW,
      requestedBy: "agent:live-observation",
    });
    // Structural chain identity: the explorer's genesis block IS the
    // well-known mainnet genesis.
    expect(prepared.familyPlan.observedGenesisHash).toBe(
      "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
    );
    capture({
      family: "UTXO",
      chainKey: "bitcoin:mainnet",
      stage: "prepare",
      observedGenesisHash: prepared.familyPlan.observedGenesisHash,
      fee: prepared.familyPlan.fee,
    });
    if (prepared.familyPlan.fee.expressible) {
      // The verbatim decimal text of the 6-block estimate bucket.
      expect(Number(prepared.familyPlan.fee.feeRateSatPerVByte)).toBeGreaterThan(0);
      expect(prepared.familyPlan.fee.mempoolPolicy.replacement).toBe("BIP125_OPT_IN");
    }
  });
});
