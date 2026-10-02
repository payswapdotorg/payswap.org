"use client";

/**
 * The sign-in form (P3-W1-002) — a REAL client form against the REAL
 * server verification route.
 *
 * Laws honored here:
 * - the password field is type=password (never displayed, never logged,
 *   never echoed back from the server — the route's responses never
 *   contain it);
 * - every failure surfaces VERBATIM what the route answered (invalid
 *   credentials, validation, honest not-configured) — no client-side
 *   fake success, no optimistic session;
 * - the rate-limit backoff is displayed with a live countdown and the
 *   submit button is disabled while locked out;
 * - `?next=` deep links are honored ONLY when they are same-site paths
 *   (leading "/", not "//") — never an open redirect.
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button, Field, Input } from "@payswap/design";

import { sessionFetchJson } from "@/lib/api-client";
import { IdentityPlaneNotConfiguredState } from "./identity-plane-state";

interface SignInResponseBody {
  readonly status: string;
  readonly message?: string;
  readonly detail?: string;
  readonly missingEnvVars?: readonly string[];
  readonly retryAfterSeconds?: number;
}

/** Only same-site path deep links are honored (never an open redirect). */
export function sanitizeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
    return null;
  }
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return null;
  }
  return raw;
}

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = sanitizeNextPath(searchParams.get("next")) ?? "/app";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState<{
    readonly detail: string;
    readonly missingEnvVars: readonly string[];
  } | null>(null);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  useEffect(() => {
    if (lockoutSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setLockoutSeconds((current) => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [lockoutSeconds]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || lockoutSeconds > 0) {
      return;
    }
    setPending(true);
    setErrorMessage(null);
    try {
      const result = await sessionFetchJson<SignInResponseBody>("/api/auth/signin", {
        method: "POST",
        body: { email, password },
      });
      if (result.status === "ok" && result.data.status === "ok") {
        // Real success (the server set the httpOnly session cookie).
        // The password field is cleared immediately.
        setPassword("");
        router.replace(nextPath);
        return;
      }
      if (result.status === "http-error") {
        const body = result.body;
        if (result.statusCode === 503 && body?.status === "not-configured") {
          setNotConfigured({
            detail: body.detail ?? "The identity plane is not configured in this deployment.",
            missingEnvVars: body.missingEnvVars ?? [],
          });
          return;
        }
        if (result.statusCode === 429 && body?.status === "rate-limited") {
          setLockoutSeconds(body.retryAfterSeconds ?? 1);
          setErrorMessage(
            body.message ?? `Too many attempts — try again in ${body.retryAfterSeconds ?? 1}s.`,
          );
          return;
        }
        setErrorMessage(
          result.message ??
            `Sign-in failed (HTTP ${result.statusCode}). Check your email and password and try again.`,
        );
        return;
      }
      setErrorMessage(
        result.status === "network-error"
          ? `Could not reach the sign-in service: ${result.message}`
          : "Sign-in failed unexpectedly. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  if (notConfigured !== null) {
    return (
      <IdentityPlaneNotConfiguredState
        missingEnvVars={notConfigured.missingEnvVars}
        detail={notConfigured.detail}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      <Field
        label="Email"
        required
        hint="The identity your deployment operator provisioned for you."
      >
        <Input
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          maxLength={254}
        />
      </Field>
      <Field
        label="Password"
        required
        hint="Verified server-side with scrypt, constant-time. PaySwap never sees or stores it in plain text."
      >
        <Input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          maxLength={256}
        />
      </Field>

      <div aria-live="polite">
        {errorMessage !== null ? (
          <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm leading-6 text-red-900">
            {errorMessage}
          </p>
        ) : null}
        {lockoutSeconds > 0 ? (
          <p className="mt-2 text-sm leading-6 text-amber-800">
            Attempts are temporarily limited — you can try again in{" "}
            <span className="font-semibold">{lockoutSeconds}s</span>.
          </p>
        ) : null}
      </div>

      <Button
        type="submit"
        variant="primary"
        loading={pending}
        loadingLabel="Signing in"
        disabled={lockoutSeconds > 0}
      >
        Sign in
      </Button>
      <p className="text-sm leading-6 text-stone-600">
        Sessions are user-authorized, httpOnly and expire honestly after 8
        hours. Signing out revokes the session immediately.
      </p>
    </form>
  );
}
