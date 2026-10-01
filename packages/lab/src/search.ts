/**
 * Lab search: executable capability discovery + replaceable search plug-ins
 * (W2-004; FROZEN-ARCHITECTURE §19; LAB.md "Search"; INV-C01/C02/C05/C08).
 *
 * INV-C05 — provider-backed executable selection is grounded in
 * ConnectedCapabilityInstance + CapabilityObservation, NEVER in provider
 * catalogue definitions alone. A catalogue entry with no connected
 * instance is returned as an explicit REJECTED selection with reason
 * CATALOGUE_ENTRY_ONLY; it can never produce an executable block.
 *
 * INV-C01/C02 — the two availability axes are kept separate and are
 * re-derived here from (capabilityState, sourceAvailability) via the
 * canonical resolver. An observation whose source is UNREACHABLE or UNKNOWN
 * yields effective availability UNKNOWN: it is surfaced as such (never
 * success, never failure) and is never executable.
 *
 * INV-C08 — a capability definition declaring nativeOptimization with
 * benchmarkBaseline === true is returned as an INCUMBENT BASELINE block.
 * Search treats it exactly like any other block: it can win or lose on
 * evidence, and nothing here ranks PaySwap composition above it.
 */

import { resolveEffectiveAvailability } from "@payswap/capabilities";
import type { CapabilityClass, EffectiveAvailability } from "@payswap/capabilities";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectedCapabilityInstance,
  ConnectorCapabilityKind,
  ExecutionMode,
  ProviderCatalogueEntry,
} from "@payswap/connectors";
import type { SimulatedWorld, SimulationProgram } from "./simulation.js";

// ---------------------------------------------------------------------------
// Executable grounding (INV-C05)
// ---------------------------------------------------------------------------

export interface LabSearchQuery {
  readonly domain: string;
  readonly currency?: string;
  readonly capabilityClass?: CapabilityClass;
  readonly connectorCapabilityKind?: ConnectorCapabilityKind;
  readonly executionMode?: ExecutionMode;
  readonly country?: string;
}

/** Why a definition did not yield an executable block. */
export type SearchRejectionReason =
  | "CATALOGUE_ENTRY_ONLY"
  | "NO_CONNECTED_INSTANCE"
  | "NO_OBSERVATION"
  | "AUTHORIZATION_NOT_ACTIVE"
  | "NOT_ELIGIBLE"
  | "CURRENCY_NOT_SUPPORTED"
  | "GEOGRAPHY_NOT_SUPPORTED"
  | "EFFECTIVELY_UNAVAILABLE";

export type SearchSelection =
  | {
      readonly status: "EXECUTABLE";
      readonly definition: CapabilityDefinition;
      readonly instance: ConnectedCapabilityInstance;
      readonly observation: CapabilityObservation;
      readonly effectiveAvailability: "AVAILABLE" | "DEGRADED";
      /** INV-C08: incumbent provider-native baseline block. */
      readonly isIncumbentBaseline: boolean;
    }
  | {
      readonly status: "UNKNOWN";
      readonly definition?: CapabilityDefinition;
      readonly instance: ConnectedCapabilityInstance;
      readonly observation: CapabilityObservation;
      /**
       * Two-axis UNKNOWN is surfaced verbatim — never converted into
       * success or failure (INV-C01/C02).
       */
      readonly effectiveAvailability: "UNKNOWN";
      readonly reason: "SOURCE_UNREACHABLE" | "SOURCE_UNKNOWN" | "AXES_INCONSISTENT";
    }
  | {
      readonly status: "REJECTED";
      readonly definition: CapabilityDefinition | undefined;
      readonly catalogueEntry: ProviderCatalogueEntry | undefined;
      readonly reason: SearchRejectionReason;
      readonly detail: string;
    };

/** An executable block: definition + live instance + current observation. */
export interface ExecutableBlock {
  readonly definition: CapabilityDefinition;
  readonly instance: ConnectedCapabilityInstance;
  readonly observation: CapabilityObservation;
  readonly effectiveAvailability: "AVAILABLE" | "DEGRADED";
  readonly isIncumbentBaseline: boolean;
}

export interface LabSearchIndex {
  readonly definitions: readonly CapabilityDefinition[];
  readonly instances: readonly ConnectedCapabilityInstance[];
  readonly observations: readonly CapabilityObservation[];
  readonly catalogueEntries: readonly ProviderCatalogueEntry[];
}

export function buildLabSearchIndex(input: {
  definitions?: readonly CapabilityDefinition[];
  instances?: readonly ConnectedCapabilityInstance[];
  observations?: readonly CapabilityObservation[];
  catalogueEntries?: readonly ProviderCatalogueEntry[];
}): LabSearchIndex {
  return {
    definitions: [...(input.definitions ?? [])],
    instances: [...(input.instances ?? [])],
    observations: [...(input.observations ?? [])],
    catalogueEntries: [...(input.catalogueEntries ?? [])],
  };
}

/** Latest observation per instance (deterministic: highest version wins). */
function latestObservation(
  index: LabSearchIndex,
  instanceId: string,
): CapabilityObservation | undefined {
  let latest: CapabilityObservation | undefined;
  for (const observation of index.observations) {
    if (observation.instanceId !== instanceId) {
      continue;
    }
    if (
      latest === undefined ||
      observation.observationVersion > latest.observationVersion
    ) {
      latest = observation;
    }
  }
  return latest;
}

/**
 * Selects executable blocks for a query. Every definition is resolved
 * against connected instances and CURRENT observations; catalogue entries
 * participate only to explain rejections (INV-C05).
 */
export function selectExecutableBlocks(
  index: LabSearchIndex,
  query: LabSearchQuery,
): { readonly selections: readonly SearchSelection[]; readonly executable: readonly ExecutableBlock[] } {
  const selections: SearchSelection[] = [];
  const executable: ExecutableBlock[] = [];

  const candidates: readonly (CapabilityDefinition | ProviderCatalogueEntry)[] = [
    ...index.definitions,
    ...index.catalogueEntries,
  ];

  for (const candidate of candidates) {
    const isDefinition = "capabilityId" in candidate && "kind" in candidate;
    const capabilityId = candidate.capabilityId;

    if (isDefinition && query.connectorCapabilityKind !== undefined) {
      const definition = candidate as CapabilityDefinition;
      if (definition.kind !== query.connectorCapabilityKind) {
        continue;
      }
    }
    if (isDefinition && query.executionMode !== undefined) {
      const definition = candidate as CapabilityDefinition;
      if (!definition.executionModes.includes(query.executionMode)) {
        continue;
      }
    }

    // Find a connected instance for this capability (INV-C05: the instance,
    // not the catalogue, is the executable object).
    const instance = index.instances.find(
      (candidateInstance) => candidateInstance.capabilityId === capabilityId,
    );

    if (instance === undefined) {
      const catalogueEntry = isDefinition
        ? undefined
        : (candidate as ProviderCatalogueEntry);
      selections.push({
        status: "REJECTED",
        definition: isDefinition ? (candidate as CapabilityDefinition) : undefined,
        catalogueEntry,
        reason: "CATALOGUE_ENTRY_ONLY",
        detail:
          "no ConnectedCapabilityInstance is bound to this capability: a catalogue claim alone can never authorize execution (INV-C05)",
      });
      continue;
    }

    if (query.currency !== undefined && !instance.currencies.includes(query.currency)) {
      selections.push({
        status: "REJECTED",
        definition: isDefinition ? (candidate as CapabilityDefinition) : undefined,
        catalogueEntry: undefined,
        reason: "CURRENCY_NOT_SUPPORTED",
        detail: `instance '${instance.instanceId}' does not support currency '${query.currency}'`,
      });
      continue;
    }
    if (
      query.country !== undefined &&
      !instance.geography.countries.includes(query.country)
    ) {
      selections.push({
        status: "REJECTED",
        definition: isDefinition ? (candidate as CapabilityDefinition) : undefined,
        catalogueEntry: undefined,
        reason: "GEOGRAPHY_NOT_SUPPORTED",
        detail: `instance '${instance.instanceId}' does not cover country '${query.country}'`,
      });
      continue;
    }
    if (instance.authorization.status !== "ACTIVE") {
      selections.push({
        status: "REJECTED",
        definition: isDefinition ? (candidate as CapabilityDefinition) : undefined,
        catalogueEntry: undefined,
        reason: "AUTHORIZATION_NOT_ACTIVE",
        detail: `instance '${instance.instanceId}' authorization status is '${instance.authorization.status}'`,
      });
      continue;
    }
    if (!instance.eligibility.eligible) {
      selections.push({
        status: "REJECTED",
        definition: isDefinition ? (candidate as CapabilityDefinition) : undefined,
        catalogueEntry: undefined,
        reason: "NOT_ELIGIBLE",
        detail: `instance '${instance.instanceId}' not eligible: ${instance.eligibility.reasons.join(", ")}`,
      });
      continue;
    }

    const observation = latestObservation(index, instance.instanceId);
    if (observation === undefined) {
      selections.push({
        status: "REJECTED",
        definition: isDefinition ? (candidate as CapabilityDefinition) : undefined,
        catalogueEntry: undefined,
        reason: "NO_OBSERVATION",
        detail: `instance '${instance.instanceId}' has no current CapabilityObservation`,
      });
      continue;
    }

    // Two-axis derivation (INV-C01/C02). The stored availability must agree
    // with a fresh derivation; a disagreement is surfaced as UNKNOWN, never
    // as success or failure.
    const derived: EffectiveAvailability = resolveEffectiveAvailability(
      observation.capabilityState,
      observation.sourceAvailability,
    );
    if (derived !== observation.availability) {
      selections.push({
        status: "UNKNOWN",
        ...(isDefinition ? { definition: candidate as CapabilityDefinition } : {}),
        instance,
        observation,
        effectiveAvailability: "UNKNOWN",
        reason: "AXES_INCONSISTENT",
      });
      continue;
    }
    if (derived === "UNKNOWN") {
      selections.push({
        status: "UNKNOWN",
        ...(isDefinition ? { definition: candidate as CapabilityDefinition } : {}),
        instance,
        observation,
        effectiveAvailability: "UNKNOWN",
        reason:
          observation.sourceAvailability === "UNREACHABLE"
            ? "SOURCE_UNREACHABLE"
            : "SOURCE_UNKNOWN",
      });
      continue;
    }
    if (derived === "UNAVAILABLE") {
      selections.push({
        status: "REJECTED",
        definition: isDefinition ? (candidate as CapabilityDefinition) : undefined,
        catalogueEntry: undefined,
        reason: "EFFECTIVELY_UNAVAILABLE",
        detail: `instance '${instance.instanceId}' is two-axis UNAVAILABLE`,
      });
      continue;
    }

    const definition = isDefinition
      ? (candidate as CapabilityDefinition)
      : undefined;
    if (definition === undefined) {
      // Catalogue entry that happens to match an instance: still rejected —
      // executable selection requires the canonical definition vocabulary.
      selections.push({
        status: "REJECTED",
        definition: undefined,
        catalogueEntry: candidate as ProviderCatalogueEntry,
        reason: "CATALOGUE_ENTRY_ONLY",
        detail:
          "catalogue entry matched an instance but no canonical CapabilityDefinition is registered",
      });
      continue;
    }

    const isIncumbentBaseline =
      definition.nativeOptimization?.benchmarkBaseline === true;
    const effectiveAvailability = derived === "DEGRADED" ? "DEGRADED" : "AVAILABLE";
    const block: ExecutableBlock = {
      definition,
      instance,
      observation,
      effectiveAvailability,
      isIncumbentBaseline,
    };
    executable.push(block);
    selections.push({
      status: "EXECUTABLE",
      definition,
      instance,
      observation,
      effectiveAvailability,
      isIncumbentBaseline,
    });
  }

  return { selections: Object.freeze(selections), executable: Object.freeze(executable) };
}

// ---------------------------------------------------------------------------
// Search plug-ins (LAB.md "Search": replaceable optimizers)
// ---------------------------------------------------------------------------

/** A candidate program discovered by a search plug-in. */
export interface SearchedCandidate {
  readonly candidateId: string;
  /** Plug-in id or baseline origin label. */
  readonly origin: string;
  readonly executionMode: ExecutionMode;
  readonly program: SimulationProgram;
  readonly instanceRefs: readonly string[];
  /** INV-C08: this candidate IS the incumbent provider-native baseline. */
  readonly isIncumbentBaseline: boolean;
}

export interface LabSearchInput {
  readonly world: SimulatedWorld;
  readonly executableBlocks: readonly ExecutableBlock[];
  readonly query: LabSearchQuery;
}

export interface LabSearchPlugin {
  readonly pluginId: string;
  readonly description: string;
  search(input: LabSearchInput): readonly SearchedCandidate[];
}

/**
 * Deterministic economics of a block's bound simulated rail: a connected
 * instance binds to a Lab-simulated rail through its provider-neutral
 * configuration key `simulatedRailId` (Lab-only convention).
 */
function simulatedRailFor(
  world: SimulatedWorld,
  block: ExecutableBlock,
): { railId: string; fixedFeeMinor: bigint; variableFeeBps: bigint; latencyMs: number } | undefined {
  const railId = block.instance.configuration["simulatedRailId"];
  if (typeof railId !== "string") {
    return undefined;
  }
  const rail = world.rails.find((candidateRail) => candidateRail.railId === railId);
  if (rail === undefined) {
    return undefined;
  }
  return {
    railId: rail.railId,
    fixedFeeMinor: rail.fixedFeeMinor,
    variableFeeBps: rail.variableFeeBps,
    latencyMs: rail.latencyMs,
  };
}

/** Deterministic rail economics lookup (unused helper removed for clarity). */

const REFERENCE_AMOUNT_MINOR = 1_000_000n;

/**
 * The deterministic baseline search plug-in (LAB.md baseline 1:
 * "deterministic/generalist" plus the incumbent native candidate). Emits,
 * for every executable block set:
 * - the incumbent provider-native single-rail program (PASS_THROUGH_NATIVE,
 *   INV-C08) when a native-optimization block is present;
 * - a greedy cheapest-first composed program (COMPOSED_PAYSWAP);
 * - a greedy multi-provider program with netting + explicit credit
 *   (OPTIMIZED_MULTI_PROVIDER).
 */
export const deterministicBaselineSearchPlugin: LabSearchPlugin = {
  pluginId: "deterministic-baseline",
  description:
    "deterministic generalist search: cheapest-first greedy ordering over executable blocks, plus the provider-native incumbent",
  search(input): readonly SearchedCandidate[] {
    const { world, executableBlocks } = input;
    const bound = executableBlocks
      .map((block) => ({ block, rail: simulatedRailFor(world, block) }))
      .filter((entry) => entry.rail !== undefined)
      .sort((left, right) => {
        if (left.rail === undefined || right.rail === undefined) {
          return 0;
        }
        const leftCost = left.rail.fixedFeeMinor + (REFERENCE_AMOUNT_MINOR * left.rail.variableFeeBps) / 10_000n;
        const rightCost = right.rail.fixedFeeMinor + (REFERENCE_AMOUNT_MINOR * right.rail.variableFeeBps) / 10_000n;
        if (leftCost !== rightCost) {
          return leftCost < rightCost ? -1 : 1;
        }
        return left.rail.railId < right.rail.railId ? -1 : left.rail.railId > right.rail.railId ? 1 : 0;
      });

    const candidates: SearchedCandidate[] = [];

    // Incumbent provider-native candidate (INV-C08): single rail, minimal
    // orchestration, the provider's own optimization does the work.
    const incumbentBlock = bound.find((entry) => entry.block.isIncumbentBaseline);
    const incumbentTarget = incumbentBlock ?? bound[0];
    if (incumbentTarget !== undefined && incumbentTarget.rail !== undefined) {
      candidates.push({
        candidateId: "search.deterministic-baseline:incumbent-native",
        origin: "deterministic-baseline",
        executionMode: "PASS_THROUGH_NATIVE",
        program: {
          programId: "search.deterministic-baseline.incumbent-native",
          programVersion: "1.0.0",
          routePreference: [incumbentTarget.rail.railId],
          useNetting: false,
          useNetworkCredit: false,
          delayToleranceSteps: 0,
          fraudScreening: true,
          privacyBounded: true,
          authorizationMode: "PROTOCOL_AUTHORIZED",
        },
        instanceRefs: [incumbentTarget.block.instance.instanceId],
        isIncumbentBaseline: true,
      });
    }

    if (bound.length > 0) {
      const preference = bound
        .map((entry) => entry.rail?.railId)
        .filter((railId): railId is string => railId !== undefined);

      // Generalist composed candidate: cheapest-first, no batching.
      candidates.push({
        candidateId: "search.deterministic-baseline:composed-generalist",
        origin: "deterministic-baseline",
        executionMode: "COMPOSED_PAYSWAP",
        program: {
          programId: "search.deterministic-baseline.composed-generalist",
          programVersion: "1.0.0",
          routePreference: preference,
          useNetting: false,
          useNetworkCredit: false,
          delayToleranceSteps: 0,
          fraudScreening: true,
          privacyBounded: true,
          authorizationMode: "PROTOCOL_AUTHORIZED",
        },
        instanceRefs: bound.map((entry) => entry.block.instance.instanceId),
        isIncumbentBaseline: false,
      });

      // Optimized multi-provider candidate: netting + explicit credit.
      candidates.push({
        candidateId: "search.deterministic-baseline:optimized-multi-provider",
        origin: "deterministic-baseline",
        executionMode: "OPTIMIZED_MULTI_PROVIDER",
        program: {
          programId: "search.deterministic-baseline.optimized-multi-provider",
          programVersion: "1.0.0",
          routePreference: preference,
          useNetting: true,
          useNetworkCredit: true,
          delayToleranceSteps: 2,
          fraudScreening: true,
          privacyBounded: true,
          authorizationMode: "PROTOCOL_AUTHORIZED",
        },
        instanceRefs: bound.map((entry) => entry.block.instance.instanceId),
        isIncumbentBaseline: false,
      });
    }

    return Object.freeze(candidates);
  },
};

/**
 * The hand-designed baseline search plug-in (LAB.md baseline 2:
 * "hand-designed"). Rule-based: latency-first preference with netting,
 * explicit credit and screening — a human-designed policy shape.
 */
export const handDesignedBaselineSearchPlugin: LabSearchPlugin = {
  pluginId: "hand-designed-baseline",
  description:
    "hand-designed policy: latency-first rail preference with netting, explicit credit and adversarial screening",
  search(input): readonly SearchedCandidate[] {
    const { world, executableBlocks } = input;
    const bound = executableBlocks
      .map((block) => ({ block, rail: simulatedRailFor(world, block) }))
      .filter((entry) => entry.rail !== undefined)
      .sort((left, right) => {
        if (left.rail === undefined || right.rail === undefined) {
          return 0;
        }
        if (left.rail.latencyMs !== right.rail.latencyMs) {
          return left.rail.latencyMs < right.rail.latencyMs ? -1 : 1;
        }
        return left.rail.railId < right.rail.railId ? -1 : left.rail.railId > right.rail.railId ? 1 : 0;
      });

    if (bound.length === 0) {
      return [];
    }
    const preference = bound
      .map((entry) => entry.rail?.railId)
      .filter((railId): railId is string => railId !== undefined);

    return Object.freeze([
      {
        candidateId: "search.hand-designed-baseline:latency-first",
        origin: "hand-designed-baseline",
        executionMode: "COMPOSED_PAYSWAP" as ExecutionMode,
        program: {
          programId: "search.hand-designed-baseline.latency-first",
          programVersion: "1.0.0",
          routePreference: preference,
          useNetting: true,
          useNetworkCredit: true,
          delayToleranceSteps: 2,
          fraudScreening: true,
          privacyBounded: true,
          authorizationMode: "PROTOCOL_AUTHORIZED",
        },
        instanceRefs: bound.map((entry) => entry.block.instance.instanceId),
        isIncumbentBaseline: false,
      },
    ]);
  },
};

// ---------------------------------------------------------------------------
// Plug-in registry (replaceable optimizers, LAB.md "Search")
// ---------------------------------------------------------------------------

const builtinPlugins: readonly LabSearchPlugin[] = [
  deterministicBaselineSearchPlugin,
  handDesignedBaselineSearchPlugin,
];

const registeredPlugins = new Map<string, LabSearchPlugin>(
  builtinPlugins.map((plugin) => [plugin.pluginId, plugin]),
);

/**
 * Registers a search plug-in. Evolutionary search, black-box optimization,
 * contextual bandits, offline policy learning, RL, planning and hybrid
 * portfolios all plug in HERE — the Lab ships the deterministic and
 * hand-designed baselines and treats every other optimizer as replaceable.
 */
export function registerSearchPlugin(plugin: LabSearchPlugin): void {
  if (plugin.pluginId.length === 0) {
    throw new Error("search plugin id must not be empty");
  }
  registeredPlugins.set(plugin.pluginId, plugin);
}

export function listSearchPlugins(): readonly LabSearchPlugin[] {
  return [...registeredPlugins.values()];
}

export function getSearchPlugin(pluginId: string): LabSearchPlugin | undefined {
  return registeredPlugins.get(pluginId);
}

/**
 * Runs a plug-in search deterministically. Both built-in plug-ins only ever
 * surface candidates that are grounded in executable blocks (INV-C05).
 */
export function runSearchPlugin(
  pluginId: string,
  input: LabSearchInput,
): readonly SearchedCandidate[] {
  const plugin = registeredPlugins.get(pluginId);
  if (plugin === undefined) {
    throw new Error(`unknown search plugin '${pluginId}'`);
  }
  return plugin.search(input);
}
