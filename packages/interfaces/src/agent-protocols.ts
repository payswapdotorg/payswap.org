/**
 * Agent protocol boundary contracts: MCP (agent → capability/tool), A2A
 * (agent ↔ agent) and AG-UI (agent ↔ application), per FROZEN-ARCHITECTURE
 * §20 ("these standards are edge adapters, not domain authority").
 *
 * Rules encoded here:
 * - Tools wrap protocol command REFERENCES (CommandRef) and CANNOT mint
 *   authority: `requiredAuthority` declares authority that must already have
 *   been granted (via an ApprovalArtifact) before the runtime will execute
 *   the underlying command. An LLM/agent never receives an unrestricted
 *   money-movement tool (INV-A04); agent proposals never mutate financial
 *   truth (INV-G03).
 * - All three contracts are explicitly versioned (schemaVersion).
 * - Commands enter this package ONLY as opaque CommandRef placeholders.
 *
 * Provenance of external specifications (public docs, surveyed 2026-09-30;
 * PaySwap adapts provider-neutral subsets, adding explicit versioning and
 * authority fields required by PaySwap):
 * - Model Context Protocol (MCP): tool descriptors (name, description,
 *   input/output JSON schemas).
 * - A2A (Agent2Agent): agent cards and multi-part messages.
 * - AG-UI: agent ↔ application event stream events (run lifecycle, text
 *   message deltas, tool calls, state snapshots).
 */

import type { AuthorityScope } from './approval.js';

/**
 * Opaque reference to a protocol command.
 *
 * CONSOLIDATION CANDIDATE: align with @payswap/protocol (W3-002).
 */
export interface CommandRef {
  readonly commandType: string;
  readonly commandId: string;
}

/** Reference from a tool/skill to the protocol capability it wraps. */
export interface CapabilityRef {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  /** The protocol command this capability binds to; opaque here. */
  readonly command: CommandRef;
}

/** JSON Schema (draft-agnostic, read-only keyword map). */
export interface JsonSchema {
  readonly [keyword: string]: unknown;
}

/**
 * MCP tool descriptor.
 *
 * A tool is a VIEW over a protocol command reference: it describes how to
 * invoke a capability, and declares the authority required to do so. Tools
 * cannot mint authority — executing the wrapped command still requires an
 * authorization-decision reference through the RuntimeAdapter
 * (see runtime-adapter.ts; INV-A04, INV-F06).
 */
export interface McpToolDescriptor {
  readonly schemaVersion: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  /** The protocol capability this tool wraps (command reference, not authority). */
  readonly capabilityRef: CapabilityRef;
  /** Authority that must already be granted before this tool's command may execute. */
  readonly requiredAuthority: AuthorityScope;
}

/** A versioned list of MCP tool descriptors served to an agent runtime. */
export interface McpToolList {
  readonly schemaVersion: string;
  readonly tools: readonly McpToolDescriptor[];
}

/** A2A message parts (text, structured data, or an opaque command reference). */
export type A2APart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'data'; readonly data: Readonly<Record<string, unknown>> }
  | { readonly kind: 'command-ref'; readonly commandRef: CommandRef };

/** A2A message (agent ↔ agent), versioned. */
export interface A2AMessage {
  readonly schemaVersion: string;
  readonly messageId: string;
  readonly role: 'AGENT' | 'USER';
  readonly sentAt: string;
  readonly parts: readonly A2APart[];
}

/** A skill an A2A agent can perform, bound to a capability and authority. */
export interface A2ASkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilityRef?: CapabilityRef;
  /** Required pre-granted authority for this skill (never minted by the card). */
  readonly requiredAuthority: AuthorityScope;
}

/**
 * A2A agent card: what an agent is, where it lives, what it may do.
 * `defaultScopes` declare pre-granted authority envelopes; a card can never
 * grant authority beyond what the referenced principal/mandates already hold
 * (INV-A01: child authority is always attenuated).
 */
export interface A2AAgentCard {
  readonly schemaVersion: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly cardVersion: string;
  /** The PaySwap principal this agent acts for. */
  readonly principalRef: string;
  readonly organizationRef?: string;
  readonly skills: readonly A2ASkill[];
  readonly capabilities: {
    readonly streaming: boolean;
    readonly pushNotifications: boolean;
  };
  readonly defaultScopes: readonly AuthorityScope[];
}

/**
 * AG-UI event stream events (agent ↔ application), PaySwap-adapted subset.
 *
 * NOTE: RUN_ERROR describes an agent-run error. It is distinct from payment
 * terminal states (§22): the UI must not render an agent-run error as a
 * payment failure, and vice versa (INV-X01 thinking applies).
 */
export type AgUiEvent =
  | { readonly type: 'RUN_STARTED'; readonly runId: string; readonly threadId: string }
  | { readonly type: 'TEXT_MESSAGE_START'; readonly messageId: string; readonly role: 'AGENT' | 'USER' }
  | { readonly type: 'TEXT_MESSAGE_CONTENT'; readonly messageId: string; readonly delta: string }
  | { readonly type: 'TEXT_MESSAGE_END'; readonly messageId: string }
  | { readonly type: 'TOOL_CALL_START'; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: 'TOOL_CALL_END'; readonly toolCallId: string }
  | { readonly type: 'STATE_SNAPSHOT'; readonly snapshot: Readonly<Record<string, unknown>> }
  | { readonly type: 'RUN_ERROR'; readonly runId: string; readonly message: string }
  | { readonly type: 'RUN_FINISHED'; readonly runId: string };

/** A versioned, timestamped AG-UI event. */
export interface VersionedAgUiEvent {
  readonly schemaVersion: string;
  readonly occurredAt: string;
  readonly event: AgUiEvent;
}
