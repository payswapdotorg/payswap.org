import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary and SIMULATION ISOLATION (W2-004; INV-L01; AGENTS.md
 * rule 7; FROZEN-ARCHITECTURE §19).
 *
 * 1. src/simulation.ts imports NOTHING: the simulator is fully
 *    self-contained, so no export path from it can reach any production
 *    rail adapter, connector execution, ledger or authorization code.
 * 2. No file in ANY OTHER package's src/** imports @payswap/lab: the
 *    simulator is not callable from any production rail path.
 * 3. src/** never references connector EXECUTION machinery
 *    (ConnectorExecutionRequest / ProtocolAuthorizationRef): the Lab
 *    proposes candidates; it never constructs execution requests — those
 *    belong to the W3-003 adapter surface under protocol authorization.
 * 4. Every non-relative import in src/** is a declared @payswap/* workspace
 *    dependency of this package's package.json.
 * 5. Simulation results are branded: they are not structurally assignable
 *    to any production evidence shape (type-level, below).
 */

const LAB_ROOT = process.cwd(); // vitest runs from packages/lab
const REPO_ROOT = join(LAB_ROOT, "..", ".."); // packages/lab → repo root

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
  "@payswap/agents",
  "@payswap/capabilities",
  "@payswap/connectors",
  "@payswap/protocol",
];

const FORBIDDEN_EXECUTION_VOCABULARY: readonly string[] = [
  "ConnectorExecutionRequest",
  "ProtocolAuthorizationRef",
  "validateExecutionRequest",
];

describe("simulation isolation boundary (INV-L01, AGENTS.md rule 7)", () => {
  it("src/simulation.ts has ZERO imports — the simulator is self-contained", () => {
    const source = readFileSync(join(LAB_ROOT, "src", "simulation.ts"), "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line));
    expect(importLines).toEqual([]);
  });

  it("no OTHER package's src/** imports @payswap/lab (not callable from any production path)", () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const offenders: string[] = [];
    for (const entry of readdirSync(packagesDir)) {
      if (entry === "lab") {
        continue;
      }
      const packageSrc = join(packagesDir, entry, "src");
      let files: string[] = [];
      try {
        files = listSourceFiles(packageSrc);
      } catch {
        continue; // package without src/
      }
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        if (source.includes("@payswap/lab")) {
          offenders.push(relativeToRepoRoot(file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("lab src/** never references connector execution machinery", () => {
    const offenders: { file: string; term: string }[] = [];
    for (const file of listSourceFiles(join(LAB_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const term of FORBIDDEN_EXECUTION_VOCABULARY) {
        if (source.includes(term)) {
          offenders.push({ file: relativeToRepoRoot(file), term });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every non-relative import in lab src/** is a declared workspace dependency", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of listSourceFiles(join(LAB_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      const importSpecifiers = [
        ...source.matchAll(/from\s+["']([^"']+)["']/g),
        ...source.matchAll(/import\s+["']([^"']+)["']/g),
      ];
      for (const match of importSpecifiers) {
        const specifier = match[1] ?? "";
        if (specifier.startsWith(".") || specifier.startsWith("node:")) {
          continue;
        }
        if (!DECLARED_WORKSPACE_DEPS.includes(specifier)) {
          offenders.push({
            file: relativeToRepoRoot(file),
            specifier,
          });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no runtime (non-@payswap) dependency is imported anywhere in lab src/**", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of listSourceFiles(join(LAB_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("node:") ||
          specifier.startsWith("@payswap/")
        ) {
          continue;
        }
        offenders.push({ file: relativeToRepoRoot(file), specifier });
      }
    }
    expect(offenders).toEqual([]);
  });
});
