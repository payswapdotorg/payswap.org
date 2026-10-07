/**
 * Command Center per-render state (P3-W2-002; object-model sidebar
 * projection by UX-003, contract 01 §3).
 *
 * The single server-side derivation every /app surface starts from: resolve
 * the session through the seam, read the role preference, and derive the
 * honest render mode — authenticated, marked preview, or the honest gate.
 * The SIDEBAR derivation (UX-003) is a PROJECTION of the UX-002 registry:
 * `projectSidebar` re-labels the five persistent rows and chooses group
 * emphasis/visibility for the role — the rows, groups, slugs and order are
 * IDENTICAL for every role (a role NEVER re-axes the navigation).
 *
 * Server-only (reads cookies); pure functions of its inputs so tests drive
 * it without a request.
 */

import type { ProductRole } from "@payswap/ux";
import { projectSidebar } from "@payswap/ux";
import type { ProjectedSidebar } from "@payswap/ux";

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
  /** The role driving the sidebar projection for this render (null = gated). */
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

/**
 * Derive the sidebar view for a render state — the UX-002 compatibility
 * fold: the role PROJECTS onto the one object-model sidebar (emphasis +
 * merchant/consumer labels), never a re-axing of the navigation.
 */
export function sidebarForState(
  state: CcRenderState,
): ProjectedSidebar {
  return projectSidebar(state.navRole ?? DEFAULT_NAV_ROLE);
}
