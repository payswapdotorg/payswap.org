import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_BAND_THRESHOLDS,
  CORROBORATION_INCREMENT_BPS,
  DETECTION_METHODS,
  MAX_CONFIDENCE_BPS,
  MAX_CORROBORATING_OBSERVATIONS,
  METHOD_BASE_CONFIDENCE_BPS,
  calibrateConfidenceBps,
  confidenceBand,
  isDetectionMethod,
  renderConfidence,
  validateConfidenceBps,
} from "../src/index.js";
import { ValidationError } from "@payswap/protocol";

describe("calibrated confidence", () => {
  it("every method has an explicit base confidence in bps", () => {
    for (const method of DETECTION_METHODS) {
      const base = METHOD_BASE_CONFIDENCE_BPS[method];
      expect(Number.isInteger(base)).toBe(true);
      expect(base).toBeGreaterThan(0);
      expect(base).toBeLessThanOrEqual(MAX_CONFIDENCE_BPS);
    }
    // Exactness ordering: identity > structural > threshold > behavior > absence.
    expect(
      METHOD_BASE_CONFIDENCE_BPS.exact_identity_match,
    ).toBeGreaterThan(METHOD_BASE_CONFIDENCE_BPS.structural_mismatch);
    expect(
      METHOD_BASE_CONFIDENCE_BPS.structural_mismatch,
    ).toBeGreaterThan(METHOD_BASE_CONFIDENCE_BPS.threshold_breach);
    expect(
      METHOD_BASE_CONFIDENCE_BPS.threshold_breach,
    ).toBeGreaterThan(METHOD_BASE_CONFIDENCE_BPS.behavioral_pattern);
    expect(
      METHOD_BASE_CONFIDENCE_BPS.behavioral_pattern,
    ).toBeGreaterThan(METHOD_BASE_CONFIDENCE_BPS.registry_absence);
  });

  it("corroboration sharpens confidence deterministically", () => {
    const base = calibrateConfidenceBps("structural_mismatch", 0);
    const one = calibrateConfidenceBps("structural_mismatch", 1);
    const three = calibrateConfidenceBps("structural_mismatch", 3);
    expect(one).toBe(base + CORROBORATION_INCREMENT_BPS);
    expect(three).toBe(base + 3 * CORROBORATION_INCREMENT_BPS);
    // Beyond the cap, no further sharpening.
    expect(calibrateConfidenceBps("structural_mismatch", 10)).toBe(three);
  });

  it("confidence never exceeds the maximum", () => {
    expect(
      calibrateConfidenceBps("exact_identity_match", 3),
    ).toBeLessThanOrEqual(MAX_CONFIDENCE_BPS);
  });

  it("calibration is a pure deterministic function (same input → same bps)", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(calibrateConfidenceBps("behavioral_pattern", 2)).toBe(7_600);
    }
  });

  it("bands follow the exact integer thresholds", () => {
    expect(confidenceBand(CONFIDENCE_BAND_THRESHOLDS.high)).toBe("high");
    expect(confidenceBand(CONFIDENCE_BAND_THRESHOLDS.high - 1)).toBe("medium");
    expect(confidenceBand(CONFIDENCE_BAND_THRESHOLDS.medium)).toBe("medium");
    expect(confidenceBand(CONFIDENCE_BAND_THRESHOLDS.medium - 1)).toBe("low");
    expect(confidenceBand(0)).toBe("low");
  });

  it("validation fails closed on malformed confidence", () => {
    expect(() => validateConfidenceBps(-1)).toThrow(ValidationError);
    expect(() => validateConfidenceBps(10_001)).toThrow(ValidationError);
    expect(() => validateConfidenceBps(0.5)).toThrow(ValidationError);
    expect(() => validateConfidenceBps(9_999)).not.toThrow();
  });

  it("renderConfidence is exact decimal rendering (no float drift)", () => {
    expect(renderConfidence(9_900)).toBe("99.00%");
    expect(renderConfidence(7_605)).toBe("76.05%");
    expect(renderConfidence(0)).toBe("0.00%");
    expect(isDetectionMethod("threshold_breach")).toBe(true);
    expect(isDetectionMethod("guess")).toBe(false);
  });
});
