import type { AgentBody } from "./body.js";
import type { VersionedRef } from "./instance.js";

/**
 * Agent Package contracts (FROZEN-ARCHITECTURE §13).
 *
 * Packages carry Bodies, organization templates, required extensions,
 * security epoch requirements, runtime requirements, model compatibility,
 * an evaluation suite reference and provenance — plus an explicit, immutable
 * lifecycle state machine.
 */

/** Deterministic lifecycle order (FROZEN-ARCHITECTURE §13). */
export const PACKAGE_LIFECYCLE = [
  "DRAFT",
  "STATIC_ANALYSIS",
  "BENCHMARKED",
  "SECURITY_REVIEW",
  "CERTIFIED",
  "AVAILABLE",
  "SUSPENDED",
  "RETIRED",
] as const;

export type PackageLifecycleState = (typeof PACKAGE_LIFECYCLE)[number];

/**
 * Allowed transitions: single forward steps only, plus the AVAILABLE↔SUSPENDED
 * toggle. Skipping states is rejected. RETIRED is terminal.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<PackageLifecycleState, readonly PackageLifecycleState[]>> = {
  DRAFT: ["STATIC_ANALYSIS"],
  STATIC_ANALYSIS: ["BENCHMARKED"],
  BENCHMARKED: ["SECURITY_REVIEW"],
  SECURITY_REVIEW: ["CERTIFIED"],
  CERTIFIED: ["AVAILABLE"],
  AVAILABLE: ["SUSPENDED"],
  SUSPENDED: ["AVAILABLE", "RETIRED"],
  RETIRED: [],
};

/** Raised when a lifecycle transition is not allowed. */
export class PackageLifecycleError extends Error {
  readonly from: PackageLifecycleState;
  readonly to: PackageLifecycleState;

  constructor(from: PackageLifecycleState, to: PackageLifecycleState) {
    super(
      `Illegal agent package lifecycle transition ${from} -> ${to}: ` +
        (from === "RETIRED"
          ? "RETIRED is terminal"
          : `allowed targets from ${from} are [${ALLOWED_TRANSITIONS[from].join(", ")}]`),
    );
    this.name = "PackageLifecycleError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Reference to an extension manifest. Extensions are owned by the capability
 * domain; packages only reference them.
 *
 * CONSOLIDATION CANDIDATE (W2-002): align with @payswap/capabilities ExtensionManifest
 */
export interface ExtensionRef {
  readonly extensionId: string;
  readonly version: string;
}

/** Reference to an organization template shipped inside the package. */
export interface OrganizationTemplateRef {
  readonly templateId: string;
  readonly version: number;
}

/** Security epoch posture required from any runtime executing this package. */
export interface SecurityEpochRequirements {
  readonly requireCurrentEpoch: boolean;
  readonly maxCredentialAgeMs?: number;
}

/** Runtime contract requirements declared by the package. */
export interface RuntimeRequirements {
  readonly minRuntimeContractVersion: number;
  readonly requiredOperations: readonly string[];
}

/** Which model bindings may serve the Bodies of this package. */
export interface ModelCompatibility {
  readonly interfaceVersion: number;
  readonly allowedProviders?: readonly string[];
  readonly disallowedModelFamilies?: readonly string[];
}

export interface PackageProvenance {
  readonly source: string;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly signedBy?: readonly string[];
}

/** An Agent Package: versioned, certified distributable of agent logic (§13). */
export interface AgentPackage {
  readonly id: string;
  readonly version: number;
  readonly bodies: readonly VersionedRef<AgentBody>[];
  readonly organizationTemplates: readonly OrganizationTemplateRef[];
  readonly requiredExtensions: readonly ExtensionRef[];
  readonly securityEpochRequirements: SecurityEpochRequirements;
  readonly runtimeRequirements: RuntimeRequirements;
  readonly modelCompatibility: ModelCompatibility;
  readonly evaluationSuiteRef: string;
  readonly provenance: PackageProvenance;
  readonly lifecycle: PackageLifecycleState;
}

/**
 * Deterministic lifecycle transition. Returns a NEW package; packages are
 * versioned artifacts and are never mutated in place (AGENTS.md rule 8).
 * Throws PackageLifecycleError on skipped or illegal transitions.
 */
export function transitionPackage(
  pkg: AgentPackage,
  to: PackageLifecycleState,
): AgentPackage {
  if (!ALLOWED_TRANSITIONS[pkg.lifecycle].includes(to)) {
    throw new PackageLifecycleError(pkg.lifecycle, to);
  }
  return { ...pkg, lifecycle: to };
}

/** True iff the transition is legal (pure query form of the same rule). */
export function canTransitionPackage(
  from: PackageLifecycleState,
  to: PackageLifecycleState,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
