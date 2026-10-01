import { describe, expect, it } from "vitest";
import {
  BASELINE_SEARCHED_PROGRAM,
  BASELINE_WORLD,
  buildLabSearchIndex,
  selectExecutableBlocks,
  registerSearchPlugin,
  listSearchPlugins,
  runSearchPlugin,
} from "@payswap/lab";
import type { LabSearchPlugin } from "@payswap/lab";
import {
  makeCatalogueEntry,
  makeComposedPayoutDefinition,
  makeInstance,
  makeNativeRoutingDefinition,
  makeObservation,
} from "./fixtures.js";

/**
 * Lab search: executable grounding (INV-C05), two-axis UNKNOWN (INV-C01/C02)
 * and incumbent provider-native baselines (INV-C08).
 */

const QUERY = { domain: "payment-routing" } as const;

function nativeSearchIndex() {
  return buildLabSearchIndex({
    definitions: [makeNativeRoutingDefinition()],
    instances: [
      makeInstance({
        instanceId: "inst-native",
        capabilityId: "psp.native-routing",
        simulatedRailId: "rail-a",
      }),
    ],
    observations: [makeObservation({ instanceId: "inst-native" })],
  });
}

/** All four baseline rails bound to executable instances (native on rail-a). */
function fullBaselineSearchIndex() {
  const bindings: { capabilityId: string; railId: string; native: boolean }[] = [
    { capabilityId: "psp.native-routing", railId: "rail-a", native: true },
    { capabilityId: "psp.payouts-b", railId: "rail-b", native: false },
    { capabilityId: "psp.payouts-c", railId: "rail-c", native: false },
    { capabilityId: "psp.payouts-d", railId: "rail-d", native: false },
  ];
  return buildLabSearchIndex({
    definitions: bindings.map((binding) =>
      binding.native
        ? makeNativeRoutingDefinition()
        : makeComposedPayoutDefinition({ capabilityId: binding.capabilityId }),
    ),
    instances: bindings.map((binding) =>
      makeInstance({
        instanceId: `inst-${binding.railId}`,
        capabilityId: binding.capabilityId,
        simulatedRailId: binding.railId,
        currencies: ["EUR", "USD"],
      }),
    ),
    observations: bindings.map((binding) =>
      makeObservation({ instanceId: `inst-${binding.railId}` }),
    ),
  });
}

describe("executable grounding (INV-C05: instance + observation, never catalogue alone)", () => {
  it("a catalogue entry alone NEVER yields an executable block", () => {
    const index = buildLabSearchIndex({
      catalogueEntries: [makeCatalogueEntry({ capabilityId: "psp.payouts" })],
    });
    const { selections, executable } = selectExecutableBlocks(index, QUERY);
    expect(executable).toEqual([]);
    expect(selections.length).toBe(1);
    const selection = selections[0];
    expect(selection?.status).toBe("REJECTED");
    if (selection?.status === "REJECTED") {
      expect(selection.reason).toBe("CATALOGUE_ENTRY_ONLY");
      expect(selection.catalogueEntry?.catalogueEntryId).toBe("cat-psp.payouts");
    }
  });

  it("a definition without a connected instance is rejected, not executable", () => {
    const index = buildLabSearchIndex({
      definitions: [makeComposedPayoutDefinition()],
      catalogueEntries: [makeCatalogueEntry({ capabilityId: "psp.payouts" })],
    });
    const { selections, executable } = selectExecutableBlocks(index, QUERY);
    expect(executable).toEqual([]);
    const rejected = selections.filter((selection) => selection.status === "REJECTED");
    expect(
      rejected.every((selection) => selection.reason === "CATALOGUE_ENTRY_ONLY"),
    ).toBe(true);
  });

  it("an instance without a current observation is not executable", () => {
    const index = buildLabSearchIndex({
      definitions: [makeComposedPayoutDefinition()],
      instances: [
        makeInstance({ instanceId: "inst-payouts", capabilityId: "psp.payouts" }),
      ],
    });
    const { executable, selections } = selectExecutableBlocks(index, QUERY);
    expect(executable).toEqual([]);
    const selection = selections[0];
    expect(selection?.status).toBe("REJECTED");
    if (selection?.status === "REJECTED") {
      expect(selection.reason).toBe("NO_OBSERVATION");
    }
  });

  it("an ACTIVE instance with a current healthy observation IS executable", () => {
    const index = nativeSearchIndex();
    const { executable } = selectExecutableBlocks(index, QUERY);
    expect(executable.length).toBe(1);
    const block = executable[0];
    expect(block?.instance.instanceId).toBe("inst-native");
    expect(block?.effectiveAvailability).toBe("AVAILABLE");
    expect(block?.definition.capabilityId).toBe("psp.native-routing");
  });

  it("the LATEST observation version wins", () => {
    const index = buildLabSearchIndex({
      definitions: [makeNativeRoutingDefinition()],
      instances: [
        makeInstance({ instanceId: "inst-native", capabilityId: "psp.native-routing" }),
      ],
      observations: [
        makeObservation({ instanceId: "inst-native", observationVersion: 1, capabilityState: "UNAVAILABLE" }),
        makeObservation({ instanceId: "inst-native", observationVersion: 2 }),
      ],
    });
    const { executable } = selectExecutableBlocks(index, QUERY);
    expect(executable.length).toBe(1);
    expect(executable[0]?.observation.observationVersion).toBe(2);
  });

  it("authorization, eligibility, currency and geography scope the instance", () => {
    const base = {
      definitions: [makeComposedPayoutDefinition()],
    };
    const revoked = buildLabSearchIndex({
      ...base,
      instances: [
        makeInstance({
          instanceId: "inst-x",
          capabilityId: "psp.payouts",
          authorizationStatus: "REVOKED",
        }),
      ],
      observations: [makeObservation({ instanceId: "inst-x" })],
    });
    expect(selectExecutableBlocks(revoked, QUERY).executable).toEqual([]);

    const ineligible = buildLabSearchIndex({
      ...base,
      instances: [
        makeInstance({ instanceId: "inst-y", capabilityId: "psp.payouts", eligible: false }),
      ],
      observations: [makeObservation({ instanceId: "inst-y" })],
    });
    expect(selectExecutableBlocks(ineligible, QUERY).executable).toEqual([]);

    const currencyMiss = buildLabSearchIndex({
      ...base,
      instances: [
        makeInstance({
          instanceId: "inst-z",
          capabilityId: "psp.payouts",
          currencies: ["JPY"],
        }),
      ],
      observations: [makeObservation({ instanceId: "inst-z" })],
    });
    expect(
      selectExecutableBlocks(currencyMiss, { domain: "payment-routing", currency: "EUR" })
        .executable,
    ).toEqual([]);

    const countryMiss = buildLabSearchIndex({
      ...base,
      instances: [
        makeInstance({ instanceId: "inst-w", capabilityId: "psp.payouts" }),
      ],
      observations: [makeObservation({ instanceId: "inst-w" })],
    });
    expect(
      selectExecutableBlocks(countryMiss, { domain: "payment-routing", country: "JP" })
        .executable,
    ).toEqual([]);
  });
});

describe("two-axis availability (INV-C01/C02: UNKNOWN is never success or failure)", () => {
  it("an UNREACHABLE source surfaces as UNKNOWN with the last-known state carried", () => {
    const index = buildLabSearchIndex({
      definitions: [makeNativeRoutingDefinition()],
      instances: [
        makeInstance({ instanceId: "inst-native", capabilityId: "psp.native-routing" }),
      ],
      observations: [
        makeObservation({ instanceId: "inst-native", sourceAvailability: "UNREACHABLE" }),
      ],
    });
    const { executable, selections } = selectExecutableBlocks(index, QUERY);
    expect(executable).toEqual([]); // never executable...
    const selection = selections[0];
    expect(selection?.status).toBe("UNKNOWN"); // ...but never REJECTED as failure either
    if (selection?.status === "UNKNOWN") {
      expect(selection.effectiveAvailability).toBe("UNKNOWN");
      expect(selection.reason).toBe("SOURCE_UNREACHABLE");
      expect(selection.observation.capabilityState).toBe("AVAILABLE"); // last-known kept
    }
  });

  it("a source-UNKNOWN observation also surfaces as UNKNOWN", () => {
    const index = buildLabSearchIndex({
      definitions: [makeNativeRoutingDefinition()],
      instances: [
        makeInstance({ instanceId: "inst-native", capabilityId: "psp.native-routing" }),
      ],
      observations: [
        makeObservation({ instanceId: "inst-native", sourceAvailability: "UNKNOWN" }),
      ],
    });
    const { selections } = selectExecutableBlocks(index, QUERY);
    const selection = selections[0];
    expect(selection?.status).toBe("UNKNOWN");
    if (selection?.status === "UNKNOWN") {
      expect(selection.reason).toBe("SOURCE_UNKNOWN");
    }
  });

  it("an observation whose stored availability disagrees with the axes is flagged UNKNOWN", () => {
    const inconsistent = {
      ...makeObservation({ instanceId: "inst-native", sourceAvailability: "UNREACHABLE" }),
      availability: "AVAILABLE" as const, // forged: derived must be UNKNOWN
    };
    const index = buildLabSearchIndex({
      definitions: [makeNativeRoutingDefinition()],
      instances: [
        makeInstance({ instanceId: "inst-native", capabilityId: "psp.native-routing" }),
      ],
      observations: [inconsistent],
    });
    const { executable, selections } = selectExecutableBlocks(index, QUERY);
    expect(executable).toEqual([]);
    const selection = selections[0];
    expect(selection?.status).toBe("UNKNOWN");
    if (selection?.status === "UNKNOWN") {
      expect(selection.reason).toBe("AXES_INCONSISTENT");
    }
  });

  it("a two-axis UNAVAILABLE capability is REJECTED (a definite negative, not UNKNOWN)", () => {
    const index = buildLabSearchIndex({
      definitions: [makeNativeRoutingDefinition()],
      instances: [
        makeInstance({ instanceId: "inst-native", capabilityId: "psp.native-routing" }),
      ],
      observations: [
        makeObservation({ instanceId: "inst-native", capabilityState: "UNAVAILABLE" }),
      ],
    });
    const { executable, selections } = selectExecutableBlocks(index, QUERY);
    expect(executable).toEqual([]);
    const selection = selections[0];
    expect(selection?.status).toBe("REJECTED");
    if (selection?.status === "REJECTED") {
      expect(selection.reason).toBe("EFFECTIVELY_UNAVAILABLE");
    }
  });
});

describe("incumbent provider-native baselines (INV-C08)", () => {
  it("a nativeOptimization benchmarkBaseline definition is flagged as the incumbent baseline", () => {
    const index = nativeSearchIndex();
    const { executable } = selectExecutableBlocks(index, QUERY);
    expect(executable[0]?.isIncumbentBaseline).toBe(true);
  });

  it("a non-native definition is NOT flagged as incumbent", () => {
    const index = buildLabSearchIndex({
      definitions: [makeComposedPayoutDefinition()],
      instances: [
        makeInstance({ instanceId: "inst-payouts", capabilityId: "psp.payouts" }),
      ],
      observations: [makeObservation({ instanceId: "inst-payouts" })],
    });
    const { executable } = selectExecutableBlocks(index, QUERY);
    expect(executable[0]?.isIncumbentBaseline).toBe(false);
  });
});

describe("search plug-ins (LAB.md 'Search': replaceable optimizers)", () => {
  it("the deterministic baseline plug-in emits the incumbent native, composed and optimized candidates", () => {
    const index = nativeSearchIndex();
    const candidates = runSearchPlugin("deterministic-baseline", {
      world: BASELINE_WORLD,
      executableBlocks: selectExecutableBlocks(index, QUERY).executable,
      query: QUERY,
    });
    const modes = candidates.map((candidate) => candidate.executionMode);
    expect(modes).toContain("PASS_THROUGH_NATIVE");
    expect(modes).toContain("COMPOSED_PAYSWAP");
    expect(modes).toContain("OPTIMIZED_MULTI_PROVIDER");
    const incumbent = candidates.find((candidate) => candidate.isIncumbentBaseline);
    expect(incumbent?.executionMode).toBe("PASS_THROUGH_NATIVE");
    expect(incumbent?.program.routePreference).toEqual(["rail-a"]);
  });

  it("the searched baseline program in the baseline suite reproduces the plug-in output", () => {
    const index = fullBaselineSearchIndex();
    const candidates = runSearchPlugin("deterministic-baseline", {
      world: BASELINE_WORLD,
      executableBlocks: selectExecutableBlocks(index, QUERY).executable,
      query: QUERY,
    });
    const optimized = candidates.find(
      (candidate) => candidate.candidateId === "search.deterministic-baseline:optimized-multi-provider",
    );
    expect(optimized?.program).toEqual(BASELINE_SEARCHED_PROGRAM);
  });

  it("the plug-in search is deterministic", () => {
    const index = fullBaselineSearchIndex();
    const run = () =>
      runSearchPlugin("deterministic-baseline", {
        world: BASELINE_WORLD,
        executableBlocks: selectExecutableBlocks(index, QUERY).executable,
        query: QUERY,
      });
    expect(run()).toEqual(run());
  });

  it("the hand-designed plug-in produces a netting, screening, latency-first candidate", () => {
    const index = nativeSearchIndex();
    const candidates = runSearchPlugin("hand-designed-baseline", {
      world: BASELINE_WORLD,
      executableBlocks: selectExecutableBlocks(index, QUERY).executable,
      query: QUERY,
    });
    expect(candidates.length).toBe(1);
    const program = candidates[0]?.program;
    expect(program?.useNetting).toBe(true);
    expect(program?.fraudScreening).toBe(true);
    expect(program?.privacyBounded).toBe(true);
  });

  it("custom optimizer plug-ins register and run (evolutionary/bandit/RL plug in here)", () => {
    const custom: LabSearchPlugin = {
      pluginId: "test-custom-optimizer",
      description: "test plug-in",
      search: (input) =>
        input.executableBlocks.length === 0
          ? []
          : [
              {
                candidateId: "custom:1",
                origin: "test-custom-optimizer",
                executionMode: "COMPOSED_PAYSWAP",
                program: {
                  programId: "custom.program",
                  programVersion: "1.0.0",
                  routePreference: ["rail-b"],
                  useNetting: false,
                  useNetworkCredit: false,
                  delayToleranceSteps: 0,
                  fraudScreening: true,
                  privacyBounded: true,
                  authorizationMode: "PROTOCOL_AUTHORIZED",
                },
                instanceRefs: input.executableBlocks.map((block) => block.instance.instanceId),
                isIncumbentBaseline: false,
              },
            ],
    };
    registerSearchPlugin(custom);
    expect(listSearchPlugins().map((plugin) => plugin.pluginId)).toContain(
      "test-custom-optimizer",
    );
    const index = nativeSearchIndex();
    const candidates = runSearchPlugin("test-custom-optimizer", {
      world: BASELINE_WORLD,
      executableBlocks: selectExecutableBlocks(index, QUERY).executable,
      query: QUERY,
    });
    expect(candidates.map((candidate) => candidate.candidateId)).toEqual(["custom:1"]);
  });

  it("an unknown plug-in id is rejected", () => {
    expect(() =>
      runSearchPlugin("no-such-plugin", {
        world: BASELINE_WORLD,
        executableBlocks: [],
        query: QUERY,
      }),
    ).toThrow(/unknown search plugin/);
  });
});
