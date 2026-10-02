/**
 * The honest "identity plane not configured" state (P3-W1-002).
 *
 * The same doctrine as Wave 1's /app gate: when the deployment has not been
 * given web-plane identities (`WEB_APP_SEED_USERS`) or a session signing
 * key (`WEB_APP_SESSION_SIGNING_KEY`), sign-in does not render a form that
 * cannot succeed — it renders the honest state, naming the missing
 * configuration by ENV VAR NAME ONLY (never a value), with no demo login
 * and no pretend session behind it.
 */

import Link from "next/link";
import { Panel } from "@payswap/design";

export interface IdentityPlaneStateProps {
  /** Which env var names are missing (names only — values never exist here). */
  readonly missingEnvVars: readonly string[];
  /** The honest, value-free explanation from the session plane. */
  readonly detail: string;
  /** Where the user came from / can go back to. */
  readonly backHref?: string;
  readonly backLabel?: string;
}

export function IdentityPlaneNotConfiguredState({
  missingEnvVars,
  detail,
  backHref = "/",
  backLabel = "Back to the public site",
}: IdentityPlaneStateProps) {
  return (
    <Panel
      title="Sign-in is not configured in this deployment"
      description="This is the honest state of the identity plane — not an error, and not a hidden login."
      headingLevel={2}
    >
      <p className="text-sm leading-6 text-stone-700">{detail}</p>
      <p className="mt-3 text-sm leading-6 text-stone-700">
        There is no demo mode, no sample identity and no pretend session
        behind this state. A deployment operator configures the identity
        plane through the environment variables below; until then this page
        cannot authenticate anyone — by design.
      </p>
      <ul className="mt-4 list-inside list-disc space-y-1 font-mono text-sm text-stone-700">
        {missingEnvVars.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      <p className="mt-4 text-sm leading-6 text-stone-600">
        Configuration is referenced by name only on this page: seed
        identities are provisioned at runtime by the deployment operator,
        and their password hashes are never committed to this repository.
      </p>
      <div className="mt-6">
        <Link
          href={backHref}
          className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-sm font-semibold text-stone-800 hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
        >
          {backLabel}
        </Link>
      </div>
    </Panel>
  );
}
