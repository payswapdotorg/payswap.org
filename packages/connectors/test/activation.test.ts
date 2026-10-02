import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_MODES,
  ActivationGateError,
  LEGAL_ACTIVATION_TRANSITIONS,
  TransferOutNotAuthorizedError,
  activateConnectedInstance,
  activationCustomerAction,
  applyProviderFailureIsolation,
  assertTransferOutAuthorized,
  authorizeTransferOut,
  browserSessionCustomerAction,
  browserSessionStateAt,
  completeReauthentication,
  deactivateConnectedInstance,
  establishBrowserSession,
  evaluateActivationGate,
  evaluateExecutionReadiness,
  evaluateProviderlessRailGate,
  expireActivation,
  expireBrowserSession,
  hasTransferOutAuthority,
  isBrowserSessionUsable,
  markActivationUnknown,
  reconnectAuthorization,
  registerPendingActivation,
  requireReauthentication,
  requireProviderStepUp,
  resolveUnknownAuthorization,
  revokeActivation,
  revokeBrowserSession,
  revokeTransferOut,
  synchronizeBrowserSessionActivation,
  transferOutRequiresStepUp,
} from "../src/activation.js";
import type {
  ActivationAuthorizationEvidence,
  ActivationRequest,
  BrowserSessionAuthorization,
  ConnectedInstanceActivation,
  ProviderlessRailEvidence,
} from "../src/activation.js";
import type { ConnectedCapabilityInstance } from "../src/instances.js";
import { observeCapability } from "../src/observations.js";
import type { CapabilityObservation } from "../src/observations.js";
import { PROVIDER_STATE_FAMILIES } from "../src/provider-state.js";
import { validateConnectedCapabilityInstance } from "../src/instances.js";
import type { ConnectorAuthorizationState } from "../src/instances.js";

const T0 = "2026-10-02T06:37:38Z";
const T1 = "2026-10-15T00:00:00Z";
const T2 = "2026-11-01T00:00:00Z";
const T3 = "2026-12-01T00:00:00Z";

// ---------------------------------------------------------------------------
// Fixtures — synthetic scope/refs only; no credential material ever appears
// in this control plane (material lives behind the adapter CredentialBroker).
// ---------------------------------------------------------------------------

interface InstanceFixture {
  readonly instanceId?: string;
  readonly providerName?: string;
  readonly authorization?: Partial<ConnectorAuthorizationState>;
  readonly credentialKind?: ConnectedCapabilityInstance["credentialScope"]["credentialKind"];
  readonly eligibility?: Partial<ConnectedCapabilityInstance["eligibility"]>;
  readonly missingPermissions?: readonly string[];
  readonly currencies?: readonly string[];
}

function makeInstance(fixture: InstanceFixture = {}): ConnectedCapabilityInstance {
  const instance = {
    instanceId: fixture.instanceId ?? "inst-stripe-card-payments-0001",
    capabilityId: "cap.card_payments",
    implementationId: "impl.stripe.card-payments",
    providerName: fixture.providerName ?? "STRIPE",
    providerVersion: "2026-10-01",
    accountRef: "acct_SYNTHETIC_0001",
    tenantRef: "tenant_SYNTHETIC_0001",
    authorization: {
      status: "ACTIVE" as const,
      grantedAt: T0,
      authorizationRef: "authorization://stripe/grant-20261002-0001",
      ...fixture.authorization,
    },
    credentialScope: {
      credentialRef: "vault://payswap/providers/stripe/test-20261002",
      credentialKind: fixture.credentialKind ?? "API_KEY",
    },
    geography: { countries: ["FR", "GH"] },
    currencies: fixture.currencies ?? ["EUR", "USD", "GHS"],
    permissionState: {
      granted: ["card_payments", "transfers"],
      requested: ["card_payments", "transfers"],
      missing: fixture.missingPermissions ?? [],
    },
    eligibility: {
      eligible: true,
      reasons: [],
      ...fixture.eligibility,
    },
    configuration: { livemode: false },
  };
  return validateConnectedCapabilityInstance(instance);
}

function stripeEvidence(
  overrides: {
    [K in keyof ActivationAuthorizationEvidence]?:
      | ActivationAuthorizationEvidence[K]
      | undefined;
  } = {},
): ActivationAuthorizationEvidence {
  const evidence: Record<string, unknown> = {
    authorizationState: {
      status: "ACTIVE",
      grantedAt: T0,
      authorizationRef: "authorization://stripe/grant-20261002-0001",
    },
    authorizationRef: "vault://payswap/providers/stripe/test-20261002",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete evidence[key];
    } else {
      evidence[key] = value;
    }
  }
  return evidence as unknown as ActivationAuthorizationEvidence;
}

function providerlessEvidence(
  overrides: {
    established?: boolean;
    missingEvidenceRef?: boolean;
  } = {},
): ProviderlessRailEvidence {
  const established = overrides.established ?? true;
  const ref = (name: string): string =>
    overrides.missingEvidenceRef === true ? "" : `evidence://stellar/${name}`;
  return {
    externalCapability: {
      gate: "EXTERNAL_CAPABILITY",
      established,
      evidenceRef: ref("capability"),
    },
    ownerAuthorization: {
      gate: "OWNER_AUTHORIZATION",
      established,
      evidenceRef: ref("owner-consent"),
    },
    legalSecurityPermissibility: {
      gate: "LEGAL_SECURITY_PERMISSIBILITY",
      established,
      evidenceRef: ref("legal-review"),
    },
    evidencePath: {
      gate: "EVIDENCE_PATH",
      established,
      evidenceRef: ref("reconciliation-path"),
    },
  };
}

function activeSession(
  overrides: {
    readonly ref?: string;
    readonly accountRef?: string;
    readonly providerName?: string;
    readonly expiresAt?: string;
  } = {},
): BrowserSessionAuthorization {
  return establishBrowserSession({
    browserSessionRef: overrides.ref ?? "browser-session://secure-browser-af-1/sess-0001",
    providerName: overrides.providerName ?? "MTN_MOMO",
    accountRef: overrides.accountRef ?? "momo-wallet-0001",
    establishedAt: T0,
    // a live session realistically carries a future expiry; the explicit
    // override (e.g. T1 for the expired-session refusal) still wins
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : { expiresAt: T3 }),
  });
}

function momoInstance(
  overrides: InstanceFixture & { accountRef?: string } = {},
): ConnectedCapabilityInstance {
  const base = makeInstance({
    instanceId: "inst-mtn-momo-collect-0001",
    providerName: "MTN_MOMO",
    credentialKind: "SESSION",
    ...overrides,
  });
  return validateConnectedCapabilityInstance({
    ...base,
    accountRef: overrides.accountRef ?? "momo-wallet-0001",
  });
}

function stellarInstance(): ConnectedCapabilityInstance {
  return makeInstance({
    instanceId: "inst-stellar-usdc-bridge-0001",
    providerName: "STELLAR_TESTNET",
    credentialKind: "API_KEY",
  });
}

function observation(
  instanceId: string,
  overrides: {
    readonly capabilityState?: CapabilityObservation["capabilityState"];
    readonly sourceAvailability?: CapabilityObservation["sourceAvailability"];
    readonly eligibility?: CapabilityObservation["eligibility"];
    readonly version?: number;
  } = {},
): CapabilityObservation {
  return observeCapability({
    instanceId,
    observedAt: T1,
    observationVersion: overrides.version ?? 1,
    capabilityState: overrides.capabilityState ?? "AVAILABLE",
    sourceAvailability: overrides.sourceAvailability ?? "REACHABLE",
    eligibility: overrides.eligibility ?? "ELIGIBLE",
    health: { status: "HEALTHY", lastCheckedAt: T1 },
    provenance: { providerName: "fixture", source: "PROVIDER_API", capturedAt: T1 },
  });
}

// ---------------------------------------------------------------------------

describe("authorization-mode vocabulary (P2-W1-001)", () => {
  it("declares exactly the five phase-2 modes", () => {
    expect([...AUTHORIZATION_MODES]).toEqual([
      "DELEGATED_OAUTH",
      "CONNECTED_ACCOUNT",
      "SCOPED_API_CREDENTIAL",
      "INTERACTIVE_BROWSER_SESSION",
      "PROVIDERLESS_RAIL",
    ]);
  });
});

describe("pending registration", () => {
  it("snapshots connection scope without granting anything", () => {
    const record = registerPendingActivation(
      makeInstance(),
      "SCOPED_API_CREDENTIAL",
      T0,
    );
    expect(record.state).toBe("PENDING");
    expect(record.history).toEqual([]);
    expect(record.connectionScope.accountRef).toBe("acct_SYNTHETIC_0001");
    expect(record.connectionScope.credentialRef).toBe(
      "vault://payswap/providers/stripe/test-20261002",
    );
    expect(record.transferOut).toBeUndefined();
    expect(() =>
      assertTransferOutAuthorized(record, T1),
    ).toThrow(TransferOutNotAuthorizedError);
  });

  it("rejects a provider catalogue entry (INV-C05) and unknown modes", () => {
    const catalogueEntry = {
      catalogueEntryId: "cat-stripe-0001",
      providerName: "STRIPE",
      providerVersion: "2026-10-01",
      capabilityId: "cap.card_payments",
      summary: "Stripe card payments",
      advertisedScope: {
        platformWide: true as const,
        advertisedGeographies: ["FR"],
        advertisedCurrencies: ["EUR"],
      },
    };
    expect(() =>
      registerPendingActivation(
        catalogueEntry as unknown as ConnectedCapabilityInstance,
        "SCOPED_API_CREDENTIAL",
        T0,
      ),
    ).toThrow(/catalogue/);
    expect(() =>
      registerPendingActivation(makeInstance(), "PASSWORD" as never, T0),
    ).toThrow(/authorization mode/);
  });
});

describe("activation gate (fail-closed)", () => {
  it("activates a fully-evidenced SCOPED_API_CREDENTIAL connection", () => {
    const record = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    expect(record.state).toBe("ACTIVE");
    expect(record.authorizationMode).toBe("SCOPED_API_CREDENTIAL");
    expect(record.authorizationRef).toBe(
      "vault://payswap/providers/stripe/test-20261002",
    );
    expect(record.transferOut).toBeUndefined();
    expect(record.history[record.history.length - 1]?.cause).toBe(
      "AUTHORIZATION_EVIDENCE_VERIFIED",
    );
  });

  it("refuses activation when the authorization artifact reference is missing", () => {
    const report = evaluateActivationGate({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence({ authorizationRef: undefined }),
      activatedAt: T1,
    });
    expect(report.authorized).toBe(false);
    expect(
      report.checks.find((c) => c.requirement === "mode-evidence")?.passed,
    ).toBe(false);
    expect(() =>
      activateConnectedInstance({
        instance: makeInstance(),
        authorizationMode: "SCOPED_API_CREDENTIAL",
        evidence: stripeEvidence({ authorizationRef: undefined }),
        activatedAt: T1,
      }),
    ).toThrow(ActivationGateError);
  });

  it("refuses activation when authorization is not ACTIVE (snapshot or fresh evidence)", () => {
    const snapshotRevoked = evaluateActivationGate({
      instance: makeInstance({ authorization: { status: "REVOKED" } }),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    expect(
      snapshotRevoked.checks.find((c) => c.requirement === "authorization-state-active")
        ?.passed,
    ).toBe(false);

    const freshExpired = evaluateActivationGate({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence({
        authorizationState: { status: "EXPIRED", grantedAt: T0 },
      }),
      activatedAt: T1,
    });
    expect(freshExpired.authorized).toBe(false);
  });

  it("refuses activation when eligibility evidence is missing or negative", () => {
    const report = evaluateActivationGate({
      instance: makeInstance({
        eligibility: { eligible: false, reasons: ["payouts_not_enabled"] },
      }),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    expect(
      report.checks.find((c) => c.requirement === "eligibility-evidence")?.passed,
    ).toBe(false);
    expect(report.authorized).toBe(false);
  });

  it("refuses activation when permissions are missing", () => {
    const report = evaluateActivationGate({
      instance: makeInstance({ missingPermissions: ["transfers"] }),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    expect(
      report.checks.find((c) => c.requirement === "permission-scope")?.passed,
    ).toBe(false);
  });

  it("refuses activation when the credential scope kind contradicts the mode", () => {
    const report = evaluateActivationGate({
      instance: makeInstance({ credentialKind: "SESSION" }),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    expect(
      report.checks.find((c) => c.requirement === "credential-scope-consistency")
        ?.passed,
    ).toBe(false);
    expect(() =>
      activateConnectedInstance({
        instance: makeInstance({ credentialKind: "SESSION" }),
        authorizationMode: "SCOPED_API_CREDENTIAL",
        evidence: stripeEvidence(),
        activatedAt: T1,
      }),
    ).toThrow(ActivationGateError);
  });

  it("refuses a provider catalogue entry outright (INV-C05)", () => {
    const catalogueEntry = {
      catalogueEntryId: "cat-stripe-0001",
      providerName: "STRIPE",
      providerVersion: "2026-10-01",
      capabilityId: "cap.card_payments",
      summary: "Stripe card payments",
      advertisedScope: {
        platformWide: true as const,
        advertisedGeographies: ["FR"],
        advertisedCurrencies: ["EUR"],
      },
    };
    const report = evaluateActivationGate({
      instance: catalogueEntry as unknown as ConnectedCapabilityInstance,
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    expect(report.authorized).toBe(false);
    expect(
      report.checks.find((c) => c.requirement === "connected-instance")?.detail,
    ).toContain("INV-C05");
  });

  it("requires explicit account/tenant/geography/currency scope", () => {
    const sparse = makeInstance();
    const broken = {
      ...sparse,
      geography: { countries: [] },
      currencies: [],
    } as ConnectedCapabilityInstance;
    const report = evaluateActivationGate({
      instance: broken,
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    expect(
      report.checks.find((c) => c.requirement === "explicit-scope")?.passed,
    ).toBe(false);
  });
});

describe("PROVIDERLESS_RAIL gate (local rails without provider credentials)", () => {
  it("passes only when all four gates are established with evidence", () => {
    const passing = evaluateProviderlessRailGate(providerlessEvidence());
    expect(passing.passed).toBe(true);
    expect(passing.checks.map((c) => c.gate)).toEqual([
      "EXTERNAL_CAPABILITY",
      "OWNER_AUTHORIZATION",
      "LEGAL_SECURITY_PERMISSIBILITY",
      "EVIDENCE_PATH",
    ]);
  });

  it("fails closed when any gate is unestablished or evidence-less", () => {
    const unestablished = evaluateProviderlessRailGate(
      providerlessEvidence({ established: false }),
    );
    expect(unestablished.passed).toBe(false);
    const evidenceless = evaluateProviderlessRailGate(
      providerlessEvidence({ missingEvidenceRef: true }),
    );
    expect(evidenceless.passed).toBe(false);
    expect(
      evidenceless.checks.every((c) => !c.passed),
    ).toBe(true);
  });

  it("activates a providerless rail only through the four gates", () => {
    const request = (evidence: ActivationAuthorizationEvidence): ActivationRequest => ({
      instance: stellarInstance(),
      authorizationMode: "PROVIDERLESS_RAIL",
      evidence,
      activatedAt: T1,
    });
    expect(() =>
      activateConnectedInstance(
        request({
          authorizationState: { status: "ACTIVE", grantedAt: T0 },
        }),
      ),
    ).toThrow(ActivationGateError);

    const activated = activateConnectedInstance(
      request({
        authorizationState: { status: "ACTIVE", grantedAt: T0 },
        providerlessRail: providerlessEvidence(),
      }),
    );
    expect(activated.state).toBe("ACTIVE");
    expect(activated.authorizationMode).toBe("PROVIDERLESS_RAIL");
  });
});

describe("INTERACTIVE_BROWSER_SESSION activation", () => {
  it("activates with a live session bound to the same account and provider", () => {
    const record = activateConnectedInstance({
      instance: momoInstance(),
      authorizationMode: "INTERACTIVE_BROWSER_SESSION",
      evidence: {
        authorizationState: { status: "ACTIVE", grantedAt: T0 },
        browserSession: activeSession(),
      },
      activatedAt: T1,
    });
    expect(record.state).toBe("ACTIVE");
    expect(record.browserSession?.browserSessionRef).toBe(
      "browser-session://secure-browser-af-1/sess-0001",
    );
    // the agent-visible record carries the OPAQUE reference only — never
    // cookies, storage or credential fields
    const serialized = JSON.stringify(record);
    expect(serialized).toContain("browser-session://secure-browser-af-1/sess-0001");
    expect(Object.keys(record.browserSession ?? {}).sort()).toEqual([
      "accountRef",
      "browserSessionRef",
      "establishedAt",
      "expiresAt",
      "lastStateChangeAt",
      "providerName",
      "state",
    ]);
  });

  it("refuses an expired session at the activation instant", () => {
    const session = activeSession({ expiresAt: T1 });
    const report = evaluateActivationGate({
      instance: momoInstance(),
      authorizationMode: "INTERACTIVE_BROWSER_SESSION",
      evidence: {
        authorizationState: { status: "ACTIVE", grantedAt: T0 },
        browserSession: session,
      },
      activatedAt: T2,
    });
    expect(report.authorized).toBe(false);
    expect(
      report.checks.find((c) => c.requirement === "mode-evidence")?.detail,
    ).toContain("EXPIRED");
  });

  it("refuses a session bound to a different account or provider", () => {
    const accountMismatch = evaluateActivationGate({
      instance: momoInstance(),
      authorizationMode: "INTERACTIVE_BROWSER_SESSION",
      evidence: {
        authorizationState: { status: "ACTIVE", grantedAt: T0 },
        browserSession: activeSession({ accountRef: "other-wallet-0002" }),
      },
      activatedAt: T1,
    });
    expect(accountMismatch.authorized).toBe(false);

    const providerMismatch = evaluateActivationGate({
      instance: momoInstance(),
      authorizationMode: "INTERACTIVE_BROWSER_SESSION",
      evidence: {
        authorizationState: { status: "ACTIVE", grantedAt: T0 },
        browserSession: activeSession({ providerName: "AIRTEL_MONEY" }),
      },
      activatedAt: T1,
    });
    expect(providerMismatch.authorized).toBe(false);
  });

  it("refuses a parallel credential reference alongside the session (ambiguous authorization)", () => {
    const report = evaluateActivationGate({
      instance: momoInstance(),
      authorizationMode: "INTERACTIVE_BROWSER_SESSION",
      evidence: {
        authorizationState: { status: "ACTIVE", grantedAt: T0 },
        browserSession: activeSession(),
        authorizationRef: "vault://payswap/providers/mtn-momo/sandbox-20261002",
      },
      activatedAt: T1,
    });
    expect(report.authorized).toBe(false);
    expect(
      report.checks.find((c) => c.requirement === "mode-evidence")?.detail,
    ).toContain("parallel");
  });
});

describe("browser-session lifecycle (first-class customer-action states)", () => {
  it("supports expiry, revocation, reauthentication and provider step-up", () => {
    const session = activeSession({ expiresAt: T3 });

    const reauth = requireReauthentication(session, T1, "session aged 30 days");
    expect(reauth.state).toBe("REAUTHENTICATION_REQUIRED");
    const action = browserSessionCustomerAction(reauth);
    expect(action?.family).toBe("customer_action_required");
    expect(action?.lifecycleStep).toBe("reauthentication_required");
    expect(PROVIDER_STATE_FAMILIES).toContain("customer_action_required");

    const stepUp = requireProviderStepUp(reauth, T1, "SCA required above 100 GHS");
    expect(stepUp.state).toBe("STEP_UP_REQUIRED");
    expect(browserSessionCustomerAction(stepUp)?.lifecycleStep).toBe("provider_step_up");

    const completed = completeReauthentication(stepUp, T2);
    expect(completed.state).toBe("ACTIVE");
    expect(completed.lastCustomerActionAt).toBe(T2);
    expect(browserSessionCustomerAction(completed)).toBeUndefined();

    const expired = expireBrowserSession(completed, T3);
    expect(expired.state).toBe("EXPIRED");
    const revoked = revokeBrowserSession(expired, T3);
    expect(revoked.state).toBe("REVOKED");
  });

  it("enforces legal session transitions (an expired session cannot be completed)", () => {
    const expired = expireBrowserSession(activeSession(), T1);
    expect(() => completeReauthentication(expired, T2)).toThrow(/illegal/);
    const revoked = revokeBrowserSession(activeSession(), T1);
    expect(() => requireReauthentication(revoked, T2, "x")).toThrow(/illegal/);
  });

  it("derives effective expiry at an explicit instant", () => {
    const session = activeSession({ expiresAt: T2 });
    expect(isBrowserSessionUsable(session, T1)).toBe(true);
    expect(browserSessionStateAt(session, T2)).toBe("EXPIRED");
    expect(isBrowserSessionUsable(session, T2)).toBe(false);
  });
});

describe("browser-session ↔ activation synchronization", () => {
  function activatedMomo(): ConnectedInstanceActivation {
    return activateConnectedInstance({
      instance: momoInstance(),
      authorizationMode: "INTERACTIVE_BROWSER_SESSION",
      evidence: {
        authorizationState: { status: "ACTIVE", grantedAt: T0 },
        browserSession: activeSession(),
      },
      activatedAt: T1,
    });
  }

  it("a reauthentication-required session gates the activation to PENDING with the customer action attached", () => {
    const record = activatedMomo();
    const gated = synchronizeBrowserSessionActivation(
      record,
      requireReauthentication(record.browserSession as BrowserSessionAuthorization, T2, "provider policy"),
      T2,
    );
    expect(gated.state).toBe("PENDING");
    const action = activationCustomerAction(gated);
    expect(action?.family).toBe("customer_action_required");
    expect(action?.lifecycleStep).toBe("reauthentication_required");
    // readiness blocks on the customer action
    const readiness = evaluateExecutionReadiness(gated, observation(gated.instanceId));
    expect(readiness.executable).toBe(false);
    expect(readiness.blockers.join(" ")).toContain("customer-action-required");
  });

  it("a step-up-required session is a first-class provider step-up state", () => {
    const record = activatedMomo();
    const gated = synchronizeBrowserSessionActivation(
      record,
      requireProviderStepUp(record.browserSession as BrowserSessionAuthorization, T2, "SCA"),
      T2,
    );
    expect(gated.state).toBe("PENDING");
    expect(activationCustomerAction(gated)?.lifecycleStep).toBe("provider_step_up");
  });

  it("session expiry and revocation propagate to the activation", () => {
    const record = activatedMomo();
    const expired = synchronizeBrowserSessionActivation(
      record,
      expireBrowserSession(record.browserSession as BrowserSessionAuthorization, T2),
      T2,
    );
    expect(expired.state).toBe("EXPIRED");

    const record2 = activatedMomo();
    const revoked = synchronizeBrowserSessionActivation(
      record2,
      revokeBrowserSession(record2.browserSession as BrowserSessionAuthorization, T2),
      T2,
    );
    expect(revoked.state).toBe("REVOKED");
  });

  it("reactivation after reauthentication requires a NEW session reference", () => {
    const record = activatedMomo();
    const gated = synchronizeBrowserSessionActivation(
      record,
      requireReauthentication(record.browserSession as BrowserSessionAuthorization, T2, "policy"),
      T2,
    );

    // the SAME session reference cannot reactivate…
    const sameSession = completeReauthentication(
      gated.browserSession as BrowserSessionAuthorization,
      T2,
    );
    const refused = evaluateActivationGate({
      instance: momoInstance(),
      authorizationMode: "INTERACTIVE_BROWSER_SESSION",
      evidence: {
        authorizationState: { status: "ACTIVE", grantedAt: T2 },
        browserSession: sameSession,
      },
      activatedAt: T2,
      continuingFrom: gated,
    });
    expect(refused.authorized).toBe(false);

    // …a freshly established session can.
    const fresh = activateConnectedInstance({
      instance: momoInstance(),
      authorizationMode: "INTERACTIVE_BROWSER_SESSION",
      evidence: {
        authorizationState: { status: "ACTIVE", grantedAt: T2 },
        browserSession: activeSession({ ref: "browser-session://secure-browser-af-1/sess-0002" }),
      },
      activatedAt: T2,
      continuingFrom: gated,
      activationCause: "REAUTHENTICATION_COMPLETED",
    });
    expect(fresh.state).toBe("ACTIVE");
    expect(fresh.browserSession?.browserSessionRef).toBe(
      "browser-session://secure-browser-af-1/sess-0002",
    );
    expect(fresh.history[fresh.history.length - 1]?.cause).toBe(
      "REAUTHENTICATION_COMPLETED",
    );
  });

  it("refuses to synchronize a foreign session reference", () => {
    const record = activatedMomo();
    expect(() =>
      synchronizeBrowserSessionActivation(
        record,
        activeSession({ ref: "browser-session://secure-browser-af-1/sess-9999" }),
        T2,
      ),
    ).toThrow(/mismatch/);
  });
});

describe("the activation state machine", () => {
  it("publishes the legal transition table (PENDING → ACTIVE → REVOKED|EXPIRED|UNKNOWN + recovery)", () => {
    expect(LEGAL_ACTIVATION_TRANSITIONS.PENDING).toEqual(["ACTIVE", "REVOKED", "EXPIRED"]);
    expect(LEGAL_ACTIVATION_TRANSITIONS.ACTIVE).toEqual([
      "REVOKED",
      "EXPIRED",
      "UNKNOWN",
      "PENDING",
    ]);
    expect(LEGAL_ACTIVATION_TRANSITIONS.REVOKED).toEqual(["PENDING"]);
    expect(LEGAL_ACTIVATION_TRANSITIONS.EXPIRED).toEqual(["PENDING", "REVOKED"]);
    expect(LEGAL_ACTIVATION_TRANSITIONS.UNKNOWN).toEqual(["ACTIVE", "REVOKED", "EXPIRED"]);
  });

  it("deactivation and revocation both land in REVOKED with distinct causes", () => {
    const base = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    const deactivated = deactivateConnectedInstance(base, {
      at: T2,
      actor: "operator-1",
      reason: "operator hold",
    });
    expect(deactivated.state).toBe("REVOKED");
    expect(deactivated.history[deactivated.history.length - 1]?.cause).toBe(
      "OPERATOR_DEACTIVATED",
    );

    const revoked = revokeActivation(base, { at: T2, reason: "owner disconnected" });
    expect(revoked.state).toBe("REVOKED");
    expect(revoked.history[revoked.history.length - 1]?.cause).toBe("OWNER_REVOKED");
  });

  it("history is append-only and prior records are never mutated", () => {
    const pending = registerPendingActivation(makeInstance(), "SCOPED_API_CREDENTIAL", T0);
    const active = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
      continuingFrom: pending,
    });
    const revoked = deactivateConnectedInstance(active, { at: T2, reason: "cleanup" });
    expect(pending.history).toEqual([]);
    expect(active.history.length).toBe(1);
    expect(revoked.history.length).toBe(2);
    expect(revoked.history[0]).toEqual(active.history[0]);
    expect(() => {
      (revoked as unknown as Record<string, unknown>)["state"] = "ACTIVE";
    }).toThrow();
  });

  it("expiry → reconnection requires a FRESH authorization artifact", () => {
    const active = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    const expired = expireActivation(active, T2, "credential rotated at provider");
    expect(expired.state).toBe("EXPIRED");

    expect(() =>
      reconnectAuthorization(expired, "vault://payswap/providers/stripe/test-20261002", T2),
    ).toThrow(/FRESH/);

    const reconnected = reconnectAuthorization(
      expired,
      "vault://payswap/providers/stripe/test-20261003",
      T2,
    );
    expect(reconnected.state).toBe("PENDING");

    const reactivated = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence({
        authorizationRef: "vault://payswap/providers/stripe/test-20261003",
      }),
      activatedAt: T2,
      continuingFrom: reconnected,
    });
    expect(reactivated.state).toBe("ACTIVE");
    expect(reactivated.authorizationRef).toBe(
      "vault://payswap/providers/stripe/test-20261003",
    );
  });

  it("UNKNOWN is resolved by reconciliation — never by blind re-activation without evidence", () => {
    const active = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    const unknown = markActivationUnknown(active, T2, "provider status endpoint ambiguous");
    expect(unknown.state).toBe("UNKNOWN");

    const resolvedRevoked = resolveUnknownAuthorization(unknown, "REVOKED", {
      at: T3,
      reason: "provider confirmed revocation",
    });
    expect(resolvedRevoked.state).toBe("REVOKED");

    const unknown2 = markActivationUnknown(active, T2, "ambiguity");
    const resolvedExpired = resolveUnknownAuthorization(unknown2, "EXPIRED", {
      at: T3,
      reason: "provider confirmed expiry",
    });
    expect(resolvedExpired.state).toBe("EXPIRED");

    // reconciliation to AUTHORIZED runs the full gate with continuingFrom
    const unknown3 = markActivationUnknown(active, T2, "ambiguity");
    const reactivated = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T3,
      continuingFrom: unknown3,
      activationCause: "RECONCILIATION_RESOLVED",
    });
    expect(reactivated.state).toBe("ACTIVE");
    expect(reactivated.history[reactivated.history.length - 1]?.cause).toBe(
      "RECONCILIATION_RESOLVED",
    );
  });

  it("a REVOKED activation cannot jump straight back to ACTIVE", () => {
    const active = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    const revoked = revokeActivation(active, { at: T2, reason: "owner disconnected" });
    const report = evaluateActivationGate({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T3,
      continuingFrom: revoked,
    });
    expect(report.authorized).toBe(false);
    expect(
      report.checks.find((c) => c.requirement === "continuity")?.passed,
    ).toBe(false);
  });

  it("a revoked authorization artifact cannot be reused to reconnect", () => {
    const active = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    const revoked = revokeActivation(active, { at: T2, reason: "owner disconnected" });
    const report = evaluateActivationGate({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T3,
      continuingFrom: revoked,
    });
    expect(
      report.checks.find((c) => c.requirement === "fresh-authorization-artifact")
        ?.passed,
    ).toBe(false);
  });
});

describe("transfer-out (debit/withdrawal) is a SEPARATE scope", () => {
  function activeStripe(): ConnectedInstanceActivation {
    return activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
  }

  it("connecting an account never grants debit authority (fail-closed default)", () => {
    const record = activeStripe();
    expect(record.transferOut).toBeUndefined();
    expect(hasTransferOutAuthority(record, T2)).toBe(false);
    expect(() => assertTransferOutAuthorized(record, T2)).toThrow(
      TransferOutNotAuthorizedError,
    );
    expect(() => assertTransferOutAuthorized(record, T2, { currency: "EUR" })).toThrow(
      /connection scope only/,
    );
  });

  it("authorizeTransferOut demands its own artifact and a bounded currency scope", () => {
    const record = activeStripe();
    expect(() =>
      authorizeTransferOut(record, {
        authorizationRef: "vault://payswap/providers/stripe/test-20261002",
        authorizedAt: T2,
        currencyScope: ["EUR"],
        requiresProviderStepUp: true,
      }),
    ).toThrow(/OWN authorization artifact/);

    expect(() =>
      authorizeTransferOut(record, {
        authorizationRef: "authorization://stripe/payout-consent-0001",
        authorizedAt: T2,
        currencyScope: ["JPY"],
        requiresProviderStepUp: false,
      }),
    ).toThrow(/exceeds the connection scope/);
  });

  it("an explicit grant authorizes transfer-out within scope, limits and expiry", () => {
    const record = activeStripe();
    const granted = authorizeTransferOut(record, {
      authorizationRef: "authorization://stripe/payout-consent-0001",
      authorizedAt: T2,
      expiresAt: T3,
      currencyScope: ["EUR", "USD"],
      maxSingleAmountMinor: 500000,
      requiresProviderStepUp: true,
    });
    expect(hasTransferOutAuthority(granted, T2)).toBe(true);
    expect(transferOutRequiresStepUp(granted)).toBe(true);
    assertTransferOutAuthorized(granted, T2, { currency: "EUR", amountMinor: 499999 });

    expect(() =>
      assertTransferOutAuthorized(granted, T2, { currency: "GHS" }),
    ).toThrow(/not authorized for currency/);
    expect(() =>
      assertTransferOutAuthorized(granted, T2, { currency: "EUR", amountMinor: 500001 }),
    ).toThrow(/per-transfer limit/);
    expect(() => assertTransferOutAuthorized(granted, T3)).toThrow(/expired/);
  });

  it("revoking the grant withdraws debit authority", () => {
    const record = activeStripe();
    const granted = authorizeTransferOut(record, {
      authorizationRef: "authorization://stripe/payout-consent-0001",
      authorizedAt: T2,
      currencyScope: ["EUR"],
      requiresProviderStepUp: false,
    });
    const revoked = revokeTransferOut(granted, T2);
    expect(revoked.transferOut).toBeUndefined();
    expect(() => assertTransferOutAuthorized(revoked, T2)).toThrow(
      TransferOutNotAuthorizedError,
    );
  });

  it("re-activation after an ambiguity episode drops any prior transfer-out grant (fail-closed)", () => {
    const record = activeStripe();
    const granted = authorizeTransferOut(record, {
      authorizationRef: "authorization://stripe/payout-consent-0001",
      authorizedAt: T2,
      currencyScope: ["EUR"],
      requiresProviderStepUp: false,
    });
    const unknown = markActivationUnknown(granted, T2, "provider ambiguity");
    const reactivated = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T3,
      continuingFrom: unknown,
      activationCause: "RECONCILIATION_RESOLVED",
    });
    expect(reactivated.state).toBe("ACTIVE");
    expect(reactivated.transferOut).toBeUndefined();
    expect(() => assertTransferOutAuthorized(reactivated, T3)).toThrow(
      TransferOutNotAuthorizedError,
    );
  });
});

describe("capability state and source availability remain distinct (INV-C01/C02)", () => {
  it("an unreachable source blocks execution WITHOUT changing the activation state", () => {
    const record = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    const unreachable = observation(record.instanceId, {
      sourceAvailability: "UNREACHABLE",
      capabilityState: "AVAILABLE",
    });
    expect(unreachable.availability).toBe("UNKNOWN");
    const readiness = evaluateExecutionReadiness(record, unreachable);
    expect(readiness.executable).toBe(false);
    expect(readiness.availability).toBe("UNKNOWN");
    expect(readiness.blockers.join(" ")).toContain("availability:UNKNOWN");
    // the two axes are distinct: availability never mutates activation state
    expect(record.state).toBe("ACTIVE");
    expect(readiness.activationState).toBe("ACTIVE");
  });

  it("a fully available, eligible observation of an ACTIVE activation is executable", () => {
    const record = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    const ready = evaluateExecutionReadiness(
      record,
      observation(record.instanceId, { version: 2 }),
    );
    expect(ready.executable).toBe(true);
    expect(ready.blockers).toEqual([]);
  });

  it("a non-ACTIVE activation is never executable regardless of availability", () => {
    const pending = registerPendingActivation(makeInstance(), "SCOPED_API_CREDENTIAL", T0);
    const readiness = evaluateExecutionReadiness(
      pending,
      observation(pending.instanceId),
    );
    expect(readiness.executable).toBe(false);
    expect(readiness.blockers.join(" ")).toContain("activation-state:PENDING");
  });

  it("rejects observations of a different instance", () => {
    const record = activateConnectedInstance({
      instance: makeInstance(),
      authorizationMode: "SCOPED_API_CREDENTIAL",
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
    expect(() =>
      evaluateExecutionReadiness(record, observation("inst-other-9999")),
    ).toThrow(/does not match/);
  });
});

describe("provider failure isolation", () => {
  function activeFor(fixture: InstanceFixture, mode: "SCOPED_API_CREDENTIAL" = "SCOPED_API_CREDENTIAL"): ConnectedInstanceActivation {
    return activateConnectedInstance({
      instance: makeInstance(fixture),
      authorizationMode: mode,
      evidence: stripeEvidence(),
      activatedAt: T1,
    });
  }

  it("an INSTANCE-scoped failure isolates exactly one instance", () => {
    const stripeA = activeFor({ instanceId: "inst-stripe-a", providerName: "STRIPE" });
    const stripeB = activeFor({ instanceId: "inst-stripe-b", providerName: "STRIPE" });
    const paystack = activeFor({
      instanceId: "inst-paystack-a",
      providerName: "PAYSTACK",
    });
    const report = applyProviderFailureIsolation(
      {
        failingInstanceId: "inst-stripe-a",
        providerName: "STRIPE",
        scope: "INSTANCE",
        detectedAt: T2,
      },
      [stripeA, stripeB, paystack],
    );
    expect(report.affectedInstanceIds).toEqual(["inst-stripe-a"]);
    expect(report.isolatedInstanceIds).toEqual(["inst-stripe-b", "inst-paystack-a"]);
    const isolated = new Map(report.activations.map((r) => [r.instanceId, r]));
    expect(isolated.get("inst-stripe-a")?.state).toBe("UNKNOWN");
    // UNRELATED provider instances are returned as the SAME, untouched records
    expect(isolated.get("inst-stripe-b")).toBe(stripeB);
    expect(isolated.get("inst-paystack-a")).toBe(paystack);
    expect(isolated.get("inst-stripe-b")?.state).toBe("ACTIVE");
    expect(isolated.get("inst-paystack-a")?.state).toBe("ACTIVE");
  });

  it("a PROVIDER-scoped outage affects only that provider's instances", () => {
    const stripeA = activeFor({ instanceId: "inst-stripe-a", providerName: "STRIPE" });
    const stripeB = activeFor({ instanceId: "inst-stripe-b", providerName: "STRIPE" });
    const flutterwave = activeFor({
      instanceId: "inst-flutterwave-a",
      providerName: "FLUTTERWAVE",
    });
    const report = applyProviderFailureIsolation(
      {
        failingInstanceId: "inst-stripe-a",
        providerName: "STRIPE",
        scope: "PROVIDER",
        detectedAt: T2,
        note: "api.stripe.com outage",
      },
      [stripeA, stripeB, flutterwave],
    );
    expect(report.affectedInstanceIds).toEqual(["inst-stripe-a", "inst-stripe-b"]);
    expect(report.isolatedInstanceIds).toEqual(["inst-flutterwave-a"]);
    const isolated = new Map(report.activations.map((r) => [r.instanceId, r]));
    expect(isolated.get("inst-flutterwave-a")).toBe(flutterwave);
    expect(isolated.get("inst-flutterwave-a")?.state).toBe("ACTIVE");
  });

  it("a failing instance that is not ACTIVE degrades nothing (no transition)", () => {
    const pendingPaystack = registerPendingActivation(
      makeInstance({ instanceId: "inst-paystack-a", providerName: "PAYSTACK" }),
      "SCOPED_API_CREDENTIAL",
      T0,
    );
    const stripe = activeFor({ instanceId: "inst-stripe-a", providerName: "STRIPE" });
    const report = applyProviderFailureIsolation(
      {
        failingInstanceId: "inst-paystack-a",
        providerName: "PAYSTACK",
        scope: "INSTANCE",
        detectedAt: T2,
      },
      [pendingPaystack, stripe],
    );
    expect(report.affectedInstanceIds).toEqual([]);
    expect(report.activations[0]).toBe(pendingPaystack);
    expect(report.activations[1]).toBe(stripe);
  });

  it("rejects failure events for unknown instances and malformed scopes", () => {
    const stripe = activeFor({ instanceId: "inst-stripe-a" });
    expect(() =>
      applyProviderFailureIsolation(
        {
          failingInstanceId: "inst-ghost",
          providerName: "STRIPE",
          scope: "INSTANCE",
          detectedAt: T2,
        },
        [stripe],
      ),
    ).toThrow(/no activation record/);
    expect(() =>
      applyProviderFailureIsolation(
        {
          failingInstanceId: "inst-stripe-a",
          providerName: "STRIPE",
          scope: "GLOBAL" as never,
          detectedAt: T2,
        },
        [stripe],
      ),
    ).toThrow(/scope/);
  });
});
