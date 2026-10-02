/**
 * @payswap/journeys — the cross-provider conformance model (P2-W2-003).
 *
 * The data model for the common certification suite across ALL production
 * providers (Wave 1 + Wave 2 connector set). The 13 lifecycle scenarios of
 * the work order are declared as data; per-provider APPLICABILITY is
 * declared from each provider's own capability ids / status vocabulary
 * (never assumed); and one executable runner exercises every applicable
 * (provider × scenario) pair against SYNTHETIC provider fixtures over
 * scripted transports — the certification is at the CONTRACT level, exactly
 * like the existing journeys: the provider's OWN mapping code (status
 * tables, envelope builders, webhook verifiers, idempotency derivations,
 * connector SDK paths) runs, but no live provider is contacted and no
 * financial effect is simulated.
 *
 * Determinism: a fixed conformance epoch (no Date.now / Math.random), a
 * scripted HttpTransport recording every call, synthetic key material that
 * is obviously fake and planted ONLY in SDK transports (never in products).
 */

import type { HttpTransport } from "@payswap/rails";
import type { ProviderStateEnvelope, ProviderStateFamily } from "@payswap/connectors";
import type { ExternalFundsPositionObservation } from "@payswap/connectors";
import type { ProviderOutcomeClassification } from "@payswap/execution";
import type { TimestampMs } from "@payswap/protocol";

// ---------------------------------------------------------------------------
// The 13 scenario ids (work order P2-W2-003, exact)
// ---------------------------------------------------------------------------

export const CONFORMANCE_SCENARIO_IDS = [
  "CUSTOMER_ACTION_REQUIRED",
  "ASYNC_PROCESSING",
  "CAPTURE",
  "RECURRING_MANDATE",
  "REFUND",
  "DISPUTE",
  "PAYOUT",
  "DUPLICATE_SUBMISSION",
  "WEBHOOK_LOSS",
  "PROVIDER_OUTAGE",
  "UNKNOWN",
  "PROVIDER_REVISION_CHANGE",
  "FALLBACK_RE_AUTHORIZATION",
] as const;
export type ConformanceScenarioId = (typeof CONFORMANCE_SCENARIO_IDS)[number];

export function isConformanceScenarioId(value: unknown): value is ConformanceScenarioId {
  return (
    typeof value === "string" &&
    (CONFORMANCE_SCENARIO_IDS as readonly unknown[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Applicability (declared per provider, never silent)
// ---------------------------------------------------------------------------

/**
 * One (provider × scenario) applicability entry. `basis` cites the
 * capability ids / status vocabulary that make the scenario applicable, or
 * the honest NOT_SUPPORTED_BY_PROVIDER / NOT_YET_IMPLEMENTED reason.
 */
export interface ProviderScenarioApplicability {
  readonly providerName: string;
  readonly scenarioId: ConformanceScenarioId;
  readonly applicable: boolean;
  readonly basis: string;
}

/** A declared applicability basis (the honest vocabulary). */
export type ApplicabilityBasis =
  | { readonly applicable: true; readonly basis: string }
  | { readonly applicable: false; readonly basis: string };

export function applicable(
  basis: string,
): { readonly applicable: true; readonly basis: string } {
  return { applicable: true, basis };
}

export function notSupportedByProvider(reason: string): ApplicabilityBasis {
  return {
    applicable: false,
    basis: `NOT_SUPPORTED_BY_PROVIDER — ${reason}`,
  };
}

export function notYetImplemented(reason: string): ApplicabilityBasis {
  return {
    applicable: false,
    basis: `NOT_YET_IMPLEMENTED — ${reason}`,
  };
}

// ---------------------------------------------------------------------------
// Verdicts, gates and checks
// ---------------------------------------------------------------------------

/** The four shared gates — identical for every provider (work order line 2). */
export const CONFORMANCE_GATE_NAMES = [
  "AUTHORIZATION",
  "EVIDENCE",
  "RECONCILIATION",
  "SECURITY",
] as const;
export type ConformanceGateName = (typeof CONFORMANCE_GATE_NAMES)[number];

export interface GateCheck {
  readonly gate: ConformanceGateName;
  readonly passed: boolean;
  readonly summary: string;
}

export interface ScenarioCheck {
  readonly ok: boolean;
  readonly detail: string;
}

/** The verdict for one (provider × scenario) pair. */
export interface ScenarioVerdict {
  readonly scenarioId: ConformanceScenarioId;
  readonly providerName: string;
  readonly verdict: "PASS" | "FAIL" | "NOT_APPLICABLE";
  /** The four shared gates — present for every EXECUTED pair (PASS or FAIL). */
  readonly gateChecks: readonly GateCheck[];
  /** The scenario-specific lifecycle checks (the 13 semantics). */
  readonly scenarioChecks: readonly ScenarioCheck[];
  readonly evidenceRefs: readonly string[];
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Scenario artifacts (what a provider script produces)
// ---------------------------------------------------------------------------

/** The second-submission duplicate probe result. */
export interface DuplicateProbeOutcome {
  /**
   * DUPLICATE_ERROR_CLASS — the provider's duplicate class was raised by the
   * second submission through the SAME protocol idempotency key (never a
   * silent second success). DERIVATION_ONLY — no dedicated duplicate class
   * exists in the fixture set; the derivation + declared duplicateBehavior
   * carry the contract (noted honestly).
   */
  readonly kind: "DUPLICATE_ERROR_CLASS" | "DERIVATION_ONLY";
  readonly duplicateClass?: string;
  readonly declaredDuplicateBehavior?: string;
}

/** The mid-effect outage probe result (INV-X01 — never FAILED). */
export interface OutageProbeOutcome {
  /**
   * OUTCOME_UNKNOWN_ENVELOPE — the connector answered with the canonical
   * ambiguous envelope (outcome OUTCOME_UNKNOWN, requires reconciliation).
   * TRANSPORT_REFUSED_NO_STATE — the connector refuses with a transport
   * error and fabricates NO provider state (the pre-envelope honest form).
   */
  readonly kind: "OUTCOME_UNKNOWN_ENVELOPE" | "TRANSPORT_REFUSED_NO_STATE";
  readonly outcome?: string;
  readonly requiresReconciliation?: boolean;
  readonly envelope?: ProviderStateEnvelope;
  readonly errorClass?: string;
  /** The append-only outage-window evidence (RailIncidentRecorder). */
  readonly incidentWindow?: {
    readonly begun: boolean;
    readonly recoveryProbes: number;
    readonly ended: boolean;
  };
}

/** What a scenario script hands the shared checks. */
export interface ScenarioArtifacts {
  readonly providerName: string;
  readonly scenarioId: ConformanceScenarioId;
  /** The lossless envelopes the provider's OWN mapping code produced. */
  readonly envelopes: readonly ProviderStateEnvelope[];
  /** The canonical outcome classification of each envelope (INV-X01). */
  readonly outcomes?: readonly ProviderOutcomeClassification[];
  /** A second, independent mapping pass over the same provider object — the
   * INV-X03 reconciliation-by-external-id re-fetch analog. */
  readonly refetched?: readonly ProviderStateEnvelope[];
  /** External funds position observations (payout scenario, INV-C09). */
  readonly fundsObservations?: readonly ExternalFundsPositionObservation[];
  /** The duplicate-submission probe (DUPLICATE_SUBMISSION). */
  readonly duplicate?: DuplicateProbeOutcome;
  /** The mid-effect outage probe (PROVIDER_OUTAGE). */
  readonly outage?: OutageProbeOutcome;
  /** The webhook ingestion + loss-recovery result (WEBHOOK_LOSS). */
  readonly webhookLoss?: {
    readonly firstIngestion: "INGESTED" | "REJECTED";
    readonly duplicateDelivery: "ALREADY_INGESTED" | "INGESTED" | "REJECTED";
    readonly refetchedExternalId: string;
    readonly refetchedFamily: ProviderStateFamily;
    readonly refetchedLifecycleStep: string;
    readonly recoveryStatus: string;
    readonly sameExternalId: boolean;
  };
  /** The append-only revision lineage (PROVIDER_REVISION_CHANGE). */
  readonly revisionLineage?: readonly {
    readonly revision: string;
    readonly envelope: ProviderStateEnvelope;
  }[];
  /** The fallback ladder result (FALLBACK_RE_AUTHORIZATION). */
  readonly fallback?: {
    readonly ladder: readonly string[];
    readonly failedTerminal: boolean;
    readonly reAuthorizationRequired: boolean;
    readonly fallbackInstanceAuthorization: string;
    readonly onboardingFirstStep: string;
  };
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Determinism anchors + the scripted transport
// ---------------------------------------------------------------------------

/** The fixed conformance epoch — every scenario runs at the same instant. */
export const CONFORMANCE_EPOCH: TimestampMs = 1_766_000_000_000n;

/** The fixed observation timestamp (ISO) derived from the epoch. */
export const CONFORMANCE_OBSERVED_AT: string = new Date(
  Number(CONFORMANCE_EPOCH),
).toISOString();

/** One recorded scripted-transport call. */
export interface RecordedHttpCall {
  readonly url: string;
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * A scripted HTTP transport: deterministic, records every call, answers from
 * the supplied responder. This is the ONLY network surface any scenario
 * touches — the certification is offline by construction.
 */
export class ScriptedConformanceTransport {
  readonly calls: RecordedHttpCall[] = [];
  readonly #respond: (
    call: RecordedHttpCall,
  ) => { status: number; bodyText: string } | Promise<{ status: number; bodyText: string }>;

  constructor(
    respond: (
      call: RecordedHttpCall,
    ) => { status: number; bodyText: string } | Promise<{ status: number; bodyText: string }>,
  ) {
    this.#respond = respond;
  }

  readonly transport: HttpTransport = async (url, init) => {
    const call: RecordedHttpCall = {
      url,
      method: init.method,
      ...(init.headers !== undefined ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    };
    this.calls.push(call);
    return this.#respond(call);
  };
}

/** A transport that answers every call with a synthetic 200 (the armed gate). */
export function answeringTransport(
  body: unknown = { ok: true },
): { transport: ScriptedConformanceTransport; calls: readonly RecordedHttpCall[] } {
  const scripted = new ScriptedConformanceTransport(() => ({
    status: 200,
    bodyText: JSON.stringify(body),
  }));
  return { transport: scripted, calls: scripted.calls };
}

/** A transport that dies on every call (the outage probe). */
export function deadTransport(): ScriptedConformanceTransport {
  return new ScriptedConformanceTransport(() => {
    throw new Error("connection reset (conformance outage probe)");
  });
}

/** A JSON 200 response helper for scripted responders. */
export function jsonOk(body: unknown): { status: number; bodyText: string } {
  return { status: 200, bodyText: JSON.stringify(body) };
}

/** A JSON error response helper for scripted responders. */
export function jsonError(
  status: number,
  body: unknown,
): { status: number; bodyText: string } {
  return { status, bodyText: JSON.stringify(body) };
}
