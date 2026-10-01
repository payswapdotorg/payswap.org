import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAULT_FAMILIES, PACKAGE_NAME } from "../src/index.js";

/**
 * Package boundary (@payswap/adversarial), W2-007 — the terminal fault
 * suite.
 *
 * 1. every non-relative import in src/** is a declared @payswap/* dependency
 *    of this package's package.json (the attacked subsystems only);
 * 2. NO src/** file imports the isolated planes (@payswap/security,
 *    @payswap/lab) — the immune system and the Lab are composed at the TEST
 *    layer through the structural views (repo-wide boundary discipline,
 *    journeys + certification precedent);
 * 3. no runtime (non-@payswap) dependency is ever imported — no provider
 *    SDK, no framework primitive;
 * 4. determinism guards: no Math.random, no Date.now, no setTimeout, and NO
 *    network primitives (fetch/http/ws) in src/** — the suite injects faults
 *    against the real subsystems offline, deterministically;
 * 5. the suite registers exactly the eleven W2-007 fault families.
 */

/** The attacked subsystems importable from src/**. */
const MAX_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/protocol",
  "@payswap/payment",
  "@payswap/trust",
  "@payswap/agents",
  "@payswap/capabilities",
  "@payswap/connectors",
  "@payswap/execution",
  "@payswap/settlement",
  "@payswap/rails",
  "@payswap/recourse",
  "@payswap/participation",
  "@payswap/campaigns",
  "@payswap/certification",
  "@payswap/journeys",
];

/** Isolated planes composed at the TEST layer only (never in src/**). */
const TEST_LAYER_ONLY_DEPS: readonly string[] = ["@payswap/security", "@payswap/lab"];

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
    if (specifier !== undefined) specifiers.push(specifier);
  }
  for (const match of source.matchAll(dynamicRe)) {
    const specifier = match[2];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  for (const match of source.matchAll(sideEffectRe)) {
    const specifier = match[2];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

const SRC_ROOT = join(process.cwd(), "src");
const sourceFiles = listSourceFiles(SRC_ROOT);

describe("Package boundary (@payswap/adversarial, W2-007)", () => {
  it("declares the package name", () => {
    expect(PACKAGE_NAME).toBe("@payswap/adversarial");
  });

  it("imports only declared @payswap/* workspace dependencies", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        expect(
          MAX_WORKSPACE_DEPS.includes(specifier),
          `${file} imports '${specifier}' which is not an attacked subsystem`,
        ).toBe(true);
      }
    }
  });

  it("never imports the isolated planes (@payswap/security, @payswap/lab) from src/**", () => {
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        expect(
          !TEST_LAYER_ONLY_DEPS.includes(specifier),
          `${file} imports '${specifier}' — the isolated planes are composed at the test layer through structural views only`,
        ).toBe(true);
      }
    }
  });

  it("declares the isolated planes as dependencies for the test composition only", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };
    for (const dep of TEST_LAYER_ONLY_DEPS) {
      expect(pkg.dependencies[dep], `${dep} must be declared for the test-layer composition`).toBe("*");
    }
  });

  it("is deterministic and offline in src/** (no random, wall clock, timers or network)", () => {
    const forbidden: readonly { readonly pattern: RegExp; readonly label: string }[] = [
      { pattern: /\bMath\.random\b/, label: "Math.random" },
      { pattern: /\bDate\.now\b/, label: "Date.now" },
      { pattern: /\bsetTimeout\b/, label: "setTimeout" },
      { pattern: /\bsetInterval\b/, label: "setInterval" },
      { pattern: /\bfetch\s*\(/, label: "fetch()" },
      { pattern: /\brequire\s*\(\s*["']https?:/i, label: "http(s) require" },
      { pattern: /["']ws:\/\//, label: "ws:// websocket" },
      { pattern: /["']wss:\/\//, label: "wss:// websocket" },
      { pattern: /["']https?:\/\//, label: "http(s):// URL" },
    ];
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const rule of forbidden) {
        expect(
          rule.pattern.test(source),
          `${file} contains forbidden nondeterminism/network primitive: ${rule.label}`,
        ).toBe(false);
      }
    }
  });

  it("registers exactly the eleven W2-007 fault families with unique ids", () => {
    expect(FAULT_FAMILIES.length).toBe(11);
    expect(new Set(FAULT_FAMILIES).size).toBe(FAULT_FAMILIES.length);
    expect([...FAULT_FAMILIES]).toEqual([
      "duplicated-commands",
      "lost-webhooks",
      "ambiguous-provider",
      "account-takeover",
      "malicious-agents",
      "package-compromise",
      "incentive-sybil-collusion-wash",
      "leaderboard-gaming",
      "provider-outage",
      "clock-skew",
      "partial-payment",
    ]);
  });

  it("provides one fault module per W2-007 fault-family group (no stubbed targets)", () => {
    const faultsRoot = join(SRC_ROOT, "faults");
    const modules = listSourceFiles(faultsRoot).map((file) => file.split(/[\\/]/).pop() ?? file);
    expect(modules.length).toBe(10);
    for (const expected of [
      "duplicated-commands.ts",
      "lost-webhooks.ts",
      "ambiguous-provider.ts",
      "account-takeover.ts",
      "malicious-agents.ts",
      "package-compromise.ts",
      "incentive-abuse.ts",
      "provider-outage.ts",
      "clock-skew.ts",
      "partial-payment.ts",
    ]) {
      expect(modules, `missing fault module ${expected}`).toContain(expected);
    }
    // Every fault module injects against real subsystems: each declares
    // candidate invariants and attacked subsystems (no stubs of targets).
    for (const file of listSourceFiles(faultsRoot)) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must declare candidate invariants`).toContain("candidateInvariants");
      expect(source, `${file} must declare attacked subsystems`).toContain("attackedSubsystems");
      expect(source, `${file} must prove injection`).toContain("injectionCheck");
      expect(source, `${file} must probe invariants`).toContain("probe(");
      expect(source, `${file} must document the recovery path`).toContain("recoveryStep");
    }
  });
});
