import { describe, expect, it } from "vitest";
import { classifyOutcome } from "@payswap/adapters";
import { validateExternalFundsPositionObservation } from "@payswap/connectors";
import { reconcileExternalFundsObservation } from "@payswap/settlement";
import {
  SettlementAttemptLedger,
  SettlementReconciliationAuthority,
  asSettlementAttemptId,
} from "@payswap/settlement";
import { asSettlementInstructionId } from "@payswap/protocol";
import { RailTransportError } from "../src/support.js";
import {
  EthereumJsonRpcRail,
  EthereumRailClient,
  DEFAULT_FINALITY_CANDIDATE_CONFIRMATIONS,
  ethereumTransactionEnvelope,
} from "../src/crypto.js";
import {
  CLOCK,
  ScriptedJsonRpcTransport,
  BLOCK_HASH_A,
  BLOCK_HASH_B,
  TX_HASH,
  VITALIK_ADDRESS,
  ctx,
  hex,
  makeAdapterAuthority,
  rpcNull,
  rpcResult,
} from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();
const HEAD = 20_000n;
const TX_BLOCK = 19_990n;

function minedTx(blockHash: string) {
  return {
    hash: TX_HASH,
    blockNumber: hex(TX_BLOCK),
    blockHash,
    from: "0x0000000000000000000000000000000000000001",
    to: "0x0000000000000000000000000000000000000002",
    value: hex(1_000_000_000_000_000_000n),
  };
}

function receipt(status: "0x1" | "0x0") {
  return { transactionHash: TX_HASH, blockHash: BLOCK_HASH_A, status };
}

/** A router for the observeTransaction call sequence. */
function txRouter(options: {
  readonly tx: unknown;
  readonly receipt?: unknown;
  readonly head?: bigint;
}): (method: string, params: readonly unknown[]) => ReturnType<typeof rpcResult> {
  return (method) => {
    switch (method) {
      case "eth_blockNumber":
        return rpcResult(1, hex(options.head ?? HEAD));
      case "eth_getTransactionByHash":
        return rpcResult(2, options.tx);
      case "eth_getTransactionReceipt":
        return rpcResult(3, options.receipt ?? null);
      default:
        return rpcNull(99);
    }
  };
}

describe("crypto rail — transaction observation (INV-X01, INV-C06)", () => {
  it("classifies a NOT-SEEN transaction as async (NEVER FAILED)", async () => {
    const scripted = new ScriptedJsonRpcTransport(txRouter({ tx: null }));
    const client = new EthereumRailClient({ clock: CLOCK, transport: scripted.transport });
    const observation = await client.observeTransaction(TX_HASH);
    expect(observation.status).toBe("NOT_SEEN");
    expect(observation.finalityCandidate).toBe(false);
    const result = await client.read(ctx(AUTHORITY, { kind: "transaction", txHash: TX_HASH }));
    expect(result.outcome).toEqual({ outcome: "ASYNC_PROCESSING" });
  });

  it("classifies a mempool transaction as async processing (NEVER FAILED)", async () => {
    const scripted = new ScriptedJsonRpcTransport(
      txRouter({ tx: { ...minedTx(BLOCK_HASH_A), blockNumber: null, blockHash: null } }),
    );
    const client = new EthereumRailClient({ clock: CLOCK, transport: scripted.transport });
    const observation = await client.observeTransaction(TX_HASH);
    expect(observation.status).toBe("PENDING");
    const result = await client.read(ctx(AUTHORITY, { kind: "transaction", txHash: TX_HASH }));
    expect(result.outcome).toEqual({ outcome: "ASYNC_PROCESSING" });
  });

  it("counts confirmations and produces a finality CANDIDATE only at the threshold", async () => {
    const scripted = new ScriptedJsonRpcTransport(
      txRouter({ tx: minedTx(BLOCK_HASH_A), receipt: receipt("0x1") }),
    );
    const client = new EthereumRailClient({ clock: CLOCK, transport: scripted.transport });
    const observation = await client.observeTransaction(TX_HASH);
    // confirmations = HEAD - TX_BLOCK + 1 = 11 < default threshold 12.
    expect(observation.confirmations).toBe(HEAD - TX_BLOCK + 1n);
    expect(observation.finalityCandidate).toBe(false);
    expect(observation.status).toBe("MINED_SUCCESS");
    // The envelope is NOT terminal below the threshold: still waiting.
    const result = await client.read(ctx(AUTHORITY, { kind: "transaction", txHash: TX_HASH }));
    expect(result.outcome).toEqual({ outcome: "ASYNC_PROCESSING" });

    // At the threshold (12 confirmations) it becomes a finality candidate.
    const threshold = DEFAULT_FINALITY_CANDIDATE_CONFIRMATIONS;
    const deepHead = TX_BLOCK + threshold - 1n;
    const deepScripted = new ScriptedJsonRpcTransport(
      txRouter({ tx: minedTx(BLOCK_HASH_A), receipt: receipt("0x1"), head: deepHead }),
    );
    const deepClient = new EthereumRailClient({ clock: CLOCK, transport: deepScripted.transport });
    const deepObservation = await deepClient.observeTransaction(TX_HASH);
    expect(deepObservation.confirmations).toBe(threshold);
    expect(deepObservation.finalityCandidate).toBe(true);
    const deepResult = await deepClient.read(ctx(AUTHORITY, { kind: "transaction", txHash: TX_HASH }));
    expect(deepResult.outcome).toEqual({ outcome: "SUCCEEDED" });
    // Raw RPC objects are preserved VERBATIM in the envelope state (INV-C06).
    expect(deepResult.providerState.state).toMatchObject({
      status: "MINED_SUCCESS",
      blockHash: BLOCK_HASH_A,
      confirmations: threshold.toString(),
    });
  });

  it("classifies an on-chain revert as a DEFINITIVE failure (ambiguity NONE)", async () => {
    const scripted = new ScriptedJsonRpcTransport(
      txRouter({ tx: minedTx(BLOCK_HASH_A), receipt: receipt("0x0") }),
    );
    const client = new EthereumRailClient({ clock: CLOCK, transport: scripted.transport });
    const result = await client.read(ctx(AUTHORITY, { kind: "transaction", txHash: TX_HASH }));
    expect(result.outcome).toEqual({ outcome: "FAILED", retryable: false });
    expect(result.providerState.failure?.ambiguity).toBe("NONE");
  });

  it("maps a DETECTED REORG to OUTCOME_UNKNOWN pending reconciliation — NEVER FAILED (INV-X01)", async () => {
    let call = 0;
    const scripted = new ScriptedJsonRpcTransport((method) => {
      if (method === "eth_getTransactionByHash") {
        call += 1;
        // First observation: included in block A; second: same height, hash B.
        return rpcResult(2, call === 1 ? minedTx(BLOCK_HASH_A) : minedTx(BLOCK_HASH_B));
      }
      if (method === "eth_blockNumber") return rpcResult(1, hex(HEAD));
      return rpcResult(3, receipt("0x1"));
    });
    const client = new EthereumRailClient({ clock: CLOCK, transport: scripted.transport });
    const first = await client.observeTransaction(TX_HASH);
    expect(first.status).toBe("MINED_SUCCESS");
    // The SECOND observation (the read surface) detects the reorg: the
    // previously observed inclusion is no longer reliable → UNKNOWN.
    const result = await client.read(ctx(AUTHORITY, { kind: "transaction", txHash: TX_HASH }));
    expect(result.outcome).toEqual({ outcome: "OUTCOME_UNKNOWN", requiresReconciliation: true });
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
    // The canonical classifier is consumed — UNKNOWN is never FAILED here.
    expect(classifyOutcome(result.providerState).outcome).toBe("OUTCOME_UNKNOWN");
    // The reorg evidence is carried in the observation metadata (INV-C06).
    expect(result.providerState.state).toMatchObject({
      status: "REORG_UNKNOWN",
      reorgDetected: true,
    });
  });

  it("maps a DISAPPEARED inclusion to OUTCOME_UNKNOWN (double-spend possible)", async () => {
    let call = 0;
    const scripted = new ScriptedJsonRpcTransport((method) => {
      if (method === "eth_getTransactionByHash") {
        call += 1;
        return call === 1 ? rpcResult(2, minedTx(BLOCK_HASH_A)) : rpcResult(2, null);
      }
      if (method === "eth_blockNumber") return rpcResult(1, hex(HEAD));
      return rpcResult(3, receipt("0x1"));
    });
    const client = new EthereumRailClient({ clock: CLOCK, transport: scripted.transport });
    await client.observeTransaction(TX_HASH);
    const second = await client.observeTransaction(TX_HASH);
    expect(second.status).toBe("REORG_UNKNOWN");
    expect(second.reorgDetected).toBe(true);
  });

  it("maps an inconsistent node view (tx mined, receipt missing) to OUTCOME_UNKNOWN", async () => {
    const scripted = new ScriptedJsonRpcTransport(
      txRouter({ tx: minedTx(BLOCK_HASH_A), receipt: null }),
    );
    const client = new EthereumRailClient({ clock: CLOCK, transport: scripted.transport });
    const observation = await client.observeTransaction(TX_HASH);
    expect(observation.status).toBe("REORG_UNKNOWN");
  });

  it("exposes the consumed vocabulary through the RailAdapter framework", () => {
    const rail = new EthereumJsonRpcRail();
    expect(rail.sourceOfTruthPolicy("transaction")).toBe("EXTERNAL_AUTHORITATIVE");
    expect(rail.authorizationRequirements("cap.rails.ethereum.observe").protocolAuthorization).toBe(true);
    expect(() => ethereumTransactionEnvelope).toBeDefined();
  });
});

describe("crypto rail — external funds observation (INV-C09)", () => {
  it("observes a balance as an ExternalFundsPositionObservation with freshness + provenance, never custody", async () => {
    const blockTimestampSeconds = 1_765_000_000n;
    const scripted = new ScriptedJsonRpcTransport((method) => {
      if (method === "eth_getBalance") return rpcResult(1, hex(1_234_567_890_123_456_789n));
      if (method === "eth_getBlockByNumber") {
        return rpcResult(2, { number: hex(HEAD), timestamp: hex(blockTimestampSeconds) });
      }
      return rpcNull(99);
    });
    const client = new EthereumRailClient({ clock: CLOCK, transport: scripted.transport });
    const observation = await client.observeExternalFundsPosition(VITALIK_ADDRESS);
    // Canonical validation passes — mandatory freshness + provenance.
    expect(() => validateExternalFundsPositionObservation(observation)).not.toThrow();
    expect(observation.observedAmount.minorUnits).toBe("1234567890123456789");
    expect(observation.observedAmount.currency).toBe("ETH");
    expect(observation.location.providerName).toBe("ethereum-mainnet");
    expect(observation.location.accountRef).toBe(VITALIK_ADDRESS);
    expect(observation.freshness.maxAgeSeconds).toBe(180);
    expect(observation.provenance.source).toBe("PROVIDER_API");

    // The settlement-plane reconciler treats it as an observation only —
    // the result is structurally NOT a custody booking (custodyBooking NONE).
    const reconciled = reconcileExternalFundsObservation({
      observation,
      expectedMinorUnits: "1234567890123456789",
      referenceTime: new Date(Number(blockTimestampSeconds) * 1000).toISOString(),
    });
    expect(reconciled.outcome).toBe("MATCHED");
    expect(reconciled.custodyBooking).toBe("NONE");

    // A stale observation can never reconcile (never a false balance).
    const stale = reconcileExternalFundsObservation({
      observation,
      expectedMinorUnits: "1234567890123456789",
      referenceTime: new Date((Number(blockTimestampSeconds) + 10_000) * 1000).toISOString(),
    });
    expect(stale.outcome).toBe("STALE_NOT_USABLE");
    expect(stale.custodyBooking).toBe("NONE");
  });

  it("reports a discrepancy as a discrepancy — never a balance correction", async () => {
    const scripted = new ScriptedJsonRpcTransport((method) => {
      if (method === "eth_getBalance") return rpcResult(1, hex(42n));
      if (method === "eth_getBlockByNumber") {
        return rpcResult(2, { number: hex(HEAD), timestamp: hex(1_765_000_000n) });
      }
      return rpcNull(99);
    });
    const client = new EthereumRailClient({ clock: CLOCK, transport: scripted.transport });
    const observation = await client.observeExternalFundsPosition(VITALIK_ADDRESS);
    const reconciled = reconcileExternalFundsObservation({
      observation,
      expectedMinorUnits: "43",
      referenceTime: new Date(1_765_000_000_000).toISOString(),
    });
    expect(reconciled.outcome).toBe("DISCREPANCY");
    expect(reconciled.custodyBooking).toBe("NONE");
  });
});

describe("crypto rail — unreachable provider: no settlement effect, UNKNOWN recorded", () => {
  it("fails at the transport and records NO fabricated outcome (INV-C01/C02, INV-X03)", async () => {
    const scripted = new ScriptedJsonRpcTransport(() => {
      throw new Error("endpoint unreachable");
    });
    const client = new EthereumRailClient({ clock: CLOCK, transport: scripted.transport });
    // Availability is UNKNOWN (never success/failure).
    const observation = await client.availabilityObservation({
      instanceId: "inst-rails-eth-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(client.railImplication(observation.availability).routable).toBe(false);

    // Health is UNKNOWN — never a business outcome.
    const health = await client.health();
    expect(health.status).toBe("UNKNOWN");

    // A read fails at the transport — the rail never fabricates a state.
    await expect(
      client.read(ctx(AUTHORITY, { kind: "transaction", txHash: TX_HASH })),
    ).rejects.toBeInstanceOf(RailTransportError);

    // The settlement plane records OUTCOME_UNKNOWN — no settlement effect:
    // the attempt stays ambiguous and ONLY reconciliation may resolve it.
    const ledger = new SettlementAttemptLedger();
    const authority = new SettlementReconciliationAuthority(ledger);
    const attemptId = asSettlementAttemptId("settle-att-1");
    const instructionId = asSettlementInstructionId("settle-instr-1");
    const now = CLOCK.now();
    ledger.begin({
      attemptId,
      instructionId,
      rail: "rail.crypto.ethereum_json_rpc",
      idempotencyKey: "idem-settle-1",
      principal: { principalType: "user", principalId: "user_1" },
      now,
    });
    ledger.start(attemptId, now);
    // The ambiguity observation itself is evidence (INV-E02).
    ledger.recordExternalOutcome(attemptId, "OUTCOME_UNKNOWN", ["ev-ambiguity-1"], now);
    const attempt = ledger.attempt(attemptId);
    expect(attempt?.state).toBe("OUTCOME_UNKNOWN");
    expect(attempt?.state).not.toBe("SUCCEEDED");
    expect(attempt?.state).not.toBe("FAILED");
    // A reconciliation case opens for the ambiguity (INV-X03) and stays OPEN.
    const openedCase = authority.openCase({
      caseId: "case-eth-1",
      subject: { kind: "SETTLEMENT_ATTEMPT", attemptId },
      reason: "PROVIDER_OUTAGE_UNKNOWN_EFFECT",
      now,
    });
    expect(openedCase.status).toBe("OPEN");
    expect(authority.case("case-eth-1")?.status).toBe("OPEN");
  });
});

describe("crypto rail — health and chain validation", () => {
  it("is HEALTHY on the expected chain and DEGRADED on a chain-id mismatch", async () => {
    const good = new EthereumRailClient({
      clock: CLOCK,
      transport: new ScriptedJsonRpcTransport((method) => {
        expect(method).toBe("eth_chainId");
        return rpcResult(1, "0x1");
      }).transport,
    });
    expect((await good.health()).status).toBe("HEALTHY");

    const wrongChain = new EthereumRailClient({
      clock: CLOCK,
      transport: new ScriptedJsonRpcTransport(() => rpcResult(1, "0x89")).transport,
    });
    const report = await wrongChain.health();
    expect(report.status).toBe("DEGRADED");
    expect(report.degradedReasons[0]).toContain("wrong network");
  });
});
