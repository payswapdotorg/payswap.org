/**
 * Connected-instance activation control plane (P2-W1-001).
 *
 * Authority: spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md +
 * spec/phase-2/work-items/P2-W1-001.md, over the FROZEN v1.5 vocabulary
 * (ConnectedCapabilityInstance, ConnectorAuthorizationState, CredentialScope,
 * ProviderStateEnvelope families, CapabilityObservation — all CONSUMED from
 * their canonical modules, never redefined).
 *
 * The laws this module enforces:
 *
 * 1. ACTIVATION IS EARNED, NEVER ASSUMED (fail-closed): a
 *    ConnectedCapabilityInstance transitions PENDING → ACTIVE only with
 *    valid authorization state FOR THE DECLARED AUTH MODE, eligibility
 *    evidence, and an explicit account/tenant/geography/currency/permission
 *    scope. Missing evidence means NO activation — there is no
 *    default-allow path anywhere;
 * 2. CONNECTION ≠ DEBIT: activating a connected account grants CONNECTION
 *    scope only. Transfer-out (debit/withdrawal) authority is a SEPARATE
 *    authorization with its own artifact reference, currency scope, limits
 *    and expiry — granted only by `authorizeTransferOut`;
 * 3. CAPABILITY STATE ≠ SOURCE AVAILABILITY (INV-C01/INV-C02): the
 *    activation state machine never consumes availability; executability is
 *    evaluated per execution against a CapabilityObservation, and an
 *    unreachable source yields UNKNOWN availability without touching the
 *    activation state;
 * 4. BROWSER SESSIONS ARE FIRST-CLASS CUSTOMER-ACTION STATE: expiry,
 *    revocation, reauthentication-required and provider-required step-up are
 *    explicit session lifecycle states in the `customer_action_required`
 *    family (PROVIDER_STATE_FAMILIES); the session itself is an opaque
 *    reference (cookies/storage/headers stay inside the isolated browser
 *    runtime — never here);
 * 5. PROVIDER FAILURE IS ISOLATED: `applyProviderFailureIsolation` scopes a
 *    failure to one instance (or one provider, explicitly) — unrelated
 *    provider instances are returned untouched, same object references;
 * 6. PROVIDERLESS LOCAL RAILS ACTIVATE ONLY THROUGH THE FOUR GATES: real
 *    external capability + owner authorization + legal/security
 *    permissibility + evidence path, each evidenced (a catalogue entry alone
 *    authorizes nothing — INV-C05).
 *
 * Deterministic only: no ambient clock, no entropy. Every time input is an
 * explicit caller-supplied ISO-8601 UTC timestamp string; comparisons are
 * lexicographic on the uniform format.
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
import type { ErrorCategory, PaySwapErrorDetails } from "@payswap/protocol";
import type { CapabilityObservation } from "./observations.js";
import { PROVIDER_STATE_FAMILIES, isProviderStateFamily } from "./provider-state.js";
import { isProviderCatalogueEntry, validateConnectedCapabilityInstance } from "./instances.js";
import type {
  ConnectedCapabilityInstance,
  ConnectorAuthorizationState,
  CredentialScope,
} from "./instances.js";

// ---------------------------------------------------------------------------
// The five authorization modes (canonical union — @payswap/adapters consumes)
// ---------------------------------------------------------------------------

/**
 * The supported phase-2 authorization modes
 * (spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md §"Supported
 * authorization modes"). INTERACTIVE_BROWSER_SESSION and PROVIDERLESS_RAIL
 * exist for local rails where no suitable provider API credential is
 * available to PaySwap.
 */
export const AUTHORIZATION_MODES = [
  "DELEGATED_OAUTH",
  "CONNECTED_ACCOUNT",
  "SCOPED_API_CREDENTIAL",
  "INTERACTIVE_BROWSER_SESSION",
  "PROVIDERLESS_RAIL",
] as const;

export type AuthorizationMode = (typeof AUTHORIZATION_MODES)[number];

export function isAuthorizationMode(
  value: unknown,
): value is AuthorizationMode {
  return (
    typeof value === "string" &&
    (AUTHORIZATION_MODES as readonly unknown[]).includes(value)
  );
}

/**
 * The CredentialScope kinds consistent with each authorization mode. A
 * browser-session connection cannot be activated on an API-key credential
 * scope and vice versa (fail-closed mode/scope consistency).
 */
const MODE_CREDENTIAL_KINDS: Readonly<
  Record<AuthorizationMode, readonly CredentialScope["credentialKind"][]>
> = Object.freeze({
  DELEGATED_OAUTH: Object.freeze(["OAUTH", "DELEGATED_TOKEN"] as const),
  CONNECTED_ACCOUNT: Object.freeze(["PROVIDER_DEFINED", "OAUTH", "DELEGATED_TOKEN"] as const),
  SCOPED_API_CREDENTIAL: Object.freeze(["API_KEY"] as const),
  INTERACTIVE_BROWSER_SESSION: Object.freeze(["SESSION"] as const),
  // A local rail holds no provider API credential; the vault reference names
  // rail-held local material whose form is rail-defined (keypair, wallet…).
  PROVIDERLESS_RAIL: Object.freeze([
    "API_KEY",
    "OAUTH",
    "DELEGATED_TOKEN",
    "SESSION",
    "PROVIDER_DEFINED",
  ] as const),
});

// ---------------------------------------------------------------------------
// Activation states and the legal transition table
// ---------------------------------------------------------------------------

/**
 * The activation lifecycle of a connected capability instance:
 * PENDING → ACTIVE → (REVOKED | EXPIRED | UNKNOWN), plus the recovery paths
 * the phase-2 acceptance demands: reconnection/reauthentication returns a
 * lapsed activation to PENDING (fresh authorization required), and
 * reconciliation resolves UNKNOWN (never a blind retry — INV-X02).
 */
export const CONNECTED_INSTANCE_ACTIVATION_STATES = [
  "PENDING",
  "ACTIVE",
  "REVOKED",
  "EXPIRED",
  "UNKNOWN",
] as const;

export type ConnectedInstanceActivationState =
  (typeof CONNECTED_INSTANCE_ACTIVATION_STATES)[number];

export function isConnectedInstanceActivationState(
  value: unknown,
): value is ConnectedInstanceActivationState {
  return (
    typeof value === "string" &&
    (CONNECTED_INSTANCE_ACTIVATION_STATES as readonly unknown[]).includes(value)
  );
}

/**
 * The legal state transitions, as data. PENDING → ACTIVE always runs the
 * full activation gate; REVOKED/EXPIRED → PENDING is the reconnection path
 * and requires FRESH authorization evidence; UNKNOWN → ACTIVE/REVOKED/
 * EXPIRED is the reconciliation path.
 */
export const LEGAL_ACTIVATION_TRANSITIONS: Readonly<
  Record<ConnectedInstanceActivationState, readonly ConnectedInstanceActivationState[]>
> = Object.freeze({
  PENDING: Object.freeze(["ACTIVE", "REVOKED", "EXPIRED"] as const),
  ACTIVE: Object.freeze(["REVOKED", "EXPIRED", "UNKNOWN", "PENDING"] as const),
  REVOKED: Object.freeze(["PENDING"] as const),
  EXPIRED: Object.freeze(["PENDING", "REVOKED"] as const),
  UNKNOWN: Object.freeze(["ACTIVE", "REVOKED", "EXPIRED"] as const),
});

/** Why an activation transition happened. */
export type ActivationCause =
  | "CONNECTION_REQUESTED"
  | "AUTHORIZATION_EVIDENCE_VERIFIED"
  | "RECONCILIATION_RESOLVED"
  | "REAUTHENTICATION_COMPLETED"
  | "REAUTHENTICATION_REQUIRED"
  | "PROVIDER_STEP_UP_REQUIRED"
  | "OWNER_REVOKED"
  | "OPERATOR_DEACTIVATED"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_UNKNOWN"
  | "PROVIDER_FAILURE_ISOLATED"
  | "TRANSFER_OUT_AUTHORIZED"
  | "TRANSFER_OUT_REVOKED";

/**
 * A first-class customer-action requirement attached to a transition (the
 * `customer_action_required` family from PROVIDER_STATE_FAMILIES — never a
 * generic error/status; AGENTS.md rule 19).
 */
export interface CustomerActionRequirement {
  readonly family: "customer_action_required";
  readonly lifecycleStep: string;
  readonly kind: string;
  readonly message: string;
}

/** Constructs a customer-action requirement pinned to the canonical family. */
export function customerActionRequirement(
  lifecycleStep: string,
  kind: string,
  message: string,
): CustomerActionRequirement {
  if (!isProviderStateFamily("customer_action_required")) {
    throw new ValidationError(
      `vocabulary drift: 'customer_action_required' is no longer a ProviderStateFamily (expected one of [${PROVIDER_STATE_FAMILIES.join(", ")}])`,
    );
  }
  if (lifecycleStep.length === 0 || kind.length === 0 || message.length === 0) {
    throw new ValidationError(
      "customer action requirements need a lifecycleStep, a kind and a message",
    );
  }
  return Object.freeze({
    family: "customer_action_required",
    lifecycleStep,
    kind,
    message,
  });
}

/** One immutable activation lifecycle event. */
export interface ActivationTransition {
  readonly from: ConnectedInstanceActivationState;
  readonly to: ConnectedInstanceActivationState;
  readonly occurredAt: string;
  readonly cause: ActivationCause;
  readonly actor?: string;
  readonly note?: string;
  readonly customerAction?: CustomerActionRequirement;
}

/**
 * The caller-supplied half of a transition — the from/to states are DERIVED
 * by the state machine and never caller-set. An explicit init type is used
 * (rather than an Omit over the transition interface) so the package's
 * textual import scanner cannot mis-read a type-level union as an import
 * specifier.
 */
export interface ActivationTransitionInit {
  readonly occurredAt: string;
  readonly cause: ActivationCause;
  readonly actor?: string;
  readonly note?: string;
  readonly customerAction?: CustomerActionRequirement;
}

// ---------------------------------------------------------------------------
// Browser-session authorization lifecycle (INTERACTIVE_BROWSER_SESSION)
// ---------------------------------------------------------------------------

/**
 * The lifecycle of an owner-established browser session in the isolated
 * secure browser runtime. EXPIRY, REVOCATION, REAUTHENTICATION-REQUIRED and
 * provider-required STEP-UP are first-class states; the session is named by
 * an opaque reference — cookies, storage and credential fields NEVER appear
 * here (they stay inside the browser runtime).
 */
export const BROWSER_SESSION_AUTHORIZATION_STATES = [
  "ACTIVE",
  "REAUTHENTICATION_REQUIRED",
  "STEP_UP_REQUIRED",
  "EXPIRED",
  "REVOKED",
] as const;

export type BrowserSessionAuthorizationState =
  (typeof BROWSER_SESSION_AUTHORIZATION_STATES)[number];

export function isBrowserSessionAuthorizationState(
  value: unknown,
): value is BrowserSessionAuthorizationState {
  return (
    typeof value === "string" &&
    (BROWSER_SESSION_AUTHORIZATION_STATES as readonly unknown[]).includes(value)
  );
}

const LEGAL_BROWSER_SESSION_TRANSITIONS: Readonly<
  Record<BrowserSessionAuthorizationState, readonly BrowserSessionAuthorizationState[]>
> = Object.freeze({
  ACTIVE: Object.freeze(["REAUTHENTICATION_REQUIRED", "STEP_UP_REQUIRED", "EXPIRED", "REVOKED"] as const),
  REAUTHENTICATION_REQUIRED: Object.freeze(["ACTIVE", "STEP_UP_REQUIRED", "EXPIRED", "REVOKED"] as const),
  STEP_UP_REQUIRED: Object.freeze(["ACTIVE", "EXPIRED", "REVOKED"] as const),
  EXPIRED: Object.freeze(["REVOKED"] as const),
  REVOKED: Object.freeze([] as const),
});

/**
 * The browser-session authorization record the control plane keeps: an
 * OPAQUE session reference plus lifecycle state — never session material.
 */
export interface BrowserSessionAuthorization {
  /** Opaque reference minted by the isolated secure browser runtime. */
  readonly browserSessionRef: string;
  readonly providerName: string;
  readonly accountRef: string;
  readonly state: BrowserSessionAuthorizationState;
  readonly establishedAt: string;
  readonly expiresAt?: string;
  readonly lastStateChangeAt: string;
  readonly lastCustomerActionAt?: string;
  readonly reauthenticationReason?: string;
  readonly stepUpReason?: string;
}

/** Input to `establishBrowserSession` (the owner just authenticated). */
export interface EstablishBrowserSessionInput {
  readonly browserSessionRef: string;
  readonly providerName: string;
  readonly accountRef: string;
  readonly establishedAt: string;
  readonly expiresAt?: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function transitionSession(
  session: BrowserSessionAuthorization,
  to: BrowserSessionAuthorizationState,
  at: string,
  patch: Partial<BrowserSessionAuthorization> = {},
): BrowserSessionAuthorization {
  const legal =
    LEGAL_BROWSER_SESSION_TRANSITIONS[session.state] ?? Object.freeze([]);
  if (!legal.includes(to)) {
    throw new ValidationError(
      `illegal browser-session transition ${session.state} → ${to} (session '${session.browserSessionRef}')`,
    );
  }
  return Object.freeze({
    ...session,
    state: to,
    lastStateChangeAt: at,
    ...patch,
  });
}

/** The owner authenticated in the isolated browser runtime → session ACTIVE. */
export function establishBrowserSession(
  input: EstablishBrowserSessionInput,
): BrowserSessionAuthorization {
  const errors: string[] = [];
  if (!nonEmptyString(input.browserSessionRef)) {
    errors.push("browserSessionRef must be a non-empty opaque reference");
  }
  if (!nonEmptyString(input.providerName)) {
    errors.push("providerName must be a non-empty string");
  }
  if (!nonEmptyString(input.accountRef)) {
    errors.push("accountRef must be a non-empty string");
  }
  if (!nonEmptyString(input.establishedAt)) {
    errors.push("establishedAt must be a non-empty timestamp");
  }
  if (
    input.expiresAt !== undefined &&
    (!nonEmptyString(input.expiresAt) || input.expiresAt <= input.establishedAt)
  ) {
    errors.push("expiresAt, when present, must be a timestamp after establishedAt");
  }
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid browser session authorization: ${errors.join("; ")}`,
    );
  }
  return Object.freeze({
    browserSessionRef: input.browserSessionRef,
    providerName: input.providerName,
    accountRef: input.accountRef,
    state: "ACTIVE",
    establishedAt: input.establishedAt,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    lastStateChangeAt: input.establishedAt,
  });
}

/** Evaluates the session's effective state at an explicit instant. */
export function browserSessionStateAt(
  session: BrowserSessionAuthorization,
  at: string,
): BrowserSessionAuthorizationState {
  if (
    session.state === "ACTIVE" &&
    session.expiresAt !== undefined &&
    at >= session.expiresAt
  ) {
    return "EXPIRED";
  }
  return session.state;
}

/** Marks expiry (temporal lapse of the session). */
export function expireBrowserSession(
  session: BrowserSessionAuthorization,
  at: string,
): BrowserSessionAuthorization {
  return transitionSession(session, "EXPIRED", at);
}

/** Marks revocation (owner or operator withdraws the session). */
export function revokeBrowserSession(
  session: BrowserSessionAuthorization,
  at: string,
): BrowserSessionAuthorization {
  return transitionSession(session, "REVOKED", at);
}

/** The provider demands reauthentication → first-class customer action. */
export function requireReauthentication(
  session: BrowserSessionAuthorization,
  at: string,
  reason: string,
): BrowserSessionAuthorization {
  if (!nonEmptyString(reason)) {
    throw new ValidationError("a reauthentication reason is required");
  }
  return transitionSession(session, "REAUTHENTICATION_REQUIRED", at, {
    reauthenticationReason: reason,
  });
}

/** The provider demands step-up (e.g. fresh MFA/SCA) → customer action. */
export function requireProviderStepUp(
  session: BrowserSessionAuthorization,
  at: string,
  reason: string,
): BrowserSessionAuthorization {
  if (!nonEmptyString(reason)) {
    throw new ValidationError("a step-up reason is required");
  }
  return transitionSession(session, "STEP_UP_REQUIRED", at, {
    stepUpReason: reason,
  });
}

/** The customer completed the required action → session ACTIVE again. */
export function completeReauthentication(
  session: BrowserSessionAuthorization,
  at: string,
): BrowserSessionAuthorization {
  return transitionSession(session, "ACTIVE", at, {
    lastCustomerActionAt: at,
    ...(session.reauthenticationReason !== undefined
      ? { reauthenticationReason: session.reauthenticationReason }
      : {}),
  });
}

/** Whether the session authorizes use at the given instant. */
export function isBrowserSessionUsable(
  session: BrowserSessionAuthorization,
  at: string,
): boolean {
  return browserSessionStateAt(session, at) === "ACTIVE";
}

/** The outstanding customer action on a session, if any. */
export function browserSessionCustomerAction(
  session: BrowserSessionAuthorization,
): CustomerActionRequirement | undefined {
  if (session.state === "REAUTHENTICATION_REQUIRED") {
    return customerActionRequirement(
      "reauthentication_required",
      "reauthenticate",
      session.reauthenticationReason !== undefined
        ? `The provider requires reauthentication: ${session.reauthenticationReason}`
        : "The provider requires reauthentication in the isolated browser runtime.",
    );
  }
  if (session.state === "STEP_UP_REQUIRED") {
    return customerActionRequirement(
      "provider_step_up",
      "step_up",
      session.stepUpReason !== undefined
        ? `The provider requires step-up authentication: ${session.stepUpReason}`
        : "The provider requires step-up authentication in the isolated browser runtime.",
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Providerless local-rail evidence (PROVIDERLESS_RAIL gate)
// ---------------------------------------------------------------------------

/** The four gates a providerless/local-rail activation must pass. */
export const PROVIDERLESS_RAIL_GATES = [
  "EXTERNAL_CAPABILITY",
  "OWNER_AUTHORIZATION",
  "LEGAL_SECURITY_PERMISSIBILITY",
  "EVIDENCE_PATH",
] as const;

export type ProviderlessRailGateName = (typeof PROVIDERLESS_RAIL_GATES)[number];

export interface ProviderlessRailGateItem {
  readonly gate: ProviderlessRailGateName;
  /** Established only when the real external fact is proven, evidenced. */
  readonly established: boolean;
  /** Reference to the evidence artifact (required when established). */
  readonly evidenceRef: string;
  readonly note?: string;
}

export interface ProviderlessRailEvidence {
  /** The real external capability exists and is operable (not a catalogue claim). */
  readonly externalCapability: ProviderlessRailGateItem;
  /** The owner authorized this automation/execution path. */
  readonly ownerAuthorization: ProviderlessRailGateItem;
  /** Legal and security permissibility is established for the automation. */
  readonly legalSecurityPermissibility: ProviderlessRailGateItem;
  /** The evidence path for external effects is established (→ reconciliation). */
  readonly evidencePath: ProviderlessRailGateItem;
}

export interface ProviderlessRailGateCheck {
  readonly gate: ProviderlessRailGateName;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ProviderlessRailGateReport {
  readonly passed: boolean;
  readonly checks: readonly ProviderlessRailGateCheck[];
}

/**
 * Fail-closed providerless/local-rail gate: the activation is possible only
 * when the real external capability, owner authorization, legal/security
 * permissibility and evidence path are ALL established with evidence
 * references. A provider catalogue entry alone authorizes nothing.
 */
export function evaluateProviderlessRailGate(
  evidence: ProviderlessRailEvidence,
): ProviderlessRailGateReport {
  const checks: ProviderlessRailGateCheck[] = [];
  const items: readonly ProviderlessRailGateItem[] = [
    evidence.externalCapability,
    evidence.ownerAuthorization,
    evidence.legalSecurityPermissibility,
    evidence.evidencePath,
  ];
  for (const item of items) {
    if (item === null || typeof item !== "object" || !item) {
      throw new ValidationError(
        "providerless rail evidence requires all four gate items",
      );
    }
    const passed =
      item.established === true && nonEmptyString(item.evidenceRef);
    checks.push({
      gate: item.gate,
      passed,
      detail: passed
        ? `established (evidence: ${item.evidenceRef})`
        : item.established !== true
          ? `not established — a providerless rail activates only when ${item.gate} is really proven`
          : "established but missing an evidence reference (fail-closed)",
    });
  }
  return Object.freeze({
    passed: checks.every((check) => check.passed),
    checks: Object.freeze(checks),
  });
}

// ---------------------------------------------------------------------------
// The activation record
// ---------------------------------------------------------------------------

/**
 * Connection scope — what the activation grants. Deliberately does NOT
 * include transfer-out authority (see TransferOutAuthorization).
 */
export interface ActivationConnectionScope {
  readonly accountRef: string;
  readonly tenantRef: string;
  readonly countries: readonly string[];
  readonly currencies: readonly string[];
  readonly grantedPermissions: readonly string[];
  readonly missingPermissions: readonly string[];
  /** CredentialScope.credentialRef — a REFERENCE, never material. */
  readonly credentialRef: string;
  readonly credentialKind: CredentialScope["credentialKind"];
  readonly eligibilityReasons: readonly string[];
}

/**
 * Transfer-out (debit/withdrawal) authority — a SEPARATE scope with its own
 * authorization artifact, currency scope, limits and expiry. Connecting an
 * account never grants this implicitly.
 */
export interface TransferOutAuthorization {
  readonly grantedAt: string;
  readonly expiresAt?: string;
  /** The SEPARATE owner authorization artifact reference (≠ connection ref). */
  readonly authorizationRef: string;
  readonly currencyScope: readonly string[];
  readonly maxSingleAmountMinor?: number;
  readonly cumulativeLimitMinor?: number;
  readonly requiresProviderStepUp: boolean;
}

/** Request to authorize transfer-out on an ACTIVE connection. */
export interface TransferOutRequest {
  readonly authorizationRef: string;
  readonly authorizedAt: string;
  readonly expiresAt?: string;
  readonly currencyScope: readonly string[];
  readonly maxSingleAmountMinor?: number;
  readonly cumulativeLimitMinor?: number;
  readonly requiresProviderStepUp: boolean;
}

/**
 * The activation record over a ConnectedCapabilityInstance: immutable,
 * append-only history, connection scope, optional separate transfer-out
 * authorization, and (for INTERACTIVE_BROWSER_SESSION) the browser-session
 * authorization snapshot.
 */
export interface ConnectedInstanceActivation {
  readonly instanceId: string;
  readonly providerName: string;
  readonly capabilityId: string;
  readonly authorizationMode: AuthorizationMode;
  readonly state: ConnectedInstanceActivationState;
  readonly connectionScope: ActivationConnectionScope;
  /** The connection's current authorization artifact reference (opaque). */
  readonly authorizationRef?: string;
  readonly transferOut?: TransferOutAuthorization;
  readonly browserSession?: BrowserSessionAuthorization;
  readonly history: readonly ActivationTransition[];
}

// ---------------------------------------------------------------------------
// The activation gate (fail-closed)
// ---------------------------------------------------------------------------

/** Evidence that authorization succeeded for the declared auth mode. */
export interface ActivationAuthorizationEvidence {
  readonly authorizationState: ConnectorAuthorizationState;
  /** Opaque artifact/vault reference for credential-bearing modes. */
  readonly authorizationRef?: string;
  /** The live browser-session authorization (INTERACTIVE_BROWSER_SESSION). */
  readonly browserSession?: BrowserSessionAuthorization;
  /** The four providerless gates (PROVIDERLESS_RAIL). */
  readonly providerlessRail?: ProviderlessRailEvidence;
}

/** An activation gate request. */
export interface ActivationRequest {
  readonly instance: ConnectedCapabilityInstance;
  readonly authorizationMode: AuthorizationMode;
  readonly evidence: ActivationAuthorizationEvidence;
  readonly activatedAt: string;
  /**
   * Prior record when continuing an existing connection (PENDING after
   * registration/reauthentication, UNKNOWN after reconciliation). Absent
   * for a first activation.
   */
  readonly continuingFrom?: ConnectedInstanceActivation;
  readonly activationCause?: Extract<
    ActivationCause,
    "AUTHORIZATION_EVIDENCE_VERIFIED" | "RECONCILIATION_RESOLVED" | "REAUTHENTICATION_COMPLETED"
  >;
}

export interface ActivationGateCheck {
  readonly requirement: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ActivationGateReport {
  readonly instanceId: string;
  readonly authorizationMode: AuthorizationMode;
  readonly authorized: boolean;
  readonly checks: readonly ActivationGateCheck[];
}

function check(
  requirement: string,
  passed: boolean,
  detail: string,
): ActivationGateCheck {
  return Object.freeze({ requirement, passed, detail });
}

/**
 * Evaluates the full activation gate WITHOUT throwing: every requirement is
 * reported. Fail-closed: `authorized` is true only when EVERY check passes.
 */
export function evaluateActivationGate(
  request: ActivationRequest,
): ActivationGateReport {
  const checks: ActivationGateCheck[] = [];
  const { instance, authorizationMode, evidence, activatedAt, continuingFrom } =
    request;

  // -- the instance must be a genuinely connected instance (INV-C05) --------
  const isCatalogue = isProviderCatalogueEntry(instance);
  let instanceValid = false;
  if (isCatalogue) {
    checks.push(
      check(
        "connected-instance",
        false,
        "INV-C05: a provider catalogue entry is an advertisement and can never activate execution — a ConnectedCapabilityInstance scoped to a real account/tenant is required",
      ),
    );
  } else {
    try {
      validateConnectedCapabilityInstance(instance);
      instanceValid = true;
      checks.push(
        check(
          "connected-instance",
          true,
          "a validated ConnectedCapabilityInstance with account/tenant scope",
        ),
      );
    } catch (error) {
      checks.push(
        check(
          "connected-instance",
          false,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  // -- declared authorization mode ------------------------------------------
  const modeValid = isAuthorizationMode(authorizationMode);
  checks.push(
    check(
      "authorization-mode-declared",
      modeValid,
      modeValid
        ? `authorization mode ${authorizationMode}`
        : `authorization mode '${String(authorizationMode)}' is not one of [${AUTHORIZATION_MODES.join(", ")}]`,
    ),
  );

  // -- continuity with a prior record ---------------------------------------
  if (continuingFrom !== undefined) {
    const sameInstance = continuingFrom.instanceId === instance.instanceId;
    const sameProvider = continuingFrom.providerName === instance.providerName;
    const sameMode = continuingFrom.authorizationMode === authorizationMode;
    const legalContinue =
      (LEGAL_ACTIVATION_TRANSITIONS[continuingFrom.state] ?? []).includes(
        "ACTIVE",
      );
    checks.push(
      check(
        "continuity",
        sameInstance && sameProvider && sameMode && legalContinue,
        sameInstance && sameProvider && sameMode
          ? legalContinue
            ? `continuing ${continuingFrom.state} → ACTIVE`
            : `a ${continuingFrom.state} activation cannot transition to ACTIVE (legal: ${(LEGAL_ACTIVATION_TRANSITIONS[continuingFrom.state] ?? []).join(", ")})`
          : "the continuing record must reference the same instance, provider and authorization mode",
      ),
    );
    // A revoked authorization artifact can never be reused to reconnect.
    if (
      continuingFrom.state === "REVOKED" &&
      evidence.authorizationRef !== undefined &&
      continuingFrom.authorizationRef !== undefined &&
      evidence.authorizationRef === continuingFrom.authorizationRef
    ) {
      checks.push(
        check(
          "fresh-authorization-artifact",
          false,
          "the revoked authorization artifact cannot be reused — reconnection requires a FRESH authorization reference",
        ),
      );
    }
    // Reauthentication mints a NEW browser session reference.
    if (
      modeValid &&
      authorizationMode === "INTERACTIVE_BROWSER_SESSION" &&
      continuingFrom.browserSession !== undefined &&
      evidence.browserSession !== undefined &&
      evidence.browserSession.browserSessionRef ===
        continuingFrom.browserSession.browserSessionRef
    ) {
      checks.push(
        check(
          "fresh-authorization-artifact",
          false,
          "reauthentication must establish a NEW browser session reference in the isolated runtime",
        ),
      );
    }
  }

  // -- authorization state valid for the mode (fail-closed) -----------------
  const freshStatus = evidence.authorizationState?.status;
  const instanceStatus = instance.authorization?.status;
  const bothActive = freshStatus === "ACTIVE" && instanceStatus === "ACTIVE";
  checks.push(
    check(
      "authorization-state-active",
      bothActive,
      bothActive
        ? "authorization is ACTIVE both on the instance snapshot and in the fresh evidence"
        : `authorization must be ACTIVE for the selected auth mode (instance snapshot: ${String(instanceStatus)}, fresh evidence: ${String(freshStatus)})`,
    ),
  );

  // -- mode-specific evidence -------------------------------------------------
  if (modeValid) {
    switch (authorizationMode) {
      case "DELEGATED_OAUTH":
      case "SCOPED_API_CREDENTIAL":
      case "CONNECTED_ACCOUNT": {
        const hasRef = nonEmptyString(evidence.authorizationRef ?? "");
        checks.push(
          check(
            "mode-evidence",
            hasRef,
            hasRef
              ? `authorization artifact reference present (${authorizationMode})`
              : `${authorizationMode} requires an opaque authorization artifact reference`,
          ),
        );
        break;
      }
      case "INTERACTIVE_BROWSER_SESSION": {
        const session = evidence.browserSession;
        let passed = false;
        let detail: string;
        if (session === undefined) {
          detail =
            "INTERACTIVE_BROWSER_SESSION requires the browser-session authorization established by the isolated secure browser runtime";
        } else if (!isBrowserSessionUsable(session, activatedAt)) {
          detail = `browser session '${session.browserSessionRef}' is ${browserSessionStateAt(session, activatedAt)} at the activation instant — only an ACTIVE, unexpired session authorizes activation`;
        } else if (session.accountRef !== instance.accountRef) {
          detail = `browser session account '${session.accountRef}' does not match the instance account '${instance.accountRef}'`;
        } else if (session.providerName !== instance.providerName) {
          detail = `browser session provider '${session.providerName}' does not match the instance provider '${instance.providerName}'`;
        } else if (evidence.authorizationRef !== undefined) {
          detail =
            "INTERACTIVE_BROWSER_SESSION authorizes through the isolated browser runtime only — a parallel credential reference is ambiguous and refused";
        } else {
          passed = true;
          detail = `active browser session '${session.browserSessionRef}' for account '${session.accountRef}'`;
        }
        checks.push(check("mode-evidence", passed, detail));
        break;
      }
      case "PROVIDERLESS_RAIL": {
        if (evidence.providerlessRail === undefined) {
          checks.push(
            check(
              "mode-evidence",
              false,
              "PROVIDERLESS_RAIL requires the four-gate evidence: external capability, owner authorization, legal/security permissibility, evidence path",
            ),
          );
        } else {
          const gate = evaluateProviderlessRailGate(evidence.providerlessRail);
          for (const gateCheck of gate.checks) {
            checks.push(
              check(
                `providerless-rail-gate:${gateCheck.gate}`,
                gateCheck.passed,
                gateCheck.detail,
              ),
            );
          }
        }
        break;
      }
    }
  }

  // -- credential-scope consistency -------------------------------------------
  if (instanceValid) {
    const scope = instance.credentialScope;
    const kinds = MODE_CREDENTIAL_KINDS[authorizationMode];
    const kindOk =
      modeValid &&
      kinds !== undefined &&
      nonEmptyString(scope.credentialRef) &&
      kinds.includes(scope.credentialKind);
    checks.push(
      check(
        "credential-scope-consistency",
        kindOk === true,
        kindOk === true
          ? `credential scope ${scope.credentialKind} is consistent with ${authorizationMode}`
          : `credential scope (kind '${String(scope?.credentialKind)}') is inconsistent with ${String(authorizationMode)} — expected one of [${(kinds ?? []).join(", ")}] with a non-empty credentialRef`,
      ),
    );
  }

  // -- eligibility evidence ----------------------------------------------------
  const eligibility = instance.eligibility;
  const eligible =
    eligibility !== undefined &&
    eligibility !== null &&
    eligibility.eligible === true &&
    eligibility.reasons.length === 0;
  checks.push(
    check(
      "eligibility-evidence",
      eligible,
      eligible
        ? "the connected account is eligible with no disqualifying reasons"
        : `eligibility evidence required (eligible: ${String(eligibility?.eligible)}, reasons: ${String(eligibility?.reasons.join("; "))})`,
    ),
  );

  // -- explicit account/tenant/geography/currency/permission scope -------------
  const scopeExplicit =
    nonEmptyString(instance.accountRef) &&
    nonEmptyString(instance.tenantRef) &&
    (instance.geography?.countries?.length ?? 0) > 0 &&
    (instance.currencies?.length ?? 0) > 0;
  checks.push(
    check(
      "explicit-scope",
      scopeExplicit,
      scopeExplicit
        ? `account '${instance.accountRef}', tenant '${instance.tenantRef}', countries [${instance.geography.countries.join(", ")}], currencies [${instance.currencies.join(", ")}]`
        : "account, tenant, geography and currency scope must all be explicit and non-empty",
    ),
  );

  const permissionsComplete =
    instance.permissionState !== undefined &&
    instance.permissionState !== null &&
    (instance.permissionState.missing?.length ?? 0) === 0;
  checks.push(
    check(
      "permission-scope",
      permissionsComplete,
      permissionsComplete
        ? `granted permissions [${instance.permissionState.granted.join(", ")}] with none missing`
        : `missing permissions: [${String(instance.permissionState?.missing?.join(", ") ?? "unknown")}]`,
    ),
  );

  return Object.freeze({
    instanceId: instance.instanceId,
    authorizationMode,
    authorized: checks.every((c) => c.passed),
    checks: Object.freeze(checks),
  });
}

/** Raised when the activation gate refuses a transition (fail-closed). */
export class ActivationGateError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "ACTIVATION_GATE_FAILED",
      category: "AUTHORIZATION_REQUIRED" as ErrorCategory,
      message,
      details,
    });
  }
}

/** Raised when transfer-out (debit/withdrawal) authority is missing/lapsed. */
export class TransferOutNotAuthorizedError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "TRANSFER_OUT_NOT_AUTHORIZED",
      category: "AUTHORIZATION_REQUIRED" as ErrorCategory,
      message,
      details,
    });
  }
}

function connectionScopeOf(
  instance: ConnectedCapabilityInstance,
): ActivationConnectionScope {
  return Object.freeze({
    accountRef: instance.accountRef,
    tenantRef: instance.tenantRef,
    countries: Object.freeze([...instance.geography.countries]),
    currencies: Object.freeze([...instance.currencies]),
    grantedPermissions: Object.freeze([...instance.permissionState.granted]),
    missingPermissions: Object.freeze([...instance.permissionState.missing]),
    credentialRef: instance.credentialScope.credentialRef,
    credentialKind: instance.credentialScope.credentialKind,
    eligibilityReasons: Object.freeze([...instance.eligibility.reasons]),
  });
}

function applyTransition(
  record: ConnectedInstanceActivation,
  to: ConnectedInstanceActivationState,
  transition: ActivationTransitionInit,
  options: { readonly statePreserving?: boolean } = {},
): ConnectedInstanceActivation {
  if (options.statePreserving === true) {
    if (record.state !== to) {
      throw new ValidationError(
        `state-preserving activation events must not change state (${record.state} → ${to})`,
      );
    }
  } else {
    if (record.state === to) {
      throw new ValidationError(
        `activation transition must change state (${record.state} → ${to}) unless explicitly state-preserving`,
      );
    }
    const legal =
      LEGAL_ACTIVATION_TRANSITIONS[record.state] ?? Object.freeze([]);
    if (!legal.includes(to)) {
      throw new ValidationError(
        `illegal activation transition ${record.state} → ${to} for instance '${record.instanceId}' (legal: ${legal.join(", ")})`,
      );
    }
  }
  const entry: ActivationTransition = Object.freeze({
    from: record.state,
    to,
    ...transition,
  });
  return Object.freeze({
    ...record,
    state: to,
    history: Object.freeze([...record.history, entry]),
  });
}

/**
 * Registers a PENDING activation for a validated connected instance. The
 * record starts with an empty history: PENDING is the initial condition, and
 * every later transition is appended immutably.
 */
export function registerPendingActivation(
  instance: ConnectedCapabilityInstance,
  authorizationMode: AuthorizationMode,
  requestedAt: string,
): ConnectedInstanceActivation {
  if (isProviderCatalogueEntry(instance)) {
    throw new ValidationError(
      "INV-C05: a provider catalogue entry can never become an activation record",
    );
  }
  const validated = validateConnectedCapabilityInstance(instance);
  if (!isAuthorizationMode(authorizationMode)) {
    throw new ValidationError(
      `authorization mode '${String(authorizationMode)}' is not one of [${AUTHORIZATION_MODES.join(", ")}]`,
    );
  }
  if (!nonEmptyString(requestedAt)) {
    throw new ValidationError("requestedAt must be a non-empty timestamp");
  }
  return Object.freeze({
    instanceId: validated.instanceId,
    providerName: validated.providerName,
    capabilityId: validated.capabilityId,
    authorizationMode,
    state: "PENDING",
    connectionScope: connectionScopeOf(validated),
    history: Object.freeze([]),
  });
}

/**
 * Activates a connected capability instance: PENDING → ACTIVE through the
 * FULL fail-closed gate (or UNKNOWN → ACTIVE via reconciliation, or
 * PENDING → ACTIVE after reauthentication — always with fresh evidence).
 * The resulting record carries CONNECTION scope only: transfer-out authority
 * is never granted here (see authorizeTransferOut).
 */
export function activateConnectedInstance(
  request: ActivationRequest,
): ConnectedInstanceActivation {
  if (!nonEmptyString(request.activatedAt)) {
    throw new ValidationError("activatedAt must be a non-empty timestamp");
  }
  const report = evaluateActivationGate(request);
  if (!report.authorized) {
    const failed = report.checks.filter((c) => !c.passed);
    throw new ActivationGateError(
      `activation refused for instance '${report.instanceId}' (mode ${String(report.authorizationMode)}): ${failed.map((c) => `${c.requirement}: ${c.detail}`).join(" | ")}`,
      {
        instanceId: report.instanceId,
        failedRequirements: failed.map((c) => c.requirement),
      },
    );
  }
  const { instance, authorizationMode, evidence, activatedAt, continuingFrom } =
    request;
  const cause = request.activationCause ?? "AUTHORIZATION_EVIDENCE_VERIFIED";
  const base: ConnectedInstanceActivation =
    continuingFrom !== undefined
      ? continuingFrom
      : registerPendingActivation(instance, authorizationMode, activatedAt);
  const transition = applyTransition(base, "ACTIVE", {
    occurredAt: activatedAt,
    cause,
  });
  // Fail-closed: activation NEVER carries transfer-out authority. Any grant
  // from a lapsed/ambiguous episode is dropped — debit scope must be
  // re-authorized explicitly after reactivation (authorizeTransferOut).
  const { transferOut: _priorGrant, ...activated } = transition;
  return Object.freeze({
    ...activated,
    ...(evidence.authorizationRef !== undefined
      ? { authorizationRef: evidence.authorizationRef }
      : {}),
    ...(authorizationMode === "INTERACTIVE_BROWSER_SESSION" &&
    evidence.browserSession !== undefined
      ? { browserSession: evidence.browserSession }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Deactivation / revocation / expiry / ambiguity
// ---------------------------------------------------------------------------

export interface DeactivationInput {
  readonly at: string;
  readonly actor?: string;
  readonly reason: string;
}

/** Owner revocation path: the account owner withdraws the connection. */
export function revokeActivation(
  record: ConnectedInstanceActivation,
  input: DeactivationInput,
): ConnectedInstanceActivation {
  if (!nonEmptyString(input.reason)) {
    throw new ValidationError("a revocation reason is required");
  }
  return applyTransition(record, "REVOKED", {
    occurredAt: input.at,
    cause: "OWNER_REVOKED",
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    note: input.reason,
  });
}

/** Operator deactivation path (safe operator control). */
export function deactivateConnectedInstance(
  record: ConnectedInstanceActivation,
  input: DeactivationInput,
): ConnectedInstanceActivation {
  if (!nonEmptyString(input.reason)) {
    throw new ValidationError("a deactivation reason is required");
  }
  return applyTransition(record, "REVOKED", {
    occurredAt: input.at,
    cause: "OPERATOR_DEACTIVATED",
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    note: input.reason,
  });
}

/** Authorization expiry path (credential or browser session lapsed). */
export function expireActivation(
  record: ConnectedInstanceActivation,
  at: string,
  note?: string,
): ConnectedInstanceActivation {
  return applyTransition(record, "EXPIRED", {
    occurredAt: at,
    cause: "AUTHORIZATION_EXPIRED",
    ...(note !== undefined ? { note } : {}),
  });
}

/** Authorization becomes ambiguous → UNKNOWN, reconciliation required. */
export function markActivationUnknown(
  record: ConnectedInstanceActivation,
  at: string,
  note?: string,
): ConnectedInstanceActivation {
  return applyTransition(record, "UNKNOWN", {
    occurredAt: at,
    cause: "AUTHORIZATION_UNKNOWN",
    ...(note !== undefined ? { note } : {}),
  });
}

export type UnknownResolution = "AUTHORIZED" | "REVOKED" | "EXPIRED";

/**
 * Resolves an UNKNOWN activation — the reconciliation path (INV-X03).
 * "AUTHORIZED" is NOT honored here: re-activation with fresh evidence runs
 * the full gate (activateConnectedInstance with continuingFrom). This
 * function only records the terminal resolutions.
 */
export function resolveUnknownAuthorization(
  record: ConnectedInstanceActivation,
  resolution: Exclude<UnknownResolution, "AUTHORIZED">,
  input: DeactivationInput,
): ConnectedInstanceActivation {
  if (record.state !== "UNKNOWN") {
    throw new ValidationError(
      `only an UNKNOWN activation can be resolved (state is ${record.state})`,
    );
  }
  if (resolution === "REVOKED") {
    return applyTransition(record, "REVOKED", {
      occurredAt: input.at,
      cause: "RECONCILIATION_RESOLVED",
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      note: input.reason,
    });
  }
  return applyTransition(record, "EXPIRED", {
    occurredAt: input.at,
    cause: "RECONCILIATION_RESOLVED",
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    note: input.reason,
  });
}

/**
 * Reconnection path: a REVOKED or EXPIRED activation returns to PENDING
 * ONLY with a fresh authorization artifact reference — the lapsed artifact
 * cannot be reused.
 */
export function reconnectAuthorization(
  record: ConnectedInstanceActivation,
  freshAuthorizationRef: string,
  at: string,
): ConnectedInstanceActivation {
  if (record.state !== "REVOKED" && record.state !== "EXPIRED") {
    throw new ValidationError(
      `only a REVOKED or EXPIRED activation can reconnect (state is ${record.state})`,
    );
  }
  if (!nonEmptyString(freshAuthorizationRef)) {
    throw new ValidationError(
      "reconnection requires a fresh authorization artifact reference",
    );
  }
  if (freshAuthorizationRef === record.authorizationRef) {
    throw new ValidationError(
      "the lapsed authorization artifact cannot be reused — reconnection requires a FRESH reference",
    );
  }
  return applyTransition(record, "PENDING", {
    occurredAt: at,
    cause: "CONNECTION_REQUESTED",
    note: "reconnection requested with a fresh authorization artifact",
  });
}

// ---------------------------------------------------------------------------
// Browser-session ↔ activation synchronization (customer action states)
// ---------------------------------------------------------------------------

/**
 * Propagates a browser-session lifecycle change to the instance activation:
 * REAUTHENTICATION_REQUIRED / STEP_UP_REQUIRED move an ACTIVE activation to
 * PENDING with the customer-action requirement attached (the customer must
 * act in the isolated browser runtime); EXPIRED/REVOKED propagate verbatim.
 */
export function synchronizeBrowserSessionActivation(
  record: ConnectedInstanceActivation,
  session: BrowserSessionAuthorization,
  at: string,
): ConnectedInstanceActivation {
  if (record.authorizationMode !== "INTERACTIVE_BROWSER_SESSION") {
    throw new ValidationError(
      "browser-session synchronization applies only to INTERACTIVE_BROWSER_SESSION activations",
    );
  }
  if (session.browserSessionRef !== record.browserSession?.browserSessionRef) {
    throw new ValidationError(
      "the session does not belong to this activation (reference mismatch)",
    );
  }
  const withSession: ConnectedInstanceActivation = Object.freeze({
    ...record,
    browserSession: session,
  });
  const action = browserSessionCustomerAction(session);
  if (action !== undefined) {
    if (record.state !== "ACTIVE" && record.state !== "PENDING") {
      throw new ValidationError(
        `a ${session.state} session can only gate an ACTIVE or PENDING activation (state is ${record.state})`,
      );
    }
    return applyTransition(withSession, "PENDING", {
      occurredAt: at,
      cause:
        session.state === "REAUTHENTICATION_REQUIRED"
          ? "REAUTHENTICATION_REQUIRED"
          : "PROVIDER_STEP_UP_REQUIRED",
      customerAction: action,
    });
  }
  if (session.state === "EXPIRED" && (withSession.state === "ACTIVE" || withSession.state === "PENDING")) {
    return applyTransition(withSession, "EXPIRED", {
      occurredAt: at,
      cause: "AUTHORIZATION_EXPIRED",
      note: "browser session expired",
    });
  }
  if (session.state === "REVOKED" && withSession.state !== "REVOKED") {
    return applyTransition(withSession, "REVOKED", {
      occurredAt: at,
      cause: "OWNER_REVOKED",
      note: "browser session revoked",
    });
  }
  return withSession;
}

/** The outstanding customer action on an activation, if any. */
export function activationCustomerAction(
  record: ConnectedInstanceActivation,
): CustomerActionRequirement | undefined {
  if (record.state !== "PENDING") {
    return undefined;
  }
  const last = record.history[record.history.length - 1];
  return last?.customerAction;
}

// ---------------------------------------------------------------------------
// Transfer-out (debit/withdrawal) — a SEPARATE scope
// ---------------------------------------------------------------------------

/**
 * Grants transfer-out (debit/withdrawal) authority on an ACTIVE connection.
 * Fail-closed: the authorization artifact must be SEPARATE from the
 * connection's, the currency scope must be within the connection's, and
 * limits/expiry must be well-formed. Connecting an account never implies
 * this grant — it exists only after this explicit authorization.
 */
export function authorizeTransferOut(
  record: ConnectedInstanceActivation,
  request: TransferOutRequest,
): ConnectedInstanceActivation {
  if (record.state !== "ACTIVE") {
    throw new TransferOutNotAuthorizedError(
      `transfer-out can only be scoped on an ACTIVE connection (state is ${record.state})`,
    );
  }
  const errors: string[] = [];
  if (!nonEmptyString(request.authorizationRef)) {
    errors.push("a transfer-out authorization artifact reference is required");
  } else if (request.authorizationRef === record.authorizationRef) {
    errors.push(
      "transfer-out requires its OWN authorization artifact — the connection reference is not debit authority",
    );
  }
  if (!nonEmptyString(request.authorizedAt)) {
    errors.push("authorizedAt must be a non-empty timestamp");
  }
  if (
    request.expiresAt !== undefined &&
    (!nonEmptyString(request.expiresAt) || request.expiresAt <= request.authorizedAt)
  ) {
    errors.push("expiresAt, when present, must be after authorizedAt");
  }
  if (request.currencyScope.length === 0) {
    errors.push("currencyScope must be non-empty (explicit transfer-out scope)");
  }
  const outOfScope = request.currencyScope.filter(
    (currency) => !record.connectionScope.currencies.includes(currency),
  );
  if (outOfScope.length > 0) {
    errors.push(
      `transfer-out currency scope exceeds the connection scope: [${outOfScope.join(", ")}]`,
    );
  }
  if (
    request.maxSingleAmountMinor !== undefined &&
    (!Number.isSafeInteger(request.maxSingleAmountMinor) ||
      request.maxSingleAmountMinor <= 0)
  ) {
    errors.push("maxSingleAmountMinor must be a positive integer (minor units)");
  }
  if (
    request.cumulativeLimitMinor !== undefined &&
    (!Number.isSafeInteger(request.cumulativeLimitMinor) ||
      request.cumulativeLimitMinor <= 0)
  ) {
    errors.push("cumulativeLimitMinor must be a positive integer (minor units)");
  }
  if (typeof request.requiresProviderStepUp !== "boolean") {
    errors.push("requiresProviderStepUp must be an explicit boolean");
  }
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid transfer-out authorization for '${record.instanceId}': ${errors.join("; ")}`,
      { errors: [...errors] },
    );
  }
  const transferOut: TransferOutAuthorization = Object.freeze({
    grantedAt: request.authorizedAt,
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    authorizationRef: request.authorizationRef,
    currencyScope: Object.freeze([...request.currencyScope]),
    ...(request.maxSingleAmountMinor !== undefined
      ? { maxSingleAmountMinor: request.maxSingleAmountMinor }
      : {}),
    ...(request.cumulativeLimitMinor !== undefined
      ? { cumulativeLimitMinor: request.cumulativeLimitMinor }
      : {}),
    requiresProviderStepUp: request.requiresProviderStepUp,
  });
  const withGrant = Object.freeze({ ...record, transferOut });
  return applyTransition(withGrant, record.state, {
    occurredAt: request.authorizedAt,
    cause: "TRANSFER_OUT_AUTHORIZED",
    note: `transfer-out scope granted: [${transferOut.currencyScope.join(", ")}]`,
  }, { statePreserving: true });
}

/** Withdraws transfer-out authority (state-preserving, appended to history). */
export function revokeTransferOut(
  record: ConnectedInstanceActivation,
  at: string,
): ConnectedInstanceActivation {
  if (record.transferOut === undefined) {
    throw new ValidationError("no transfer-out authorization to revoke");
  }
  const { transferOut: _removed, ...rest } = record;
  return applyTransition(
    rest as ConnectedInstanceActivation,
    record.state,
    {
      occurredAt: at,
      cause: "TRANSFER_OUT_REVOKED",
      note: "transfer-out scope withdrawn",
    },
    { statePreserving: true },
  );
}

/** Whether transfer-out authority exists and is unexpired at `at`. */
export function hasTransferOutAuthority(
  record: ConnectedInstanceActivation,
  at: string,
): boolean {
  const grant = record.transferOut;
  if (grant === undefined) {
    return false;
  }
  if (record.state !== "ACTIVE") {
    return false;
  }
  return grant.expiresAt === undefined || at < grant.expiresAt;
}

/** Whether a pending transfer requires provider-native step-up. */
export function transferOutRequiresStepUp(
  record: ConnectedInstanceActivation,
): boolean {
  return record.transferOut?.requiresProviderStepUp === true;
}

/**
 * Execution-path assertion for transfer-out (debit/withdrawal): throws
 * TransferOutNotAuthorizedError unless a valid, unexpired, in-currency,
 * within-limits grant exists. CONNECTION SCOPE ALONE NEVER PASSES.
 */
export function assertTransferOutAuthorized(
  record: ConnectedInstanceActivation,
  at: string,
  execution?: {
    readonly currency?: string;
    readonly amountMinor?: number;
  },
): void {
  const grant = record.transferOut;
  if (grant === undefined) {
    throw new TransferOutNotAuthorizedError(
      `instance '${record.instanceId}' has connection scope only — connecting an account never grants debit/withdrawal authority (authorizeTransferOut is a separate, explicit authorization)`,
      { instanceId: record.instanceId },
    );
  }
  if (record.state !== "ACTIVE") {
    throw new TransferOutNotAuthorizedError(
      `transfer-out requires an ACTIVE connection (state is ${record.state})`,
    );
  }
  if (grant.expiresAt !== undefined && at >= grant.expiresAt) {
    throw new TransferOutNotAuthorizedError(
      `transfer-out authorization expired at ${grant.expiresAt}`,
    );
  }
  if (
    execution?.currency !== undefined &&
    !grant.currencyScope.includes(execution.currency)
  ) {
    throw new TransferOutNotAuthorizedError(
      `transfer-out is not authorized for currency '${execution.currency}' (scope: [${grant.currencyScope.join(", ")}])`,
    );
  }
  if (
    execution?.amountMinor !== undefined &&
    grant.maxSingleAmountMinor !== undefined &&
    execution.amountMinor > grant.maxSingleAmountMinor
  ) {
    throw new TransferOutNotAuthorizedError(
      `transfer-out amount ${execution.amountMinor} exceeds the per-transfer limit ${grant.maxSingleAmountMinor}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Executability — capability state and source availability stay DISTINCT
// ---------------------------------------------------------------------------

export interface ExecutionReadinessReport {
  readonly instanceId: string;
  readonly activationState: ConnectedInstanceActivationState;
  /** The observation's derived two-axis availability (INV-C01/INV-C02). */
  readonly availability: CapabilityObservation["availability"];
  readonly executable: boolean;
  readonly blockers: readonly string[];
}

/**
 * Evaluates whether an activation may execute RIGHT NOW against a
 * CapabilityObservation. The two axes stay distinct: an unreachable/unknown
 * source makes the execution NOT executable (availability UNKNOWN — never
 * success, never failure) but NEVER changes the activation state; the state
 * machine and the availability axis are evaluated independently.
 */
export function evaluateExecutionReadiness(
  record: ConnectedInstanceActivation,
  observation: CapabilityObservation,
): ExecutionReadinessReport {
  if (observation.instanceId !== record.instanceId) {
    throw new ValidationError(
      `observation instance '${observation.instanceId}' does not match activation '${record.instanceId}'`,
    );
  }
  const blockers: string[] = [];
  if (record.state !== "ACTIVE") {
    blockers.push(`activation-state:${record.state}`);
  }
  const action = activationCustomerAction(record);
  if (action !== undefined) {
    blockers.push(`customer-action-required:${action.lifecycleStep}`);
  }
  if (
    record.authorizationMode === "INTERACTIVE_BROWSER_SESSION" &&
    record.browserSession !== undefined &&
    !isBrowserSessionUsable(record.browserSession, observation.observedAt)
  ) {
    blockers.push(
      `browser-session:${browserSessionStateAt(record.browserSession, observation.observedAt)}`,
    );
  }
  if (observation.availability !== "AVAILABLE") {
    blockers.push(
      `availability:${observation.availability} (source ${observation.sourceAvailability} — INV-C02: unknown reachability is never success or failure)`,
    );
  }
  if (observation.eligibility !== "ELIGIBLE") {
    blockers.push(`eligibility:${observation.eligibility}`);
  }
  return Object.freeze({
    instanceId: record.instanceId,
    activationState: record.state,
    availability: observation.availability,
    executable: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

// ---------------------------------------------------------------------------
// Provider failure isolation
// ---------------------------------------------------------------------------

export type ProviderFailureScope = "INSTANCE" | "PROVIDER";

export interface ProviderFailureEvent {
  /** The instance that observed the failure. */
  readonly failingInstanceId: string;
  readonly providerName: string;
  readonly scope: ProviderFailureScope;
  readonly detectedAt: string;
  readonly note?: string;
}

export interface ProviderIsolationReport {
  readonly failingInstanceId: string;
  readonly providerName: string;
  readonly scope: ProviderFailureScope;
  /** Instances whose activation state changed. */
  readonly affectedInstanceIds: readonly string[];
  /**
   * Instances left untouched — the isolation proof. Their records are the
   * SAME object references as the inputs: a provider failure cannot disable
   * or degrade unrelated provider instances.
   */
  readonly isolatedInstanceIds: readonly string[];
  readonly activations: readonly ConnectedInstanceActivation[];
}

/**
 * Applies a provider failure with STRICT isolation: an INSTANCE-scoped
 * failure may only move the failing instance to UNKNOWN (authorization
 * became unverifiable — reconciliation territory); a PROVIDER-scoped outage
 * may only affect that provider's instances. Every other instance — same
 * provider or not — is returned UNCHANGED (identical object reference).
 * Availability degradation belongs to the observation axis, never here.
 */
export function applyProviderFailureIsolation(
  event: ProviderFailureEvent,
  activations: readonly ConnectedInstanceActivation[],
): ProviderIsolationReport {
  const errors: string[] = [];
  if (!nonEmptyString(event.failingInstanceId)) {
    errors.push("failingInstanceId must be non-empty");
  }
  if (!nonEmptyString(event.providerName)) {
    errors.push("providerName must be non-empty");
  }
  if (!nonEmptyString(event.detectedAt)) {
    errors.push("detectedAt must be a non-empty timestamp");
  }
  if (event.scope !== "INSTANCE" && event.scope !== "PROVIDER") {
    errors.push("scope must be INSTANCE or PROVIDER");
  }
  if (errors.length > 0) {
    throw new ValidationError(
      `Invalid provider failure event: ${errors.join("; ")}`,
    );
  }
  const known = activations.some(
    (record) => record.instanceId === event.failingInstanceId,
  );
  if (!known) {
    throw new ValidationError(
      `failing instance '${event.failingInstanceId}' has no activation record`,
    );
  }
  const affected: string[] = [];
  const next: ConnectedInstanceActivation[] = [];
  for (const record of activations) {
    const inScope =
      event.scope === "INSTANCE"
        ? record.instanceId === event.failingInstanceId
        : record.providerName === event.providerName;
    if (!inScope || record.state !== "ACTIVE") {
      next.push(record);
      continue;
    }
    affected.push(record.instanceId);
    next.push(
      applyTransition(record, "UNKNOWN", {
        occurredAt: event.detectedAt,
        cause: "PROVIDER_FAILURE_ISOLATED",
        note:
          event.note !== undefined
            ? `${event.scope}-scoped provider failure: ${event.note}`
            : `${event.scope}-scoped provider failure`,
      }),
    );
  }
  return Object.freeze({
    failingInstanceId: event.failingInstanceId,
    providerName: event.providerName,
    scope: event.scope,
    affectedInstanceIds: Object.freeze(affected),
    isolatedInstanceIds: Object.freeze(
      activations
        .filter((record) => !affected.includes(record.instanceId))
        .map((record) => record.instanceId),
    ),
    activations: Object.freeze(next),
  });
}
