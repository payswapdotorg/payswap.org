import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import { CertificationLedger } from "@payswap/capabilities";
import {
  CONNECTOR_PACK_FAMILIES,
  SOURCE_OF_TRUTH_POLICIES,
  findSubPack,
  flattenPackCapabilityRefs,
  validateConnectorCapabilityPack,
} from "../src/index.js";
import type { ConnectorCapabilityPack } from "../src/index.js";

/**
 * Hierarchical Connector Capability Packs (§2A): provider packs are TREES
 * of independently versioned/certified sub-packs (payments, billing, risk,
 * connect/marketplace, payouts, tax, issuing, financial accounts, crypto,
 * native optimization). Each node declares auth, schemas, object mappings,
 * source-of-truth policy, rate limits, provenance and evidence.
 */

function leafPack(
  packId: string,
  version: string,
  capabilityId: string,
): ConnectorCapabilityPack {
  return {
    packId,
    family: "payments",
    version,
    subPacks: [],
    capabilityRefs: [{ capabilityId, capabilityVersion: "1.0.0" }],
    auth: { authKind: "OAUTH", scopes: ["payments:read"] },
    schemas: [{ schemaId: "schemas/payments/intent", version: "1.1.0" }],
    objectMappings: [
      {
        externalObjectType: "PAYMENT_INTENT",
        canonicalObjectRef: "work-graph/payment-intent",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE",
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE",
    rateLimits: [{ limit: 100, windowSeconds: 1, scope: "per-connected-instance" }],
    provenance: {
      publisher: "payswap-connector-publishers/psp-a",
      publishedAt: "2026-09-30T00:00:00Z",
      contentHash: "sha256:pack",
    },
    evidence: [{ evidenceId: "ev-pack-1", artifactRef: "artifacts/psp-a-payments.tgz" }],
  };
}

const paymentsPack: ConnectorCapabilityPack = {
  packId: "pack:psp-a-payments",
  family: "payments",
  version: "4.1.0",
  subPacks: [
    { ...leafPack("pack:psp-a-payments-methods", "1.3.0", "conn:payments.list-methods") },
    {
      ...leafPack("pack:psp-a-payments-authorization", "2.0.1", "conn:payments.create-authorization"),
    },
    { ...leafPack("pack:psp-a-payments-capture", "1.9.4", "conn:payments.capture") },
    { ...leafPack("pack:psp-a-payments-refund", "3.2.0", "conn:payments.refund") },
  ],
  capabilityRefs: [],
  auth: { authKind: "OAUTH", scopes: ["payments:read", "payments:write"] },
  schemas: [{ schemaId: "schemas/payments/root", version: "4.0.0" }],
  objectMappings: [],
  sourceOfTruth: "PAYSWAP_AUTHORITATIVE",
  rateLimits: [{ limit: 1000, windowSeconds: 60, scope: "pack" }],
  provenance: {
    publisher: "payswap-connector-publishers/psp-a",
    publishedAt: "2026-09-30T00:00:00Z",
    contentHash: "sha256:pack-root",
  },
  evidence: [{ evidenceId: "ev-pack-root", artifactRef: "artifacts/psp-a-root.tgz" }],
};

describe("pack family vocabulary (§2A)", () => {
  it("includes the PSP sub-pack families named by the frozen architecture", () => {
    expect([...CONNECTOR_PACK_FAMILIES]).toEqual([
      "payments",
      "billing",
      "risk",
      "connect_marketplace",
      "payouts",
      "tax",
      "issuing",
      "financial_accounts",
      "crypto",
      "native_optimization",
    ]);
  });

  it("declares the four source-of-truth policies", () => {
    expect([...SOURCE_OF_TRUTH_POLICIES]).toEqual([
      "EXTERNAL_AUTHORITATIVE",
      "PAYSWAP_AUTHORITATIVE",
      "SHARED_WITH_VERSIONED_CONFLICT_RULE",
      "DERIVED_PROJECTION",
    ]);
  });
});

describe("hierarchical pack validation", () => {
  it("validates a multi-level pack tree", () => {
    const parsed = validateConnectorCapabilityPack(paymentsPack);
    expect(parsed.packId).toBe("pack:psp-a-payments");
    expect(parsed.subPacks).toHaveLength(4);
  });

  it("rejects duplicate packIds anywhere in the tree", () => {
    expect(() =>
      validateConnectorCapabilityPack({
        ...paymentsPack,
        subPacks: [
          ...paymentsPack.subPacks,
          { ...leafPack("pack:psp-a-payments-capture", "9.9.9", "conn:payments.capture") },
        ],
      }),
    ).toThrow(/duplicate packId 'pack:psp-a-payments-capture'/);
  });

  it("requires every object mapping to declare a source-of-truth policy", () => {
    expect(() =>
      validateConnectorCapabilityPack({
        ...leafPack("pack:bad-mapping", "1.0.0", "conn:payments.refund"),
        objectMappings: [
          {
            externalObjectType: "REFUND",
            canonicalObjectRef: "work-graph/refund",
            sourceOfTruth: "WHATEVER" as never,
          },
        ],
      }),
    ).toThrow(/sourceOfTruth/);
  });

  it("requires a conflict rule for SHARED_WITH_VERSIONED_CONFLICT_RULE mappings", () => {
    expect(() =>
      validateConnectorCapabilityPack({
        ...leafPack("pack:shared-mapping", "1.0.0", "conn:payments.refund"),
        objectMappings: [
          {
            externalObjectType: "CUSTOMER",
            canonicalObjectRef: "work-graph/customer",
            sourceOfTruth: "SHARED_WITH_VERSIONED_CONFLICT_RULE",
          },
        ],
      }),
    ).toThrow(/conflictRuleRef is required/);
    expect(() =>
      validateConnectorCapabilityPack({
        ...leafPack("pack:shared-mapping-ok", "1.0.0", "conn:payments.refund"),
        objectMappings: [
          {
            externalObjectType: "CUSTOMER",
            canonicalObjectRef: "work-graph/customer",
            sourceOfTruth: "SHARED_WITH_VERSIONED_CONFLICT_RULE",
            conflictRuleRef: "conflict-rules/last-writer-with-rebase",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects an empty leaf and malformed nodes", () => {
    expect(() =>
      validateConnectorCapabilityPack(
        leafPack("pack:empty-leaf", "1.0.0", "conn:payments.refund"),
      ),
    ).not.toThrow();
    const { capabilityRefs: _c, ...stripped } = leafPack(
      "pack:stripped",
      "1.0.0",
      "conn:payments.refund",
    );
    expect(() =>
      validateConnectorCapabilityPack({ ...stripped, capabilityRefs: [] }),
    ).toThrow(/must declare capabilityRefs and\/or subPacks/);
    expect(() => validateConnectorCapabilityPack(null)).toThrow(ValidationError);
  });
});

describe("independent versioning and certification of sub-packs", () => {
  it("flattens capability refs across the tree and finds sub-packs by id", () => {
    const refs = flattenPackCapabilityRefs(paymentsPack);
    expect(refs.map((ref) => ref.capabilityId)).toEqual([
      "conn:payments.list-methods",
      "conn:payments.create-authorization",
      "conn:payments.capture",
      "conn:payments.refund",
    ]);
    const capture = findSubPack(paymentsPack, "pack:psp-a-payments-capture");
    expect(capture?.version).toBe("1.9.4");
    expect(findSubPack(paymentsPack, "pack:missing")).toBeUndefined();
  });

  it("a sub-pack version bump does not require a parent bump — versions are per node", () => {
    const bumped = validateConnectorCapabilityPack({
      ...paymentsPack,
      subPacks: paymentsPack.subPacks.map((sub) =>
        sub.packId === "pack:psp-a-payments-capture"
          ? { ...sub, version: "1.9.5" }
          : sub,
      ),
    });
    // Parent stays 4.1.0; the capture sub-pack independently moved to 1.9.5.
    expect(bumped.version).toBe("4.1.0");
    expect(findSubPack(bumped, "pack:psp-a-payments-capture")?.version).toBe("1.9.5");
    expect(
      validateConnectorCapabilityPack(paymentsPack).subPacks.find(
        (sub) => sub.packId === "pack:psp-a-payments-capture",
      )?.version,
    ).toBe("1.9.4");
  });

  it("sub-packs certify independently through the certification ledger (capability_pack subjects)", () => {
    const ledger = new CertificationLedger();
    const capture = findSubPack(paymentsPack, "pack:psp-a-payments-capture");
    if (capture === undefined) {
      throw new Error("fixture error: capture sub-pack missing");
    }
    ledger.certify({
      recordId: "cert:capture:1.9.4",
      subject: { kind: "capability_pack", subjectId: capture.packId, version: capture.version },
      status: "CERTIFIED",
      evidence: [
        {
          evidenceId: "ev-capture-cert",
          kind: "TEST_RUN",
          artifactRef: "artifacts/capture-conformance.tgz",
          contentHash: "sha256:capture",
        },
      ],
      certifiedAt: "2026-10-01T00:00:00Z",
    });
    expect(ledger.isAvailableForNewUse("pack:psp-a-payments-capture")).toBe(true);
    // The parent pack was NOT certified as part of that act.
    expect(ledger.isAvailableForNewUse("pack:psp-a-payments")).toBe(false);
  });
});
