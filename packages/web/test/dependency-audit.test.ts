import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import allowlistJson from "./dependency-audit-allowlist.json";

/**
 * Dependency audit as a test (Work Order P3-W1-003).
 *
 * The repository dependency surface is a COST and SECURITY contract:
 *
 * (a) Resend and Apify SDKs are ABSENT — from every package.json in the
 *     repository AND from the root lockfile. Phase 3 law: they enter only
 *     through an explicit work-order amendment, never through an allowlist
 *     edit (no escape hatch for this rule).
 *
 * (b) The direct dependencies of every workspace match the curated allowlist
 *     `dependency-audit-allowlist.json` exactly. A NEW dependency (or a
 *     removal) fails with a diff; the escape hatch for a justified addition
 *     is to edit the allowlist in the SAME commit, recording a one-line
 *     justification in its `justifications` map. This keeps "no unexpected
 *     paid dependency" machine-checked: a surprise SDK cannot land quietly.
 *
 * The audit is deterministic and offline: it reads the repository tree and
 * the committed lockfile only. No network, no installs.
 */

/** Dependency-section names a manifest can declare. */
const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type DepSection = (typeof DEP_SECTIONS)[number];

/** Resend + Apify SDK package names/prefixes — banned repo-wide. */
const BANNED_PACKAGES: readonly string[] = [
  "resend",
  "apify",
  "apify-client",
];
const BANNED_SCOPES: readonly string[] = ["@resend/", "@apify/"];

function isBanned(name: string): boolean {
  if (BANNED_PACKAGES.includes(name)) {
    return true;
  }
  return BANNED_SCOPES.some((scope) => name.startsWith(scope));
}

/** Directories never walked when auditing manifests. */
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".vercel", "coverage", "out"]);

/** The audited allowlist shape (the JSON is cast to this — see below). */
interface Allowlist {
  readonly $comment: string;
  readonly sections: readonly string[];
  readonly workspaces: Record<
    string,
    Partial<Record<DepSection, readonly string[]>>
  >;
  readonly justifications: Record<string, string>;
}

const allowlist = allowlistJson as unknown as Allowlist;

/**
 * The repository root: the nearest ancestor directory whose package.json
 * declares the npm workspaces of this monorepo. Resolved from this test
 * file's location so the audit is vantage-independent.
 */
function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: unknown;
        workspaces?: unknown;
      };
      if (pkg.name === "@payswap/payswap-org" && Array.isArray(pkg.workspaces)) {
        return dir;
      }
    } catch {
      // no package.json here — walk up
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    "dependency-audit: could not locate the repository root (expected @payswap/payswap-org with npm workspaces)",
  );
}

interface ManifestFile {
  /** Repo-relative workspace directory ("." for the root). */
  readonly workspace: string;
  /** Repo-relative manifest path (for failure messages). */
  readonly file: string;
  /** Parsed dependency sections (only the declared ones). */
  readonly sections: Partial<Record<DepSection, string[]>>;
}

function readManifest(root: string, absolute: string): ManifestFile {
  const rel = path.relative(root, absolute).split(path.sep).join("/");
  const workspace = path.posix.dirname(rel) === "." ? "." : path.posix.dirname(rel);
  const raw = JSON.parse(readFileSync(absolute, "utf8")) as Record<string, unknown>;
  const sections: Partial<Record<DepSection, string[]>> = {};
  for (const section of DEP_SECTIONS) {
    const declared = raw[section];
    if (declared === undefined || declared === null) {
      continue;
    }
    if (typeof declared !== "object" || Array.isArray(declared)) {
      throw new Error(
        `dependency-audit: ${rel} declares "${section}" as a non-object — npm requires an object`,
      );
    }
    sections[section] = Object.keys(declared as Record<string, unknown>).sort();
  }
  return { workspace, file: rel, sections };
}

function walkPackageJsons(root: string): ManifestFile[] {
  const manifests: ManifestFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".git")) {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        walk(absolute);
      } else if (entry.isFile() && entry.name === "package.json") {
        manifests.push(readManifest(root, absolute));
      }
    }
  };
  walk(root);
  return manifests.sort((a, b) => a.workspace.localeCompare(b.workspace));
}

const REPO_ROOT = findRepoRoot();
const MANIFESTS = walkPackageJsons(REPO_ROOT);
const LOCKFILE_PATH = path.join(REPO_ROOT, "package-lock.json");

/**
 * Extract the package NAME from a lockfile "packages" key. Keys look like
 * "node_modules/<name>", "node_modules/<@scope>/<name>", or the nested
 * workspace-local forms "packages/web/node_modules/<name>" (lockfile v3).
 * Workspace roots ("packages/web", "") return null — they are not deps.
 */
function lockfileKeyName(key: string): string | null {
  const marker = "node_modules/";
  const at = key.lastIndexOf(marker);
  if (at === -1) {
    return null;
  }
  return key.slice(at + marker.length);
}

/** Sorted diff lines between the allowlist set and the actual set. */
function diffSets(expected: readonly string[], actual: readonly string[]): string[] {
  const added = actual.filter((name) => !expected.includes(name));
  const removed = expected.filter((name) => !actual.includes(name));
  const lines: string[] = [];
  for (const name of added) {
    lines.push(`  + ${name}  (unexpected — not in the allowlist)`);
  }
  for (const name of removed) {
    lines.push(`  - ${name}  (in the allowlist but no longer declared)`);
  }
  return lines;
}

describe("dependency audit — Resend and Apify are absent (hard law)", () => {
  it("walks the repository and finds the workspace manifests", () => {
    expect(MANIFESTS.length).toBeGreaterThanOrEqual(25);
    expect(MANIFESTS.map((m) => m.workspace)).toContain(".");
    expect(MANIFESTS.map((m) => m.workspace)).toContain("packages/web");
  });

  it("has no Resend/Apify SDK in ANY dependency section of ANY manifest", () => {
    const violations: string[] = [];
    for (const manifest of MANIFESTS) {
      for (const section of DEP_SECTIONS) {
        for (const name of manifest.sections[section] ?? []) {
          if (isBanned(name)) {
            violations.push(`${manifest.file} → ${section} → ${name}`);
          }
        }
      }
    }
    expect(
      violations,
      `Resend/Apify SDKs must be absent (a work-order amendment is required to add them). Found:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("has no Resend/Apify package anywhere in the root lockfile (no transitive entry either)", () => {
    const lockRaw = JSON.parse(readFileSync(LOCKFILE_PATH, "utf8")) as {
      packages?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
    };
    const locations: string[] = [];
    for (const key of Object.keys(lockRaw.packages ?? {})) {
      const name = lockfileKeyName(key);
      if (name !== null && isBanned(name)) {
        locations.push(key);
      }
    }
    for (const name of Object.keys(lockRaw.dependencies ?? {})) {
      if (isBanned(name)) {
        locations.push(`dependencies → ${name}`);
      }
    }
    expect(
      locations,
      `Resend/Apify packages must not appear in package-lock.json. Found:\n${locations.join("\n")}`,
    ).toEqual([]);
  });

  it("no manifest declares an npm alias that hides a banned package", () => {
    // "npm:<real-name>@<version>" alias values can smuggle a banned SDK
    // behind an innocent-looking key; the audit reads VALUES too.
    const violations: string[] = [];
    for (const manifest of MANIFESTS) {
      const raw = JSON.parse(
        readFileSync(path.join(REPO_ROOT, manifest.file), "utf8"),
      ) as Record<string, Record<string, unknown>>;
      for (const section of DEP_SECTIONS) {
        for (const [name, version] of Object.entries(raw[section] ?? {})) {
          if (typeof version === "string" && version.startsWith("npm:")) {
            const aliased = version.slice(4).split("@")[0];
            if (isBanned(aliased) || isBanned(name)) {
              violations.push(`${manifest.file} → ${section} → ${name}@${version}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("dependency audit — curated allowlist per workspace", () => {
  it("the allowlist is well-formed and covers exactly the audited workspaces", () => {
    expect([...allowlist.sections]).toEqual([...DEP_SECTIONS]);
    const manifestWorkspaces = MANIFESTS.map((m) => m.workspace);
    const allowlistWorkspaces = Object.keys(allowlist.workspaces).sort();
    expect(manifestWorkspaces).toEqual(allowlistWorkspaces);
  });

  it("every workspace's declared direct dependencies match the allowlist exactly", () => {
    const failures: string[] = [];

    for (const manifest of MANIFESTS) {
      const allowed = allowlist.workspaces[manifest.workspace];
      if (allowed === undefined) {
        failures.push(
          `${manifest.file}: workspace "${manifest.workspace}" is missing from the allowlist (add it — same commit, with justification if it introduces new dependencies)`,
        );
        continue;
      }
      for (const section of DEP_SECTIONS) {
        const expected: readonly string[] = allowed[section] ?? [];
        const actual: readonly string[] = manifest.sections[section] ?? [];
        if (expected.length === 0 && actual.length === 0) {
          continue;
        }
        const diff = diffSets(expected, actual);
        if (diff.length > 0) {
          failures.push(
            `${manifest.file} → ${section}\n${diff.join("\n")}\n  escape hatch: update packages/web/test/dependency-audit-allowlist.json in the SAME commit, recording a justification under "justifications" → "${manifest.workspace}|${section}|<name>"`,
          );
        }
      }
    }

    expect(
      failures,
      `The dependency surface drifted from the curated allowlist (no-unexpected-additions law). Failures:\n\n${failures.join("\n\n")}`,
    ).toEqual([]);
  });

  it("every allowlisted name is either declared or carries a recorded justification", () => {
    // Inverse direction: a name may sit in the allowlist without being
    // declared ONLY while it documents a justified transition (the escape
    // hatch stays self-auditing; the allowlist cannot rot silently).
    const orphans: string[] = [];
    for (const [workspace, sections] of Object.entries(allowlist.workspaces)) {
      const manifest = MANIFESTS.find((m) => m.workspace === workspace);
      for (const [section, names] of Object.entries(sections)) {
        for (const name of names ?? []) {
          const declared = manifest?.sections[section as DepSection] ?? [];
          const key = `${workspace}|${section}|${name}`;
          const justified = Object.keys(allowlist.justifications).includes(key);
          if (!declared.includes(name) && !justified) {
            orphans.push(
              `allowlist lists ${workspace} → ${section} → ${name} which is neither declared nor justified`,
            );
          }
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  it("banned SDKs can never be authorized by an allowlist entry or justification", () => {
    for (const key of Object.keys(allowlist.justifications)) {
      const name = key.split("|").at(-1) ?? "";
      expect(
        isBanned(name),
        `justification "${key}" authorizes a banned SDK — this requires a work-order amendment, not an allowlist entry`,
      ).toBe(false);
    }
    for (const [workspace, sections] of Object.entries(allowlist.workspaces)) {
      for (const [section, names] of Object.entries(sections)) {
        for (const name of names ?? []) {
          expect(
            isBanned(name),
            `allowlist lists the banned SDK ${workspace} → ${section} → ${name}`,
          ).toBe(false);
        }
      }
    }
  });
});
