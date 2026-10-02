import { describe, expect, it } from "vitest";
import { AUTHORIZATION_MODES } from "@payswap/connectors";
import { runCrossProviderConformance } from "@payswap/journeys";
import {
  appendProviderActivationRecord,
  emptyProviderActivationLedger,
  resolveProviderEnablement,
} from "../src/provider-activation.js";
import type { ProviderActivationLedger, ProviderProbeEvidenceRef } from "../src/provider-activation.js";
import {
  checkProviderRolloutPlan,
  checkProviderRolloutReleaseRecord,
  deactivateProvider,
  executeProviderRolloutPlan,
  ProviderRolloutError,
  PROVIDER_ROLLOUT_PARITY_ALLOWED_DIFFERENCES,
  PROVIDER_ROLLOUT_RELEASE_RECORD_TYPE,
  PROVIDER_ROLLOUT_ROLLBACK_STEPS,
  PROVIDER_ROLLOUT_SCHEMA_VERSION,
  reactivateProvider,
  rehearseProviderRollback,
  verifyProviderRolloutParity,
} from "../src/provider-rollout.js";
import type {
  CertificationEvidenceRef,
  ProviderRolloutBrowserEvidence,
  ProviderRolloutPlan,
  RolloutEnvironmentProviderSet,
} from "../src/provider-rollout.js";

/**
 * The canonical authorization-mode union is imported DIRECTLY from
 * @payswap/connectors here (the battery binds the checker input to the
 * canonical export — the drift-prevention half of the P2-W1-001 law 6
 * pattern: the src checker receives it as an argument, the test supplies
 * the real thing).
 */
const MODES: readonly string[] = AUTHORIZATION_MODES;

// ---------------------------------------------------------------------------
// Fixtures (deterministic; obviously-synthetic material only)
// ---------------------------------------------------------------------------

const PROBE_EVIDENCE_STRIPE = {
  evidencePath: "spec/development-state/provider-probes-20261002.json",
  probedAt: "2026-10-02T06:37:38Z",
  verdict: "VERIFIED",
  summary:
    "live test-mode account probe: authentication VERIFIED, observed account scope, real create+cancel PaymentIntent round-trip",
} as const;

const PROBE_EVIDENCE_PAYSTACK = {
  evidencePath: "spec/development-state/provider-probes-20261002.json",
  probedAt: "2026-10-02T06:37:38Z",
  verdict: "ELIGIBLE",
  summary:
    "live test-mode probe: authentication VERIFIED, GHS ghipss + NGN/KES/ZAR bank-rail enumeration",
} as const;

const PROBE_EVIDENCE_FLUTTERWAVE = {
  evidencePath: "spec/development-state/provider-probes-20261002.json",
  probedAt: "2026-10-02T06:37:38Z",
  verdict: "ELIGIBLE",
  summary:
    "live probe: authentication VERIFIED, 31-wallet observation incl. USDC/USDT/RLUSD stablecoins",
} as const;

const CERTIFICATION_STRIPE: CertificationEvidenceRef = {
  certificationId: "P2-W2-003-cross-provider-conformance",
  providerName: "stripe",
  executed: 13,
  passed: 13,
  failed: 0,
  notApplicable: 0,
  evidencePath: "packages/journeys/test/conformance.test.ts (matrix 39 pairs)",
};

const CERTIFICATION_PAYSTACK: CertificationEvidenceRef = {
  certificationId: "P2-W2-003-cross-provider-conformance",
  providerName: "paystack",
  executed: 9,
  passed: 9,
  failed: 0,
  notApplicable: 4,
  evidencePath: "packages/journeys/test/conformance.test.ts (matrix 39 pairs)",
};

const CERTIFICATION_FLUTTERWAVE: CertificationEvidenceRef = {
  certificationId: "P2-W2-003-cross-provider-conformance",
  providerName: "flutterwave",
  executed: 9,
  passed: 9,
  failed: 0,
  notApplicable: 4,
  evidencePath: "packages/journeys/test/conformance.test.ts (matrix 39 pairs)",
};

function activatedRecordFixture(
  providerName: string,
  recordId: string,
  instanceId: string,
  probeEvidence: ProviderProbeEvidenceRef,
): Record<string, unknown> {
  return {
    record_type: "provider-activation",
    schema_version: "1.0",
    recordId,
    providerName,
    credential: {
      configKey: `PROVIDER_${providerName.toUpperCase()}_CREDENTIAL_REF`,
      vaultReference: `vault://payswap/providers/${providerName}`,
      authorizationMode: "SCOPED_API_CREDENTIAL",
    },
    probeEvidence,
    status: "ACTIVATED",
    connectedInstanceId: instanceId,
    limitations: ["test-mode credentials (honest limitation carried)"],
    recordedAt: "2026-10-02T07:00:00Z",
    recordedBy: "tl-gate",
  };
}

function buildLedger(): ProviderActivationLedger {
  let ledger = emptyProviderActivationLedger();
  ledger = appendProviderActivationRecord(
    ledger,
    activatedRecordFixture(
      "stripe",
      "pa-stripe-001",
      "cci-stripe-001",
      PROBE_EVIDENCE_STRIPE,
    ),
    MODES,
  );
  ledger = appendProviderActivationRecord(
    ledger,
    activatedRecordFixture(
      "paystack",
      "pa-paystack-001",
      "cci-paystack-001",
      PROBE_EVIDENCE_PAYSTACK,
    ),
    MODES,
  );
  ledger = appendProviderActivationRecord(
    ledger,
    activatedRecordFixture(
      "flutterwave",
      "pa-flutterwave-001",
      "cci-flutterwave-001",
      PROBE_EVIDENCE_FLUTTERWAVE,
    ),
    MODES,
  );
  return ledger;
}

function providerSetFixture(
  environment: "preview" | "production",
): RolloutEnvironmentProviderSet {
  return {
    environment,
    providers: [
      {
        providerName: "stripe",
        activationRecordId: "pa-stripe-001",
        configKey: "PROVIDER_STRIPE_CREDENTIAL_REF",
        vaultReference: `vault://payswap/${environment}/providers/stripe`,
      },
      {
        providerName: "paystack",
        activationRecordId: "pa-paystack-001",
        configKey: "PROVIDER_PAYSTACK_CREDENTIAL_REF",
        vaultReference: `vault://payswap/${environment}/providers/paystack`,
      },
      {
        providerName: "flutterwave",
        activationRecordId: "pa-flutterwave-001",
        configKey: "PROVIDER_FLUTTERWAVE_CREDENTIAL_REF",
        vaultReference: `vault://payswap/${environment}/providers/flutterwave`,
      },
    ],
  };
}

function planFixture(): ProviderRolloutPlan {
  return {
    planId: "provider-rollout-20261002",
    workOrder: "P2-W3-003",
    plannedAt: "2026-10-02T12:00:00Z",
    plannedBy: "tl-gate",
    items: [
      {
        providerName: "stripe",
        activationRecordId: "pa-stripe-001",
        probeEvidence: PROBE_EVIDENCE_STRIPE,
        certification: CERTIFICATION_STRIPE,
        limitations: ["test-mode credentials"],
      },
      {
        providerName: "paystack",
        activationRecordId: "pa-paystack-001",
        probeEvidence: PROBE_EVIDENCE_PAYSTACK,
        certification: CERTIFICATION_PAYSTACK,
        limitations: ["test-mode credentials"],
      },
      {
        providerName: "flutterwave",
        activationRecordId: "pa-flutterwave-001",
        probeEvidence: PROBE_EVIDENCE_FLUTTERWAVE,
        certification: CERTIFICATION_FLUTTERWAVE,
        limitations: ["test-mode credentials"],
      },
    ],
    preview: providerSetFixture("preview"),
    production: providerSetFixture("production"),
    nonConnections: [
      {
        providerName: "mtn_momo",
        status: "BLOCKED",
        reason:
          "subscription key rejected at the APIM gate (HTTP 401) — honest blocked probe, re-probe on a valid key",
        evidencePath: "spec/development-state/provider-probes-20261002.json",
      },
      {
        providerName: "paypal-direct",
        status: "NO_CREDENTIAL_HELD",
        reason:
          "no Wave-2 provider credential held — connector real-mapped and fail-closed (INV-NC04)",
      },
    ],
  };
}

const BROWSER_EVIDENCE: ProviderRolloutBrowserEvidence = {
  suiteId: "payswap.provider-rollout-browser-verification",
  workOrder: "P2-W3-003",
  passed: true,
  digest: "fnv1a64:synthetic-browser-evidence-digest",
  journeyRunCount: 5,
};

// ---------------------------------------------------------------------------
// Plan checking
// ---------------------------------------------------------------------------

describe("checkProviderRolloutPlan", () => {
  it("accepts the certified plan over the activated ledger", () => {
    const report = checkProviderRolloutPlan(planFixture(), buildLedger(), MODES);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("rejects a plan item whose activation record is not current ACTIVATED", () => {
    const ledger = emptyProviderActivationLedger(); // nothing activated
    const report = checkProviderRolloutPlan(planFixture(), ledger, MODES);
    expect(report.ok).toBe(false);
    expect(
      report.issues.filter((issue) =>
        issue.problem.includes("no CURRENT ACTIVATED ledger record"),
      ).length,
    ).toBe(3);
  });

  it("rejects a stale activation-record reference (superseded record)", () => {
    const ledger = buildLedger();
    const revoked = deactivateProvider(
      ledger,
      "stripe",
      {
        reason: "operator-initiated rollback rehearsal",
        evidencePath: "test",
        decidedAt: "2026-10-02T13:00:00Z",
        decidedBy: "tl-gate",
      },
      MODES,
    );
    const report = checkProviderRolloutPlan(planFixture(), revoked, MODES);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.field === "items[0].activationRecordId" &&
        issue.problem.includes("no CURRENT ACTIVATED ledger record"),
      ),
    ).toBe(true);
  });

  it("rejects certification evidence with failed pairs (not conclusive)", () => {
    const plan = planFixture();
    const broken: ProviderRolloutPlan = {
      ...plan,
      items: [
        {
          ...plan.items[0]!,
          certification: { ...CERTIFICATION_STRIPE, failed: 1 },
        },
        ...plan.items.slice(1),
      ],
    };
    const report = checkProviderRolloutPlan(broken, buildLedger(), MODES);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problem.includes("certification is not conclusive"),
      ),
    ).toBe(true);
  });

  it("rejects an empty rollout (at least one certified provider)", () => {
    const plan = planFixture();
    const empty: ProviderRolloutPlan = {
      ...plan,
      items: [],
      preview: { environment: "preview", providers: [] },
      production: { environment: "production", providers: [] },
    };
    const report = checkProviderRolloutPlan(empty, buildLedger(), MODES);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problem.includes("at least one certified provider"),
      ),
    ).toBe(true);
  });

  it("rejects a provider bound in one environment but missing from the plan", () => {
    const plan = planFixture();
    const drifted: ProviderRolloutPlan = {
      ...plan,
      production: {
        ...plan.production,
        providers: [
          ...plan.production.providers,
          {
            providerName: "rapyd",
            activationRecordId: "pa-rapyd-001",
            configKey: "PROVIDER_RAPYD_CREDENTIAL_REF",
            vaultReference: "vault://payswap/production/providers/rapyd",
          },
        ],
      },
    };
    const report = checkProviderRolloutPlan(drifted, buildLedger(), MODES);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problem.includes("rapyd' is bound in production but has no plan item"),
      ),
    ).toBe(true);
  });

  it("rejects secret-shaped values anywhere in the plan", () => {
    const plan = planFixture();
    const leaking: ProviderRolloutPlan = {
      ...plan,
      items: [
        {
          ...plan.items[0]!,
          limitations: [...plan.items[0]!.limitations, "key was sk_live_SYNTHETIC1234567890"],
        },
        ...plan.items.slice(1),
      ],
    };
    const report = checkProviderRolloutPlan(leaking, buildLedger(), MODES);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problem.includes("secret-shaped value in a rollout plan"),
      ),
    ).toBe(true);
  });

  it("rejects a value (not a vault reference) in a provider binding", () => {
    const plan = planFixture();
    const leaking: ProviderRolloutPlan = {
      ...plan,
      preview: {
        ...plan.preview,
        providers: plan.preview.providers.map((binding, index) =>
          index === 0
            ? { ...binding, vaultReference: "not-a-vault-reference" }
            : binding,
        ),
      },
    };
    const report = checkProviderRolloutPlan(leaking, buildLedger(), MODES);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problem.includes("must be a vault:// reference"),
      ),
    ).toBe(true);
  });

  it("rejects an ambiguous provider that is both item and non-connection", () => {
    const plan = planFixture();
    const ambiguous: ProviderRolloutPlan = {
      ...plan,
      nonConnections: [
        ...plan.nonConnections,
        { providerName: "stripe", status: "NOT_ACTIVATED", reason: "ambiguous duplicate" },
      ],
    };
    const report = checkProviderRolloutPlan(ambiguous, buildLedger(), MODES);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problem.includes("both a plan item and a non-connection"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------

describe("verifyProviderRolloutParity", () => {
  it("passes the mirrored provider sets (only vault references differ)", () => {
    const report = verifyProviderRolloutParity(
      providerSetFixture("preview"),
      providerSetFixture("production"),
    );
    expect(report.passed).toBe(true);
    expect(report.providersMissingInProduction).toEqual([]);
    expect(report.providersMissingInPreview).toEqual([]);
    expect(report.providerDiffs.every((diff) => diff.passed)).toBe(true);
    expect(report.digest).toMatch(/^fnv1a64:/);
  });

  it("fails when a provider is missing in production", () => {
    const preview = providerSetFixture("preview");
    const production: RolloutEnvironmentProviderSet = {
      environment: "production",
      providers: providerSetFixture("production").providers.slice(0, 2),
    };
    const report = verifyProviderRolloutParity(preview, production);
    expect(report.passed).toBe(false);
    expect(report.providersMissingInProduction).toEqual(["flutterwave"]);
  });

  it("fails on activation-record drift between environments", () => {
    const production = providerSetFixture("production");
    const drifted: RolloutEnvironmentProviderSet = {
      ...production,
      providers: production.providers.map((binding, index) =>
        index === 0
          ? { ...binding, activationRecordId: "pa-stripe-002" }
          : binding,
      ),
    };
    const report = verifyProviderRolloutParity(
      providerSetFixture("preview"),
      drifted,
    );
    expect(report.passed).toBe(false);
    expect(report.providerDiffs[0]?.activationRecordIdDrift).toBe(true);
  });

  it("the vault-reference difference is the ONLY allowed difference (explicit allowlist)", () => {
    expect(PROVIDER_ROLLOUT_PARITY_ALLOWED_DIFFERENCES).toEqual([
      "credential.vaultReference",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Execution — reproducibility
// ---------------------------------------------------------------------------

describe("executeProviderRolloutPlan", () => {
  it("produces a valid release record naming the connected providers with evidence", () => {
    const record = executeProviderRolloutPlan(
      planFixture(),
      buildLedger(),
      BROWSER_EVIDENCE,
      MODES,
    );
    expect(record.record_type).toBe(PROVIDER_ROLLOUT_RELEASE_RECORD_TYPE);
    expect(record.schema_version).toBe(PROVIDER_ROLLOUT_SCHEMA_VERSION);
    expect(record.workOrder).toBe("P2-W3-003");
    expect(record.connectedProviders.map((p) => p.providerName)).toEqual([
      "stripe",
      "paystack",
      "flutterwave",
    ]);
    for (const provider of record.connectedProviders) {
      expect(provider.connectedInstanceId).toMatch(/^cci-/);
      expect(provider.certification.failed).toBe(0);
      expect(provider.vaultReferences.preview).toMatch(/^vault:\/\//);
      expect(provider.vaultReferences.production).toMatch(/^vault:\/\//);
      expect(provider.vaultReferences.preview).not.toBe(
        provider.vaultReferences.production,
      );
    }
    expect(record.parity.passed).toBe(true);
    expect(record.enablement.every((e) => e.enabled)).toBe(true);
    expect(record.rollback.steps).toEqual(PROVIDER_ROLLOUT_ROLLBACK_STEPS);
    expect(record.digest).toMatch(/^fnv1a64:/);
    expect(
      checkProviderRolloutReleaseRecord(record).ok,
    ).toBe(true);
  });

  it("is REPRODUCIBLE: the same inputs produce a byte-identical record", () => {
    const first = executeProviderRolloutPlan(
      planFixture(),
      buildLedger(),
      BROWSER_EVIDENCE,
      MODES,
    );
    const second = executeProviderRolloutPlan(
      planFixture(),
      buildLedger(),
      BROWSER_EVIDENCE,
      MODES,
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.digest).toBe(first.digest);
  });

  it("refuses to roll out when the browser verification did not pass", () => {
    expect(() =>
      executeProviderRolloutPlan(
        planFixture(),
        buildLedger(),
        { ...BROWSER_EVIDENCE, passed: false },
        MODES,
      ),
    ).toThrow(ProviderRolloutError);
    expect(() =>
      executeProviderRolloutPlan(
        planFixture(),
        buildLedger(),
        { ...BROWSER_EVIDENCE, passed: false },
        MODES,
      ),
    ).toThrow(/did not pass/);
  });

  it("refuses to roll out over a plan that fails the checker", () => {
    expect(() =>
      executeProviderRolloutPlan(
        { planId: "broken" },
        buildLedger(),
        BROWSER_EVIDENCE,
        MODES,
      ),
    ).toThrow(ProviderRolloutError);
  });

  it("carries the honest non-connections (BLOCKED + NO_CREDENTIAL_HELD)", () => {
    const record = executeProviderRolloutPlan(
      planFixture(),
      buildLedger(),
      BROWSER_EVIDENCE,
      MODES,
    );
    expect(record.nonConnections.map((n) => n.providerName)).toEqual([
      "mtn_momo",
      "paypal-direct",
    ]);
    expect(record.nonConnections[0]?.status).toBe("BLOCKED");
    expect(record.nonConnections[1]?.status).toBe("NO_CREDENTIAL_HELD");
  });
});

// ---------------------------------------------------------------------------
// Release-record checking (durable artifact)
// ---------------------------------------------------------------------------

describe("checkProviderRolloutReleaseRecord", () => {
  it("accepts the executed record and survives a JSON round-trip", () => {
    const record = executeProviderRolloutPlan(
      planFixture(),
      buildLedger(),
      BROWSER_EVIDENCE,
      MODES,
    );
    const roundTripped = JSON.parse(JSON.stringify(record));
    expect(checkProviderRolloutReleaseRecord(roundTripped).ok).toBe(true);
  });

  it("detects digest tampering (body changed after digesting)", () => {
    const record = executeProviderRolloutPlan(
      planFixture(),
      buildLedger(),
      BROWSER_EVIDENCE,
      MODES,
    );
    const tampered = {
      ...JSON.parse(JSON.stringify(record)),
      connectedProviders: (
        JSON.parse(JSON.stringify(record)) as {
          connectedProviders: { providerName: string }[];
        }
      ).connectedProviders.map((p) =>
        p.providerName === "stripe" ? { ...p, providerName: "stripe-eu" } : p,
      ),
    };
    const report = checkProviderRolloutReleaseRecord(tampered);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problem.includes("digest mismatch"),
      ),
    ).toBe(true);
  });

  it("rejects a record with zero connected providers", () => {
    const report = checkProviderRolloutReleaseRecord({
      record_type: PROVIDER_ROLLOUT_RELEASE_RECORD_TYPE,
      schema_version: PROVIDER_ROLLOUT_SCHEMA_VERSION,
      workOrder: "P2-W3-003",
      releaseId: "empty",
      connectedProviders: [],
      parity: { passed: true },
      browserVerification: { passed: true },
      rollback: { steps: PROVIDER_ROLLOUT_ROLLBACK_STEPS, reactivationRequiresFreshEvidence: true },
      digest: "fnv1a64:x",
    });
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problem.includes("names at least one connected provider"),
      ),
    ).toBe(true);
  });

  it("rejects a secret-shaped value in a connected-provider entry", () => {
    const record = executeProviderRolloutPlan(
      planFixture(),
      buildLedger(),
      BROWSER_EVIDENCE,
      MODES,
    );
    const leaking = JSON.parse(JSON.stringify(record));
    leaking.connectedProviders[0].limitations.push(
      "rotated to whsec_SYNTHETIC12345678",
    );
    leaking.digest = record.digest; // keep digest so only the secret scan fires
    const report = checkProviderRolloutReleaseRecord(leaking);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problem.includes("secret-shaped value in a release record"),
      ),
    ).toBe(true);
  });

  it("rejects a wrong rollback step list", () => {
    const record = executeProviderRolloutPlan(
      planFixture(),
      buildLedger(),
      BROWSER_EVIDENCE,
      MODES,
    );
    const mutated = JSON.parse(JSON.stringify(record));
    mutated.rollback.steps = ["REVOCATION_RECORD_APPEND"];
    const report = checkProviderRolloutReleaseRecord(mutated);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) =>
        issue.problem.includes("five canonical rollback steps"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rollback / deactivation / re-activation
// ---------------------------------------------------------------------------

describe("deactivateProvider / reactivateProvider", () => {
  it("appends a REVOKED record superseding the ACTIVATED one (history immutable)", () => {
    const ledger = buildLedger();
    const rolled = deactivateProvider(
      ledger,
      "stripe",
      {
        reason: "provider incident — controlled rollback",
        evidencePath: "spec/development-state/incidents.md",
        decidedAt: "2026-10-02T14:00:00Z",
        decidedBy: "operator-console",
      },
      MODES,
    );
    // the ORIGINAL ledger is untouched (functional append-only)
    expect(ledger.records.length).toBe(3);
    expect(rolled.records.length).toBe(4);
    const revoked = rolled.records[3];
    expect(revoked?.status).toBe("REVOKED");
    expect(revoked?.supersedes).toBe("pa-stripe-001");
    expect(revoked?.connectedInstanceId).toBeUndefined();
    expect(revoked?.limitations.some((l) => l.startsWith("deactivated:"))).toBe(
      true,
    );
  });

  it("flips enablement to NOT ENABLED after the revocation", () => {
    const rolled = deactivateProvider(
      buildLedger(),
      "stripe",
      {
        reason: "provider incident",
        evidencePath: "test",
        decidedAt: "2026-10-02T14:00:00Z",
        decidedBy: "operator-console",
      },
      MODES,
    );
    const stripe = resolveProviderEnablement(rolled).find(
      (e) => e.providerName === "stripe",
    );
    expect(stripe?.enabled).toBe(false);
    expect(stripe?.reason).toContain("REVOKED");
  });

  it("refuses to deactivate a provider with no current ACTIVATED record", () => {
    expect(() =>
      deactivateProvider(
        emptyProviderActivationLedger(),
        "stripe",
        {
          reason: "nothing to roll back",
          evidencePath: "test",
          decidedAt: "2026-10-02T14:00:00Z",
          decidedBy: "operator-console",
        },
        MODES,
      ),
    ).toThrow(ProviderRolloutError);
    expect(() =>
      deactivateProvider(
        emptyProviderActivationLedger(),
        "stripe",
        {
          reason: "nothing to roll back",
          evidencePath: "test",
          decidedAt: "2026-10-02T14:00:00Z",
          decidedBy: "operator-console",
        },
        MODES,
      ),
    ).toThrow(/no current ACTIVATED record to deactivate/);
  });

  it("re-activates with FRESH evidence and a fresh connected instance", () => {
    const rolled = deactivateProvider(
      buildLedger(),
      "stripe",
      {
        reason: "provider incident",
        evidencePath: "test",
        decidedAt: "2026-10-02T14:00:00Z",
        decidedBy: "operator-console",
      },
      MODES,
    );
    const reactivated = reactivateProvider(
      rolled,
      {
        providerName: "stripe",
        freshProbeEvidence: {
          evidencePath: "spec/development-state/provider-probes-20261002.json",
          probedAt: "2026-10-02T15:00:00Z",
          verdict: "VERIFIED",
          summary: "post-incident re-verification probe: authentication VERIFIED",
        },
        connectedInstanceId: "cci-stripe-002",
        recordedAt: "2026-10-02T15:05:00Z",
        recordedBy: "tl-gate",
        limitations: ["test-mode credentials", "re-activated after rollback"],
      },
      MODES,
    );
    expect(reactivated.records.length).toBe(5);
    const activated = reactivated.records[4];
    expect(activated?.status).toBe("ACTIVATED");
    expect(activated?.connectedInstanceId).toBe("cci-stripe-002");
    expect(activated?.supersedes).toBe("rollback:stripe:2026-10-02T14:00:00Z");
    const stripe = resolveProviderEnablement(reactivated).find(
      (e) => e.providerName === "stripe",
    );
    expect(stripe?.enabled).toBe(true);
  });

  it("REFUSES re-activation on stale (pre-revocation) probe evidence", () => {
    const rolled = deactivateProvider(
      buildLedger(),
      "stripe",
      {
        reason: "provider incident",
        evidencePath: "test",
        decidedAt: "2026-10-02T14:00:00Z",
        decidedBy: "operator-console",
      },
      MODES,
    );
    expect(() =>
      reactivateProvider(
        rolled,
        {
          providerName: "stripe",
          freshProbeEvidence: {
            ...PROBE_EVIDENCE_STRIPE,
            probedAt: "2026-10-02T06:37:38Z", // BEFORE the revocation
          },
          connectedInstanceId: "cci-stripe-002",
          recordedAt: "2026-10-02T15:05:00Z",
          recordedBy: "tl-gate",
          limitations: [],
        },
        MODES,
      ),
    ).toThrow(/FRESH probe evidence/);
  });

  it("refuses re-activation when there is no current REVOKED record", () => {
    expect(() =>
      reactivateProvider(
        buildLedger(),
        {
          providerName: "stripe",
          freshProbeEvidence: PROBE_EVIDENCE_STRIPE,
          connectedInstanceId: "cci-stripe-002",
          recordedAt: "2026-10-02T15:05:00Z",
          recordedBy: "tl-gate",
          limitations: [],
        },
        MODES,
      ),
    ).toThrow(/no current REVOKED record/);
  });
});

// ---------------------------------------------------------------------------
// The rollback rehearsal (the tested rollback/deactivation path)
// ---------------------------------------------------------------------------

describe("rehearseProviderRollback", () => {
  it("drills deactivate -> disabled -> re-activate -> enabled without touching the original ledger", () => {
    const ledger = buildLedger();
    const report = rehearseProviderRollback(
      ledger,
      ["stripe", "paystack"],
      {
        reason: "rollout rollback rehearsal (P2-W3-003 acceptance)",
        evidencePath: "packages/operations/test/provider-rollout.test.ts",
        decidedAt: "2026-10-02T16:00:00Z",
        decidedBy: "tl-gate",
      },
      [
        {
          providerName: "stripe",
          freshProbeEvidence: {
            evidencePath: "spec/development-state/provider-probes-20261002.json",
            probedAt: "2026-10-02T16:30:00Z",
            verdict: "VERIFIED",
            summary: "rehearsal re-verification probe",
          },
          connectedInstanceId: "cci-stripe-rehearsal",
          recordedAt: "2026-10-02T16:35:00Z",
          recordedBy: "tl-gate",
          limitations: [],
        },
      ],
      MODES,
    );
    expect(report.allSatisfied).toBe(true);
    expect(report.steps.length).toBeGreaterThan(0);
    expect(report.steps.every((step) => step.outcome === "SATISFIED")).toBe(true);
    expect(report.originalLedgerUntouched).toBe(true);
    // the production ledger this rehearsal derived from is unchanged
    expect(ledger.records.length).toBe(3);
    expect(report.digest).toMatch(/^fnv1a64:/);
  });

  it("records FAILED steps honestly when the re-activation evidence is stale", () => {
    const report = rehearseProviderRollback(
      buildLedger(),
      ["stripe"],
      {
        reason: "rehearsal",
        evidencePath: "test",
        decidedAt: "2026-10-02T16:00:00Z",
        decidedBy: "tl-gate",
      },
      [
        {
          providerName: "stripe",
          freshProbeEvidence: {
            ...PROBE_EVIDENCE_STRIPE,
            probedAt: "2026-10-02T06:37:38Z", // stale: before the revocation
          },
          connectedInstanceId: "cci-stripe-rehearsal",
          recordedAt: "2026-10-02T16:35:00Z",
          recordedBy: "tl-gate",
          limitations: [],
        },
      ],
      MODES,
    );
    expect(report.allSatisfied).toBe(false);
    expect(
      report.steps.some(
        (step) =>
          step.step === "RE_ACTIVATION_WITH_FRESH_EVIDENCE" &&
          step.outcome === "FAILED",
      ),
    ).toBe(true);
  });

  it("covers every canonical rollback step in the satisfied drill", () => {
    const report = rehearseProviderRollback(
      buildLedger(),
      ["stripe"],
      {
        reason: "rehearsal",
        evidencePath: "test",
        decidedAt: "2026-10-02T16:00:00Z",
        decidedBy: "tl-gate",
      },
      [
        {
          providerName: "stripe",
          freshProbeEvidence: {
            evidencePath: "spec/development-state/provider-probes-20261002.json",
            probedAt: "2026-10-02T16:30:00Z",
            verdict: "VERIFIED",
            summary: "rehearsal re-verification probe",
          },
          connectedInstanceId: "cci-stripe-rehearsal",
          recordedAt: "2026-10-02T16:35:00Z",
          recordedBy: "tl-gate",
          limitations: [],
        },
      ],
      MODES,
    );
    for (const step of PROVIDER_ROLLOUT_ROLLBACK_STEPS) {
      expect(
        report.steps.some((drilled) => drilled.step === step),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Binding to the REAL P2-W2-003 certification evidence
// ---------------------------------------------------------------------------

describe("release record binds to the real cross-provider conformance evidence", () => {
  it(
    "the certification evidence refs match the ACTUAL conformance report the battery runs",
    { timeout: 120_000 },
    async () => {
      const report = await runCrossProviderConformance();
      expect(report.allPassed).toBe(true);
      for (const provider of report.providers) {
        expect(provider.failed).toBe(0);
      }
      // the plan's certification refs mirror the real matrix numbers
      const stripeRow = report.providers.find(
        (p) => p.providerName === "stripe",
      );
      expect(stripeRow).toBeDefined();
      const plan = planFixture();
      expect(plan.items[0]!.certification.certificationId).toBe(
        report.certificationId,
      );
      expect(plan.items[0]!.certification.failed).toBe(stripeRow?.failed ?? -1);
      expect(plan.items[0]!.certification.notApplicable).toBe(
        stripeRow?.notApplicable ?? -1,
      );
      expect(plan.items[0]!.certification.executed).toBe(
        stripeRow?.executed ?? -1,
      );
    },
  );
});
