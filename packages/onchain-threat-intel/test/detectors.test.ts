import { describe, expect, it } from "vitest";
import { prepareWrite } from "@payswap/onchain-security";
import type { OnchainWriteRequest } from "@payswap/onchain-security";
import {
  AdversarialTransactionAgent,
  runAllDetectors,
} from "../src/index.js";
import type { DetectionContext } from "../src/index.js";
import { recordObservationBundle } from "../src/index.js";
import type { OnchainThreatObservationBundle } from "../src/index.js";
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
  baseThreatPolicy,
  baseWriteRequest,
  benignBundle,
  benignBundleInput,
  canonicalApproval,
  consistentSimulation,
  contractExtension,
  protocolIdentity,
} from "./helpers.js";

/**
 * The 13-family detection battery: for EVERY task-packet family there is
 * (a) at least one positive detection test whose raised signals carry a
 * complete evidence chain (observation refs, digest refs, exact deltas),
 * and (b) a benign negative proving the detector stays silent on healthy
 * input. Detection is evidence-generating; verdicts are NOT produced here
 * (see policy/verdict suites).
 */

const agent = new AdversarialTransactionAgent(AGENT_REF);

function context(input: {
  write?: ReturnType<typeof prepareWrite>;
  simulation?: ReturnType<typeof consistentSimulation>;
  policy?: ReturnType<typeof baseThreatPolicy>;
  bundle?: ReturnType<typeof benignBundle>;
  at?: number;
}): DetectionContext {
  return {
    write: input.write ?? prepareWrite(baseWriteRequest(), NOW),
    ...(input.simulation === undefined ? {} : { simulation: input.simulation }),
    policy: input.policy ?? baseThreatPolicy(),
    bundle: input.bundle ?? benignBundle(),
    at: input.at ?? NOW,
  };
}

describe("benign baseline (no false positives)", () => {
  it("a fully healthy world raises ZERO signals", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const assessment = agent.analyze({
      write,
      simulation: consistentSimulation(write.writeId),
      policy: baseThreatPolicy(),
      bundle: benignBundle(),
      at: NOW,
    });
    expect(assessment.signals).toEqual([]);
    expect(assessment.agentRecommendation).toBe("ALLOW");
  });

  it("runAllDetectors on the benign context is empty", () => {
    expect(runAllDetectors(context({}))).toEqual([]);
  });
});

describe("family 1 — malicious approvals/permits", () => {
  it("detects an unlimited approval when policy forbids them", () => {
    const write = prepareWrite(
      baseWriteRequest({
        approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER, unlimited: true, minorUnits: "0" })],
      }),
      NOW,
    );
    const raw = runAllDetectors(context({ write }));
    const signal = raw.find(
      (s) => s.family === "malicious_approval_permit" && s.code === "unlimited_approval_forbidden",
    );
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("critical");
    expect(signal!.evidence.observationRefs.join(" ")).toContain("approval:");
    expect(signal!.evidence.digestRefs.join(" ")).toContain(`write:${write.writeDigest}`);
  });

  it("detects an over-cap approval (exact minor-unit delta)", () => {
    const write = prepareWrite(
      baseWriteRequest({
        approvals: [canonicalApproval({ spender: ROUTER, minorUnits: "9000000" })],
      }),
      NOW,
    );
    const raw = runAllDetectors(context({ write }));
    const signal = raw.find((s) => s.code === "approval_exceeds_policy_cap");
    expect(signal).toBeDefined();
    expect(signal!.evidence.deltas?.[0]).toMatchObject({
      label: "approval_minor_units",
      observed: "9000000",
      expected: "5000000",
    });
  });

  it("detects an approval to a drain-pattern spender (behavioral + corroboration)", () => {
    const write = prepareWrite(
      baseWriteRequest({ approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })] }),
      NOW,
    );
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      spenders: [
        {
          observationId: "spender-intel:drainer",
          spender: MALICIOUS_SPENDER,
          knownDrainPattern: true,
          observedIncidents: 5,
          firstObservedAt: NOW - 90 * 86_400_000,
        },
      ],
    });
    const raw = runAllDetectors(context({ write, bundle }));
    const signal = raw.find((s) => s.code === "approval_to_drain_pattern_spender");
    expect(signal).toBeDefined();
    expect(signal!.evidence.observationRefs).toContain("spender-intel:drainer");
  });

  it("detects an expired permit deadline", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      domain: {
        observationId: "domain:write-1",
        payloadDigest: "fnv1a64:abcdef0123456789",
        domainRef: "domain:permit-2",
        domainChain: CHAIN,
        digestPreviouslyObserved: false,
        permitDeadline: NOW - 1,
        observedAt: NOW,
      },
    });
    const raw = runAllDetectors(context({ bundle }));
    expect(raw.some((s) => s.code === "permit_deadline_expired")).toBe(true);
  });

  it("stays silent for a canonical bounded approval", () => {
    const write = prepareWrite(
      baseWriteRequest({ approvals: [canonicalApproval()] }),
      NOW,
    );
    const raw = runAllDetectors(context({ write }));
    expect(
      raw.filter((s) => s.family === "malicious_approval_permit"),
    ).toEqual([]);
  });
});

describe("family 2 — unexpected spenders", () => {
  it("detects a spender outside the policy allowlist", () => {
    const write = prepareWrite(
      baseWriteRequest({ approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER })] }),
      NOW,
    );
    const raw = runAllDetectors(context({ write }));
    const signal = raw.find((s) => s.code === "spender_not_in_policy_allowlist");
    expect(signal).toBeDefined();
    expect(signal!.method).toBe("exact_identity_match");
  });

  it("detects a too-recent spender (exact age delta)", () => {
    const write = prepareWrite(
      baseWriteRequest({ approvals: [canonicalApproval({ spender: ROUTER })] }),
      NOW,
    );
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      spenders: [
        {
          observationId: "spender-intel:fresh",
          spender: ROUTER,
          knownDrainPattern: false,
          firstObservedAt: NOW - 1_000,
        },
      ],
    });
    const raw = runAllDetectors(context({ write, bundle }));
    const signal = raw.find((s) => s.code === "spender_below_minimum_age");
    expect(signal).toBeDefined();
    expect(signal!.evidence.deltas?.[0]).toMatchObject({
      label: "spender_age_ms",
      observed: "1000",
      expected: "3600000",
    });
  });

  it("detects an incident-heavy spender", () => {
    const write = prepareWrite(
      baseWriteRequest({ approvals: [canonicalApproval({ spender: ROUTER })] }),
      NOW,
    );
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      spenders: [
        {
          observationId: "spender-intel:incidents",
          spender: ROUTER,
          knownDrainPattern: false,
          firstObservedAt: NOW - 90 * 86_400_000,
          observedIncidents: 4,
        },
      ],
    });
    const raw = runAllDetectors(context({ write, bundle }));
    expect(raw.some((s) => s.code === "spender_incident_threshold_reached")).toBe(true);
  });
});

describe("family 3 — token impersonation", () => {
  it("detects an impersonator token by registry observation", () => {
    const write = prepareWrite(
      baseWriteRequest({
        transfer: {
          asset: FAKE_USC_ASSET,
          amount: { currency: "USC", minorUnits: "1000000" },
          from: PAYER,
          to: MERCHANT,
        },
      }),
      NOW,
    );
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
    const raw = runAllDetectors(context({ write, bundle }));
    const signal = raw.find((s) => s.code === "impersonator_token_identified");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("critical");
    expect(signal!.method).toBe("exact_identity_match");
  });

  it("detects an asset absent from required registry coverage (weak evidence)", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      tokens: [], // registry observed, but nothing in it
    });
    const raw = runAllDetectors(context({ bundle }));
    const signal = raw.find((s) => s.code === "asset_absent_from_registry_observation");
    expect(signal).toBeDefined();
    expect(signal!.method).toBe("registry_absence");
  });

  it("silence when coverage is not required", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      tokens: [],
    });
    const raw = runAllDetectors(
      context({ bundle, policy: baseThreatPolicy({ requireTokenRegistryCoverage: false }) }),
    );
    expect(
      raw.filter((s) => s.family === "token_impersonation"),
    ).toEqual([]);
  });
});

describe("family 4 — honeypot/transfer restrictions", () => {
  it("detects transfer-restricted and unsellable tokens", () => {
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
    const raw = runAllDetectors(context({ bundle }));
    expect(raw.some((s) => s.code === "token_transfer_restricted")).toBe(true);
    expect(raw.some((s) => s.code === "token_not_sellable")).toBe(true);
    const restricted = raw.find((s) => s.code === "token_transfer_restricted")!;
    expect(restricted.evidence.observationRefs).toContain("token-registry:usc");
  });
});

describe("family 5 — proxy/admin/implementation changes", () => {
  function writeWithProtocol(contractOverrides: Parameters<typeof contractExtension>[0]) {
    const request: OnchainWriteRequest = {
      writeId: "write-swap-1",
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
        contract: contractExtension(contractOverrides),
      },
    };
    return prepareWrite(request, NOW);
  }

  it("detects implementation bytecode drift", () => {
    const write = writeWithProtocol({ bytecodeHash: "byte-hash-EVIL" });
    const raw = runAllDetectors(context({ write }));
    const signal = raw.find((s) => s.code === "implementation_bytecode_drift");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("critical");
  });

  it("detects upgrade-authority and admin-authority changes", () => {
    const write = writeWithProtocol({
      upgradeAuthority: {
        kind: "UPGRADEABLE",
        description: "single-admin upgrade path",
      },
      adminAuthority: { kind: "DAO", description: "replaced authority" },
    });
    const raw = runAllDetectors(context({ write }));
    expect(raw.some((s) => s.code === "upgrade_authority_changed")).toBe(true);
    expect(raw.some((s) => s.code === "admin_authority_changed")).toBe(true);
  });

  it("silence when the declared contract matches the certified reference", () => {
    const write = writeWithProtocol(undefined);
    const raw = runAllDetectors(context({ write }));
    expect(raw.filter((s) => s.family === "proxy_admin_change")).toEqual([]);
  });

  it("silence when no protocol identity is declared (kernel dimension)", () => {
    const raw = runAllDetectors(context({}));
    expect(raw.filter((s) => s.family === "proxy_admin_change")).toEqual([]);
  });
});

describe("family 6 — oracle manipulation", () => {
  it("detects pairwise deviation beyond the threshold (exact rational delta)", () => {
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
          observedPrice: "1100000/1000000", // 10% deviation = 100000 bps
          priceUpdatedAt: NOW - 1_000,
          feedAgeMs: 1_000,
        },
      ],
    });
    const raw = runAllDetectors(context({ bundle }));
    const signal = raw.find(
      (s) => s.code === "oracle_pairwise_deviation_exceeds_threshold",
    );
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("critical");
    const delta = signal!.evidence.deltas?.[0]!;
    expect(delta.label).toBe("pairwise_price_deviation_bps");
    // exact: |1 - 1.1| / 1.1·1·10^4 → rational string, exceeds 50 bps
    expect(delta.unit).toBe("rational");
  });

  it("detects a stale oracle feed", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      oracles: [
        {
          observationId: "oracle:usd-1",
          oracleId: "oracle:primary-usc",
          pair: "USC/USD",
          observedPrice: "1000000/1000000",
          priceUpdatedAt: NOW - 500_000,
          feedAgeMs: 500_000,
        },
      ],
    });
    const raw = runAllDetectors(context({ bundle }));
    expect(raw.some((s) => s.code === "oracle_feed_stale")).toBe(true);
  });

  it("detects deviation from a policy reference price", () => {
    const bundle = benignBundle();
    const raw = runAllDetectors(
      context({
        bundle,
        policy: baseThreatPolicy({
          referenceOraclePrices: [{ pair: "USC/USD", price: "999000/1000000" }],
          maxOracleReferenceDeviationBasisPoints: 5,
        }),
      }),
    );
    // the benign secondary oracle (1000100/1000000) is 11 bps off the
    // reference (999000/1000000) — beyond the 5 bps threshold
    expect(raw.some((s) => s.code === "oracle_reference_deviation_exceeds_threshold")).toBe(true);
  });

  it("benign oracles (within 50 bps of each other) stay silent", () => {
    const raw = runAllDetectors(context({ bundle: benignBundle() }));
    expect(raw.filter((s) => s.family === "oracle_manipulation")).toEqual([]);
  });
});

describe("family 7 — bridge compromise", () => {
  it("detects a halted bridge (critical) and a degraded bridge (high)", () => {
    for (const [status, code] of [
      ["halted", "bridge_halted"],
      ["degraded", "bridge_degraded"],
    ] as const) {
      const bundle = recordObservationBundle({
        ...benignBundleInput(),
        bridges: [
          {
            observationId: "bridge:main-1",
            bridgeId: "bridge:canonical-bridge",
            status,
            attestationQuorum: "9/10",
            observedAt: NOW,
          },
        ],
      });
      const raw = runAllDetectors(context({ bundle }));
      expect(raw.some((s) => s.code === code)).toBe(true);
    }
  });

  it("detects a recent validator-set change (suspicion window)", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      bridges: [
        {
          observationId: "bridge:main-1",
          bridgeId: "bridge:canonical-bridge",
          status: "healthy",
          validatorSetChangedAt: NOW - 1_000,
          attestationQuorum: "9/10",
          observedAt: NOW,
        },
      ],
    });
    const raw = runAllDetectors(context({ bundle }));
    const signal = raw.find((s) => s.code === "bridge_validator_set_recently_changed");
    expect(signal).toBeDefined();
    expect(signal!.evidence.deltas?.[0]).toMatchObject({
      label: "validator_set_change_age_ms",
      observed: "1000",
      expected: "86400000",
    });
  });

  it("detects sub-quorum attestations (exact rational comparison)", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      bridges: [
        {
          observationId: "bridge:main-1",
          bridgeId: "bridge:canonical-bridge",
          status: "healthy",
          attestationQuorum: "3/5", // 0.6 < 2/3
          observedAt: NOW,
        },
      ],
    });
    const raw = runAllDetectors(context({ bundle }));
    expect(raw.some((s) => s.code === "bridge_attestation_quorum_below_minimum")).toBe(true);
  });

  it("detects a bridge hop with no health observation (weak evidence)", () => {
    const write = prepareWrite(
      baseWriteRequest({
        route: {
          routeId: "route-bridge-1",
          routeHash: "fnv1a64:0000000000000001",
          hops: [
            { venue: "venue:source-dex", chain: CHAIN },
            { venue: "bridge:unobserved-bridge", chain: OTHER_CHAIN },
          ],
        },
      }),
      NOW,
    );
    const raw = runAllDetectors(context({ write }));
    expect(raw.some((s) => s.code === "bridge_hop_without_health_observation")).toBe(true);
  });
});

describe("family 8 — MEV/sandwich exposure (W2-002 quote composition)", () => {
  function quoteBundle(input: {
    limitBasisPoints?: number;
    priceImpactBasisPoints?: number;
    visible?: boolean;
    competing?: number;
    validUntil?: number;
  }) {
    const slippage = {
      protection: "DECLARED_LIMIT" as const,
      worstCaseOutput: { currency: "USC", minorUnits: "900000" },
      ...(input.limitBasisPoints === undefined
        ? {}
        : { limitBasisPoints: input.limitBasisPoints }),
    };
    const mempool = {
      observationId: "mempool:main",
      chain: CHAIN,
      writeVisible: input.visible ?? false,
      ...(input.competing === undefined
        ? {}
        : { competingTransactions: input.competing }),
      observedAt: NOW - 500,
    };
    return recordObservationBundle({
      ...benignBundleInput(),
      quoteSlippage: slippage,
      ...(input.priceImpactBasisPoints === undefined
        ? {}
        : {
            quoteLiquidityImpact: {
              declaredImpactCost: {
                asset: USC_ASSET,
                minorUnits: "5000",
              },
              priceImpactBasisPoints: input.priceImpactBasisPoints,
              description: "venue-declared pool impact",
            },
          }),
      quoteObservedAt: NOW - 1_000,
      quoteValidUntil: input.validUntil ?? NOW + 30_000,
      mempool,
    });
  }

  it("detects a slippage limit above the policy max", () => {
    const raw = runAllDetectors(context({ bundle: quoteBundle({ limitBasisPoints: 400 }) }));
    const signal = raw.find((s) => s.code === "slippage_limit_above_policy_max");
    expect(signal).toBeDefined();
    expect(signal!.evidence.deltas?.[0]).toMatchObject({
      label: "slippage_limit_bps",
      observed: "400",
      expected: "300",
    });
  });

  it("detects a VISIBLE swap with sandwich-profitable slippage (critical)", () => {
    const raw = runAllDetectors(
      context({ bundle: quoteBundle({ limitBasisPoints: 250, visible: true, competing: 3 }) }),
    );
    const signal = raw.find(
      (s) => s.code === "visible_swap_with_sandwich_profitable_slippage",
    );
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("critical");
    expect(signal!.evidence.observationRefs).toContain("mempool:main");
  });

  it("an INVISIBLE swap with over-limit slippage is only medium (not the sandwich pattern)", () => {
    const raw = runAllDetectors(
      context({ bundle: quoteBundle({ limitBasisPoints: 400, visible: false }) }),
    );
    expect(
      raw.some((s) => s.code === "visible_swap_with_sandwich_profitable_slippage"),
    ).toBe(false);
    expect(raw.some((s) => s.code === "slippage_limit_above_policy_max")).toBe(true);
  });

  it("detects price impact above the policy max", () => {
    const raw = runAllDetectors(
      context({ bundle: quoteBundle({ priceImpactBasisPoints: 900 }) }),
    );
    expect(raw.some((s) => s.code === "price_impact_above_policy_max")).toBe(true);
  });

  it("detects an expired execution quote", () => {
    const raw = runAllDetectors(
      context({ bundle: quoteBundle({ validUntil: NOW - 1 }) }),
    );
    expect(raw.some((s) => s.code === "quote_expired_at_evaluation")).toBe(true);
  });

  it("a tight invisible quote stays silent", () => {
    const raw = runAllDetectors(
      context({ bundle: quoteBundle({ limitBasisPoints: 100 }) }),
    );
    expect(raw.filter((s) => s.family === "mev_sandwich_exposure")).toEqual([]);
  });
});

describe("family 9 — destination/chain confusion", () => {
  it("detects a route hop on a different chain (one write, one chain)", () => {
    const write = prepareWrite(
      baseWriteRequest({
        route: {
          routeId: "route-x",
          routeHash: "fnv1a64:0000000000000001",
          hops: [{ venue: "venue:bridge-hop", chain: OTHER_CHAIN }],
        },
      }),
      NOW,
    );
    const raw = runAllDetectors(context({ write }));
    const signal = raw.find((s) => s.code === "route_hop_chain_mismatch");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("critical");
  });

  it("detects a write on a chain other than the policy's expected chain", () => {
    const raw = runAllDetectors(
      context({ policy: baseThreatPolicy({ expectedChain: OTHER_CHAIN }) }),
    );
    expect(raw.some((s) => s.code === "write_chain_differs_from_expected")).toBe(true);
  });

  it("detects a destination address active only on OTHER chains", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      addresses: [
        {
          observationId: "address:merchant",
          address: MERCHANT,
          chainsActiveOn: [OTHER_CHAIN],
          observedAt: NOW,
        },
      ],
    });
    const raw = runAllDetectors(context({ bundle }));
    const signal = raw.find((s) => s.code === "destination_address_active_on_other_chains");
    expect(signal).toBeDefined();
    expect(signal!.evidence.observationRefs).toContain("address:merchant");
  });
});

describe("family 10 — replay/signature-domain issues", () => {
  it("detects a previously observed payload digest (replay, critical)", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      domain: {
        observationId: "domain:write-1",
        payloadDigest: "fnv1a64:abcdef0123456789",
        domainRef: "domain:swap-router-v1",
        domainChain: CHAIN,
        digestPreviouslyObserved: true,
        observedAt: NOW,
      },
    });
    const raw = runAllDetectors(context({ bundle }));
    const signal = raw.find((s) => s.code === "payload_digest_previously_observed");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("critical");
  });

  it("detects a signing domain bound to another chain", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      domain: {
        observationId: "domain:write-1",
        payloadDigest: "fnv1a64:abcdef0123456789",
        domainRef: "domain:swap-router-v1",
        domainChain: OTHER_CHAIN,
        digestPreviouslyObserved: false,
        observedAt: NOW,
      },
    });
    const raw = runAllDetectors(context({ bundle }));
    expect(raw.some((s) => s.code === "signature_domain_chain_mismatch")).toBe(true);
  });

  it("detects nonce reuse (exact ms delta)", () => {
    const write = prepareWrite(baseWriteRequest({ nonce: "nonce-42" }), NOW);
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      domain: {
        observationId: "domain:write-1",
        payloadDigest: "fnv1a64:abcdef0123456789",
        domainRef: "domain:swap-router-v1",
        domainChain: CHAIN,
        digestPreviouslyObserved: false,
        nonceLastUsedAt: NOW - 10_000,
        observedAt: NOW,
      },
    });
    const raw = runAllDetectors(context({ write, bundle }));
    const signal = raw.find((s) => s.code === "nonce_previously_used");
    expect(signal).toBeDefined();
    expect(signal!.evidence.deltas?.[0]).toMatchObject({
      label: "nonce_last_used_ms",
      observed: (NOW - 10_000).toString(),
      expected: "0",
    });
  });
});

describe("family 11 — unexpected balance/state deltas", () => {
  it("detects a simulated debit for a holder outside the intent", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const simulation = consistentSimulation(write.writeId, {
      balanceDeltas: [
        {
          holder: "0x7777000000000000000000000000000000000000",
          asset: USC_ASSET,
          amount: { currency: "USC", minorUnits: "777000" },
          direction: "debit",
        },
      ],
      approvals: [],
    });
    const raw = runAllDetectors(context({ write, simulation }));
    const signal = raw.find((s) => s.code === "delta_outside_intent");
    expect(signal).toBeDefined();
    expect(signal!.evidence.deltas?.[0]).toMatchObject({
      label: "delta_minor_units",
      observed: "777000",
      expected: "0",
    });
  });

  it("detects an allowance change the write never requested (sweep, critical)", () => {
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
    const raw = runAllDetectors(context({ write, simulation }));
    const signal = raw.find((s) => s.code === "approval_state_change_outside_intent");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("critical");
  });

  it("the exactly-intended deltas stay silent", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const raw = runAllDetectors(
      context({ write, simulation: consistentSimulation(write.writeId) }),
    );
    expect(raw.filter((s) => s.family === "unexpected_balance_delta")).toEqual([]);
  });
});

describe("family 12 — stale/materially changed simulations", () => {
  it("detects a simulation bound to a DIFFERENT write (critical)", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const simulation = consistentSimulation("write-OTHER");
    const raw = runAllDetectors(context({ write, simulation }));
    const signal = raw.find((s) => s.code === "simulation_bound_to_different_write");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("critical");
  });

  it("detects a simulation older than the policy max age", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const simulation = consistentSimulation(write.writeId, { observedAt: NOW - 60_000 });
    const raw = runAllDetectors(context({ write, simulation }));
    const signal = raw.find((s) => s.code === "simulation_older_than_policy_max_age");
    expect(signal).toBeDefined();
    expect(signal!.evidence.deltas?.[0]).toMatchObject({
      label: "simulation_age_ms",
      observed: "60000",
      expected: "30000",
    });
  });

  it("detects a simulation whose block lags the chain head (blocks delta)", () => {
    const write = prepareWrite(baseWriteRequest(), NOW);
    const simulation = consistentSimulation(write.writeId, { blockRef: "block:900" });
    const raw = runAllDetectors(context({ write, simulation }));
    const signal = raw.find((s) => s.code === "simulation_block_lags_head");
    expect(signal).toBeDefined();
    expect(signal!.evidence.deltas?.[0]).toMatchObject({
      label: "simulation_block_lag",
      observed: "100",
      expected: "6",
    });
    // the write's bundle finality head is 1000 (helpers)
  });

  it("detects a stale observation bundle (corroborating staleness)", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      observedAt: NOW - 60_000,
    });
    const raw = runAllDetectors(context({ bundle }));
    expect(raw.some((s) => s.code === "observation_bundle_stale")).toBe(true);
  });
});

describe("family 13 — finality/reorg anomalies", () => {
  it("detects a reorg deeper than the threshold (critical)", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      finality: {
        observationId: "finality:main",
        chain: CHAIN,
        headBlock: 1_000,
        safeBlock: 995,
        lastReorgDepthBlocks: 5,
        observedAt: NOW,
      },
    });
    const raw = runAllDetectors(context({ bundle }));
    const signal = raw.find((s) => s.code === "reorg_depth_exceeds_threshold");
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe("critical");
    expect(signal!.evidence.deltas?.[0]).toMatchObject({
      label: "reorg_depth_blocks",
      observed: "5",
      expected: "2",
    });
  });

  it("detects a head→safe gap beyond the finality threshold", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      finality: {
        observationId: "finality:main",
        chain: CHAIN,
        headBlock: 1_000,
        safeBlock: 950,
        lastReorgDepthBlocks: 0,
        observedAt: NOW,
      },
    });
    const raw = runAllDetectors(context({ bundle }));
    expect(raw.some((s) => s.code === "finality_lag_exceeds_threshold")).toBe(true);
  });

  it("finality intel for a DIFFERENT chain does not judge this write's chain", () => {
    const bundle = recordObservationBundle({
      ...benignBundleInput(),
      finality: {
        observationId: "finality:other",
        chain: OTHER_CHAIN,
        headBlock: 1_000,
        safeBlock: 950,
        lastReorgDepthBlocks: 9,
        observedAt: NOW,
      },
    });
    const raw = runAllDetectors(context({ bundle }));
    expect(raw.filter((s) => s.family === "finality_reorg_anomaly")).toEqual([]);
  });
});

describe("detector determinism", () => {
  it("the same context always yields identical raw signals (byte-for-byte)", () => {
    const write = prepareWrite(
      baseWriteRequest({
        approvals: [canonicalApproval({ spender: MALICIOUS_SPENDER, minorUnits: "9000000" })],
      }),
      NOW,
    );
    const first = runAllDetectors(context({ write }));
    const second = runAllDetectors(context({ write }));
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
  });
});
