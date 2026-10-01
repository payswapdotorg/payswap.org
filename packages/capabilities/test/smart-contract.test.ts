import { describe, expect, it } from "vitest";
import {
  assessSmartContractRisk,
  isSearchableByLab,
  validateSmartContractExtension,
} from "../src/index.js";
import type { SmartContractExtension } from "../src/index.js";

/**
 * W2-003 — smart-contract extension representation.
 *
 * INV-SC01: source/bytecode, chain, address, upgrade, admin, pause, oracle
 * and custody properties are ALL declared — an omission is a validation
 * error, never an assumption.
 * INV-SC04: upgrade/governance risk is part of capability certification —
 * the deterministic risk profile below is what certification requires.
 */

const validDeclaration: SmartContractExtension = {
  kind: "smart_contract_extension",
  chainRef: "ethereum:mainnet",
  contractAddress: "0xA1000000000000000000000000000000000000AA",
  sourceHash: "sha256:source-hash",
  bytecodeHash: "sha256:bytecode-hash",
  upgradeAuthority: {
    kind: "IMMUTABLE",
    description: "no upgrade path after deployment",
  },
  adminAuthority: {
    kind: "MULTISIG",
    description: "4-of-7 operations multisig",
  },
  pausePowers: [{ actor: "operations multisig", scope: "new settlements only" }],
  oracleDependencies: [
    { oracleRef: "oracle:eth-usd", usage: "settlement reference price" },
  ],
  custody: {
    custodial: false,
    withdrawalAuthority: "user-controlled keys only",
    keyManagement: "user self-custody wallets",
  },
  searchableByLabAfterCertification: true,
};

describe("INV-SC01: every property must be declared", () => {
  it("validates a complete declaration", () => {
    const parsed = validateSmartContractExtension(validDeclaration);
    expect(parsed.contractAddress).toBe(validDeclaration.contractAddress);
    expect(parsed.upgradeAuthority.kind).toBe("IMMUTABLE");
    expect(parsed.custody.custodial).toBe(false);
    expect(parsed.searchableByLabAfterCertification).toBe(true);
  });

  it("rejects each omission with the missing property named", () => {
    const omittedFields = [
      "chainRef",
      "contractAddress",
      "sourceHash",
      "bytecodeHash",
      "upgradeAuthority",
      "adminAuthority",
      "pausePowers",
      "oracleDependencies",
      "custody",
      "searchableByLabAfterCertification",
    ] as const;
    for (const field of omittedFields) {
      const { [field]: _omitted, ...incomplete } = validDeclaration;
      expect(() => validateSmartContractExtension(incomplete)).toThrow(
        new RegExp(field),
      );
    }
  });

  it("rejects a custodial contract without a declared custodian", () => {
    expect(() =>
      validateSmartContractExtension({
        ...validDeclaration,
        custody: {
          custodial: true,
          withdrawalAuthority: "operator multisig with user proof",
          keyManagement: "operator HSM",
        },
      }),
    ).toThrow(/custodianRef/);
    const custodial = validateSmartContractExtension({
      ...validDeclaration,
      custody: {
        custodial: true,
        custodianRef: "party:licensed-custodian",
        withdrawalAuthority: "operator multisig with user proof",
        keyManagement: "operator HSM",
      },
    });
    expect(custodial.custody.custodial).toBe(true);
    expect(custodial.custody.custodianRef).toBe("party:licensed-custodian");
  });

  it("rejects non-objects and wrong kind", () => {
    expect(() => validateSmartContractExtension(null)).toThrow();
    expect(() => validateSmartContractExtension(42)).toThrow();
    expect(() =>
      validateSmartContractExtension({ ...validDeclaration, kind: "crypto_wallet" }),
    ).toThrow(/kind/);
  });
});

describe("INV-SC04: deterministic upgrade/governance risk profile", () => {
  it("maps immutable upgrade authority to NONE", () => {
    const profile = assessSmartContractRisk(validDeclaration);
    expect(profile.upgradeRisk).toBe("NONE");
    expect(profile.governanceRisk).toBe("MEDIUM"); // MULTISIG admin
    expect(profile.pauseRisk).toBe("PRESENT");
    expect(profile.oracleRisk).toBe("PRESENT");
    expect(profile.custodyRisk).toBe("NON_CUSTODIAL");
  });

  it("maps an unbounded upgrade path to UNBOUNDED, a timelocked one to BOUNDED", () => {
    const unbounded = assessSmartContractRisk({
      ...validDeclaration,
      upgradeAuthority: {
        kind: "UPGRADEABLE",
        description: "upgradeable proxy without timelock",
      },
    });
    expect(unbounded.upgradeRisk).toBe("UNBOUNDED");

    const bounded = assessSmartContractRisk({
      ...validDeclaration,
      upgradeAuthority: {
        kind: "UPGRADEABLE",
        description: "upgradeable proxy behind a 48h timelock",
        delayOrTimelock: "48h timelock",
      },
    });
    expect(bounded.upgradeRisk).toBe("BOUNDED");
  });

  it("maps admin authority to governance risk levels deterministically", () => {
    expect(
      assessSmartContractRisk({
        ...validDeclaration,
        adminAuthority: { kind: "IMMUTABLE", description: "fixed admin" },
      }).governanceRisk,
    ).toBe("LOW");
    expect(
      assessSmartContractRisk({
        ...validDeclaration,
        adminAuthority: { kind: "DAO", description: "token-vote governance" },
      }).governanceRisk,
    ).toBe("HIGH");
  });

  it("marks custodial custody as CUSTODIAL", () => {
    const custodial = assessSmartContractRisk({
      ...validDeclaration,
      custody: {
        custodial: true,
        custodianRef: "party:licensed-custodian",
        withdrawalAuthority: "custodian with user instruction",
        keyManagement: "custodian HSM",
      },
    });
    expect(custodial.custodyRisk).toBe("CUSTODIAL");
  });
});

describe("Lab searchability after certification", () => {
  it("is searchable only when certified AND declared searchable", () => {
    expect(isSearchableByLab(validDeclaration, "CERTIFIED")).toBe(true);
    expect(isSearchableByLab(validDeclaration, "REVOKED")).toBe(false);
    expect(isSearchableByLab(validDeclaration, "RETIRED")).toBe(false);
    expect(
      isSearchableByLab(
        { ...validDeclaration, searchableByLabAfterCertification: false },
        "CERTIFIED",
      ),
    ).toBe(false);
  });
});
