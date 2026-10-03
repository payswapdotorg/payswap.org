import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as onchainVenues from "../src/index.js";

/**
 * ADVERSARIAL GUARDS for the venue packs (P4-W2-002):
 *
 * 1. CORE-BARREL VENUE NEUTRALITY: the venue-neutral files (the pack
 *    contract barrel and the shared capability base) contain ZERO venue
 *    vocabulary — venue-specific shapes live ONLY in the venue pack
 *    subdirectories (mirroring the onchain-domain EVM-leak scan).
 * 2. DEPENDENCY DIRECTION: venue packs import the cores; the cores never
 *    import a venue pack. All src imports are @payswap/* or relative.
 * 3. SECRET-FIELD GUARD (rule 25): no key/seed/mnemonic/secret/password
 *    fields anywhere in src.
 * 4. NO LIVE ENDPOINTS: fixture-driven packs never embed network endpoints
 *    (the packs are offline models; integration arrives with the adapters).
 */

const SRC_ROOT = join(process.cwd(), "src");
const VENUE_DIRECTORIES = new Set(["uniswap", "aggregator", "intents"]);

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

const ALL_SRC_FILES = listSourceFiles(SRC_ROOT);
const NEUTRAL_FILES = ALL_SRC_FILES.filter(
  (file) => !VENUE_DIRECTORIES.has(file.split(/[\\/]/).slice(-2)[0] ?? ""),
);

describe("CORE-BARREL VENUE NEUTRALITY (venue shapes live only in venue packs)", () => {
  it("the neutral files (pack contract + capability base) contain no venue vocabulary", () => {
    expect(NEUTRAL_FILES.length).toBeGreaterThanOrEqual(2);
    const violations: string[] = [];
    for (const file of NEUTRAL_FILES) {
      const source = readFileSync(file, "utf8");
      for (const pattern of [/uniswap/i, /zeroswap/i, /solverbatch/i, /\brfq\b/i]) {
        if (pattern.test(source)) {
          violations.push(`${file}: leaks '${pattern.source}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the venue directories exist and carry the venue-specific shapes", () => {
    for (const directory of VENUE_DIRECTORIES) {
      const files = ALL_SRC_FILES.filter((file) => file.includes(join("src", directory)));
      expect(files.length).toBeGreaterThan(0);
    }
  });
});

describe("DEPENDENCY DIRECTION (venue → core, never core → venue)", () => {
  it("all src imports are @payswap/* workspace packages or relative modules", () => {
    const violations: string[] = [];
    for (const file of ALL_SRC_FILES) {
      const source = readFileSync(file, "utf8");
      const importPattern = /from\s+["']([^"']+)["']/g;
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(source)) !== null) {
        const specifier = match[1] as string;
        if (specifier.startsWith(".") || specifier.startsWith("node:")) {
          continue;
        }
        if (!specifier.startsWith("@payswap/")) {
          violations.push(`${file}: imports non-workspace module '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no third-party vendor SDK is imported anywhere (no ethers/viem/web3/…)", () => {
    const violations: string[] = [];
    for (const file of ALL_SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (
        /from\s+["'](ethers|viem|web3|@ethersproject\/[^"']+|@solana\/web3\.js|bitcoinjs-lib|@scure\/[^"']+|@noble\/[^"']+)["']/.test(
          source,
        )
      ) {
        violations.push(`${file}: imports a vendor SDK`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the neutral barrel never imports a venue pack (subpath isolation)", () => {
    for (const file of NEUTRAL_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from\s+["']\.\.?\/(uniswap|aggregator|intents)/);
    }
  });
});

describe("SECRET-FIELD GUARD (rule 25)", () => {
  it("src/** declares no key/seed/mnemonic/secret/password-shaped property", () => {
    const violations: string[] = [];
    const propertyDeclaration =
      /^\s*(?:export\s+)?(?:readonly\s+)?(?:declare\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(\?)?\s*:/;
    const forbiddenFieldName =
      /^(privatekey|priv_?key|seed_?phrase|seedwords|mnemonic|secret|secret_?key|password|passphrase|api_?key|access_?token|refreshtoken|session_?secret|client_?secret|keystore_?json|encrypted_?key)$/i;
    for (const file of ALL_SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        const match = propertyDeclaration.exec(line);
        if (match !== null) {
          const fieldName = match[1] as string;
          if (forbiddenFieldName.test(fieldName)) {
            violations.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no raw secret vocabulary appears anywhere in src", () => {
    const violations: string[] = [];
    for (const file of ALL_SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of [
        "privateKey",
        "private_key",
        "seedPhrase",
        "seed_phrase",
        "mnemonic",
        "password",
      ]) {
        if (source.includes(forbidden)) {
          violations.push(`${file} contains '${forbidden}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no git-style push token or credential-shaped string appears in src", () => {
    const violations: string[] = [];
    for (const file of ALL_SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (/ghp_[A-Za-z0-9]{20,}/.test(source)) {
        violations.push(`${file}: contains a push-token-shaped string`);
      }
      if (/Bearer\s+[A-Za-z0-9._-]{20,}/.test(source)) {
        violations.push(`${file}: contains a bearer-token-shaped string`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("NO LIVE ENDPOINTS (offline fixture-driven packs)", () => {
  it("src/** embeds no network endpoint URLs", () => {
    const violations: string[] = [];
    for (const file of ALL_SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (/https?:\/\/(?!github\.com|ethereum\.org)[^\s"']+/i.test(source)) {
        violations.push(`${file}: embeds a network endpoint`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the package exports the neutral contract surface only", () => {
    const exportedNames = Object.keys(onchainVenues).sort();
    expect(exportedNames).toContain("PACKAGE_NAME");
    expect(exportedNames).toContain("validateVenueExtensionPack");
    expect(exportedNames).toContain("venuePackId");
    expect(exportedNames).toContain("venueConnectedProtocolInstance");
    // No venue-specific export leaks into the neutral barrel.
    for (const name of exportedNames) {
      expect(/uniswap|zeroswap|solverbatch/i.test(name)).toBe(false);
    }
  });
});
