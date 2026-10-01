/**
 * ExecutionPlan — the canonical execution graph (W3-003).
 *
 * FROZEN-ARCHITECTURE §2A / LOSSLESS-CONNECTOR-CAPABILITY-MODEL §4 /
 * CONNECTOR-PLATFORM / PSP-ADAPTER-NETWORK:
 *
 * A plan is the ordered set of connector capability steps chosen to realize an
 * economic intent. It CONSUMES the canonical connector capability vocabulary
 * owned by @payswap/connectors (W2-003): every step references a
 * CapabilityDefinition executed through a ConnectedCapabilityInstance — never a
 * provider catalogue entry (INV-C05, enforced via `assertConnectedInstance`).
 *
 * - INV-C07: `executionMode` is EXPLICIT on every plan — PASS_THROUGH_NATIVE |
 *   COMPOSED_PAYSWAP | OPTIMIZED_MULTI_PROVIDER — and no mode bypasses the
 *   protocol authorization + evidence boundary: `protocolAuthorization`
 *   (command + principal + evidence reference) is mandatory on EVERY plan,
 *   including PASS_THROUGH_NATIVE, which preserves the incumbent provider
 *   flow SEMANTICALLY (single provider step, native optimization preserved)
 *   while still traversing PaySwap's authorization and evidence boundary.
 * - The merchant settlement destination is EXPLICIT on every plan (an external
 *   MerchantSettlementDestination from @payswap/payment — never PaySwap
 *   custody).
 * - Payment-to-invoice/order/project remittance references are preserved on
 *   the plan so the translated execution can always answer "which business
 *   documents did this settle?".
 *
 * Types + deterministic validation only. No network, no provider SDKs, no
 * floating-point money (INV-F01).
 */

import { ValidationError } from "@payswap/protocol";
import { assertConnectedInstance, isExecutionMode } from "@payswap/connectors";
import type {
  CapabilityDefinition,
  CompensationDeclaration,
  ConnectedCapabilityInstance,
  ExecutionMode,
  PartialExecutionDeclaration,
  ProtocolAuthorizationRef,
} from "@payswap/connectors";
import type {
  MerchantSettlementDestination,
  RemittanceDocumentKind,
} from "@payswap/payment";

declare const ExecutionPlanIdBrand: unique symbol;

/** Branded id of one execution plan. */
export type ExecutionPlanId = string & {
  readonly [ExecutionPlanIdBrand]: "ExecutionPlanId";
};

/** Brand a validated string as an `ExecutionPlanId`. */
export function asExecutionPlanId(value: string): ExecutionPlanId {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("ExecutionPlanId must be a non-empty string");
  }
  if (value.length > 256) {
    throw new ValidationError("ExecutionPlanId exceeds 256 characters");
  }
  if (value.trim() !== value) {
    throw new ValidationError("ExecutionPlanId must not carry surrounding whitespace");
  }
  return value as ExecutionPlanId;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * One step of the execution graph: a CapabilityDefinition (W2-003 canonical
 * vocabulary — consumed, never redefined) executed through one specific
 * ConnectedCapabilityInstance (INV-C05: a provider catalogue claim can never
 * be a step).
 */
export interface ExecutionPlanStep {
  readonly stepId: string;
  /** Strictly 1..n — execution order is total and deterministic. */
  readonly order: number;
  /** Human-readable role, e.g. `collect`, `fx-convert`, `payout`. */
  readonly role: string;
  readonly capability: CapabilityDefinition;
  readonly instance: ConnectedCapabilityInstance;
  /** Opaque provider-neutral request payload (never typed with provider SDKs). */
  readonly providerRequest: unknown;
}

// ---------------------------------------------------------------------------
// Explicit execution mode detail (INV-C07)
// ---------------------------------------------------------------------------

/**
 * Mode-specific detail. `kind` MUST equal the plan's `executionMode`
 * (validated), so a plan can never claim one mode while describing another.
 */
export type ExecutionModeDetail =
  | {
      /**
       * PASS_THROUGH_NATIVE preserves the incumbent provider's native
       * execution/optimization flow semantically (LOSSLESS model §4) while
       * still traversing protocol authorization + evidence.
       */
      readonly kind: "PASS_THROUGH_NATIVE";
      readonly incumbentProviderName: string;
      readonly preservesNativeFlow: true;
    }
  | {
      readonly kind: "COMPOSED_PAYSWAP";
      /** PaySwap capabilities composed with the provider steps (FX, liquidity, credit, incentives, …). */
      readonly composedWith: readonly string[];
    }
  | {
      readonly kind: "OPTIMIZED_MULTI_PROVIDER";
      /** Providers compared/orchestrated by the strategy. */
      readonly comparedProviders: readonly string[];
    };

// ---------------------------------------------------------------------------
// Remittance preservation
// ---------------------------------------------------------------------------

/**
 * A payment-to-document remittance reference preserved on the plan (invoice,
 * order, project/milestone…). The document kinds are the canonical
 * @payswap/payment vocabulary (W1-003) — consumed, never redefined.
 */
export interface PlanRemittanceDocumentRef {
  readonly documentKind: RemittanceDocumentKind;
  readonly documentId: string;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** The canonical execution plan. */
export interface ExecutionPlan {
  readonly planId: ExecutionPlanId;
  /** EXPLICIT on every plan (INV-C07). */
  readonly executionMode: ExecutionMode;
  readonly modeDetail: ExecutionModeDetail;
  readonly steps: readonly ExecutionPlanStep[];
  /** EXPLICIT merchant settlement destination (external, never PaySwap custody). */
  readonly settlementDestination: MerchantSettlementDestination;
  readonly remittance: readonly PlanRemittanceDocumentRef[];
  /**
   * The protocol authorization backing the whole plan (INV-C07/INV-F06):
   * command + principal + authorization evidence reference. Required on
   * EVERY plan — PASS_THROUGH_NATIVE included.
   */
  readonly protocolAuthorization: ProtocolAuthorizationRef;
  /** Optional link to a scoped execution grant issued by this package's grant authority. */
  readonly executionGrantId?: string;
}

/** Input accepted by `defineExecutionPlan`. */
export interface ExecutionPlanInput {
  readonly planId: string;
  readonly executionMode: ExecutionMode;
  readonly modeDetail: ExecutionModeDetail;
  readonly steps: readonly ExecutionPlanStep[];
  readonly settlementDestination: MerchantSettlementDestination;
  readonly remittance?: readonly PlanRemittanceDocumentRef[];
  readonly protocolAuthorization: ProtocolAuthorizationRef;
  readonly executionGrantId?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateProtocolAuthorization(
  authorization: ProtocolAuthorizationRef,
): void {
  if (
    authorization === null ||
    typeof authorization !== "object" ||
    !isNonEmptyString(authorization.commandId) ||
    authorization.principal === null ||
    typeof authorization.principal !== "object" ||
    !isNonEmptyString(authorization.principal.principalType) ||
    !isNonEmptyString(authorization.principal.principalId) ||
    !isNonEmptyString(authorization.authorizationEvidenceRef)
  ) {
    throw new ValidationError(
      "protocolAuthorization is required on every execution plan: command, principal and authorization evidence reference (no execution mode — including PASS_THROUGH_NATIVE — can bypass protocol authorization; INV-C07, INV-F06)",
    );
  }
}

function validateSettlementDestination(
  destination: MerchantSettlementDestination,
): void {
  if (
    destination === null ||
    typeof destination !== "object" ||
    !isNonEmptyString(destination.id) ||
    !isNonEmptyString(destination.kind) ||
    !isNonEmptyString(destination.currency) ||
    !isNonEmptyString(destination.externalRef)
  ) {
    throw new ValidationError(
      "settlementDestination must be an explicit external MerchantSettlementDestination (the merchant settlement destination is explicit on every plan)",
    );
  }
}

/**
 * Construct a validated, frozen execution plan.
 *
 * Enforces (in order):
 * - INV-C07: explicit, valid execution mode + mode detail consistency;
 * - INV-C05: every step's instance is a genuinely ConnectedCapabilityInstance
 *   (catalogue entries are rejected with `ConnectorAuthorityError`),
 *   authorized (ACTIVE), eligible, with no missing permissions, and the
 *   instance actually implements the step's CapabilityDefinition;
 * - INV-C07: every referenced CapabilityDefinition declares support for the
 *   plan's mode;
 * - PASS_THROUGH_NATIVE: exactly ONE provider step preserving the incumbent
 *   provider's flow (semantic preservation, not an authority bypass);
 * - OPTIMIZED_MULTI_PROVIDER: at least two orchestrated steps;
 * - explicit settlement destination, preserved remittance references and the
 *   mandatory protocol authorization link.
 */
export function defineExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("execution plan input must be an object");
  }
  const planId = asExecutionPlanId(input.planId);

  if (!isExecutionMode(input.executionMode)) {
    throw new ValidationError(
      "executionMode is REQUIRED and must be explicit on every execution plan (INV-C07): PASS_THROUGH_NATIVE | COMPOSED_PAYSWAP | OPTIMIZED_MULTI_PROVIDER",
    );
  }
  const mode = input.executionMode;

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new ValidationError("an execution plan requires at least one step");
  }

  const seenStepIds = new Set<string>();
  let expectedOrder = 1;
  for (const step of input.steps) {
    if (step === null || typeof step !== "object") {
      throw new ValidationError("each plan step must be an ExecutionPlanStep");
    }
    if (!isNonEmptyString(step.stepId)) {
      throw new ValidationError("step.stepId must be a non-empty string");
    }
    if (seenStepIds.has(step.stepId)) {
      throw new ValidationError(`step ids must not repeat: ${step.stepId}`);
    }
    seenStepIds.add(step.stepId);
    if (step.order !== expectedOrder) {
      throw new ValidationError(
        `step order must be strictly 1..n; got ${String(step.order)} for step '${step.stepId}'`,
      );
    }
    expectedOrder += 1;
    if (!isNonEmptyString(step.role)) {
      throw new ValidationError(`step '${step.stepId}' must declare a role`);
    }
    if (step.capability === null || typeof step.capability !== "object") {
      throw new ValidationError(
        `step '${step.stepId}' must reference a CapabilityDefinition`,
      );
    }
    // INV-C05: catalogue entries are rejected here; a genuinely connected
    // instance with full scope is required.
    assertConnectedInstance(step.instance);
    if (step.instance.capabilityId !== step.capability.capabilityId) {
      throw new ValidationError(
        `step '${step.stepId}' references capability '${step.capability.capabilityId}' but its instance implements '${step.instance.capabilityId}'`,
      );
    }
    if (!step.capability.executionModes.includes(mode)) {
      throw new ValidationError(
        `step '${step.stepId}' references capability '${step.capability.capabilityId}' which does not declare support for execution mode '${mode}' (INV-C07)`,
      );
    }
    if (step.instance.authorization.status !== "ACTIVE") {
      throw new ValidationError(
        `step '${step.stepId}' references instance '${step.instance.instanceId}' whose authorization is '${step.instance.authorization.status}' — execution requires an ACTIVE connected instance (INV-C05)`,
      );
    }
    if (step.instance.eligibility.eligible !== true) {
      throw new ValidationError(
        `step '${step.stepId}' references instance '${step.instance.instanceId}' which is not eligible (INV-C05): ${step.instance.eligibility.reasons.join("; ")}`,
      );
    }
    if (step.instance.permissionState.missing.length > 0) {
      throw new ValidationError(
        `step '${step.stepId}' references instance '${step.instance.instanceId}' with missing permissions [${step.instance.permissionState.missing.join(", ")}] (INV-C05)`,
      );
    }
  }

  const detail = input.modeDetail;
  if (detail === null || typeof detail !== "object" || detail.kind !== mode) {
    throw new ValidationError(
      "modeDetail.kind must equal the plan's executionMode (INV-C07: the mode is explicit AND consistent)",
    );
  }
  if (detail.kind === "PASS_THROUGH_NATIVE") {
    const first = input.steps[0];
    if (input.steps.length !== 1 || first === undefined) {
      throw new ValidationError(
        "PASS_THROUGH_NATIVE preserves ONE incumbent provider flow: the plan must have exactly one step (semantic preservation of the provider-native flow/optimizer)",
      );
    }
    if (detail.incumbentProviderName !== first.instance.providerName) {
      throw new ValidationError(
        "PASS_THROUGH_NATIVE modeDetail.incumbentProviderName must match the single step's provider (the incumbent provider flow is preserved semantically)",
      );
    }
  } else if (detail.kind === "COMPOSED_PAYSWAP") {
    if (!Array.isArray(detail.composedWith) || detail.composedWith.length === 0) {
      throw new ValidationError(
        "COMPOSED_PAYSWAP must declare the PaySwap capabilities composed with the provider steps",
      );
    }
  } else {
    if (!Array.isArray(detail.comparedProviders) || detail.comparedProviders.length === 0) {
      throw new ValidationError(
        "OPTIMIZED_MULTI_PROVIDER must declare the providers compared/orchestrated by the strategy",
      );
    }
    if (input.steps.length < 2) {
      throw new ValidationError(
        "OPTIMIZED_MULTI_PROVIDER orchestrates multiple reachable providers/capabilities: the plan must have at least two steps",
      );
    }
  }

  validateSettlementDestination(input.settlementDestination);
  validateProtocolAuthorization(input.protocolAuthorization);

  const remittance: PlanRemittanceDocumentRef[] = [];
  for (const ref of input.remittance ?? []) {
    if (ref === null || typeof ref !== "object" || !isNonEmptyString(ref.documentKind) || !isNonEmptyString(ref.documentId)) {
      throw new ValidationError(
        "each remittance reference must carry a canonical documentKind and non-empty documentId (payment-to-invoice/order/project links are preserved)",
      );
    }
    remittance.push(Object.freeze({ ...ref }));
  }

  const plan: ExecutionPlan = {
    planId,
    executionMode: mode,
    modeDetail: Object.freeze({ ...detail }) as ExecutionModeDetail,
    steps: Object.freeze(
      input.steps.map((step) =>
        Object.freeze({
          ...step,
          capability: step.capability,
          instance: step.instance,
        }),
      ),
    ),
    settlementDestination: input.settlementDestination,
    remittance: Object.freeze(remittance),
    protocolAuthorization: Object.freeze({
      commandId: input.protocolAuthorization.commandId,
      principal: Object.freeze({ ...input.protocolAuthorization.principal }),
      authorizationEvidenceRef: input.protocolAuthorization.authorizationEvidenceRef,
    }),
    ...(input.executionGrantId !== undefined
      ? { executionGrantId: input.executionGrantId }
      : {}),
  };
  return Object.freeze(plan);
}

/** Structural guard for plans arriving from untyped sources. */
export function isExecutionPlan(value: unknown): value is ExecutionPlan {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ExecutionPlan>;
  return (
    typeof candidate.planId === "string" &&
    candidate.planId !== "" &&
    isExecutionMode(candidate.executionMode) &&
    candidate.modeDetail !== undefined &&
    candidate.modeDetail !== null &&
    typeof candidate.modeDetail.kind === "string" &&
    candidate.modeDetail.kind === candidate.executionMode &&
    Array.isArray(candidate.steps) &&
    candidate.steps.length > 0 &&
    candidate.settlementDestination !== undefined &&
    candidate.settlementDestination !== null &&
    candidate.protocolAuthorization !== undefined &&
    candidate.protocolAuthorization !== null
  );
}

// ---------------------------------------------------------------------------
// Derived compensation / partial-execution profiles
// ---------------------------------------------------------------------------

/** Derived, deterministic compensation profile of a plan from its steps' capability declarations. */
export type PlanCompensationProfile =
  | {
      readonly compensable: true;
      readonly compensationCapabilityIds: readonly string[];
    }
  | {
      readonly compensable: false;
      readonly reason: "NON_COMPENSABLE_STEP";
      readonly blockingStepIds: readonly string[];
    };

/** Derive the plan's compensation profile from the consumed capability declarations. */
export function planCompensationProfile(
  plan: ExecutionPlan,
): PlanCompensationProfile {
  const blocking: string[] = [];
  const compensationCapabilityIds: string[] = [];
  for (const step of plan.steps) {
    const compensation: CompensationDeclaration = step.capability.compensation;
    if (!compensation.compensable) {
      blocking.push(step.stepId);
    } else if (
      compensation.compensationCapabilityId !== undefined &&
      !compensationCapabilityIds.includes(compensation.compensationCapabilityId)
    ) {
      compensationCapabilityIds.push(compensation.compensationCapabilityId);
    }
  }
  if (blocking.length > 0) {
    return Object.freeze({
      compensable: false,
      reason: "NON_COMPENSABLE_STEP",
      blockingStepIds: Object.freeze(blocking),
    });
  }
  return Object.freeze({
    compensable: true,
    compensationCapabilityIds: Object.freeze(compensationCapabilityIds),
  });
}

/** Conservative (most-manual) partial-execution profile derived from the steps. */
export interface PlanPartialExecutionProfile {
  readonly possible: boolean;
  readonly granularity: "ATOMIC" | "LINE_ITEM" | "STAGED" | "MIXED";
  readonly onPartial: "DISCLOSED" | "AUTO_COMPENSATED" | "MANUAL_RECONCILIATION" | "MIXED";
}

/** Derive the plan's partial-execution semantics (conservative: the strictest declaration wins). */
export function planPartialExecutionProfile(
  plan: ExecutionPlan,
): PlanPartialExecutionProfile {
  const declarations: PartialExecutionDeclaration[] = plan.steps.map(
    (step) => step.capability.compensation.partialExecution,
  );
  const possible = declarations.some((declaration) => declaration.possible);
  const granularities = new Set(declarations.map((declaration) => declaration.granularity));
  const onPartials = new Set(declarations.map((declaration) => declaration.onPartial));
  return Object.freeze({
    possible,
    granularity:
      granularities.size > 1
        ? "MIXED"
        : (granularities.values().next().value ?? "ATOMIC"),
    onPartial:
      onPartials.has("MANUAL_RECONCILIATION")
        ? "MANUAL_RECONCILIATION"
        : onPartials.size > 1
          ? "MIXED"
          : (onPartials.values().next().value ?? "DISCLOSED"),
  });
}
