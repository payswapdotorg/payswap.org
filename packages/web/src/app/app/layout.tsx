import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@payswap/design/styles/tokens.css";
import "@payswap/design/styles/components.css";
import "./cc.css";

import { CommandCenterShell } from "@/components/cc/command-center-shell";
import { RoleSwitcher } from "@/components/cc/role-switcher";
import { getServerCcState } from "@/lib/cc/server-state";
import { navigationForState } from "@/lib/cc/render-state";
import { ccSessionLine } from "@/lib/cc/session-seam";

export const metadata: Metadata = {
  title: "Command Center",
  description:
    "The authenticated PaySwap Command Center — one navigation, role-derived views, honest states everywhere: UNKNOWN reconciles (never fails), empty means empty, and no financial state is ever fabricated.",
};

/**
 * The Command Center shell layout (P3-W2-002).
 *
 * Server side: resolve the render state (session seam + role preference),
 * derive the navigation through the certified `deriveNavigationForRole`, and
 * compose the @payswap/design shell (sidebar + topbar + ⌘K palette + mobile
 * drawer). Unauthenticated visitors still see the shell with the honest
 * gate inside every section (the Wave-1 pattern, preserved by CcSection).
 */
export default async function CommandCenterLayout({ children }: { children: ReactNode }) {
  const state = await getServerCcState();
  const nav = navigationForState(state);
  const sessionLine = ccSessionLine(state.session);
  return (
    <CommandCenterShell
      nav={nav}
      role={state.navRole}
      preview={state.preview}
      sessionLine={sessionLine}
      roleSwitcher={<RoleSwitcher rolePreference={state.rolePreference} />}
    >
      {children}
    </CommandCenterShell>
  );
}
