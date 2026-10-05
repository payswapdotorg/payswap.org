/**
 * Security-vocabulary + convert-fold tests (P4-W4-002 §4): the
 * BLOCK/ALLOW/UNKNOWN people-language fold preserves the typed verdicts
 * exactly (UNKNOWN never rendered as failure or success); the convert
 * fold discloses honestly at both levels.
 *
 * The GateDecision fixtures here are values of the REAL
 * @payswap/onchain-security type — the fold is tested against the typed
 * vocabulary itself, not a lookalike.
 */

import { describe, expect, it } from "vitest";
import type { GateDecision } from "@payswap/onchain-security";

import { foldGateDecision, modeIndicator } from "../src/index.js";
import { convertRequestSummary, foldRouteCompilation } from "../src/index.js";

const allowDecision: GateDecision = {
  decision: "ALLOW",
  checks: [
    { dimension: "spender_approval", outcome: "pass", code: "spender_exact", detail: "allowance is exactly the swap amount" },
    { dimension: "simulation_consistency", outcome: "pass", code: "diff_clean", detail: "state diff matches the quote" },
  ],
  evidenceRefs: ["evidence:sim:1"],
};

const blockDecision: GateDecision = {
  decision: "BLOCK",
  reasons: [
    {
      dimension: "spender_approval",
      code: "unlimited_allowance",
      message: "The contract would grant unlimited USDC spending authority to an untrusted spender.",
      invariantRefs: ["INV-SC02", "rule-28"],
    },
  ],
  checks: [
    { dimension: "spender_approval", outcome: "block", code: "unlimited_allowance", detail: "approval is unbounded" },
  ],
  evidenceRefs: ["evidence:sim:2"],
};

const unknownDecision: GateDecision = {
  decision: "UNKNOWN",
  dimensions: [
    {
      dimension: "simulation_consistency",
      code: "simulation_unavailable",
      message: "No simulation observation is available for this write.",
    },
  ],
  checks: [
    { dimension: "spender_approval", outcome: "pass", code: "spender_exact", detail: "allowance is exactly the swap amount" },
  ],
  evidenceRefs: [],
};

describe("gate vocabulary fold (§3.4)", () => {
  it("preserves the verdict verbatim — the fold never invents a fourth verdict", () => {
    expect(foldGateDecision(allowDecision).verdict).toBe("ALLOW");
    expect(foldGateDecision(blockDecision).verdict).toBe("BLOCK");
    expect(foldGateDecision(unknownDecision).verdict).toBe("UNKNOWN");
  });

  it("BLOCK carries the human reason, the invariant refs and a no-override statement", () => {
    const view = foldGateDecision(blockDecision);
    expect(view.tone).toBe("danger");
    expect(view.headline).toContain("blocked");
    expect(view.explanation).toContain("no setting");
    expect(view.drilldown.join(" ")).toContain("unlimited USDC spending authority");
    expect(view.drilldown.join(" ")).toContain("INV-SC02");
    expect(view.evidenceRefs).toEqual(["evidence:sim:2"]);
  });

  it("UNKNOWN renders as neither failure nor success", () => {
    const view = foldGateDecision(unknownDecision);
    expect(view.tone).toBe("warning");
    expect(view.headline).toContain("not yet decided");
    expect(view.explanation).toContain("neither failure nor success");
    expect(view.drilldown.join(" ")).toContain("simulation_unavailable");
  });

  it("ALLOW lists what passed without claiming blanket trust", () => {
    const view = foldGateDecision(allowDecision);
    expect(view.tone).toBe("success");
    expect(view.explanation).toContain("authorizes this action only");
    expect(view.drilldown.join(" ")).toContain("spender_exact");
  });
});

describe("mode indicator contract (§3.5, directive §13)", () => {
  it("test + testnet is visibly distinct from live + mainnet", () => {
    const test = modeIndicator({ testOrLive: "TEST", onchain: true, testnet: true });
    const live = modeIndicator({ testOrLive: "LIVE", onchain: true, testnet: false });
    expect(test.testOrLive).toBe("TEST");
    expect(test.testnetOrMainnet).toBe("TESTNET");
    expect(test.note).toContain("no real money");
    expect(live.testOrLive).toBe("LIVE");
    expect(live.testnetOrMainnet).toBe("MAINNET");
    expect(live.note).toContain("real money");
  });

  it("fiat-only surfaces honestly mark the network dimension not applicable", () => {
    const fiat = modeIndicator({ testOrLive: "TEST", onchain: false, testnet: false });
    expect(fiat.testnetOrMainnet).toBe("NOT-APPLICABLE");
  });
});

describe("convert disclosure fold (§3.1 Convert)", () => {
  const compiled = foldRouteCompilation({
    status: "ROUTES_COMPILED",
    plans: [
      {
        planId: "route-plan:intent-1:mixed-dex-offramp",
        shapeId: "mixed-dex-offramp",
        candidateStatus: "EXECUTABLE_CANDIDATE",
        compositionClass: "MIXED",
        isProviderNativeBaseline: false,
        legs: [
          { legKind: "ONCHAIN_DEX_SWAP" },
          { legKind: "OFF_RAMP_PAYOUT" },
          { legKind: "BANK_SETTLEMENT" },
        ],
      },
      {
        planId: "route-plan:intent-1:provider-native",
        shapeId: "provider-native",
        candidateStatus: "PROVIDER_NATIVE_BASELINE",
        compositionClass: "FIAT_ONLY",
        isProviderNativeBaseline: true,
        legs: [{ legKind: "FIAT_PSP_COLLECT" }],
      },
      {
        planId: "route-plan:intent-1:risky",
        shapeId: "risky",
        candidateStatus: "INELIGIBLE_CANDIDATE",
        compositionClass: "ONCHAIN_ONLY",
        isProviderNativeBaseline: false,
        legs: [{ legKind: "ONCHAIN_BRIDGE" }],
        ineligibilityReasons: [
          { legId: "leg-2", code: "gate_block", detail: "bridge gate returned BLOCK" },
        ],
      },
    ],
    exclusions: [{ shapeId: "no-rail", reasons: ["no capability observation for the rail"] }],
  });

  it("counts executable/baseline/ineligible/excluded honestly", () => {
    expect(compiled.counts).toEqual({
      totalPlans: 3,
      executable: 1,
      baselines: 1,
      ineligible: 1,
      excludedShapes: 1,
    });
    expect(compiled.nothingExecutable).toBe(false);
    expect(compiled.outcomeLine).toContain("1 executable route plan");
    expect(compiled.outcomeLine).toContain("provider-native baseline");
    expect(compiled.outcomeLine).toContain("ineligible");
  });

  it("advanced view carries the leg chain and verbatim ineligibility reasons", () => {
    const mixed = compiled.plans.find((plan) => plan.shapeId === "mixed-dex-offramp");
    expect(mixed?.legChain).toEqual(["ONCHAIN_DEX_SWAP", "OFF_RAMP_PAYOUT", "BANK_SETTLEMENT"]);
    const ineligible = compiled.plans.find((plan) => plan.shapeId === "risky");
    expect(ineligible?.ineligibilityReasons.join(" ")).toContain("bridge gate returned BLOCK");
    expect(ineligible?.ineligibilityReasons.join(" ")).toContain("leg-2");
  });

  it("marks the provider-native baseline with the never-ranked-away note", () => {
    const baseline = compiled.plans.find((plan) => plan.shapeId === "provider-native");
    expect(baseline?.baselineNote).toContain("never ranked away");
  });

  it("exclusions are disclosed, never silently dropped", () => {
    expect(compiled.exclusions[0]?.shapeId).toBe("no-rail");
    expect(compiled.exclusions[0]?.reasons[0]).toContain("no capability observation");
  });

  it("an all-ineligible compilation leads with that honest fact (not a failure tone)", () => {
    const empty = foldRouteCompilation({
      status: "ROUTES_COMPILED",
      plans: [
        {
          planId: "p1",
          shapeId: "only",
          candidateStatus: "INELIGIBLE_CANDIDATE",
          compositionClass: "FIAT_ONLY",
          isProviderNativeBaseline: false,
          legs: [{ legKind: "BANK_SETTLEMENT" }],
          ineligibilityReasons: [{ legId: "l1", code: "stale_quote", detail: "quote expired" }],
        },
      ],
    });
    expect(empty.nothingExecutable).toBe(true);
    expect(empty.outcomeLine).toContain("No executable route right now");
    expect(empty.outcomeLine).toContain("nothing was silently dropped");
  });

  it("a bare compilation result (no plans/exclusions) folds to the honest empty headline", () => {
    const bare = foldRouteCompilation({ status: "ROUTES_COMPILED" });
    expect(bare.counts.totalPlans).toBe(0);
    expect(bare.nothingExecutable).toBe(true);
  });

  it("the request summary is exact minor units, never a float rewrite", () => {
    expect(
      convertRequestSummary({
        sourceCurrency: "usd",
        targetCurrency: "ETH",
        amountMinorUnits: 250000n,
      }),
    ).toBe("Convert 250000 (minor units) USD → ETH");
  });
});
