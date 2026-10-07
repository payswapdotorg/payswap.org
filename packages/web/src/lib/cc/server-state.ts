/**
 * Server-side Command Center render state (P3-W2-002; projection
 * preference by UX-006).
 *
 * Reads the role-preference + projection-preference cookies and the session
 * seam ON THE SERVER and derives the render state. Server-only
 * (next/headers); every /app surface composes this through `CcSection` or
 * the layout.
 */

import { cookies } from "next/headers";

import { deriveCcRenderState, type CcRenderState } from "./render-state";
import {
  CC_PROJECTION_COOKIE,
  CC_ROLE_COOKIE,
  parseProjectionPreference,
  parseRolePreference,
  resolveCcSession,
} from "./session-seam";

export async function getServerCcState(): Promise<CcRenderState> {
  const [store, session] = await Promise.all([cookies(), resolveCcSession()]);
  const rolePreference = parseRolePreference(store.get(CC_ROLE_COOKIE)?.value);
  const projectionPreference = parseProjectionPreference(
    store.get(CC_PROJECTION_COOKIE)?.value,
  );
  return deriveCcRenderState(session, rolePreference, projectionPreference);
}
