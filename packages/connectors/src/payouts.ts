/**
 * Global payout controls (P2-W1-002) — the generic, provider-neutral payout
 * gate on the P2-W1-001 activation control plane.
 *
 * Authority: spec/phase-2/work-items/P2-W1-002.md,
 * spec/phase-2/AUTHORIZATION-AND-CREDENTIAL-ISOLATION.md (§ Debit/withdrawal:
 * "A connected account does not imply unrestricted debit or withdrawal
 * authority. Transfer-out/debit capabilities require explicit authorization,
 * scope, limits, expiry and, where applicable, provider-native
 * confirmation/step-up.").
 *
 * LAWS implemented here:
 * - THE PAYOUT DESTINATION REMAINS EXTERNAL AND EXPLICIT: a PayoutDestination
 *   is always a provider-addressable EXTERNAL destination (beneficiary id /
 *   PayPal email or payer_id / bank details per provider) — NEVER a PaySwap
 *   account, never implicit, never free-form money movement. The type is
 *   sealed: { kind, providerDestinationRef, displayName?, country? }.
 * - CONNECTION SCOPE NEVER GRANTS TRANSFER-OUT: the gate reuses
 *   TransferOutAuthorization (activation.ts) VERBATIM — it is never
 *   redefined here — and a payout request without a live, in-currency,
 *   within-limits, unexpired grant is refused
 *   (TRANSFER_OUT_NOT_AUTHORIZED).
 * - OBSERVATION ≠ EXECUTION: PayoutObservation (read scope only) is a
 *   structurally distinct type from PayoutExecutionRequest (full gate
 *   required) — an observation can never be mistaken for, or coerced into,
 *   an execution request.
 * - INV-C09 discipline at the control-plane level: nothing in this module
 *   MOVES value; it produces machine-checkable gate reports and sealed
 *   request records. The provider-side connector layer maps payout
 *   EXECUTION to the provider only under an explicit, gated
 *   PayoutExecutionRequest (and the PayPal Direct connector deliberately
 *   implements payouts as OBSERVATION ONLY).
 * - Fail-closed: every gate check reports pass/fail with a reason;
 *   `allowed` is true only when EVERY check passes; the execution-request
 *   constructor throws on a closed gate.
 */

import { ValidationError } from "@payswap/protocol";
import type {
  ConnectedInstanceActivation,
  TransferOutAuthorization,
} from "./activation.js";
import { TransferOutNotAuthorizedError } from "./activation.js";

// ---------------------------------------------------------------------------
// The payout destination (explicit + external — never a PaySwap account)
// ---------------------------------------------------------------------------

/**
 * The kind of EXTERNAL, provider-addressable destination a payout can target.
 * Every kind names a PROVIDER-side addressing scheme — none of them can
 * address a PaySwap account (PaySwap holds no funds; INV-C09).
 */
export type PayoutDestinationKind =
  /** A provider beneficiary/payout-profile id (e.g. a PayPal payee beneficiary id). */
  | "PROVIDER_BENEFICIARY_ID"
  /** A provider account email (e.g. a PayPal receiver email). */
  | "PROVIDER_ACCOUNT_EMAIL"
  /** A provider payer/recipient id (e.g. a PayPal payer_id / encrypted account number). */
  | "PROVIDER_PAYER_ID"
  /** Provider-addressed bank account details (held at the provider as a saved instrument). */
  | "PROVIDER_BANK_INSTRUMENT"
  /** A provider-addressed wallet (e.g. a custodial stablecoin wallet id at the provider). */
  | "PROVIDER_WALLET_ADDRESS";

/** The explicit, provider-addressable, EXTERNAL payout destination (sealed). */
export interface PayoutDestination {
  readonly kind: PayoutDestinationKind;
  /**
   * The provider-side destination reference exactly as the provider
   * addresses it (beneficiary id, email, payer_id, instrument id, wallet) —
   * NEVER a PaySwap account/instance reference, never a protocol join key.
   */
  readonly providerDestinationRef: string;
  readonly displayName?: string;
  /** ISO 3166-1 alpha-2 of the destination (when the provider declares it). */
  readonly country?: string;
}

/** Internal PaySwap reference prefixes that can never be payout destinations. */
const INTERNAL_REFERENCE_PREFIXES: readonly string[] = Object.freeze([
  // Protocol join keys (INV-F05 derivations), not provider destinations:
  "payswap:",
  "payswap-long:",
  // Connected-instance / activation references, not provider destinations:
  "inst-",
  "vault://payswap/",
]);

/**
 * Validates a payout destination as EXPLICIT + EXTERNAL (fail-closed):
 * - it must be an object with a known kind and a non-empty
 *   providerDestinationRef (never undefined/implicit);
 * - the ref must NOT look like a PaySwap-internal reference (protocol join
 *   keys, connected-instance refs, vault refs are not provider destinations);
 * - nothing about the destination may reference a PaySwap account.
 */
export function validatePayoutDestination(candidate: unknown): PayoutDestination {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError(
      "a payout destination is required (explicit + external — never implicit; P2-W1-002 payout law)",
    );
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const kind = record["kind"];
  const knownKinds: readonly PayoutDestinationKind[] = [
    "PROVIDER_BENEFICIARY_ID",
    "PROVIDER_ACCOUNT_EMAIL",
    "PROVIDER_PAYER_ID",
    "PROVIDER_BANK_INSTRUMENT",
    "PROVIDER_WALLET_ADDRESS",
  ];
  if (typeof kind !== "string" || !(knownKinds as readonly string[]).includes(kind)) {
    throw new ValidationError(
      `payout destination kind must be one of [${knownKinds.join(", ")}] — a provider-addressable EXTERNAL destination (got: ${String(kind)})`,
    );
  }
  const ref = record["providerDestinationRef"];
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new ValidationError(
      "payout destination requires a non-empty providerDestinationRef (the provider-side destination exactly as the provider addresses it)",
    );
  }
  for (const prefix of INTERNAL_REFERENCE_PREFIXES) {
    if (ref.startsWith(prefix)) {
      throw new ValidationError(
        `providerDestinationRef '${ref.slice(0, 32)}…' looks like a PaySwap-internal reference (${prefix}…) — a payout destination is EXTERNAL and provider-addressable, never a PaySwap account/protocol reference`,
      );
    }
  }
  const displayName = record["displayName"];
  if (displayName !== undefined && (typeof displayName !== "string" || displayName.length === 0)) {
    throw new ValidationError("payout destination displayName, when present, must be a non-empty string");
  }
  const country = record["country"];
  if (country !== undefined && !/^[A-Za-z]{2}$/.test(String(country))) {
    throw new ValidationError(
      "payout destination country, when present, must be an ISO 3166-1 alpha-2 code",
    );
  }
  return Object.freeze({
    kind: kind as PayoutDestinationKind,
    providerDestinationRef: ref,
    ...(typeof displayName === "string" && displayName.length > 0 ? { displayName } : {}),
    ...(typeof country === "string" && /^[A-Za-z]{2}$/.test(country) ? { country: country.toUpperCase() } : {}),
  });
}

// ---------------------------------------------------------------------------
// The payout request init (what a gated execution request is built from)
// ---------------------------------------------------------------------------

/**
 * The initialization record for a payout execution request. Every field is
 * required evidence for the gate: the connector capability that would
 * execute, the transfer-out authorization artifact, the EXPLICIT external
 * destination, the exact amount, the protocol idempotency key and the
 * authorization evidence lineage.
 */
export interface PayoutRequestInit {
  /** The connector capability that would execute (e.g. cap.rails.paypal-direct.payout_observation is NOT executable — a transfer-out capability id). */
  readonly connectorCapabilityId: string;
  /** The transfer-out authorization artifact reference (≠ the connection ref). */
  readonly transferOutAuthorizationId: string;
  readonly destination: PayoutDestination;
  /** Exact minor units (INV-F01 — integer, never a float). */
  readonly amountMinor: number;
  readonly currency: string;
  /** The protocol idempotency key (INV-F05) the provider reference derives from. */
  readonly protocolKey: string;
  /** Reference to the authorization evidence backing this request. */
  readonly authorizationEvidenceRef: string;
  /** The request time — also the expiry-evaluation time for the gate. */
  readonly requestedAt: string;
  /**
   * Provider-native step-up evidence (a reference to the completed
   * provider confirmation), required when the grant sets
   * requiresProviderStepUp.
   */
  readonly providerStepUpEvidenceRef?: string;
  /** Already-drawn cumulative amount in minor units (the cumulative-limit check input). */
  readonly cumulativeDrawnMinor?: number;
}

/** Constructs and validates a payout request init (fail-closed on shape). */
export function validatePayoutRequestInit(candidate: unknown): PayoutRequestInit {
  if (candidate === null || typeof candidate !== "object") {
    throw new ValidationError("a payout request init is required");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  for (const field of [
    "connectorCapabilityId",
    "transferOutAuthorizationId",
    "destination",
    "currency",
    "protocolKey",
    "authorizationEvidenceRef",
    "requestedAt",
  ] as const) {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new ValidationError(`payout request init requires a non-empty '${field}'`);
    }
  }
  const amountMinor = record["amountMinor"];
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError(
      "payout request init requires amountMinor as a positive integer of exact minor units (INV-F01 — never a float)",
    );
  }
  const destination = validatePayoutDestination(record["destination"]);
  const stepUp = record["providerStepUpEvidenceRef"];
  if (stepUp !== undefined && (typeof stepUp !== "string" || stepUp.length === 0)) {
    throw new ValidationError(
      "providerStepUpEvidenceRef, when present, must be a non-empty reference",
    );
  }
  const cumulative = record["cumulativeDrawnMinor"];
  if (
    cumulative !== undefined &&
    (typeof cumulative !== "number" || !Number.isInteger(cumulative) || cumulative < 0)
  ) {
    throw new ValidationError(
      "cumulativeDrawnMinor, when present, must be a non-negative integer of minor units",
    );
  }
  return Object.freeze({
    connectorCapabilityId: record["connectorCapabilityId"] as string,
    transferOutAuthorizationId: record["transferOutAuthorizationId"] as string,
    destination,
    amountMinor,
    currency: (record["currency"] as string).toUpperCase(),
    protocolKey: record["protocolKey"] as string,
    authorizationEvidenceRef: record["authorizationEvidenceRef"] as string,
    requestedAt: record["requestedAt"] as string,
    ...(typeof stepUp === "string" && stepUp.length > 0 ? { providerStepUpEvidenceRef: stepUp } : {}),
    ...(typeof cumulative === "number" && Number.isInteger(cumulative) && cumulative >= 0
      ? { cumulativeDrawnMinor: cumulative }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// The payout gate (machine-checkable, fail-closed)
// ---------------------------------------------------------------------------

/** The six machine-checkable payout gates. */
export type PayoutGateName =
  | "TRANSFER_OUT_GRANT_EXISTS"
  | "TRANSFER_OUT_CURRENCY_SCOPE"
  | "TRANSFER_OUT_LIMITS"
  | "TRANSFER_OUT_NOT_EXPIRED"
  | "DESTINATION_EXPLICIT_EXTERNAL"
  | "PROVIDER_STEP_UP";

/** One gate check outcome (append-only style: every check is reported). */
export interface PayoutGateCheck {
  readonly gate: PayoutGateName;
  readonly pass: boolean;
  /** The fail-closed reason (present on failure; a short basis on pass). */
  readonly reason?: string;
}

/** The full gate report — `allowed` is true only when EVERY check passes. */
export interface PayoutGateReport {
  readonly instanceId: string;
  readonly allowed: boolean;
  readonly checks: readonly PayoutGateCheck[];
}

function payoutGateCheck(
  gate: PayoutGateName,
  pass: boolean,
  reason: string,
): PayoutGateCheck {
  return Object.freeze({ gate, pass, ...(pass ? {} : { reason }) });
}

/** The transfer-out grant of a record (TransferOutAuthorization, reused verbatim). */
export function payoutTransferOutGrant(
  record: ConnectedInstanceActivation,
): TransferOutAuthorization | undefined {
  return record.transferOut;
}

/**
 * Evaluates the FULL payout gate WITHOUT throwing: every requirement is
 * reported as a machine-checkable check. Fail-closed: `allowed` is true only
 * when EVERY check passes. The six gates:
 *
 * 1. TRANSFER_OUT_GRANT_EXISTS — a transfer-out grant exists on the record
 *    (connection scope alone NEVER passes; TRANSFER_OUT_NOT_AUTHORIZED
 *    semantics);
 * 2. TRANSFER_OUT_CURRENCY_SCOPE — request.currency ∈ grant.currencyScope;
 * 3. TRANSFER_OUT_LIMITS — amount within the grant's limits when any are
 *    set (max single; cumulative against request.cumulativeDrawnMinor);
 * 4. TRANSFER_OUT_NOT_EXPIRED — the grant is unexpired at request.requestedAt
 *    (and the record is ACTIVE);
 * 5. DESTINATION_EXPLICIT_EXTERNAL — the destination is a valid
 *    PayoutDestination (kind + providerDestinationRef; never
 *    undefined/implicit, never a PaySwap account);
 * 6. PROVIDER_STEP_UP — when the grant requires provider-native step-up,
 *    the request carries providerStepUpEvidenceRef.
 */
export function evaluatePayoutGate(
  record: ConnectedInstanceActivation,
  request: PayoutRequestInit,
): PayoutGateReport {
  const checks: PayoutGateCheck[] = [];
  const grant = record.transferOut;

  // (1) the transfer-out grant EXISTS
  if (grant === undefined) {
    checks.push(
      payoutGateCheck(
        "TRANSFER_OUT_GRANT_EXISTS",
        false,
        "TRANSFER_OUT_NOT_AUTHORIZED: no transfer-out grant on the activation record — connecting an account never grants debit/withdrawal authority (authorize a separate TransferOutAuthorization)",
      ),
    );
    // No grant: the remaining grant-scoped checks are honestly skipped
    // (reported as failures with the dependent reason, never guessed).
    checks.push(
      payoutGateCheck(
        "TRANSFER_OUT_CURRENCY_SCOPE",
        false,
        "no transfer-out grant — currency scope cannot be evaluated",
      ),
    );
    checks.push(
      payoutGateCheck(
        "TRANSFER_OUT_LIMITS",
        false,
        "no transfer-out grant — limits cannot be evaluated",
      ),
    );
    checks.push(
      payoutGateCheck(
        "TRANSFER_OUT_NOT_EXPIRED",
        false,
        "no transfer-out grant — expiry cannot be evaluated",
      ),
    );
  } else {
    checks.push(
      payoutGateCheck(
        "TRANSFER_OUT_GRANT_EXISTS",
        true,
        `transfer-out grant ${grant.authorizationRef} (granted ${grant.grantedAt})`,
      ),
    );

    // (2) currency scope
    const inScope = grant.currencyScope
      .map((code) => code.toUpperCase())
      .includes(request.currency.toUpperCase());
    checks.push(
      payoutGateCheck(
        "TRANSFER_OUT_CURRENCY_SCOPE",
        inScope,
        inScope
          ? `${request.currency} ∈ [${grant.currencyScope.join(", ")}]`
          : `TRANSFER_OUT_CURRENCY_NOT_IN_SCOPE: ${request.currency} ∉ [${grant.currencyScope.join(", ")}]`,
      ),
    );

    // (3) limits (single + cumulative when set)
    const limitFailures: string[] = [];
    if (
      grant.maxSingleAmountMinor !== undefined &&
      request.amountMinor > grant.maxSingleAmountMinor
    ) {
      limitFailures.push(
        `single payout ${request.amountMinor} exceeds maxSingleAmountMinor ${grant.maxSingleAmountMinor}`,
      );
    }
    if (grant.cumulativeLimitMinor !== undefined) {
      const drawn = request.cumulativeDrawnMinor ?? 0;
      if (drawn + request.amountMinor > grant.cumulativeLimitMinor) {
        limitFailures.push(
          `cumulative draw ${drawn} + ${request.amountMinor} exceeds cumulativeLimitMinor ${grant.cumulativeLimitMinor}`,
        );
      }
    }
    checks.push(
      payoutGateCheck(
        "TRANSFER_OUT_LIMITS",
        limitFailures.length === 0,
        limitFailures.length === 0
          ? "within the grant's limits (or none set)"
          : `TRANSFER_OUT_LIMIT_EXCEEDED: ${limitFailures.join("; ")}`,
      ),
    );

    // (4) expiry (and an ACTIVE record)
    const expired =
      grant.expiresAt !== undefined && request.requestedAt >= grant.expiresAt;
    const active = record.state === "ACTIVE";
    checks.push(
      payoutGateCheck(
        "TRANSFER_OUT_NOT_EXPIRED",
        !expired && active,
        expired
          ? `TRANSFER_OUT_EXPIRED: the grant expired at ${grant.expiresAt} (requested at ${request.requestedAt})`
          : active
            ? `unexpired at ${request.requestedAt}`
            : `TRANSFER_OUT_NOT_ACTIVE: the activation record is ${record.state} (transfer-out requires an ACTIVE connection)`,
      ),
    );
  }

  // (5) destination explicit + external
  let destinationError: string | undefined;
  try {
    validatePayoutDestination(request.destination);
  } catch (error) {
    destinationError = error instanceof Error ? error.message : String(error);
  }
  if (destinationError !== undefined) {
    checks.push(
      payoutGateCheck(
        "DESTINATION_EXPLICIT_EXTERNAL",
        false,
        `DESTINATION_NOT_EXPLICIT_EXTERNAL: ${destinationError}`,
      ),
    );
  } else {
    checks.push(
      payoutGateCheck(
        "DESTINATION_EXPLICIT_EXTERNAL",
        true,
        `${request.destination.kind} → ${request.destination.providerDestinationRef.slice(0, 24)}… (external, provider-addressable)`,
      ),
    );
  }

  // (6) provider step-up honored
  const stepUpRequired = grant?.requiresProviderStepUp === true;
  const stepUpSatisfied =
    !stepUpRequired ||
    (request.providerStepUpEvidenceRef !== undefined &&
      request.providerStepUpEvidenceRef.length > 0);
  checks.push(
    payoutGateCheck(
      "PROVIDER_STEP_UP",
      stepUpSatisfied,
      stepUpSatisfied
        ? stepUpRequired
          ? "provider step-up evidence present"
          : "no provider step-up required by the grant"
        : "TRANSFER_OUT_STEP_UP_REQUIRED: the grant requires provider-native step-up and the request carries no providerStepUpEvidenceRef",
    ),
  );

  return Object.freeze({
    instanceId: record.instanceId,
    allowed: checks.every((check) => check.pass),
    checks: Object.freeze(checks),
  });
}

// ---------------------------------------------------------------------------
// Observation ≠ execution (structurally distinct types)
// ---------------------------------------------------------------------------

/**
 * A payout OBSERVATION — read scope only. Structurally distinct from a
 * PayoutExecutionRequest: it carries no gate, no destination and no
 * execution authority; it can never be mistaken for, or coerced into, an
 * execution request. (INV-C09: observing provider-held payout state is not
 * custody and not movement.)
 */
export interface PayoutObservation {
  readonly observationKind: "PayoutObservation";
  readonly observationId: string;
  readonly observedAt: string;
  /** The provider-side payout object observed (batch/item id). */
  readonly providerPayoutRef: string;
  readonly providerName: string;
  readonly status: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK" | "OPERATOR";
  /** Read scope required to produce this observation — never execution scope. */
  readonly requiredScope: "payments:read";
}

/** Constructs a payout observation (read-scope only — no gate, no authority). */
export function payoutObservation(input: {
  readonly observationId: string;
  readonly observedAt: string;
  readonly providerPayoutRef: string;
  readonly providerName: string;
  readonly status: string;
  readonly provenanceSource: "PROVIDER_API" | "PROVIDER_WEBHOOK" | "OPERATOR";
}): PayoutObservation {
  for (const [field, value] of Object.entries(input) as readonly (readonly [
    string,
    unknown,
  ])[]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new ValidationError(`payout observation requires a non-empty '${field}'`);
    }
  }
  return Object.freeze({
    observationKind: "PayoutObservation" as const,
    observationId: input.observationId,
    observedAt: input.observedAt,
    providerPayoutRef: input.providerPayoutRef,
    providerName: input.providerName,
    status: input.status,
    provenanceSource: input.provenanceSource,
    requiredScope: "payments:read" as const,
  });
}

/**
 * A payout EXECUTION REQUEST — the full gate required. Constructed ONLY from
 * an activation record + a request init whose gate passes (fail-closed:
 * `createPayoutExecutionRequest` throws TRANSFER_OUT_NOT_AUTHORIZED on a
 * closed gate). Carries the gate report + destination + the exact
 * provider-callable instruction — nothing implicit.
 */
export interface PayoutExecutionRequest {
  readonly requestKind: "PayoutExecutionRequest";
  readonly instanceId: string;
  readonly connectorCapabilityId: string;
  readonly transferOutAuthorizationId: string;
  readonly destination: PayoutDestination;
  readonly amountMinor: number;
  readonly currency: string;
  readonly protocolKey: string;
  readonly authorizationEvidenceRef: string;
  readonly requestedAt: string;
  /** The machine-checkable gate report that authorized this request. */
  readonly gate: PayoutGateReport;
  /** Present exactly when the grant required provider-native step-up. */
  readonly providerStepUpEvidenceRef?: string;
}

/**
 * Constructs a payout EXECUTION request — the fail-closed constructor: the
 * full gate must PASS (every check), otherwise
 * TransferOutNotAuthorizedError. The sealed record carries the gate report
 * for audit; the destination is validated external+explicit; the step-up
 * evidence is embedded when the grant required it.
 */
export function createPayoutExecutionRequest(
  record: ConnectedInstanceActivation,
  request: PayoutRequestInit,
): PayoutExecutionRequest {
  const validated = validatePayoutRequestInit(request);
  const gate = evaluatePayoutGate(record, validated);
  if (!gate.allowed) {
    const failed = gate.checks.filter((check) => !check.pass);
    throw new TransferOutNotAuthorizedError(
      `payout execution refused for instance '${record.instanceId}': ${failed.length} gate check(s) failed (${failed
        .map((check) => check.gate)
        .join(", ")}) — see the gate report reasons`,
      { instanceId: record.instanceId, failedGates: failed.map((check) => check.gate) },
    );
  }
  return Object.freeze({
    requestKind: "PayoutExecutionRequest" as const,
    instanceId: record.instanceId,
    connectorCapabilityId: validated.connectorCapabilityId,
    transferOutAuthorizationId: validated.transferOutAuthorizationId,
    destination: validated.destination,
    amountMinor: validated.amountMinor,
    currency: validated.currency,
    protocolKey: validated.protocolKey,
    authorizationEvidenceRef: validated.authorizationEvidenceRef,
    requestedAt: validated.requestedAt,
    gate,
    ...(validated.providerStepUpEvidenceRef !== undefined
      ? { providerStepUpEvidenceRef: validated.providerStepUpEvidenceRef }
      : {}),
  });
}
