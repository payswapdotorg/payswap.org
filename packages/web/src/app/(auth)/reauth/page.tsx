import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, Panel } from "@payswap/design";

import { ReauthEntry, type ReauthEntryInput } from "@/components/connect/reauth-entry";
import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { catalogueStatusById } from "@/app/(auth)/_server/connection-catalogue";
import { currentWebSessionContext } from "@/lib/session/server";

export const metadata: Metadata = {
  title: "Reauthorization",
  description:
    "The reauthorization journey: expired or step-up-required authorizations are completed on the trusted surface, then execution resumes with the original lineage intact — never quietly continued.",
};

export const dynamic = "force-dynamic";

/**
 * /reauth — the ReauthJourney entry (P3-W1-002; the real journey rendering
 * by P3-W3-002).
 *
 * A reauthorization journey begins from AUTHORITY state: an EXPIRED
 * ConnectedCapabilityInstanceRecord folded into the connection plane by the
 * authoritative API. This page derives those records for the signed-in
 * principal and renders the live ReauthJourney contract for each — the
 * fresh-authorization request dispatches through the real authenticated
 * transport and the answer folds VERBATIM. With no expired records the
 * honest empty state renders (never a fabricated journey).
 */
export default async function ReauthPage() {
  const context = await currentWebSessionContext();

  if (!context.configured) {
    return (
      <section className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="text-3xl font-bold tracking-tight text-stone-900">Reauthorization</h1>
        <div className="mt-8">
          <EmptyState
            title="The identity plane is not configured in this deployment"
            description={`Reauthorization is an authenticated journey. (${context.missingEnvVars.join(", ")} — env var names only.)`}
          />
        </div>
      </section>
    );
  }

  if (!context.session.valid) {
    return (
      <section className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="text-3xl font-bold tracking-tight text-stone-900">Reauthorization</h1>
        <div className="mt-8">
          <EmptyState
            title="Authentication required"
            description="A reauthorization journey is tied to your session's authorizations. Sign in to see whether any of them require action."
            action={
              <Link
                href="/signin?next=%2Freauth"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
              >
                Sign in
              </Link>
            }
          />
        </div>
      </section>
    );
  }

  const principalRef = context.session.view.principalRef;
  const plane = getConnectionPlane();
  const expiredEntries: ReauthEntryInput[] = plane
    .authorityRecordsFor(principalRef)
    .filter((record) => record.state === "EXPIRED")
    .map((record) => {
      const journey = plane.journeyFor(principalRef, record.providerId);
      return {
        providerId: record.providerId,
        providerDisplayName:
          catalogueStatusById(record.providerId)?.displayName ?? record.providerId,
        instanceId: record.instanceId,
        connectedAt: record.connectedAt,
        ...(journey?.initiationIntentId === undefined
          ? {}
          : { initiationIntentId: journey.initiationIntentId }),
      };
    });

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-3xl font-bold tracking-tight text-stone-900">Reauthorization</h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-stone-600">
        When an authorization expires (or a sensitive action requires a
        step-up), execution parks honestly — it never continues on a stale
        authorization. The journey: request the fresh authorization →
        complete the customer action on the trusted browser surface → record
        the fresh authorization → resume execution with the original lineage
        intact.
      </p>
      <div className="mt-8 flex flex-col gap-8">
        {expiredEntries.length > 0 ? (
          expiredEntries.map((entry) => (
            <ReauthEntry key={entry.instanceId} entry={entry} csrfToken={context.csrfToken} />
          ))
        ) : (
          <EmptyState
            title="No authorization requires reauthorization right now"
            description="There is no expired or step-up-required authorization on record for your session. This is the honest state: the web app holds no payment authorizations of its own (financial authority lives in the PaySwap API), and none of your connection journeys is parked in a reauth-required state."
            action={
              <Link
                href="/connect"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-sm font-semibold text-stone-800 hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              >
                Review your connections
              </Link>
            }
          />
        )}
      </div>
      <div className="mt-8">
        <Panel
          title="What the journey preserves"
          description="The lineage is carried verbatim through every state."
          headingLevel={2}
        >
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-stone-700">
            <li>The original intent, attempt and command the expired authorization covered.</li>
            <li>The fresh authorization&rsquo;s opaque reference and evidence reference — never credential material.</li>
            <li>Execution resumes under the NEW authorization with the OLD lineage: no re-entry of details, no duplicated side effects (idempotent commands).</li>
          </ul>
        </Panel>
      </div>
    </section>
  );
}
