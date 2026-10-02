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
import { collectSecretShapedStrings } from "./provider-activation.js";

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
  readonly source:
    | "UX_PAYMENT_JOURNEY"
    | "W1_007_CERTIFICATION_JOURNEY"
    | "PROVIDER_REAL_PATH_JOURNEY"
    | "LOCAL_RAIL_USER_AUTHORIZED_JOURNEY"
    | "EXPIRED_SESSION_JOURNEY";
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
  /**
   * P2-W3-003: present on provider-rollout contracts — the REAL
   * API/protocol/provider path the journey drives (never a simulated
   * substitute).
   */
  readonly realPath?: RealPathDescriptor;
  /**
   * P2-W3-003: present on provider-backed contracts — secret-bearing form
   * fields, cookies and session material stay inside the secure
   * browser/credential boundary (opaque references only in artifacts).
   */
  readonly credentialBoundary?: "SECURE_BROWSER_OR_VAULT_ONLY";
  /**
   * P2-W3-003: present on the expired-session contract — an expired
   * session produces an EXPLICIT reauthentication / customer-action-
   * required state (never a silent re-login or fabricated continuation).
   */
  readonly expiredSessionHandling?: ExpiredSessionHandling;
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
    violations.push(...contractRuleViolations(contract));
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

/**
 * The per-contract rule checks (2-6 of the checker above), shared with the
 * P2-W3-003 provider-rollout coverage checker so every contract family is
 * held to the SAME six-check/state-table/INV-X01/INV-E04 rules.
 */
function contractRuleViolations(contract: BrowserJourneyContract): ContractViolation[] {
  const violations: ContractViolation[] = [];
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
  return violations;
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
  const assembled = assembleJourneyRuns(runs);
  const body = { suiteId: "payswap.browser-verification" as const, runs: assembled };
  return {
    ...body,
    workOrder: "W3-007",
    passed: assembled.every((run) => run.passed),
    digest: contentDigest(body),
  };
}

/** Shared run assembly: the six required checks per journey, fail-closed. */
function assembleJourneyRuns(
  runs: readonly {
    readonly journeyId: string;
    readonly checks: readonly CheckResult[];
  }[],
): JourneyVerificationRun[] {
  return runs.map((run) => {
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
}

// ---------------------------------------------------------------------------
// P2-W3-003 — provider-rollout browser contracts: real paths, the local
// rail's user-authorized session, expired sessions, secret exclusion
// ---------------------------------------------------------------------------

/**
 * The REAL path a provider-rollout journey drives (work-order acceptance
 * "browser journeys use real API/protocol/provider paths"). The contract
 * describes the real path — the connector's own mapping code over the
 * provider's real documented API surface, driven through the validated
 * protocol envelope; never a simulated substitute.
 */
export interface RealPathDescriptor {
  readonly providerName: string;
  /** The journey drives the provider's REAL API surface through the connector. */
  readonly apiPath: "REAL_PROVIDER_API";
  /** Mutations leave as validated RequestEnvelopes (INV-F05 idempotency keys). */
  readonly protocolPath: "VALIDATED_REQUEST_ENVELOPE";
  /**
   * The canonical authorization mode of the connected instance (validated
   * against the caller-supplied canonical union — boundary law 6).
   */
  readonly authorizationMode: string;
  readonly transportNote: string;
}

/** The expired-session handling declaration (P2-W3-003 acceptance). */
export interface ExpiredSessionHandling {
  /** The journey reaches an EXPLICIT EXPIRED state (never silent). */
  readonly producesExpiredState: true;
  /** The customer must act: reauthentication is required to continue. */
  readonly customerActionRequired: true;
  /** Reauthentication happens ONLY inside the isolated secure browser surface. */
  readonly reauthenticationPath: "ISOLATED_SECURE_BROWSER_SURFACE";
  /** A re-authenticated journey continues as a NEW attempt with fresh authorization evidence. */
  readonly continuesAsNewAttempt: true;
}

/**
 * Builds the provider real-path browser contract for one connected
 * provider. The journey drives the provider's real API through the
 * connector's own mapping code and the validated protocol envelope;
 * UNKNOWN outcomes render reconciling (INV-X01).
 */
export function providerRealPathJourneyContract(
  providerName: string,
  authorizationMode: string,
  extraInteractions: readonly KeyInteraction[] = [],
): BrowserJourneyContract {
  return Object.freeze({
    journeyId: `provider-real-path:${providerName}`,
    title: `Provider real-path journey — ${providerName}`,
    source: "PROVIDER_REAL_PATH_JOURNEY" as const,
    surface: "Payments",
    requiredChecks: [...BROWSER_VERIFICATION_CHECKS],
    keyInteractions: [
      {
        interactionId: "complete-real-path-payment",
        description:
          `Drive the checkout over the REAL ${providerName} API path (the connector's own mapping code, the provider's documented API surface, the validated RequestEnvelope) to the terminal honest view with evidence links.`,
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "settlementId",
      },
      {
        interactionId: "provider-outcome-unknown",
        description:
          `When ${providerName} answers ambiguously, the surface renders UNKNOWN as reconciling with the reconciliation path surfaced — never as failure (INV-X01).`,
        expectedJourneyState: "UNKNOWN",
        correlatedProtocolId: "reconciliationCaseId",
      },
      ...extraInteractions,
    ],
    unknownHandling: {
      applies: true as const,
      rendersAs: "reconciling" as const,
      reconciliationPathSurfaced: true as const,
    },
    screenshotArtifact: {
      evidenceId: `screenshot:provider-real-path:${providerName}`,
      strength: SCREENSHOT_EVIDENCE_STRENGTH,
    },
    realPath: {
      providerName,
      apiPath: "REAL_PROVIDER_API" as const,
      protocolPath: "VALIDATED_REQUEST_ENVELOPE" as const,
      authorizationMode,
      transportNote:
        "the connector's own mapping code over the provider's real documented API surface — scripted transport in certification, live transport in production; never a simulated rail",
    },
    credentialBoundary: "SECURE_BROWSER_OR_VAULT_ONLY" as const,
  });
}

/**
 * Derives the real-path contract set for the connected providers of a
 * rollout (one contract per provider — the completeness the coverage
 * checker enforces).
 */
export function deriveProviderRealPathContracts(
  connectedProviders: readonly {
    readonly providerName: string;
    readonly authorizationMode: string;
  }[],
): readonly BrowserJourneyContract[] {
  return Object.freeze(
    connectedProviders.map((provider) =>
      providerRealPathJourneyContract(
        provider.providerName,
        provider.authorizationMode,
      ),
    ),
  );
}

/**
 * Builds the LOCAL-RAIL user-authorized journey contract (work-order
 * acceptance: "local-rail browser journeys use the real user-authorized
 * provider/session path when no API credential exists"). The
 * authorizationMode is the W1-003 direct-local mode (INTERACTIVE_BROWSER_
 * SESSION for the user-authorized provider session; PROVIDERLESS_RAIL for
 * a rail with user-held local material) — validated by the coverage
 * checker against the caller-supplied canonical direct-local union.
 */
export function localRailUserAuthorizedJourneyContract(
  authorizationMode: string,
): BrowserJourneyContract {
  return Object.freeze({
    journeyId: "local-rail-user-authorized-payment",
    title: "Local-rail payment over the user-authorized provider session",
    source: "LOCAL_RAIL_USER_AUTHORIZED_JOURNEY" as const,
    surface: "Payments",
    requiredChecks: [...BROWSER_VERIFICATION_CHECKS],
    keyInteractions: [
      {
        interactionId: "establish-user-authorized-session",
        description:
          "With no API credential, the user authorizes the provider inside the ISOLATED secure browser surface (login/MFA in the browser boundary — the session material never crosses into agent context or artifacts); the surface renders the preserved customer action (INV-C06).",
        expectedJourneyState: "USER_ACTION_REQUIRED",
        correlatedProtocolId: "attemptId",
      },
      {
        interactionId: "complete-local-rail-payment",
        description:
          "The local-rail payment executes over the user-authorized provider/session path (the real path — no simulated substitute); the terminal honest view renders with evidence links.",
        expectedJourneyState: "FULFILLED",
        correlatedProtocolId: "settlementId",
      },
    ],
    unknownHandling: {
      applies: true as const,
      rendersAs: "reconciling" as const,
      reconciliationPathSurfaced: true as const,
    },
    screenshotArtifact: {
      evidenceId: "screenshot:local-rail-user-authorized-payment",
      strength: SCREENSHOT_EVIDENCE_STRENGTH,
    },
    realPath: {
      providerName: "local-rail",
      apiPath: "REAL_PROVIDER_API" as const,
      protocolPath: "VALIDATED_REQUEST_ENVELOPE" as const,
      authorizationMode,
      transportNote:
        "the real user-authorized provider/session path inside the isolated secure browser runtime — applies when no API credential exists (the W1-003 direct-local coverage-gap vocabulary)",
    },
    credentialBoundary: "SECURE_BROWSER_OR_VAULT_ONLY" as const,
  });
}

/** The default local-rail contract (the user-authorized browser session). */
export const LOCAL_RAIL_USER_AUTHORIZED_JOURNEY_CONTRACT: BrowserJourneyContract =
  localRailUserAuthorizedJourneyContract("INTERACTIVE_BROWSER_SESSION");

/**
 * The expired-session journey contract (work-order acceptance: "expired
 * sessions produce explicit reauthentication/customer-action-required
 * states"). Expected states use the canonical browser-session
 * authorization lifecycle tokens (ACTIVE / REAUTHENTICATION_REQUIRED /
 * STEP_UP_REQUIRED / EXPIRED / REVOKED — owned by @payswap/connectors and
 * passed into the checker by the caller); EXPIRED renders through the
 * honest-state layer (neutral tone, never failure).
 */
export const EXPIRED_SESSION_JOURNEY_CONTRACT: BrowserJourneyContract =
  Object.freeze({
    journeyId: "expired-session-reauthentication",
    title: "Expired session — explicit reauthentication",
    source: "EXPIRED_SESSION_JOURNEY" as const,
    surface: "Payments",
    requiredChecks: [...BROWSER_VERIFICATION_CHECKS],
    keyInteractions: [
      {
        interactionId: "observe-session-expiry",
        description:
          "The provider session expires mid-journey; the surface reaches the EXPLICIT EXPIRED state with the reauthentication path surfaced — never a silent re-login, never a fabricated continuation.",
        expectedJourneyState: "EXPIRED",
        correlatedProtocolId: "attemptId",
      },
      {
        interactionId: "complete-reauthentication",
        description:
          "The customer re-authenticates inside the isolated secure browser surface; the browser-session lifecycle returns to ACTIVE and the journey continues as a NEW attempt with fresh authorization evidence.",
        expectedJourneyState: "ACTIVE",
        correlatedProtocolId: "attemptId",
      },
      {
        interactionId: "provider-requires-step-up",
        description:
          "When the provider requires step-up authentication, the surface renders STEP_UP_REQUIRED as a customer action (INV-C06) — distinct from expiry and from failure.",
        expectedJourneyState: "STEP_UP_REQUIRED",
        correlatedProtocolId: "attemptId",
      },
    ],
    unknownHandling: {
      applies: false as const,
      notApplicableReason:
        "Session expiry, reauthentication and step-up are determinate browser-session lifecycle states; ambiguity of the external outcome is owned by the real-path journey contracts.",
    },
    screenshotArtifact: {
      evidenceId: "screenshot:expired-session-reauthentication",
      strength: SCREENSHOT_EVIDENCE_STRENGTH,
    },
    credentialBoundary: "SECURE_BROWSER_OR_VAULT_ONLY" as const,
    expiredSessionHandling: {
      producesExpiredState: true as const,
      customerActionRequired: true as const,
      reauthenticationPath: "ISOLATED_SECURE_BROWSER_SURFACE" as const,
      continuesAsNewAttempt: true as const,
    },
  });

// ---------------------------------------------------------------------------
// P2-W3-003 — secret exclusion: secret-bearing form fields, cookies and
// session material stay OUTSIDE agent context and ordinary artifacts
// ---------------------------------------------------------------------------

/** The field classes that carry secret-bearing material. */
export const SECRET_BEARING_FIELD_CLASSES = [
  "FORM_FIELD_VALUE",
  "COOKIE",
  "SESSION_MATERIAL",
  "AUTHORIZATION_HEADER",
  "WEBHOOK_SIGNATURE",
] as const;
export type SecretBearingFieldClass =
  (typeof SECRET_BEARING_FIELD_CLASSES)[number];

/** Cookie-assignment syntax (a cookie VALUE recorded as an artifact string). */
const COOKIE_ASSIGNMENT_PATTERN =
  /[A-Za-z0-9_-]{2,}=[^;\s]{8,};\s*(?:Path|Domain|Max-Age|Expires|HttpOnly|Secure|SameSite)=/;

/** Opaque boundary references (the ONLY legal artifact representation). */
const OPAQUE_REF_PATTERN = /^(?:browser-session|vault|opaque):\/\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** What a browser runner observed on one journey (pre-redaction input). */
export interface BrowserObservationField {
  readonly name: string;
  readonly fieldClass: SecretBearingFieldClass | "NON_SECRET";
  /** PLAIN_VALUE carries the material; OPAQUE_REF carries a boundary reference. */
  readonly representation: "PLAIN_VALUE" | "OPAQUE_REF";
  readonly value: string;
}

export interface BrowserJourneyObservation {
  readonly journeyId: string;
  readonly fields: readonly BrowserObservationField[];
  /** Cookie NAMES only — cookie values are structurally unrepresentable. */
  readonly cookieNames: readonly string[];
  /** The opaque browser-session reference (when a session backs the journey). */
  readonly sessionRef?: string;
  readonly notes: readonly string[];
}

/** The artifact-safe product of {@link redactBrowserJourneyObservation}. */
export interface RedactedBrowserJourneyArtifact {
  readonly journeyId: string;
  readonly fields: readonly {
    readonly name: string;
    readonly fieldClass: SecretBearingFieldClass | "NON_SECRET";
    readonly representation: "OPAQUE_REF";
    /** A per-field ordinal opaque reference — NO trace of the value survives. */
    readonly ref: string;
  }[];
  readonly cookieNames: readonly string[];
  readonly sessionRef?: string;
  readonly notes: readonly string[];
  readonly credentialBoundary: "SECURE_BROWSER_OR_VAULT_ONLY";
}

export interface BrowserArtifactExclusionReport {
  readonly journeyId: string;
  readonly ok: boolean;
  readonly violations: readonly { readonly field: string; readonly problem: string }[];
}

/** Deep secret scan + representation rules over one observation. */
function observationExclusionViolations(
  observation: BrowserJourneyObservation,
  rootLabel: string,
): { journeyId: string; violations: { field: string; problem: string }[] } {
  const violations: { field: string; problem: string }[] = [];
  const push = (field: string, problem: string): void => {
    violations.push({ field, problem });
  };

  for (const fieldClass of SECRET_BEARING_FIELD_CLASSES) {
    if (fieldClass === "COOKIE") {
      continue; // cookies are names-only, checked below
    }
    for (const field of observation.fields) {
      if (field.fieldClass === fieldClass && field.representation === "PLAIN_VALUE") {
        push(
          `${rootLabel}.fields[${field.name}]`,
          `secret-bearing ${fieldClass.toLowerCase()} recorded as PLAIN_VALUE — the secure browser/credential boundary is the only legal location`,
        );
      }
    }
  }
  for (const field of observation.fields) {
    if (
      field.fieldClass === "COOKIE" &&
      field.representation === "PLAIN_VALUE" &&
      COOKIE_ASSIGNMENT_PATTERN.test(field.value)
    ) {
      push(
        `${rootLabel}.fields[${field.name}]`,
        "cookie assignment syntax recorded in an artifact — cookie values stay in the browser boundary",
      );
    }
  }
  if (observation.sessionRef !== undefined) {
    if (!OPAQUE_REF_PATTERN.test(observation.sessionRef)) {
      push(
        `${rootLabel}.sessionRef`,
        "session material must appear as an opaque boundary reference (browser-session://…), never as a value",
      );
    }
  }
  // Deep secret-shape scan over every string (same fail-closed heuristics
  // as the provider-activation byte scanner — one law, one scanner).
  for (const hit of collectSecretShapedStrings(observation, rootLabel)) {
    push(hit, "secret-shaped value in browser-journey material (references only)");
  }
  return { journeyId: observation.journeyId, violations };
}

/**
 * Checks a raw observation: every secret-bearing field, cookie value and
 * session material must stay OUT of the recorded artifact (opaque
 * references only). The runner calls this BEFORE redaction to prove the
 * boundary holds — an ok:false report is a boundary violation.
 */
export function checkBrowserObservationSecretExclusion(
  observation: BrowserJourneyObservation,
): BrowserArtifactExclusionReport {
  const { journeyId, violations } = observationExclusionViolations(
    observation,
    "observation",
  );
  return { journeyId, ok: violations.length === 0, violations };
}

/**
 * Deterministically redacts an observation into the artifact-safe form:
 * every field becomes an OPAQUE_REF with a per-journey ordinal (NO digest,
 * NO trace of the value survives in the artifact); cookie names are kept
 * (names are not secret); the session reference passes through only when
 * it is already opaque.
 */
export function redactBrowserJourneyObservation(
  observation: BrowserJourneyObservation,
): RedactedBrowserJourneyArtifact {
  return Object.freeze({
    journeyId: observation.journeyId,
    fields: Object.freeze(
      observation.fields.map((field, index) => ({
        name: field.name,
        fieldClass: field.fieldClass,
        representation: "OPAQUE_REF" as const,
        ref: `opaque://${observation.journeyId}/field/${index}`,
      })),
    ),
    cookieNames: Object.freeze([...observation.cookieNames]),
    ...(observation.sessionRef !== undefined &&
    OPAQUE_REF_PATTERN.test(observation.sessionRef)
      ? { sessionRef: observation.sessionRef }
      : {}),
    notes: Object.freeze([...observation.notes]),
    credentialBoundary: "SECURE_BROWSER_OR_VAULT_ONLY" as const,
  });
}

/**
 * Checks a redacted artifact (or any claimed artifact): the artifact must
 * contain NO secret-bearing material — no secret-shaped strings, no
 * cookie-assignment syntax, no plain session material — anywhere in its
 * structure. Fail-closed deep scan.
 */
export function checkBrowserArtifactSecretExclusion(
  artifact: unknown,
): BrowserArtifactExclusionReport {
  const violations: { field: string; problem: string }[] = [];
  const record =
    typeof artifact === "object" && artifact !== null
      ? (artifact as Readonly<Record<string, unknown>>)
      : undefined;
  const journeyIdToken = record?.journeyId;
  const journeyId =
    typeof journeyIdToken === "string" ? journeyIdToken : "unknown-journey";
  const push = (field: string, problem: string): void => {
    violations.push({ field, problem });
  };

  const scan = (value: unknown, field: string): void => {
    if (typeof value === "string") {
      if (COOKIE_ASSIGNMENT_PATTERN.test(value)) {
        push(field, "cookie assignment syntax in an artifact (values stay in the browser boundary)");
      }
      return; // secret-shape handled by the shared scanner below
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => scan(item, `${field}[${i}]`));
    } else if (typeof value === "object" && value !== null) {
      const record = value as Readonly<Record<string, unknown>>;
      for (const key of Object.keys(record)) {
        scan(record[key], `${field}.${key}`);
      }
    }
  };
  scan(artifact, "artifact");
  for (const hit of collectSecretShapedStrings(artifact, "artifact")) {
    push(hit, "secret-shaped value in a browser artifact (references only)");
  }
  return { journeyId, ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// P2-W3-003 — the provider-rollout browser coverage checker
// ---------------------------------------------------------------------------

export interface ProviderRolloutBrowserCoverageInput {
  /** The connected providers of the rollout (from the release record). */
  readonly connectedProviders: readonly {
    readonly providerName: string;
    readonly authorizationMode: string;
  }[];
  readonly contracts: readonly BrowserJourneyContract[];
  /** The local-rail leg: applies exactly when no API credential exists. */
  readonly localRail: {
    readonly applies: boolean;
    readonly reason: string;
  };
}

/**
 * Checks the provider-rollout browser coverage (work-order acceptance):
 *
 *  1. every CONNECTED provider has exactly one PROVIDER_REAL_PATH_JOURNEY
 *     contract whose realPath provider + canonical authorization mode
 *     match (the journey drives the real API/protocol/provider path);
 *  2. every provided contract passes the shared per-contract rules (the
 *     six checks, protocol-correlated interactions, INV-X01, INV-E04);
 *  3. every provider-backed contract declares the SECURE_BROWSER_OR_VAULT_
 *     ONLY credential boundary;
 *  4. when the local rail applies (no API credential exists), the
 *     LOCAL_RAIL_USER_AUTHORIZED_JOURNEY contract is present with a
 *     canonical direct-local authorization mode (the W1-003 vocabulary —
 *     passed in by the caller);
 *  5. the EXPIRED_SESSION contract is present with the explicit
 *     reauthentication/customer-action-required declaration.
 *
 * `allowedAuthorizationModes` is the canonical five-mode union
 * (@payswap/connectors AUTHORIZATION_MODES) and
 * `allowedDirectLocalAuthorizationModes` the W1-003 direct-local union
 * (@payswap/capabilities DIRECT_LOCAL_AUTHORIZATION_MODES) — both passed
 * in by the caller (boundary law 6: this package never redefines them).
 */
export function checkProviderRolloutBrowserCoverage(
  input: ProviderRolloutBrowserCoverageInput,
  allowedAuthorizationModes: readonly string[],
  allowedDirectLocalAuthorizationModes: readonly string[],
): BrowserContractReport {
  const violations: ContractViolation[] = [];

  for (const provider of input.connectedProviders) {
    const mine = input.contracts.filter(
      (contract) =>
        contract.source === "PROVIDER_REAL_PATH_JOURNEY" &&
        contract.realPath !== undefined &&
        contract.realPath.providerName === provider.providerName,
    );
    if (mine.length === 0) {
      violations.push({
        journeyId: `provider-real-path:${provider.providerName}`,
        check: "real-path-coverage",
        detail:
          "connected provider has no real-path browser journey contract (the rollout's browser journeys must drive the real API/protocol/provider path)",
      });
      continue;
    }
    if (mine.length > 1) {
      violations.push({
        journeyId: `provider-real-path:${provider.providerName}`,
        check: "real-path-coverage",
        detail: "duplicate real-path contract for the provider",
      });
    }
    if (!allowedAuthorizationModes.includes(provider.authorizationMode)) {
      violations.push({
        journeyId: `provider-real-path:${provider.providerName}`,
        check: "real-path-coverage",
        detail: `authorization mode '${provider.authorizationMode}' is not in the canonical union`,
      });
    }
  }

  for (const contract of input.contracts) {
    violations.push(...contractRuleViolations(contract));
    if (
      (contract.source === "PROVIDER_REAL_PATH_JOURNEY" ||
        contract.source === "LOCAL_RAIL_USER_AUTHORIZED_JOURNEY" ||
        contract.source === "EXPIRED_SESSION_JOURNEY") &&
      contract.credentialBoundary !== "SECURE_BROWSER_OR_VAULT_ONLY"
    ) {
      violations.push({
        journeyId: contract.journeyId,
        check: "credential-boundary",
        detail:
          "provider-backed browser contracts must declare the SECURE_BROWSER_OR_VAULT_ONLY credential boundary (secret-bearing fields, cookies and session material never enter artifacts)",
      });
    }
  }

  if (input.localRail.applies) {
    const localRailContracts = input.contracts.filter(
      (contract) => contract.source === "LOCAL_RAIL_USER_AUTHORIZED_JOURNEY",
    );
    if (localRailContracts.length === 0) {
      violations.push({
        journeyId: "local-rail-user-authorized-payment",
        check: "local-rail-coverage",
        detail: `the local rail applies (${input.localRail.reason}) but the user-authorized provider/session journey contract is missing`,
      });
    } else {
      const mode = localRailContracts[0]?.realPath?.authorizationMode;
      if (mode === undefined || !allowedDirectLocalAuthorizationModes.includes(mode)) {
        violations.push({
          journeyId: "local-rail-user-authorized-payment",
          check: "local-rail-coverage",
          detail: `the local-rail authorization mode must be one of the canonical direct-local modes [${allowedDirectLocalAuthorizationModes.join(", ")}] (the W1-003 coverage-gap vocabulary)`,
        });
      }
    }
  }

  const expired = input.contracts.filter(
    (contract) => contract.source === "EXPIRED_SESSION_JOURNEY",
  );
  if (expired.length !== 1) {
    violations.push({
      journeyId: "expired-session-reauthentication",
      check: "expired-session-coverage",
      detail:
        "exactly one expired-session contract is required (expired sessions produce explicit reauthentication/customer-action-required states)",
    });
  } else {
    const contract = expired[0];
    if (
      contract?.expiredSessionHandling === undefined ||
      contract.expiredSessionHandling.customerActionRequired !== true ||
      contract.expiredSessionHandling.reauthenticationPath !==
        "ISOLATED_SECURE_BROWSER_SURFACE"
    ) {
      violations.push({
        journeyId: "expired-session-reauthentication",
        check: "expired-session-coverage",
        detail:
          "the expired-session contract must declare customer-action-required reauthentication through the isolated secure browser surface",
      });
    }
  }

  const verifiedTerminalStates = new Set<string>();
  for (const contract of input.contracts) {
    for (const interaction of contract.keyInteractions) {
      if (isTerminalUiState(interaction.expectedJourneyState)) {
        renderTerminalHonestView(interaction.expectedJourneyState);
        verifiedTerminalStates.add(interaction.expectedJourneyState);
      }
    }
  }

  return {
    passed: violations.length === 0,
    contractCount: input.contracts.length,
    violations,
    verifiedTerminalStates: [...verifiedTerminalStates].sort(),
  };
}

// ---------------------------------------------------------------------------
// P2-W3-003 — the provider-rollout browser verification run record
// ---------------------------------------------------------------------------

export interface ProviderRolloutBrowserVerificationReport {
  readonly suiteId: "payswap.provider-rollout-browser-verification";
  readonly workOrder: "P2-W3-003";
  readonly runs: readonly JourneyVerificationRun[];
  readonly passed: boolean;
  readonly digest: string;
}

/**
 * Records the provider-rollout browser verification run (the P2-W3-003
 * gate evidence the release record consumes): same six-checks-per-journey
 * assembly and digest discipline as {@link recordBrowserVerificationRun},
 * over the provider-rollout journey set.
 */
export function recordProviderRolloutBrowserVerification(
  runs: readonly {
    readonly journeyId: string;
    readonly checks: readonly CheckResult[];
  }[],
): ProviderRolloutBrowserVerificationReport {
  const assembled = assembleJourneyRuns(runs);
  const body = {
    suiteId: "payswap.provider-rollout-browser-verification" as const,
    runs: assembled,
  };
  return {
    ...body,
    workOrder: "P2-W3-003",
    passed: assembled.every((run) => run.passed),
    digest: contentDigest(body),
  };
}
