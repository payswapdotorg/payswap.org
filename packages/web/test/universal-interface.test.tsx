/**
 * Universal interface tests (P4-W4-002 §4): surface integration, journey
 * honesty, state-machine coverage and adversarial scans for the universal
 * layer — outcome actions, eleven-area IA, palette extension, mode
 * indicators, the convert/checkout honest states, and the no-fake-success
 * law (UNKNOWN never renders as failure or success; undispatchable never
 * renders as ready).
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { deriveNavigationForRole, PRODUCT_NAVIGATION, PRODUCT_ROLES } from "@payswap/ux";
import {
  OUTCOME_REGISTRY,
  SURFACE_API_VERSION,
  UNIVERSAL_AREAS,
  outcomeCapabilityBoard,
} from "@payswap/surface";
import type { GateDecision } from "@payswap/onchain-security";

import { deriveUniversalAreaViews, resolveUniversalAreaRoute } from "../src/lib/universal/areas";
import { deriveUniversalPalette } from "../src/lib/universal/palette";
import { ModeIndicator } from "../src/components/universal/mode-indicator";
import { OutcomeLauncher } from "../src/components/universal/outcome-launcher";
import { SecurityGateView } from "../src/components/universal/security-gate-view";
import { ConvertJourneySurface } from "../src/components/universal/convert-surface";
import { CheckoutJourneySurface } from "../src/components/universal/checkout-surface";

const NOTHING_BOUND = {
  apiRuntimeConfigured: false,
  merchantCheckoutContextBound: false,
  routeCompilationInputsAvailable: false,
};

/* ---------------------- the surface integration ----------------------- */

describe("the web consumes the surface contracts (§3.6)", () => {
  it("renders the five outcome actions from the versioned registry", () => {
    expect(OUTCOME_REGISTRY.map((action) => action.id)).toEqual([
      "pay",
      "receive",
      "move",
      "convert",
      "checkout",
    ]);
    expect(SURFACE_API_VERSION).toBe("1.0.0");
  });

  it("renders the eleven areas with research citations", () => {
    expect(UNIVERSAL_AREAS).toHaveLength(11);
    expect(UNIVERSAL_AREAS.every((area) => area.researchCitations.length > 0)).toBe(true);
  });
});

/* --------------------------- the area binding -------------------------- */

describe("universal area binding (§3.2)", () => {
  it("every area resolves to its route; outcome routes resolve too", () => {
    for (const area of UNIVERSAL_AREAS) {
      expect(resolveUniversalAreaRoute(area.route)).toBe(area.route);
    }
    expect(resolveUniversalAreaRoute("/app/convert")).toBe("/app/convert");
    expect(resolveUniversalAreaRoute("/app/checkout")).toBe("/app/checkout");
    expect(resolveUniversalAreaRoute("/app/payments")).toBe("/app/payments");
    expect(resolveUniversalAreaRoute("/app/unknown-thing")).toBeNull();
  });

  it("visibility follows the certified role derivation for every role", () => {
    for (const role of PRODUCT_ROLES) {
      const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, role);
      const views = deriveUniversalAreaViews(nav);
      expect(views).toHaveLength(11);
      const opportunities = views.find((view) => view.area.id === "opportunities");
      const certifiedVisible = nav.items.some((view) => view.item.id === "opportunities");
      expect(opportunities?.visible).toBe(certifiedVisible);
    }
  });

  it("the merchant derivation keeps the certified exclusion law (Opportunities/Developers hidden)", () => {
    const nav = deriveNavigationForRole(PRODUCT_NAVIGATION, "merchant");
    const views = deriveUniversalAreaViews(nav);
    const ids = views.filter((view) => view.visible).map((view) => view.area.id);
    expect(ids).not.toContain("opportunities");
    expect(ids).not.toContain("developers");
    expect(ids).toContain("accounts");
    expect(ids).toContain("connections");
    expect(ids).toContain("security");
    expect(ids).toContain("reports");
  });
});

/* -------------------------- the palette extension ----------------------- */

describe("universal palette (§3.3)", () => {
  it("adds the five outcome actions with real routes (no placeholder commands)", () => {
    const palette = deriveUniversalPalette("merchant");
    const outcomeIds = palette.actions
      .filter((action) => action.id.startsWith("universal-action-"))
      .map((action) => action.id);
    expect(outcomeIds).toEqual([
      "universal-action-pay",
      "universal-action-receive",
      "universal-action-move",
      "universal-action-convert",
      "universal-action-checkout",
    ]);
    for (const action of palette.actions) {
      expect(action.href.startsWith("/app") || action.href === "/connect").toBe(true);
    }
  });

  it("go-to carries the visible universal areas for the role", () => {
    const palette = deriveUniversalPalette("merchant");
    const areaLabels = palette.goTo
      .filter((command) => command.id.startsWith("universal-goto-"))
      .map((command) => command.id.replace("universal-goto-", ""));
    expect(areaLabels).toContain("accounts");
    expect(areaLabels).toContain("security");
    expect(areaLabels).not.toContain("opportunities"); // merchant exclusion law
  });
});

/* --------------------- the outcome launcher honesty --------------------- */

describe("outcome launcher (§3.1)", () => {
  it("renders every action with its honest capability state — undispatchable is stated, never faked ready", () => {
    const html = renderToStaticMarkup(
      <OutcomeLauncher deployment={NOTHING_BOUND} />,
    );
    for (const { action, state } of outcomeCapabilityBoard(NOTHING_BOUND)) {
      expect(html).toContain(action.label);
      if (state.dispatchable) {
        expect(html).toContain("Ready");
      } else {
        expect(html).toContain("Not dispatchable in this deployment");
        expect(html).toContain("Why this is not dispatchable yet");
      }
    }
    expect(html).not.toMatch(/data-dispatchable="true"/);
  });

  it("with the API runtime configured, pay/receive/move render ready; convert/checkout still state their own prerequisites", () => {
    const html = renderToStaticMarkup(
      <OutcomeLauncher
        deployment={{ ...NOTHING_BOUND, apiRuntimeConfigured: true }}
      />,
    );
    expect(html).toMatch(/data-dispatchable="true"/);
    expect(html).toContain("Not dispatchable in this deployment"); // convert + checkout
  });

  it("every outcome link resolves to a real route (no dead buttons)", () => {
    const html = renderToStaticMarkup(<OutcomeLauncher deployment={NOTHING_BOUND} />);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/app/payments?start=1",
        "/app/collections?start=1",
        "/app/payouts?start=1",
        "/app/convert",
        "/app/checkout",
      ]),
    );
  });
});

/* ------------------------- the mode indicator --------------------------- */

describe("mode indicators (§3.5)", () => {
  it("test/testnet renders visibly distinct from live/mainnet", () => {
    const testnet = renderToStaticMarkup(
      <ModeIndicator testOrLive="TEST" onchain testnet />,
    );
    const mainnet = renderToStaticMarkup(
      <ModeIndicator testOrLive="LIVE" onchain testnet={false} />,
    );
    expect(testnet).toContain("TEST MODE");
    expect(testnet).toContain("TESTNET");
    expect(testnet).toContain("no real money");
    expect(mainnet).toContain("LIVE MODE");
    expect(mainnet).toContain("MAINNET");
    expect(mainnet).toContain("real money");
  });

  it("fiat-only surfaces honestly mark the network dimension not applicable", () => {
    const fiat = renderToStaticMarkup(
      <ModeIndicator testOrLive="TEST" onchain={false} testnet={false} />,
    );
    expect(fiat).not.toContain("TESTNET");
    expect(fiat).not.toContain("MAINNET");
  });
});

/* ---------------------- the security gate view --------------------------- */

describe("security gate view (§3.4)", () => {
  const unknownDecision: GateDecision = {
    decision: "UNKNOWN",
    dimensions: [
      {
        dimension: "simulation_consistency",
        code: "simulation_unavailable",
        message: "No simulation observation is available for this write.",
      },
    ],
    checks: [],
    evidenceRefs: [],
  };

  it("UNKNOWN renders as UNKNOWN — never as failure, never as success", () => {
    const html = renderToStaticMarkup(<SecurityGateView decision={unknownDecision} />);
    expect(html).toContain('data-verdict="UNKNOWN"');
    expect(html).toContain("not yet decided");
    expect(html).not.toContain("passed the security gates");
    expect(html).not.toContain("blocked");
  });

  it("BLOCK renders the human reason and the non-override statement", () => {
    const blockDecision: GateDecision = {
      decision: "BLOCK",
      reasons: [
        {
          dimension: "spender_approval",
          code: "unlimited_allowance",
          message: "unlimited USDC spending authority to an untrusted spender",
          invariantRefs: ["INV-SC02"],
        },
      ],
      checks: [],
      evidenceRefs: ["evidence:x"],
    };
    const html = renderToStaticMarkup(<SecurityGateView decision={blockDecision} />);
    expect(html).toContain('data-verdict="BLOCK"');
    expect(html).toContain("unlimited USDC spending authority");
    expect(html).toContain("no setting, agent or optimization overrides");
    expect(html).toContain("Evidence: evidence:x");
  });
});

/* -------------------- convert + checkout journeys ------------------------ */

describe("convert journey honesty (§3.1 Convert)", () => {
  it("with no lane observations, renders the honest prerequisite — never an invented route", () => {
    const html = renderToStaticMarkup(
      <ConvertJourneySurface deployment={NOTHING_BOUND} />,
    );
    expect(html).toContain("No compiled conversion to show");
    expect(html).toContain("onchain lane and venue observations");
    expect(html).not.toContain("executable route plan");
    expect(html).toContain("TEST MODE"); // mode indicator present
    expect(html).toContain("TESTNET");
  });

  it("with a real compilation, the fold renders simple + advanced disclosure", () => {
    const html = renderToStaticMarkup(
      <ConvertJourneySurface
        deployment={{ ...NOTHING_BOUND, routeCompilationInputsAvailable: true }}
        request={{ sourceCurrency: "USD", targetCurrency: "ETH", amountMinorUnits: 250000n }}
        compilation={{
          status: "ROUTES_COMPILED",
          plans: [
            {
              planId: "p1",
              shapeId: "mixed-dex-offramp",
              candidateStatus: "EXECUTABLE_CANDIDATE",
              compositionClass: "MIXED",
              isProviderNativeBaseline: false,
              legs: [{ legKind: "ONCHAIN_DEX_SWAP" }, { legKind: "OFF_RAMP_PAYOUT" }],
              ineligibilityReasons: [],
            },
            {
              planId: "p2",
              shapeId: "risky",
              candidateStatus: "INELIGIBLE_CANDIDATE",
              compositionClass: "ONCHAIN_ONLY",
              isProviderNativeBaseline: false,
              legs: [{ legKind: "ONCHAIN_BRIDGE" }],
              ineligibilityReasons: [
                { legId: "leg-1", code: "gate_block", detail: "bridge gate returned BLOCK" },
              ],
            },
          ],
          exclusions: [{ shapeId: "no-rail", reasons: ["no capability observation"] }],
        }}
      />,
    );
    expect(html).toContain("Convert 250000 (minor units) USD");
    expect(html).toContain("1 executable route plan");
    expect(html).toContain("Every plan, leg by leg");
    expect(html).toContain("ONCHAIN_DEX_SWAP → OFF_RAMP_PAYOUT");
    expect(html).toContain("bridge gate returned BLOCK");
    expect(html).toContain("never silently dropped");
  });
});

describe("checkout journey honesty (§3.1 Checkout, fiat-first)", () => {
  it("with no merchant context bound, states exactly that — never a fabricated session", () => {
    const html = renderToStaticMarkup(
      <CheckoutJourneySurface deployment={NOTHING_BOUND} />,
    );
    expect(html).toContain("No merchant checkout context is bound");
    expect(html).toContain("merchant onboarding and the crypto acceptance policy come first");
    expect(html).toContain("fiat-denominated");
    expect(html).toContain("signs EXPLICITLY");
  });

  it("renders the typed journey steps with the merchant/customer distinction", () => {
    const html = renderToStaticMarkup(
      <CheckoutJourneySurface deployment={NOTHING_BOUND} />,
    );
    expect(html).toContain("merchant/onboarding.draft");
    expect(html).toContain("checkout/session.open");
    expect(html).toContain("payment/attempt.submit");
    expect(html).toContain("settlement/route.select");
    expect(html).toContain('data-who="merchant"');
    expect(html).toContain('data-who="customer"');
  });
});

/* ------------------------------ adversarial ------------------------------ */

describe("adversarial: no fake success anywhere (§4)", () => {
  it("no money-adjacent surface renders a success state without evidence-backed dispatch", () => {
    const surfaces = [
      renderToStaticMarkup(<ConvertJourneySurface deployment={NOTHING_BOUND} />),
      renderToStaticMarkup(<CheckoutJourneySurface deployment={NOTHING_BOUND} />),
      renderToStaticMarkup(<OutcomeLauncher deployment={NOTHING_BOUND} />),
    ];
    for (const html of surfaces) {
      expect(html).not.toContain("Payment successful");
      expect(html).not.toContain("Funds sent");
      expect(html).not.toContain("data-dispatchable=\"true\"");
      expect(html).not.toMatch(/\$\s?\d/);
    }
  });

  it("every rendered internal href on the universal surfaces resolves to a real route", () => {
    const KNOWN_ROUTES = new Set([
      "/app",
      "/app/payments",
      "/app/collections",
      "/app/payouts",
      "/app/convert",
      "/app/checkout",
      "/app/accounts",
      "/app/activity",
      "/app/opportunities",
      "/app/connections",
      "/app/capabilities",
      "/app/security",
      "/app/reports",
      "/app/developers",
      "/app/settings",
      "/connect",
    ]);
    const surfaces = [
      renderToStaticMarkup(<OutcomeLauncher deployment={NOTHING_BOUND} />),
      renderToStaticMarkup(<ConvertJourneySurface deployment={NOTHING_BOUND} />),
      renderToStaticMarkup(<CheckoutJourneySurface deployment={NOTHING_BOUND} />),
    ];
    for (const html of surfaces) {
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => (match[1] ?? "").split("?")[0] ?? "");
      for (const href of hrefs) {
        expect(KNOWN_ROUTES.has(href)).toBe(true);
      }
    }
  });
});
