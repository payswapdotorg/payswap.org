import { describe, expect, it } from "vitest";
import {
  ACTIVATION_EVIDENCE_VERDICTS,
  appendProviderActivationRecord,
  checkProviderActivationRecord,
  currentProviderActivationRecords,
  emptyProviderActivationLedger,
  planProviderCredentialRotation,
  ProviderActivationError,
  PROVIDER_ACTIVATION_RECORD_TYPE,
  PROVIDER_ACTIVATION_SCHEMA_VERSION,
  resolveProviderEnablement,
} from "../src/provider-activation.js";

/**
 * The canonical authorization-mode union is owned by @payswap/connectors;
 * this package's boundary forbids importing it, so tests pass the same
 * five Phase 2 modes as the TL gate / operator console would.
 */
const MODES = [
  "DELEGATED_OAUTH",
  "CONNECTED_ACCOUNT",
  "SCOPED_API_CREDENTIAL",
  "INTERACTIVE_BROWSER_SESSION",
  "PROVIDERLESS_RAIL",
] as const;

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    record_type: PROVIDER_ACTIVATION_RECORD_TYPE,
    schema_version: PROVIDER_ACTIVATION_SCHEMA_VERSION,
    recordId: "par-stripe-test-20261002",
    providerName: "stripe",
    credential: {
      configKey: "PROVIDER_STRIPE_CREDENTIAL_REF",
      vaultReference: "vault://payswap/providers/stripe/test-20261002",
      authorizationMode: "SCOPED_API_CREDENTIAL",
    },
    probeEvidence: {
      evidencePath: "spec/development-state/provider-probes-20261002.json",
      probedAt: "2026-10-02T00:00:00Z",
      verdict: "VERIFIED",
      summary: "authenticated account + balance + capability probes",
    },
    status: "ACTIVATED",
    connectedInstanceId: "inst:stripe-test-20261002",
    limitations: ["test-mode keys", "webhook endpoint not yet registered"],
    recordedAt: "2026-10-02T12:00:00Z",
    recordedBy: "tl",
    ...overrides,
  };
}

describe("provider activation records (P2-W1-001)", () => {
  it("accepts a well-formed ACTIVATED record with live evidence and an instance", () => {
    const report = checkProviderActivationRecord(validRecord(), MODES);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("rejects the wrong record_type / schema_version", () => {
    expect(
      checkProviderActivationRecord(validRecord({ record_type: "provider-catalogue" }), MODES).ok,
    ).toBe(false);
    expect(
      checkProviderActivationRecord(validRecord({ schema_version: "0.9" }), MODES).ok,
    ).toBe(false);
  });

  it("rejects a config key outside the PROVIDER_<NAME>_CREDENTIAL_REF template", () => {
    const report = checkProviderActivationRecord(
      validRecord({
        credential: {
          configKey: "STRIPE_SECRET_KEY",
          vaultReference: "vault://payswap/providers/stripe/test-20261002",
          authorizationMode: "SCOPED_API_CREDENTIAL",
        },
      }),
      MODES,
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.field === "credential.configKey")).toBe(true);
  });

  it("rejects a raw value where a vault reference belongs", () => {
    const report = checkProviderActivationRecord(
      validRecord({
        credential: {
          configKey: "PROVIDER_STRIPE_CREDENTIAL_REF",
          vaultReference: "sk_test_SYNTHETIC0123456789fixture",
          authorizationMode: "SCOPED_API_CREDENTIAL",
        },
      }),
      MODES,
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.field === "credential.vaultReference")).toBe(true);
  });

  it("rejects secret-shaped values anywhere in the record (references only)", () => {
    const cases: Record<string, unknown>[] = [
      validRecord({
        limitations: ["key sk_test_SYNTHETIC0123456789fixture leaked"],
      }),
      validRecord({
        probeEvidence: {
          evidencePath: "spec/development-state/provider-probes-20261002.json",
          probedAt: "2026-10-02T00:00:00Z",
          verdict: "VERIFIED",
          summary: "probed with Bearer SYNTHETIC0123456789fixture",
        },
      }),
      validRecord({
        credential: {
          configKey: "PROVIDER_STRIPE_CREDENTIAL_REF",
          vaultReference: "vault://payswap/providers/stripe/test-20261002",
          authorizationMode: "SCOPED_API_CREDENTIAL",
        },
        connectedInstanceId: "whsec_SYNTHETIC0123456789fixture",
      }),
    ];
    for (const record of cases) {
      const report = checkProviderActivationRecord(record, MODES);
      expect(report.ok).toBe(false);
      expect(
        report.issues.some((i) => i.problem.includes("secret-shaped")),
      ).toBe(true);
    }
  });

  it("rejects an authorization mode outside the canonical union (input, never a copy)", () => {
    const report = checkProviderActivationRecord(
      validRecord({
        credential: {
          configKey: "PROVIDER_STRIPE_CREDENTIAL_REF",
          vaultReference: "vault://payswap/providers/stripe/test-20261002",
          authorizationMode: "SHARED_PASSWORD",
        },
      }),
      MODES,
    );
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((i) => i.field === "credential.authorizationMode"),
    ).toBe(true);
  });

  it("BLOCKED records cannot carry a connected instance (MTN MoMo honest status)", () => {
    const report = checkProviderActivationRecord(
      validRecord({
        recordId: "par-mtn-momo-sandbox-20261002",
        providerName: "mtn_momo",
        credential: {
          configKey: "PROVIDER_MTN_MOMO_CREDENTIAL_REF",
          vaultReference: "vault://payswap/providers/mtn-momo/sandbox-20261002",
          authorizationMode: "SCOPED_API_CREDENTIAL",
        },
        probeEvidence: {
          evidencePath: "spec/development-state/provider-probes-20261002.json",
          probedAt: "2026-10-02T00:00:00Z",
          verdict: "VERIFIED",
          summary: "subscription key rejected at APIM gate — operator input, not integration proof",
        },
        status: "BLOCKED",
        connectedInstanceId: "inst:should-not-exist",
      }),
      MODES,
    );
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((i) => i.field === "connectedInstanceId"),
    ).toBe(true);
  });

  it("ACTIVATED without an instance reference fails (INV-C05)", () => {
    const { connectedInstanceId: _omitted, ...withoutInstance } = validRecord();
    const report = checkProviderActivationRecord(withoutInstance, MODES);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((i) => i.field === "connectedInstanceId"),
    ).toBe(true);
  });

  it("rejects non-evidence verdicts (operator input is never integration proof)", () => {
    const report = checkProviderActivationRecord(
      validRecord({
        probeEvidence: {
          evidencePath: "spec/development-state/provider-probes-20261002.json",
          probedAt: "2026-10-02T00:00:00Z",
          verdict: "SUPPLIER_CLAIMED",
          summary: "operator said the credentials work",
        },
      }),
      MODES,
    );
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((i) => i.field === "probeEvidence.verdict"),
    ).toBe(true);
    expect(ACTIVATION_EVIDENCE_VERDICTS).toEqual(
      expect.arrayContaining(["VERIFIED", "ELIGIBLE", "READY"]),
    );
  });
});

describe("provider activation ledger (append-only, immutable)", () => {
  it("appends valid records and returns new snapshots (functional)", () => {
    const empty = emptyProviderActivationLedger();
    const first = appendProviderActivationRecord(empty, validRecord(), MODES);
    expect(first.records).toHaveLength(1);
    expect(empty.records).toHaveLength(0);
    expect(Object.isFrozen(first.records[0])).toBe(true);
  });

  it("rejects duplicate recordIds", () => {
    const ledger = appendProviderActivationRecord(
      emptyProviderActivationLedger(),
      validRecord(),
      MODES,
    );
    expect(() =>
      appendProviderActivationRecord(ledger, validRecord(), MODES),
    ).toThrow(ProviderActivationError);
  });

  it("enforces linear supersede chains within one provider", () => {
    const v1 = appendProviderActivationRecord(
      emptyProviderActivationLedger(),
      validRecord(),
      MODES,
    );
    const v2 = appendProviderActivationRecord(
      v1,
      validRecord({
        recordId: "par-stripe-test-20261003",
        supersedes: "par-stripe-test-20261002",
        status: "REVOKED",
        connectedInstanceId: undefined,
      }),
      MODES,
    );
    // snapshots are immutable: v1 still sees its own current truth
    expect(currentProviderActivationRecords(v1)).toHaveLength(1);
    // v2's current truth is the REVOKED superseding record — the ACTIVATED
    // predecessor is history (supersession is a ledger relationship)
    expect(currentProviderActivationRecords(v2)).toHaveLength(1);
    expect(currentProviderActivationRecords(v2)[0]?.status).toBe("REVOKED");
    // double-supersede fails
    expect(() =>
      appendProviderActivationRecord(
        v2,
        validRecord({
          recordId: "par-stripe-test-20261004",
          supersedes: "par-stripe-test-20261002",
          status: "REVOKED",
          connectedInstanceId: undefined,
        }),
        MODES,
      ),
    ).toThrow(ProviderActivationError);
    // cross-provider supersede fails
    expect(() =>
      appendProviderActivationRecord(
        v1,
        validRecord({
          recordId: "par-flw-test-20261004",
          providerName: "flutterwave",
          supersedes: "par-stripe-test-20261002",
          status: "REVOKED",
          connectedInstanceId: undefined,
          credential: {
            configKey: "PROVIDER_FLUTTERWAVE_CREDENTIAL_REF",
            vaultReference: "vault://payswap/providers/flutterwave/test-20261002",
            authorizationMode: "SCOPED_API_CREDENTIAL",
          },
        }),
        MODES,
      ),
    ).toThrow(ProviderActivationError);
  });

  it("rejects malformed records at append time (fail-closed)", () => {
    expect(() =>
      appendProviderActivationRecord(
        emptyProviderActivationLedger(),
        { nope: true },
        MODES,
      ),
    ).toThrow(ProviderActivationError);
  });
});

describe("provider enablement (data, not redeployment)", () => {
  it("is fail-closed without a verified activation record", () => {
    const enablement = resolveProviderEnablement(emptyProviderActivationLedger());
    expect(enablement).toEqual([]);
  });

  it("derives enablement from ACTIVATED records; BLOCKED stays disabled", () => {
    const ledger = appendProviderActivationRecord(
      appendProviderActivationRecord(
        emptyProviderActivationLedger(),
        validRecord(),
        MODES,
      ),
      validRecord({
        recordId: "par-mtn-momo-sandbox-20261002",
        providerName: "mtn_momo",
        credential: {
          configKey: "PROVIDER_MTN_MOMO_CREDENTIAL_REF",
          vaultReference: "vault://payswap/providers/mtn-momo/sandbox-20261002",
          authorizationMode: "SCOPED_API_CREDENTIAL",
        },
        probeEvidence: {
          evidencePath: "spec/development-state/provider-probes-20261002.json",
          probedAt: "2026-10-02T00:00:00Z",
          verdict: "READY",
          summary: "subscription key rejected at APIM gate — blocked status recorded",
        },
        status: "BLOCKED",
        connectedInstanceId: undefined,
      }),
      MODES,
    );
    const enablement = resolveProviderEnablement(ledger);
    const stripe = enablement.find((e) => e.providerName === "stripe");
    const mtn = enablement.find((e) => e.providerName === "mtn_momo");
    expect(stripe?.enabled).toBe(true);
    expect(mtn?.enabled).toBe(false);
    expect(mtn?.reason).toContain("BLOCKED");
  });

  it("an operator override may only disable — never manufacture enablement", () => {
    const ledger = appendProviderActivationRecord(
      emptyProviderActivationLedger(),
      validRecord(),
      MODES,
    );
    const disabled = resolveProviderEnablement(ledger, [
      {
        providerName: "stripe",
        enabled: false,
        reason: "incident quarantine",
        decidedAt: "2026-10-02T13:00:00Z",
      },
    ]);
    expect(disabled.find((e) => e.providerName === "stripe")?.enabled).toBe(false);

    const blockedLedger = appendProviderActivationRecord(
      emptyProviderActivationLedger(),
      validRecord({
        recordId: "par-mtn-momo-sandbox-20261002",
        providerName: "mtn_momo",
        status: "BLOCKED",
        connectedInstanceId: undefined,
        credential: {
          configKey: "PROVIDER_MTN_MOMO_CREDENTIAL_REF",
          vaultReference: "vault://payswap/providers/mtn-momo/sandbox-20261002",
          authorizationMode: "SCOPED_API_CREDENTIAL",
        },
        probeEvidence: {
          evidencePath: "spec/development-state/provider-probes-20261002.json",
          probedAt: "2026-10-02T00:00:00Z",
          verdict: "READY",
          summary: "blocked probe — subscription key rejected",
        },
      }),
      MODES,
    );
    const forced = resolveProviderEnablement(blockedLedger, [
      {
        providerName: "mtn_momo",
        enabled: true,
        reason: "operator wants it on",
        decidedAt: "2026-10-02T13:00:00Z",
      },
    ]);
    expect(forced.find((e) => e.providerName === "mtn_momo")?.enabled).toBe(false);
  });
});

describe("provider credential rotation (derived from the canonical procedure)", () => {
  it("derives the swap-reference-then-verify plan and binds the connected instance", () => {
    const ledger = appendProviderActivationRecord(
      emptyProviderActivationLedger(),
      validRecord(),
      MODES,
    );
    const plan = planProviderCredentialRotation("stripe", ledger);
    expect(plan.configKey).toBe("PROVIDER_STRIPE_CREDENTIAL_REF");
    expect(plan.procedureId).toBe("rotate-provider-credentials");
    expect(plan.steps.map((s) => s.stepId)).toEqual([
      "pause-provider-intake",
      "mint-new-provider-key",
      "swap-reference",
      "verify-connected-instance",
      "revoke-old-provider-key",
    ]);
    expect(plan.verificationBinding).toEqual({
      kind: "CONNECTED_INSTANCE",
      instanceId: "inst:stripe-test-20261002",
    });
  });

  it("without an active instance the plan demands a fresh probe before re-activation", () => {
    const plan = planProviderCredentialRotation(
      "stripe",
      emptyProviderActivationLedger(),
    );
    expect(plan.verificationBinding.kind).toBe("NO_ACTIVE_INSTANCE");
    if (plan.verificationBinding.kind === "NO_ACTIVE_INSTANCE") {
      expect(plan.verificationBinding.note).toContain("probe");
    }
  });
});
