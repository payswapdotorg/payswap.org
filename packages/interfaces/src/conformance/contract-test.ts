/**
 * Contract-test registration contract.
 *
 * Conformance harnesses register their cases through an injected test
 * function so that src/ never needs a test-framework import (keeping the
 * package self-contained — zero non-relative imports outside node: builtins;
 * enforced by test/boundary.test.ts).
 *
 * Usage inside a test framework file:
 *   runHttpContractTests(subject, (name, fn) => it(name, fn));
 */

export type ContractTestFn = (name: string, fn: () => void | Promise<void>) => void;
