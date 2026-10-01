import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (@payswap/payment), W1-003.
 *
 * The payment plane is a contract package on top of the protocol kernel:
 * 1. every non-relative import in src/** is a DECLARED @payswap/* dependency
 *    of this package's package.json (no undeclared dependencies);
 * 2. the declared workspace dependency set is a subset of the frozen
 *    maximum allowlist (protocol only — no connector/trust/agent leakage);
 * 3. no runtime (non-@payswap) dependency is ever imported;
 * 4. determinism guards: no Math.random, no Date.now, no setTimeout in src/.
 */

const MAX_WORKSPACE_DEPS: readonly string[] = ["@payswap/protocol"];

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

describe("package boundary (@payswap/payment)", () => {
  it("scans a non-empty src tree", () => {
    const files = listSourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("declares only allowed workspace dependencies", () => {
    const declared = declaredWorkspaceDependencies();
    for (const dep of declared) {
      expect(MAX_WORKSPACE_DEPS).toContain(dep);
    }
  });

  it("imports ONLY declared workspace deps + relative modules in src/**", () => {
    const declared = new Set(declaredWorkspaceDependencies());
    const offenders: string[] = [];
    for (const file of listSourceFiles(join(process.cwd(), "src"))) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.startsWith("./") || specifier.startsWith("../")) continue;
        if (specifier.startsWith("@payswap/")) {
          if (!declared.has(specifier)) {
            offenders.push(`${file} -> undeclared '${specifier}'`);
          }
          continue;
        }
        if (specifier.startsWith("node:")) {
          offenders.push(`${file} -> forbidden node builtin '${specifier}'`);
          continue;
        }
        offenders.push(`${file} -> runtime dependency '${specifier}'`);
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("never uses pseudo-randomness, ambient time or timers in src/**", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      if (source.includes("Math.random")) offenders.push(`${file}: Math.random`);
      if (source.includes("Date.now")) offenders.push(`${file}: Date.now`);
      if (source.includes("setTimeout")) offenders.push(`${file}: setTimeout`);
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("never lets floating-point money into the package (INV-F01)", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      // numeric literals with a decimal point in money-bearing modules
      if (/\b\d+\.\d+\b/.test(source)) {
        offenders.push(`${file}: floating-point literal`);
      }
    }
    expect(offenders.join("\n")).toBe("");
  });
});
