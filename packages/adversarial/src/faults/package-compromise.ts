/**
 * W2-007 fault family — package compromise.
 *
 * Attack: a published, sealed agent package (and the capability it provides)
 * is discovered to be compromised in the wild.
 *
 * Defense: a security advisory restricts the affected components globally
 * (INV-S01); the compromised package is quarantined and cannot regain access
 * through cached capability state (INV-S03); extensions/packages can never
 * directly write financial state — every adapter authority is
 * canWriteFinancialState:false and finality is protocol-authorized only
 * (INV-C04); the released package version is sealed and immutable, so the
 * only remediation is a NEW certified version (INV-G02).
 *
 * Invariants on the line: INV-S01, INV-C04, INV-G02, INV-S03.
 *
 * The security immune system is consumed through STRUCTURAL views
 * (harness.ts); the test layer wires the REAL security-package objects in.
 */

import { PackageLifecycleLedger } from "@payswap/agents";
import type { AgentPackage, SealedPackageVersion } from "@payswap/agents";
import {
  defineProofPolicy,
  deriveSettlementInstruction,
} from "@payswap/settlement";
import type { SettlementInstruction } from "@payswap/settlement";
import {
  ADVERSARIAL_PRINCIPAL,
  adversarialCommand,
  beginAdversarialChain,
  buildAdversarialWorld,
  clearingRecord,
  injectionCheck,
  probe,
  recoveryStep,
  usd,
} from "../harness.js";
import type {
  AdversarialScenario,
  FaultExecution,
  PackageCompromiseSecurityPlane,
} from "../harness.js";

const T0 = 1_766_400_000_000;

function lifecycleEvidence(decidedAt: number): { readonly decidedBy: string; readonly decidedAt: number; readonly evidenceRefs: readonly string[] } {
  return {
    decidedBy: "security-team",
    decidedAt,
    evidenceRefs: [`audit:${decidedAt}`],
  };
}

function compromisedPackage(version: number): AgentPackage {
  return {
    id: "pkg:assistant",
    version,
    bodies: [{ id: "body:assistant", version: 1 }],
    organizationTemplates: [{ templateId: "tmpl:assistant", version: 1 }],
    requiredExtensions: [{ extensionId: "ext:tools", version: "1.0.0" }],
    securityEpochRequirements: { requireCurrentEpoch: true },
    runtimeRequirements: { minRuntimeContractVersion: 1, requiredOperations: ["execute", "requestTool"] },
    modelCompatibility: { interfaceVersion: 1 },
    evaluationSuiteRef: "suite:assistant-eval@2",
    provenance: {
      source: "registry:payswap",
      contentHash: `pkgdigest:${version}`,
      createdAt: T0 - 86_400_000,
    },
    lifecycle: "DRAFT",
  };
}

/** Certify + publish (seal) a package through the REAL lifecycle ledger. */
function publishPackage(pkg: AgentPackage, registeredAt: number): {
  readonly ledger: PackageLifecycleLedger;
  readonly sealed: SealedPackageVersion;
} {
  const ledger = new PackageLifecycleLedger(pkg, registeredAt);
  ledger.submitForStaticAnalysis(lifecycleEvidence(registeredAt + 1));
  ledger.benchmark(lifecycleEvidence(registeredAt + 2));
  ledger.securityReview(lifecycleEvidence(registeredAt + 3));
  ledger.certify({
    decidedBy: "security-team",
    decidedAt: registeredAt + 4,
    evidenceRefs: ["report:static-analysis", "report:benchmark"],
    certifiedBy: ["reviewer:1", "reviewer:2"],
    evaluationReportRefs: ["report:evaluation-suite"],
  });
  const sealed = ledger.publish(lifecycleEvidence(registeredAt + 5));
  return { ledger, sealed };
}

export interface PackageCompromiseOptions {
  /** The REAL security immune system, wired through the structural views. */
  readonly security: PackageCompromiseSecurityPlane;
}

export function packageCompromiseScenario(options: PackageCompromiseOptions): AdversarialScenario {
  const declaration = {
    faultId: "fault:package-compromise:1",
    family: "package-compromise" as const,
    title: "Compromised published agent package — advisory restriction, quarantine and immutable seal",
    description:
      "A sealed, AVAILABLE agent package is found compromised; a critical advisory restricts it globally, the package and its capability are quarantined (cached capability state cannot re-enter), no adapter path can write financial state, and the sealed version cannot be rewritten — the only remediation is a patched, re-certified NEW version.",
    candidateInvariants: ["INV-S01", "INV-C04", "INV-G02", "INV-S03"],
    attackedSubsystems: ["security", "@payswap/agents", "@payswap/execution", "@payswap/settlement"],
  };

  return {
    declaration,
    run: (): FaultExecution => {
      const world = buildAdversarialWorld();
      const security = options.security;
      const now = (): bigint => world.journey.clock.now();

      // --- ground truth: a published, sealed, AVAILABLE agent package ------
      const { ledger: v1Ledger, sealed: v1Sealed } = publishPackage(compromisedPackage(1), T0);
      const packageComponent = { kind: "agent_package" as const, id: "pkg:assistant" };
      const capabilityComponent = { kind: "capability" as const, id: "cap:assistant:payments" };

      // --- ground truth: an in-flight settlement the package might target --
      const chain = beginAdversarialChain({
        world,
        sequence: "package-compromise",
        clearingRecords: [
          clearingRecord("CR:PKGC:1", [
            {
              id: "act:PKGC:1",
              activityType: "MERCHANT_SALE",
              debtor: "merchant-1",
              creditor: "customer-1",
              amount: usd(1500n),
            },
          ], world),
        ],
        dueWindow: { opensAt: now() + 1n, closesAt: now() + 86_400_000n },
        rail: "rail:psp-a",
        settlementDestinationId: "dest:merchant-1",
        authorizationRefs: ["authz:pkgc:1"],
      });

      // --- INJECTION: the compromise advisory + quarantine -----------------
      const advisory = security.advisories.publish({
        advisoryId: "adv:pkg-assistant-compromise",
        title: "Remote code execution in pkg:assistant <= 1",
        severity: "critical",
        description:
          "The published pkg:assistant@1 exfiltrates credentials and attempts direct ledger writes; all installations must stop executing it immediately.",
        affected: [{ kind: "agent_package", id: "pkg:assistant", versionRange: { minVersion: "1", maxVersion: "1" } }],
        action: "quarantine",
        remediation: {
          summary: "Upgrade to the patched version 2; rotate all credentials the package could read.",
          patchedVersion: "2",
          workarounds: ["disable the assistant capability"],
        },
        declaredBy: "security-team",
        publishedAt: T0 + 10_000,
      });
      const packageQuarantine = security.quarantine.quarantine({
        component: packageComponent,
        reason: "compromised published package (adv:pkg-assistant-compromise)",
        advisoryRefs: [advisory.advisoryId],
        at: T0 + 10_001,
      });
      security.quarantine.quarantine({
        component: capabilityComponent,
        reason: "capability provided by the compromised package",
        advisoryRefs: [advisory.advisoryId],
        at: T0 + 10_002,
      });
      // State captured AT INJECTION TIME (the recovery later closes the
      // advisory and releases the package quarantine — the attack-moment
      // facts must not be re-read after remediation).
      const restrictionAtInjection = security.advisories.restrictionFor({
        kind: "agent_package",
        id: "pkg:assistant",
        version: "1",
      });
      const bothQuarantinedAtInjection =
        security.quarantine.isQuarantined(packageComponent) &&
        security.quarantine.isQuarantined(capabilityComponent);

      // --- the attack: cached capability state re-entry --------------------
      const cachedReentry = security.authorizeCapabilityUse({
        capabilityId: "cap:assistant:payments",
        sourceId: "source:cache:pkg-assistant",
        effectiveAvailability: "AVAILABLE",
        providedBy: [packageComponent],
      });

      // --- the attack: the compromised package tries to write money -------
      const command = adversarialCommand(world, "execution.attempt", "idem:pkgc:adapter", {
        capabilityInstanceId: "inst:assistant:payments",
      });
      const scopedGrant = world.journey.grants.issue({
        grantId: "grant:pkgc:scoped",
        command,
        scope: {
          capabilityInstanceIds: ["inst:assistant:payments"],
          executionModes: ["PASS_THROUGH_NATIVE"],
        },
        requestHash: "reqhash:pkgc:adapter",
        expiresAt: BigInt(T0 + 3_600_000),
        authorizationEvidenceRef: "authz:pkgc:adapter",
      });
      const adapterAuthority = world.journey.grants.attenuateForAdapter(
        "grant:pkgc:scoped",
        now(),
      );

      // A FORGED settlement instruction (not protocol-derived) tries to
      // declare finality — only the Financial Protocol Authority may write.
      const realInstruction = deriveSettlementInstruction({
        protocolInstruction: chain.instruction,
        remittance: [],
        settlementDestinationId: "dest:merchant-1",
        authorizationRefs: ["authz:pkgc:1"],
        issuedAt: now(),
      });
      const forgedInstruction: SettlementInstruction = {
        ...realInstruction,
        amount: usd(999_999n),
      };
      const authNode = world.journey.evidence.record({
        nodeId: "pkgc:auth:0",
        kind: "AUTHORIZATION",
        actionRef: forgedInstruction.id,
        claimedLevel: "P2",
        provenance: { source: "OPERATOR", operatorRef: "payswap:protocol:authorization" },
        payload: "authorization-refs:authz:pkgc:1",
        links: [],
        recordedAt: now(),
      });
      const execNode = world.journey.evidence.record({
        nodeId: "pkgc:exec:0",
        kind: "EXECUTION",
        actionRef: "sa:package-compromise:0",
        claimedLevel: "P2",
        provenance: { source: "AUTHENTICATED_PROVIDER", providerName: "psp-a" },
        payload: "provider-op:pkgc",
        links: ["pkgc:auth:0"],
        recordedAt: now(),
      });
      const outcomeNode = world.journey.evidence.record({
        nodeId: "pkgc:outcome:0",
        kind: "OUTCOME",
        actionRef: "sa:package-compromise:0",
        claimedLevel: "P3",
        provenance: { source: "INDEPENDENT_OBSERVER", observerRef: "rail-statement:rail:psp-a" },
        payload: "destination-observation",
        links: ["pkgc:exec:0"],
        recordedAt: now(),
      });
      let forgedFinalityRejected = false;
      let forgedFinalityError = "";
      try {
        world.journey.finality.declareFinality({
          finalityId: "fin:pkgc:forged",
          instruction: forgedInstruction,
          authorization: { nettingSet: chain.nettingSet, obligations: chain.obligations },
          policy: defineProofPolicy({
            policyId: "pp:pkgc",
            currency: forgedInstruction.amount.currency,
            baselineLevel: "P1",
            highRiskThresholdMinorUnits: 50_000n,
            highRiskLevel: "P3",
            railMinimums: {},
            counterpartyRiskMinimums: {},
          }),
          proofContext: { direction: "SETTLE", amount: forgedInstruction.amount },
          evidence: [authNode, execNode, outcomeNode],
          now: now(),
        });
      } catch (error) {
        forgedFinalityRejected = true;
        forgedFinalityError = error instanceof Error ? error.constructor.name : "unknown";
      }

      // --- the attack: rewrite the sealed version --------------------------
      const sealedFrozen = Object.isFrozen(v1Sealed.package);
      let mutationThrew = false;
      try {
        (v1Sealed.package as unknown as { id: string }).id = "pkg:evil";
      } catch {
        mutationThrew = true;
      }
      const tampered: AgentPackage = { ...v1Sealed.package, id: "pkg:tampered" };
      const tamperDetected = v1Ledger.verifyIntegrity(tampered) === false;

      // --- recovery: patched version 2 + advisory closure + release --------
      const { ledger: v2Ledger, sealed: v2Sealed } = publishPackage(compromisedPackage(2), T0 + 50_000);
      const closedAdvisory = security.advisories.close({
        advisoryId: advisory.advisoryId,
        closedAt: T0 + 60_000,
        closureNote: "patched version 2 published and certified; credentials rotated.",
        remediationVerified: true,
      });
      const releasedQuarantine = security.releaseQuarantine({
        quarantineId: packageQuarantine.quarantineId,
        remediation: {
          releaseNote: "patched version 2 certified and published; old version stays retired",
          evidence: [
            {
              evidenceId: "ev:pkgc:patch",
              artifactRef: "artifact:pkg:assistant@2",
              contentDigest: v2Sealed.contentHash,
            },
          ],
        },
        at: T0 + 60_001,
      });

      const injectionChecks = [
        injectionCheck(
          advisory.advisoryId === "adv:pkg-assistant-compromise" &&
            advisory.status === "active" &&
            advisory.action === "quarantine",
          `the critical compromise advisory was published and is ${advisory.status} (action ${advisory.action})`,
        ),
        injectionCheck(
          bothQuarantinedAtInjection,
          `both the compromised package and its capability are quarantined`,
        ),
        injectionCheck(
          cachedReentry.decision === "REJECT",
          `the cached AVAILABLE capability view was refused (decision REJECT, reason ${cachedReentry.reason ?? "none"})`,
        ),
        injectionCheck(
          forgedFinalityRejected && forgedFinalityError === "FinalityNotProtocolAuthorizedError",
          `the forged (non-protocol-derived) settlement instruction was refused by the FinalityAuthority with ${forgedFinalityError}`,
        ),
      ];

      const probes = [
        probe(
          "INV-S01",
          restrictionAtInjection.restricted === true &&
            restrictionAtInjection.quarantined === true &&
            restrictionAtInjection.advisoryRefs.includes(advisory.advisoryId),
          `the advisory restricted the affected component globally at injection time (unscoped restriction view: restricted=${String(restrictionAtInjection.restricted)}, quarantined=${String(restrictionAtInjection.quarantined)}, advisoryRefs=[${restrictionAtInjection.advisoryRefs.join(", ")}])`,
        ),
        probe(
          "INV-C04",
          adapterAuthority.canWriteFinancialState === false &&
            adapterAuthority.authorityKind === "ADAPTER_EXECUTION_ONLY" &&
            forgedFinalityRejected &&
            forgedFinalityError === "FinalityNotProtocolAuthorizedError",
          `the compromised package cannot write financial state: its adapter authority carries canWriteFinancialState:false and the forged instruction was rejected by the protocol-owned FinalityAuthority (${forgedFinalityError})`,
        ),
        probe(
          "INV-G02",
          sealedFrozen &&
            mutationThrew &&
            tamperDetected &&
            v2Sealed.contentHash !== v1Sealed.contentHash &&
            v2Ledger.verifyIntegrity(v2Sealed.package) === true,
          `the released version is immutable: the sealed artifact is frozen (mutation threw), content drift is detected (verifyIntegrity=false), and remediation required a NEW sealed version with a different content hash`,
        ),
        probe(
          "INV-S03",
          cachedReentry.decision === "REJECT" &&
            (cachedReentry.reason === "quarantined" || cachedReentry.reason === "quarantined_provider"),
          `the quarantined package could not regain access through the cached AVAILABLE capability state (reason ${cachedReentry.reason ?? "none"}); release required closed advisories + remediation evidence`,
        ),
      ];

      const recoveryPath = [
        recoveryStep(
          1,
          "Compromise advisory published — global restriction active",
          security.advisories.byId(advisory.advisoryId) !== undefined,
          `adv:pkg-assistant-compromise published (critical/quarantine) restricting pkg:assistant@1 globally`,
        ),
        recoveryStep(
          2,
          "Compromised components quarantined",
          security.quarantine.byId(packageQuarantine.quarantineId) !== undefined,
          `agent_package:pkg:assistant and capability:cap:assistant:payments quarantined with advisory provenance`,
        ),
        recoveryStep(
          3,
          "Cached capability re-entry denied",
          cachedReentry.decision === "REJECT",
          `the still-AVAILABLE cached view was refused (reason ${cachedReentry.reason ?? "none"})`,
        ),
        recoveryStep(
          4,
          "Financial truth unreachable from the package path",
          adapterAuthority.canWriteFinancialState === false && forgedFinalityRejected,
          `adapter authority is ADAPTER_EXECUTION_ONLY (canWriteFinancialState=false) and the forged instruction was rejected (${forgedFinalityError})`,
        ),
        recoveryStep(
          5,
          "Sealed version rewrite refused — patched v2 published instead",
          tamperDetected && v2Sealed.contentHash !== v1Sealed.contentHash,
          `the v1 seal is frozen and hash-verified; remediation published a NEW certified version (content hash ${v2Sealed.contentHash})`,
        ),
        recoveryStep(
          6,
          "Advisory closed with verified remediation; quarantine released with evidence",
          closedAdvisory.status === "closed" && releasedQuarantine.status === "released",
          `adv:pkg-assistant-compromise closed (remediationVerified) and quarantine ${packageQuarantine.quarantineId} released against the v2 seal digest`,
        ),
      ];

      const evidenceRefs = [
        advisory.advisoryId,
        packageQuarantine.quarantineId,
        v1Sealed.contentHash,
        v2Sealed.contentHash,
        "fin:pkgc:forged",
        "grant:pkgc:scoped",
        scopedGrant.grantId,
        chain.instruction.id,
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
