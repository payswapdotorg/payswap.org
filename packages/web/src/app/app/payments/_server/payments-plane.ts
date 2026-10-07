/**
 * UX-004 — the honest payments data plane (server side).
 *
 * THE LADDER (in priority order — the first rung that applies serves):
 *
 * 1. THE AUTHORITATIVE API, when the runtime is configured
 *    (NEXT_PUBLIC_PAYSWAP_API_URL) AND the viewer has a session: every read
 *    goes through the real session-aware client (`paySwapApiFetch` — the
 *    principal rides as request context) and the answer folds VERBATIM.
 *    Nothing is invented: a 200 folds only the fields the record actually
 *    carries; a 404 is the honest not-found page; any other status renders
 *    as the honest http-error state with the verbatim code. This web app
 *    holds no financial state of its own (P3-W1-001 law).
 *
 * 2. CLEARLY-MARKED TEST FIXTURES, when the deployment enables
 *    WEB_APP_TEST_PAYMENT_FIXTURES and the API rung did not apply: the
 *    fixture records (pay_test_* / link_test_*) render under the TEST
 *    environment marking — fixture data, never presented as real money.
 *
 * 3. THE HONEST EMPTY STATE otherwise: the surface states exactly what is
 *    not configured (env-var NAMES only — never values) and teaches the
 *    fill path. No fabricated records, ever.
 *
 * No raw fetch lives here (the B2 transport law): the read path is
 * `paySwapApiFetch` from @/lib/api-client, the SAME transport the rest of
 * the Command Center reads through.
 */

import type { ApiRuntimeState } from "@/lib/api";
import { apiRuntimeState } from "@/lib/api";
import { paySwapApiFetch } from "@/lib/api-client";

import type { PaymentLinkRecordView, PaymentRecordView } from "../_view/payment-view.js";
import { LINK_TEST_FIXTURES, PAY_TEST_FIXTURES } from "./test-fixtures.js";

/** The env var that opts a deployment into the clearly-marked test fixtures. */
export const TEST_FIXTURES_ENV_VAR = "WEB_APP_TEST_PAYMENT_FIXTURES" as const;

/** Everything the plane needs (injectable — tests never mutate ambient env). */
export interface PaymentsPlaneInput {
  /** The session principal (null in the marked preview — no API reads then). */
  readonly principalRef: string | null;
  /** The API runtime state (defaults to the ambient env resolution). */
  readonly apiState?: ApiRuntimeState;
  /** Whether WEB_APP_TEST_PAYMENT_FIXTURES is enabled for this deployment. */
  readonly fixturesEnabled?: boolean;
}

/** Which rung served a successful read — stated on the surface, never implied. */
export type PaymentsReadSource = "authoritative-api" | "test-fixtures";

/** The honest outcome of a payments read (never throws for expected states). */
export type PaymentsReadResult<T> =
  | { readonly status: "ok"; readonly source: PaymentsReadSource; readonly data: T }
  | { readonly status: "unconfigured" }
  | { readonly status: "preview-no-session" }
  | {
      readonly status: "http-error";
      readonly statusCode: number;
      readonly message: string;
    }
  | { readonly status: "network-error"; readonly message: string };

/** The honest outcome of a single-payment lookup (adds not-found). */
export type PaymentLookupResult =
  | PaymentsReadResult<PaymentRecordView>
  | { readonly status: "not-found" };

/** The honest outcome of a payment-link lookup. */
export type PaymentLinkLookupResult =
  | PaymentsReadResult<PaymentLinkRecordView>
  | { readonly status: "not-found" };

/** Build the plane input from the ambient environment (server pages). */
export function paymentsPlaneInput(
  principalRef: string | null,
  fixturesRawEnv: string | undefined = process.env[TEST_FIXTURES_ENV_VAR],
  apiState: ApiRuntimeState = apiRuntimeState(),
): PaymentsPlaneInput {
  return {
    principalRef,
    apiState,
    fixturesEnabled: typeof fixturesRawEnv === "string" && fixturesRawEnv.trim().length > 0,
  };
}

/** The world a lookup happened in (the not-found page names it honestly). */
export function paymentsWorldLabel(input: PaymentsPlaneInput): string {
  if (input.apiState?.configured && input.principalRef !== null) {
    return "the connected PaySwap API runtime";
  }
  if (input.fixturesEnabled) {
    return `test mode (${TEST_FIXTURES_ENV_VAR} — clearly-marked test records)`;
  }
  return "this deployment";
}

// ---------------------------------------------------------------------------
// Rung resolution
// ---------------------------------------------------------------------------

/** The API rung applies only with a configured runtime AND a real session. */
function apiRungApplies(input: PaymentsPlaneInput): boolean {
  return input.apiState !== undefined && input.apiState.configured && input.principalRef !== null;
}

// ---------------------------------------------------------------------------
// The authoritative-API fold (rung 1) — verbatim, minimal, honest
// ---------------------------------------------------------------------------

/** The intent envelope shape the API's GET /v1/intents/:id actually returns. */
interface ApiIntentEnvelope {
  readonly id?: unknown;
  readonly commandType?: unknown;
  readonly payload?: unknown;
  readonly issuedAt?: unknown;
  readonly principalRef?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fold ONE intent envelope into a payment record view — ONLY the fields the
 * record actually carries. The intent has no outcome yet: the state is
 * `processing` (never `failed` — INV-X01) with the honest detail that the
 * outcome comes from observation and evidence.
 */
export function paymentViewFromApiIntent(
  envelope: ApiIntentEnvelope,
): PaymentRecordView | null {
  const id = typeof envelope.id === "string" ? envelope.id : null;
  if (id === null) {
    return null;
  }
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  const amount = isRecord(payload.amount) ? payload.amount : {};
  const minorUnits = typeof amount.minorUnits === "string" ? amount.minorUnits : undefined;
  const currency = typeof amount.currency === "string" ? amount.currency : undefined;
  const recipient = typeof payload.recipient === "string" ? payload.recipient : undefined;
  const issuedAt = typeof envelope.issuedAt === "number" ? new Date(envelope.issuedAt).toISOString() : new Date(0).toISOString();

  const record: PaymentRecordView = {
    id,
    environment: "test",
    source: "api",
    state: "processing",
    stateDetail:
      "The API's intent record does not carry an outcome yet — outcome comes from observation and evidence, never inference.",
    createdAt: issuedAt,
    amount: {
      minorUnits: minorUnits ?? "0",
      currency: currency ?? "—",
    },
    counterparty: { name: recipient ?? "Unknown counterparty" },
    fundingRail: "manual-entry",
    events: [
      {
        id: `${id}:recorded`,
        occurredAt: issuedAt,
        sentence: "Payment intent recorded by the PaySwap API",
        actor: "PaySwap API",
        raw: {
          type: "intent.recorded",
          commandType: typeof envelope.commandType === "string" ? envelope.commandType : "unknown",
        },
      },
    ],
    refunds: [],
    receiptsSent: 0,
  };
  return record;
}

// ---------------------------------------------------------------------------
// The public reads
// ---------------------------------------------------------------------------

/**
 * The payments collection. Rung 1 reads the API's payments surface
 * (GET /v1/payments) and folds ONLY a validated list shape; today's API
 * runtime does not expose the collection, and the honest 404 state says so.
 */
export async function listPaymentsFor(
  input: PaymentsPlaneInput,
): Promise<PaymentsReadResult<readonly PaymentRecordView[]>> {
  if (apiRungApplies(input)) {
    const result = await paySwapApiFetch<{ payments?: unknown }>(
      { principalRef: input.principalRef ?? "" },
      "/v1/payments",
    );
    if (result.status === "ok") {
      const raw = result.data.payments;
      if (Array.isArray(raw)) {
        const folded: PaymentRecordView[] = [];
        for (const entry of raw) {
          if (!isRecord(entry)) {
            continue;
          }
          const view = paymentViewFromApiIntent(entry as ApiIntentEnvelope);
          if (view !== null) {
            folded.push(view);
          }
        }
        return { status: "ok", source: "authoritative-api", data: Object.freeze(folded) };
      }
      return {
        status: "http-error",
        statusCode: 200,
        message:
          "The API runtime answered the payments collection with a shape this surface cannot fold — nothing is rendered from it.",
      };
    }
    if (result.status === "http-error") {
      return {
        status: "http-error",
        statusCode: result.statusCode,
        message:
          result.statusCode === 404
            ? "The API runtime does not expose the payments collection yet (HTTP 404, answered verbatim) — no records are fabricated."
            : `The API runtime answered HTTP ${result.statusCode} for the payments collection — the verbatim answer renders, nothing is fabricated.`,
      };
    }
    if (result.status === "network-error") {
      return { status: "network-error", message: result.message };
    }
    return { status: "unconfigured" };
  }
  if (input.fixturesEnabled) {
    return { status: "ok", source: "test-fixtures", data: PAY_TEST_FIXTURES };
  }
  if (input.apiState !== undefined && input.apiState.configured && input.principalRef === null) {
    return { status: "preview-no-session" };
  }
  return { status: "unconfigured" };
}

/** One payment by id (the detail route). */
export async function paymentById(
  input: PaymentsPlaneInput,
  id: string,
): Promise<PaymentLookupResult> {
  if (apiRungApplies(input)) {
    const result = await paySwapApiFetch<{ intent?: unknown }>(
      { principalRef: input.principalRef ?? "" },
      `/v1/intents/${encodeURIComponent(id)}`,
    );
    if (result.status === "ok") {
      const envelope = result.data.intent;
      if (isRecord(envelope)) {
        const view = paymentViewFromApiIntent(envelope as ApiIntentEnvelope);
        if (view !== null) {
          return { status: "ok", source: "authoritative-api", data: view };
        }
      }
      return {
        status: "http-error",
        statusCode: 200,
        message:
          "The API answered this intent with a shape this surface cannot fold — nothing is rendered from it.",
      };
    }
    if (result.status === "http-error") {
      if (result.statusCode === 404) {
        return { status: "not-found" };
      }
      return {
        status: "http-error",
        statusCode: result.statusCode,
        message: `The API runtime answered HTTP ${result.statusCode} for this payment — the verbatim answer renders, nothing is fabricated.`,
      };
    }
    if (result.status === "network-error") {
      return { status: "network-error", message: result.message };
    }
    return { status: "unconfigured" };
  }
  if (input.fixturesEnabled) {
    const fixture = PAY_TEST_FIXTURES.find((record) => record.id === id);
    if (fixture !== undefined) {
      return { status: "ok", source: "test-fixtures", data: fixture };
    }
    return { status: "not-found" };
  }
  if (input.apiState !== undefined && input.apiState.configured && input.principalRef === null) {
    return { status: "preview-no-session" };
  }
  return { status: "unconfigured" };
}

/** One payment link by id (the W2 result route). */
export async function paymentLinkById(
  input: PaymentsPlaneInput,
  id: string,
): Promise<PaymentLinkLookupResult> {
  // The authoritative API exposes no link records yet: the honest answer for
  // the API rung is the not-yet-exposed state (never a fabricated link).
  if (apiRungApplies(input)) {
    return {
      status: "http-error",
      statusCode: 404,
      message:
        "The API runtime does not expose payment-link records yet — no link is fabricated. Links appear here the moment the authoritative surface ships.",
    };
  }
  if (input.fixturesEnabled) {
    const fixture = LINK_TEST_FIXTURES.find((link) => link.id === id);
    if (fixture !== undefined) {
      return { status: "ok", source: "test-fixtures", data: fixture };
    }
    return { status: "not-found" };
  }
  if (input.apiState !== undefined && input.apiState.configured && input.principalRef === null) {
    return { status: "preview-no-session" };
  }
  return { status: "unconfigured" };
}
