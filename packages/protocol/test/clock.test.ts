import { describe, expect, it } from 'vitest';
import {
  DeterministicClock,
  EpochCounter,
  EpochRegressionError,
  PaySwapError,
  SystemProtocolClock,
  ValidationError,
} from '../src/index.js';

describe('DeterministicClock', () => {
  it('starts at the seed and only moves via advanceMs', () => {
    const clock = new DeterministicClock(1_000n);
    expect(clock.now()).toBe(1000n);
    clock.advanceMs(5);
    expect(clock.now()).toBe(1005n);
    clock.advanceMs(10n);
    expect(clock.now()).toBe(1015n);
    clock.advanceMs(-15n);
    expect(clock.now()).toBe(1000n);
  });

  it('monotonic() strictly increases on every call', () => {
    const clock = new DeterministicClock();
    const readings: bigint[] = [];
    for (let i = 0; i < 5; i += 1) {
      readings.push(clock.monotonic());
    }
    for (let i = 1; i < readings.length; i += 1) {
      expect(readings[i] as bigint).toBeGreaterThan(readings[i - 1] as bigint);
    }
  });

  it('monotonic() increases even when the wall reading is frozen', () => {
    const clock = new DeterministicClock(42n);
    expect(clock.now()).toBe(42n);
    const first = clock.monotonic();
    const second = clock.monotonic();
    expect(second).toBeGreaterThan(first);
    expect(clock.now()).toBe(42n);
  });

  it('is deterministic: same seed and same operations produce identical readings', () => {
    const runA = new DeterministicClock(7n);
    const runB = new DeterministicClock(7n);
    for (const clock of [runA, runB]) {
      clock.advanceMs(3n);
      clock.advanceMs(11);
    }
    expect(runA.now()).toBe(runB.now());
    expect(runA.monotonic()).toBe(runB.monotonic());
    expect(runA.monotonic()).toBe(runB.monotonic());
  });

  it('rejects non-integer numeric advances and non-bigint seeds', () => {
    const clock = new DeterministicClock();
    expect(() => clock.advanceMs(1.5)).toThrow(ValidationError);
    expect(() => new DeterministicClock(5 as unknown as bigint)).toThrow(ValidationError);
  });
});

describe('SystemProtocolClock (edge adapter)', () => {
  it('now() returns a plausible bigint epoch milliseconds reading', () => {
    const clock = new SystemProtocolClock();
    const before = BigInt(Date.now());
    const reading = clock.now();
    const after = BigInt(Date.now());
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(after);
  });

  it('monotonic() strictly increases across rapid calls', () => {
    const clock = new SystemProtocolClock();
    const first = clock.monotonic();
    const second = clock.monotonic();
    const third = clock.monotonic();
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
});

describe('EpochCounter', () => {
  it('reserves strictly increasing epochs via next()', () => {
    const counter = new EpochCounter();
    expect(counter.next()).toBe(1n);
    expect(counter.next()).toBe(2n);
    expect(counter.next()).toBe(3n);
    expect(counter.current).toBe(3n);
  });

  it('honours a positive initial epoch', () => {
    const counter = new EpochCounter(41n);
    expect(counter.current).toBe(41n);
    expect(counter.next()).toBe(42n);
  });

  it('observe() adopts strictly greater epochs', () => {
    const counter = new EpochCounter(10n);
    counter.observe(11n);
    expect(counter.current).toBe(11n);
    counter.observe(99n);
    expect(counter.current).toBe(99n);
  });

  it('regression throws EpochRegressionError (INV-A02 semantics)', () => {
    const counter = new EpochCounter(10n);
    expect(() => counter.observe(10n)).toThrow(EpochRegressionError);
    expect(() => counter.observe(9n)).toThrow(EpochRegressionError);
    counter.observe(11n);
    expect(() => counter.observe(11n)).toThrow(EpochRegressionError);
    try {
      counter.observe(5n);
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EpochRegressionError);
      expect(error).toBeInstanceOf(PaySwapError);
      expect((error as EpochRegressionError).category).toBe('CONFLICT');
    }
  });

  it('rejects a negative initial epoch', () => {
    expect(() => new EpochCounter(-1n)).toThrow(ValidationError);
  });
});
