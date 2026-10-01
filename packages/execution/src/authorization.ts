/**
 * Protocol-issued scoped execution grants (W3-003).
 *
 * FROZEN-ARCHITECTURE §4/§20 + INTEGRATIONS.md ("Only the Financial Protocol
 * Authority issues an execution grant"):
 *
 * A ScopedExecutionGrant is issued ONLY against a protocol command envelope
 * carrying authorization evidence (INV-E01). It narrows what may be executed:
 * the connected capability instances, the explicit execution modes (INV-C07)
 * and an optional exact amount ceiling. It never widens anything and it never
 * declares financial finality.
 *
 * - INV-C04 / INV-F06: adapters NEVER receive financial write authority. The
 *   attenuated `AdapterExecutionAuthority` carries the literal
 *   `canWriteFinancialState: false` — it is structurally incapable of
 *   representing a ledger/journal mutation right, and a runtime validator
 *   rejects any value claiming otherwise.
 * - INV-A03: approval artifacts identify principal, agent, scope, expiry and
 *   request hash; a grant issued from an approval cannot outlive or diverge
 *   from that artifact.
 * - INV-A02-adjacent: verification is fail-closed — unknown, expired,
 *   request-hash-mismatched or out-of-scope grants never vouch for anything.
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
import type {
  CommandEnvelope,
  PaySwapErrorDetails,
  PrincipalRef,
  TimestampMs,
} from "@payswap/protocol";
import { isExecutionMode } from "@payswap/connectors";
import type { ExecutionMode } from "@payswap/connectors";

declare const ExecutionGrantIdBrand: unique symbol;
declare const ApprovalArtifactIdBrand: unique symbol;

/** Branded id of one scoped execution grant. */
export type ExecutionGrantId = string & {
  readonly [ExecutionGrantIdBrand]: "ExecutionGrantId";
};

/** Branded id of one signed approval artifact. */
export type ApprovalArtifactId = string & {
  readonly [ApprovalArtifactIdBrand]: "ApprovalArtifactId";
};

/** Raised when a scoped execution grant is rejected (issue or verify). */
export class ExecutionAuthorizationError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "EXECUTION_GRANT_REJECTED",
      category: "AUTHORIZATION_REQUIRED",
      message,
      details,
    });
  }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * The narrowing a grant authorizes: which connected capability instances, in
 * which explicit execution modes, under which optional exact amount ceiling.
 * Absent dimensions mean "no authority at all" here — a grant MUST name at
 * least one instance and one mode (fail closed, never wildcard).
 */
export interface ExecutionGrantScope {
  readonly capabilityInstanceIds: readonly string[];
  readonly executionModes: readonly ExecutionMode[];
  readonly amountCeiling?: {
    readonly currency: string;
    readonly value: bigint;
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateScope(scope: ExecutionGrantScope): void {
  if (scope === null || typeof scope !== "object") {
    throw new ValidationError("grant scope must be an ExecutionGrantScope");
  }
  if (
    !Array.isArray(scope.capabilityInstanceIds) ||
    scope.capabilityInstanceIds.length === 0 ||
    !scope.capabilityInstanceIds.every(isNonEmptyString)
  ) {
    throw new ValidationError(
      "grant scope must name at least one ConnectedCapabilityInstance (execution is scoped to real instances — INV-C05)",
    );
  }
  if (
    !Array.isArray(scope.executionModes) ||
    scope.executionModes.length === 0 ||
    !scope.executionModes.every(isExecutionMode)
  ) {
    throw new ValidationError(
      "grant scope must declare at least one explicit execution mode (INV-C07)",
    );
  }
  const ceiling = scope.amountCeiling;
  if (ceiling !== undefined) {
    if (
      ceiling === null ||
      typeof ceiling !== "object" ||
      !isNonEmptyString(ceiling.currency) ||
      typeof ceiling.value !== "bigint" ||
      ceiling.value <= 0n
    ) {
      throw new ValidationError(
        "grant scope amountCeiling must be exact positive money (INV-F01)",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Approval artifacts (INV-A03)
// ---------------------------------------------------------------------------

/**
 * A signed approval artifact backing a grant issued through an approved flow.
 * INV-A03: identifies principal, agent, scope, expiry and request hash.
 */
export interface GrantApprovalArtifact {
  readonly artifactId: ApprovalArtifactId;
  /** The approving principal (the human/tenant authority). */
  readonly principal: PrincipalRef;
  /** The delegated agent acting under the approval (equals principal when not delegated). */
  readonly agent: PrincipalRef;
  /** The scope the approval covers — the grant may only narrow it further. */
  readonly scope: ExecutionGrantScope;
  /** INV-A03: expiry. */
  readonly expiresAt: TimestampMs;
  /** INV-A03: request hash — the exact request the approver saw. */
  readonly requestHash: string;
  /** Reference to the trusted-surface signature backing this artifact. */
  readonly signatureRef: string;
}

/** Validate an approval artifact arriving from an untyped source (INV-A03 completeness). */
export function validateGrantApprovalArtifact(
  candidate: unknown,
): GrantApprovalArtifact {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("approval artifact must be an object");
  }
  const artifact = candidate as GrantApprovalArtifact;
  if (!isNonEmptyString(artifact.artifactId)) {
    throw new ValidationError("approval artifact must carry an artifactId");
  }
  if (
    artifact.principal === null ||
    typeof artifact.principal !== "object" ||
    !isNonEmptyString(artifact.principal.principalType) ||
    !isNonEmptyString(artifact.principal.principalId) ||
    artifact.agent === null ||
    typeof artifact.agent !== "object" ||
    !isNonEmptyString(artifact.agent.principalType) ||
    !isNonEmptyString(artifact.agent.principalId)
  ) {
    throw new ValidationError(
      "approval artifact must identify BOTH principal and agent (INV-A03)",
    );
  }
  validateScope(artifact.scope);
  if (typeof artifact.expiresAt !== "bigint" || artifact.expiresAt <= 0n) {
    throw new ValidationError("approval artifact must carry an expiry (INV-A03)");
  }
  if (!isNonEmptyString(artifact.requestHash)) {
    throw new ValidationError(
      "approval artifact must carry the request hash of the approved request (INV-A03)",
    );
  }
  if (!isNonEmptyString(artifact.signatureRef)) {
    throw new ValidationError("approval artifact must reference its signature");
  }
  return artifact;
}

// ---------------------------------------------------------------------------
// The grant
// ---------------------------------------------------------------------------

/** A scoped, short-lived execution credential issued against a protocol command. */
export interface ScopedExecutionGrant {
  readonly grantId: ExecutionGrantId;
  /** The protocol-authorized command under whose authority this grant exists. */
  readonly command: CommandEnvelope<unknown>;
  readonly principal: PrincipalRef;
  readonly scope: ExecutionGrantScope;
  readonly issuedAt: TimestampMs;
  readonly expiresAt: TimestampMs;
  /** Hash of the request the grant covers — execution must match it exactly. */
  readonly requestHash: string;
  /** Present iff the grant was issued from an approved flow (INV-A03). */
  readonly approvalArtifact?: GrantApprovalArtifact;
  /** Authorization evidence lineage (INV-E01). */
  readonly authorizationEvidenceRef: string;
}

// ---------------------------------------------------------------------------
// Adapter attenuation (INV-C04 / INV-F06)
// ---------------------------------------------------------------------------

/**
 * The ONLY authority an adapter may ever hold: execution-scoped, derived from
 * a scoped execution grant, and structurally incapable of financial writes —
 * `canWriteFinancialState` is the literal `false`.
 */
export interface AdapterExecutionAuthority {
  readonly authorityKind: "ADAPTER_EXECUTION_ONLY";
  readonly canWriteFinancialState: false;
  readonly grant: ScopedExecutionGrant;
}

/**
 * Marker for the financial write authority that ONLY the Financial Protocol
 * Authority holds. It is deliberately NOT constructible from anything this
 * package exports: an AdapterExecutionAuthority can never be assigned to it.
 */
export interface FinancialProtocolWriteAuthority {
  readonly canWriteFinancialState: true;
  readonly protocolCommandRef: string;
}

/**
 * Runtime guard for adapter authorities from untyped sources (INV-C04/INV-F06):
 * any value claiming financial write authority is rejected outright.
 */
export function validateAdapterExecutionAuthority(
  candidate: unknown,
): AdapterExecutionAuthority {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("adapter execution authority must be an object");
  }
  const authority = candidate as Partial<AdapterExecutionAuthority>;
  if (authority.authorityKind !== "ADAPTER_EXECUTION_ONLY") {
    throw new ExecutionAuthorizationError(
      "adapter authorities are execution-only (INV-C04): authorityKind must be ADAPTER_EXECUTION_ONLY",
    );
  }
  if (authority.canWriteFinancialState !== false) {
    throw new ExecutionAuthorizationError(
      "INV-C04/INV-F06: an adapter can NEVER hold financial write authority",
      { canWriteFinancialState: String(authority.canWriteFinancialState) },
    );
  }
  if (authority.grant === null || typeof authority.grant !== "object") {
    throw new ValidationError("adapter execution authority must carry its grant");
  }
  return candidate as AdapterExecutionAuthority;
}

// ---------------------------------------------------------------------------
// The grant authority
// ---------------------------------------------------------------------------

export interface IssueExecutionGrantInput {
  /** The protocol command whose authorization backs this grant. */
  readonly command: CommandEnvelope<unknown>;
  readonly scope: ExecutionGrantScope;
  /** Hash binding the grant to one exact execution request. */
  readonly requestHash: string;
  readonly expiresAt: TimestampMs;
  /** INV-E01: authorization evidence backing the command. */
  readonly authorizationEvidenceRef: string;
  /** Present iff issued from an approved NEEDS_APPROVAL-style flow (INV-A03). */
  readonly approvalArtifact?: GrantApprovalArtifact;
  /** Explicit grant id (deterministic callers supply their own). */
  readonly grantId: string;
}

export type ExecutionGrantVerification =
  | { readonly ok: true; readonly grant: ScopedExecutionGrant }
  | {
      readonly ok: false;
      readonly reason:
        | "UNKNOWN_GRANT"
        | "EXPIRED"
        | "REQUEST_HASH_MISMATCH"
        | "INSTANCE_NOT_IN_SCOPE"
        | "MODE_NOT_IN_SCOPE"
        | "NOT_ADAPTER_ATTENUATED";
      readonly message: string;
    };

export interface VerifyExecutionGrantInput {
  readonly now: TimestampMs;
  readonly requestHash?: string;
  readonly capabilityInstanceId?: string;
  readonly executionMode?: ExecutionMode;
}

function samePrincipal(
  left: PrincipalRef,
  right: PrincipalRef,
): boolean {
  return (
    left.principalType === right.principalType &&
    left.principalId === right.principalId
  );
}

function validateCommandEnvelope(
  command: CommandEnvelope<unknown>,
): void {
  if (command === null || typeof command !== "object") {
    throw new ValidationError("grant must be issued against a protocol command envelope");
  }
  if (
    !isNonEmptyString(command.id) ||
    !isNonEmptyString(command.commandType) ||
    command.principalRef === null ||
    typeof command.principalRef !== "object" ||
    !isNonEmptyString(command.principalRef.principalType) ||
    !isNonEmptyString(command.principalRef.principalId) ||
    !isNonEmptyString(command.idempotencyKey) ||
    typeof command.issuedAt !== "bigint" ||
    typeof command.schemaVersion !== "number"
  ) {
    throw new ValidationError(
      "grant must be issued against a complete protocol CommandEnvelope (id, commandType, principalRef, idempotencyKey, issuedAt, schemaVersion)",
    );
  }
}

/**
 * The execution grant authority: issues scoped execution grants against
 * protocol command envelopes and verifies them fail-closed. Deterministic —
 * every time question is answered `at` an explicitly supplied instant, never
 * against an ambient clock.
 */
export class ExecutionGrantAuthority {
  readonly #grants = new Map<string, ScopedExecutionGrant>();

  /** Issue a scoped execution grant (protocol-issued authority; fail-closed validation). */
  issue(input: IssueExecutionGrantInput): ScopedExecutionGrant {
    if (input === null || typeof input !== "object") {
      throw new ValidationError("grant issue input must be an object");
    }
    if (!isNonEmptyString(input.grantId)) {
      throw new ValidationError("grantId must be a non-empty string");
    }
    if (this.#grants.has(input.grantId)) {
      throw new ExecutionAuthorizationError(
        `execution grant '${input.grantId}' already exists`,
      );
    }
    validateCommandEnvelope(input.command);
    validateScope(input.scope);
    if (!isNonEmptyString(input.requestHash)) {
      throw new ValidationError(
        "requestHash is required: a grant is bound to one exact execution request",
      );
    }
    if (!isNonEmptyString(input.authorizationEvidenceRef)) {
      throw new ValidationError(
        "authorizationEvidenceRef is required on every execution grant (INV-E01)",
      );
    }
    if (typeof input.expiresAt !== "bigint" || input.expiresAt <= input.command.issuedAt) {
      throw new ValidationError(
        "an execution grant must expire strictly after the protocol command that issued it",
      );
    }

    let approvalArtifact: GrantApprovalArtifact | undefined;
    if (input.approvalArtifact !== undefined) {
      const artifact = validateGrantApprovalArtifact(input.approvalArtifact);
      if (artifact.requestHash !== input.requestHash) {
        throw new ExecutionAuthorizationError(
          "approval artifact request hash does not match the grant request: the grant is not bound to what was approved (INV-A03)",
          {
            artifactRequestHash: artifact.requestHash,
            grantRequestHash: input.requestHash,
          },
        );
      }
      if (input.expiresAt > artifact.expiresAt) {
        throw new ExecutionAuthorizationError(
          "an execution grant issued from an approval cannot outlive its approval artifact (INV-A03)",
          { grantExpiresAt: input.expiresAt.toString(), artifactExpiresAt: artifact.expiresAt.toString() },
        );
      }
      const commanded = samePrincipal(input.command.principalRef, artifact.principal) ||
        samePrincipal(input.command.principalRef, artifact.agent);
      if (!commanded) {
        throw new ExecutionAuthorizationError(
          "the protocol command principal must be a party to the approval artifact (approving principal or delegated agent — INV-A03)",
          {
            commandPrincipal: input.command.principalRef.principalId,
            approvingPrincipal: artifact.principal.principalId,
            agent: artifact.agent.principalId,
          },
        );
      }
      approvalArtifact = artifact;
    }

    const grant: ScopedExecutionGrant = Object.freeze({
      grantId: input.grantId as ExecutionGrantId,
      command: input.command,
      principal: Object.freeze({ ...input.command.principalRef }),
      scope: Object.freeze({
        capabilityInstanceIds: Object.freeze([...input.scope.capabilityInstanceIds]),
        executionModes: Object.freeze([...input.scope.executionModes]),
        ...(input.scope.amountCeiling !== undefined
          ? { amountCeiling: Object.freeze({ ...input.scope.amountCeiling }) }
          : {}),
      }),
      issuedAt: input.command.issuedAt,
      expiresAt: input.expiresAt,
      requestHash: input.requestHash,
      ...(approvalArtifact !== undefined ? { approvalArtifact } : {}),
      authorizationEvidenceRef: input.authorizationEvidenceRef,
    });
    this.#grants.set(grant.grantId, grant);
    return grant;
  }

  /** The grant with this id, when issued by this authority. */
  lookup(grantId: string): ScopedExecutionGrant | undefined {
    return this.#grants.get(grantId);
  }

  /**
   * Fail-closed verification at an explicitly supplied instant. Every
   * dimension supplied is checked; anything unknown, expired, unbound or
   * out of scope refuses to vouch for execution.
   */
  verify(
    grantId: string,
    input: VerifyExecutionGrantInput,
  ): ExecutionGrantVerification {
    const grant = this.#grants.get(grantId);
    if (grant === undefined) {
      return {
        ok: false,
        reason: "UNKNOWN_GRANT",
        message: `execution grant '${grantId}' was never issued by this authority: unresolvable references never vouch for authority`,
      };
    }
    if (input.now >= grant.expiresAt) {
      return {
        ok: false,
        reason: "EXPIRED",
        message: `execution grant '${grantId}' expired: expired grants fail closed everywhere`,
      };
    }
    if (input.requestHash !== undefined && input.requestHash !== grant.requestHash) {
      return {
        ok: false,
        reason: "REQUEST_HASH_MISMATCH",
        message: `execution grant '${grantId}' is bound to a different request hash`,
      };
    }
    if (
      input.capabilityInstanceId !== undefined &&
      !grant.scope.capabilityInstanceIds.includes(input.capabilityInstanceId)
    ) {
      return {
        ok: false,
        reason: "INSTANCE_NOT_IN_SCOPE",
        message: `execution grant '${grantId}' does not authorize connected capability instance '${input.capabilityInstanceId}'`,
      };
    }
    if (
      input.executionMode !== undefined &&
      !grant.scope.executionModes.includes(input.executionMode)
    ) {
      return {
        ok: false,
        reason: "MODE_NOT_IN_SCOPE",
        message: `execution grant '${grantId}' does not authorize execution mode '${input.executionMode}' (INV-C07)`,
      };
    }
    return { ok: true, grant };
  }

  /**
   * Attenuate a grant into the execution-only authority an adapter may hold
   * (INV-C04/INV-F06): fail-closed on verification, and the returned
   * authority carries `canWriteFinancialState: false` as a literal — adapters
   * NEVER get financial write authority.
   */
  attenuateForAdapter(
    grantId: string,
    now: TimestampMs,
  ): AdapterExecutionAuthority {
    const verification = this.verify(grantId, { now });
    if (!verification.ok) {
      throw new ExecutionAuthorizationError(
        `cannot attenuate '${grantId}' for adapter use: ${verification.message}`,
        { reason: verification.reason },
      );
    }
    return validateAdapterExecutionAuthority({
      authorityKind: "ADAPTER_EXECUTION_ONLY",
      canWriteFinancialState: false,
      grant: verification.grant,
    });
  }
}
