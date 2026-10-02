import Link from "next/link";
import {
  coverage,
  formatUtcTimestamp,
  providerLabel,
} from "@/lib/coverage";

const JOURNEYS = [
  {
    title: "Connect a provider",
    body: "Authorize a connection to a provider you already use — Stripe, Paystack, Flutterwave and more. Credentials stay in the operator vault under scoped references; PaySwap connects through user-authorized sessions, never stored keys.",
  },
  {
    title: "Pay",
    body: "Execute payments through your connected providers. Every payment carries authorization lineage and evidence lineage — no action is ever reported as done without proof.",
  },
  {
    title: "Collect",
    body: "Collect in the currencies your providers actually support — from GHS bank rails to pan-African and stablecoin wallets. Coverage follows your live connections, not a marketing list.",
  },
  {
    title: "Pay out",
    body: "Disburse funds through payout-capable providers under explicit control-plane gates. Payout controls exist so money moves only with recorded authorization.",
  },
  {
    title: "Reconcile",
    body: "External outcomes are reconciled, never guessed. When a provider answer is ambiguous, PaySwap renders UNKNOWN and works the reconciliation — UNKNOWN is never silently turned into success or failure.",
  },
] as const;

const CUSTODY_POINTS = [
  {
    title: "We never hold your credentials",
    body: "Provider connections run through scoped credentials kept in an operator vault outside Git. The product references them by name only.",
  },
  {
    title: "We never hold your money",
    body: "Balances you see are external observations reported by the providers you connect. Funds never move into PaySwap custody.",
  },
  {
    title: "Every action carries evidence",
    body: "Each consequential financial effect records both its authorization lineage and its evidence lineage — auditable by construction.",
  },
] as const;

export function HomePage() {
  const connectedNames = coverage.connected.map((entry) =>
    providerLabel(entry.providerName),
  );
  const blockedEntry = coverage.blocked[0];

  return (
    <>
      {/* Hero */}
      <section
        aria-labelledby="hero-heading"
        className="border-b border-stone-200 bg-gradient-to-b from-emerald-50/70 to-white"
      >
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
            PaySwap.org
          </p>
          <h1
            id="hero-heading"
            className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-stone-900 sm:text-5xl"
          >
            A non-custodial economic operating system for the payment
            providers and rails you already use.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-stone-600">
            PaySwap connects you to your providers and rails — pay, collect,
            pay out and reconcile in one place, with authorization and
            evidence for every financial action. You keep custody of your
            money and your credentials. Always.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              href="/app"
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-6 py-3 text-base font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
            >
              Open the Command Center
            </Link>
            <Link
              href="/capabilities"
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-stone-300 bg-white px-6 py-3 text-base font-semibold text-stone-800 hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              See live coverage
            </Link>
          </div>
          <p className="mt-4 max-w-2xl text-sm text-stone-500">
            The Command Center requires authentication and is not yet
            available in this deployment phase — you will see an honest gate,
            not a demo with fake data.
          </p>
        </div>
      </section>

      {/* Journeys */}
      <section aria-labelledby="journeys-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2
            id="journeys-heading"
            className="text-3xl font-bold tracking-tight text-stone-900"
          >
            What you do with PaySwap
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            One operating system for the economic actions that already run
            your business or your life — on the providers you already have.
          </p>
          <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {JOURNEYS.map((journey) => (
              <li
                key={journey.title}
                className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm"
              >
                <h3 className="text-base font-semibold text-stone-900">
                  {journey.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-stone-600">
                  {journey.body}
                </p>
              </li>
            ))}
            <li className="rounded-xl border border-emerald-200 bg-emerald-50 p-6">
              <h3 className="text-base font-semibold text-emerald-900">
                And everything is evidence-backed
              </h3>
              <p className="mt-2 text-sm leading-6 text-emerald-900/80">
                The same protocol path serves the product UI and programmatic
                clients. Financial truth is protocol-owned — the interface
                only ever projects it.
              </p>
            </li>
          </ul>
        </div>
      </section>

      {/* Honest coverage summary */}
      <section
        aria-labelledby="coverage-heading"
        className="border-y border-stone-200 bg-stone-50"
      >
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2
                id="coverage-heading"
                className="text-3xl font-bold tracking-tight text-stone-900"
              >
                Provider coverage today
              </h2>
              <p className="mt-3 max-w-2xl text-stone-600">
                Recorded from live provider probes on{" "}
                <time dateTime={coverage.probedAt}>
                  {formatUtcTimestamp(coverage.probedAt)}
                </time>
                . This is the honest picture — providers are never listed as
                connected when the recorded evidence says otherwise.
              </p>
            </div>
            <Link
              href="/capabilities"
              className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-800 hover:border-stone-400 hover:bg-stone-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              Full coverage explorer
            </Link>
          </div>

          <dl className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-stone-200 bg-white p-6">
              <dt className="text-sm font-medium text-stone-500">
                Verified connections (test-mode)
              </dt>
              <dd className="mt-2 text-4xl font-bold tracking-tight text-emerald-700">
                {coverage.connected.length}
              </dd>
              <p className="mt-2 text-sm text-stone-600">
                {connectedNames.join(", ")} — probed live, with certification
                evidence.
              </p>
            </div>
            <div className="rounded-xl border border-stone-200 bg-white p-6">
              <dt className="text-sm font-medium text-stone-500">
                Blocked at the provider gate
              </dt>
              <dd className="mt-2 text-4xl font-bold tracking-tight text-rose-700">
                {coverage.blocked.length}
              </dd>
              <p className="mt-2 text-sm text-stone-600">
                {blockedEntry
                  ? `${providerLabel(blockedEntry.providerName)} — subscription key rejected (HTTP 401); re-probe pending a valid key.`
                  : "No blocked providers recorded."}
              </p>
            </div>
            <div className="rounded-xl border border-stone-200 bg-white p-6">
              <dt className="text-sm font-medium text-stone-500">
                Built, awaiting credentials
              </dt>
              <dd className="mt-2 text-4xl font-bold tracking-tight text-amber-700">
                {coverage.awaitingCredentials.length}
              </dd>
              <p className="mt-2 text-sm text-stone-600">
                Connectors implemented and certified, activation waiting on
                operator-supplied credentials — plus the Stellar local rail.
              </p>
            </div>
          </dl>
        </div>
      </section>

      {/* Non-custody */}
      <section aria-labelledby="custody-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2
            id="custody-heading"
            className="text-3xl font-bold tracking-tight text-stone-900"
          >
            Non-custodial by construction
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            PaySwap is an operating system over your existing economic
            relationships — not another place your money lives.
          </p>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {CUSTODY_POINTS.map((point) => (
              <div
                key={point.title}
                className="rounded-xl border border-stone-200 bg-stone-50 p-6"
              >
                <h3 className="text-base font-semibold text-stone-900">
                  {point.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-stone-600">
                  {point.body}
                </p>
              </div>
            ))}
          </div>
          <Link
            href="/security"
            className="mt-8 inline-flex min-h-[44px] items-center text-sm font-semibold text-emerald-700 hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          >
            Read the security &amp; non-custody commitments →
          </Link>
        </div>
      </section>

      {/* Developers */}
      <section
        aria-labelledby="developers-heading"
        className="border-t border-stone-200 bg-stone-900"
      >
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="developers-heading"
            className="text-2xl font-bold tracking-tight text-white"
          >
            Building on PaySwap?
          </h2>
          <p className="mt-3 max-w-2xl text-stone-300">
            The API is the authority. This website is just one client of it —
            the same protocol path that renders these pages serves your
            programmatic clients.
          </p>
          <Link
            href="/developers"
            className="mt-6 inline-flex min-h-[44px] items-center rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-stone-950 hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          >
            Start with the API
          </Link>
        </div>
      </section>
    </>
  );
}
