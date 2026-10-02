/**
 * P3-W2-003 — deep-link contracts: no dead buttons, no broken deep links.
 *
 * Law: every navigation entry rendered anywhere in the public web surface
 * resolves to a REAL route in this application. The route inventory below
 * is checked against the filesystem (src/app page.tsx tree) so the two can
 * never drift silently, and every internal href extracted from the rendered
 * navigation surfaces (site header/footer, public pages, CC navigation for
 * all eight roles, the honest auth gate, both not-found surfaces, the
 * provider catalogue, the ⌘K palette) must resolve against it.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { deriveNavigationForRole, PRODUCT_NAVIGATION, PRODUCT_ROLES } from "@payswap/ux";

import { SiteHeader } from "../src/components/site-header";
import { SiteFooter } from "../src/components/site-footer";
import { HomePage } from "../src/components/home-page";
import { CapabilitiesPage } from "../src/components/capabilities-page";
import { SecurityPage } from "../src/components/security-page";
import { DevelopersPage } from "../src/components/developers-page";
import { CcNavContent } from "../src/components/cc/cc-nav-content";
import { CcAuthGate } from "../src/components/cc/cc-auth-gate";
import { CommandCenterShell } from "../src/components/cc/command-center-shell";
import NotFoundRoot from "../src/app/not-found";
import NotFoundApp from "../src/app/app/not-found";
import { ProviderCataloguePanel } from "../src/components/connect/provider-catalogue";
import { CATALOGUE_STATUSES } from "../src/app/(auth)/_server/connection-catalogue";
import { deriveCcPalette } from "../src/lib/cc/palette";
import { appRoutes, resolveAppSection } from "../src/lib/cc/routes";
import { PRIMARY_NAV, COMMAND_CENTER_HREF } from "../src/lib/site";
import { API_BASE_URL_ENV_VAR, type ApiRuntimeState } from "../src/lib/api";
import { deriveCcRenderState } from "../src/lib/cc/render-state";
import { resolveCcSession } from "../src/lib/cc/session-seam";

const APP_DIR = join(import.meta.dirname, "../src/app");

/* ------------------------- the route inventory ----------------------- */

/** Dynamic segment notation: :providerId ← [providerId]. */
const ROUTE_INVENTORY: readonly string[] = [
  "/",
  "/capabilities",
  "/security",
  "/developers",
  "/signin",
  "/signout",
  "/connect",
  "/connect/:providerId",
  "/reauth",
  "/onboarding",
  "/app",
  "/app/activity",
  "/app/agents",
  "/app/billing",
  "/app/capabilities",
  "/app/collections",
  "/app/credit",
  "/app/developers",
  "/app/disputes",
  "/app/evidence",
  "/app/liquidity",
  "/app/opportunities",
  "/app/payments",
  "/app/payouts",
  "/app/programs",
  "/app/settings",
];

const API_INVENTORY: readonly string[] = ["/api/health"];

function routeFromFile(file: string): string {
  let rel = relative(APP_DIR, file).split(sep).join("/");
  rel = rel.replace(/(?:^|\/)page\.tsx$/, "").replace(/(?:^|\/)route\.ts$/, "");
  // Route groups ((auth), …) are URL-invisible.
  rel = rel.replace(/(^|\/)\([^/]+\)/g, "/");
  // Dynamic segments to :param notation.
  rel = rel.replace(/\[([^\]]+)\]/g, ":$1");
  // Normalize: strip the leading slash (re-added below), collapse doubles.
  rel = rel.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (rel === "") {
    return "/";
  }
  return `/${rel}`;
}

function discoverRoutes(): { pages: string[]; apis: string[] } {
  const pages: string[] = [];
  const apis: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "page.tsx") {
        pages.push(routeFromFile(full));
      } else if (entry.name === "route.ts") {
        apis.push(routeFromFile(full));
      }
    }
  };
  walk(APP_DIR);
  pages.sort();
  apis.sort();
  return { pages, apis };
}

/* --------------------------- href extraction ------------------------- */

function extractInternalHrefs(markup: string): string[] {
  const document = new JSDOM(`<!doctype html><body>${markup}</body>`).window
    .document;
  const hrefs: string[] = [];
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const raw = anchor.getAttribute("href") ?? "";
    if (raw === "" || raw.startsWith("#")) {
      continue; // same-document fragment — covered by the skip-link contract
    }
    if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith("//") || raw.startsWith("mailto:")) {
      continue; // external — none exist today; if one appears it must opt in explicitly
    }
    hrefs.push(raw);
  }
  return hrefs;
}

const CATALOGUE_IDS = new Set(
  CATALOGUE_STATUSES.map((status) => status.providerId),
);

function hrefResolves(href: string): boolean {
  const path = href.split("?")[0]!.split("#")[0]!;
  if (ROUTE_INVENTORY.includes(path)) {
    return true;
  }
  const dynamic = path.match(/^\/connect\/([a-z0-9_-]+)$/);
  if (dynamic) {
    return CATALOGUE_IDS.has(dynamic[1]!);
  }
  return false;
}

const API_UNCONFIGURED: ApiRuntimeState = {
  configured: false,
  baseUrl: null,
  envVar: API_BASE_URL_ENV_VAR,
};

/* ------------------------------- tests ------------------------------- */

describe("deep links: the route inventory is the filesystem truth", () => {
  it("every declared page route exists as a page.tsx (and vice versa)", () => {
    const { pages } = discoverRoutes();
    expect(pages.sort()).toEqual([...ROUTE_INVENTORY].sort());
  });

  it("the health endpoint exists as an API route", () => {
    const { apis } = discoverRoutes();
    for (const api of API_INVENTORY) {
      expect(apis).toContain(api);
    }
  });
});

describe("deep links: every nav entry resolves to a real route", () => {
  const surfaces: Array<[string, string[]]> = [
    ["site header", extractInternalHrefs(renderToStaticMarkup(<SiteHeader />))],
    ["site footer", extractInternalHrefs(renderToStaticMarkup(<SiteFooter />))],
    ["home page", extractInternalHrefs(renderToStaticMarkup(<HomePage />))],
    [
      "capabilities page",
      extractInternalHrefs(renderToStaticMarkup(<CapabilitiesPage />)),
    ],
    ["security page", extractInternalHrefs(renderToStaticMarkup(<SecurityPage />))],
    [
      "developers page",
      extractInternalHrefs(
        renderToStaticMarkup(<DevelopersPage api={API_UNCONFIGURED} />),
      ),
    ],
    [
      "root not-found",
      extractInternalHrefs(renderToStaticMarkup(<NotFoundRoot />)),
    ],
    [
      "app not-found (unknown /app deep link)",
      extractInternalHrefs(renderToStaticMarkup(<NotFoundApp />)),
    ],
    [
      "provider catalogue",
      extractInternalHrefs(
        renderToStaticMarkup(
          <ProviderCataloguePanel statuses={CATALOGUE_STATUSES} />,
        ),
      ),
    ],
  ];

  // The CC navigation, for every role derivation.
  for (const role of PRODUCT_ROLES) {
    const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, role);
    surfaces.push([
      `CC navigation (${role})`,
      extractInternalHrefs(
        renderToStaticMarkup(<CcNavContent nav={nav} activeRoute="/app" />),
      ),
    ]);
  }

  it.each(surfaces.map(([name]) => name))(
    "%s: all internal hrefs resolve",
    (name) => {
      const hrefs = surfaces.find(([n]) => n === name)![1];
      // Navigation surfaces must actually navigate; content-only surfaces
      // simply must not contain dead links.
      const isNavSurface =
        /navigation|header|footer|catalogue|auth gate/.test(name);
      if (isNavSurface) {
        expect(hrefs.length).toBeGreaterThan(0);
      }
      const dead = hrefs.filter((href) => !hrefResolves(href));
      expect(dead).toEqual([]);
    },
  );

  it("the primary nav and the Command Center CTA are real routes", () => {
    for (const link of PRIMARY_NAV) {
      expect(ROUTE_INVENTORY).toContain(link.href);
    }
    expect(ROUTE_INVENTORY).toContain(COMMAND_CENTER_HREF);
  });

  it("the honest auth gate links only to real public routes", async () => {
    const session = await resolveCcSession();
    const state = deriveCcRenderState(session, null);
    const markup = renderToStaticMarkup(
      <CcAuthGate navItemId="overview" state={state} />,
    );
    const hrefs = extractInternalHrefs(markup);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((href) => !hrefResolves(href))).toEqual([]);
  });

  it("the ⌘K palette commands deep-link to real routes (journey starts included)", () => {
    for (const role of PRODUCT_ROLES) {
      const palette = deriveCcPalette(role);
      const hrefs = [...palette.actions, ...palette.goTo].map(
        (command) => command.href,
      );
      expect(hrefs.length).toBeGreaterThan(0);
      expect(hrefs.filter((href) => !hrefResolves(href))).toEqual([]);
    }
  });

  it("every /app nav route binds back through resolveAppSection (no dead sections)", () => {
    for (const [id, route] of appRoutes()) {
      expect(ROUTE_INVENTORY).toContain(route);
      const resolution = resolveAppSection(route);
      expect(resolution).toEqual({
        kind: "SECTION",
        navItemId: id,
        route,
      });
    }
  });
});

describe("deep links: the Command Center shell navigation is complete", () => {
  it("the shell renders the merchant navigation as real anchors", () => {
    const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, "merchant");
    const markup = renderToStaticMarkup(
      <CommandCenterShell
        nav={nav}
        role="merchant"
        preview
        sessionLine="No session."
        roleSwitcher={<select aria-label="View as role (preview)" />}
      >
        <p>x</p>
      </CommandCenterShell>,
    );
    const hrefs = extractInternalHrefs(markup);
    // Every visible merchant section is reachable from the shell.
    for (const view of nav.items) {
      const route =
        view.item.id === "overview" ? "/app" : `/app/${view.item.id}`;
      expect(hrefs).toContain(route);
    }
    expect(hrefs.filter((href) => !hrefResolves(href))).toEqual([]);
  });
});

describe("deep links: no dead anchors anywhere", () => {
  it("no surface renders href=\"#\" or empty/JS hrefs", () => {
    const markups = [
      renderToStaticMarkup(<SiteHeader />),
      renderToStaticMarkup(<SiteFooter />),
      renderToStaticMarkup(<HomePage />),
      renderToStaticMarkup(<CapabilitiesPage />),
      renderToStaticMarkup(<SecurityPage />),
      renderToStaticMarkup(<DevelopersPage api={API_UNCONFIGURED} />),
    ];
    for (const markup of markups) {
      expect(markup).not.toContain('href="#"');
      expect(markup).not.toContain('href=""');
      expect(markup).not.toContain("javascript:");
    }
  });

  it("hash targets reference elements that exist in the same document", () => {
    const markup = renderToStaticMarkup(
      <SiteHeader /> + renderToStaticMarkup(<HomePage />),
    );
    const document = new JSDOM(`<!doctype html><body>${markup}</body>`).window
      .document;
    for (const anchor of Array.from(document.querySelectorAll("a[href^='#']"))) {
      const id = (anchor.getAttribute("href") ?? "").slice(1);
      if (id !== "") {
        expect(document.getElementById(id)).toBeTruthy();
      }
    }
  });
});
