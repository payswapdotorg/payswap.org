/**
 * POST /api/connect/select — choose a provider from the catalogue (the
 * REAL W3-001 folds: browsing → initiating only; the catalogue never
 * authorizes). Session + CSRF gated.
 *
 * Honest outcomes:
 * - 200 with the serialized journey when the choice is legal;
 * - 400 `illegal` when the contract refuses (e.g. the BLOCKED provider) —
 *   the contract's own message, verbatim;
 * - 401/403/503 from the session gate.
 */

import { NextResponse, type NextRequest } from "next/server";

import { readJsonObject } from "../../auth/_guards";
import { getConnectionPlane } from "../../../_server/connection-plane";
import { gateConnectRoute } from "../_gate";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = await gateConnectRoute(request, { requireCsrf: true });
  if (!gate.ok) {
    return gate.response;
  }
  const body = await readJsonObject(request);
  const providerId = body !== null && typeof body["providerId"] === "string" ? body["providerId"] : "";
  if (providerId.length === 0 || providerId.length > 64) {
    return NextResponse.json(
      { status: "error", message: "Expected a providerId string." },
      { status: 400 },
    );
  }
  const result = getConnectionPlane().selectProvider(
    gate.context.principal.principalRef,
    providerId,
  );
  switch (result.status) {
    case "ok":
      return NextResponse.json({ status: "ok", journey: result.journey });
    case "illegal":
      return NextResponse.json({ status: "illegal", message: result.message }, { status: 400 });
    case "not-found":
      return NextResponse.json({ status: "not-found" }, { status: 404 });
    case "api-unavailable":
      return NextResponse.json(
        { status: "api-unavailable", reason: result.reason, message: result.message },
        { status: 503 },
      );
  }
}
