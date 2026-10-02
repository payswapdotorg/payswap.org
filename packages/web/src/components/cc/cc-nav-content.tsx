/**
 * The Command Center navigation content (P3-W2-002): the grouped sidebar
 * items derived from the certified role navigation. Pure presentational —
 * rendered inside both the static sidebar and the mobile drawer by the
 * shell, and directly testable (no navigation hooks).
 */

import type { RoleNavigationView } from "@payswap/ux";
import { SidebarItem, SidebarSection } from "@payswap/design";

import { appRouteForNavItemId } from "@/lib/cc/routes";

export function CcNavContent({
  nav,
  activeRoute,
}: {
  /** The certified, role-derived navigation (computed server-side). */
  readonly nav: RoleNavigationView;
  readonly activeRoute: string;
}) {
  return (
    <>
      {nav.groups.map((group) => (
        <SidebarSection key={group.group.id} label={group.group.label}>
          {group.items.map((view) => {
            const route = appRouteForNavItemId(view.item.id);
            return (
              <SidebarItem key={view.item.id} href={route} active={route === activeRoute}>
                {view.item.label}
              </SidebarItem>
            );
          })}
        </SidebarSection>
      ))}
    </>
  );
}
