import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (W2-006 + the P4-W4-003 production-certification
 * extension; AGENTS.md rules 1/5/7/16/17; INV-C07).
 *
 * 1. certification src/** imports ONLY the workspace dependencies whose
 *    boundary rules permit cross-package consumption. The W2-006 core
 *    (suites/security-gates/replay-fault/promotion/uniform-gates) consumes
 *    protocol, agents, capabilities, connectors. The P4-W4-003
 *    production-certification module (src/production/**) ADDITIONALLY
 *    consumes the merged kernels it certifies — the W1-002 onchain
 *    security kernel, the W1-001 onchain domain, the W2-002 best-execution
 *    engine, the W2-001 venue packs, the W3-001 mixed-rail Lab extension,
 *    the W4-001 route compiler, the W1-003 merchant-crypto + W2-003
 *    merchant-checkout, the W3-002 opportunity engine, the W3-003 threat
 *    intelligence, the W3-007 operations/deployment contracts, the W4-002
 *    surface API and their trust/payment/settlement/interfaces foundations
 *    — each DECLARED in package.json and each justified by the
 *    certification doctrine: the journeys drive the REAL composed kernels
 *    end-to-end (no re-implementations, no logic doubles; only the
 *    declared narrow port doubles at the external seams, declared in
 *    src/production/world.ts).
 *    The immune-system package and the Lab package remain consumed
 *    STRUCTURALLY (their own boundary rules forbid src imports): the real
 *    advisory/quarantine/epoch machinery is driven through the contracts
 *    by the TEST battery (the gate-17 wiring proof), never from src.
 *    The @payswap/operations deployment machinery is likewise driven from
 *    the TEST layer (devDependency — the same consumption pattern as the
 *    deployment scripts' esbuild bundles): operations' vendored
 *    node-builtins are program-global ambient declarations, so a
 *    src-level import would change every consuming workspace's
 *    typecheck program. Its receipts feed the certification report as
 *    inputs (the composed exercise in test/production/).
 * 2. src/** never references connector EXECUTION machinery: the
 *    certification layer gates, orders, records and CERTIFIES artifacts;
 *    it never constructs execution requests. (The journeys exercise the
 *    kernels' own execution vocabularies — the kernel-owned words, never
 *    the connector execution machinery owned by other packages.)
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
  // P4-W4-003 production-certification dependencies (each justified by
  // the certification doctrine — the journeys/gates drive the REAL
  // composed kernels end-to-end):
  "@payswap/trust", // the Principal/AmountSpec foundations the kernel requests carry
  "@payswap/payment", // merchant settlement destinations/acceptance policies (Journey D/E fixtures)
  "@payswap/settlement", // the reconciliation-resolution vocabulary (Journey I/D exits)
  "@payswap/interfaces", // the API version the deployment record binds
  "@payswap/onchain-domain", // chain/asset/observation/finality vocabulary (Journey A/I)
  "@payswap/onchain-security", // THE W1-002 kernel every wallet journey walks
  "@payswap/onchain-venues", // the REAL venue packs (Uniswap v2 / aggregator / intents)
  "@payswap/onchain-venues/uniswap", // the Uniswap v2 reference pack (the venue subpath exports)
  "@payswap/onchain-venues/aggregator", // the RFQ aggregator pack
  "@payswap/onchain-venues/intents", // the batch-intents pack
  "@payswap/onchain-opportunities", // the W3-002 discovery engine (Journey G)
  "@payswap/onchain-threat-intel", // the W3-003 adversarial agent + verdict lattice (Journey F)
  "@payswap/best-execution", // the W2-002 engine: routes, exact math, execution records (Journey B)
  "@payswap/mixed-rail", // the W3-001 lane composer + Lab walk (Journeys B/E/I)
  "@payswap/route-compiler", // the W4-001 compiler + walks (Journeys A/C/E/I)
  "@payswap/merchant-crypto", // quotes/acceptance/settlement-route families (Journey D/E)
  "@payswap/merchant-checkout", // the W2-003 composed merchant kernel (Journeys D/I)
  "@payswap/surface", // the W4-002 surface folds the disclosure/gate views render through
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
    // actual import in src must be a declared, justified workspace
    // dependency (the W2-006 core four + the P4-W4-003 certification
    // dependencies enumerated in DECLARED_WORKSPACE_DEPS with their
    // justifications).
    const allowed: readonly string[] = DECLARED_WORKSPACE_DEPS;
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
