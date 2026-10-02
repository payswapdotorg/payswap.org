import type { NextConfig } from "next";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Deterministic build identity for @payswap/web.
 *
 * The BUILD_ID is a content digest of the package's build inputs (source
 * tree + config), NOT a random UUID: the same committed sources always
 * produce the same BUILD_ID, so a web release record that references a
 * commit SHA + build hash is reproducible (Work Order P3-W1-001:
 * "Vercel deployment is reproducible"). The release-record driver
 * (scripts/deployment/web-release.mjs) recomputes the same digest over the
 * same inputs and fails if the two disagree.
 *
 * Builds are expected to run with the working directory at packages/web
 * (npm workspace scripts and the Vercel root-directory setting both
 * guarantee this) — the guard below makes any other vantage fail loudly
 * instead of hashing the wrong tree.
 */

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "node_modules",
  "coverage",
  "out",
  ".vercel",
]);

const HASHED_CONFIG_FILES = [
  "package.json",
  "postcss.config.mjs",
  "next.config.ts",
] as const;

function readPackageName(root: string): string | undefined {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { name?: unknown };
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function assertWebRoot(root: string): void {
  if (readPackageName(root) !== "@payswap/web") {
    throw new Error(
      `next.config.ts: expected the working directory to be packages/web (name "@payswap/web"), found "${readPackageName(root) ?? "no package.json"}" at ${root}. Build from the workspace script (npm run build --workspace @payswap/web) or the Vercel project with root directory packages/web.`,
    );
  }
}

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  for (const dir of ["src", "public"]) {
    const absolute = path.join(root, dir);
    if (fs.existsSync(absolute)) {
      walk(absolute);
    }
  }
  for (const file of HASHED_CONFIG_FILES) {
    const absolute = path.join(root, file);
    if (fs.existsSync(absolute)) {
      files.push(absolute);
    }
  }
  return files.sort();
}

/** sha256 over the sorted build inputs, truncated to a 16-hex build id. */
export function computeSourceDigest(root: string): string {
  const hash = createHash("sha256");
  for (const file of collectSourceFiles(root)) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function currentGitCommit(): string {
  const fromVercel = process.env["VERCEL_GIT_COMMIT_SHA"];
  if (fromVercel && fromVercel.length > 0) {
    return fromVercel;
  }
  const res = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (res.status === 0 && typeof res.stdout === "string" && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return "unknown";
}

const webRoot = process.cwd();
assertWebRoot(webRoot);
const sourceDigest = computeSourceDigest(webRoot);

const nextConfig: NextConfig = {
  // The workspace protocol packages are consumed from source (TypeScript
  // with .js extension imports). Transpiling them lets Next/Turbopack apply
  // its ts resolution; without this the dev server and the Vercel build
  // fail with "Module not found: Can't resolve './approval.js'".
  transpilePackages: [
    "@payswap/design",
    "@payswap/ux",
    "@payswap/api",
    "@payswap/payment",
    "@payswap/execution",
    "@payswap/interfaces",
  ],
  outputFileTracingRoot: path.join(webRoot, "..", ".."),
  // The workspace protocol packages are TypeScript ESM sources whose
  // intra-package imports use the .js extension (correct for tsc
  // NodeNext output). The bundler must apply TS's compile-time extension
  // mapping (.js -> .ts/.tsx) when consuming them from source.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    // The @payswap/ux barrel transitively re-exports the interfaces
    // webhooks/approval modules (node:crypto, authority-side only). The
    // web app never invokes them (verified), so their FILES are aliased to
    // the local empty shim — keeping every compilation free of the node:
    // scheme while the protocol packages stay untouched.
    const monorepoRoot = path.join(webRoot, "..", "..");
    const shim = path.join(webRoot, "src", "shims", "empty-module.ts");
    // The interface modules below use node:crypto (authority-side HMAC /
    // hashing / fixtures). The node: SCHEME cannot be read by the client
    // and edge-server compilations, which reach these modules only through
    // the @payswap/ux barrel's re-exports and never invoke them — so they
    // are shimmed empty THERE. The server compilation reads node:crypto
    // natively and keeps the REAL modules (the session plane's
    // @payswap/api consumption stays intact).
    if (config.name !== "server") {
      const interfacesSrc = path.join(monorepoRoot, "packages", "interfaces", "src");
      const aliased: Record<string, string> = {
        [path.join(interfacesSrc, "webhooks.ts")]: shim,
        [path.join(interfacesSrc, "approval.ts")]: shim,
      };
      // The conformance contract-test infrastructure (fixtures, HMAC
      // helpers) is authority/test-plane only — never invoked by the app.
      const conformanceDir = path.join(interfacesSrc, "conformance");
      for (const entry of fs.readdirSync(conformanceDir)) {
        if (entry.endsWith(".ts")) {
          aliased[path.join(conformanceDir, entry)] = shim;
        }
      }
      config.resolve.alias = {
        ...config.resolve.alias,
        ...aliased,
      };
    }
    return config;
  },
  // Deterministic build identity: same sources => same BUILD_ID.
  generateBuildId: () => sourceDigest,
  env: {
    // Baked into the build so /api/health can report it honestly.
    PAYSWAP_WEB_BUILD_ID: sourceDigest,
    PAYSWAP_WEB_BUILD_COMMIT: currentGitCommit(),
  },
};

export default nextConfig;
