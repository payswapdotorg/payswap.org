import { contentDigest } from "./canonical.js";

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
