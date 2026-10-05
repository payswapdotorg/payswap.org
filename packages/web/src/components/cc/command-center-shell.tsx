"use client";

/**
 * The Command Center shell (P3-W2-002).
 *
 * Client composition of the @payswap/design primitives: the static grouped
 * Sidebar (hidden <lg), the mobile SidebarDrawer, the Topbar (breadcrumb +
 * ⌘K search trigger + context badges) and the CommandPalette wired to real
 * actions. All navigation is derived server-side from the certified
 * `deriveNavigationForRole` model and passed in as data — this component
 * hardcodes nothing. Interactive state is shell-level only (drawer/palette);
 * every section surface renders as server content below the topbar.
 */

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ProductRole, RoleNavigationView } from "@payswap/ux";
import {
  CommandPalette,
  Sidebar,
  SidebarDrawer,
  SidebarItem,
  SidebarSection,
  Topbar,
  useCommandKey,
} from "@payswap/design";

import { appRouteForNavItemId, resolveAppSection } from "@/lib/cc/routes";
import { deriveUniversalPalette, UNIVERSAL_AREA_MODEL } from "@/lib/universal/palette";
import { resolveUniversalAreaRoute } from "@/lib/universal/areas";
import { CcNavContent } from "./cc-nav-content";

export interface CommandCenterShellProps {
  /** The certified, role-derived navigation (computed server-side). */
  readonly nav: RoleNavigationView;
  /** The role driving this render (null while gated). */
  readonly role: ProductRole | null;
  /** True when the marked preview mode is active (banner renders). */
  readonly preview: boolean;
  /** Honest session one-liner for the sidebar footer. */
  readonly sessionLine: string;
  /** The role switcher form (a server slot — works without JavaScript). */
  readonly roleSwitcher: ReactNode;
  readonly children: ReactNode;
}

export function CommandCenterShell({
  nav,
  role,
  preview,
  sessionLine,
  roleSwitcher,
  children,
}: CommandCenterShellProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useCommandKey(() => {
    setPaletteOpen(true);
  });

  // Close the drawer whenever navigation happens (the palette closes itself).
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const resolved = resolveAppSection(pathname);
  const universalRoute = resolveUniversalAreaRoute(pathname);
  const activeRoute =
    universalRoute ??
    (resolved.kind === "SECTION" ? resolved.route : appRouteForNavItemId("overview"));
  const activeLabel =
    resolved.kind === "SECTION"
      ? (nav.items.find((view) => appRouteForNavItemId(view.item.id) === resolved.route)?.item
          .label ?? "Command Center")
      : (UNIVERSAL_AREA_MODEL.find((area) => area.route === pathname)?.label ??
        "Command Center");

  const palette = deriveUniversalPalette(role);
  const sections = [
    {
      id: "cc-actions",
      label: "Actions",
      commands: palette.actions.map((action) => ({
        id: action.id,
        label: action.label,
        group: action.group,
        keywords: action.keywords,
        run: () => {
          router.push(action.href);
        },
      })),
    },
    {
      id: "cc-goto",
      label: "Go to",
      commands: palette.goTo.map((command) => ({
        id: command.id,
        label: command.label,
        group: command.group,
        keywords: command.keywords,
        run: () => {
          router.push(command.href);
        },
      })),
    },
  ];

  const sidebarFooter = (
    <div className="cc-role-form">
      <p className="cc-role-form__note">{sessionLine}</p>
      {roleSwitcher}
    </div>
  );

  const brand = (
    <>
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "1.75rem",
          height: "1.75rem",
          borderRadius: "var(--ps-radius-sm, 6px)",
          backgroundColor: "var(--ps-accent)",
          color: "var(--ps-on-accent)",
          fontSize: "var(--ps-text-sm)",
          fontWeight: "var(--ps-weight-semibold)",
        }}
      >
        PS
      </span>
      <span>Command Center</span>
    </>
  );

  return (
    <div className="ps-root cc-shell">
      <Sidebar label="Command Center sections" brand={brand} footer={sidebarFooter}>
        <CcNavContent nav={nav} activeRoute={activeRoute} />
      </Sidebar>

      <SidebarDrawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
        }}
        brand={brand}
        footer={sidebarFooter}
      >
        <CcNavContent nav={nav} activeRoute={activeRoute} />
      </SidebarDrawer>

      <div className="cc-shell__main">
        <Topbar
          leading={
            <button
              type="button"
              className="cc-shell__menu"
              aria-label="Open navigation"
              onClick={() => {
                setDrawerOpen(true);
              }}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
                <path
                  d="M4 6h16M4 12h16M4 18h16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          }
          breadcrumbs={[
            { label: "Command Center", href: "/app" },
            { label: activeLabel },
          ]}
          onSearch={() => {
            setPaletteOpen(true);
          }}
          searchText="Search…"
          searchLabel="Open the command palette"
          badges={
            preview ? (
              <span className="ps-badge" data-tone="preview">
                Preview — no session
              </span>
            ) : null
          }
        />
        {preview ? (
          <p className="cc-preview" role="status">
            <span className="cc-preview__label">Preview mode</span>
            <span>
              Navigation is derived for the{" "}
              <strong>{role ?? "selected"}</strong> role. No session is active —
              session-scoped data renders its honest unavailable states. This is
              a clearly-marked affordance, not an authentication.
            </span>
          </p>
        ) : null}
        <div className="cc-shell__content">{children}</div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
        }}
        sections={sections}
        label="Command palette"
        emptyMessage="No matching commands or sections."
      />
    </div>
  );
}
