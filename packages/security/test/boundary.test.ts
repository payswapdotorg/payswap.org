import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (W2-005; AGENTS.md rules 1/5/7/17; lab INV-L01 boundary).
 *
 * 1. No file in ANY package's src/** imports @payswap/security except
 *    packages/security itself (nothing consumes it yet — W2-006 will, on the
 *    TL's merge; production code never reaches into an unmerged package).
 * 2. security src/** NEVER imports @payswap/lab: the Lab's own boundary test
 *    (INV-L01) forbids any other package's src importing it, so Arena
 *    compatibility must be structural, not an import.
 * 3. security src/** never references financial-mutation or connector
 *    EXECUTION machinery: the immune system restricts and produces
 *    evidence; it never moves money or executes rails.
 * 4. Every non-relative import in security src/** is a declared @payswap/*
 *    workspace dependency of this package's package.json.
 * 5. src/experts.ts contains no authority vocabulary: expert output is
 *    evidence/learning only (LAB.md "Arena bridge"; no hidden authority).
 */

const SECURITY_ROOT = process.cwd(); // vitest runs from packages/security
const REPO_ROOT = join(SECURITY_ROOT, "..", ".."); // → repo root

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
  "@payswap/capabilities",
  "@payswap/agents",
  "@payswap/trust",
];

/** Financial-mutation / rail-execution machinery owned by other packages. */
const FORBIDDEN_EXECUTION_VOCABULARY: readonly string[] = [
  "ConnectorExecutionRequest",
  "ProtocolAuthorizationRef",
  "validateExecutionRequest",
  "asCommandId",
  "CommandId",
  "JournalEntry",
  "postJournalEntry",
  "SignedApprovalArtifact",
  "PermissionGrant",
  "ScopedExecutionGrant",
];

/** Authority vocabulary that must never appear in the expert bridge. */
const FORBIDDEN_AUTHORITY_VOCABULARY: readonly string[] = [
  "MandateRef",
  "SignedApprovalArtifact",
  "PermissionGrant",
  "ScopedExecutionGrant",
  "EpochScopedAuthorization",
  "issueAuthorization",
  "grantAuthority",
  "authorize(",
];

describe("package boundary (W2-005)", () => {
  it("no OTHER package's src/** imports @payswap/security (unmerged package, no consumers yet)", () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const offenders: string[] = [];
    for (const entry of readdirSync(packagesDir)) {
      if (entry === "security") {
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
        if (source.includes("@payswap/security")) {
          offenders.push(relativeToRepoRoot(file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("security src/** NEVER imports @payswap/lab (lab INV-L01 boundary stays green)", () => {
    // Comments may MENTION @payswap/lab (documenting why it is not
    // imported); actual import statements are what the lab boundary test
    // forbids, so only those count as offenders here.
    const offenders: string[] = [];
    for (const file of listSourceFiles(join(SECURITY_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      const importSpecifiers = [
        ...source.matchAll(/from\s+["']([^"']+)["']/g),
        ...source.matchAll(/import\s+["']([^"']+)["']/g),
      ];
      for (const match of importSpecifiers) {
        if (match[1] === "@payswap/lab") {
          offenders.push(relativeToRepoRoot(file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("security src/** never references financial-mutation or execution machinery", () => {
    const offenders: { file: string; term: string }[] = [];
    for (const file of listSourceFiles(join(SECURITY_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const term of FORBIDDEN_EXECUTION_VOCABULARY) {
        if (source.includes(term)) {
          offenders.push({ file: relativeToRepoRoot(file), term });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every non-relative import in security src/** is a declared workspace dependency", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of listSourceFiles(join(SECURITY_ROOT, "src"))) {
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
          offenders.push({ file: relativeToRepoRoot(file), specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no runtime (non-@payswap) dependency is imported anywhere in security src/**", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of listSourceFiles(join(SECURITY_ROOT, "src"))) {
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

  it("src/experts.ts carries no authority vocabulary — evidence and learning only", () => {
    const source = readFileSync(join(SECURITY_ROOT, "src", "experts.ts"), "utf8");
    const offenders: string[] = [];
    for (const term of FORBIDDEN_AUTHORITY_VOCABULARY) {
      if (source.includes(term)) {
        offenders.push(term);
      }
    }
    // The ONLY conversion API for expert output produces an evidence artifact.
    expect(source.includes("resolutionToEvidenceArtifact")).toBe(true);
    expect(offenders).toEqual([]);
  });

  it("the quarantine gate reads quarantine/advisory state, never the cached availability", () => {
    const source = readFileSync(
      join(SECURITY_ROOT, "src", "quarantine.ts"),
      "utf8",
    );
    // The INV-S03 gate function must exist and the decision path must never
    // branch on the cached effectiveAvailability: it consults the quarantine
    // ledger and the advisory restriction view instead.
    const gateStart = source.indexOf("export function authorizeCapabilityUse");
    expect(gateStart).toBeGreaterThan(-1);
    const gateBody = source.slice(gateStart, source.indexOf("export class SecurityGate"));
    expect(gateBody.includes("effectiveAvailability")).toBe(false);
    expect(gateBody.includes("activeQuarantinesFor")).toBe(true);
    expect(gateBody.includes("restrictionFor")).toBe(true);
  });
});
