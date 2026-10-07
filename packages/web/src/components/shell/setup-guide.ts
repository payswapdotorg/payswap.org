/**
 * The shell setup guide (UX-003, contracts 01 §7 / 03 §2.10 / workflow
 * contract 04 W6): the sidebar-footer checklist — verify account → secure
 * wallet → activate first rail → create profile. Exactly ONE "Next:" step
 * is named and linked; the checklist is collapsible; never a modal wall.
 *
 * Honesty law: every step's `done` flag derives from REAL deployment state
 * (the session plane and the connection plane) — the widget never
 * fabricates progress or completion. Steps whose state no plane observes
 * yet (wallet security, merchant profile) honestly render not-done.
 */

import type { SetupGuideStep } from "@payswap/design";

/** The honest inputs the setup steps derive from (server-resolved facts). */
export interface SetupGuideFacts {
  /** True when the session plane resolved an authenticated session. */
  readonly accountVerified: boolean;
  /** The number of ACTIVE connected-instance records (rails activated). */
  readonly activeRails: number;
}

/** Where each step's activation lives (real routes only). */
const SETUP_STEP_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  "verify-account": "/signin",
  "secure-wallet": "/connect",
  "activate-rail": "/connect",
  "create-profile": "/app/settings",
});

/** The step ids in W6 order (verify account → secure wallet → activate rail → create profile). */
export const SETUP_STEP_IDS = [
  "verify-account",
  "secure-wallet",
  "activate-rail",
  "create-profile",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/**
 * Derive the setup steps from the honest facts. Only planes that observe
 * state can mark a step done: the session plane verifies the account; the
 * connection plane activates rails. Wallet security and the merchant
 * profile have no observing plane yet — they render not-done until one
 * ships (never a fabricated ✓).
 */
export function deriveSetupSteps(facts: SetupGuideFacts): readonly SetupGuideStep[] {
  return [
    {
      id: "verify-account",
      label: "Verify your account",
      done: facts.accountVerified,
    },
    {
      id: "secure-wallet",
      label: "Secure your wallet",
      done: false,
    },
    {
      id: "activate-rail",
      label: "Activate your first rail",
      done: facts.activeRails > 0,
    },
    {
      id: "create-profile",
      label: "Create your merchant profile",
      done: false,
    },
  ];
}

/** The activation route for one setup step (the shell wires navigation). */
export function setupStepRoute(stepId: string): string {
  const route = SETUP_STEP_ROUTES[stepId];
  if (route === undefined) {
    throw new Error(`unknown setup step: ${stepId}`);
  }
  return route;
}
