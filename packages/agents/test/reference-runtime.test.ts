import { describe, expect, it } from "vitest";
import { EpochLedger, evaluate, issueGrant } from "@payswap/trust";
import type { AuthorizationDecision, Mandate, PermissionGrant } from "@payswap/trust";
import { DeterministicClock } from "@payswap/protocol";
import {
  AgentRuntimeError,
  InMemoryAgentRuntime,
  ManualClock,
  SequentialIdFactory,
  SessionStateError,
  UnknownSessionError,
  fromProtocolClock,
} from "../src/index.js";
import type {
  AgentEvent,
  AgentExecutor,
  AgentRuntimeContract,
  AgentRuntimeIds,
  AuthorizationDecisionSource,
  ToolDescriptor,
  ToolResult,
} from "../src/index.js";

/**
 * W2-002 — the in-memory reference runtime: deterministic, event-sourced,
 * real pause/resume/cancel state transitions with checkpoint/restore, and the
 * fail-closed financial-effect tool gate (INV-A04/INV-E01).
 */

const NOW = 1_000_000;

const principal = {
  kind: "agent",
  agentKeyFingerprint: "agent-key-1",
  ownerRef: "user:owner-1",
  bodyRef: "body:payer@1",
  packageVersionRef: "pkg:payer@1",
  authorityEnvelope: [{ mandateId: "mandate-1", version: 1 }],
  securityEpoch: 0n,
} as const;

function mandate(): Mandate {
  return {
    id: "mandate-1",
    version: 1,
    grantor: "user:owner-1",
    grantee: "agent:agent-key-1",
    actions: ["payments.initiate"],
    resources: [{ type: "payment_intent" }],
    expiresAt: NOW + 86_400_000,
    proofRequirements: [],
  };
}

function allowDecision(): AuthorizationDecision {
  const decision = evaluate(
    {
      principal,
      action: "payments.initiate",
      resource: { type: "payment_intent", resourceId: "pi-1" },
      context: { amount: { currency: "EUR", minorUnits: "10000" } },
      requestHash: "reqhash-1",
      requestedAt: NOW,
    },
    [issueGrant(mandate(), { grantId: "grant-1", issuedAt: NOW - 1000 })],
    { ledger: new EpochLedger() },
  );
  if (decision.decision !== "ALLOW") {
    throw new Error("fixture setup: expected ALLOW");
  }
  return decision;
}

function denyDecision(): AuthorizationDecision {
  return {
    decision: "DENY",
    reason: "no_matching_grant",
    policyRefs: ["principal:agent:agent-key-1"],
  };
}

function mapSource(entries: Record<string, AuthorizationDecision>): AuthorizationDecisionSource {
  return {
    resolve: (ref: string): AuthorizationDecision | undefined => entries[ref],
  };
}

function scriptExecutor(
  script: readonly ("COMPLETED" | "REQUIRES_INPUT" | "THROW")[],
): AgentExecutor & { calls: readonly SessionCommandRecord[] } {
  const calls: SessionCommandRecord[] = [];
  let step = 0;
  return {
    calls,
    async execute(command, context) {
      calls.push(command);
      const action = script[Math.min(step, script.length - 1)] ?? "COMPLETED";
      step += 1;
      if (action === "THROW") {
        throw new Error("executor exploded");
      }
      if (action === "REQUIRES_INPUT") {
        return { status: "REQUIRES_INPUT", reason: "need beneficiary confirmation" };
      }
      return { status: "COMPLETED", output: { commandId: command.commandId, contextInstanceId: context.instanceId } };
    },
  };
}

interface SessionCommandRecord {
  readonly commandId: string;
}

function toolCallingExecutor(
  toolRequests: readonly { toolId: string; args: Readonly<Record<string, unknown>> }[],
): AgentExecutor & { results: ToolResult[] } {
  const results: ToolResult[] = [];
  return {
    results,
    async execute(command, context) {
      for (const request of toolRequests) {
        const result = await context.requestTool(request);
        results.push(result);
      }
      return { status: "COMPLETED", output: { commandId: command.commandId } };
    },
  };
}

function makeRuntime(
  executor: AgentExecutor,
  options: { tools?: readonly ToolDescriptor[]; decisions?: AuthorizationDecisionSource } = {},
): InMemoryAgentRuntime {
  return new InMemoryAgentRuntime({
    executor,
    clock: new ManualClock(NOW),
    ids: new SequentialIdFactory(),
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.decisions !== undefined ? { decisions: options.decisions } : {}),
  });
}

async function eventsOf(runtime: InMemoryAgentRuntime, sessionId: string): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of runtime.streamEvents(sessionId)) {
    collected.push(event);
  }
  return collected;
}

describe("InMemoryAgentRuntime — contract conformance and determinism", () => {
  it("satisfies the frozen §20 AgentRuntimeContract", async () => {
    const runtime: AgentRuntimeContract = makeRuntime(scriptExecutor(["COMPLETED"]));
    const session = await runtime.createSession({
      instanceId: "instance-payer",
      requestedCapabilities: ["payments"],
    });
    expect(session.state).toBe("ACTIVE");
    const outcome = await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
    expect(outcome.status).toBe("COMPLETED");
  });

  it("is deterministic: identical injected seams produce identical event logs", async () => {
    async function run(): Promise<AgentEvent[]> {
      const runtime = makeRuntime(scriptExecutor(["REQUIRES_INPUT", "COMPLETED"]));
      const session = await runtime.createSession({
        instanceId: "instance-payer",
        requestedCapabilities: ["payments"],
      });
      await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
      await runtime.approve(session.sessionId, {
        approvalArtifact: { signature: "sig-1", principal: "user:owner-1" },
      });
      await runtime.execute(session.sessionId, { commandId: "cmd-2", input: {} });
      return eventsOf(runtime, session.sessionId);
    }
    const one = await run();
    const two = await run();
    expect(one).toEqual(two);
    expect(one.map((event) => event.type)).toEqual([
      "session_created",
      "execution_started",
      "approval_requested",
      "approval_recorded",
      "execution_started",
      "execution_completed",
    ]);
  });

  it("unknown session operations fail closed", async () => {
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]));
    await expect(runtime.inspect("session-ghost")).rejects.toBeInstanceOf(UnknownSessionError);
    await expect(
      runtime.execute("session-ghost", { commandId: "cmd-1", input: {} }),
    ).rejects.toBeInstanceOf(UnknownSessionError);
  });

  it("fromProtocolClock adapts the protocol clock and refuses unsafe precision", () => {
    const protocol = new DeterministicClock(1_000_000n);
    const clock = fromProtocolClock(protocol);
    expect(clock.now()).toBe(1_000_000);
    protocol.advanceMs(5);
    expect(clock.now()).toBe(1_000_005);
    const huge = new DeterministicClock(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(() => fromProtocolClock(huge).now()).toThrow(RangeError);
  });
});

describe("InMemoryAgentRuntime — execute, approval flow, failure", () => {
  it("COMPLETED: terminal state, output passthrough, full event sequence", async () => {
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]));
    const session = await runtime.createSession({
      instanceId: "instance-payer",
      requestedCapabilities: ["payments", "routing"],
    });
    const outcome = await runtime.execute(session.sessionId, { commandId: "cmd-1", input: { intent: "pay" } });
    expect(outcome).toEqual({
      commandId: "cmd-1",
      status: "COMPLETED",
      output: { commandId: "cmd-1", contextInstanceId: "instance-payer" },
    });
    const inspection = await runtime.inspect(session.sessionId);
    expect(inspection.session.state).toBe("COMPLETED");
    expect(inspection.pendingApprovals).toEqual([]);
    const events = await eventsOf(runtime, session.sessionId);
    expect(events.map((event) => event.type)).toEqual([
      "session_created",
      "execution_started",
      "execution_completed",
    ]);
  });

  it("REQUIRES_INPUT: pending approval is inspectable, approvable, then completable", async () => {
    const runtime = makeRuntime(scriptExecutor(["REQUIRES_INPUT", "COMPLETED"]));
    const session = await runtime.createSession({
      instanceId: "instance-payer",
      requestedCapabilities: [],
    });
    const first = await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
    expect(first.status).toBe("REQUIRES_INPUT");
    const before = await runtime.inspect(session.sessionId);
    expect(before.pendingApprovals).toHaveLength(1);
    const approvalId = before.pendingApprovals[0];
    const approval = await runtime.approve(session.sessionId, {
      approvalArtifact: { signature: "sig-1", principal: "user:owner-1", requestHash: "reqhash-1" },
    });
    expect(approval).toEqual({ accepted: true });
    const after = await runtime.inspect(session.sessionId);
    expect(after.pendingApprovals).toEqual([]);
    const second = await runtime.execute(session.sessionId, { commandId: "cmd-2", input: {} });
    expect(second.status).toBe("COMPLETED");
    const events = await eventsOf(runtime, session.sessionId);
    expect(events.map((event) => event.type)).toContain("approval_requested");
    expect(events.map((event) => event.type)).toContain("approval_recorded");
    const requested = events.find((event) => event.type === "approval_requested");
    expect(requested?.payload).toMatchObject({ commandId: "cmd-1", approvalId });
  });

  it("approve fails closed with no pending approval or an empty artifact", async () => {
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]));
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    const noPending = await runtime.approve(session.sessionId, { approvalArtifact: { sig: "x" } });
    expect(noPending).toEqual({ accepted: false, reason: "no_pending_approval" });
    await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
    // session is COMPLETED (terminal): approving is a state error
    await expect(
      runtime.approve(session.sessionId, { approvalArtifact: { sig: "x" } }),
    ).rejects.toBeInstanceOf(SessionStateError);
  });

  it("executor exceptions become errored events and a FAILED session", async () => {
    const runtime = makeRuntime(scriptExecutor(["THROW"]));
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    const outcome = await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
    expect(outcome.status).toBe("FAILED");
    const inspection = await runtime.inspect(session.sessionId);
    expect(inspection.session.state).toBe("FAILED");
    const events = await eventsOf(runtime, session.sessionId);
    const errored = events.find((event) => event.type === "errored");
    expect(errored?.payload).toMatchObject({ commandId: "cmd-1", error: "executor exploded" });
  });

  it("time budget exceeded fails the execution closed", async () => {
    const clock = new ManualClock(NOW);
    const runtime = new InMemoryAgentRuntime({
      executor: scriptExecutor(["COMPLETED"]),
      clock,
      ids: new SequentialIdFactory(),
    });
    const session = await runtime.createSession({
      instanceId: "i",
      requestedCapabilities: [],
      timeBudgetMs: 1000,
    });
    clock.advanceBy(1500);
    const outcome = await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
    expect(outcome.status).toBe("FAILED");
    const events = await eventsOf(runtime, session.sessionId);
    const errored = events.find((event) => event.type === "errored");
    expect(errored?.payload).toMatchObject({ commandId: "cmd-1", reason: "time_budget_exceeded" });
    expect((await runtime.inspect(session.sessionId)).session.state).toBe("FAILED");
  });
});

describe("InMemoryAgentRuntime — pause/resume/cancel are real state transitions", () => {
  it("paused sessions cannot execute or call tools; resume restores activity", async () => {
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]));
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    await runtime.pause(session.sessionId);
    let inspection = await runtime.inspect(session.sessionId);
    expect(inspection.session.state).toBe("PAUSED");
    expect(inspection.lastCheckpoint).toBeDefined();
    await expect(
      runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} }),
    ).rejects.toBeInstanceOf(SessionStateError);
    const tool = await runtime.requestTool(session.sessionId, { toolId: "tool-x", args: {} });
    expect(tool.status).toBe("DENIED");
    await runtime.resume(session.sessionId);
    inspection = await runtime.inspect(session.sessionId);
    expect(inspection.session.state).toBe("ACTIVE");
    const outcome = await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
    expect(outcome.status).toBe("COMPLETED");
    const events = await eventsOf(runtime, session.sessionId);
    expect(events.map((event) => event.type)).toEqual([
      "session_created",
      "paused",
      "checkpointed",
      // the paused tool call is itself evidenced as DENIED (fail closed)
      "tool_requested",
      "resumed",
      "execution_started",
      "execution_completed",
    ]);
    const deniedTool = events.find((event) => event.type === "tool_requested");
    expect(deniedTool?.payload).toMatchObject({
      toolId: "tool-x",
      status: "DENIED",
      reason: "session_not_active:PAUSED",
    });
  });

  it("pausing twice, resuming an active session and unknown checkpoints are errors", async () => {
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]));
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    await expect(runtime.resume(session.sessionId)).rejects.toBeInstanceOf(SessionStateError);
    await runtime.pause(session.sessionId);
    await expect(runtime.pause(session.sessionId)).rejects.toBeInstanceOf(SessionStateError);
    await expect(
      runtime.restoreCheckpoint(session.sessionId, "checkpoint-ghost"),
    ).rejects.toBeInstanceOf(AgentRuntimeError);
  });

  it("cancel is terminal and monotonic (INV-X04)", async () => {
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]));
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    await runtime.pause(session.sessionId);
    await runtime.cancel(session.sessionId, "user requested");
    const inspection = await runtime.inspect(session.sessionId);
    expect(inspection.session.state).toBe("CANCELLED");
    await expect(runtime.resume(session.sessionId)).rejects.toBeInstanceOf(SessionStateError);
    await expect(
      runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} }),
    ).rejects.toBeInstanceOf(SessionStateError);
    await expect(runtime.cancel(session.sessionId, "again")).rejects.toBeInstanceOf(SessionStateError);
    const events = await eventsOf(runtime, session.sessionId);
    expect(events.at(-1)?.type).toBe("cancelled");
    expect(events.at(-1)?.payload).toMatchObject({ reason: "user requested" });
  });
});

describe("InMemoryAgentRuntime — checkpoint/restore of session logs", () => {
  it("restoreCheckpoint rewinds runtime state while the event log is retained (INV-E05)", async () => {
    const runtime = makeRuntime(scriptExecutor(["REQUIRES_INPUT", "COMPLETED"]));
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
    const checkpoint = await runtime.checkpoint(session.sessionId);
    // pending approval p1 exists at checkpoint time
    expect((await runtime.inspect(session.sessionId)).pendingApprovals).toHaveLength(1);
    await runtime.approve(session.sessionId, { approvalArtifact: { sig: "s" } });
    expect((await runtime.inspect(session.sessionId)).pendingApprovals).toEqual([]);
    const logLengthBeforeRestore = (await eventsOf(runtime, session.sessionId)).length;

    await runtime.restoreCheckpoint(session.sessionId, checkpoint.checkpointId);

    // runtime state rewound: the approval is pending again
    const restored = await runtime.inspect(session.sessionId);
    expect(restored.pendingApprovals).toHaveLength(1);
    expect(restored.session.state).toBe("ACTIVE");
    // the log is append-only: nothing was deleted, recovery itself is evidenced
    const events = await eventsOf(runtime, session.sessionId);
    expect(events.length).toBe(logLengthBeforeRestore + 1);
    expect(events.at(-1)?.type).toBe("resumed");
    expect(events.at(-1)?.payload).toMatchObject({
      restoredFrom: checkpoint.checkpointId,
      sequence: checkpoint.sequence,
    });
    // the workflow can be re-driven to completion from the restored state
    await runtime.approve(session.sessionId, { approvalArtifact: { sig: "s2" } });
    const outcome = await runtime.execute(session.sessionId, { commandId: "cmd-2", input: {} });
    expect(outcome.status).toBe("COMPLETED");
    const finalEvents = await eventsOf(runtime, session.sessionId);
    expect(finalEvents.filter((event) => event.type === "approval_recorded")).toHaveLength(2);
  });

  it("restore is refused on terminal sessions (monotonic terminal states)", async () => {
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]));
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    const checkpoint = await runtime.checkpoint(session.sessionId);
    await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
    await expect(
      runtime.restoreCheckpoint(session.sessionId, checkpoint.checkpointId),
    ).rejects.toBeInstanceOf(SessionStateError);
  });
});

describe("InMemoryAgentRuntime — fail-closed financial tool gate (INV-A04/INV-E01)", () => {
  const tools = [
    { toolId: "tool:balance-read", effect: "informational" as const },
    { toolId: "tool:initiate-payment", effect: "financial" as const },
  ];

  it("refuses construction with financial tools but no decision source", () => {
    expect(
      () =>
        new InMemoryAgentRuntime({
          executor: scriptExecutor(["COMPLETED"]),
          clock: new ManualClock(NOW),
          ids: new SequentialIdFactory(),
          tools,
        }),
    ).toThrow(AgentRuntimeError);
  });

  it("grants informational tools without a decision reference", async () => {
    const executor = toolCallingExecutor([{ toolId: "tool:balance-read", args: {} }]);
    const runtime = makeRuntime(executor, { tools, decisions: mapSource({}) });
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
    expect(executor.results).toEqual([
      { toolId: "tool:balance-read", status: "GRANTED", result: { effect: "informational" } },
    ]);
  });

  it("REJECTS a financial tool without a decision reference (never best-effort)", async () => {
    const executor = toolCallingExecutor([
      { toolId: "tool:initiate-payment", args: { amount: "10000" } },
    ]);
    const runtime = makeRuntime(executor, { tools, decisions: mapSource({}) });
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    await runtime.execute(session.sessionId, { commandId: "cmd-1", input: {} });
    expect(executor.results).toEqual([{ toolId: "tool:initiate-payment", status: "DENIED" }]);
    const events = await eventsOf(runtime, session.sessionId);
    const toolEvent = events.find((event) => event.type === "tool_requested");
    expect(toolEvent?.payload).toMatchObject({
      toolId: "tool:initiate-payment",
      status: "DENIED",
      reason: "missing_decision_ref",
    });
  });

  it("REJECTS on unknown or non-ALLOW decision references", async () => {
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]), {
      tools,
      decisions: mapSource({ "decision:unknown-map": denyDecision() }),
    });
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    const unknown = await runtime.requestTool(session.sessionId, {
      toolId: "tool:initiate-payment",
      args: { decisionRef: "decision:missing" },
    });
    expect(unknown.status).toBe("DENIED");
    const denied = await runtime.requestTool(session.sessionId, {
      toolId: "tool:initiate-payment",
      args: { decisionRef: "decision:unknown-map" },
    });
    expect(denied.status).toBe("DENIED");
    const wrongType = await runtime.requestTool(session.sessionId, {
      toolId: "tool:initiate-payment",
      args: { decisionRef: 42 },
    });
    expect(wrongType.status).toBe("DENIED");
    const events = await eventsOf(runtime, session.sessionId);
    const reasons = events
      .filter((event) => event.type === "tool_requested")
      .map((event) => event.payload?.reason);
    expect(reasons).toContain("unknown_decision_ref");
    expect(reasons).toContain("decision_not_allow:DENY");
    expect(reasons).toContain("missing_decision_ref");
  });

  it("GRANTS a financial tool only with a resolvable ALLOW decision reference", async () => {
    const allow = allowDecision();
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]), {
      tools,
      decisions: mapSource({ "decision:allow-1": allow }),
    });
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    const granted = await runtime.requestTool(session.sessionId, {
      toolId: "tool:initiate-payment",
      args: { decisionRef: "decision:allow-1", amount: "10000" },
    });
    expect(granted).toEqual({
      toolId: "tool:initiate-payment",
      status: "GRANTED",
      result: { effect: "financial", decisionRef: "decision:allow-1" },
    });
    const events = await eventsOf(runtime, session.sessionId);
    const toolEvent = events.find((event) => event.type === "tool_requested");
    expect(toolEvent?.payload).toMatchObject({
      toolId: "tool:initiate-payment",
      status: "GRANTED",
      effect: "financial",
      decisionRef: "decision:allow-1",
    });
  });

  it("unknown tools are denied, never guessed", async () => {
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]), { tools, decisions: mapSource({}) });
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    const result = await runtime.requestTool(session.sessionId, {
      toolId: "tool:ledger-write",
      args: {},
    });
    expect(result.status).toBe("DENIED");
    const events = await eventsOf(runtime, session.sessionId);
    expect(events.find((event) => event.type === "tool_requested")?.payload).toMatchObject({
      reason: "unknown_tool",
    });
  });

  it("a revoked scoped grant fails closed end-to-end: evaluate DENY ⇒ tool DENIED", async () => {
    // The trust evaluate() gate (scoped_grant_revoked) feeds the runtime gate:
    // the whole chain fails closed, never best-effort.
    const { ScopedGrantRegistry } = await import("@payswap/trust");
    const registry = new ScopedGrantRegistry();
    registry.issue({
      grantId: "sg-1",
      mandateRef: { mandateId: "mandate-1", version: 1 },
      scope: { actions: ["payments.initiate"] },
      grantedAt: NOW - 10,
      expiresAt: NOW + 10_000,
      conditions: [],
      decisionRef: "decision:allow-1",
    });
    registry.revoke("sg-1", NOW, "user revoked");
    const decision = evaluate(
      {
        principal,
        action: "payments.initiate",
        resource: { type: "payment_intent", resourceId: "pi-1" },
        context: { amount: { currency: "EUR", minorUnits: "10000" } },
        requestHash: "reqhash-1",
        requestedAt: NOW,
      },
      [issueGrant(mandate(), { grantId: "grant-1", issuedAt: NOW - 1000 })],
      { ledger: new EpochLedger(), scopedGrants: registry },
    );
    expect(decision.decision).toBe("DENY");
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]), {
      tools,
      decisions: mapSource({ "decision:revoked": decision }),
    });
    const session = await runtime.createSession({ instanceId: "i", requestedCapabilities: [] });
    const result = await runtime.requestTool(session.sessionId, {
      toolId: "tool:initiate-payment",
      args: { decisionRef: "decision:revoked" },
    });
    expect(result.status).toBe("DENIED");
  });
});

describe("InMemoryAgentRuntime — ids and validation", () => {
  it("SequentialIdFactory mints deterministic, distinct ids per kind", () => {
    const ids: AgentRuntimeIds = new SequentialIdFactory("rt/");
    expect(ids.nextSessionId()).toBe("rt/session-1");
    expect(ids.nextApprovalId()).toBe("rt/approval-2");
    expect(ids.nextCheckpointId()).toBe("rt/checkpoint-3");
    expect(ids.nextSessionId()).toBe("rt/session-4");
  });

  it("createSession validates instanceId, capabilities and budget", async () => {
    const runtime = makeRuntime(scriptExecutor(["COMPLETED"]));
    await expect(
      runtime.createSession({ instanceId: "", requestedCapabilities: [] }),
    ).rejects.toBeInstanceOf(AgentRuntimeError);
    await expect(
      runtime.createSession({ instanceId: "i", requestedCapabilities: [""] }),
    ).rejects.toBeInstanceOf(AgentRuntimeError);
    await expect(
      runtime.createSession({ instanceId: "i", requestedCapabilities: [], timeBudgetMs: 0 }),
    ).rejects.toBeInstanceOf(AgentRuntimeError);
    await expect(
      runtime.execute("whatever", { commandId: "", input: {} }),
    ).rejects.toBeInstanceOf(AgentRuntimeError);
  });
});
