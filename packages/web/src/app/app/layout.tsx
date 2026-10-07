import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@payswap/design/styles/tokens.css";
import "@payswap/design/styles/components.css";
import "./cc.css";

import { CommandCenterShell } from "@/components/cc/command-center-shell";
import { RoleSwitcher } from "@/components/cc/role-switcher";
import { getServerCcState } from "@/lib/cc/server-state";
import { sidebarForState } from "@/lib/cc/render-state";
import { ccSessionLine } from "@/lib/cc/session-seam";
import { deriveSetupSteps } from "@/components/shell/setup-guide";
import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";

export const metadata: Metadata = {
  title: "Command Center",
  description:
    "The authenticated PaySwap Command Center — one navigation, role-derived views, honest states everywhere: UNKNOWN reconciles (never fails), empty means empty, and no financial state is ever fabricated.",
};

/**
 * The Command Center shell layout (P3-W2-002; object-model sidebar by
 * UX-003).
 *
 * Server side: resolve the render state (session seam + role preference),
 * PROJECT the UX-002 sidebar registry for the role (roles are projections —
 * emphasis and merchant/consumer labels, never a re-axing of the
 * navigation), derive the setup-guide steps from real session/connection
 * state, and compose the @payswap/design shell (sidebar + environment band
 * + topbar with the global Create split-button + ⌘K palette + mobile
 * drawer). Unauthenticated visitors still see the shell with the honest
 * gate inside every section (the Wave-1 pattern, preserved by CcSection).
 */
export default async function CommandCenterLayout({ children }: { children: ReactNode }) {
  const state = await getServerCcState();
  const sidebar = sidebarForState(state);
  const sessionLine = ccSessionLine(state.session);

  // Setup-guide facts: only real planes mark steps done. The connection
  // plane is consulted ONLY for authenticated sessions (a preview role
  // derives no connection state — preview is never an authentication).
  const authenticated = state.session.status === "authenticated";
  const activeRails = authenticated
    ? getConnectionPlane()
        .connectedInstancesFor(state.session.principal.principal)
        .filter((record) => record.state === "ACTIVE").length
    : 0;
  const setupSteps = deriveSetupSteps({ accountVerified: authenticated, activeRails });

  return (
    <CommandCenterShell
      sidebar={sidebar}
      role={state.navRole}
      preview={state.preview}
      sessionLine={sessionLine}
      setupSteps={setupSteps}
      roleSwitcher={<RoleSwitcher rolePreference={state.rolePreference} />}
    >
      {children}
    </CommandCenterShell>
  );
}
