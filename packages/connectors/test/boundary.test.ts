import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (@payswap/connectors), the canonical connector capability
 * vocabulary (W2-003; AGENTS.md rule 22).
 *
 * 1. every non-relative import in src/** is a declared @payswap/* dependency
 *    of this package's package.json (allowed: @payswap/protocol,
 *    @payswap/capabilities);
 * 2. no runtime (non-@payswap) dependency is ever imported — provider SDKs
 *    are FORBIDDEN in these provider-neutral contracts (provider quirks
 *    live in future W3-003 adapters);
 * 3. src/** never imports @payswap/interfaces (no second, parallel connector
 *    vocabulary) and never imports @payswap/agents (authority direction).
 */

const MAX_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/protocol",
  "@payswap/capabilities",
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

describe("package boundary (@payswap/connectors)", () => {
  it("scans a non-empty src tree", () => {
    const files = listSourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThanOrEqual(9);
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
          offenders.push(`${file.replace(root + sep, "")}: non-workspace import '${specifier}' (provider SDKs are forbidden in provider-neutral contracts)`);
        } else if (!declared.has(specifier)) {
          offenders.push(`${file.replace(root + sep, "")}: undeclared workspace import '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports @payswap/interfaces (no second connector vocabulary) nor @payswap/agents (authority direction)", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier === "@payswap/interfaces" || specifier === "@payswap/agents") {
          offenders.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function declaredWorkspaceDependencies(): string[] {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {}).filter((dep) => dep.startsWith("@payswap/"));
}
