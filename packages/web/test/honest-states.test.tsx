// @vitest-environment jsdom
/**
 * P3-W2-003 — honest-state contracts (loading / error / empty / UNKNOWN /
 * auth-required).
 *
 * The state family's law (DESIGN-SYSTEM-FOUNDATIONS §4, AGENTS.md law 4):
 * every asynchronous surface renders the TRUTH of its data. UNKNOWN is
 * reconciliation language with neutral/unknown styling and role=status —
 * it is NEVER dressed as failure (INV-X01): never the danger tone, never
 * role=alert, never a failure title. Loading is transport-level only
 * (aria-busy + polite announcements). Empty states state the absence and
 * guide onward. The auth-required gate states exactly what is unavailable
 * and why, with zero credential capture and zero fabricated data.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import {
  AuthRequiredState,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusPill,
  UnknownState,
} from "@payswap/design";
import {
  applyPayOutcome,
  applyPaymentSubmissionResponse,
  asConnectedCapabilityInstanceId,
  asEvidenceArtifactRef,
  beginPayJourney,
  emptySnapshot,
  selectPayCapability,
} from "@payswap/ux";

import { PayJourneyView } from "../src/components/cc/pay-journey-surface";
import { CcErrorRetry } from "../src/components/cc/cc-error-retry";
import { CcSectionNotYetAvailable } from "../src/components/cc/cc-section-not-yet";
import { CcInboxFeed } from "../src/components/cc/cc-inbox-feed";
import { CcAuthGate } from "../src/components/cc/cc-auth-gate";
import { IdentityPlaneNotConfiguredState } from "../src/components/auth/identity-plane-state";
import { AuthorizationSurfaceNotBoundState } from "../src/components/connect/connection-flow";
import NotFoundRoot from "../src/app/not-found";
import NotFoundApp from "../src/app/app/not-found";
import { deriveCcRenderState } from "../src/lib/cc/render-state";
import { resolveCcSession } from "../src/lib/cc/session-seam";

const routerState = vi.hoisted(() => ({ refreshes: 0 }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => undefined,
    refresh: () => {
      routerState.refreshes += 1;
    },
    back: () => undefined,
    forward: () => undefined,
    prefetch: () => undefined,
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  routerState.refreshes = 0;
});

function doc(markup: string): Document {
  return new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
    url: "https://payswap.test/",
  }).window.document;
}

/** Failure vocabulary that must NEVER classify an UNKNOWN outcome. */
const FAILURE_WORDS = [
  "failed",
  "failure",
  "error",
  "went wrong",
  "unable",
  "couldn't",
  "could not",
];

/* ------------------------- the state family -------------------------- */

describe("honest states: EmptyState", () => {
  it("states the absence politely (role=status, neutral tone) and guides onward", () => {
    const markup = renderToStaticMarkup(
      <EmptyState
        title="No connected capability"
        description="None exist for this viewer yet."
        action={<a href="/connect">Connect a provider</a>}
      />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("ps-state--neutral");
    expect(markup).not.toContain("ps-state--danger");
    expect(markup).toContain("No connected capability");
    expect(markup).toContain('href="/connect"');
    // An empty state is not a failure: no alert semantics, no danger tone.
    expect(markup).not.toContain('role="alert"');
  });

  it("renders no fabricated data by construction (no numbers as content)", () => {
    const markup = renderToStaticMarkup(
      <EmptyState title="Nothing here yet" />,
    );
    const text = doc(markup).body.textContent ?? "";
    expect(text).not.toMatch(/\d/);
  });
});

describe("honest states: ErrorState", () => {
  it("is assertive (role=alert), danger-toned, and its Retry is a real button", () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        title="Could not load payments"
        description="The API answered unexpectedly."
        onRetry={onRetry}
      />,
    );
    const state = document.querySelector(".ps-state--danger");
    expect(state).toBeTruthy();
    expect(state!.getAttribute("role")).toBe("alert");
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders no retry button when there is no recovery action", () => {
    const markup = renderToStaticMarkup(
      <ErrorState title="Could not load" description="x" />,
    );
    expect(markup).not.toContain("Retry");
  });
});

describe("honest states: UnknownState — the UNKNOWN ≠ FAILED law", () => {
  it("renders reconciliation language with UNKNOWN styling, never error semantics", () => {
    const markup = renderToStaticMarkup(
      <UnknownState
        title="Outcome unknown — reconciling"
        description="Awaiting confirmation from the provider."
      />,
    );
    const state = doc(markup).querySelector(".ps-state");
    expect(state).toBeTruthy();
    // role=status (polite), NOT alert.
    expect(state!.getAttribute("role")).toBe("status");
    // The unknown tone, never the danger tone.
    expect(state!.className).toContain("ps-state--unknown");
    expect(state!.className).not.toContain("ps-state--danger");
    // The visible pill carries the reconciliation language + an sr-only
    // "outcome not yet known" (state is never color-alone).
    expect(markup).toContain("Reconciling");
    expect(markup).toContain("outcome not yet known");
  });

  it("the default copy never uses failure vocabulary", () => {
    const markup = renderToStaticMarkup(<UnknownState />);
    const text = doc(markup).body.textContent ?? "";
    const lowered = text.toLowerCase();
    for (const word of FAILURE_WORDS) {
      expect(lowered).not.toContain(word);
    }
    expect(text).toContain("Outcome not yet known");
  });

  it("StatusPill keeps unknown and failed visually and semantically distinct", () => {
    const unknown = renderToStaticMarkup(
      <StatusPill tone="unknown">Reconciling</StatusPill>,
    );
    const failed = renderToStaticMarkup(
      <StatusPill tone="failed">Failed</StatusPill>,
    );
    expect(unknown).toContain("ps-pill--unknown");
    expect(unknown).not.toContain("ps-pill--failed");
    expect(failed).toContain("ps-pill--failed");
    expect(unknown).toContain("outcome not yet known");
    expect(failed).toContain("failed");
  });
});

describe("honest states: AuthRequiredState", () => {
  it("states what is unavailable and why, with the doctrine line and a working retry", () => {
    const onRetry = vi.fn();
    render(
      <AuthRequiredState
        title="Payments — authentication required"
        reason="Sign in to reach this section."
        onRetry={onRetry}
      />,
    );
    const state = document.querySelector(".ps-state");
    expect(state!.getAttribute("role")).toBe("alert");
    expect(screen.getByText(/authentication required/i)).toBeTruthy();
    expect(
      screen.getByText(/Only real, verified state is rendered here/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("captures no credentials (no inputs of any kind)", () => {
    const markup = renderToStaticMarkup(<AuthRequiredState />);
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain("<textarea");
  });
});

/* ------------------------------ loading ------------------------------ */

describe("honest states: loading is transport-level only", () => {
  it("Button loading: aria-busy, sr-only loading label, disabled, label preserved", () => {
    const markup = renderToStaticMarkup(
      <Button loading loadingLabel="Signing in">Sign in</Button>,
    );
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Signing in");
    const document = doc(markup);
    expect(
      document.querySelector(".ps-sr-only")?.textContent,
    ).toContain("Signing in");
    expect(document.querySelector("button")!.disabled).toBe(true);
  });

  it("Skeleton announces politely with a label", () => {
    const markup = renderToStaticMarkup(
      <Skeleton count={3} announce="Loading payments" />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Loading payments");
  });
});

/* --------------------------- web surfaces ---------------------------- */

const INSTANCE_RECORD = {
  instanceId: asConnectedCapabilityInstanceId("inst_pay_1"),
  providerId: "stripe",
  connectedAt: "2026-10-02T12:00:00Z",
  state: "ACTIVE" as const,
};

describe("honest states: the Pay journey", () => {
  it("EMPTY — no connected instances renders the honest empty, never a fabricated list", () => {
    const journey = beginPayJourney({
      request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
      connectedInstances: [],
      routabilityChecks: [],
    });
    const markup = renderToStaticMarkup(
      <PayJourneyView journey={journey} onAction={() => undefined} />,
    );
    expect(markup).toContain("No connected capability");
    expect(markup).toContain("honest empty state");
    expect(markup).toContain('href="/app/capabilities"');
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("ps-state--danger");
  });

  it("UNKNOWN — RECONCILING renders reconciliation, never failure styling or alert semantics", () => {
    const selected = selectPayCapability(
      beginPayJourney({
        request: { amount: { currency: "GHS", minorUnits: "1050" }, recipient: "dest_1" },
        connectedInstances: [INSTANCE_RECORD],
        routabilityChecks: [
          { instanceId: INSTANCE_RECORD.instanceId, currency: "GHS", routable: true },
        ],
      }),
      INSTANCE_RECORD.instanceId,
      [],
    );
    const submitted = applyPaymentSubmissionResponse(selected, {
      kind: "success",
      status: 200,
      envelope: {
        data: { intent: { id: "intent_pay_1" } },
        meta: { schemaVersion: "v1", requestId: "req_pay_1" },
      },
    });
    const reconciling = applyPayOutcome(submitted, "OUTCOME_UNKNOWN", [
      asEvidenceArtifactRef("ev_ambiguity_1"),
    ]);
    expect(reconciling.stateName).toBe("RECONCILING");

    const markup = renderToStaticMarkup(
      <PayJourneyView journey={reconciling} onAction={() => undefined} />,
    );
    expect(markup).toContain("Reconciling — outcome unknown");
    expect(markup).toContain("ps-state--unknown");
    expect(markup).not.toContain("ps-state--danger");
    expect(markup).toContain('role="status"');
    // The pill tone is unknown, not failed.
    expect(markup).toContain("ps-pill--unknown");
    // Evidence continuity, not a blind retry (INV-X02).
    expect(markup).toContain("View the evidence recorded so far");
  });
});

describe("honest states: the Command Center surfaces", () => {
  it("ERROR — CcErrorRetry renders ErrorState whose retry re-runs the server render", () => {
    render(
      <CcErrorRetry
        title="Could not load the section"
        description="The API answered unexpectedly."
      />,
    );
    expect(document.querySelector(".ps-state--danger")).toBeTruthy();
    expect(
      screen.getByText(/API answered unexpectedly/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(routerState.refreshes).toBe(1);
  });

  it("EMPTY — the inbox renders the honest empty snapshot", () => {
    const markup = renderToStaticMarkup(
      <CcInboxFeed
        snapshot={emptySnapshot({
          principal: "user:owner@example.test",
          roleLabels: ["Merchant"],
          agentRefs: [],
        })}
        nowMs={1_800_000_000_000}
      />,
    );
    expect(markup).toContain("No activity yet");
    expect(markup).toContain("nothing is back-filled, nothing is simulated");
    expect(markup).toContain('role="status"');
  });

  it("NOT-YET — sections without a live surface say so honestly", () => {
    const markup = renderToStaticMarkup(
      <CcSectionNotYetAvailable navItemId="billing" />,
    );
    expect(markup).toContain("Not yet live in this deployment");
    expect(markup).toContain("Nothing here is simulated");
    expect(markup).toContain('role="status"');
  });

  it("AUTH-REQUIRED — the gate states the truth with zero credential capture", async () => {
    const session = await resolveCcSession();
    const state = deriveCcRenderState(session, null);
    const markup = renderToStaticMarkup(
      <CcAuthGate navItemId="payments" state={state} />,
    );
    expect(markup).toContain("authentication required");
    expect(markup).toContain("not yet wired in this deployment");
    expect(markup).toContain("Only real, verified state is rendered here");
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain('type="email"');
    expect(markup).not.toMatch(/\$\s?\d/);
  });

  it("NOT-CONFIGURED — the identity plane names env vars only, never values", () => {
    const markup = renderToStaticMarkup(
      <IdentityPlaneNotConfiguredState
        missingEnvVars={["WEB_APP_SEED_USERS", "WEB_APP_SESSION_SIGNING_KEY"]}
        detail="The identity plane is not configured."
      />,
    );
    expect(markup).toContain("Sign-in is not configured in this deployment");
    expect(markup).toContain("WEB_APP_SEED_USERS");
    expect(markup).toContain("WEB_APP_SESSION_SIGNING_KEY");
    expect(markup).toContain("no demo mode, no sample identity");
    expect(markup).toContain('href="/"');
  });

  it("UNKNOWN — the authorization surface not-bound state is reconciliation, not failure", () => {
    const markup = renderToStaticMarkup(
      <AuthorizationSurfaceNotBoundState honestState="The broker is not yet bound." />,
    );
    expect(markup).toContain("ps-state--unknown");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("not yet bound");
    expect(markup).not.toContain("ps-state--danger");
  });

  it("404 — both not-found surfaces state the truth and link onward", () => {
    const root = renderToStaticMarkup(<NotFoundRoot />);
    expect(root).toContain("Page not found");
    expect(root).toContain('href="/"');

    const app = renderToStaticMarkup(<NotFoundApp />);
    expect(app).toContain("Unrecognized Command Center path");
    expect(app).toContain("deep links never 404 here");
    expect(app).toContain('href="/app"');
    expect(app).toContain('href="/app/settings"');
  });
});
