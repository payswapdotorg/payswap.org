/**
 * POST /api/journeys/dispatch — the ONE authenticated transport for product
 * journey mutations (P3-W3-002): pay/collect/payout submissions, the
 * reauthorization request, the reconciliation observation.
 *
 * Laws honored (the work order's "no simulated financial effect" line):
 * - the apiCommand comes from the LIVE certified journey contract on the
 *   client (the contract's own `actions[].apiCommand` — INV-F05 bodies);
 * - this route TRANSPORTS it to the authoritative PaySwap API through the
 *   REAL api client (`paySwapApiFetch` — principal context, API version
 *   header, fresh idempotency key on every POST) and returns the API's
 *   answer VERBATIM (status, envelope or error body) for the client to fold
 *   through the same W3-001 contracts — it never invents, upgrades or
 *   reinterprets a command or a response;
 * - a FROZEN allowlist (journeyId, actionId, method, path, commandType) —
 *   asserted equal to the contract's own action commands by tests — refuses
 *   anything the certified journeys do not emit;
 * - session + CSRF gated like every connect mutation; unconfigured API
 *   runtime and network failures are honest 503s, never fabricated outcomes.
 */

import { NextResponse, type NextRequest } from "next/server";

import { gateConnectRoute } from "../../connect/_gate";
import { paySwapApiFetch } from "@/lib/api-client";
import { ALLOWED_JOURNEY_COMMANDS, type AllowedJourneyCommand } from "@/lib/cc/journey-commands";

export const runtime = "nodejs";

const ALLOWED: readonly AllowedJourneyCommand[] = ALLOWED_JOURNEY_COMMANDS;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = await gateConnectRoute(request, { requireCsrf: true });
  if (!gate.ok) {
    return gate.response;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { status: "error", message: "Expected a JSON body." },
      { status: 400 },
    );
  }
  if (!isJsonObject(body)) {
    return NextResponse.json(
      { status: "error", message: "Expected a JSON object body." },
      { status: 400 },
    );
  }
  const { journeyId, actionId, apiCommand } = body as {
    journeyId?: unknown;
    actionId?: unknown;
    apiCommand?: unknown;
  };
  if (typeof journeyId !== "string" || typeof actionId !== "string" || !isJsonObject(apiCommand)) {
    return NextResponse.json(
      {
        status: "error",
        message:
          "Expected { journeyId, actionId, apiCommand: { method, path, body } } — the apiCommand comes from the certified journey contract's own action.",
      },
      { status: 400 },
    );
  }
  const allowed = ALLOWED.find(
    (entry) => entry.journeyId === journeyId && entry.actionId === actionId,
  );
  if (allowed === undefined) {
    return NextResponse.json(
      {
        status: "refused",
        message: `The journey mutation (${journeyId}/${actionId}) is not one the certified contracts emit — refused.`,
      },
      { status: 400 },
    );
  }
  const { method, path, body: commandBody } = apiCommand as {
    method?: unknown;
    path?: unknown;
    body?: unknown;
  };
  if (method !== allowed.method || path !== allowed.path || !isJsonObject(commandBody)) {
    return NextResponse.json(
      {
        status: "refused",
        message: `The submitted apiCommand does not match the certified ${allowed.journeyId}/${allowed.actionId} command (${allowed.method} ${allowed.path}).`,
      },
      { status: 400 },
    );
  }
  if (allowed.commandType !== undefined && commandBody["commandType"] !== allowed.commandType) {
    return NextResponse.json(
      {
        status: "refused",
        message: `The submitted command body does not carry the certified commandType ${allowed.commandType}.`,
      },
      { status: 400 },
    );
  }

  // Transport to the REAL authoritative PaySwap API; the answer returns
  // VERBATIM for the client's contract fold (never reinterpreted here).
  const result = await paySwapApiFetch(gate.context.principal, allowed.path, {
    method: "POST",
    body: commandBody,
  });
  switch (result.status) {
    case "ok":
      return NextResponse.json({ status: "ok", statusCode: 200, body: result.data });
    case "unconfigured":
      return NextResponse.json(
        {
          status: "api-unavailable",
          reason: "unconfigured",
          message:
            "The PaySwap API runtime is not configured in this deployment (NEXT_PUBLIC_PAYSWAP_API_URL) — there is nothing to dispatch against yet.",
        },
        { status: 503 },
      );
    case "network-error":
      return NextResponse.json(
        {
          status: "api-unavailable",
          reason: "network-error",
          message: result.message,
        },
        { status: 503 },
      );
    case "http-error":
      return NextResponse.json(
        { status: "http-error", statusCode: result.statusCode, body: result.body },
        { status: 200 },
      );
  }
}
