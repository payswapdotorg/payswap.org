/**
 * @payswap/route-compiler — the route-leg contracts (Work Order
 * P4-W4-001, task-packet hard requirement 1).
 *
 * EVERY leg of EVERY route plan carries the full chain of custody for:
 *
 * - AUTHORITY — an AuthorizationLineage: the intent's authorization
 *   artifact reference (the lineage root) plus the leg's OWN authorization
 *   evidence, which is always a REAL kernel/policy verdict (an onchain gate
 *   decision bound to a content-addressed prepared write; the connectors
 *   payout gate report bound to a transfer-out authorization; an acceptance
 *   policy verdict; or provider-verified Stripe crypto-settlement
 *   eligibility evidence). No leg is ever authorized by prose.
 *
 * - STATE — a LegStateGrounding: the observations the leg is grounded in
 *   (kernel observation ids), each re-checked for freshness at the compile
 *   instant with the REAL kernel freshness probes. A leg grounded in stale
 *   or missing observations is not executable and says so honestly
 *   (INV-C01/C02 discipline: never success, never failure — a stated
 *   reason).
 *
 * - FINALITY — a LegFinalityContract: finality candidates ONLY, never an
 *   assumption of finality (INV-F06; rule 29: submitted ≠ final). Onchain
 *   candidates carry the chain finality model; fiat and Stripe candidates
 *   are PROVIDER_OWNED — finality belongs to the provider's settlement
 *   state machine, observed as provider state, never minted locally.
 *
 * - EVIDENCE — non-empty evidenceRefs on every custody transfer, every
 *   authorization verdict and every leg (INV-E02: an external effect
 *   without linked evidence is not evidence).
 *
 * - CUSTODY — an explicit, evidenced CustodyTransfer per hop. Nothing
 *   implicitly holds funds (the observations-never-custody law extended to
 *   route compilation, INV-C09): every party that touches the value is
 *   named, and consecutive legs must custody-CHAIN (leg N's `to` is leg
 *   N+1's `from`) so value never appears or disappears silently.
 *
 * - FAILURE — a LegFailureSemantics, structurally identical for every leg
 *   kind: UNKNOWN is not FAILED (INV-X01), blind retry is forbidden
 *   (INV-X02) and settlement reconciliation is the only resolver
 *   (INV-X03). A failed leg never corrupts the honest state of the rest of
 *   the route.
 *
 * Planned amounts are quote/conversion/intent-grounded estimates with their
 * grounding basis recorded — the compiler NEVER invents an FX rate and
 * never re-declares the intent amount where an observation must speak.
 */

import { ValidationError } from "@payswap/protocol";
import type { AmountSpec } from "@payswap/trust";
import { validateAmountSpec } from "@payswap/trust";
import type { GateDecision } from "@payswap/onchain-security";
import type { PayoutGateReport } from "@payswap/connectors";
import type { ChainFinalityModel } from "@payswap/onchain-domain";

/** Raised when a leg contract is violated (fail closed, never guessed). */
export class InvalidRouteLegContractError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRouteLegContractError";
  }
}

// ---------------------------------------------------------------------------
// Custody (the no-hidden-custody law)
// ---------------------------------------------------------------------------

/** A named party that can hold the value at one point of the route. */
export type CustodyParty =
  | {
      readonly kind: "ONCHAIN_WALLET";
      readonly accountRef: string;
      readonly chainKey?: string;
    }
  | {
      readonly kind: "EXTERNAL_PROVIDER";
      readonly providerName: string;
      readonly accountRef?: string;
    }
  | {
      readonly kind: "EXTERNAL_BANK_INSTRUMENT";
      readonly externalRef: string;
    }
  | {
      readonly kind: "ONCHAIN_PROTOCOL";
      readonly protocolKey: string;
      readonly chainKey: string;
    }
  | {
      readonly kind: "STRIPE_MERCHANT_BALANCE";
      readonly stripeAccountRef: string;
    };

/** The explicit custody transfer of one hop: who gives up value, who receives it, what, how much, on what evidence. */
export interface CustodyTransfer {
  readonly from: CustodyParty;
  readonly to: CustodyParty;
  /** The protocol/venue that effects the hop (the DEX router, bridge contract, PSP). */
  readonly via?: CustodyParty;
  /** What is held after the hop (asset id or currency code). */
  readonly assetRef: string;
  readonly amount: AmountSpec;
  readonly evidenceRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Authorization lineage (the authority chain of custody)
// ---------------------------------------------------------------------------

/** The leg's own authorization evidence — always a real kernel/policy verdict. */
export type LegAuthorizationEvidence =
  | {
      readonly kind: "ONCHAIN_GATE_DECISION";
      /** The deterministic kernel gate verdict (ALLOW — or an honest BLOCK/UNKNOWN verdict on ineligible candidates). */
      readonly gateDecision: GateDecision;
      /** The content digest of the kernel-prepared write the gate evaluated. */
      readonly writeDigest: string;
      readonly routeRef: string;
      readonly routeHash: string;
    }
  | {
      readonly kind: "PAYOUT_TRANSFER_OUT_GRANT";
      /** The REAL connectors payout gate report (connection scope alone never passes). */
      readonly gate: PayoutGateReport;
      readonly transferOutAuthorizationId: string;
    }
  | {
      readonly kind: "ACCEPTANCE_POLICY_VERDICT";
      readonly policyId: string;
      readonly accepted: boolean;
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "PROVIDER_VERIFIED_STRIPE_ELIGIBILITY";
      /** The provider-verified eligibility evidence id (the provider-verified-effects law). */
      readonly evidenceId: string;
      readonly awaitingAuthority: "P4-W1-003";
    }
  | {
      /**
       * The leg executes under the intent's own authorization artifact: no
       * additional kernel gate/policy verdict applies at this hop (e.g. a
       * fiat collect hop whose payer authorization IS the intent artifact,
       * or a bank arrival hop that is the evidenced consequence of an
       * already-authorized payout). The reason is recorded honestly.
       */
      readonly kind: "INTENT_AUTHORIZATION_ONLY";
      readonly reason: string;
    };

/** The authority lineage every leg references: the intent's authorization root + the leg's own verdict. */
export interface AuthorizationLineage {
  /** The intent this leg executes (referenced — never re-declared). */
  readonly intentRef: string;
  /** The intent's authorization artifact reference (opaque lineage root). */
  readonly intentAuthorizationRef: string;
  readonly legAuthorization: LegAuthorizationEvidence;
}

// ---------------------------------------------------------------------------
// State grounding (the observation law)
// ---------------------------------------------------------------------------

/** One observation a leg is grounded in, with its compile-time freshness verdict. */
export interface GroundedObservation {
  /** The kernel observation vocabulary kind (AssetObservation, CapabilityObservation, VenueQuote, …). */
  readonly observationKind: string;
  readonly observationId: string;
  /** Fresh at the compile instant per the REAL kernel freshness probe (false is honest, never silent). */
  readonly fresh: boolean;
  /** How staleness was judged — the kernel probe or policy applied. */
  readonly freshnessRule: string;
}

export interface LegStateGrounding {
  readonly observations: readonly GroundedObservation[];
  /** Honest grounding failures: a leg with failures is not executable and says why (INV-C01/C02). */
  readonly groundingFailures: readonly string[];
}

// ---------------------------------------------------------------------------
// Finality (candidates only — never assumed)
// ---------------------------------------------------------------------------

export type LegFinalityCandidate =
  | {
      readonly candidateOnly: true;
      readonly model: ChainFinalityModel;
      readonly confirmationDepth?: number;
    }
  | {
      readonly candidateOnly: true;
      readonly model: "PROVIDER_OWNED";
      readonly providerName: string;
    };

export interface LegFinalityContract {
  /** Structural law: a route plan NEVER assumes finality (INV-F06, rule 29). */
  readonly finalityNeverAssumed: true;
  /** Candidates observed so far — possibly empty before execution. */
  readonly candidates: readonly LegFinalityCandidate[];
}

// ---------------------------------------------------------------------------
// Failure semantics (identical for every leg kind)
// ---------------------------------------------------------------------------

export interface LegFailureSemantics {
  /** INV-X01: UNKNOWN is an honest terminal state, never coerced to FAILED. */
  readonly unknownIsNotFailed: true;
  /** INV-X02: blind retry is structurally forbidden. */
  readonly blindRetryForbidden: true;
  /** INV-X03: settlement reconciliation is the only resolver. */
  readonly resolver: "SETTLEMENT_RECONCILIATION_AUTHORITY";
}

/** The frozen failure-semantics contract shared by every leg (structural, not per-leg configuration). */
export const ROUTE_LEG_FAILURE_SEMANTICS: Readonly<LegFailureSemantics> = Object.freeze({
  unknownIsNotFailed: true,
  blindRetryForbidden: true,
  resolver: "SETTLEMENT_RECONCILIATION_AUTHORITY",
});

// ---------------------------------------------------------------------------
// Planned amounts (grounded estimates — never fabricated FX)
// ---------------------------------------------------------------------------

export type PlannedLegAmount =
  | { readonly basis: "INTENT_DECLARED"; readonly amount: AmountSpec }
  | { readonly basis: "QUOTE_GROUNDED"; readonly amount: AmountSpec; readonly quoteId: string }
  | {
      readonly basis: "CONVERSION_GROUNDED";
      readonly amount: AmountSpec;
      readonly ruleId: string;
    }
  | { readonly basis: "UNKNOWN"; readonly reason: string };

// ---------------------------------------------------------------------------
// Contract validation (fail closed)
// ---------------------------------------------------------------------------

function validateCustodyParty(party: unknown, field: string): CustodyParty {
  if (party === null || typeof party !== "object") {
    throw new InvalidRouteLegContractError(`custody ${field} is required (no implicit custody)`);
  }
  const record = party as Readonly<Record<string, unknown>>;
  const kind = record["kind"];
  if (kind === "ONCHAIN_WALLET") {
    if (typeof record["accountRef"] !== "string" || record["accountRef"].length === 0) {
      throw new InvalidRouteLegContractError(`custody ${field}.accountRef must be non-empty`);
    }
    return Object.freeze({
      kind: "ONCHAIN_WALLET" as const,
      accountRef: record["accountRef"],
      ...(typeof record["chainKey"] === "string" ? { chainKey: record["chainKey"] } : {}),
    });
  }
  if (kind === "EXTERNAL_PROVIDER") {
    if (typeof record["providerName"] !== "string" || record["providerName"].length === 0) {
      throw new InvalidRouteLegContractError(`custody ${field}.providerName must be non-empty`);
    }
    return Object.freeze({
      kind: "EXTERNAL_PROVIDER" as const,
      providerName: record["providerName"],
      ...(typeof record["accountRef"] === "string" ? { accountRef: record["accountRef"] } : {}),
    });
  }
  if (kind === "EXTERNAL_BANK_INSTRUMENT") {
    if (typeof record["externalRef"] !== "string" || record["externalRef"].length === 0) {
      throw new InvalidRouteLegContractError(`custody ${field}.externalRef must be non-empty`);
    }
    return Object.freeze({
      kind: "EXTERNAL_BANK_INSTRUMENT" as const,
      externalRef: record["externalRef"],
    });
  }
  if (kind === "ONCHAIN_PROTOCOL") {
    if (
      typeof record["protocolKey"] !== "string" ||
      record["protocolKey"].length === 0 ||
      typeof record["chainKey"] !== "string" ||
      record["chainKey"].length === 0
    ) {
      throw new InvalidRouteLegContractError(
        `custody ${field} (ONCHAIN_PROTOCOL) requires protocolKey and chainKey`,
      );
    }
    return Object.freeze({
      kind: "ONCHAIN_PROTOCOL" as const,
      protocolKey: record["protocolKey"],
      chainKey: record["chainKey"],
    });
  }
  if (kind === "STRIPE_MERCHANT_BALANCE") {
    if (
      typeof record["stripeAccountRef"] !== "string" ||
      record["stripeAccountRef"].length === 0
    ) {
      throw new InvalidRouteLegContractError(
        `custody ${field}.stripeAccountRef must be non-empty`,
      );
    }
    return Object.freeze({
      kind: "STRIPE_MERCHANT_BALANCE" as const,
      stripeAccountRef: record["stripeAccountRef"],
    });
  }
  throw new InvalidRouteLegContractError(
    `custody ${field}.kind must name an explicit custody party (got: ${String(kind)}) — hidden custody is structurally unrepresentable`,
  );
}

/** Fail-closed validation of a custody transfer (explicit + evidenced, INV-C09/INV-E02). */
export function validateCustodyTransfer(candidate: unknown): CustodyTransfer {
  if (candidate === null || typeof candidate !== "object") {
    throw new InvalidRouteLegContractError(
      "a custody transfer is required for every hop — value never moves implicitly",
    );
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const from = validateCustodyParty(record["from"], "from");
  const to = validateCustodyParty(record["to"], "to");
  const via =
    record["via"] === undefined ? undefined : validateCustodyParty(record["via"], "via");
  if (typeof record["assetRef"] !== "string" || record["assetRef"].length === 0) {
    throw new InvalidRouteLegContractError("custody transfer assetRef must be non-empty");
  }
  try {
    validateAmountSpec(record["amount"] as AmountSpec);
  } catch {
    throw new InvalidRouteLegContractError(
      "custody transfer amount must be a canonical exact-integer AmountSpec (INV-F01)",
    );
  }
  const evidenceRefs = record["evidenceRefs"];
  if (
    !Array.isArray(evidenceRefs) ||
    evidenceRefs.length === 0 ||
    evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)
  ) {
    throw new InvalidRouteLegContractError(
      "custody transfer requires non-empty evidenceRefs — an unevidenced custody change is not evidence (INV-E02)",
    );
  }
  return Object.freeze({
    from,
    to,
    ...(via !== undefined ? { via } : {}),
    assetRef: record["assetRef"] as string,
    amount: record["amount"] as AmountSpec,
    evidenceRefs: Object.freeze([...(evidenceRefs as readonly string[])]),
  });
}

/**
 * The custody-CHAIN law: consecutive legs must hand value over without gaps
 * — leg N's `to` party must be leg N+1's `from` party (same kind + same
 * identifying reference). Throws on any gap: hidden custody — value sitting
 * somewhere unnamed between hops — is structurally unrepresentable.
 */
export function assertCustodyContinuity(
  custodies: readonly CustodyTransfer[],
): void {
  for (let index = 0; index + 1 < custodies.length; index += 1) {
    const current = custodies[index]!;
    const next = custodies[index + 1]!;
    if (!sameCustodyParty(current.to, next.from)) {
      throw new InvalidRouteLegContractError(
        `custody continuity broken between hop ${index} and hop ${index + 1}: value arrives at '${describeCustodyParty(
          current.to,
        )}' but the next hop starts from '${describeCustodyParty(next.from)}' — nothing may implicitly hold funds (INV-C09)`,
      );
    }
  }
}

function sameCustodyParty(a: CustodyParty, b: CustodyParty): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "ONCHAIN_WALLET":
      return a.accountRef === (b as typeof a).accountRef;
    case "EXTERNAL_PROVIDER":
      return a.providerName === (b as typeof a).providerName;
    case "EXTERNAL_BANK_INSTRUMENT":
      return a.externalRef === (b as typeof a).externalRef;
    case "ONCHAIN_PROTOCOL":
      return (
        a.protocolKey === (b as typeof a).protocolKey &&
        a.chainKey === (b as typeof a).chainKey
      );
    case "STRIPE_MERCHANT_BALANCE":
      return a.stripeAccountRef === (b as typeof a).stripeAccountRef;
  }
}

function describeCustodyParty(party: CustodyParty): string {
  switch (party.kind) {
    case "ONCHAIN_WALLET":
      return `wallet:${party.accountRef}`;
    case "EXTERNAL_PROVIDER":
      return `provider:${party.providerName}`;
    case "EXTERNAL_BANK_INSTRUMENT":
      return `bank:${party.externalRef}`;
    case "ONCHAIN_PROTOCOL":
      return `protocol:${party.protocolKey}@${party.chainKey}`;
    case "STRIPE_MERCHANT_BALANCE":
      return `stripe-balance:${party.stripeAccountRef}`;
  }
}
