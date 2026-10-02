import Link from "next/link";

/**
 * The authenticated entry boundary: the Command Center shell.
 *
 * Law (P3-W1-001): this is an HONEST gate. Authentication is not yet
 * available in this deployment phase, so the content area renders the
 * "authentication required / not yet available" state — there is NO fake
 * login, NO demo data, NO optimistic content. The shell (sidebar with the
 * product's sections) is real navigation: every /app/* deep link resolves
 * and survives a hard refresh, because the optional catch-all route
 * server-renders this same gate for any section path.
 */

export interface CommandCenterSection {
  readonly href: string;
  readonly label: string;
  readonly description: string;
}

/** The product's sections, as sidebar navigation. */
export const COMMAND_CENTER_SECTIONS: readonly CommandCenterSection[] = [
  {
    href: "/app",
    label: "Overview",
    description:
      "A live view of your economic position across every connected provider — observed externally, never custodial.",
  },
  {
    href: "/app/activity",
    label: "Activity",
    description:
      "The stream of economic events you acted on or that affected you, each with its authorization and evidence lineage.",
  },
  {
    href: "/app/payments",
    label: "Payments",
    description:
      "Payments executed through your connected providers, with proof for every effect and UNKNOWN reconciliation front and center.",
  },
  {
    href: "/app/collections",
    label: "Collections",
    description:
      "Money collected in the currencies your connections actually support, scoped to real eligibility.",
  },
  {
    href: "/app/payouts",
    label: "Payouts",
    description:
      "Disbursements under explicit control-plane gates — money moves only with recorded authorization.",
  },
  {
    href: "/app/capabilities",
    label: "Capabilities",
    description:
      "Your connected capabilities as live instances — never a provider catalogue mistaken for authority.",
  },
  {
    href: "/app/evidence",
    label: "Evidence",
    description:
      "The evidence archive: authorization lineage and proof for every consequential financial effect.",
  },
  {
    href: "/app/developers",
    label: "Developers",
    description:
      "API keys, webhooks and programmatic access to the same protocol path the product runs on.",
  },
  {
    href: "/app/settings",
    label: "Settings",
    description:
      "Your connections, sessions, authorizations and notification preferences.",
  },
];

interface ResolvedSection {
  readonly known: boolean;
  readonly active: CommandCenterSection | undefined;
  readonly path: string;
}

function resolveSection(section: readonly string[] | undefined): ResolvedSection {
  if (section === undefined || section.length === 0) {
    return { known: true, active: COMMAND_CENTER_SECTIONS[0], path: "/app" };
  }
  const path = `/app/${section.join("/")}`;
  if (section.length === 1) {
    const active = COMMAND_CENTER_SECTIONS.find(
      (entry) => entry.href === path,
    );
    if (active) {
      return { known: true, active, path };
    }
  }
  return { known: false, active: undefined, path };
}

function SectionLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "flex min-h-[44px] items-center rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
          : "flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-stone-600 hover:bg-stone-200/70 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
      }
    >
      {label}
    </Link>
  );
}

export function CommandCenter({
  section,
}: {
  section: readonly string[] | undefined;
}) {
  const resolved = resolveSection(section);

  return (
    <section
      aria-labelledby="command-center-heading"
      className="flex-1 border-b border-stone-200 bg-stone-100"
    >
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="grid gap-8 lg:grid-cols-[240px_1fr]">
          {/* Sidebar navigation */}
          <nav
            aria-label="Command Center sections"
            className="rounded-xl border border-stone-200 bg-white p-3"
          >
            <p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
              Command Center
            </p>
            <ul className="flex flex-wrap gap-1 lg:flex-col">
              {COMMAND_CENTER_SECTIONS.map((entry) => (
                <li key={entry.href} className="lg:w-full">
                  <SectionLink
                    href={entry.href}
                    label={entry.label}
                    active={resolved.active?.href === entry.href}
                  />
                </li>
              ))}
            </ul>
          </nav>

          {/* Content: the honest gate */}
          <div className="rounded-xl border border-stone-200 bg-white p-6 sm:p-10">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-stone-100">
                <svg
                  viewBox="0 0 24 24"
                  className="h-5 w-5 text-stone-600"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    d="M7 10V8a5 5 0 0 1 10 0v2m-9 0h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm4 4.5a1.5 1.5 0 0 1 1 2.8V19a1 1 0 1 1-2 0v-1.7a1.5 1.5 0 0 1 1-2.8Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
                Command Center
                {resolved.active ? ` — ${resolved.active.label}` : ""}
              </p>
            </div>

            <h1
              id="command-center-heading"
              className="mt-6 text-3xl font-bold tracking-tight text-stone-900"
            >
              Authentication required
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-stone-600">
              The Command Center requires an authenticated session, and
              authentication is not yet available in this deployment phase.
              This gate is the honest state — there is no demo mode, no
              sample data and no pretend login behind it.
            </p>

            {!resolved.known && (
              <p className="mt-6 max-w-2xl rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                Unrecognized section:{" "}
                <span className="font-mono">{resolved.path}</span> is not one
                of the Command Center sections listed in the navigation. The
                URL still resolves (deep links never 404 here) — it will
                serve the authenticated section view once authentication
                ships.
              </p>
            )}

            <dl className="mt-8 divide-y divide-stone-200 rounded-xl border border-stone-200">
              <div className="flex flex-col gap-1 p-4 sm:flex-row sm:gap-4">
                <dt className="w-44 shrink-0 text-sm font-semibold text-stone-900">
                  Authentication
                </dt>
                <dd className="text-sm leading-6 text-stone-600">
                  Required — not available in this deployment phase. When it
                  ships, sessions are user-authorized and expire honestly:
                  expired sessions must be re-authenticated, never quietly
                  continued.
                </dd>
              </div>
              <div className="flex flex-col gap-1 p-4 sm:flex-row sm:gap-4">
                <dt className="w-44 shrink-0 text-sm font-semibold text-stone-900">
                  Financial data
                </dt>
                <dd className="text-sm leading-6 text-stone-600">
                  None rendered. This web surface holds no financial state of
                  its own — the authoritative PaySwap API owns all financial
                  truth, and the Command Center only ever projects it for
                  authenticated sessions.
                </dd>
              </div>
              <div className="flex flex-col gap-1 p-4 sm:flex-row sm:gap-4">
                <dt className="w-44 shrink-0 text-sm font-semibold text-stone-900">
                  This URL
                </dt>
                <dd className="text-sm leading-6 text-stone-600">
                  <span className="font-mono">{resolved.path}</span> is a
                  valid deep link — it renders now, survives a hard refresh,
                  and will serve the authenticated{" "}
                  {resolved.active?.label.toLowerCase() ?? "section"}{" "}
                  when authentication ships.
                  {resolved.active
                    ? ` ${resolved.active.label} will show: ${resolved.active.description}`
                    : ""}
                </dd>
              </div>
            </dl>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
              >
                Back to the public site
              </Link>
              <Link
                href="/capabilities"
                className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-sm font-semibold text-stone-800 hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
              >
                Provider coverage (public)
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
