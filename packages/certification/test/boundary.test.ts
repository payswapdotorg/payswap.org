import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (W2-006; AGENTS.md rules 1/5/7/16/17; INV-C07).
 *
 * 1. certification src/** imports ONLY the workspace dependencies whose
 *    boundary rules permit cross-package consumption (protocol, agents,
 *    capabilities, connectors). The immune-system package and the Lab
 *    package are consumed STRUCTURALLY (view interfaces the concrete
 *    artifacts satisfy): their own boundary tests forbid any other
 *    package's src importing them, so no src file here even mentions those
 *    specifiers — the real artifacts are driven through the contracts by
 *    the test suite instead (real structural consumption, proven below).
 * 2. src/** never references connector EXECUTION machinery: the
 *    certification layer gates, orders and records artifacts; it never
 *    constructs execution requests.
 * 3. Every non-relative import in src/** is a declared @payswap/* workspace
 *    dependency of this package's package.json.
 * 4. THE uniform gate wall decision core cannot see the execution mode:
 *    `evaluateUniformGates` receives `UniformGateDecisionInput`, which
 *    structurally omits `executionMode` and `isIncumbentBaseline`, and its
 *    source never references either field (type-, value- and source-level
 *    proofs of "no mode-specific bypass").
 * 5. THE requirements object is single and frozen: one constant for all
 *    three execution modes.
 */

const PACKAGE_ROOT = process.cwd(); // vitest runs from packages/certification
const REPO_ROOT = join(PACKAGE_ROOT, "..", ".."); // → repo root

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

function relativeToRepoRoot(full: string): string {
  return full.substring(REPO_ROOT.length + sep.length);
}

const DECLARED_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/protocol",
  "@payswap/security",
  "@payswap/lab",
  "@payswap/capabilities",
  "@payswap/connectors",
  "@payswap/agents",
];

/**
 * The boundary rules of the immune-system and Lab packages forbid any other
 * package's src importing them; certification consumes both STRUCTURALLY,
 * so no src file may even mention those specifiers.
 */
const STRUCTURALLY_CONSUMED_SPECIFIERS: readonly string[] = [
  "@payswap/security",
  "@payswap/lab",
];

/** Execution machinery owned by other packages (never constructed here). */
const FORBIDDEN_EXECUTION_VOCABULARY: readonly string[] = [
  "ConnectorExecutionRequest",
  "ProtocolAuthorizationRef",
  "validateExecutionRequest",
  "providerRequest",
  "JournalEntry",
  "postJournalEntry",
];

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/from\s+["']([^"']+)["']/g),
    ...source.matchAll(/import\s+["']([^"']+)["']/g),
  ].map((match) => match[1] ?? "");
}

describe("package boundary (W2-006)", () => {
  it("certification src/** never mentions the structurally-consumed packages (their boundary rules stay green)", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of listSourceFiles(join(PACKAGE_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of STRUCTURALLY_CONSUMED_SPECIFIERS) {
        if (source.includes(specifier)) {
          offenders.push({ file: relativeToRepoRoot(file), specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every non-relative import in certification src/** is a declared workspace dependency", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of listSourceFiles(join(PACKAGE_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) {
          continue;
        }
        if (!DECLARED_WORKSPACE_DEPS.includes(specifier)) {
          offenders.push({ file: relativeToRepoRoot(file), specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("certification src/** imports only the directly-consumable workspace packages", () => {
    // The immune-system and Lab packages are consumed structurally; every
    // actual import in src must be one of the four directly consumable
    // packages (protocol/agents/capabilities/connectors).
    const allowed: readonly string[] = [
      "@payswap/protocol",
      "@payswap/agents",
      "@payswap/capabilities",
      "@payswap/connectors",
    ];
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of listSourceFiles(join(PACKAGE_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) {
          continue;
        }
        if (specifier.startsWith("@payswap/") && !allowed.includes(specifier)) {
          offenders.push({ file: relativeToRepoRoot(file), specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("certification src/** never references execution machinery", () => {
    const offenders: { file: string; term: string }[] = [];
    for (const file of listSourceFiles(join(PACKAGE_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const term of FORBIDDEN_EXECUTION_VOCABULARY) {
        if (source.includes(term)) {
          offenders.push({ file: relativeToRepoRoot(file), term });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the uniform gate decision core never reads the execution mode (source-level proof)", () => {
    const source = readFileSync(
      join(PACKAGE_ROOT, "src", "uniform-gates.ts"),
      "utf8",
    );
    const start = source.indexOf("export function evaluateUniformGates");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("/** The wall result");
    expect(end).toBeGreaterThan(start);
    const decisionBody = source.slice(start, end);
    expect(decisionBody.includes("executionMode")).toBe(false);
    expect(decisionBody.includes("isIncumbentBaseline")).toBe(false);
    expect(decisionBody.includes("PASS_THROUGH_NATIVE")).toBe(false);
    expect(decisionBody.includes("COMPOSED_PAYSWAP")).toBe(false);
    expect(decisionBody.includes("OPTIMIZED_MULTI_PROVIDER")).toBe(false);
  });

  it("THE uniform requirements are one frozen constant over all three gates", () => {
    const source = readFileSync(
      join(PACKAGE_ROOT, "src", "uniform-gates.ts"),
      "utf8");
    // Exactly ONE exported requirements constant, frozen at declaration.
    const declarations = source.match(
      /export const UNIFORM_GATE_REQUIREMENTS[^;]*;/g,
    );
    expect(declarations).toHaveLength(1);
    expect(String(declarations?.[0]).includes("Object.freeze")).toBe(true);
    // The requirements TYPE carries no mode parameter.
    const requirementsType = source.slice(
      source.indexOf("export interface UniformGateRequirements"),
      source.indexOf("export const UNIFORM_GATE_REQUIREMENTS"),
    );
    expect(requirementsType.includes("executionMode")).toBe(false);
    expect(requirementsType.includes("ExecutionMode")).toBe(false);
  });
});
