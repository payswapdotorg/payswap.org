/**
 * RailAdapter — the provider-neutral rail adapter interface (W3-003).
 *
 * INTEGRATIONS.md ("Rail adapter" canonical contract) +
 * LOSSLESS-CONNECTOR-CAPABILITY-MODEL §2/§3 + FROZEN-ARCHITECTURE §2A:
 *
 * An adapter maps provider states into canonical states WITHOUT erasing
 * provider meaning:
 *
 * - preconditions and authorization requirements come from the consumed
 *   CapabilityDefinition (W2-003 vocabulary — never redefined here);
 * - provider/canonical state mapping is ADDITIVE: the mapping result carries
 *   the canonical state AND the ProviderStateEnvelope verbatim (INV-C06 —
 *   `mapProviderStateToCanonical` returns the SAME envelope it was given;
 *   no lossy flattening exists anywhere in this interface);
 * - required customer/user action surfaces are surfaced from the preserved
 *   envelope (never collapsed into generic outcomes);
 * - external object identity/revision declarations come from the consumed
 *   capability definitions, and every object mapping declares its
 *   source-of-truth policy (consumed SourceOfTruthPolicy vocabulary).
 */

import { ValidationError } from "@payswap/protocol";
import type {
  AuthorizationDeclaration,
  CapabilityDefinition,
  ConnectorCapabilityPack,
  ExternalObjectIdentity,
  ProviderActionRequired,
  ProviderStateEnvelope,
  SourceOfTruthPolicy,
} from "@payswap/connectors";
import { validateConnectorCapabilityPack } from "@payswap/connectors";
import { findSubPack } from "@payswap/connectors";

// ---------------------------------------------------------------------------
// Provider/canonical state mapping (INV-C06 — additive, lossless)
// ---------------------------------------------------------------------------

/**
 * The result of mapping a provider state to its canonical meaning: the
 * canonical state is DERIVED, ADDITIVE metadata; the envelope is preserved
 * VERBATIM (INV-C06). There is deliberately no way to obtain a canonical
 * state without the envelope.
 */
export interface ProviderStateMapping {
  /** Canonical state reference: `${family}:${lifecycleStep}` (additive). */
  readonly canonicalState: string;
  /** The lossless envelope — the SAME value passed in, never rewritten. */
  readonly envelope: ProviderStateEnvelope;
  readonly requiresCustomerAction: boolean;
  readonly isTerminal: boolean;
}

/**
 * Deterministic, additive provider→canonical mapping (INV-C06): the
 * canonical state is composed from the envelope's own family/lifecycle
 * classification, and the envelope itself passes through UNTOUCHED (same
 * reference). The mapping NEVER replaces the raw provider state.
 */
export function mapProviderStateToCanonical(
  envelope: ProviderStateEnvelope,
): ProviderStateMapping {
  if (envelope === null || typeof envelope !== "object") {
    throw new ValidationError("a ProviderStateEnvelope is required");
  }
  return Object.freeze({
    canonicalState: `${envelope.classification.family}:${envelope.classification.lifecycleStep}`,
    envelope,
    requiresCustomerAction:
      envelope.classification.requiresCustomerAction ||
      envelope.actionRequired !== undefined,
    isTerminal: envelope.classification.isTerminal,
  });
}

/**
 * The provider-required customer/user actions preserved on an envelope
 * (INV-C06): surfaced verbatim for the trusted application surface — never
 * flattened into a generic error/status.
 */
export function requiredCustomerActionsFrom(
  envelope: ProviderStateEnvelope,
): readonly ProviderActionRequired[] {
  if (envelope === null || typeof envelope !== "object") {
    throw new ValidationError("a ProviderStateEnvelope is required");
  }
  if (
    (envelope.classification.requiresCustomerAction ||
      envelope.classification.family === "customer_action_required") &&
    envelope.actionRequired !== undefined
  ) {
    return Object.freeze([envelope.actionRequired]);
  }
  return Object.freeze([]);
}

// ---------------------------------------------------------------------------
// The RailAdapter interface
// ---------------------------------------------------------------------------

/**
 * The provider-neutral rail adapter interface: preconditions + authorization
 * requirements, lossless state mapping, required action surfaces and
 * external object identity/revision/source-of-truth policy.
 */
export interface RailAdapter {
  readonly adapterId: string;
  /** Links to the ProviderImplementation this adapter realizes (W2-003 layer 2). */
  readonly implementationId: string;

  /** Preconditions declared by the capability definition (consumed). */
  describePreconditions(capabilityId: string): readonly string[];
  /** Authorization requirements declared by the capability definition (consumed, INV-C07). */
  authorizationRequirements(capabilityId: string): AuthorizationDeclaration;
  /** Additive provider/canonical state mapping with envelope preservation (INV-C06). */
  mapProviderState(envelope: ProviderStateEnvelope): ProviderStateMapping;
  /** Required customer/user actions surfaced from the preserved envelope (INV-C06). */
  requiredCustomerActions(envelope: ProviderStateEnvelope): readonly ProviderActionRequired[];
  /** External object identity/revision declarations (consumed). */
  externalObjectIdentity(capabilityId: string): readonly ExternalObjectIdentity[];
  /** The source-of-truth policy for one external object type (consumed). */
  sourceOfTruthPolicy(externalObjectType: string): SourceOfTruthPolicy | undefined;
}

// ---------------------------------------------------------------------------
// Framework base
// ---------------------------------------------------------------------------

/**
 * A RailAdapter base wired to a Connector Capability Pack and the consumed
 * capability definitions: preconditions, authorization requirements, external
 * object identities and source-of-truth policies are all DERIVED from the
 * W2-003 vocabulary, never redeclared by the adapter.
 */
export abstract class BaseRailAdapter implements RailAdapter {
  readonly #pack: ConnectorCapabilityPack;
  readonly #definitions: ReadonlyMap<string, CapabilityDefinition>;

  protected constructor(
    pack: ConnectorCapabilityPack,
    definitions: ReadonlyMap<string, CapabilityDefinition>,
  ) {
    this.#pack = validateConnectorCapabilityPack(pack);
    this.#definitions = new Map(definitions);
  }

  abstract readonly adapterId: string;
  abstract readonly implementationId: string;

  /** The validated capability pack backing this adapter. */
  capabilityPack(): ConnectorCapabilityPack {
    return this.#pack;
  }

  describePreconditions(capabilityId: string): readonly string[] {
    return this.#definitionFor(capabilityId)?.preconditions ?? [];
  }

  authorizationRequirements(capabilityId: string): AuthorizationDeclaration {
    const definition = this.#definitionFor(capabilityId);
    if (definition === undefined) {
      throw new ValidationError(
        `no registered CapabilityDefinition for '${capabilityId}': preconditions and authorization requirements are consumed from the W2-003 vocabulary, never invented by an adapter`,
      );
    }
    return definition.authorization;
  }

  mapProviderState(envelope: ProviderStateEnvelope): ProviderStateMapping {
    return mapProviderStateToCanonical(envelope);
  }

  requiredCustomerActions(envelope: ProviderStateEnvelope): readonly ProviderActionRequired[] {
    return requiredCustomerActionsFrom(envelope);
  }

  externalObjectIdentity(capabilityId: string): readonly ExternalObjectIdentity[] {
    return this.#definitionFor(capabilityId)?.externalObjects ?? [];
  }

  sourceOfTruthPolicy(externalObjectType: string): SourceOfTruthPolicy | undefined {
    const policy = this.#objectMappingFor(this.#pack, externalObjectType);
    return policy?.sourceOfTruth;
  }

  #definitionFor(capabilityId: string): CapabilityDefinition | undefined {
    return this.#definitions.get(capabilityId);
  }

  #objectMappingFor(
    pack: ConnectorCapabilityPack,
    externalObjectType: string,
  ): { readonly sourceOfTruth: SourceOfTruthPolicy } | undefined {
    for (const mapping of pack.objectMappings) {
      if (mapping.externalObjectType === externalObjectType) {
        return mapping;
      }
    }
    for (const sub of pack.subPacks) {
      const found = this.#objectMappingFor(sub, externalObjectType);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
}

/** Exposed for certification-style checks: find a sub-pack by id. */
export function subPackOf(
  pack: ConnectorCapabilityPack,
  packId: string,
): ConnectorCapabilityPack | undefined {
  return findSubPack(pack, packId);
}
