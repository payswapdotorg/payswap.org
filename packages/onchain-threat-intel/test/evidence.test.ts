import { describe, expect, it } from "vitest";
import {
  ThreatEvidenceError,
  compareExactIntegers,
  compareExactRationals,
  parseRational,
  rationalDeviationBps,
  rationalExceedsInteger,
  validateEvidenceDelta,
  validateThreatEvidence,
} from "../src/index.js";
import { ValidationError } from "@payswap/protocol";

describe("evidence chains", () => {
  const validEvidence = {
    observationRefs: ["spender-intel:router"],
    digestRefs: ["write:fnv1a64:1"],
    deltas: [
      { label: "approval_minor_units", unit: "minor_units" as const, observed: "9000000", expected: "5000000" },
    ],
    note: "spender intelligence observed a drain pattern",
  };

  it("a complete evidence chain validates", () => {
    expect(() => validateThreatEvidence(validEvidence, "test:1")).not.toThrow();
  });

  it("AN EMPTY OBSERVATION CHAIN IS STRUCTURALLY INVALID (hard requirement)", () => {
    expect(() =>
      validateThreatEvidence(
        { ...validEvidence, observationRefs: [] },
        "test:2",
      ),
    ).toThrow(ThreatEvidenceError);
  });

  it("AN EMPTY DIGEST CHAIN IS STRUCTURALLY INVALID (hard requirement)", () => {
    expect(() =>
      validateThreatEvidence({ ...validEvidence, digestRefs: [] }, "test:3"),
    ).toThrow(ThreatEvidenceError);
  });

  it("an empty note is invalid — a chain must be explainable", () => {
    expect(() =>
      validateThreatEvidence({ ...validEvidence, note: "" }, "test:4"),
    ).toThrow(ThreatEvidenceError);
  });

  it("empty refs inside the chains are invalid", () => {
    expect(() =>
      validateThreatEvidence(
        { ...validEvidence, observationRefs: ["ok", ""] },
        "test:5",
      ),
    ).toThrow(ThreatEvidenceError);
    expect(() =>
      validateThreatEvidence({ ...validEvidence, digestRefs: [""] }, "test:6"),
    ).toThrow(ThreatEvidenceError);
  });
});

describe("evidence deltas", () => {
  it("validates every canonical unit shape", () => {
    expect(() =>
      validateEvidenceDelta({
        label: "bps",
        unit: "basis_points",
        observed: "250",
        expected: "50",
      }),
    ).not.toThrow();
    expect(() =>
      validateEvidenceDelta({
        label: "blocks",
        unit: "blocks",
        observed: "7",
        expected: "2",
      }),
    ).not.toThrow();
    expect(() =>
      validateEvidenceDelta({
        label: "minor",
        unit: "minor_units",
        observed: "-1200",
        expected: "0",
      }),
    ).not.toThrow();
    expect(() =>
      validateEvidenceDelta({
        label: "bool",
        unit: "boolean",
        observed: "false",
        expected: "true",
      }),
    ).not.toThrow();
    expect(() =>
      validateEvidenceDelta({
        label: "rat",
        unit: "rational",
        observed: "12/34",
        expected: "1/3",
      }),
    ).not.toThrow();
  });

  it("rejects malformed values per unit (fail closed)", () => {
    expect(() =>
      validateEvidenceDelta({ label: "x", unit: "basis_points", observed: "25.5", expected: "1" }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEvidenceDelta({ label: "x", unit: "basis_points", observed: "-1", expected: "1" }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEvidenceDelta({ label: "x", unit: "rational", observed: "1/0", expected: "1/1" }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEvidenceDelta({ label: "x", unit: "boolean", observed: "maybe", expected: "true" }),
    ).toThrow(ValidationError);
    expect(() =>
      validateEvidenceDelta({ label: "", unit: "count", observed: "1", expected: "1" }),
    ).toThrow(ValidationError);
  });
});

describe("exact rational arithmetic (no floating point anywhere)", () => {
  it("parseRational validates and parses", () => {
    expect(parseRational("3/4")).toEqual({
      numerator: 3n,
      denominator: 4n,
    });
    expect(() => parseRational("0.75")).toThrow(ValidationError);
    expect(() => parseRational("3/0")).toThrow(ValidationError);
  });

  it("compareExactRationals cross-multiplies exactly", () => {
    expect(compareExactRationals("1/3", "1/3")).toBe(0);
    expect(compareExactRationals("1/2", "1/3")).toBe(1);
    expect(compareExactRationals("1/1000000000", "1/999999999")).toBe(-1);
  });

  it("compareExactIntegers is exact at BigInt scale", () => {
    expect(
      compareExactIntegers("9007199254740993", "9007199254740992"),
    ).toBe(1);
    expect(() => compareExactIntegers("1.5", "1")).toThrow(ValidationError);
  });

  it("rationalDeviationBps is exact and symmetric", () => {
    expect(rationalDeviationBps("1/2", "1/2")).toBe("0/4");
    // |1/2 - 1/4| = 1/4 = 2500 bps exactly: |1*4 - 1*2| * 10000 / (2*4).
    expect(rationalDeviationBps("1/2", "1/4")).toBe("20000/8");
    // symmetric
    expect(rationalDeviationBps("1/4", "1/2")).toBe(rationalDeviationBps("1/2", "1/4"));
  });

  it("rationalExceedsInteger compares exactly against integer limits", () => {
    // 2500 bps > 50 → true
    expect(rationalExceedsInteger("10000/4", 50)).toBe(true);
    // 5 bps > 50 → false
    expect(rationalExceedsInteger("5/1", 50)).toBe(false);
    // exactly at the limit → false (strictly greater required)
    expect(rationalExceedsInteger("50/1", 50)).toBe(false);
    expect(() => rationalExceedsInteger("1/1", -1)).toThrow(ValidationError);
  });
});
