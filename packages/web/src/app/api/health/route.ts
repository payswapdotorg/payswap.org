/**
 * Health/readiness endpoint for the PaySwap public web surface.
 *
 * Reports service status + build information honestly: the deterministic
 * build id and the commit the build was produced from are baked at build
 * time by next.config.ts; when they are unavailable they are reported as
 * null — never fabricated. This endpoint carries NO financial state (the
 * authoritative PaySwap API owns all financial truth).
 */

export const dynamic = "force-dynamic";

export function GET() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_PAYSWAP_API_URL?.trim() || null;
  return Response.json(
    {
      status: "ok",
      service: "@payswap/web",
      role: "public product surface — a consumer of the authoritative PaySwap API",
      build: {
        id: process.env.PAYSWAP_WEB_BUILD_ID ?? null,
        commit: process.env.PAYSWAP_WEB_BUILD_COMMIT ?? null,
      },
      apiRuntime: {
        baseUrl: apiBaseUrl,
        configured: apiBaseUrl !== null,
        envVar: "NEXT_PUBLIC_PAYSWAP_API_URL",
        note: "referenced by name only — no value is stored in git",
      },
      checkedAt: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
