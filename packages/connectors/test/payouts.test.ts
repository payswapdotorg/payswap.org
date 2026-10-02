import { describe, expect, it } from "vitest";
import {
  TransferOutNotAuthorizedError,
  activateConnectedInstance,
  authorizeTransferOut,
  revokeActivation,
} from "../src/activation.js";
import type {
  ActivationAuthorizationEvidence,
  ConnectedInstanceActivation,
} from "../src/activation.js";
import type { ConnectedCapabilityInstance } from "../src/instances.js";
import { validateConnectedCapabilityInstance } from "../src/instances.js";
import {
  createPayoutExecutionRequest,
  evaluatePayoutGate,
  payoutObservation,
  payoutTransferOutGrant,
  validatePayoutDestination,
  validatePayoutRequestInit,
} from "../src/payouts.js";
import type {
  PayoutDestination,
  PayoutGateName,
  PayoutRequestInit,
} from "../src/payouts.js";

const T0 = "2026-10-02T06:37:38Z";
const T1 = "2026-10-15T00:00:00Z";
const T3 = "2026-12-01T00:00:00Z";

// ---------------------------------------------------------------------------
// Fixtures — synthetic refs only (control-plane shapes; NO credential material)
// ---------------------------------------------------------------------------

function makeInstance(): ConnectedCapabilityInstance {
  return validateConnectedCapabilityInstance({
    instanceId: "inst-paypal-direct-payouts-0001",
    capabilityId: "cap.rails.paypal-direct.payment_order",
    implementationId: "impl.rails.paypal-direct.2026-10-02",
    providerName: "paypal_direct",
    providerVersion: "rest-v2-2026-10-02",
    accountRef: "paypal-account-SYNTHETIC-0001",
    tenantRef: "tenant-SYNTHETIC-0001",
    authorization: {
      status: "ACTIVE",
      grantedAt: T0,
      authorizationRef: "authorization://paypal-direct/grant-20261002-0001",
    },
    credentialScope: {
      credentialRef: "vault://payswap/providers/paypal-direct/sandbox-20261002",
      credentialKind: "OAUTH",
    },
    geography: { countries: ["FR", "GH"] },
    currencies: ["EUR", "USD", "GHS"],
    permissionState: {
      granted: ["payments:write", "payments:read"],
      requested: ["payments:write", "payments:read"],
      missing: [],
    },
    eligibility: { eligible: true, reasons: [] },
    configuration: { livemode: false },
  });
}

function scopedCredentialEvidence(): ActivationAuthorizationEvidence {
  return {
    authorizationState: {
      status: "ACTIVE",
      grantedAt: T0,
      authorizationRef: "authorization://paypal-direct/grant-20261002-0001",
    },
    authorizationRef: "vault://payswap/providers/paypal-direct/sandbox-20261002",
  };
}

function activeRecord(): ConnectedInstanceActivation {
  return activateConnectedInstance({
    instance: makeInstance(),
    authorizationMode: "DELEGATED_OAUTH",
    evidence: scopedCredentialEvidence(),
    activatedAt: T0,
  });
}

function recordWithGrant(
  overrides: {
    readonly currencyScope?: readonly string[];
    readonly maxSingleAmountMinor?: number;
    readonly cumulativeLimitMinor?: number;
    readonly expiresAt?: string;
    readonly requiresProviderStepUp?: boolean;
  } = {},
): ConnectedInstanceActivation {
  return authorizeTransferOut(activeRecord(), {
    authorizationRef: "authorization://paypal-direct/transfer-out-20261002-0001",
    authorizedAt: T0,
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
    currencyScope: overrides.currencyScope ?? ["USD", "EUR"],
    ...(overrides.maxSingleAmountMinor !== undefined
      ? { maxSingleAmountMinor: overrides.maxSingleAmountMinor }
      : {}),
    ...(overrides.cumulativeLimitMinor !== undefined
      ? { cumulativeLimitMinor: overrides.cumulativeLimitMinor }
      : {}),
    requiresProviderStepUp: overrides.requiresProviderStepUp ?? false,
  });
}

const EMAIL_DESTINATION: PayoutDestination = Object.freeze({
  kind: "PROVIDER_ACCOUNT_EMAIL",
  providerDestinationRef: "receiver@example.com",
});

function payoutRequest(
  overrides: Partial<PayoutRequestInit> = {},
): PayoutRequestInit {
  return {
    connectorCapabilityId: "cap.payouts.execute.synthetic",
    transferOutAuthorizationId: "authorization://paypal-direct/transfer-out-20261002-0001",
    destination: EMAIL_DESTINATION,
    amountMinor: 5000,
    currency: "USD",
    protocolKey: "payout-protocol-key-123",
    authorizationEvidenceRef: "evidence://payouts/auth-20261002-0001",
    requestedAt: T1,
    ...overrides,
  };
}

function gateNames(report: { readonly checks: readonly { readonly gate: PayoutGateName }[] }): PayoutGateName[] {
  return report.checks.map((check) => check.gate);
}

// ---------------------------------------------------------------------------
// Destination explicitness (the "external and explicit" acceptance)
// ---------------------------------------------------------------------------

describe("payout destination — explicit + external (never a PaySwap account)", () => {
  it("accepts every provider-addressable destination kind", () => {
    const cases: readonly PayoutDestination[] = [
      { kind: "PROVIDER_BENEFICIARY_ID", providerDestinationRef: "ben-id-123" },
      { kind: "PROVIDER_ACCOUNT_EMAIL", providerDestinationRef: "receiver@example.com" },
      { kind: "PROVIDER_PAYER_ID", providerDestinationRef: "payer-id-XYZ" },
      { kind: "PROVIDER_BANK_INSTRUMENT", providerDestinationRef: "ba_SETH1234" },
      { kind: "PROVIDER_WALLET_ADDRESS", providerDestinationRef: "wallet-123" },
    ];
    for (const destination of cases) {
      expect(validatePayoutDestination(destination)).toEqual(destination);
    }
  });

  it("preserves displayName and normalizes the country code", () => {
    const validated = validatePayoutDestination({
      kind: "PROVIDER_BANK_INSTRUMENT",
      providerDestinationRef: "ba_SETH1234",
      displayName: "Ops USD account",
      country: "gh",
    });
    expect(validated.displayName).toBe("Ops USD account");
    expect(validated.country).toBe("GH");
  });

  it("REFUSES undefined/null/implicit destinations (fail-closed)", () => {
    expect(() => validatePayoutDestination(undefined)).toThrow(/explicit \+ external/);
    expect(() => validatePayoutDestination(null)).toThrow(/explicit \+ external/);
    expect(() => validatePayoutDestination({})).toThrow();
    expect(() => validatePayoutDestination("receiver@example.com")).toThrow();
  });

  it("REFUSES unknown kinds and empty/whitespace refs", () => {
    expect(() =>
      validatePayoutDestination({ kind: "PAYS_WAP_ACCOUNT", providerDestinationRef: "x" }),
    ).toThrow(/provider-addressable EXTERNAL destination/);
    expect(() =>
      validatePayoutDestination({ kind: "PROVIDER_PAYER_ID", providerDestinationRef: "" }),
    ).toThrow(/non-empty providerDestinationRef/);
    expect(() =>
      validatePayoutDestination({ kind: "PROVIDER_PAYER_ID", providerDestinationRef: "   " }),
    ).toThrow(/non-empty providerDestinationRef/);
  });

  it("REFUSES PaySwap-internal references as destinations (protocol keys, instances, vault refs)", () => {
    for (const ref of [
      "payswap:payout-protocol-key-123",
      "payswap-long:abcdef0123456789",
      "inst-paypal-direct-payouts-0001",
      "vault://payswap/providers/paypal-direct/sandbox-20261002",
    ]) {
      expect(() =>
        validatePayoutDestination({ kind: "PROVIDER_BENEFICIARY_ID", providerDestinationRef: ref }),
      ).toThrow(/EXTERNAL and provider-addressable/);
    }
  });

  it("REFUSES malformed displayName/country metadata", () => {
    expect(() =>
      validatePayoutDestination({
        kind: "PROVIDER_PAYER_ID",
        providerDestinationRef: "payer-1",
        displayName: "",
      }),
    ).toThrow(/displayName/);
    expect(() =>
      validatePayoutDestination({
        kind: "PROVIDER_PAYER_ID",
        providerDestinationRef: "payer-1",
        country: "GHA",
      }),
    ).toThrow(/alpha-2/);
  });
});

// ---------------------------------------------------------------------------
// Request-init validation
// ---------------------------------------------------------------------------

describe("payout request init validation (exact minor units, full evidence)", () => {
  it("validates the happy path and normalizes the currency", () => {
    const validated = validatePayoutRequestInit(payoutRequest({ currency: "usd" }));
    expect(validated.currency).toBe("USD");
    expect(validated.amountMinor).toBe(5000);
    expect(validated.destination).toEqual(EMAIL_DESTINATION);
  });

  it("requires EVERY mandatory field (fail-closed on each)", () => {
    for (const field of [
      "connectorCapabilityId",
      "transferOutAuthorizationId",
      "currency",
      "protocolKey",
      "authorizationEvidenceRef",
      "requestedAt",
    ] as const) {
      const broken: Record<string, unknown> = { ...payoutRequest() };
      delete broken[field];
      expect(() => validatePayoutRequestInit(broken), field).toThrow(new RegExp(field));
    }
    expect(() => validatePayoutRequestInit({ ...payoutRequest(), destination: undefined })).toThrow(
      /destination/,
    );
  });

  it("amountMinor must be a positive integer of minor units (INV-F01 — never a float)", () => {
    for (const bad of [0, -5, 10.5, Number.NaN]) {
      expect(() => validatePayoutRequestInit({ ...payoutRequest(), amountMinor: bad })).toThrow(
        /minor units/,
      );
    }
  });

  it("step-up evidence and cumulative draw ride the init when present", () => {
    const validated = validatePayoutRequestInit(
      payoutRequest({ providerStepUpEvidenceRef: "evidence://stepup/0001", cumulativeDrawnMinor: 1200 }),
    );
    expect(validated.providerStepUpEvidenceRef).toBe("evidence://stepup/0001");
    expect(validated.cumulativeDrawnMinor).toBe(1200);
    const plain = validatePayoutRequestInit(payoutRequest());
    expect(plain.providerStepUpEvidenceRef).toBeUndefined();
    expect(plain.cumulativeDrawnMinor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The six-gate matrix (all gates × pass/fail)
// ---------------------------------------------------------------------------

describe("evaluatePayoutGate — the six-gate matrix (machine-checkable, fail-closed)", () => {
  it("ALL SIX gates pass on a fully-authorized, in-scope, in-limit, unexpired, explicit request", () => {
    const report = evaluatePayoutGate(recordWithGrant(), payoutRequest());
    expect(report.instanceId).toBe("inst-paypal-direct-payouts-0001");
    expect(report.allowed).toBe(true);
    expect(gateNames(report)).toEqual([
      "TRANSFER_OUT_GRANT_EXISTS",
      "TRANSFER_OUT_CURRENCY_SCOPE",
      "TRANSFER_OUT_LIMITS",
      "TRANSFER_OUT_NOT_EXPIRED",
      "DESTINATION_EXPLICIT_EXTERNAL",
      "PROVIDER_STEP_UP",
    ]);
    for (const check of report.checks) {
      expect(check.pass).toBe(true);
      expect(check.reason).toBeUndefined(); // pass rows carry no failure reason
    }
  });

  it("GATE 1 (grant exists): a connection WITHOUT transfer-out fails TRANSFER_OUT_NOT_AUTHORIZED — connection scope never passes", () => {
    const report = evaluatePayoutGate(activeRecord(), payoutRequest());
    expect(report.allowed).toBe(false);
    const grantCheck = report.checks.find((check) => check.gate === "TRANSFER_OUT_GRANT_EXISTS");
    expect(grantCheck?.pass).toBe(false);
    expect(grantCheck?.reason).toContain("TRANSFER_OUT_NOT_AUTHORIZED");
    expect(grantCheck?.reason).toContain("never grants debit/withdrawal authority");
  });

  it("GATE 1 failure: the grant-dependent gates report their dependent reasons (never guessed)", () => {
    const report = evaluatePayoutGate(activeRecord(), payoutRequest());
    for (const gate of [
      "TRANSFER_OUT_CURRENCY_SCOPE",
      "TRANSFER_OUT_LIMITS",
      "TRANSFER_OUT_NOT_EXPIRED",
    ] as const) {
      const check = report.checks.find((candidate) => candidate.gate === gate);
      expect(check?.pass).toBe(false);
      expect(check?.reason).toContain("no transfer-out grant");
    }
  });

  it("GATE 2 (currency scope): out-of-scope currency fails; case is normalized both ways", () => {
    const report = evaluatePayoutGate(recordWithGrant(), payoutRequest({ currency: "GHS" }));
    const scopeCheck = report.checks.find((check) => check.gate === "TRANSFER_OUT_CURRENCY_SCOPE");
    expect(scopeCheck?.pass).toBe(false);
    expect(scopeCheck?.reason).toContain("GHS");
    expect(scopeCheck?.reason).toContain("USD, EUR");
    const caseInsensitive = evaluatePayoutGate(
      recordWithGrant(),
      payoutRequest({ currency: "usd" }),
    );
    expect(
      caseInsensitive.checks.find((check) => check.gate === "TRANSFER_OUT_CURRENCY_SCOPE")?.pass,
    ).toBe(true);
  });

  it("GATE 3 (limits): maxSingleAmountMinor exceeded fails with the exact numbers", () => {
    const report = evaluatePayoutGate(
      recordWithGrant({ maxSingleAmountMinor: 4999 }),
      payoutRequest({ amountMinor: 5000 }),
    );
    const limitsCheck = report.checks.find((check) => check.gate === "TRANSFER_OUT_LIMITS");
    expect(limitsCheck?.pass).toBe(false);
    expect(limitsCheck?.reason).toContain("maxSingleAmountMinor 4999");
  });

  it("GATE 3 (limits): exactly AT the single limit passes (inclusive bound)", () => {
    const report = evaluatePayoutGate(
      recordWithGrant({ maxSingleAmountMinor: 5000 }),
      payoutRequest({ amountMinor: 5000 }),
    );
    expect(report.checks.find((check) => check.gate === "TRANSFER_OUT_LIMITS")?.pass).toBe(true);
  });

  it("GATE 3 (limits): cumulative limit fails when drawn + request exceeds it, passes within", () => {
    const failing = evaluatePayoutGate(
      recordWithGrant({ cumulativeLimitMinor: 6000 }),
      payoutRequest({ amountMinor: 5000, cumulativeDrawnMinor: 1200 }),
    );
    expect(failing.checks.find((check) => check.gate === "TRANSFER_OUT_LIMITS")?.pass).toBe(false);
    const passing = evaluatePayoutGate(
      recordWithGrant({ cumulativeLimitMinor: 6000 }),
      payoutRequest({ amountMinor: 5000, cumulativeDrawnMinor: 1000 }),
    );
    expect(passing.checks.find((check) => check.gate === "TRANSFER_OUT_LIMITS")?.pass).toBe(true);
  });

  it("GATE 3 (limits): with NO limits set, any amount passes the limits gate", () => {
    const report = evaluatePayoutGate(recordWithGrant(), payoutRequest({ amountMinor: 10_000_000 }));
    expect(report.checks.find((check) => check.gate === "TRANSFER_OUT_LIMITS")?.pass).toBe(true);
  });

  it("GATE 4 (expiry): an expired grant fails with the expiry timestamps", () => {
    const report = evaluatePayoutGate(
      recordWithGrant({ expiresAt: T1 }),
      payoutRequest({ requestedAt: T1 }),
    );
    const expiryCheck = report.checks.find((check) => check.gate === "TRANSFER_OUT_NOT_EXPIRED");
    expect(expiryCheck?.pass).toBe(false);
    expect(expiryCheck?.reason).toContain("TRANSFER_OUT_EXPIRED");
    expect(expiryCheck?.reason).toContain(T1);
  });

  it("GATE 4 (expiry): a request before the expiry passes; no expiry set never expires", () => {
    const before = evaluatePayoutGate(
      recordWithGrant({ expiresAt: T3 }),
      payoutRequest({ requestedAt: T1 }),
    );
    expect(before.checks.find((check) => check.gate === "TRANSFER_OUT_NOT_EXPIRED")?.pass).toBe(true);
    const openEnded = evaluatePayoutGate(recordWithGrant(), payoutRequest({ requestedAt: T3 }));
    expect(openEnded.checks.find((check) => check.gate === "TRANSFER_OUT_NOT_EXPIRED")?.pass).toBe(true);
  });

  it("GATE 4 (active state): a REVOKED activation fails the not-expired gate (transfer-out requires ACTIVE)", () => {
    const revoked = revokeActivation(recordWithGrant(), { at: T1, reason: "owner withdrew connection" });
    const report = evaluatePayoutGate(revoked, payoutRequest({ requestedAt: T1 }));
    const stateCheck = report.checks.find((check) => check.gate === "TRANSFER_OUT_NOT_EXPIRED");
    expect(stateCheck?.pass).toBe(false);
    expect(stateCheck?.reason).toContain("TRANSFER_OUT_NOT_ACTIVE");
  });

  it("GATE 5 (destination): an undefined/implicit destination fails (never guessed)", () => {
    const report = evaluatePayoutGate(
      recordWithGrant(),
      payoutRequest({ destination: undefined as unknown as PayoutDestination }),
    );
    const destinationCheck = report.checks.find(
      (check) => check.gate === "DESTINATION_EXPLICIT_EXTERNAL",
    );
    expect(destinationCheck?.pass).toBe(false);
    expect(destinationCheck?.reason).toContain("DESTINATION_NOT_EXPLICIT_EXTERNAL");
  });

  it("GATE 5 (destination): an empty-ref destination fails even with a valid kind", () => {
    const report = evaluatePayoutGate(
      recordWithGrant(),
      payoutRequest({ destination: { kind: "PROVIDER_PAYER_ID", providerDestinationRef: "" } }),
    );
    expect(
      report.checks.find((check) => check.gate === "DESTINATION_EXPLICIT_EXTERNAL")?.pass,
    ).toBe(false);
  });

  it("GATE 5 (destination): a PaySwap-internal reference fails as non-external", () => {
    const report = evaluatePayoutGate(
      recordWithGrant(),
      payoutRequest({
        destination: { kind: "PROVIDER_BENEFICIARY_ID", providerDestinationRef: "inst-paypal-direct-payouts-0001" },
      }),
    );
    const destinationCheck = report.checks.find(
      (check) => check.gate === "DESTINATION_EXPLICIT_EXTERNAL",
    );
    expect(destinationCheck?.pass).toBe(false);
    expect(destinationCheck?.reason).toContain("never a PaySwap account");
  });

  it("GATE 6 (step-up): a step-up grant without evidence fails; with evidence passes", () => {
    const failing = evaluatePayoutGate(
      recordWithGrant({ requiresProviderStepUp: true }),
      payoutRequest(),
    );
    const stepUpCheck = failing.checks.find((check) => check.gate === "PROVIDER_STEP_UP");
    expect(stepUpCheck?.pass).toBe(false);
    expect(stepUpCheck?.reason).toContain("TRANSFER_OUT_STEP_UP_REQUIRED");
    const passing = evaluatePayoutGate(
      recordWithGrant({ requiresProviderStepUp: true }),
      payoutRequest({ providerStepUpEvidenceRef: "evidence://stepup/0001" }),
    );
    expect(passing.checks.find((check) => check.gate === "PROVIDER_STEP_UP")?.pass).toBe(true);
  });

  it("GATE 6 (step-up): no step-up required → passes without evidence", () => {
    const report = evaluatePayoutGate(recordWithGrant({ requiresProviderStepUp: false }), payoutRequest());
    expect(report.checks.find((check) => check.gate === "PROVIDER_STEP_UP")?.pass).toBe(true);
  });

  it("a fully-failing combination still reports ALL SIX checks (append-only style)", () => {
    const report = evaluatePayoutGate(
      activeRecord(),
      payoutRequest({
        currency: "GHS",
        destination: undefined as unknown as PayoutDestination,
      }),
    );
    expect(report.checks).toHaveLength(6);
    expect(report.allowed).toBe(false);
    expect(report.checks.filter((check) => !check.pass).length).toBeGreaterThanOrEqual(5);
  });

  it("payoutTransferOutGrant exposes the reused TransferOutAuthorization verbatim", () => {
    expect(payoutTransferOutGrant(activeRecord())).toBeUndefined();
    const grant = payoutTransferOutGrant(recordWithGrant({ maxSingleAmountMinor: 7000 }));
    expect(grant).toBeDefined();
    expect(grant?.maxSingleAmountMinor).toBe(7000);
    expect(grant?.currencyScope).toEqual(["USD", "EUR"]);
    expect(grant?.authorizationRef).toBe(
      "authorization://paypal-direct/transfer-out-20261002-0001",
    );
  });
});

// ---------------------------------------------------------------------------
// Observation ≠ execution (the structural separation)
// ---------------------------------------------------------------------------

describe("payout observation vs execution (read scope ≠ authority)", () => {
  it("an observation is read-scope only: no gate, no destination, no execution authority", () => {
    const observation = payoutObservation({
      observationId: "payout-observation-0001",
      observedAt: T1,
      providerPayoutRef: "YQCEB2SZAB2J6",
      providerName: "paypal_direct",
      status: "PROCESSING",
      provenanceSource: "PROVIDER_API",
    });
    expect(observation.observationKind).toBe("PayoutObservation");
    expect(observation.requiredScope).toBe("payments:read");
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("gate");
    expect(serialized).not.toContain("destination");
    expect(serialized).not.toContain("PayoutExecutionRequest");
  });

  it("an observation needs NO transfer-out grant (read scope only)", () => {
    // even with zero authorization state in scope, an observation constructs:
    const observation = payoutObservation({
      observationId: "payout-observation-0002",
      observedAt: T1,
      providerPayoutRef: "JH8S9ZQ4XKVW6",
      providerName: "paypal_direct",
      status: "SUCCESS",
      provenanceSource: "PROVIDER_WEBHOOK",
    });
    expect(observation.status).toBe("SUCCESS");
  });

  it("observation construction validates every field (fail-closed shape)", () => {
    expect(() =>
      payoutObservation({
        observationId: "",
        observedAt: T1,
        providerPayoutRef: "YQCEB2SZAB2J6",
        providerName: "paypal_direct",
        status: "PROCESSING",
        provenanceSource: "PROVIDER_API",
      }),
    ).toThrow(/observationId/);
  });

  it("an observation can NEVER be coerced into an execution request (kind brands differ)", () => {
    const observation = payoutObservation({
      observationId: "payout-observation-0003",
      observedAt: T1,
      providerPayoutRef: "YQCEB2SZAB2J6",
      providerName: "paypal_direct",
      status: "SUCCESS",
      provenanceSource: "OPERATOR",
    });
    const asRecord = observation as unknown as Record<string, unknown>;
    expect(asRecord["requestKind"]).toBeUndefined();
    expect(asRecord["observationKind"]).toBe("PayoutObservation");
  });
});

describe("createPayoutExecutionRequest (the gated execution constructor)", () => {
  it("a fully-authorized request seals into a PayoutExecutionRequest carrying the gate report", () => {
    const request = createPayoutExecutionRequest(recordWithGrant(), payoutRequest());
    expect(request.requestKind).toBe("PayoutExecutionRequest");
    expect(request.instanceId).toBe("inst-paypal-direct-payouts-0001");
    expect(request.destination).toEqual(EMAIL_DESTINATION);
    expect(request.amountMinor).toBe(5000);
    expect(request.currency).toBe("USD");
    expect(request.protocolKey).toBe("payout-protocol-key-123");
    expect(request.gate.allowed).toBe(true);
    expect(request.gate.checks).toHaveLength(6);
    expect(request.providerStepUpEvidenceRef).toBeUndefined();
  });

  it("a closed gate THROWS TransferOutNotAuthorizedError with the failed gates listed", () => {
    const attempt = () => createPayoutExecutionRequest(activeRecord(), payoutRequest());
    expect(attempt).toThrow(TransferOutNotAuthorizedError);
    expect(attempt).toThrow(/TRANSFER_OUT_GRANT_EXISTS/);
    try {
      attempt();
    } catch (error) {
      const details = (error as { readonly details?: { readonly failedGates?: string[] } }).details;
      expect(details?.failedGates).toContain("TRANSFER_OUT_GRANT_EXISTS");
    }
  });

  it("each single-gate failure refuses the execution request (scope, limits, expiry, destination, step-up)", () => {
    const failures: readonly [string, ConnectedInstanceActivation, PayoutRequestInit, RegExp][] = [
      [
        "currency scope",
        recordWithGrant(),
        payoutRequest({ currency: "GHS" }),
        /payout execution refused/,
      ],
      [
        "single limit",
        recordWithGrant({ maxSingleAmountMinor: 100 }),
        payoutRequest({ amountMinor: 5000 }),
        /payout execution refused/,
      ],
      [
        "expiry",
        recordWithGrant({ expiresAt: "2026-10-03T00:00:00Z" }),
        payoutRequest({ requestedAt: T1 }),
        /payout execution refused/,
      ],
      [
        "destination (shape refused before the gate — fail-closed either way)",
        recordWithGrant(),
        payoutRequest({ destination: undefined as unknown as PayoutDestination }),
        /explicit \+ external/,
      ],
      [
        "step-up",
        recordWithGrant({ requiresProviderStepUp: true }),
        payoutRequest(),
        /payout execution refused.*PROVIDER_STEP_UP/,
      ],
    ];
    for (const [label, record, request, matcher] of failures) {
      expect(() => createPayoutExecutionRequest(record, request), label).toThrow(matcher);
    }
  });

  it("a step-up-authorized request embeds the step-up evidence in the sealed record", () => {
    const request = createPayoutExecutionRequest(
      recordWithGrant({ requiresProviderStepUp: true }),
      payoutRequest({ providerStepUpEvidenceRef: "evidence://stepup/0001" }),
    );
    expect(request.providerStepUpEvidenceRef).toBe("evidence://stepup/0001");
  });

  it("a malformed init fails at VALIDATION (before the gate — fail-closed on shape)", () => {
    expect(() =>
      createPayoutExecutionRequest(recordWithGrant(), payoutRequest({ amountMinor: 10.5 })),
    ).toThrow(/minor units/);
    expect(() =>
      createPayoutExecutionRequest(recordWithGrant(), payoutRequest({ protocolKey: "" })),
    ).toThrow(/protocolKey/);
  });

  it("the sealed request is immutable and serializes without any credential material", () => {
    const request = createPayoutExecutionRequest(recordWithGrant(), payoutRequest());
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("clientSecret");
    expect(serialized).not.toContain("clientId");
    expect(Object.isFrozen(request)).toBe(true);
  });
});
