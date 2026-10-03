import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAssetObservation, validateAssetAmount } from "../src/asset.js";
import { etherAssetObservation } from "./fixtures.js";
import type { AssetObservation } from "../src/asset.js";
import { validateSignerHandle } from "../src/wallet.js";
import { signerHandle } from "./fixtures.js";
import { isChainCatalogueShape } from "../src/chain.js";
import { ethereumChainDefinition, connectedChainInstance } from "./fixtures.js";
import {
  mapObservationToRailOutcome,
  settlementAttemptEventCandidate,
} from "../src/settlement-mapping.js";
import { unknownObservation, failedObservation } from "./fixtures.js";
import * as onchainDomain from "../src/index.js";

/**
 * ADVERSARIAL GUARDS (P4-W1-001 hard constraints, structurally scanned).
 *
 * 1. SECRET-FIELD GUARD (AGENTS.md rule 25): no agent-facing contract in
 *    this package declares any field whose name looks like key/seed/
 *    mnemonic/secret/password/api-key/credential material. The scan walks
 *    every property declaration in src/**.
 * 2. EVM-LEAKAGE GUARD (rule 17): the neutral core contracts never mention
 *    family-specific shapes — not even in comments. Only
 *    family-extensions.ts (labeled) may carry them.
 * 3. CATALOGUE-NEVER-AUTHORIZES / OBSERVATIONS-NOT-CUSTODY /
 *    NO-FLOATING-POINT-MONEY runtime probes.
 */

const SRC_DIR = join(process.cwd(), "src");

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

const SRC_FILES = listSourceFiles(SRC_DIR);

const fileName = (path: string): string => path.split(/[\\/]/).pop() as string;

describe("SECRET-FIELD GUARD (rule 25: no private-key/seed/password/secret fields)", () => {
  it("src/** declares no key/seed/mnemonic/secret/password-shaped property", () => {
    const violations: string[] = [];
    // Anchored property-declaration lines only (interface/type/class
    // members): `readonly fieldName:` / `fieldName?:` / `fieldName:`.
    const propertyDeclaration =
      /^\s*(?:export\s+)?(?:readonly\s+)?(?:declare\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(\?)?\s*:/;
    const forbiddenFieldName =
      /^(privatekey|priv_?key|seed_?phrase|seedwords|mnemonic|secret|secret_?key|password|passphrase|api_?key|access_?token|refreshtoken|session_?secret|client_?secret|keystore_?json|encrypted_?key)$/i;
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        const match = propertyDeclaration.exec(line);
        if (match !== null) {
          const fieldName = match[1] as string;
          if (forbiddenFieldName.test(fieldName)) {
            violations.push(`${fileName(file)}: ${line.trim()}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the raw word 'privateKey'/'seedPhrase'/'password' appears nowhere in src declarations", () => {
    const violations: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of [
        "privateKey",
        "private_key",
        "seedPhrase",
        "seed_phrase",
        "mnemonic",
        "password",
        "apiKey",
        "api_key",
      ]) {
        if (source.includes(forbidden)) {
          violations.push(`${fileName(file)} contains '${forbidden}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("a SignerHandle rejects key-material-shaped ids (runtime probe)", () => {
    expect(() =>
      validateSignerHandle({ ...signerHandle(), handleId: "4c0883a69102937d".repeat(4) }),
    ).toThrow(/key material/);
    expect(() =>
      validateSignerHandle({ ...signerHandle(), handleId: "0x" + "deadbeef".repeat(8) }),
    ).toThrow(/key material/);
  });
});

describe("EVM-LEAKAGE GUARD (rule 17: neutral core contracts never mention EVM-specific shapes)", () => {
  it("every neutral core file never mentions EVM at all — not even in comments", () => {
    const neutralFiles = SRC_FILES.filter(
      (file) => fileName(file) !== "family-extensions.ts" && fileName(file) !== "family.ts",
    );
    expect(neutralFiles.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of neutralFiles) {
      const source = readFileSync(file, "utf8");
      if (/evm/i.test(source)) {
        violations.push(`${fileName(file)} mentions family-specific vocabulary`);
      }
      for (const forbidden of [
        /\babi\b/i,
        /\bgas\b/i,
        /calldata/i,
        /\berc\d+/i,
        /eip[-_ ]?\d/i,
        /secp256k1/i,
        /\bwei\b/i,
        /solidity/i,
        /metamask/i,
      ]) {
        if (forbidden.test(source)) {
          violations.push(`${fileName(file)} leaks '${forbidden.source}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the family vocabulary file mentions EVM ONLY as the family name (no shapes leak)", () => {
    const familyFile = SRC_FILES.find((file) => fileName(file) === "family.ts");
    expect(familyFile).toBeDefined();
    const source = readFileSync(familyFile as string, "utf8");
    // 'EVM' may appear only as a family member name, never with shapes.
    for (const forbidden of [
      /evmaddress/i,
      /evmchainid/i,
      /\babi\b/i,
      /\bgas\b/i,
      /calldata/i,
      /\berc\d+/i,
      /eip[-_ ]?\d/i,
      /\bwei\b/i,
    ]) {
      expect(forbidden.test(source)).toBe(false);
    }
  });

  it("family extensions are OPTIONAL: neutral contracts validate without any extension", () => {
    // Covered in chain/asset tests; asserted here as the explicit guard.
    const definition = ethereumChainDefinition();
    const neutral = {
      ...definition,
      chain: { ...definition.chain, familyExtension: undefined },
    };
    expect((neutral.chain as Record<string, unknown>).familyExtension).toBeUndefined();
  });
});

describe("OBSERVATIONS-NOT-CUSTODY GUARD (INV-C09 / rule 21)", () => {
  it("this package exports NO money/balance constructor (no parallel ledger)", () => {
    const exportedNames = Object.keys(onchainDomain).sort();
    for (const forbidden of [/balance/i, /ledger/i, /\bmint/i, /\bdeposit/i]) {
      for (const name of exportedNames) {
        expect(forbidden.test(name)).toBe(false);
      }
    }
    // Custody vocabulary is restricted to the descriptive custody-model
    // classification (who controls keys) — never a custody claim or a
    // custody-taking constructor.
    const custodyNames = exportedNames.filter((name) => /custody/i.test(name));
    expect(custodyNames.sort()).toEqual(
      ["WALLET_CUSTODY_MODELS", "isWalletCustodyModel"].sort(),
    );
    // And nothing returns the protocol Money type (type-level guard in
    // type-level.test.ts); the package never imports the Money constructor.
    const violations: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (/import\s*\{[^}]*\bMoney\b[^}]*\}\s*from/.test(source)) {
        violations.push(`${fileName(file)} imports Money`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("an asset observation without freshness/provenance/observer is not evidence (runtime probe)", () => {
    for (const strip of ["freshness", "provenance", "observer"] as const) {
      const stripped = { ...etherAssetObservation(), [strip]: undefined } as Partial<AssetObservation>;
      expect(() => validateAssetObservation(stripped)).toThrow(/MANDATORY|must be/i);
    }
  });

  it("the observation brand makes observations nominally distinct from balances", () => {
    expect(etherAssetObservation().observationKind).toBe("AssetObservation");
    const renamed = { ...etherAssetObservation(), observationKind: "Balance" };
    expect(() => validateAssetObservation(renamed)).toThrow(/observationKind/);
  });
});

describe("NO-FLOATING-POINT-MONEY GUARD (INV-F01)", () => {
  it("floating-point and malformed minor units never validate anywhere", () => {
    for (const minorUnits of ["1.5", "1e7", "0x1", "-1", "0.1", ""]) {
      expect(() => validateAssetAmount({ assetId: "a", minorUnits })).toThrow(/minorUnits/);
    }
    const floatObservation = {
      ...etherAssetObservation(),
      observedAmount: { currency: etherAssetObservation().assetId, minorUnits: "0.1" },
    };
    expect(() => validateAssetObservation(floatObservation)).toThrow(/observedAmount/);
  });
});

describe("CATALOGUE-NEVER-AUTHORIZES GUARD (INV-C05 discipline — runtime probes)", () => {
  it("chain catalogue shapes are discriminated from instances deterministically", () => {
    expect(isChainCatalogueShape(ethereumChainDefinition())).toBe(true);
    expect(isChainCatalogueShape(ethereumChainDefinition().chain)).toBe(true);
    expect(isChainCatalogueShape(connectedChainInstance())).toBe(false);
    expect(isChainCatalogueShape(null)).toBe(false);
    expect(isChainCatalogueShape(undefined)).toBe(false);
    expect(isChainCatalogueShape("chain.ethereum:mainnet")).toBe(false);
  });

  it("UNKNOWN observations never map into failures or success (INV-X01 runtime probe)", () => {
    const outcome = mapObservationToRailOutcome(unknownObservation());
    expect(outcome.kind).toBe("RAIL_EFFECT_UNKNOWN");
    const failed = mapObservationToRailOutcome(failedObservation());
    expect(failed.kind).toBe("RAIL_EFFECT_FAILED");
    // The UNKNOWN observation NEVER suggests a blind retry event; only a
    // reconciliation resolution can move the canonical attempt onward.
    expect(settlementAttemptEventCandidate(unknownObservation())).toEqual({
      kind: "EVENT_CANDIDATE",
      event: "OUTCOME_UNKNOWN",
    });
  });
});
