import type { ReactNode } from "react";
import {
  coverage,
  formatUtcTimestamp,
  providerLabel,
} from "@/lib/coverage";

/**
 * The /capabilities surface: the honest coverage explorer.
 *
 * Law (P3-W1-001): the probe/rollout records under spec/development-state/
 * are the ONLY provider-coverage truth. Everything on this page is derived
 * from them through @/lib/coverage — nothing here invents a provider,
 * upgrades a status or hides a blocked gate. Dates are always visible.
 */

type BadgeTone = "verified" | "blocked" | "awaiting" | "neutral";

const BADGE_TONES: Readonly<Record<BadgeTone, string>> = {
  verified:
    "border-emerald-300 bg-emerald-50 text-emerald-800",
  blocked: "border-rose-300 bg-rose-50 text-rose-800",
  awaiting: "border-amber-300 bg-amber-50 text-amber-900",
  neutral: "border-stone-300 bg-stone-100 text-stone-700",
};

function StatusBadge({
  tone,
  children,
}: {
  tone: BadgeTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-3 py-1 text-xs font-semibold ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** The two evidence records this page renders (provenance, always shown). */
const EVIDENCE_RECORDS = [
  {
    label: "Provider probe evidence",
    path: "spec/development-state/provider-probes-20261002.json",
    detail: `Live probes executed ${formatUtcTimestamp(coverage.probedAt)}. Every verdict derives from a probe against the provider's real API — operator input is recorded, never treated as integration proof.`,
  },
  {
    label: "Provider rollout release record",
    path: "spec/development-state/provider-rollout-20261002.json",
    detail: `Release ${coverage.releaseId}. The connected / non-connected split, certification numbers and rollback steps recorded at the Phase 2 rollout gate.`,
  },
] as const;

const CAPABILITY_OVERVIEW = [
  {
    title: "Pay",
    body: "Execute payments through your connected providers. Every payment carries authorization lineage and evidence lineage — nothing is reported done without proof.",
  },
  {
    title: "Collect",
    body: "Collect in the currencies your connections actually support — bank rails, wallets and stablecoin paths, scoped to what each account is really eligible for.",
  },
  {
    title: "Pay out",
    body: "Disburse through payout-capable providers under explicit control-plane gates. Money moves only with recorded authorization.",
  },
  {
    title: "Reconcile",
    body: "External outcomes are reconciled, never guessed. Ambiguous provider answers render as UNKNOWN and get worked — never silently turned into success or failure.",
  },
] as const;

export function CapabilitiesPage() {
  return (
    <>
      {/* Intro */}
      <section
        aria-labelledby="capabilities-heading"
        className="border-b border-stone-200 bg-gradient-to-b from-emerald-50/70 to-white"
      >
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
            Capabilities
          </p>
          <h1
            id="capabilities-heading"
            className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-stone-900"
          >
            What PaySwap can do — and exactly which providers are behind it
            today.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-stone-600">
            This page renders recorded evidence, not a marketing list. Every
            status below comes from live provider probes and the release
            record committed to the repository — with the dates those probes
            ran. A provider is never shown as connected when the recorded
            evidence says otherwise.
          </p>

          <dl className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-emerald-200 bg-white p-5">
              <dt className="text-sm font-medium text-stone-500">
                Verified (test-mode)
              </dt>
              <dd className="mt-1 text-3xl font-bold tracking-tight text-emerald-700">
                {coverage.connected.length}
              </dd>
            </div>
            <div className="rounded-xl border border-rose-200 bg-white p-5">
              <dt className="text-sm font-medium text-stone-500">
                Blocked
              </dt>
              <dd className="mt-1 text-3xl font-bold tracking-tight text-rose-700">
                {coverage.blocked.length}
              </dd>
            </div>
            <div className="rounded-xl border border-amber-200 bg-white p-5">
              <dt className="text-sm font-medium text-stone-500">
                Awaiting credentials
              </dt>
              <dd className="mt-1 text-3xl font-bold tracking-tight text-amber-700">
                {coverage.awaitingCredentials.length}
              </dd>
            </div>
            <div className="rounded-xl border border-stone-200 bg-white p-5">
              <dt className="text-sm font-medium text-stone-500">
                Local rail
              </dt>
              <dd className="mt-1 text-3xl font-bold tracking-tight text-stone-700">
                {coverage.localRail.length}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* Capability overview */}
      <section aria-labelledby="capability-model-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="capability-model-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            The capability model
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            PaySwap is an operating system over your existing economic
            relationships. Four capability families run on top of your
            connected providers:
          </p>
          <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {CAPABILITY_OVERVIEW.map((capability) => (
              <li
                key={capability.title}
                className="rounded-xl border border-stone-200 bg-stone-50 p-5"
              >
                <h3 className="text-base font-semibold text-stone-900">
                  {capability.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-stone-600">
                  {capability.body}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-8 max-w-3xl rounded-xl border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600">
            One law shapes all of it: a provider&apos;s catalogue capability is
            never executable authority. Execution is scoped to what your
            connected account is actually authorized, eligible and currently
            able to do — observed live, never assumed from a brochure.
          </p>
        </div>
      </section>

      {/* Verified connections */}
      <section
        aria-labelledby="verified-heading"
        className="border-y border-stone-200 bg-stone-50"
      >
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="verified-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            Verified connections
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            Probed live and certified through the cross-provider conformance
            matrix. All current connections run on scoped test-mode
            credentials — live credentials have not been supplied to this
            deployment.
          </p>
          <ul className="mt-8 grid gap-6 lg:grid-cols-3">
            {coverage.connected.map((entry) => (
              <li
                key={entry.providerName}
                className="flex flex-col rounded-xl border border-stone-200 bg-white p-6 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-lg font-semibold text-stone-900">
                    {providerLabel(entry.providerName)}
                  </h3>
                  <StatusBadge tone="verified">
                    {entry.probeEvidence.verdict} · test-mode
                  </StatusBadge>
                </div>
                <p className="mt-1 font-mono text-xs text-stone-500">
                  {entry.authorizationMode} · {entry.configKey}
                </p>
                <p className="mt-4 text-sm leading-6 text-stone-600">
                  {entry.probeEvidence.summary}
                </p>
                <p className="mt-3 text-xs text-stone-500">
                  Probed{" "}
                  <time dateTime={entry.probeEvidence.probedAt}>
                    {formatUtcTimestamp(entry.probeEvidence.probedAt)}
                  </time>
                  .
                </p>
                <div className="mt-4 rounded-lg bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                    Conformance certification
                  </p>
                  <p className="mt-1 text-sm text-stone-700">
                    {entry.certification.passed}/{entry.certification.executed}{" "}
                    scenarios passed · {entry.certification.failed} failed ·{" "}
                    {entry.certification.notApplicable} not applicable
                  </p>
                  {entry.certification.certificationId && (
                    <p className="mt-1 font-mono text-xs text-stone-500">
                      {entry.certification.certificationId}
                    </p>
                  )}
                </div>
                {entry.limitations.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                      Recorded limitations
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-sm leading-6 text-stone-600">
                      {entry.limitations.map((limitation) => (
                        <li key={limitation}>{limitation}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Blocked */}
      <section aria-labelledby="blocked-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="blocked-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            Blocked at the provider gate
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            Recorded honestly as unavailable. A blocked provider stays blocked
            until a fresh probe with a working credential says otherwise.
          </p>
          <ul className="mt-8 space-y-6">
            {coverage.blocked.map((entry) => (
              <li
                key={entry.providerName}
                className="rounded-xl border border-rose-200 bg-rose-50/50 p-6"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-stone-900">
                      {providerLabel(entry.providerName)}
                    </h3>
                    <p className="mt-1 font-mono text-xs text-stone-500">
                      {coverage.mtnMomo?.mode ?? "sandbox credential probe"}
                    </p>
                  </div>
                  <StatusBadge tone="blocked">
                    BLOCKED · unavailable
                  </StatusBadge>
                </div>
                <p className="mt-4 text-sm leading-6 text-stone-700">
                  {entry.reason}
                </p>
                {coverage.mtnMomo?.detail && (
                  <p className="mt-3 text-sm leading-6 text-stone-600">
                    Probe detail: {coverage.mtnMomo.detail}
                  </p>
                )}
                <p className="mt-3 text-xs text-stone-500">
                  Probed{" "}
                  <time dateTime={coverage.probedAt}>
                    {formatUtcTimestamp(coverage.probedAt)}
                  </time>{" "}
                  · re-probe pending a valid subscription key.
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Awaiting credentials */}
      <section
        aria-labelledby="awaiting-heading"
        className="border-y border-stone-200 bg-stone-50"
      >
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="awaiting-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            Built and certified — not connected
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            These connectors are implemented and certified fail-closed in the
            repository, but no credential exists for them in the operator
            vault. They are NOT connected and are never shown as available
            until the operator supplies a credential and a live probe verifies
            it.
          </p>
          <ul className="mt-8 divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
            {coverage.awaitingCredentials.map((entry) => (
              <li
                key={entry.providerName}
                className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between"
              >
                <div>
                  <h3 className="text-base font-semibold text-stone-900">
                    {providerLabel(entry.providerName)}
                  </h3>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-600">
                    {entry.reason}
                  </p>
                </div>
                <StatusBadge tone="awaiting">
                  not connected · awaiting credentials
                </StatusBadge>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Local rail */}
      <section aria-labelledby="local-rail-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="local-rail-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            The local rail
          </h2>
          <div className="mt-8 space-y-6">
            {coverage.localRail.map((entry) => (
              <div
                key={entry.providerName}
                className="rounded-xl border border-stone-200 bg-stone-50 p-6"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-stone-900">
                      {providerLabel(entry.providerName)}
                    </h3>
                    <p className="mt-1 font-mono text-xs text-stone-500">
                      {coverage.stellarTestnet?.mode ?? "providerless rail"}
                    </p>
                  </div>
                  <StatusBadge tone="neutral">
                    local rail · not a provider connection
                  </StatusBadge>
                </div>
                <p className="mt-4 text-sm leading-6 text-stone-700">
                  {entry.reason}
                </p>
                {coverage.stellarTestnet?.verdict && (
                  <p className="mt-3 text-sm leading-6 text-stone-600">
                    Testnet probe: {coverage.stellarTestnet.verdict}. The
                    W1-003 cross-border proof vehicle (GHS → USDC → KES) ran
                    on this rail; browser journeys use the real
                    user-authorized session path.
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Supporting services */}
      <section
        aria-labelledby="supporting-heading"
        className="border-t border-stone-200 bg-stone-50"
      >
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="supporting-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            Supporting platform services
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            Probed for operational use. None of these is a payment rail —
            they serve notifications, email and screening.
          </p>
          <ul className="mt-8 divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
            {coverage.supportingServices.map((service) => (
              <li
                key={service.id}
                className="flex flex-col gap-2 p-5 sm:flex-row sm:items-start sm:justify-between"
              >
                <div>
                  <h3 className="text-base font-semibold text-stone-900">
                    {providerLabel(service.id)}
                  </h3>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-600">
                    {service.note}
                  </p>
                </div>
                <StatusBadge tone="neutral">{service.verdict}</StatusBadge>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Provenance */}
      <section aria-labelledby="provenance-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="provenance-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            Where this data comes from
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            Coverage on this page is a build-time projection of two committed
            evidence records. It updates only when new records land in the
            repository — never on its own.
          </p>
          <ul className="mt-8 grid gap-6 md:grid-cols-2">
            {EVIDENCE_RECORDS.map((record) => (
              <li
                key={record.path}
                className="rounded-xl border border-stone-200 bg-stone-50 p-6"
              >
                <h3 className="text-base font-semibold text-stone-900">
                  {record.label}
                </h3>
                <p className="mt-2 break-all font-mono text-xs text-stone-500">
                  {record.path}
                </p>
                <p className="mt-3 text-sm leading-6 text-stone-600">
                  {record.detail}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
