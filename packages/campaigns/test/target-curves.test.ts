import { describe, expect, it } from 'vitest';
import {
  defineTargetBand,
  defineTargetCurve,
  evaluateTargetCurve,
  resolveCurvePoint,
  targetCurveDigest,
} from '../src/target-curves.js';

describe('target curves: declarations are validated deterministically', () => {
  it('accepts and freezes a CONSTANT curve', () => {
    const curve = defineTargetCurve({ kind: 'CONSTANT', target: 100n });
    expect(curve.kind).toBe('CONSTANT');
    expect(Object.isFrozen(curve)).toBe(true);
  });

  it('accepts and freezes a LINEAR_RAMP with strictly ascending anchors', () => {
    const curve = defineTargetCurve({
      kind: 'LINEAR_RAMP',
      from: { at: 0n, target: 10n },
      to: { at: 1_000n, target: 110n },
    });
    expect(curve.kind).toBe('LINEAR_RAMP');
    expect(Object.isFrozen(curve)).toBe(true);
    expect(() =>
      defineTargetCurve({
        kind: 'LINEAR_RAMP',
        from: { at: 1_000n, target: 10n },
        to: { at: 1_000n, target: 110n },
      }),
    ).toThrow(/strictly after/);
  });

  it('accepts STEP_BANDS with strictly ascending steps and rejects violations', () => {
    const curve = defineTargetCurve({
      kind: 'STEP_BANDS',
      steps: [
        { fromAt: 0n, target: 10n },
        { fromAt: 500n, target: 50n },
        { fromAt: 1_000n, target: 100n },
      ],
    });
    expect(curve.kind).toBe('STEP_BANDS');
    expect(() =>
      defineTargetCurve({
        kind: 'STEP_BANDS',
        steps: [
          { fromAt: 0n, target: 10n },
          { fromAt: 0n, target: 50n },
        ],
      }),
    ).toThrow(/strictly ascending/);
  });

  it('rejects non-positive targets', () => {
    expect(() => defineTargetCurve({ kind: 'CONSTANT', target: 0n })).toThrow(/positive/);
    expect(() => defineTargetCurve({ kind: 'CONSTANT', target: -5n })).toThrow(/positive/);
  });

  it('validates the tolerance band within [0, 10000] bp', () => {
    expect(defineTargetBand({ toleranceBps: 0n }).toleranceBps).toBe(0n);
    expect(defineTargetBand({ toleranceBps: 10_000n }).toleranceBps).toBe(10_000n);
    expect(() => defineTargetBand({ toleranceBps: 10_001n })).toThrow(/10000/);
  });
});

describe('target curves: evaluation is a pure deterministic function of time', () => {
  it('CONSTANT returns the same target for every time', () => {
    const curve = defineTargetCurve({ kind: 'CONSTANT', target: 42n });
    expect(evaluateTargetCurve(curve, 0n)).toBe(42n);
    expect(evaluateTargetCurve(curve, 1_000_000_000n)).toBe(42n);
  });

  it('LINEAR_RAMP interpolates exactly (bigint math, truncation toward zero)', () => {
    const curve = defineTargetCurve({
      kind: 'LINEAR_RAMP',
      from: { at: 0n, target: 100n },
      to: { at: 1_000n, target: 200n },
    });
    expect(evaluateTargetCurve(curve, 0n)).toBe(100n);
    expect(evaluateTargetCurve(curve, 500n)).toBe(150n);
    expect(evaluateTargetCurve(curve, 250n)).toBe(125n);
    expect(evaluateTargetCurve(curve, 1_000n)).toBe(200n);
    // Clamped outside the anchor range.
    expect(evaluateTargetCurve(curve, 2_000n)).toBe(200n);
    expect(evaluateTargetCurve(curve, 5_000n)).toBe(200n);
    // Non-divisible interpolation truncates toward zero (documented policy).
    const odd = defineTargetCurve({
      kind: 'LINEAR_RAMP',
      from: { at: 0n, target: 1n },
      to: { at: 3n, target: 11n },
    });
    expect(evaluateTargetCurve(odd, 1n)).toBe(4n); // 1 + 10*1/3 → 1+3
    expect(evaluateTargetCurve(odd, 2n)).toBe(7n); // 1 + 10*2/3 → 1+6
  });

  it('STEP_BANDS applies the last step whose fromAt <= at', () => {
    const curve = defineTargetCurve({
      kind: 'STEP_BANDS',
      steps: [
        { fromAt: 100n, target: 10n },
        { fromAt: 600n, target: 50n },
        { fromAt: 1_100n, target: 100n },
      ],
    });
    // Before the first step, the first step's target is the declared baseline.
    expect(evaluateTargetCurve(curve, 0n)).toBe(10n);
    expect(evaluateTargetCurve(curve, 100n)).toBe(10n);
    expect(evaluateTargetCurve(curve, 599n)).toBe(10n);
    expect(evaluateTargetCurve(curve, 600n)).toBe(50n);
    expect(evaluateTargetCurve(curve, 1_099n)).toBe(50n);
    expect(evaluateTargetCurve(curve, 1_100n)).toBe(100n);
    expect(evaluateTargetCurve(curve, 9_999n)).toBe(100n);
  });

  it('same inputs always produce the same curve (determinism, W3-005 §3.3)', () => {
    const spec = {
      kind: 'LINEAR_RAMP',
      from: { at: 0n, target: 100n },
      to: { at: 1_000n, target: 200n },
    } as const;
    for (const at of [0n, 1n, 123n, 500n, 999n, 1_000n, 5_000n]) {
      const first = evaluateTargetCurve(defineTargetCurve(spec), at);
      const second = evaluateTargetCurve(defineTargetCurve(spec), at);
      expect(first).toBe(second);
    }
    // The digest of identical declarations is identical.
    expect(targetCurveDigest(defineTargetCurve(spec))).toBe(targetCurveDigest(defineTargetCurve(spec)));
    // Different declarations digest differently.
    expect(targetCurveDigest(defineTargetCurve({ kind: 'CONSTANT', target: 100n }))).not.toBe(
      targetCurveDigest(defineTargetCurve(spec)),
    );
  });
});

describe('target curves: curve points resolve emission levels deterministically', () => {
  const curve = defineTargetCurve({ kind: 'CONSTANT', target: 100n });
  const band = defineTargetBand({ toleranceBps: 500n }); // ±5%

  it('observed below the band → BELOW_TARGET (boost regime)', () => {
    const point = resolveCurvePoint(curve, { at: 1_000n, observedParticipation: 94n }, band);
    expect(point.target).toBe(100n);
    expect(point.emissionLevel).toBe('BELOW_TARGET');
    expect(point.withinBand).toBe(false);
  });

  it('observed inside the band → WITHIN_BAND (normalize regime)', () => {
    const point = resolveCurvePoint(curve, { at: 1_000n, observedParticipation: 96n }, band);
    expect(point.emissionLevel).toBe('WITHIN_BAND');
    expect(point.withinBand).toBe(true);
    const upperEdge = resolveCurvePoint(curve, { at: 1_000n, observedParticipation: 105n }, band);
    expect(upperEdge.emissionLevel).toBe('WITHIN_BAND');
    expect(upperEdge.withinBand).toBe(true);
  });

  it('observed above the band → ABOVE_TARGET (taper regime)', () => {
    const point = resolveCurvePoint(curve, { at: 1_000n, observedParticipation: 106n }, band);
    expect(point.emissionLevel).toBe('ABOVE_TARGET');
    expect(point.withinBand).toBe(false);
  });

  it('identical inputs reproduce identical points AND digests (INV-P03)', () => {
    const inputs = { at: 1_234_567n, observedParticipation: 87n };
    const first = resolveCurvePoint(curve, inputs, band);
    const second = resolveCurvePoint(curve, inputs, band);
    expect(second).toEqual(first);
    expect(second.digest).toBe(first.digest);
    // Different observation → different digest.
    const third = resolveCurvePoint(curve, { ...inputs, observedParticipation: 88n }, band);
    expect(third.digest).not.toBe(first.digest);
  });

  it('rejects malformed observations loudly', () => {
    expect(() =>
      resolveCurvePoint(curve, { at: 1n, observedParticipation: -1n }, band),
    ).toThrow(/non-negative/);
  });
});
