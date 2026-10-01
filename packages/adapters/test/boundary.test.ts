import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (@payswap/adapters), W3-003.
 *
 * 1. every non-relative import in src/** is a declared @payswap/* dependency
 *    of this package's package.json (allowed: @payswap/protocol,
 *    @payswap/connectors, @payswap/execution) or a node: builtin (the
 *    deterministic HMAC webhook verifier uses node:crypto);
 * 2. no runtime npm dependency is ever imported — provider SDKs are
 *    FORBIDDEN in contract/framework code (they live inside connector
 *    implementations only);
 * 3. src/** never imports @payswap/interfaces (no second, parallel connector
 *    vocabulary) nor @payswap/agents / @payswap/trust / @payswap/api /
 *    @payswap/payment (authority direction and plane separation);
 * 4. determinism guards: no Math.random, no Date.now, no setTimeout in src/.
 */

const MAX_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/protocol",
  "@payswap/connectors",
  "@payswap/execution",
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

describe("package boundary (@payswap/adapters)", () => {
  it("scans a non-empty src tree", () => {
    const files = listSourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("declares only allowed workspace dependencies", () => {
    const declared = declaredWorkspaceDependencies();
    for (const dep of declared) {
      expect(MAX_WORKSPACE_DEPS).toContain(dep);
    }
  });

  it("src/** imports only declared @payswap/* dependencies and node: builtins", () => {
    const root = join(process.cwd(), "src");
    const declared = new Set(declaredWorkspaceDependencies());
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) {
          continue;
        }
        if (!specifier.startsWith("@payswap/")) {
          offenders.push(
            `${file.replace(root + sep, "")}: non-workspace import '${specifier}' (provider SDKs live inside connector implementations, never in the framework)`,
          );
        } else if (!declared.has(specifier)) {
          offenders.push(`${file.replace(root + sep, "")}: undeclared workspace import '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports parallel vocabularies or other planes", () => {
    const root = join(process.cwd(), "src");
    const forbidden = [
      "@payswap/interfaces",
      "@payswap/agents",
      "@payswap/trust",
      "@payswap/api",
      "@payswap/payment",
    ];
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (forbidden.includes(specifier)) {
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

  it("never imports a provider SDK (no 'stripe'/'adyen'/'checkout' npm imports anywhere in src)", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      if (/from\s+["'](stripe|adyen|checkout|braintree|paypal)["']/.test(source)) {
        offenders.push(file.replace(root + sep, ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});
