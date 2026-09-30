/**
 * Agent Proposal contracts (FROZEN-ARCHITECTURE §4 authority boundary, INV-G03).
 *
 * An AgentProposal is an ADVISORY input to a decision. It is structurally
 * distinct from a protocol command: it carries no idempotency key, no
 * authorization/authority field, no signature and no ledger/rail effect. An
 * agent proposal, plan or explanation is never the authority itself
 * (DOMAIN-MODEL: Authority boundary; AGENTS.md rule 5).
 */

export type ProposalType =
  | "money_movement"
  | "strategy"
  | "work_action"
  | "informational";

/**
 * A proposal from one agent instance. `payload` is opaque, advisory data.
 * It MUST NOT contain protocol-command fields (see assertNotProtocolCommand).
 */
export interface AgentProposal {
  readonly proposalId: string;
  readonly proposingInstance: string;
  readonly proposalType: ProposalType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly rationale?: string;
  readonly evidenceRefs: readonly string[];
  readonly expiresAt: number;
}

/**
 * Fields that mark a value as a protocol command or an authority artifact.
 * A proposal carrying any of these — at any nesting depth — is rejected.
 */
export const PROTOCOL_COMMAND_MARKER_FIELDS = [
  "idempotencyKey",
  "commandType",
  "commandId",
  "authorization",
  "authority",
  "authorityEnvelope",
  "mandate",
  "mandateRef",
  "permissionGrant",
  "permissionGrantRef",
  "signature",
  "approvals",
] as const;

/** Raised when a value carries protocol-command / authority shape (INV-G03). */
export class ProtocolCommandShapeError extends Error {
  constructor(path: string, field: string) {
    super(
      `Value at '${path}' carries protocol command field '${field}': agent proposals are advisory and must not carry command or authority shape`,
    );
    this.name = "ProtocolCommandShapeError";
  }
}

function scanForCommandFields(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  const record = value as Readonly<Record<string, unknown>>;
  for (const field of PROTOCOL_COMMAND_MARKER_FIELDS) {
    if (field in record) {
      throw new ProtocolCommandShapeError(path, field);
    }
  }
  for (const key of Object.keys(record)) {
    scanForCommandFields(record[key], path === "" ? key : `${path}.${key}`, seen);
  }
}

/**
 * Guard (INV-G03): assert that a value does not carry protocol-command or
 * authority shape, at any nesting depth. Agent proposals pass; protocol
 * commands and authority artifacts do not.
 */
export function assertNotProtocolCommand(candidate: unknown): void {
  scanForCommandFields(candidate, "$", new Set());
}

/**
 * Construct a validated AgentProposal. The payload and the proposal itself
 * are checked against protocol-command shape; a proposal is advisory only.
 */
export function makeProposal(
  proposal: AgentProposal,
): AgentProposal {
  if (proposal.proposalId.length === 0) {
    throw new ProtocolCommandShapeError("$", "proposalId must not be empty");
  }
  if (proposal.proposingInstance.length === 0) {
    throw new ProtocolCommandShapeError("$", "proposingInstance must not be empty");
  }
  assertNotProtocolCommand(proposal.payload);
  assertNotProtocolCommand(proposal);
  return proposal;
}
