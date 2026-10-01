/**
 * W2-007 fault family — malicious agents.
 *
 * Attack: a malicious agent (a) tries to smuggle protocol-command authority
 * inside an advisory proposal, (b) tries to widen its attenuated authority,
 * (c) requests an unrestricted money-movement tool, and (d) "suggests" that
 * policy/compliance constraints be overridden.
 *
 * Defense: proposals are structurally incapable of carrying command shape
 * (INV-G03); child authority is always a strict subset (INV-A01); financial
 * tools only ever execute against an ALLOW trust decision and every adapter
 * authority is canWriteFinancialState:false (INV-A04); suggestions cannot
 * override protocol, policy, compliance or security constraints (INV-A05).
 *
 * Recovery: the honest path — a properly attenuated child grant plus a
 * scoped execution grant — still executes within limits.
 */

import {
  AgentRuntimeError,
  InMemoryAgentRuntime,
  ProtocolCommandShapeError,
  makeProposal,
  fromProtocolClock,
  SequentialIdFactory,
} from "@payswap/agents";
import type {
  AgentEvent,
  AgentExecutor,
  ToolDescriptor,
  ToolResult,
} from "@payswap/agents";
import {
  EpochLedger,
  attenuateGrant,
  evaluate,
  issueGrant,
} from "@payswap/trust";
import type {
  AuthorizationDecision,
  Mandate,
  PermissionGrant,
  Principal,
} from "@payswap/trust";
import {
  ADVERSARIAL_PRINCIPAL,
  adversarialCommand,
  buildAdversarialWorld,
  injectionCheck,
  probe,
  recoveryStep,
} from "../harness.js";
import type {
  AdversarialScenario,
  FaultExecution,
} from "../harness.js";

const NOW = 1_766_300_000_000;

const maliciousAgent: Principal = {
  kind: "agent",
  agentKeyFingerprint: "agent-key-mal",
  ownerRef: "user:attacker-1",
  bodyRef: "body:malicious@1",
  packageVersionRef: "pkg:malicious@1",
  authorityEnvelope: [{ mandateId: "mandate:mal", version: 1 }],
  securityEpoch: 0n,
};

const parentMandate: Mandate = {
  id: "mandate:mal",
  version: 1,
  grantor: "user:owner-1",
  grantee: "agent:agent-key-mal",
  actions: ["payments.initiate"],
  resources: [{ type: "payment_intent" }],
  limits: { perTransactionAmount: { currency: "USD", minorUnits: "10000" } },
  expiresAt: NOW + 86_400_000,
  proofRequirements: [],
};

/** Collect a runtime session's events (first-match denial-reason extraction). */
async function eventsOf(runtime: InMemoryAgentRuntime, sessionId: string): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of runtime.streamEvents(sessionId)) {
    collected.push(event);
  }
  return collected;
}

/** The first tool_requested denial reason for a tool id (INV-A04 evidence). */
function firstDenialReason(events: readonly AgentEvent[], toolId: string): string {
  for (const event of events) {
    const payload = event.payload;
    if (
      event.type === "tool_requested" &&
      payload !== undefined &&
      payload.toolId === toolId &&
      payload.status === "DENIED"
    ) {
      return String(payload.reason ?? "none");
    }
  }
  return "none";
}

export function maliciousAgentsScenario(): AdversarialScenario {
  const declaration = {
    faultId: "fault:malicious-agents:1",
    family: "malicious-agents" as const,
    title: "Malicious agent — proposal smuggling, authority widening, unrestricted tools, constraint overrides",
    description:
      "A malicious agent attempts to smuggle command authority inside an advisory proposal, widen its attenuated grant, request an unrestricted money-movement tool and override policy limits by suggestion; every path is refused and the honest attenuated path still works.",
    candidateInvariants: ["INV-A01", "INV-G03", "INV-A04", "INV-A05"],
    attackedSubsystems: ["@payswap/agents", "@payswap/trust", "@payswap/execution"],
  };

  return {
    declaration,
    run: async (): Promise<FaultExecution> => {
      const world = buildAdversarialWorld();
      const ledger = new EpochLedger();
      const parentGrant = issueGrant(parentMandate, {
        grantId: "grant:mal:parent",
        issuedAt: NOW - 1_000,
      });

      // ------------------------------------------------------------------
      // INJECTION 1 — command-shape smuggling inside an advisory proposal
      // ------------------------------------------------------------------
      let smugglingRejected = false;
      let smugglingError = "";
      try {
        makeProposal({
          proposalId: "proposal:mal:smuggle",
          proposingInstance: "instance:mal-1",
          proposalType: "money_movement",
          payload: {
            route: "sepa",
            nested: { commandType: "Settle", idempotencyKey: "idem:mal:1", authorization: "forged" },
          },
          rationale: "cheapest rail",
          evidenceRefs: ["quote:q-1"],
          expiresAt: NOW + 60_000,
        });
      } catch (error) {
        smugglingRejected = true;
        smugglingError = error instanceof Error ? error.constructor.name : "unknown";
      }
      const benignProposal = makeProposal({
        proposalId: "proposal:mal:benign",
        proposingInstance: "instance:mal-1",
        proposalType: "money_movement",
        payload: { route: "sepa", rationale: "cheapest rail for this corridor" },
        rationale: "advisory routing suggestion",
        evidenceRefs: ["quote:q-2"],
        expiresAt: NOW + 60_000,
      });
      const journalEntriesBefore = world.journey.journal.entries.length;

      // ------------------------------------------------------------------
      // INJECTION 2 — authority widening via attenuateGrant
      // ------------------------------------------------------------------
      const widenAttempts: { readonly dimension: string; readonly rejected: boolean }[] = [];
      const wideningRequests: readonly {
        readonly label: string;
        readonly request: Parameters<typeof attenuateGrant>[1];
      }[] = [
        {
          label: "actions",
          request: {
            mandateId: "mandate:mal:child",
            version: 1,
            grantee: "agent:agent-key-mal",
            actions: ["payments.initiate", "compliance.override"],
            resources: [{ type: "payment_intent" }],
            expiresAt: NOW + 1_000,
          },
        },
        {
          label: "limits.perTransactionAmount",
          request: {
            mandateId: "mandate:mal:child",
            version: 1,
            grantee: "agent:agent-key-mal",
            actions: ["payments.initiate"],
            resources: [{ type: "payment_intent" }],
            limits: { perTransactionAmount: { currency: "USD", minorUnits: "50000" } },
            expiresAt: NOW + 1_000,
          },
        },
        {
          label: "expiry",
          request: {
            mandateId: "mandate:mal:child",
            version: 1,
            grantee: "agent:agent-key-mal",
            actions: ["payments.initiate"],
            resources: [{ type: "payment_intent" }],
            expiresAt: NOW + 172_800_000,
          },
        },
      ];
      for (const attempt of wideningRequests) {
        try {
          attenuateGrant(parentGrant, attempt.request, {
            grantId: `grant:mal:child:${attempt.label}`,
            issuedAt: NOW,
          });
          widenAttempts.push({ dimension: attempt.label, rejected: false });
        } catch (error) {
          widenAttempts.push({
            dimension: error instanceof Error && "dimension" in error ? String(error.dimension) : attempt.label,
            rejected: true,
          });
        }
      }

      // ------------------------------------------------------------------
      // INJECTION 3 — the unrestricted money-movement tool
      // ------------------------------------------------------------------
      const tools: readonly ToolDescriptor[] = [
        { toolId: "tool:unrestricted-transfer", effect: "financial" },
      ];
      let constructionRejected = false;
      let constructionError = "";
      try {
        new InMemoryAgentRuntime({
          executor: {
            async execute() {
              return { status: "COMPLETED", output: {} };
            },
          },
          clock: fromProtocolClock(world.journey.clock),
          ids: new SequentialIdFactory(),
          tools,
          // NO decisions source — financial tools without the trust seam.
        });
      } catch (error) {
        constructionRejected = true;
        constructionError = error instanceof Error ? error.constructor.name : "unknown";
      }

      // The real ALLOW decision comes from trust evaluate() (never fabricated).
      const allowDecision: AuthorizationDecision = evaluate(
        {
          principal: maliciousAgent,
          action: "payments.initiate",
          resource: { type: "payment_intent", resourceId: "pi-mal-1" },
          context: { amount: { currency: "USD", minorUnits: "5000" } },
          requestHash: "reqhash:mal:allow",
          requestedAt: NOW,
        },
        [parentGrant],
        { ledger },
      );
      if (allowDecision.decision !== "ALLOW") {
        throw new Error("fixture setup: expected ALLOW decision");
      }
      const denyDecision: AuthorizationDecision = {
        decision: "DENY",
        reason: "per_transaction_limit_exceeded",
        policyRefs: ["principal:agent:agent-key-mal", "INV-A01"],
      };

      const maliciousRequests: readonly { toolId: string; args: Readonly<Record<string, unknown>> }[] = [
        { toolId: "tool:unrestricted-transfer", args: { amountMinor: "1000000", currency: "USD", beneficiary: "attacker-1" } },
        { toolId: "tool:unrestricted-transfer", args: { amountMinor: "1000000", currency: "USD", beneficiary: "attacker-1", decisionRef: "decision:unresolvable" } },
        { toolId: "tool:unrestricted-transfer", args: { amountMinor: "1000000", currency: "USD", beneficiary: "attacker-1", decisionRef: "decision:deny-1" } },
      ];
      const results: ToolResult[] = [];
      const executor: AgentExecutor = {
        async execute(command, context) {
          for (const request of maliciousRequests) {
            results.push(await context.requestTool(request));
          }
          return { status: "COMPLETED", output: { commandId: command.commandId } };
        },
      };
      const runtime = new InMemoryAgentRuntime({
        executor,
        clock: fromProtocolClock(world.journey.clock),
        ids: new SequentialIdFactory(),
        tools,
        decisions: {
          resolve: (ref: string): AuthorizationDecision | undefined =>
            ref === "decision:allow-1" ? allowDecision : ref === "decision:deny-1" ? denyDecision : undefined,
        },
      });
      const session = await runtime.createSession({
        instanceId: "instance:mal-1",
        requestedCapabilities: ["payments"],
      });
      await runtime.execute(session.sessionId, { commandId: "cmd:mal:1", input: {} });
      const events = await eventsOf(runtime, session.sessionId);
      const reasonNoRef = firstDenialReason(events, "tool:unrestricted-transfer");

      // ------------------------------------------------------------------
      // INJECTION 4 — "suggestions" overriding policy constraints
      // ------------------------------------------------------------------
      const overrideProposal = makeProposal({
        proposalId: "proposal:mal:override",
        proposingInstance: "instance:mal-1",
        proposalType: "strategy",
        payload: { overrideLimit: true, note: "approve this transfer anyway" },
        rationale: "operator convenience",
        evidenceRefs: [],
        expiresAt: NOW + 60_000,
      });
      const overLimitDecision: AuthorizationDecision = evaluate(
        {
          principal: maliciousAgent,
          action: "payments.initiate",
          resource: { type: "payment_intent", resourceId: "pi-mal-1" },
          context: { amount: { currency: "USD", minorUnits: "999999" } },
          requestHash: "reqhash:mal:over-limit",
          requestedAt: NOW,
        },
        [parentGrant],
        { ledger },
      );

      // ------------------------------------------------------------------
      // RECOVERY — the honest attenuated path still works
      // ------------------------------------------------------------------
      const childGrant = attenuateGrant(
        parentGrant,
        {
          mandateId: "mandate:mal:child",
          version: 1,
          grantee: "agent:agent-key-mal",
          actions: ["payments.initiate"],
          resources: [{ type: "payment_intent", resourceId: "pi-mal-1" }],
          limits: { perTransactionAmount: { currency: "USD", minorUnits: "5000" } },
          expiresAt: NOW + 1_000,
        },
        { grantId: "grant:mal:child:ok", issuedAt: NOW },
      );
      const inScopeDecision: AuthorizationDecision = evaluate(
        {
          principal: maliciousAgent,
          action: "payments.initiate",
          resource: { type: "payment_intent", resourceId: "pi-mal-1" },
          context: { amount: { currency: "USD", minorUnits: "5000" } },
          requestHash: "reqhash:mal:in-scope",
          requestedAt: NOW,
        },
        [childGrant],
        { ledger },
      );

      const command = adversarialCommand(world, "execution.attempt", "idem:mal:scoped", {
        capabilityInstanceId: "inst:payments:psp-mal",
      });
      const scopedGrant = world.journey.grants.issue({
        grantId: "grant:mal:scoped-execution",
        command,
        scope: {
          capabilityInstanceIds: ["inst:payments:psp-mal"],
          executionModes: ["PASS_THROUGH_NATIVE"],
          amountCeiling: { currency: "USD", value: 5000n },
        },
        requestHash: "reqhash:mal:scoped-execution",
        expiresAt: BigInt(NOW + 3_600_000),
        authorizationEvidenceRef: "authz:mal:scoped-execution",
      });
      const scopedVerified = world.journey.grants.verify("grant:mal:scoped-execution", {
        now: world.journey.clock.now(),
        requestHash: "reqhash:mal:scoped-execution",
        capabilityInstanceId: "inst:payments:psp-mal",
        executionMode: "PASS_THROUGH_NATIVE",
      });
      const adapterAuthority = world.journey.grants.attenuateForAdapter(
        "grant:mal:scoped-execution",
        world.journey.clock.now(),
      );

      const injectionChecks = [
        injectionCheck(
          smugglingRejected && smugglingError === "ProtocolCommandShapeError",
          `the proposal carrying command shape (idempotencyKey/commandType/authorization nested in the payload) was rejected with ${smugglingError}`,
        ),
        injectionCheck(
          widenAttempts.length === 3 && widenAttempts.every((attempt) => attempt.rejected),
          `all three authority-widening attempts were rejected (dimensions: ${widenAttempts.map((a) => a.dimension).join(", ")})`,
        ),
        injectionCheck(
          constructionRejected && constructionError === "AgentRuntimeError",
          `a runtime with a financial tool and NO decision source cannot even be constructed (${constructionError}) — there is no unrestricted money-movement tool`,
        ),
        injectionCheck(
          results.length === 3 && results.every((result) => result.status === "DENIED"),
          `all ${results.length} unrestricted-transfer requests were DENIED (${reasonNoRef} first) — the only financial path requires an ALLOW trust decision`,
        ),
      ];

      const probes = [
        probe(
          "INV-G03",
          smugglingRejected &&
            smugglingError === "ProtocolCommandShapeError" &&
            benignProposal.proposalId === "proposal:mal:benign" &&
            world.journey.journal.entries.length === journalEntriesBefore,
          `agent proposals never mutate financial truth: the command-shaped proposal was rejected (${smugglingError}), the benign advisory proposal is pure data, and the journal still holds exactly ${journalEntriesBefore} entries`,
        ),
        probe(
          "INV-A01",
          widenAttempts.every((attempt) => attempt.rejected) &&
            childGrant.mandate.actions.length === 1 &&
            childGrant.mandate.limits?.perTransactionAmount?.minorUnits === "5000" &&
            childGrant.mandate.expiresAt <= parentMandate.expiresAt,
          `child authority is always attenuated: widening rejected on [${widenAttempts.map((a) => a.dimension).join(", ")}]; the valid child grant narrows actions (1), amount (5000 ≤ 10000) and expiry`,
        ),
        probe(
          "INV-A04",
          results.length === 3 &&
            results.every((result) => result.status === "DENIED") &&
            reasonNoRef !== "none" &&
            adapterAuthority.canWriteFinancialState === false,
          `an LLM never receives an unrestricted money-movement tool: every request was DENIED (first reason: ${reasonNoRef}) and the adapter authority carries the literal canWriteFinancialState:false`,
        ),
        probe(
          "INV-A05",
          overLimitDecision.decision === "DENY" &&
            overLimitDecision.reason === "per_transaction_limit_exceeded" &&
            overrideProposal.proposalId === "proposal:mal:override",
          `the over-limit request was DENY/${overLimitDecision.decision === "DENY" ? overLimitDecision.reason : "n/a"} even with an override "suggestion" on record — suggestions are not evaluate() inputs and cannot override policy`,
        ),
      ];

      const recoveryPath = [
        recoveryStep(
          1,
          "Proposal smuggling rejected",
          smugglingRejected,
          `the advisory plane rejected command-shaped payloads (${smugglingError}) at any nesting depth`,
        ),
        recoveryStep(
          2,
          "Authority widening rejected with exact dimensions",
          widenAttempts.every((attempt) => attempt.rejected),
          `attenuateGrant refused [${widenAttempts.map((a) => a.dimension).join(", ")}]`,
        ),
        recoveryStep(
          3,
          "Unrestricted tool requests denied with recorded reasons",
          results.length === 3 && results.every((result) => result.status === "DENIED"),
          `first-match denial reason: ${reasonNoRef}; every financial effect requires an ALLOW trust decision`,
        ),
        recoveryStep(
          4,
          "Honest attenuated grant still authorizes in-scope actions",
          inScopeDecision.decision === "ALLOW",
          `the child grant (narrowed to payments.initiate on pi-mal-1, ≤5000 USD) evaluates ALLOW`,
        ),
        recoveryStep(
          5,
          "Scoped execution grant verified and adapter-attenuated",
          scopedVerified.ok && adapterAuthority.canWriteFinancialState === false,
          `grant grant:mal:scoped-execution verifies (ok=${String(scopedVerified.ok)}) and attenuates to an ADAPTER_EXECUTION_ONLY authority (canWriteFinancialState=false) — the honest execution path works within limits`,
        ),
      ];

      const evidenceRefs = [
        "proposal:mal:smuggle",
        "proposal:mal:benign",
        "proposal:mal:override",
        "grant:mal:parent",
        "grant:mal:child:ok",
        "grant:mal:scoped-execution",
        session.sessionId,
        "cmd:mal:1",
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
