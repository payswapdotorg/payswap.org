import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAMILY_SEVERITY_VERDICTS,
  InvalidThreatPolicyError,
  THREAT_FAMILIES,
  THREAT_SEVERITIES,
  VERDICT_RANK,
  evaluateThreatPolicy,
  isThreatVerdict,
  orderThreatSignals,
  stricterVerdict,
  validateThreatPolicy,
} from "../src/index.js";
import type { ThreatSignal } from "../src/index.js";
import { buildThreatSignal } from "../src/index.js";
import { baseThreatPolicy } from "./helpers.js";

function signal(input: {
  family: (typeof THREAT_FAMILIES)[number];
  severity: (typeof THREAT_SEVERITIES)[number];
  confidenceBps?: number;
}): ThreatSignal {
  return buildThreatSignal({
    family: input.family,
    code: "test_code",
    severity: input.severity,
    method: "threshold_breach",
    confidenceBps: input.confidenceBps ?? 9_000,
    evidence: {
      observationRefs: ["obs:1"],
      digestRefs: ["write:fnv1a64:test"],
      note: "test signal",
    },
    summary: "test signal",
  });
}

describe("the default severity→verdict table", () => {
  it("covers every family × severity cell (no gaps, no guessing)", () => {
    for (const family of THREAT_FAMILIES) {
      for (const severity of THREAT_SEVERITIES) {
        const verdict = DEFAULT_FAMILY_SEVERITY_VERDICTS[family][severity];
        expect(isThreatVerdict(verdict)).toBe(true);
      }
    }
  });

  it("no family ever BLOCKs on info severity alone", () => {
    for (const family of THREAT_FAMILIES) {
      expect(DEFAULT_FAMILY_SEVERITY_VERDICTS[family].info).not.toBe("BLOCK");
    }
  });

  it("value-loss families BLOCK at high/critical", () => {
    expect(DEFAULT_FAMILY_SEVERITY_VERDICTS.malicious_approval_permit.high).toBe("BLOCK");
    expect(DEFAULT_FAMILY_SEVERITY_VERDICTS.token_impersonation.high).toBe("BLOCK");
    expect(DEFAULT_FAMILY_SEVERITY_VERDICTS.destination_chain_confusion.high).toBe("BLOCK");
    expect(DEFAULT_FAMILY_SEVERITY_VERDICTS.honeypot_transfer_restriction.high).toBe("BLOCK");
  });

  it("exposure families REQUIRE_CONFIRMATION at high, BLOCK at critical", () => {
    expect(DEFAULT_FAMILY_SEVERITY_VERDICTS.mev_sandwich_exposure.high).toBe(
      "REQUIRE_CONFIRMATION",
    );
    expect(DEFAULT_FAMILY_SEVERITY_VERDICTS.mev_sandwich_exposure.critical).toBe("BLOCK");
    expect(DEFAULT_FAMILY_SEVERITY_VERDICTS.finality_reorg_anomaly.high).toBe(
      "REQUIRE_CONFIRMATION",
    );
  });
});

describe("verdict vocabulary", () => {
  it("the four-value vocabulary is exactly the task packet's", () => {
    expect(VERDICT_RANK).toEqual({
      ALLOW: 0,
      ALLOW_WITH_CONSTRAINTS: 1,
      REQUIRE_CONFIRMATION: 2,
      BLOCK: 3,
    });
  });

  it("stricterVerdict is the lattice join", () => {
    expect(stricterVerdict("ALLOW", "BLOCK")).toBe("BLOCK");
    expect(stricterVerdict("BLOCK", "ALLOW")).toBe("BLOCK");
    expect(stricterVerdict("ALLOW", "ALLOW_WITH_CONSTRAINTS")).toBe(
      "ALLOW_WITH_CONSTRAINTS",
    );
    expect(stricterVerdict("REQUIRE_CONFIRMATION", "ALLOW_WITH_CONSTRAINTS")).toBe(
      "REQUIRE_CONFIRMATION",
    );
  });
});

describe("policy validation (fail closed)", () => {
  it("accepts the canonical base policy", () => {
    expect(() => validateThreatPolicy(baseThreatPolicy())).not.toThrow();
  });

  it("rejects malformed fields", () => {
    expect(() =>
      validateThreatPolicy(baseThreatPolicy({ policyId: "" })),
    ).toThrow(InvalidThreatPolicyError);
    expect(() =>
      validateThreatPolicy(baseThreatPolicy({ version: 0 })),
    ).toThrow(InvalidThreatPolicyError);
    expect(() =>
      validateThreatPolicy(baseThreatPolicy({ maxSlippageBasisPoints: -1 })),
    ).toThrow(InvalidThreatPolicyError);
    expect(() =>
      validateThreatPolicy(baseThreatPolicy({ maxSlippageBasisPoints: 10_001 })),
    ).toThrow(InvalidThreatPolicyError);
    expect(() =>
      validateThreatPolicy(baseThreatPolicy({ expectedChain: "not a chain" })),
    ).toThrow(InvalidThreatPolicyError);
    expect(() =>
      validateThreatPolicy(
        baseThreatPolicy({ minBridgeAttestationQuorum: "1/0" }),
      ),
    ).toThrow(InvalidThreatPolicyError);
    expect(() =>
      validateThreatPolicy(
        baseThreatPolicy({
          familyVerdicts: {
            // @ts-expect-error deliberately malformed verdict
            oracle_manipulation: { high: "MAYBE" },
          },
        }),
      ),
    ).toThrow(InvalidThreatPolicyError);
    expect(() =>
      validateThreatPolicy(
        baseThreatPolicy({
          confidenceFloors: {
            oracle_manipulation: { floor: -5, below: "REQUIRE_CONFIRMATION" },
          },
        }),
      ),
    ).toThrow(InvalidThreatPolicyError);
    expect(() =>
      validateThreatPolicy(baseThreatPolicy({ retireCompromisedContracts: "yes" as never })),
    ).toThrow(InvalidThreatPolicyError);
  });
});

describe("evaluateThreatPolicy (deterministic + authoritative)", () => {
  it("an empty signal set is ALLOW", () => {
    const evaluation = evaluateThreatPolicy([], baseThreatPolicy());
    expect(evaluation.verdict).toBe("ALLOW");
    expect(evaluation.drivingSignals).toEqual([]);
    expect(evaluation.policyRef).toBe("threat-policy-1@1");
  });

  it("takes the most restrictive per-signal verdict (severity ordered)", () => {
    const evaluation = evaluateThreatPolicy(
      [
        signal({ family: "mev_sandwich_exposure", severity: "medium" }),
        signal({ family: "malicious_approval_permit", severity: "critical" }),
      ],
      baseThreatPolicy(),
    );
    expect(evaluation.verdict).toBe("BLOCK");
    expect(evaluation.drivingSignals[0]!.severity).toBe("critical");
    expect(evaluation.basis.length).toBeGreaterThan(0);
  });

  it("weak-evidence signals are capped by confidence floors (never silent BLOCK, never silent ALLOW)", () => {
    // registry_absence-based impersonation signal at 4000 bps with a floor
    // at 6000: the table says high→BLOCK, but the floor caps it at
    // REQUIRE_CONFIRMATION.
    const evaluation = evaluateThreatPolicy(
      [
        signal({
          family: "token_impersonation",
          severity: "high",
          confidenceBps: 4_000,
        }),
      ],
      baseThreatPolicy({
        confidenceFloors: {
          token_impersonation: { floor: 6_000, below: "REQUIRE_CONFIRMATION" },
        },
      }),
    );
    expect(evaluation.verdict).toBe("REQUIRE_CONFIRMATION");
    expect(evaluation.basis[0]!).toContain("confidence_capped");
  });

  it("familyVerdicts override the default table per family (whole map)", () => {
    const evaluation = evaluateThreatPolicy(
      [signal({ family: "mev_sandwich_exposure", severity: "critical" })],
      baseThreatPolicy({
        familyVerdicts: {
          mev_sandwich_exposure: {
            info: "ALLOW",
            low: "ALLOW",
            medium: "ALLOW_WITH_CONSTRAINTS",
            high: "REQUIRE_CONFIRMATION",
            critical: "ALLOW_WITH_CONSTRAINTS",
          },
        },
      }),
    );
    expect(evaluation.verdict).toBe("ALLOW_WITH_CONSTRAINTS");
  });

  it("deterministic ordering: severity desc, then family, then code", () => {
    const ordered = orderThreatSignals([
      signal({ family: "unexpected_spender", severity: "medium" }),
      signal({ family: "oracle_manipulation", severity: "critical" }),
      signal({ family: "bridge_compromise", severity: "critical" }),
      signal({ family: "malicious_approval_permit", severity: "high" }),
    ]);
    expect(ordered.map((s) => `${s.family}:${s.severity}`)).toEqual([
      "bridge_compromise:critical",
      "oracle_manipulation:critical",
      "malicious_approval_permit:high",
      "unexpected_spender:medium",
    ]);
  });

  it("same inputs → same evaluation (determinism)", () => {
    const signals = [
      signal({ family: "bridge_compromise", severity: "high" }),
      signal({ family: "oracle_manipulation", severity: "medium" }),
    ];
    const first = evaluateThreatPolicy(signals, baseThreatPolicy());
    const second = evaluateThreatPolicy(signals, baseThreatPolicy());
    expect(first).toEqual(second);
  });
});
