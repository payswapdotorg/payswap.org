/**
 * P3-W2-003 — aria contracts.
 *
 * Static-markup contracts (the repo's node-environment pattern): every
 * interactive element is named, every landmark present, every form control
 * wired (label / hint / error), live regions announce the right politeness,
 * the active nav entry is carried by aria-current (never color alone), icons
 * are hidden from AT, buttons declare their type, and the CSS keeps its side
 * of the bargain (focus-visible rings, 44px touch tokens, reduced-motion).
 *
 * Parsed with JSDOM so structural laws are asserted against a real DOM tree,
 * not string luck.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Field,
  Input,
  SidebarDrawer,
  Skeleton,
  Toast,
  ToastViewport,
  Topbar,
} from "@payswap/design";
import { projectSidebar } from "@payswap/ux";

import RootLayout from "../src/app/layout";
import { SiteHeader } from "../src/components/site-header";
import { SiteFooter } from "../src/components/site-footer";
import { HomePage } from "../src/components/home-page";
import { CapabilitiesPage } from "../src/components/capabilities-page";
import { SecurityPage } from "../src/components/security-page";
import { DevelopersPage } from "../src/components/developers-page";
import { SignInForm } from "../src/components/auth/sign-in-form";
import { CommandCenterShell } from "../src/components/cc/command-center-shell";
import { CcNavContent } from "../src/components/cc/cc-nav-content";
import { API_BASE_URL_ENV_VAR, type ApiRuntimeState } from "../src/lib/api";

const API_UNCONFIGURED: ApiRuntimeState = {
  configured: false,
  baseUrl: null,
  envVar: API_BASE_URL_ENV_VAR,
};

function doc(markup: string): Document {
  // A real origin (never opaque) so jsdom storage accessors work and
  // assertion diffs print properly.
  return new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
    url: "https://payswap.test/",
  }).window.document;
}

/** Simplified accessible-name computation (ARIA label precedence). */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const owner = el.ownerDocument!;
    return labelledBy
      .split(/\s+/)
      .map((id) => owner.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  const label = el.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") {
    return label.trim();
  }
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

interface NameSweep {
  buttons: Element[];
  links: Element[];
  unlabeledButtons: string[];
  unlabeledLinks: string[];
}

function sweepNames(document: Document, scope: string): NameSweep {
  const root = scope === "body" ? document.body : document;
  const buttons = Array.from(root.querySelectorAll("button"));
  const links = Array.from(root.querySelectorAll("a[href]"));
  return {
    buttons,
    links,
    unlabeledButtons: buttons
      .filter((b) => accessibleName(b) === "")
      .map((b) => b.outerHTML.slice(0, 90)),
    unlabeledLinks: links
      .filter((l) => accessibleName(l) === "")
      .map((l) => l.outerHTML.slice(0, 90)),
  };
}

const PUBLIC_SURFACES: Array<[string, () => string]> = [
  ["home", () => renderToStaticMarkup(<HomePage />)],
  ["capabilities", () => renderToStaticMarkup(<CapabilitiesPage />)],
  ["security", () => renderToStaticMarkup(<SecurityPage />)],
  ["developers", () => renderToStaticMarkup(<DevelopersPage api={API_UNCONFIGURED} />)],
  ["site header", () => renderToStaticMarkup(<SiteHeader />)],
  ["site footer", () => renderToStaticMarkup(<SiteFooter />)],
  ["sign-in form", () => renderToStaticMarkup(<SignInForm />)],
];

/** Full-page surfaces — the one-h1-per-page law applies to these only. */
const PAGE_SURFACES = PUBLIC_SURFACES.filter(([name]) =>
  ["home", "capabilities", "security", "developers"].includes(name),
);

/* --------------------------- landmarks + names ---------------------- */

describe("aria: landmarks, headings and page structure", () => {
  it("the root layout declares the document language and the landmark frame", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <div>content</div>
      </RootLayout>,
    );
    const document = new JSDOM(markup, { url: "https://payswap.test/" })
      .window.document;
    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(document.querySelector("main")!.getAttribute("id")).toBe(
      "main-content",
    );
    expect(document.querySelectorAll("header")).toHaveLength(1);
    expect(document.querySelectorAll("footer")).toHaveLength(1);
    // Both navigation landmarks are named.
    for (const nav of Array.from(document.querySelectorAll("nav"))) {
      expect(nav.getAttribute("aria-label")).toMatch(/^(Primary|Footer|Mobile)$/);
    }
    expect(document.querySelectorAll("nav").length).toBeGreaterThanOrEqual(2);
  });

  it.each(PAGE_SURFACES.map(([name]) => name))(
    "%s: exactly one h1",
    (name) => {
      const surface = PAGE_SURFACES.find(([n]) => n === name)!;
      const document = doc(surface[1]());
      expect(document.querySelectorAll("h1")).toHaveLength(1);
    },
  );

  it.each(PUBLIC_SURFACES.map(([name]) => name))(
    "%s: every interactive element has an accessible name",
    (name) => {
      const surface = PUBLIC_SURFACES.find(([n]) => n === name)!;
      const sweep = sweepNames(doc(surface[1]()), "body");
      // Content-only surfaces may legitimately have zero interactives; any
      // interactive that DOES exist must be named.
      expect(sweep.unlabeledButtons).toEqual([]);
      expect(sweep.unlabeledLinks).toEqual([]);
    },
  );

  it.each(PUBLIC_SURFACES.map(([name]) => name))(
    "%s: every button declares its type (no accidental submits)",
    (name) => {
      const surface = PUBLIC_SURFACES.find(([n]) => n === name)!;
      const document = doc(surface[1]());
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const button of buttons) {
        expect(["button", "submit", "reset"]).toContain(
          button.getAttribute("type"),
        );
      }
    },
  );

  it.each(PUBLIC_SURFACES.map(([name]) => name))(
    "%s: decorative SVGs are hidden from AT",
    (name) => {
      const surface = PUBLIC_SURFACES.find(([n]) => n === name)!;
      const document = doc(surface[1]());
      for (const svg of Array.from(document.querySelectorAll("svg"))) {
        expect(svg.getAttribute("aria-hidden")).toBe("true");
      }
    },
  );
});

/* --------------------------- touch + focus CSS ---------------------- */

describe("aria: focus-visible and touch-target CSS contracts", () => {
  const webRoot = path.resolve(import.meta.dirname, "../src/app");
  const designRoot = path.resolve(
    import.meta.dirname,
    "../../design/src",
  );

  it("the public header/nav links carry visible focus rings and 44px targets", () => {
    const markup = renderToStaticMarkup(<SiteHeader />);
    // Tailwind utilities in the rendered classes (the design-system law in
    // the public surface's own vocabulary).
    expect(markup).toContain("focus-visible:outline-2");
    const links = Array.from(doc(markup).querySelectorAll("a[href]"));
    const navLinks = links.filter((l) =>
      l.getAttribute("class")?.includes("min-h-[44px]"),
    );
    expect(navLinks.length).toBeGreaterThanOrEqual(4);
  });

  it("the design tokens keep the visible-focus law and the 44px touch law", () => {
    const tokens = readFileSync(
      path.join(designRoot, "tokens.css"),
      "utf8",
    );
    expect(tokens).toMatch(/:focus-visible\s*{\s*outline:\s*2px solid/);
    expect(tokens).toContain("--ps-touch: 44px");
    // Motion tokens collapse under prefers-reduced-motion.
    expect(tokens).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*--ps-duration-fast: 0\.01ms/,
    );
  });

  it("the Command Center shell keeps the no-overflow min-width law", () => {
    const cc = readFileSync(path.join(webRoot, "app/cc.css"), "utf8");
    expect(cc).toMatch(/\.cc-shell__main\s*{[^}]*min-width:\s*0/);
  });

  it("public smooth scrolling is guarded by prefers-reduced-motion (WCAG 2.3.3 posture)", () => {
    const css = readFileSync(path.join(webRoot, "globals.css"), "utf8");
    // The rule must appear ONLY inside a no-preference media query.
    const unguarded = /(^|})\s*html\s*{[^}]*scroll-behavior:\s*smooth/.test(
      css.replace(/@media \(prefers-reduced-motion: no-preference\)\s*{[\s\S]*?}\s*}/g, ""),
    );
    expect(unguarded).toBe(false);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*{[\s\S]*scroll-behavior:\s*smooth/,
    );
  });
});

/* ------------------------------ forms ------------------------------- */

describe("aria: form fields are fully wired", () => {
  it("Field + Input: label association, hint and error via aria-describedby, aria-invalid", () => {
    const markup = renderToStaticMarkup(
      <Field
        label="Amount"
        hint="Minor units (pesewas)."
        error="Amount exceeds the mandate limit."
        required
      >
        <Input name="amount" />
      </Field>,
    );
    const document = doc(markup);
    const label = document.querySelector("label")!;
    const control = document.querySelector("input")!;
    expect(label.getAttribute("for")).toBe(control.getAttribute("id"));
    const describedBy = (control.getAttribute("aria-describedby") ?? "").split(
      /\s+/,
    );
    const hint = document.querySelector("p.ps-field__hint")!;
    const error = document.querySelector("p.ps-field__error")!;
    expect(describedBy).toContain(hint.getAttribute("id"));
    expect(describedBy).toContain(error.getAttribute("id"));
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(error.getAttribute("role")).toBe("alert");
  });

  it("the sign-in form wires both fields (label, hint, describedby) and announces failures politely", () => {
    const markup = renderToStaticMarkup(<SignInForm />);
    const document = doc(markup);
    const email = document.querySelector('input[name="email"]')!;
    const password = document.querySelector('input[name="password"]')!;
    expect(email.getAttribute("type")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("username");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    for (const control of [email, password]) {
      const id = control.getAttribute("id")!;
      expect(document.querySelector(`label[for="${id}"]`)).toBeTruthy();
      const describedBy = control.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      for (const part of describedBy!.split(/\s+/)) {
        expect(document.getElementById(part)).toBeTruthy();
      }
    }
    // Failures land in a polite live region (never assertive for form
    // validation noise).
    expect(markup).toContain('aria-live="polite"');
  });
});

/* ---------------------------- live regions -------------------------- */

describe("aria: live regions announce with the right politeness", () => {
  it("errors are assertive, information is polite — Toast", () => {
    const error = renderToStaticMarkup(
      <Toast tone="error">Payment submission failed</Toast>,
    );
    expect(error).toContain('role="alert"');
    const info = renderToStaticMarkup(
      <Toast tone="info">Connected — observed just now</Toast>,
    );
    expect(info).toContain('role="status"');
    const success = renderToStaticMarkup(
      <Toast tone="success">Signed in</Toast>,
    );
    expect(success).toContain('role="status"');
    for (const markup of [error, info, success]) {
      expect(markup).toContain('aria-label="Dismiss"');
    }
  });

  it("exactly one labelled toast viewport (never duplicate live regions)", () => {
    const markup = renderToStaticMarkup(
      <ToastViewport>
        <Toast tone="info">x</Toast>
      </ToastViewport>,
    );
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Notifications"');
  });

  it("Skeleton loading is announced politely", () => {
    const markup = renderToStaticMarkup(
      <Skeleton count={3} announce="Loading payments" />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Loading payments");
  });
});

/* --------------------------- aria-current --------------------------- */

describe("aria: the active page is carried by aria-current, never color alone", () => {
  it("the Command Center navigation marks the active section", () => {
    const markup = renderToStaticMarkup(
      <CcNavContent sidebar={projectSidebar("merchant")} activeRoute="/app/payments" />,
    );
    const current = doc(markup).querySelector('[aria-current="page"]');
    expect(current?.getAttribute("href")).toBe("/app/payments");
  });

  it("the topbar breadcrumb marks the current crumb", () => {
    const markup = renderToStaticMarkup(
      <Topbar
        breadcrumbs={[
          { label: "Command Center", href: "/app" },
          { label: "Payments" },
        ]}
      />,
    );
    const current = doc(markup).querySelector('[aria-current="page"]');
    expect(current?.textContent).toContain("Payments");
    expect(markup).toContain('aria-label="Breadcrumb"');
  });

  it("the public header marks the current primary-nav entry (static render: home)", () => {
    const markup = renderToStaticMarkup(<SiteHeader />);
    const currentLinks = Array.from(
      doc(markup).querySelectorAll('a[aria-current="page"]'),
    );
    // With the stub pathname "/", exactly the Home entries are current —
    // one in the desktop nav and one in the mobile disclosure.
    expect(currentLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of currentLinks) {
      expect(link.getAttribute("href")).toBe("/");
    }
    // No other primary-nav entry is marked current.
    const currentHrefs = new Set(
      currentLinks.map((link) => link.getAttribute("href")),
    );
    expect(currentHrefs.has("/capabilities")).toBe(false);
    expect(currentHrefs.has("/security")).toBe(false);
    expect(currentHrefs.has("/developers")).toBe(false);
  });
});

/* ------------------------- Command Center shell --------------------- */

describe("aria: the Command Center shell", () => {
  function shellMarkup(): string {
    return renderToStaticMarkup(
      <CommandCenterShell
        sidebar={projectSidebar("merchant")}
        role="merchant"
        preview
        sessionLine="No session — preview only."
        setupSteps={[]}
        roleSwitcher={<select aria-label="View as role (preview)" />}
      >
        <p>section</p>
      </CommandCenterShell>,
    );
  }

  it("names its landmarks, navigation, search and mobile trigger", () => {
    const markup = shellMarkup();
    const document = doc(markup);
    expect(document.querySelector("aside")).toBeTruthy();
    const sidebarNav = document.querySelector(
      'nav[aria-label="Command Center sections"]',
    );
    expect(sidebarNav).toBeTruthy();
    expect(
      document.querySelector('[aria-label="Open the command palette"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[aria-label="Open navigation"]'),
    ).toBeTruthy();
  });

  it("every sidebar nav entry is a named anchor", () => {
    const sweep = sweepNames(doc(shellMarkup()), "body");
    expect(sweep.unlabeledLinks).toEqual([]);
    expect(sweep.links.filter((l) => (l.getAttribute("href") ?? "").startsWith("/app")).length)
      .toBeGreaterThanOrEqual(5);
  });

  it("the preview banner is a polite status", () => {
    expect(shellMarkup()).toContain('role="status"');
  });

  it("the closed drawer and palette mount nothing (no stray dialogs)", () => {
    const markup = renderToStaticMarkup(
      <SidebarDrawer open={false} onClose={() => undefined}>
        <a href="/app">x</a>
      </SidebarDrawer>,
    );
    expect(markup).not.toContain('role="dialog"');
    expect(shellMarkup()).not.toContain('aria-modal="true"');
  });
});
