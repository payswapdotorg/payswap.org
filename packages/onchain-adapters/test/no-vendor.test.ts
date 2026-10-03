import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Vendor-neutrality law (P4-W2-001): NO single RPC/indexer/simulation vendor
 * is a core dependency. Enforced structurally:
 * - src/** imports ONLY @payswap/* workspace packages and relative modules —
 *   no vendor SDK (ethers, viem, web3, @solana/web3.js, bitcoinjs-lib, …);
 * - the package manifest declares NO third-party runtime dependency at all;
 * - the CORE barrel never imports a FAMILY module (core is family-neutral;
 *   the direction is strictly family → core);
 * - production transports must configure ≥2 distinct endpoint providers.
 */
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".git")) {
      continue;
    }
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, files);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolute);
    }
  }
  return files;
}

const SRC_FILES = walk(path.join(PACKAGE_ROOT, "src"));

const VENDOR_SDK_PATTERNS: readonly RegExp[] = [
  /from\s+["'](ethers|viem|web3|@ethersproject\/[^"']+|@solana\/web3\.js|@solana\/spl-token|bitcoinjs-lib|@scure\/[^"']+|@noble\/[^"']+|solc|@truffle\/[^"']+)["']/,
];

const THIRD_PARTY_IMPORT = /^@(?!payswap)/;

describe("no vendor SDK is a dependency (source scan)", () => {
  it("src/** contains vendor-SDK imports from ZERO providers", () => {
    expect(SRC_FILES.length).toBeGreaterThan(10);
    const violations: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const pattern of VENDOR_SDK_PATTERNS) {
        const match = pattern.exec(source);
        if (match !== null) {
          violations.push(`${path.relative(PACKAGE_ROOT, file)} → ${match[0]}`);
        }
      }
    }
    expect(
      violations,
      `vendor SDKs must never be imported:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("src/** imports ONLY @payswap/* packages and relative modules", () => {
    const violations: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        const importMatch = /^\s*import\s+(?:type\s+)?[^"']*from\s+["']([^"']+)["']/.exec(line);
        if (importMatch === null) continue;
        const specifier = importMatch[1] as string;
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        if (specifier.startsWith("@payswap/")) continue;
        violations.push(`${path.relative(PACKAGE_ROOT, file)} → ${specifier}`);
      }
    }
    expect(
      violations,
      `the SDK core and families import only @payswap/* + relative modules:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("the package manifest declares ZERO third-party runtime dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.keys(manifest.dependencies ?? {});
    for (const dep of deps) {
      expect(
        dep.startsWith("@payswap/"),
        `runtime dependency '${dep}' is not a workspace package — vendors live behind transport ports`,
      ).toBe(true);
    }
    // The dev dependency surface is typescript/vitest + the settlement
    // compiled-against check only.
    const devDeps = Object.keys(manifest.devDependencies ?? {}).sort();
    expect(devDeps).toEqual(["@payswap/settlement", "typescript", "vitest"]);
  });
});

describe("core/family dependency direction (family → core ONLY)", () => {
  const CORE_FILES = [
    "src/index.ts",
    "src/contract.ts",
    "src/environment.ts",
    "src/transport.ts",
    "src/semantics.ts",
    "src/lifecycle.ts",
    "src/settlement-gate.ts",
    "src/errors.ts",
  ];

  it("no core module imports a family module", () => {
    const violations: string[] = [];
    for (const relative of CORE_FILES) {
      const absolute = path.join(PACKAGE_ROOT, relative);
      if (!existsSync(absolute)) {
        violations.push(`missing core file: ${relative}`);
        continue;
      }
      const source = readFileSync(absolute, "utf8");
      if (/from\s+["']\.\/(evm|solana|utxo)\//.test(source)) {
        violations.push(`${relative} imports a family module (direction must be family → core)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the family modules exist and import the core", () => {
    for (const family of ["evm", "solana", "utxo"]) {
      const index = path.join(PACKAGE_ROOT, "src", family, "index.ts");
      expect(existsSync(index), `src/${family}/index.ts must exist`).toBe(true);
      if (!existsSync(index)) continue;
      const source = readFileSync(index, "utf8");
      expect(source).toMatch(/from\s+["']\.\.\/(lifecycle|contract|semantics|errors|transport)\.js["']/);
    }
  });

  it("the package exports expose the core barrel and the three family subpaths", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { exports: Record<string, string> };
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./evm", "./solana", "./utxo"]);
  });
});

describe("deterministic default suite excludes live endpoints", () => {
  it("the default vitest config excludes test/live/**", () => {
    const config = readFileSync(path.join(PACKAGE_ROOT, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/exclude.*test\/live/);
    const liveConfig = readFileSync(path.join(PACKAGE_ROOT, "vitest.live.config.ts"), "utf8");
    expect(liveConfig).toMatch(/test\/live\/\*\*\/\*\.live\.test\.ts/);
  });

  it("live test files exist for all three families", () => {
    for (const family of ["evm", "solana", "utxo"]) {
      const liveTest = path.join(PACKAGE_ROOT, "test", "live", `${family}.live.test.ts`);
      expect(existsSync(liveTest), `test/live/${family}.live.test.ts must exist`).toBe(true);
    }
    // The evidence directory is part of the delivery.
    expect(statSync(path.join(PACKAGE_ROOT, "evidence")).isDirectory()).toBe(true);
  });

  it("no secret material is committed in the evidence directory", () => {
    const evidenceDir = path.join(PACKAGE_ROOT, "evidence");
    for (const entry of readdirSync(evidenceDir)) {
      const content = readFileSync(path.join(evidenceDir, entry), "utf8");
      expect(
        /(api[_-]?key|secret[_-]?key|private[_-]?key|seed phrase|mnemonic|password|token=sk-)/i.exec(content),
        `evidence/${entry} must be sanitized (no keys, no credentials)`,
      ).toBeNull();
    }
  });
});
