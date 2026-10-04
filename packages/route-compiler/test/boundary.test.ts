import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoSecretMaterial } from "@payswap/onchain-security";

import { PACKAGE_NAME, compileMoneyMovementRoute } from "../src/index.js";
import {
  baseCompilerInput,
  compileBase,
  route1Intent,
  stripeEligibilityEvidence,
} from "./fixtures.js";

/**
 * Package boundary (P4-W4-001; mirrors the mixed-rail / onchain-opportunities
 * boundary-guard pattern).
 *
 * 1. The package.json dependency surface matches the dependency-audit
 *    allowlist registration EXACTLY, and every @payswap/* dependency —
 *    runtime and dev — carries a recorded justification key
 *    `packages/route-compiler|<section>|<name>` in
 *    packages/web/test/dependency-audit-allowlist.json (the SAME-commit
 *    allowlist law, proven from the package side; typescript/vitest are the
 *    repo-wide toolchain baseline and need none).
 * 2. src/** NEVER imports the Lab runtime (INV-L01: the Lab is driven from
 *    the TEST layer only) and never imports @payswap/agents or
 *    @payswap/capabilities — both are devDependencies of this package,
 *    i.e. TEST-ONLY surfaces.
 * 3. No vendor SDK anywhere in src/** or test/** (the neutrality law: no
 *    chain vendor, no provider SDK, no HTTP client).
 * 4. Every non-relative import in src/** is a declared workspace dependency.
 * 5. Determinism declaration: the compiler refuses bad instants (no ambient
 *    clock — every instant is caller-supplied; determinism.test.ts proves
 *    the full law, this is the boundary-level guard).
 * 6. No secret-shaped material on any agent-facing artifact: compiled plans,
 *    the full compiler input and the Stripe eligibility evidence all pass
 *    the kernel's assertNoSecretMaterial.
 * 7. The package name is the canonical workspace name.
 */

const PACKAGE_ROOT = join(import.meta.dirname, ".."); // packages/route-compiler
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const ALLOWLIST_PATH = join(
  REPO_ROOT,
  "packages",
  "web",
  "test",
  "dependency-audit-allowlist.json",
);

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
const TEST_FILES = listSourceFiles(join(PACKAGE_ROOT, "test"));

/** Every import specifier of a source file (from "…" and import "…" forms). */
function importSpecifiers(source: string): readonly string[] {
  return [
    ...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g),
  ]
    .map((match) => match[1] ?? "")
    .filter((specifier) => /^[@\w][\w@./-]*$/.test(specifier));
}

/** The workspace package name of an import specifier (`@payswap/a/b` → `@payswap/a`). */
function workspacePackageName(specifier: string): string {
  if (!specifier.startsWith("@")) {
    return specifier.split("/")[0] ?? specifier;
  }
  const segments = specifier.split("/");
  return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : specifier;
}

const DECLARED_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/best-execution",
  "@payswap/connectors",
  "@payswap/mixed-rail",
  "@payswap/onchain-adapters",
  "@payswap/onchain-domain",
  "@payswap/onchain-opportunities",
  "@payswap/onchain-security",
  "@payswap/onchain-venues",
  "@payswap/payment",
  "@payswap/protocol",
  "@payswap/trust",
];

const DECLARED_DEV_DEPS: readonly string[] = [
  "@payswap/agents",
  "@payswap/capabilities",
  "@payswap/lab",
  "typescript",
  "vitest",
];

describe("package boundary (P4-W4-001)", () => {
  it("the package name is the canonical workspace name", () => {
    expect(PACKAGE_NAME).toBe("@payswap/route-compiler");
    expect(SRC_FILES.length).toBeGreaterThanOrEqual(10);
  });

  it("the package.json dependency surface matches the allowlist registration exactly (the SAME-commit allowlist law)", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("@payswap/route-compiler");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      [...DECLARED_WORKSPACE_DEPS].sort(),
    );
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(
      [...DECLARED_DEV_DEPS].sort(),
    );

    const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as {
      workspaces: Record<
        string,
        { dependencies?: string[]; devDependencies?: string[] }
      >;
      justifications: Record<string, string>;
    };
    const registration = allowlist.workspaces["packages/route-compiler"];
    expect(registration?.dependencies?.slice().sort()).toEqual(
      [...DECLARED_WORKSPACE_DEPS].sort(),
    );
    expect(registration?.devDependencies?.slice().sort()).toEqual(
      [...DECLARED_DEV_DEPS].sort(),
    );

    // EVERY @payswap/* entry in dependencies AND devDependencies carries a
    // recorded justification key (typescript/vitest are the repo-wide
    // toolchain baseline and need none). Proving this from the package side
    // is the same-commit law: the allowlist edit landed with the package.
    for (const dependency of DECLARED_WORKSPACE_DEPS) {
      const key = `packages/route-compiler|dependencies|${dependency}`;
      expect(allowlist.justifications[key]?.length ?? 0).toBeGreaterThan(20);
    }
    for (const dependency of DECLARED_DEV_DEPS.filter((name) =>
      name.startsWith("@payswap/"),
    )) {
      const key = `packages/route-compiler|devDependencies|${dependency}`;
      expect(allowlist.justifications[key]?.length ?? 0).toBeGreaterThan(20);
    }
    // And the allowlist registers no dependency this package does not declare.
    for (const key of Object.keys(allowlist.justifications)) {
      if (key.startsWith("packages/route-compiler|")) {
        const [, section, name] = key.split("|");
        const declared =
          section === "dependencies"
            ? DECLARED_WORKSPACE_DEPS
            : DECLARED_DEV_DEPS;
        expect(declared, `stale allowlist key ${key}`).toContain(name);
      }
    }
  });

  it("every non-relative import in src/** is a declared workspace dependency", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) {
          continue;
        }
        if (!DECLARED_WORKSPACE_DEPS.includes(workspacePackageName(specifier))) {
          offenders.push({ file: relativeToPackageRoot(file), specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** never imports the Lab runtime (INV-L01 — the Lab is TEST-layer only)", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier === "@payswap/lab" || specifier.startsWith("@payswap/lab/")) {
          offenders.push({ file: relativeToPackageRoot(file), specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** never imports @payswap/agents or @payswap/capabilities (devDependencies = TEST-ONLY)", () => {
    const offenders: { file: string; specifier: string }[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        for (const testOnly of ["@payswap/agents", "@payswap/capabilities"]) {
          if (specifier === testOnly || specifier.startsWith(`${testOnly}/`)) {
            offenders.push({ file: relativeToPackageRoot(file), specifier });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    // The Lab runtime IS reachable from the test layer (INV-L01's positive side).
    const labImporters = TEST_FILES.filter((file) =>
      importSpecifiers(readFileSync(file, "utf8")).some(
        (specifier) =>
          specifier === "@payswap/lab" || specifier.startsWith("@payswap/lab/"),
      ),
    );
    expect(labImporters.map(relativeToPackageRoot)).toContain(
      "test/lab-composition.test.ts",
    );
  });

  it("no vendor SDK is imported anywhere in src/** or test/** (the neutrality law)", () => {
    const vendorPattern = /from\s+["'](ethers|web3|@solana|viem|axios)(?:\/[^"']*)?["']/;
    const offenders: string[] = [];
    for (const file of [...SRC_FILES, ...TEST_FILES]) {
      const source = readFileSync(file, "utf8");
      if (vendorPattern.test(source)) {
        offenders.push(relativeToPackageRoot(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** has no ambient clock, no randomness, no floating-point parsing (determinism law)", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (source.includes("Math.random(")) {
        offenders.push(`${relativeToPackageRoot(file)}: Math.random`);
      }
      if (source.includes("Date.now(")) {
        offenders.push(`${relativeToPackageRoot(file)}: ambient clock (Date.now)`);
      }
      if (/new Date\(\s*\)/.test(source)) {
        offenders.push(`${relativeToPackageRoot(file)}: ambient clock (new Date())`);
      }
      if (source.includes("parseFloat(")) {
        offenders.push(`${relativeToPackageRoot(file)}: parseFloat`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no secret-shaped material on compiled plans, the compiler input or the Stripe evidence (rule 25)", () => {
    const result = compileBase(route1Intent());
    expect(result.plans.length).toBeGreaterThan(0);
    for (const plan of result.plans) {
      expect(() => assertNoSecretMaterial(plan, `plan ${plan.planId}`)).not.toThrow();
    }
    // The FULL compiler input is agent-facing-safe: no raw credential ever
    // enters the compiler (opaque credentialRefs only, by construction).
    const input = baseCompilerInput(route1Intent());
    expect(() => assertNoSecretMaterial(input, "route compiler input")).not.toThrow();
    // The provider-verified Stripe eligibility evidence carries references only.
    expect(() =>
      assertNoSecretMaterial(stripeEligibilityEvidence(), "stripe eligibility evidence"),
    ).not.toThrow();
  });

  it("determinism declaration: the compiler refuses bad instants (caller-supplied time only)", () => {
    expect(() =>
      compileMoneyMovementRoute(baseCompilerInput(route1Intent(), { at: -1 })),
    ).toThrow(/non-negative integer/);
  });
});
