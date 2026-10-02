/**
 * Coverage Gap Case workflow (P2-W1-003, Phase 2 Wave 3).
 *
 * Implements the Tier-C (gap-driven) layer of the provider coverage strategy
 * (spec/research/PROVIDER-COVERAGE-STRATEGY-2026-10-02.md): coverage is
 * EXECUTABLE — country × merchant domicile × shopper/beneficiary country ×
 * method × currency × direction × regulatory perimeter × connected-account
 * eligibility × health — and a provider catalogue is NEVER sufficient.
 *
 * A Coverage Gap Case is created whenever the executable matrix shows no
 * eligible pay-in/payout route, an unsupported local method/currency, an
 * unacceptable regulatory perimeter, insufficient capacity/health, poor
 * economics, or no credible fallback. The case identifies the NARROWEST
 * provider/rail addition needed.
 *
 * Laws encoded here:
 * - every country/method/currency/direction gap is representable (the
 *   dimension quadruple plus domicile/beneficiary context);
 * - gaps are classified by REGULATORY / CAPABILITY / COMMERCIAL / CAPACITY /
 *   RELIABILITY cause — deterministically, never by marketing claim;
 * - the workflow selects the narrowest provider/rail integration needed
 *   (tier 1..5 breadth ranking);
 * - direct local connectors are independently certified, and browser/session
 *   credentials stay inside the secure browser/credential boundary — the
 *   onboarding step list carries OPAQUE REFERENCES ONLY, never material;
 * - debit/withdrawal scope is explicitly authorized and CANNOT be inferred
 *   from account connection (the P2-W1-001 TransferOutAuthorization law,
 *   referenced by name — this package does not redefine it);
 * - NO "global coverage" claim can bypass the matrix (the no-bypass law);
 * - blocked/sanctioned/no-route cases are explicit (SanctionedMarketPolicy
 *   with the reason recorded; no hidden degradation).
 *
 * This module is deliberately self-contained (Stage-0 boundary: no
 * non-relative imports): the authorization-mode literals repeat the
 * P2-W1-001 vocabulary VALUES because @payswap/capabilities cannot import
 * @payswap/connectors — the strings are the wire contract, aligned by tests.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Every gap kind the executable matrix can surface. */
export const COVERAGE_GAP_KINDS = [
  "NO_PAY_IN_ROUTE",
  "NO_PAYOUT_ROUTE",
  "UNSUPPORTED_METHOD",
  "UNSUPPORTED_CURRENCY",
  "REGULATORY_PERIMETER",
  "CAPACITY_HEALTH",
  "ECONOMICS",
  "NO_FALLBACK",
] as const;
export type CoverageGapKind = (typeof COVERAGE_GAP_KINDS)[number];

/** The five cause classifications (work-order acceptance, exhaustive). */
export const COVERAGE_GAP_CAUSE_CLASSIFICATIONS = [
  "REGULATORY",
  "CAPABILITY",
  "COMMERCIAL",
  "CAPACITY",
  "RELIABILITY",
] as const;
export type CoverageGapCauseClassification =
  (typeof COVERAGE_GAP_CAUSE_CLASSIFICATIONS)[number];

/** Lifecycle of a gap case. */
export const COVERAGE_GAP_STATUSES = [
  "OPEN",
  "IN_ANALYSIS",
  "RESOLVED_BY_ROUTING",
  "RESOLVED_BY_CONNECTOR",
  "NOT_RESOLVABLE",
  "WITHDRAWN",
] as const;
export type CoverageGapStatus = (typeof COVERAGE_GAP_STATUSES)[number];

/**
 * The honest verdict vocabulary (strategy §honest verdicts). `AVAILABLE` is
 * only ever derived from an eligible matrix row — never from a provider's
 * global footprint.
 */
export const HONEST_COVERAGE_VERDICTS = [
  "AVAILABLE",
  "NOT_ELIGIBLE",
  "NOT_CONFIGURED",
  "UNAVAILABLE",
  "UNKNOWN",
  "COMPLIANCE_BLOCKED",
  "NO_VIABLE_ROUTE",
] as const;
export type HonestCoverageVerdict = (typeof HONEST_COVERAGE_VERDICTS)[number];

/**
 * The five authorization modes a direct local connector may use
 * (AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md; the P2-W1-001 literal values).
 */
export const DIRECT_LOCAL_AUTHORIZATION_MODES = [
  "DELEGATED_OAUTH",
  "CONNECTED_ACCOUNT",
  "SCOPED_API_CREDENTIAL",
  "INTERACTIVE_BROWSER_SESSION",
  "PROVIDERLESS_RAIL",
] as const;
export type DirectLocalAuthorizationMode =
  (typeof DIRECT_LOCAL_AUTHORIZATION_MODES)[number];

// ---------------------------------------------------------------------------
// Validation helpers (module-private)
// ---------------------------------------------------------------------------

export class CoverageGapValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageGapValidationError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => isNonEmptyString(entry))
  );
}

function isISODate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
}

function assertMember<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
  label: string,
): T {
  if (
    typeof value === "string" &&
    (vocabulary as readonly string[]).includes(value)
  ) {
    return value as T;
  }
  throw new CoverageGapValidationError(
    `${label} must be one of [${vocabulary.join(", ")}] (got: ${String(value)})`,
  );
}

// ---------------------------------------------------------------------------
// The gap dimension (country/method/currency/direction quadruple)
// ---------------------------------------------------------------------------

export const COVERAGE_DIRECTIONS = ["PAY_IN", "PAY_OUT"] as const;
export type CoverageDirection = (typeof COVERAGE_DIRECTIONS)[number];

/**
 * WHERE the gap is observed: the country/method/currency/direction quadruple
 * plus the domicile/beneficiary context the strategy's executable matrix
 * dimensions require. All four core dimensions are REQUIRED — a gap that
 * cannot name them is not representable and therefore not a gap case.
 */
export interface CoverageGapDimension {
  /** ISO 3166-1 alpha-2 market where the gap is observed (e.g. "GH"). */
  readonly country: string;
  /** Payment method id (e.g. "card", "mobile_money", "bank_transfer", "stellar_usdc"). */
  readonly method: string;
  /** ISO 4217 currency or asset code (e.g. "GHS", "KES", "USDC"). */
  readonly currency: string;
  readonly direction: CoverageDirection;
  /** Merchant domicile when the matrix records it (strategy dimension). */
  readonly merchantDomicile?: string;
  /** Shopper/beneficiary country when the matrix records it (strategy dimension). */
  readonly shopperBeneficiaryCountry?: string;
}

/** Validates the dimension quadruple (fail-closed on unnamed dimensions). */
export function validateCoverageGapDimension(
  candidate: unknown,
): CoverageGapDimension {
  if (candidate === null || typeof candidate !== "object") {
    throw new CoverageGapValidationError("coverage gap dimension must be an object");
  }
  const dimension = candidate as Partial<CoverageGapDimension>;
  const errors: string[] = [];
  const { country, method, currency, direction } = dimension;
  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) {
    errors.push("country must be an ISO 3166-1 alpha-2 code");
  }
  if (!isNonEmptyString(method)) {
    errors.push("method must be a non-empty string");
  }
  if (typeof currency !== "string" || !/^[A-Z]{3,12}$/.test(currency)) {
    errors.push("currency must be an ISO 4217 or asset code (A-Z, 3-12 chars)");
  }
  if (direction !== "PAY_IN" && direction !== "PAY_OUT") {
    errors.push("direction must be PAY_IN or PAY_OUT");
  }
  if (
    dimension.merchantDomicile !== undefined &&
    !/^[A-Z]{2}$/.test(dimension.merchantDomicile)
  ) {
    errors.push("merchantDomicile, when present, must be an ISO alpha-2 code");
  }
  if (
    dimension.shopperBeneficiaryCountry !== undefined &&
    !/^[A-Z]{2}$/.test(dimension.shopperBeneficiaryCountry)
  ) {
    errors.push("shopperBeneficiaryCountry, when present, must be an ISO alpha-2 code");
  }
  if (errors.length > 0) {
    throw new CoverageGapValidationError(
      `invalid coverage gap dimension: ${errors.join("; ")}`,
    );
  }
  return Object.freeze({
    country,
    method,
    currency,
    direction,
    ...(dimension.merchantDomicile !== undefined
      ? { merchantDomicile: dimension.merchantDomicile }
      : {}),
    ...(dimension.shopperBeneficiaryCountry !== undefined
      ? { shopperBeneficiaryCountry: dimension.shopperBeneficiaryCountry }
      : {}),
  } as CoverageGapDimension);
}

// ---------------------------------------------------------------------------
// The gap case record
// ---------------------------------------------------------------------------

/** One evidence reference backing a gap case (refs only — never material). */
export interface CoverageGapEvidenceRef {
  /** Opaque reference (probe record, matrix row, policy document, …). */
  readonly evidenceRef: string;
  readonly note?: string;
}

/** How a gap case was resolved (required for the RESOLVED_* statuses). */
export interface CoverageGapResolution {
  readonly resolvedAt: string;
  readonly resolutionKind: "ROUTING" | "CONNECTOR";
  /** Matrix route_id for RESOLVED_BY_ROUTING. */
  readonly routeRef?: string;
  /** The connector integration that closed the gap, for RESOLVED_BY_CONNECTOR. */
  readonly integration?: NarrowestIntegrationSelection;
  readonly note?: string;
}

/**
 * The Coverage Gap Case record (Tier C). Immutable after construction;
 * lifecycle transitions produce NEW records (append-only history is the
 * caller's ledger discipline, as in the certification module).
 */
export interface CoverageGapCase {
  readonly caseId: string;
  readonly dimension: CoverageGapDimension;
  readonly gapKind: CoverageGapKind;
  readonly causeClassification: CoverageGapCauseClassification;
  readonly evidence: readonly CoverageGapEvidenceRef[];
  readonly status: CoverageGapStatus;
  readonly createdAt: string;
  readonly resolution?: CoverageGapResolution;
}

/** Input to `openCoverageGapCase`. */
export interface OpenCoverageGapCaseInput {
  readonly caseId: string;
  readonly dimension: unknown;
  readonly gapKind: CoverageGapKind;
  readonly causeClassification?: CoverageGapCauseClassification;
  readonly evidence?: readonly CoverageGapEvidenceRef[];
  readonly createdAt: string;
}

/** Creates a gap case in the OPEN status (the Tier-C entry point). */
export function openCoverageGapCase(
  input: OpenCoverageGapCaseInput,
): CoverageGapCase {
  if (!isNonEmptyString(input.caseId)) {
    throw new CoverageGapValidationError("caseId must be a non-empty string");
  }
  if (!isISODate(input.createdAt)) {
    throw new CoverageGapValidationError("createdAt must be an ISO-8601 timestamp");
  }
  const gapKind = assertMember(
    input.gapKind,
    COVERAGE_GAP_KINDS,
    "gapKind",
  );
  const dimension = validateCoverageGapDimension(input.dimension);
  const evidence = input.evidence ?? [];
  if (!isStringArray(evidence.map((entry) => entry?.evidenceRef))) {
    throw new CoverageGapValidationError(
      "evidence must carry non-empty opaque references",
    );
  }
  const cause =
    input.causeClassification ??
    classifyCoverageGapCause({ gapKind });
  assertMember(
    cause,
    COVERAGE_GAP_CAUSE_CLASSIFICATIONS,
    "causeClassification",
  );
  return Object.freeze({
    caseId: input.caseId,
    dimension,
    gapKind,
    causeClassification: cause,
    evidence: Object.freeze([...evidence]),
    status: "OPEN",
    createdAt: input.createdAt,
  });
}

// ---------------------------------------------------------------------------
// Cause classification (deterministic table + refinements)
// ---------------------------------------------------------------------------

/**
 * Structured cause inputs. All flags are optional evidence about WHY the
 * matrix shows the gap; the classifier is deterministic and total over them.
 */
export interface CoverageGapCauseInput {
  readonly gapKind: CoverageGapKind;
  /** The market is COMPLIANCE_BLOCKED (sanctioned / unacceptable perimeter). */
  readonly complianceBlocked?: boolean;
  /** No provider offers the method/currency at all — a capability void. */
  readonly capabilityVoid?: boolean;
  /** Routes exist but capacity or health excludes them. */
  readonly capacityOrHealthLimited?: boolean;
  /** Providers exist but their reliability history excludes them. */
  readonly unreliable?: boolean;
  /** Routes exist but the economics were rejected. */
  readonly uneconomical?: boolean;
}

/**
 * The default classification table: gapKind → cause classification in the
 * absence of overriding evidence. Exported so the classification acceptance
 * is testable as a table.
 */
export function coverageGapCauseTable(): Readonly<
  Record<CoverageGapKind, CoverageGapCauseClassification>
> {
  return Object.freeze({
    NO_PAY_IN_ROUTE: "CAPABILITY",
    NO_PAYOUT_ROUTE: "CAPABILITY",
    UNSUPPORTED_METHOD: "CAPABILITY",
    UNSUPPORTED_CURRENCY: "CAPABILITY",
    REGULATORY_PERIMETER: "REGULATORY",
    CAPACITY_HEALTH: "CAPACITY",
    ECONOMICS: "COMMERCIAL",
    NO_FALLBACK: "RELIABILITY",
  });
}

/**
 * Deterministic cause classification:
 * 1. a compliance-blocked market is REGULATORY — always, regardless of the
 *    gap kind (sanctions dominate; no hidden degradation);
 * 2. REGULATORY_PERIMETER / CAPACITY_HEALTH / ECONOMICS map by their kind
 *    (the table above);
 * 3. the route-shaped kinds (NO_*_ROUTE / UNSUPPORTED_* / NO_FALLBACK) take
 *    the strongest evidenced refinement in the fixed order CAPACITY →
 *    RELIABILITY → COMMERCIAL, defaulting to CAPABILITY.
 */
export function classifyCoverageGapCause(
  input: CoverageGapCauseInput,
): CoverageGapCauseClassification {
  if (input.complianceBlocked === true) {
    return "REGULATORY";
  }
  switch (input.gapKind) {
    case "REGULATORY_PERIMETER":
      return "REGULATORY";
    case "CAPACITY_HEALTH":
      return "CAPACITY";
    case "ECONOMICS":
      return "COMMERCIAL";
    case "NO_PAY_IN_ROUTE":
    case "NO_PAYOUT_ROUTE":
    case "UNSUPPORTED_METHOD":
    case "UNSUPPORTED_CURRENCY":
    case "NO_FALLBACK":
      if (input.capacityOrHealthLimited === true) {
        return "CAPACITY";
      }
      if (input.unreliable === true) {
        return "RELIABILITY";
      }
      if (input.uneconomical === true) {
        return "COMMERCIAL";
      }
      return "CAPABILITY";
  }
}

// ---------------------------------------------------------------------------
// Gap case lifecycle transitions
// ---------------------------------------------------------------------------

/**
 * Legal status transitions. OPEN → IN_ANALYSIS → {RESOLVED_BY_ROUTING,
 * RESOLVED_BY_CONNECTOR, NOT_RESOLVABLE}; WITHDRAWN is reachable from any
 * non-terminal status (the operator withdraws the case); every RESOLVED_* /
 * NOT_RESOLVABLE / WITHDRAWN state is terminal.
 */
export const LEGAL_COVERAGE_GAP_TRANSITIONS: Readonly<
  Record<CoverageGapStatus, readonly CoverageGapStatus[]>
> = Object.freeze({
  OPEN: Object.freeze(["IN_ANALYSIS", "WITHDRAWN"] as const),
  IN_ANALYSIS: Object.freeze([
    "RESOLVED_BY_ROUTING",
    "RESOLVED_BY_CONNECTOR",
    "NOT_RESOLVABLE",
    "WITHDRAWN",
  ] as const),
  RESOLVED_BY_ROUTING: Object.freeze([] as const),
  RESOLVED_BY_CONNECTOR: Object.freeze([] as const),
  NOT_RESOLVABLE: Object.freeze([] as const),
  WITHDRAWN: Object.freeze([] as const),
});

/** Applies a lifecycle transition, producing the NEXT immutable record. */
export function transitionCoverageGapCase(
  gap: CoverageGapCase,
  next: CoverageGapStatus,
  resolution?: CoverageGapResolution,
): CoverageGapCase {
  const legal = LEGAL_COVERAGE_GAP_TRANSITIONS[gap.status] ?? Object.freeze([]);
  if (!legal.includes(next)) {
    throw new CoverageGapValidationError(
      `illegal coverage gap case transition ${gap.status} → ${next} (case '${gap.caseId}')`,
    );
  }
  if (
    (next === "RESOLVED_BY_ROUTING" || next === "RESOLVED_BY_CONNECTOR") &&
    resolution === undefined
  ) {
    throw new CoverageGapValidationError(
      `transition to ${next} requires a resolution record (case '${gap.caseId}')`,
    );
  }
  if (
    (next === "RESOLVED_BY_ROUTING" && resolution?.resolutionKind !== "ROUTING") ||
    (next === "RESOLVED_BY_CONNECTOR" && resolution?.resolutionKind !== "CONNECTOR")
  ) {
    throw new CoverageGapValidationError(
      `resolution kind must match the transition target (case '${gap.caseId}')`,
    );
  }
  return Object.freeze({
    ...gap,
    status: next,
    ...(resolution !== undefined ? { resolution } : {}),
  });
}

// ---------------------------------------------------------------------------
// Narrowest integration selection (tiers 1..5 by breadth)
// ---------------------------------------------------------------------------

/** Integration breadth tiers: 1 = narrowest, 5 = broadest. */
export const INTEGRATION_OPTION_TIERS = [1, 2, 3, 4, 5] as const;
export type IntegrationOptionTier = (typeof INTEGRATION_OPTION_TIERS)[number];

/** The canonical tier labels (work-order acceptance). */
export const INTEGRATION_TIER_LABELS: Readonly<
  Record<IntegrationOptionTier, string>
> = Object.freeze({
  1: "existing connected instance reconfiguration",
  2: "eligibility extension on an existing provider",
  3: "new authorization mode on an existing provider",
  4: "aggregator provider addition",
  5: "direct local connector",
});

/** One candidate integration option for closing a gap. */
export interface IntegrationOption {
  readonly optionId: string;
  readonly tier: IntegrationOptionTier;
  readonly providerName?: string;
  readonly railId?: string;
  /** Authorization mode the option would use (e.g. tier 3 → INTERACTIVE_BROWSER_SESSION). */
  readonly authorizationMode?: DirectLocalAuthorizationMode;
  /** Whether the option is actually available to pursue (eligible + evidence). */
  readonly available: boolean;
  readonly unavailabilityReason?: string;
}

/** One ranked option with its deterministic rank position. */
export interface RankedIntegrationOption {
  readonly option: IntegrationOption;
  readonly rank: number;
  readonly reason: string;
}

/** The selection product: the narrowest AVAILABLE option, with the ranking. */
export interface NarrowestIntegrationSelection {
  readonly caseId: string;
  readonly selected: IntegrationOption | undefined;
  readonly ranking: readonly RankedIntegrationOption[];
  readonly reason: string;
  readonly verdict: "SELECTION_MADE" | "NO_VIABLE_OPTION";
}

function validateIntegrationOption(option: unknown): IntegrationOption {
  if (option === null || typeof option !== "object") {
    throw new CoverageGapValidationError("integration option must be an object");
  }
  const candidate = option as Partial<IntegrationOption>;
  if (!isNonEmptyString(candidate.optionId)) {
    throw new CoverageGapValidationError("integration option requires optionId");
  }
  const tier = candidate.tier;
  if (
    typeof tier !== "number" ||
    !INTEGRATION_OPTION_TIERS.includes(tier as IntegrationOptionTier)
  ) {
    throw new CoverageGapValidationError(
      `integration option '${candidate.optionId}' requires tier 1..5`,
    );
  }
  if (typeof candidate.available !== "boolean") {
    throw new CoverageGapValidationError(
      `integration option '${candidate.optionId}' requires an explicit availability verdict`,
    );
  }
  if (
    candidate.authorizationMode !== undefined &&
    !DIRECT_LOCAL_AUTHORIZATION_MODES.includes(candidate.authorizationMode)
  ) {
    throw new CoverageGapValidationError(
      `integration option '${candidate.optionId}' has an unknown authorization mode`,
    );
  }
  return Object.freeze({
    optionId: candidate.optionId,
    tier: tier as IntegrationOptionTier,
    ...(candidate.providerName !== undefined
      ? { providerName: candidate.providerName }
      : {}),
    ...(candidate.railId !== undefined ? { railId: candidate.railId } : {}),
    ...(candidate.authorizationMode !== undefined
      ? { authorizationMode: candidate.authorizationMode }
      : {}),
    available: candidate.available,
    ...(candidate.unavailabilityReason !== undefined
      ? { unavailabilityReason: candidate.unavailabilityReason }
      : {}),
  });
}

/**
 * Ranks the integration options by breadth (tier ascending — the NARROWEST
 * first) and selects the narrowest AVAILABLE one. Tie-breaks inside a tier
 * are deterministic: optionId lexicographic order. When no option is
 * available the verdict is NO_VIABLE_OPTION — never a defaulted selection.
 */
export function selectNarrowestIntegration(
  gap: CoverageGapCase,
  options: readonly IntegrationOption[],
): NarrowestIntegrationSelection {
  if (gap === null || typeof gap !== "object") {
    throw new CoverageGapValidationError("selectNarrowestIntegration requires a gap case");
  }
  const validated = options.map((option) => validateIntegrationOption(option));
  const sorted = [...validated].sort((a, b) =>
    a.tier !== b.tier ? a.tier - b.tier : a.optionId < b.optionId ? -1 : 1,
  );
  const ranking: RankedIntegrationOption[] = sorted.map((option, index) => ({
    option,
    rank: index + 1,
    reason: option.available
      ? `tier ${option.tier} (${INTEGRATION_TIER_LABELS[option.tier]}) — available`
      : `tier ${option.tier} (${INTEGRATION_TIER_LABELS[option.tier]}) — unavailable: ${
          option.unavailabilityReason ?? "no reason recorded"
        }`,
  }));
  const selected = sorted.find((option) => option.available);
  if (selected === undefined) {
    return Object.freeze({
      caseId: gap.caseId,
      selected: undefined,
      ranking: Object.freeze(ranking),
      reason:
        "no viable integration option is available for this gap — the case proceeds to NOT_RESOLVABLE or stays open with the recorded cause",
      verdict: "NO_VIABLE_OPTION",
    });
  }
  return Object.freeze({
    caseId: gap.caseId,
    selected,
    ranking: Object.freeze(ranking),
    reason: `narrowest integration needed: tier ${selected.tier} (${INTEGRATION_TIER_LABELS[selected.tier]})${
      selected.providerName !== undefined ? ` via ${selected.providerName}` : ""
    } — broader options are ranked but NOT selected while a narrower one is available`,
    verdict: "SELECTION_MADE",
  });
}

// ---------------------------------------------------------------------------
// Direct local connector onboarding path
// ---------------------------------------------------------------------------

/** The declared onboarding path shape for a direct local connector. */
export interface DirectLocalOnboardingPath {
  readonly connectorName: string;
  readonly authorizationMode: DirectLocalAuthorizationMode;
  /** True only for INTERACTIVE_BROWSER_SESSION (validated, not assumed). */
  readonly browserSessionRequired: boolean;
  /** Debit/withdrawal scope must be requested explicitly; never inferred. */
  readonly debitScopeRequired: boolean;
  /** Direct local connectors are independently certified (acceptance). */
  readonly certificationRequired: boolean;
}

/**
 * Validates the onboarding path shape. The browser-session requirement is
 * DERIVED from the authorization mode (INTERACTIVE_BROWSER_SESSION ⟺
 * browserSessionRequired) — a path that declares otherwise is rejected, so
 * no connector can quietly claim it needs no browser boundary while using
 * session credentials.
 */
export function validateDirectLocalOnboardingPath(
  candidate: unknown,
): DirectLocalOnboardingPath {
  if (candidate === null || typeof candidate !== "object") {
    throw new CoverageGapValidationError("onboarding path must be an object");
  }
  const path = candidate as Partial<DirectLocalOnboardingPath>;
  if (!isNonEmptyString(path.connectorName)) {
    throw new CoverageGapValidationError("onboarding path requires connectorName");
  }
  const authorizationMode = assertMember(
    path.authorizationMode,
    DIRECT_LOCAL_AUTHORIZATION_MODES,
    "authorizationMode",
  );
  if (typeof path.browserSessionRequired !== "boolean") {
    throw new CoverageGapValidationError("browserSessionRequired must be boolean");
  }
  if (typeof path.debitScopeRequired !== "boolean") {
    throw new CoverageGapValidationError("debitScopeRequired must be boolean");
  }
  if (typeof path.certificationRequired !== "boolean") {
    throw new CoverageGapValidationError("certificationRequired must be boolean");
  }
  const browserSessionDerived = authorizationMode === "INTERACTIVE_BROWSER_SESSION";
  if (path.browserSessionRequired !== browserSessionDerived) {
    throw new CoverageGapValidationError(
      `browserSessionRequired must be ${browserSessionDerived} for ${authorizationMode} — the browser-session requirement is derived from the authorization mode, never declared independently`,
    );
  }
  return Object.freeze({
    connectorName: path.connectorName,
    authorizationMode,
    browserSessionRequired: path.browserSessionRequired,
    debitScopeRequired: path.debitScopeRequired,
    certificationRequired: path.certificationRequired,
  });
}

/** The ordered onboarding steps (work-order acceptance, fixed order). */
export const DIRECT_LOCAL_ONBOARDING_STEPS = [
  "ACCOUNT_OWNER_AUTHORIZATION",
  "EXPLICIT_DEBIT_SCOPE",
  "CONNECTOR_CERTIFICATION",
  "CAPABILITY_INSTANCE_CREATION",
  "OBSERVATION",
] as const;
export type DirectLocalOnboardingStepName =
  (typeof DIRECT_LOCAL_ONBOARDING_STEPS)[number];

/** Gate state of one onboarding step. */
export interface OnboardingStepGate {
  readonly step: DirectLocalOnboardingStepName;
  readonly order: number;
  readonly required: boolean;
  readonly gateState: "SATISFIED" | "REQUIRED_UNSATISFIED";
  /** Opaque reference ONLY — credential/session material never appears. */
  readonly evidenceRef?: string;
  readonly lawNote: string;
}

/** The dependency surface `onboardDirectLocalConnector` consumes. */
export interface DirectLocalOnboardingDeps {
  /**
   * Owner authorization evidence — an opaque artifact reference
   * (DELEGATED_OAUTH / CONNECTED_ACCOUNT / SCOPED_API_CREDENTIAL /
   * PROVIDERLESS_RAIL) or a browser-session reference
   * (INTERACTIVE_BROWSER_SESSION). The VALUES behind these references live
   * in the credential/browser boundary and are structurally absent here.
   */
  readonly ownerAuthorization?:
    | { readonly artifactRef: string }
    | { readonly browserSessionRef: string };
  /**
   * The SEPARATE debit/withdrawal authorization artifact (the P2-W1-001
   * TransferOutAuthorization law by reference). Required exactly when the
   * path declares debitScopeRequired.
   */
  readonly debitScopeAuthorization?: { readonly authorizationRef: string };
  /** Independent certification evidence for the connector. */
  readonly certification?: { readonly certificationRef: string };
  /** The created ConnectedCapabilityInstance reference. */
  readonly capabilityInstance?: { readonly instanceRef: string };
  /** First observation evidence of the live connector behavior. */
  readonly observation?: { readonly observationRef: string };
}

/** The onboarding plan product. */
export interface DirectLocalOnboardingPlan {
  readonly path: DirectLocalOnboardingPath;
  readonly steps: readonly OnboardingStepGate[];
  readonly allGatesSatisfied: boolean;
  readonly missingGates: readonly DirectLocalOnboardingStepName[];
  /**
   * Structural law: browser/session credentials stay inside the secure
   * browser/credential boundary — the plan can only ever reference opaque
   * refs, so this is a constant, not a computed property.
   */
  readonly credentialBoundary: "SECURE_BROWSER_OR_VAULT_ONLY";
  /**
   * The owner's login/MFA established the authorization ONCE; it is NOT
   * repeated per transaction. Reauthentication happens only when the
   * provider requires it or policy requires step-up (the P2-W1-001
   * REAUTHENTICATION_REQUIRED / STEP_UP_REQUIRED states, consumed by
   * reference).
   */
  readonly perTransactionReauthentication: false;
}

function ownerAuthorizationRef(deps: DirectLocalOnboardingDeps): string | undefined {
  if (deps.ownerAuthorization === undefined) {
    return undefined;
  }
  if ("browserSessionRef" in deps.ownerAuthorization) {
    return deps.ownerAuthorization.browserSessionRef;
  }
  return deps.ownerAuthorization.artifactRef;
}

/**
 * Builds the ordered onboarding step list with gate states. Steps run in the
 * fixed work-order order: account-owner authorization (login/MFA inside the
 * secure browser boundary — NEVER agent-visible), explicit debit/withdrawal
 * scope grant (only when the path requires it; NEVER inferable from the
 * connection), independent connector certification, capability instance
 * creation, observation. A step is SATISFIED only when its evidence dep is
 * present; the plan reports the first missing gates without fabricating any
 * state.
 */
export function onboardDirectLocalConnector(
  path: unknown,
  deps: DirectLocalOnboardingDeps,
): DirectLocalOnboardingPlan {
  const validatedPath = validateDirectLocalOnboardingPath(path);
  const ownerRef = ownerAuthorizationRef(deps);
  const steps: OnboardingStepGate[] = [];

  steps.push({
    step: "ACCOUNT_OWNER_AUTHORIZATION",
    order: 1,
    required: true,
    gateState: ownerRef !== undefined ? "SATISFIED" : "REQUIRED_UNSATISFIED",
    ...(ownerRef !== undefined ? { evidenceRef: ownerRef } : {}),
    lawNote:
      validatedPath.authorizationMode === "INTERACTIVE_BROWSER_SESSION"
        ? "the account owner logs in with MFA inside the isolated secure browser runtime; cookies/storage/credential fields never cross into model context — only the opaque browser-session reference exists here"
        : `the account owner establishes authorization for ${validatedPath.authorizationMode}; the artifact material stays inside the credential boundary — only the opaque reference exists here`,
  });

  steps.push({
    step: "EXPLICIT_DEBIT_SCOPE",
    order: 2,
    required: validatedPath.debitScopeRequired,
    gateState: !validatedPath.debitScopeRequired
      ? "SATISFIED"
      : deps.debitScopeAuthorization !== undefined
        ? "SATISFIED"
        : "REQUIRED_UNSATISFIED",
    ...(deps.debitScopeAuthorization !== undefined
      ? { evidenceRef: deps.debitScopeAuthorization.authorizationRef }
      : {}),
    lawNote:
      "debit/withdrawal scope is a SEPARATE explicit authorization artifact (the P2-W1-001 TransferOutAuthorization law): it cannot be inferred from account connection, and connection alone never grants transfer-out authority",
  });

  steps.push({
    step: "CONNECTOR_CERTIFICATION",
    order: 3,
    required: validatedPath.certificationRequired,
    gateState: !validatedPath.certificationRequired
      ? "SATISFIED"
      : deps.certification !== undefined
        ? "SATISFIED"
        : "REQUIRED_UNSATISFIED",
    ...(deps.certification !== undefined
      ? { evidenceRef: deps.certification.certificationRef }
      : {}),
    lawNote:
      "direct local connectors are independently certified before activation — the certification is its own evidence artifact, never a side effect of the connection",
  });

  steps.push({
    step: "CAPABILITY_INSTANCE_CREATION",
    order: 4,
    required: true,
    gateState:
      deps.capabilityInstance !== undefined ? "SATISFIED" : "REQUIRED_UNSATISFIED",
    ...(deps.capabilityInstance !== undefined
      ? { evidenceRef: deps.capabilityInstance.instanceRef }
      : {}),
    lawNote:
      "a ConnectedCapabilityInstance is created only after the authorization and scope gates — a provider catalogue entry alone authorizes nothing",
  });

  steps.push({
    step: "OBSERVATION",
    order: 5,
    required: true,
    gateState: deps.observation !== undefined ? "SATISFIED" : "REQUIRED_UNSATISFIED",
    ...(deps.observation !== undefined
      ? { evidenceRef: deps.observation.observationRef }
      : {}),
    lawNote:
      "the live connector behavior is observed with real external evidence before the onboarding is considered complete (honest verdicts; UNKNOWN never success/failure)",
  });

  const missingGates = steps
    .filter((step) => step.gateState === "REQUIRED_UNSATISFIED")
    .map((step) => step.step);

  return Object.freeze({
    path: validatedPath,
    steps: Object.freeze(steps),
    allGatesSatisfied: missingGates.length === 0,
    missingGates: Object.freeze(missingGates),
    credentialBoundary: "SECURE_BROWSER_OR_VAULT_ONLY",
    perTransactionReauthentication: false,
  });
}

// ---------------------------------------------------------------------------
// The debit-scope-not-inferable law (executable)
// ---------------------------------------------------------------------------

/**
 * The connection-scope side of a connected instance as this law sees it.
 * `transferOutAuthorizationRef` is the SEPARATE artifact; its absence means
 * transfer-out is NOT granted — structurally, not by policy convention.
 */
export interface ConnectedInstanceScopeView {
  readonly instanceRef: string;
  /** The connection's own authorization artifact reference. */
  readonly connectionAuthorizationRef?: string;
  /** The SEPARATE transfer-out/debit authorization artifact reference. */
  readonly transferOutAuthorizationRef?: string;
  readonly transferOutCurrencyScope?: readonly string[];
}

/** The honest answer to "may this connection move funds out?". */
export type TransferOutScopeVerdict =
  | { readonly granted: false; readonly reason: string }
  | {
      readonly granted: true;
      readonly transferOutAuthorizationRef: string;
      readonly currencyScope: readonly string[];
    };

/**
 * THE LAW, executable: debit/withdrawal authority is granted ONLY by the
 * separate transfer-out artifact. A connection artifact, however complete,
 * never grants it; the same reference can never serve as both artifacts
 * (the P2-W1-001 TransferOutAuthorization separation).
 */
export function explicitTransferOutScope(
  instance: ConnectedInstanceScopeView,
): TransferOutScopeVerdict {
  if (!isNonEmptyString(instance.instanceRef)) {
    throw new CoverageGapValidationError("instanceRef must be a non-empty string");
  }
  const transferRef = instance.transferOutAuthorizationRef;
  if (transferRef === undefined || transferRef.length === 0) {
    return Object.freeze({
      granted: false,
      reason:
        "no separate transfer-out authorization artifact exists — account connection does not imply debit/withdrawal authority (cannot be inferred)",
    });
  }
  if (
    instance.connectionAuthorizationRef !== undefined &&
    transferRef === instance.connectionAuthorizationRef
  ) {
    throw new CoverageGapValidationError(
      "the transfer-out authorization reference must be a SEPARATE artifact — it can never be the connection's own authorization reference (P2-W1-001 TransferOutAuthorization separation)",
    );
  }
  const currencyScope = instance.transferOutCurrencyScope ?? [];
  if (!isStringArray(currencyScope)) {
    throw new CoverageGapValidationError(
      "transferOutCurrencyScope, when present, must be non-empty currency codes",
    );
  }
  return Object.freeze({
    granted: true,
    transferOutAuthorizationRef: transferRef,
    currencyScope: Object.freeze([...currencyScope]),
  });
}

// ---------------------------------------------------------------------------
// Sanctioned-market policy (explicit blocked markets)
// ---------------------------------------------------------------------------

/** Why a market is blocked — the reason is ALWAYS recorded, never hidden. */
export const SANCTIONED_MARKET_CLASSIFICATIONS = [
  "SANCTIONED",
  "HIGH_RISK",
] as const;
export type SanctionedMarketClassification =
  (typeof SANCTIONED_MARKET_CLASSIFICATIONS)[number];

export interface SanctionedMarketEntry {
  readonly country: string;
  readonly classification: SanctionedMarketClassification;
  /** The recorded reason — opaque references acceptable, never empty. */
  readonly reason: string;
  readonly evidenceRef: string;
  readonly recordedAt: string;
}

export interface SanctionedMarketPolicy {
  readonly policyId: string;
  readonly entries: readonly SanctionedMarketEntry[];
}

/** The honest per-market verdict. */
export interface SanctionedMarketVerdict {
  readonly country: string;
  readonly verdict: "COMPLIANCE_BLOCKED" | "NOT_BLOCKED";
  readonly classification?: SanctionedMarketClassification;
  readonly reason?: string;
  readonly evidenceRef?: string;
}

/** Validates one sanctioned-market entry (fail-closed on hidden reasons). */
export function validateSanctionedMarketEntry(
  candidate: unknown,
): SanctionedMarketEntry {
  if (candidate === null || typeof candidate !== "object") {
    throw new CoverageGapValidationError("sanctioned market entry must be an object");
  }
  const entry = candidate as Partial<SanctionedMarketEntry>;
  const { country, classification, reason, evidenceRef, recordedAt } = entry;
  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) {
    throw new CoverageGapValidationError(
      "sanctioned market entry requires an ISO alpha-2 country",
    );
  }
  if (classification !== "SANCTIONED" && classification !== "HIGH_RISK") {
    throw new CoverageGapValidationError(
      "sanctioned market entry requires classification SANCTIONED or HIGH_RISK",
    );
  }
  if (!isNonEmptyString(reason)) {
    throw new CoverageGapValidationError(
      "a blocked market MUST carry a recorded reason — no hidden degradation",
    );
  }
  if (!isNonEmptyString(evidenceRef)) {
    throw new CoverageGapValidationError(
      "a blocked market MUST carry an evidence reference",
    );
  }
  if (!isISODate(recordedAt)) {
    throw new CoverageGapValidationError("recordedAt must be an ISO-8601 timestamp");
  }
  return Object.freeze({
    country,
    classification,
    reason,
    evidenceRef,
    recordedAt,
  });
}

/** Builds a sanctioned-market policy from validated entries. */
export function buildSanctionedMarketPolicy(
  policyId: string,
  entries: readonly unknown[],
): SanctionedMarketPolicy {
  if (!isNonEmptyString(policyId)) {
    throw new CoverageGapValidationError("policyId must be a non-empty string");
  }
  const validated = entries.map((entry) => validateSanctionedMarketEntry(entry));
  const seen = new Set<string>();
  for (const entry of validated) {
    if (seen.has(entry.country)) {
      throw new CoverageGapValidationError(
        `duplicate sanctioned-market entry for ${entry.country}`,
      );
    }
    seen.add(entry.country);
  }
  return Object.freeze({
    policyId,
    entries: Object.freeze(validated),
  });
}

/** The explicit per-market verdict (COMPLIANCE_BLOCKED with the reason, or NOT_BLOCKED). */
export function sanctionedMarketVerdict(
  policy: SanctionedMarketPolicy,
  country: string,
): SanctionedMarketVerdict {
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new CoverageGapValidationError("country must be an ISO alpha-2 code");
  }
  const entry = policy.entries.find((candidate) => candidate.country === country);
  if (entry === undefined) {
    return Object.freeze({ country, verdict: "NOT_BLOCKED" });
  }
  return Object.freeze({
    country,
    verdict: "COMPLIANCE_BLOCKED",
    classification: entry.classification,
    reason: entry.reason,
    evidenceRef: entry.evidenceRef,
  });
}

/** The blocked-country list of a policy (for matrix row annotation). */
export function complianceBlockedCountries(
  policy: SanctionedMarketPolicy,
): readonly string[] {
  return Object.freeze(policy.entries.map((entry) => entry.country));
}

// ---------------------------------------------------------------------------
// The executable matrix (row references) + honest verdicts
// ---------------------------------------------------------------------------

/**
 * One executable-matrix row as this module consumes it: route identity,
 * dimension coverage, and the two-axis instance state. This is a REFERENCE
 * view of the matrix (spec/development-state/coverage-matrix.json) — the
 * matrix itself remains the evidence authority.
 */
export interface CoverageMatrixRowRef {
  readonly routeId: string;
  readonly country: string;
  readonly method: string;
  readonly currency: string;
  readonly direction: CoverageDirection;
  /** A connected capability instance exists for this route. */
  readonly connectedInstanceConfigured: boolean;
  /** Eligibility is established (probe-verified, not catalogue-claimed). */
  readonly connectedInstanceEligible: boolean;
  /** Effective availability (INV-C01/C02 vocabulary). */
  readonly effectiveAvailability: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";
  /** Explicit compliance block (sanctioned / unacceptable perimeter). */
  readonly complianceBlocked: boolean;
}

/** Validates one matrix row reference (fail-closed on malformed rows). */
export function validateCoverageMatrixRowRef(
  candidate: unknown,
): CoverageMatrixRowRef {
  if (candidate === null || typeof candidate !== "object") {
    throw new CoverageGapValidationError("matrix row must be an object");
  }
  const row = candidate as Partial<CoverageMatrixRowRef>;
  const { routeId, country, method, currency, direction } = row;
  if (!isNonEmptyString(routeId)) {
    throw new CoverageGapValidationError("matrix row requires routeId");
  }
  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) {
    throw new CoverageGapValidationError(`matrix row '${routeId}' requires an ISO alpha-2 country`);
  }
  if (!isNonEmptyString(method) || typeof currency !== "string" || !/^[A-Z]{3,12}$/.test(currency)) {
    throw new CoverageGapValidationError(
      `matrix row '${routeId}' requires method and currency (3-12 A-Z)`,
    );
  }
  if (direction !== "PAY_IN" && direction !== "PAY_OUT") {
    throw new CoverageGapValidationError(`matrix row '${routeId}' requires direction`);
  }
  if (typeof row.connectedInstanceConfigured !== "boolean") {
    throw new CoverageGapValidationError(
      `matrix row '${row.routeId}' requires connectedInstanceConfigured`,
    );
  }
  if (typeof row.connectedInstanceEligible !== "boolean") {
    throw new CoverageGapValidationError(
      `matrix row '${row.routeId}' requires connectedInstanceEligible`,
    );
  }
  if (
    row.effectiveAvailability !== "AVAILABLE" &&
    row.effectiveAvailability !== "DEGRADED" &&
    row.effectiveAvailability !== "UNAVAILABLE" &&
    row.effectiveAvailability !== "UNKNOWN"
  ) {
    throw new CoverageGapValidationError(
      `matrix row '${row.routeId}' requires an effectiveAvailability verdict`,
    );
  }
  if (typeof row.complianceBlocked !== "boolean") {
    throw new CoverageGapValidationError(
      `matrix row '${row.routeId}' requires an explicit complianceBlocked verdict`,
    );
  }
  return Object.freeze({
    routeId,
    country,
    method,
    currency,
    direction,
    connectedInstanceConfigured: row.connectedInstanceConfigured,
    connectedInstanceEligible: row.connectedInstanceEligible,
    effectiveAvailability: row.effectiveAvailability,
    complianceBlocked: row.complianceBlocked,
  });
}

/**
 * The honest per-row verdict (deterministic table):
 * - complianceBlocked → COMPLIANCE_BLOCKED (explicit, reason recorded upstream);
 * - no connected instance → NOT_CONFIGURED;
 * - instance but no established eligibility → NOT_ELIGIBLE;
 * - eligible but availability ≠ AVAILABLE → UNAVAILABLE;
 * - eligible and AVAILABLE → AVAILABLE (the ONLY path to AVAILABLE).
 */
export function honestVerdictForMatrixRow(row: CoverageMatrixRowRef): HonestCoverageVerdict {
  if (row.complianceBlocked) {
    return "COMPLIANCE_BLOCKED";
  }
  if (!row.connectedInstanceConfigured) {
    return "NOT_CONFIGURED";
  }
  if (!row.connectedInstanceEligible) {
    return "NOT_ELIGIBLE";
  }
  return row.effectiveAvailability === "AVAILABLE"
    ? "AVAILABLE"
    : row.effectiveAvailability === "UNKNOWN"
      ? "UNKNOWN"
      : "UNAVAILABLE";
}

/** A read-only matrix view over validated rows. */
export interface CoverageMatrixView {
  readonly rows: readonly CoverageMatrixRowRef[];
}

/** Builds a validated matrix view (fail-closed on malformed rows). */
export function coverageMatrixView(
  rows: readonly unknown[],
): CoverageMatrixView {
  return Object.freeze({
    rows: Object.freeze(rows.map((row) => validateCoverageMatrixRowRef(row))),
  });
}

// ---------------------------------------------------------------------------
// THE NO-BYPASS LAW (executable)
// ---------------------------------------------------------------------------

/** A coverage claim as marketing/sales surfaces tend to phrase it. */
export interface CoverageClaim {
  readonly claimId: string;
  /** Claimed countries — ["*"] or an entry "*" means a GLOBAL claim. */
  readonly countries: readonly string[];
  readonly methods: readonly string[];
  readonly currencies: readonly string[];
  readonly direction: CoverageDirection | "BOTH";
  readonly assertion: string;
}

/** The per-claim verdict — honest, never an inferred AVAILABLE. */
export interface CoverageClaimVerdict {
  readonly claimId: string;
  readonly verdict: HonestCoverageVerdict;
  /** Route ids that support each claimed dimension (all of them). */
  readonly supportingRows: readonly string[];
  /** Claimed dimensions with NO eligible matrix row (the honest gaps). */
  readonly unsupportedDimensions: readonly CoverageGapDimension[];
  readonly reason: string;
}

function claimDirections(claim: CoverageClaim): readonly CoverageDirection[] {
  return claim.direction === "BOTH" ? ["PAY_IN", "PAY_OUT"] : [claim.direction];
}

function isWildcard(values: readonly string[]): boolean {
  return values.length === 0 || values.includes("*");
}

function rowSupportsDimension(
  row: CoverageMatrixRowRef,
  dimension: CoverageGapDimension,
): boolean {
  return (
    row.country === dimension.country &&
    row.method === dimension.method &&
    row.currency === dimension.currency &&
    row.direction === dimension.direction
  );
}

/**
 * THE NO-BYPASS LAW: every coverage claim must map to matrix rows with
 * eligible connected instances. A claimed dimension with no row yields the
 * honest verdict — UNKNOWN when the matrix has nothing to say,
 * NO_VIABLE_ROUTE when rows exist but none is viable,
 * COMPLIANCE_BLOCKED when every matching row is blocked. A GLOBAL claim
 * ("*" countries/methods/currencies) can NEVER be verified against a finite
 * matrix and therefore NEVER yields AVAILABLE. The claim is SUPPORTED only
 * when EVERY claimed dimension maps to an AVAILABLE row — an inferred
 * AVAILABLE does not exist in this function.
 */
export function assertNoGlobalCoverageBypass(
  matrix: CoverageMatrixView,
  claim: CoverageClaim,
): CoverageClaimVerdict {
  if (claim === null || typeof claim !== "object") {
    throw new CoverageGapValidationError("coverage claim must be an object");
  }
  if (!isNonEmptyString(claim.claimId)) {
    throw new CoverageGapValidationError("coverage claim requires claimId");
  }
  if (!isStringArray(claim.countries) || !isStringArray(claim.methods) || !isStringArray(claim.currencies)) {
    throw new CoverageGapValidationError(
      "coverage claim requires countries/methods/currencies string arrays",
    );
  }
  if (
    claim.direction !== "PAY_IN" &&
    claim.direction !== "PAY_OUT" &&
    claim.direction !== "BOTH"
  ) {
    throw new CoverageGapValidationError("coverage claim requires a direction");
  }

  const wildcard = isWildcard(claim.countries) || isWildcard(claim.methods) || isWildcard(claim.currencies);
  if (wildcard) {
    return Object.freeze({
      claimId: claim.claimId,
      verdict: "UNKNOWN",
      supportingRows: [],
      unsupportedDimensions: [],
      reason:
        "GLOBAL claim: a wildcard ('*') country/method/currency set cannot be verified against a finite executable matrix — the no-bypass law refuses to infer AVAILABLE (enumerate the claimed dimensions or cite the matrix rows)",
    });
  }

  const directions = claimDirections(claim);
  const supportingRows = new Set<string>();
  const unsupportedDimensions: CoverageGapDimension[] = [];
  let sawNoRow = false;
  let sawBlockedOnly = true;
  let sawViableRow = false;

  for (const country of claim.countries) {
    for (const method of claim.methods) {
      for (const currency of claim.currencies) {
        for (const direction of directions) {
          const dimension: CoverageGapDimension = Object.freeze({
            country,
            method,
            currency,
            direction,
          });
          const matching = matrix.rows.filter((row) =>
            rowSupportsDimension(row, dimension),
          );
          if (matching.length === 0) {
            sawNoRow = true;
            unsupportedDimensions.push(dimension);
            continue;
          }
          if (matching.some((row) => !row.complianceBlocked)) {
            sawBlockedOnly = false;
          }
          const available = matching.filter(
            (row) => honestVerdictForMatrixRow(row) === "AVAILABLE",
          );
          if (available.length > 0) {
            sawViableRow = true;
            for (const row of available) {
              supportingRows.add(row.routeId);
            }
          } else {
            unsupportedDimensions.push(dimension);
          }
        }
      }
    }
  }

  if (unsupportedDimensions.length === 0) {
    return Object.freeze({
      claimId: claim.claimId,
      verdict: "AVAILABLE",
      supportingRows: Object.freeze([...supportingRows]),
      unsupportedDimensions: [],
      reason:
        "every claimed dimension maps to an eligible, AVAILABLE matrix row with a connected instance — the claim is SUPPORTED by executable evidence",
    });
  }

  const verdict: HonestCoverageVerdict = sawNoRow
    ? "UNKNOWN"
    : sawBlockedOnly
      ? "COMPLIANCE_BLOCKED"
      : sawViableRow
        ? "NO_VIABLE_ROUTE"
        : "NO_VIABLE_ROUTE";
  return Object.freeze({
    claimId: claim.claimId,
    verdict,
    supportingRows: Object.freeze([...supportingRows]),
    unsupportedDimensions: Object.freeze(unsupportedDimensions),
    reason:
      verdict === "UNKNOWN"
        ? "claimed dimensions with NO matrix row: the matrix has nothing to say — UNKNOWN, never an inferred AVAILABLE (open a Coverage Gap Case for these dimensions)"
        : verdict === "COMPLIANCE_BLOCKED"
          ? "every matching matrix row is compliance-blocked (sanctioned/unacceptable perimeter) — the block is explicit with its recorded reason"
          : "matching matrix rows exist but none is eligible-and-AVAILABLE — NO_VIABLE_ROUTE (open a Coverage Gap Case for these dimensions)",
  });
}

// ---------------------------------------------------------------------------
// Gap detection from the matrix (the executable Tier-C trigger)
// ---------------------------------------------------------------------------

/** A detected gap: the dimension plus the honest verdict that exposed it. */
export interface DetectedCoverageGap {
  readonly dimension: CoverageGapDimension;
  readonly observedVerdict: HonestCoverageVerdict;
  readonly matchingRouteIds: readonly string[];
}

/**
 * Scans the matrix for gap-triggering verdicts on a requested dimension:
 * every verdict except AVAILABLE is a gap trigger (Tier C: no eligible
 * pay-in/payout route, unsupported method/currency, unacceptable perimeter,
 * insufficient capacity/health, or no credible fallback).
 */
export function detectCoverageGap(
  matrix: CoverageMatrixView,
  dimension: unknown,
): DetectedCoverageGap {
  const validated = validateCoverageGapDimension(dimension);
  const matching = matrix.rows.filter((row) =>
    rowSupportsDimension(row, validated),
  );
  if (matching.length === 0) {
    return Object.freeze({
      dimension: validated,
      observedVerdict: "UNKNOWN",
      matchingRouteIds: [],
    });
  }
  const verdicts = matching.map((row) => honestVerdictForMatrixRow(row));
  const observed: HonestCoverageVerdict = verdicts.includes("COMPLIANCE_BLOCKED")
    ? "COMPLIANCE_BLOCKED"
    : verdicts.includes("AVAILABLE")
      ? "AVAILABLE"
      : verdicts.includes("UNKNOWN")
        ? "UNKNOWN"
        : verdicts.includes("NOT_CONFIGURED") || verdicts.includes("NOT_ELIGIBLE")
          ? "NOT_ELIGIBLE"
          : "NO_VIABLE_ROUTE";
  return Object.freeze({
    dimension: validated,
    observedVerdict: observed,
    matchingRouteIds: Object.freeze(matching.map((row) => row.routeId)),
  });
}
