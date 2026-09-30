/**
 * Runtime adapter contract: the only path from proposals to protocol-authorized
 * execution (FROZEN-ARCHITECTURE §20 agent runtime contract; §4 authority
 * boundaries).
 *
 * Rules encoded:
 * - submitProposal accepts PROPOSALS ONLY: agents, RL, optimization and human
 *   experts propose actions; they cannot declare financial finality
 *   (AGENTS.md rule 5, INV-G03). A proposal wraps an opaque CommandRef.
 * - requestApproval routes an ApprovalRequest through a trusted approval
 *   surface and returns a reference to the issued artifact (INV-A03).
 * - executeCommand REQUIRES an authorization-decision reference
 *   (AuthorizationDecisionRef) — a typed precondition. Execution without a
 *   decision reference is a contract violation (see
 *   validateCommandExecution and the conformance tests). No financial
 *   mutation bypasses the Financial Protocol Authority (INV-F06), and an
 *   LLM never receives an unrestricted money-movement tool (INV-A04).
 * - Every execution carries an idempotency key (INV-F05) and resolves to a
 *   terminal state from §22 (via protocol-state.ts), optionally attaching a
 *   lossless ProviderStateEnvelope.
 */

import type { ApprovalArtifactRef, ApprovalRequest, AuthorityScope } from './approval.js';
import type { CommandRef } from './agent-protocols.js';
import type { TerminalState } from './protocol-state.js';
import type { ProviderStateEnvelope } from './psp-connector.js';

/**
 * An agent/user proposal: a request to execute a protocol command, with
 * justification, for evaluation by the protocol runtime. Proposals never
 * mutate financial truth directly (INV-G03).
 */
export interface Proposal {
  readonly proposalId: string;
  readonly principal: string;
  readonly agentRef?: string;
  /** Opaque command reference (CONSOLIDATION CANDIDATE: align with @payswap/protocol, W3-002). */
  readonly command: CommandRef;
  /** Canonical-JSON-encoded command arguments, when the command is parameterized. */
  readonly argumentsJson?: string;
  readonly justification?: string;
}

/** Acknowledgement that a proposal was received for evaluation. */
export interface ProposalReceipt {
  readonly proposalId: string;
  readonly status: 'RECEIVED';
  readonly command: CommandRef;
  readonly receivedAt: string;
}

/**
 * Reference to an authorization decision derived from an approval artifact.
 * Required by executeCommand as a typed precondition.
 */
export interface AuthorizationDecisionRef {
  readonly decisionId: string;
  /** Reference to the ApprovalArtifact backing this decision (INV-A03). */
  readonly approvalArtifactRef: ApprovalArtifactRef;
  /** The scope that was actually granted for this decision. */
  readonly scope: AuthorityScope;
  readonly decidedAt: string;
}

/**
 * A command execution request. `authorizationDecisionRef` is REQUIRED —
 * omitting it is a compile-time error and a runtime contract violation.
 */
export interface CommandExecution {
  readonly command: CommandRef;
  readonly authorizationDecisionRef: AuthorizationDecisionRef;
  /** INV-F05: one idempotency key maps to one authoritative command result. */
  readonly idempotencyKey: string;
  readonly argumentsJson?: string;
}

export type ExecutionValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly string[] };

/**
 * Runtime validation of a CommandExecution. Used by conformance tests to
 * prove that execution without an authorization-decision reference is a
 * contract violation.
 */
export function validateCommandExecution(execution: CommandExecution): ExecutionValidation {
  const violations: string[] = [];
  const command = execution?.command;
  if (command === undefined || command === null || typeof command.commandType !== 'string' || typeof command.commandId !== 'string') {
    violations.push('command (CommandRef) is required');
  }
  const decision = execution?.authorizationDecisionRef;
  if (decision === undefined || decision === null) {
    violations.push(
      'authorizationDecisionRef is REQUIRED: command execution requires an authorization decision derived from an approval artifact (INV-A03/INV-F06)',
    );
  } else {
    if (typeof decision.decisionId !== 'string' || decision.decisionId === '') {
      violations.push('authorizationDecisionRef.decisionId is required');
    }
    if (typeof decision.approvalArtifactRef !== 'string' || decision.approvalArtifactRef === '') {
      violations.push('authorizationDecisionRef.approvalArtifactRef is required');
    }
    if (decision.scope === undefined || decision.scope === null) {
      violations.push('authorizationDecisionRef.scope is required');
    }
  }
  if (typeof execution?.idempotencyKey !== 'string' || execution.idempotencyKey === '') {
    violations.push('idempotencyKey is required (INV-F05)');
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** Outcome of an authorized execution, expressed in §22 terminal states. */
export interface ExecutionOutcome {
  readonly executionId: string;
  readonly command: CommandRef;
  readonly terminalState: TerminalState;
  /** Lossless provider state attached to consequential external operations (INV-C06). */
  readonly providerState?: ProviderStateEnvelope;
  /** Reference to the reconciliation case when terminalState is UNKNOWN/WAITING. */
  readonly reconciliationRef?: string;
}

/**
 * The runtime adapter: proposals in, authorized executions out.
 * This is the ONLY contract through which a proposal becomes a
 * protocol-authorized external effect.
 */
export interface RuntimeAdapter {
  /** Proposals only — the runtime evaluates; proposers cannot declare finality. */
  submitProposal(proposal: Proposal): Promise<ProposalReceipt>;
  /** Routes an approval request through a trusted surface; returns an artifact reference. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalArtifactRef>;
  /** Executes a command REQUIRES an authorization-decision reference. */
  executeCommand(execution: CommandExecution): Promise<ExecutionOutcome>;
}
