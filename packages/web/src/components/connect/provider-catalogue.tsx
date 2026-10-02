/**
 * The provider catalogue browser (P3-W1-002) — the /connect entry.
 *
 * Every card is the HONEST status from the recorded evidence (probe +
 * rollout records): platform-verified providers say verified-at-platform
 * and explicitly NOT connected for you; MTN MoMo says BLOCKED with dates;
 * no-credential providers say not connected; the local rail says
 * providerless. Selecting an option NEVER treats availability as connected
 * capability — the distinction is written on the card and enforced by the
 * W3-001 contract (the catalogue never authorizes).
 */

import Link from "next/link";
import { Badge, Card, CardMeta, CardSubtitle, CardTitle, Panel, StatusPill } from "@payswap/design";

import type { CatalogueProviderStatus } from "@/app/(auth)/_server/connection-catalogue";
import { statusPillTone } from "@/app/(auth)/_server/connection-catalogue";
import { coverage, formatUtcTimestamp } from "@/lib/coverage";

const MODE_LABELS: Readonly<Record<CatalogueProviderStatus["userConnectionMode"], string>> = {
  DELEGATED_OAUTH: "Delegated OAuth",
  CONNECTED_ACCOUNT: "Connected account",
  SCOPED_CREDENTIAL: "Scoped credential",
  BROWSER_SESSION: "Browser session",
};

export function ProviderCataloguePanel({
  statuses,
}: {
  readonly statuses: readonly CatalogueProviderStatus[];
}) {
  return (
    <Panel
      title="Provider catalogue"
      description={`Derived from the recorded probe and release evidence (probed ${formatUtcTimestamp(coverage.probedAt)}; release ${coverage.releaseId}). Availability is NOT connected capability — connecting requires the explicit authorization flow.`}
      headingLevel={2}
    >
      <ul className="grid list-none gap-4 p-0">
        {statuses.map((status) => (
          <li key={status.providerId}>
            <ProviderCatalogueCard status={status} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function ProviderCatalogueCard({ status }: { readonly status: CatalogueProviderStatus }) {
  const connectable = status.statusKind !== "BLOCKED";
  return (
    <Card raised className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>{status.displayName}</CardTitle>
          <CardSubtitle>
            <code className="ps-mono text-xs">{status.providerId}</code>
          </CardSubtitle>
        </div>
        <div className="flex flex-col items-end gap-2">
          <StatusPill tone={statusPillTone(status.statusKind)}>
            {status.statusKind === "PLATFORM_VERIFIED"
              ? "Verified at platform level"
              : status.statusKind === "BLOCKED"
                ? "Blocked"
                : status.statusKind === "NOT_CONNECTED_NO_CREDENTIAL"
                  ? "Not connected"
                  : "Local rail"}
          </StatusPill>
          <Badge>{MODE_LABELS[status.userConnectionMode]}</Badge>
        </div>
      </div>

      <p className="mt-3 text-sm leading-6 text-stone-700">{status.statusLine}</p>

      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-stone-600">
        {status.evidenceLines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <CardMeta className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs leading-5 text-stone-500">
          Availability is not connected capability — connecting requires the
          explicit authorization flow.
        </span>
        {connectable ? (
          <Link
            href={`/connect/${status.providerId}`}
            className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
          >
            Review connection
          </Link>
        ) : (
          <span className="rounded-lg border border-stone-300 bg-stone-100 px-4 py-2 text-sm font-medium text-stone-500">
            Not connectable (honest datum)
          </span>
        )}
      </CardMeta>
    </Card>
  );
}
