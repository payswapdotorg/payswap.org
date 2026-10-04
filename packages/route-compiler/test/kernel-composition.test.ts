/**
 * REAL kernel composition proof (Work Order P4-W4-001 task-packet hard
 * requirement 7): the compiled journeys are produced by the REAL merged
 * kernels — no shadow models. This suite proves it mechanically:
 *
 * - the DEX lane is a REAL mixed-rail OnchainLaneProof produced by the REAL
 *   best-execution engine over the REAL Uniswap v2 reference venue pack
 *   (the v2 constant-product math is verified against an independent
 *   computation from the injected pool state);
 * - the kernel write pipeline artifacts (prepared write digests, gate
 *   decisions with guard checks, expected diffs) are the onchain-security
 *   kernel's own;
 * - the off-ramp payout authorization is the REAL connectors payout gate
 *   report with its six gates;
 * - the bank arrival is derived by the canonical settlementResultFrom;
 * - the opportunity context is resolved + policy-evaluated by the REAL
 *   W3-002 kernel, and discovery STRUCTURALLY never authorizes;
 * - the security kernel's secret law (assertNoSecretMaterial) accepts every
 *   compiled plan (agent-facing artifacts carry no secrets);
 * - the provider-native baselines derive from real nativeOptimization
 *   declarations (INV-C08) — both the venue-native lane baseline and the
 *   fiat capability baseline.
 */

import { describe, expect, it } from "vitest";
import { assertNoSecretMaterial, evaluateOnchainWriteGates, prepareWrite } from "@payswap/onchain-security";
import { discoveryPermitsExecution, resolveOpportunity } from "@payswap/onchain-opportunities";
import { evaluatePayoutGate } from "@payswap/connectors";
import { settlementResultFrom } from "@payswap/payment";
import {
  compileBase,
  route1Intent,
  route2Intent,
  liquidityOpportunity,
  baseSecurityPolicy,
  baseSecurityState,
  NOW,
  deepEthUscPool,
  makePayoutActivation,
  merchantBankEuroDestination,
  groundedPlannedAmount,
  OFFRAMP_PROVIDER,
  MERCHANT_BANK_IBAN,
} from "./fixtures.js";

describe("the DEX lane is a REAL engine-selected lane over the REAL Uniswap pack", () => {
  it("carries the real venue identity, quote provenance and engine artifacts", () => {
    const result = compileBase(route1Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const swap = plan.legs[0] as Extract<typeof plan.legs[number], { legKind: "ONCHAIN_DEX_SWAP" }>;
    const lane = swap.lane;
    expect(lane.venueId).toBe("uniswap-v2");
    expect(lane.quote.provenance.source).toBe("INDEXED_POOL_STATE");
    expect(lane.quote.provenance.evidenceRefs).toContain("evidence:pool-state:pair:eth-usc");
    expect(lane.quote.observer.observerKind).toBe("INDEXER");
    expect(lane.routeRef).toBeDefined();
    expect(lane.routeHash).toBeDefined();
    expect(lane.write.writeDigest.startsWith("fnv1a64:")).toBe(true);
    expect(lane.gateDecision.decision).toBe("ALLOW");
    expect(lane.gateDecision.evidenceRefs.some((ref) => ref.startsWith("policy:"))).toBe(true);
    expect(lane.inputAssetObservation.observationId).toBe("route-obs:eth:owner:1");
  });

  it("the v2 constant-product math is the pack's own (verified independently)", () => {
    const result = compileBase(route1Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const swap = plan.legs[0] as Extract<typeof plan.legs[number], { legKind: "ONCHAIN_DEX_SWAP" }>;
    // Independent v2 computation from the injected pool state:
    // out = reserveA * amountIn * 997 / (reserveB * 1000 + amountIn * 997)
    const pool = deepEthUscPool();
    const amountIn = BigInt(route1Intent().originAmount.minorUnits);
    const expected =
      (BigInt(pool.reserveAMinorUnits) * amountIn * 997n) /
      (BigInt(pool.reserveBMinorUnits) * 1000n + amountIn * 997n);
    expect(swap.lane.quote.slippage.expectedOutput?.minorUnits).toBe(expected.toString());
    const worstCase = (expected * 9950n) / 10000n;
    expect(swap.lane.quote.slippage.worstCaseOutput.minorUnits).toBe(worstCase.toString());
    // The planned hop amount is the GUARANTEED worst-case output.
    expect(swap.plannedAmount.basis).toBe("QUOTE_GROUNDED");
    expect(groundedPlannedAmount(swap.plannedAmount)).toEqual(
      swap.lane.quote.slippage.worstCaseOutput,
    );
  });

  it("the lane carries the venue-native incumbent baseline declaration (INV-C08)", () => {
    const result = compileBase(route1Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const swap = plan.legs[0] as Extract<typeof plan.legs[number], { legKind: "ONCHAIN_DEX_SWAP" }>;
    expect(swap.lane.isVenueNativeBaseline).toBe(true);
    expect(swap.lane.quote.optimizationOrigin).toBe("PROVIDER_NATIVE");
  });
});

describe("the kernel write pipeline artifacts are the onchain-security kernel's own", () => {
  it("the deposit write is reproducible through the kernel prepare/gate pipeline", () => {
    const result = compileBase(route1Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const deposit = plan.legs[1] as Extract<typeof plan.legs[number], { legKind: "ONCHAIN_TRANSFER" }>;
    // Re-prepare the identical write through the REAL kernel functions
    // (only the keys that are actually present are forwarded —
    // exactOptionalPropertyTypes discipline, runtime-identical).
    const reproduced = prepareWrite(
      {
        writeId: deposit.write.writeId,
        action: "onchain.transfer",
        chain: deposit.write.chain,
        ...(deposit.write.transfer !== undefined ? { transfer: deposit.write.transfer } : {}),
        approvals: [],
        route: deposit.write.route,
        expiry: deposit.write.expiry,
        requestedBy: deposit.write.requestedBy,
        ...(deposit.write.settlementInstruction !== undefined
          ? { settlementInstruction: deposit.write.settlementInstruction }
          : {}),
      },
      NOW,
    );
    expect(reproduced.writeDigest).toBe(deposit.write.writeDigest);
    const reGated = evaluateOnchainWriteGates({
      write: reproduced,
      policy: baseSecurityPolicy(),
      securityState: baseSecurityState(),
      at: NOW,
    });
    expect(reGated.decision).toBe("ALLOW");
    expect(deposit.expectedDiff).toBeDefined();
  });

  it("a BLOCKed gate verdict is carried honestly (never coerced to executable)", () => {
    // Destination not permitted → the deterministic gate BLOCKs.
    const result = compileBase(route1Intent(), {
      onchainSecurity: {
        policy: baseSecurityPolicy({
          allowedDestinations: ["0x9999999999999999999999999999999999999999"],
        }),
        state: baseSecurityState(),
      },
    });
    const plan = result.plans.find((plan) => plan.shapeId === "provider-native-offramp");
    expect(plan).toBeDefined();
    expect(plan!.candidateStatus).toBe("INELIGIBLE_CANDIDATE");
    const reason = plan!.ineligibilityReasons.find((r) => r.code === "ONCHAIN_GATE_BLOCK");
    expect(reason).toBeDefined();
    expect(reason!.detail).toContain("not a permitted beneficiary");
    // The mixed shape's deposit write also BLOCKs → also ineligible, honestly.
    const mixed = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp");
    expect(mixed!.candidateStatus).toBe("INELIGIBLE_CANDIDATE");
  });
});

describe("the off-ramp payout authorization is the REAL connectors payout gate", () => {
  it("the leg's gate report is reproducible through evaluatePayoutGate", () => {
    const result = compileBase(route1Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const payout = plan.legs[2] as Extract<typeof plan.legs[number], { legKind: "OFF_RAMP_PAYOUT" }>;
    // All six canonical gates are reported.
    const gateNames = payout.gate.checks.map((check) => check.gate);
    for (const expected of [
      "TRANSFER_OUT_GRANT_EXISTS",
      "TRANSFER_OUT_CURRENCY_SCOPE",
      "TRANSFER_OUT_LIMITS",
      "TRANSFER_OUT_NOT_EXPIRED",
      "DESTINATION_EXPLICIT_EXTERNAL",
      "PROVIDER_STEP_UP",
    ]) {
      expect(gateNames).toContain(expected);
    }
    // Reproducible: the same activation + request re-evaluates to the same report.
    expect(payout.plannedAmount.basis).toBe("CONVERSION_GROUNDED");
    const payoutAmount = groundedPlannedAmount(payout.plannedAmount);
    const reEvaluated = evaluatePayoutGate(
      makePayoutActivation({ instanceId: "instance:psp-payouts:1" }),
      {
        connectorCapabilityId: "psp.payouts",
        transferOutAuthorizationId: "transfer-out:intent:route-1:crypto-dex-offramp-bank",
        destination: payout.destination,
        amountMinor: Number(payoutAmount.minorUnits),
        currency: payoutAmount.currency,
        protocolKey: "route:intent:route-1:crypto-dex-offramp-bank",
        authorizationEvidenceRef: "authz:intent:route-1",
        requestedAt: new Date(NOW).toISOString(),
      },
    );
    expect(reEvaluated.allowed).toBe(payout.gate.allowed);
    // Connection scope alone NEVER passes: an activation without the
    // transfer-out grant closes the gate (TRANSFER_OUT_NOT_AUTHORIZED).
    const { transferOut: _omitted, ...activationWithoutGrant } = makePayoutActivation();
    const noGrant = evaluatePayoutGate(activationWithoutGrant, {
      connectorCapabilityId: "psp.payouts",
      transferOutAuthorizationId: "transfer-out:intent:route-1:crypto-dex-offramp-bank",
      destination: payout.destination,
      amountMinor: Number(payoutAmount.minorUnits),
      currency: payoutAmount.currency,
      protocolKey: "route:intent:route-1:crypto-dex-offramp-bank",
      authorizationEvidenceRef: "authz:intent:route-1",
      requestedAt: new Date(NOW).toISOString(),
    });
    expect(noGrant.allowed).toBe(false);
    expect(noGrant.checks[0]!.pass).toBe(false);
  });

  it("a closed payout gate (no transfer-out grant) makes the shape honestly ineligible", () => {
    const { transferOut: _omitted, ...activationWithoutGrant } = makePayoutActivation();
    const result = compileBase(route1Intent(), {
      fiatActivations: [activationWithoutGrant],
    });
    for (const shapeId of ["mixed-dex-offramp", "provider-native-offramp"]) {
      const plan = result.plans.find((plan) => plan.shapeId === shapeId);
      expect(plan).toBeDefined();
      expect(plan!.candidateStatus).toBe("INELIGIBLE_CANDIDATE");
      expect(
        plan!.ineligibilityReasons.some((r) => r.code === "PAYOUT_GATE_CLOSED"),
      ).toBe(true);
    }
  });
});

describe("the bank arrival is derived by the canonical payment-plane function", () => {
  it("settlementResultFrom derives the external destination — never re-declared", () => {
    const result = compileBase(route1Intent());
    const plan = result.plans.find((plan) => plan.shapeId === "mixed-dex-offramp")!;
    const bank = plan.legs[3] as Extract<typeof plan.legs[number], { legKind: "BANK_SETTLEMENT" }>;
    expect(bank.settlementResult.destinationKind).toBe("BANK_ACCOUNT");
    expect(bank.settlementResult.externalRef).toBe(MERCHANT_BANK_IBAN);
    expect(bank.settlementResult).toEqual(
      settlementResultFrom(merchantBankEuroDestination()),
    );
  });
});

describe("the opportunity context is composed through the REAL W3-002 kernel", () => {
  it("resolves + policy-evaluates each opportunity at the compile instant", () => {
    const result = compileBase(route1Intent());
    expect(result.opportunityGrounding).toHaveLength(1);
    const grounding = result.opportunityGrounding[0]!;
    expect(grounding.opportunityId).toContain("liquidity");
    expect(grounding.resolvedStatus).toBe("CURRENT");
    expect(grounding.eligible).toBe(true);
    expect(grounding.reasons).toHaveLength(0);
    expect(grounding.evaluatedAt).toBe(NOW);
  });

  it("a stale opportunity is invalidated with reasons — never silently dropped", () => {
    const stale = liquidityOpportunity({ freshnessAgeMs: 60_000 });
    const result = compileBase(route1Intent(), { opportunityObservations: [stale] });
    const grounding = result.opportunityGrounding[0]!;
    expect(grounding.resolvedStatus).toBe("STALE");
    expect(grounding.eligible).toBe(false);
    expect(grounding.reasons).toContain("STALE_OBSERVATION");
    // The kernel's own resolution agrees (defense in depth).
    const resolved = resolveOpportunity(stale, NOW);
    expect(resolved.status).toBe("STALE");
  });

  it("discovery STRUCTURALLY never authorizes (the W3-002 law, composed verbatim)", () => {
    const result = compileBase(route1Intent());
    expect(result.discoveryPermitsExecution).toBe(false);
    expect(discoveryPermitsExecution()).toBe(false);
    // Even an ELIGIBLE, CURRENT opportunity never yields an executable leg:
    // no plan leg references any opportunity id as authorization.
    for (const plan of result.plans) {
      for (const leg of plan.legs) {
        expect(
          JSON.stringify(leg.authorizationLineage.legAuthorization).includes("opportunity"),
        ).toBe(false);
        expect(leg.authorizationLineage.legAuthorization.kind).not.toBe("OPPORTUNITY");
      }
    }
  });
});

describe("the kernel secret law accepts every compiled plan (agent-facing artifacts)", () => {
  it("assertNoSecretMaterial passes on every plan of every representative route", () => {
    for (const intent of [route1Intent(), route2Intent()]) {
      const result = compileBase(intent);
      for (const plan of result.plans) {
        expect(() => assertNoSecretMaterial(plan, `plan ${plan.planId}`)).not.toThrow();
      }
    }
  });
});

describe("provider-native baselines derive from real nativeOptimization declarations (INV-C08)", () => {
  it("the fiat baseline is the capability whose definition declares benchmarkBaseline", () => {
    const result = compileBase(route2Intent());
    const baseline = result.plans.find(
      (plan) => plan.shapeId === "provider-native-onramp",
    )!;
    expect(baseline).toBeDefined();
    // The native instance is the psp.native-routing capability instance.
    const collect = baseline.legs[0] as Extract<
      typeof baseline.legs[number],
      { legKind: "FIAT_PSP_COLLECT" }
    >;
    expect(collect.instance.capabilityId).toBe("psp.native-routing");
    expect(collect.instance.providerName).toBe(OFFRAMP_PROVIDER);
  });
});
