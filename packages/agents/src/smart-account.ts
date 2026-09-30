/**
 * Smart-account and session-key contracts (FROZEN-ARCHITECTURE §12, INV-SC03).
 *
 * User Agents may operate non-custodial smart accounts through a
 * provider-neutral SmartAccountCapability. Session-key authority is always
 * bounded by an explicit permission envelope (actions, resources, value and
 * time). The ROOT account credential never enters a session or model context.
 */

import type { AmountSpec } from "./amount.js";

export type SmartAccountFeature =
  | "session_keys"
  | "spending_policies"
  | "recovery"
  | "batching"
  | "gas_sponsorship";

/** Provider-neutral description of one smart account's capabilities (§12). */
export interface SmartAccountCapability {
  readonly capabilityId: string;
  readonly accountRef: string;
  readonly supportedFeatures: readonly SmartAccountFeature[];
  readonly constraints: readonly string[];
}

/** The bounded permission envelope of a session key (INV-SC03). */
export interface SessionKeyPermissions {
  /** Exact action ids; wildcards are forbidden — the envelope must be bounded. */
  readonly actions: readonly string[];
  /** Exact resource ids; wildcards are forbidden — the envelope must be bounded. */
  readonly resources: readonly string[];
  /** Hard value ceiling for the whole session-key lifetime (exact minor units). */
  readonly maxTotalValue: AmountSpec;
  /** Hard time bound: the session key is invalid at and after this instant. */
  readonly expiresAt: number;
}

export interface SessionKeyEnvelope {
  readonly sessionKeyFingerprint: string;
  readonly permissions: SessionKeyPermissions;
}

/** Raised when a session-key envelope is not explicitly bounded (INV-SC03). */
export class UnboundedSessionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnboundedSessionKeyError";
  }
}

/**
 * Validate that a session-key envelope is explicitly bounded on all four
 * axes: action, resource, value and time (INV-SC03).
 */
export function validateSessionKeyEnvelope(envelope: SessionKeyEnvelope): void {
  if (envelope.sessionKeyFingerprint.length === 0) {
    throw new UnboundedSessionKeyError("sessionKeyFingerprint must not be empty");
  }
  const permissions = envelope.permissions;
  if (permissions.actions.length === 0) {
    throw new UnboundedSessionKeyError(
      "session key must enumerate at least one exact action (wildcards are forbidden)",
    );
  }
  for (const action of permissions.actions) {
    if (action.includes("*") || action.length === 0) {
      throw new UnboundedSessionKeyError(
        `session key action '${action}' must be an exact action id, not a wildcard`,
      );
    }
  }
  if (permissions.resources.length === 0) {
    throw new UnboundedSessionKeyError(
      "session key must enumerate at least one exact resource id (wildcards are forbidden)",
    );
  }
  for (const resource of permissions.resources) {
    if (resource.includes("*") || resource.length === 0) {
      throw new UnboundedSessionKeyError(
        `session key resource '${resource}' must be an exact resource id, not a wildcard`,
      );
    }
  }
  if (!/^[A-Z]{3}$/.test(permissions.maxTotalValue.currency)) {
    throw new UnboundedSessionKeyError(
      `session key value bound currency must be a 3-letter uppercase code, got '${permissions.maxTotalValue.currency}'`,
    );
  }
  if (!/^(0|[1-9][0-9]*)$/.test(permissions.maxTotalValue.minorUnits)) {
    throw new UnboundedSessionKeyError(
      "session key value bound must be exact integer minor units",
    );
  }
  if (!Number.isFinite(permissions.expiresAt) || permissions.expiresAt <= 0) {
    throw new UnboundedSessionKeyError("session key must carry a finite expiry timestamp");
  }
}

/** Marker: the ROOT credential of a smart account. Never enters sessions or model context. */
export interface RootCredentialRef {
  readonly credentialKind: "root_credential";
  readonly accountRef: string;
  readonly keyFingerprint: string;
}

/** The only credential kind a session or model context may ever carry. */
export interface SessionCredentialRef {
  readonly credentialKind: "session_credential";
  readonly sessionKeyFingerprint: string;
  readonly envelope: SessionKeyEnvelope;
}

/**
 * Credential-bearing context handed to a session / model. Structurally, only
 * SessionCredentialRef fits the `credential` slot — RootCredentialRef does not.
 */
export interface SessionContext {
  readonly sessionId: string;
  readonly credential: SessionCredentialRef;
  readonly permittedTokenFamilies: readonly string[];
}

/** Raised when a root credential is found inside a session/model context. */
export class RootCredentialInContextError extends Error {
  constructor(path: string) {
    super(
      `Root credential found at '${path}': the root account credential never enters a session or model context (INV-SC03, FROZEN §12)`,
    );
    this.name = "RootCredentialInContextError";
  }
}

function scanForRootCredential(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  const record = value as Readonly<Record<string, unknown>>;
  if (record["credentialKind"] === "root_credential") {
    throw new RootCredentialInContextError(path);
  }
  for (const key of Object.keys(record)) {
    scanForRootCredential(record[key], path === "" ? key : `${path}.${key}`, seen);
  }
}

/**
 * Runtime guard: assert that no root credential appears anywhere inside a
 * session or model context value (INV-SC03 / FROZEN §12).
 */
export function assertNoRootCredential(context: unknown): void {
  scanForRootCredential(context, "$", new Set());
}
