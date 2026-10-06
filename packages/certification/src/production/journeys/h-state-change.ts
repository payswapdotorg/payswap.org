/**
 * Journey H — State changes before broadcast (§35).
 *
 * quote → approval → state changes → pre-broadcast recheck.
 * Expected: execution invalidated → new simulation → new authorization
 * required.
 *
 * Real composition: the W1-002 kernel pipeline over a quoted write. After
 * the approval (the artifact minted at the trusted surface), the world
 * changes (the network security epoch advances). The immediate
 * pre-broadcast recheck detects the drift and VOIDS the authorization
 * (terminal). The VOIDED pipeline can never hand off — a new pipeline
 * requires a NEW simulation and a NEW authorization (different request
 * hash, different artifact, fresh evidence chain).
 */

import { OnchainWritePipeline } from "@payswap/onchain-security";
import {
  assertionFromChecks,
  assembleJourneyOutcome,
  journeyRequires,
  stage,
  type ProductionJourney,
} from "../contract.js";
import {
  CERT_NOW,
  CERT_SIGNER_ADAPTER,
  CERT_SERVICE_PRINCIPAL,
  CHAIN,
  CUSTOMER_APPROVER_REF,
  USC_ASSET,
  certApprovalSurface,
  certSecurityPolicy,
  certSecurityState,
  recheckObservationFor,
  requestFromPrepared,
  transferSimulation,
} from "../world.js";
import type { OnchainWriteRequest } from "@payswap/onchain-security";

function quotedWriteRequest(): OnchainWriteRequest {
  return {
    writeId: "write:cert:h:1",
    action: "onchain.transfer",
    chain: CHAIN,
    transfer: {
      asset: USC_ASSET,
      amount: { currency: "USC", minorUnits: "20000000" },
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
    },
    approvals: [],
    route: { routeId: "route:cert:h", routeHash: "fnv1a64:0000000000000002" },
    expiry: CERT_NOW + 600_000,
    requestedBy: "agent:certification-key-1",
  };
}

export const journeyH: ProductionJourney = {
  journeyId: "journey:h-state-change-before-broadcast",
  letter: "H",
  title: "State changes before broadcast — quote → approval → state change → recheck VOID → new simulation + new authorization",
  spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §35 Journey H",
  run: (): ReturnType<typeof assembleJourneyOutcome> => {
    // ------------------------------------------------------------------
    // 1. Quote (the kernel prepares over the quoted write)
    // ------------------------------------------------------------------
    const pipeline = new OnchainWritePipeline({
      request: quotedWriteRequest(),
      policy: certSecurityPolicy(),
      at: CERT_NOW,
    });
    pipeline.simulate(
      transferSimulation("write:cert:h:1", {
        asset: USC_ASSET,
        minorUnits: "20000000",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
      }),
      CERT_NOW,
    );
    const gateDecision = pipeline.runGates(certSecurityState(), CERT_NOW);
    journeyRequires(gateDecision.decision === "ALLOW", "the quoted write must gate ALLOW");
    const diff = pipeline.buildExpectedDiff(CERT_NOW);

    // ------------------------------------------------------------------
    // 2. Approval (the authorization request + artifact at the surface)
    // ------------------------------------------------------------------
    const firstRequest = pipeline.buildAuthorizationRequest({
      requestId: "authreq:cert:h:1",
      principal: CERT_SERVICE_PRINCIPAL,
      requestedAt: CERT_NOW,
    });
    const firstArtifact = pipeline.authorize({
      surface: certApprovalSurface(),
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: certSecurityState(),
      expiresAt: CERT_NOW + 300_000,
      at: CERT_NOW + 1,
    });

    // ------------------------------------------------------------------
    // 3. State changes (the network security epoch advances)
    // ------------------------------------------------------------------
    const changedState = certSecurityState({
      observedAt: CERT_NOW + 2_000,
      networkEpoch: 1n,
    });

    // ------------------------------------------------------------------
    // 4. Pre-broadcast recheck → execution INVALIDATED
    // ------------------------------------------------------------------
    const recheck = pipeline.recheck(
      recheckObservationFor(pipeline.prepared, changedState, CERT_NOW + 2_000),
      CERT_NOW + 2_000,
    );
    journeyRequires(
      recheck.outcome === "AUTHORIZATION_VOIDED",
      `the epoch drift must VOID the authorization (got ${recheck.outcome})`,
    );

    // The VOIDED pipeline has no broadcast path.
    let voidedHandoffRejected = false;
    let voidedAuthorizeRejected = false;
    try {
      pipeline.handoffForBroadcast({
        requestId: "signreq:cert:h:voided",
        adapter: CERT_SIGNER_ADAPTER,
        at: CERT_NOW + 3_000,
      });
    } catch {
      voidedHandoffRejected = true;
    }
    try {
      pipeline.authorize({
        surface: certApprovalSurface(),
        approverRef: CUSTOMER_APPROVER_REF,
        securityState: changedState,
        expiresAt: CERT_NOW + 700_000,
        at: CERT_NOW + 3_000,
      });
    } catch {
      voidedAuthorizeRejected = true;
    }

    // ------------------------------------------------------------------
    // 5. New simulation + 6. new authorization required
    // ------------------------------------------------------------------
    const secondPipeline = new OnchainWritePipeline({
      request: requestFromPrepared(pipeline.prepared),
      policy: certSecurityPolicy(),
      at: CERT_NOW + 4_000,
    });
    const secondSimulation = secondPipeline.simulate(
      transferSimulation("write:cert:h:1", {
        asset: USC_ASSET,
        minorUnits: "20000000",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        at: CERT_NOW + 4_000,
      }),
      CERT_NOW + 4_000,
    );
    const secondGate = secondPipeline.runGates(changedState, CERT_NOW + 4_000);
    journeyRequires(secondGate.decision === "ALLOW", "the fresh gates must ALLOW under the new epoch");
    secondPipeline.buildExpectedDiff(CERT_NOW + 4_000);
    const secondRequest = secondPipeline.buildAuthorizationRequest({
      requestId: "authreq:cert:h:2",
      principal: CERT_SERVICE_PRINCIPAL,
      requestedAt: CERT_NOW + 4_000,
    });
    const secondArtifact = secondPipeline.authorize({
      surface: certApprovalSurface(),
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: changedState,
      expiresAt: CERT_NOW + 300_000,
      at: CERT_NOW + 5_000,
    });
    const secondRecheck = secondPipeline.recheck(
      recheckObservationFor(secondPipeline.prepared, changedState, CERT_NOW + 6_000),
      CERT_NOW + 6_000,
    );
    journeyRequires(secondRecheck.outcome === "RECHECK_OK", "the fresh authorization must pass its recheck");
    const secondSigningRequest = secondPipeline.handoffForBroadcast({
      requestId: "signreq:cert:h:2",
      adapter: CERT_SIGNER_ADAPTER,
      at: CERT_NOW + 7_000,
    });

    const stages = [
      stage(
        "QUOTE",
        "the kernel prepared the quoted write and gated it ALLOW",
        [
          `write:${pipeline.prepared.writeDigest}`,
          `gate:${gateDecision.decision}`,
          `diff:${diff.diffDigest}`,
        ],
        [...gateDecision.evidenceRefs],
      ),
      stage(
        "APPROVAL",
        "the first authorization request was built and the artifact minted at the trusted surface",
        [
          `authorizationRequest:${firstRequest.requestHash}`,
          `artifact:${firstArtifact.signature.slice(0, 16)}`,
          `networkEpochAtIssuance:${firstArtifact.networkEpochAtIssuance}`,
        ],
        [`evidence:authorization:${firstRequest.requestHash}`],
      ),
      stage(
        "STATE_CHANGE",
        "the world changed before broadcast: the network security epoch advanced 0→1",
        [`networkEpoch:0→1`, `observedAt:${changedState.observedAt}`],
        ["evidence:cert:h:epoch-bump"],
      ),
      stage(
        "PRE_BROADCAST_RECHECK",
        "the immediate pre-broadcast recheck detected the stale-epoch drift and VOIDED the authorization (terminal)",
        [
          `recheck:${recheck.outcome}`,
          ...(recheck.outcome === "AUTHORIZATION_VOIDED" ? [`drift:${recheck.drift.join("|")}`] : []),
          `pipelineState:${pipeline.state}`,
          `voidedHandoffRejected:${voidedHandoffRejected}`,
          `voidedAuthorizeRejected:${voidedAuthorizeRejected}`,
        ],
        [...recheck.evidenceRefs],
      ),
      stage(
        "NEW_SIMULATION_NEW_AUTHORIZATION",
        "a fresh pipeline ran a NEW simulation under the new epoch, gated ALLOW, and required a NEW authorization (different request hash and artifact) before its own handoff",
        [
          `newSimulation:${secondSimulation.simulationId}:${secondSimulation.status}`,
          `newGate:${secondGate.decision}`,
          `newAuthorizationRequest:${secondRequest.requestHash}`,
          `newArtifact:${secondArtifact.signature.slice(0, 16)}`,
          `newNetworkEpochAtIssuance:${secondArtifact.networkEpochAtIssuance}`,
          `newRecheck:${secondRecheck.outcome}`,
          `newHandoff:${secondSigningRequest.requestId}`,
        ],
        [`evidence:authorization:${secondRequest.requestHash}`],
      ),
    ];

    const assertions = [
      assertionFromChecks(
        "h:quote-and-approval",
        [
          { check: "the quoted write gated ALLOW", passed: gateDecision.decision === "ALLOW" },
          { check: "the first artifact was minted at epoch 0", passed: firstArtifact.networkEpochAtIssuance === 0n },
        ],
        [`evidence:authorization:${firstRequest.requestHash}`],
      ),
      assertionFromChecks(
        "h:recheck-voids",
        [
          { check: "the epoch drift VOIDed the authorization (AUTHORIZATION_VOIDED)", passed: recheck.outcome === "AUTHORIZATION_VOIDED" },
          { check: "the drift reason is stale_network_epoch", passed: recheck.outcome === "AUTHORIZATION_VOIDED" && recheck.drift.includes("stale_network_epoch") },
          { check: "the pipeline is terminally VOIDED", passed: pipeline.state === "VOIDED" },
          { check: "the VOIDED pipeline cannot hand off for broadcast", passed: voidedHandoffRejected },
          { check: "the VOIDED pipeline cannot re-authorize (no auto-repair)", passed: voidedAuthorizeRejected },
        ],
        [...recheck.evidenceRefs],
      ),
      assertionFromChecks(
        "h:new-simulation-and-authorization",
        [
          { check: "the second pipeline ran a NEW simulation (fresh observation instant)", passed: secondSimulation.observedAt === CERT_NOW + 4_000 },
          { check: "the new authorization request differs from the first (re-request, not reuse)", passed: secondRequest.requestHash !== firstRequest.requestHash },
          { check: "the new artifact differs from the first", passed: secondArtifact.signature !== firstArtifact.signature },
          { check: "the new artifact was minted at the NEW epoch", passed: secondArtifact.networkEpochAtIssuance === 1n },
          { check: "the new authorization passed its own recheck and handed off", passed: secondRecheck.outcome === "RECHECK_OK" && secondPipeline.state === "BROADCAST_HANDOFF" },
        ],
        [`evidence:authorization:${secondRequest.requestHash}`],
      ),
    ];

    return assembleJourneyOutcome({ journey: journeyH, stages, assertions });
  },
};
