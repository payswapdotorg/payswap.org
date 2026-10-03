import { describe, expect, it } from "vitest";
import { registerCurrency } from "@payswap/protocol";
import type { SmartContractExtension } from "@payswap/capabilities";
import {
  buildExpectedStateDiff,
  prepareWrite,
  recordSimulation,
} from "../src/index.js";
import type {
  OnchainWriteRequest,
  SimulatedBalanceDelta,
  SimulationObservation,
} from "../src/index.js";

/**
 * Stage contracts for prepare / simulate / diff (P4-W1-002):
 * - prepare: fail-closed structural validation of the write request, the
 *   writeDigest binding over every guard dimension, and the secret boundary;
 * - simulate: observation validation (never authority — see pipeline tests);
 * - diff: the user-readable expected-state diff, content-addressed, with
 *   simulation entries marked OBSERVED.
 *
 * Secret-shaped fixtures are assembled at RUNTIME from fragments
 * (work-order security law): no realistic secret literal appears here.
 */

registerCurrency("USC", 6);

const CHAIN = "ethereum:mainnet";
const USC_ASSET = { chain: CHAIN, assetId: "0xaaaa111111111111111111111111111111111111", symbol: "USC" };
const PAYER = "0x1111111111111111111111111111111111111111";
const MERCHANT = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x3333333333333333333333333333333333333333";
const NOW = 1_000_000;
const ROUTE_HASH = "fnv1a64:0000000000000001";

function contractExtension(): SmartContractExtension {
  return {
    kind: "smart_contract_extension",
    chainRef: CHAIN,
    contractAddress: ROUTER,
    sourceHash: "src-hash-1",
    bytecodeHash: "byte-hash-1",
    upgradeAuthority: { kind: "MULTISIG", description: "dao multisig", delayOrTimelock: "48h timelock" },
    adminAuthority: { kind: "MULTISIG", description: "dao multisig" },
    pausePowers: [],
    oracleDependencies: [],
    custody: { custodial: false, withdrawalAuthority: "owner-only", keyManagement: "non-custodial" },
    searchableByLabAfterCertification: true,
  };
}

function baseWriteRequest(overrides?: Partial<OnchainWriteRequest>): OnchainWriteRequest {
  return {
    writeId: "write-1",
    action: "onchain.transfer",
    chain: CHAIN,
    transfer: {
      asset: USC_ASSET,
      amount: { currency: "USC", minorUnits: "1000000" },
      from: PAYER,
      to: MERCHANT,
    },
    approvals: [],
    route: { routeId: "route-1", routeHash: ROUTE_HASH },
    expiry: NOW + 60_000,
    requestedBy: "agent:agent-key-1",
    ...overrides,
  };
}

describe("prepare — fail-closed structural validation", () => {
  it("prepares, freezes and content-addresses a valid composite write", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    expect(Object.isFrozen(write)).toBe(true);
    expect(write.writeDigest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(write.preparedAt).toBe(NOW);
  });

  it("rejects an empty write (no transfer, no approvals, no call)", () => {
    const { transfer: _omit, ...rest } = baseWriteRequest();
    expect(() => prepareWrite(rest, NOW)).toThrowError(
      /must move value, change an approval, or call a contract/,
    );
  });

  it("rejects a wildcard action id", () => {
    expect(() => prepareWrite(baseWriteRequest({ action: "onchain.*" }), NOW)).toThrowError(
      /must be concrete, not a wildcard pattern/,
    );
  });

  it("rejects a transfer whose asset lives on another chain (chain confusion)", () => {
    expect(() =>
      prepareWrite(
        baseWriteRequest({
          chain: "solana:mainnet",
          transfer: {
            asset: { ...USC_ASSET, chain: "solana:mainnet" },
            amount: { currency: "USC", minorUnits: "1" },
            from: PAYER,
            to: MERCHANT,
          },
        }),
        NOW,
      ),
    ).not.toThrowError(/chain/); // same-chain restated write is fine
    expect(() =>
      prepareWrite(
        baseWriteRequest({
          transfer: {
            asset: { ...USC_ASSET, chain: "solana:mainnet" },
            amount: { currency: "USC", minorUnits: "1000000" },
            from: PAYER,
            to: MERCHANT,
          },
        }),
        NOW,
      ),
    ).toThrowError(/differs from write chain/);
  });

  it("rejects an amount currency that is not the asset symbol (cross-asset confusion)", () => {
    expect(() =>
      prepareWrite(
        baseWriteRequest({
          transfer: {
            asset: USC_ASSET,
            amount: { currency: "USC", minorUnits: "1000000" },
            from: PAYER,
            to: MERCHANT,
          },
        }),
        NOW,
      ),
    ).not.toThrowError();
    expect(() =>
      prepareWrite(
        baseWriteRequest({
          transfer: {
            asset: USC_ASSET,
            amount: { currency: "AAA", minorUnits: "1000000" },
            from: PAYER,
            to: MERCHANT,
          },
        }),
        NOW,
      ),
    ).toThrowError(/does not match asset symbol/);
  });

  it("rejects an unlimited approval that also carries an explicit amount", () => {
    expect(() =>
      prepareWrite(
        baseWriteRequest({
          approvals: [
            {
              asset: USC_ASSET,
              owner: PAYER,
              spender: ROUTER,
              amount: { currency: "USC", minorUnits: "1" },
              unlimited: true,
            },
          ],
        }),
        NOW,
      ),
    ).toThrowError(/unlimited approval must carry amount 0/);
  });

  it("rejects a protocol identity whose contract is off-chain", () => {
    expect(() =>
      prepareWrite(
        baseWriteRequest({
          protocol: {
            protocolId: "uniswap:v3",
            version: "1.0.0",
            contract: { ...contractExtension(), chainRef: "solana:mainnet" },
          },
        }),
        NOW,
      ),
    ).toThrowError(/differs from write chain/);
  });

  it("rejects a malformed chain reference", () => {
    expect(() => prepareWrite(baseWriteRequest({ chain: "not-a-chain-ref" }), NOW)).toThrowError(
      /must match '<network>:<segment>'/,
    );
  });

  it("rejects secret-shaped material in the request (rule 25, fixture assembled at runtime)", () => {
    const smuggledKey = ["priv", "ateKey"].join("");
    const request = baseWriteRequest() as OnchainWriteRequest & Record<string, unknown>;
    // nested object that survives the constructor's field copy
    (request.transfer as unknown as Record<string, unknown>)[smuggledKey] = "opaque";
    expect(() => prepareWrite(request, NOW)).toThrowError(/secret-shaped material rejected/);
  });

  it("binds every guard dimension into the writeDigest", () => {
    const base = prepareWrite(baseWriteRequest(), NOW);
    const variants: OnchainWriteRequest[] = [
      baseWriteRequest({ writeId: "write-2" }),
      baseWriteRequest({ action: "onchain.transfer" }), // control: identical
      baseWriteRequest({
        transfer: {
          asset: USC_ASSET,
          amount: { currency: "USC", minorUnits: "2000000" },
          from: PAYER,
          to: MERCHANT,
        },
      }),
      baseWriteRequest({
        transfer: {
          asset: USC_ASSET,
          amount: { currency: "USC", minorUnits: "1000000" },
          from: PAYER,
          to: "0x9999999999999999999999999999999999999999",
        },
      }),
      baseWriteRequest({ route: { routeId: "route-2", routeHash: "fnv1a64:0000000000000002" } }),
      baseWriteRequest({ nonce: "seq-7" }),
      baseWriteRequest({ expiry: NOW + 61_000 }),
    ];
    const digests = new Set<string>([base.writeDigest]);
    for (const variant of variants) {
      digests.add(prepareWrite(variant, NOW).writeDigest);
    }
    // base + 6 distinct variants (writeId, amount, destination, route, nonce,
    // expiry); the identical control collapses into base.
    expect(digests.size).toBe(7);
  });
});

describe("recordSimulation — observation validation", () => {
  function baseSimulation(
    overrides?: Partial<SimulationObservation>,
    deltas: readonly SimulatedBalanceDelta[] = [
      {
        holder: PAYER,
        asset: USC_ASSET,
        amount: { currency: "USC", minorUnits: "1000000" },
        direction: "debit",
      },
      {
        holder: MERCHANT,
        asset: USC_ASSET,
        amount: { currency: "USC", minorUnits: "1000000" },
        direction: "credit",
      },
    ],
  ): SimulationObservation {
    return {
      simulationId: "sim-1",
      writeId: "write-1",
      status: "SUCCEEDED",
      observedAt: NOW + 100,
      balanceDeltas: deltas,
      approvals: [],
      simulator: "simulator:evm-1",
      ...overrides,
    };
  }

  it("records and freezes a valid observation", () => {
    const observation = recordSimulation(baseSimulation());
    expect(Object.isFrozen(observation)).toBe(true);
    expect(observation.status).toBe("SUCCEEDED");
  });

  it("rejects a delta whose amount currency is not the asset symbol", () => {
    expect(() =>
      recordSimulation(
        baseSimulation(undefined, [
          { holder: PAYER, asset: USC_ASSET, amount: { currency: "AAA", minorUnits: "1" }, direction: "debit" },
        ]),
      ),
    ).toThrowError(/does not match asset symbol/);
  });

  it("rejects an unlimited observed allowance carrying an explicit amount", () => {
    expect(() =>
      recordSimulation(
        baseSimulation({
          approvals: [
            {
              owner: PAYER,
              spender: ROUTER,
              asset: USC_ASSET,
              allowance: { currency: "USC", minorUnits: "5" },
              unlimited: true,
            },
          ],
        }),
      ),
    ).toThrowError(/unlimited observed allowance must carry allowance 0/);
  });

  it("rejects a malformed gas estimate (exact integers only)", () => {
    expect(() => recordSimulation(baseSimulation({ gasEstimate: "1.5" }))).toThrowError(
      /gasEstimate must be an exact non-negative integer string/,
    );
  });

  it("treats a 32-byte-hex blockRef as its EXPECTED derived form (block hash), not a secret", () => {
    const blockHashShape = "cd".repeat(32); // 64 hex chars, synthetic pattern
    // blockRef is a derived-identifier field: its value shape is expected,
    // so the scan must not reject it (and never rejects the name).
    expect(() => recordSimulation(baseSimulation({ blockRef: blockHashShape }))).not.toThrowError();
  });
});

describe("buildExpectedStateDiff — the user-readable diff", () => {
  it("derives deterministic intent entries for a transfer", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const diff = buildExpectedStateDiff(write);
    expect(diff.entries.length).toBeGreaterThan(0);
    expect(diff.diffDigest).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    const debit = diff.entries.find(
      (entry) => entry.kind === "balance" && entry.direction === "debit",
    );
    expect(debit).toBeDefined();
    if (debit?.kind === "balance") {
      expect(debit.source).toBe("intent");
      expect(debit.holder).toBe(PAYER);
      expect(debit.description.length).toBeGreaterThan(0);
    }
  });

  it("derives approval entries with the exact spender and allowance", () => {
    const write = prepareWrite(
      baseWriteRequest({
        approvals: [
          {
            asset: USC_ASSET,
            owner: PAYER,
            spender: ROUTER,
            amount: { currency: "USC", minorUnits: "500000" },
            unlimited: false,
          },
        ],
      }),
      NOW,
    );
    const diff = buildExpectedStateDiff(write);
    const approvalEntry = diff.entries.find((entry) => entry.kind === "approval");
    expect(approvalEntry).toBeDefined();
    if (approvalEntry?.kind === "approval") {
      expect(approvalEntry.spender).toBe(ROUTER);
      expect(approvalEntry.owner).toBe(PAYER);
      expect(approvalEntry.after.minorUnits).toBe("500000");
      expect(approvalEntry.description).toContain(ROUTER);
    }
  });

  it("marks simulation-observed entries as OBSERVED (they inform, never authorize)", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const observation = recordSimulation({
      simulationId: "sim-1",
      writeId: "write-1",
      status: "SUCCEEDED",
      observedAt: NOW + 100,
      balanceDeltas: [
        { holder: PAYER, asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, direction: "debit" },
        { holder: MERCHANT, asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, direction: "credit" },
      ],
      approvals: [],
      simulator: "simulator:evm-1",
    });
    const diff = buildExpectedStateDiff(write, observation);
    expect(diff.entries.some((entry) => entry.source === "simulation_observed")).toBe(true);
    expect(diff.entries.some((entry) => entry.source === "intent")).toBe(true);
  });

  it("is deterministic: same inputs produce the same diff digest", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    expect(buildExpectedStateDiff(write).diffDigest).toBe(buildExpectedStateDiff(write).diffDigest);
  });
});
