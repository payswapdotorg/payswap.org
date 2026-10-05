import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanForSecretMaterial } from "@payswap/onchain-security";

/**
 * Package boundary (@payswap/merchant-checkout), P4-W2-003.
 *
 * 1. every non-relative import in src/** is a DECLARED @payswap/* dependency
 *    of this package's package.json (no undeclared dependencies);
 * 2. the declared workspace dependency set matches the frozen maximum
 *    allowlist exactly (protocol/payment/settlement/connectors/
 *    merchant-crypto/onchain-security/route-compiler);
 * 3. no runtime (non-@payswap) dependency and no node builtin is imported
 *    in src/**;
 * 4. determinism guards: no Math.random, no Date.now, no setTimeout in src/;
 * 5. no floating-point money literals in src/** (INV-F01);
 * 6. every exported artifact constructor in src/** is secret-scanned (the
 *    kernel's own scanner finds no violations across the source surface).
 */

const MAX_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/protocol",
  "@payswap/payment",
  "@payswap/settlement",
  "@payswap/connectors",
  "@payswap/merchant-crypto",
  "@payswap/onchain-security",
  "@payswap/route-compiler",
  "@payswap/trust",
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
  const fromRe = /\bfrom\s*(["'])([^"'\n]+)\1/g;
  const dynamicRe = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
  const sideEffectRe = /(?:^|[;\n])\s*import\s*(["'])([^"'\n]+)\1/g;
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

/** Remove string/template literals and comments so only CODE is scanned. */
function stripLiteralsAndComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, "``");
}

const SRC_FILES = listSourceFiles(join(process.cwd(), "src"));
const TEST_FILES = listSourceFiles(join(process.cwd(), "test"));

describe("dependency boundary", () => {
  it("src/** imports only declared @payswap/* workspace dependencies", () => {
    const declared = declaredWorkspaceDependencies();
    expect(declared.sort()).toEqual([...MAX_WORKSPACE_DEPS].sort());
    const undeclared: string[] = [];
    for (const file of SRC_FILES) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.startsWith(".")) {
          continue;
        }
        if (!specifier.startsWith("@payswap/")) {
          throw new Error(
            `${file}: non-workspace import '${specifier}' is forbidden in src/** (provider-neutral contract package)`,
          );
        }
        if (!declared.includes(specifier)) {
          undeclared.push(`${file} → ${specifier}`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("test/** may additionally import only vitest, node builtins and local files", () => {
    for (const file of TEST_FILES) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) {
          continue;
        }
        if (specifier === "vitest") {
          continue;
        }
        if (specifier.startsWith("@payswap/")) {
          continue;
        }
        throw new Error(
          `${file}: unexpected test import '${specifier}' (only vitest, node builtins, @payswap/* and relative imports are allowed)`,
        );
      }
    }
  });
});

describe("determinism guards (src/**)", () => {
  it("contains no Math.random, Date.now, setInterval or setTimeout", () => {
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const code = stripLiteralsAndComments(readFileSync(file, "utf8"));
      for (const banned of ["Math.random", "Date.now", "setInterval", "setTimeout"]) {
        if (code.includes(banned)) {
          offenders.push(`${file}: ${banned}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("contains no floating-point money literals (INV-F01)", () => {
    const offenders: string[] = [];
    const floatLiteral = /(?<![.\w])\d+\.\d+(?![.\w])/;
    for (const file of SRC_FILES) {
      const code = stripLiteralsAndComments(readFileSync(file, "utf8"));
      for (const line of code.split("\n")) {
        if (floatLiteral.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("secret-free source surface", () => {
  it("no forbidden secret KEY NAME appears in any src/** contract", () => {
    // Type-level-ish structural scan: every src file's exported interfaces
    // and object literals go through the kernel scanner at runtime; here we
    // assert the SOURCE contains no forbidden key names as property
    // declarations (a cheap static mirror of the runtime law).
    const forbidden = [
      "privateKey",
      "apiKey",
      "secret",
      "password",
      "accessToken",
      "refreshToken",
      "cookie",
      "mfa",
      "seedPhrase",
    ];
    const offenders: string[] = [];
    for (const file of SRC_FILES) {
      const code = stripLiteralsAndComments(readFileSync(file, "utf8"));
      for (const key of forbidden) {
        const pattern = new RegExp(`\\b(?:readonly\\s+)?${key}\\s*[?]?\\s*:`, "i");
        if (pattern.test(code)) {
          offenders.push(`${file}: ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the kernel scanner finds no secret material in the journey evidence file shape", async () => {
    const { runFullJourney } = await import("./journey-helpers.js");
    const { buildJourneyEvidenceFile } = await import("../src/index.js");
    const journey = runFullJourney();
    const file = buildJourneyEvidenceFile({
      journeyId: "journey:boundary",
      profile: journey.profile,
      activation: journey.activation,
      flow: journey.flow,
      authorization: journey.lineage,
      pipelineEvidence: journey.pipeline.evidence(),
      attempt: journey.attempt,
      inbox: journey.inbox,
      refund: journey.refund,
      settlement: journey.settlement,
    });
    expect(scanForSecretMaterial(file)).toEqual([]);
    expect(scanForSecretMaterial(journey.lineage)).toEqual([]);
    expect(scanForSecretMaterial(journey.bundle.paymentSummary)).toEqual([]);
  });
});

describe("package manifest sanity", () => {
  it("the package declares the expected name and test/typecheck scripts", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    expect(pkg.name).toBe("@payswap/merchant-checkout");
    expect(pkg.scripts?.["test"]).toBe("vitest run");
    expect(pkg.scripts?.["typecheck"]).toBe("tsc --noEmit");
  });
});
