/**
 * Shared deterministic fixtures for @payswap/rails tests. All shapes are
 * CONSUMED from the canonical packages (protocol kernel, W2-003 vocabulary,
 * W3-003 execution/adapters framework, W1-004 settlement plane). Nothing
 * here redefines vocabulary; nothing here contacts a network — the
 * deterministic suite MUST pass offline (network-dependent tests live in
 * test/live/**).
 */
import { DeterministicClock, asCommandId } from "@payswap/protocol";
import type { CommandEnvelope, ProtocolClock } from "@payswap/protocol";
import { ExecutionGrantAuthority } from "@payswap/execution";
import type { AdapterExecutionAuthority } from "@payswap/execution";
import type { HttpTransport, JsonRpcResponse, JsonRpcTransport } from "../src/support.js";

export const CLOCK: ProtocolClock = new DeterministicClock(1_765_000_000_000n);

export const PRINCIPAL = Object.freeze({
  principalType: "user",
  principalId: "user_1",
});

export const COMMAND: CommandEnvelope<unknown> = Object.freeze({
  id: asCommandId("cmd_rails_1"),
  commandType: "execution.executePlan",
  payload: { planId: "plan_rails_1" },
  principalRef: PRINCIPAL,
  idempotencyKey: "idem-rails-1",
  issuedAt: 1_765_000_000_000n,
  schemaVersion: 1,
});

/** An adapter execution authority (execution-only — INV-C04/F06), as in the adapters fixtures. */
export function makeAdapterAuthority(): AdapterExecutionAuthority {
  const grants = new ExecutionGrantAuthority();
  grants.issue({
    grantId: "grant_rails_1",
    command: COMMAND,
    scope: {
      capabilityInstanceIds: [
        "inst-rails-fiat-1",
        "inst-rails-momo-1",
        "inst-rails-eth-1",
        "inst-rails-fx-1",
      ],
      executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    },
    requestHash: "req_hash_rails_1",
    expiresAt: COMMAND.issuedAt + 3_600_000n,
    authorizationEvidenceRef: "evidence:auth-rails-1",
  });
  return grants.attenuateForAdapter("grant_rails_1", COMMAND.issuedAt + 1n);
}

/** A call context for SDK operations. */
export function ctx(
  authority: AdapterExecutionAuthority,
  request: unknown,
  idempotencyKey = "idem-sdk-1",
): { authority: AdapterExecutionAuthority; idempotencyKey: string; request: unknown } {
  return { authority, idempotencyKey, request };
}

// ---------------------------------------------------------------------------
// Deterministic transport fixtures (offline — NO network)
// ---------------------------------------------------------------------------

/** An HTTP transport scripted per-URL; records every call for assertions. */
export class ScriptedHttpTransport {
  readonly calls: { readonly url: string; readonly method: string; readonly body?: string }[] = [];

  constructor(
    private readonly respond: (
      url: string,
      init: { method: string; body?: string },
    ) => { status: number; bodyText: string } | Promise<{ status: number; bodyText: string }>,
  ) {}

  readonly transport: HttpTransport = async (url, init) => {
    this.calls.push({ url, method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) });
    return this.respond(url, init);
  };
}

/** A JSON-RPC transport scripted per-method; records every call. */
export class ScriptedJsonRpcTransport {
  readonly calls: { readonly method: string; readonly params: readonly unknown[] }[] = [];

  constructor(
    private readonly respond: (
      method: string,
      params: readonly unknown[],
    ) => JsonRpcResponse | Promise<JsonRpcResponse>,
  ) {}

  readonly transport: JsonRpcTransport = async (method, params) => {
    this.calls.push({ method, params });
    return this.respond(method, params);
  };
}

/** A JSON-RPC success response. */
export function rpcResult(id: number, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** A JSON-RPC null result (the honest "not found"). */
export function rpcNull(id: number): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: null };
}

/** A 0x-prefixed hex quantity for a bigint. */
export function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

// ---------------------------------------------------------------------------
// Shared literals
// ---------------------------------------------------------------------------

export const VITALIK_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as const;
export const TX_HASH =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
export const BLOCK_HASH_A =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
export const BLOCK_HASH_B =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
