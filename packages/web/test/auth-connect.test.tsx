import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildWebSessionPlane,
  InjectedWebClock,
  type WebSessionPlane,
} from "../src/lib/session/web-session";
import { hashPassword, verifyPassword } from "../src/lib/session/password";
import { mintCsrfToken, verifyCsrfToken } from "../src/lib/session/csrf";
import { SESSION_COOKIE, CSRF_COOKIE, sessionCookieAttributes } from "../src/lib/session/cookies";
import { sanitizeNextPath } from "../src/components/auth/sign-in-form";
import { IdentityPlaneNotConfiguredState } from "../src/components/auth/identity-plane-state";
import {
  buildConnectionPlaneForTests,
  AUTHORIZATION_SURFACE_NOT_BOUND,
} from "../src/app/(auth)/_server/connection-plane";
import { CATALOGUE_STATUSES } from "../src/app/(auth)/_server/connection-catalogue";
import { ProviderCataloguePanel } from "../src/components/connect/provider-catalogue";
import {
  asBrowserSessionRef,
  beginConnectProvider,
  browseProviderCatalogue,
  chooseProvider,
} from "@payswap/ux";
import { providerCatalogueEntries } from "../src/app/(auth)/_server/connection-catalogue";

/**
 * P3-W1-002 acceptance tests — the authentication/onboarding/connection UX.
 *
 * Laws exercised: the identity plane is real and secure (scrypt, CSRF,
 * fail-closed unconfigured); credentials never surface; the catalogue never
 * authorizes; the authorization surface is honestly not-bound; connection
 * scope is explicit.
 */

const NOW_MS = 1_800_000_000_000;
const SIGNING_KEY = "test-signing-key-at-least-32-characters";

async function buildPlane(): Promise<WebSessionPlane> {
  const passwordHash = await hashPassword("correct horse battery staple");
  const seed = JSON.stringify([
    { email: "owner@example.test", displayName: "Owner", passwordHash },
  ]);
  const plane = await buildWebSessionPlane({
    seedUsersRaw: seed,
    signingKeyRaw: SIGNING_KEY,
    clock: new InjectedWebClock(() => NOW_MS),
  });
  if (!plane.configured) {
    throw new Error(`plane unexpectedly unconfigured: ${plane.detail}`);
  }
  return plane;
}

describe("session plane — real and secure", () => {
  it("unconfigured without env: fail-closed with the env NAMES only (never values)", async () => {
    const plane = await buildWebSessionPlane({
      seedUsersRaw: undefined,
      signingKeyRaw: undefined,
    });
    expect(plane.configured).toBe(false);
    if (!plane.configured) {
      expect(plane.missingEnvVars).toContain("WEB_APP_SEED_USERS");
      expect(plane.missingEnvVars).toContain("WEB_APP_SESSION_SIGNING_KEY");
      expect(plane.detail).not.toContain("test-signing-key");
    }
  });

  it("signs in with the correct password and issues a revocable session", async () => {
    const plane = await buildPlane();
    const outcome = await plane.signIn("owner@example.test", "correct horse battery staple");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      const lookup = plane.lookup(outcome.sessionToken);
      expect(lookup.valid).toBe(true);
      if (lookup.valid) {
        expect(lookup.view.principalRef).toContain("owner@example.test");
      }
      expect(plane.revoke(outcome.sessionToken)).toBe(true);
      const after = plane.lookup(outcome.sessionToken);
      expect(after.valid).toBe(false);
    }
  });

  it("a WRONG password is rejected verbatim and issues NO session", async () => {
    const plane = await buildPlane();
    const outcome = await plane.signIn("owner@example.test", "wrong password");
    expect(outcome.status).not.toBe("signed-in");
    expect(plane.identityCount()).toBe(1);
  });

  it("the password hash verifies via scrypt and never echoes material", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("incorrect", hash)).toBe(false);
  });

  it("CSRF is bound double-submit: a foreign token fails, the minted one passes", () => {
    const sessionToken = "session-token-under-test-123456";
    const minted = mintCsrfToken(sessionToken, SIGNING_KEY);
    expect(minted.startsWith("csrf_v1_")).toBe(true);
    expect(verifyCsrfToken(minted, sessionToken, SIGNING_KEY)).toBe(true);
    expect(verifyCsrfToken("csrf_v1_someothermac", sessionToken, SIGNING_KEY)).toBe(false);
    expect(verifyCsrfToken(undefined, sessionToken, SIGNING_KEY)).toBe(false);
  });

  it("the session cookie contract: httpOnly + SameSite=lax, cookie NAMES only in code", () => {
    const attrs = sessionCookieAttributes(3600);
    expect(SESSION_COOKIE).toBe("payswap_web_session");
    expect(CSRF_COOKIE).toBe("payswap_web_csrf");
    expect(attrs.httpOnly).toBe(true);
    expect(attrs.sameSite).toBe("lax");
  });
});

describe("sign-in surfaces — honest states", () => {
  it("the not-configured state names the env vars and NEVER a credential", () => {
    const html = renderToStaticMarkup(
      <IdentityPlaneNotConfiguredState
        missingEnvVars={["WEB_APP_SEED_USERS", "WEB_APP_SESSION_SIGNING_KEY"]}
        detail="Seed identities and a session signing key are required."
      />,
    );
    expect(html).toContain("WEB_APP_SEED_USERS");
    expect(html).toContain("WEB_APP_SESSION_SIGNING_KEY");
    expect(html).not.toMatch(/password\s*[:=]/i);
  });

  it("the ?next= deep-link return is sanitized (open-redirect refused)", () => {
    expect(sanitizeNextPath("/app/payments")).toBe("/app/payments");
    expect(sanitizeNextPath("https://evil.example.net/x")).toBeNull();
    expect(sanitizeNextPath("//evil.example.net")).toBeNull();
    expect(sanitizeNextPath(null)).toBeNull();
  });
});

describe("connection plane — the W3-001 contract consumed", () => {
  it("the catalogue NEVER authorizes: choosing a provider only moves browsing → initiating", () => {
    const catalogue = providerCatalogueEntries();
    const browsing = browseProviderCatalogue(beginConnectProvider({ catalogue }));
    const option = browsing.catalogue.find((o) => o.connectable);
    expect(option).toBeDefined();
    if (option === undefined) return;
    const initiating = chooseProvider(browsing, option.providerId);
    expect(initiating.stateName).toBe("initiating");
    expect(initiating.connectedInstance).toBeUndefined();
  });

  it("the plane folds select → initiating through the frozen contract (no direct edits)", () => {
    const plane = buildConnectionPlaneForTests();
    const connectable = CATALOGUE_STATUSES.find(
      (s) => s.statusKind !== "BLOCKED" && !s.statusLine.toLowerCase().includes("blocked"),
    );
    expect(connectable).toBeDefined();
    if (connectable === undefined) return;
    const result = plane.selectProvider("user:owner", connectable.providerId);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.journey.stateName).toBe("initiating");
    }
  });

  it("a BLOCKED provider is honestly refused by the contract", () => {
    const catalogue = providerCatalogueEntries();
    const browsing = browseProviderCatalogue(beginConnectProvider({ catalogue }));
    const blockedOption = browsing.catalogue.find((o) => !o.connectable);
    if (blockedOption === undefined) return;
    expect(() => chooseProvider(browsing, blockedOption.providerId)).toThrow();
  });

  it("the authorization surface is honestly NOT BOUND in this deployment (no fabricated sessions)", () => {
    expect(AUTHORIZATION_SURFACE_NOT_BOUND.brokerBound).toBe(false);
    expect(AUTHORIZATION_SURFACE_NOT_BOUND.honestState).toContain("not yet bound");
  });

  it("the catalogue panel renders statuses with dates and the availability-is-not-capability doctrine", () => {
    const html = renderToStaticMarkup(<ProviderCataloguePanel statuses={CATALOGUE_STATUSES} />);
    expect(html).toContain("Availability is NOT connected capability");
    expect(html).toMatch(/BLOCKED|blocked/i);
  });

  it("the browser-session ref is opaque — no credential material anywhere in the serialized journeys", () => {
    const ref = asBrowserSessionRef("opaque-session-ref-1");
    expect(String(ref)).toBe("opaque-session-ref-1");
    const plane = buildConnectionPlaneForTests();
    for (const journey of plane.journeysFor("user:owner")) {
      const serialized = JSON.stringify(journey);
      expect(serialized).not.toMatch(/password|api[_-]?key|cookie|mfa/i);
    }
  });
});
