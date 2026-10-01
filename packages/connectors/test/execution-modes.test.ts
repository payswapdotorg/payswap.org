import { describe, expect, it } from "vitest";
import {
  EXECUTION_MODES,
  ImplicitExecutionModeError,
  isExecutionMode,
  validateExecutionRequest,
} from "../src/index.js";
import type { ConnectorExecutionRequest, ProtocolAuthorizationRef } from "../src/index.js";
import type { Equal, Expect } from "./type-utils.js";

/**
 * INV-C07: PASS_THROUGH_NATIVE, COMPOSED_PAYSWAP and OPTIMIZED_MULTI_PROVIDER
 * are EXPLICIT modes; none can bypass protocol authorization, policy,
 * compliance, security or evidence. The execution request validation below
 * is the canonical enforcement surface.
 */

const authorization: ProtocolAuthorizationRef = {
  commandId: "cmd-0192-7f3a" as ProtocolAuthorizationRef["commandId"],
  principal: { principalType: "user", principalId: "user:merchant-1" },
  authorizationEvidenceRef: "evidence:authz-1",
};

function request(
  overrides: Partial<ConnectorExecutionRequest> = {},
): ConnectorExecutionRequest {
  return {
    executionMode: "PASS_THROUGH_NATIVE",
    capabilityInstanceId: "inst:acct-1-payments",
    providerRequest: { amount: { currency: "EUR", minorUnits: "1000" } },
    idempotencyKey: "idem-1",
    protocolAuthorization: authorization,
    ...overrides,
  };
}

describe("execution mode vocabulary (INV-C07)", () => {
  it("declares exactly the three explicit modes", () => {
    expect([...EXECUTION_MODES]).toEqual([
      "PASS_THROUGH_NATIVE",
      "COMPOSED_PAYSWAP",
      "OPTIMIZED_MULTI_PROVIDER",
    ]);
    type ModeCases = [
      Expect<Equal<(typeof EXECUTION_MODES)[number], "PASS_THROUGH_NATIVE" | "COMPOSED_PAYSWAP" | "OPTIMIZED_MULTI_PROVIDER">>,
    ];
    const cases: ModeCases = [true];
    expect(cases).toEqual([true]);
  });

  it("guards mode values", () => {
    for (const mode of EXECUTION_MODES) {
      expect(isExecutionMode(mode)).toBe(true);
    }
    expect(isExecutionMode("pass_through_native")).toBe(false);
    expect(isExecutionMode("AUTOMATIC")).toBe(false);
    expect(isExecutionMode(undefined)).toBe(false);
    expect(isExecutionMode(42)).toBe(false);
  });
});

describe("every execution requires an explicit mode (INV-C07)", () => {
  it("accepts each of the three modes when fully specified", () => {
    for (const mode of EXECUTION_MODES) {
      const result = validateExecutionRequest(request({ executionMode: mode }));
      expect(result).toEqual({ ok: true, mode });
    }
  });

  it("rejects a request with no mode at all", () => {
    const result = validateExecutionRequest({
      capabilityInstanceId: "inst:acct-1-payments",
      providerRequest: {},
      idempotencyKey: "idem-1",
      protocolAuthorization: authorization,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.join(" ")).toMatch(/executionMode is REQUIRED/);
      expect(result.violations.join(" ")).toMatch(/INV-C07/);
    }
  });

  it("rejects an unknown mode string", () => {
    const result = validateExecutionRequest(request({ executionMode: "AUTOMATIC" as never }));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing protocol authorization reference — no mode bypasses protocol authorization", () => {
    const { protocolAuthorization: _omitted, ...withoutAuthorization } = request();
    const result = validateExecutionRequest(withoutAuthorization);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.join(" ")).toMatch(/protocolAuthorization is required/);
      expect(result.violations.join(" ")).toMatch(/INV-C07/);
    }
  });

  it("rejects a missing idempotency key (INV-F05) and a missing instance reference", () => {
    const noKey = validateExecutionRequest({ ...request(), idempotencyKey: "" });
    expect(noKey.ok).toBe(false);
    const noInstance = validateExecutionRequest({ ...request(), capabilityInstanceId: "" });
    expect(noInstance.ok).toBe(false);
  });

  it("exposes an error type for implicit-mode executions", () => {
    const result = validateExecutionRequest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(() => {
        throw new ImplicitExecutionModeError(result.violations);
      }).toThrow(/INV-C07/);
    }
  });
});
