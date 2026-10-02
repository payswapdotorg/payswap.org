/**
 * The viewer's connected capability instances (P3-W3-002) — the "inspect
 * connected capability" acceptance line.
 *
 * HONEST DATA CONTRACT: instances derive EXCLUSIVELY from authority
 * activation records in the connection plane (`authorityRecordsFor` — the
 * W3-001 law: `applyConnectionAuthorizationOutcome` is the only fold that
 * produces them). Never catalogue data, never fabricated. With no records
 * the honest empty state renders. An unauthenticated (marked-preview)
 * visitor honestly sees none — the preview carries no session.
 */

import Link from "next/link";

import {
  ConnectedInstanceView,
  connectionFactsFromRecord,
  type ConnectionAuthorizationMode,
} from "@/components/connect/connected-instance-view";
import { NoConnectedCapabilitiesState } from "@/components/connect/connected-instance-view";
import type { ConnectedCapabilityInstanceRecord } from "@payswap/ux";

import { catalogueStatusById } from "@/app/(auth)/_server/connection-catalogue";

function modeFor(providerId: string): ConnectionAuthorizationMode {
  return catalogueStatusById(providerId)?.userConnectionMode ?? "DELEGATED_OAUTH";
}

export function CcYourInstances({
  records,
  authenticated,
}: {
  /** Authority activation records for the signed-in principal (any state). */
  readonly records: readonly ConnectedCapabilityInstanceRecord[];
  /** False in the marked preview (no session — no records are claimed). */
  readonly authenticated: boolean;
}) {
  if (records.length === 0) {
    return (
      <div className="cc-stack">
        <NoConnectedCapabilitiesState />
        {!authenticated ? (
          <p className="cc-actions__reason">
            You are viewing the marked role preview — it carries no session,
            so no connected capability instances can be claimed here.{" "}
            <Link href="/connect" className="font-semibold text-emerald-800 underline">
              Sign in and review the connection flows
            </Link>
            .
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="cc-stack">
      {records.map((record) => (
        <ConnectedInstanceView
          key={record.instanceId}
          facts={connectionFactsFromRecord(record, modeFor(record.providerId))}
          providerDisplayName={
            catalogueStatusById(record.providerId)?.displayName ?? record.providerId
          }
        />
      ))}
    </div>
  );
}
