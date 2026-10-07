"use client";

/**
 * The Command Center shell (P3-W2-002; contract-01 convergence by UX-003).
 *
 * Client composition of the @payswap/design primitives around the UX-002
 * object-model sidebar: the static grouped Sidebar (hidden <lg), the mobile
 * SidebarDrawer, the persistent EnvironmentBanner (honest TEST band — the
 * live path exists in the component but no live deployment exists to reach
 * it), the Topbar (breadcrumb + ⌘K search trigger + Settings + the global
 * Create split-button with visible chords `c p` / `c r` / `c i` / `c l` /
 * `c v` active everywhere inside /app) and the CommandPalette wired to real
 * actions. The sidebar arrives as a role PROJECTION of the registry
 * (computed server-side) — this component hardcodes nothing. Interactive
 * state is shell-level only (drawer/palette/accordion); every section
 * surface renders as server content below the topbar.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ProductRole } from "@payswap/ux";
import { navigationItems, PRODUCT_NAVIGATION } from "@payswap/ux";
import type { ProjectedSidebar } from "@payswap/ux";
import type { SetupGuideStep } from "@payswap/design";
import {
  CommandPalette,
  CreateMenu,
  EnvironmentBanner,
  Sidebar,
  SidebarDrawer,
  SetupGuideWidget,
  Topbar,
  useCommandKey,
  type CreateMenuItem as DesignCreateMenuItem,
} from "@payswap/design";

import { appRouteForSidebarGroupItem, appRouteForSidebarRow, createMenuTargets, deepestKnownAppRoute } from "@/lib/cc/routes";
import { deriveUniversalPalette, UNIVERSAL_AREA_MODEL } from "@/lib/universal/palette";
import { resolveUniversalAreaRoute } from "@/lib/universal/areas";
import { CC_ENVIRONMENT } from "@/components/shell/environment";
import { setupStepRoute } from "@/components/shell/setup-guide";
import { CcNavContent } from "./cc-nav-content";

export interface CommandCenterShellProps {
  /** The role-projected object-model sidebar (computed server-side). */
  readonly sidebar: ProjectedSidebar;
  /** The role driving this render (null while gated). */
  readonly role: ProductRole | null;
  /** True when the marked preview mode is active (banner renders). */
  readonly preview: boolean;
  /** Honest session one-liner for the sidebar footer. */
  readonly sessionLine: string;
  /** The role switcher form (a server slot — works without JavaScript). */
  readonly roleSwitcher: ReactNode;
  /** The honest setup-guide steps (derived server-side from real state). */
  readonly setupSteps: readonly SetupGuideStep[];
  readonly children: ReactNode;
}

/** Legacy-section labels for deep surfaces the sidebar folds (labels only). */
const LEGACY_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  navigationItems(PRODUCT_NAVIGATION).map((item) => [
    item.id === "overview" ? "/app" : `/app/${item.id}`,
    item.label,
  ]),
);

export function CommandCenterShell({
  sidebar,
  role,
  preview,
  sessionLine,
  roleSwitcher,
  setupSteps,
  children,
}: CommandCenterShellProps) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [announced, setAnnounced] = useState<string | null>(null);

  useCommandKey(() => {
    setPaletteOpen(true);
  });

  // The mobile drawer closes when a navigation happens INSIDE it (any
  // anchor click — event delegation, no navigation-chasing effect).
  const handleDrawerContentClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLElement && event.target.closest("a") !== null) {
      setDrawerOpen(false);
    }
  };

  // The active /app route: universal areas win on their routes, otherwise
  // the deepest KNOWN route (detail pages keep their collection active).
  const universalRoute = resolveUniversalAreaRoute(pathname);
  const activeRoute = universalRoute ?? deepestKnownAppRoute(pathname);

  // The breadcrumb label: the projection's own label when the sidebar binds
  // this route, otherwise the legacy/universal surface's certified label.
  const activeLabel =
    sidebar.rows.find((view) => appRouteForSidebarRow(view.row) === activeRoute)?.label ??
    sidebar.groups
      .flatMap((view) => view.group.items)
      .find((item) => appRouteForSidebarGroupItem(item) === activeRoute)?.label ??
    LEGACY_LABELS[activeRoute] ??
    UNIVERSAL_AREA_MODEL.find((area) => area.route === pathname)?.label ??
    "Command Center";

  // Live region: announce route changes politely (contract 01 §2.5). No
  // announcement on first paint — only on actual navigation.
  const firstPathname = useRef(pathname);
  useEffect(() => {
    if (firstPathname.current !== pathname) {
      firstPathname.current = pathname;
      setAnnounced(`Navigated to ${activeLabel}`);
    }
  }, [pathname, activeLabel]);

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

  // The global Create split-button (contract 01 §6): five canonical
  // creations, each with its visible chord, routing to the work-order
  // targets. Chords are active everywhere inside /app while mounted (the
  // design hook never fires while a text input is focused).
  const createItems: readonly DesignCreateMenuItem[] = createMenuTargets().map(
    ([item, route]) => ({
      id: item.id,
      label: item.label,
      chord: item.chord,
      onSelect: () => {
        router.push(route);
      },
    }),
  );

  const sidebarFooter = (
    <div className="cc-role-form cc-shell__footer">
      <SetupGuideWidget
        steps={[...setupSteps]}
        onSelectStep={(stepId) => {
          router.push(setupStepRoute(stepId));
        }}
      />
      <p className="cc-role-form__note">{sessionLine}</p>
      {roleSwitcher}
      <Link className="cc-shell__footer-link" href="/app/developers">
        Developers
      </Link>
      {/* Customize (contract 01 §2.4): appearance configuration is
          account-level — Settings serves it until a dedicated surface
          ships (the same fold doctrine as the route binding table). */}
      <Link className="cc-shell__footer-link" href="/app/settings">
        Customize
      </Link>
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
        <CcNavContent sidebar={sidebar} activeRoute={activeRoute} />
      </Sidebar>

      <SidebarDrawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
        }}
        brand={brand}
        footer={sidebarFooter}
      >
        <div onClick={handleDrawerContentClick}>
          <CcNavContent sidebar={sidebar} activeRoute={activeRoute} />
        </div>
      </SidebarDrawer>

      <div className="cc-shell__main">
        {/* The honest environment band: persistent, full-width, top-pinned,
            not dismissible (contract 01 §2). TEST in this deployment; the
            live path renders nothing by design and is unreachable here. */}
        <EnvironmentBanner
          environment={CC_ENVIRONMENT}
          exitHref="/app/settings"
          data-testid="cc-env-banner"
        />
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
            <>
              <EnvironmentBanner environment={CC_ENVIRONMENT} variant="badge" />
              {preview ? (
                <span className="ps-badge" data-tone="preview">
                  Preview — no session
                </span>
              ) : null}
            </>
          }
          actions={
            <>
              <Link className="cc-shell__topbar-link" href="/app/settings">
                Settings
              </Link>
              <CreateMenu items={[...createItems]} data-testid="cc-create-menu" />
            </>
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
        {/* Route-change live region (contract 01 §2.5). */}
        <p className="ps-sr-only" role="status" aria-live="polite" data-testid="cc-route-announcer">
          {announced}
        </p>
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
