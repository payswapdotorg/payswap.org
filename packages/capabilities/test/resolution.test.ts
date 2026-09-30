import { describe, expect, it } from "vitest";
import { resolveCapability } from "../src/index.js";
import type {
  Capability,
  CapabilityGraph,
  CapabilityGraphEntry,
  CapabilityResolveRequest,
} from "../src/index.js";

/**
 * W2-002 — deterministic capability resolution: class + condition matching,
 * two-axis availability, provenance carried, and INV-C02 — an unreachable
 * source means the candidate is LISTED with UNKNOWN availability, never
 * filtered out and never mapped to success (INV-X01).
 */

function capability(
  id: string,
  capabilityClass: Capability["capabilityClass"],
  kinds: readonly Capability["conditions"][number]["kind"][],
): Capability {
  return {
    id,
    capabilityClass,
    conditions: kinds.map((kind) => ({
      kind,
      description: `${kind} constraint for ${id}`,
      hardConstraint: true,
    })),
    cost: [],
    risk: { riskClass: "settlement", severity: "low", mitigations: ["reconciliation"] },
    provenance: {
      declaredBy: `provider:${id}`,
      artifactRef: `provider:${id}/manifest@1`,
      contentHash: `fnv1a64:${id.length.toString(16).padStart(4, "0")}`,
    },
    economicAccountability: {
      accountablePartyRef: `provider:${id}`,
      ledgerAccountRef: "ledger:fees",
      recoursePolicyRef: "policy:recourse",
    },
    proofRequirements: [{ proofLevel: "P2", scope: "settlement" }],
  };
}

function entry(
  cap: Capability,
  sourceId: string,
  capabilityState: CapabilityGraphEntry["capabilityState"],
  sourceAvailability: CapabilityGraphEntry["sourceAvailability"],
): CapabilityGraphEntry {
  return { capability: cap, sourceId, capabilityState, sourceAvailability };
}

const sepaCompliant = capability("cap:sepa-ct", "rail_movement", ["jurisdiction", "compliance"]);
const sepaPlain = capability("cap:sepa-basic", "rail_movement", ["jurisdiction"]);
const liquidity = capability("cap:eur-liquidity", "liquidity", ["compliance"]);
const acceptance = { ...capability("cap:merchant-acc", "merchant_acceptance", []), capabilityClass: "merchant_acceptance" as const };

const graph: CapabilityGraph = {
  entries: [
    entry(sepaCompliant, "source:registry-a", "AVAILABLE", "REACHABLE"),
    entry(sepaPlain, "source:registry-b", "AVAILABLE", "UNREACHABLE"),
    entry(liquidity, "source:lp-fund", "AVAILABLE", "REACHABLE"),
    entry(acceptance, "source:merchant-123", "AVAILABLE", "REACHABLE"),
  ],
};

function request(overrides: Partial<CapabilityResolveRequest> = {}): CapabilityResolveRequest {
  return { capabilityClass: "rail_movement", ...overrides };
}

describe("resolveCapability — class and condition matching", () => {
  it("matches by class only when no condition kinds are required", () => {
    const resolution = resolveCapability(graph, request());
    expect(resolution.candidates.map((c) => c.capability.id)).toEqual([
      "cap:sepa-ct",
      "cap:sepa-basic",
    ]);
  });

  it("never cross-substitutes classes: acceptance is not a funding source", () => {
    const liquidityOnly = resolveCapability(graph, request({ capabilityClass: "liquidity" }));
    expect(liquidityOnly.candidates.map((c) => c.capability.id)).toEqual(["cap:eur-liquidity"]);
    const funding = resolveCapability(graph, request({ capabilityClass: "merchant_acceptance" }));
    expect(funding.candidates.map((c) => c.capability.id)).toEqual(["cap:merchant-acc"]);
    // a rail_movement request never picks up liquidity or acceptance entries
    const rails = resolveCapability(graph, request({ capabilityClass: "rail_movement" }));
    expect(rails.candidates.every((c) => c.capability.capabilityClass === "rail_movement")).toBe(true);
  });

  it("requires every requested condition kind to be declared (hard constraints first)", () => {
    const resolution = resolveCapability(graph, request({ requiredConditionKinds: ["jurisdiction", "compliance"] }));
    expect(resolution.candidates.map((c) => c.capability.id)).toEqual(["cap:sepa-ct"]);
    const missing = resolveCapability(graph, request({ requiredConditionKinds: ["eligibility"] }));
    expect(missing.candidates).toEqual([]);
    expect(missing.selected).toBeUndefined();
  });
});

describe("resolveCapability — two-axis availability (INV-C01/C02)", () => {
  it("resolves every (state, source) pair deterministically", () => {
    const cases: readonly [
      CapabilityGraphEntry["capabilityState"],
      CapabilityGraphEntry["sourceAvailability"],
      string,
    ][] = [
      ["AVAILABLE", "REACHABLE", "AVAILABLE"],
      ["DEGRADED", "REACHABLE", "DEGRADED"],
      ["UNAVAILABLE", "REACHABLE", "UNAVAILABLE"],
      ["AVAILABLE", "UNREACHABLE", "UNKNOWN"],
      ["DEGRADED", "UNKNOWN", "UNKNOWN"],
      ["UNAVAILABLE", "UNREACHABLE", "UNKNOWN"],
    ];
    for (const [capabilityState, sourceAvailability, expected] of cases) {
      const twoAxis: CapabilityGraph = {
        entries: [entry(sepaCompliant, "source:x", capabilityState, sourceAvailability)],
      };
      const resolution = resolveCapability(twoAxis, request());
      expect(resolution.candidates[0]?.effectiveAvailability).toBe(expected);
    }
  });

  it("UNREACHABLE source: the candidate is LISTED with UNKNOWN, never filtered out (INV-C02)", () => {
    const unreachable: CapabilityGraph = {
      entries: [entry(sepaCompliant, "source:dark", "AVAILABLE", "UNREACHABLE")],
    };
    const resolution = resolveCapability(unreachable, request());
    expect(resolution.candidates).toHaveLength(1);
    expect(resolution.candidates[0]?.effectiveAvailability).toBe("UNKNOWN");
    expect(resolution.candidates[0]?.sourceAvailability).toBe("UNREACHABLE");
    expect(resolution.candidates[0]?.capabilityState).toBe("AVAILABLE");
    // UNKNOWN never selects: there is no success to report (INV-X01)
    expect(resolution.selected).toBeUndefined();
  });

  it("carries provenance for every candidate", () => {
    const resolution = resolveCapability(graph, request());
    expect(resolution.candidates[0]?.provenance).toEqual(sepaCompliant.provenance);
    expect(resolution.candidates[0]?.sourceId).toBe("source:registry-a");
  });
});

describe("resolveCapability — deterministic selection", () => {
  it("selects the FIRST AVAILABLE candidate in graph order", () => {
    const resolution = resolveCapability(graph, request());
    expect(resolution.selected?.capability.id).toBe("cap:sepa-ct");
    expect(resolution.selected?.effectiveAvailability).toBe("AVAILABLE");
  });

  it("skips non-AVAILABLE candidates deterministically", () => {
    const mixed: CapabilityGraph = {
      entries: [
        entry(sepaPlain, "source:down", "AVAILABLE", "UNREACHABLE"), // UNKNOWN
        entry(sepaCompliant, "source:degraded", "DEGRADED", "REACHABLE"), // DEGRADED
        entry(capability("cap:sepa-backup", "rail_movement", []), "source:ok", "AVAILABLE", "REACHABLE"),
      ],
    };
    const resolution = resolveCapability(mixed, request());
    expect(resolution.candidates.map((c) => c.effectiveAvailability)).toEqual([
      "UNKNOWN",
      "DEGRADED",
      "AVAILABLE",
    ]);
    expect(resolution.selected?.capability.id).toBe("cap:sepa-backup");
  });

  it("no AVAILABLE candidate ⇒ selected undefined, candidates intact", () => {
    const allUnknown: CapabilityGraph = {
      entries: [entry(sepaCompliant, "source:a", "AVAILABLE", "UNKNOWN")],
    };
    const resolution = resolveCapability(allUnknown, request());
    expect(resolution.candidates).toHaveLength(1);
    expect(resolution.selected).toBeUndefined();
  });

  it("identical inputs produce identical resolutions (determinism)", () => {
    const one = resolveCapability(graph, request({ requiredConditionKinds: ["jurisdiction"] }));
    const two = resolveCapability(graph, request({ requiredConditionKinds: ["jurisdiction"] }));
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(one.request).toEqual(two.request);
  });

  it("carries the request back on the resolution", () => {
    const resolution = resolveCapability(graph, request({ capabilityClass: "liquidity" }));
    expect(resolution.request.capabilityClass).toBe("liquidity");
  });
});
