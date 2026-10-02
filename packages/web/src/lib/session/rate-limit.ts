/**
 * Sign-in rate limiting with exponential backoff (P3-W1-002).
 *
 * A real, in-memory per-identity failure tracker (documented limitation:
 * process-local, like the identity store — the interface allows a durable
 * implementation). After MAX_FAILURES consecutive failures the key is
 * locked out for BASE_LOCKOUT_MS doubling with each further failure, up to
 * MAX_LOCKOUT_MS. A successful sign-in clears the counter.
 *
 * The tracker keys on the NORMALIZED EMAIL only in this deployment (no IP
 * dimension — the honest scope of a single-instance plane); the UI surfaces
 * the retry-after seconds verbatim, never a fake "try again later".
 */

const MAX_FAILURES = 5;
const BASE_LOCKOUT_MS = 15_000;
const MAX_LOCKOUT_MS = 900_000;

interface AttemptState {
  failures: number;
  lockedUntil: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Present only while locked out — whole seconds until the next attempt. */
  readonly retryAfterSeconds?: number;
  /** Failures recorded so far (for honest backoff display). */
  readonly failures: number;
}

export class SignInRateLimiter {
  readonly #attempts = new Map<string, AttemptState>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** Is this key allowed to attempt a sign-in right now? */
  check(key: string): RateLimitDecision {
    const state = this.#attempts.get(key);
    if (state === undefined) {
      return { allowed: true, failures: 0 };
    }
    const now = this.#now();
    if (state.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
        failures: state.failures,
      };
    }
    return { allowed: true, failures: state.failures };
  }

  /** Record a failed attempt (applies/extends the backoff lockout). */
  recordFailure(key: string): void {
    const state = this.#attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
    const failures = state.failures + 1;
    let lockedUntil = state.lockedUntil;
    if (failures >= MAX_FAILURES) {
      const exponent = failures - MAX_FAILURES;
      const lockoutMs = Math.min(BASE_LOCKOUT_MS * 2 ** exponent, MAX_LOCKOUT_MS);
      lockedUntil = Math.max(this.#now() + lockoutMs, state.lockedUntil);
    }
    this.#attempts.set(key, { failures, lockedUntil });
  }

  /** A successful sign-in clears the failure history for the key. */
  recordSuccess(key: string): void {
    this.#attempts.delete(key);
  }
}
