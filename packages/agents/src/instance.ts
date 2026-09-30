import type { AgentBody } from "./body.js";

/**
 * Agent Instance contracts (FROZEN-ARCHITECTURE §7, INV-G01).
 *
 * An AgentInstance binds a Body version to a principal and an OPTIONAL,
 * replaceable ModelBinding. Swapping the ModelBinding never changes the
 * Body-contract compatibility of the instance.
 */

/**
 * Versioned, content-stable reference to an artifact. The phantom `__refTo`
 * tag exists only at the type level; it binds the reference to the artifact
 * type it points at and is never present at runtime.
 */
export interface VersionedRef<T> {
  readonly id: string;
  readonly version: number;
  readonly __refTo?: T;
}

/** Minimal reference to an AgentPrincipal owned by the trust domain. */
export interface AgentPrincipalRef {
  readonly agentKeyFingerprint: string;
  readonly ownerRef: string;
}

/**
 * Opaque, replaceable model binding. This type carries no authority and no
 * financial semantics; it only describes which model serves a Body.
 */
export interface ModelBinding {
  readonly provider: string;
  readonly modelId: string;
  readonly bindingVersion: number;
}

export type AgentRuntimeStatus = "IDLE" | "RUNNING" | "PAUSED" | "TERMINATED";

export interface AgentRuntimeState {
  readonly status: AgentRuntimeStatus;
  readonly lastCheckpointRef?: string;
}

/** A running (or resting) agent: Body contract plus replaceable model binding. */
export interface AgentInstance {
  readonly id: string;
  readonly bodyRef: VersionedRef<AgentBody>;
  readonly principal: AgentPrincipalRef;
  readonly modelBinding?: ModelBinding;
  readonly runtimeState: AgentRuntimeState;
}

/** The Body contract an instance is bound to (independent of any model). */
export function instanceBodyRef(instance: AgentInstance): VersionedRef<AgentBody> {
  return instance.bodyRef;
}

/** True iff the instance's Body contract matches the given Body exactly. */
export function isBodyContractCompatible(body: AgentBody, instance: AgentInstance): boolean {
  return body.id === instance.bodyRef.id && body.version === instance.bodyRef.version;
}

/**
 * Swap the model binding of an instance. Returns a new instance with the same
 * Body contract, principal and runtime state (INV-G01: the model is
 * replaceable without touching the Body contract).
 */
export function rebindModel(
  instance: AgentInstance,
  modelBinding: ModelBinding | undefined,
): AgentInstance {
  if (modelBinding === undefined) {
    const { modelBinding: _dropped, ...rest } = instance;
    return rest;
  }
  return { ...instance, modelBinding };
}
