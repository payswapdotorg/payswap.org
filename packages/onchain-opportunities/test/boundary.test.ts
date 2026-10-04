import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync as readFile } from "node:fs";

/**
 * Package boundary (P4-W3-002; mirrors the mixed-rail / onchain-threat-intel
 * boundary-guard pattern).
 *
 * 1. Every non-relative import in src/** is a declared workspace
 *    dependency of this package's package.json (the dependency-audit
 *    allowlist registers the same surface in the SAME commit).
 * 2. src/** NEVER references the Lab runtime package (INV-L01: the Lab is
 *    driven from the test layer only, like every other Lab consumer).
 * 3. src/** contains NO vendor-SDK and NO venue-specific vocabulary (the
 *    neutrality law extends to discovery).
 * 4. src/** owns NO execution/broadcast/authorization machinery (discovery
 *    is never authorization).
 * 5. No randomness, no ambient clock, no floating-point parsing in src/**.
 * 6. The package.json dependency surface matches the allowlist
 *    registration exactly (repo law).
 */

const PACKAGE_ROOT = process.cwd(); // vitest runs from packages/onchain-opportunities
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

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

function relativeToPackageRoot(full: string): string {
  return full.substring(PACKAGE_ROOT.length + sep.length);
}

const SRC_FILES = listSourceFiles(join(PACKAGE_ROOT, "src"));

const DECLARED_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/best-execution",
  "@payswap/onchain-domain",
  "@payswap/onchain-security",
  "@payswap/protocol",
];

const DECLARED_DEV_DEPS: readonly string[] = [
  "@payswap/agents",
  "@payswap/connectors",
  "@payswap/lab",
  "typescript",
  "vitest",
];

/** Execution/broadcast/authorization machinery discovery never owns. */
const FORBIDDEN_EXECUTION_VOCABULARY: readonly string[] = [
  "broadcastTransaction",
  "BroadcastHandoff",
  "signTransaction",
  "sendTransaction",
  "postJournalEntry",
  "issueAuthorization",
  "grantAuthority",
  "mintAuthorization",
  "SignedApprovalArtifact",
  "TrustedApprovalSurface",
];

/** Chain/vendor SDK vocabulary that must never appear (neutrality law). */
const FORBIDDEN_VENDOR_VOCABULARY: readonly RegExp[] = [
  /\bethers\b/i,
  /\bviem\b/i,
  /\bweb3\b/i,
  /\bsolana-web3\b/i,
  /\balchemy\b/i,
  /\binfura\b/i,
  /\bquicknode\b/i,
  /\btenderly\b/i,
  /\bcovalent\b/i,
  /\bmoralis\b/i,
  /\bblocknative\b/i,
];

describe("package boundary (P4-W3-002)", () => {
  it("every non-relative import in src/** is a declared workspace dependency", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of SRC_FILES) {
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
          offenders.push({ file: relativeToPackageRoot(file), specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** never references the Lab runtime package (INV-L01 — not even as a string)", () => {
    expect(SRC_FILES.length).toBeGreaterThan(3);
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (source.includes("@payswap/lab")) {
        offenders.push(relativeToPackageRoot(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** contains no vendor-SDK vocabulary (the neutrality law extends to discovery)", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_VENDOR_VOCABULARY) {
        if (pattern.test(source)) {
          offenders.push(`${relativeToPackageRoot(file)} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** owns no venue-specific vocabulary (venue-neutral like the engine core)", () => {
    const forbidden = [
      /uniswap/i,
      /sushi/i,
      /curve\/v/i,
      /1inch/i,
      /balancer/i,
      /cowswap/i,
      /zeroswap/i,
      /solverbatch/i,
      /aave/i,
      /compound/i,
      /lido/i,
      /maker/i,
    ];
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          offenders.push(`${relativeToPackageRoot(file)} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** owns NO execution/broadcast/authorization machinery (discovery is never authorization)", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of FORBIDDEN_EXECUTION_VOCABULARY) {
        if (source.includes(forbidden)) {
          offenders.push(`${relativeToPackageRoot(file)} contains '${forbidden}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** has no randomness, no ambient clock, no floating-point parsing (determinism law)", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (source.includes("Math.random(")) {
        offenders.push(`${relativeToPackageRoot(file)} uses Math.random`);
      }
      if (source.includes("Date.now(") || source.includes("new Date(")) {
        offenders.push(`${relativeToPackageRoot(file)} uses an ambient clock`);
      }
      if (source.includes("parseFloat(")) {
        offenders.push(`${relativeToPackageRoot(file)} parses floating point`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the package.json dependency surface matches the allowlist registration exactly (repo law)", () => {
    const packageJson = JSON.parse(
      readFile(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(packageJson.dependencies).sort()).toEqual(
      [...DECLARED_WORKSPACE_DEPS].sort(),
    );
    expect(Object.keys(packageJson.devDependencies).sort()).toEqual(
      [...DECLARED_DEV_DEPS].sort(),
    );

    const allowlist = JSON.parse(
      readFile(join(REPO_ROOT, "packages", "web", "test", "dependency-audit-allowlist.json"), "utf8"),
    ) as {
      workspaces: Record<string, { dependencies?: string[]; devDependencies?: string[] }>;
      justifications: Record<string, string>;
    };
    const registration = allowlist.workspaces["packages/onchain-opportunities"];
    expect(registration?.dependencies?.sort()).toEqual([...DECLARED_WORKSPACE_DEPS].sort());
    expect(registration?.devDependencies?.sort()).toEqual([...DECLARED_DEV_DEPS].sort());

    // SAME-commit law: every declared dependency carries a recorded
    // justification in the allowlist (typescript/vitest are the repo-wide
    // toolchain baseline and need none).
    for (const dependency of DECLARED_WORKSPACE_DEPS) {
      expect(allowlist.justifications[`packages/onchain-opportunities|dependencies|${dependency}`]).toBeDefined();
    }
    for (const dependency of DECLARED_DEV_DEPS.filter(
      (dependency) => dependency.startsWith("@payswap/"),
    )) {
      expect(allowlist.justifications[`packages/onchain-opportunities|devDependencies|${dependency}`]).toBeDefined();
    }
  });

  it("no raw secrets anywhere in the package source or tests (rule 25)", () => {
    const secretPatterns: readonly RegExp[] = [
      /ghp_[A-Za-z0-9]{20,}/,
      /github_pat_[A-Za-z0-9_]{20,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\b0x[0-9a-fA-F]{64}\b/,
      /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{16,}["']/i,
    ];
    const allFiles = [...SRC_FILES, ...listSourceFiles(join(PACKAGE_ROOT, "test"))];
    const offenders: string[] = [];
    for (const file of allFiles) {
      const source = readFileSync(file, "utf8");
      for (const pattern of secretPatterns) {
        if (pattern.test(source)) {
          offenders.push(`${relativeToPackageRoot(file)} matches secret-shaped pattern`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
