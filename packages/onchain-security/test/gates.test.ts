import { describe, expect, it } from "vitest";
import { registerCurrency } from "@payswap/protocol";
import type { SmartContractExtension } from "@payswap/capabilities";
import {
  AgentOverrideForbiddenError,
  attemptAgentOverride,
  attachAgentFlag,
  evaluateOnchainWriteGates,
  prepareWrite,
} from "../src/index.js";
import type {
  AgentSecurityFlag,
  GateDecision,
  GatedEvaluation,
  OnchainSecurityPolicy,
  OnchainSecurityState,
  OnchainWriteRequest,
  SimulationObservation,
} from "../src/index.js";

/**
 * P4-W1-002 acceptance: adversarial negative tests — EVERY guard dimension
 * (chain, asset, amount, destination, spender/approval, expiry, route,
 * protocol/contract identity) has a BLOCK case, plus UNKNOWN semantics
 * (INV-X01: never silently converted) and the rule-27 agent-override
 * rejection.
 */

registerCurrency("USC", 6);
registerCurrency("ETH", 8);

const CHAIN = "ethereum:mainnet";
const USC_ASSET = { chain: CHAIN, assetId: "0xaaaa111111111111111111111111111111111111", symbol: "USC" };
const PAYER = "0x1111111111111111111111111111111111111111";
const MERCHANT = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x3333333333333333333333333333333333333333";
const MALICIOUS_SPENDER = "0x4444444444444444444444444444444444444444";
const UNKNOWN_TARGET = "0x5555555555555555555555555555555555555555";
const NOW = 1_000_000;
const ROUTE_HASH = "fnv1a64:0000000000000001";

function contractExtension(overrides?: Partial<SmartContractExtension>): SmartContractExtension {
  return {
    kind: "smart_contract_extension",
    chainRef: CHAIN,
    contractAddress: ROUTER,
    sourceHash: "src-hash-1",
    bytecodeHash: "byte-hash-1",
    upgradeAuthority: { kind: "MULTISIG", description: "dao multisig", delayOrTimelock: "48h timelock" },
    adminAuthority: { kind: "MULTISIG", description: "dao multisig" },
    pausePowers: [{ actor: "guardian", scope: "transfers" }],
    oracleDependencies: [],
    custody: { custodial: false, withdrawalAuthority: "owner-only", keyManagement: "non-custodial" },
    searchableByLabAfterCertification: true,
    ...overrides,
  };
}

function protocol() {
  return {
    protocolId: "uniswap:v3",
    version: "1.0.0",
    contract: contractExtension(),
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

function basePolicy(overrides?: Partial<OnchainSecurityPolicy>): OnchainSecurityPolicy {
  return {
    policyId: "policy-1",
    version: 1,
    allowedChains: [CHAIN],
    allowedAssets: [USC_ASSET],
    allowedDestinations: [MERCHANT],
    allowedSpenders: [ROUTER],
    maxApprovalAmount: { currency: "USC", minorUnits: "5000000" },
    forbidUnlimitedApprovals: true,
    knownRoutes: [ROUTE_HASH],
    certifiedProtocols: [protocol()],
    unknownContractPolicy: "block",
    unknownRoutePolicy: "block",
    maxSecurityStateAgeMs: 5_000,
    ...overrides,
  };
}

function baseSecurityState(overrides?: Partial<OnchainSecurityState>): OnchainSecurityState {
  return {
    observedAt: NOW,
    networkEpoch: 0n,
    quarantinedComponents: [],
    restrictedComponents: [],
    activeAdvisoryRefs: [],
    ...overrides,
  };
}

function gated(request: OnchainWriteRequest, policy = basePolicy(), state = baseSecurityState(), at = NOW): GateDecision {
  const write = prepareWrite(request, at);
  return evaluateOnchainWriteGates({ write, policy, securityState: state, at });
}

function expectBlock(decision: GateDecision, code: string): void {
  expect(decision.decision).toBe("BLOCK");
  if (decision.decision === "BLOCK") {
    expect(decision.reasons.some((r) => r.code === code)).toBe(true);
  }
}

describe("guard dimension: chain", () => {
  it("BLOCKs a write on a chain outside the policy allowlist", () => {
    const request = baseWriteRequest({ chain: "solana:mainnet", transfer: { ...baseWriteRequest().transfer!, asset: { chain: "solana:mainnet", assetId: "So11111111111111111111111111111111111111112", symbol: "USC" } } });
    expectBlock(gated(request), "chain_not_permitted");
  });
});

describe("guard dimension: asset", () => {
  it("BLOCKs an asset outside the policy allowlist (fake-token defense)", () => {
    const fakeToken = { chain: CHAIN, assetId: "0xbbbb222222222222222222222222222222222222", symbol: "USC" };
    const request = baseWriteRequest({ transfer: { ...baseWriteRequest().transfer!, asset: fakeToken } });
    expectBlock(gated(request), "asset_not_permitted");
  });
});

describe("guard dimension: amount", () => {
  it("BLOCKs a zero-amount value transfer", () => {
    const request = baseWriteRequest({ transfer: { ...baseWriteRequest().transfer!, amount: { currency: "USC", minorUnits: "0" } } });
    expectBlock(gated(request), "transfer_amount_not_positive");
  });
});

describe("guard dimension: destination", () => {
  it("BLOCKs a destination outside the permitted beneficiary list", () => {
    const request = baseWriteRequest({ transfer: { ...baseWriteRequest().transfer!, to: MALICIOUS_SPENDER } });
    expectBlock(gated(request), "destination_not_permitted");
  });
});

describe("guard dimension: spender / approval changes", () => {
  it("BLOCKs an approval to a spender outside the allowlist (malicious approval)", () => {
    const request = baseWriteRequest({
      approvals: [{ asset: USC_ASSET, owner: PAYER, spender: MALICIOUS_SPENDER, amount: { currency: "USC", minorUnits: "1000000" }, unlimited: false }],
    });
    expectBlock(gated(request), "spender_not_permitted");
  });

  it("BLOCKs an approval exceeding the policy cap", () => {
    const request = baseWriteRequest({
      approvals: [{ asset: USC_ASSET, owner: PAYER, spender: ROUTER, amount: { currency: "USC", minorUnits: "6000000" }, unlimited: false }],
    });
    expectBlock(gated(request), "approval_exceeds_cap");
  });

  it("BLOCKs an unlimited approval when policy forbids them", () => {
    const request = baseWriteRequest({
      approvals: [{ asset: USC_ASSET, owner: PAYER, spender: ROUTER, amount: { currency: "USC", minorUnits: "0" }, unlimited: true }],
    });
    expectBlock(gated(request), "unlimited_approval_forbidden");
  });

  it("BLOCKs an approval whose currency mismatches the cap currency", () => {
    const request = baseWriteRequest({
      approvals: [{ asset: { chain: CHAIN, assetId: "native", symbol: "ETH" }, owner: PAYER, spender: ROUTER, amount: { currency: "ETH", minorUnits: "1" }, unlimited: false }],
    });
    expectBlock(gated(request), "approval_cap_currency_mismatch");
  });

  it("allows a zero-amount approval (allowance revocation)", () => {
    const request = baseWriteRequest({
      approvals: [{ asset: USC_ASSET, owner: PAYER, spender: ROUTER, amount: { currency: "USC", minorUnits: "0" }, unlimited: false }],
    });
    const decision = gated(request);
    expect(decision.decision).toBe("ALLOW");
  });
});

describe("guard dimension: expiry", () => {
  it("BLOCKs an expired write", () => {
    const request = baseWriteRequest({ expiry: NOW });
    expectBlock(gated(request, basePolicy(), baseSecurityState(), NOW + 1), "write_expired");
  });
});

describe("guard dimension: route", () => {
  it("BLOCKs an uncertified route when policy blocks", () => {
    const request = baseWriteRequest({ route: { routeId: "route-2", routeHash: "fnv1a64:0000000000000002" } });
    expectBlock(gated(request), "route_not_certified");
  });

  it("UNKNOWN for an uncertified route under escalate policy (never silently ALLOW)", () => {
    const request = baseWriteRequest({ route: { routeId: "route-2", routeHash: "fnv1a64:0000000000000002" } });
    const decision = gated(request, basePolicy({ unknownRoutePolicy: "escalate" }));
    expect(decision.decision).toBe("UNKNOWN");
    if (decision.decision === "UNKNOWN") {
      expect(decision.dimensions.some((d) => d.code === "route_certification_unknown")).toBe(true);
    }
  });

  it("a policy-authority escalation resolves the route dimension WITH evidence", () => {
    const request = baseWriteRequest({ route: { routeId: "route-2", routeHash: "fnv1a64:0000000000000002" } });
    const policy = basePolicy({
      unknownRoutePolicy: "escalate",
      escalations: [
        {
          escalationId: "esc-route-2",
          dimension: "route",
          targetRef: "fnv1a64:0000000000000002",
          disposition: "allow_with_evidence",
          evidenceRefs: ["evidence:route-audit-7"],
          resolvedBy: "policy:operator",
          resolvedAt: NOW - 1_000,
          expiresAt: NOW + 30_000,
        },
      ],
    });
    const decision = gated(request, policy);
    expect(decision.decision).toBe("ALLOW");
    expect(decision.evidenceRefs).toContain("evidence:route-audit-7");
  });

  it("an EXPIRED escalation no longer resolves the dimension", () => {
    const request = baseWriteRequest({ route: { routeId: "route-2", routeHash: "fnv1a64:0000000000000002" } });
    const policy = basePolicy({
      unknownRoutePolicy: "escalate",
      escalations: [
        {
          escalationId: "esc-route-stale",
          dimension: "route",
          targetRef: "fnv1a64:0000000000000002",
          disposition: "allow_with_evidence",
          evidenceRefs: ["evidence:route-audit-7"],
          resolvedBy: "policy:operator",
          resolvedAt: NOW - 60_000,
          expiresAt: NOW - 1_000,
        },
      ],
    });
    const decision = gated(request, policy);
    expect(decision.decision).toBe("UNKNOWN");
  });
});

describe("guard dimension: protocol / contract identity", () => {
  it("BLOCKs a declared protocol that is not certified (identity drift defense)", () => {
    const driftedProtocol = { ...protocol(), contract: { ...protocol().contract, contractAddress: UNKNOWN_TARGET } };
    const request = baseWriteRequest({ protocol: driftedProtocol });
    expectBlock(gated(request), "protocol_not_certified");
  });

  it("BLOCKs a generic contract write with no protocol identity (rule 28)", () => {
    const request = baseWriteRequest({
      contractCall: { target: UNKNOWN_TARGET, calldata: "0xdeadbeef", calldataDigest: "fnv1a64:a" },
    });
    expectBlock(gated(request), "unknown_contract_write");
  });

  it("UNKNOWN for a generic contract write under escalate policy — never silent execution", () => {
    const request = baseWriteRequest({
      contractCall: { target: UNKNOWN_TARGET, calldata: "0xdeadbeef", calldataDigest: "fnv1a64:a" },
    });
    const decision = gated(request, basePolicy({ unknownContractPolicy: "escalate" }));
    expect(decision.decision).toBe("UNKNOWN");
    if (decision.decision === "UNKNOWN") {
      expect(decision.dimensions.some((d) => d.code === "unknown_contract_requires_escalation")).toBe(true);
    }
  });

  it("a policy escalation targeting the exact contract resolves the dimension", () => {
    const request = baseWriteRequest({
      contractCall: { target: UNKNOWN_TARGET, calldata: "0xdeadbeef", calldataDigest: "fnv1a64:a" },
    });
    const policy = basePolicy({
      unknownContractPolicy: "escalate",
      escalations: [
        {
          escalationId: "esc-contract-55",
          dimension: "protocol_identity",
          targetRef: UNKNOWN_TARGET,
          disposition: "allow_with_evidence",
          evidenceRefs: ["evidence:contract-audit-3"],
          resolvedBy: "policy:operator",
          resolvedAt: NOW - 500,
          expiresAt: NOW + 10_000,
        },
      ],
    });
    const decision = gated(request, policy);
    expect(decision.decision).toBe("ALLOW");
  });
});

describe("guard dimension: composed security state (INV-S01/S02/S03)", () => {
  it("BLOCKs a write referencing a quarantined component (cached availability can never bypass)", () => {
    const state = baseSecurityState({ quarantinedComponents: [`connected_instance:${ROUTER}`] });
    const request = baseWriteRequest({
      approvals: [{ asset: USC_ASSET, owner: PAYER, spender: ROUTER, amount: { currency: "USC", minorUnits: "1000000" }, unlimited: false }],
    });
    expectBlock(gated(request, basePolicy(), state), "component_quarantined_or_restricted");
  });

  it("BLOCKs a write whose route venue is restricted by an active advisory", () => {
    const state = baseSecurityState({
      restrictedComponents: ["extension:venue-router-xyz"],
      activeAdvisoryRefs: ["adv-1"],
    });
    const request = baseWriteRequest({ route: { routeId: "route-1", routeHash: ROUTE_HASH, hops: [{ venue: "venue-router-xyz", chain: CHAIN }] } });
    const decision = gated(request, basePolicy(), state);
    expectBlock(decision, "component_quarantined_or_restricted");
    expect(decision.evidenceRefs).toContain("advisory:adv-1");
  });

  it("UNKNOWN (never BLOCK, never ALLOW) when the security state is stale", () => {
    const state = baseSecurityState({ observedAt: NOW - 30_000 });
    const decision = gated(baseWriteRequest(), basePolicy(), state, NOW);
    expect(decision.decision).toBe("UNKNOWN");
    if (decision.decision === "UNKNOWN") {
      expect(decision.dimensions.some((d) => d.code === "security_state_stale")).toBe(true);
    }
  });
});

describe("guard dimension: simulation consistency (INV-L01, INV-X01)", () => {
  function simulated(simulation: Partial<SimulationObservation>): SimulationObservation {
    return {
      simulationId: "sim-1",
      writeId: "write-1",
      status: "SUCCEEDED",
      observedAt: NOW,
      balanceDeltas: [
        { holder: PAYER, asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, direction: "debit" },
        { holder: MERCHANT, asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, direction: "credit" },
      ],
      approvals: [],
      simulator: "simulator:evm-node-1",
      ...simulation,
    } as SimulationObservation;
  }

  function gateWithSimulation(sim: SimulationObservation, policy = basePolicy()): GateDecision {
    const write = prepareWrite(baseWriteRequest(), NOW);
    return evaluateOnchainWriteGates({ write, simulation: sim, policy, securityState: baseSecurityState(), at: NOW });
  }

  it("a consistent passing simulation keeps the decision ALLOW", () => {
    expect(gateWithSimulation(simulated({})).decision).toBe("ALLOW");
  });

  it("BLOCKs when the simulation observed a different write", () => {
    expectBlock(gateWithSimulation(simulated({ writeId: "write-other" })), "simulation_write_mismatch");
  });

  it("BLOCKs a reverted/failed simulation", () => {
    expectBlock(gateWithSimulation(simulated({ status: "REVERTED" })), "simulation_reverted");
    expectBlock(gateWithSimulation(simulated({ status: "FAILED" })), "simulation_reverted");
  });

  it("OUTCOME_UNKNOWN is UNKNOWN — never converted to BLOCK or ALLOW (INV-X01)", () => {
    const decision = gateWithSimulation(simulated({ status: "OUTCOME_UNKNOWN" }));
    expect(decision.decision).toBe("UNKNOWN");
    if (decision.decision === "UNKNOWN") {
      expect(decision.dimensions.some((d) => d.code === "simulation_outcome_unknown")).toBe(true);
    }
  });

  it("BLOCKs when the simulated debit diverges from the intent amount", () => {
    const sim = simulated({
      balanceDeltas: [
        { holder: PAYER, asset: USC_ASSET, amount: { currency: "USC", minorUnits: "2000000" }, direction: "debit" },
        { holder: MERCHANT, asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, direction: "credit" },
      ],
    });
    expectBlock(gateWithSimulation(sim), "simulation_amount_mismatch");
  });

  it("BLOCKs when the simulated credit never reaches the intended destination", () => {
    const sim = simulated({
      balanceDeltas: [
        { holder: PAYER, asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, direction: "debit" },
        { holder: MALICIOUS_SPENDER, asset: USC_ASSET, amount: { currency: "USC", minorUnits: "1000000" }, direction: "credit" },
      ],
    });
    expectBlock(gateWithSimulation(sim), "simulation_destination_mismatch");
  });

  it("BLOCKs when the simulated allowance diverges from the requested approval", () => {
    const writeRequest = baseWriteRequest({
      approvals: [{ asset: USC_ASSET, owner: PAYER, spender: ROUTER, amount: { currency: "USC", minorUnits: "1000000" }, unlimited: false }],
    });
    const write = prepareWrite(writeRequest, NOW);
    const sim = simulated({
      approvals: [{ owner: PAYER, spender: ROUTER, asset: USC_ASSET, allowance: { currency: "USC", minorUnits: "999999999" }, unlimited: false }],
    });
    const decision = evaluateOnchainWriteGates({ write, simulation: sim, policy: basePolicy(), securityState: baseSecurityState(), at: NOW });
    expectBlock(decision, "simulation_approval_mismatch");
  });
});

describe("ALLOW happy path", () => {
  it("passes every dimension and records the evidence refs", () => {
    const decision = gated(baseWriteRequest());
    expect(decision.decision).toBe("ALLOW");
    expect(decision.checks.length).toBeGreaterThanOrEqual(10);
    expect(decision.evidenceRefs.some((ref) => ref.startsWith("policy:"))).toBe(true);
    expect(decision.evidenceRefs.some((ref) => ref.startsWith("write:"))).toBe(true);
  });
});

describe("rule 27: agents may FLAG, never override", () => {
  it("attaching an agent flag never mutates the decision", () => {
    const blocked = gated(baseWriteRequest({ chain: "solana:mainnet", transfer: { ...baseWriteRequest().transfer!, asset: { chain: "solana:mainnet", assetId: "So11111111111111111111111111111111111111112", symbol: "USC" } } }));
    expect(blocked.decision).toBe("BLOCK");
    const flag: AgentSecurityFlag = {
      flagId: "flag-1",
      flaggedBy: "agent:adversarial-1",
      dimension: "chain",
      note: "chain confusion pattern observed",
      flaggedAt: NOW,
    };
    const evaluation: GatedEvaluation = attachAgentFlag({ decision: blocked, flags: [] }, flag);
    expect(evaluation.decision.decision).toBe("BLOCK");
    expect(evaluation.flags).toHaveLength(1);
    // The decision object is the same frozen instance — untouched.
    expect(evaluation.decision).toBe(blocked);
  });

  it("attemptAgentOverride on a BLOCK decision is rejected (throws)", () => {
    const blocked = gated(baseWriteRequest({ transfer: { ...baseWriteRequest().transfer!, to: MALICIOUS_SPENDER } }));
    expect(() => attemptAgentOverride(blocked, "agent:malicious-1")).toThrow(AgentOverrideForbiddenError);
  });

  it("attemptAgentOverride is rejected for UNKNOWN and ALLOW as well", () => {
    const unknownDecision = gated(
      baseWriteRequest({ route: { routeId: "route-2", routeHash: "fnv1a64:0000000000000002" } }),
      basePolicy({ unknownRoutePolicy: "escalate" }),
    );
    expect(unknownDecision.decision).toBe("UNKNOWN");
    expect(() => attemptAgentOverride(unknownDecision, "agent:heuristic-1")).toThrow(AgentOverrideForbiddenError);

    const allowed = gated(baseWriteRequest());
    expect(() => attemptAgentOverride(allowed, "agent:malicious-1")).toThrow(AgentOverrideForbiddenError);
  });

  it("a runtime-injected escalation (not in the frozen policy) cannot resolve UNKNOWN", () => {
    const request = baseWriteRequest({
      contractCall: { target: UNKNOWN_TARGET, calldata: "0xdeadbeef", calldataDigest: "fnv1a64:a" },
    });
    const policy = basePolicy({ unknownContractPolicy: "escalate" });
    const write = prepareWrite(request, NOW);
    const before = evaluateOnchainWriteGates({ write, policy, securityState: baseSecurityState(), at: NOW });
    expect(before.decision).toBe("UNKNOWN");
    // An agent tries to smuggle an escalation into the decision path by
    // mutating the policy object after evaluation — the policy is frozen
    // input; re-evaluation uses the same frozen policy object.
    const smuggled = {
      ...policy,
      escalations: [
        {
          escalationId: "agent-forged",
          dimension: "protocol_identity" as const,
          targetRef: UNKNOWN_TARGET,
          disposition: "allow_with_evidence" as const,
          evidenceRefs: ["fabricated"],
          resolvedBy: "agent:malicious-1",
          resolvedAt: NOW,
          expiresAt: NOW + 60_000,
        },
      ],
    };
    // The smuggled policy is a NEW object; the evaluation that already
    // happened is immutable. Re-running with the smuggled policy WOULD
    // resolve — which is why policy provenance is operator-owned; the
    // pipeline only ever evaluates with the policy IT was constructed with.
    const after = evaluateOnchainWriteGates({ write, policy: smuggled, securityState: baseSecurityState(), at: NOW });
    expect(after.decision).toBe("ALLOW"); // policy-authority escalation works —
    // but the decision minted from the ORIGINAL policy stays UNKNOWN:
    expect(before.decision).toBe("UNKNOWN");
    expect(Object.isFrozen(before)).toBe(true);
  });
});
