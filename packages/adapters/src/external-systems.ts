/**
 * External-system connector interfaces — generalized, non-PSP systems
 * (W3-003; CONNECTOR-PLATFORM: "A Connector is a versioned provider adapter
 * and productized capability surface for an external system").
 *
 * CRM, ERP/accounting, construction/project-management, EHR/healthcare,
 * fleet/telematics, hospitality/PMS, legal matter, communications,
 * cloud/dev-platform and document/storage systems all face the SAME
 * ConnectorSDK framework and expose their capabilities through the SAME
 * @payswap/connectors registry capability kinds (SEARCH/READ/WRITE/ACTION/
 * EVENT/HEALTH) — there is exactly one connector model, not a PSP-specific
 * one and a parallel "integration" one.
 *
 * The only structural difference from a PSP connector is the provider system
 * kind: an ExternalSystemConnector faces a NON-PSP system and therefore
 * cannot be registered as a PSP connector (validated fail-closed).
 */

import { ValidationError } from "@payswap/protocol";
import type {
  ConnectorCapabilityKind,
  ProviderIdentity,
} from "@payswap/connectors";
import { PROVIDER_SYSTEM_KINDS } from "@payswap/connectors";
import type { ConnectorCapabilityPack } from "@payswap/connectors";
import { ConnectorSDK } from "./sdk.js";
import type { ConnectorHealthReport, SdkCallResult } from "./sdk.js";

/** The non-PSP system kinds (consumed W2-003 vocabulary, 'psp' excluded). */
export type NonPspSystemKind = Exclude<(typeof PROVIDER_SYSTEM_KINDS)[number], "psp">;

export function isNonPspSystemKind(value: unknown): value is NonPspSystemKind {
  return (
    typeof value === "string" &&
    (PROVIDER_SYSTEM_KINDS as readonly string[]).includes(value) &&
    value !== "psp"
  );
}

/** The merchant/tenant-facing descriptor of an external-system connector. */
export interface ExternalSystemConnectorDescriptor {
  readonly connectorId: string;
  /** The external system this connector faces (systemKind !== 'psp'). */
  readonly provider: ProviderIdentity;
  /** The canonical capability kinds this connector's pack exposes. */
  readonly capabilityKinds: readonly ConnectorCapabilityKind[];
}

/**
 * An external-system connector: a ConnectorSDK facing a non-PSP system.
 * Search, read, create, update, action, subscribe, reconcile, health,
 * disconnect and credential rotation apply to external systems exactly as
 * they do to PSPs — CRUD verbs may implement transport, but the semantic
 * contract is the capability pack (CONNECTOR-PLATFORM).
 */
export abstract class ExternalSystemConnector extends ConnectorSDK {
  /** The non-PSP system kind this connector faces. */
  abstract systemKind(): NonPspSystemKind;

  /** The canonical capability kinds this connector's pack maps onto. */
  abstract exposedCapabilityKinds(): readonly ConnectorCapabilityKind[];

  /** The merchant-facing descriptor. */
  descriptor(connectorId: string): ExternalSystemConnectorDescriptor {
    const identity = this.providerIdentity();
    if (identity.systemKind === "psp") {
      throw new ValidationError(
        "an ExternalSystemConnector cannot face a 'psp' provider (PSP connectors use the PspConnector interface)",
      );
    }
    if (identity.systemKind !== this.systemKind()) {
      throw new ValidationError(
        "the connector's systemKind must match its provider identity",
      );
    }
    return Object.freeze({
      connectorId,
      provider: identity,
      capabilityKinds: Object.freeze([...this.exposedCapabilityKinds()]),
    });
  }
}

/** The result of an external-system conformance check (certification-style). */
export type ExternalSystemConformance =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly string[] };

/**
 * Deterministic conformance check for external-system connectors:
 * - the provider must be a declared non-PSP system kind;
 * - the pack must be a structurally valid Connector Capability Pack;
 * - the exposed capability kinds must be canonical W2-003 kinds.
 */
export function validateExternalSystemConnector(
  connector: ExternalSystemConnector,
): ExternalSystemConformance {
  const violations: string[] = [];
  const identity = connector.providerIdentity();
  if (!isNonPspSystemKind(identity.systemKind)) {
    violations.push(
      `provider systemKind '${identity.systemKind}' is not a declared non-PSP system kind`,
    );
  }
  if (identity.systemKind !== connector.systemKind()) {
    violations.push("connector.systemKind() does not match its provider identity");
  }
  try {
    connector.validateCapabilityPack();
  } catch (error) {
    violations.push(
      `capability pack is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const kind of connector.exposedCapabilityKinds()) {
    if (
      typeof kind !== "string" ||
      !(["SEARCH", "READ", "WRITE", "ACTION", "EVENT", "HEALTH"] as readonly string[]).includes(kind)
    ) {
      violations.push(`exposed capability kind '${String(kind)}' is not a canonical W2-003 kind`);
    }
  }
  if (violations.length > 0) {
    return { ok: false, violations: Object.freeze(violations) };
  }
  return { ok: true };
}
