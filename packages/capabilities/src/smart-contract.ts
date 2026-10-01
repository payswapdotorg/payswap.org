/**
 * Smart-contract extension representation (W2-003, FROZEN-ARCHITECTURE
 * §SMART-CONTRACT-EXTENSIONS, ADR-002, INV-SC01, INV-SC04).
 *
 * A capability that is (partly) realized by a smart contract must declare its
 * code/address/chain/authority/pause/oracle/custody properties in full
 * (INV-SC01): every property below is REQUIRED — an undeclared property is a
 * validation error, never an assumption (INV-NC03).
 *
 * Certification treats the contract's upgrade/governance risk as part of the
 * capability's certification (INV-SC04): `assessSmartContractRisk` derives a
 * deterministic risk profile from the declared authorities, and
 * certification of a smart-contract-backed capability requires that profile
 * (see ./certification.js).
 *
 * The extension carries `searchableByLabAfterCertification` so the Lab can
 * find certified smart-contract capabilities; the flag alone grants no
 * authority.
 */

/** Who can change the contract's logic. */
export const SMART_CONTRACT_AUTHORITY_KINDS = [
  "IMMUTABLE",
  "PROVIDER_GOVERNED",
  "MULTISIG",
  "UPGRADEABLE",
  "DAO",
] as const;
export type SmartContractAuthorityKind =
  (typeof SMART_CONTRACT_AUTHORITY_KINDS)[number];

/** One declared authority over a smart contract (INV-SC01). */
export interface SmartContractAuthority {
  readonly kind: SmartContractAuthorityKind;
  readonly description: string;
  /** Declared timelock/execution delay (free-form, e.g. '48h timelock'). */
  readonly delayOrTimelock?: string;
}

/** One declared pause power. */
export interface SmartContractPausePower {
  readonly actor: string;
  readonly scope: string;
}

/** One declared oracle dependency. */
export interface SmartContractOracleDependency {
  readonly oracleRef: string;
  readonly usage: string;
}

/** Declared custody properties (INV-SC01; INV-NC02/NC03 for fund-holding). */
export interface SmartContractCustodyProperties {
  readonly custodial: boolean;
  /** Who actually holds funds when custodial; must be declared when true. */
  readonly custodianRef?: string;
  /** How the contract's withdrawal/recovery authority is exercised. */
  readonly withdrawalAuthority: string;
  readonly keyManagement: string;
}

/**
 * A smart-contract extension declaration (INV-SC01). Every field is a
 * declared property — the validator below rejects any omission.
 */
export interface SmartContractExtension {
  readonly kind: "smart_contract_extension";
  /** Chain identifier (e.g. 'ethereum:mainnet'). */
  readonly chainRef: string;
  readonly contractAddress: string;
  /** Hash of the verified source. */
  readonly sourceHash: string;
  /** Hash of the deployed bytecode. */
  readonly bytecodeHash: string;
  readonly upgradeAuthority: SmartContractAuthority;
  readonly adminAuthority: SmartContractAuthority;
  readonly pausePowers: readonly SmartContractPausePower[];
  readonly oracleDependencies: readonly SmartContractOracleDependency[];
  readonly custody: SmartContractCustodyProperties;
  /**
   * Declares that the Lab may index/search this contract once the carrying
   * capability is certified. A searchability flag is never execution
   * authority (see isSearchableByLab).
   */
  readonly searchableByLabAfterCertification: boolean;
}

/** Deterministic upgrade/governance risk profile (INV-SC04). */
export interface SmartContractRiskProfile {
  readonly upgradeRisk: "NONE" | "BOUNDED" | "UNBOUNDED";
  readonly governanceRisk: "LOW" | "MEDIUM" | "HIGH";
  readonly pauseRisk: "NONE" | "PRESENT";
  readonly oracleRisk: "NONE" | "PRESENT";
  readonly custodyRisk: "CUSTODIAL" | "NON_CUSTODIAL";
  readonly notes: readonly string[];
}

/** Raised when a smart-contract declaration is incomplete (INV-SC01). */
export class SmartContractValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Invalid smart-contract extension: ${errors.join("; ")}`);
    this.name = "SmartContractValidationError";
    this.errors = errors;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAuthorityKind(value: unknown): value is SmartContractAuthorityKind {
  return (
    typeof value === "string" &&
    (SMART_CONTRACT_AUTHORITY_KINDS as readonly unknown[]).includes(value)
  );
}

function readAuthority(
  record: Readonly<Record<string, unknown>>,
  field: "upgradeAuthority" | "adminAuthority",
  errors: string[],
): SmartContractAuthority | undefined {
  const value = record[field];
  if (value === null || typeof value !== "object") {
    errors.push(`${field} must be a declared SmartContractAuthority (INV-SC01)`);
    return undefined;
  }
  const authority = value as Readonly<Record<string, unknown>>;
  const errorsBefore = errors.length;
  if (!isAuthorityKind(authority["kind"])) {
    errors.push(`${field}.kind must be one of [${SMART_CONTRACT_AUTHORITY_KINDS.join(", ")}]`);
  }
  if (!isNonEmptyString(authority["description"])) {
    errors.push(`${field}.description must be a non-empty string`);
  }
  if (authority["delayOrTimelock"] !== undefined && !isNonEmptyString(authority["delayOrTimelock"])) {
    errors.push(`${field}.delayOrTimelock, when present, must be a non-empty string`);
  }
  if (errors.length > errorsBefore) {
    return undefined;
  }
  const delay = authority["delayOrTimelock"];
  const parsed: SmartContractAuthority = {
    kind: authority["kind"] as SmartContractAuthorityKind,
    description: authority["description"] as string,
    ...(typeof delay === "string" ? { delayOrTimelock: delay } : {}),
  };
  return parsed;
}

/**
 * Validates a smart-contract extension declaration arriving from untyped
 * sources. INV-SC01: source/bytecode hashes, chain, address, upgrade and
 * admin authority, pause powers, oracle dependencies and custody properties
 * are ALL mandatory — an undeclared property is rejected, never assumed.
 */
export function validateSmartContractExtension(
  candidate: unknown,
): SmartContractExtension {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new SmartContractValidationError([
      "smart-contract extension must be an object",
    ]);
  }
  const record = candidate as Readonly<Record<string, unknown>>;

  if (record["kind"] !== "smart_contract_extension") {
    errors.push("kind must be 'smart_contract_extension'");
  }
  for (const field of ["chainRef", "contractAddress", "sourceHash", "bytecodeHash"] as const) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`${field} must be a non-empty string (INV-SC01)`);
    }
  }
  const upgradeAuthority = readAuthority(record, "upgradeAuthority", errors);
  const adminAuthority = readAuthority(record, "adminAuthority", errors);

  if (!Array.isArray(record["pausePowers"])) {
    errors.push("pausePowers must be an array of declared pause powers (may be empty)");
  }
  if (!Array.isArray(record["oracleDependencies"])) {
    errors.push("oracleDependencies must be an array of declared oracle dependencies (may be empty)");
  }

  const custodyValue = record["custody"];
  if (custodyValue === null || typeof custodyValue !== "object") {
    errors.push("custody must be declared (INV-SC01)");
  } else {
    const custody = custodyValue as Readonly<Record<string, unknown>>;
    if (typeof custody["custodial"] !== "boolean") {
      errors.push("custody.custodial must be a boolean");
    }
    if (custody["custodial"] === true && !isNonEmptyString(custody["custodianRef"])) {
      errors.push("custody.custodianRef must be declared when custodial");
    }
    if (!isNonEmptyString(custody["withdrawalAuthority"])) {
      errors.push("custody.withdrawalAuthority must be a non-empty string (INV-NC02)");
    }
    if (!isNonEmptyString(custody["keyManagement"])) {
      errors.push("custody.keyManagement must be a non-empty string");
    }
  }

  if (typeof record["searchableByLabAfterCertification"] !== "boolean") {
    errors.push("searchableByLabAfterCertification must be a boolean");
  }

  if (errors.length > 0) {
    throw new SmartContractValidationError(errors);
  }

  const custody = custodyValue as Readonly<Record<string, unknown>>;
  const custodianRef = custody["custodianRef"];
  const parsedCustody: SmartContractCustodyProperties = {
    custodial: custody["custodial"] as boolean,
    withdrawalAuthority: custody["withdrawalAuthority"] as string,
    keyManagement: custody["keyManagement"] as string,
    ...(isNonEmptyString(custodianRef) ? { custodianRef } : {}),
  };

  const extension: SmartContractExtension = {
    kind: "smart_contract_extension",
    chainRef: record["chainRef"] as string,
    contractAddress: record["contractAddress"] as string,
    sourceHash: record["sourceHash"] as string,
    bytecodeHash: record["bytecodeHash"] as string,
    upgradeAuthority: upgradeAuthority as SmartContractAuthority,
    adminAuthority: adminAuthority as SmartContractAuthority,
    pausePowers: Object.freeze(
      [...(record["pausePowers"] as readonly unknown[])],
    ) as readonly SmartContractPausePower[],
    oracleDependencies: Object.freeze(
      [...(record["oracleDependencies"] as readonly unknown[])],
    ) as readonly SmartContractOracleDependency[],
    custody: Object.freeze(parsedCustody),
    searchableByLabAfterCertification: record[
      "searchableByLabAfterCertification"
    ] as boolean,
  };
  return extension;
}

/**
 * Deterministic upgrade/governance risk profile for a declared extension
 * (INV-SC04). Pure function of the declaration:
 *
 * - upgradeRisk: IMMUTABLE logic → NONE; any upgrade path with a declared
 *   delay/timelock → BOUNDED; an upgrade path without one → UNBOUNDED;
 * - governanceRisk (admin authority): IMMUTABLE → LOW; PROVIDER_GOVERNED or
 *   MULTISIG → MEDIUM; UPGRADEABLE or DAO → HIGH;
 * - pause/oracle risk PRESENT iff any pause power / oracle dependency is
 *   declared; custody risk CUSTODIAL iff custody.custodial.
 */
export function assessSmartContractRisk(
  extension: SmartContractExtension,
): SmartContractRiskProfile {
  const upgrade = extension.upgradeAuthority;
  const upgradeRisk: SmartContractRiskProfile["upgradeRisk"] =
    upgrade.kind === "IMMUTABLE"
      ? "NONE"
      : upgrade.delayOrTimelock !== undefined
        ? "BOUNDED"
        : "UNBOUNDED";

  const admin = extension.adminAuthority;
  const governanceRisk: SmartContractRiskProfile["governanceRisk"] =
    admin.kind === "IMMUTABLE"
      ? "LOW"
      : admin.kind === "PROVIDER_GOVERNED" || admin.kind === "MULTISIG"
        ? "MEDIUM"
        : "HIGH";

  const notes: string[] = [
    `upgrade authority: ${upgrade.kind}${upgrade.delayOrTimelock !== undefined ? ` (${upgrade.delayOrTimelock})` : ""}`,
    `admin authority: ${admin.kind}`,
  ];
  if (extension.pausePowers.length > 0) {
    notes.push(`pause powers: ${extension.pausePowers.length}`);
  }
  if (extension.oracleDependencies.length > 0) {
    notes.push(`oracle dependencies: ${extension.oracleDependencies.length}`);
  }

  return Object.freeze({
    upgradeRisk,
    governanceRisk,
    pauseRisk: extension.pausePowers.length > 0 ? "PRESENT" : "NONE",
    oracleRisk: extension.oracleDependencies.length > 0 ? "PRESENT" : "NONE",
    custodyRisk: extension.custody.custodial ? "CUSTODIAL" : "NON_CUSTODIAL",
    notes: Object.freeze(notes),
  });
}

/**
 * Whether the Lab may index/search this contract: only after the carrying
 * capability is CERTIFIED, and only when the extension declared the flag.
 * Searchability is discovery, never execution authority.
 */
export function isSearchableByLab(
  extension: SmartContractExtension,
  certificationStatus: "CERTIFIED" | "SUPERSEDED" | "REVOKED" | "RETIRED" | "UNCERTIFIED",
): boolean {
  return (
    extension.searchableByLabAfterCertification && certificationStatus === "CERTIFIED"
  );
}
