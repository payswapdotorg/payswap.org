import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync as readPackageJson } from "node:fs";

/**
 * Package boundary (@payswap/onchain-domain).
 *
 * Stage-0 rule: src/** contains ZERO non-relative imports (fully
 * self-contained) EXCEPT the declared @payswap/* workspace dependencies:
 *
 * 1. every non-relative import in src/** is a declared @payswap/* dependency
 *    of this package's package.json (no undeclared dependency can appear);
 * 2. the declared workspace dependency set is a subset of the frozen maximum
 *    allowlist for this package (no scope creep);
 * 3. no runtime (non-@payswap) dependency is ever imported;
 * 4. tests may additionally consume @payswap/settlement for the compiled-
 *    against canonical-settlement-machinery integration checks.
 */

const MAX_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/capabilities",
  "@payswap/connectors",
  "@payswap/protocol",
];

const MAX_WORKSPACE_TEST_DEPS: readonly string[] = [
  "@payswap/settlement",
];

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

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromRe = /\bfrom\s*(["'])([^"']+)\1/g;
  const dynamicRe = /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g;
  const sideEffectRe = /(?:^|[;\n])\s*import\s*(["'])([^"']+)\1/g;
  for (const match of source.matchAll(fromRe)) {
    specifiers.push(match[2] as string);
  }
  for (const match of source.matchAll(dynamicRe)) {
    specifiers.push(match[2] as string);
  }
  for (const match of source.matchAll(sideEffectRe)) {
    specifiers.push(match[2] as string);
  }
  return specifiers;
}

describe("package boundary (@payswap/onchain-domain)", () => {
  const srcDir = join(process.cwd(), "src");
  const testDir = join(process.cwd(), "test");
  const srcFiles = listSourceFiles(srcDir);
  const testFiles = listSourceFiles(testDir).filter((file) => !file.endsWith(".d.ts"));

  const pkg = JSON.parse(readPackageJson(join(process.cwd(), "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const declaredDeps = Object.keys(pkg.dependencies);
  const declaredTestDeps = Object.keys(pkg.devDependencies).filter((dep) =>
    dep.startsWith("@payswap/"),
  );

  it("src/** imports only declared @payswap/* workspace dependencies and relative modules", () => {
    expect(srcFiles.length).toBeGreaterThan(0);
    for (const file of srcFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".")) {
          continue;
        }
        expect(specifier.startsWith("@payswap/")).toBe(true);
        expect(declaredDeps).toContain(specifier);
      }
    }
  });

  it("the declared dependency set is a subset of the frozen maximum allowlist", () => {
    for (const dep of declaredDeps) {
      expect(MAX_WORKSPACE_DEPS).toContain(dep);
    }
    expect(declaredDeps.sort()).toEqual([...MAX_WORKSPACE_DEPS].sort());
  });

  it("test/** imports only the allowed @payswap/* surface (settlement is the compiled-against consumer check)", () => {
    for (const file of testFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") || specifier === "vitest" || specifier.startsWith("node:")) {
          continue;
        }
        expect(specifier.startsWith("@payswap/")).toBe(true);
        expect(
          [...MAX_WORKSPACE_DEPS, ...MAX_WORKSPACE_TEST_DEPS].includes(specifier),
        ).toBe(true);
      }
    }
  });

  it("declared @payswap test dependencies stay within the test allowlist", () => {
    for (const dep of declaredTestDeps) {
      expect([...MAX_WORKSPACE_DEPS, ...MAX_WORKSPACE_TEST_DEPS]).toContain(dep);
    }
  });

  it("no runtime (non-@payswap) dependency is imported anywhere", () => {
    for (const file of [...srcFiles, ...testFiles]) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("@payswap/") ||
          specifier === "vitest"
        ) {
          continue;
        }
        expect(specifier.startsWith("node:")).toBe(true);
      }
    }
    // And package.json carries no runtime dependency besides the allowlist.
    expect(Object.keys(pkg.dependencies).every((dep) => MAX_WORKSPACE_DEPS.includes(dep))).toBe(
      true,
    );
  });
});
