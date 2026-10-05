/**
 * @payswap/surface — versioning and stability policy (Work Order P4-W4-002 §3.6).
 *
 * The surface API is a STABILITY BOUNDARY: a future browser extension and a
 * future mobile app import these contracts without React and without
 * PaySwap's web app. The version below is the CONTRACT version of the
 * surface — it changes ONLY when a contract shape changes (additive or
 * breaking), never because an implementation detail moved.
 */

/**
 * The surface contract version. Semver, as policy:
 * - MAJOR: a breaking change to any exported type or function signature
 *   (removals, narrowed unions, changed required fields). Requires a work
 *   order that names the surface explicitly and a README changelog entry.
 * - MINOR: additive contracts (a new outcome action, a new area, a new
 *   optional field). Old consumers keep compiling.
 * - PATCH: wording/documentation and pure implementation fixes.
 *
 * Every runtime the surface serves (web app today; extension and mobile
 * app later) records the version it compiled against — drift is detectable
 * at build time, not discovered in production.
 */
export const SURFACE_API_VERSION = "1.0.0" as const;

/** Which parts of the surface are covered by which stability class. */
export type SurfaceStability =
  /** Frozen: removal or shape change requires a MAJOR bump. */
  | "stable"
  /** Additive-only between MINOR bumps; consumed by shipped surfaces. */
  | "experimental";

export interface SurfaceContractProvenance {
  readonly surfaceApiVersion: typeof SURFACE_API_VERSION;
  readonly stability: SurfaceStability;
  /** The work order that introduced the contract. */
  readonly workOrder: string;
}

/** Tag every exported contract model with its provenance (auditable). */
export function surfaceProvenance(
  workOrder: string,
  stability: SurfaceStability = "stable",
): SurfaceContractProvenance {
  return {
    surfaceApiVersion: SURFACE_API_VERSION,
    stability,
    workOrder,
  };
}

export const PACKAGE_NAME = "@payswap/surface" as const;
