import type { Metadata } from "next";
import { Suspense } from "react";

import { Panel } from "@payswap/design";

import { IdentityPlaneNotConfiguredState } from "@/components/auth/identity-plane-state";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SessionStatusPanel } from "@/components/auth/session-status";
import { currentWebSessionContext } from "@/lib/session/server";
import { sessionLookupExplanation } from "@/lib/session/server";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in to PaySwap with a real, server-verified session — scrypt password verification, httpOnly cookies, honest expiry. When the identity plane is not configured in this deployment, this page says so instead of pretending.",
};

export const dynamic = "force-dynamic";

/**
 * /signin — the real sign-in page (P3-W1-002).
 *
 * Three honest states, derived server-side:
 * 1. identity plane not configured → the honest state (env names only);
 * 2. a live session already exists → the session status + sign-out;
 * 3. otherwise → the real sign-in form (client component).
 */
export default async function SignInPage() {
  const context = await currentWebSessionContext();

  return (
    <section
      aria-labelledby="signin-heading"
      className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14"
    >
      <h1 id="signin-heading" className="text-3xl font-bold tracking-tight text-stone-900">
        Sign in
      </h1>
      <p className="mt-3 max-w-xl text-base leading-7 text-stone-600">
        Sign in to reach the Command Center, onboarding and provider
        connections. Sessions are real, server-issued and expire honestly.
      </p>
      <div className="mt-8">
        {!context.configured ? (
          <IdentityPlaneNotConfiguredState
            missingEnvVars={context.missingEnvVars}
            detail={context.detail}
          />
        ) : context.session.valid ? (
          <div className="flex flex-col gap-6">
            <Panel
              title="You are already signed in"
              description="A live session is attached to this browser."
              headingLevel={2}
            >
              <p className="text-sm leading-6 text-stone-700">
                Continue to the Command Center, or review the session below.
              </p>
            </Panel>
            <SessionStatusPanel view={context.session.view} csrfToken={context.csrfToken ?? ""} />
          </div>
        ) : (
          <>
            <Panel
              title="Sign in to PaySwap"
              description="Credentials are verified server-side; nothing is validated as success on the client."
              headingLevel={2}
            >
              <Suspense
                fallback={
                  <p className="text-sm leading-6 text-stone-600">Loading the sign-in form…</p>
                }
              >
                <SignInForm />
              </Suspense>
            </Panel>
            {!context.session.valid ? (
              <p className="mt-4 text-sm leading-6 text-stone-600">
                {sessionLookupExplanation(context.session.reason)}
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
