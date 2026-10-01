/**
 * Shared per-journey test helpers: assert the W1-007 acceptance axes.
 */
import { expect } from "vitest";
import { ACCEPTANCE_AXES, journeyPassed } from "../src/harness.js";
import type { JourneyOutcome } from "../src/harness.js";

/** The five axes every journey asserts; the baseline axis belongs to the suite. */
export const JOURNEY_AXES = ACCEPTANCE_AXES.filter((axis) => axis !== "PASS_THROUGH_NATIVE_BASELINE");

export function expectJourneyPasses(outcome: JourneyOutcome): void {
  expect(outcome.assertions.length).toBeGreaterThan(0);
  for (const assertion of outcome.assertions) {
    expect(
      { axis: assertion.axis, passed: assertion.passed, summary: assertion.summary },
      `${assertion.axis}: ${assertion.summary}`,
    ).toMatchObject({ axis: assertion.axis, passed: true });
  }
  expect(journeyPassed(outcome)).toBe(true);
}

export function expectAxesCovered(outcome: JourneyOutcome, expected: readonly string[]): void {
  const axes = new Set(outcome.assertions.map((a) => a.axis));
  expect([...axes].sort()).toEqual([...expected].sort());
}
