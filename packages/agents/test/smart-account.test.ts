import { describe, expect, it } from "vitest";
import {
  RootCredentialInContextError,
  UnboundedSessionKeyError,
  assertNoRootCredential,
  validateSessionKeyEnvelope,
} from "../src/index.js";
import type {
  RootCredentialRef,
  SessionContext,
  SessionCredentialRef,
  SessionKeyEnvelope,
} from "../src/index.js";
import type { Equal, Expect } from "./type-utils.js";

/**
 * INV-SC03: smart-account/session-key authority is bounded by an explicit
 * permission envelope, and the root credential never enters a session or
 * model context (FROZEN-ARCHITECTURE §12).
 */

const envelope: SessionKeyEnvelope = {
  sessionKeyFingerprint: "sesskey-1",
  permissions: {
    actions: ["payments.initiate"],
    resources: ["beneficiary:ben-1"],
    maxTotalValue: { currency: "EUR", minorUnits: "25000" },
    expiresAt: 10_000_000,
  },
};

describe("SessionKeyEnvelope bounding (INV-SC03)", () => {
  it("accepts an explicitly bounded envelope", () => {
    expect(() => validateSessionKeyEnvelope(envelope)).not.toThrow();
  });

  it("rejects wildcard actions and resources", () => {
    expect(() =>
      validateSessionKeyEnvelope({
        ...envelope,
        permissions: { ...envelope.permissions, actions: ["payments.*"] },
      }),
    ).toThrow(UnboundedSessionKeyError);
    expect(() =>
      validateSessionKeyEnvelope({
        ...envelope,
        permissions: { ...envelope.permissions, resources: ["beneficiary:*"] },
      }),
    ).toThrow(UnboundedSessionKeyError);
  });

  it("rejects empty action/resource sets (unbounded semantics)", () => {
    expect(() =>
      validateSessionKeyEnvelope({
        ...envelope,
        permissions: { ...envelope.permissions, actions: [] },
      }),
    ).toThrow(UnboundedSessionKeyError);
    expect(() =>
      validateSessionKeyEnvelope({
        ...envelope,
        permissions: { ...envelope.permissions, resources: [] },
      }),
    ).toThrow(UnboundedSessionKeyError);
  });

  it("rejects non-exact value bounds", () => {
    expect(() =>
      validateSessionKeyEnvelope({
        ...envelope,
        permissions: {
          ...envelope.permissions,
          maxTotalValue: { currency: "EUR", minorUnits: "25.5" },
        },
      }),
    ).toThrow(UnboundedSessionKeyError);
  });

  it("rejects a missing/invalid time bound", () => {
    expect(() =>
      validateSessionKeyEnvelope({
        ...envelope,
        permissions: { ...envelope.permissions, expiresAt: Number.NaN },
      }),
    ).toThrow(UnboundedSessionKeyError);
  });
});

describe("root credential exclusion (INV-SC03 / FROZEN §12)", () => {
  it("assertNoRootCredential accepts a session context", () => {
    const context: SessionContext = {
      sessionId: "session-1",
      credential: {
        credentialKind: "session_credential",
        sessionKeyFingerprint: "sesskey-1",
        envelope,
      },
      permittedTokenFamilies: ["Intent", "Quote"],
    };
    expect(() => assertNoRootCredential(context)).not.toThrow();
  });

  it("assertNoRootCredential rejects a root credential at the top level", () => {
    const root: RootCredentialRef = {
      credentialKind: "root_credential",
      accountRef: "smart-account-1",
      keyFingerprint: "root-key-1",
    };
    expect(() => assertNoRootCredential(root)).toThrow(RootCredentialInContextError);
  });

  it("assertNoRootCredential rejects a root credential nested in a model context", () => {
    const modelContext = {
      model: "gpt-5.1",
      tools: ["payments"],
      credentials: [
        { credentialKind: "session_credential", sessionKeyFingerprint: "sesskey-1", envelope },
        { credentialKind: "root_credential", accountRef: "smart-account-1", keyFingerprint: "root-key-1" },
      ],
    };
    try {
      assertNoRootCredential(modelContext);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RootCredentialInContextError);
      expect((error as RootCredentialInContextError).message).toContain(
        "credentials.1",
      );
    }
  });
});

// Type-level guarantees (enforced by `tsc --noEmit`):

// RootCredentialRef is NOT assignable to SessionCredentialRef, so it cannot
// occupy the credential slot of SessionContext (or any model-context type
// that reuses SessionCredentialRef).
type _rootAssignableToSessionCredential = RootCredentialRef extends SessionCredentialRef
  ? true
  : false;
type _assert1 = Expect<Equal<_rootAssignableToSessionCredential, false>>;

// And the inverse does not hold either: the types are disjoint.
type _sessionAssignableToRoot = SessionCredentialRef extends RootCredentialRef ? true : false;
type _assert2 = Expect<Equal<_sessionAssignableToRoot, false>>;

// The session context credential slot is exactly a session credential.
type _contextCredential = SessionContext["credential"];
type _assert3 = Expect<Equal<_contextCredential, SessionCredentialRef>>;
