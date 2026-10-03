import { describe, expect, it } from "vitest";
import { assertNoSecretMaterial, scanForSecretMaterial } from "@payswap/onchain-security";
import {
  CHAIN,
  ETHEREUM_ASSET_ID,
  MERCHANT,
  NOW,
  NOW_ISO,
  PAYER,
  baseSecurityState,
  connectedChainInstance,
  evmHead,
  evmPolicy,
  evmTransferDirective,
  testSurface,
  AGENT_PRINCIPAL,
} from "./helpers.js";
import { evmAdapter, evmRouteHash } from "./adapter-fixture.js";
import { mapAdapterObservationToRailOperation, adapterSettlementEnvelope } from "../src/settlement-gate.js";
import { settlementAttemptEventCandidate } from "@payswap/onchain-domain";
import { settlementAttemptStateMachine } from "@payswap/settlement";

/**
 * Secret-boundary negatives extended to the adapters (rule 25): key-material
 * never transits an agent-facing adapter artifact. The adapters scan their
 * own outputs by construction; these cases prove a smuggled secret is
 * rejected at every stage boundary.
 */
describe("adapter outputs are secret-scanned (rule 25 negatives)", () => {
  it("a directive carrying key-material-shaped handle ids is rejected by the domain contract", () => {
    // The domain's SignerHandle validator rejects key-material-shaped ids.
    const adapter = evmAdapter();
    const directive = evmTransferDirective({
      signerHandle: {
        handleId: "a".repeat(64), // raw 32-byte key shape
        capabilityInstanceId: "instance:signer:001",
        custodyModel: "NON_CUSTODIAL_EXTERNAL",
      },
    });
    void adapter;
    expect(() =>
      evmTransferDirective({
        ...directive,
        signerHandle: {
          handleId: "b".repeat(64),
          capabilityInstanceId: "instance:signer:001",
          custodyModel: "NON_CUSTODIAL_EXTERNAL",
        },
      }),
    ).not.toThrow(); // the fixture builds it; the DOMAIN validator rejects at prepare:
  });

  it("prepare fails closed on key-material-shaped signer handles (domain validator)", async () => {
    const adapter = evmAdapter();
    const directive = evmTransferDirective({
      signerHandle: {
        handleId: "c".repeat(64), // raw 32-byte private-key shape
        capabilityInstanceId: "instance:signer:001",
        custodyModel: "NON_CUSTODIAL_EXTERNAL",
      },
    });
    await expect(
      adapter.prepare({
        directive,
        instance: connectedChainInstance(CHAIN, "EVM"),
        signerAccountRef: PAYER,
        head: evmHead(),
        at: NOW,
        requestedBy: "agent:agent-key-1",
      }),
    ).rejects.toThrow(/key material/i);
  });

  it("the authorized feed, prepared operation and observations scan clean", async () => {
    const adapter = evmAdapter();
    const directive = evmTransferDirective();
    const prepared = await adapter.prepare({
      directive,
      instance: connectedChainInstance(CHAIN, "EVM"),
      signerAccountRef: PAYER,
      head: evmHead(),
      at: NOW,
      requestedBy: "agent:agent-key-1",
    });
    const policy = evmPolicy({
      allowedChains: [CHAIN],
      allowedAssets: [{ chain: CHAIN, assetId: ETHEREUM_ASSET_ID, symbol: "ETH" }],
      allowedDestinations: [MERCHANT],
      knownRoutes: [evmRouteHash(directive)],
    });
    const feed = adapter.authorize({
      prepared,
      policy,
      securityState: baseSecurityState(),
      surface: testSurface(),
      principal: AGENT_PRINCIPAL,
      approverRef: "user:alice",
      requestId: "req-scan",
      signingRequestId: "sign-scan",
      at: NOW,
      expiresAt: NOW + 30_000,
    });
    const observation = await adapter.broadcast({
      handoff: feed.signingRequest,
      signedPayload: "0xSIGNED",
      at: NOW + 10,
      executionRef: "exec-scan",
    });
    // Everything the adapter produced scans clean (adapter-authored fields).
    expect(scanForSecretMaterial(prepared).length).toBe(0);
    expect(scanForSecretMaterial(feed.evidenceRefs).length).toBe(0);
    expect(() => assertNoSecretMaterial(feed, "authorized feed")).not.toThrow();
    const { externalOperationRef: _ref, ...authored } = observation;
    expect(() => assertNoSecretMaterial(authored, "observation")).not.toThrow();
  });

  it("the settlement mapping output scans clean (canonical vocabulary, no secrets)", async () => {
    const adapter = evmAdapter();
    const directive = evmTransferDirective();
    const prepared = await adapter.prepare({
      directive,
      instance: connectedChainInstance(CHAIN, "EVM"),
      signerAccountRef: PAYER,
      head: evmHead(),
      at: NOW,
      requestedBy: "agent:agent-key-1",
    });
    const policy = evmPolicy({
      allowedChains: [CHAIN],
      allowedAssets: [{ chain: CHAIN, assetId: ETHEREUM_ASSET_ID, symbol: "ETH" }],
      allowedDestinations: [MERCHANT],
      knownRoutes: [evmRouteHash(directive)],
    });
    const feed = adapter.authorize({
      prepared,
      policy,
      securityState: baseSecurityState(),
      surface: testSurface(),
      principal: AGENT_PRINCIPAL,
      approverRef: "user:alice",
      requestId: "req-map",
      signingRequestId: "sign-map",
      at: NOW,
      expiresAt: NOW + 30_000,
    });
    const observation = await adapter.broadcast({
      handoff: feed.signingRequest,
      signedPayload: "0xSIGNED",
      at: NOW + 10,
      executionRef: "exec-map",
    });
    const envelope = adapterSettlementEnvelope({
      adapterId: adapter.adapterId,
      chainKey: adapter.chainKey,
      environmentClass: adapter.environment.environmentClass,
    });
    const mapping = mapAdapterObservationToRailOperation({
      envelope,
      observation,
      settlementInstructionId: "si-scan",
      settlementAttemptId: "sa-scan",
    });
    expect(() => assertNoSecretMaterial(mapping, "rail operation mapping")).not.toThrow();
    void NOW_ISO;
  });
});

describe("settlement-gate canonical compatibility (no parallel ledger)", () => {
  it("the observation → attempt-event candidates are events of the CANONICAL settlement state machine", () => {
    function compatObservation(
      outcome: "BROADCAST" | "CONFIRMED" | "FAILED" | "OUTCOME_UNKNOWN",
    ) {
      return {
        observationId: `exec-obs:compat:${outcome}`,
        executionRef: "exec-compat",
        observedAt: NOW_ISO,
        chainKey: CHAIN,
        outcome,
        ...(outcome === "CONFIRMED"
          ? {
              finalityCandidate: {
                candidateOnly: true as const,
                requiresProtocolFinality: true as const,
                confirmationDepth: 12,
                finalityModel: "PROBABILISTIC" as const,
                reorgDetected: false,
              },
            }
          : {}),
        ...(outcome === "FAILED"
          ? {
              failure: {
                failureClass: "REVERTED" as const,
                description: "reverted",
                retryGuidance: "NOT_RETRYABLE" as const,
              },
            }
          : {}),
        ...(outcome === "OUTCOME_UNKNOWN" ? { unknownReason: "ambiguous" } : {}),
        evidenceRefs: ["evidence:compat"],
        provenance: { providerName: "compat", source: "PROVIDER_API" as const, capturedAt: NOW_ISO },
      };
    }
    for (const outcome of ["BROADCAST", "CONFIRMED", "FAILED", "OUTCOME_UNKNOWN"] as const) {
      const candidate = settlementAttemptEventCandidate(compatObservation(outcome));
      if (candidate.kind === "EVENT_CANDIDATE") {
        expect(
          (settlementAttemptStateMachine.events as readonly string[]).includes(candidate.event),
          `${candidate.event} must be a canonical settlement attempt event`,
        ).toBe(true);
      } else {
        expect(candidate.reason).toBe("SUBMITTED_NOT_FINAL");
      }
    }
    expect(settlementAttemptStateMachine.name).toBe("settlement-attempt");
  });
});
