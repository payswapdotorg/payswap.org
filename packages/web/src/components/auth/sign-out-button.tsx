"use client";

/**
 * The sign-out control (P3-W1-002) — a real POST with the CSRF
 * double-submit header, then a redirect to the sign-in page.
 *
 * The CSRF token comes from the server-rendered prop (the CSRF cookie's
 * value — no secret material: it is bound to the session via HMAC and is
 * intentionally JS-readable so this header can exist).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@payswap/design";

import { sessionFetchJson } from "@/lib/api-client";

export function SignOutButton({
  csrfToken,
  redirectTo = "/signin",
  label = "Sign out",
}: {
  readonly csrfToken: string;
  readonly redirectTo?: string;
  readonly label?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut(): Promise<void> {
    if (pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await sessionFetchJson<{ status?: string; message?: string }>(
        "/api/auth/signout",
        { method: "POST", body: {}, csrfToken },
      );
      if (result.status === "ok") {
        router.replace(redirectTo);
        return;
      }
      setError(
        result.status === "http-error"
          ? (result.message ?? `Sign-out failed (HTTP ${result.statusCode}) — your session is still active.`)
          : `Could not reach the sign-out service: ${result.message}`,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="secondary"
        loading={pending}
        loadingLabel="Signing out"
        onClick={handleSignOut}
      >
        {label}
      </Button>
      <div aria-live="polite">
        {error !== null ? (
          <p className="text-sm leading-6 text-red-800">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
