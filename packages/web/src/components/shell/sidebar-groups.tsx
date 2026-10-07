"use client";

/**
 * The object-model sidebar groups (UX-003, contract 01 §3): the five
 * workload groups render as an ACCORDION — one group open at a time,
 * collapsed by default except the role projection's first emphasized group
 * (the UX-002 projection pins it open; emphasis is never a re-axing — the
 * groups, slugs, items and order are identical for every role).
 *
 * Keyboard semantics are native: the group toggle is a real button
 * (Enter/Space activate), the items are real anchors (deep-linkable,
 * middle-clickable), and the collapsed panel is `hidden` so Tab never
 * reaches it until the group opens. Every node carries its stable
 * `nav.group.<slug>` / `nav.item.<slug>` testid (contract 01 §2.5).
 */

import { useState, type ReactNode } from "react";
import { SidebarItem } from "@payswap/design";
import type { SidebarGroupView } from "@payswap/ux";

import { appRouteForSidebarGroupItem } from "@/lib/cc/routes";

export interface SidebarWorkloadGroupsProps {
  /** The projected groups (already filtered to the projection's visible set). */
  readonly groups: readonly SidebarGroupView[];
  /** The /app route currently active (marks the owning item aria-current). */
  readonly activeRoute: string;
  /** The group pinned open on mount (the projection's first emphasized group). */
  readonly defaultOpenSlug?: string | null;
  /** Renders inside each group panel below the items (future slot). */
  readonly children?: ReactNode;
}

export function SidebarWorkloadGroups({
  groups,
  activeRoute,
  defaultOpenSlug = null,
}: SidebarWorkloadGroupsProps) {
  const [openSlug, setOpenSlug] = useState<string | null>(defaultOpenSlug);

  return (
    <>
      {groups.map((view) => {
        const { group } = view;
        const open = openSlug === group.slug;
        const panelId = `cc-nav-group-${group.slug}`;
        return (
          <div
            key={group.slug}
            className="cc-nav__group"
            data-testid={group.testId}
            data-open={open || undefined}
          >
            <button
              type="button"
              className="cc-nav__group-toggle"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => {
                // Accordion: opening one group closes the previous.
                setOpenSlug(open ? null : group.slug);
              }}
            >
              <span className="cc-nav__group-label">{group.label}</span>
              <span className="cc-nav__group-chevron" aria-hidden="true">
                {open ? "\u25BE" : "\u25B8"}
              </span>
            </button>
            <ul id={panelId} className="cc-nav__group-items" hidden={!open}>
              {group.items.map((item) => {
                const route = appRouteForSidebarGroupItem(item);
                return (
                  <li key={item.slug}>
                    <SidebarItem
                      href={route}
                      active={route === activeRoute}
                      data-testid={item.testId}
                    >
                      {item.label}
                    </SidebarItem>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}
