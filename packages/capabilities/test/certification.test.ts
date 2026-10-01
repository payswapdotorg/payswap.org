import { describe, expect, it } from "vitest";
import {
  CertificationError,
  CertificationLedger,
} from "../src/index.js";
import type { CertificationRecord } from "../src/index.js";
import { assessSmartContractRisk, validateSmartContractExtension } from "../src/index.js";
import type { SmartContractExtension } from "../src/index.js";

/**
 * W2-003 — certification integration.
 *
 * INV-C03: retirement cannot rewrite in-flight history — the ledger is
 * append-only, records are deep-frozen clones, and `retire` APPENDS a
 * RETIRED record that only marks going-forward unavailability.
 * INV-SC04: a subject declaring a smart-contract extension must be
 * certified with an upgrade/governance risk profile.
 */

const extension: SmartContractExtension = validateSmartContractExtension({
  kind: "smart_contract_extension",
  chainRef: "ethereum:mainnet",
  contractAddress: "0xA1",
  sourceHash: "sha256:source",
  bytecodeHash: "sha256:bytecode",
  upgradeAuthority: { kind: "IMMUTABLE", description: "immutable logic" },
  adminAuthority: { kind: "MULTISIG", description: "admin multisig" },
  pausePowers: [],
  oracleDependencies: [],
  custody: {
    custodial: false,
    withdrawalAuthority: "user keys",
    keyManagement: "self-custody",
  },
  searchableByLabAfterCertification: true,
});

function certifiedRecord(
  subjectId: string,
  version: string,
  recordId?: string,
): CertificationRecord {
  return {
    recordId: recordId ?? `cert:${subjectId}:${version}`,
    subject: { kind: "capability", subjectId, version },
    status: "CERTIFIED",
    evidence: [
      {
        evidenceId: "ev-1",
        kind: "TEST_RUN",
        artifactRef: "artifacts/connector-cert.tgz",
        contentHash: "sha256:ev1",
      },
    ],
    certifiedAt: "2026-10-01T00:00:00Z",
  };
}

describe("certification records attach with evidence refs", () => {
  it("certifies a capability definition and exposes history", () => {
    const ledger = new CertificationLedger();
    const stored = ledger.certify(certifiedRecord("conn:payments.create", "1.0.0"));
    expect(stored.status).toBe("CERTIFIED");
    expect(ledger.historyFor("conn:payments.create").length).toBe(1);
    expect(ledger.currentStatusFor("conn:payments.create")?.status).toBe("CERTIFIED");
    expect(ledger.isAvailableForNewUse("conn:payments.create")).toBe(true);
  });

  it("certifies a capability pack subject (kind capability_pack)", () => {
    const ledger = new CertificationLedger();
    ledger.certify({
      ...certifiedRecord("pack:stripe-payments", "2.3.0"),
      subject: { kind: "capability_pack", subjectId: "pack:stripe-payments", version: "2.3.0" },
    });
    expect(ledger.currentStatusFor("pack:stripe-payments")?.record.subject.kind).toBe(
      "capability_pack",
    );
  });

  it("rejects CERTIFIED records without evidence and duplicate record ids", () => {
    const ledger = new CertificationLedger();
    expect(() =>
      ledger.certify({
        ...certifiedRecord("conn:no-evidence", "1.0.0"),
        evidence: [],
      }),
    ).toThrow(CertificationError);
    ledger.certify(certifiedRecord("conn:dup", "1.0.0", "cert:dup:1"));
    expect(() =>
      ledger.certify(certifiedRecord("conn:dup", "1.0.1", "cert:dup:1")),
    ).toThrow(/already exists/);
  });
});

describe("INV-SC04: smart-contract risk is part of certification", () => {
  it("rejects a smart-contract-backed certification without a risk profile", () => {
    const ledger = new CertificationLedger();
    expect(() =>
      ledger.certify(certifiedRecord("conn:onchain-settle", "1.0.0"), {
        subjectDeclaresSmartContract: true,
      }),
    ).toThrow(/INV-SC04/);
  });

  it("accepts it with the derived upgrade/governance risk profile", () => {
    const ledger = new CertificationLedger();
    const record = ledger.certify(
      {
        ...certifiedRecord("conn:onchain-settle", "1.0.0"),
        smartContractRisk: assessSmartContractRisk(extension),
      },
      { subjectDeclaresSmartContract: true },
    );
    expect(record.smartContractRisk?.upgradeRisk).toBe("NONE");
  });
});

describe("INV-C03: retirement cannot rewrite in-flight history", () => {
  it("appends a RETIRED record and preserves prior history untouched", () => {
    const ledger = new CertificationLedger();
    ledger.certify(certifiedRecord("conn:legacy-payouts", "1.0.0"));
    const historyBefore = ledger.historyFor("conn:legacy-payouts");
    const snapshot = JSON.parse(JSON.stringify(historyBefore)) as unknown;

    ledger.retire({
      subjectId: "conn:legacy-payouts",
      version: "1.0.0",
      retiredAt: "2026-10-02T00:00:00Z",
      note: "superseded by payouts-v2",
    });

    const historyAfter = ledger.historyFor("conn:legacy-payouts");
    expect(historyAfter.length).toBe(historyBefore.length + 1);
    // Prior records are preserved byte-for-byte — history is immutable.
    expect(JSON.parse(JSON.stringify(historyAfter.slice(0, -1))) as unknown).toEqual(
      snapshot,
    );
    // The appended record marks going-forward unavailability only.
    expect(historyAfter[historyAfter.length - 1]?.status).toBe("RETIRED");
    expect(ledger.currentStatusFor("conn:legacy-payouts")?.status).toBe("RETIRED");
    expect(ledger.isAvailableForNewUse("conn:legacy-payouts")).toBe(false);
  });

  it("deep-freezes stored records so in-flight history cannot be mutated", () => {
    const ledger = new CertificationLedger();
    ledger.certify(certifiedRecord("conn:frozen", "1.0.0"));
    const record = ledger.historyFor("conn:frozen")[0];
    expect(record).toBeDefined();
    if (record === undefined) {
      throw new Error("unreachable");
    }
    expect(() => {
      (record as { status?: string }).status = "REVOKED";
    }).toThrow();
    expect(() => {
      (record.subject as { subjectId?: string }).subjectId = "conn:tampered";
    }).toThrow();
    expect(ledger.historyFor("conn:frozen")[0]?.subject.subjectId).toBe("conn:frozen");
  });

  it("does not freeze caller-owned input objects", () => {
    const input = certifiedRecord("conn:caller-owned", "1.0.0");
    ledgerFreezeProbe(input);
    function ledgerFreezeProbe(record: CertificationRecord): void {
      const ledger = new CertificationLedger();
      ledger.certify(record);
      expect(Object.isFrozen(record)).toBe(false);
      expect(Object.isFrozen(record.evidence)).toBe(false);
    }
  });

  it("cannot retire a subject that was never certified", () => {
    const ledger = new CertificationLedger();
    expect(() =>
      ledger.retire({
        subjectId: "conn:never-certified",
        version: "1.0.0",
        retiredAt: "2026-10-02T00:00:00Z",
      }),
    ).toThrow(/no certification history/);
  });
});
