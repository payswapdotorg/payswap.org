/**
 * @payswap/operations — browser-journey verification contracts (W3-007).
 *
 * Authority: spec/architecture/FRONTEND-UX-DEPLOYMENT.md ("Browser
 * verification") + spec/experience/DEPLOYMENT-TOPOLOGY.md §6 gate 7:
 * every UI Work Order includes desktop verification, responsive/mobile
 * verification, a console-error check, key interaction verification, a
 * screenshot artifact, and evidence of real API/protocol wiring.
 *
 * This module is the CONTRACT + DETERMINISTIC CHECKER layer — NOT a live
 * browser driver. The package paradigm is data + contracts + checkers: at
 * test time there is no network and no browser. What this module does:
 *
 * - declares one `BrowserJourneyContract` per MAJOR JOURNEY — the six
 *   @payswap/ux payment journeys (the view-model state machines that own
 *   the browser surfaces) plus the twelve @payswap/journeys W1-007
 *   certification journeys (the end-to-end economic paths the browser
 *   surfaces must exhibit);
 * - CHECKS those contracts against the ACTUAL view-models: every
 *   key-interaction's expected state exists in the journey's declared
 *   state table (`PAYMENT_JOURNEY_STATES`), the UNKNOWN-relevant journeys
 *   render reconciling with the reconciliation path surfaced (INV-X01 —
 *   UNKNOWN is never rendered as failure), and every screenshot artifact's
 *   provenance strength is bounded below authenticated evidence (INV-E04 —
 *   UI/browser artifacts are not stronger than their authenticated
 *   provenance);
 * - records verification RUNS as deterministic artifacts (a run report
 *   with a content digest) that the deployment gate consumes.
 *
 * Deterministic only: pure functions over imported contract data; no DOM,
 * no network, no screenshots at check time.
 */

import { JOURNEYS } from "@payswap/journeys";
import {
  PAYMENT_JOURNEY_STATES,
  renderTerminalHonestView,
} from "@payswap/ux";

import { contentDigest } from "./digest.js";

/** The terminal-state type of the UX honest-state view, derived type-level. */
export type TerminalUiState = Parameters<typeof renderTerminalHonestView>[0];

/**
 * Runtime guard for the terminal-state vocabulary of the honest-state
 * layer. Non-terminal UX journey states (e.g. `REVIEWING_TERMS`) are
 * verified against the journey state table instead.
 */
export function isTerminalUiState(value: string): value is TerminalUiState {
  return (
    value === "FULFILLED" ||
    value === "WAITING" ||
    value === "USER_ACTION_REQUIRED" ||
    value === "NO_VIABLE_ROUTE" ||
    value === "COMPLIANCE_BLOCKED" ||
    value === "EXPIRED" ||
    value === "CANCELLED" ||
    value === "FAILED" ||
    value === "UNKNOWN"
  );
}

// ---------------------------------------------------------------------------
// The six required checks per FRONTEND-UX-DEPLOYMENT "Browser verification"
// ---------------------------------------------------------------------------

export const BROWSER_VERIFICATION_CHECKS = [
  "desktop-verification",
  "responsive-mobile-verification",
  "console-error-check",
  "key-interaction-verification",
  "screenshot-artifact",
  "real-api-wiring-evidence",
] as const;
export type BrowserVerificationCheck =
  (typeof BROWSER_VERIFICATION_CHECKS)[number];

/**
 * INV-E04: a screenshot is browser-generated evidence with UNAUTHENTICATED
 * provenance — it can never be stronger than authenticated protocol
 * evidence. The contract makes the ceiling structural.
 */
export const SCREENSHOT_EVIDENCE_STRENGTH =
  "BROWSER_UNAUTHENTICATED_PROVENANCE" as const;

// ---------------------------------------------------------------------------
// The journey verification contract
// ---------------------------------------------------------------------------

/** One key interaction a browser run must drive and observe. */
export interface KeyInteraction {
  readonly interactionId: string;
  readonly description: string;
  /** The journey state the surface MUST reach when the interaction fires. */
  readonly expectedJourneyState: string;
  /**
   * The protocol-ID the emitted event correlates to — browser wiring
   * evidence must bind to a protocol identifier, never to a DOM artifact.
   */
  readonly correlatedProtocolId: string;
}

/** How a contract handles UNKNOWN outcomes (INV-X01). */
export type UnknownHandling =
  | {
      readonly applies: true;
      /** The honest view must render reconciling — never failure. */
      readonly rendersAs: "reconciling";
      /** The reconciliation/action path must be surfaced in the UI. */
      readonly reconciliationPathSurfaced: true;
      readonly notApplicableReason?: undefined;
    }
  | {
      readonly applies: false;
      readonly rendersAs?: undefined;
      readonly reconciliationPathSurfaced?: undefined;
      readonly notApplicableReason: string;
    };

/** One major-journey browser verification contract. */
export interface BrowserJourneyContract {
  readonly journeyId: string;
  readonly title: string;
  /** Which @payswap/ux view-model family backs the browser surface. */
  readonly source: "UX_PAYMENT_JOURNEY" | "W1_007_CERTIFICATION_JOURNEY";
  /** The information-architecture surface hosting the journey. */
  readonly surface: string;
  /** Must declare exactly the six required checks. */
  readonly requiredChecks: readonly BrowserVerificationCheck[];
  readonly keyInteractions: readonly KeyInteraction[];
  readonly unknownHandling: UnknownHandling;
  readonly screenshotArtifact: {
    readonly evidenceId: string;
    readonly strength: typeof SCREENSHOT_EVIDENCE_STRENGTH;
  };
}

// ---------------------------------------------------------------------------
// Contracts for the six @payswap/ux payment journeys (browser surfaces)
// ---------------------------------------------------------------------------

const UX_JOURNEY_IDS = PAYMENT_JOURNEY_STATES.map((spec) => spec.journeyId);

function paymentJourneyContract(
  journeyId: (typeof UX_JOURNEY_IDS)[number],
  title: string,
  surface: string,
  keyInteractions: readonly KeyInteraction[],
  unknownHandling: UnknownHandling,
): BrowserJourneyContract {
  return {
    journeyId,
    title,
    source: "UX_PAYMENT_JOURNEY",
    surface,
    requiredChecks: [...BROWSER_VERIFICATION_CHECKS],
    keyInteractions,
    unknownHandling,
    screenshotArtifact: {
      evidenceId: `screenshot:${journeyId}`,
      strength: SCREENSHOT_EVIDENCE_STRENGTH,
    },
  };
}

/** The six UX payment-journey browser contracts. */
export const UX_PAYMENT_JOURNEY_CONTRACTS: readonly BrowserJourneyContract[] =
  Object.freeze([
    paymentJourneyContract(
      "choose-or-delegate-payment",
      "Choose or delegate a payment",
      "Payments",
      [
        {
          interactionId: "choose-method",
          description:
            "Select one of the recommended payment methods (each carries authoritative reasons); surface reaches REVIEWING_TERMS.",
          expectedJourneyState: "REVIEWING_TERMS",
          correlatedProtocolId: "attemptId",
        },
        {
          interactionId: "approve-terms",
          description:
            "Approve the reviewed material terms; journey submits through the validated RequestEnvelope (idempotency key, INV-F05).",
          expectedJourneyState: "SUBMITTED",
          correlatedProtocolId: "commandId",
        },
        {
          interactionId: "delegate-to-agent",
          description:
            "Delegate the choice to the user agent inside its attenuated grant; surface reaches DELEGATED_TO_AGENT.",
          expectedJourneyState: "DELEGATED_TO_AGENT",
          correlatedProtocolId: "commandId",
        },
      ],
      {
        applies: false,
        notApplicableReason:
          "Method choice and delegation render determinate authority states; ambiguity surfaces enter through the honest execution views instead.",
      },
    ),
    paymentJourneyContract(
      "switch-or-fallback-payment",
      "Switch or fallback payment",
      "Payments",
      [
        {
          interactionId: "evaluate-switch",
          description:
            "Trigger switch evaluation; a switch that changes material terms must land on REAUTHORIZATION_REQUIRED — never a silent switch.",
          expectedJourneyState: "REAUTHORIZATION_REQUIRED",
          correlatedProtocolId: "attemptId",
        },
        {
          interactionId: "approve-fallback",
          description:
            "Approve the fallback after the explicit term-change disclosure; surface reaches SWITCHED.",
          expectedJourneyState: "SWITCHED",
          correlatedProtocolId: "settlementId",
        },
      ],
      {
        applies: false,
        notApplicableReason:
          "Fallback authorization is a determinate approval flow; the underlying execution ambiguity is owned by the honest execution views.",
      },
    ),
    paymentJourneyContract(
      "manage-recurring-mandate",
      "Manage a recurring mandate",
      "Payments",
      [
        {
          interactionId: "record-mandate-event",
          description:
            "Record a mandate lifecycle event (pause/resume/cancel) through the mandate authority; surface reaches MANDATE_EVENT_RECORDED.",
          expectedJourneyState: "MANDATE_EVENT_RECORDED",
          correlatedProtocolId: "eventId",
        },
        {
          interactionId: "approve-new-mandate",
          description:
            "Approve a new mandate version through the trusted approval surface; surface reaches AWAITING_NEW_MANDATE_APPROVAL.",
          expectedJourneyState: "AWAITING_NEW_MANDATE_APPROVAL",
          correlatedProtocolId: "commandId",
        },
      ],
      {
        applies: false,
        notApplicableReason:
          "Mandate state folds consume the mandate authority's own state machine; mandate renewal ambiguity reconciles through the mandate reconciliation path.",
      },
    ),
    paymentJourneyContract(
      "reconcile-invoice-order-project",
      "Reconcile invoice to order and project",
      "Collections",
      [
        {
          interactionId: "submit-allocation",
          description:
            "Allocate the invoice amount across order and project lines; a mismatch blocks at ALLOCATION_MISMATCH with the discrepancy shown.",
          expectedJourneyState: "ALLOCATION_MISMATCH",
          correlatedProtocolId: "obligationId",
        },
        {
          interactionId: "confirm-allocation",
          description:
            "Resolve the mismatch and confirm the full allocation; surface reaches ALLOCATED.",
          expectedJourneyState: "ALLOCATED",
          correlatedProtocolId: "obligationId",
        },
      ],
      {
        applies: false,
        notApplicableReason:
          "Document allocation is exact and deterministic; ambiguity is owned by the off-network record journey.",
      },
    ),
    paymentJourneyContract(
      "initiate-refund-or-dispute",
      "Initiate a refund or dispute",
      "Disputes",
      [
        {
          interactionId: "submit-request",
          description:
            "Submit the refund or dispute request; surface reaches REQUEST_SUBMITTED with the recourse obligation referenced.",
          expectedJourneyState: "REQUEST_SUBMITTED",
          correlatedProtocolId: "obligationId",
        },
        {
          interactionId: "eligibility-unknown",
          description:
            "When eligibility cannot be determined, the surface must render ELIGIBILITY_UNKNOWN as reconciling with the reconciliation path surfaced — never as failure (INV-X01).",
          expectedJourneyState: "ELIGIBILITY_UNKNOWN",
          correlatedProtocolId: "reconciliationCaseId",
        },
      ],
      {
        applies: true,
        rendersAs: "reconciling",
        reconciliationPathSurfaced: true,
      },
    ),
    paymentJourneyContract(
      "record-off-network-payment",
      "Record an off-network payment",
      "Payments",
      [
        {
          interactionId: "submit-details",
          description:
            "Enter the off-network payment details; surface reaches RECORDED with the ingestion evidence referenced.",
          expectedJourneyState: "RECORDED",
          correlatedProtocolId: "evidenceId",
        },
        {
          interactionId: "advance-reconciliation",
          description:
            "Advance the off-network record through reconciliation; unresolved outcomes render RECONCILING — never failure (INV-X01).",
          expectedJourneyState: "RECONCILING",
          correlatedProtocolId: "reconciliationCaseId",
        },
      ],
      {
        applies: true,
        rendersAs: "reconciling",
        reconciliationPathSurfaced: true,
      },
    ),
  ]);

// ---------------------------------------------------------------------------
// Contracts for the twelve W1-007 certification journeys (economic paths)
// ---------------------------------------------------------------------------

function certificationJourneyContract(
  journeyId: string,
  title: string,
  surface: string,
  keyInteraction: KeyInteraction,
  unknownApplies: boolean,
): BrowserJourneyContract {
  return {
    journeyId,
    title,
    source: "W1_007_CERTIFICATION_JOURNEY",
    surface,
    requiredChecks: [...BROWSER_VERIFICATION_CHECKS],
    keyInteractions: [keyInteraction],
    unknownHandling: unknownApplies
      ? {
          applies: true,
          rendersAs: "reconciling",
          reconciliationPathSurfaced: true,
        }
      : {
          applies: false,
          notApplicableReason:
            "The journey's authority path resolves deterministically under its injected transports; UNKNOWN handling is exercised by the ambiguity-journey contracts.",
        },
    screenshotArtifact: {
      evidenceId: `screenshot:${journeyId}`,
      strength: SCREENSHOT_EVIDENCE_STRENGTH,
    },
  };
}

/** The twelve W1-007 economic-journey browser contracts. */
export const CERTIFICATION_JOURNEY_CONTRACTS: readonly BrowserJourneyContract[] =
  Object.freeze([
    certificationJourneyContract(
      "p2p",
      "P2P transfer",
      "Payments",
      {
        interactionId: "complete-p2p-transfer",
        description:
          "Drive obligation → reservation → clearing → settlement → finality; browser surface shows the terminal honest view with evidence links.",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "settlementId",
      },
      false,
    ),
    certificationJourneyContract(
      "merchant-checkout",
      "Merchant checkout",
      "Payments",
      {
        interactionId: "complete-merchant-checkout",
        description:
          "Accept the checkout through the payment acceptance surface; finality is protocol-declared with policy-required proof.",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "settlementId",
      },
      false,
    ),
    certificationJourneyContract(
      "cross-border",
      "Cross-border payment",
      "Payments",
      {
        interactionId: "complete-cross-border",
        description:
          "Drive the FX-quoted cross-border path; the browser surface displays the exact rate/fee/spread provenance (INV-F09).",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "settlementId",
      },
      false,
    ),
    certificationJourneyContract(
      "payroll-batch",
      "Payroll batch",
      "Payments",
      {
        interactionId: "complete-payroll-batch",
        description:
          "Drive the netted payroll batch to settlement; per-employee obligations derive from the retained gross derivation (INV-F07).",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "settlementId",
      },
      false,
    ),
    certificationJourneyContract(
      "credit",
      "Credit draw and repayment",
      "Credit",
      {
        interactionId: "draw-and-repay-credit",
        description:
          "Draw on an explicit credit line and repay it; delay is never hidden credit (INV-F08).",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "obligationId",
      },
      false,
    ),
    certificationJourneyContract(
      "incentive-liquidity",
      "Incentive participation and liquidity",
      "Programs/Incentives",
      {
        interactionId: "earn-funded-reward",
        description:
          "Participate in a funded incentive program; the reward becomes a protocol obligation through the same clearing machinery.",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "obligationId",
      },
      false,
    ),
    certificationJourneyContract(
      "psp-incumbent",
      "PSP incumbent pass-through",
      "Capabilities",
      {
        interactionId: "pass-through-incumbent",
        description:
          "Execute PASS_THROUGH_NATIVE through the connected incumbent PSP; provider state renders losslessly (INV-C06).",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "settlementId",
      },
      false,
    ),
    certificationJourneyContract(
      "customer-action",
      "Customer-action-required flow",
      "Payments",
      {
        interactionId: "complete-customer-action",
        description:
          "Complete the provider-native customer action; the ProviderStateEnvelope's required action drives the surface (INV-C06).",
        expectedJourneyState: "USER_ACTION_REQUIRED",
        correlatedProtocolId: "attemptId",
      },
      false,
    ),
    certificationJourneyContract(
      "recurring-mandate",
      "Recurring mandate execution",
      "Payments",
      {
        interactionId: "execute-recurring-charge",
        description:
          "Execute a charge under an approved recurring mandate; the mandate authorization is epoch-checked (INV-A02).",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "settlementId",
      },
      false,
    ),
    certificationJourneyContract(
      "refund-dispute",
      "Refund and dispute recourse",
      "Disputes",
      {
        interactionId: "resolve-refund-dispute",
        description:
          "Drive the separate recourse obligation to resolution; contribution history remains (INV-P06 semantics for clawbacks).",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "obligationId",
      },
      true,
    ),
    certificationJourneyContract(
      "multi-provider-fallback",
      "Multi-provider fallback",
      "Payments",
      {
        interactionId: "fallback-to-alternate-provider",
        description:
          "Fail one provider and fall back with EXPLICIT term changes; the surface must require reauthorization, never switch silently.",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "settlementId",
      },
      true,
    ),
    certificationJourneyContract(
      "external-funds",
      "External funds position observation",
      "Liquidity",
      {
        interactionId: "observe-external-funds",
        description:
          "Observe an external funds position; it renders as an observation with freshness/provenance — never PaySwap custody (INV-C09).",
        expectedJourneyState: "WAITING",
        correlatedProtocolId: "evidenceId",
      },
      false,
    ),
  ]);

/** Every browser journey contract, UX journeys first. */
export const BROWSER_JOURNEY_CONTRACTS: readonly BrowserJourneyContract[] =
  Object.freeze([
    ...UX_PAYMENT_JOURNEY_CONTRACTS,
    ...CERTIFICATION_JOURNEY_CONTRACTS,
  ]);

// ---------------------------------------------------------------------------
// Deterministic contract checker
// ---------------------------------------------------------------------------

export interface ContractViolation {
  readonly journeyId: string;
  readonly check: string;
  readonly detail: string;
}

export interface BrowserContractReport {
  readonly passed: boolean;
  readonly contractCount: number;
  readonly violations: readonly ContractViolation[];
  /** Every terminal state the honest-state layer renders for the journeys. */
  readonly verifiedTerminalStates: readonly string[];
}

/**
 * The deterministic browser-contract checker. Verifies against the ACTUAL
 * view-model data (never against a claim):
 *
 *  1. COMPLETENESS — every @payswap/ux payment journey has a contract and
 *     every @payswap/journeys W1-007 certification journey has a contract;
 *  2. SIX CHECKS — every contract declares exactly the six required
 *     browser-verification checks;
 *  3. STATE TABLE — every UX key-interaction's expected state exists in
 *     that journey's declared `PAYMENT_JOURNEY_STATES` table;
 *  4. INV-X01 — journeys whose surfaces render UNKNOWN render it as
 *     `reconciling` with the reconciliation path surfaced (never failure);
 *  5. INV-E04 — every screenshot artifact's evidence strength is bounded at
 *     BROWSER_UNAUTHENTICATED_PROVENANCE (browser artifacts are never
 *     stronger than authenticated provenance);
 *  6. HONEST RENDERING — every terminal state referenced by the contracts
 *     renders through the honest-state layer without throwing.
 */
export function checkBrowserJourneyContracts(
  contracts: readonly BrowserJourneyContract[] = BROWSER_JOURNEY_CONTRACTS,
): BrowserContractReport {
  const violations: ContractViolation[] = [];
  const verifiedTerminalStates = new Set<string>();

  // 1. completeness against the live view-model registries
  const contractIds = new Set(contracts.map((contract) => contract.journeyId));
  for (const spec of PAYMENT_JOURNEY_STATES) {
    if (!contractIds.has(spec.journeyId)) {
      violations.push({
        journeyId: spec.journeyId,
        check: "completeness",
        detail: "UX payment journey has no browser verification contract",
      });
    }
  }
  const uxContractIds = new Set(
    contracts
      .filter((contract) => contract.source === "UX_PAYMENT_JOURNEY")
      .map((contract) => contract.journeyId),
  );
  for (const spec of PAYMENT_JOURNEY_STATES) {
    if (!uxContractIds.has(spec.journeyId)) {
      violations.push({
        journeyId: spec.journeyId,
        check: "completeness",
        detail: "UX payment journey contract must use source UX_PAYMENT_JOURNEY",
      });
    }
  }
  for (const journey of JOURNEYS) {
    if (!contractIds.has(journey.journeyId)) {
      violations.push({
        journeyId: journey.journeyId,
        check: "completeness",
        detail:
          "W1-007 certification journey has no browser verification contract",
      });
    }
  }
  for (const contract of contracts) {
    const duplicates = contracts.filter(
      (candidate) => candidate.journeyId === contract.journeyId,
    );
    if (duplicates.length > 1) {
      violations.push({
        journeyId: contract.journeyId,
        check: "completeness",
        detail: "duplicate browser journey contract",
      });
    }
  }

  for (const contract of contracts) {
    // 2. the six checks, exactly
    const missing = BROWSER_VERIFICATION_CHECKS.filter(
      (check) => !contract.requiredChecks.includes(check),
    );
    if (missing.length > 0) {
      violations.push({
        journeyId: contract.journeyId,
        check: "required-checks",
        detail: `missing required checks: ${missing.join(", ")}`,
      });
    }

    // 3. key interactions exist in the declared state table
    if (contract.keyInteractions.length === 0) {
      violations.push({
        journeyId: contract.journeyId,
        check: "key-interactions",
        detail: "contract declares no key interaction",
      });
    }
    if (contract.source === "UX_PAYMENT_JOURNEY") {
      const spec = PAYMENT_JOURNEY_STATES.find(
        (candidate) => candidate.journeyId === contract.journeyId,
      );
      if (spec !== undefined) {
        const stateNames = new Set(spec.states.map((state) => state.stateName));
        for (const interaction of contract.keyInteractions) {
          if (!stateNames.has(interaction.expectedJourneyState)) {
            violations.push({
              journeyId: contract.journeyId,
              check: "key-interactions",
              detail: `expected state '${interaction.expectedJourneyState}' is not in the journey's declared state table`,
            });
          }
        }
      }
    }
    for (const interaction of contract.keyInteractions) {
      if (!interaction.correlatedProtocolId) {
        violations.push({
          journeyId: contract.journeyId,
          check: "key-interactions",
          detail: `interaction '${interaction.interactionId}' declares no correlated protocol ID`,
        });
      }
    }

    // 4. UNKNOWN renders as reconciling with the path surfaced
    if (contract.unknownHandling.applies) {
      if (
        contract.unknownHandling.rendersAs !== "reconciling" ||
        !contract.unknownHandling.reconciliationPathSurfaced
      ) {
        violations.push({
          journeyId: contract.journeyId,
          check: "unknown-handling",
          detail: "UNKNOWN must render as reconciling with the reconciliation path surfaced (INV-X01)",
        });
      }
    }

    // 5. INV-E04 evidence-strength ceiling
    if (contract.screenshotArtifact.strength !== SCREENSHOT_EVIDENCE_STRENGTH) {
      violations.push({
        journeyId: contract.journeyId,
        check: "evidence-strength",
        detail: "screenshot artifact strength must be BROWSER_UNAUTHENTICATED_PROVENANCE (INV-E04)",
      });
    }

    // 6. every TERMINAL state referenced by the contracts renders honestly
    //    through the @payswap/ux honest-state layer (non-terminal UX journey
    //    states are covered by the state-table check above).
    for (const interaction of contract.keyInteractions) {
      if (!isTerminalUiState(interaction.expectedJourneyState)) {
        continue;
      }
      const rendered = renderTerminalHonestView(interaction.expectedJourneyState);
      if (rendered.uiState === "failed" && interaction.expectedJourneyState === "UNKNOWN") {
        violations.push({
          journeyId: contract.journeyId,
          check: "honest-rendering",
          detail: "UNKNOWN rendered as failure — must render reconciling (INV-X01)",
        });
      }
      if (interaction.expectedJourneyState === "UNKNOWN" && rendered.tone === "negative") {
        violations.push({
          journeyId: contract.journeyId,
          check: "honest-rendering",
          detail: "UNKNOWN rendered with negative tone — must be neutral/reconciling (INV-X01)",
        });
      }
    }
  }

  // collect which terminal states actually rendered (for the report)
  for (const contract of contracts) {
    for (const interaction of contract.keyInteractions) {
      if (isTerminalUiState(interaction.expectedJourneyState)) {
        renderTerminalHonestView(interaction.expectedJourneyState);
        verifiedTerminalStates.add(interaction.expectedJourneyState);
      }
    }
  }

  return {
    passed: violations.length === 0,
    contractCount: contracts.length,
    violations,
    verifiedTerminalStates: [...verifiedTerminalStates].sort(),
  };
}

// ---------------------------------------------------------------------------
// Verification runs — deterministic artifacts for the deployment gate
// ---------------------------------------------------------------------------

export interface CheckResult {
  readonly check: BrowserVerificationCheck;
  readonly passed: boolean;
  readonly evidenceRef: string;
}

export interface JourneyVerificationRun {
  readonly journeyId: string;
  readonly checks: readonly CheckResult[];
  readonly passed: boolean;
}

export interface BrowserVerificationReport {
  readonly suiteId: "payswap.browser-verification";
  readonly workOrder: "W3-007";
  readonly runs: readonly JourneyVerificationRun[];
  readonly passed: boolean;
  readonly digest: string;
}

/**
 * Record a browser verification run. The runner (agent-browser at gate
 * time) supplies per-check outcomes with evidence references; this
 * assembler validates every required check is covered per journey and
 * digests the report for immutability (INV-E05 lineage).
 */
export function recordBrowserVerificationRun(
  runs: readonly {
    readonly journeyId: string;
    readonly checks: readonly CheckResult[];
  }[],
): BrowserVerificationReport {
  const assembled: JourneyVerificationRun[] = runs.map((run) => {
    const covered = BROWSER_VERIFICATION_CHECKS.filter((check) =>
      run.checks.some((result) => result.check === check),
    );
    const missing = BROWSER_VERIFICATION_CHECKS.filter(
      (check) => !covered.includes(check),
    );
    const passed =
      missing.length === 0 && run.checks.every((result) => result.passed);
    const checks =
      missing.length === 0
        ? run.checks
        : [
            ...run.checks,
            ...missing.map((check) => ({
              check,
              passed: false,
              evidenceRef: "missing",
            })),
          ];
    return { journeyId: run.journeyId, checks, passed };
  });
  const body = { suiteId: "payswap.browser-verification" as const, runs: assembled };
  return {
    ...body,
    workOrder: "W3-007",
    passed: assembled.every((run) => run.passed),
    digest: contentDigest(body),
  };
}
