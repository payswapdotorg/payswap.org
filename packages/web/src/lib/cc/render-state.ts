/**
 * Command Center per-render state (P3-W2-002).
 *
 * The single server-side derivation every /app surface starts from: resolve
 * the session through the seam, read the role preference, and derive the
 * honest render mode — authenticated, marked preview, or the honest gate.
 * Server-only (reads cookies); pure functions of its inputs so tests drive
 * it without a request.
 */

import type { ProductRole, RoleNavigationView } from "@payswap/ux";
import { deriveNavigationForRole } from "@payswap/ux";
import { PRODUCT_NAVIGATION } from "@payswap/ux";

import {
  effectiveNavigationRole,
  isPreviewMode,
  type CcSessionResolution,
} from "./session-seam";

/** The default role the navigation derivation uses before any preference. */
export const DEFAULT_NAV_ROLE: ProductRole = "merchant";

export interface CcRenderState {
  readonly session: CcSessionResolution;
  readonly rolePreference: ProductRole | null;
  /** The role driving deriveNavigationForRole for this render (null = gated). */
  readonly navRole: ProductRole | null;
  readonly preview: boolean;
  /** True when the honest authentication gate must replace section content. */
  readonly gated: boolean;
}

export function deriveCcRenderState(
  session: CcSessionResolution,
  rolePreference: ProductRole | null,
): CcRenderState {
  const navRole = effectiveNavigationRole(session, rolePreference);
  const preview = isPreviewMode(session, rolePreference);
  return {
    session,
    rolePreference,
    navRole,
    preview,
    gated: session.status !== "authenticated" && navRole === null,
  };
}

/** Derive the navigation view for a render state (the certified derivation). */
export function navigationForState(state: CcRenderState): RoleNavigationView {
  return deriveNavigationForRole(PRODUCT_NAVIGATION, state.navRole ?? DEFAULT_NAV_ROLE);
}
