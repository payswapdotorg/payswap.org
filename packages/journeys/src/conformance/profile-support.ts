/**
 * @payswap/journeys — conformance profile support (P2-W2-003).
 *
 * Shared, deterministic helpers every provider profile uses: the fixed
 * conformance clock, the adapter execution authority for SDK calls (the
 * execution-only INV-C04/F06 surface), and the SDK call-context builder.
 * Nothing here contacts a network or fabricates provider behavior.
 */

import { asCommandId } from "@payswap/protocol";
import type { CommandEnvelope, ProtocolClock, TimestampMs } from "@payswap/protocol";
import { ExecutionGrantAuthority } from "@payswap/execution";
import type { AdapterExecutionAuthority } from "@payswap/execution";
import type { ConnectorSDK, SdkCallContext } from "@payswap/adapters";
import { CONFORMANCE_EPOCH } from "./model.js";

/** The fixed conformance clock — one instant, no drift. */
export const CONFORMANCE_CLOCK: ProtocolClock = {
  now(): TimestampMs {
    return CONFORMANCE_EPOCH;
  },
  monotonic(): bigint {
    return 0n;
  },
};

const CONFORMANCE_COMMAND: CommandEnvelope<unknown> = Object.freeze({
  id: asCommandId("cmd_conformance_1"),
  commandType: "execution.executePlan",
  payload: { planId: "plan_conformance_1" },
  principalRef: Object.freeze({
    principalType: "operator",
    principalId: "user_conformance_1",
  }),
  idempotencyKey: "idem-conformance-1",
  issuedAt: CONFORMANCE_EPOCH,
  schemaVersion: 1,
});

/**
 * The adapter execution authority every SDK probe runs under: execution-only
 * (adapters never hold financial write authority — INV-C04/INV-F06).
 */
export function conformanceAdapterAuthority(): AdapterExecutionAuthority {
  const grants = new ExecutionGrantAuthority();
  grants.issue({
    grantId: "grant_conformance_1",
    command: CONFORMANCE_COMMAND,
    scope: {
      capabilityInstanceIds: ["inst-conformance-1"],
      executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    },
    requestHash: "reqhash_conformance_1",
    expiresAt: CONFORMANCE_EPOCH + 3_600_000n,
    authorizationEvidenceRef: "evidence:conformance-auth-1",
  });
  return grants.attenuateForAdapter("grant_conformance_1", CONFORMANCE_EPOCH + 1n);
}

/** The SDK call context for one conformance probe (INV-F05 idempotency key). */
export function sdkCtx(
  request: unknown,
  idempotencyKey = "idem-conformance-sdk-1",
): SdkCallContext {
  return { authority: conformanceAdapterAuthority(), idempotencyKey, request };
}

/** Invokes a connector SDK method by name with a call context. */
export function invokeSdk(
  connector: ConnectorSDK,
  method: "create" | "update" | "executeAction" | "read",
  ctx: SdkCallContext,
): Promise<unknown> {
  switch (method) {
    case "create":
      return connector.create(ctx);
    case "update":
      return connector.update(ctx);
    case "executeAction":
      return connector.executeAction(ctx);
    case "read":
      return connector.read(ctx);
  }
}

/** Extracts (outcome, requiresReconciliation) from an SdkCallResult-shaped value. */
export function sdkOutcomeOf(
  result: unknown,
): { readonly outcome?: string; readonly requiresReconciliation?: boolean } {
  if (result === null || typeof result !== "object") {
    return {};
  }
  const outcome = (result as { readonly outcome?: { readonly outcome?: unknown; readonly requiresReconciliation?: unknown } }).outcome;
  if (outcome === null || typeof outcome !== "object") {
    return {};
  }
  return {
    ...(typeof outcome.outcome === "string" ? { outcome: outcome.outcome } : {}),
    ...(typeof outcome.requiresReconciliation === "boolean"
      ? { requiresReconciliation: outcome.requiresReconciliation }
      : {}),
  };
}

/** Extracts the providerState envelope from an SdkCallResult-shaped value. */
export function sdkProviderStateOf(result: unknown): unknown {
  if (result === null || typeof result !== "object") {
    return undefined;
  }
  return (result as { readonly providerState?: unknown }).providerState;
}

/** The error class name of a thrown value. */
export function errorClassName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
