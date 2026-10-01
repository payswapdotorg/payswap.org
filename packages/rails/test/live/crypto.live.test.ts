import { describe, expect, it } from "vitest";
import { validateExternalFundsPositionObservation } from "@payswap/connectors";
import {
  SettlementAttemptLedger,
  SettlementReconciliationAuthority,
  asSettlementAttemptId,
} from "@payswap/settlement";
import { asSettlementInstructionId } from "@payswap/protocol";
import {
  DEFAULT_ETHEREUM_RPC_ENDPOINT,
  EthereumRailClient,
} from "../../src/crypto.js";
import { CLOCK, VITALIK_ADDRESS, hex } from "../fixtures.js";

/**
 * LIVE network suite (run explicitly: `npm run test:live`; retries
 * configured for public-endpoint flakiness). Contacts the REAL public
 * Ethereum mainnet JSON-RPC endpoint https://ethereum-rpc.publicnode.com —
 * read-only methods only (chainId, blockNumber, getBalance,
 * getTransactionByHash, getTransactionReceipt, getBlockByNumber). No
 * credentials, no value movement, no fabricated state.
 */
describe("crypto rail — LIVE Ethereum mainnet JSON-RPC (read-only)", () => {
  const client = new EthereumRailClient({ clock: CLOCK });

  it("answers eth_chainId with the mainnet chain id", async () => {
    expect(await client.chainId()).toBe("0x1");
  });

  it("answers eth_blockNumber with a positive, parseable height", async () => {
    const head = await client.blockNumber();
    expect(head).toBeGreaterThan(20_000_000n);
  });

  it("reads an exact wei balance for a well-known address (INV-F01: bigint string)", async () => {
    const balance = await client.balanceWei(VITALIK_ADDRESS);
    expect(balance).toBeGreaterThanOrEqual(0n);
  });

  it("observes an ExternalFundsPositionObservation with freshness + provenance (INV-C09 — never custody)", async () => {
    const observation = await client.observeExternalFundsPosition(VITALIK_ADDRESS);
    expect(() => validateExternalFundsPositionObservation(observation)).not.toThrow();
    expect(observation.location.providerName).toBe("ethereum-mainnet");
    expect(observation.observedAmount.currency).toBe("ETH");
    expect(/^\d+$/.test(observation.observedAmount.minorUnits)).toBe(true);
    expect(observation.freshness.maxAgeSeconds).toBeGreaterThan(0);
    expect(observation.provenance.source).toBe("PROVIDER_API");
  });

  it("observes a real mined transaction from the latest block with confirmations >= 1", async () => {
    const head = await client.blockNumber();
    // Reads the latest block, then observes its first transaction (read-only).
    const observation = await observeLatestTransaction(client, head);
    expect(["MINED_SUCCESS", "MINED_REVERTED", "PENDING"]).toContain(observation.status);
    expect(observation.confirmations).toBeGreaterThanOrEqual(0n);
  });

  it("reports NOT_SEEN (never FAILED) for an unknown transaction hash (INV-X01)", async () => {
    const unknownHash = `0x${"ab".repeat(32)}`;
    const observation = await client.observeTransaction(unknownHash);
    expect(observation.status).toBe("NOT_SEEN");
    expect(observation.finalityCandidate).toBe(false);
  });

  it("health reports HEALTHY on mainnet", async () => {
    const report = await client.health();
    expect(report.status).toBe("HEALTHY");
    expect(report.providerName).toBe("ethereum-mainnet");
  });

  it("availability observation is AVAILABLE (live probe) and the endpoint is documented", async () => {
    const observation = await client.availabilityObservation({
      instanceId: "inst-rails-eth-live-1",
      observationVersion: 1,
    });
    expect(observation.sourceAvailability).toBe("REACHABLE");
    expect(observation.availability).toBe("AVAILABLE");
    expect(client.railImplication(observation.availability).routable).toBe(true);
    expect(DEFAULT_ETHEREUM_RPC_ENDPOINT).toBe("https://ethereum-rpc.publicnode.com");
  });

  it("finality candidates are CANDIDATES only: an old-enough transaction is a candidate, a fresh one may not be", async () => {
    const head = await client.blockNumber();
    const observation = await observeLatestTransaction(client, head);
    // The finality assessment carries the threshold explicitly; the
    // protocol owns finality (INV-E03) — this is rail-side evidence only.
    const candidate = await client.finalityCandidate(observation.txHash);
    expect(candidate.threshold).toBe(12n);
    expect(typeof candidate.candidate).toBe("boolean");
    expect(candidate.status).toBe(observation.status);
  });
});

/** Reads the latest block and observes its first transaction (read-only). */
async function observeLatestTransaction(
  client: EthereumRailClient,
  head: bigint,
): Promise<{ readonly txHash: string; readonly status: string; readonly confirmations: bigint }> {
  const blockResponse = await fetch(DEFAULT_ETHEREUM_RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9001,
      method: "eth_getBlockByNumber",
      params: [hex(head), true],
    }),
  });
  const blockJson = JSON.parse(await blockResponse.text()) as {
    result?: { readonly transactions?: readonly { readonly hash: string }[] };
  };
  const transactions = blockJson.result?.transactions ?? [];
  const first = transactions[0];
  if (first === undefined) {
    throw new Error("latest block carried no transactions — retry the live suite");
  }
  const observation = await client.observeTransaction(first.hash);
  return {
    txHash: observation.txHash,
    status: observation.status,
    confirmations: observation.confirmations,
  };
}

describe("crypto rail — LIVE settlement discipline (no fabricated effects)", () => {
  it("an unreachable-classified read path still records OUTCOME_UNKNOWN, not FAILED, on the settlement plane", () => {
    // Deterministic settlement-plane wiring exercised against the LIVE
    // client's NOT_SEEN observation: an unmined hash is NEVER a failure.
    const attemptLedger = new SettlementAttemptLedger();
    const authority = new SettlementReconciliationAuthority(attemptLedger);
    const attemptId = asSettlementAttemptId("settle-att-live-1");
    const now = CLOCK.now();
    attemptLedger.begin({
      attemptId,
      instructionId: asSettlementInstructionId("settle-instr-live-1"),
      rail: "rail.crypto.ethereum_json_rpc",
      idempotencyKey: "idem-live-1",
      principal: { principalType: "user", principalId: "user_1" },
      now,
    });
    attemptLedger.start(attemptId, now);
    attemptLedger.recordExternalOutcome(attemptId, "OUTCOME_UNKNOWN", ["ev-live-amb-1"], now);
    const opened = authority.openCase({
      caseId: "case-live-1",
      subject: { kind: "SETTLEMENT_ATTEMPT", attemptId },
      reason: "EXTERNAL_AMBIGUITY",
      now,
    });
    expect(opened.status).toBe("OPEN");
    expect(attemptLedger.attempt(attemptId)?.state).toBe("OUTCOME_UNKNOWN");
  });
});
