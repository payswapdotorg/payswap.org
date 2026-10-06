/**
 * Journey B — DEX optimization (§35).
 *
 * User: "Swap $1,000 USDC into ETH."
 * PaySwap: collects multiple routes → computes total economic outcome
 * (exact math) → security screens → simulates → asks for authorization →
 * executes → reconciles.
 *
 * Real composition:
 * - the W2-002 best-execution engine collects quotes from ALL THREE real
 *   venue packs (Uniswap v2 constant-product, RFQ aggregator, batch
 *   intents), applies hard constraints, computes each candidate's total
 *   economic outcome in exact integer/rational arithmetic, runs the
 *   kernel security gates per candidate, ranks and SELECTS;
 * - the W3-001 lane composer proves the onchain lane (gate ALLOW + ACTIVE
 *   instance + fresh canonical asset observation);
 * - the W1-002 kernel pipeline authorizes the SAME write (digest-bound)
 *   with explicit signing at the injected trusted surface, rechecks and
 *   hands off;
 * - the execution record walks the canonical lifecycle to EXECUTED_
 *   CANDIDATE over the kernel-validated CONFIRMED observation, and the
 *   reconciliation mapping is asserted on the UNKNOWN variant (Journey I
 *   drives the full UNKNOWN walk).
 */

import type { SwapRequest } from "@payswap/best-execution";
import { RouteExecutionRecord } from "@payswap/best-execution";
import { discoverOnchainLane, executeOnchainLane, engineFromVenuePacks } from "@payswap/mixed-rail";
import { OnchainWritePipeline } from "@payswap/onchain-security";
import {
  assertionFromChecks,
  assembleJourneyOutcome,
  journeyRequires,
  requirePresent,
  stage,
  type ProductionJourney,
} from "../contract.js";
import {
  CERT_EPOCH_ISO,
  CERT_NOW,
  CERT_SIGNER_ADAPTER,
  CERT_SERVICE_PRINCIPAL,
  CHAIN,
  CUSTOMER_APPROVER_REF,
  CUSTOMER_WALLET,
  ETH_ASSET,
  PAYEE,
  USC_ASSET,
  certApprovalSurface,
  certBestExecutionPolicy,
  certProtocolInstances,
  certSecurityPolicy,
  certSecurityState,
  certVenuePacks,
  recheckObservationFor,
  requestFromPrepared,
  submitAtTrustedSurface,
  uscWalletObservation,
} from "../world.js";

/** "Swap $1,000 USDC into ETH" — 1_000.00 USC (10^9 minor) EXACT_INPUT. */
export const JOURNEY_B_INPUT_MINOR = "1000000000" as const;

export const journeyB: ProductionJourney = {
  journeyId: "journey:b-dex-optimization",
  letter: "B",
  title: "DEX optimization — \u201cSwap $1,000 USDC into ETH\u201d",
  spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §35 Journey B",
  run: (): ReturnType<typeof assembleJourneyOutcome> => {
    const swap: SwapRequest = {
      requestId: "swap:cert:b:usd1000-usdc-eth",
      chain: CHAIN,
      inputAsset: USC_ASSET,
      outputAsset: ETH_ASSET,
      swapKind: "EXACT_INPUT",
      amount: { currency: "USC", minorUnits: JOURNEY_B_INPUT_MINOR },
      maxSlippageBasisPoints: 300,
    };
    const { engine } = engineFromVenuePacks([...certVenuePacks()]);
    const engineInput = {
      executionId: "exec:cert:b",
      swap,
      policy: certBestExecutionPolicy(),
      security: { policy: certSecurityPolicy(), state: certSecurityState() } as const,
      instances: [...certProtocolInstances()],
      owner: CUSTOMER_WALLET,
      beneficiary: PAYEE,
      requestedBy: "agent:certification-key-1",
      routeExpiryMs: CERT_NOW + 600_000,
      at: CERT_NOW,
    } as const;

    // ------------------------------------------------------------------
    // 1. Multiple routes collected + 2. total economic outcome (exact math)
    // ------------------------------------------------------------------
    const decision = engine.execute(engineInput);
    if (decision.decision !== "ROUTE_SELECTED") {
      throw new Error(`production journey structural prerequisite failed: the engine must select a route (got ${decision.decision}: ${decision.detail})`);
    }
    const selected = decision.selected;

    // ------------------------------------------------------------------
    // 3. Security screens + 4. simulation (per-candidate, engine-driven)
    // ------------------------------------------------------------------
    const laneResult = discoverOnchainLane({
      engine,
      ...engineInput,
      assetObservations: [uscWalletObservation()],
    });
    if (laneResult.status !== "LANE_PROVED") {
      throw new Error(`production journey structural prerequisite failed: the lane must be proved (${laneResult.status})`);
    }
    const lane = laneResult.lane;

    // ------------------------------------------------------------------
    // 5. Authorization (the REAL kernel over the SAME write)
    // ------------------------------------------------------------------
    const pipeline = new OnchainWritePipeline({
      request: requestFromPrepared(lane.write),
      policy: certSecurityPolicy(),
      at: CERT_NOW,
    });
    journeyRequires(
      pipeline.prepared.writeDigest === lane.write.writeDigest,
      "the pipeline must walk the engine's write (digest equality)",
    );
    const gateDecision = pipeline.runGates(certSecurityState(), CERT_NOW);
    journeyRequires(gateDecision.decision === "ALLOW", `the kernel gates must ALLOW (got ${gateDecision.decision})`);
    const diff = pipeline.buildExpectedDiff(CERT_NOW);
    const authorizationRequest = pipeline.buildAuthorizationRequest({
      requestId: "authreq:cert:b",
      principal: CERT_SERVICE_PRINCIPAL,
      requestedAt: CERT_NOW,
    });
    const artifact = pipeline.authorize({
      surface: certApprovalSurface(),
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: certSecurityState(),
      expiresAt: CERT_NOW + 600_000,
      at: CERT_NOW + 1,
    });
    const recheck = pipeline.recheck(
      recheckObservationFor(pipeline.prepared, certSecurityState({ observedAt: CERT_NOW + 2 }), CERT_NOW + 2),
      CERT_NOW + 2,
    );
    journeyRequires(recheck.outcome === "RECHECK_OK", "the pre-broadcast recheck must pass");
    const signingRequest = pipeline.handoffForBroadcast({
      requestId: "signreq:cert:b",
      adapter: CERT_SIGNER_ADAPTER,
      at: CERT_NOW + 3,
    });
    const handoffReceipt = submitAtTrustedSurface(signingRequest, "tx:cert:b:1", CERT_NOW + 4_000);

    // ------------------------------------------------------------------
    // 6. Execution (the canonical record lifecycle) + 7. reconciliation
    // ------------------------------------------------------------------
    const record = RouteExecutionRecord.open(decision);
    record.recordPreparedWrite(selected.write, CERT_NOW + 4);
    record.recordGateDecision(selected.gateDecision, CERT_NOW + 4);
    record.recordBroadcastHandoff(signingRequest.requestId, CERT_NOW + 4);
    const execution = executeOnchainLane({
      lane,
      at: CERT_NOW + 5,
      observedAtIso: CERT_EPOCH_ISO,
      executionRef: record.executionRef,
    });
    if (execution.status !== "EXECUTED") {
      throw new Error("production journey structural prerequisite failed: the lane walk must execute");
    }
    record.recordExecutionObservation(execution.observation, CERT_NOW + 5);

    const componentSum = lane.evaluation.components.reduce(
      (acc, component) => acc + BigInt(component.numeraireMinorUnits),
      0n,
    );
    const outputComponent = lane.evaluation.components.find(
      (component) => component.kind === "OUTPUT",
    );
    const allowanceDiffEntries = diff.entries.filter((entry) => entry.kind === "approval");

    const stages = [
      stage(
        "ROUTE_COLLECTION",
        "the engine collected quotes from all three real venues (Uniswap v2, RFQ aggregator, batch intents)",
        decision.ranking.map((trace) => `venue:${trace.venueId}:${trace.quoteProvenance.outcome}`),
        decision.ranking.flatMap((trace) => trace.quoteProvenance.provenance?.evidenceRefs ?? []),
      ),
      stage(
        "TOTAL_ECONOMIC_OUTCOME",
        "each candidate's total economic outcome computed in exact integer/rational arithmetic (output − fees − gas − risk − time)",
        [
          `selected:${selected.venueId}`,
          `netNumeraire:${selected.evaluation.netNumeraireMinorUnits}`,
          `numeraire:${selected.evaluation.numeraire}`,
          ...selected.evaluation.components.map(
            (component) => `${component.kind}:${component.numeraireMinorUnits}`,
          ),
        ],
        [`evaluation:${selected.routeRef}`],
      ),
      stage(
        "SECURITY_SCREENS",
        "every candidate was screened by the deterministic kernel gates; only gate-ALLOWed routes are selectable",
        decision.ranking.map((trace) => `venue:${trace.venueId}:gate:${trace.security.gateDecision}`),
        [`policy:${certSecurityPolicy().policyId}@${certSecurityPolicy().version}`],
      ),
      stage(
        "SIMULATION",
        "the selected venue supports simulation and the engine recorded the venue simulation observation before gating",
        [
          `simulation:${selected.simulation?.simulationId ?? "none"}`,
          `venueSupportsSimulation:${selected.simulation !== undefined}`,
        ],
        [`simulation:${selected.simulation?.simulationId ?? "none"}`],
      ),
      stage(
        "AUTHORIZATION",
        "the kernel pipeline authorized the SAME write (digest-bound) with explicit signing at the injected trusted surface and a passing pre-broadcast recheck",
        [
          `write:${pipeline.prepared.writeDigest}`,
          `authorizationRequest:${authorizationRequest.requestHash}`,
          `artifact:${artifact.signature.slice(0, 16)}`,
          `recheck:${recheck.outcome}`,
        ],
        [`evidence:authorization:${authorizationRequest.requestHash}`, ...handoffReceipt.evidenceRefs],
      ),
      stage(
        "EXECUTION",
        "the execution record walked the canonical lifecycle to EXECUTED_CANDIDATE over the kernel-validated CONFIRMED observation",
        [
          `record:${record.status}`,
          `executionRef:${record.executionRef}`,
          `outcome:${execution.outcome}`,
          `lifecycle:${execution.lifecycleStages.join(">")}`,
        ],
        [...execution.evidenceRefs],
      ),
      stage(
        "RECONCILIATION",
        "the canonical settlement mapping produced the rail outcome, settlement-attempt event candidate and rail-operation binding for the executed observation",
        [
          `railOutcome:${execution.railOutcome.kind}`,
          `eventCandidate:${execution.eventCandidate.kind === "EVENT_CANDIDATE" ? execution.eventCandidate.event : execution.eventCandidate.reason}`,
          `railOperation:${execution.railOperation.railId}`,
        ],
        [...execution.railOutcome.evidenceRefs],
      ),
    ];

    const assertions = [
      assertionFromChecks(
        "b:multiple-routes-collected",
        [
          { check: "three venues were asked and all three quoted", passed: decision.ranking.length === 3 && decision.ranking.every((trace) => trace.quoteProvenance.outcome === "QUOTED") },
          { check: "one SELECTED + runner-ups recorded (a real competition)", passed: decision.ranking.filter((trace) => trace.status === "SELECTED").length === 1 && decision.ranking.some((trace) => trace.status === "RUNNER_UP") },
          { check: "the provider-native baseline competed on identical terms (INV-C08)", passed: lane.isVenueNativeBaseline === true },
        ],
        decision.ranking.flatMap((trace) => trace.quoteProvenance.provenance?.evidenceRefs ?? []),
      ),
      assertionFromChecks(
        "b:total-economic-outcome-exact",
        [
          { check: "net outcome equals the exact sum of its valued components (bigint)", passed: componentSum === BigInt(selected.evaluation.netNumeraireMinorUnits) },
          { check: "the OUTPUT component is grounded in the quote's worst-case output", passed: outputComponent !== undefined && BigInt(outputComponent.numeraireMinorUnits) > 0n },
          { check: "the swap input is exactly $1,000.00 USC", passed: lane.quote.inputAsset.symbol === "USC" && lane.quote.inputAmount.minorUnits === JOURNEY_B_INPUT_MINOR },
        ],
        [`evaluation:${selected.routeRef}`],
      ),
      assertionFromChecks(
        "b:security-screens",
        [
          { check: "the selected route is gate-ALLOWed", passed: selected.gateDecision.decision === "ALLOW" },
          { check: "the kernel pipeline agrees on the SAME write (digest equality)", passed: pipeline.prepared.writeDigest === lane.write.writeDigest },
          { check: "the swap write declares its approval (allowance change visible)", passed: lane.write.approvals.length === 1 },
        ],
        [...selected.gateDecision.evidenceRefs],
      ),
      assertionFromChecks(
        "b:simulation",
        [
          { check: "the simulation-supporting venue's observation was recorded by the engine", passed: selected.simulation !== undefined && selected.simulation.status === "SUCCEEDED" },
          { check: "the lane proof carries the simulation", passed: lane.simulation !== undefined },
        ],
        [`simulation:${selected.simulation?.simulationId ?? "none"}`],
      ),
      assertionFromChecks(
        "b:authorization",
        [
          { check: "explicit signing at the trusted surface (approver = the customer)", passed: artifact.principal === CUSTOMER_APPROVER_REF },
          { check: "the expected-state diff shows the allowance change (router approval) and balance deltas", passed: lane.expectedDiff.entries.some((entry) => entry.kind === "approval") && lane.expectedDiff.entries.some((entry) => entry.kind === "balance") },
          { check: "pre-broadcast recheck passed before handoff", passed: recheck.outcome === "RECHECK_OK" },
          { check: "the kernel ends at BROADCAST_HANDOFF (it never broadcasts)", passed: pipeline.state === "BROADCAST_HANDOFF" },
        ],
        [`evidence:authorization:${authorizationRequest.requestHash}`],
      ),
      assertionFromChecks(
        "b:execution-and-reconciliation",
        [
          { check: "execution record reached EXECUTED_CANDIDATE (terminal)", passed: record.status === "EXECUTED_CANDIDATE" },
          { check: "the confirming observation carries a finality candidate (candidate-only)", passed: record.finalityCandidate?.candidateOnly === true },
          { check: "the observation outcome is CONFIRMED via the kernel validator", passed: execution.observation.outcome === "CONFIRMED" },
          { check: "the rail outcome maps to an observed effect requiring protocol finality", passed: execution.railOutcome.kind === "RAIL_EFFECT_OBSERVED" },
          { check: "a CONFIRM_SUCCEEDED settlement-attempt event candidate was produced (the reconciliation feed)", passed: execution.eventCandidate.kind === "EVENT_CANDIDATE" && execution.eventCandidate.event === "CONFIRM_SUCCEEDED" },
          { check: "every definitive state carries evidence", passed: execution.evidenceRefs.length > 0 && handoffReceipt.evidenceRefs.length > 0 },
        ],
        [...execution.evidenceRefs],
      ),
    ];

    return assembleJourneyOutcome({ journey: journeyB, stages, assertions });
  },
};
