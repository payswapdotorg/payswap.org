/**
 * W2-007 fault family — account takeover / SIM-swap-like signals.
 *
 * Attack: an attacker takes over a user's account (SIM-swap-style signal);
 * a delegated, temporally-valid authorization and a cached capability state
 * are replayed by the attacker.
 *
 * Defense: the security epoch is bumped (network-wide + per-principal
 * credential epoch), every stale authorization is refused on sensitive
 * actions, the compromised key is quarantined and cannot re-enter through
 * cached capability state, and the exact recovery is out-of-band
 * re-verification issuing a NEW authorization at the current epoch.
 *
 * Invariants on the line: INV-S02 (epoch checked on every sensitive
 * delegated action), INV-A02 (expired/revoked epochs cannot authorize),
 * INV-S03 (quarantined components cannot regain access through cached
 * capability state), INV-E01 (consequential actions carry authorization
 * evidence — the re-authorization is a fresh signed approval artifact).
 *
 * The security immune system is consumed through STRUCTURAL views
 * (harness.ts): the REAL security-package objects are wired in by the test
 * composition (repo-wide boundary discipline).
 */

import {
  EpochLedger,
  checkEpoch,
  evaluate,
  issueGrant,
  verifyApprovalArtifact,
} from "@payswap/trust";
import type {
  AuthorizationDecision,
  Mandate,
  PermissionGrant,
  Principal,
} from "@payswap/trust";
import { injectionCheck, probe, recoveryStep } from "../harness.js";
import type {
  AccountTakeoverSecurityPlane,
  AdversarialScenario,
  EpochScopedAuthorizationView,
  FaultExecution,
} from "../harness.js";

const T0 = 1_766_200_000_000;
const T_BUMP = T0 + 1_000;
const T_ATTACK = T0 + 2_000;
const T_RECOVERY = T0 + 3_000;
const T_LATE = T0 + 4_000_000;

export interface AccountTakeoverOptions {
  /** The REAL security immune system, wired through the structural views. */
  readonly security: AccountTakeoverSecurityPlane;
}

export function accountTakeoverScenario(options: AccountTakeoverOptions): AdversarialScenario {
  const declaration = {
    faultId: "fault:account-takeover:1",
    family: "account-takeover" as const,
    title: "Account takeover (SIM-swap signal) — epoch bump, quarantine and re-authorization",
    description:
      "A SIM-swap-like signal fires while a delegated authorization is still temporally valid; the network epoch and the per-principal credential epoch are raised, the compromised key is quarantined, and the attacker's stale authorizations + cached capability state are refused. Recovery is out-of-band re-verification issuing a fresh epoch-current authorization and signed approval artifact.",
    candidateInvariants: ["INV-S02", "INV-A02", "INV-S03", "INV-E01"],
    attackedSubsystems: ["security", "@payswap/trust", "@payswap/protocol"],
  };

  return {
    declaration,
    run: (): FaultExecution => {
      const security = options.security;
      const epochLedger: EpochLedger = security.credentialEpochLedger;

      const victimAgent: Principal = {
        kind: "agent",
        agentKeyFingerprint: "agent-key-1",
        ownerRef: "user:victim-1",
        bodyRef: "body:assistant@1",
        packageVersionRef: "pkg:assistant@1",
        authorityEnvelope: [{ mandateId: "mandate:atk", version: 1 }],
        securityEpoch: 0n,
      };

      const mandate: Mandate = {
        id: "mandate:atk",
        version: 1,
        grantor: "user:victim-1",
        grantee: "agent:agent-key-1",
        actions: ["beneficiary.change", "payments.initiate"],
        resources: [{ type: "beneficiary" }, { type: "payment_intent" }],
        expiresAt: T0 + 86_400_000,
        proofRequirements: [],
      };
      const grants: readonly PermissionGrant[] = [
        issueGrant(mandate, { grantId: "grant:atk:1", issuedAt: T0 - 1_000 }),
      ];

      const request = {
        principal: victimAgent,
        action: "beneficiary.change",
        resource: { type: "beneficiary", resourceId: "ben-1" },
        context: {},
        requestHash: "reqhash:atk:1",
        requestedAt: T_ATTACK,
      };

      /** The delegated authorization — still temporally valid across the whole attack. */
      const authorizationV1: EpochScopedAuthorizationView = {
        authorizationRef: "authz:atk:1",
        principalRef: "agent:agent-key-1",
        agentRef: "agent-key-1",
        actionClass: "beneficiary_change",
        issuedAtEpoch: 0n,
        expiresAt: T0 + 86_400_000,
      };

      // --- ground truth: the authorization is valid BEFORE the fault -------
      let validBefore = false;
      try {
        security.checkSensitiveAction(authorizationV1, T0);
        validBefore = true;
      } catch {
        validBefore = false;
      }
      const decisionBefore: AuthorizationDecision = evaluate(request, grants, {
        ledger: epochLedger,
      });

      // --- INJECTION: SIM-swap signal → epoch bump + credential epoch -----
      const bumped = security.epochs.advance({
        reason: "SIM-swap signal on user:victim-1 (account takeover response)",
        at: T_BUMP,
      });
      const credentialEpoch = epochLedger.raiseEpoch(
        "agent:agent-key-1",
        "credential compromise suspected during account takeover",
        T_BUMP,
      );
      security.quarantine.quarantine({
        component: { kind: "agent_key", id: "agent-key-1" },
        reason: "compromised agent key during account takeover",
        advisoryRefs: [],
        at: T_BUMP,
      });

      // --- the attack: replay the stale authorization + cached capability --
      let staleRejected = false;
      let staleError = "";
      try {
        security.checkSensitiveAction(authorizationV1, T_ATTACK);
      } catch (error) {
        staleRejected = true;
        staleError = error instanceof Error ? error.constructor.name : "unknown";
      }
      const staleEvaluation = security.evaluateSensitiveAction(authorizationV1, T_ATTACK);

      let delegatedRejected = false;
      let delegatedError = "";
      try {
        security.checkDelegatedSensitiveAction(victimAgent, authorizationV1, T_ATTACK);
      } catch (error) {
        delegatedRejected = true;
        delegatedError = error instanceof Error ? error.message : "unknown";
      }

      let credentialRejected = false;
      let credentialError = "";
      try {
        checkEpoch(victimAgent, epochLedger);
      } catch (error) {
        credentialRejected = true;
        credentialError = error instanceof Error ? error.constructor.name : "unknown";
      }

      const decisionAfter: AuthorizationDecision = evaluate(request, grants, {
        ledger: epochLedger,
      });

      const cachedReentry = security.authorizeCapabilityUse({
        capabilityId: "cap:payments",
        sourceId: "source:cache-1",
        effectiveAvailability: "AVAILABLE",
        providedBy: [{ kind: "agent_key", id: "agent-key-1" }],
      });

      // --- recovery: out-of-band re-verification, NEW epoch-current grant --
      const authorizationV2: EpochScopedAuthorizationView = {
        authorizationRef: "authz:atk:2",
        principalRef: "agent:agent-key-1",
        agentRef: "agent-key-2",
        actionClass: "beneficiary_change",
        issuedAtEpoch: bumped.value,
        expiresAt: T_RECOVERY + 3_600_000,
      };
      let reAuthorized = false;
      try {
        security.checkSensitiveAction(authorizationV2, T_RECOVERY);
        reAuthorized = true;
      } catch {
        reAuthorized = false;
      }

      const rotatedAgent: Principal = { ...victimAgent, agentKeyFingerprint: "agent-key-2", securityEpoch: credentialEpoch.value };
      let rotatedCredentialValid = false;
      try {
        checkEpoch(rotatedAgent, epochLedger);
        rotatedCredentialValid = true;
      } catch {
        rotatedCredentialValid = false;
      }

      // INV-E01: the consequential action carries a NEW signed approval artifact.
      const approvalArtifact = {
        principal: "user:victim-1",
        agentRef: "agent:agent-key-2",
        scope: {
          actions: ["beneficiary.change"],
          resources: [{ type: "beneficiary", resourceId: "ben-1" }],
          maxAmount: { currency: "USD", minorUnits: "100000" },
        },
        expiry: T_RECOVERY + 3_600_000,
        requestHash: "reqhash:atk:2",
        signature: "sig:recovery:1",
        issuedAt: T_RECOVERY,
      };
      const approvalValid = verifyApprovalArtifact(approvalArtifact, {
        principal: rotatedAgent,
        action: "beneficiary.change",
        resource: { type: "beneficiary", resourceId: "ben-1" },
        context: { amount: { currency: "USD", minorUnits: "100000" } },
        requestHash: "reqhash:atk:2",
        requestedAt: T_RECOVERY,
      }, T_RECOVERY);

      // The OLD request hash can never satisfy the NEW artifact.
      const replayedApproval = verifyApprovalArtifact(approvalArtifact, {
        principal: rotatedAgent,
        action: "beneficiary.change",
        resource: { type: "beneficiary", resourceId: "ben-1" },
        context: {},
        requestHash: "reqhash:atk:1",
        requestedAt: T_RECOVERY,
      }, T_RECOVERY);

      const injectionChecks = [
        injectionCheck(
          validBefore && decisionBefore.decision === "ALLOW",
          `before the fault the delegated authorization passed the epoch gate and trust evaluate() returned ALLOW (the fixture is a genuinely valid target)`,
        ),
        injectionCheck(
          bumped.value === 1n && credentialEpoch.value === 1n,
          `the SIM-swap signal advanced the network epoch to ${bumped.value} and the per-principal credential epoch to ${credentialEpoch.value}`,
        ),
        injectionCheck(
          staleRejected && staleError === "StaleAuthorizationEpochError",
          `the temporally-valid authorization was refused on the sensitive action with ${staleError}`,
        ),
        injectionCheck(
          cachedReentry.decision === "REJECT",
          `the quarantined key could not re-enter through cached capability state: decision REJECT (${cachedReentry.reason ?? "no reason"} on ${cachedReentry.componentKey ?? "component"})`,
        ),
      ];

      const probes = [
        probe(
          "INV-S02",
          staleRejected &&
            staleError === "StaleAuthorizationEpochError" &&
            delegatedRejected &&
            staleEvaluation.allowed === false &&
            staleEvaluation.reason === "stale_security_epoch",
          `the epoch was checked on the sensitive delegated action: checkSensitiveAction threw ${staleError}, evaluateSensitiveAction returned allowed=false/stale_security_epoch, and checkDelegatedSensitiveAction refused (${delegatedError})`,
        ),
        probe(
          "INV-A02",
          credentialRejected &&
            credentialError === "StaleEpochError" &&
            decisionAfter.decision === "DENY" &&
            decisionAfter.reason === "stale_security_epoch",
          `the revoked credential epoch cannot authorize: checkEpoch threw ${credentialError} and trust evaluate() returned DENY/stale_security_epoch even though the mandate and grant are untouched`,
        ),
        probe(
          "INV-S03",
          cachedReentry.decision === "REJECT" &&
            (cachedReentry.reason === "quarantined" || cachedReentry.reason === "quarantined_provider"),
          `the cached AVAILABLE capability view was refused for the quarantined agent_key (reason ${cachedReentry.reason ?? "none"}) — the cache cannot override quarantine`,
        ),
        probe(
          "INV-E01",
          approvalValid.valid === true &&
            replayedApproval.valid === false &&
            (replayedApproval.valid === false ? replayedApproval.reason : "") === "request_hash_mismatch",
          `re-authorization produced a fresh signed approval artifact that verifies for the new request hash and refuses the old one (${replayedApproval.valid === false ? replayedApproval.reason : "n/a"})`,
        ),
      ];

      const recoveryPath = [
        recoveryStep(
          1,
          "Takeover signal detected — network epoch advanced",
          bumped.value === 1n,
          `SecurityEpochAuthority.advance → network epoch ${bumped.value} (every lower-epoch authorization is stale network-wide)`,
        ),
        recoveryStep(
          2,
          "Compromised credential epoch raised",
          credentialEpoch.value === 1n && credentialRejected,
          `EpochLedger.raiseEpoch → credential epoch ${credentialEpoch.value}; the old credential fails checkEpoch`,
        ),
        recoveryStep(
          3,
          "Compromised key quarantined",
          security.quarantine.isQuarantined({ kind: "agent_key", id: "agent-key-1" }),
          `the agent_key component is quarantined and its cached capability re-entry is REJECT`,
        ),
        recoveryStep(
          4,
          "User re-verifies out-of-band; NEW epoch-current authorization issued",
          reAuthorized,
          `authorization authz:atk:2 issued at epoch ${bumped.value} passes the sensitive-action gate`,
        ),
        recoveryStep(
          5,
          "Rotated credential validates",
          rotatedCredentialValid,
          `the rotated agent key at credential epoch ${credentialEpoch.value} passes checkEpoch`,
        ),
        recoveryStep(
          6,
          "Fresh signed approval artifact verifies for the consequential action",
          approvalValid.valid === true,
          `the re-authorization evidence binds principal/agent/scope/expiry/request hash and verifies (the old request hash is refused)`,
        ),
      ];

      const evidenceRefs = [
        "authz:atk:1",
        "authz:atk:2",
        "agent-key-1",
        "mandate:atk@1",
        "grant:atk:1",
        "reqhash:atk:2",
        "sig:recovery:1",
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
