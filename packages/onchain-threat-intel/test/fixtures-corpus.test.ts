import { describe, expect, it } from "vitest";
import { evaluateOnchainWriteGates, prepareWrite } from "@payswap/onchain-security";
import type { OnchainWriteRequest } from "@payswap/onchain-security";
import {
  AdversarialTransactionAgent,
  evaluateThreatPolicy,
  composeThreatVerdict,
  resolveOnchainSecurityDecision,
} from "../src/index.js";
import type { OnchainThreatObservationBundle } from "../src/index.js";
import { recordObservationBundle } from "../src/index.js";
import {
  AGENT_REF,
  CHAIN,
  FAKE_USC_ASSET,
  MALICIOUS_SPENDER,
  MERCHANT,
  NOW,
  OTHER_CHAIN,
  PAYER,
  ROUTE_HASH,
  ROUTER,
  USC_ASSET,
  baseKernelPolicy,
  baseSecurityState,
  baseThreatPolicy,
  baseWriteRequest,
  benignBundleInput,
  canonicalApproval,
  consistentSimulation,
  contractExtension,
} from "./helpers.js";

/**
 * THE MALICIOUS FIXTURE CORPUS (task packet hard requirement 4).
 *
 * One fixture per threat family — 13/13. Every fixture is an INTENTIONALLY
 * malicious transaction world; the full adversarial pipeline runs:
 *
 *   prepare → simulate → observe → agent.analyze → evaluateThreatPolicy →
 *   composeThreatVerdict → resolveOnchainSecurityDecision (kernel gates
 *   composed)
 *
 * and the fixture asserts:
 * - the final composed decision is BLOCK (or REQUIRE_CONFIRMATION exactly
 *   where the deterministic policy says so — never a silent ALLOW);
 * - the driving signals carry COMPLETE evidence chains (which observation,
 *   which digest, which exact delta) — recorded verbatim in the assertion;
 * - the kernel's own decision corroborates where its dimensions overlap.
 */

const agent = new AdversarialTransactionAgent(AGENT_REF);

interface FixtureResult {
  readonly decision: string;
  readonly threatVerdict: string;
  readonly kernel: string;
  readonly signals: readonly {
    family: string;
    code: string;
    severity: string;
    method: string;
    confidenceBps: number;
    observationRefs: readonly string[];
    digestRefs: readonly string[];
    deltas: readonly { label: string; observed: string; expected: string }[];
  }[];
}

function runFixture(input: {
  writeOverrides?: Parameters<typeof baseWriteRequest>[0];
  simulation?: ReturnType<typeof consistentSimulation>;
  bundle?: OnchainThreatObservationBundle;
  policy?: Parameters<typeof baseThreatPolicy>[0];
  kernelPolicy?: Parameters<typeof baseKernelPolicy>[0];
}): FixtureResult {
  const write = prepareWrite(baseWriteRequest(input.writeOverrides), NOW);
  const bundle = input.bundle ?? recordObservationBundle(benignBundleInput());
  const policy = baseThreatPolicy(input.policy);
  const assessment = agent.analyze({
    write,
    ...(input.simulation === undefined ? {} : { simulation: input.simulation }),
    policy,
    bundle,
    at: NOW,
  });
  const policyEvaluation = evaluateThreatPolicy(assessment.signals, policy);
  const composed = composeThreatVerdict(
    assessment.agentRecommendation,
    policyEvaluation.verdict,
  );
  const kernelDecision = evaluateOnchainWriteGates({
    write,
    ...(input.simulation === undefined ? {} : { simulation: input.simulation }),
    policy: baseKernelPolicy(input.kernelPolicy),
    securityState: baseSecurityState(),
    at: NOW,
  });
  const resolution = resolveOnchainSecurityDecision({
    kernelDecision,
    threatVerdict: composed,
  });
  return {
    decision: resolution.decision,
    threatVerdict: composed,
    kernel: kernelDecision.decision,
    signals: assessment.signals.map((signal) => ({
      family: signal.family,
      code: signal.code,
      severity: signal.severity,
      method: signal.method,
      confidenceBps: signal.confidenceBps,
      observationRefs: signal.evidence.observationRefs,
      digestRefs: signal.evidence.digestRefs,
      deltas: (signal.evidence.deltas ?? []).map((d) => ({
        label: d.label,
        observed: d.observed,
        expected: d.expected,
      })),
    })),
  };
}

describe("MALICIOUS FIXTURE CORPUS — 13/13 families, end-to-end", () => {
  it("fixture 1 — UNLIMITED APPROVAL to a drain-pattern spender → BLOCK", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      spenders: [
        {
          observationId: "spender-intel:drainer",
          spender: MALICIOUS_SPENDER,
          knownDrainPattern: true,
          observedIncidents: 7,
          firstObservedAt: NOW - 90 * 86_400_000,
        },
      ],
    });
    const result = runFixture({
      writeOverrides: {
        approvals: [
          canonicalApproval({ spender: MALICIOUS_SPENDER, unlimited: true, minorUnits: "0" }),
        ],
      },
      bundle,
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.threatVerdict).toBe("BLOCK");
    expect(result.kernel).toBe("BLOCK"); // kernel: spender not allowlisted
    const unlimited = result.signals.find((s) => s.code === "unlimited_approval_forbidden")!;
    expect(unlimited.severity).toBe("critical");
    expect(unlimited.observationRefs).toContain("spender-intel:drainer");
    expect(unlimited.digestRefs.join(" ")).toMatch(/write:fnv1a64:/);
    expect(unlimited.deltas[0]).toMatchObject({
      label: "approval_allowance",
      observed: "true",
      expected: "false",
    });
  });

  it("fixture 2 — HOSTILE spender (fresh, incident-heavy, drain pattern) → BLOCK via the threat layer (kernel blind)", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      spenders: [
        {
          observationId: "spender-intel:fresh-hostile",
          spender: MALICIOUS_SPENDER,
          knownDrainPattern: true,
          firstObservedAt: NOW - 60_000,
          observedIncidents: 4,
        },
      ],
    });
    const result = runFixture({
      writeOverrides: {
        approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })],
      },
      bundle,
      // the kernel policy trusts this spender; the ADVERSARIAL layer must
      // catch the drain pattern + incidents the allowlist cannot see.
      kernelPolicy: { allowedSpenders: [ROUTER, MALICIOUS_SPENDER] },
      policy: { allowedSpenders: [ROUTER, MALICIOUS_SPENDER] },
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.kernel).toBe("ALLOW");
    const incidents = result.signals.find((s) => s.code === "spender_incident_threshold_reached")!;
    expect(incidents.observationRefs).toContain("spender-intel:fresh-hostile");
    expect(incidents.deltas[0]).toMatchObject({ observed: "4", expected: "3" });
    // the drain-pattern allowance is the critical driver
    expect(result.signals.some((s) => s.code === "approval_to_drain_pattern_spender")).toBe(true);
  });

  it("fixture 3 — FAKE TOKEN impersonating USC → BLOCK", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      tokens: [
        {
          observationId: "token-registry:fake-usc",
          asset: FAKE_USC_ASSET,
          canonical: false,
          impersonatesAssetId: USC_ASSET.assetId,
        },
      ],
    });
    const result = runFixture({
      writeOverrides: {
        transfer: {
          asset: FAKE_USC_ASSET,
          amount: { currency: "USC", minorUnits: "1000000" },
          from: PAYER,
          to: MERCHANT,
        },
      },
      bundle,
      kernelPolicy: { allowedAssets: [USC_ASSET, FAKE_USC_ASSET] }, // kernel blind here — the THREAT layer must catch it
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.threatVerdict).toBe("BLOCK");
    expect(result.kernel).toBe("ALLOW"); // proves the adversarial layer sees what the gate cannot
    const impersonation = result.signals.find((s) => s.code === "impersonator_token_identified")!;
    expect(impersonation.severity).toBe("critical");
    expect(impersonation.method).toBe("exact_identity_match");
    expect(impersonation.confidenceBps).toBeGreaterThanOrEqual(9_900);
    expect(impersonation.observationRefs).toContain("token-registry:fake-usc");
  });

  it("fixture 4 — HONEYPOT token (transfer-restricted, unsellable) → BLOCK", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      tokens: [
        {
          observationId: "token-registry:usc",
          asset: USC_ASSET,
          canonical: true,
          transferRestricted: true,
          sellable: false,
        },
      ],
    });
    const result = runFixture({ bundle });
    expect(result.decision).toBe("BLOCK");
    const honeypot = result.signals.find((s) => s.code === "token_transfer_restricted")!;
    expect(honeypot.observationRefs).toContain("token-registry:usc");
    expect(honeypot.deltas[0]).toMatchObject({
      label: "transfer_restricted",
      observed: "true",
      expected: "false",
    });
  });

  it("fixture 5 — PROXY/ADMIN HIJACK (upgrade authority flipped off multisig) → BLOCK", () => {
    const swapRequest: OnchainWriteRequest = {
      writeId: "write-swap-hijack",
      action: "onchain.swap",
      chain: CHAIN,
      contractCall: {
        target: ROUTER,
        calldata: "0xdeadbeef",
        calldataDigest: "fnv1a64:ca11",
      },
      approvals: [canonicalApproval()],
      route: { routeId: "route-1", routeHash: ROUTE_HASH },
      expiry: NOW + 60_000,
      requestedBy: AGENT_REF,
      protocol: {
        protocolId: "uniswap:v3",
        version: "1.0.0",
        contract: contractExtension({
          bytecodeHash: "byte-hash-EVIL",
          upgradeAuthority: {
            kind: "UPGRADEABLE",
            description: "attacker-controlled upgrade path",
          },
          adminAuthority: { kind: "DAO", description: "replaced authority" },
        }),
      },
    };
    const result = runFixture({ writeOverrides: swapRequest as Partial<OnchainWriteRequest> });
    expect(result.decision).toBe("BLOCK");
    expect(result.kernel).toBe("BLOCK"); // kernel: protocol identity drift
    const upgrade = result.signals.find((s) => s.code === "upgrade_authority_changed")!;
    expect(upgrade.severity).toBe("critical");
    expect(upgrade.observationRefs.join(" ")).toContain("protocol:uniswap:v3");
  });

  it("fixture 6 — ORACLE MANIPULATION (12% divergence between feeds) → BLOCK", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      oracles: [
        {
          observationId: "oracle:usd-1",
          oracleId: "oracle:primary-usc",
          pair: "USC/USD",
          observedPrice: "1000000/1000000",
          priceUpdatedAt: NOW - 1_000,
          feedAgeMs: 1_000,
        },
        {
          observationId: "oracle:usd-2",
          oracleId: "oracle:secondary-usc",
          pair: "USC/USD",
          observedPrice: "880000/1000000",
          priceUpdatedAt: NOW - 1_000,
          feedAgeMs: 1_000,
        },
      ],
    });
    const result = runFixture({ bundle });
    expect(result.decision).toBe("BLOCK");
    const oracle = result.signals.find(
      (s) => s.code === "oracle_pairwise_deviation_exceeds_threshold",
    )!;
    expect(oracle.severity).toBe("critical");
    expect(oracle.observationRefs).toEqual(["oracle:usd-1", "oracle:usd-2"]);
    expect(oracle.deltas[0]!.label).toBe("pairwise_price_deviation_bps");
  });

  it("fixture 7 — BRIDGE COMPROMISE (halted + validator churn + sub-quorum) → BLOCK", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      bridges: [
        {
          observationId: "bridge:main-1",
          bridgeId: "bridge:canonical-bridge",
          status: "halted",
          validatorSetChangedAt: NOW - 60_000,
          attestationQuorum: "1/3",
          observedAt: NOW,
        },
      ],
      // route crosses a chain boundary through the compromised bridge
    });
    const result = runFixture({
      writeOverrides: {
        route: {
          routeId: "route-bridge-1",
          routeHash: "fnv1a64:0000000000000001",
          hops: [
            { venue: "bridge:canonical-bridge", chain: OTHER_CHAIN },
          ],
        },
      },
      bundle,
    });
    expect(result.decision).toBe("BLOCK");
    expect(result.signals.some((s) => s.code === "bridge_halted")).toBe(true);
    expect(result.signals.some((s) => s.code === "bridge_validator_set_recently_changed")).toBe(true);
    expect(result.signals.some((s) => s.code === "bridge_attestation_quorum_below_minimum")).toBe(true);
    // chain confusion also fires (hop on another chain)
    expect(result.signals.some((s) => s.code === "route_hop_chain_mismatch")).toBe(true);
  });

  it("fixture 8 — MEV/SANDWICH: public-mempool-visible swap at 400 bps slippage → BLOCK (critical exposure with competing txs)", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      quoteSlippage: {
        protection: "DECLARED_LIMIT",
        worstCaseOutput: { currency: "USC", minorUnits: "600000" },
        limitBasisPoints: 400,
      },
      quoteObservedAt: NOW - 1_000,
      quoteValidUntil: NOW + 30_000,
      mempool: {
        observationId: "mempool:main",
        chain: CHAIN,
        writeVisible: true,
        competingTransactions: 4,
        observedAt: NOW - 500,
      },
    });
    const result = runFixture({ bundle });
    expect(result.decision).toBe("BLOCK");
    const sandwich = result.signals.find(
      (s) => s.code === "visible_swap_with_sandwich_profitable_slippage",
    )!;
    expect(sandwich.severity).toBe("critical");
    expect(sandwich.observationRefs).toContain("mempool:main");
    expect(sandwich.deltas[0]).toMatchObject({
      label: "sandwich_surface_bps",
      observed: "400",
      expected: "199",
    });
  });

  it("fixture 8b — MEV exposure at MEDIUM grade (invisible, over-limit slippage only) → REQUIRE_CONFIRMATION exactly as the deterministic policy says", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      quoteSlippage: {
        protection: "DECLARED_LIMIT",
        worstCaseOutput: { currency: "USC", minorUnits: "900000" },
        limitBasisPoints: 400,
      },
      quoteObservedAt: NOW - 1_000,
      quoteValidUntil: NOW + 30_000,
      mempool: {
        observationId: "mempool:main",
        chain: CHAIN,
        writeVisible: false,
        observedAt: NOW - 500,
      },
    });
    const result = runFixture({ bundle });
    // medium severity, mev family default: REQUIRE_CONFIRMATION (never silent ALLOW)
    expect(result.decision).toBe("REQUIRE_CONFIRMATION");
    expect(result.signals.some((s) => s.code === "slippage_limit_above_policy_max")).toBe(true);
  });

  it("fixture 9 — DESTINATION/CHAIN CONFUSION (hop on polygon while write targets ethereum) → BLOCK", () => {
    const result = runFixture({
      writeOverrides: {
        route: {
          routeId: "route-confused",
          routeHash: "fnv1a64:0000000000000001",
          hops: [{ venue: "venue:poly-dex", chain: OTHER_CHAIN }],
        },
      },
    });
    expect(result.decision).toBe("BLOCK");
    const confusion = result.signals.find((s) => s.code === "route_hop_chain_mismatch")!;
    expect(confusion.severity).toBe("critical");
    expect(confusion.deltas[0]).toMatchObject({
      label: "hop_chain_matches_write_chain",
      observed: "false",
      expected: "true",
    });
  });

  it("fixture 10 — REPLAY: previously observed payload digest under another domain → BLOCK", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      domain: {
        observationId: "domain:write-1",
        payloadDigest: "fnv1a64:abcdef0123456789",
        domainRef: "domain:swap-router-v1",
        domainChain: OTHER_CHAIN,
        digestPreviouslyObserved: true,
        nonceLastUsedAt: NOW - 60_000,
        observedAt: NOW,
      },
    });
    const result = runFixture({ bundle });
    expect(result.decision).toBe("BLOCK");
    expect(result.signals.some((s) => s.code === "payload_digest_previously_observed")).toBe(true);
    expect(result.signals.some((s) => s.code === "signature_domain_chain_mismatch")).toBe(true);
    const replay = result.signals.find((s) => s.code === "payload_digest_previously_observed")!;
    expect(replay.method).toBe("exact_identity_match");
  });

  it("fixture 11 — UNEXPECTED BALANCE DELTA: simulation sweeps an unrequested allowance → BLOCK", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const simulation = consistentSimulation(write.writeId, {
      approvals: [
        {
          owner: PAYER,
          spender: MALICIOUS_SPENDER,
          asset: USC_ASSET,
          allowance: { currency: "USC", minorUnits: "9999999" },
          unlimited: false,
        },
      ],
    });
    const result = runFixture({ simulation });
    expect(result.decision).toBe("BLOCK");
    const sweep = result.signals.find(
      (s) => s.code === "approval_state_change_outside_intent",
    )!;
    expect(sweep.severity).toBe("critical");
    expect(sweep.deltas[0]).toMatchObject({
      label: "unexpected_allowance_minor_units",
      observed: "9999999",
      expected: "0",
    });
  });

  it("fixture 12 — MATERIALLY CHANGED SIMULATION (bound to a different write) → BLOCK", () => {
    const simulation = consistentSimulation("write-SOMEONE-ELSE");
    const result = runFixture({ simulation });
    expect(result.decision).toBe("BLOCK");
    expect(result.kernel).toBe("BLOCK"); // kernel consistency dimension fires too
    const stale = result.signals.find(
      (s) => s.code === "simulation_bound_to_different_write",
    )!;
    expect(stale.severity).toBe("critical");
    expect(stale.method).toBe("exact_identity_match");
  });

  it("fixture 12b — STALE simulation (old age, lagging block) → BLOCK (high-grade staleness blocks by the deterministic table)", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const simulation = consistentSimulation(write.writeId, {
      observedAt: NOW - 60_000,
      blockRef: "block:900",
    });
    const result = runFixture({ simulation });
    // high-severity staleness → BLOCK under the default
    // stale_changed_simulation table; the kernel's own simulation
    // consistency dimension is still ALLOW (deltas match) — the adversarial
    // layer binds where the gate cannot see age.
    expect(result.decision).toBe("BLOCK");
    expect(result.kernel).toBe("ALLOW");
    expect(result.signals.some((s) => s.code === "simulation_older_than_policy_max_age")).toBe(true);
    expect(result.signals.some((s) => s.code === "simulation_block_lags_head")).toBe(true);
  });

  it("fixture 13 — FINALITY ANOMALY (wide head→safe lag, reorg within tolerance) → REQUIRE_CONFIRMATION exactly as the deterministic policy says", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      finality: {
        observationId: "finality:main",
        chain: CHAIN,
        headBlock: 1_000,
        safeBlock: 940,
        lastReorgDepthBlocks: 1,
        observedAt: NOW,
      },
    });
    const result = runFixture({ bundle });
    // finality_lag (high severity) → REQUIRE_CONFIRMATION under the default
    // table (the exposure family confirms with a human before executing
    // beyond the safe head; only a deeper reorg BLOCKs).
    expect(result.decision).toBe("REQUIRE_CONFIRMATION");
    const lag = result.signals.find((s) => s.code === "finality_lag_exceeds_threshold")!;
    expect(lag.severity).toBe("high");
    expect(lag.observationRefs).toContain("finality:main");
    expect(lag.deltas[0]).toMatchObject({ label: "finality_lag_blocks", observed: "60", expected: "12" });
  });

  it("fixture 13b — DEEP REORG (critical-grade alone under a stricter family table) → BLOCK", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      finality: {
        observationId: "finality:main",
        chain: CHAIN,
        headBlock: 1_000,
        safeBlock: 995,
        lastReorgDepthBlocks: 9,
        observedAt: NOW,
      },
    });
    const result = runFixture({ bundle });
    // critical reorg-depth → BLOCK by the default table (critical: BLOCK).
    expect(result.decision).toBe("BLOCK");
    expect(result.signals.find((s) => s.code === "reorg_depth_exceeds_threshold")!.deltas[0])
      .toMatchObject({ label: "reorg_depth_blocks", observed: "9", expected: "2" });
  });

  it("the benign control fixture stays ALLOW end-to-end (no false positives in the corpus)", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const result = runFixture({ simulation: consistentSimulation(write.writeId) });
    expect(result.decision).toBe("ALLOW");
    expect(result.threatVerdict).toBe("ALLOW");
    expect(result.kernel).toBe("ALLOW");
    expect(result.signals).toEqual([]);
  });
});
