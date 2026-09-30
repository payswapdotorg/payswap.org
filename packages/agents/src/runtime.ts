/**
 * Agent runtime contract (FROZEN-ARCHITECTURE §20).
 *
 * Typed signatures and event types only — NO implementation. Concrete
 * runtimes (W2-002) implement this interface; external protocols (MCP, A2A,
 * AG-UI, REST) are edge adapters to this contract and never domain authority.
 */

/** Every operation a conforming agent runtime must expose (§20). */
export const RUNTIME_OPERATIONS = [
  "createSession",
  "execute",
  "streamEvents",
  "approve",
  "requestTool",
  "checkpoint",
  "pause",
  "resume",
  "cancel",
  "inspect",
] as const;

export type RuntimeOperation = (typeof RUNTIME_OPERATIONS)[number];

export type AgentSessionState =
  | "ACTIVE"
  | "PAUSED"
  | "CANCELLED"
  | "COMPLETED"
  | "FAILED";

export interface SessionCreateRequest {
  readonly instanceId: string;
  readonly requestedCapabilities: readonly string[];
  readonly timeBudgetMs?: number;
}

export interface AgentSession {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly createdAt: number;
  readonly state: AgentSessionState;
}

export interface SessionCommand {
  readonly commandId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ExecutionOutcome {
  readonly commandId: string;
  readonly status: "COMPLETED" | "FAILED" | "REQUIRES_INPUT";
  readonly output?: Readonly<Record<string, unknown>>;
}

/**
 * A signed approval artifact as produced by the trusted approval surface.
 * Opaque here: the authoritative shape lives in @payswap/trust (W2-001) and
 * the trusted surface (W3-002); runtimes must never fabricate one.
 */
export type ApprovalArtifactRef = Readonly<Record<string, unknown>>;

export interface ApprovalSubmission {
  readonly approvalArtifact: ApprovalArtifactRef;
}

export interface ApprovalResult {
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface ToolRequest {
  readonly toolId: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
  readonly toolId: string;
  readonly status: "GRANTED" | "DENIED";
  readonly result?: Readonly<Record<string, unknown>>;
}

export interface CheckpointRef {
  readonly checkpointId: string;
  readonly sequence: number;
}

export interface SessionInspection {
  readonly session: AgentSession;
  readonly lastCheckpoint?: CheckpointRef;
  readonly pendingApprovals: readonly string[];
}

/** Event types emitted on the session event stream. */
export const AGENT_EVENT_TYPES = [
  "session_created",
  "execution_started",
  "execution_completed",
  "tool_requested",
  "approval_requested",
  "approval_recorded",
  "checkpointed",
  "paused",
  "resumed",
  "cancelled",
  "errored",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface AgentEvent {
  readonly type: AgentEventType;
  readonly sessionId: string;
  readonly occurredAt: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * The agent runtime contract: session create/execute/event-stream/approve/
 * tool-request/checkpoint/pause/resume/cancel/inspect (FROZEN §20).
 */
export interface AgentRuntimeContract {
  createSession(request: SessionCreateRequest): Promise<AgentSession>;
  execute(sessionId: string, command: SessionCommand): Promise<ExecutionOutcome>;
  streamEvents(sessionId: string): AsyncIterableIterator<AgentEvent>;
  approve(sessionId: string, submission: ApprovalSubmission): Promise<ApprovalResult>;
  requestTool(sessionId: string, request: ToolRequest): Promise<ToolResult>;
  checkpoint(sessionId: string): Promise<CheckpointRef>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  cancel(sessionId: string, reason: string): Promise<void>;
  inspect(sessionId: string): Promise<SessionInspection>;
}
