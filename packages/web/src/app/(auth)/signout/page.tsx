import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, Panel } from "@payswap/design";

import { SessionStatusPanel } from "@/components/auth/session-status";
import { currentWebSessionContext, sessionLookupExplanation } from "@/lib/session/server";

export const metadata: Metadata = {
  title: "Sign out",
  description:
    "Sign out of PaySwap — the real session revocation (server-side, immediate), never a client-side-only logout.",
};

export const dynamic = "force-dynamic";

/**
 * /signout — confirm + execute the real sign-out (P3-W1-002).
 * The actual revocation is the CSRF-protected POST /api/auth/signout.
 */
export default async function SignOutPage() {
  const context = await currentWebSessionContext();

  return (
    <section
      aria-labelledby="signout-heading"
      className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14"
    >
      <h1 id="signout-heading" className="text-3xl font-bold tracking-tight text-stone-900">
        Sign out
      </h1>
      <div className="mt-8">
        {!context.configured ? (
          <EmptyState
            title="No identity plane, no session to sign out of"
            description="The identity plane is not configured in this deployment — there is no session to revoke. This is the honest state, not an error."
            action={
              <Link
                href="/"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-sm font-semibold text-stone-800 hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              >
                Back to the public site
              </Link>
            }
          />
        ) : context.session.valid ? (
          <div className="flex flex-col gap-6">
            <Panel
              title="Sign out of this browser"
              description="Revokes the session server-side and clears the session cookies — immediate and real."
              headingLevel={2}
            >
              <p className="text-sm leading-6 text-stone-700">
                Signing out revokes the session in the session manager (it
                can never be replayed) and expires both cookies. Any page
                that requires a session will honestly ask you to sign in
                again.
              </p>
            </Panel>
            <SessionStatusPanel view={context.session.view} csrfToken={context.csrfToken ?? ""} />
          </div>
        ) : (
          <EmptyState
            title="No session is active"
            description={sessionLookupExplanation(context.session.reason)}
            action={
              <Link
                href="/signin"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
              >
                Go to sign in
              </Link>
            }
          />
        )}
      </div>
    </section>
  );
}
