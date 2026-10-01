/**
 * Incident handling for rails — outage windows, UNKNOWN classification and
 * recovery probes (W1-005; FROZEN-ARCHITECTURE §22; INV-S04: incidents feed
 * evidence and security learning).
 *
 * Binding rules:
 * - an outage NEVER fabricates a business outcome: while a rail has an open
 *   outage window, an in-flight external effect on that rail classifies as
 *   OUTCOME_UNKNOWN with reason PROVIDER_OUTAGE_UNKNOWN_EFFECT (INV-X01 —
 *   never FAILED, never SUCCEEDED) and resolves ONLY through a settlement
 *   reconciliation case (INV-X03);
 * - outage evidence is APPEND-ONLY and auditable: OUTAGE_BEGUN /
 *   OUTAGE_ENDED / RECOVERY_PROBE records are immutable once recorded
 *   (INV-E05) and compose into outage windows with their evidence
 *   references;
 * - recovery probes are read-only health checks (never business outcomes);
 *   a probe that answers proves endpoint reachability only (INV-C02).
 */

import { ValidationError } from "@payswap/protocol";
import type { TimestampMs } from "@payswap/protocol";
import type { SettlementReconciliationAuthority } from "@payswap/settlement";
import type { SettlementAttemptId } from "@payswap/settlement";

// ---------------------------------------------------------------------------
// Append-only incident records (INV-E05 — never rewritten)
// ---------------------------------------------------------------------------

export type RailIncidentRecord =
  | {
      readonly kind: "OUTAGE_BEGUN";
      readonly railId: string;
      readonly startedAt: TimestampMs;
      readonly evidenceRef: string;
      readonly note?: string;
      readonly recordedAt: TimestampMs;
    }
  | {
      readonly kind: "OUTAGE_ENDED";
      readonly railId: string;
      readonly startedAt: TimestampMs;
      readonly endedAt: TimestampMs;
      readonly evidenceRef: string;
      readonly note?: string;
      readonly recordedAt: TimestampMs;
    }
  | {
      readonly kind: "RECOVERY_PROBE";
      readonly railId: string;
      readonly probedAt: TimestampMs;
      readonly reachable: boolean;
      readonly evidenceRef: string;
      readonly note?: string;
      readonly recordedAt: TimestampMs;
    };

/** One composed outage window (audit view over the append-only records). */
export interface RailOutageWindow {
  readonly railId: string;
  readonly startedAt: TimestampMs;
  /** Undefined while the outage is still open. */
  readonly endedAt?: TimestampMs;
  /** Evidence references of the begin (and, when present, end records. */
  readonly evidenceRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Outage classification (INV-X01 — never a fabricated outcome)
// ---------------------------------------------------------------------------

/**
 * The incident classification of an in-flight external effect: while the
 * rail has an OPEN outage window covering the effect time, the outcome is
 * OUTCOME_UNKNOWN pending reconciliation — an outage is never allowed to
 * fabricate a SUCCEEDED or FAILED business outcome.
 */
export type IncidentOutcomeClassification =
  | {
      readonly outcome: "OUTCOME_UNKNOWN";
      readonly requiresReconciliation: true;
      readonly reason: "PROVIDER_OUTAGE_UNKNOWN_EFFECT";
      readonly railId: string;
      readonly window: RailOutageWindow;
    }
  | { readonly outcome: "NO_OPEN_OUTAGE"; readonly railId: string };

// ---------------------------------------------------------------------------
// The incident recorder
// ---------------------------------------------------------------------------

export interface RailProbeResult {
  readonly railId: string;
  readonly reachable: boolean;
  readonly probedAt: TimestampMs;
  readonly evidenceRef: string;
  readonly detail?: string;
}

/**
 * The rail incident recorder: append-only outage/probe records, outage
 * windows for audit, the INV-X01 outage classification, and the
 * reconciliation-case opening for outage-affected attempts (INV-X03).
 */
export class RailIncidentRecorder {
  readonly #records: RailIncidentRecord[] = [];

  /** Begins an outage window for one rail (append-only evidence). */
  beginOutage(input: {
    readonly railId: string;
    readonly startedAt: TimestampMs;
    readonly evidenceRef: string;
    readonly now: TimestampMs;
    readonly note?: string;
  }): RailIncidentRecord {
    this.#validateOutageInput(input);
    if (this.#openWindow(input.railId) !== undefined) {
      throw new ValidationError(
        `rail '${input.railId}' already has an OPEN outage window — end it before beginning another (append-only history)`,
      );
    }
    const record: RailIncidentRecord = Object.freeze({
      kind: "OUTAGE_BEGUN",
      railId: input.railId,
      startedAt: input.startedAt,
      evidenceRef: input.evidenceRef,
      ...(input.note !== undefined ? { note: input.note } : {}),
      recordedAt: input.now,
    });
    this.#records.push(record);
    return record;
  }

  /** Ends the open outage window for one rail (append-only evidence). */
  endOutage(input: {
    readonly railId: string;
    readonly endedAt: TimestampMs;
    readonly evidenceRef: string;
    readonly now: TimestampMs;
    readonly note?: string;
  }): RailIncidentRecord {
    if (
      typeof input.railId !== "string" ||
      input.railId.length === 0 ||
      typeof input.evidenceRef !== "string" ||
      input.evidenceRef.length === 0 ||
      typeof input.endedAt !== "bigint" ||
      typeof input.now !== "bigint"
    ) {
      throw new ValidationError("end-outage input must carry railId, endedAt, evidenceRef and now");
    }
    const open = this.#openWindow(input.railId);
    if (open === undefined) {
      throw new ValidationError(`rail '${input.railId}' has no OPEN outage window to end`);
    }
    if (input.endedAt < open.startedAt) {
      throw new ValidationError("an outage window cannot end before it began");
    }
    const record: RailIncidentRecord = Object.freeze({
      kind: "OUTAGE_ENDED",
      railId: input.railId,
      startedAt: open.startedAt,
      endedAt: input.endedAt,
      evidenceRef: input.evidenceRef,
      ...(input.note !== undefined ? { note: input.note } : {}),
      recordedAt: input.now,
    });
    this.#records.push(record);
    return record;
  }

  /**
   * Records one read-only recovery probe (INV-C02: reachability only —
   * never a business outcome). Probes are evidence for the outage window
   * audit trail and for closing outages with provider-answered proof.
   */
  recordRecoveryProbe(input: {
    readonly railId: string;
    readonly probedAt: TimestampMs;
    readonly reachable: boolean;
    readonly evidenceRef: string;
    readonly now: TimestampMs;
    readonly note?: string;
  }): RailIncidentRecord {
    if (
      typeof input.railId !== "string" ||
      input.railId.length === 0 ||
      typeof input.evidenceRef !== "string" ||
      input.evidenceRef.length === 0 ||
      typeof input.probedAt !== "bigint" ||
      typeof input.reachable !== "boolean" ||
      typeof input.now !== "bigint"
    ) {
      throw new ValidationError(
        "probe input must carry railId, probedAt, reachable, evidenceRef and now",
      );
    }
    const record: RailIncidentRecord = Object.freeze({
      kind: "RECOVERY_PROBE",
      railId: input.railId,
      probedAt: input.probedAt,
      reachable: input.reachable,
      evidenceRef: input.evidenceRef,
      ...(input.note !== undefined ? { note: input.note } : {}),
      recordedAt: input.now,
    });
    this.#records.push(record);
    return record;
  }

  /**
   * Runs one recovery probe through a rail's read-only health surface and
   * records it. The health probe itself is supplied by the caller (any
   * ConnectorSDK `health()`): this recorder only captures the evidence.
   */
  async probeRailRecovery(input: {
    readonly railId: string;
    readonly evidenceRef: string;
    readonly now: TimestampMs;
    readonly probe: () => Promise<{ readonly status: string }>;
  }): Promise<RailProbeResult> {
    if (
      typeof input.railId !== "string" ||
      input.railId.length === 0 ||
      typeof input.evidenceRef !== "string" ||
      input.evidenceRef.length === 0 ||
      typeof input.now !== "bigint"
    ) {
      throw new ValidationError("probe input must carry railId, evidenceRef and now");
    }
    let reachable = false;
    let detail: string | undefined;
    try {
      const report = await input.probe();
      reachable = report.status === "HEALTHY";
      detail = `probe status: ${report.status}`;
    } catch (cause) {
      reachable = false;
      detail = `probe failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    this.recordRecoveryProbe({
      railId: input.railId,
      probedAt: input.now,
      reachable,
      evidenceRef: input.evidenceRef,
      now: input.now,
      ...(detail !== undefined ? { note: detail } : {}),
    });
    return {
      railId: input.railId,
      reachable,
      probedAt: input.now,
      evidenceRef: input.evidenceRef,
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  /** True when the rail has an outage window OPEN at the given time. */
  isOpen(railId: string, at: TimestampMs): boolean {
    return this.#windowCovering(railId, at) !== undefined;
  }

  /**
   * INV-X01 classification: an external effect on a rail whose outage
   * window covers the effect time is OUTCOME_UNKNOWN — never a fabricated
   * business outcome. Resolutions flow exclusively through reconciliation
   * cases (INV-X03).
   */
  classifyExternalEffect(input: {
    readonly railId: string;
    readonly effectAt: TimestampMs;
  }): IncidentOutcomeClassification {
    const window = this.#windowCovering(input.railId, input.effectAt);
    if (window === undefined) {
      return { outcome: "NO_OPEN_OUTAGE", railId: input.railId };
    }
    return {
      outcome: "OUTCOME_UNKNOWN",
      requiresReconciliation: true,
      reason: "PROVIDER_OUTAGE_UNKNOWN_EFFECT",
      railId: input.railId,
      window,
    };
  }

  /**
   * Opens the settlement reconciliation case for an outage-affected attempt
   * (INV-X03): the attempt must already be OUTCOME_UNKNOWN and the rail's
   * outage window must cover the effect time — outage attribution is never
   * fabricated for a rail without a recorded window.
   */
  openOutageEffectCase(
    authority: SettlementReconciliationAuthority,
    input: {
      readonly caseId: string;
      readonly attemptId: SettlementAttemptId;
      readonly railId: string;
      readonly effectAt: TimestampMs;
      readonly now: TimestampMs;
    },
  ): { readonly caseId: string; readonly window: RailOutageWindow } {
    const classification = this.classifyExternalEffect({
      railId: input.railId,
      effectAt: input.effectAt,
    });
    if (classification.outcome !== "OUTCOME_UNKNOWN") {
      throw new ValidationError(
        `no open outage window covers rail '${input.railId}' at the effect time — refusing to attribute an outage effect without recorded outage evidence`,
      );
    }
    authority.openCase({
      caseId: input.caseId,
      subject: { kind: "SETTLEMENT_ATTEMPT", attemptId: input.attemptId },
      reason: "PROVIDER_OUTAGE_UNKNOWN_EFFECT",
      now: input.now,
    });
    return { caseId: input.caseId, window: classification.window };
  }

  /** All records in append order (audit view — immutable values). */
  records(): readonly RailIncidentRecord[] {
    return Object.freeze([...this.#records]);
  }

  /** Composed outage windows per rail (audit view). */
  outageWindows(railId?: string): readonly RailOutageWindow[] {
    const windows: RailOutageWindow[] = [];
    for (const record of this.#records) {
      if (railId !== undefined && record.railId !== railId) {
        continue;
      }
      if (record.kind === "OUTAGE_BEGUN") {
        windows.push({
          railId: record.railId,
          startedAt: record.startedAt,
          evidenceRefs: [record.evidenceRef],
        });
      } else if (record.kind === "OUTAGE_ENDED") {
        const open = windows.find(
          (window) => window.railId === record.railId && window.endedAt === undefined,
        );
        if (open === undefined) {
          continue; // unreachable through the public API; audit-safe skip
        }
        const index = windows.indexOf(open);
        windows[index] = {
          ...open,
          endedAt: record.endedAt,
          evidenceRefs: [...open.evidenceRefs, record.evidenceRef],
        };
      }
    }
    return Object.freeze(windows);
  }

  // -- internals -------------------------------------------------------------------

  #validateOutageInput(input: {
    readonly railId: string;
    readonly startedAt: TimestampMs;
    readonly evidenceRef: string;
    readonly now: TimestampMs;
    readonly note?: string;
  }): void {
    if (
      typeof input.railId !== "string" ||
      input.railId.length === 0 ||
      typeof input.startedAt !== "bigint" ||
      typeof input.evidenceRef !== "string" ||
      input.evidenceRef.length === 0 ||
      typeof input.now !== "bigint"
    ) {
      throw new ValidationError(
        "outage input must carry railId, startedAt, evidenceRef and now",
      );
    }
  }

  #openWindow(railId: string): RailOutageWindow | undefined {
    const windows = this.outageWindows(railId);
    return windows.find((window) => window.endedAt === undefined);
  }

  #windowCovering(railId: string, at: TimestampMs): RailOutageWindow | undefined {
    return this.outageWindows(railId).find(
      (window) => window.startedAt <= at && (window.endedAt === undefined || at <= window.endedAt),
    );
  }
}
