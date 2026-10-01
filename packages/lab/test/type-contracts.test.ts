import { describe, expect, it } from "vitest";
import type {
  CapabilityObservation,
  ConnectedCapabilityInstance,
  ConnectorExecutionRequest,
} from "@payswap/connectors";
import type { SimulationRunResult } from "@payswap/lab";
import type { ReplayResult } from "@payswap/lab";
import type { RunEvaluationResult } from "@payswap/lab";
import type { DirectorReasoningAnnotation } from "@payswap/lab";
import type { Equal, Expect } from "./type-utils.js";

/**
 * Type-level contracts (checked by tsc --noEmit; a failed Expect is a
 * compile error, so these guarantees are enforced by the typecheck gate).
 * Merely declaring each assertion type makes the compiler verify it.
 */

type IsAssignable<X, Y> = X extends Y ? true : false;

// INV-L01: a simulation result must not be usable where ANY production
// evidence shape is demanded — and conversely.
type SimNotInstance = Expect<
  Equal<IsAssignable<SimulationRunResult, ConnectedCapabilityInstance>, false>
>;
type SimNotObservation = Expect<
  Equal<IsAssignable<SimulationRunResult, CapabilityObservation>, false>
>;
type SimNotExecutionRequest = Expect<
  Equal<IsAssignable<SimulationRunResult, ConnectorExecutionRequest>, false>
>;
type InstanceNotSim = Expect<
  Equal<IsAssignable<ConnectedCapabilityInstance, SimulationRunResult>, false>
>;

// INV-L01: replay results are Lab artifacts, never production evidence.
type ReplayNotObservation = Expect<
  Equal<IsAssignable<ReplayResult, CapabilityObservation>, false>
>;
type ReplayNotInstance = Expect<
  Equal<IsAssignable<ReplayResult, ConnectedCapabilityInstance>, false>
>;

// AGENTS.md rule 14: the evaluation phases tuple is compile-time ordered —
// hard constraints first, optimization second, exactly two phases.
type Phases = RunEvaluationResult["phases"];
type PhaseOne = Expect<Equal<Phases[0]["phase"], "HARD_CONSTRAINTS">>;
type PhaseTwo = Expect<Equal<Phases[1]["phase"], "OPTIMIZATION">>;
type PhaseCount = Expect<Equal<Phases["length"], 2>>;

// INV-A05/G03: Director reasoning annotations are structurally
// non-authoritative — `authoritative` is the literal type false.
type ReasoningNotAuthoritative = Expect<
  Equal<DirectorReasoningAnnotation["authoritative"], false>
>;

describe("type-level isolation and ordering contracts", () => {
  it("the declared assertion types compile (enforced by tsc --noEmit)", () => {
    expect(true).toBe(true);
  });
});
