/**
 * Tiny assertion toolkit for conformance harnesses.
 *
 * The harnesses must stay importable without a test framework (the framework
 * is injected — see contract-test.ts), so these helpers throw plain Errors
 * that any runner (vitest, node) reports as failures.
 */

export function ok(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

export function fail(message: string): never {
  throw new Error(`assertion failed: ${message}`);
}

/** Structural deep equality (objects, arrays, primitives). */
export function deepEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) {
    return true;
  }
  if (typeof actual !== 'object' || typeof expected !== 'object' || actual === null || expected === null) {
    return false;
  }
  const actualIsArray = Array.isArray(actual);
  if (actualIsArray !== Array.isArray(expected)) {
    return false;
  }
  if (actualIsArray && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      return false;
    }
    return actual.every((item, index) => deepEquals(item, expected[index]));
  }
  const left = actual as Record<string, unknown>;
  const right = expected as Record<string, unknown>;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key, index) => key === rightKeys[index] && deepEquals(left[key], right[key]),
  );
}

export function equal(actual: unknown, expected: unknown, message: string): void {
  if (!deepEquals(actual, expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

/**
 * Asserts that an async operation rejects with an error whose message
 * contains `messagePart`.
 */
export async function assertRejects(fn: () => Promise<unknown>, messagePart: string): Promise<void> {
  let rejected = false;
  let error: unknown;
  try {
    await fn();
  } catch (caught: unknown) {
    rejected = true;
    error = caught;
  }
  if (!rejected) {
    throw new Error(`assertion failed: expected rejection containing "${messagePart}", but the call resolved`);
  }
  const text = error instanceof Error ? error.message : String(error);
  if (!text.includes(messagePart)) {
    throw new Error(`assertion failed: rejection "${text}" does not contain "${messagePart}"`);
  }
}
