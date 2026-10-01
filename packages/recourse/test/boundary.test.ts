import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (@payswap/recourse), W1-006.
 *
 * 1. every non-relative import in src/** is a declared @payswap/* dependency
 *    of this package's package.json (allowed: @payswap/protocol,
 *    @payswap/settlement — exactly the two planes the Work Order assigns);
 * 2. no runtime (non-@payswap) dependency is ever imported;
 * 3. src/** never imports parallel vocabularies or other authority planes
 *    (@payswap/interfaces, @payswap/agents, @payswap/trust, @payswap/api,
 *    @payswap/capabilities, @payswap/adapters, @payswap/participation,
 *    @payswap/connectors, @payswap/payment, @payswap/execution,
 *    @payswap/rails) — recourse consumes the protocol + settlement planes
 *    only;
 * 4. determinism guards: no Math.random, no Date.now, no setTimeout in src/.
 */

const MAX_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/protocol",
  "@payswap/settlement",
];

const FORBIDDEN_IMPORTS: readonly string[] = [
  "@payswap/interfaces",
  "@payswap/agents",
  "@payswap/trust",
  "@payswap/api",
  "@payswap/capabilities",
  "@payswap/adapters",
  "@payswap/participation",
  "@payswap/connectors",
  "@payswap/payment",
  "@payswap/execution",
  "@payswap/rails",
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

describe("package boundary (@payswap/recourse)", () => {
  it("scans a non-empty src tree", () => {
    const files = listSourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it("declares only allowed workspace dependencies", () => {
    const declared = declaredWorkspaceDependencies();
    expect(declared.sort()).toEqual([...MAX_WORKSPACE_DEPS].sort());
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
          offenders.push(
            `${file.replace(root + sep, "")}: non-workspace import '${specifier}'`,
          );
        } else if (!declared.has(specifier)) {
          offenders.push(`${file.replace(root + sep, "")}: undeclared workspace import '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports parallel vocabularies or other authority planes", () => {
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

  it("uses no ambient entropy or timers in src/**", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      if (source.includes("Math.random") || source.includes("Date.now") || source.includes("setTimeout")) {
        offenders.push(file.replace(root + sep, ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});
