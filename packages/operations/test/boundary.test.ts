import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package boundary (@payswap/operations), following the repo-wide
 * boundary-test convention (see packages/ux/test/boundary.test.ts):
 *
 * 1. every non-relative import in src/** is a DECLARED @payswap/* dependency
 *    of this package's package.json (the W3-007 work-order dependency set:
 *    @payswap/ux + @payswap/journeys + @payswap/protocol);
 * 2. the declared workspace dependency set is exactly the frozen allowlist
 *    for this package;
 * 3. src/** NEVER imports a network/DOM primitive — this is the operations
 *    CONTRACT layer: deterministic data + contracts + checkers, no network,
 *    no browser, no vault (secrets are reference names only);
 * 4. src/** never uses ambient entropy or ambient time, and never `any`;
 * 5. test/** imports only relative modules, node: builtins, @payswap/* and
 *    vitest.
 */

const MAX_WORKSPACE_DEPS: readonly string[] = [
  "@payswap/journeys",
  "@payswap/protocol",
  "@payswap/ux",
];

const FORBIDDEN_IMPORTS: readonly string[] = [
  "@payswap/agents",
  "@payswap/api",
  "@payswap/campaigns",
  "@payswap/capabilities",
  "@payswap/certification",
  "@payswap/connectors",
  "@payswap/execution",
  "@payswap/interfaces",
  "@payswap/lab",
  "@payswap/payment",
  "@payswap/participation",
  "@payswap/rails",
  "@payswap/recourse",
  "@payswap/security",
  "@payswap/settlement",
  "@payswap/trust",
];

const NETWORK_PRIMITIVES: readonly RegExp[] = [
  /\bfetch\s*\(/,
  /new\s+XMLHttpRequest/,
  /new\s+WebSocket/,
  /from\s+['"]node:http['"]/,
  /from\s+['"]node:https['"]/,
  /from\s+['"]node:net['"]/,
  /from\s+['"]node:dgram['"]/,
  /from\s+['"]node:tls['"]/,
  /from\s+['"]node:child_process['"]/,
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
  const patterns = [
    /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

function readPackageDeps(): {
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
} {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8"),
  ) as {
    dependencies?: Readonly<Record<string, string>>;
    devDependencies?: Readonly<Record<string, string>>;
  };
  return {
    dependencies: Object.keys(raw.dependencies ?? {}),
    devDependencies: Object.keys(raw.devDependencies ?? {}),
  };
}

describe("package boundary (@payswap/operations)", () => {
  it("scans a non-empty src tree", () => {
    const files = listSourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it("src/** imports only its declared @payswap/* dependencies + relative modules", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) {
          continue;
        }
        if (!specifier.startsWith("@payswap/")) {
          offenders.push(`${file.replace(`${root}/`, "")}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every @payswap/* import in src/** is a declared runtime dependency (W3-007 set)", () => {
    const root = join(process.cwd(), "src");
    const { dependencies } = readPackageDeps();
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith("@payswap/") && !dependencies.includes(specifier)) {
          offenders.push(
            `${file.replace(`${root}/`, "")}: '${specifier}' (not declared)`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the declared runtime dependency set matches the frozen W3-007 allowlist", () => {
    const { dependencies } = readPackageDeps();
    const workspaceDeps = dependencies.filter((dep) =>
      dep.startsWith("@payswap/"),
    );
    expect([...workspaceDeps].sort()).toEqual([...MAX_WORKSPACE_DEPS].sort());
  });

  it("src/** never imports authority domains outside the allowlist", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of FORBIDDEN_IMPORTS) {
        if (
          source.includes(`from '${forbidden}'`) ||
          source.includes(`from "${forbidden}"`)
        ) {
          offenders.push(`${file.replace(`${root}/`, "")}: '${forbidden}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** contains NO network/DOM primitives (deterministic contracts + checkers only)", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const pattern of NETWORK_PRIMITIVES) {
        if (pattern.test(source)) {
          offenders.push(`${file.replace(`${root}/`, "")}: ${String(pattern)}`);
        }
      }
      if (/\bdocument\s*\./.test(source) || /\bwindow\s*\./.test(source)) {
        offenders.push(`${file.replace(`${root}/`, "")}: DOM global usage`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** never uses ambient entropy or ambient time (no Math.random / Date.now)", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      if (/\bMath\.random\s*\(/.test(source) || /\bDate\.(now|parse)\s*\(/.test(source)) {
        offenders.push(file.replace(`${root}/`, ""));
      }
      if (/\bnew\s+Date\s*\(/.test(source)) {
        offenders.push(`${file.replace(`${root}/`, "")}: new Date()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src/** never uses `any` (strict typing)", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      const anyPattern = /:\s*any\b/;
      if (anyPattern.test(source)) {
        offenders.push(file.replace(`${root}/`, ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("test/** imports only relative modules, node: builtins, @payswap/* and vitest", () => {
    const root = join(process.cwd(), "test");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("node:") ||
          specifier.startsWith("@payswap/") ||
          specifier === "vitest"
        ) {
          continue;
        }
        offenders.push(`${file.replace(`${root}/`, "")}: '${specifier}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
