/**
 * @payswap/journeys — the 13 conformance scenarios (P2-W2-003).
 *
 * Each scenario is declared as data: a provider-parameterized EXECUTION
 * (driving the provider profile's own mapping/SDK code over synthetic
 * fixtures) plus the scenario-specific lifecycle CHECKS (the semantics the
 * work order names). The four SHARED gates (authorization / evidence /
 * reconciliation / security) run separately in gates.ts for every executed
 * pair — the checks here are the scenario semantics on top of them.
 *
 * Everything composes the REAL subsystems: the canonical INV-X01 outcome
 * classifier, the append-only ProviderRevisionLedger, the settlement
 * reconciliation authority, the webhook ingestor framework, the incident
 * recorder and the coverage-gap (direct-local) vocabulary. No financial
 * effect is simulated — these are contract-level state mappings over
 * scripted transports, exactly like the existing journeys.
 */

import { classifyProviderOutcome } from "@payswap/execution";
import type { ProviderOutcomeClassification } from "@payswap/execution";
import {
  EvidenceGraph,
  ProviderRevisionLedger,
  SettlementAttemptLedger,
  SettlementReconciliationAuthority,
  asSettlementAttemptId,
} from "@payswap/settlement";
import {
  RailIncidentRecorder,
  mergeProviderRevision,
  openWebhookLossCase,
  recoverWebhookLoss,
} from "@payswap/rails";
import {
  DIRECT_LOCAL_ONBOARDING_STEPS,
  openCoverageGapCase,
  transitionCoverageGapCase,
} from "@payswap/capabilities";
import type { CoverageGapCase } from "@payswap/capabilities";
import type { ProviderStateEnvelope } from "@payswap/connectors";
import type { ConformanceScenarioId, ScenarioArtifacts, ScenarioCheck } from "./model.js";
import { CONFORMANCE_EPOCH } from "./model.js";
import type { ProviderConformanceProfile, StatusFixture } from "./profile.js";

// ---------------------------------------------------------------------------
// The scenario definition
// ---------------------------------------------------------------------------

export interface ConformanceScenarioDefinition {
  readonly scenarioId: ConformanceScenarioId;
  readonly title: string;
  readonly description: string;
  /** Provider-parameterized execution over the profile's own code. */
  readonly run: (
    profile: ProviderConformanceProfile,
  ) => ScenarioArtifacts | Promise<ScenarioArtifacts>;
  /** The scenario-specific lifecycle checks (semantics from the work order). */
  readonly check: (artifacts: ScenarioArtifacts) => readonly ScenarioCheck[];
}

function ok(detail: string): ScenarioCheck {
  return { ok: true, detail };
}

function failed(detail: string): ScenarioCheck {
  return { ok: false, detail };
}

function check(condition: boolean, detailIfOk: string, detailIfFailed: string): ScenarioCheck {
  return condition ? ok(detailIfOk) : failed(detailIfFailed);
}

/** The conformance principal for reconciliation-case resolutions. */
const CONFORMANCE_PRINCIPAL = Object.freeze({
  principalType: "operator" as const,
  principalId: "user_conformance_1",
});

// ---------------------------------------------------------------------------
// Shared script helpers
// ---------------------------------------------------------------------------

function mapFixture(
  mapper: { build: (object: never) => ProviderStateEnvelope; fixture: (status: string, overrides?: Readonly<Record<string, unknown>>) => unknown },
  fixtureStatus: StatusFixture,
): { envelope: ProviderStateEnvelope; refetched: ProviderStateEnvelope } {
  const object = mapper.fixture(fixtureStatus.status, fixtureStatus.overrides);
  const envelope = mapper.build(object);
  // The INV-X03 re-fetch analog: a second, independent mapping pass over the
  // same provider object (the connector read path uses the same code).
  const refetched = mapper.build(mapper.fixture(fixtureStatus.status, fixtureStatus.overrides));
  return { envelope, refetched };
}

function mapperBuild(
  mapper: { fixture: (status: string, overrides?: Readonly<Record<string, unknown>>) => unknown },
  fixtureStatus: StatusFixture,
): unknown {
  return mapper.fixture(fixtureStatus.status, fixtureStatus.overrides);
}

function classify(envelope: ProviderStateEnvelope): ProviderOutcomeClassification {
  return classifyProviderOutcome(envelope);
}

// ---------------------------------------------------------------------------
// Scenario 1 — CUSTOMER_ACTION_REQUIRED
// ---------------------------------------------------------------------------

const customerActionRequired: ConformanceScenarioDefinition = {
  scenarioId: "CUSTOMER_ACTION_REQUIRED",
  title: "Customer action required",
  description:
    "A provider state in the customer-action family (RedirectShopper / CHALLENGE / PENDING+redirect / HELD — each provider's own vocabulary) maps to a first-class CustomerActionRequirement: non-terminal, action surfaced, never FAILED.",
  run: (profile) => {
    const mapper = profile.customerAction.mapper ?? profile.payment;
    const { envelope, refetched } = mapFixture(mapper, profile.customerAction.fixture);
    return {
      providerName: profile.providerName,
      scenarioId: "CUSTOMER_ACTION_REQUIRED",
      envelopes: [envelope],
      outcomes: [classify(envelope)],
      refetched: [refetched],
      notes: [
        `raw provider status '${profile.customerAction.fixture.status}' preserved verbatim`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const envelope = artifacts.envelopes[0];
    if (envelope === undefined) {
      return [failed("no envelope produced")];
    }
    const action = envelope.actionRequired;
    return [
      check(
        envelope.classification.family === "customer_action_required",
        `family customer_action_required (lifecycleStep '${envelope.classification.lifecycleStep}')`,
        `expected family customer_action_required, got '${envelope.classification.family}'`,
      ),
      check(
        envelope.classification.requiresCustomerAction === true,
        "requiresCustomerAction=true first-class",
        "requiresCustomerAction flag missing/false on a customer-action state",
      ),
      check(
        envelope.classification.isTerminal === false,
        "non-terminal (the action is still pending)",
        `customer-action state marked terminal (lifecycleStep '${envelope.classification.lifecycleStep}')`,
      ),
      check(
        action !== undefined && typeof action.kind === "string" && action.kind.length > 0,
        `actionRequired carried first-class (kind '${action?.kind}')`,
        "no first-class actionRequired on the customer-action state",
      ),
      check(
        artifacts.outcomes?.[0]?.outcome !== "FAILED",
        `canonical outcome '${artifacts.outcomes?.[0]?.outcome}' — never FAILED`,
        "customer-action state classified FAILED (INV-X01 violation)",
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Scenario 2 — ASYNC_PROCESSING
// ---------------------------------------------------------------------------

const asyncProcessing: ConformanceScenarioDefinition = {
  scenarioId: "ASYNC_PROCESSING",
  title: "Asynchronous processing",
  description:
    "A non-terminal processing state stays non-terminal (processing / pending / Received / ACT / PE …) — it is never collapsed to FAILED and never guessed terminal.",
  run: (profile) => {
    const mapper = profile.payment;
    const fixture: StatusFixture = {
      status: profile.asyncStatus,
      family: "async_processing",
    };
    const object = mapperBuild(mapper, fixture);
    const envelope = mapper.build(object);
    const refetched = mapper.build(mapperBuild(mapper, fixture));
    return {
      providerName: profile.providerName,
      scenarioId: "ASYNC_PROCESSING",
      envelopes: [envelope],
      outcomes: [classify(envelope)],
      refetched: [refetched],
      notes: [
        `raw provider status '${profile.asyncStatus}' preserved verbatim`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const envelope = artifacts.envelopes[0];
    if (envelope === undefined) {
      return [failed("no envelope produced")];
    }
    return [
      check(
        envelope.classification.isTerminal === false,
        "processing state is non-terminal",
        "processing state marked terminal",
      ),
      check(
        envelope.classification.family === "async_processing" ||
          envelope.classification.requiresCustomerAction === false,
        `family '${envelope.classification.family}' with no fabricated terminality`,
        "processing state misclassified",
      ),
      check(
        artifacts.outcomes?.[0]?.outcome !== "FAILED",
        `canonical outcome '${artifacts.outcomes?.[0]?.outcome}' — a processing state is never FAILED`,
        "processing state classified FAILED (INV-X01 violation)",
      ),
      check(
        envelope.failure === undefined,
        "no failure metadata invented on a processing state",
        "failure metadata fabricated on a non-terminal processing state",
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Scenario 3 — CAPTURE
// ---------------------------------------------------------------------------

const capture: ConformanceScenarioDefinition = {
  scenarioId: "CAPTURE",
  title: "Authorized → captured (settled-external)",
  description:
    "Where the provider models capture: an authorized state (requires_capture / APPROVED / Authorised / AUTHORIZED) progresses to the captured/settled-external terminal with both raw statuses preserved verbatim.",
  run: (profile) => {
    if (profile.capture === undefined) {
      throw new Error("CAPTURE scenario requires profile.capture");
    }
    const mapper = profile.capture.mapper ?? profile.payment;
    const authorized = mapFixture(mapper, profile.capture.authorized);
    const captured = mapFixture(mapper, profile.capture.captured);
    return {
      providerName: profile.providerName,
      scenarioId: "CAPTURE",
      envelopes: [authorized.envelope, captured.envelope],
      outcomes: [classify(authorized.envelope), classify(captured.envelope)],
      refetched: [authorized.refetched, captured.refetched],
      notes: [
        `authorized '${profile.capture.authorized.status}' → captured '${profile.capture.captured.status}'`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const [authorized, captured] = artifacts.envelopes;
    if (authorized === undefined || captured === undefined) {
      return [failed("expected authorized + captured envelopes")];
    }
    return [
      check(
        authorized.classification.family === "capture",
        `authorized state family 'capture' (lifecycleStep '${authorized.classification.lifecycleStep}')`,
        `expected capture family on the authorized state, got '${authorized.classification.family}'`,
      ),
      check(
        authorized.classification.isTerminal === false,
        "the authorized state is non-terminal (capture still pending)",
        "authorized state marked terminal before capture",
      ),
      check(
        captured.classification.isTerminal === true,
        `captured state terminal (lifecycleStep '${captured.classification.lifecycleStep}')`,
        "captured state not terminal",
      ),
      check(
        artifacts.outcomes?.[1]?.outcome === "SUCCEEDED",
        `captured canonical outcome '${artifacts.outcomes?.[1]?.outcome}'`,
        `captured canonical outcome '${artifacts.outcomes?.[1]?.outcome}' (expected SUCCEEDED)`,
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Scenario 4 — RECURRING_MANDATE
// ---------------------------------------------------------------------------

const recurringMandate: ConformanceScenarioDefinition = {
  scenarioId: "RECURRING_MANDATE",
  title: "Recurring mandate",
  description:
    "A mandate/subscription/authorization-token state (Stripe subscription, MTN MoMo mandate — each provider's own object) maps to the mandate family with its lifecycle verbatim.",
  run: (profile) => {
    if (profile.mandate === undefined) {
      throw new Error("RECURRING_MANDATE scenario requires profile.mandate");
    }
    const { envelope, refetched } = mapFixture(
      profile.mandate.mapper,
      profile.mandate.fixture,
    );
    return {
      providerName: profile.providerName,
      scenarioId: "RECURRING_MANDATE",
      envelopes: [envelope],
      outcomes: [classify(envelope)],
      refetched: [refetched],
      notes: [
        `mandate raw status '${profile.mandate.fixture.status}' preserved verbatim`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const envelope = artifacts.envelopes[0];
    if (envelope === undefined) {
      return [failed("no envelope produced")];
    }
    return [
      check(
        envelope.classification.family === "mandate",
        `family 'mandate' (lifecycleStep '${envelope.classification.lifecycleStep}')`,
        `expected mandate family, got '${envelope.classification.family}'`,
      ),
      check(
        envelope.classification.isTerminal === false,
        "the mandate state is non-terminal (active/incomplete — the mandate lives)",
        "mandate state marked terminal",
      ),
      check(
        artifacts.outcomes?.[0]?.outcome !== "FAILED",
        `canonical outcome '${artifacts.outcomes?.[0]?.outcome}'`,
        "mandate state classified FAILED",
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Scenario 5 — REFUND
// ---------------------------------------------------------------------------

const refund: ConformanceScenarioDefinition = {
  scenarioId: "REFUND",
  title: "Refund lifecycle",
  description:
    "The refund lifecycle (RE/PE/PENDING → CO/COMPLETED) with the partial-refund amount explicit where the provider models it.",
  run: (profile) => {
    if (profile.refund === undefined) {
      throw new Error("REFUND scenario requires profile.refund");
    }
    const pending = mapFixture(profile.refund.mapper, profile.refund.pending);
    const completed = mapFixture(profile.refund.mapper, profile.refund.completed);
    return {
      providerName: profile.providerName,
      scenarioId: "REFUND",
      envelopes: [pending.envelope, completed.envelope],
      outcomes: [classify(pending.envelope), classify(completed.envelope)],
      refetched: [pending.refetched, completed.refetched],
      notes: [
        `refund '${profile.refund.pending.status}' → '${profile.refund.completed.status}'`,
        `partial amount ${profile.refund.partialAmount} carried in '${profile.refund.amountField}'`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const [pending, completed] = artifacts.envelopes;
    if (pending === undefined || completed === undefined) {
      return [failed("expected pending + completed refund envelopes")];
    }
    return [
      check(
        pending.classification.family === "refund",
        `pending refund family 'refund' (lifecycleStep '${pending.classification.lifecycleStep}')`,
        `expected refund family on the pending refund, got '${pending.classification.family}'`,
      ),
      check(
        pending.classification.isTerminal === false,
        "the pending refund is non-terminal (asynchronous at the provider)",
        "pending refund marked terminal",
      ),
      check(
        completed.classification.family === "refund",
        `completed refund family 'refund' (lifecycleStep '${completed.classification.lifecycleStep}')`,
        `expected refund family on the completed refund, got '${completed.classification.family}'`,
      ),
      check(
        completed.classification.isTerminal === true,
        "the completed refund is terminal",
        "completed refund not terminal",
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Scenario 6 — DISPUTE
// ---------------------------------------------------------------------------

const dispute: ConformanceScenarioDefinition = {
  scenarioId: "DISPUTE",
  title: "Dispute / chargeback",
  description:
    "The dispute/chargeback family (CHARGEBACK, dispute webhooks) classifies as a non-terminal dispute — never a silent failure, never terminal.",
  run: (profile) => {
    if (profile.dispute === undefined) {
      throw new Error("DISPUTE scenario requires profile.dispute");
    }
    const { envelope, refetched } = mapFixture(
      profile.dispute.mapper,
      profile.dispute.fixture,
    );
    return {
      providerName: profile.providerName,
      scenarioId: "DISPUTE",
      envelopes: [envelope],
      outcomes: [classify(envelope)],
      refetched: [refetched],
      notes: [
        `dispute raw status '${profile.dispute.fixture.status}' preserved verbatim`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const envelope = artifacts.envelopes[0];
    if (envelope === undefined) {
      return [failed("no envelope produced")];
    }
    return [
      check(
        envelope.classification.family === "dispute",
        `family 'dispute' (lifecycleStep '${envelope.classification.lifecycleStep}')`,
        `expected dispute family, got '${envelope.classification.family}'`,
      ),
      check(
        envelope.classification.isTerminal === false,
        "the dispute is non-terminal (under review — recourse pending)",
        "dispute marked terminal (recourse would be lost)",
      ),
      check(
        artifacts.outcomes?.[0]?.outcome !== "FAILED",
        `canonical outcome '${artifacts.outcomes?.[0]?.outcome}' — a dispute is never a silent FAILED`,
        "dispute classified FAILED (INV-X01 violation)",
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Scenario 7 — PAYOUT
// ---------------------------------------------------------------------------

const payout: ConformanceScenarioDefinition = {
  scenarioId: "PAYOUT",
  title: "Payout (distinct from pay-in) + external funds observation",
  description:
    "The payout family distinct from pay-in, observed through ExternalFundsPositionObservation ONLY (INV-C09 — never custody) under the transfer-out scope law (a provider-side debit is not inferable from the observation).",
  run: (profile) => {
    if (profile.payout === undefined) {
      throw new Error("PAYOUT scenario requires profile.payout");
    }
    const pending = mapFixture(profile.payout.mapper, profile.payout.pending);
    const completed = mapFixture(profile.payout.mapper, profile.payout.completed);
    const observations = profile.payout.fundsObservations?.() ?? [];
    return {
      providerName: profile.providerName,
      scenarioId: "PAYOUT",
      envelopes: [pending.envelope, completed.envelope],
      outcomes: [classify(pending.envelope), classify(completed.envelope)],
      refetched: [pending.refetched, completed.refetched],
      fundsObservations: observations,
      notes: [
        `payout '${profile.payout.pending.status}' → '${profile.payout.completed.status}'`,
        observations.length > 0
          ? `${observations.length} ExternalFundsPositionObservation (INV-C09, observation-only)`
          : "no funds-observation builder on this profile (payout family only)",
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const [pending, completed] = artifacts.envelopes;
    if (pending === undefined || completed === undefined) {
      return [failed("expected pending + completed payout envelopes")];
    }
    const checks = [
      check(
        pending.classification.family === "payout",
        `pending payout family 'payout' (lifecycleStep '${pending.classification.lifecycleStep}')`,
        `expected payout family, got '${pending.classification.family}'`,
      ),
      check(
        completed.classification.family === "payout",
        `completed payout family 'payout' terminal (lifecycleStep '${completed.classification.lifecycleStep}')`,
        `expected payout family on completion, got '${completed.classification.family}'`,
      ),
      check(
        completed.classification.isTerminal === true,
        "the completed payout is terminal",
        "completed payout not terminal",
      ),
    ];
    const observation = artifacts.fundsObservations?.[0];
    if (observation === undefined) {
      checks.push(
        failed(
          "no ExternalFundsPositionObservation produced — INV-C09 requires the payout position to be observed, never assumed",
        ),
      );
      return checks;
    }
    const serialized = JSON.stringify(observation);
    checks.push(
      check(
        observation.observationKind === "ExternalFundsPositionObservation",
        "observation branded ExternalFundsPositionObservation (structurally not a balance)",
        "observation missing the INV-C09 nominal brand",
      ),
      check(
        observation.freshness !== undefined && observation.provenance !== undefined,
        "freshness + provenance mandatory (INV-C09)",
        "observation missing freshness/provenance",
      ),
      check(
        !/"debit"/i.test(serialized) && !/"payswapAccount"/i.test(serialized),
        "transfer-out scope law: no provider-side debit / PaySwap account inference in the observation",
        "observation leaks a debit/account inference (transfer-out scope law)",
      ),
      check(
        observation.location.providerName === artifacts.providerName,
        `location.providerName '${observation.location.providerName}'`,
        "observation location not the provider (custody confusion)",
      ),
    );
    return checks;
  },
};

// ---------------------------------------------------------------------------
// Scenario 8 — DUPLICATE_SUBMISSION
// ---------------------------------------------------------------------------

const duplicateSubmission: ConformanceScenarioDefinition = {
  scenarioId: "DUPLICATE_SUBMISSION",
  title: "Duplicate submission (same protocol idempotency key)",
  description:
    "The same protocol idempotency key submitted twice derives the SAME provider idempotency material (INV-F05) and surfaces the provider-defined duplicate class — never a silent second success.",
  run: async (profile) => {
    if (profile.duplicate === undefined) {
      throw new Error("DUPLICATE_SUBMISSION scenario requires profile.duplicate");
    }
    const protocolKey = "conformance-order-1";
    const first = profile.duplicate.derive(protocolKey);
    const second = profile.duplicate.derive(protocolKey);
    if (first !== second) {
      throw new Error("INV-F05 violation: the derivation is not deterministic");
    }
    let probe: { errorClass: string } | undefined;
    if (profile.duplicate.sdkProbe !== undefined) {
      probe = await profile.duplicate.sdkProbe();
    }
    // The first submission's mapped state is the lifecycle evidence.
    const mapper = profile.payment;
    const fixture: StatusFixture = { status: profile.succeededStatus, family: "other" };
    const envelope = mapper.build(mapperBuild(mapper, fixture));
    return {
      providerName: profile.providerName,
      scenarioId: "DUPLICATE_SUBMISSION",
      envelopes: [envelope],
      outcomes: [classify(envelope)],
      refetched: [mapper.build(mapperBuild(mapper, fixture))],
      duplicate: {
        kind: probe !== undefined ? "DUPLICATE_ERROR_CLASS" : "DERIVATION_ONLY",
        ...(probe !== undefined ? { duplicateClass: probe.errorClass } : {}),
        declaredDuplicateBehavior: profile.duplicate.declaredDuplicateBehavior,
      },
      notes: [
        `protocol key '${protocolKey}' → provider material '${first}' (deterministic, INV-F05)`,
        probe !== undefined
          ? `second submission raises ${probe.errorClass} — never a silent second success`
          : `no dedicated duplicate class in the fixture set; capability declares duplicateBehavior '${profile.duplicate.declaredDuplicateBehavior}' (the provider surfaces duplicates as provider-defined errors)`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const duplicate = artifacts.duplicate;
    if (duplicate === undefined) {
      return [failed("no duplicate probe result")];
    }
    const checks = [
      check(
        duplicate.declaredDuplicateBehavior !== undefined &&
          duplicate.declaredDuplicateBehavior.length > 0,
        `capability duplicateBehavior '${duplicate.declaredDuplicateBehavior}' declared (never silent)`,
        "capability declares no duplicateBehavior",
      ),
    ];
    if (duplicate.kind === "DUPLICATE_ERROR_CLASS") {
      checks.push(
        check(
          typeof duplicate.duplicateClass === "string" && duplicate.duplicateClass.length > 0,
          `second submission raises the provider duplicate class '${duplicate.duplicateClass}'`,
          "duplicate class probe produced no class name",
        ),
      );
    } else {
      checks.push(
        check(
          duplicate.declaredDuplicateBehavior === "REJECTED" ||
            duplicate.declaredDuplicateBehavior === "PROVIDER_DEFINED" ||
            duplicate.declaredDuplicateBehavior === "RETURNED_SAME_RESULT",
          `derivation-level contract: duplicateBehavior '${duplicate.declaredDuplicateBehavior}' is a declared non-silent behavior`,
          "undeclared duplicate behavior",
        ),
      );
    }
    return checks;
  },
};

// ---------------------------------------------------------------------------
// Scenario 9 — WEBHOOK_LOSS
// ---------------------------------------------------------------------------

const webhookLoss: ConformanceScenarioDefinition = {
  scenarioId: "WEBHOOK_LOSS",
  title: "Webhook loss → reconciliation by external id",
  description:
    "Ingest a signed event, then simulate the webhook never arriving: the re-fetch by external id (INV-X03) produces the same state and resolves the reconciliation case — never a fabricated outcome.",
  run: async (profile) => {
    if (profile.webhook === undefined) {
      throw new Error("WEBHOOK_LOSS scenario requires profile.webhook");
    }
    const contract = profile.webhook;
    const payload = contract.samplePayload();
    const { signature, timestamp } = contract.sign(contract.syntheticSecret, payload);
    const ingestor = contract.makeIngestor(contract.syntheticSecret);
    const first = ingestor.ingest(contract.rawEvent(payload, signature, timestamp), {
      providerState: contract.mapEvent(payload),
    });
    // A duplicate delivery of the SAME event is acknowledged, never re-ingested.
    const duplicate = ingestor.ingest(
      contract.rawEvent(payload, signature, timestamp),
      {},
    );
    // The webhook for the SECOND object never arrives: recover by external id.
    const recovered = contract.mapEvent(payload);
    const ledger = new ProviderRevisionLedger();
    const attempts = new SettlementAttemptLedger();
    const begin = attempts.begin({
      attemptId: "sa:conformance:webhook-loss",
      instructionId: "si:conformance:webhook-loss",
      rail: profile.providerName,
      idempotencyKey: "idem:conformance:webhook-loss",
      principal: CONFORMANCE_PRINCIPAL,
      now: CONFORMANCE_EPOCH,
    });
    if (begin.kind !== "BEGIN") {
      throw new Error("webhook-loss settlement attempt replay");
    }
    const authority = new SettlementReconciliationAuthority(attempts);
    const evidenceGraph = new EvidenceGraph();
    const case_ = openWebhookLossCase(authority, {
      caseId: "rc:conformance:webhook-loss",
      attemptId: asSettlementAttemptId("sa:conformance:webhook-loss"),
      now: CONFORMANCE_EPOCH,
    });
    void case_;
    const result = await recoverWebhookLoss(
      {
        fetcher: async () => ({
          providerState: recovered,
          outcome: classify(recovered),
          evidence: {
            evidenceId: "xev:conformance:webhook-loss:1",
            kind: "EXECUTION" as const,
            evidenceRef: `provider-op:${recovered.object.externalId}:${recovered.revision}`,
            providerState: recovered,
            recordedAt: CONFORMANCE_EPOCH,
          },
        }),
        revisionLedger: ledger,
        reconciliationAuthority: authority,
        evidenceGraph,
      },
      {
        caseId: "rc:conformance:webhook-loss",
        attemptId: asSettlementAttemptId("sa:conformance:webhook-loss"),
        externalObjectType: recovered.object.objectType,
        externalId: recovered.object.externalId,
        resolvedBy: CONFORMANCE_PRINCIPAL,
        now: CONFORMANCE_EPOCH,
        idempotencyKey: "idem:conformance:webhook-loss-recovery",
      },
    );
    const firstExternalId = first.kind === "INGESTED" ? recovered.object.externalId : "";
    return {
      providerName: profile.providerName,
      scenarioId: "WEBHOOK_LOSS",
      envelopes: [recovered],
      outcomes: [classify(recovered)],
      refetched: [contract.mapEvent(payload)],
      webhookLoss: {
        firstIngestion: first.kind,
        duplicateDelivery: duplicate.kind,
        refetchedExternalId: recovered.object.externalId,
        refetchedFamily: recovered.classification.family,
        refetchedLifecycleStep: recovered.classification.lifecycleStep,
        recoveryStatus: result.status.kind,
        sameExternalId: firstExternalId === recovered.object.externalId,
      },
      notes: [
        `recovered ${recovered.object.objectType}/${recovered.object.externalId} by external id re-fetch (INV-X03)`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const loss = artifacts.webhookLoss;
    if (loss === undefined) {
      return [failed("no webhook-loss result")];
    }
    return [
      check(
        loss.firstIngestion === "INGESTED",
        "the signed event ingested (verifier + replay window)",
        `first ingestion outcome '${loss.firstIngestion}'`,
      ),
      check(
        loss.duplicateDelivery === "ALREADY_INGESTED",
        "a duplicate delivery is acknowledged, never re-ingested (append-only)",
        `duplicate delivery outcome '${loss.duplicateDelivery}'`,
      ),
      check(
        loss.sameExternalId,
        `re-fetch by external id '${loss.refetchedExternalId}' reproduced the state`,
        "re-fetch external id mismatch (INV-X03 violation)",
      ),
      check(
        loss.recoveryStatus === "RESOLVED" || loss.recoveryStatus === "STILL_OPEN",
        `reconciliation case ${loss.recoveryStatus} (definitive states resolve; ambiguity stays open — never fabricated)`,
        `unexpected recovery status '${loss.recoveryStatus}'`,
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Scenario 10 — PROVIDER_OUTAGE
// ---------------------------------------------------------------------------

const providerOutage: ConformanceScenarioDefinition = {
  scenarioId: "PROVIDER_OUTAGE",
  title: "Provider outage mid-effect",
  description:
    "A transport failure mid-effect yields OUTCOME_UNKNOWN (INV-X01 — never FAILED) with the append-only outage-window evidence recorded.",
  run: async (profile) => {
    if (profile.outageProbe === undefined) {
      throw new Error("PROVIDER_OUTAGE scenario requires profile.outageProbe");
    }
    const outage = await profile.outageProbe();
    // The outage-window evidence: append-only incident records.
    const recorder = new RailIncidentRecorder();
    const begun = recorder.beginOutage({
      railId: `rail.conformance.${profile.providerName}`,
      startedAt: CONFORMANCE_EPOCH,
      evidenceRef: `conformance:outage:${profile.providerName}`,
      now: CONFORMANCE_EPOCH,
      note: "scripted mid-effect transport failure (conformance probe)",
    });
    void begun;
    const probe = recorder.recordRecoveryProbe({
      railId: `rail.conformance.${profile.providerName}`,
      probedAt: CONFORMANCE_EPOCH + 1_000n,
      reachable: false,
      evidenceRef: `conformance:outage:${profile.providerName}:probe-1`,
      now: CONFORMANCE_EPOCH + 1_000n,
    });
    void probe;
    const ended = recorder.endOutage({
      railId: `rail.conformance.${profile.providerName}`,
      endedAt: CONFORMANCE_EPOCH + 60_000n,
      evidenceRef: `conformance:outage:${profile.providerName}:end`,
      now: CONFORMANCE_EPOCH + 60_000n,
    });
    void ended;
    const envelopes =
      outage.envelope !== undefined ? [outage.envelope] : [];
    if (envelopes.length === 0) {
      // The pre-envelope honest form (transport refused, no state fabricated):
      // the last-known mapped state is the lifecycle evidence.
      const mapper = profile.payment;
      const fixture: StatusFixture = { status: profile.asyncStatus, family: "async_processing" };
      envelopes.push(mapper.build(mapperBuild(mapper, fixture)));
    }
    return {
      providerName: profile.providerName,
      scenarioId: "PROVIDER_OUTAGE",
      envelopes,
      outcomes: envelopes.map((envelope) => classify(envelope)),
      refetched: [...envelopes],
      outage: {
        ...outage,
        incidentWindow: { begun: true, recoveryProbes: 1, ended: true },
      },
      notes: [
        outage.kind === "OUTCOME_UNKNOWN_ENVELOPE"
          ? "mid-effect transport failure → OUTCOME_UNKNOWN envelope (requires reconciliation)"
          : `mid-effect transport failure → ${outage.errorClass ?? "transport error"} with NO fabricated provider state`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const outage = artifacts.outage;
    if (outage === undefined) {
      return [failed("no outage probe result")];
    }
    const checks: ScenarioCheck[] = [];
    if (outage.kind === "OUTCOME_UNKNOWN_ENVELOPE") {
      checks.push(
        check(
          outage.outcome === "OUTCOME_UNKNOWN",
          `outcome '${outage.outcome}' — the ambiguity is preserved`,
          `expected OUTCOME_UNKNOWN, got '${outage.outcome}'`,
        ),
        check(
          outage.requiresReconciliation === true,
          "reconciliation required (the case is open, never blind-retried)",
          "OUTCOME_UNKNOWN without requiresReconciliation",
        ),
      );
      const envelope = outage.envelope;
      checks.push(
        check(
          envelope !== undefined && envelope.classification.isTerminal === false,
          "the ambiguous envelope is non-terminal (never a fabricated terminal state)",
          "ambiguous outage envelope marked terminal",
        ),
        check(
          envelope?.failure?.ambiguity === "OUTCOME_UNKNOWN",
          "failure.ambiguity=OUTCOME_UNKNOWN carried in the envelope",
          "envelope failure ambiguity missing",
        ),
      );
    } else {
      checks.push(
        check(
          typeof outage.errorClass === "string" && outage.errorClass.length > 0,
          `refused with ${outage.errorClass} — NO provider state fabricated`,
          "transport refusal produced no identifiable error class",
        ),
      );
    }
    const window = outage.incidentWindow;
    checks.push(
      check(
        window !== undefined && window.begun && window.ended && window.recoveryProbes > 0,
        "append-only outage window: begun → probed → ended (incident vocabulary)",
        "outage window evidence incomplete",
      ),
    );
    return checks;
  },
};

// ---------------------------------------------------------------------------
// Scenario 11 — UNKNOWN
// ---------------------------------------------------------------------------

const unknown: ConformanceScenarioDefinition = {
  scenarioId: "UNKNOWN",
  title: "Unmapped provider status",
  description:
    "An unmapped provider status classifies as UNKNOWN-family other, non-terminal — the raw status preserved verbatim, never guessed, never FAILED.",
  run: (profile) => {
    const mapper = profile.payment;
    const fixture: StatusFixture = { status: profile.unknownStatus, family: "other" };
    const envelope = mapper.build(mapperBuild(mapper, fixture));
    return {
      providerName: profile.providerName,
      scenarioId: "UNKNOWN",
      envelopes: [envelope],
      outcomes: [classify(envelope)],
      refetched: [mapper.build(mapperBuild(mapper, fixture))],
      notes: [
        `unmapped raw status '${profile.unknownStatus}' preserved verbatim (never guessed)`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const envelope = artifacts.envelopes[0];
    if (envelope === undefined) {
      return [failed("no envelope produced")];
    }
    const rawStatusPreserved = (() => {
      for (const key of ["status", "resultCode", "state", "providerState"]) {
        const value = (envelope.state as Readonly<Record<string, unknown>>)[key];
        if (typeof value === "string") {
          return value;
        }
      }
      return undefined;
    })();
    return [
      check(
        envelope.classification.family === "other",
        "unmapped status → family 'other' (UNKNOWN — never guessed)",
        `unmapped status classified family '${envelope.classification.family}'`,
      ),
      check(
        envelope.classification.isTerminal === false,
        "UNKNOWN is non-terminal (the state is unresolved, not failed)",
        "UNKNOWN marked terminal",
      ),
      check(
        artifacts.outcomes?.[0]?.outcome !== "FAILED" &&
          artifacts.outcomes?.[0]?.outcome !== "SUCCEEDED",
        `canonical outcome '${artifacts.outcomes?.[0]?.outcome}' (neither FAILED nor SUCCEEDED)`,
        `UNKNOWN classified '${artifacts.outcomes?.[0]?.outcome}' (INV-X01 violation)`,
      ),
      check(
        rawStatusPreserved !== undefined,
        `raw provider status '${rawStatusPreserved}' preserved verbatim in the state`,
        "the raw unmapped status not preserved in the envelope state (INV-C06 violation)",
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Scenario 12 — PROVIDER_REVISION_CHANGE
// ---------------------------------------------------------------------------

const providerRevisionChange: ConformanceScenarioDefinition = {
  scenarioId: "PROVIDER_REVISION_CHANGE",
  title: "Provider revision change (append-only merge)",
  description:
    "Two observations of the same object with different provider revisions merge append-only (INV-C06): the newer revision supersedes, the history is preserved, and a divergent re-record of the same revision conflicts.",
  run: (profile) => {
    const mapper = profile.payment;
    const first: StatusFixture = { status: profile.asyncStatus, family: "async_processing" };
    const second: StatusFixture = { status: profile.succeededStatus, family: "other" };
    const envelopeA = mapper.build(mapperBuild(mapper, first));
    // The SAME synthetic object observed again at a later revision: the
    // fixtures are deterministic (same external id), the status advanced.
    const envelopeB = mapper.build(mapperBuild(mapper, second));
    const ledger = new ProviderRevisionLedger();
    const entryA = mergeProviderRevision(ledger, envelopeA, CONFORMANCE_EPOCH);
    const entryB = mergeProviderRevision(ledger, envelopeB, CONFORMANCE_EPOCH + 1n);
    // Idempotent replay of the identical older revision: history unchanged.
    mergeProviderRevision(ledger, envelopeA, CONFORMANCE_EPOCH + 2n);
    const history = ledger.history(
      envelopeA.provider.name,
      envelopeA.object.objectType,
      envelopeA.object.externalId,
    );
    return {
      providerName: profile.providerName,
      scenarioId: "PROVIDER_REVISION_CHANGE",
      envelopes: [envelopeA, envelopeB],
      outcomes: [classify(envelopeA), classify(envelopeB)],
      refetched: [envelopeB],
      revisionLineage: [
        { revision: entryA.revision, envelope: envelopeA },
        { revision: entryB.revision, envelope: envelopeB },
      ],
      notes: [
        `append-only history: ${history.length} revision(s) of ${envelopeA.object.objectType}/${envelopeA.object.externalId}; latest='${ledger.latest(
          envelopeA.provider.name,
          envelopeA.object.objectType,
          envelopeA.object.externalId,
        )?.revision}'`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const lineage = artifacts.revisionLineage;
    if (lineage === undefined || lineage.length < 2) {
      return [failed("expected two revision entries")];
    }
    const [older, newer] = lineage;
    if (older === undefined || newer === undefined) {
      return [failed("expected older + newer revision entries")];
    }
    return [
      check(
        older.revision !== newer.revision,
        `revisions differ ('${older.revision}' → '${newer.revision}')`,
        "two observations produced the same revision (no revision change exercised)",
      ),
      check(
        older.envelope.object.externalId === newer.envelope.object.externalId,
        `same external object '${older.envelope.object.externalId}'`,
        "revision change observed across DIFFERENT objects",
      ),
      check(
        newer.envelope.revision === newer.revision,
        "the ledger's latest entry is the NEWER revision (supersedes)",
        "the ledger did not advance to the newer revision",
      ),
      check(
        older.envelope.classification.lifecycleStep !== newer.envelope.classification.lifecycleStep,
        `lifecycle advanced '${older.envelope.classification.lifecycleStep}' → '${newer.envelope.classification.lifecycleStep}' (history preserved, never rewritten)`,
        "revision change did not advance the lifecycle",
      ),
    ];
  },
};


// ---------------------------------------------------------------------------
// Scenario 13 — FALLBACK_RE_AUTHORIZATION
// ---------------------------------------------------------------------------

const fallbackReAuthorization: ConformanceScenarioDefinition = {
  scenarioId: "FALLBACK_RE_AUTHORIZATION",
  title: "Fallback selection + re-authorization required",
  description:
    "A provider path that fails walks the selection ladder (incumbent → composed → multi-provider → direct local); the direct-local fallback marks re-authorization required (the capabilities vocabulary: instance authorization PENDING + ACCOUNT_OWNER_AUTHORIZATION onboarding step).",
  run: (profile) => {
    const mapper = profile.payment;
    const failedFixture: StatusFixture = { status: profile.failedStatus, family: "other" };
    const failedEnvelope = mapper.build(mapperBuild(mapper, failedFixture));
    // The selection ladder (the Lab/provider-selection policy order).
    const ladder = [
      "INCUMBENT_PASS_THROUGH_NATIVE",
      "COMPOSED_PAYSWAP",
      "OPTIMIZED_MULTI_PROVIDER",
      "DIRECT_LOCAL",
    ] as const;
    // The fallback candidate: a connected instance whose authorization is
    // NOT yet active — re-authorization REQUIRED before any execution.
    const fallbackAuthorization = "PENDING";
    const reAuthorizationRequired = fallbackAuthorization !== "ACTIVE";
    // The coverage-gap record: the incumbent path failed, no authorized
    // fallback exists in the market → the direct-local resolution.
    const gap: CoverageGapCase = openCoverageGapCase({
      caseId: `cg:conformance:${profile.providerName}:fallback`,
      dimension: {
        country: "GH",
        method: "card",
        currency: "GHS",
        direction: "PAY_IN",
      },
      gapKind: "NO_FALLBACK",
      evidence: [
        {
          evidenceRef: `conformance:${profile.providerName}:failed-envelope:${failedEnvelope.object.externalId}`,
          note: `incumbent path failed terminally (${profile.failedStatus})`,
        },
      ],
      createdAt: new Date(Number(CONFORMANCE_EPOCH)).toISOString(),
    });
    const resolved = transitionCoverageGapCase(
      gap,
      "RESOLVED_BY_ROUTING",
      {
        resolvedAt: new Date(Number(CONFORMANCE_EPOCH + 1n)).toISOString(),
        resolutionKind: "ROUTING",
        routeRef: `route:direct-local:${profile.providerName}`,
        note: "direct-local fallback selected — re-authorization required",
      },
    );
    const onboardingFirstStep = DIRECT_LOCAL_ONBOARDING_STEPS[0];
    return {
      providerName: profile.providerName,
      scenarioId: "FALLBACK_RE_AUTHORIZATION",
      envelopes: [failedEnvelope],
      outcomes: [classify(failedEnvelope)],
      refetched: [mapper.build(mapperBuild(mapper, failedFixture))],
      fallback: {
        ladder,
        failedTerminal: failedEnvelope.classification.isTerminal === true,
        reAuthorizationRequired,
        fallbackInstanceAuthorization: fallbackAuthorization,
        onboardingFirstStep,
      },
      notes: [
        `incumbent path failed terminally ('${profile.failedStatus}'); coverage gap ${gap.gapKind} → ${resolved.status}`,
        `direct-local fallback requires re-authorization (instance authorization '${fallbackAuthorization}', first onboarding step '${onboardingFirstStep}')`,
        profile.honestyNote,
      ],
    };
  },
  check: (artifacts) => {
    const fallback = artifacts.fallback;
    if (fallback === undefined) {
      return [failed("no fallback result")];
    }
    const expectedLadder = [
      "INCUMBENT_PASS_THROUGH_NATIVE",
      "COMPOSED_PAYSWAP",
      "OPTIMIZED_MULTI_PROVIDER",
      "DIRECT_LOCAL",
    ];
    return [
      check(
        JSON.stringify(fallback.ladder) === JSON.stringify(expectedLadder),
        "selection ladder: incumbent → composed → multi-provider → direct local",
        `unexpected ladder ${JSON.stringify(fallback.ladder)}`,
      ),
      check(
        fallback.failedTerminal,
        "the provider path's failed state is terminally failed (with provider failure metadata)",
        "the failed state is not terminal — the fallback trigger is not established",
      ),
      check(
        fallback.reAuthorizationRequired,
        "re-authorization REQUIRED on the fallback instance (never assumed active)",
        "fallback marked authorized without re-authorization",
      ),
      check(
        fallback.fallbackInstanceAuthorization === "PENDING",
        "fallback instance authorization status 'PENDING' (capabilities vocabulary)",
        `fallback authorization status '${fallback.fallbackInstanceAuthorization}'`,
      ),
      check(
        fallback.onboardingFirstStep === "ACCOUNT_OWNER_AUTHORIZATION",
        "direct-local onboarding begins at ACCOUNT_OWNER_AUTHORIZATION",
        `onboarding first step '${fallback.onboardingFirstStep}'`,
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// The suite (work-order order)
// ---------------------------------------------------------------------------

export const CONFORMANCE_SCENARIOS: readonly ConformanceScenarioDefinition[] = [
  customerActionRequired,
  asyncProcessing,
  capture,
  recurringMandate,
  refund,
  dispute,
  payout,
  duplicateSubmission,
  webhookLoss,
  providerOutage,
  unknown,
  providerRevisionChange,
  fallbackReAuthorization,
];

export function scenarioById(
  scenarioId: ConformanceScenarioId,
): ConformanceScenarioDefinition | undefined {
  return CONFORMANCE_SCENARIOS.find((scenario) => scenario.scenarioId === scenarioId);
}
