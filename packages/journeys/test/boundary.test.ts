import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";
import { JOURNEYS } from "../src/certification.js";
import { ACCEPTANCE_AXES } from "../src/harness.js";

/**
 * Package boundary (@payswap/journeys), W1-007 — the terminal certification
 * suite.
 *
 * 1. every non-relative import in src/** is a declared @payswap/* dependency
 *    of this package's package.json (the composed subsystems only);
 * 2. no runtime (non-@payswap) dependency is ever imported — no provider SDK,
 *    no framework primitive;
 * 3. determinism guards: no Math.random, no Date.now, no setTimeout, and NO
 *    network primitives (fetch/http/ws) in src/** — the suite composes the
 *    real subsystems offline through their fail-closed / injected-transport
 *    surfaces;
 * 4. the suite registers exactly the 12 W1-007 journeys with unique ids and
 *    the acceptance axes are the work-order axes.
 */

/** Composed subsystems importable from src/** (the certification suites' composition plane). */
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
  // P2-W2-003 evolution: the cross-provider conformance suite drives the
  // REAL connectors through their SDK surface (the framework base every
  // connector implements — the authorization gate probes bare connectors;
  // the duplicate probe invokes create()). The dependency is TYPE-ONLY in
  // src (ConnectorSDK/SdkCallContext contracts) — adapters never gains a
  // runtime composition path from journeys.
  "@payswap/adapters",
];

/**
 * Isolated planes composed at the TEST layer only (repo-wide boundary
 * discipline): the Lab (INV-L01, AGENTS rule 7 — simulation is never
 * callable from a production path) and the security immune system. The
 * package.json dependency exists for the test composition, mirroring
 * @payswap/certification's convention.
 */
const TEST_LAYER_ONLY_DEPS: readonly string[] = ["@payswap/lab", "@payswap/security"];

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

describe("Package boundary (@payswap/journeys, W1-007)", () => {
  it("declares the package name", () => {
    expect(PACKAGE_NAME).toBe("@payswap/journeys");
  });

  it("imports only declared @payswap/* workspace dependencies", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        expect(
          MAX_WORKSPACE_DEPS.includes(specifier),
          `${file} imports '${specifier}' which is not a composed subsystem`,
        ).toBe(true);
      }
    }
  });

  it("never imports provider SDKs or framework primitives", () => {
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        expect(specifier.startsWith("@payswap/"), `${file} imports non-workspace '${specifier}'`).toBe(true);
      }
    }
  });

  it("is deterministic and offline: no Math.random, Date.now, timers or network primitives in src/**", () => {
    const forbidden: readonly { readonly pattern: RegExp; readonly label: string }[] = [
      { pattern: /\bMath\.random\b/, label: "Math.random" },
      { pattern: /\bDate\.now\b/, label: "Date.now" },
      { pattern: /\bsetTimeout\b/, label: "setTimeout" },
      { pattern: /\bsetInterval\b/, label: "setInterval" },
      { pattern: /\bfetch\s*\(/, label: "fetch()" },
      { pattern: /\bWebSocket\b/, label: "WebSocket" },
      { pattern: /\baxios\b/, label: "axios" },
      { pattern: /\brequire\s*\(\s*['"]https?['"]\s*\)/, label: "require('http(s)')" },
      { pattern: /\bnet\.connect\b|\bhttp\.request\b|\bhttps\.request\b/, label: "node network client" },
    ];
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const rule of forbidden) {
        expect(rule.pattern.test(source), `${file} contains forbidden ${rule.label}`).toBe(false);
      }
    }
  });

  it("never references the isolated packages from src/** (Lab and security are test-layer composition)", () => {
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const isolated of TEST_LAYER_ONLY_DEPS) {
        expect(
          source.includes(isolated),
          `${file} references '${isolated}' — the isolated planes are composed at the test layer only`,
        ).toBe(false);
      }
    }
  });

  it("registers exactly the 12 W1-007 journeys with unique ids", () => {
    expect(JOURNEYS).toHaveLength(12);
    const ids = JOURNEYS.map((journey) => journey.journeyId);
    expect(new Set(ids).size).toBe(12);
    expect(ids).toEqual([
      "p2p",
      "merchant-checkout",
      "cross-border",
      "payroll-batch",
      "credit",
      "incentive-liquidity",
      "psp-incumbent",
      "customer-action",
      "recurring-mandate",
      "refund-dispute",
      "multi-provider-fallback",
      "external-funds",
    ]);
  });

  it("asserts exactly the W1-007 acceptance axes", () => {
    expect([...ACCEPTANCE_AXES].sort()).toEqual(
      [
        "EVIDENCED_CHAIN",
        "ACCOUNTING_RECONCILES",
        "FEES_FX_INCENTIVES_EXACT",
        "APPROVALS_AND_PROOFS_EXIST",
        "LOSSLESS_STATE_RECONCILIATION",
        "PASS_THROUGH_NATIVE_BASELINE",
      ].sort(),
    );
  });

  it("lives only under packages/journeys (delivery scope)", () => {
    expect(SRC_ROOT.endsWith(join("packages", "journeys", "src"))).toBe(true);
  });
});
