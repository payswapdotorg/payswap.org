/**
 * W2-007 fault family — ambiguous provider outcomes.
 *
 * Attack: a provider answers an external write with an ambiguous outcome
 * (failure.ambiguity = OUTCOME_UNKNOWN, retryable). The system must preserve
 * UNKNOWN (never map it to FAILED), refuse blind retries, and resolve the
 * ambiguity only through reconciliation with provider evidence.
 *
 * Invariants on the line: INV-X01 (UNKNOWN is never FAILED), INV-X02 (no
 * blind retry of UNKNOWN external writes), INV-X03 (reconciliation is
 * authoritative), INV-C06 (lossless provider state).
 */

import { asExecutionAttemptId, classifyProviderOutcome } from "@payswap/execution";
import type { ProviderExecutionEvidenceDraft } from "@payswap/execution";
import {
  createProviderStateEnvelope,
  serializeProviderStateEnvelope,
  parseProviderStateEnvelope,
} from "@payswap/connectors";
import type { ProviderStateEnvelope } from "@payswap/connectors";
import { ExternalAmbiguityError, isFailureOutcome } from "@payswap/protocol";
import {
  ADVERSARIAL_PRINCIPAL,
  buildAdversarialWorld,
  injectionCheck,
  probe,
  recoveryStep,
} from "../harness.js";
import type {
  AdversarialScenario,
  AdversarialWorld,
  FaultExecution,
} from "../harness.js";

function envelope(options: {
  readonly ambiguity: "NONE" | "OUTCOME_UNKNOWN";
  readonly retryable: boolean;
  readonly terminal?: boolean;
}): ProviderStateEnvelope {
  return createProviderStateEnvelope({
    provider: { name: "psp-ambiguous", version: "2.4.1" },
    object: { objectType: "payment_intent", externalId: "pi_amb_1" },
    revision: "7",
    state: { status: options.terminal === true ? "failed" : "processing" },
    classification: {
      family: "other",
      lifecycleStep: options.terminal === true ? "failed" : "processing",
      isTerminal: options.terminal === true,
      requiresCustomerAction: false,
    },
    history: [],
    ...(options.ambiguity === "OUTCOME_UNKNOWN"
      ? {
          failure: {
            providerErrorCode: "gateway_timeout",
            providerErrorMessage: "upstream timed out before committing",
            retryable: options.retryable,
            ambiguity: "OUTCOME_UNKNOWN" as const,
          },
        }
      : {
          failure: {
            providerErrorCode: "card_declined",
            providerErrorMessage: "definitive decline",
            retryable: false,
            ambiguity: "NONE" as const,
          },
        }),
    privacy: { dataClassification: "PARTNER", constraints: [], shareableFields: ["state"] },
    timestamps: { observedAt: "2026-10-20T00:00:00Z" },
    provenance: { source: "PROVIDER_API", fetchId: "fetch_pi_amb_1_7" },
  });
}

function evidence(
  evidenceId: string,
  providerState: ProviderStateEnvelope,
  kind: "EXECUTION" | "RECONCILIATION" = "EXECUTION",
  recordedAt: bigint,
): ProviderExecutionEvidenceDraft {
  return {
    evidenceId,
    kind,
    evidenceRef: `provider-op:pi_amb_1:${providerState.revision}`,
    providerState,
    recordedAt,
  };
}

export function ambiguousProviderScenario(): AdversarialScenario {
  const declaration = {
    faultId: "fault:ambiguous-provider:1",
    family: "ambiguous-provider" as const,
    title: "Ambiguous provider outcome preserved as UNKNOWN and resolved only by reconciliation",
    description:
      "A provider write times out ambiguously (retryable OUTCOME_UNKNOWN); the attempt must preserve UNKNOWN, refuse the blind retry, and reach a terminal state only through a reconciliation resolution backed by fresh provider evidence — after which a SAFE_TO_RETRY retry may run.",
    candidateInvariants: ["INV-X01", "INV-X02", "INV-X03", "INV-C06"],
    attackedSubsystems: ["@payswap/execution", "@payswap/connectors", "@payswap/protocol", "@payswap/journeys"],
  };

  return {
    declaration,
    run: (): FaultExecution => {
      const world: AdversarialWorld = buildAdversarialWorld();
      const now = (): bigint => world.journey.clock.now();
      const ledger = world.journey.attempts;

      // --- ground truth: an in-flight attempt on a real rail step ----------
      const begin = ledger.begin({
        attemptId: "att:amb:1",
        planId: "plan:amb",
        stepId: "step:charge",
        executionMode: "PASS_THROUGH_NATIVE",
        capabilityInstanceId: "inst:payments:psp-ambiguous",
        capabilityId: "cap:payments",
        retryPolicy: "SAFE_TO_RETRY",
        cancellation: "BEFORE_EXECUTION",
        compensation: {
          compensable: true,
          compensationCapabilityId: "cap:refund",
          cancellation: "BEFORE_EXECUTION",
          partialExecution: { possible: true, granularity: "ATOMIC", onPartial: "DISCLOSED" },
        },
        idempotencyKey: "idem:amb:1",
        principal: { ...ADVERSARIAL_PRINCIPAL },
        now: now(),
      });
      if (begin.kind !== "BEGIN") {
        throw new Error("fixture setup: first attempt must BEGIN");
      }
      ledger.advance("att:amb:1", "START", { now: now() });

      // --- INJECTION: the provider answers ambiguously ---------------------
      const ambiguousEnvelope = envelope({ ambiguity: "OUTCOME_UNKNOWN", retryable: true });
      const unknown = ledger.advance("att:amb:1", "EXTERNAL_OUTCOME_UNKNOWN", {
        now: now(),
        evidence: [evidence("ev:amb:timeout", ambiguousEnvelope, "EXECUTION", now())],
        providerState: ambiguousEnvelope,
      });
      const classification = classifyProviderOutcome(ambiguousEnvelope);
      const classificationRequiresReconciliation =
        classification.outcome === "OUTCOME_UNKNOWN" ? classification.requiresReconciliation : false;

      // --- the invariant carrier itself ------------------------------------
      const ambiguityError = new ExternalAmbiguityError("provider write outcome unknown", {
        externalId: "pi_amb_1",
      });

      // --- INJECTION: the blind retry is attempted -------------------------
      let blindRetryRejected = false;
      let blindRetryError = "";
      try {
        ledger.requestRetry("att:amb:1", "att:amb:blind-retry", now());
      } catch (error) {
        blindRetryRejected = true;
        blindRetryError = error instanceof Error ? error.constructor.name : "unknown";
      }

      // --- INJECTION: direct outcome overwrite is attempted ----------------
      let directOverwriteRejected = false;
      let directOverwriteMessage = "";
      try {
        ledger.advance("att:amb:1", "CONFIRM_FAILED", {
          now: now(),
          evidence: [
            evidence("ev:amb:overwrite", envelope({ ambiguity: "NONE", retryable: false }), "EXECUTION", now()),
          ],
        });
      } catch (error) {
        directOverwriteRejected = true;
        directOverwriteMessage = error instanceof Error ? error.message : "unknown";
      }

      // --- recovery: reconciliation with re-fetched provider evidence ------
      const reconciliation = world.journey.executionReconciliation;
      const opened = reconciliation.openCase({
        caseId: "case:amb:1",
        attemptId: asExecutionAttemptId("att:amb:1"),
        reason: "EXTERNAL_AMBIGUITY",
        now: now(),
      });
      const definitive = envelope({ ambiguity: "NONE", retryable: false, terminal: true });
      reconciliation.resolveCase({
        caseId: "case:amb:1",
        outcome: "CONFIRMED_FAILED",
        resolvedBy: { ...ADVERSARIAL_PRINCIPAL },
        evidence: [evidence("ev:amb:resolved", definitive, "RECONCILIATION", now())],
        now: now(),
      });
      const resolved = ledger.attempt("att:amb:1");
      const resolvedCase = reconciliation.case("case:amb:1");

      // --- recovery: with the ambiguity resolved, a SAFE_TO_RETRY runs -----
      const retry = ledger.requestRetry("att:amb:1", "att:amb:retry-1", now());
      ledger.advance("att:amb:retry-1", "START", { now: now() });
      const retriedSucceeded = ledger.advance("att:amb:retry-1", "CONFIRM_SUCCEEDED", {
        now: now(),
        evidence: [
          evidence(
            "ev:amb:retry-ok",
            envelope({ ambiguity: "NONE", retryable: false, terminal: true }),
            "EXECUTION",
            now(),
          ),
        ],
      });

      const injectionChecks = [
        injectionCheck(
          unknown.state === "OUTCOME_UNKNOWN" &&
            classification.outcome === "OUTCOME_UNKNOWN" &&
            classificationRequiresReconciliation === true,
          `the ambiguous provider answer (retryable OUTCOME_UNKNOWN) surfaced as ${unknown.state} and classifyProviderOutcome returns ${classification.outcome} with requiresReconciliation=${String(classificationRequiresReconciliation)}`,
        ),
        injectionCheck(
          blindRetryRejected && blindRetryError === "AttemptRetryForbiddenError",
          `the blind retry of the UNKNOWN write threw ${blindRetryError} (INV-X02 enforced by the real ledger)`,
        ),
        injectionCheck(
          directOverwriteRejected,
          `a direct CONFIRM_FAILED on the UNKNOWN attempt was rejected: ${directOverwriteMessage}`,
        ),
      ];

      const serialized = serializeProviderStateEnvelope(ambiguousEnvelope);
      const roundTripIdentical =
        serializeProviderStateEnvelope(parseProviderStateEnvelope(serialized)) === serialized;

      const probes = [
        probe(
          "INV-X01",
          unknown.state === "OUTCOME_UNKNOWN" &&
            classification.outcome === "OUTCOME_UNKNOWN" &&
            classificationRequiresReconciliation === true &&
            isFailureOutcome(ambiguityError) === false &&
            ambiguityError.requiresReconciliation === true,
          `UNKNOWN was never mapped to FAILED: the attempt is ${unknown.state}, the classification is OUTCOME_UNKNOWN/requiresReconciliation, and isFailureOutcome(ExternalAmbiguityError) is false`,
        ),
        probe(
          "INV-X02",
          blindRetryRejected && blindRetryError === "AttemptRetryForbiddenError" && directOverwriteRejected,
          `the UNKNOWN external write could be neither blindly retried (${blindRetryError}) nor directly overwritten (rejected)`,
        ),
        probe(
          "INV-X03",
          opened.caseId === "case:amb:1" &&
            resolved !== undefined &&
            resolved.state === "FAILED" &&
            resolvedCase !== undefined &&
            resolvedCase.status === "RESOLVED" &&
            resolvedCase.resolution !== undefined &&
            resolvedCase.resolution.outcome === "CONFIRMED_FAILED" &&
            retry.attemptId === "att:amb:retry-1" &&
            retriedSucceeded.state === "SUCCEEDED",
          `the attempt reached FAILED ONLY through reconciliation case case:amb:1 (CONFIRMED_FAILED with provider evidence); the subsequent SAFE_TO_RETRY attempt att:amb:retry-1 ran and SUCCEEDED with evidence`,
        ),
        probe(
          "INV-C06",
          roundTripIdentical &&
            resolved?.evidence.some(
              (entry) =>
                entry.evidenceId === "ev:amb:timeout" &&
                entry.providerState !== undefined &&
                serializeProviderStateEnvelope(entry.providerState) === serialized,
            ) === true &&
            resolved?.providerState !== undefined &&
            serializeProviderStateEnvelope(resolved.providerState) ===
              serializeProviderStateEnvelope(definitive),
          `the ambiguous provider state pi_amb_1@7 is preserved verbatim in the attempt's evidence chain (ev:amb:timeout), the latest provider state is the definitive terminal envelope, and the envelope round-trips losslessly through serialize/parse`,
        ),
      ];

      const recoveryPath = [
        recoveryStep(
          1,
          "Ambiguity surfaced as OUTCOME_UNKNOWN (never FAILED)",
          unknown.state === "OUTCOME_UNKNOWN",
          `attempt att:amb:1 recorded EXTERNAL_OUTCOME_UNKNOWN with the provider's ambiguous envelope as evidence`,
        ),
        recoveryStep(
          2,
          "Blind retry refused",
          blindRetryRejected,
          `requestRetry on the UNKNOWN attempt threw ${blindRetryError}; the write is not re-issued blind`,
        ),
        recoveryStep(
          3,
          "Reconciliation case opened",
          opened.caseId === "case:amb:1",
          `case case:amb:1 (EXTERNAL_AMBIGUITY) opened for attempt att:amb:1`,
        ),
        recoveryStep(
          4,
          "Re-fetch evidence resolves the ambiguity",
          resolved !== undefined &&
            resolved.state === "FAILED" &&
            resolvedCase !== undefined &&
            resolvedCase.status === "RESOLVED",
          `the provider's definitive terminal report (card_declined) resolved the case CONFIRMED_FAILED; the attempt FAILED`,
        ),
        recoveryStep(
          5,
          "Safe retry after resolution",
          retriedSucceeded.state === "SUCCEEDED" && retry.attemptId === "att:amb:retry-1",
          `attempt att:amb:retry-1 (SAFE_TO_RETRY, fresh attemptId, same idempotency scope) START → CONFIRM_SUCCEEDED with execution evidence`,
        ),
      ];

      const evidenceRefs = [
        "att:amb:1",
        "case:amb:1",
        "pi_amb_1@7",
        "att:amb:retry-1",
        "ev:amb:timeout",
        "ev:amb:resolved",
      ];

      return {
        declaration,
        injected: injectionChecks.every((check) => check.ok),
        injectionChecks,
        probes,
        recoveryPath,
        evidenceRefs,
      };
    },
  };
}
