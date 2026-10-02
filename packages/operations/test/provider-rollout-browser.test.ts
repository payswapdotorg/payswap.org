import { describe, expect, it } from "vitest";

import { AUTHORIZATION_MODES, BROWSER_SESSION_AUTHORIZATION_STATES } from "@payswap/connectors";
import { DIRECT_LOCAL_AUTHORIZATION_MODES } from "@payswap/capabilities";

import {
  BROWSER_JOURNEY_CONTRACTS,
  BROWSER_VERIFICATION_CHECKS,
  EXPIRED_SESSION_JOURNEY_CONTRACT,
  LOCAL_RAIL_USER_AUTHORIZED_JOURNEY_CONTRACT,
  SECRET_BEARING_FIELD_CLASSES,
  checkBrowserArtifactSecretExclusion,
  checkBrowserJourneyContracts,
  checkBrowserObservationSecretExclusion,
  checkProviderRolloutBrowserCoverage,
  deriveProviderRealPathContracts,
  localRailUserAuthorizedJourneyContract,
  providerRealPathJourneyContract,
  recordProviderRolloutBrowserVerification,
  redactBrowserJourneyObservation,
} from "../src/browser-verification.js";
import type {
  BrowserJourneyContract,
  BrowserJourneyObservation,
  BrowserObservationField,
} from "../src/browser-verification.js";

/**
 * The canonical vocabularies are imported DIRECTLY from their owning
 * packages (@payswap/connectors, @payswap/capabilities) and passed into the
 * checkers — the battery binds the operations contract layer to the real
 * unions (the P2-W1-001 law 6 drift-prevention pattern).
 */
const MODES: readonly string[] = AUTHORIZATION_MODES;
const DIRECT_LOCAL_MODES: readonly string[] = DIRECT_LOCAL_AUTHORIZATION_MODES;

const CONNECTED_PROVIDERS = [
  { providerName: "stripe", authorizationMode: "SCOPED_API_CREDENTIAL" },
  { providerName: "paystack", authorizationMode: "SCOPED_API_CREDENTIAL" },
  { providerName: "flutterwave", authorizationMode: "SCOPED_API_CREDENTIAL" },
] as const;

function rolloutContractSet(): readonly BrowserJourneyContract[] {
  return [
    ...deriveProviderRealPathContracts(CONNECTED_PROVIDERS),
    LOCAL_RAIL_USER_AUTHORIZED_JOURNEY_CONTRACT,
    EXPIRED_SESSION_JOURNEY_CONTRACT,
  ];
}

function localRailApplies() {
  return {
    applies: true,
    reason:
      "no API credential exists for the local rail — the user-authorized provider/session path applies (the W1-003 direct-local vocabulary)",
  };
}

// ---------------------------------------------------------------------------
// Real-path contracts
// ---------------------------------------------------------------------------

describe("provider real-path browser contracts", () => {
  it("the full rollout contract set passes the coverage checker with the canonical unions", () => {
    const report = checkProviderRolloutBrowserCoverage(
      {
        connectedProviders: CONNECTED_PROVIDERS,
        contracts: rolloutContractSet(),
        localRail: localRailApplies(),
      },
      MODES,
      DIRECT_LOCAL_MODES,
    );
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.contractCount).toBe(5);
  });

  it("each contract declares the six required checks, the real path and the credential boundary", () => {
    for (const contract of deriveProviderRealPathContracts(CONNECTED_PROVIDERS)) {
      expect(contract.requiredChecks).toEqual(BROWSER_VERIFICATION_CHECKS);
      expect(contract.realPath?.apiPath).toBe("REAL_PROVIDER_API");
      expect(contract.realPath?.protocolPath).toBe("VALIDATED_REQUEST_ENVELOPE");
      expect(contract.credentialBoundary).toBe("SECURE_BROWSER_OR_VAULT_ONLY");
      expect(contract.unknownHandling.applies).toBe(true);
    }
  });

  it("a connected provider without a real-path contract is a coverage violation", () => {
    const report = checkProviderRolloutBrowserCoverage(
      {
        connectedProviders: [
          ...CONNECTED_PROVIDERS,
          { providerName: "rapyd", authorizationMode: "SCOPED_API_CREDENTIAL" },
        ],
        contracts: rolloutContractSet(),
        localRail: localRailApplies(),
      },
      MODES,
      DIRECT_LOCAL_MODES,
    );
    expect(report.passed).toBe(false);
    expect(
      report.violations.some(
        (violation) =>
          violation.journeyId === "provider-real-path:rapyd" &&
          violation.check === "real-path-coverage",
      ),
    ).toBe(true);
  });

  it("a non-canonical authorization mode is a coverage violation", () => {
    const report = checkProviderRolloutBrowserCoverage(
      {
        connectedProviders: [
          { providerName: "stripe", authorizationMode: "MAGIC_UNICORN_MODE" },
        ],
        contracts: [
          providerRealPathJourneyContract("stripe", "MAGIC_UNICORN_MODE"),
          EXPIRED_SESSION_JOURNEY_CONTRACT,
        ],
        localRail: { applies: false, reason: "api credential exists" },
      },
      MODES,
      DIRECT_LOCAL_MODES,
    );
    expect(report.passed).toBe(false);
    expect(
      report.violations.some(
        (violation) =>
          violation.check === "real-path-coverage" &&
          violation.detail.includes("not in the canonical union"),
      ),
    ).toBe(true);
  });

  it("a provider-backed contract without the credential boundary is a violation", () => {
    const { credentialBoundary: _dropped, ...stripped } =
      providerRealPathJourneyContract("stripe", "SCOPED_API_CREDENTIAL");
    const report = checkProviderRolloutBrowserCoverage(
      {
        connectedProviders: [
          { providerName: "stripe", authorizationMode: "SCOPED_API_CREDENTIAL" },
        ],
        contracts: [stripped, EXPIRED_SESSION_JOURNEY_CONTRACT],
        localRail: { applies: false, reason: "api credential exists" },
      },
      MODES,
      DIRECT_LOCAL_MODES,
    );
    expect(report.passed).toBe(false);
    expect(
      report.violations.some((violation) => violation.check === "credential-boundary"),
    ).toBe(true);
  });

  it("the rollout contracts coexist with the W3-007 families under the shared checker", () => {
    const report = checkBrowserJourneyContracts([
      ...BROWSER_JOURNEY_CONTRACTS,
      ...rolloutContractSet(),
    ]);
    expect(report.passed).toBe(true);
    expect(report.contractCount).toBe(
      BROWSER_JOURNEY_CONTRACTS.length + rolloutContractSet().length,
    );
  });
});

// ---------------------------------------------------------------------------
// The local-rail user-authorized path
// ---------------------------------------------------------------------------

describe("local-rail user-authorized journey contract", () => {
  it("drives the user-authorized provider/session path when no API credential exists", () => {
    const contract = LOCAL_RAIL_USER_AUTHORIZED_JOURNEY_CONTRACT;
    expect(contract.source).toBe("LOCAL_RAIL_USER_AUTHORIZED_JOURNEY");
    expect(contract.realPath?.authorizationMode).toBe("INTERACTIVE_BROWSER_SESSION");
    expect(contract.credentialBoundary).toBe("SECURE_BROWSER_OR_VAULT_ONLY");
    const establish = contract.keyInteractions.find(
      (interaction) => interaction.interactionId === "establish-user-authorized-session",
    );
    expect(establish?.expectedJourneyState).toBe("USER_ACTION_REQUIRED");
    expect(establish?.description).toContain("ISOLATED");
  });

  it("the default mode is in the canonical W1-003 direct-local union (drift guard)", () => {
    expect(DIRECT_LOCAL_MODES).toContain(
      LOCAL_RAIL_USER_AUTHORIZED_JOURNEY_CONTRACT.realPath?.authorizationMode,
    );
    // and the PROVIDERLESS_RAIL variant is equally constructible (the
    // Stellar-style local rail with user-held local material)
    const providerless = localRailUserAuthorizedJourneyContract("PROVIDERLESS_RAIL");
    expect(DIRECT_LOCAL_MODES).toContain(providerless.realPath?.authorizationMode);
  });

  it("when the local rail applies, a missing user-authorized contract is a violation", () => {
    const report = checkProviderRolloutBrowserCoverage(
      {
        connectedProviders: CONNECTED_PROVIDERS,
        contracts: [
          ...deriveProviderRealPathContracts(CONNECTED_PROVIDERS),
          EXPIRED_SESSION_JOURNEY_CONTRACT,
        ],
        localRail: localRailApplies(),
      },
      MODES,
      DIRECT_LOCAL_MODES,
    );
    expect(report.passed).toBe(false);
    expect(
      report.violations.some(
        (violation) => violation.check === "local-rail-coverage",
      ),
    ).toBe(true);
  });

  it("a local-rail contract with a non-canonical mode is a violation", () => {
    const rogue = localRailUserAuthorizedJourneyContract("AMBIENT_CREDENTIAL");
    const report = checkProviderRolloutBrowserCoverage(
      {
        connectedProviders: [],
        contracts: [rogue, EXPIRED_SESSION_JOURNEY_CONTRACT],
        localRail: localRailApplies(),
      },
      MODES,
      DIRECT_LOCAL_MODES,
    );
    expect(report.passed).toBe(false);
    expect(
      report.violations.some(
        (violation) =>
          violation.check === "local-rail-coverage" &&
          violation.detail.includes("canonical direct-local modes"),
      ),
    ).toBe(true);
  });

  it("when an API credential exists (rail does not apply), the contract is not required", () => {
    const report = checkProviderRolloutBrowserCoverage(
      {
        connectedProviders: CONNECTED_PROVIDERS,
        contracts: [
          ...deriveProviderRealPathContracts(CONNECTED_PROVIDERS),
          EXPIRED_SESSION_JOURNEY_CONTRACT,
        ],
        localRail: { applies: false, reason: "api credential exists" },
      },
      MODES,
      DIRECT_LOCAL_MODES,
    );
    expect(report.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Expired sessions -> explicit reauthentication / customer-action-required
// ---------------------------------------------------------------------------

describe("expired-session journey contract", () => {
  it("produces the explicit EXPIRED state with customer-action-required reauthentication", () => {
    const contract = EXPIRED_SESSION_JOURNEY_CONTRACT;
    expect(contract.expiredSessionHandling).toEqual({
      producesExpiredState: true,
      customerActionRequired: true,
      reauthenticationPath: "ISOLATED_SECURE_BROWSER_SURFACE",
      continuesAsNewAttempt: true,
    });
    expect(
      contract.keyInteractions.some(
        (interaction) => interaction.expectedJourneyState === "EXPIRED",
      ),
    ).toBe(true);
  });

  it("the reauthentication/step-up states are the canonical browser-session lifecycle tokens (drift guard)", () => {
    expect(BROWSER_SESSION_AUTHORIZATION_STATES).toContain("STEP_UP_REQUIRED");
    expect(BROWSER_SESSION_AUTHORIZATION_STATES).toContain("ACTIVE");
    const states = EXPIRED_SESSION_JOURNEY_CONTRACT.keyInteractions.map(
      (interaction) => interaction.expectedJourneyState,
    );
    const canonicalStates: readonly string[] = BROWSER_SESSION_AUTHORIZATION_STATES;
    for (const token of states) {
      expect(canonicalStates.includes(token) || token === "EXPIRED").toBe(true);
    }
  });

  it("EXPIRED renders through the honest layer with a NEUTRAL tone (never failure)", async () => {
    const { renderTerminalHonestView } = await import("@payswap/ux");
    const view = renderTerminalHonestView("EXPIRED");
    expect(view.uiState).not.toBe("failed");
    expect(view.tone).not.toBe("negative");
  });

  it("a missing expired-session contract is a coverage violation", () => {
    const report = checkProviderRolloutBrowserCoverage(
      {
        connectedProviders: [],
        contracts: [],
        localRail: { applies: false, reason: "none" },
      },
      MODES,
      DIRECT_LOCAL_MODES,
    );
    expect(report.passed).toBe(false);
    expect(
      report.violations.some(
        (violation) => violation.check === "expired-session-coverage",
      ),
    ).toBe(true);
  });

  it("an expired-session contract without the explicit declaration is a violation", () => {
    const { expiredSessionHandling: _dropped, ...stripped } =
      EXPIRED_SESSION_JOURNEY_CONTRACT;
    const report = checkProviderRolloutBrowserCoverage(
      {
        connectedProviders: [],
        contracts: [stripped],
        localRail: { applies: false, reason: "none" },
      },
      MODES,
      DIRECT_LOCAL_MODES,
    );
    expect(report.passed).toBe(false);
    expect(
      report.violations.some(
        (violation) => violation.check === "expired-session-coverage",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Secret exclusion — form fields, cookies, session material
// ---------------------------------------------------------------------------

/** A field carrying obviously-synthetic secret-bearing material (test-only). */
function syntheticSecretField(
  name: string,
  fieldClass: BrowserObservationField["fieldClass"],
): BrowserObservationField {
  return {
    name,
    fieldClass,
    representation: "PLAIN_VALUE",
    value: "SYNTHETIC_test_secret_material_0123456789",
  };
}

function observationFixture(): BrowserJourneyObservation {
  return {
    journeyId: "provider-real-path:stripe",
    fields: [
      { name: "email", fieldClass: "NON_SECRET", representation: "PLAIN_VALUE", value: "customer@example.test" },
      syntheticSecretField("card-number", "FORM_FIELD_VALUE"),
      syntheticSecretField("authorization", "AUTHORIZATION_HEADER"),
      syntheticSecretField("session", "SESSION_MATERIAL"),
      {
        name: "card-cvc",
        fieldClass: "FORM_FIELD_VALUE",
        representation: "OPAQUE_REF",
        value: "opaque://provider-real-path:stripe/field/4",
      },
    ],
    cookieNames: ["__Host-session", "csrftoken"],
    sessionRef: "browser-session://synthetic-session-ref",
    notes: ["login/MFA completed inside the isolated secure browser surface"],
  };
}

describe("browser secret exclusion", () => {
  it("SECRET_BEARING_FIELD_CLASSES names the five secret-bearing classes", () => {
    expect(SECRET_BEARING_FIELD_CLASSES).toEqual([
      "FORM_FIELD_VALUE",
      "COOKIE",
      "SESSION_MATERIAL",
      "AUTHORIZATION_HEADER",
      "WEBHOOK_SIGNATURE",
    ]);
  });

  it("flags PLAIN_VALUE secret-bearing fields (the boundary violation)", () => {
    const report = checkBrowserObservationSecretExclusion(observationFixture());
    expect(report.ok).toBe(false);
    expect(report.violations.length).toBeGreaterThanOrEqual(3);
    expect(
      report.violations.some((v) =>
        v.problem.includes("form_field_value recorded as PLAIN_VALUE"),
      ),
    ).toBe(true);
    expect(
      report.violations.some((v) =>
        v.problem.includes("authorization_header recorded as PLAIN_VALUE"),
      ),
    ).toBe(true);
    expect(
      report.violations.some((v) =>
        v.problem.includes("session_material recorded as PLAIN_VALUE"),
      ),
    ).toBe(true);
  });

  it("flags cookie-assignment syntax recorded as a field value", () => {
    const observation: BrowserJourneyObservation = {
      journeyId: "local-rail-user-authorized-payment",
      fields: [
        {
          name: "observed-cookie",
          fieldClass: "COOKIE",
          representation: "PLAIN_VALUE",
          value: "session=SYNTHETIC1234567890; Path=/; HttpOnly; SameSite=Lax",
        },
      ],
      cookieNames: ["session"],
      notes: [],
    };
    const report = checkBrowserObservationSecretExclusion(observation);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        v.problem.includes("cookie assignment syntax"),
      ),
    ).toBe(true);
  });

  it("flags a session value that is not an opaque boundary reference", () => {
    const observation: BrowserJourneyObservation = {
      journeyId: "expired-session-reauthentication",
      fields: [],
      cookieNames: [],
      sessionRef: "raw-session-material-SYNTHETIC",
      notes: [],
    };
    const report = checkBrowserObservationSecretExclusion(observation);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        v.problem.includes("opaque boundary reference"),
      ),
    ).toBe(true);
  });

  it("flags secret-shaped values even in NON_SECRET plain fields (deep scan)", () => {
    const observation: BrowserJourneyObservation = {
      journeyId: "provider-real-path:stripe",
      fields: [
        {
          name: "operator-note",
          fieldClass: "NON_SECRET",
          representation: "PLAIN_VALUE",
          value: "key was sk_live_SYNTHETICabcdef123456",
        },
      ],
      cookieNames: [],
      notes: [],
    };
    const report = checkBrowserObservationSecretExclusion(observation);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        v.problem.includes("secret-shaped value"),
      ),
    ).toBe(true);
  });

  it("the REDACTED artifact is clean: no trace of any planted value survives", () => {
    const observation = observationFixture();
    const artifact = redactBrowserJourneyObservation(observation);
    // every field is an opaque ordinal reference
    for (const field of artifact.fields) {
      expect(field.representation).toBe("OPAQUE_REF");
      expect(field.ref).toMatch(/^opaque:\/\//);
      expect(field.ref).not.toContain("SYNTHETIC");
    }
    // cookie NAMES survive (names are not secret), values never existed
    expect(artifact.cookieNames).toEqual(["__Host-session", "csrftoken"]);
    // the opaque session reference survives
    expect(artifact.sessionRef).toBe("browser-session://synthetic-session-ref");
    expect(artifact.credentialBoundary).toBe("SECURE_BROWSER_OR_VAULT_ONLY");
    // the artifact passes the fail-closed deep scan
    const report = checkBrowserArtifactSecretExclusion(artifact);
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
  });

  it("redaction is deterministic (reproducible artifact)", () => {
    const first = redactBrowserJourneyObservation(observationFixture());
    const second = redactBrowserJourneyObservation(observationFixture());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("the artifact checker flags secret-shaped material in ANY artifact shape", () => {
    const report = checkBrowserArtifactSecretExclusion({
      journeyId: "provider-real-path:stripe",
      capturedNetwork: {
        authorization: "Bearer SYNTHETICBearerToken1234567890",
      },
    });
    expect(report.ok).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);
  });

  it("a leaked session value inside a redacted artifact is still caught", () => {
    const artifact = redactBrowserJourneyObservation(observationFixture());
    const leaking = {
      ...artifact,
      notes: [
        ...artifact.notes,
        "leaked authorization header was Bearer SYNTHETICBearerToken1234567890",
      ],
    };
    const report = checkBrowserArtifactSecretExclusion(leaking);
    expect(report.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The provider-rollout browser verification run record
// ---------------------------------------------------------------------------

describe("recordProviderRolloutBrowserVerification", () => {
  const runFixture = () =>
    rolloutContractSet().map((contract) => ({
      journeyId: contract.journeyId,
      checks: BROWSER_VERIFICATION_CHECKS.map((check) => ({
        check,
        passed: true,
        evidenceRef: `evidence://${contract.journeyId}/${check}`,
      })),
    }));

  it("assembles a passing report over the rollout journey set", () => {
    const report = recordProviderRolloutBrowserVerification(runFixture());
    expect(report.suiteId).toBe("payswap.provider-rollout-browser-verification");
    expect(report.workOrder).toBe("P2-W3-003");
    expect(report.passed).toBe(true);
    expect(report.runs).toHaveLength(5);
    expect(report.digest).toMatch(/^fnv1a64:/);
  });

  it("is reproducible (same runs, same digest)", () => {
    const first = recordProviderRolloutBrowserVerification(runFixture());
    const second = recordProviderRolloutBrowserVerification(runFixture());
    expect(second.digest).toBe(first.digest);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("fails closed when a journey is missing a required check", () => {
    const runs = runFixture().map((run, index) =>
      index === 0
        ? { journeyId: run.journeyId, checks: run.checks.slice(0, 5) }
        : run,
    );
    const report = recordProviderRolloutBrowserVerification(runs);
    expect(report.passed).toBe(false);
    expect(report.runs[0]?.passed).toBe(false);
    expect(
      report.runs[0]?.checks.some(
        (result) => !result.passed && result.evidenceRef === "missing",
      ),
    ).toBe(true);
  });

  it("fails closed when any check outcome failed", () => {
    const runs = runFixture().map((run, index) =>
      index === 2
        ? {
            journeyId: run.journeyId,
            checks: run.checks.map((result, i) =>
              i === 2 ? { ...result, passed: false } : result,
            ),
          }
        : run,
    );
    const report = recordProviderRolloutBrowserVerification(runs);
    expect(report.passed).toBe(false);
  });
});
