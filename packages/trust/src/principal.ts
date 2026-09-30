/**
 * Principal contracts for the Trust / Delegation plane (FROZEN-ARCHITECTURE §5).
 *
 * Identity, Principal and AgentPrincipal are distinct (§5). A Principal is the
 * authenticated actor reference presented to authorization evaluation; it is
 * not the identity record itself and it is not authority. Authority travels
 * exclusively through mandates referenced by grants — never inline on a
 * principal (AGENTS.md rules 1, 5, 10).
 */

/** Reference to a mandate, carried inside an AgentPrincipal authority envelope. */
export interface MandateRef {
  readonly mandateId: string;
  readonly version: number;
}

/**
 * Human principal. `securityEpoch` is the security epoch at which this
 * credential was issued; it is compared against the current epoch on every
 * sensitive delegated action (INV-A02 / INV-S02).
 */
export interface UserPrincipal {
  readonly kind: "user";
  readonly id: string;
  readonly securityEpoch: bigint;
}

/**
 * Agent principal (FROZEN-ARCHITECTURE §5): binds agent key, owner reference,
 * Body/package version, authority envelope and security epoch. The authority
 * envelope references mandates; it never carries inline authority.
 */
export interface AgentPrincipal {
  readonly kind: "agent";
  readonly agentKeyFingerprint: string;
  readonly ownerRef: string;
  readonly bodyRef: string;
  readonly packageVersionRef: string;
  readonly authorityEnvelope: readonly MandateRef[];
  readonly securityEpoch: bigint;
}

/** Service principal with an explicit, non-delegable scope descriptor. */
export interface ServicePrincipal {
  readonly kind: "service";
  readonly id: string;
  readonly scope: string;
}

export type Principal = UserPrincipal | AgentPrincipal | ServicePrincipal;

/** Deterministic canonical principal reference used across trust records. */
export function principalRef(principal: Principal): string {
  switch (principal.kind) {
    case "user":
      return `user:${principal.id}`;
    case "agent":
      return `agent:${principal.agentKeyFingerprint}`;
    case "service":
      return `service:${principal.id}`;
  }
}
