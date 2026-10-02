import Link from "next/link";

/**
 * The /security surface: the non-custody and session-isolation explanation.
 *
 * Every claim on this page is true to the repository's facts: PaySwap never
 * holds provider credentials (scoped credentials live in the operator vault,
 * referenced by name only), never holds funds (balances are external
 * observations), connections run through user-authorized browser sessions
 * that must be re-authenticated when they expire, and every consequential
 * financial effect carries both authorization and evidence lineage.
 */

const COMMITMENTS = [
  {
    title: "PaySwap never holds your money",
    body: "Funds never move into PaySwap custody. The balances you see are external observations reported by the providers you connect — they are their state, projected read-only. Nothing on this site is a PaySwap balance, because no such thing exists.",
    detail:
      "External provider balances and positions are observations, never PaySwap custody or customer balances — that law is structural, not a policy promise.",
  },
  {
    title: "PaySwap never holds your credentials",
    body: "Provider connections run through scoped credentials kept in an operator vault outside the repository. The product references them by name only (the PROVIDER_<NAME>_CREDENTIAL_REF pattern) — secret values never enter Git, logs or pages.",
    detail:
      "No tokens, keys or .env files are committed anywhere in this codebase. Environment variables are referenced by name, valued only in the vault or the deployment environment.",
  },
  {
    title: "Connections are user-authorized sessions",
    body: "A connection is a browser session you authorize against your provider — not a standing key PaySwap can use whenever it likes. When a session expires, journeys that need it stop and ask you to re-authenticate; they never quietly continue with stale authority.",
    detail:
      "Session expiry is a verified behavior, not an aspiration: expired-session re-authentication is part of the browser-verification suite the product is certified against.",
  },
  {
    title: "Every financial action carries evidence",
    body: "Each consequential financial effect records both its authorization lineage (who or what allowed it, under which grant) and its evidence lineage (the proof of what actually happened outside). Auditable by construction — not a bolted-on audit log.",
    detail:
      "There is no path in the system that produces a financial effect without recording how it was authorized and how it was proven.",
  },
  {
    title: "UNKNOWN is never quietly resolved",
    body: "When a provider's answer is ambiguous, PaySwap renders UNKNOWN and works the reconciliation. Ambiguity is never blindly retried, never converted into success, and never converted into failure.",
    detail:
      "You will see the honest state — including when the honest state is 'we don't know yet, here is the reconciliation case'.",
  },
  {
    title: "Fail-closed, everywhere",
    body: "A connector without credentials fails closed instead of pretending. A blocked provider stays blocked until a fresh probe with a working credential says otherwise. Nothing renders as connected or successful when the recorded evidence says otherwise.",
    detail:
      "The same law runs this website: the provider coverage you see here is a projection of recorded probe evidence, never a marketing list.",
  },
] as const;

export function SecurityPage() {
  return (
    <>
      {/* Intro */}
      <section
        aria-labelledby="security-heading"
        className="border-b border-stone-200 bg-gradient-to-b from-emerald-50/70 to-white"
      >
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
            Security &amp; non-custody
          </p>
          <h1
            id="security-heading"
            className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-stone-900"
          >
            An operating system over your economic relationships — not another
            place your money lives.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-stone-600">
            PaySwap connects you to the payment providers and rails you
            already use. That design decision carries the whole security
            model: PaySwap holds no funds, no provider credentials of its
            own, and no financial truth — it orchestrates, authorizes,
            observes and proves, through your connections.
          </p>
        </div>
      </section>

      {/* Commitments */}
      <section aria-labelledby="commitments-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="commitments-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            The commitments, and where each one is enforced
          </h2>
          <p className="mt-3 max-w-2xl text-stone-600">
            These are not policy statements — each is a structural property
            of the system, enforced by its construction and verified by its
            test battery.
          </p>
          <ul className="mt-10 grid gap-6 md:grid-cols-2">
            {COMMITMENTS.map((commitment) => (
              <li
                key={commitment.title}
                className="rounded-xl border border-stone-200 bg-stone-50 p-6"
              >
                <h3 className="text-lg font-semibold text-stone-900">
                  {commitment.title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-stone-600">
                  {commitment.body}
                </p>
                <p className="mt-4 border-l-2 border-emerald-600 pl-3 text-xs leading-5 text-stone-500">
                  {commitment.detail}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Plain language */}
      <section
        aria-labelledby="plain-heading"
        className="border-y border-stone-200 bg-stone-50"
      >
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2
            id="plain-heading"
            className="text-2xl font-bold tracking-tight text-stone-900"
          >
            In plain language
          </h2>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="rounded-xl border border-stone-200 bg-white p-6">
              <h3 className="text-base font-semibold text-stone-900">
                If PaySwap disappeared tomorrow
              </h3>
              <p className="mt-2 text-sm leading-6 text-stone-600">
                Your money would be exactly where it is today: with your
                providers, in your accounts. Nothing is held “in PaySwap”.
              </p>
            </div>
            <div className="rounded-xl border border-stone-200 bg-white p-6">
              <h3 className="text-base font-semibold text-stone-900">
                If someone compromised this website
              </h3>
              <p className="mt-2 text-sm leading-6 text-stone-600">
                They would find no funds to move and no provider credentials
                to use. The website is a consumer of the authoritative API —
                it holds no financial state of its own.
              </p>
            </div>
            <div className="rounded-xl border border-stone-200 bg-white p-6">
              <h3 className="text-base font-semibold text-stone-900">
                When you act through PaySwap
              </h3>
              <p className="mt-2 text-sm leading-6 text-stone-600">
                The action runs through your authorized connection, under
                recorded authorization, and returns with proof. If the
                provider&apos;s answer is ambiguous, you see UNKNOWN — never
                a guess.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Honest phase note */}
      <section aria-labelledby="phase-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="rounded-xl border border-stone-200 bg-stone-900 p-8">
            <h2
              id="phase-heading"
              className="text-xl font-bold tracking-tight text-white"
            >
              What you will see today — honestly
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-stone-300">
              The Command Center (the authenticated product surface) is not
              yet available in this deployment phase. When you open it, you
              will find an honest authentication gate — not a demo with fake
              balances or a pretend login. Provider coverage on this site is
              the recorded, dated truth: three verified test-mode
              connections, one blocked provider, and connectors waiting for
              credentials.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/capabilities"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-stone-950 hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
              >
                See the live coverage picture
              </Link>
              <Link
                href="/developers"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-stone-600 px-5 py-2.5 text-sm font-semibold text-stone-200 hover:border-stone-400 hover:bg-stone-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
              >
                Build against the API
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
