import type { Metadata } from "next";
import Link from "next/link";

import { Panel } from "@payswap/design";

import { ProviderCataloguePanel } from "@/components/connect/provider-catalogue";
import { CATALOGUE_STATUSES } from "@/app/(auth)/_server/connection-catalogue";
import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { currentWebSessionContext } from "@/lib/session/server";

export const metadata: Metadata = {
  title: "Connect a provider",
  description:
    "Browse the provider catalogue with honest statuses from the recorded probe and release evidence. Availability is never connected capability — connecting requires the explicit authorization flow.",
};

export const dynamic = "force-dynamic";

/**
 * /connect — the catalogue browser (P3-W1-002). Session-gated: connecting
 * providers is an authenticated activity. The catalogue itself is public
 * truth (the capabilities explorer shows the same evidence publicly).
 */
export default async function ConnectPage() {
  const context = await currentWebSessionContext();

  if (!context.configured) {
    return (
      <section aria-labelledby="connect-heading" className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 id="connect-heading" className="text-3xl font-bold tracking-tight text-stone-900">
          Connect a provider
        </h1>
        <div className="mt-8 max-w-2xl">
          <Panel title="Sign-in is not configured in this deployment" headingLevel={2}>
            <p className="text-sm leading-6 text-stone-700">
              Connecting providers requires an authenticated session, and the
              identity plane is not configured here ({context.missingEnvVars.join(", ")} —
              names only). The public{" "}
              <Link href="/capabilities" className="font-semibold text-emerald-800 underline">
                capabilities explorer
              </Link>{" "}
              shows the same provider evidence without a session.
            </p>
          </Panel>
        </div>
      </section>
    );
  }

  if (!context.session.valid) {
    return (
      <section aria-labelledby="connect-heading" className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 id="connect-heading" className="text-3xl font-bold tracking-tight text-stone-900">
          Connect a provider
        </h1>
        <div className="mt-8 max-w-2xl">
          <Panel
            title="Authentication required"
            description="Connecting a provider is an authenticated activity — there is no guest connection and no demo connection."
            headingLevel={2}
          >
            <p className="text-sm leading-6 text-stone-700">
              Sign in to browse the connection flows for your account. The
              catalogue&rsquo;s provider statuses stay public on the{" "}
              <Link href="/capabilities" className="font-semibold text-emerald-800 underline">
                capabilities page
              </Link>
              .
            </p>
            <div className="mt-5">
              <Link
                href="/signin?next=%2Fconnect"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
              >
                Sign in to continue
              </Link>
            </div>
          </Panel>
        </div>
      </section>
    );
  }

  const journeys = getConnectionPlane().journeysFor(context.session.view.principalRef);

  return (
    <section aria-labelledby="connect-heading" className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 id="connect-heading" className="text-3xl font-bold tracking-tight text-stone-900">
        Connect a provider
      </h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-stone-600">
        Signed in as{" "}
        <span className="font-semibold text-stone-900">{context.session.view.displayName}</span>.
        Every option below carries its honest status from the recorded
        evidence — and none of them is a connection until the explicit
        authorization flow completes.
      </p>
      <div className="mt-8 flex flex-col gap-8">
        {journeys.length > 0 ? (
          <Panel title="Your connection journeys" description="In-flight and terminal journeys, newest first." headingLevel={2}>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-stone-700">
              {journeys.map((journey) => (
                <li key={journey.providerId}>
                  <Link
                    href={`/connect/${journey.providerId}`}
                    className="font-semibold text-emerald-800 underline"
                  >
                    {journey.providerId}
                  </Link>{" "}
                  — state <code className="ps-mono text-xs">{journey.stateName}</code>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
        <ProviderCataloguePanel statuses={CATALOGUE_STATUSES} />
      </div>
    </section>
  );
}
