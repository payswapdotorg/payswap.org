import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (P4-W3-001; mirrors the onchain-threat-intel /
 * best-execution boundary-guard pattern).
 *
 * 1. Every non-relative import in src/** is a declared workspace
 *    dependency of this package's package.json (the dependency-audit
 *    allowlist registers the same surface in the SAME commit).
 * 2. src/** NEVER references the Lab runtime package (INV-L01: the
 *    simulator is not callable from any production path) — the Lab model
 *    is consumed from the test layer only, like every other Lab consumer.
 * 3. src/** contains NO vendor-SDK and NO venue-specific vocabulary: the
 *    adapter plane's neutrality law extends to the Lab (no chain vendor,
 *    no venue lock-in, no provider SDK).
 * 4. src/** owns NO execution/broadcast/authorization machinery: the Lab
 *    never broadcasts, never signs, never mints authorization artifacts.
 * 5. No randomness, no ambient clock, no floating-point parsing in src/**.
 * 6. Test fixtures use obviously-synthetic addresses only.
 * 7. The package.json dependency surface matches the allowlist
 *    registration exactly, with recorded justifications (repo law).
 */

const PACKAGE_ROOT = process.cwd(); // vitest runs from packages/mixed-rail
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
  "@payswap/onchain-adapters",
  "@payswap/onchain-domain",
  "@payswap/onchain-security",
  "@payswap/onchain-venues",
  "@payswap/protocol",
];

const DECLARED_DEV_DEPS: readonly string[] = [
  "@payswap/agents",
  "@payswap/capabilities",
  "@payswap/connectors",
  "@payswap/lab",
  "typescript",
  "vitest",
];

/** Execution/broadcast/authorization machinery the Lab never owns. */
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

describe("package boundary (P4-W3-001)", () => {
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

  it("src/** contains no vendor-SDK vocabulary (the neutrality law extends to the Lab)", () => {
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
    const forbidden = [/uniswap/i, /sushi/i, /curve\/v/i, /1inch/i, /balancer/i, /cowswap/i, /zeroswap/i, /solverbatch/i];
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

  it("src/** owns no execution/broadcast/authorization machinery (propose and observe, never execute)", () => {
    const offenders: { file: string; term: string }[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const term of FORBIDDEN_EXECUTION_VOCABULARY) {
        if (source.includes(term)) {
          offenders.push({ file: relativeToPackageRoot(file), term });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no randomness, ambient clock or floating-point parsing anywhere in src/**", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (source.includes("Math.random")) {
        offenders.push(`${relativeToPackageRoot(file)}: Math.random`);
      }
      if (/parseFloat\(/.test(source)) {
        offenders.push(`${relativeToPackageRoot(file)}: parseFloat`);
      }
      if (/\bnew Date\(/.test(source)) {
        offenders.push(`${relativeToPackageRoot(file)}: ambient clock (new Date)`);
      }
      if (/\bDate\.now\(/.test(source)) {
        offenders.push(`${relativeToPackageRoot(file)}: ambient clock (Date.now)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("test fixtures use obviously-synthetic addresses only (no real-world addresses)", () => {
    const testFiles = listSourceFiles(join(PACKAGE_ROOT, "test"));
    const offenders: string[] = [];
    // Well-known real-world mainnet addresses (spot list), assembled at
    // RUNTIME from fragments so the literals never appear in source.
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
          offenders.push(`${relativeToPackageRoot(file)}: real-world address ${address.slice(0, 8)}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the package.json dependency surface matches the allowlist registration (repo law)", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      DECLARED_WORKSPACE_DEPS.slice().sort(),
    );
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(
      DECLARED_DEV_DEPS.slice().sort(),
    );
    // and the allowlist registers this workspace with the same surface.
    const allowlistPath = join(
      REPO_ROOT,
      "packages",
      "web",
      "test",
      "dependency-audit-allowlist.json",
    );
    const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")) as {
      workspaces: Record<
        string,
        { dependencies?: string[]; devDependencies?: string[] }
      >;
      justifications: Record<string, string>;
    };
    const entry = allowlist.workspaces["packages/mixed-rail"];
    expect(entry?.dependencies?.slice().sort()).toEqual(
      DECLARED_WORKSPACE_DEPS.slice().sort(),
    );
    expect(entry?.devDependencies?.slice().sort()).toEqual(
      DECLARED_DEV_DEPS.slice().sort(),
    );
    for (const dep of DECLARED_WORKSPACE_DEPS) {
      const key = `packages/mixed-rail|dependencies|${dep}`;
      expect(allowlist.justifications[key]?.length ?? 0).toBeGreaterThan(20);
    }
    for (const dep of ["@payswap/agents", "@payswap/capabilities", "@payswap/connectors", "@payswap/lab"]) {
      const key = `packages/mixed-rail|devDependencies|${dep}`;
      expect(allowlist.justifications[key]?.length ?? 0).toBeGreaterThan(20);
    }
  });
});
