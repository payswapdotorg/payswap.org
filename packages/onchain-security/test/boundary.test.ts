import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentSecurityFlag,
  ExpectedStateDiff,
  GateDecision,
  OnchainAuthorizationArtifact,
  OnchainAuthorizationRequest,
  OnchainWriteRequest,
  RecheckObservation,
  SigningDelegation,
  SigningRequest,
  SimulationObservation,
  TrustedSurfaceSigner,
} from "../src/index.js";
import type { FindForbiddenSecretKeys } from "../src/index.js";

/**
 * Package boundary (@payswap/onchain-security), P4-W1-002.
 *
 * 1. src/** imports only the declared @payswap/* workspace dependencies
 *    (@payswap/protocol, @payswap/trust, @payswap/capabilities);
 * 2. src/** NEVER imports @payswap/security (the security package's own
 *    boundary test forbids consumers until the TL merges one; composition
 *    is pure-data + test-level — see test/security-composition.test.ts);
 * 3. src/** never imports unmerged/parallel planes (@payswap/settlement,
 *    @payswap/execution, @payswap/rails, @payswap/adapters, W1-001's
 *    onchain domain kernel, the Lab, the web app): the kernel codes
 *    against structural type surfaces, not unmerged packages;
 * 4. EVM/EIP-712/ERC-1271 vocabulary lives ONLY in src/adapters/* — core
 *    contracts stay provider-neutral (architecture law: no EVM
 *    assumptions in core contracts);
 * 5. determinism guards: no Math.random, Date.now or setTimeout in src/;
 * 6. secret hygiene: no 64-hex (raw-key-shaped) literal anywhere in src or
 *    test — credential-shaped fixtures are assembled at RUNTIME from
 *    fragments;
 * 7. type-level proof: FindForbiddenSecretKeys resolves to never for every
 *    agent-facing contract.
 */

const PACKAGE_ROOT = process.cwd();

function listFiles(dir: string, filter: (path: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listFiles(full, filter));
    } else if (filter(full)) {
      found.push(full);
    }
  }
  return found;
}

function stripStringsAndComments(source: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    switch (mode) {
      case "code":
        if (char === "/" && next === "/") {
          mode = "line";
          i += 1;
        } else if (char === "/" && next === "*") {
          mode = "block";
          i += 1;
        } else if (char === '"') {
          mode = "double";
        } else if (char === "'") {
          mode = "single";
        } else if (char === "`") {
          mode = "template";
        } else {
          out += char;
        }
        break;
      case "line":
        if (char === "\n") {
          mode = "code";
          out += "\n";
        }
        break;
      case "block":
        if (char === "*" && next === "/") {
          mode = "code";
          i += 1;
        }
        break;
      case "single":
        if (char === "\\") {
          i += 1;
        } else if (char === "'") {
          mode = "code";
        }
        break;
      case "double":
        if (char === "\\") {
          i += 1;
        } else if (char === '"') {
          mode = "code";
        }
        break;
      case "template":
        if (char === "\\") {
          i += 1;
        } else if (char === "`") {
          mode = "code";
        }
        break;
    }
  }
  return out;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const code = stripStringsAndComments(source);
  for (const match of code.matchAll(/\bfrom\s*("|')(\S+)\1/g)) {
    specifiers.push(match[2] ?? "");
  }
  for (const match of code.matchAll(/\bimport\s*("|')(\S+)\1/g)) {
    specifiers.push(match[2] ?? "");
  }
  return specifiers;
}

const DECLARED_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/protocol",
  "@payswap/trust",
  "@payswap/capabilities",
];

const FORBIDDEN_SRC_IMPORTS: readonly string[] = [
  "@payswap/security",
  "@payswap/settlement",
  "@payswap/execution",
  "@payswap/rails",
  "@payswap/adapters",
  "@payswap/connectors",
  "@payswap/agents",
  "@payswap/api",
  "@payswap/lab",
  "@payswap/web",
  "@payswap/payment",
];

const CORE_MODULES = [
  "types.ts",
  "digest.ts",
  "secrets.ts",
  "write-intent.ts",
  "simulation.ts",
  "diff.ts",
  "gates.ts",
  "delegation.ts",
  "authorization.ts",
  "recheck.ts",
  "pipeline.ts",
  "signers.ts",
  "index.ts",
] as const;

const EVM_VOCABULARY = [
  "EIP-712",
  "EIP712",
  "eip712",
  "ERC-1271",
  "ERC1271",
  "erc1271",
  "chainId",
  "chainid",
  "secp256k1",
  "ethereum",
  "Ethereum",
  "EVM",
  "metamask",
] as const;

const RAW_KEY_LITERAL_PATTERN = /(0x)?[0-9a-fA-F]{64}/;

describe("package boundary (@payswap/onchain-security)", () => {
  it("scans a non-empty src tree", () => {
    const files = listFiles(join(PACKAGE_ROOT, "src"), () => true);
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it("src/** imports only declared @payswap/* workspace dependencies", () => {
    const offenders: string[] = [];
    for (const file of listFiles(join(PACKAGE_ROOT, "src"), (p) => p.endsWith(".ts"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".")) {
          continue;
        }
        if (!specifier.startsWith("@payswap/")) {
          offenders.push(`${file.replace(PACKAGE_ROOT + sep, "")}: non-workspace import '${specifier}'`);
        } else if (!DECLARED_WORKSPACE_DEPS.includes(specifier)) {
          offenders.push(`${file.replace(PACKAGE_ROOT + sep, "")}: undeclared workspace import '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** never imports forbidden parallel/unmerged planes (incl. @payswap/security)", () => {
    const offenders: string[] = [];
    for (const file of listFiles(join(PACKAGE_ROOT, "src"), (p) => p.endsWith(".ts"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (FORBIDDEN_SRC_IMPORTS.includes(specifier)) {
          offenders.push(`${file.replace(PACKAGE_ROOT + sep, "")}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("EVM signing vocabulary lives ONLY in src/adapters/* (core contracts stay provider-neutral)", () => {
    const offenders: { file: string; term: string }[] = [];
    for (const file of listFiles(join(PACKAGE_ROOT, "src"), (p) => p.endsWith(".ts"))) {
      if (file.includes(join("src", "adapters"))) {
        continue; // adapters own the chain-family semantics by law
      }
      const code = stripStringsAndComments(readFileSync(file, "utf8"));
      for (const term of EVM_VOCABULARY) {
        if (code.includes(term)) {
          offenders.push({ file: file.replace(PACKAGE_ROOT + sep, ""), term });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("determinism guards: no Math.random, Date.now or setTimeout in src/", () => {
    const offenders: string[] = [];
    for (const file of listFiles(join(PACKAGE_ROOT, "src"), (p) => p.endsWith(".ts"))) {
      const source = readFileSync(file, "utf8");
      if (source.includes("Math.random") || source.includes("Date.now") || source.includes("setTimeout")) {
        offenders.push(file.replace(PACKAGE_ROOT + sep, ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no raw-key-shaped (64-hex) literal in src/ or test/ — fixtures assemble at runtime", () => {
    const offenders: string[] = [];
    for (const root of ["src", "test"]) {
      for (const file of listFiles(join(PACKAGE_ROOT, root), (p) => p.endsWith(".ts"))) {
        const source = readFileSync(file, "utf8");
        for (const line of source.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith(' "')) {
            continue; // comments and digest-format examples are not literals
          }
          const match = RAW_KEY_LITERAL_PATTERN.exec(trimmed);
          if (match !== null) {
            offenders.push(`${file.replace(PACKAGE_ROOT + sep, "")}: ${match[0]}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("type-level proof: every agent-facing contract is secret-free (FindForbiddenSecretKeys = never)", () => {
    expectTypeOf<FindForbiddenSecretKeys<OnchainWriteRequest>>().toBeNever();
    expectTypeOf<FindForbiddenSecretKeys<SimulationObservation>>().toBeNever();
    expectTypeOf<FindForbiddenSecretKeys<ExpectedStateDiff>>().toBeNever();
    expectTypeOf<FindForbiddenSecretKeys<GateDecision>>().toBeNever();
    expectTypeOf<FindForbiddenSecretKeys<AgentSecurityFlag>>().toBeNever();
    expectTypeOf<FindForbiddenSecretKeys<OnchainAuthorizationRequest>>().toBeNever();
    expectTypeOf<FindForbiddenSecretKeys<OnchainAuthorizationArtifact>>().toBeNever();
    expectTypeOf<FindForbiddenSecretKeys<RecheckObservation>>().toBeNever();
    expectTypeOf<FindForbiddenSecretKeys<SigningRequest>>().toBeNever();
    expectTypeOf<FindForbiddenSecretKeys<SigningDelegation>>().toBeNever();
    expectTypeOf<FindForbiddenSecretKeys<TrustedSurfaceSigner>>().toBeNever();
  });

  it("the core contract modules all exist with the expected names", () => {
    const srcFiles = listFiles(join(PACKAGE_ROOT, "src"), (p) => p.endsWith(".ts")).map((path) =>
      path.split(sep).pop() ?? "",
    );
    for (const module of CORE_MODULES) {
      expect(srcFiles).toContain(module);
    }
  });
});
