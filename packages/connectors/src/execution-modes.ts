/**
 * Execution modes (W2-003, FROZEN-ARCHITECTURE §2A, ADR-006, INV-C07).
 *
 * Every connector execution carries an EXPLICIT mode:
 * - PASS_THROUGH_NATIVE      — preserve the provider's native execution/
 *   optimization flow with minimal translation;
 * - COMPOSED_PAYSWAP         — compose the provider capability with PaySwap
 *   capabilities (FX, liquidity, credit, incentives, other rails);
 * - OPTIMIZED_MULTI_PROVIDER — compare/orchestrate multiple reachable
 *   providers/capabilities.
 *
 * NONE of the modes bypasses protocol authorization, policy, compliance,
 * security, idempotency or evidence (INV-C07): every canonical execution
 * request must reference the protocol command that authorized it, and
 * `validateExecutionRequest` enforces both the explicit mode and that
 * authorization link. PASS_THROUGH_NATIVE is semantic preservation, not an
 * authority bypass.
 *
 * Provider-native optimization/recovery is represented AS a capability so it
 * can be benchmarked as an incumbent baseline (INV-C08) — see
 * ./definitions.js (`nativeOptimization`).
 */

import { ValidationError } from "@payswap/protocol";
import type { CommandId, PrincipalRef } from "@payswap/protocol";

export const EXECUTION_MODES = [
  "PASS_THROUGH_NATIVE",
  "COMPOSED_PAYSWAP",
  "OPTIMIZED_MULTI_PROVIDER",
] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return (
    typeof value === "string" &&
    (EXECUTION_MODES as readonly unknown[]).includes(value)
  );
}

/**
 * The protocol authorization backing a connector execution (INV-C07, INV-F06).
 * The referenced command is the protocol-authorized envelope under which the
 * external effect may happen; it carries its own principal and evidence.
 */
export interface ProtocolAuthorizationRef {
  readonly commandId: CommandId;
  readonly principal: PrincipalRef;
  readonly authorizationEvidenceRef: string;
}

/**
 * A canonical connector execution request (INV-C07).
 *
 * `executionMode` is REQUIRED on every execution, and so is the protocol
 * authorization reference: no mode — including PASS_THROUGH_NATIVE — can
 * bypass protocol authorization.
 */
export interface ConnectorExecutionRequest {
  readonly executionMode: ExecutionMode;
  readonly capabilityInstanceId: string;
  /** Opaque provider-native request payload (never typed with provider SDKs). */
  readonly providerRequest: unknown;
  readonly idempotencyKey: string;
  readonly protocolAuthorization: ProtocolAuthorizationRef;
}

export type ExecutionRequestValidation =
  | { readonly ok: true; readonly mode: ExecutionMode }
  | { readonly ok: false; readonly violations: readonly string[] };

/**
 * Validates that an execution request carries an explicit, valid mode AND
 * the protocol authorization link (INV-C07). Missing mode, missing instance
 * reference, missing idempotency key (INV-F05) and a missing protocol
 * authorization reference are all violations.
 */
export function validateExecutionRequest(
  request: unknown,
): ExecutionRequestValidation {
  const violations: string[] = [];
  const candidate = request as Partial<ConnectorExecutionRequest> | null;

  if (candidate === null || typeof candidate !== "object") {
    return {
      ok: false,
      violations: ["execution request must be an object"],
    };
  }

  if (!isExecutionMode(candidate.executionMode)) {
    violations.push(
      "executionMode is REQUIRED and must be explicit on every execution (INV-C07): PASS_THROUGH_NATIVE | COMPOSED_PAYSWAP | OPTIMIZED_MULTI_PROVIDER",
    );
  }
  if (
    typeof candidate.capabilityInstanceId !== "string" ||
    candidate.capabilityInstanceId === ""
  ) {
    violations.push(
      "capabilityInstanceId is required (must reference a ConnectedCapabilityInstance, never a provider catalogue entry — INV-C05)",
    );
  }
  if (typeof candidate.idempotencyKey !== "string" || candidate.idempotencyKey === "") {
    violations.push("idempotencyKey is required (INV-F05)");
  }
  const authorization = candidate.protocolAuthorization;
  if (
    authorization === null ||
    typeof authorization !== "object" ||
    typeof authorization.commandId !== "string" ||
    authorization.commandId === "" ||
    authorization.principal === null ||
    typeof authorization.principal !== "object" ||
    typeof authorization.principal.principalType !== "string" ||
    typeof authorization.principal.principalId !== "string" ||
    typeof authorization.authorizationEvidenceRef !== "string" ||
    authorization.authorizationEvidenceRef === ""
  ) {
    violations.push(
      "protocolAuthorization is required: no execution mode (including PASS_THROUGH_NATIVE) can bypass protocol authorization (INV-C07, INV-F06)",
    );
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return { ok: true, mode: (candidate as ConnectorExecutionRequest).executionMode };
}

/** Thrown when an execution is attempted without an explicit mode (INV-C07). */
export class ImplicitExecutionModeError extends ValidationError {
  constructor(violations: readonly string[]) {
    super(
      `Execution request is not valid: ${violations.join("; ")}`,
      { violations: [...violations] },
    );
  }
}

