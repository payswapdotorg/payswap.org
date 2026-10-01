import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (@payswap/rails), W1-005.
 *
 * 1. every non-relative import in src/** is a declared @payswap/* dependency
 *    of this package's package.json (allowed: @payswap/protocol,
 *    @payswap/connectors, @payswap/execution, @payswap/adapters,
 *    @payswap/settlement) — no runtime npm dependency is ever imported
 *    (provider SDKs would be allowed only inside adapter implementations;
 *    this package needs none: it speaks plain HTTP/JSON-RPC);
 * 2. src/** never imports @payswap/interfaces, @payswap/agents,
 *    @payswap/trust, @payswap/api, @payswap/payment or @payswap/capabilities
 *    directly (vocabulary/authority direction; the capabilities two-axis
 *    vocabulary is consumed THROUGH @payswap/connectors);
 * 3. determinism guards: no Math.random, no Date.now anywhere in src/, and
 *    setTimeout appears ONLY as the single documented fetch-abort timer in
 *    support.ts (never as settlement/timing logic);
 * 4. the acceptance artifacts BLOCKED-RAILS.md and CREDENTIAL-ROTATION.md
 *    exist and name the credential env vars the code declares.
 */

const MAX_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/protocol",
  "@payswap/connectors",
  "@payswap/execution",
  "@payswap/adapters",
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
  return specifiers;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function declaredWorkspaceDependencies(): string[] {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {}).filter((dep) => dep.startsWith("@payswap/"));
}

describe("package boundary (@payswap/rails)", () => {
  it("scans a non-empty src tree", () => {
    const files = listSourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it("declares only allowed workspace dependencies", () => {
    const declared = declaredWorkspaceDependencies();
    expect(declared.length).toBeGreaterThan(0);
    for (const dep of declared) {
      expect(MAX_WORKSPACE_DEPS, `unexpected workspace dependency ${dep}`).toContain(dep);
    }
  });

  it("imports only declared @payswap/* packages, relative modules or node: builtins", () => {
    for (const file of listSourceFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        const ok =
          specifier.startsWith(".") ||
          specifier.startsWith("node:") ||
          (specifier.startsWith("@payswap/") && MAX_WORKSPACE_DEPS.includes(specifier));
        expect(ok, `${file} imports forbidden specifier '${specifier}'`).toBe(true);
      }
    }
  });

  it("never imports a forbidden workspace package", () => {
    const forbidden = [
      "@payswap/interfaces",
      "@payswap/agents",
      "@payswap/trust",
      "@payswap/api",
      "@payswap/payment",
      "@payswap/capabilities",
      "@payswap/participation",
    ];
    for (const file of listSourceFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        expect(forbidden, `${file} must not import '${specifier}'`).not.toContain(specifier);
      }
    }
  });

  it("has no Math.random or Date.now anywhere in src (determinism guards — comments excluded)", () => {
    for (const file of listSourceFiles(join(process.cwd(), "src"))) {
      const source = stripComments(readFileSync(file, "utf8"));
      expect(source, `${file} uses Math.random`).not.toContain("Math.random");
      expect(source, `${file} uses Date.now`).not.toContain("Date.now");
    }
  });

  it("uses setTimeout only as the single documented fetch-abort timer in support.ts", () => {
    for (const file of listSourceFiles(join(process.cwd(), "src"))) {
      const source = readFileSync(file, "utf8");
      const occurrences = (source.match(/setTimeout\(/g) ?? []).length;
      if (file.endsWith(join("src", "support.ts"))) {
        // Exactly one: the AbortController timeout in realHttpTransport.
        expect(occurrences).toBe(1);
      } else {
        expect(occurrences, `${file} must not call setTimeout`).toBe(0);
      }
    }
  });

  it("ships the BLOCKED-RAILS.md and CREDENTIAL-ROTATION.md acceptance artifacts", () => {
    const blocked = join(process.cwd(), "BLOCKED-RAILS.md");
    const rotation = join(process.cwd(), "CREDENTIAL-ROTATION.md");
    expect(existsSync(blocked)).toBe(true);
    expect(existsSync(rotation)).toBe(true);
    const blockedText = readFileSync(blocked, "utf8");
    const rotationText = readFileSync(rotation, "utf8");
    for (const envVar of [
      "PAYSWAP_RAILS_FIAT_SECRET_REF",
      "PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF",
      "PAYSWAP_RAILS_MOMO_API_USER_REF",
      "PAYSWAP_RAILS_MOMO_API_KEY_REF",
    ]) {
      expect(rotationText, `CREDENTIAL-ROTATION.md must document ${envVar}`).toContain(envVar);
    }
    expect(blockedText).toContain("INV-C01");
    expect(blockedText).toContain("INV-NC04");
  });

  it("documents the real public endpoints it exercises", () => {
    const blockedText = readFileSync(join(process.cwd(), "BLOCKED-RAILS.md"), "utf8");
    expect(blockedText).toContain("https://ethereum-rpc.publicnode.com");
    expect(blockedText).toContain(
      "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
    );
  });
});
