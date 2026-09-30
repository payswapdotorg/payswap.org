import { contentDigest } from "./canonical.js";
import type { AgentInstance, AgentPrincipalRef, AgentRuntimeState, ModelBinding } from "./instance.js";
import { isBodyContractCompatible } from "./instance.js";

/**
 * Agent Body contracts (FROZEN-ARCHITECTURE §7, INV-G01).
 *
 * An Agent Body declares WHAT an agent can do: interfaces, capability
 * descriptors and constraints. A Body is structurally independent of any
 * model or "Soul": this interface deliberately has NO model, provider,
 * prompt-weights or persona fields. Model selection is a replaceable binding
 * on the AgentInstance, never a property of the Body contract.
 */

/** A declared input or output port of the Body. */
export interface InterfacePort {
  readonly name: string;
  /** Typed protocol artifact / token family the port accepts or produces (§24). */
  readonly artifactType: string;
}

export interface DeclaredInterfaces {
  readonly inputs: readonly InterfacePort[];
  readonly outputs: readonly InterfacePort[];
}

/** Behavioral capability the Body declares (e.g. route-selection, drafting). */
export interface BodyCapabilityDescriptor {
  readonly name: string;
  readonly summary: string;
}

export interface AgentBodyConstraint {
  readonly kind: "resource" | "behavioral" | "safety";
  readonly description: string;
}

/** The model-independent contract of an agent (INV-G01). */
export interface AgentBody {
  readonly id: string;
  readonly version: number;
  readonly declaredInterfaces: DeclaredInterfaces;
  readonly capabilityDescriptors: readonly BodyCapabilityDescriptor[];
  readonly constraints: readonly AgentBodyConstraint[];
}

/**
 * Deterministic Body contract key: two Bodies produce the same key iff their
 * declared interfaces and capability descriptors are equal. Model bindings
 * and instances never influence this key.
 */
export function bodyContractKey(body: AgentBody): string {
  return contentDigest({
    interfaces: body.declaredInterfaces,
    capabilities: body.capabilityDescriptors,
  });
}

/**
 * Possession parameters (W2-002). Possession binds a Body version to one
 * principal and one ModelBinding: the Body declares WHAT the agent can do,
 * the ModelBinding decides WHICH model serves it, and neither is a property
 * of the other (INV-G01).
 */
export interface PossessParams {
  readonly instanceId: string;
  readonly principal: AgentPrincipalRef;
  /** Initial runtime state; defaults to `{ status: "IDLE" }`. */
  readonly runtimeState?: AgentRuntimeState;
}

/**
 * A Body possesses-by-model-binding: create an AgentInstance for this Body
 * under a distinct ModelBinding (W2-002 acceptance: multiple models can
 * possess one Body).
 *
 * The instance's bodyRef pins the Body id AND version, so every possessor of
 * the same Body shares the identical Body contract — verified by
 * `isBodyContractCompatible(body, instance)` and by identical
 * `bodyContractKey` values across possessors.
 */
export function possess(
  body: AgentBody,
  modelBinding: ModelBinding,
  params: PossessParams,
): AgentInstance {
  if (params.instanceId.length === 0) {
    throw new Error("possess: instanceId must not be empty");
  }
  if (params.principal.agentKeyFingerprint.length === 0) {
    throw new Error("possess: principal agentKeyFingerprint must not be empty");
  }
  return {
    id: params.instanceId,
    bodyRef: { id: body.id, version: body.version },
    principal: params.principal,
    modelBinding,
    runtimeState: params.runtimeState ?? { status: "IDLE" },
  };
}

/**
 * All instances that possess this Body (same id AND version), in array order.
 * Two or more entries with distinct ModelBindings demonstrate multi-model
 * possession of one Body.
 */
export function possessorsOf(
  body: AgentBody,
  instances: readonly AgentInstance[],
): readonly AgentInstance[] {
  return instances.filter((instance) => isBodyContractCompatible(body, instance));
}

/** Structural identity of a ModelBinding for possession counting. */
export function bindingKey(binding: ModelBinding): string {
  return `${binding.provider}/${binding.modelId}@${binding.bindingVersion}`;
}

/**
 * The DISTINCT ModelBindings that possess this Body, in first-appearance
 * order. Multiple entries prove the same Body is served by several models
 * without any Body-contract change.
 */
export function possessingBindings(
  body: AgentBody,
  instances: readonly AgentInstance[],
): readonly ModelBinding[] {
  const seen = new Set<string>();
  const bindings: ModelBinding[] = [];
  for (const instance of possessorsOf(body, instances)) {
    if (instance.modelBinding === undefined) {
      continue;
    }
    const key = bindingKey(instance.modelBinding);
    if (!seen.has(key)) {
      seen.add(key);
      bindings.push(instance.modelBinding);
    }
  }
  return bindings;
}
