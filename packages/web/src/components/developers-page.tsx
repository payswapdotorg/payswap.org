import Link from "next/link";
import type { ApiRuntimeState } from "@/lib/api";

/**
 * The /developers surface: the API-authority entry point.
 *
 * The web app is a CONSUMER of the authoritative PaySwap API — the same
 * protocol path that renders these pages serves programmatic clients. The
 * API runtime host is a separate deployment (the existing `payswap` Vercel
 * project); this surface points at it through NEXT_PUBLIC_PAYSWAP_API_URL
 * and renders the honest "not configured" state when that variable is
 * absent — never a guessed or fabricated URL.
 */

const PROTOCOL_GUARANTEES = [
  {
    title: "One protocol path",
    body: "The product UI and programmatic clients speak the same API. There is no separate “internal” surface — what you build against is what the product runs on.",
  },
  {
    title: "Enveloped responses",
    body: "Every response arrives in a structured envelope, and error categories map to status codes deterministically — including EXTERNAL_AMBIGUITY returning 409 with an X-PaySwap-Outcome: unknown header.",
  },
  {
    title: "Idempotency by contract",
    body: "Mutation endpoints enforce idempotency keys — a replayed request with the same key resolves to the recorded outcome instead of double-executing.",
  },
  {
    title: "UNKNOWN stays UNKNOWN",
    body: "When a provider answer is ambiguous, the protocol returns the ambiguity — never a synthesized success or failure. Reconciliation is a first-class state.",
  },
  {
    title: "Signed webhooks",
    body: "Webhook integrations verify signatures and enforce a bounded replay window — stale or forged events are rejected by construction.",
  },
  {
    title: "Evidence on every effect",
    body: "Consequential financial effects carry authorization lineage and evidence lineage — the API is the authority precisely because it can prove what it did.",
  },
] as const;

export function DevelopersPage({ api }: { api: ApiRuntimeState }) {
  return (
    <>
      {/* Intro */}
      <section
        aria-labelledby="developers-heading"
        className="border-b border-stone-200 bg-gradient-to-b from-emerald-50/70 to-white"
      >
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
            Developers
          </p>
          <h1
            id="developers-heading"
            className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-stone-900"
          >
            The API is the authority. This website is just one client of it.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-stone-600">
            PaySwap&apos;s financial truth is protocol-owned: the same
            protocol path that renders these pages serves your programmatic
            clients. Build against the API and you build against the
            product&apos;s spine — envelopes, evidence and honest states
            included.
          </p>
        </div>
      </section>

      {/* API runtime configuration */}
      <section aria-labelledby="api-config-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="api-config-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            The API runtime
          </h2>
          {api.configured ? (
            <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-6">
              <p className="text-sm font-semibold text-emerald-900">
                Configured
              </p>
              <p className="mt-2 break-all font-mono text-sm text-emerald-900">
                {api.baseUrl}
              </p>
              <p className="mt-3 text-sm leading-6 text-emerald-900/80">
                Base URL resolved from {api.envVar} at build time. The API
                runtime host is a separate deployment — the authoritative
                PaySwap service this web surface consumes.
              </p>
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-6">
              <p className="text-sm font-semibold text-amber-900">
                Not configured — and shown as such
              </p>
              <p className="mt-3 text-sm leading-6 text-amber-900/90">
                This deployment of the web surface has no{" "}
                <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs">
                  {api.envVar}
                </code>{" "}
                value baked in, so there is no API base URL to point you at.
                That is the honest state, not an error: the authoritative
                PaySwap API runs as a separate service (the existing{" "}
                <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-xs">
                  payswap
                </code>{" "}
                Vercel project — the API/runtime host), and its public URL is
                supplied per environment at deployment time, by name, from
                the deployment environment — never hardcoded here.
              </p>
              <p className="mt-3 text-sm leading-6 text-amber-900/90">
                When the deployment is configured, this page shows the live
                base URL in place of this notice.
              </p>
            </div>
          )}
          <p className="mt-6 max-w-3xl text-sm leading-6 text-stone-600">
            Project separation, deliberately: the web surface deploys as its
            own Vercel project (
            <code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs">
              payswap-web
            </code>
            , root directory{" "}
            <code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs">
              packages/web
            </code>
            ) and never replaces or shadows the API runtime host. One
            authority, many clients.
          </p>
        </div>
      </section>

      {/* Protocol guarantees */}
      <section
        aria-labelledby="protocol-heading"
        className="border-y border-stone-200 bg-stone-50"
      >
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="protocol-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            What the protocol guarantees you
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            The properties below are contract-level, machine-verified by the
            API conformance suites — not documentation aspirations.
          </p>
          <ul className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {PROTOCOL_GUARANTEES.map((guarantee) => (
              <li
                key={guarantee.title}
                className="rounded-xl border border-stone-200 bg-white p-6"
              >
                <h3 className="text-base font-semibold text-stone-900">
                  {guarantee.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-stone-600">
                  {guarantee.body}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Where the contracts live */}
      <section aria-labelledby="contracts-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="contracts-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            Where the contracts live
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            The protocol is specified and tested in the PaySwap repository —
            the same source of truth that renders this page&apos;s coverage
            data:
          </p>
          <ul className="mt-8 space-y-4">
            <li className="rounded-xl border border-stone-200 bg-stone-50 p-5">
              <p className="font-mono text-xs text-stone-500">
                packages/interfaces
              </p>
              <p className="mt-2 text-sm leading-6 text-stone-600">
                The API surface contracts — envelope shapes, error
                categories, idempotency semantics.
              </p>
            </li>
            <li className="rounded-xl border border-stone-200 bg-stone-50 p-5">
              <p className="font-mono text-xs text-stone-500">
                packages/api
              </p>
              <p className="mt-2 text-sm leading-6 text-stone-600">
                The boundary implementation and its conformance suite
                (envelope shape, category-to-status mapping, webhook
                signature and replay window).
              </p>
            </li>
            <li className="rounded-xl border border-stone-200 bg-stone-50 p-5">
              <p className="font-mono text-xs text-stone-500">
                spec/architecture
              </p>
              <p className="mt-2 text-sm leading-6 text-stone-600">
                The frozen architecture and invariants the protocol upholds —
                including the evidence and authorization-lineage laws.
              </p>
            </li>
          </ul>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/capabilities"
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
            >
              See the live provider coverage
            </Link>
            <Link
              href="/security"
              className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-sm font-semibold text-stone-800 hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              Read the non-custody model
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
