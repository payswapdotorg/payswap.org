/**
 * @payswap/surface — the five outcome-level actions (P4-W4-002 §3.1).
 *
 * The PRIMARY surface of the universal interface: Pay, Receive, Move,
 * Convert, Checkout. Each entry records WHERE its journey actually
 * executes — the REAL dispatch authority, never a UI-side imitation — and
 * the honest dispatchability state for a deployment that has none of the
 * required authority configured. This registry is DATA: the web renders
 * it; an extension or mobile app renders the same facts.
 */

import { surfaceProvenance, type SurfaceContractProvenance } from "./version.js";

// UX-002 — the command-verb and sidebar-anchor vocabularies of the aliases
// below. These literal unions MIRROR @payswap/ux's single registries
// (COMMAND_VERBS, SIDEBAR_GROUP_SLUGS, SIDEBAR_PERSISTENT_ROW_IDS) — they are
// duplicated at the TYPE level only (a deliberate decoupling: a type-only
// import of @payswap/ux here would drag the whole ux→api→interfaces source
// graph into every downstream TypeScript program that already includes this
// package, breaking programs with vendored minimal node:crypto declarations).
// Equivalence with the single source is ENFORCED BY TEST
// (test/outcome-aliases.test.ts imports the REAL @payswap/ux registries and
// asserts every alias verb/anchor is a member) — drift fails the gate.
type CommandVerb = "pay" | "request" | "invoice" | "link" | "convert" | "withdraw";
type SidebarGroupSlug = "accept" | "bill" | "insights" | "capabilities" | "more";
type SidebarPersistentRowId = "home" | "balances" | "transactions" | "customers" | "catalog";

/** The five outcome actions — the fixed, versioned vocabulary. */
export type OutcomeActionId = "pay" | "receive" | "move" | "convert" | "checkout";

/**
 * Where an outcome action's journey REALLY executes. `dispatchPath` names
 * the authoritative transport; `commandType` is the certified API command
 * where the action dispatches through the PaySwap API runtime.
 */
export interface OutcomeDispatchAuthority {
  /** The real authority the journey runs against. */
  readonly authority:
    | "payswap-api-runtime" // the @payswap/api REST surface via /api/journeys/dispatch
    | "merchant-checkout-dispatch" // dispatchMerchantCheckoutApi (in-process, typed deps injected)
    | "route-compiler-preview"; // compileMoneyMovementRoute output, folded read-only
  /** The certified journey id whose contract the action renders. */
  readonly journeyId: string;
  /** The certified commandType dispatched for the journey's submit step. */
  readonly commandType?: string;
}

/**
 * The honest execution capability of one outcome action in ONE deployment
 * context. `dispatchable` is a FACT about configured authority, never a
 * UI mood: when false, the reason is the typed missing prerequisite and
 * the surface renders exactly that — never a dead button, never a
 * fabricated success.
 */
export interface OutcomeCapabilityState {
  readonly dispatchable: boolean;
  /**
   * The typed reason a journey cannot dispatch yet (present iff not
   * dispatchable) — rendered verbatim in people-language surfaces.
   */
  readonly missingPrerequisite?: string;
}

/** One outcome action's full surface contract. */
export interface OutcomeAction {
  readonly id: OutcomeActionId;
  readonly label: string;
  /** One-line people-language outcome description (the simple view). */
  readonly outcomeLine: string;
  /** What the advanced (drill-down) view discloses for this action. */
  readonly advancedDisclosure: readonly string[];
  readonly dispatch: OutcomeDispatchAuthority;
  /**
   * The honest capability fold for a deployment context: given whether the
   * API runtime is configured and whether a merchant checkout context is
   * bound, returns the typed dispatchability fact.
   */
  capability(
    context: OutcomeDeploymentContext,
  ): OutcomeCapabilityState;
  readonly provenance: SurfaceContractProvenance;
}

/** What a deployment actually has configured (facts, not UI state). */
export interface OutcomeDeploymentContext {
  /** NEXT_PUBLIC_PAYSWAP_API_URL resolved and the runtime reachable. */
  readonly apiRuntimeConfigured: boolean;
  /** A merchant checkout context (profile + trusted deps) is bound. */
  readonly merchantCheckoutContextBound: boolean;
  /** Onchain lane/venue observations exist for route compilation. */
  readonly routeCompilationInputsAvailable: boolean;
}

const UNCONFIGURED_API =
  "The PaySwap API runtime is not configured in this deployment — there is nothing to dispatch against yet. Set the API runtime configuration to make this journey live.";

const NO_MERCHANT_CONTEXT =
  "No merchant checkout context is bound in this deployment — merchant onboarding and the crypto acceptance policy come first; this surface refuses to fabricate a checkout session without them.";

const NO_ROUTE_INPUTS =
  "Route compilation requires onchain lane and venue observations (connected venue packs and mixed-rail lanes). None are configured in this deployment — the honest state is an empty capability observation, never an invented route.";

function payCapability(context: OutcomeDeploymentContext): OutcomeCapabilityState {
  return context.apiRuntimeConfigured
    ? { dispatchable: true }
    : { dispatchable: false, missingPrerequisite: UNCONFIGURED_API };
}

const OUTCOME_ACTIONS: readonly OutcomeAction[] = Object.freeze([
  {
    id: "pay",
    label: "Pay",
    outcomeLine: "Send money to a recipient through your connected providers.",
    advancedDisclosure: [
      "Route candidates with legs, fees and rails before any submission",
      "Security gates and UNKNOWN/risk disclosures per candidate",
      "Before/after balances as typed observations",
      "Evidence for every definitive outcome",
    ],
    dispatch: {
      authority: "payswap-api-runtime",
      journeyId: "pay",
      commandType: "payments.intent.create",
    },
    capability: payCapability,
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "receive",
    label: "Receive",
    outcomeLine: "Request money from a payer — a collect request they can fulfill.",
    advancedDisclosure: [
      "The collect request contract and its payer-visible summary",
      "Fulfillment attempts with UNKNOWN rendered as reconciliation",
      "Evidence lineage for the received payment",
    ],
    dispatch: {
      authority: "payswap-api-runtime",
      journeyId: "collect",
      commandType: "payments.collect.request",
    },
    capability: payCapability,
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "move",
    label: "Move",
    outcomeLine:
      "Move money to another account you control through the payout journey to a registered settlement destination.",
    advancedDisclosure: [
      "Settlement destination selection (registered destinations only)",
      "The payout gate report and its authorization lineage",
      "Custody chain of the movement, leg by leg",
    ],
    dispatch: {
      authority: "payswap-api-runtime",
      journeyId: "payout",
      commandType: "payouts.payout.create",
    },
    capability: payCapability,
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "convert",
    label: "Convert",
    outcomeLine:
      "Convert between currencies and assets — the compiled route plan, its legs and its honest exclusions, before anything moves.",
    advancedDisclosure: [
      "Every compiled route plan leg (rail hops, custody stops)",
      "Ineligible candidates with their typed reasons — never silently dropped",
      "Provider-native baselines emitted alongside composed plans",
      "Quote freshness and execution-mode facts",
    ],
    dispatch: {
      authority: "route-compiler-preview",
      journeyId: "convert",
    },
    capability(context: OutcomeDeploymentContext): OutcomeCapabilityState {
      return context.routeCompilationInputsAvailable
        ? { dispatchable: true }
        : { dispatchable: false, missingPrerequisite: NO_ROUTE_INPUTS };
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
  {
    id: "checkout",
    label: "Checkout",
    outcomeLine:
      "The merchant checkout journey: fiat-first pricing with the explicit crypto acceptance layer and customer explicit-signing.",
    advancedDisclosure: [
      "Merchant onboarding state (DRAFT → SUBMITTED → VERIFIED → ACTIVE)",
      "Crypto acceptance policy activation and quote observations with expiry",
      "The customer payment summary and the typed authorization diff",
      "Settlement route selection: native Stripe crypto vs external PaySwap conversion",
    ],
    dispatch: {
      authority: "merchant-checkout-dispatch",
      journeyId: "checkout",
    },
    capability(context: OutcomeDeploymentContext): OutcomeCapabilityState {
      return context.merchantCheckoutContextBound
        ? { dispatchable: true }
        : { dispatchable: false, missingPrerequisite: NO_MERCHANT_CONTEXT };
    },
    provenance: surfaceProvenance("P4-W4-002"),
  },
] as const);

/** The full registry, in the work order's fixed order. */
export const OUTCOME_REGISTRY: readonly OutcomeAction[] = OUTCOME_ACTIONS;

export function outcomeActionById(id: OutcomeActionId): OutcomeAction {
  const found = OUTCOME_ACTIONS.find((action) => action.id === id);
  if (found === undefined) {
    throw new Error(`outcomeActionById: unknown outcome action id ${JSON.stringify(id)}`);
  }
  return found;
}

/** Every outcome action's honest capability fold for one deployment. */
export function outcomeCapabilityBoard(
  context: OutcomeDeploymentContext,
): ReadonlyArray<{ readonly action: OutcomeAction; readonly state: OutcomeCapabilityState }> {
  return OUTCOME_ACTIONS.map((action) => ({
    action,
    state: action.capability(context),
  }));
}

// ---------------------------------------------------------------------------
// Outcome-action reconciliation aliases (UX-002 — contract 01 §3 + 06 §3/§4)
// ---------------------------------------------------------------------------
//
// ADDITIVE side-table: the five CERTIFIED outcome actions keep their ids,
// shapes and dispatch authorities exactly as P4-W4-002 certified them; this
// table reconciles them onto the command-grammar verbs and the object-model
// sidebar anchors so ONE interaction grammar covers both vocabularies. The
// verbs and anchors are TYPED against @payswap/ux (the single source) — no
// second verb or navigation vocabulary is created here.

/** A sidebar anchor for an outcome-action lane: a workload group or a persistent money-object row. */
export type OutcomeAliasNavAnchor = SidebarGroupSlug | SidebarPersistentRowId;

/** The reconciliation of one certified outcome action onto the command grammar + sidebar. */
export interface OutcomeActionAlias {
  readonly actionId: OutcomeActionId;
  /**
   * The command grammar verbs this action reconciles onto (contract 06 §3/§4).
   * `receive` ≈ the request lane; `move` ≈ the withdraw/convert lanes.
   */
  readonly commandVerbs: readonly CommandVerb[];
  /** Where the lane lives in the object-model sidebar (contract 01 §3). */
  readonly navAnchors: readonly OutcomeAliasNavAnchor[];
  /** Why this mapping holds (auditable, one line). */
  readonly note: string;
}

const OUTCOME_ACTION_ALIASES_TABLE: Readonly<Record<OutcomeActionId, OutcomeActionAlias>> = {
  pay: {
    actionId: "pay",
    commandVerbs: ["pay"],
    navAnchors: ["accept"],
    note: "Paying is the payments family lane: the pay verb opens the payment workflow from the Accept group.",
  },
  receive: {
    actionId: "receive",
    commandVerbs: ["request"],
    navAnchors: ["accept"],
    note: "receive ≈ the request lane (UX-002): requesting money is the `request` verb of the same payments family.",
  },
  move: {
    actionId: "move",
    commandVerbs: ["withdraw", "convert"],
    navAnchors: ["balances"],
    note: "move ≈ the withdraw/convert lanes (UX-002): withdraw routes to the Balances withdraw flow (contract 06 §3); convert moves value between balances.",
  },
  convert: {
    actionId: "convert",
    commandVerbs: ["convert"],
    navAnchors: ["balances"],
    note: "Converting is moving value between the balances you hold — anchored on the Balances object row.",
  },
  checkout: {
    actionId: "checkout",
    commandVerbs: ["link"],
    navAnchors: ["accept"],
    note: "checkout ≈ the payment-link lane: a payment link is a hosted, customer-facing checkout page (the Accept group's Checkout/links items).",
  },
};

/**
 * The outcome-action reconciliation table (UX-002): five certified actions ×
 * command verbs × sidebar anchors. ADDITIVE — the certified
 * `OUTCOME_REGISTRY`/`OutcomeActionId` shapes are untouched.
 */
export const OUTCOME_ACTION_ALIASES: Readonly<Record<OutcomeActionId, OutcomeActionAlias>> =
  OUTCOME_ACTION_ALIASES_TABLE;

/** Look up one action's reconciliation (fail-closed on unknown ids). */
export function outcomeActionAlias(id: OutcomeActionId): OutcomeActionAlias {
  const alias = OUTCOME_ACTION_ALIASES[id];
  if (alias === undefined) {
    throw new Error(`outcomeActionAlias: unknown outcome action id ${JSON.stringify(id)}`);
  }
  return alias;
}
