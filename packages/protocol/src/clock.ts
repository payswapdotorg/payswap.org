/**
 * @payswap/protocol — deterministic clock and epoch abstraction (W1-001).
 *
 * Domain logic never reads the host wall clock directly: it receives a
 * `ProtocolClock` by injection. Deterministic code (tests, replay,
 * simulations, contract freezing) uses `DeterministicClock`; the
 * `SystemProtocolClock` is an edge adapter for the composition root only.
 *
 * `EpochCounter` provides a strictly increasing epoch with explicit
 * regression detection, used for leadership/sequencing claims that must
 * never move backwards (INV-A02-adjacent: expired/revoked epochs cannot
 * authorize sensitive actions).
 */

import {
  PaySwapError,
  ValidationError,
  type PaySwapErrorDetails,
  type PaySwapErrorInit,
} from './errors.js';

/** Milliseconds since the Unix epoch. bigint — never a JS number. */
export type TimestampMs = bigint;

export interface ProtocolClock {
  /** Wall-clock reading, millisecond precision. */
  now(): TimestampMs;
  /** Strictly increasing sequence source for uniqueness within this clock. */
  monotonic(): bigint;
}

/** Raised when an epoch observation regresses below the current epoch. */
export class EpochRegressionError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({ code: 'EPOCH_REGRESSION', category: 'CONFLICT', message, details });
  }
}

function toBigIntMs(value: number | bigint, label: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new ValidationError(`${label} must be an integer number of milliseconds`, { value });
    }
    return BigInt(value);
  }
  return value;
}

/**
 * Fully deterministic clock for tests, replay and contract freezing.
 *
 * - `now()` returns the simulated wall time; it only moves via `advanceMs`.
 * - `monotonic()` returns a value that strictly increases on every call,
 *   independent of `advanceMs`, so id factories minting on a frozen clock
 *   still produce distinct, reproducible identifiers.
 *
 * `advanceMs` accepts negative deltas to simulate clock-skew scenarios in
 * tests; regression of the *simulated wall clock* is allowed on purpose —
 * real epoch regression is what `EpochCounter` detects.
 */
export class DeterministicClock implements ProtocolClock {
  private _now: bigint;
  private _monotonic: bigint;

  constructor(seed: TimestampMs = 0n) {
    if (typeof seed !== 'bigint') {
      throw new ValidationError('seed must be a bigint', { seed });
    }
    this._now = seed;
    this._monotonic = 0n;
  }

  now(): TimestampMs {
    return this._now;
  }

  monotonic(): bigint {
    this._monotonic += 1n;
    return this._monotonic;
  }

  advanceMs(ms: number | bigint): void {
    this._now += toBigIntMs(ms, 'advanceMs');
  }
}

/**
 * Edge adapter over the host wall clock. Intended for the composition root
 * and infrastructure edges only — never inside deterministic domain logic.
 *
 * `monotonic()` combines host time with a per-instance strictly increasing
 * sequence so that two calls in the same millisecond still differ. If the
 * host clock itself jumps backwards far enough, monotonicity can be broken
 * by the host component; that environment failure mode is exactly what
 * `EpochCounter` exists to detect at authority boundaries.
 */
export class SystemProtocolClock implements ProtocolClock {
  private _sequence: bigint;

  constructor() {
    this._sequence = 0n;
  }

  now(): TimestampMs {
    return BigInt(Date.now());
  }

  monotonic(): bigint {
    this._sequence += 1n;
    return BigInt(Date.now()) * 1_000_000n + this._sequence;
  }
}

/**
 * Strictly increasing epoch counter with regression detection.
 *
 * - `next()` reserves and returns the next epoch (current + 1).
 * - `observe(seen)` folds in an externally observed epoch: it must be
 *   strictly greater than the current epoch, otherwise an
 *   `EpochRegressionError` is thrown (INV-A02: stale epochs never authorize).
 */
export class EpochCounter {
  private _current: bigint;

  constructor(initialEpoch: bigint = 0n) {
    if (typeof initialEpoch !== 'bigint' || initialEpoch < 0n) {
      throw new ValidationError('initialEpoch must be a non-negative bigint', { initialEpoch });
    }
    this._current = initialEpoch;
  }

  get current(): bigint {
    return this._current;
  }

  next(): bigint {
    this._current += 1n;
    return this._current;
  }

  observe(observedEpoch: bigint): void {
    if (typeof observedEpoch !== 'bigint') {
      throw new ValidationError('observedEpoch must be a bigint', { observedEpoch });
    }
    if (observedEpoch <= this._current) {
      throw new EpochRegressionError('observed epoch is not greater than the current epoch', {
        observedEpoch: observedEpoch.toString(),
        currentEpoch: this._current.toString(),
      });
    }
    this._current = observedEpoch;
  }
}
