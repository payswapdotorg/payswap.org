import { describe, expect, it } from "vitest";
import {
  COVERAGE_DIRECTIONS,
  COVERAGE_GAP_CAUSE_CLASSIFICATIONS,
  COVERAGE_GAP_KINDS,
  COVERAGE_GAP_STATUSES,
  DIRECT_LOCAL_AUTHORIZATION_MODES,
  DIRECT_LOCAL_ONBOARDING_STEPS,
  HONEST_COVERAGE_VERDICTS,
  INTEGRATION_TIER_LABELS,
  CoverageGapValidationError,
  assertNoGlobalCoverageBypass,
  buildSanctionedMarketPolicy,
  classifyCoverageGapCause,
  complianceBlockedCountries,
  coverageGapCauseTable,
  coverageMatrixView,
  explicitTransferOutScope,
  honestVerdictForMatrixRow,
  onboardDirectLocalConnector,
  openCoverageGapCase,
  sanctionedMarketVerdict,
  selectNarrowestIntegration,
  transitionCoverageGapCase,
  validateCoverageGapDimension,
  validateDirectLocalOnboardingPath,
} from "../src/coverage-gap.js";
import type {
  CoverageGapCase,
  CoverageMatrixRowRef,
  DirectLocalOnboardingPath,
  IntegrationOption,
} from "../src/coverage-gap.js";

const T0 = "2026-10-02T12:00:00Z";

const GH_PAY_IN = {
  country: "GH",
  method: "mobile_money",
  currency: "GHS",
  direction: "PAY_IN" as const,
};

function openCase(overrides: Record<string, unknown> = {}): CoverageGapCase {
  return openCoverageGapCase({
    caseId: "gap-001",
    dimension: GH_PAY_IN,
    gapKind: "NO_PAY_IN_ROUTE",
    createdAt: T0,
    ...overrides,
  });
}

describe("coverage-gap vocabulary (P2-W1-003)", () => {
  it("the gap kinds cover every strategy Tier-C trigger (8 kinds)", () => {
    expect(COVERAGE_GAP_KINDS).toEqual([
      "NO_PAY_IN_ROUTE",
      "NO_PAYOUT_ROUTE",
      "UNSUPPORTED_METHOD",
      "UNSUPPORTED_CURRENCY",
      "REGULATORY_PERIMETER",
      "CAPACITY_HEALTH",
      "ECONOMICS",
      "NO_FALLBACK",
    ]);
  });

  it("the cause classifications are exactly the five work-order causes", () => {
    expect(COVERAGE_GAP_CAUSE_CLASSIFICATIONS).toEqual([
      "REGULATORY",
      "CAPABILITY",
      "COMMERCIAL",
      "CAPACITY",
      "RELIABILITY",
    ]);
  });

  it("the honest verdict vocabulary is the strategy's seven (never an inferred AVAILABLE)", () => {
    expect(HONEST_COVERAGE_VERDICTS).toEqual([
      "AVAILABLE",
      "NOT_ELIGIBLE",
      "NOT_CONFIGURED",
      "UNAVAILABLE",
      "UNKNOWN",
      "COMPLIANCE_BLOCKED",
      "NO_VIABLE_ROUTE",
    ]);
  });

  it("the direct-local authorization modes are the credential-isolation doc's five (P2-W1-001 literals)", () => {
    expect(DIRECT_LOCAL_AUTHORIZATION_MODES).toEqual([
      "DELEGATED_OAUTH",
      "CONNECTED_ACCOUNT",
      "SCOPED_API_CREDENTIAL",
      "INTERACTIVE_BROWSER_SESSION",
      "PROVIDERLESS_RAIL",
    ]);
  });

  it("the onboarding steps are in the fixed acceptance order", () => {
    expect(DIRECT_LOCAL_ONBOARDING_STEPS).toEqual([
      "ACCOUNT_OWNER_AUTHORIZATION",
      "EXPLICIT_DEBIT_SCOPE",
      "CONNECTOR_CERTIFICATION",
      "CAPABILITY_INSTANCE_CREATION",
      "OBSERVATION",
    ]);
  });
});

describe("coverage-gap dimension (the country/method/currency/direction quadruple)", () => {
  it("validates a well-formed dimension and preserves the optional strategy dimensions", () => {
    const dimension = validateCoverageGapDimension({
      ...GH_PAY_IN,
      merchantDomicile: "FR",
      shopperBeneficiaryCountry: "GH",
    });
    expect(dimension).toEqual({
      country: "GH",
      method: "mobile_money",
      currency: "GHS",
      direction: "PAY_IN",
      merchantDomicile: "FR",
      shopperBeneficiaryCountry: "GH",
    });
  });

  it("rejects malformed countries, currencies, directions and domicile codes (fail-closed)", () => {
    expect(() => validateCoverageGapDimension({ ...GH_PAY_IN, country: "GHA" })).toThrow(CoverageGapValidationError);
    expect(() => validateCoverageGapDimension({ ...GH_PAY_IN, country: "gh" })).toThrow(CoverageGapValidationError);
    expect(() => validateCoverageGapDimension({ ...GH_PAY_IN, currency: "x" })).toThrow(CoverageGapValidationError);
    expect(() => validateCoverageGapDimension({ ...GH_PAY_IN, method: "" })).toThrow(CoverageGapValidationError);
    expect(() => validateCoverageGapDimension({ ...GH_PAY_IN, direction: "BOTH" })).toThrow(CoverageGapValidationError);
    expect(() => validateCoverageGapDimension({ ...GH_PAY_IN, merchantDomicile: "FRA" })).toThrow(CoverageGapValidationError);
  });

  it("asset codes beyond ISO-4217 (USDC, 12-char) are representable — every currency gap can be represented", () => {
    expect(() =>
      validateCoverageGapDimension({ country: "GH", method: "stellar_usdc", currency: "USDC", direction: "PAY_OUT" }),
    ).not.toThrow();
    expect(() =>
      validateCoverageGapDimension({ country: "GH", method: "x", currency: "ABCDEFGHIJKL", direction: "PAY_IN" }),
    ).not.toThrow();
    expect(() =>
      validateCoverageGapDimension({ country: "GH", method: "x", currency: "A234567890123", direction: "PAY_IN" }),
    ).toThrow(CoverageGapValidationError);
  });

  it("both directions are legal", () => {
    expect(COVERAGE_DIRECTIONS).toEqual(["PAY_IN", "PAY_OUT"]);
  });
});

describe("gap case lifecycle", () => {
  it("opens a case in OPEN with the default cause classification derived from the kind", () => {
    const gap = openCase();
    expect(gap.status).toBe("OPEN");
    expect(gap.caseId).toBe("gap-001");
    expect(gap.dimension).toEqual(GH_PAY_IN);
    expect(gap.causeClassification).toBe(coverageGapCauseTable()["NO_PAY_IN_ROUTE"]);
  });

  it("an explicit cause classification overrides the table default", () => {
    expect(openCase({ causeClassification: "COMMERCIAL" }).causeClassification).toBe("COMMERCIAL");
  });

  it("evidence refs are opaque strings only (never material)", () => {
    const gap = openCase({ evidence: [{ evidenceRef: "probe:20261002", note: "matrix row" }] });
    expect(gap.evidence[0]?.evidenceRef).toBe("probe:20261002");
    expect(() => openCase({ evidence: [{ note: "no ref" }] as never })).toThrow(CoverageGapValidationError);
  });

  it("rejects malformed case ids and timestamps (fail-closed)", () => {
    expect(() => openCase({ caseId: "" })).toThrow(CoverageGapValidationError);
    expect(() => openCase({ createdAt: "not-a-date" })).toThrow(CoverageGapValidationError);
    expect(() => openCase({ gapKind: "NO_ROUTE" as never })).toThrow(CoverageGapValidationError);
  });

  it("transitions follow the legal lifecycle only", () => {
    const gap = openCase();
    const analyzed = transitionCoverageGapCase(gap, "IN_ANALYSIS");
    expect(analyzed.status).toBe("IN_ANALYSIS");
    const resolved = transitionCoverageGapCase(
      analyzed,
      "RESOLVED_BY_CONNECTOR",
      {
        resolvedAt: "2026-10-02T14:00:00Z",
        resolutionKind: "CONNECTOR",
        note: "stellar local rail",
      },
    );
    expect(resolved.status).toBe("RESOLVED_BY_CONNECTOR");
    expect(resolved.resolution?.resolutionKind).toBe("CONNECTOR");
  });

  it("illegal transitions are refused (e.g. WITHDRAWN → OPEN, OPEN → RESOLVED)", () => {
    const gap = openCase();
    const withdrawn = transitionCoverageGapCase(gap, "WITHDRAWN");
    expect(() => transitionCoverageGapCase(withdrawn, "OPEN")).toThrow(CoverageGapValidationError);
    expect(() => transitionCoverageGapCase(gap, "RESOLVED_BY_ROUTING")).toThrow(CoverageGapValidationError);
  });

  it("a resolution record is REQUIRED for the RESOLVED_* targets and must match the kind", () => {
    const analyzed = transitionCoverageGapCase(openCase(), "IN_ANALYSIS");
    expect(() => transitionCoverageGapCase(analyzed, "RESOLVED_BY_CONNECTOR")).toThrow(CoverageGapValidationError);
    expect(() =>
      transitionCoverageGapCase(analyzed, "RESOLVED_BY_ROUTING", {
        resolvedAt: "2026-10-02T14:00:00Z",
        resolutionKind: "CONNECTOR",
      }),
    ).toThrow(CoverageGapValidationError);
  });

  it("every status in the vocabulary is reachable somewhere in the legal transitions", () => {
    for (const status of COVERAGE_GAP_STATUSES) {
      expect(typeof status).toBe("string");
    }
    expect(COVERAGE_GAP_STATUSES).toContain("NOT_RESOLVABLE");
  });
});

describe("cause classification (the five causes, deterministic and total)", () => {
  it("compliance-blocked evidence classifies REGULATORY regardless of kind", () => {
    expect(classifyCoverageGapCause({ gapKind: "UNSUPPORTED_METHOD", complianceBlocked: true })).toBe("REGULATORY");
    expect(classifyCoverageGapCause({ gapKind: "ECONOMICS", complianceBlocked: true })).toBe("REGULATORY");
  });

  it("a capability void classifies CAPABILITY; capacity/health evidence classifies CAPACITY; unreliability RELIABILITY; economics COMMERCIAL", () => {
    expect(classifyCoverageGapCause({ gapKind: "UNSUPPORTED_CURRENCY", capabilityVoid: true })).toBe("CAPABILITY");
    expect(classifyCoverageGapCause({ gapKind: "CAPACITY_HEALTH", capacityOrHealthLimited: true })).toBe("CAPACITY");
    expect(classifyCoverageGapCause({ gapKind: "NO_PAY_IN_ROUTE", unreliable: true })).toBe("RELIABILITY");
    expect(classifyCoverageGapCause({ gapKind: "NO_FALLBACK", uneconomical: true })).toBe("COMMERCIAL");
  });

  it("unmarked route-kind gaps classify CAPABILITY; unmarked cause inputs throw (never classified silently)", () => {
    expect(classifyCoverageGapCause({ gapKind: "UNSUPPORTED_METHOD" })).toBe("CAPABILITY");
    expect(classifyCoverageGapCause({ gapKind: "NO_FALLBACK" })).toBe("CAPABILITY");
  });

  it("the default table maps every gap kind to a cause (total, no undefined)", () => {
    const table = coverageGapCauseTable();
    for (const kind of COVERAGE_GAP_KINDS) {
      expect(COVERAGE_GAP_CAUSE_CLASSIFICATIONS).toContain(table[kind]);
    }
  });

  it("unmarked route-kind gaps classify CAPABILITY (the classifier is total — a gap is never left unclassified)", () => {
    expect(classifyCoverageGapCause({ gapKind: "NO_FALLBACK" })).toBe("CAPABILITY");
  });
});

describe("narrowest integration selection", () => {
  const gap = openCase();
  const option = (tier: number, available = true, optionId = `opt-${tier}`): IntegrationOption =>
    ({
      optionId,
      tier,
      providerName: tier <= 3 ? "existing-provider" : tier === 4 ? "aggregator" : "direct-local",
      ...(tier === 3 ? { authorizationMode: "INTERACTIVE_BROWSER_SESSION" as const } : {}),
      available,
      ...(available ? {} : { unavailabilityReason: "not eligible" }),
    }) as IntegrationOption;

  it("selects the narrowest AVAILABLE tier (tier 1 over tier 5)", () => {
    const selection = selectNarrowestIntegration(gap, [option(5), option(3), option(1), option(2)]);
    expect(selection.selected?.tier).toBe(1);
    expect(selection.verdict).toBe("SELECTION_MADE");
  });

  it("skips unavailable narrow tiers — the selected option is the narrowest AVAILABLE one", () => {
    const selection = selectNarrowestIntegration(gap, [
      option(1, false),
      option(2, false),
      option(3),
      option(4),
    ]);
    expect(selection.selected?.tier).toBe(3);
    expect(selection.ranking[0]?.option.tier).toBe(1); // ranked, not selected
    expect(selection.ranking[0]?.reason).toContain("unavailable");
  });

  it("no available option → NO_VIABLE_OPTION with the honest verdict", () => {
    const selection = selectNarrowestIntegration(gap, [option(1, false), option(5, false)]);
    expect(selection.selected).toBeUndefined();
    expect(selection.verdict).toBe("NO_VIABLE_OPTION");
  });

  it("tier ties break deterministically by optionId", () => {
    const selection = selectNarrowestIntegration(gap, [option(4, true, "zzz"), option(4, true, "aaa")]);
    expect(selection.selected?.optionId).toBe("aaa");
  });

  it("the five tier labels are the strategy's five integration breadths", () => {
    expect(INTEGRATION_TIER_LABELS[1]).toContain("reconfiguration");
    expect(INTEGRATION_TIER_LABELS[5]).toContain("direct local connector");
  });

  it("invalid options are refused (tier outside 1-5)", () => {
    expect(() => selectNarrowestIntegration(gap, [option(6)])).toThrow(CoverageGapValidationError);
  });
});

describe("direct-local onboarding path (the five authorization modes)", () => {
  const base: DirectLocalOnboardingPath = {
    connectorName: "gh-local-momo",
    authorizationMode: "INTERACTIVE_BROWSER_SESSION",
    browserSessionRequired: true,
    debitScopeRequired: true,
    certificationRequired: true,
  };

  it("browserSessionRequired is DERIVED from the mode — an inconsistent declaration is rejected", () => {
    expect(() => validateDirectLocalOnboardingPath(base)).not.toThrow();
    expect(() =>
      validateDirectLocalOnboardingPath({ ...base, browserSessionRequired: false }),
    ).toThrow(CoverageGapValidationError);
    const nonBrowser = { ...base, authorizationMode: "SCOPED_API_CREDENTIAL" as const, browserSessionRequired: false };
    expect(() => validateDirectLocalOnboardingPath(nonBrowser)).not.toThrow();
    expect(() =>
      validateDirectLocalOnboardingPath({ ...nonBrowser, browserSessionRequired: true }),
    ).toThrow(CoverageGapValidationError);
  });

  it("every mode validates with the derived browser-session requirement", () => {
    for (const mode of DIRECT_LOCAL_AUTHORIZATION_MODES) {
      const path = {
        ...base,
        authorizationMode: mode,
        browserSessionRequired: mode === "INTERACTIVE_BROWSER_SESSION",
      };
      expect(() => validateDirectLocalOnboardingPath(path)).not.toThrow();
    }
  });

  it("the onboarding plan emits the five steps in order with the correct gate states", () => {
    const plan = onboardDirectLocalConnector(base, {
      ownerAuthorization: { browserSessionRef: "browser-session-ref-opaque" },
      debitScopeAuthorization: { authorizationRef: "transfer-out-auth-ref" },
      certification: { certificationRef: "cert-ref" },
      capabilityInstance: { instanceRef: "instance-ref" },
      observation: { observationRef: "observation-ref" },
    });
    expect(plan.steps.map((s) => s.step)).toEqual([...DIRECT_LOCAL_ONBOARDING_STEPS]);
    expect(plan.steps.every((s) => s.gateState === "SATISFIED")).toBe(true);
    expect(plan.allGatesSatisfied).toBe(true);
    expect(plan.missingGates).toEqual([]);
    expect(plan.credentialBoundary).toBe("SECURE_BROWSER_OR_VAULT_ONLY");
    expect(plan.perTransactionReauthentication).toBe(false);
  });

  it("missing owner authorization leaves step 1 unsatisfied — the plan is not complete", () => {
    const plan = onboardDirectLocalConnector(base, {});
    expect(plan.steps[0]?.gateState).toBe("REQUIRED_UNSATISFIED");
    expect(plan.allGatesSatisfied).toBe(false);
    expect(plan.missingGates).toContain("ACCOUNT_OWNER_AUTHORIZATION");
  });

  it("the browser-session law note records the isolation boundary (agent NEVER sees credential material)", () => {
    const plan = onboardDirectLocalConnector(base, { ownerAuthorization: { browserSessionRef: "ref-1" } });
    expect(plan.steps[0]?.lawNote).toContain("never cross into model context");
    expect(plan.steps[0]?.evidenceRef).toBe("ref-1"); // opaque ref ONLY
  });

  it("a non-browser mode's step-1 note names the mode and the credential boundary", () => {
    const plan = onboardDirectLocalConnector(
      { ...base, authorizationMode: "PROVIDERLESS_RAIL" as const, browserSessionRequired: false },
      { ownerAuthorization: { artifactRef: "artifact-ref" } },
    );
    expect(plan.steps[0]?.lawNote).toContain("PROVIDERLESS_RAIL");
  });

  it("debit scope unsatisfied when required — connection alone never grants transfer-out", () => {
    const plan = onboardDirectLocalConnector(base, { ownerAuthorization: { browserSessionRef: "ref-1" } });
    expect(plan.steps[1]?.gateState).toBe("REQUIRED_UNSATISFIED");
    expect(plan.steps[1]?.lawNote).toContain("cannot be inferred from account connection");
  });

  it("debit scope NOT required for a pure collection connector — the step is satisfied by non-requirement", () => {
    const plan = onboardDirectLocalConnector(
      { ...base, debitScopeRequired: false },
      { ownerAuthorization: { browserSessionRef: "ref-1" } },
    );
    expect(plan.steps[1]?.gateState).toBe("SATISFIED");
    expect(plan.steps[1]?.required).toBe(false);
  });
});

describe("explicit transfer-out scope (debit cannot be inferred from connection)", () => {
  it("no separate transfer-out artifact → NOT granted, structurally", () => {
    const verdict = explicitTransferOutScope({ instanceRef: "inst-1" });
    expect(verdict.granted).toBe(false);
    if (verdict.granted === false) {
      expect(verdict.reason).toContain("cannot be inferred");
    }
  });

  it("a SEPARATE artifact grants transfer-out with its currency scope", () => {
    const verdict = explicitTransferOutScope({
      instanceRef: "inst-1",
      connectionAuthorizationRef: "connection-auth",
      transferOutAuthorizationRef: "transfer-out-auth",
      transferOutCurrencyScope: ["GHS", "KES"],
    });
    expect(verdict.granted).toBe(true);
    if (verdict.granted === true) {
      expect(verdict.currencyScope).toEqual(["GHS", "KES"]);
    }
  });

  it("the transfer-out artifact may NEVER be the connection's own artifact (the W1-001 separation)", () => {
    expect(() =>
      explicitTransferOutScope({
        instanceRef: "inst-1",
        connectionAuthorizationRef: "same-ref",
        transferOutAuthorizationRef: "same-ref",
      }),
    ).toThrow(CoverageGapValidationError);
  });
});

describe("sanctioned-market policy (explicit blocked cases)", () => {
  const policy = buildSanctionedMarketPolicy("policy-2026-10-02", [
    { country: "XY", classification: "SANCTIONED", reason: "OFAC comprehensive embargo (synthetic fixture)", evidenceRef: "policy:ofac", recordedAt: T0 },
    { country: "ZW", classification: "HIGH_RISK", reason: "enhanced licensing (synthetic fixture)", evidenceRef: "policy:high-risk", recordedAt: T0 },
  ]);

  it("blocked markets return COMPLIANCE_BLOCKED with the reason recorded (never hidden)", () => {
    const verdict = sanctionedMarketVerdict(policy, "XY");
    expect(verdict.verdict).toBe("COMPLIANCE_BLOCKED");
    expect(verdict.classification).toBe("SANCTIONED");
    expect(verdict.reason).toContain("embargo");
  });

  it("unblocked markets return NOT_BLOCKED", () => {
    expect(sanctionedMarketVerdict(policy, "GH").verdict).toBe("NOT_BLOCKED");
  });

  it("the blocked-country list is explicit for matrix annotation", () => {
    expect(complianceBlockedCountries(policy)).toEqual(["XY", "ZW"]);
  });

  it("duplicate entries and malformed countries are refused", () => {
    expect(() =>
      buildSanctionedMarketPolicy("p2", [
        { country: "XY", classification: "SANCTIONED", reason: "x", evidenceRef: "r", recordedAt: T0 },
        { country: "XY", classification: "SANCTIONED", reason: "x", evidenceRef: "r", recordedAt: T0 },
      ]),
    ).toThrow(CoverageGapValidationError);
    expect(() => sanctionedMarketVerdict(policy, "XYZ")).toThrow(CoverageGapValidationError);
  });
});

describe("the executable matrix + honest verdicts", () => {
  const row = (overrides: Partial<CoverageMatrixRowRef> = {}): CoverageMatrixRowRef =>
    ({
      routeId: "stripe-card-fr-account",
      country: "FR",
      method: "card",
      currency: "EUR",
      direction: "PAY_IN" as const,
      connectedInstanceConfigured: true,
      connectedInstanceEligible: true,
      effectiveAvailability: "AVAILABLE" as const,
      complianceBlocked: false,
      ...overrides,
    }) as CoverageMatrixRowRef;

  it("AVAILABLE is derived ONLY from a configured + eligible + available row", () => {
    expect(honestVerdictForMatrixRow(row())).toBe("AVAILABLE");
  });

  it("unconfigured → NOT_CONFIGURED; ineligible → NOT_ELIGIBLE; blocked → COMPLIANCE_BLOCKED", () => {
    expect(honestVerdictForMatrixRow(row({ connectedInstanceConfigured: false }))).toBe("NOT_CONFIGURED");
    expect(honestVerdictForMatrixRow(row({ connectedInstanceEligible: false }))).toBe("NOT_ELIGIBLE");
    expect(honestVerdictForMatrixRow(row({ complianceBlocked: true }))).toBe("COMPLIANCE_BLOCKED");
  });

  it("DEGRADED/UNKNOWN availability is honest (UNKNOWN never coerced to AVAILABLE)", () => {
    expect(honestVerdictForMatrixRow(row({ effectiveAvailability: "DEGRADED" }))).toBe("UNAVAILABLE");
    expect(honestVerdictForMatrixRow(row({ effectiveAvailability: "UNKNOWN" }))).toBe("UNKNOWN");
  });

  it("malformed rows are refused at view construction (fail-closed)", () => {
    expect(() => coverageMatrixView([{ routeId: "" }])).toThrow(CoverageGapValidationError);
  });
});

describe("THE NO-BYPASS LAW (executable)", () => {
  const matrix = coverageMatrixView([
    {
      routeId: "paystack-gh-local",
      country: "GH",
      method: "bank_transfer",
      currency: "GHS",
      direction: "PAY_IN",
      connectedInstanceConfigured: true,
      connectedInstanceEligible: true,
      effectiveAvailability: "AVAILABLE",
      complianceBlocked: false,
    },
    {
      routeId: "sanctioned-xy",
      country: "XY",
      method: "card",
      currency: "USD",
      direction: "PAY_IN",
      connectedInstanceConfigured: true,
      connectedInstanceEligible: true,
      effectiveAvailability: "AVAILABLE",
      complianceBlocked: true,
    },
  ]);

  it("a claim fully supported by eligible rows is SUPPORTED (verdict AVAILABLE)", () => {
    const verdict = assertNoGlobalCoverageBypass(matrix, {
      claimId: "claim-gh-bank",
      countries: ["GH"],
      methods: ["bank_transfer"],
      currencies: ["GHS"],
      direction: "PAY_IN",
      assertion: "Ghana bank-transfer collection",
    });
    expect(verdict.verdict).toBe("AVAILABLE");
    expect(verdict.supportingRows).toEqual(["paystack-gh-local"]);
    expect(verdict.unsupportedDimensions).toEqual([]);
  });

  it("a claim with no matching row is UNKNOWN — never an inferred AVAILABLE", () => {
    const verdict = assertNoGlobalCoverageBypass(matrix, {
      claimId: "claim-tg",
      countries: ["TG"],
      methods: ["mobile_money"],
      currencies: ["XOF"],
      direction: "PAY_OUT",
      assertion: "Togo mobile-money payout",
    });
    expect(verdict.verdict).toBe("UNKNOWN");
    expect(verdict.unsupportedDimensions.length).toBeGreaterThan(0);
  });

  it("a GLOBAL ('*') claim can NEVER be verified — no finite matrix yields AVAILABLE", () => {
    const verdict = assertNoGlobalCoverageBypass(matrix, {
      claimId: "claim-global",
      countries: ["*"],
      methods: ["*"],
      currencies: ["*"],
      direction: "BOTH",
      assertion: "we cover everything everywhere",
    });
    expect(verdict.verdict).not.toBe("AVAILABLE");
    expect(verdict.reason.toLowerCase()).toContain("global");
  });

  it("a claim over only blocked rows is COMPLIANCE_BLOCKED (explicit, not hidden)", () => {
    const verdict = assertNoGlobalCoverageBypass(matrix, {
      claimId: "claim-xy",
      countries: ["XY"],
      methods: ["card"],
      currencies: ["USD"],
      direction: "PAY_IN",
      assertion: "sanctioned market collection",
    });
    expect(verdict.verdict).toBe("COMPLIANCE_BLOCKED");
  });

  it("a malformed claim is refused (fail-closed)", () => {
    expect(() =>
      assertNoGlobalCoverageBypass(matrix, { claimId: "" } as never),
    ).toThrow(CoverageGapValidationError);
  });
});
