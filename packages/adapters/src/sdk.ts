/**
 * ConnectorSDK — the framework base every connector implements (W3-003).
 *
 * W3-003 work order + CONNECTOR-PLATFORM ("Connector contract") +
 * LOSSLESS-CONNECTOR-CAPABILITY-MODEL:
 *
 * A connector is the productized boundary to an external provider. It exposes
 * a versioned Connector Capability Pack and supports the operation surface
 * search / read / create / update / action / subscribe / reconcile / health /
 * disconnect / credential rotation. Provider-specific SDKs stay INSIDE
 * connector implementations — they never leak into domain contracts
 * (AGENTS.md rule 17).
 *
 * The capability KINDS (SEARCH/READ/WRITE/ACTION/EVENT/HEALTH) are the
 * canonical @payswap/connectors vocabulary (W2-003) — CONSUMED here, never
 * redefined. SDK operations are METHOD names; `capabilityKindForSdkOperation`
 * documents the fixed mapping onto the canonical kinds, and the two lifecycle
 * operations (disconnect, credential_rotation) deliberately map to none.
 *
 * - INV-C04/INV-F06: every mutating operation runs behind
 *   `requireAuthority`, which demands a valid AdapterExecutionAuthority —
 *   execution-scoped, `canWriteFinancialState: false` — plus an idempotency
 *   key (INV-F05). An adapter can never write financial state through this
 *   framework.
 * - Health (`health()`) is checkable INDEPENDENTLY from PaySwap core: it is
 *   a read-only provider probe that never fabricates business outcomes.
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
import type { PaySwapErrorDetails, ProtocolClock, TimestampMs } from "@payswap/protocol";
import { validateConnectorCapabilityPack } from "@payswap/connectors";
import type {
  ConnectorCapabilityKind,
  ConnectorCapabilityPack,
  ProviderIdentity,
  ProviderStateEnvelope,
} from "@payswap/connectors";
import { validateAdapterExecutionAuthority } from "@payswap/execution";
import type {
  AdapterExecutionAuthority,
  ProviderExecutionEvidenceDraft,
  ProviderOutcomeClassification,
} from "@payswap/execution";
import { classifyProviderOutcome } from "@payswap/execution";

/** Raised when a connector SDK call violates the framework contract. */
export class ConnectorSdkError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "CONNECTOR_SDK_VIOLATION",
      category: "POLICY_BLOCKED",
      message,
      details,
    });
  }
}

// ---------------------------------------------------------------------------
// Operation surface (framework method names; kinds are W2-003 vocabulary)
// ---------------------------------------------------------------------------

/**
 * The connector operation surface (CONNECTOR-PLATFORM "Connector contract":
 * discover/authenticate/authorize are registry concerns; these are the SDK's
 * executable method families).
 */
export const CONNECTOR_SDK_OPERATIONS = [
  "search",
  "read",
  "create",
  "update",
  "action",
  "subscribe",
  "reconcile",
  "health",
  "disconnect",
  "credential_rotation",
] as const;

export type ConnectorSdkOperation = (typeof CONNECTOR_SDK_OPERATIONS)[number];

/**
 * The canonical capability kind an SDK operation maps onto. The kinds
 * themselves are owned by @payswap/connectors; `disconnect` and
 * `credential_rotation` are connector LIFECYCLE operations and deliberately
 * map to no capability kind.
 */
export function capabilityKindForSdkOperation(
  operation: ConnectorSdkOperation,
): ConnectorCapabilityKind | undefined {
  switch (operation) {
    case "search":
      return "SEARCH";
    case "read":
      return "READ";
    case "create":
    case "update":
      return "WRITE";
    case "action":
    case "reconcile":
      return "ACTION";
    case "subscribe":
      return "EVENT";
    case "health":
      return "HEALTH";
    case "disconnect":
    case "credential_rotation":
      return undefined;
  }
}

/** One operation-to-kind mapping entry (for `describeOperations`). */
export interface SdkOperationDescriptor {
  readonly operation: ConnectorSdkOperation;
  readonly canonicalKind: ConnectorCapabilityKind | undefined;
  readonly lifecycleOperation: boolean;
}

// ---------------------------------------------------------------------------
// Call contract
// ---------------------------------------------------------------------------

/** The context every SDK call carries: adapter authority + idempotency key. */
export interface SdkCallContext {
  /** INV-C04/INV-F06: execution-only authority — adapters never write financial state. */
  readonly authority: AdapterExecutionAuthority;
  /** INV-F05: every mutating call is idempotent by key. */
  readonly idempotencyKey: string;
  /** Opaque, provider-neutral request payload (never typed with provider SDKs). */
  readonly request: unknown;
}

/** The deterministic result of an SDK call. */
export interface SdkCallResult {
  /** The lossless provider state resulting from the call (INV-C06 — verbatim). */
  readonly providerState: ProviderStateEnvelope;
  /** Canonical outcome classification of that state (INV-X01 discipline). */
  readonly outcome: ProviderOutcomeClassification;
  /** Execution evidence draft for the caller's attempt ledger (INV-E02). */
  readonly evidence: ProviderExecutionEvidenceDraft;
}

/** The result of a credential rotation. Secrets never appear in contracts. */
export interface CredentialRotationResult {
  readonly rotatedAt: TimestampMs;
  /** Opaque reference to the newly issued credential (vault-resolved). */
  readonly newCredentialRef: string;
  readonly evidence: ProviderExecutionEvidenceDraft;
}

// ---------------------------------------------------------------------------
// Health (read-only, PaySwap-core independent, never a business outcome)
// ---------------------------------------------------------------------------

/** Connector health report — a provider-reachability projection ONLY. */
export interface ConnectorHealthReport {
  readonly connectorId: string;
  readonly providerName: string;
  readonly providerVersion: string;
  /** Consumed HealthStatus vocabulary (W2-003): HEALTHY/DEGRADED/UNHEALTHY/UNKNOWN. */
  readonly status: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
  readonly lastCheckedAt: string;
  /** Per-capability-instance health signals backing the aggregate. */
  readonly capabilityStatuses: readonly {
    readonly instanceId: string;
    readonly health: {
      readonly status: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
      readonly lastCheckedAt: string;
    };
  }[];
  readonly degradedReasons: readonly string[];
}

// ---------------------------------------------------------------------------
// The framework base
// ---------------------------------------------------------------------------

export interface ConnectorSdkDeps {
  readonly clock: ProtocolClock;
}

/**
 * The Connector SDK framework base. A connector implements its provider
 * behavior behind these methods; provider SDKs, API names and quirks stay
 * inside the implementation and NEVER appear in this contract.
 */
export abstract class ConnectorSDK {
  readonly #clock: ProtocolClock;

  constructor(deps: ConnectorSdkDeps) {
    this.#clock = deps.clock;
  }

  /** The external provider this connector faces (any system kind). */
  abstract providerIdentity(): ProviderIdentity;

  /** The versioned Connector Capability Pack this connector exposes. */
  abstract capabilityPack(): ConnectorCapabilityPack;

  // -- capability operations --------------------------------------------------

  abstract search(ctx: SdkCallContext): Promise<SdkCallResult>;
  abstract read(ctx: SdkCallContext): Promise<SdkCallResult>;
  abstract create(ctx: SdkCallContext): Promise<SdkCallResult>;
  abstract update(ctx: SdkCallContext): Promise<SdkCallResult>;
  abstract executeAction(ctx: SdkCallContext): Promise<SdkCallResult>;
  abstract subscribe(ctx: SdkCallContext): Promise<SdkCallResult>;
  abstract reconcile(ctx: SdkCallContext): Promise<SdkCallResult>;
  abstract disconnect(ctx: SdkCallContext): Promise<SdkCallResult>;

  // -- lifecycle operations -----------------------------------------------------

  abstract rotateCredentials(ctx: SdkCallContext): Promise<CredentialRotationResult>;

  /**
   * Health probe — read-only, independent from PaySwap core state, and never
   * a business outcome: a connector can be UNHEALTHY while payments it
   * already submitted are still succeeding at the provider.
   */
  abstract health(): Promise<ConnectorHealthReport>;

  // -- framework gates ----------------------------------------------------------

  /**
   * INV-C04/INV-F06: framework gate for every mutating operation. Validates
   * the adapter execution authority (execution-only; financial write
   * authority is rejected outright) and the idempotency key (INV-F05).
   */
  protected requireAuthority(
    ctx: SdkCallContext,
    operation: ConnectorSdkOperation,
  ): void {
    if (ctx === null || typeof ctx !== "object") {
      throw new ConnectorSdkError(
        `operation '${operation}' requires a call context with an AdapterExecutionAuthority`,
      );
    }
    try {
      validateAdapterExecutionAuthority(ctx.authority);
    } catch (error) {
      throw new ConnectorSdkError(
        `operation '${operation}' requires a valid AdapterExecutionAuthority (adapters never hold financial write authority — INV-C04/INV-F06)`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (typeof ctx.idempotencyKey !== "string" || ctx.idempotencyKey.length === 0) {
      throw new ConnectorSdkError(
        `operation '${operation}' requires an idempotency key (INV-F05)`,
      );
    }
  }

  /** Deterministic clock reading for implementations. */
  protected now(): TimestampMs {
    return this.#clock.now();
  }

  /** The operation surface this framework exposes, mapped to canonical kinds. */
  describeOperations(): readonly SdkOperationDescriptor[] {
    return Object.freeze(
      CONNECTOR_SDK_OPERATIONS.map((operation) =>
        Object.freeze({
          operation,
          canonicalKind: capabilityKindForSdkOperation(operation),
          lifecycleOperation:
            operation === "disconnect" || operation === "credential_rotation",
        }),
      ),
    );
  }

  /** Validates the connector's declared capability pack (certification-style check). */
  validateCapabilityPack(): ConnectorCapabilityPack {
    return validateConnectorCapabilityPack(this.capabilityPack());
  }
}

/**
 * Convenience helper: classify a provider state outcome with the canonical
 * INV-X01 discipline (UNKNOWN never becomes FAILED). Consumed from
 * @payswap/execution so connector implementations share one classifier.
 */
export function classifyOutcome(
  providerState: ProviderStateEnvelope,
): ProviderOutcomeClassification {
  return classifyProviderOutcome(providerState);
}

/** Structural validation of an SDK call context from untyped sources. */
export function validateSdkCallContext(
  candidate: unknown,
): SdkCallContext {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("SDK call context must be an object");
  }
  const ctx = candidate as Partial<SdkCallContext>;
  if (ctx.authority === undefined || ctx.authority === null) {
    throw new ConnectorSdkError("SDK call context requires an AdapterExecutionAuthority");
  }
  validateAdapterExecutionAuthority(ctx.authority);
  if (typeof ctx.idempotencyKey !== "string" || ctx.idempotencyKey.length === 0) {
    throw new ConnectorSdkError("SDK call context requires an idempotency key (INV-F05)");
  }
  return candidate as SdkCallContext;
}
