/**
 * POST /api/connect/[providerId]/initiate — initiate the connection
 * against the REAL PaySwap API and fold the verbatim response through the
 * W3-001 contract (P3-W1-002).
 *
 * Honest outcomes:
 * - 200 with the folded journey (the attempt record shows exactly what the
 *   API answered — including the deployed runtime's verbatim 403
 *   `auth.session_token_required`, which the UI renders as the honest
 *   "API session not yet wired in this deployment" state);
 * - 503 `api-unavailable` when the API runtime is unconfigured or
 *   unreachable (never a fabricated initiation);
 * - 401/403/404 from the gates.
 */

import { NextResponse, type NextRequest } from "next/server";

import { gateConnectRoute } from "../../_gate";
import { getConnectionPlane } from "../../../../_server/connection-plane";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ providerId: string }> },
): Promise<NextResponse> {
  const gate = await gateConnectRoute(request, { requireCsrf: true });
  if (!gate.ok) {
    return gate.response;
  }
  const { providerId } = await context.params;
  if (providerId.length === 0 || providerId.length > 64) {
    return NextResponse.json(
      { status: "error", message: "Expected a providerId." },
      { status: 400 },
    );
  }
  const result = await getConnectionPlane().initiateConnection(
    gate.context.principal.principalRef,
    providerId,
    gate.context.principal,
  );
  switch (result.status) {
    case "ok":
      return NextResponse.json({ status: "ok", journey: result.journey });
    case "not-found":
      return NextResponse.json(
        {
          status: "not-found",
          message:
            "No connection journey is in the initiating state for this provider — choose the provider first (the catalogue never authorizes).",
        },
        { status: 404 },
      );
    case "illegal":
      return NextResponse.json({ status: "illegal", message: result.message }, { status: 400 });
    case "api-unavailable":
      return NextResponse.json(
        {
          status: "api-unavailable",
          reason: result.reason,
          message: result.message,
          journey: result.journey,
        },
        { status: 503 },
      );
  }
}
