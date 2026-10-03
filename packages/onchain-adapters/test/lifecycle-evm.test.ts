import { describe, expect, it } from "vitest";
import { TestnetNeverProductionError } from "../src/errors.js";
import { adapterSettlementEnvelope, mapAdapterObservationToRailOperation } from "../src/settlement-gate.js";
import { settlementAttemptEventCandidate } from "@payswap/onchain-domain";
import {
  AGENT_PRINCIPAL,
  CHAIN,
  ETHEREUM_ASSET_ID,
  MERCHANT,
  NOW,
  NOW_ISO,
  PAYER,
  baseSecurityState,
  connectedChainInstance,
  evmHead,
  evmPolicy,
  evmTransferDirective,
  testSurface,
} from "./helpers.js";
import {
  EVM_HEAD_HEIGHT,
  EVM_RECEIPT_BLOCK_NUMBER,
  EVM_TX_HASH,
  evmAdapter,
  evmAdapterWithTransport,
  evmRouteHash,
  scriptedEvmTransport,
} from "./adapter-fixture.js";

/**
 * The EVM family adapter lifecycle: the FULL nine-stage golden path against
 * the REAL security kernel (gates → diff → authorization → recheck →
 * handoff), then the canonical settlement mapping behind the production
 * environment gate.
 */
describe("EVM golden lifecycle (all nine stages)", () => {
  const directive = evmTransferDirective();
  const instance = connectedChainInstance(CHAIN, "EVM");
  const policy = evmPolicy({
    allowedChains: [CHAIN],
    allowedAssets: [{ chain: CHAIN, assetId: ETHEREUM_ASSET_ID, symbol: "ETH" }],
    allowedDestinations: [MERCHANT],
    knownRoutes: [evmRouteHash(directive)],
  });

  it("observe → prepare → simulate → authorize → broadcast → observe → finality → reconcile → evidence", async () => {
    const adapter = evmAdapter();

    // 1. observe — a chain-head observation with environment + provenance.
    const headProbe = await adapter.observeChainHead({ at: NOW_ISO });
    expect(headProbe.kind).toBe("HEAD_OBSERVED");
    if (headProbe.kind !== "HEAD_OBSERVED") throw new Error("unreachable");
    const head = headProbe.head;
    expect(head.chainKey).toBe(CHAIN);
    expect(head.environmentClass).toBe("PRODUCTION");
    expect(head.height).toBe(EVM_HEAD_HEIGHT);
    expect(head.provenance.adapterId).toBe("adapter:evm:test");

    // 2. prepare — chain-id cross-check, nonce, explicit 1559 fee semantics.
    const prepared = await adapter.prepare({
      directive,
      instance,
      signerAccountRef: PAYER,
      head,
      at: NOW,
      requestedBy: "agent:agent-key-1",
    });
    expect(prepared.familyPlan.observedChainId).toBe("1");
    expect(prepared.familyPlan.nonce).toBe("7");
    expect(prepared.familyPlan.to).toBe(MERCHANT);
    expect(prepared.familyPlan.value).toBe("0x" + BigInt("1000000").toString(16));
    if (prepared.familyPlan.fee.expressible !== false) {
      expect(prepared.familyPlan.fee.feeModel).toBe("GAS_AUCTION");
      expect(prepared.familyPlan.fee.baseFeePerGasMinorUnits).toBe("100000000");
      expect(prepared.familyPlan.fee.eip1559).toBe(true);
    } else {
      throw new Error("the scripted block carries baseFeePerGas — fee must be expressible");
    }

    // 3. simulate — an OBSERVATION through the kernel's recordSimulation.
    const simulation = await adapter.simulate({ prepared, at: NOW });
    expect(simulation.status).toBe("SUCCEEDED");
    expect(simulation.gasEstimate).toBe("21000");
    expect(simulation.balanceDeltas.length).toBe(2);

    // 4. authorize — drives the REAL kernel to BROADCAST_HANDOFF.
    const feed = adapter.authorize({
      prepared,
      policy,
      securityState: baseSecurityState(),
      surface: testSurface(),
      principal: AGENT_PRINCIPAL,
      approverRef: "user:alice",
      requestId: "req-1",
      signingRequestId: "sign-1",
      at: NOW,
      expiresAt: NOW + 30_000,
    });
    expect(feed.pipelineState).toBe("BROADCAST_HANDOFF");
    expect(feed.signingRequest.signerAddress).toBe(PAYER);
    // EVM signing semantics are REAL EIP-712 typed data (via the kernel's own adapter).
    expect(feed.signingRequest.payload).toContain("PaySwapOnchainAuthorization");
    expect(feed.authorizationRef).toBe(feed.signingRequest.authorizationRef);

    // 5. broadcast — submitted ≠ finality (rule 29).
    const broadcastObservation = await adapter.broadcast({
      handoff: feed.signingRequest,
      signedPayload: "0xSIGNEDRAWTX",
      at: NOW + 10,
      executionRef: "exec-1",
    });
    expect(broadcastObservation.outcome).toBe("BROADCAST");
    expect(broadcastObservation.externalOperationRef).toBe(EVM_TX_HASH);
    expect(broadcastObservation.finalityCandidate).toBeUndefined();
    expect(broadcastObservation.failure).toBeUndefined();

    // 6. observe (result) — CONFIRMED with a finality CANDIDATE.
    const observed = await adapter.observeOperation({
      executionRef: "exec-1",
      externalOperationRef: EVM_TX_HASH,
      at: NOW + 30,
    });
    expect(observed.outcome).toBe("CONFIRMED");
    expect(observed.finalityCandidate?.candidateOnly).toBe(true);
    expect(observed.finalityCandidate?.requiresProtocolFinality).toBe(true);
    expect(observed.finalityCandidate?.confirmationDepth).toBe(EVM_HEAD_HEIGHT - EVM_RECEIPT_BLOCK_NUMBER + 1);
    expect(observed.finalityCandidate?.reorgDetected).toBe(false);

    // 7. finality — depth against the declared guidance, protocol-owned.
    const laterHead = evmHead({ height: EVM_HEAD_HEIGHT + 5 });
    const evaluation = adapter.evaluateFinality({ observation: observed, head: laterHead });
    expect(evaluation.observedDepth).toBe(EVM_HEAD_HEIGHT + 5 - EVM_RECEIPT_BLOCK_NUMBER + 1);
    expect(evaluation.declaredTarget).toBe(12);
    expect(evaluation.depthSufficient).toBe(true);
    expect(evaluation.candidate.candidateOnly).toBe(true);
    expect(evaluation.reorgDetected).toBe(false);

    // 8. reconcile — only for OUTCOME_UNKNOWN (never failure conversion).
    expect(() =>
      adapter.reconciliationPlan({ observation: observed }),
    ).toThrow(/only constructed for OUTCOME_UNKNOWN/);

    // 9. evidence — the append-only log records every stage.
    const stages = adapter.evidence("exec-1").map((entry) => entry.stage);
    expect(stages).toContain("broadcast");
    expect(stages).toContain("observeResult");
    const allStages = new Set(adapter.evidence().map((entry) => entry.stage));
    for (const stage of ["observe", "prepare", "simulate", "authorize", "broadcast", "observeResult"] as const) {
      expect(allStages.has(stage), `stage ${stage} must be evidenced`).toBe(true);
    }
  });

  it("the settlement gate maps observations into the CANONICAL vocabulary (production only)", async () => {
    const adapter = evmAdapter();
    const prepared = await adapter.prepare({
      directive,
      instance,
      signerAccountRef: PAYER,
      head: evmHead(),
      at: NOW,
      requestedBy: "agent:agent-key-1",
    });
    const feed = adapter.authorize({
      prepared,
      policy,
      securityState: baseSecurityState(),
      surface: testSurface(),
      principal: AGENT_PRINCIPAL,
      approverRef: "user:alice",
      requestId: "req-2",
      signingRequestId: "sign-2",
      at: NOW,
      expiresAt: NOW + 30_000,
    });
    const observation = await adapter.broadcast({
      handoff: feed.signingRequest,
      signedPayload: "0xSIGNEDRAWTX",
      at: NOW + 10,
      executionRef: "exec-2",
    });

    // The production envelope is constructible only from a production chain.
    const envelope = adapterSettlementEnvelope({
      adapterId: adapter.adapterId,
      chainKey: adapter.chainKey,
      environmentClass: adapter.environment.environmentClass,
    });
    const mapping = mapAdapterObservationToRailOperation({
      envelope,
      observation,
      settlementInstructionId: "si-001",
      settlementAttemptId: "sa-001",
    });
    // The canonical onchain-domain mapping vocabulary (NO parallel ledger).
    expect(mapping.mappingKind).toBe("OBSERVATION_TO_RAIL_OPERATION");
    expect(mapping.railId).toBe("onchain.ethereum:mainnet");
    expect(mapping.outcome.kind).toBe("RAIL_EFFECT_PENDING");
    // The canonical settlement-attempt event candidate is a REAL event of the
    // canonical machine (BROADCAST → NO event: submitted is not finality).
    expect(settlementAttemptEventCandidate(observation)).toEqual({
      kind: "NO_EVENT",
      reason: "SUBMITTED_NOT_FINAL",
    });
  });

  it("a chainKey/environment mismatch fails the settlement envelope (chain confusion)", () => {
    expect(() =>
      adapterSettlementEnvelope({
        adapterId: "adapter:evm:test",
        chainKey: "ethereum:mainnet",
        environmentClass: "TESTNET",
      }),
    ).toThrow(TestnetNeverProductionError);
  });
});

describe("EVM broadcast rejection classification (deterministic table)", () => {
  const directive = evmTransferDirective();
  const instance = connectedChainInstance(CHAIN, "EVM");
  const policy = evmPolicy({
    allowedChains: [CHAIN],
    allowedAssets: [{ chain: CHAIN, assetId: ETHEREUM_ASSET_ID, symbol: "ETH" }],
    allowedDestinations: [MERCHANT],
    knownRoutes: [evmRouteHash(directive)],
  });

  async function handoffFor(adapter: ReturnType<typeof evmAdapter>) {
    const prepared = await adapter.prepare({
      directive,
      instance,
      signerAccountRef: PAYER,
      head: evmHead(),
      at: NOW,
      requestedBy: "agent:agent-key-1",
    });
    return adapter.authorize({
      prepared,
      policy,
      securityState: baseSecurityState(),
      surface: testSurface(),
      principal: AGENT_PRINCIPAL,
      approverRef: "user:alice",
      requestId: "req-x",
      signingRequestId: "sign-x",
      at: NOW,
      expiresAt: NOW + 30_000,
    });
  }

  it("a definitive pre-chain rejection classifies as FAILED with an explicit failure class", async () => {
    const adapter = evmAdapterWithTransport(
      scriptedEvmTransport({
        responses: {
          eth_sendRawTransaction: () => ({ scriptedError: "insufficient funds for gas * price + value" }),
        },
      }),
    );
    const feed = await handoffFor(adapter);
    const observation = await adapter.broadcast({
      handoff: feed.signingRequest,
      signedPayload: "0xSIGNEDRAWTX",
      at: NOW + 10,
      executionRef: "exec-fee",
    });
    expect(observation.outcome).toBe("FAILED");
    expect(observation.failure?.failureClass).toBe("INSUFFICIENT_FUNDS");
    expect(observation.failure?.retryGuidance).toBe("SAFE_TO_RETRY");
  });

  it("an already-known transaction classifies as BROADCAST (in flight)", async () => {
    const adapter = evmAdapterWithTransport(
      scriptedEvmTransport({
        responses: {
          eth_sendRawTransaction: () => ({ scriptedError: "already known" }),
        },
      }),
    );
    const feed = await handoffFor(adapter);
    const observation = await adapter.broadcast({
      handoff: feed.signingRequest,
      signedPayload: "0xSIGNEDRAWTX",
      at: NOW + 10,
      executionRef: "exec-known",
    });
    expect(observation.outcome).toBe("BROADCAST");
  });

  it("an unclassified node response after submission is OUTCOME_UNKNOWN (INV-X01)", async () => {
    const adapter = evmAdapterWithTransport(
      scriptedEvmTransport({
        responses: {
          eth_sendRawTransaction: () => ({ scriptedError: "weird unclassified node condition" }),
        },
      }),
    );
    const feed = await handoffFor(adapter);
    const observation = await adapter.broadcast({
      handoff: feed.signingRequest,
      signedPayload: "0xSIGNEDRAWTX",
      at: NOW + 10,
      executionRef: "exec-unknown",
    });
    expect(observation.outcome).toBe("OUTCOME_UNKNOWN");
    expect(observation.unknownReason).toMatch(/unknown whether the operation reached the chain/);
    expect(observation.failure).toBeUndefined();
  });

  it("the EVM family does not authorize unsupported operations (fail closed)", async () => {
    const adapter = evmAdapter();
    await expect(
      adapter.prepare({
        directive: evmTransferDirective({
          operation: "onchain.bridge",
          protocolRef: "bridge-example",
        }),
        instance,
        signerAccountRef: PAYER,
        head: evmHead(),
        at: NOW,
        requestedBy: "agent:agent-key-1",
      }),
    ).rejects.toThrow(/does not declare support for operation 'onchain.bridge'/);
  });

  it("a chain-identity mismatch (endpoint chain id) fails prepare closed", async () => {
    const adapter = evmAdapterWithTransport(scriptedEvmTransport({ chainId: "0x2" }));
    await expect(
      adapter.prepare({
        directive,
        instance,
        signerAccountRef: PAYER,
        head: evmHead(),
        at: NOW,
        requestedBy: "agent:agent-key-1",
      }),
    ).rejects.toThrow(/chain confusion fails closed/);
  });
});
