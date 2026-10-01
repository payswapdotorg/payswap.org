import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  observeCapability,
  unknownReachabilityObservation,
  validateCapabilityObservation,
} from "../src/index.js";
import type { CapabilityObservation } from "../src/index.js";
import type { Equal, Expect } from "./type-utils.js";

/**
 * CapabilityObservation (§2A layer 4) — the two-axis model is REUSED from
 * @payswap/capabilities (INV-C01/C02): capability state and source
 * availability are separate axes, and an unreachable or UNKNOWN source
 * means the effective availability is UNKNOWN — never success, never
 * failure. The availability field is DERIVED, never caller-supplied.
 */

const provenance = {
  providerName: "psp-a",
  source: "PROVIDER_API" as const,
  capturedAt: "2026-10-01T12:00:00Z",
};

function observationInput(
  overrides: Partial<Parameters<typeof observeCapability>[0]> = {},
): Parameters<typeof observeCapability>[0] {
  return {
    instanceId: "inst:acct-1-payments",
    observedAt: "2026-10-01T12:00:05Z",
    observationVersion: 1,
    capabilityState: "AVAILABLE",
    sourceAvailability: "REACHABLE",
    eligibility: "ELIGIBLE",
    health: { status: "HEALTHY", lastCheckedAt: "2026-10-01T12:00:04Z" },
    provenance,
    ...overrides,
  };
}

describe("two-axis availability integration (INV-C01/C02, reused from @payswap/capabilities)", () => {
  it("derives AVAILABLE from a reachable source reporting a healthy capability", () => {
    const observation = observeCapability(observationInput());
    expect(observation.capabilityState).toBe("AVAILABLE");
    expect(observation.sourceAvailability).toBe("REACHABLE");
    expect(observation.availability).toBe("AVAILABLE");
  });

  it("an UNREACHABLE source means availability UNKNOWN — never failure, never success", () => {
    const observation = observeCapability(
      observationInput({ sourceAvailability: "UNREACHABLE" }),
    );
    expect(observation.capabilityState).toBe("AVAILABLE"); // last reported state
    expect(observation.sourceAvailability).toBe("UNREACHABLE");
    expect(observation.availability).toBe("UNKNOWN");
  });

  it("an UNKNOWN source means availability UNKNOWN even when the capability was healthy", () => {
    const observation = observeCapability(
      observationInput({ sourceAvailability: "UNKNOWN" }),
    );
    expect(observation.availability).toBe("UNKNOWN");
  });

  it("a DEGRADED reachable capability is DEGRADED — not UNKNOWN, not failed", () => {
    const observation = observeCapability(
      observationInput({ capabilityState: "DEGRADED" }),
    );
    expect(observation.availability).toBe("DEGRADED");
  });

  it("the observation input type has NO availability field to fabricate", () => {
    type HasAvailability = "availability" extends keyof Parameters<
      typeof observeCapability
    >[0]
      ? true
      : false;
    type Cases = [Expect<Equal<HasAvailability, false>>];
    const cases: Cases = [true];
    expect(cases).toEqual([true]);
  });
});

describe("unknownReachabilityObservation (current reachability cannot be established)", () => {
  it("produces an UNKNOWN availability observation with UNKNOWN health and eligibility", () => {
    const observation = unknownReachabilityObservation({
      instanceId: "inst:acct-1-payments",
      observedAt: "2026-10-01T12:01:00Z",
      observationVersion: 2,
      lastKnownCapabilityState: "AVAILABLE",
      reason: "probe timed out",
      provenance,
    });
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.eligibility).toBe("UNKNOWN");
    expect(observation.health.status).toBe("UNKNOWN");
  });
});

describe("observation validation", () => {
  it("rejects a fabricated availability that contradicts the two axes", () => {
    const honest = observeCapability(
      observationInput({ sourceAvailability: "UNREACHABLE" }),
    );
    expect(() =>
      validateCapabilityObservation({
        ...honest,
        availability: "AVAILABLE" as never,
      }),
    ).toThrow(/does not match its two axes.*INV-C02/);
    // The honest observation itself validates.
    expect(() => validateCapabilityObservation(honest)).not.toThrow();
  });

  it("rejects malformed observations", () => {
    expect(() =>
      observeCapability(observationInput({ observationVersion: 0 })),
    ).toThrow(/observationVersion/);
    expect(() =>
      observeCapability(observationInput({ instanceId: "" })),
    ).toThrow(/instanceId/);
    expect(() =>
      observeCapability(
        observationInput({
          health: { status: "BROKEN" as never, lastCheckedAt: "x" },
        }),
      ),
    ).toThrow(/health/);
    expect(() =>
      observeCapability(observationInput({ provenance: {} as never })),
    ).toThrow(/provenance/);
    expect(() => validateCapabilityObservation("not-an-object")).toThrow(ValidationError);
  });

  it("carries quota, terms and external state without losing them", () => {
    const observation: CapabilityObservation = observeCapability(
      observationInput({
        quota: { limit: 100, remaining: 97, windowSeconds: 60 },
        terms: { version: "2026-09-fees", changePending: true },
      }),
    );
    expect(observation.quota?.remaining).toBe(97);
    expect(observation.terms?.changePending).toBe(true);
  });
});
