import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (P4-W3-003; mirrors the onchain-security /
 * best-execution boundary-guard pattern).
 *
 * 1. src/** NEVER references the security immune-system package (not even
 *    as a string): its own boundary test forbids src-level consumers; the
 *    composition with the real machinery is a wiring/test-layer concern
 *    (the W1-002 pattern). This keeps BOTH boundary tests green.
 * 2. Every non-relative import in src/** is a declared workspace
 *    dependency of this package's package.json.
 * 3. src/** contains NO venue vocabulary and NO execution/broadcast
 *    vocabulary: the adversarial agent detects threats, it never executes.
 * 4. No floating-point money/threshold arithmetic in src/**: exact
 *    integers, rationals and basis points only (spot-scan for the
 *    forbidden `Math.random` and `parseFloat`/`Number(` constructions of
 *    inexact comparison on financial magnitudes).
 * 5. Fixtures in test/** use obviously-synthetic addresses only.
 */

const PACKAGE_ROOT = process.cwd(); // vitest runs from packages/onchain-threat-intel
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

const SRC_FILES = listSourceFiles(join(PACKAGE_ROOT, "src"));

const DECLARED_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/best-execution",
  "@payswap/onchain-security",
  "@payswap/protocol",
  "@payswap/trust",
];

/** Execution/broadcast machinery this package must never own. */
const FORBIDDEN_EXECUTION_VOCABULARY: readonly string[] = [
  "broadcastTransaction",
  "BroadcastHandoff",
  "signTransaction",
  "sendTransaction",
  "postJournalEntry",
  "issueAuthorization",
  "grantAuthority",
  "SignedApprovalArtifact",
];

describe("package boundary (P4-W3-003)", () => {
  it("src/** never references the immune-system package (composition is wiring/test-layer — W1-002 law)", () => {
    expect(SRC_FILES.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (source.includes("@payswap/security")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every non-relative import in src/** is a declared workspace dependency", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of SRC_FILES) {
      let source = readFileSync(file, "utf8");
      // Strip template literals first: detector summaries legitimately
      // contain prose like "changed from 'X' to 'Y'" which would otherwise
      // false-positive the import-pattern scan.
      source = source.replace(/`[^`]*`/g, "``");
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
          offenders.push({ file, specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** contains no venue-specific vocabulary (the intel layer is venue-agnostic)", () => {
    const forbidden = [/uniswap/i, /sushi/i, /curve\/v/i, /1inch/i, /balancer/i, /cowswap/i];
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          offenders.push(`${file} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** owns no execution/broadcast machinery (detect, never execute)", () => {
    const offenders: { file: string; term: string }[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const term of FORBIDDEN_EXECUTION_VOCABULARY) {
        if (source.includes(term)) {
          offenders.push({ file, term });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no randomness or floating-point parsing anywhere in src/**", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (source.includes("Math.random")) {
        offenders.push(`${file}: Math.random`);
      }
      if (/parseFloat\(|Number\(\s*[a-zA-Z][^)]*\.\s*(replace|split|substring)/.test(source)) {
        offenders.push(`${file}: float parsing`);
      }
      if (/\bnew Date\(/.test(source)) {
        offenders.push(`${file}: ambient clock (new Date)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("test fixtures use obviously-synthetic addresses only (no real-world addresses)", () => {
    const testFiles = listSourceFiles(join(PACKAGE_ROOT, "test"));
    const offenders: string[] = [];
    // Well-known real-world mainnet addresses (spot list), assembled at
    // RUNTIME from fragments so the literals never appear in source (the
    // repo's credential-shape discipline applied to address fixtures).
    const knownReal = [
      ["0xdAC17F958D2ee523a2206206994597", "C13D831ec7"],
      ["0xA0b86991c6218b36c1d19D4a2e9Eb0", "cE3606eB48"],
      ["0xC02aaA39b223FE8D0A0e5C4F27eAD9", "083C756Cc2"],
      ["0x514910771AF9Ca656af840dff83E8", "264EcF986CA"],
    ].map((parts) => parts.join(""));
    for (const file of testFiles) {
      const source = readFileSync(file, "utf8");
      for (const address of knownReal) {
        if (source.includes(address)) {
          offenders.push(`${file}: real-world address ${address.slice(0, 8)}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the package.json dependency surface matches the allowlist registration (repo law)", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      DECLARED_WORKSPACE_DEPS.slice().sort(),
    );
    expect(Object.keys(pkg.devDependencies).sort()).toEqual([
      "@payswap/security",
      "typescript",
      "vitest",
    ]);
    // and the allowlist registers this workspace with the same surface.
    const allowlistPath = join(
      REPO_ROOT,
      "packages",
      "web",
      "test",
      "dependency-audit-allowlist.json",
    );
    const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")) as {
      workspaces: Record<string, { dependencies?: string[]; devDependencies?: string[] }>;
      justifications: Record<string, string>;
    };
    const entry = allowlist.workspaces["packages/onchain-threat-intel"];
    expect(entry?.dependencies?.slice().sort()).toEqual(
      DECLARED_WORKSPACE_DEPS.slice().sort(),
    );
    expect(entry?.devDependencies?.slice().sort()).toEqual([
      "@payswap/security",
      "typescript",
      "vitest",
    ]);
    for (const dep of DECLARED_WORKSPACE_DEPS) {
      const key = `packages/onchain-threat-intel|dependencies|${dep}`;
      expect(allowlist.justifications[key]?.length ?? 0).toBeGreaterThan(20);
    }
    const devKey = "packages/onchain-threat-intel|devDependencies|@payswap/security";
    expect(allowlist.justifications[devKey]?.length ?? 0).toBeGreaterThan(20);
  });
});
