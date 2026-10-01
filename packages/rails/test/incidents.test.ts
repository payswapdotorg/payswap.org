import { describe, expect, it } from "vitest";
import {
  SettlementAttemptLedger,
  SettlementReconciliationAuthority,
  asSettlementAttemptId,
} from "@payswap/settlement";
import { asSettlementInstructionId } from "@payswap/protocol";
import { RailIncidentRecorder } from "../src/incidents.js";
import { CLOCK } from "./fixtures.js";

const RAIL = "rail.fiat.stripe-shape";
const NOW = CLOCK.now();
const PRINCIPAL = { principalType: "user", principalId: "user_1" };

describe("incident recorder — outage windows with append-only evidence", () => {
  it("records begin/end with evidence references and composes audit windows", () => {
    const recorder = new RailIncidentRecorder();
    recorder.beginOutage({
      railId: RAIL,
      startedAt: NOW,
      evidenceRef: "status-page:incident-1:start",
      now: NOW,
      note: "provider status page: elevated errors",
    });
    expect(recorder.isOpen(RAIL, NOW + 1n)).toBe(true);
    recorder.endOutage({
      railId: RAIL,
      endedAt: NOW + 3_600_000n,
      evidenceRef: "status-page:incident-1:resolved",
      now: NOW + 3_600_000n,
    });
    expect(recorder.isOpen(RAIL, NOW + 3_600_001n)).toBe(false);
    const windows = recorder.outageWindows(RAIL);
    expect(windows.length).toBe(1);
    expect(windows[0]?.startedAt).toBe(NOW);
    expect(windows[0]?.endedAt).toBe(NOW + 3_600_000n);
    expect(windows[0]?.evidenceRefs).toEqual([
      "status-page:incident-1:start",
      "status-page:incident-1:resolved",
    ]);
    // The audit records are append-only: 2 immutable records.
    expect(recorder.records().length).toBe(2);
    expect(recorder.records()[0]?.kind).toBe("OUTAGE_BEGUN");
    expect(recorder.records()[1]?.kind).toBe("OUTAGE_ENDED");
  });

  it("rejects overlapping outages and outages that end before they begin", () => {
    const recorder = new RailIncidentRecorder();
    recorder.beginOutage({ railId: RAIL, startedAt: NOW, evidenceRef: "ev-1", now: NOW });
    expect(() =>
      recorder.beginOutage({ railId: RAIL, startedAt: NOW + 1n, evidenceRef: "ev-2", now: NOW + 1n }),
    ).toThrow(/OPEN outage window/);
    expect(() =>
      recorder.endOutage({ railId: "rail.other", endedAt: NOW, evidenceRef: "ev-3", now: NOW }),
    ).toThrow(/no OPEN outage window/);
    const recorder2 = new RailIncidentRecorder();
    recorder2.beginOutage({ railId: RAIL, startedAt: NOW, evidenceRef: "ev-1", now: NOW });
    expect(() =>
      recorder2.endOutage({ railId: RAIL, endedAt: NOW - 1n, evidenceRef: "ev-2", now: NOW }),
    ).toThrow(/cannot end before it began/);
  });
});

describe("incident recorder — outage → UNKNOWN, never a fabricated outcome (INV-X01)", () => {
  it("classifies an in-flight effect during an open window as OUTCOME_UNKNOWN pending reconciliation", () => {
    const recorder = new RailIncidentRecorder();
    recorder.beginOutage({ railId: RAIL, startedAt: NOW, evidenceRef: "ev-outage-1", now: NOW });
    const during = recorder.classifyExternalEffect({ railId: RAIL, effectAt: NOW + 1n });
    expect(during.outcome).toBe("OUTCOME_UNKNOWN");
    if (during.outcome !== "OUTCOME_UNKNOWN") return;
    expect(during.requiresReconciliation).toBe(true);
    expect(during.reason).toBe("PROVIDER_OUTAGE_UNKNOWN_EFFECT");
    expect(during.window.startedAt).toBe(NOW);
    // The classification is structurally incapable of being SUCCEEDED or
    // FAILED — an outage NEVER fabricates a business outcome.
    const asRecord: readonly string[] = [during.outcome];
    expect(asRecord).not.toContain("SUCCEEDED");
    expect(asRecord).not.toContain("FAILED");

    // An effect BEFORE the window opened is not outage-covered.
    const before = recorder.classifyExternalEffect({ railId: RAIL, effectAt: NOW - 1n });
    expect(before.outcome).toBe("NO_OPEN_OUTAGE");
    recorder.endOutage({ railId: RAIL, endedAt: NOW + 100n, evidenceRef: "ev-outage-2", now: NOW + 100n });
    const after = recorder.classifyExternalEffect({ railId: RAIL, effectAt: NOW + 200n });
    expect(after.outcome).toBe("NO_OPEN_OUTAGE");
  });

  it("opens a reconciliation case for an outage-affected OUTCOME_UNKNOWN attempt (INV-X03)", () => {
    const recorder = new RailIncidentRecorder();
    const attemptLedger = new SettlementAttemptLedger();
    const authority = new SettlementReconciliationAuthority(attemptLedger);
    const attemptId = asSettlementAttemptId("settle-att-incident-1");
    attemptLedger.begin({
      attemptId,
      instructionId: asSettlementInstructionId("settle-instr-incident-1"),
      rail: RAIL,
      idempotencyKey: "idem-incident-1",
      principal: PRINCIPAL,
      now: NOW,
    });
    attemptLedger.start(attemptId, NOW);
    attemptLedger.recordExternalOutcome(attemptId, "OUTCOME_UNKNOWN", ["ev-amb-incident-1"], NOW);

    recorder.beginOutage({ railId: RAIL, startedAt: NOW - 1000n, evidenceRef: "ev-outage-1", now: NOW });
    const opened = recorder.openOutageEffectCase(authority, {
      caseId: "case-incident-1",
      attemptId,
      railId: RAIL,
      effectAt: NOW,
      now: NOW,
    });
    expect(opened.window.startedAt).toBe(NOW - 1000n);
    const record = authority.case("case-incident-1");
    expect(record?.reason).toBe("PROVIDER_OUTAGE_UNKNOWN_EFFECT");
    expect(record?.status).toBe("OPEN");
    // The attempt is still ambiguous — only reconciliation may resolve it.
    expect(attemptLedger.attempt(attemptId)?.state).toBe("OUTCOME_UNKNOWN");
  });

  it("refuses to attribute an outage effect without a recorded covering window (no fabricated attribution)", () => {
    const recorder = new RailIncidentRecorder();
    const attemptLedger = new SettlementAttemptLedger();
    const authority = new SettlementReconciliationAuthority(attemptLedger);
    const attemptId = asSettlementAttemptId("settle-att-incident-2");
    attemptLedger.begin({
      attemptId,
      instructionId: asSettlementInstructionId("settle-instr-incident-2"),
      rail: RAIL,
      idempotencyKey: "idem-incident-2",
      principal: PRINCIPAL,
      now: NOW,
    });
    attemptLedger.start(attemptId, NOW);
    attemptLedger.recordExternalOutcome(attemptId, "OUTCOME_UNKNOWN", ["ev-amb-incident-2"], NOW);
    expect(() =>
      recorder.openOutageEffectCase(authority, {
        caseId: "case-incident-2",
        attemptId,
        railId: RAIL,
        effectAt: NOW,
        now: NOW,
      }),
    ).toThrow(/without recorded outage evidence/);
  });
});

describe("incident recorder — recovery probes (read-only, evidence-capturing)", () => {
  it("records a successful probe when the rail health surface answers HEALTHY", async () => {
    const recorder = new RailIncidentRecorder();
    const probe = await recorder.probeRailRecovery({
      railId: RAIL,
      evidenceRef: "probe:1",
      now: NOW,
      probe: async () => ({ status: "HEALTHY" }),
    });
    expect(probe.reachable).toBe(true);
    const records = recorder.records();
    expect(records[records.length - 1]?.kind).toBe("RECOVERY_PROBE");
    const last = records[records.length - 1];
    if (last?.kind === "RECOVERY_PROBE") {
      expect(last.reachable).toBe(true);
      expect(last.evidenceRef).toBe("probe:1");
    }
  });

  it("records a failed probe (and the failure detail) when the probe throws — never fabricates recovery", async () => {
    const recorder = new RailIncidentRecorder();
    const probe = await recorder.probeRailRecovery({
      railId: RAIL,
      evidenceRef: "probe:2",
      now: NOW,
      probe: async () => {
        throw new Error("connection refused");
      },
    });
    expect(probe.reachable).toBe(false);
    expect(probe.detail).toContain("connection refused");
    const last = recorder.records()[0];
    if (last?.kind === "RECOVERY_PROBE") {
      expect(last.reachable).toBe(false);
      expect(last.note).toContain("connection refused");
    }
  });

  it("composes a full incident audit: outage → failed probe → recovery probe → window closed", async () => {
    const recorder = new RailIncidentRecorder();
    recorder.beginOutage({ railId: RAIL, startedAt: NOW, evidenceRef: "ev-out-1", now: NOW });
    await recorder.probeRailRecovery({
      railId: RAIL,
      evidenceRef: "probe:unhealthy",
      now: NOW + 60_000n,
      probe: async () => ({ status: "UNKNOWN" }),
    });
    await recorder.probeRailRecovery({
      railId: RAIL,
      evidenceRef: "probe:recovered",
      now: NOW + 120_000n,
      probe: async () => ({ status: "HEALTHY" }),
    });
    recorder.endOutage({
      railId: RAIL,
      endedAt: NOW + 180_000n,
      evidenceRef: "ev-out-2",
      now: NOW + 180_000n,
      note: "recovery confirmed by probe evidence",
    });
    const records = recorder.records();
    expect(records.map((record) => record.kind)).toEqual([
      "OUTAGE_BEGUN",
      "RECOVERY_PROBE",
      "RECOVERY_PROBE",
      "OUTAGE_ENDED",
    ]);
    const window = recorder.outageWindows(RAIL)[0];
    expect(window?.endedAt).toBe(NOW + 180_000n);
    expect(window?.evidenceRefs).toEqual(["ev-out-1", "ev-out-2"]);
  });
});
