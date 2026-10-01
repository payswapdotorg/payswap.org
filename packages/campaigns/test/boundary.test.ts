import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (@payswap/campaigns), following the repo-wide
 * boundary-test convention (see packages/participation/test/boundary.test.ts):
 *
 * 1. every non-relative import in src/** is a declared @payswap/* dependency
 *    of this package's package.json (no undeclared dependency can appear);
 * 2. the declared workspace dependency set is a subset of the frozen maximum
 *    allowlist for this package (W3-005 scope: @payswap/participation +
 *    @payswap/protocol only);
 * 3. no runtime (non-@payswap) dependency is ever imported by src/**;
 * 4. the package never imports authority domains it must not consume
 *    (agents, capabilities, connectors, trust, interfaces, payment, lab,
 *    execution, settlement, adapters, api).
 */

const MAX_WORKSPACE_DEPS: readonly string[] = ["@payswap/participation", "@payswap/protocol"];

const FORBIDDEN_IMPORTS: readonly string[] = [
  "@payswap/agents",
  "@payswap/capabilities",
  "@payswap/connectors",
  "@payswap/trust",
  "@payswap/interfaces",
  "@payswap/payment",
  "@payswap/lab",
  "@payswap/execution",
  "@payswap/settlement",
  "@payswap/adapters",
  "@payswap/api",
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
    const specifier = match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  for (const match of source.matchAll(dynamicRe)) {
    const specifier = match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  for (const match of source.matchAll(sideEffectRe)) {
    const specifier = match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function declaredWorkspaceDependencies(): string[] {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {}).filter((dep) => dep.startsWith("@payswap/"));
}

describe("package boundary (@payswap/campaigns)", () => {
  it("scans a non-empty src tree", () => {
    const files = listSourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it("declares only allowed workspace dependencies", () => {
    const declared = declaredWorkspaceDependencies();
    for (const dep of declared) {
      expect(MAX_WORKSPACE_DEPS).toContain(dep);
    }
  });

  it("src/** imports only declared @payswap/* workspace dependencies", () => {
    const root = join(process.cwd(), "src");
    const declared = new Set(declaredWorkspaceDependencies());
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".")) {
          continue;
        }
        if (!specifier.startsWith("@payswap/")) {
          offenders.push(`${file.replace(root + sep, "")}: non-workspace import '${specifier}'`);
        } else if (!declared.has(specifier)) {
          offenders.push(`${file.replace(root + sep, "")}: undeclared workspace import '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports authority domains outside its scope", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (FORBIDDEN_IMPORTS.includes(specifier)) {
          offenders.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps relative imports on the NodeNext .js convention", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
          offenders.push(`${file.replace(root + sep, "")}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
