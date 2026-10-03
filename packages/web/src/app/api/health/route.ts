/**
 * Health/readiness endpoint for the PaySwap public web surface.
 *
 * P3-W1-003 hardened contract (see @/lib/health for the full model):
 *
 * - LIVENESS: answering this endpoint at all proves the process is alive
 *   (`liveness: "alive"` — it can be nothing else from inside a response).
 * - READINESS: every dependency check is real, env-gated and honestly
 *   classified — `ok` only when all checks are healthy; `degraded` when a
 *   check is skipped (binding env absent) or ambiguous (the dependency
 *   answered but its internal health is unknown to this surface);
 *   `unready` (HTTP 503) only when a CONFIGURED dependency failed.
 * - NEVER FAKE-HEALTHY: build identity is reported null when not baked by
 *   the build (never fabricated); an unconfigured API runtime is reported
 *   as skipped, never as passed.
 *
 * This endpoint carries NO financial state — the authoritative PaySwap API
 * owns all financial truth; this probe observes transport/dependency
 * posture only.
 */

import { buildHealthReport } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const { report, httpStatus } = await buildHealthReport({
    apiBaseUrlEnv: process.env.NEXT_PUBLIC_PAYSWAP_API_URL,
    buildIdEnv: process.env.PAYSWAP_WEB_BUILD_ID,
    buildCommitEnv: process.env.PAYSWAP_WEB_BUILD_COMMIT,
    fetcher: (url, init) => fetch(url, init),
  });
  return Response.json(report, {
    status: httpStatus,
    headers: { "cache-control": "no-store" },
  });
}
