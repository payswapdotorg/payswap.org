import { describe, expect, it } from "vitest";
import { buildThreatSignal, validateThreatSignal } from "../src/index.js";
import { InvalidThreatSignalError, ThreatEvidenceError } from "../src/index.js";

describe("threat signal construction (evidence is structurally mandatory)", () => {
  const complete = {
    family: "oracle_manipulation" as const,
    code: "oracle_pairwise_deviation_exceeds_threshold",
    severity: "critical" as const,
    method: "threshold_breach" as const,
    confidenceBps: 8_000,
    evidence: {
      observationRefs: ["oracle:usd-1", "oracle:usd-2"],
      digestRefs: ["write:fnv1a64:1", "bundle:fnv1a64:2"],
      deltas: [
        {
          label: "pairwise_price_deviation_bps",
          unit: "rational" as const,
          observed: "100/4",
          expected: "50/1",
        },
      ],
      note: "two independent oracle readings diverged",
    },
    summary: "oracle readings diverged beyond the policy threshold",
  };

  it("builds a frozen, content-addressed signal from complete input", () => {
    const signal = buildThreatSignal(complete);
    expect(signal.signalId.startsWith("fnv1a64:")).toBe(true);
    expect(Object.isFrozen(signal)).toBe(true);
    expect(Object.isFrozen(signal.evidence.observationRefs)).toBe(true);
    expect(() => validateThreatSignal(signal)).not.toThrow();
  });

  it("content-addressed: identical input → identical signalId", () => {
    expect(buildThreatSignal(complete).signalId).toBe(
      buildThreatSignal(complete).signalId,
    );
    const changed = buildThreatSignal({
      ...complete,
      confidenceBps: 8_300,
    });
    expect(changed.signalId).not.toBe(buildThreatSignal(complete).signalId);
  });

  it("A SIGNAL WITHOUT ITS EVIDENCE CHAIN FAILS VALIDATION STRUCTURALLY (hard requirement)", () => {
    expect(() =>
      buildThreatSignal({
        ...complete,
        evidence: {
          observationRefs: [],
          digestRefs: [],
          note: "no chain at all",
        },
      }),
    ).toThrow(ThreatEvidenceError);
  });

  it("an empty digest chain is equally invalid", () => {
    expect(() =>
      buildThreatSignal({
        ...complete,
        evidence: {
          observationRefs: ["oracle:usd-1"],
          digestRefs: [],
          note: "observations but no digest binding",
        },
      }),
    ).toThrow(ThreatEvidenceError);
  });

  it("malformed confidence, code and summary fail closed", () => {
    expect(() =>
      buildThreatSignal({ ...complete, confidenceBps: 12_000 }),
    ).toThrow(InvalidThreatSignalError);
    expect(() => buildThreatSignal({ ...complete, code: "" })).toThrow(
      InvalidThreatSignalError,
    );
    expect(() => buildThreatSignal({ ...complete, summary: "" })).toThrow(
      InvalidThreatSignalError,
    );
  });
});
