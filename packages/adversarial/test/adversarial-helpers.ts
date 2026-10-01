/**
 * @payswap/adversarial — test-layer composition (W2-007).
 *
 * Wires the REAL security immune system (@payswap/security) and the REAL
 * Lab replay machinery (@payswap/lab) into the structural views declared by
 * src/harness.ts. src/** never imports these two packages (repo-wide
 * boundary discipline, journeys + certification precedent); the composition
 * happens HERE, exactly like @payswap/certification's structural
 * immune-state views.
 */

import * as security from "@payswap/security";
import { EpochLedger } from "@payswap/trust";
import { recordProductionFacts, runReplay } from "@payswap/lab";
import type { SimulationProgram } from "@payswap/lab";
import type { StructuralReplayResult } from "@payswap/certification";
import { expect } from "vitest";
import type {
  AccountTakeoverSecurityPlane,
  AdversarialScenario,
  FaultFamilyId,
  FaultVerdict,
  PackageCompromiseSecurityPlane,
} from "../src/index.js";
import { runScenario } from "../src/index.js";
import { accountTakeoverScenario } from "../src/faults/account-takeover.js";
import { packageCompromiseScenario } from "../src/faults/package-compromise.js";
import { providerOutageScenario } from "../src/faults/provider-outage.js";
import { duplicatedCommandsScenario } from "../src/faults/duplicated-commands.js";
import { lostWebhooksScenario } from "../src/faults/lost-webhooks.js";
import { ambiguousProviderScenario } from "../src/faults/ambiguous-provider.js";
import { maliciousAgentsScenario } from "../src/faults/malicious-agents.js";
import {
  incentiveSybilCollusionWashScenario,
  leaderboardGamingScenario,
} from "../src/faults/incentive-abuse.js";
import { clockSkewScenario } from "../src/faults/clock-skew.js";
import { partialPaymentScenario } from "../src/faults/partial-payment.js";

/**
 * Build the account-takeover security plane over the REAL security objects:
 * a real SecurityEpochAuthority, a real QuarantineLedger, a real advisory
 * registry, and the real free-function gates bound to them. The per-principal
 * credential ledger is the REAL trust EpochLedger shared with the scenario.
 */
export function buildAccountTakeoverPlane(): AccountTakeoverSecurityPlane {
  const epochs = new security.SecurityEpochAuthority();
  const quarantine = new security.QuarantineLedger();
  const advisories = new security.SecurityAdvisoryRegistry();
  const credentialEpochLedger = new EpochLedger();
  return {
    epochs,
    credentialEpochLedger,
    checkSensitiveAction: (authorization, at) =>
      security.checkSensitiveActionAuthorization(authorization, epochs, at),
    evaluateSensitiveAction: (authorization, at) =>
      security.evaluateSensitiveActionAuthorization(authorization, epochs, at),
    checkDelegatedSensitiveAction: (principal, authorization, at) =>
      security.checkDelegatedSensitiveAction(
        principal,
        authorization,
        epochs,
        at,
        credentialEpochLedger,
      ),
    quarantine,
    authorizeCapabilityUse: (view) =>
      security.authorizeCapabilityUse(view, { advisories, quarantine }),
  };
}

/**
 * Build the package-compromise security plane over the REAL security
 * objects: a real SecurityAdvisoryRegistry, a real QuarantineLedger and the
 * real capability gate. The release closure binds the registry (release
 * refuses while advisories remain active).
 */
export function buildPackageCompromisePlane(): PackageCompromiseSecurityPlane {
  const advisories = new security.SecurityAdvisoryRegistry();
  const quarantine = new security.QuarantineLedger();
  return {
    advisories,
    quarantine,
    releaseQuarantine: (input) =>
      quarantine.release({ ...input, advisories }),
    authorizeCapabilityUse: (view) =>
      security.authorizeCapabilityUse(view, { advisories, quarantine }),
  };
}

/** The Lab program used by the W2-006 replay-fault contract verification. */
const REPLAY_PROGRAM: SimulationProgram = {
  programId: "replay.adversarial",
  programVersion: "1.0.0",
  routePreference: ["rail-a", "rail-b"],
  useNetting: false,
  useNetworkCredit: false,
  delayToleranceSteps: 0,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
};

/**
 * A REAL Lab replay with an in-flight external write under outage — the
 * frozen W2-006 PROVIDER_OUTAGE contract surface. The replay result flows
 * through the structural view unchanged.
 */
export function buildOutageReplay(): StructuralReplayResult {
  const facts = recordProductionFacts({
    factsId: "facts-adversarial-outage",
    description: "observed production demand with an ambiguous external write under outage",
    rails: [
      {
        railId: "rail-a",
        currency: "EUR",
        latencyMs: 400,
        fixedFeeMinor: 25n,
        variableFeeBps: 10n,
      },
      {
        railId: "rail-b",
        currency: "EUR",
        latencyMs: 350,
        fixedFeeMinor: 40n,
        variableFeeBps: 8n,
      },
    ],
    pools: [
      { poolId: "pool-a", railId: "rail-a", availableMinor: 1_000_000n },
      { poolId: "pool-b", railId: "rail-b", availableMinor: 1_000_000n },
    ],
    stepLatencyMs: 250,
    demands: [
      {
        demandId: "prod-demand-adversarial-1",
        observedAtMs: 0,
        amountMinor: 120_000n,
        currency: "EUR",
        direction: "OUTBOUND",
        deadlineMs: 30_000,
      },
    ],
    incidents: [
      {
        incidentType: "DELAYED_WRITE",
        atStep: 0,
        railId: "rail-a",
        observedAtMs: 0,
      },
    ],
  });
  const replay = runReplay({ facts, program: REPLAY_PROGRAM, seed: "seed-adversarial-1", stepMs: 250 });
  const structural: StructuralReplayResult = replay;
  return structural;
}

/**
 * The standard W2-007 adversarial suite: all eleven fault families, each
 * composed against the REAL subsystems (security planes and the Lab replay
 * wired here at the test layer).
 */
export function standardAdversarialSuite(): readonly AdversarialScenario[] {
  return [
    duplicatedCommandsScenario(),
    lostWebhooksScenario(),
    ambiguousProviderScenario(),
    accountTakeoverScenario({ security: buildAccountTakeoverPlane() }),
    maliciousAgentsScenario(),
    packageCompromiseScenario({ security: buildPackageCompromisePlane() }),
    incentiveSybilCollusionWashScenario(),
    leaderboardGamingScenario(),
    providerOutageScenario({ replay: buildOutageReplay() }),
    clockSkewScenario(),
    partialPaymentScenario(),
  ];
}

/**
 * Run one scenario and verify the full W2-007 acceptance contract:
 * the fault GENUINELY occurred, every candidate invariant held, and the
 * exact recovery path completed in order.
 */
export async function runAndExpectScenario(
  scenario: AdversarialScenario,
  family: FaultFamilyId,
  candidateInvariants: readonly string[],
): Promise<FaultVerdict> {
  const verdict = await runScenario(scenario);
  expect(verdict.family).toBe(family);
  expect(verdict.injected, "the fault must genuinely occur (no stubbed targets)").toBe(true);
  expect(verdict.injectionChecks.length).toBeGreaterThan(0);
  for (const check of verdict.injectionChecks) {
    expect(check.ok, `injection check failed: ${check.detail}`).toBe(true);
  }
  expect(verdict.invariantsHeld, "no candidate invariant may breach").toBe(true);
  expect(verdict.probes.length).toBeGreaterThanOrEqual(candidateInvariants.length);
  for (const candidate of candidateInvariants) {
    const invariantProbe = verdict.probes.find((p) => p.invariantId === candidate);
    expect(invariantProbe, `missing probe for ${candidate}`).toBeDefined();
    expect(invariantProbe?.held, `${candidate} proof: ${invariantProbe?.proof ?? "none"}`).toBe(true);
    expect(invariantProbe?.proof.length ?? 0).toBeGreaterThan(0);
  }
  expect(verdict.recoveryCompleted, "the exact recovery path must complete").toBe(true);
  verdict.recoveryPath.forEach((step, index) => {
    expect(step.step, "recovery steps are 1-based and ordered").toBe(index + 1);
    expect(step.done, `recovery step ${step.step} incomplete: ${step.detail}`).toBe(true);
  });
  expect(verdict.passed).toBe(true);
  expect(verdict.evidenceRefs.length).toBeGreaterThan(0);
  return verdict;
}
