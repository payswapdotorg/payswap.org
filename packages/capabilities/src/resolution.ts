import type { Capability, CapabilityClass, ProvenanceDescriptor } from "./capability.js";
import type { CapabilityCondition } from "./capability.js";
import type { CapabilityState, EffectiveAvailability, SourceAvailability } from "./availability.js";
import { resolveEffectiveAvailability } from "./availability.js";

/**
 * Deterministic capability resolution (W2-002, FROZEN-ARCHITECTURE §11,
 * INV-C01, INV-C02).
 *
 * `resolveCapability(graph, request)` selects capability candidates by class
 * and (optionally) required condition kinds, and reports each candidate's
 * TWO-AXIS availability:
 *
 * - the capability's own state (AVAILABLE/DEGRADED/UNAVAILABLE), and
 * - the availability of the source that must confirm it
 *   (REACHABLE/UNREACHABLE/UNKNOWN),
 *
 * resolved into one effective availability via the Stage-0 rules. An
 * unreachable or unknown source NEVER removes the candidate and NEVER turns
 * into success or failure: the candidate is listed with effective
 * availability UNKNOWN (INV-C02, INV-X01).
 *
 * Hard-constraint filtering (class + required condition kinds) runs BEFORE
 * any availability consideration (AGENTS.md rule 14: hard constraints before
 * soft optimization); availability influences only the deterministic
 * `selected` pick, never the candidate list.
 */

/** The four declared condition kinds (see CapabilityCondition). */
export type ConditionKind = CapabilityCondition["kind"];

/** What the caller needs resolved. */
export interface CapabilityResolveRequest {
  readonly capabilityClass: CapabilityClass;
  /**
   * Hard-constraint condition kinds every candidate must declare at least one
   * condition for (e.g. compliance and jurisdiction for cross-border use).
   * Absent or empty ⇒ class-only matching.
   */
  readonly requiredConditionKinds?: readonly ConditionKind[];
}

/** One capability as registered in the resolution graph. */
export interface CapabilityGraphEntry {
  readonly capability: Capability;
  readonly sourceId: string;
  /** Axis 1: what the capability itself reports. */
  readonly capabilityState: CapabilityState;
  /** Axis 2: whether the confirming source is reachable. */
  readonly sourceAvailability: SourceAvailability;
}

/** The resolution graph: a deterministic, caller-supplied entry list. */
export interface CapabilityGraph {
  readonly entries: readonly CapabilityGraphEntry[];
}

/** A class-and-conditions-matching candidate with resolved availability. */
export interface ResolvedCandidate {
  readonly capability: Capability;
  readonly sourceId: string;
  readonly capabilityState: CapabilityState;
  readonly sourceAvailability: SourceAvailability;
  /** The two-axis effective availability (INV-C01/C02). */
  readonly effectiveAvailability: EffectiveAvailability;
  /** Carried provenance: who declared it and the content it points at. */
  readonly provenance: ProvenanceDescriptor;
}

/** The deterministic resolution result. */
export interface CapabilityResolution {
  readonly request: CapabilityResolveRequest;
  /**
   * EVERY matching candidate, in graph order — including candidates whose
   * effective availability is UNKNOWN (INV-C02: unreachable sources never
   * filter candidates out).
   */
  readonly candidates: readonly ResolvedCandidate[];
  /**
   * The deterministic primary: the FIRST candidate in graph order whose
   * effective availability is AVAILABLE. Deliberately strict — a DEGRADED or
   * UNKNOWN candidate is NEVER auto-selected (INV-X01: UNKNOWN is not
   * success); consuming those requires an explicit caller policy. Always
   * present as a key; `undefined` means no candidate is AVAILABLE.
   */
  readonly selected: ResolvedCandidate | undefined;
}

function declaredKinds(capability: Capability): Set<ConditionKind> {
  return new Set(capability.conditions.map((condition) => condition.kind));
}

/**
 * Deterministic capability lookup by class and conditions. See the module
 * documentation for the two-axis availability and UNKNOWN-preservation
 * semantics.
 */
export function resolveCapability(
  graph: CapabilityGraph,
  request: CapabilityResolveRequest,
): CapabilityResolution {
  const required = request.requiredConditionKinds ?? [];
  const candidates: ResolvedCandidate[] = [];
  for (const entry of graph.entries) {
    // Hard-constraint matching first (class, then required condition kinds).
    if (entry.capability.capabilityClass !== request.capabilityClass) {
      continue;
    }
    const declared = declaredKinds(entry.capability);
    const kindsSatisfied = required.every((kind) => declared.has(kind));
    if (!kindsSatisfied) {
      continue;
    }
    candidates.push({
      capability: entry.capability,
      sourceId: entry.sourceId,
      capabilityState: entry.capabilityState,
      sourceAvailability: entry.sourceAvailability,
      effectiveAvailability: resolveEffectiveAvailability(
        entry.capabilityState,
        entry.sourceAvailability,
      ),
      provenance: entry.capability.provenance,
    });
  }
  const selected = candidates.find(
    (candidate) => candidate.effectiveAvailability === "AVAILABLE",
  );
  return {
    request: { ...request },
    candidates: [...candidates],
    // `selected` is undefined when no candidate is AVAILABLE — an UNKNOWN
    // availability is never mapped to success (INV-C02, INV-X01).
    selected,
  };
}
