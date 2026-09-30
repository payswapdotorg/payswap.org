import type { AuthorizationDecision } from "@payswap/trust";
import type { ProtocolClock } from "@payswap/protocol";
import type {
  AgentEvent,
  AgentRuntimeContract,
  AgentSession,
  AgentSessionState,
  ApprovalResult,
  ApprovalSubmission,
  CheckpointRef,
  ExecutionOutcome,
  SessionCommand,
  SessionCreateRequest,
  SessionInspection,
  ToolRequest,
  ToolResult,
} from "../runtime.js";

/**
 * In-memory reference agent runtime (W2-002, FROZEN-ARCHITECTURE §20).
 *
 * Implements the W2-001 `AgentRuntimeContract` with:
 *
 * - DETERMINISM: no wall clock, no random ids, no LLM/HTTP calls. Time comes
 *   from an injected `AgentRuntimeClock`, identifiers from an injected
 *   `AgentRuntimeIds` factory, agent behavior from an injected `AgentExecutor`
 *   seam. The same injected inputs always produce the same session log.
 * - EVENT SOURCING: every session owns an append-only event log
 *   (`session_created` … `cancelled`/`errored`). Checkpoints snapshot the log;
 *   `restoreCheckpoint` rewinds RUNTIME STATE from a snapshot while the log
 *   itself is retained (historical evidence is immutable, INV-E05).
 * - REAL STATE TRANSITIONS: pause/resume/cancel are genuine session-state
 *   machine transitions — a paused session cannot execute or call tools, a
 *   cancelled session is terminal (INV-X04).
 * - FAIL-CLOSED TOOL GATE (INV-A04/INV-E01): a financial-effect tool call must
 *   carry an authorization-decision reference resolvable to an ALLOW decision
 *   produced by @payswap/trust `evaluate()`. Absent, unknown, denied or
 *   needs-approval references REJECT the tool call. Never best-effort.
 *
 * External protocols (MCP, A2A, AG-UI, REST) are edge adapters to the contract
 * and never domain authority; this reference runtime is the deterministic
 * in-process implementation.
 */

/** Raised on any invalid runtime operation argument or state transition. */
export class AgentRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

/** Raised when an operation names a session this runtime never created. */
export class UnknownSessionError extends AgentRuntimeError {
  constructor(sessionId: string) {
    super(`unknown session '${sessionId}'`);
    this.name = "UnknownSessionError";
  }
}

/** Raised on an illegal session-state transition (fail closed, INV-X04). */
export class SessionStateError extends AgentRuntimeError {
  readonly from: AgentSessionState;
  readonly to: AgentSessionState;

  constructor(operation: string, from: AgentSessionState, to: AgentSessionState) {
    super(
      `cannot ${operation} session in state ${from} (would move to ${to}): ` +
        "pause/resume/cancel are real state transitions; terminal states are monotonic",
    );
    this.name = "SessionStateError";
    this.from = from;
    this.to = to;
  }
}

/** Raised when a checkpoint no longer matches the session log prefix (tamper fail-closed). */
export class CheckpointIntegrityError extends AgentRuntimeError {
  constructor(sessionId: string, checkpointId: string) {
    super(
      `checkpoint '${checkpointId}' of session '${sessionId}' does not match the append-only log prefix: history must be immutable (INV-E05)`,
    );
    this.name = "CheckpointIntegrityError";
  }
}

/**
 * Deterministic time source (number milliseconds, matching the frozen §20
 * contract's number timestamps). The protocol kernel's `ProtocolClock` is
 * bigint-precision; adapt it with `fromProtocolClock`.
 */
export interface AgentRuntimeClock {
  now(): number;
}

/** Deterministic identifier factory for sessions, checkpoints and approvals. */
export interface AgentRuntimeIds {
  nextSessionId(): string;
  nextCheckpointId(): string;
  nextApprovalId(): string;
}

/** Classify a tool's effect: financial tools are gated, informational are not. */
export type ToolEffect = "financial" | "informational";

/**
 * Tool descriptor registered with the runtime. A tool that is not registered
 * is DENIED — unknown tools are never granted (fail closed).
 */
export interface ToolDescriptor {
  readonly toolId: string;
  readonly effect: ToolEffect;
}

/**
 * Source of authorization decisions (INV-E01 evidence). The composition root
 * wires this to decisions produced by @payswap/trust `evaluate()`; the
 * reference runtime only ever RESOLVES references, it never fabricates
 * decisions.
 */
export interface AuthorizationDecisionSource {
  resolve(decisionRef: string): AuthorizationDecision | undefined;
}

/** Handle the injected executor uses to act inside one session. */
export interface ExecutorContext {
  readonly sessionId: string;
  readonly instanceId: string;
  /**
   * Request a tool through the runtime's fail-closed authorization gate.
   * Financial-effect tools require an ALLOW decision reference.
   */
  requestTool(request: ToolRequest): Promise<ToolResult>;
}

/** Deterministic result of one executor invocation. */
export type ExecutorResult =
  | { readonly status: "COMPLETED"; readonly output?: Readonly<Record<string, unknown>> }
  | { readonly status: "REQUIRES_INPUT"; readonly reason?: string }
  | { readonly status: "FAILED"; readonly error: string };

/**
 * The injected agent-behavior seam. Concrete executors (model adapters, W2-003
 * transports) implement this; the runtime owns state, events and the tool
 * gate. No LLM or HTTP call ever happens inside the runtime itself.
 */
export interface AgentExecutor {
  execute(command: SessionCommand, context: ExecutorContext): Promise<ExecutorResult>;
}

/** Constructor inputs: everything is injected, nothing is ambient. */
export interface InMemoryAgentRuntimeParams {
  readonly executor: AgentExecutor;
  readonly clock: AgentRuntimeClock;
  readonly ids: AgentRuntimeIds;
  readonly tools?: readonly ToolDescriptor[];
  readonly decisions?: AuthorizationDecisionSource;
}

interface CheckpointSnapshot {
  readonly ref: CheckpointRef;
  readonly session: AgentSession;
  readonly pendingApprovals: readonly string[];
  readonly eventsPrefix: readonly AgentEvent[];
  readonly timeBudgetMs?: number;
}

interface SessionRecord {
  session: AgentSession;
  readonly events: AgentEvent[];
  readonly pendingApprovals: string[];
  readonly checkpoints: Map<string, CheckpointSnapshot>;
  lastCheckpoint?: CheckpointSnapshot;
  readonly requestedCapabilities: readonly string[];
  readonly timeBudgetMs?: number;
}

const DECISION_REF_ARG = "decisionRef";

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new AgentRuntimeError(`${label} must not be empty`);
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Adapt a @payswap/protocol clock (bigint `TimestampMs`) onto the number-based
 * `AgentRuntimeClock` seam mandated by the frozen §20 contract. Fails closed
 * with a RangeError when the protocol time exceeds `Number.MAX_SAFE_INTEGER`
 * rather than silently losing precision.
 */
export function fromProtocolClock(clock: ProtocolClock): AgentRuntimeClock {
  return {
    now(): number {
      const ms = clock.now();
      if (ms > BigInt(Number.MAX_SAFE_INTEGER) || ms < -BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(
          "protocol clock time exceeds Number.MAX_SAFE_INTEGER: refusing lossy number conversion",
        );
      }
      return Number(ms);
    },
  };
}

/** Deterministic sequential id factory: `session-1`, `checkpoint-2`, … */
export class SequentialIdFactory implements AgentRuntimeIds {
  readonly #prefix: string;
  #next = 0;

  constructor(prefix = "") {
    this.#prefix = prefix;
  }

  #mint(kind: string): string {
    this.#next += 1;
    return `${this.#prefix}${kind}-${this.#next}`;
  }

  nextSessionId(): string {
    return this.#mint("session");
  }

  nextCheckpointId(): string {
    return this.#mint("checkpoint");
  }

  nextApprovalId(): string {
    return this.#mint("approval");
  }
}

/** Manual number-millisecond clock for deterministic tests and replay. */
export class ManualClock implements AgentRuntimeClock {
  #now: number;

  constructor(seed: number) {
    if (!Number.isFinite(seed)) {
      throw new AgentRuntimeError("clock seed must be finite");
    }
    this.#now = seed;
  }

  now(): number {
    return this.#now;
  }

  set(now: number): void {
    this.#now = now;
  }

  advanceBy(ms: number): void {
    this.#now += ms;
  }
}

/**
 * The in-memory reference runtime. See the module documentation for the
 * determinism, event-sourcing, state-machine and fail-closed guarantees.
 */
export class InMemoryAgentRuntime implements AgentRuntimeContract {
  readonly #executor: AgentExecutor;
  readonly #clock: AgentRuntimeClock;
  readonly #ids: AgentRuntimeIds;
  readonly #tools: readonly ToolDescriptor[];
  readonly #decisions: AuthorizationDecisionSource | undefined;
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(params: InMemoryAgentRuntimeParams) {
    this.#executor = params.executor;
    this.#clock = params.clock;
    this.#ids = params.ids;
    this.#tools = params.tools ?? [];
    this.#decisions = params.decisions;
    // Fail closed at construction: a financial tool without a decision source
    // could never be granted; such a runtime must not even start.
    if (this.#decisions === undefined && this.#tools.some((tool) => tool.effect === "financial")) {
      throw new AgentRuntimeError(
        "financial-effect tools require an AuthorizationDecisionSource: construct the runtime with the trust decision seam",
      );
    }
    const seenTools = new Set<string>();
    for (const tool of this.#tools) {
      requireNonEmpty(tool.toolId, "toolId");
      if (seenTools.has(tool.toolId)) {
        throw new AgentRuntimeError(`duplicate tool descriptor '${tool.toolId}'`);
      }
      seenTools.add(tool.toolId);
    }
  }

  #require(sessionId: string): SessionRecord {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      throw new UnknownSessionError(sessionId);
    }
    return record;
  }

  #emit(record: SessionRecord, type: AgentEvent["type"], payload?: Readonly<Record<string, unknown>>): void {
    const event: AgentEvent = {
      type,
      sessionId: record.session.sessionId,
      occurredAt: this.#clock.now(),
      ...(payload !== undefined ? { payload } : {}),
    };
    record.events.push(event);
  }

  #snapshot(record: SessionRecord, checkpointId: string): CheckpointSnapshot {
    return {
      ref: { checkpointId, sequence: record.events.length },
      session: { ...record.session },
      pendingApprovals: [...record.pendingApprovals],
      eventsPrefix: [...record.events],
      ...(record.timeBudgetMs !== undefined ? { timeBudgetMs: record.timeBudgetMs } : {}),
    };
  }

  #verifyPrefix(record: SessionRecord, snapshot: CheckpointSnapshot): void {
    const prefix = record.events.slice(0, snapshot.ref.sequence);
    if (
      prefix.length !== snapshot.ref.sequence ||
      !jsonEqual(prefix, snapshot.eventsPrefix)
    ) {
      throw new CheckpointIntegrityError(record.session.sessionId, snapshot.ref.checkpointId);
    }
  }

  async createSession(request: SessionCreateRequest): Promise<AgentSession> {
    requireNonEmpty(request.instanceId, "instanceId");
    for (const capability of request.requestedCapabilities) {
      requireNonEmpty(capability, "requestedCapabilities entry");
    }
    if (request.timeBudgetMs !== undefined && request.timeBudgetMs <= 0) {
      throw new AgentRuntimeError("timeBudgetMs must be positive when supplied");
    }
    const sessionId = this.#ids.nextSessionId();
    const session: AgentSession = {
      sessionId,
      instanceId: request.instanceId,
      createdAt: this.#clock.now(),
      state: "ACTIVE",
    };
    const record: SessionRecord = {
      session,
      events: [],
      pendingApprovals: [],
      checkpoints: new Map(),
      requestedCapabilities: [...request.requestedCapabilities],
      ...(request.timeBudgetMs !== undefined ? { timeBudgetMs: request.timeBudgetMs } : {}),
    };
    this.#sessions.set(sessionId, record);
    this.#emit(record, "session_created", {
      instanceId: request.instanceId,
      requestedCapabilities: [...request.requestedCapabilities],
      ...(request.timeBudgetMs !== undefined ? { timeBudgetMs: request.timeBudgetMs } : {}),
    });
    return { ...session };
  }

  async execute(sessionId: string, command: SessionCommand): Promise<ExecutionOutcome> {
    requireNonEmpty(command.commandId, "commandId");
    const record = this.#require(sessionId);
    if (record.session.state !== "ACTIVE") {
      throw new SessionStateError("execute", record.session.state, record.session.state);
    }
    const budget = record.timeBudgetMs;
    if (budget !== undefined && this.#clock.now() - record.session.createdAt >= budget) {
      this.#emit(record, "errored", { commandId: command.commandId, reason: "time_budget_exceeded" });
      record.session = { ...record.session, state: "FAILED" };
      return { commandId: command.commandId, status: "FAILED" };
    }
    this.#emit(record, "execution_started", { commandId: command.commandId });
    const context: ExecutorContext = {
      sessionId,
      instanceId: record.session.instanceId,
      requestTool: (toolRequest) => this.requestTool(sessionId, toolRequest),
    };
    let result: ExecutorResult;
    try {
      result = await this.#executor.execute(command, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#emit(record, "errored", { commandId: command.commandId, error: message });
      record.session = { ...record.session, state: "FAILED" };
      return { commandId: command.commandId, status: "FAILED" };
    }
    switch (result.status) {
      case "COMPLETED": {
        this.#emit(record, "execution_completed", {
          commandId: command.commandId,
          status: "COMPLETED",
        });
        record.session = { ...record.session, state: "COMPLETED" };
        return {
          commandId: command.commandId,
          status: "COMPLETED",
          ...(result.output !== undefined ? { output: result.output } : {}),
        };
      }
      case "REQUIRES_INPUT": {
        const approvalId = this.#ids.nextApprovalId();
        record.pendingApprovals.push(approvalId);
        this.#emit(record, "approval_requested", {
          commandId: command.commandId,
          approvalId,
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        });
        return { commandId: command.commandId, status: "REQUIRES_INPUT" };
      }
      case "FAILED": {
        this.#emit(record, "errored", { commandId: command.commandId, error: result.error });
        record.session = { ...record.session, state: "FAILED" };
        return { commandId: command.commandId, status: "FAILED" };
      }
    }
  }

  streamEvents(sessionId: string): AsyncIterableIterator<AgentEvent> {
    const record = this.#require(sessionId);
    // Deterministic replay semantics: the stream yields the append-only log
    // exactly as recorded at call time, in order, then completes. Live
    // transport streaming is an edge-adapter concern (W2-003), never domain
    // behavior, so the reference runtime stays replay-deterministic.
    const log = [...record.events];
    return (async function* replay(): AsyncIterableIterator<AgentEvent> {
      for (const event of log) {
        yield event;
      }
    })();
  }

  async approve(sessionId: string, submission: ApprovalSubmission): Promise<ApprovalResult> {
    const record = this.#require(sessionId);
    if (record.session.state !== "ACTIVE") {
      throw new SessionStateError("approve in", record.session.state, record.session.state);
    }
    const next = record.pendingApprovals[0];
    if (next === undefined) {
      return { accepted: false, reason: "no_pending_approval" };
    }
    if (Object.keys(submission.approvalArtifact).length === 0) {
      return { accepted: false, reason: "empty_approval_artifact" };
    }
    record.pendingApprovals.shift();
    this.#emit(record, "approval_recorded", { approvalId: next });
    // Structural recording only: cryptographic verification of the artifact
    // belongs to the trusted approval surface (W3-002). A chat message is not
    // authority (INV-A03); runtimes must never fabricate or verify signatures.
    return { accepted: true };
  }

  async requestTool(sessionId: string, request: ToolRequest): Promise<ToolResult> {
    requireNonEmpty(request.toolId, "toolId");
    const record = this.#require(sessionId);
    if (record.session.state !== "ACTIVE") {
      // A paused, cancelled or failed session cannot act — fail closed.
      this.#emit(record, "tool_requested", {
        toolId: request.toolId,
        status: "DENIED",
        reason: `session_not_active:${record.session.state}`,
      });
      return { toolId: request.toolId, status: "DENIED" };
    }
    const descriptor = this.#tools.find((tool) => tool.toolId === request.toolId);
    if (descriptor === undefined) {
      this.#emit(record, "tool_requested", {
        toolId: request.toolId,
        status: "DENIED",
        reason: "unknown_tool",
      });
      return { toolId: request.toolId, status: "DENIED" };
    }
    if (descriptor.effect === "informational") {
      this.#emit(record, "tool_requested", {
        toolId: request.toolId,
        status: "GRANTED",
        effect: "informational",
      });
      return { toolId: request.toolId, status: "GRANTED", result: { effect: "informational" } };
    }
    // Financial-effect tool: an ALLOW decision reference is mandatory (INV-A04,
    // INV-E01). Absent, unknown or non-ALLOW ⇒ REJECTED, never best-effort.
    const raw = request.args[DECISION_REF_ARG];
    const decisionRef = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    if (decisionRef === undefined) {
      this.#emit(record, "tool_requested", {
        toolId: request.toolId,
        status: "DENIED",
        reason: "missing_decision_ref",
      });
      return { toolId: request.toolId, status: "DENIED" };
    }
    const decision = this.#decisions?.resolve(decisionRef);
    if (decision === undefined) {
      this.#emit(record, "tool_requested", {
        toolId: request.toolId,
        status: "DENIED",
        reason: "unknown_decision_ref",
        decisionRef,
      });
      return { toolId: request.toolId, status: "DENIED" };
    }
    if (decision.decision !== "ALLOW") {
      this.#emit(record, "tool_requested", {
        toolId: request.toolId,
        status: "DENIED",
        reason: `decision_not_allow:${decision.decision}`,
        decisionRef,
      });
      return { toolId: request.toolId, status: "DENIED" };
    }
    this.#emit(record, "tool_requested", {
      toolId: request.toolId,
      status: "GRANTED",
      effect: "financial",
      decisionRef,
    });
    return {
      toolId: request.toolId,
      status: "GRANTED",
      result: { effect: "financial", decisionRef },
    };
  }

  async checkpoint(sessionId: string): Promise<CheckpointRef> {
    const record = this.#require(sessionId);
    if (record.session.state !== "ACTIVE" && record.session.state !== "PAUSED") {
      throw new SessionStateError("checkpoint", record.session.state, record.session.state);
    }
    const checkpointId = this.#ids.nextCheckpointId();
    this.#emit(record, "checkpointed", { checkpointId });
    const snapshot = this.#snapshot(record, checkpointId);
    record.checkpoints.set(checkpointId, snapshot);
    record.lastCheckpoint = snapshot;
    return { ...snapshot.ref };
  }

  async pause(sessionId: string): Promise<void> {
    const record = this.#require(sessionId);
    if (record.session.state !== "ACTIVE") {
      throw new SessionStateError("pause", record.session.state, "PAUSED");
    }
    record.session = { ...record.session, state: "PAUSED" };
    this.#emit(record, "paused");
    // A pause always materializes a checkpoint: the session log and state are
    // captured so resume/restore never depends on ambient memory.
    const checkpointId = this.#ids.nextCheckpointId();
    this.#emit(record, "checkpointed", { checkpointId });
    const snapshot = this.#snapshot(record, checkpointId);
    record.checkpoints.set(checkpointId, snapshot);
    record.lastCheckpoint = snapshot;
  }

  async resume(sessionId: string): Promise<void> {
    const record = this.#require(sessionId);
    if (record.session.state !== "PAUSED") {
      throw new SessionStateError("resume", record.session.state, "ACTIVE");
    }
    // Restore: verify the log prefix captured at the pause checkpoint is still
    // intact (the append-only history was not rewritten while paused).
    const snapshot = record.lastCheckpoint;
    if (snapshot !== undefined) {
      this.#verifyPrefix(record, snapshot);
    }
    record.session = { ...record.session, state: "ACTIVE" };
    this.#emit(record, "resumed");
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    requireNonEmpty(reason, "cancel reason");
    const record = this.#require(sessionId);
    if (record.session.state !== "ACTIVE" && record.session.state !== "PAUSED") {
      throw new SessionStateError("cancel", record.session.state, "CANCELLED");
    }
    record.session = { ...record.session, state: "CANCELLED" };
    this.#emit(record, "cancelled", { reason });
  }

  async inspect(sessionId: string): Promise<SessionInspection> {
    const record = this.#require(sessionId);
    return {
      session: { ...record.session },
      ...(record.lastCheckpoint !== undefined
        ? { lastCheckpoint: { ...record.lastCheckpoint.ref } }
        : {}),
      pendingApprovals: [...record.pendingApprovals],
    };
  }

  /**
   * W2-002 reference extension (NOT part of the frozen §20 contract):
   * crash-recovery restore of the session runtime state from a stored
   * checkpoint. The append-only event log is fully RETAINED (INV-E05); only
   * the runtime state (session fields, pending approvals) rewinds, and a
   * `resumed` event with a `restoredFrom` marker is appended so the recovery
   * is itself evidenced. Requires a non-terminal session.
   */
  async restoreCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
    const record = this.#require(sessionId);
    if (
      record.session.state !== "ACTIVE" &&
      record.session.state !== "PAUSED"
    ) {
      throw new SessionStateError("restore", record.session.state, record.session.state);
    }
    const snapshot = record.checkpoints.get(checkpointId);
    if (snapshot === undefined) {
      throw new AgentRuntimeError(
        `unknown checkpoint '${checkpointId}' for session '${sessionId}'`,
      );
    }
    this.#verifyPrefix(record, snapshot);
    record.session = { ...snapshot.session };
    record.pendingApprovals.length = 0;
    record.pendingApprovals.push(...snapshot.pendingApprovals);
    record.lastCheckpoint = snapshot;
    this.#emit(record, "resumed", { restoredFrom: checkpointId, sequence: snapshot.ref.sequence });
  }
}
