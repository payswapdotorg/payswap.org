import { describe, expect, it } from "vitest";
import {
  AGENT_PRINCIPAL,
  BITCOIN_CHAIN,
  CHAIN,
  ETHEREUM_ASSET_ID,
  MERCHANT,
  NOW,
  NOW_ISO,
  PAYER,
  SOLANA_ASSET_ID,
  SOLANA_CHAIN,
  baseSecurityState,
  connectedChainInstance,
  evmHead,
  evmPolicy,
  evmTransferDirective,
  solanaTransferDirective,
  testSurface,
} from "./helpers.js";
import {
  EVM_RECEIPT_BLOCK_HASH,
  EVM_RECEIPT_BLOCK_NUMBER,
  EVM_TX_HASH,
  evmAdapter,
  evmAdapterWithTransport,
  evmRouteHash,
  scriptedEvmTransport,
  scriptedSolanaTransport,
  solanaAdapter,
  SOLANA_SIGNATURE,
} from "./adapter-fixture.js";
import { StaleObservationError } from "../src/errors.js";
import { assertHeadFresh, isObservationFresh } from "../src/lifecycle.js";
import { settlementAttemptEventCandidate } from "@payswap/onchain-domain";
import type { OnchainExecutionObservation } from "@payswap/onchain-domain";

/**
 * Work-order-mandated failure/reconciliation paths (deterministic):
 * - broadcast-then-reorg → UNKNOWN;
 * - observe-stale → invalidation;
 * - finalize-ambiguous → UNKNOWN;
 * - unreachable rails → availability UNKNOWN (INV-C01/C02), never failure;
 * - transport ambiguity after submission → OUTCOME_UNKNOWN (INV-X01).
 */
describe("broadcast-then-reorg → UNKNOWN", () => {
  it("EVM: a receipt that vanishes after a prior CONFIRMED observation is UNKNOWN", async () => {
    const transport = scriptedEvmTransport();
    const adapter = evmAdapterWithTransport(transport);
    const confirmed = await adapter.observeOperation({
      executionRef: "evm-reorg-1",
      externalOperationRef: EVM_TX_HASH,
      at: NOW,
    });
    expect(confirmed.outcome).toBe("CONFIRMED");

    // Re-script: the receipt vanishes (the containing block was reorganized away).
    transport.script("eth_getTransactionReceipt", () => null);
    const unknown = await adapter.observeOperation({
      executionRef: "evm-reorg-1",
      externalOperationRef: EVM_TX_HASH,
      at: NOW + 120_000,
      prior: confirmed,
    });
    expect(unknown.outcome).toBe("OUTCOME_UNKNOWN");
    expect(unknown.unknownReason).toMatch(/broadcast-then-reorg/);
    expect(unknown.failure).toBeUndefined();
    // The observation-level finality candidate is GONE (the domain validator
    // forbids finality candidates on UNKNOWN outcomes — structural).
    expect(unknown.finalityCandidate).toBeUndefined();
  });

  it("EVM: the chain's block at the receipt height no longer matches (reorg detected)", async () => {
    const transport = scriptedEvmTransport();
    const adapter = evmAdapterWithTransport(transport);
    const confirmed = await adapter.observeOperation({
      executionRef: "evm-reorg-2",
      externalOperationRef: EVM_TX_HASH,
      at: NOW,
    });
    expect(confirmed.outcome).toBe("CONFIRMED");

    // Re-script: the chain's block at the receipt's height is a DIFFERENT block.
    transport.script("eth_getBlockByNumber", (params) => {
      const block = params[0] as string;
      if (block === "latest") {
        return { hash: "0xabc0000000000000000000000000000000000000000000000000000000000f01", baseFeePerGas: "0x5f5e100" };
      }
      return { hash: "0xreorg0000000000000000000000000000000000000000000000000000000000001" };
    });
    const unknown = await adapter.observeOperation({
      executionRef: "evm-reorg-2",
      externalOperationRef: EVM_TX_HASH,
      at: NOW + 120_000,
      prior: confirmed,
    });
    expect(unknown.outcome).toBe("OUTCOME_UNKNOWN");
    expect(unknown.unknownReason).toMatch(/reorg detected/);
  });

  it("the UNKNOWN observation feeds the canonical UNKNOWN settlement path", () => {
    // A representative reorg-unknown observation (domain-validated shape).
    const unknown: OnchainExecutionObservation = {
      observationId: "exec-obs:reorg:1",
      executionRef: "evm-reorg-1",
      observedAt: NOW_ISO,
      chainKey: CHAIN,
      outcome: "OUTCOME_UNKNOWN",
      externalOperationRef: EVM_TX_HASH,
      unknownReason: "broadcast-then-reorg: the transaction receipt VANISHED after a prior CONFIRMED observation",
      evidenceRefs: ["evidence:reorg:1"],
      provenance: { providerName: "ScriptedProvider", source: "PROVIDER_API", capturedAt: NOW_ISO },
    };
    expect(settlementAttemptEventCandidate(unknown)).toEqual({
      kind: "EVENT_CANDIDATE",
      event: "OUTCOME_UNKNOWN",
    });
  });
});

describe("observe-stale → invalidation", () => {
  it("a stale chain head invalidates preparation (fail closed)", () => {
    const staleHead = evmHead({ observedAt: new Date(NOW - 10 * 60_000).toISOString() });
    expect(() => assertHeadFresh(staleHead, NOW)).toThrow(StaleObservationError);
    expect(() => assertHeadFresh(staleHead, NOW)).toThrow(/re-observe, never execute on stale state/);
  });

  it("a head dated in the future is treated as stale (fail closed)", () => {
    const futureHead = evmHead({ observedAt: new Date(NOW + 10 * 60_000).toISOString() });
    expect(() => assertHeadFresh(futureHead, NOW)).toThrow(StaleObservationError);
  });

  it("prepare refuses a stale head (the golden guard runs inside the prologue)", async () => {
    const adapter = evmAdapter();
    const directive = evmTransferDirective();
    await expect(
      adapter.prepare({
        directive,
        instance: connectedChainInstance(CHAIN, "EVM"),
        signerAccountRef: PAYER,
        head: evmHead({ observedAt: new Date(NOW - 10 * 60_000).toISOString() }),
        at: NOW,
        requestedBy: "agent:agent-key-1",
      }),
    ).rejects.toThrow(StaleObservationError);
  });

  it("an expired directive is never prepared (expiry is mandatory)", async () => {
    const adapter = evmAdapter();
    await expect(
      adapter.prepare({
        directive: evmTransferDirective({ expiresAt: new Date(NOW - 1_000).toISOString() }),
        instance: connectedChainInstance(CHAIN, "EVM"),
        signerAccountRef: PAYER,
        head: evmHead(),
        at: NOW,
        requestedBy: "agent:agent-key-1",
      }),
    ).rejects.toThrow(/must be a future instant at prepare time/);
  });

  it("broadcast refuses an expired kernel handoff (deadline enforced)", async () => {
    const adapter = evmAdapter();
    const directive = evmTransferDirective();
    const prepared = await adapter.prepare({
      directive,
      instance: connectedChainInstance(CHAIN, "EVM"),
      signerAccountRef: PAYER,
      head: evmHead(),
      at: NOW,
      requestedBy: "agent:agent-key-1",
    });
    const policy = evmPolicy({
      allowedChains: [CHAIN],
      allowedAssets: [{ chain: CHAIN, assetId: ETHEREUM_ASSET_ID, symbol: "ETH" }],
      allowedDestinations: [MERCHANT],
      knownRoutes: [evmRouteHash(directive)],
    });
    const feed = adapter.authorize({
      prepared,
      policy,
      securityState: baseSecurityState(),
      surface: testSurface(),
      principal: AGENT_PRINCIPAL,
      approverRef: "user:alice",
      requestId: "req-stale",
      signingRequestId: "sign-stale",
      at: NOW,
      expiresAt: NOW + 30_000,
    });
    // After the directive expiry the handoff is expired: broadcast fails closed.
    await expect(
      adapter.broadcast({
        handoff: feed.signingRequest,
        signedPayload: "0xSIGNED",
        at: NOW + 120_000,
        executionRef: "exec-stale",
      }),
    ).rejects.toThrow(/expired authorization can never broadcast/);
  });

  it("a drifted recheck VOIDS authorization (kernel stale-state invalidation, re-requested)", async () => {
    const adapter = evmAdapter();
    const directive = evmTransferDirective();
    const prepared = await adapter.prepare({
      directive,
      instance: connectedChainInstance(CHAIN, "EVM"),
      signerAccountRef: PAYER,
      head: evmHead(),
      at: NOW,
      requestedBy: "agent:agent-key-1",
    });
    const policy = evmPolicy({
      allowedChains: [CHAIN],
      allowedAssets: [{ chain: CHAIN, assetId: ETHEREUM_ASSET_ID, symbol: "ETH" }],
      allowedDestinations: [MERCHANT],
      knownRoutes: [evmRouteHash(directive)],
    });
    // A NEWER security epoch between authorization and recheck VOIDS the
    // authorization (stale-state invalidation; re-request, never repair).
    expect(() =>
      adapter.authorize({
        prepared,
        policy,
        securityState: baseSecurityState(),
        surface: testSurface(),
        principal: AGENT_PRINCIPAL,
        approverRef: "user:alice",
        requestId: "req-void",
        signingRequestId: "sign-void",
        at: NOW,
        expiresAt: NOW + 30_000,
        recheckSecurityState: baseSecurityState({
          networkEpoch: 1n,
          observedAt: NOW + 1,
        }),
      }),
    ).toThrow(StaleObservationError);
  });

  it("an asset observation past its freshness window is not fresh for acting", () => {
    const asOf = new Date(NOW - 120_000).toISOString();
    expect(isObservationFresh({ asOf, maxAgeSeconds: 30 }, NOW)).toBe(false);
    expect(isObservationFresh({ asOf: NOW_ISO, maxAgeSeconds: 30 }, NOW)).toBe(true);
  });
});

describe("finalize-ambiguous → UNKNOWN", () => {
  it("EVM: a receipt status that is neither 0x1 nor 0x0 is UNKNOWN", async () => {
    const transport = scriptedEvmTransport({
      responses: {
        eth_getTransactionReceipt: () => ({
          status: "0x2",
          blockNumber: "0x" + EVM_RECEIPT_BLOCK_NUMBER.toString(16),
          blockHash: EVM_RECEIPT_BLOCK_HASH,
        }),
      },
    });
    const adapter = evmAdapterWithTransport(transport);
    const observation = await adapter.observeOperation({
      executionRef: "evm-ambiguous-status",
      externalOperationRef: EVM_TX_HASH,
      at: NOW,
    });
    expect(observation.outcome).toBe("OUTCOME_UNKNOWN");
    expect(observation.unknownReason).toMatch(/neither success nor revert/);
    expect(observation.failure).toBeUndefined();
  });

  it("EVM: a receipt above the observed head is UNKNOWN (inconsistent provider data)", async () => {
    const transport = scriptedEvmTransport({
      responses: {
        eth_getTransactionReceipt: () => ({
          status: "0x1",
          blockNumber: "0x" + (18_000_005).toString(16),
          blockHash: EVM_RECEIPT_BLOCK_HASH,
        }),
      },
    });
    const adapter = evmAdapterWithTransport(transport);
    const observation = await adapter.observeOperation({
      executionRef: "evm-ambiguous-above-head",
      externalOperationRef: EVM_TX_HASH,
      at: NOW,
    });
    expect(observation.outcome).toBe("OUTCOME_UNKNOWN");
    expect(observation.unknownReason).toMatch(/above the observed head/);
  });

  it("Solana: a status slot above the observed head is UNKNOWN", async () => {
    const adapter = solanaAdapter({
      responses: {
        getSignatureStatuses: () => ({
          value: [{ slot: 453_015_900, confirmations: 1, confirmationStatus: "finalized", err: null }],
        }),
      },
    });
    const observation = await adapter.observeOperation({
      executionRef: "sol-ambiguous",
      externalOperationRef: SOLANA_SIGNATURE,
      at: NOW,
    });
    expect(observation.outcome).toBe("OUTCOME_UNKNOWN");
    expect(observation.unknownReason).toMatch(/above the observed head/);
  });
});

describe("unreachable rails → availability UNKNOWN (INV-C01/C02, never failure)", () => {
  it("EVM: an unreachable chain head surfaces HEAD_UNREACHABLE with availability UNKNOWN", async () => {
    const transport = scriptedEvmTransport();
    transport.goUnreachable();
    const adapter = evmAdapterWithTransport(transport);
    const probe = await adapter.observeChainHead({ at: NOW_ISO });
    expect(probe.kind).toBe("RAIL_UNREACHABLE");
    if (probe.kind !== "RAIL_UNREACHABLE") throw new Error("unreachable");
    expect(probe.availability).toBe("UNKNOWN");
    expect(probe.message).toMatch(/never success\/failure/);
    expect(probe.attemptedEndpointIds.length).toBe(2);
  });

  it("EVM: an unreachable broadcast attempt after submission is OUTCOME_UNKNOWN", async () => {
    const transport = scriptedEvmTransport();
    const adapter = evmAdapterWithTransport(transport);
    const directive = evmTransferDirective();
    const prepared = await adapter.prepare({
      directive,
      instance: connectedChainInstance(CHAIN, "EVM"),
      signerAccountRef: PAYER,
      head: evmHead(),
      at: NOW,
      requestedBy: "agent:agent-key-1",
    });
    const policy = evmPolicy({
      allowedChains: [CHAIN],
      allowedAssets: [{ chain: CHAIN, assetId: ETHEREUM_ASSET_ID, symbol: "ETH" }],
      allowedDestinations: [MERCHANT],
      knownRoutes: [evmRouteHash(directive)],
    });
    const feed = adapter.authorize({
      prepared,
      policy,
      securityState: baseSecurityState(),
      surface: testSurface(),
      principal: AGENT_PRINCIPAL,
      approverRef: "user:alice",
      requestId: "req-unreach",
      signingRequestId: "sign-unreach",
      at: NOW,
      expiresAt: NOW + 30_000,
    });
    transport.goUnreachable();
    const observation = await adapter.broadcast({
      handoff: feed.signingRequest,
      signedPayload: "0xSIGNED",
      at: NOW + 10,
      executionRef: "exec-unreach",
    });
    expect(observation.outcome).toBe("OUTCOME_UNKNOWN");
    expect(observation.unknownReason).toMatch(/transport unreachable after the submission attempt/);
    expect(observation.failure).toBeUndefined();
  });

  it("EVM: simulation transport ambiguity is OUTCOME_UNKNOWN, never FAILED", async () => {
    const transport = scriptedEvmTransport({
      responses: {
        eth_estimateGas: () => ({ scriptedError: "connection reset mid-estimate" }),
      },
    });
    const adapter = evmAdapterWithTransport(transport);
    const directive = evmTransferDirective();
    const prepared = await adapter.prepare({
      directive,
      instance: connectedChainInstance(CHAIN, "EVM"),
      signerAccountRef: PAYER,
      head: evmHead(),
      at: NOW,
      requestedBy: "agent:agent-key-1",
    });
    const simulation = await adapter.simulate({ prepared, at: NOW });
    expect(simulation.status).toBe("OUTCOME_UNKNOWN");
  });

  it("Solana: an unreachable position observation is POSITION_UNOBSERVABLE (never fabricated)", async () => {
    const transport = scriptedSolanaTransport();
    transport.goUnreachable();
    const adapter = solanaAdapter();
    // Build an adapter over the unreachable transport via family constructor.
    const { SolanaChainAdapter } = await import("../src/solana/index.js");
    const unreachableAdapter = new SolanaChainAdapter({
      adapterId: "adapter:solana:unreachable",
      chainKey: SOLANA_CHAIN,
      transport,
      slotConfirmationTarget: 32,
    });
    const probe = await unreachableAdapter.observeAssetPosition({
      accountRef: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      assetId: SOLANA_ASSET_ID,
      at: NOW_ISO,
    });
    expect(probe.kind).toBe("POSITION_UNOBSERVABLE");
    void adapter;
    void BITCOIN_CHAIN;
    void solanaTransferDirective;
  });
});

describe("reconciliation plans (INV-X02/X03 — never blind retry)", () => {
  it("an UNKNOWN broadcast observation produces a deterministic reconciliation plan", async () => {
    const transport = scriptedEvmTransport();
    const adapter = evmAdapterWithTransport(transport);
    const directive = evmTransferDirective();
    const prepared = await adapter.prepare({
      directive,
      instance: connectedChainInstance(CHAIN, "EVM"),
      signerAccountRef: PAYER,
      head: evmHead(),
      at: NOW,
      requestedBy: "agent:agent-key-1",
    });
    const policy = evmPolicy({
      allowedChains: [CHAIN],
      allowedAssets: [{ chain: CHAIN, assetId: ETHEREUM_ASSET_ID, symbol: "ETH" }],
      allowedDestinations: [MERCHANT],
      knownRoutes: [evmRouteHash(directive)],
    });
    const feed = adapter.authorize({
      prepared,
      policy,
      securityState: baseSecurityState(),
      surface: testSurface(),
      principal: AGENT_PRINCIPAL,
      approverRef: "user:alice",
      requestId: "req-recon",
      signingRequestId: "sign-recon",
      at: NOW,
      expiresAt: NOW + 30_000,
    });
    transport.goUnreachable();
    const unknown = await adapter.broadcast({
      handoff: feed.signingRequest,
      signedPayload: "0xSIGNED",
      at: NOW + 10,
      executionRef: "exec-recon",
    });
    const plan = adapter.reconciliationPlan({ observation: unknown });
    expect(plan.blindRetryForbidden).toBe(true);
    expect(plan.resolver).toBe("SETTLEMENT_RECONCILIATION_AUTHORITY");
    expect(plan.reasons.length).toBeGreaterThan(0);
    expect(plan.externalChecks.length).toBeGreaterThan(0);
    // The cross-check providers are the adapter's independent endpoints.
    const providers = plan.externalChecks[0]?.providerNames ?? [];
    expect(new Set(providers).size).toBe(providers.length);
  });
});
