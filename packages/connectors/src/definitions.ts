/**
 * CapabilityDefinition — the provider-neutral semantic contract of an
 * operation/capability (W2-003; FROZEN-ARCHITECTURE §2A layer 1; ADR-006).
 *
 * "Every executable connector capability declares" (§2A):
 * canonical operation semantics and state machine; preconditions and
 * authorization requirements; side effects and financial effect
 * classification; idempotency and retry behavior; compensation/cancellation
 * behavior; partial-execution behavior; required customer/user actions;
 * provider action/state vocabulary; external object identifiers and
 * revisions; evidence produced and required; economic terms, limits and
 * settlement implications; jurisdiction/regulatory/commercial constraints;
 * current scope/eligibility/health observations (the last one lives on
 * ConnectedCapabilityInstance + CapabilityObservation, not here).
 *
 * Provider-neutral ONLY (AGENTS.md rule 17): no provider SDK types, API
 * names or provider quirks — those belong to ProviderImplementation and the
 * future W3-003 adapters. Where shapes overlap with the Stage-0
 * merchant-facing boundary (packages/interfaces/src/psp-connector.ts), this
 * package is now the canonical owner and consumes those field shapes.
 */

import { ValidationError } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/capabilities";
import { EXECUTION_MODES, isExecutionMode } from "./execution-modes.js";
import type { ExecutionMode } from "./execution-modes.js";

// ---------------------------------------------------------------------------
// Generalized capability kinds (same registry for non-PSP systems)
// ---------------------------------------------------------------------------

/**
 * Capability kinds exposed through the generalized Connector registry.
 * Non-PSP systems (CRM, ERP, EHR, fleet, hospitality, legal, comms, cloud,
 * storage…) expose search/read/write/action/event/health capabilities
 * through the SAME registry as PSPs (CONNECTOR-PLATFORM).
 */
export const CONNECTOR_CAPABILITY_KINDS = [
  "SEARCH",
  "READ",
  "WRITE",
  "ACTION",
  "EVENT",
  "HEALTH",
] as const;

export type ConnectorCapabilityKind =
  (typeof CONNECTOR_CAPABILITY_KINDS)[number];

export function isConnectorCapabilityKind(
  value: unknown,
): value is ConnectorCapabilityKind {
  return (
    typeof value === "string" &&
    (CONNECTOR_CAPABILITY_KINDS as readonly unknown[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Declaration building blocks
// ---------------------------------------------------------------------------

/** Reference to the canonical state machine that governs this operation. */
export interface CanonicalStateMachineRef {
  readonly documentRef: string;
  readonly version: string;
}

/** Canonical operation semantics of the capability. */
export interface CanonicalOperationSemantics {
  /** Canonical operation name, e.g. 'payments.create_authorization'. */
  readonly operation: string;
  readonly stateMachine: CanonicalStateMachineRef;
  readonly description: string;
}

/** Financial effect classification (§2A side effects). */
export const FINANCIAL_EFFECT_CLASSIFICATIONS = [
  "NO_FINANCIAL_EFFECT",
  "RESERVES_VALUE",
  "MOVES_VALUE",
  "SETTLES_VALUE",
  "CREATES_OBLIGATION",
  "DISCHARGES_OBLIGATION",
  "ADJUSTS_VALUE",
] as const;

export type FinancialEffectClassification =
  (typeof FINANCIAL_EFFECT_CLASSIFICATIONS)[number];

export function isFinancialEffectClassification(
  value: unknown,
): value is FinancialEffectClassification {
  return (
    typeof value === "string" &&
    (FINANCIAL_EFFECT_CLASSIFICATIONS as readonly unknown[]).includes(value)
  );
}

/** One declared side effect with its financial classification. */
export interface SideEffectDeclaration {
  readonly effect: string;
  readonly financialEffect: FinancialEffectClassification;
  readonly reversible: boolean;
}

/** Idempotency and retry behavior (INV-F05, INV-X02). */
export type IdempotencyKeyScope =
  | "REQUEST"
  | "CONNECTED_INSTANCE"
  | "PROVIDER_ACCOUNT";

export interface IdempotencyDeclaration {
  readonly idempotent: boolean;
  readonly keyScope: IdempotencyKeyScope;
  readonly duplicateBehavior: "REJECTED" | "RETURNED_SAME_RESULT" | "PROVIDER_DEFINED";
  /**
   * Non-idempotent operations (or ambiguous duplicates) must declare
   * REQUIRES_RECONCILIATION — an UNKNOWN external write can never be blindly
   * retried (INV-X02).
   */
  readonly retryPolicy: "SAFE_TO_RETRY" | "REQUIRES_RECONCILIATION";
}

/** Cancellation/compensation semantics. */
export type CancellationPolicy =
  | "NOT_SUPPORTED"
  | "BEFORE_EXECUTION"
  | "UNTIL_SETTLEMENT"
  | "PROVIDER_DEFINED";

export interface PartialExecutionDeclaration {
  readonly possible: boolean;
  readonly granularity: "ATOMIC" | "LINE_ITEM" | "STAGED";
  readonly onPartial: "DISCLOSED" | "AUTO_COMPENSATED" | "MANUAL_RECONCILIATION";
}

export interface CompensationDeclaration {
  readonly compensable: boolean;
  /** Required when compensable: the capability that compensates this one. */
  readonly compensationCapabilityId?: string;
  readonly cancellation: CancellationPolicy;
  readonly partialExecution: PartialExecutionDeclaration;
}

/** A required customer/user action surfaced by this capability. */
export interface RequiredCustomerAction {
  readonly action: string;
  readonly actor: "CUSTOMER" | "MERCHANT_OPERATOR";
  readonly description: string;
  readonly surfaceHint?: string;
}

/**
 * Provider action/state vocabulary declared by the definition. The state
 * entries DECLARE the provider→canonical mapping; the lossless provider
 * state itself is preserved per-operation in ProviderStateEnvelope
 * (./provider-state.js, INV-C06) — the mapping is additive, never a
 * replacement for the envelope.
 */
export interface ProviderStateVocabularyEntry {
  readonly providerState: string;
  readonly canonicalState: string;
  readonly requiresCustomerAction: boolean;
  readonly isTerminal: boolean;
}

export interface ProviderActionVocabularyEntry {
  readonly action: string;
  readonly description: string;
}

export interface ProviderVocabulary {
  readonly actions: readonly ProviderActionVocabularyEntry[];
  readonly states: readonly ProviderStateVocabularyEntry[];
}

/** External object identity/revision declaration (§2A). */
export interface ExternalObjectIdentity {
  readonly objectType: string;
  readonly idFormat: string;
  readonly revisioned: boolean;
  readonly revisionFormat?: string;
}

/** Evidence kinds a capability can produce or require (§2A evidence/proof). */
export const EVIDENCE_KINDS = [
  "AUTHORIZATION",
  "EXECUTION",
  "RECONCILIATION",
  "STATE_OBSERVATION",
  "WEBHOOK_EVENT",
  "RECEIPT",
  "AUDIT_LOG",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return (
    typeof value === "string" &&
    (EVIDENCE_KINDS as readonly unknown[]).includes(value)
  );
}

export interface EvidenceDeclaration {
  readonly produced: readonly EvidenceKind[];
  readonly required: readonly EvidenceKind[];
}

/** Economic terms, limits and settlement implications (§2A). */
export type FeeModel =
  | "NONE"
  | "FIXED"
  | "VARIABLE_BPS"
  | "TIERED"
  | "HYBRID"
  | "PROVIDER_SCHEDULE";

export type EconomicLimitDimension =
  | "AMOUNT"
  | "AMOUNT_PER_PERIOD"
  | "COUNT"
  | "VELOCITY"
  | "CURRENCY";

export interface EconomicLimit {
  readonly dimension: EconomicLimitDimension;
  readonly description: string;
  readonly amount?: AmountSpec;
}

export interface EconomicTermsDeclaration {
  readonly feeModel: FeeModel;
  readonly limits: readonly EconomicLimit[];
  readonly settlementImplications: string;
}

/** Jurisdiction/regulatory/commercial constraints (§2A). */
export type JurisdictionConstraintKind =
  | "JURISDICTION"
  | "REGULATORY"
  | "COMMERCIAL";

export interface JurisdictionConstraint {
  readonly kind: JurisdictionConstraintKind;
  readonly description: string;
  readonly countryCodes?: readonly string[];
}

/**
 * Authorization requirements (INV-C07): every mode is subject to protocol
 * authorization — `protocolAuthorization: true` is a literal type so it
 * cannot be declared false or omitted.
 */
export interface AuthorizationDeclaration {
  readonly protocolAuthorization: true;
  readonly requiredScopes: readonly string[];
  readonly customerConsent: "NOT_REQUIRED" | "IMPLICIT" | "EXPLICIT";
}

/**
 * Provider-native optimization/recovery represented AS a capability
 * (INV-C08): an incumbent baseline the Lab can benchmark WITHOUT assuming
 * PaySwap composition is superior.
 */
export type NativeOptimizationKind =
  | "ROUTING"
  | "RECOVERY"
  | "PAYMENT_METHOD_SELECTION"
  | "PROVIDER_DEFINED";

export interface NativeOptimizationDeclaration {
  readonly optimizationKind: NativeOptimizationKind;
  /** Marks this capability as an incumbent benchmark baseline (INV-C08). */
  readonly benchmarkBaseline: true;
}

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

/**
 * CapabilityDefinition (§2A layer 1) — the canonical, provider-neutral
 * semantic contract. Overlapping Stage-0 boundary fields (capabilityId,
 * capabilityVersion, summary, requiredPermissions, executionModes) keep
 * their shapes; this package is the canonical owner of the full vocabulary.
 */
export interface CapabilityDefinition {
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly summary: string;
  /** Generalized capability kind (PSP rails and non-PSP systems alike). */
  readonly kind: ConnectorCapabilityKind;
  readonly requiredPermissions: readonly string[];
  /** Modes this capability may execute under — all subject to INV-C07. */
  readonly executionModes: readonly ExecutionMode[];
  readonly semantics: CanonicalOperationSemantics;
  readonly preconditions: readonly string[];
  readonly authorization: AuthorizationDeclaration;
  readonly sideEffects: readonly SideEffectDeclaration[];
  readonly idempotency: IdempotencyDeclaration;
  readonly compensation: CompensationDeclaration;
  readonly requiredCustomerActions: readonly RequiredCustomerAction[];
  readonly providerVocabulary: ProviderVocabulary;
  readonly externalObjects: readonly ExternalObjectIdentity[];
  readonly evidence: EvidenceDeclaration;
  readonly economics: EconomicTermsDeclaration;
  readonly constraints: readonly JurisdictionConstraint[];
  /** INV-C08: incumbent provider-native optimization/recovery baseline. */
  readonly nativeOptimization?: NativeOptimizationDeclaration;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => isNonEmptyString(item))
  );
}

/**
 * Runtime validation for a capability definition arriving from untyped
 * sources (packages, files, RPC). Enforces the §2A declaration completeness
 * plus the invariant couplings:
 * - protocolAuthorization must be declared true (INV-C07);
 * - at least one valid execution mode (INV-C07);
 * - non-idempotent capabilities must require reconciliation before retry
 *   (INV-X02);
 * - compensable capabilities must name their compensation capability.
 */
export function validateCapabilityDefinition(
  candidate: unknown,
): CapabilityDefinition {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("capability definition must be an object");
  }
  const record = candidate as Readonly<Record<string, unknown>>;

  for (const field of ["capabilityId", "capabilityVersion", "summary"] as const) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!isConnectorCapabilityKind(record.kind)) {
    errors.push(
      `kind must be one of [${CONNECTOR_CAPABILITY_KINDS.join(", ")}]`,
    );
  }
  if (!isStringArray(record.requiredPermissions)) {
    errors.push("requiredPermissions must be an array of non-empty strings");
  }
  const modes = record.executionModes;
  if (!Array.isArray(modes) || modes.length === 0) {
    errors.push(
      "executionModes must declare at least one explicit mode (INV-C07)",
    );
  } else {
    const seen = new Set<string>();
    for (const mode of modes) {
      if (!isExecutionMode(mode)) {
        errors.push(
          `unknown execution mode '${String(mode)}': must be one of [${EXECUTION_MODES.join(", ")}] (INV-C07)`,
        );
      }
      if (seen.has(String(mode))) {
        errors.push(`duplicate execution mode '${String(mode)}'`);
      }
      seen.add(String(mode));
    }
  }

  const semantics = record.semantics;
  if (semantics === null || typeof semantics !== "object") {
    errors.push("semantics must be a CanonicalOperationSemantics");
  } else {
    const sem = semantics as Readonly<Record<string, unknown>>;
    if (!isNonEmptyString(sem.operation)) {
      errors.push("semantics.operation must be a non-empty string");
    }
    const stateMachine = sem.stateMachine;
    if (
      stateMachine === null ||
      typeof stateMachine !== "object" ||
      !isNonEmptyString((stateMachine as Record<string, unknown>)["documentRef"]) ||
      !isNonEmptyString((stateMachine as Record<string, unknown>)["version"])
    ) {
      errors.push(
        "semantics.stateMachine must reference a canonical state machine { documentRef, version }",
      );
    }
    if (!isNonEmptyString(sem.description)) {
      errors.push("semantics.description must be a non-empty string");
    }
  }

  if (!isStringArray(record.preconditions)) {
    errors.push("preconditions must be an array of non-empty strings");
  }

  const authorization = record.authorization;
  if (authorization === null || typeof authorization !== "object") {
    errors.push("authorization must be an AuthorizationDeclaration (INV-C07)");
  } else {
    const auth = authorization as Readonly<Record<string, unknown>>;
    if (auth.protocolAuthorization !== true) {
      errors.push(
        "authorization.protocolAuthorization must be declared true: no execution mode can bypass protocol authorization (INV-C07)",
      );
    }
    if (!isStringArray(auth.requiredScopes)) {
      errors.push("authorization.requiredScopes must be an array of non-empty strings");
    }
    if (
      auth.customerConsent !== "NOT_REQUIRED" &&
      auth.customerConsent !== "IMPLICIT" &&
      auth.customerConsent !== "EXPLICIT"
    ) {
      errors.push("authorization.customerConsent must be NOT_REQUIRED, IMPLICIT or EXPLICIT");
    }
  }

  if (!Array.isArray(record.sideEffects)) {
    errors.push("sideEffects must be an array of SideEffectDeclaration");
  } else {
    for (const [index, effect] of record.sideEffects.entries()) {
      const entry = effect as Readonly<Record<string, unknown>> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        !isNonEmptyString(entry.effect) ||
        !isFinancialEffectClassification(entry.financialEffect) ||
        typeof entry.reversible !== "boolean"
      ) {
        errors.push(`sideEffects[${index}] is not a valid SideEffectDeclaration`);
      }
    }
  }

  const idempotency = record.idempotency;
  if (idempotency === null || typeof idempotency !== "object") {
    errors.push("idempotency must be an IdempotencyDeclaration");
  } else {
    const idem = idempotency as Readonly<Record<string, unknown>>;
    if (typeof idem.idempotent !== "boolean") {
      errors.push("idempotency.idempotent must be a boolean");
    }
    if (
      idem.keyScope !== "REQUEST" &&
      idem.keyScope !== "CONNECTED_INSTANCE" &&
      idem.keyScope !== "PROVIDER_ACCOUNT"
    ) {
      errors.push("idempotency.keyScope must be REQUEST, CONNECTED_INSTANCE or PROVIDER_ACCOUNT");
    }
    if (
      idem.duplicateBehavior !== "REJECTED" &&
      idem.duplicateBehavior !== "RETURNED_SAME_RESULT" &&
      idem.duplicateBehavior !== "PROVIDER_DEFINED"
    ) {
      errors.push(
        "idempotency.duplicateBehavior must be REJECTED, RETURNED_SAME_RESULT or PROVIDER_DEFINED",
      );
    }
    if (
      idem.retryPolicy !== "SAFE_TO_RETRY" &&
      idem.retryPolicy !== "REQUIRES_RECONCILIATION"
    ) {
      errors.push("idempotency.retryPolicy must be SAFE_TO_RETRY or REQUIRES_RECONCILIATION");
    } else if (
      idem.idempotent === false &&
      idem.retryPolicy === "SAFE_TO_RETRY"
    ) {
      errors.push(
        "a non-idempotent capability must declare retryPolicy REQUIRES_RECONCILIATION (INV-X02)",
      );
    }
  }

  const compensation = record.compensation;
  if (compensation === null || typeof compensation !== "object") {
    errors.push("compensation must be a CompensationDeclaration");
  } else {
    const comp = compensation as Readonly<Record<string, unknown>>;
    if (typeof comp.compensable !== "boolean") {
      errors.push("compensation.compensable must be a boolean");
    }
    if (comp.compensable === true && !isNonEmptyString(comp.compensationCapabilityId)) {
      errors.push(
        "compensation.compensationCapabilityId is required when compensable",
      );
    }
    if (
      comp.cancellation !== "NOT_SUPPORTED" &&
      comp.cancellation !== "BEFORE_EXECUTION" &&
      comp.cancellation !== "UNTIL_SETTLEMENT" &&
      comp.cancellation !== "PROVIDER_DEFINED"
    ) {
      errors.push("compensation.cancellation is not a valid CancellationPolicy");
    }
    const partial = comp.partialExecution;
    if (partial === null || typeof partial !== "object") {
      errors.push("compensation.partialExecution must be declared");
    } else {
      const part = partial as Readonly<Record<string, unknown>>;
      if (typeof part.possible !== "boolean") {
        errors.push("compensation.partialExecution.possible must be a boolean");
      }
      if (
        part.granularity !== "ATOMIC" &&
        part.granularity !== "LINE_ITEM" &&
        part.granularity !== "STAGED"
      ) {
        errors.push("compensation.partialExecution.granularity is invalid");
      }
      if (
        part.onPartial !== "DISCLOSED" &&
        part.onPartial !== "AUTO_COMPENSATED" &&
        part.onPartial !== "MANUAL_RECONCILIATION"
      ) {
        errors.push("compensation.partialExecution.onPartial is invalid");
      }
    }
  }

  if (!Array.isArray(record.requiredCustomerActions)) {
    errors.push("requiredCustomerActions must be an array");
  } else {
    for (const [index, action] of record.requiredCustomerActions.entries()) {
      const entry = action as Readonly<Record<string, unknown>> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        !isNonEmptyString(entry.action) ||
        (entry.actor !== "CUSTOMER" && entry.actor !== "MERCHANT_OPERATOR") ||
        !isNonEmptyString(entry.description)
      ) {
        errors.push(`requiredCustomerActions[${index}] is not a valid RequiredCustomerAction`);
      }
    }
  }

  const vocabulary = record.providerVocabulary;
  if (vocabulary === null || typeof vocabulary !== "object") {
    errors.push("providerVocabulary must be declared");
  } else {
    const vocab = vocabulary as Readonly<Record<string, unknown>>;
    if (!Array.isArray(vocab.actions)) {
      errors.push("providerVocabulary.actions must be an array");
    } else {
      for (const [index, action] of vocab.actions.entries()) {
        const entry = action as Readonly<Record<string, unknown>> | null;
        if (
          entry === null ||
          typeof entry !== "object" ||
          !isNonEmptyString(entry.action) ||
          !isNonEmptyString(entry.description)
        ) {
          errors.push(`providerVocabulary.actions[${index}] is invalid`);
        }
      }
    }
    if (!Array.isArray(vocab.states)) {
      errors.push("providerVocabulary.states must be an array");
    } else {
      for (const [index, state] of vocab.states.entries()) {
        const entry = state as Readonly<Record<string, unknown>> | null;
        if (
          entry === null ||
          typeof entry !== "object" ||
          !isNonEmptyString(entry.providerState) ||
          !isNonEmptyString(entry.canonicalState) ||
          typeof entry.requiresCustomerAction !== "boolean" ||
          typeof entry.isTerminal !== "boolean"
        ) {
          errors.push(`providerVocabulary.states[${index}] is invalid`);
        }
      }
    }
  }

  if (!Array.isArray(record.externalObjects)) {
    errors.push("externalObjects must be an array of ExternalObjectIdentity");
  } else {
    for (const [index, external] of record.externalObjects.entries()) {
      const entry = external as Readonly<Record<string, unknown>> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        !isNonEmptyString(entry.objectType) ||
        !isNonEmptyString(entry.idFormat) ||
        typeof entry.revisioned !== "boolean"
      ) {
        errors.push(`externalObjects[${index}] is invalid`);
      } else if (
        entry.revisioned === true &&
        !isNonEmptyString(entry.revisionFormat)
      ) {
        errors.push(
          `externalObjects[${index}].revisionFormat is required when revisioned`,
        );
      }
    }
  }

  const evidence = record.evidence;
  if (evidence === null || typeof evidence !== "object") {
    errors.push("evidence must be an EvidenceDeclaration");
  } else {
    const ev = evidence as Readonly<Record<string, unknown>>;
    for (const field of ["produced", "required"] as const) {
      const list = ev[field];
      if (!Array.isArray(list)) {
        errors.push(`evidence.${field} must be an array`);
      } else {
        for (const [index, kind] of list.entries()) {
          if (!isEvidenceKind(kind)) {
            errors.push(
              `evidence.${field}[${index}] '${String(kind)}' is not a known evidence kind`,
            );
          }
        }
      }
    }
  }

  const economics = record.economics;
  if (economics === null || typeof economics !== "object") {
    errors.push("economics must be an EconomicTermsDeclaration");
  } else {
    const econ = economics as Readonly<Record<string, unknown>>;
    const feeModels = ["NONE", "FIXED", "VARIABLE_BPS", "TIERED", "HYBRID", "PROVIDER_SCHEDULE"];
    if (!feeModels.includes(String(econ.feeModel))) {
      errors.push("economics.feeModel is not a valid FeeModel");
    }
    if (!Array.isArray(econ.limits)) {
      errors.push("economics.limits must be an array");
    } else {
      const dimensions = ["AMOUNT", "AMOUNT_PER_PERIOD", "COUNT", "VELOCITY", "CURRENCY"];
      for (const [index, limit] of econ.limits.entries()) {
        const entry = limit as Readonly<Record<string, unknown>> | null;
        if (
          entry === null ||
          typeof entry !== "object" ||
          !dimensions.includes(String(entry.dimension)) ||
          !isNonEmptyString(entry.description)
        ) {
          errors.push(`economics.limits[${index}] is invalid`);
        }
      }
    }
    if (!isNonEmptyString(econ.settlementImplications)) {
      errors.push("economics.settlementImplications must be a non-empty string");
    }
  }

  if (!Array.isArray(record.constraints)) {
    errors.push("constraints must be an array of JurisdictionConstraint");
  } else {
    const kinds = ["JURISDICTION", "REGULATORY", "COMMERCIAL"];
    for (const [index, constraint] of record.constraints.entries()) {
      const entry = constraint as Readonly<Record<string, unknown>> | null;
      if (
        entry === null ||
        typeof entry !== "object" ||
        !kinds.includes(String(entry.kind)) ||
        !isNonEmptyString(entry.description)
      ) {
        errors.push(`constraints[${index}] is invalid`);
      }
    }
  }

  const nativeOptimization = record.nativeOptimization;
  if (nativeOptimization !== undefined) {
    if (nativeOptimization === null || typeof nativeOptimization !== "object") {
      errors.push("nativeOptimization, when present, must be a NativeOptimizationDeclaration");
    } else {
      const native = nativeOptimization as Readonly<Record<string, unknown>>;
      const kinds = ["ROUTING", "RECOVERY", "PAYMENT_METHOD_SELECTION", "PROVIDER_DEFINED"];
      if (!kinds.includes(String(native.optimizationKind))) {
        errors.push("nativeOptimization.optimizationKind is invalid");
      }
      if (native.benchmarkBaseline !== true) {
        errors.push(
          "nativeOptimization.benchmarkBaseline must be true (INV-C08 incumbent baseline)",
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid capability definition: ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }

  return candidate as CapabilityDefinition;
}
