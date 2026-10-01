import { describe, expect, it } from "vitest";
import { recordProductionFacts, runReplay } from "@payswap/lab";
import type { SimulationProgram } from "@payswap/lab";
import {
  declareFault,
  expectedBehaviorForFault,
  runReplayFaultSuite,
  verifyDeterministicReRun,
  verifyFaultContract,
} from "@payswap/certification";
import type { StructuralReplayResult } from "@payswap/certification";

/**
 * Replay/fault test contracts (W2-006 acceptance: fault-injection
 * declarations — provider outage → UNKNOWN, webhook loss → reconciliation
 * recovery, epoch bump → re-authorization; deterministic re-runs). The REAL
 * replay machinery produces the replay results flowing through the
 * contracts (structural consumption).
 */

const PROGRAM: SimulationProgram = {
  programId: "replay.certification",
  programVersion: "1.0.0",
  routePreference: ["rail-a", "rail-b"],
  useNetting: false,
  useNetworkCredit: false,
  delayToleranceSteps: 0,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
};

function factsWithDelayedWrite(): ReturnType<typeof recordProductionFacts> {
  return recordProductionFacts({
    factsId: "facts-fault-delayed-write",
    description: "observed production demand with an ambiguous external write",
    rails: [
      {
        railId: "rail-a",
        currency: "EUR",
        latencyMs: 400,
        fixedFeeMinor: 25n,
        variableFeeBps: 10n,
      },
      {
        railId: "rail-b",
        currency: "EUR",
        latencyMs: 350,
        fixedFeeMinor: 40n,
        variableFeeBps: 8n,
      },
    ],
    pools: [
      { poolId: "pool-a", railId: "rail-a", availableMinor: 1_000_000n },
      { poolId: "pool-b", railId: "rail-b", availableMinor: 1_000_000n },
    ],
    stepLatencyMs: 250,
    demands: [
      {
        demandId: "prod-demand-1",
        observedAtMs: 0,
        amountMinor: 120_000n,
        currency: "EUR",
        direction: "OUTBOUND",
        deadlineMs: 30_000,
      },
    ],
    incidents: [
      {
        incidentType: "DELAYED_WRITE",
        atStep: 0,
        railId: "rail-a",
        observedAtMs: 0,
      },
    ],
  });
}

function cleanFacts(): ReturnType<typeof recordProductionFacts> {
  return recordProductionFacts({
    factsId: "facts-clean",
    rails: [
      {
        railId: "rail-a",
        currency: "EUR",
        latencyMs: 400,
        fixedFeeMinor: 25n,
        variableFeeBps: 10n,
      },
    ],
    pools: [{ poolId: "pool-a", railId: "rail-a", availableMinor: 1_000_000n }],
    stepLatencyMs: 250,
    demands: [
      {
        demandId: "prod-demand-1",
        observedAtMs: 0,
        amountMinor: 120_000n,
        currency: "EUR",
        direction: "OUTBOUND",
        deadlineMs: 30_000,
      },
    ],
    incidents: [],
  });
}

describe("fault-injection declarations", () => {
  it("declares the canonical fault→expected-behavior mapping", () => {
    const outage = expectedBehaviorForFault("PROVIDER_OUTAGE");
    expect(outage.requiredOutcome).toBe("UNKNOWN_REQUIRES_RECONCILIATION");
    expect(outage.requiredInvariants).toContain("INV-X01");

    const webhook = expectedBehaviorForFault("WEBHOOK_LOSS");
    expect(webhook.requiredOutcome).toBe("RECONCILIATION_RECOVERY");
    expect(webhook.requiredInvariants).toContain("INV-X03");

    const epoch = expectedBehaviorForFault("SECURITY_EPOCH_BUMP");
    expect(epoch.requiredOutcome).toBe("RE_AUTHORIZATION_REQUIRED");
    expect(epoch.requiredInvariants).toContain("INV-S02");
  });

  it("validates declaration shape deterministically", () => {
    const fault = declareFault({
      faultId: "fault-outage-1",
      faultKind: "PROVIDER_OUTAGE",
      targetKind: "connected_instance",
      targetId: "inst:acct-1-payments",
      atStep: 3,
    });
    expect(fault.target).toEqual({ kind: "connected_instance", id: "inst:acct-1-payments" });
    expect(() =>
      declareFault({
        faultId: "",
        faultKind: "PROVIDER_OUTAGE",
        targetKind: "connected_instance",
        targetId: "inst",
        atStep: 0,
      }),
    ).toThrow(/faultId/);
    expect(() =>
      declareFault({
        faultId: "fault-bad",
        faultKind: "MAGIC_UNICORN" as "PROVIDER_OUTAGE",
        targetKind: "connected_instance",
        targetId: "inst",
        atStep: 0,
      }),
    ).toThrow(/unknown fault kind/);
  });
});

describe("fault contracts over REAL replay results", () => {
  it("PROVIDER_OUTAGE → UNKNOWN: an ambiguous external write surfaces as UNKNOWN (INV-X01)", () => {
    const replay = runReplay({
      facts: factsWithDelayedWrite(),
      program: PROGRAM,
      seed: "seed-1",
      stepMs: 250,
    });
    // The REAL replay result flows through the structural view unchanged.
    const structural: StructuralReplayResult = replay;
    expect(
      structural.run.outcomes.some(
        (record) => record.outcome === "UNKNOWN_REQUIRES_RECONCILIATION",
      ),
    ).toBe(true);

    const fault = declareFault({
      faultId: "fault-outage-1",
      faultKind: "PROVIDER_OUTAGE",
      targetKind: "connected_instance",
      targetId: "inst:acct-1-payments",
      atStep: 0,
    });
    const verdict = verifyFaultContract({ fault, replay });
    expect(verdict.passed).toBe(true);
    expect(verdict.violations).toEqual([]);

    // A clean replay (no ambiguity) does NOT satisfy the outage contract:
    // the fault must actually be exercised.
    const cleanVerdict = verifyFaultContract({
      fault,
      replay: runReplay({ facts: cleanFacts(), program: PROGRAM, seed: "seed-1", stepMs: 250 }),
    });
    expect(cleanVerdict.passed).toBe(false);
    expect(cleanVerdict.violations.join(" ")).toContain("INV-X01");
  });

  it("WEBHOOK_LOSS → reconciliation recovery (INV-X03)", () => {
    const replay = runReplay({
      facts: factsWithDelayedWrite(),
      program: PROGRAM,
      seed: "seed-1",
      stepMs: 250,
    });
    const fault = declareFault({
      faultId: "fault-webhook-1",
      faultKind: "WEBHOOK_LOSS",
      targetKind: "connected_instance",
      targetId: "inst:acct-1-payments",
      atStep: 0,
    });

    const recovered = verifyFaultContract({
      fault,
      replay,
      reconciliation: { ambiguousEffects: 1, recoveredWithEvidence: 1 },
    });
    expect(recovered.passed).toBe(true);

    const notRecovered = verifyFaultContract({
      fault,
      replay,
      reconciliation: { ambiguousEffects: 1, recoveredWithEvidence: 0 },
    });
    expect(notRecovered.passed).toBe(false);
    expect(notRecovered.violations.join(" ")).toContain("INV-X03");

    const missingObservation = verifyFaultContract({ fault, replay });
    expect(missingObservation.passed).toBe(false);
    expect(missingObservation.violations.join(" ")).toContain("reconciliation observation");
  });

  it("SECURITY_EPOCH_BUMP → re-authorization (INV-S02/A02)", () => {
    const replay = runReplay({
      facts: cleanFacts(),
      program: PROGRAM,
      seed: "seed-1",
      stepMs: 250,
    });
    const fault = declareFault({
      faultId: "fault-epoch-1",
      faultKind: "SECURITY_EPOCH_BUMP",
      targetKind: "agent_key",
      targetId: "agent-key-1",
      atStep: 2,
    });

    const reAuthorized = verifyFaultContract({
      fault,
      replay,
      epochBump: { issuedAtEpoch: 0n, currentEpoch: 1n, reAuthorizedActions: 1 },
    });
    expect(reAuthorized.passed).toBe(true);

    const noReAuthorization = verifyFaultContract({
      fault,
      replay,
      epochBump: { issuedAtEpoch: 0n, currentEpoch: 1n, reAuthorizedActions: 0 },
    });
    expect(noReAuthorization.passed).toBe(false);
    expect(noReAuthorization.violations.join(" ")).toContain("re-authorized");

    const notAdvanced = verifyFaultContract({
      fault,
      replay,
      epochBump: { issuedAtEpoch: 1n, currentEpoch: 1n, reAuthorizedActions: 1 },
    });
    expect(notAdvanced.passed).toBe(false);
    expect(notAdvanced.violations.join(" ")).toContain("advanced");
  });

  it("the suite runner aggregates verdicts deterministically", () => {
    const replay = runReplay({
      facts: factsWithDelayedWrite(),
      program: PROGRAM,
      seed: "seed-1",
      stepMs: 250,
    });
    const suiteResult = runReplayFaultSuite({
      suiteId: "fault-suite-1",
      cases: [
        {
          caseId: "case-1",
          fault: declareFault({
            faultId: "fault-outage-1",
            faultKind: "PROVIDER_OUTAGE",
            targetKind: "connected_instance",
            targetId: "inst:acct-1-payments",
            atStep: 0,
          }),
          replay,
        },
        {
          caseId: "case-2",
          fault: declareFault({
            faultId: "fault-webhook-1",
            faultKind: "WEBHOOK_LOSS",
            targetKind: "connected_instance",
            targetId: "inst:acct-1-payments",
            atStep: 0,
          }),
          replay,
          reconciliation: { ambiguousEffects: 1, recoveredWithEvidence: 1 },
        },
      ],
    });
    expect(suiteResult.passed).toBe(true);
    expect(suiteResult.cases).toHaveLength(2);

    const rerun = runReplayFaultSuite({
      suiteId: "fault-suite-1",
      cases: [
        {
          caseId: "case-1",
          fault: declareFault({
            faultId: "fault-outage-1",
            faultKind: "PROVIDER_OUTAGE",
            targetKind: "connected_instance",
            targetId: "inst:acct-1-payments",
            atStep: 0,
          }),
          replay,
        },
        {
          caseId: "case-2",
          fault: declareFault({
            faultId: "fault-webhook-1",
            faultKind: "WEBHOOK_LOSS",
            targetKind: "connected_instance",
            targetId: "inst:acct-1-payments",
            atStep: 0,
          }),
          replay,
          reconciliation: { ambiguousEffects: 1, recoveredWithEvidence: 1 },
        },
      ],
    });
    expect(rerun.suiteDigest).toBe(suiteResult.suiteDigest);
    expect(() =>
      runReplayFaultSuite({ suiteId: "", cases: [] }),
    ).toThrow();
  });
});

describe("deterministic re-runs (INV-P03 discipline)", () => {
  it("the same facts, program and seed replay to identical digests", () => {
    const facts = factsWithDelayedWrite();
    const first = runReplay({ facts, program: PROGRAM, seed: "seed-1", stepMs: 250 });
    const second = runReplay({ facts, program: PROGRAM, seed: "seed-1", stepMs: 250 });
    const check = verifyDeterministicReRun(first, second);
    expect(check.deterministic).toBe(true);
    if (check.deterministic) {
      expect(check.digest).toBe(first.digest);
    }
  });

  it("a different seed is a reproducibility violation for the same facts", () => {
    const facts = factsWithDelayedWrite();
    const first = runReplay({ facts, program: PROGRAM, seed: "seed-1", stepMs: 250 });
    const second = runReplay({ facts, program: PROGRAM, seed: "seed-2", stepMs: 250 });
    const check = verifyDeterministicReRun(first, second);
    expect(check.deterministic).toBe(false);
    if (!check.deterministic) {
      expect(check.reason).toContain("different replay digests");
    }
  });

  it("different fact sets are rejected outright", () => {
    const first = runReplay({
      facts: factsWithDelayedWrite(),
      program: PROGRAM,
      seed: "seed-1",
      stepMs: 250,
    });
    const second = runReplay({
      facts: cleanFacts(),
      program: PROGRAM,
      seed: "seed-1",
      stepMs: 250,
    });
    const check = verifyDeterministicReRun(first, second);
    expect(check.deterministic).toBe(false);
    if (!check.deterministic) {
      expect(check.reason).toContain("different fact sets");
    }
  });
});
