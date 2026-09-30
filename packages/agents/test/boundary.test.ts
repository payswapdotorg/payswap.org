import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (@payswap/agents), adapted for the W2-002 consolidation.
 *
 * Stage-0 rule: src/** contains ZERO non-relative imports (fully
 * self-contained). W2-002 mandates (a) consolidation of shared primitives
 * onto @payswap/protocol (injected clock + id factory, exact money) and
 * @payswap/trust (evaluate/attenuate authority for organization execution and
 * the runtime tool-request gate). The boundary therefore evolves from "no
 * workspace imports" to "ONLY the declared workspace dependencies":
 *
 * 1. every non-relative import in src/** is a declared @payswap/* dependency
 *    of this package's package.json (no undeclared dependency can appear);
 * 2. the declared workspace dependency set is a subset of the frozen maximum
 *    allowlist for this package (no scope creep beyond consolidation);
 * 3. no runtime (non-@payswap) dependency is ever imported.
 */

const MAX_WORKSPACE_DEPS: readonly string[] = ["@payswap/protocol", "@payswap/trust"];

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

describe("package boundary (@payswap/agents)", () => {
  it("scans a non-empty src tree", () => {
    const files = listSourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThanOrEqual(8);
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

  it("never imports @payswap/capabilities (vocabulary direction: W2-003 owns it)", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier === "@payswap/capabilities") {
          offenders.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
