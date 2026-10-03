import { describe, expect, it } from "vitest";
// REAL immune-system machinery (test-level composition: the kernel's src
// boundary forbids importing @payswap/security until the TL merges a
// consumer; the wiring layer produces OnchainSecurityState from these
// exact machines — this test proves the composition contract with them).
import {
  QuarantineLedger,
  SecurityAdvisoryRegistry,
  SecurityEpochAuthority,
} from "@payswap/security";
import { prepareWrite, evaluateOnchainWriteGates, buildAuthorizationRequest } from "../src/index.js";
import { buildExpectedStateDiff, performPreBroadcastRecheck, verifyOnchainAuthorization } from "../src/index.js";
import type { OnchainSecurityState } from "../src/index.js";
import { TrustedApprovalSurface } from "../src/index.js";
import {
  AGENT_PRINCIPAL,
  CHAIN,
  NOW,
  USC_ASSET,
  basePolicy,
  baseSecurityState,
  baseWriteRequest,
  TEST_SURFACE_SIGNER,
} from "./helpers.js";

/**
 * P4-W1-002: the deterministic onchain gates COMPOSE with the existing
 * @payswap/security immune system (AGENTS.md rule 27; INV-S01, INV-S02,
 * INV-S03). The wiring layer derives `OnchainSecurityState` from the real
 * SecurityEpochAuthority / SecurityAdvisoryRegistry / QuarantineLedger;
 * this test drives those real machines and proves:
 *
 * - a quarantined component (from a REAL advisory) BLOCKs the write
 *   (INV-S03 — cached capability state can never bypass);
 * - a network epoch advance past artifact issuance voids verification and
 *   the pre-broadcast recheck (INV-S02);
 * - a fresh epoch + clean quarantine view keeps the pipeline green.
 */

function composeSecurityState(input: {
  readonly epochAuthority: SecurityEpochAuthority;
  readonly advisories: SecurityAdvisoryRegistry;
  readonly quarantine: QuarantineLedger;
  readonly at: number;
}): OnchainSecurityState {
  const active = input.advisories.listActive();
  const restrictedComponents: string[] = [];
  const quarantinedComponents: string[] = [];
  for (const advisory of active) {
    for (const affected of advisory.affected) {
      const key = `${affected.kind}:${affected.id}`;
      const restriction = input.advisories.restrictionFor({
        kind: affected.kind,
        id: affected.id,
      });
      if (restriction.quarantined) {
        quarantinedComponents.push(key);
      } else if (restriction.restricted) {
        restrictedComponents.push(key);
      }
    }
  }
  // Projection follows the REAL ledger semantics: only ACTIVE quarantines
  // block (QuarantineLedger.isQuarantined). A RELEASED quarantine (explicit
  // remediation + advisory closure) must never keep blocking.
  for (const record of input.quarantine.list()) {
    if (record.status === "active") {
      quarantinedComponents.push(`${record.component.kind}:${record.component.id}`);
    }
  }
  return {
    observedAt: input.at,
    networkEpoch: input.epochAuthority.currentEpoch().value,
    quarantinedComponents: [...new Set(quarantinedComponents)],
    restrictedComponents: [...new Set(restrictedComponents)],
    activeAdvisoryRefs: active.map((advisory) => advisory.advisoryId),
  };
}

const ROUTER_COMPONENT = { kind: "extension" as const, id: "0x3333333333333333333333333333333333333333" };

describe("composition with the real security immune system", () => {
  it("a REAL advisory + quarantine of the router/spender BLOCKs the write (INV-S03)", () => {
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();
    const epochAuthority = new SecurityEpochAuthority();

    advisories.publish({
      advisoryId: "adv-router-exploit",
      title: "Router contract exploit in the wild",
      severity: "critical",
      description: "Approvals to the exploited router are being drained",
      affected: [ROUTER_COMPONENT],
      action: "quarantine",
      remediation: { summary: "Revoke approvals; await patched router", workarounds: [] },
      declaredBy: "security:incident-response",
      publishedAt: NOW,
    });
    quarantine.quarantine({
      component: ROUTER_COMPONENT,
      reason: "adv-router-exploit: drain attack observed",
      advisoryRefs: ["adv-router-exploit"],
      at: NOW,
    });

    const state = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW });
    expect(state.quarantinedComponents).toContain(`extension:${ROUTER_COMPONENT.id}`);
    expect(state.activeAdvisoryRefs).toContain("adv-router-exploit");

    const writeRequest = {
      ...baseWriteRequest(),
      approvals: [
        {
          asset: USC_ASSET,
          owner: "0x1111111111111111111111111111111111111111",
          spender: ROUTER_COMPONENT.id,
          amount: { currency: "USC", minorUnits: "1000000" },
          unlimited: false,
        },
      ],
    };
    const write = prepareWrite(writeRequest, NOW);
    const decision = evaluateOnchainWriteGates({
      write,
      policy: basePolicy(),
      securityState: state,
      at: NOW,
    });
    expect(decision.decision).toBe("BLOCK");
    if (decision.decision === "BLOCK") {
      expect(decision.reasons.some((r) => r.code === "component_quarantined_or_restricted")).toBe(true);
      expect(decision.evidenceRefs).toContain("advisory:adv-router-exploit");
    }
  });

  it("a REAL network epoch advance voids a previously issued authorization (INV-S02)", () => {
    const epochAuthority = new SecurityEpochAuthority();
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();

    // Authorize at epoch 0:
    const state = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW });
    const write = prepareWrite(baseWriteRequest(), NOW);
    const decision = evaluateOnchainWriteGates({ write, policy: basePolicy(), securityState: state, at: NOW });
    expect(decision.decision).toBe("ALLOW");
    const diff = buildExpectedStateDiff(write);
    const request = buildAuthorizationRequest({
      requestId: "req-1",
      principal: AGENT_PRINCIPAL,
      write,
      expectedDiff: diff,
      gateDecision: decision,
      requestedAt: NOW,
    });
    const surface = new TrustedApprovalSurface(TEST_SURFACE_SIGNER);
    const artifact = surface.approve({
      request,
      policy: basePolicy(),
      securityState: state,
      approverRef: "user:alice",
      expiresAt: NOW + 30_000,
      at: NOW + 1,
    });
    expect(artifact.networkEpochAtIssuance).toBe(0n);

    // The immune system advances the epoch (a REAL advisory-driven advance):
    epochAuthority.advance({ reason: "coordinated exploit response", at: NOW + 2, advisoryRef: "adv-x" });
    const advancedState = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW + 3 });
    expect(advancedState.networkEpoch).toBe(1n);

    const verification = verifyOnchainAuthorization(artifact, request, NOW + 3, {
      securityState: advancedState,
      trustedSurfaces: [surface],
    });
    expect(verification).toMatchObject({ valid: false, reason: "stale_network_epoch" });

    const recheck = performPreBroadcastRecheck(
      artifact,
      request,
      {
        writeId: write.writeId,
        observedAt: NOW + 3,
        chain: CHAIN,
        writeDigest: write.writeDigest,
        ...(write.transfer !== undefined
          ? { transfer: { asset: write.transfer.asset, amount: write.transfer.amount, to: write.transfer.to } }
          : {}),
        approvals: write.approvals,
        routeHash: write.route.routeHash,
        securityState: advancedState,
      },
      NOW + 3,
    );
    expect(recheck.outcome).toBe("AUTHORIZATION_VOIDED");
    if (recheck.outcome === "AUTHORIZATION_VOIDED") {
      expect(recheck.drift).toContain("stale_network_epoch");
    }
  });

  it("a clean immune-system state keeps the full pipeline green", () => {
    const epochAuthority = new SecurityEpochAuthority();
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();
    const state = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW });
    expect(state.networkEpoch).toBe(0n);
    expect(state.quarantinedComponents).toEqual([]);
    expect(state.restrictedComponents).toEqual([]);

    const write = prepareWrite(baseWriteRequest(), NOW);
    const decision = evaluateOnchainWriteGates({ write, policy: basePolicy(), securityState: state, at: NOW });
    expect(decision.decision).toBe("ALLOW");
  });
  it("a REAL restrict-action advisory (no quarantine) BLOCKs the write (INV-S01 global restriction)", () => {
    const epochAuthority = new SecurityEpochAuthority();
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();
    advisories.publish({
      advisoryId: "adv-router-restricted",
      title: "Router venue under active investigation",
      severity: "high",
      description: "Anomalous routing behavior; restrict while investigating",
      affected: [ROUTER_COMPONENT],
      action: "restrict",
      remediation: { summary: "Complete investigation", workarounds: [] },
      declaredBy: "security:incident-response",
      publishedAt: NOW,
    });
    const state = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW });
    expect(state.restrictedComponents).toContain(`extension:${ROUTER_COMPONENT.id}`);
    expect(state.quarantinedComponents).toEqual([]);
    const writeRequest = {
      ...baseWriteRequest(),
      approvals: [
        {
          asset: USC_ASSET,
          owner: "0x1111111111111111111111111111111111111111",
          spender: ROUTER_COMPONENT.id,
          amount: { currency: "USC", minorUnits: "1000000" },
          unlimited: false,
        },
      ],
    };
    const decision = evaluateOnchainWriteGates({
      write: prepareWrite(writeRequest, NOW),
      policy: basePolicy(),
      securityState: state,
      at: NOW,
    });
    expect(decision.decision).toBe("BLOCK");
    if (decision.decision === "BLOCK") {
      expect(
        decision.reasons.some(
          (r) => r.dimension === "security_state" && r.code === "component_quarantined_or_restricted",
        ),
      ).toBe(true);
    }
  });

  it("a RELEASED quarantine (remediation + advisory closure) no longer blocks", () => {
    const epochAuthority = new SecurityEpochAuthority();
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();
    advisories.publish({
      advisoryId: "adv-router-fix",
      title: "Router exploit patched",
      severity: "critical",
      description: "Exploit confirmed at publication; patched router verified since",
      affected: [ROUTER_COMPONENT],
      action: "quarantine",
      remediation: { summary: "Upgrade to the patched router", patchedVersion: "1.1.0", workarounds: [] },
      declaredBy: "security:incident-response",
      publishedAt: NOW - 10_000,
    });
    const record = quarantine.quarantine({
      component: ROUTER_COMPONENT,
      reason: "adv-router-fix: drain attack observed",
      advisoryRefs: ["adv-router-fix"],
      at: NOW - 10_000,
    });
    advisories.close({
      advisoryId: "adv-router-fix",
      closedAt: NOW - 5_000,
      closureNote: "patched router verified onchain",
      remediationVerified: true,
    });
    quarantine.release({
      quarantineId: record.quarantineId,
      remediation: {
        releaseNote: "patched and verified",
        evidence: [
          { evidenceId: "ev-1", artifactRef: "artifact:router-fix", contentDigest: "fnv1a64:1" },
        ],
      },
      advisories,
      at: NOW - 5_000,
    });
    const state = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW });
    expect(state.quarantinedComponents).toEqual([]);
    expect(state.restrictedComponents).toEqual([]);
    const writeRequest = {
      ...baseWriteRequest(),
      approvals: [
        {
          asset: USC_ASSET,
          owner: "0x1111111111111111111111111111111111111111",
          spender: ROUTER_COMPONENT.id,
          amount: { currency: "USC", minorUnits: "1000000" },
          unlimited: false,
        },
      ],
    };
    const decision = evaluateOnchainWriteGates({
      write: prepareWrite(writeRequest, NOW),
      policy: basePolicy(),
      securityState: state,
      at: NOW,
    });
    expect(decision.decision).toBe("ALLOW");
  });

  it("a STALE composed security state surfaces UNKNOWN — never a guessed ALLOW (INV-X01 discipline)", () => {
    const epochAuthority = new SecurityEpochAuthority();
    const advisories = new SecurityAdvisoryRegistry();
    const quarantine = new QuarantineLedger();
    const state = composeSecurityState({ epochAuthority, advisories, quarantine, at: NOW - 60_000 });
    const decision = evaluateOnchainWriteGates({
      write: prepareWrite(baseWriteRequest(), NOW),
      policy: basePolicy(), // maxSecurityStateAgeMs: 5_000
      securityState: state,
      at: NOW,
    });
    expect(decision.decision).toBe("UNKNOWN");
    if (decision.decision === "UNKNOWN") {
      expect(decision.dimensions.some((d) => d.code === "security_state_stale")).toBe(true);
    }
  });
});

