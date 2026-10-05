/**
 * The Command Center navigation content (P3-W2-002; universal extension
 * P4-W4-002): the grouped sidebar items derived from the certified role
 * navigation, PLUS the universal areas group derived from the
 * @payswap/surface eleven-area contract (visibility following the
 * certified role derivation — an area bound to a certified item shows
 * exactly when that item shows). Pure presentational — rendered inside
 * both the static sidebar and the mobile drawer by the shell, and
 * directly testable (no navigation hooks).
 */

import type { RoleNavigationView } from "@payswap/ux";
import { SidebarItem, SidebarSection } from "@payswap/design";

import { appRouteForNavItemId } from "@/lib/cc/routes";
import { deriveUniversalAreaViews } from "@/lib/universal/areas";

export function CcNavContent({
  nav,
  activeRoute,
}: {
  /** The certified, role-derived navigation (computed server-side). */
  readonly nav: RoleNavigationView;
  readonly activeRoute: string;
}) {
  const universalAreas = deriveUniversalAreaViews(nav).filter((view) => view.visible);
  return (
    <>
      <SidebarSection label="Universal areas">
        {universalAreas.map((view) => (
          <SidebarItem
            key={`universal-${view.area.id}`}
            href={view.route}
            active={view.route === activeRoute}
          >
            {view.area.label}
          </SidebarItem>
        ))}
      </SidebarSection>
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
