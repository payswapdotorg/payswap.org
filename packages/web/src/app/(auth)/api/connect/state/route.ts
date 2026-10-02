/**
 * GET /api/connect/state — the honest connection state for the session:
 * the evidence-derived catalogue (with every provider's honest status) and
 * the principal's connection journeys (serialized contract objects).
 */

import { NextResponse, type NextRequest } from "next/server";

import { getConnectionPlane } from "../../../_server/connection-plane";
import { CATALOGUE_STATUSES } from "../../../_server/connection-catalogue";
import { gateConnectRoute } from "../_gate";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = await gateConnectRoute(request, { requireCsrf: false });
  if (!gate.ok) {
    return gate.response;
  }
  const principalRef = gate.context.principal.principalRef;
  return NextResponse.json({
    status: "ok",
    catalogue: CATALOGUE_STATUSES,
    journeys: getConnectionPlane().journeysFor(principalRef),
    authorizationSurface: getConnectionPlane().authorizationSurface(),
  });
}
