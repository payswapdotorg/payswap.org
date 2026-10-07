/**
 * The Command Center navigation content (P3-W2-002; object-model sidebar by
 * UX-003, contract 01 §3): the FIVE persistent money-object rows (always
 * visible, exact order, projection-aware labels) plus the five workload
 * groups (accordion — one open, collapse default, role-projection emphasis)
 * from the UX-002 `SIDEBAR` registry.
 *
 * The projection NEVER re-axes the navigation: rows/groups/slugs/order are
 * identical for every role — only the labels (merchant/consumer mental
 * model), group emphasis and role-default group visibility change. Pure
 * presentational — rendered inside both the static sidebar and the mobile
 * drawer by the shell, and directly testable (static markup asserts the
 * registry shape).
 */

import { SidebarItem } from "@payswap/design";
import type { ProjectedSidebar } from "@payswap/ux";

import { appRouteForSidebarRow } from "@/lib/cc/routes";
import { SidebarWorkloadGroups } from "@/components/shell/sidebar-groups";

export function CcNavContent({
  sidebar,
  activeRoute,
}: {
  /** The role-projected sidebar (computed server-side from the registry). */
  readonly sidebar: ProjectedSidebar;
  readonly activeRoute: string;
}) {
  const visibleGroups = sidebar.groups.filter((view) => view.visible);
  // The projection's first emphasized group pins open on mount (contract
  // 01 §3 accordion + UX-002 emphasis); collapse default otherwise.
  const defaultOpen =
    visibleGroups.find((view) => view.emphasized)?.group.slug ?? null;
  return (
    <>
      <div className="cc-nav__rows" data-testid="nav.rows">
        {sidebar.rows.map(({ row, label }) => {
          const route = appRouteForSidebarRow(row);
          return (
            <SidebarItem
              key={row.id}
              href={route}
              active={route === activeRoute}
              data-testid={row.testId}
            >
              {label}
            </SidebarItem>
          );
        })}
      </div>
      <SidebarWorkloadGroups
        groups={visibleGroups}
        activeRoute={activeRoute}
        defaultOpenSlug={defaultOpen}
      />
    </>
  );
}
