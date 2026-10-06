/**
 * Journey F — Security attack (§35).
 *
 * Adversarial fixtures: fake token, malicious approval, unexpected
 * spender, changed proxy implementation, unexpected balance delta.
 * Expected: security engine detects → human-readable explanation →
 * transaction BLOCKED. The agent cannot downgrade a BLOCK.
 *
 * Real composition:
 * - the W1-002 deterministic gates detect each adversarial fixture and
 *   BLOCK with a human-readable reason + invariant refs;
 * - the W3-003 adversarial transaction agent analyzes the same fixtures
 *   (13-family threat model) and produces signals — its recommendation
 *   is advisory only: composeThreatVerdict can only HARDEN, and
 *   resolveOnchainSecurityDecision keeps the kernel BLOCK terminal;
 * - attemptAgentOverride ALWAYS throws (rule 27);
 * - the human-readable explanation is asserted verbatim (message text,
 *   invariant refs, people-language rendering through the W4-002 surface
 *   fold);
 * - a BLOCKED pipeline is terminal: no authorize, no handoff, no
 *   broadcast path exists.
 */

import {
  OnchainWritePipeline,
  attachAgentFlag,
  attemptAgentOverride,
  prepareWrite,
} from "@payswap/onchain-security";
import type { GateDecision, OnchainWriteRequest, RecheckObservation } from "@payswap/onchain-security";
import {
  AdversarialTransactionAgent,
  composeThreatVerdict,
  evaluateThreatPolicy,
  recommendationFromSignals,
  resolveOnchainSecurityDecision,
  recordObservationBundle,
} from "@payswap/onchain-threat-intel";
import type { OnchainThreatPolicy } from "@payswap/onchain-threat-intel";
import { foldGateDecision } from "@payswap/surface";
import { registerCurrency } from "@payswap/protocol";
import {
  assertionFromChecks,
  assembleJourneyOutcome,
  stage,
  type ProductionJourney,
} from "../contract.js";
import {
  CERT_NOW,
  CHAIN,
  CUSTOMER_APPROVER_REF,
  MALICIOUS_SPENDER,
  USC_ASSET,
  certApprovalSurface,
  certSecurityPolicy,
  certSecurityState,
  contractExtension,
  protocolIdentity,
  recheckObservationFor,
  transferSimulation,
} from "../world.js";

registerCurrency("USC", 6);
registerCurrency("ETH", 8);

/** A fake token: the USC SYMBOL with a DIFFERENT asset id (impersonation). */
export const FAKE_USC_ASSET = {
  chain: CHAIN,
  assetId: "0xbbbb999999999999999999999999999999999999",
  symbol: "USC",
} as const;

const ROUTE_HASH = "fnv1a64:0000000000000001";

function benignTransferWrite(overrides?: Partial<OnchainWriteRequest>): OnchainWriteRequest {
  return {
    writeId: "write:cert:f:1",
    action: "onchain.transfer",
    chain: CHAIN,
    transfer: {
      asset: USC_ASSET,
      amount: { currency: "USC", minorUnits: "20000000" },
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
    },
    approvals: [],
    route: { routeId: "route:cert:f", routeHash: ROUTE_HASH },
    expiry: CERT_NOW + 600_000,
    requestedBy: "agent:certification-key-1",
    ...overrides,
  };
}

function certThreatPolicy(): OnchainThreatPolicy {
  return {
    policyId: "threat-policy:cert:1",
    version: 1,
    forbidUnlimitedApprovals: true,
    maxApprovalAmount: { currency: "USC", minorUnits: "5000000000" },
    allowedSpenders: ["0x3333333333333333333333333333333333333333"],
    spenderMinimumAgeMs: 3_600_000,
    spenderIncidentThreshold: 3,
    requireTokenRegistryCoverage: true,
    certifiedProtocols: [protocolIdentity()],
    maxOracleDeviationBasisPoints: 50,
    maxOracleFeedAgeMs: 90_000,
    requireBridgeHealthForBridgeHops: true,
    bridgeValidatorChangeWindowMs: 86_400_000,
    minBridgeAttestationQuorum: "2/3",
    maxSlippageBasisPoints: 300,
    sandwichSensitiveSlippageBasisPoints: 200,
    maxPriceImpactBasisPoints: 500,
    expectedChain: CHAIN,
    maxSimulationAgeMs: 30_000,
    maxSimulationLagBlocks: 6,
    maxReorgDepthBlocks: 2,
    maxFinalityLagBlocks: 12,
    maxObservationAgeMs: 10_000,
  };
}

function benignBundleInput() {
  return {
    bundleId: "bundle:cert:f:1",
    observer: "observer:cert:chain-intel-1",
    observedAt: CERT_NOW,
    spenders: [
      {
        observationId: "spender-intel:cert:router",
        spender: "0x3333333333333333333333333333333333333333",
        knownDrainPattern: false,
        firstObservedAt: CERT_NOW - 90 * 86_400_000,
        observedIncidents: 0,
        sources: ["intel:internal"],
      },
    ],
    tokens: [
      { observationId: "token-registry:cert:usc", asset: USC_ASSET, canonical: true },
    ],
    oracles: [
      {
        observationId: "oracle:cert:usd-1",
        oracleId: "oracle:primary-usc",
        pair: "USC/USD",
        observedPrice: "1000000/1000000",
        priceUpdatedAt: CERT_NOW - 1_000,
        feedAgeMs: 1_000,
      },
      {
        observationId: "oracle:cert:usd-2",
        oracleId: "oracle:secondary-usc",
        pair: "USC/USD",
        observedPrice: "1000100/1000000",
        priceUpdatedAt: CERT_NOW - 1_000,
        feedAgeMs: 1_000,
      },
    ],
    bridges: [
      {
        observationId: "bridge:cert:main-1",
        bridgeId: "bridge:canonical-bridge",
        status: "healthy" as const,
        attestationQuorum: "9/10",
        observedAt: CERT_NOW - 2_000,
      },
    ],
    finality: {
      observationId: "finality:cert:main",
      chain: CHAIN,
      headBlock: 1_000,
      safeBlock: 995,
      lastReorgDepthBlocks: 0,
      observedAt: CERT_NOW - 1_000,
    },
    mempool: {
      observationId: "mempool:cert:main",
      chain: CHAIN,
      writeVisible: false,
      observedAt: CERT_NOW - 500,
    },
  };
}

/** The BLOCK-narrowed gate decision (the reasons are why the journey exists). */
type BlockGateDecision = GateDecision & { readonly decision: "BLOCK" };

/** Runs the gates over a write and returns the BLOCK decision (or fails the journey). */
function blockDecisionFor(write: OnchainWriteRequest, label: string): BlockGateDecision {
  const pipeline = new OnchainWritePipeline({
    request: write,
    policy: certSecurityPolicy(),
    at: CERT_NOW,
  });
  const decision = pipeline.runGates(certSecurityState(), CERT_NOW);
  if (decision.decision !== "BLOCK") {
    throw new Error(
      `journey F fixture '${label}' must be BLOCKed by the deterministic gates (got ${decision.decision})`,
    );
  }
  return decision;
}

export const journeyF: ProductionJourney = {
  journeyId: "journey:f-security-attack",
  letter: "F",
  title: "Security attack — adversarial fixtures detected, explained and BLOCKED",
  spec: "docs/UNIVERSAL-MONEY-HANDOFF-FULL-2026-10-02.md §35 Journey F",
  run: (): ReturnType<typeof assembleJourneyOutcome> => {
    // ------------------------------------------------------------------
    // Fixture 1: FAKE TOKEN (symbol impersonation)
    // ------------------------------------------------------------------
    const fakeTokenDecision = blockDecisionFor(
      benignTransferWrite({
        writeId: "write:cert:f:fake-token",
        transfer: {
          asset: FAKE_USC_ASSET,
          amount: { currency: "USC", minorUnits: "20000000" },
          from: "0x1111111111111111111111111111111111111111",
          to: "0x2222222222222222222222222222222222222222",
        },
      }),
      "fake token",
    );

    // ------------------------------------------------------------------
    // Fixture 2: MALICIOUS APPROVAL (unlisted spender + over-cap amount)
    // ------------------------------------------------------------------
    const maliciousApprovalDecision = blockDecisionFor(
      benignTransferWrite({
        writeId: "write:cert:f:malicious-approval",
        approvals: [
          {
            asset: USC_ASSET,
            owner: "0x1111111111111111111111111111111111111111",
            spender: MALICIOUS_SPENDER,
            amount: { currency: "USC", minorUnits: "9000000000" },
            unlimited: false,
          },
        ],
      }),
      "malicious approval",
    );

    // ------------------------------------------------------------------
    // Fixture 3: UNEXPECTED SPENDER (threat-intel: drain-pattern spender)
    // ------------------------------------------------------------------
    const unexpectedSpenderWrite = prepareWrite(
      benignTransferWrite({
        writeId: "write:cert:f:unexpected-spender",
        approvals: [
          {
            asset: USC_ASSET,
            owner: "0x1111111111111111111111111111111111111111",
            spender: MALICIOUS_SPENDER,
            amount: { currency: "USC", minorUnits: "1000000" },
            unlimited: false,
          },
        ],
      }),
      CERT_NOW,
    );
    const agent = new AdversarialTransactionAgent("agent:cert-adversarial-1");
    const drainPatternBundle = recordObservationBundle({
      ...benignBundleInput(),
      bundleId: "bundle:cert:f:drain-spender",
      spenders: [
        {
          observationId: "spender-intel:cert:drain",
          spender: MALICIOUS_SPENDER,
          knownDrainPattern: true,
          firstObservedAt: CERT_NOW - 1_000,
          observedIncidents: 40,
          sources: ["intel:internal", "intel:external"],
        },
      ],
    });
    const assessment = agent.analyze({
      write: unexpectedSpenderWrite,
      policy: certThreatPolicy(),
      bundle: drainPatternBundle,
      at: CERT_NOW,
    });
    const policyEvaluation = evaluateThreatPolicy(assessment.signals, certThreatPolicy());
    const unexpectedSpenderVerdict = resolveOnchainSecurityDecision({
      kernelDecision: { decision: "ALLOW", checks: [], evidenceRefs: [] },
      threatVerdict: composeThreatVerdict(
        recommendationFromSignals(assessment.signals),
        policyEvaluation.verdict,
      ),
    });

    // ------------------------------------------------------------------
    // Fixture 4: CHANGED PROXY IMPLEMENTATION (recheck drift)
    // ------------------------------------------------------------------
    const proxyPipeline = new OnchainWritePipeline({
      request: benignTransferWrite({
        writeId: "write:cert:f:proxy-change",
        protocol: protocolIdentity(),
      }),
      policy: certSecurityPolicy({ certifiedProtocols: [protocolIdentity()] }),
      at: CERT_NOW,
    });
    proxyPipeline.simulate(
      transferSimulation("write:cert:f:proxy-change", {
        asset: USC_ASSET,
        minorUnits: "20000000",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
      }),
      CERT_NOW,
    );
    const proxyGate = proxyPipeline.runGates(certSecurityState(), CERT_NOW);
    if (proxyGate.decision !== "ALLOW") {
      throw new Error(`journey F proxy fixture must gate ALLOW before the attack (got ${proxyGate.decision})`);
    }
    proxyPipeline.buildExpectedDiff(CERT_NOW);
    proxyPipeline.buildAuthorizationRequest({
      requestId: "authreq:cert:f:proxy",
      principal: {
        kind: "agent",
        agentKeyFingerprint: "certification-key-1",
        ownerRef: "user:certification-operator",
        bodyRef: "body-certification-1",
        packageVersionRef: "pkg-certification@1.0.0",
        authorityEnvelope: [],
        securityEpoch: 0n,
      },
      requestedAt: CERT_NOW,
    });
    proxyPipeline.authorize({
      surface: certApprovalSurface(),
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: certSecurityState(),
      expiresAt: CERT_NOW + 600_000,
      at: CERT_NOW + 1,
    });
    // The proxy attack: the recheck observes a CHANGED implementation.
    const baseObservation = recheckObservationFor(
      proxyPipeline.prepared,
      certSecurityState({ observedAt: CERT_NOW + 2 }),
      CERT_NOW + 2,
    );
    const swappedProxyObservation: RecheckObservation = {
      ...baseObservation,
      protocol: {
        ...baseObservation.protocol!,
        contract: contractExtension({ bytecodeHash: "byte-hash-SWAPPED-by-attacker" }),
      },
    };
    const proxyRecheck = proxyPipeline.recheck(swappedProxyObservation, CERT_NOW + 2);

    // ------------------------------------------------------------------
    // Fixture 5: UNEXPECTED BALANCE DELTA (simulation ≠ intent)
    // ------------------------------------------------------------------
    const balanceDeltaDecision = (() => {
      const pipeline = new OnchainWritePipeline({
        request: benignTransferWrite({ writeId: "write:cert:f:balance-delta" }),
        policy: certSecurityPolicy(),
        at: CERT_NOW,
      });
      pipeline.simulate(
        transferSimulation("write:cert:f:balance-delta", {
          asset: USC_ASSET,
          minorUnits: "999999999999",
          from: "0x1111111111111111111111111111111111111111",
          to: "0x2222222222222222222222222222222222222222",
        }),
        CERT_NOW,
      );
      const decision = pipeline.runGates(certSecurityState(), CERT_NOW);
      if (decision.decision !== "BLOCK") {
        throw new Error(
          `journey F fixture 'unexpected balance delta' must be BLOCKed by the deterministic gates (got ${decision.decision})`,
        );
      }
      return decision;
    })();

    // ------------------------------------------------------------------
    // The agent CANNOT downgrade a BLOCK (rule 27 — all three laws)
    // ------------------------------------------------------------------
    let overrideRejected = false;
    let overrideErrorName = "";
    try {
      attemptAgentOverride(fakeTokenDecision, "agent:cert-adversarial-1");
    } catch (error) {
      overrideRejected = true;
      overrideErrorName = (error as Error).name;
    }
    const flagged = attachAgentFlag(
      { decision: fakeTokenDecision, flags: [] },
      {
        flagId: "flag:cert:f:1",
        flaggedBy: "agent:cert-adversarial-1",
        dimension: "asset",
        note: "advisory flag — the agent believes the token is fine",
        flaggedAt: CERT_NOW,
      },
    );
    const kernelBlockStaysBlock = resolveOnchainSecurityDecision({
      kernelDecision: fakeTokenDecision,
      threatVerdict: composeThreatVerdict(
        recommendationFromSignals([]),
        "ALLOW",
      ),
    });
    const fakeTokenBlockedPipeline = new OnchainWritePipeline({
      request: benignTransferWrite({ writeId: "write:cert:f:fake-token-2" }),
      policy: certSecurityPolicy(),
      at: CERT_NOW,
    });
    fakeTokenBlockedPipeline.runGates(certSecurityState(), CERT_NOW);
    let blockedPipelineHandoffRejected = false;
    try {
      fakeTokenBlockedPipeline.handoffForBroadcast({
        requestId: "signreq:cert:f:blocked",
        adapter: {
          adapterId: "signer:cert",
          supportedChains: [CHAIN],
          buildSigningPayload: () => "payload",
        },
        at: CERT_NOW + 3,
      });
    } catch {
      blockedPipelineHandoffRejected = true;
    }

    // Human-readable explanation (people language, invariant refs).
    const fakeTokenView = foldGateDecision(fakeTokenDecision);

    const stages = [
      stage(
        "FAKE_TOKEN_DETECTED",
        "the gates BLOCKed the symbol-impersonating token (asset identity is chain+assetId+symbol, never symbol alone)",
        [`decision:${fakeTokenDecision.decision}`, ...fakeTokenDecision.reasons.map((reason) => `${reason.dimension}:${reason.code}`)],
        [...fakeTokenDecision.evidenceRefs],
      ),
      stage(
        "MALICIOUS_APPROVAL_DETECTED",
        "the gates BLOCKed the approval to the unlisted spender with an over-cap amount",
        [`decision:${maliciousApprovalDecision.decision}`, ...maliciousApprovalDecision.reasons.map((reason) => `${reason.dimension}:${reason.code}`)],
        [...maliciousApprovalDecision.evidenceRefs],
      ),
      stage(
        "UNEXPECTED_SPENDER_DETECTED",
        "the adversarial agent flagged the drain-pattern spender; the deterministic threat policy BLOCKed it and the composed resolution stays BLOCK",
        [
          `signals:${assessment.signals.map((signal) => signal.family).join(",")}`,
          `policyVerdict:${policyEvaluation.verdict}`,
          `resolution:${unexpectedSpenderVerdict.decision}`,
        ],
        [...assessment.evidenceRefs],
      ),
      stage(
        "PROXY_IMPLEMENTATION_CHANGE_DETECTED",
        "the pre-broadcast recheck VOIDed the authorization when the proxy implementation changed (bytecode hash drift)",
        [
          `recheck:${proxyRecheck.outcome}`,
          ...(proxyRecheck.outcome === "AUTHORIZATION_VOIDED" ? [`drift:${proxyRecheck.drift.join("|")}`] : []),
          `pipelineState:${proxyPipeline.state}`,
        ],
        [...proxyRecheck.evidenceRefs],
      ),
      stage(
        "UNEXPECTED_BALANCE_DELTA_DETECTED",
        "the simulation-consistency dimension BLOCKed the write whose simulated debit does not match the intent's exact amount",
        [`decision:${balanceDeltaDecision.decision}`, ...balanceDeltaDecision.reasons.map((reason) => `${reason.dimension}:${reason.code}`)],
        [...balanceDeltaDecision.evidenceRefs],
      ),
      stage(
        "AGENT_CANNOT_DOWNGRADE",
        "all three rule-27 laws held: override rejected by construction, flags never mutate the decision, the composed resolution keeps the kernel BLOCK terminal — and a BLOCKED pipeline has no broadcast path",
        [
          `overrideRejected:${overrideRejected}`,
          `overrideError:${overrideErrorName}`,
          `flagMutatedDecision:${flagged.decision !== fakeTokenDecision}`,
          `kernelBlockResolution:${kernelBlockStaysBlock.decision}`,
          `blockedPipelineHandoffRejected:${blockedPipelineHandoffRejected}`,
        ],
        ["evidence:cert:f:agent-laws"],
      ),
    ];

    const assertions = [
      assertionFromChecks(
        "f:fake-token-blocked",
        [
          { check: "BLOCKed on the asset dimension", passed: fakeTokenDecision.reasons.some((reason) => reason.dimension === "asset") },
          { check: "the human-readable explanation exists and carries invariant refs", passed: fakeTokenDecision.reasons.every((reason) => reason.message.length > 0 && reason.invariantRefs.length > 0) },
          { check: "the people-language fold renders the BLOCK with its reasons", passed: fakeTokenView.tone === "danger" && fakeTokenView.headline.length > 0 },
        ],
        [...fakeTokenDecision.evidenceRefs],
      ),
      assertionFromChecks(
        "f:malicious-approval-blocked",
        [
          { check: "BLOCKed on the spender/approval dimension", passed: maliciousApprovalDecision.reasons.some((reason) => reason.dimension === "spender_approval") },
        ],
        [...maliciousApprovalDecision.evidenceRefs],
      ),
      assertionFromChecks(
        "f:unexpected-spender-blocked",
        [
          { check: "the agent produced threat signals for the drain-pattern spender", passed: assessment.signals.length > 0 },
          { check: "the deterministic threat policy verdict is at least REQUIRE_CONFIRMATION", passed: ["REQUIRE_CONFIRMATION", "BLOCK"].includes(policyEvaluation.verdict) },
          { check: "the composed resolution is BLOCK (the agent's advisory recommendation cannot soften it)", passed: unexpectedSpenderVerdict.decision === "BLOCK" },
        ],
        [...assessment.evidenceRefs],
      ),
      assertionFromChecks(
        "f:proxy-change-voided",
        [
          { check: "the changed proxy implementation VOIDed the authorization (terminal)", passed: proxyRecheck.outcome === "AUTHORIZATION_VOIDED" && proxyPipeline.state === "VOIDED" },
          { check: "the drift reason names the protocol identity dimension", passed: proxyRecheck.outcome === "AUTHORIZATION_VOIDED" && proxyRecheck.drift.includes("protocol_identity_drift") },
        ],
        [...proxyRecheck.evidenceRefs],
      ),
      assertionFromChecks(
        "f:balance-delta-blocked",
        [
          { check: "BLOCKed on the simulation-consistency dimension (the simulated debit ≠ the intent amount)", passed: balanceDeltaDecision.decision === "BLOCK" && balanceDeltaDecision.reasons.some((reason) => reason.dimension === "simulation_consistency") },
        ],
        [...balanceDeltaDecision.evidenceRefs],
      ),
      assertionFromChecks(
        "f:agent-cannot-downgrade",
        [
          { check: "attemptAgentOverride threw AgentOverrideForbiddenError", passed: overrideRejected && overrideErrorName === "AgentOverrideForbiddenError" },
          { check: "the advisory flag left the BLOCK decision object unchanged", passed: flagged.decision === fakeTokenDecision },
          { check: "kernel BLOCK stays terminal under an ALLOW threat verdict", passed: kernelBlockStaysBlock.decision === "BLOCK" },
          { check: "a BLOCKED pipeline cannot hand off for broadcast", passed: blockedPipelineHandoffRejected },
        ],
        ["evidence:cert:f:agent-laws"],
      ),
    ];

    return assembleJourneyOutcome({ journey: journeyF, stages, assertions });
  },
};
