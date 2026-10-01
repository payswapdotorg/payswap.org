/**
 * The generalized Connector registry (W2-003; FROZEN-ARCHITECTURE §2A;
 * ADR-006; CONNECTOR-PLATFORM).
 *
 * Non-PSP systems (CRM, ERP, EHR, fleet, hospitality, legal, comms, cloud,
 * storage…) expose search/read/write/action/event/health capabilities
 * through the SAME registry as PSPs — the capability kinds enum
 * (./definitions.js) is shared by every provider system kind.
 *
 * Registration enforces the chain completeness of the lossless hierarchy:
 * CapabilityDefinition → ProviderImplementation → ConnectedCapabilityInstance
 * → CapabilityObservation, plus Connector Capability Packs whose sub-packs
 * map ONLY to capabilities actually exposed by registered instances.
 * A ProviderCatalogueEntry can NEVER be registered as an instance (INV-C05).
 */

import { PaySwapError, ValidationError } from "@payswap/protocol";
import type { ErrorCategory, PaySwapErrorDetails } from "@payswap/protocol";
import {
  validateCapabilityDefinition,
} from "./definitions.js";
import type {
  CapabilityDefinition,
  ConnectorCapabilityKind,
} from "./definitions.js";
import { ProviderRegistry, validateProviderImplementation } from "./providers.js";
import type {
  CorridorQuery,
  ProviderIdentity,
  ProviderImplementation,
} from "./providers.js";
import {
  isProviderCatalogueEntry,
  validateConnectedCapabilityInstance,
} from "./instances.js";
import type { ConnectedCapabilityInstance } from "./instances.js";
import { validateCapabilityObservation } from "./observations.js";
import type { CapabilityObservation } from "./observations.js";
import {
  flattenPackCapabilityRefs,
  validateConnectorCapabilityPack,
} from "./packs.js";
import type { ConnectorCapabilityPack } from "./packs.js";

/** Raised when a registration breaks the connector chain invariants. */
export class ConnectorRegistryError extends PaySwapError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super({
      code: "CONNECTOR_REGISTRY_VIOLATION",
      category: "VALIDATION" as ErrorCategory,
      message,
      details,
    });
  }
}

/** Which chain link a completeness gap belongs to. */
export type ChainLinkKind =
  | "definition"
  | "implementation"
  | "instance"
  | "observation"
  | "pack";

/** One gap in the definition → implementation → instance → observation chain. */
export interface ChainGap {
  readonly link: ChainLinkKind;
  readonly ref: string;
  readonly problem: string;
}

/** Result of a full chain-completeness sweep. */
export interface ChainCompletenessReport {
  readonly complete: boolean;
  readonly gaps: readonly ChainGap[];
}

/**
 * The generalized Connector registry. Deterministic: registration order is
 * preserved for all lookups; lookups never fabricate reachable instances
 * (INV-NC04) and never turn a catalogue claim into an instance (INV-C05).
 */
export class ConnectorRegistry {
  private readonly definitions = new Map<string, CapabilityDefinition>();
  private readonly providers = new ProviderRegistry();
  private readonly instances = new Map<string, ConnectedCapabilityInstance>();
  private readonly observations = new Map<string, CapabilityObservation[]>();
  private readonly packs = new Map<string, ConnectorCapabilityPack>();

  // -- definitions ---------------------------------------------------------

  /** Registers a capability definition (layer 1). */
  registerDefinition(definition: CapabilityDefinition): CapabilityDefinition {
    const validated = validateCapabilityDefinition(definition);
    const key = `${validated.capabilityId}@${validated.capabilityVersion}`;
    if (this.definitions.has(key)) {
      throw new ConnectorRegistryError(
        `capability definition '${key}' is already registered`,
      );
    }
    this.definitions.set(key, validated);
    return validated;
  }

  definition(
    capabilityId: string,
    capabilityVersion?: string,
  ): CapabilityDefinition | undefined {
    if (capabilityVersion !== undefined) {
      return this.definitions.get(`${capabilityId}@${capabilityVersion}`);
    }
    for (const definition of this.definitions.values()) {
      if (definition.capabilityId === capabilityId) {
        return definition;
      }
    }
    return undefined;
  }

  allDefinitions(): readonly CapabilityDefinition[] {
    return [...this.definitions.values()];
  }

  definitionsOfKind(kind: ConnectorCapabilityKind): readonly CapabilityDefinition[] {
    return this.allDefinitions().filter((definition) => definition.kind === kind);
  }

  /**
   * INV-C08: provider-native optimization/recovery capabilities registered
   * as incumbent benchmark baselines.
   */
  benchmarkBaselines(): readonly CapabilityDefinition[] {
    return this.allDefinitions().filter(
      (definition) => definition.nativeOptimization?.benchmarkBaseline === true,
    );
  }

  // -- providers + implementations (layer 2) --------------------------------

  /** Registers a provider identity (any system kind). */
  registerProvider(provider: ProviderIdentity): ProviderIdentity {
    return this.providers.registerProvider(provider);
  }

  provider(
    providerName: string,
    providerVersion: string,
  ): ProviderIdentity | undefined {
    return this.providers.provider(providerName, providerVersion);
  }

  allProviders(): readonly ProviderIdentity[] {
    return this.providers.allProviders();
  }

  /**
   * Registers a provider implementation (layer 2). Chain rule: the
   * referenced capability definition must already be registered. The
   * definition check runs BEFORE the provider-store insertion so a rejected
   * registration leaves no partial state behind.
   */
  registerImplementation(
    implementation: ProviderImplementation,
  ): ProviderImplementation {
    const validated = validateProviderImplementation(implementation);
    const definition = this.definition(
      validated.capabilityId,
      validated.capabilityVersion,
    );
    if (definition === undefined) {
      throw new ConnectorRegistryError(
        `implementation '${validated.implementationId}' references capability '${validated.capabilityId}' which is not a registered CapabilityDefinition (chain rule: register the definition first — definition → implementation → instance → observation)`,
      );
    }
    return this.providers.registerImplementation(validated);
  }

  implementation(
    implementationId: string,
  ): ProviderImplementation | undefined {
    return this.providers.implementation(implementationId);
  }

  allImplementations(): readonly ProviderImplementation[] {
    return this.providers.allImplementations();
  }

  implementationsForDefinition(
    capabilityId: string,
  ): readonly ProviderImplementation[] {
    return this.providers.implementationsForDefinition(capabilityId);
  }

  implementationsServingCorridor(
    query: CorridorQuery,
  ): readonly ProviderImplementation[] {
    return this.providers.implementationsServingCorridor(query);
  }

  // -- connected instances (layer 3) ----------------------------------------

  /**
   * Registers a connected capability instance (layer 3). Chain rules:
   * a ProviderCatalogueEntry is rejected outright (INV-C05), and the
   * referenced implementation must already be registered.
   */
  registerInstance(
    instance: ConnectedCapabilityInstance,
  ): ConnectedCapabilityInstance {
    if (isProviderCatalogueEntry(instance)) {
      throw new ConnectorRegistryError(
        "INV-C05: a ProviderCatalogueEntry is a platform-wide advertisement and can never be registered as a ConnectedCapabilityInstance — catalogue claims never authorize execution",
        { catalogueEntryId: instance.catalogueEntryId },
      );
    }
    const validated = validateConnectedCapabilityInstance(instance);
    if (this.instances.has(validated.instanceId)) {
      throw new ConnectorRegistryError(
        `connected capability instance '${validated.instanceId}' is already registered`,
      );
    }
    const implementation = this.implementation(validated.implementationId);
    if (implementation === undefined) {
      throw new ConnectorRegistryError(
        `connected capability instance '${validated.instanceId}' references implementation '${validated.implementationId}' which is not registered (chain rule: register the ProviderImplementation first — definition → implementation → instance → observation)`,
      );
    }
    if (implementation.capabilityId !== validated.capabilityId) {
      throw new ConnectorRegistryError(
        `connected capability instance '${validated.instanceId}' references capability '${validated.capabilityId}' but its implementation '${validated.implementationId}' implements '${implementation.capabilityId}'`,
      );
    }
    this.instances.set(validated.instanceId, validated);
    return validated;
  }

  instance(instanceId: string): ConnectedCapabilityInstance | undefined {
    return this.instances.get(instanceId);
  }

  allInstances(): readonly ConnectedCapabilityInstance[] {
    return [...this.instances.values()];
  }

  instancesForCapability(
    capabilityId: string,
  ): readonly ConnectedCapabilityInstance[] {
    return this.allInstances().filter(
      (instance) => instance.capabilityId === capabilityId,
    );
  }

  // -- observations (layer 4) ------------------------------------------------

  /**
   * Records a capability observation (layer 4). Chain rules: the observed
   * instance must be registered, and per-instance observation versions must
   * be strictly monotonic.
   */
  recordObservation(
    observation: CapabilityObservation,
  ): CapabilityObservation {
    const validated = validateCapabilityObservation(observation);
    if (!this.instances.has(validated.instanceId)) {
      throw new ConnectorRegistryError(
        `observation ${validated.observationVersion} references instance '${validated.instanceId}' which is not registered (chain rule: register the ConnectedCapabilityInstance first — definition → implementation → instance → observation)`,
      );
    }
    const history = this.observations.get(validated.instanceId) ?? [];
    const latest = history[history.length - 1];
    if (latest !== undefined && validated.observationVersion <= latest.observationVersion) {
      throw new ConnectorRegistryError(
        `observation versions must be strictly monotonic per instance: got ${validated.observationVersion} but latest is ${latest.observationVersion} for '${validated.instanceId}'`,
      );
    }
    this.observations.set(validated.instanceId, [...history, validated]);
    return validated;
  }

  observationsFor(instanceId: string): readonly CapabilityObservation[] {
    return [...(this.observations.get(instanceId) ?? [])];
  }

  latestObservationFor(
    instanceId: string,
  ): CapabilityObservation | undefined {
    const history = this.observations.get(instanceId) ?? [];
    return history[history.length - 1];
  }

  // -- packs -----------------------------------------------------------------

  /**
   * Registers a Connector Capability Pack. Chain rule: every capability
   * referenced anywhere in the pack tree must be a registered definition
   * AND exposed by at least one registered ConnectedCapabilityInstance —
   * sub-packs map ONLY to capabilities actually exposed by connected
   * instances.
   */
  registerPack(pack: ConnectorCapabilityPack): ConnectorCapabilityPack {
    const validated = validateConnectorCapabilityPack(pack);
    if (this.packs.has(validated.packId)) {
      throw new ConnectorRegistryError(
        `connector capability pack '${validated.packId}' is already registered`,
      );
    }
    const missing: string[] = [];
    for (const ref of flattenPackCapabilityRefs(validated)) {
      const definition = this.definition(ref.capabilityId, ref.capabilityVersion);
      if (definition === undefined) {
        missing.push(
          `${ref.capabilityId}@${ref.capabilityVersion} (no such registered definition)`,
        );
        continue;
      }
      const exposed = this.allInstances().some(
        (instance) => instance.capabilityId === ref.capabilityId,
      );
      if (!exposed) {
        missing.push(
          `${ref.capabilityId}@${ref.capabilityVersion} (registered, but not exposed by any ConnectedCapabilityInstance)`,
        );
      }
    }
    if (missing.length > 0) {
      throw new ConnectorRegistryError(
        `connector capability pack '${validated.packId}' maps to capabilities not exposed by any ConnectedCapabilityInstance (sub-packs map ONLY to capabilities actually exposed by connected instances): ${missing.join("; ")}`,
        { missing: [...missing] },
      );
    }
    this.packs.set(validated.packId, validated);
    return validated;
  }

  pack(packId: string): ConnectorCapabilityPack | undefined {
    return this.packs.get(packId);
  }

  allPacks(): readonly ConnectorCapabilityPack[] {
    return [...this.packs.values()];
  }

  // -- chain completeness ------------------------------------------------------

  /**
   * Full chain-completeness sweep. With eager registration validation this
   * should always report complete; the sweep exists so integrators and the
   * TL acceptance gate can VERIFY the chain rather than trust it.
   */
  validateChain(): ChainCompletenessReport {
    const gaps: ChainGap[] = [];
    for (const implementation of this.allImplementations()) {
      const definition = this.definition(
        implementation.capabilityId,
        implementation.capabilityVersion,
      );
      if (definition === undefined) {
        gaps.push({
          link: "implementation",
          ref: implementation.implementationId,
          problem: `references unregistered definition '${implementation.capabilityId}'`,
        });
      }
    }
    for (const instance of this.allInstances()) {
      const implementation = this.implementation(instance.implementationId);
      if (implementation === undefined) {
        gaps.push({
          link: "instance",
          ref: instance.instanceId,
          problem: `references unregistered implementation '${instance.implementationId}'`,
        });
      }
    }
    for (const instance of this.allInstances()) {
      const history = this.observations.get(instance.instanceId) ?? [];
      if (history.length === 0) {
        gaps.push({
          link: "observation",
          ref: instance.instanceId,
          problem: "registered instance has no observations (availability cannot be established)",
        });
      }
    }
    for (const pack of this.allPacks()) {
      for (const ref of flattenPackCapabilityRefs(pack)) {
        const definition = this.definition(ref.capabilityId, ref.capabilityVersion);
        if (definition === undefined) {
          gaps.push({
            link: "pack",
            ref: pack.packId,
            problem: `references unregistered capability '${ref.capabilityId}@${ref.capabilityVersion}'`,
          });
          continue;
        }
        const exposed = this.allInstances().some(
          (instance) => instance.capabilityId === ref.capabilityId,
        );
        if (!exposed) {
          gaps.push({
            link: "pack",
            ref: pack.packId,
            problem: `capability '${ref.capabilityId}' not exposed by any registered instance`,
          });
        }
      }
    }
    return { complete: gaps.length === 0, gaps: Object.freeze(gaps) };
  }

  /** Rejects a value that is not a connected instance (INV-C05 helper). */
  assertInstance(instanceId: string): ConnectedCapabilityInstance {
    const instance = this.instances.get(instanceId);
    if (instance === undefined) {
      throw new ValidationError(
        `no ConnectedCapabilityInstance '${instanceId}' is registered (a provider catalogue claim never authorizes execution — INV-C05)`,
      );
    }
    return instance;
  }
}
