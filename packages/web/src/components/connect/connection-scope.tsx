/**
 * The connection-scope review (P3-W1-002) — the EXPLICIT
 * connection-vs-withdrawal distinction the work order demands.
 *
 * Law 3: connection ≠ withdrawal authority. This panel states, before any
 * initiation, exactly what a connection authorizes and — with equal
 * prominence — what it NEVER authorizes. The distinction is not fine
 * print: both columns carry the same visual weight, and the initiation
 * action sits directly under this contract.
 */

import { Panel } from "@payswap/design";

export interface ConnectionScopeProps {
  readonly providerDisplayName: string;
  /** True for the providerless local rail (browser-session mode). */
  readonly isLocalRail?: boolean;
}

export function ConnectionScopeReview({
  providerDisplayName,
  isLocalRail = false,
}: ConnectionScopeProps) {
  return (
    <Panel
      title={`What connecting ${providerDisplayName} authorizes — and what it never does`}
      description="Read this before initiating. The distinction is the contract of the connection."
      headingLevel={3}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4">
          <h4 className="text-sm font-semibold text-emerald-900">
            A connection authorizes
          </h4>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6 text-emerald-950">
            <li>
              Establishing a <strong>linked capability</strong> with this
              provider for your account — nothing more.
            </li>
            <li>
              Observing what the connection honestly supports (eligibility,
              rails, limits) — read/observe scope.
            </li>
            <li>
              Initiating payments through the connection, where{" "}
              <strong>every payment still requires its own authorization</strong>{" "}
              (approvals, per-action scopes, idempotent commands).
            </li>
            {isLocalRail ? (
              <li>
                The local rail is providerless: your authorization happens in
                YOUR browser session; the app only ever holds an opaque
                session reference — never your keys.
              </li>
            ) : null}
          </ul>
        </div>
        <div className="rounded-lg border border-stone-300 bg-stone-100 p-4">
          <h4 className="text-sm font-semibold text-stone-900">
            A connection NEVER authorizes
          </h4>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6 text-stone-800">
            <li>
              <strong>Withdrawing funds.</strong> Withdrawal is a separate,
              explicitly-granted authority — never a side effect of
              connecting.
            </li>
            <li>
              Blanket transfer authority or moving money without a payout
              destination you separately authorized.
            </li>
            <li>
              Custody. PaySwap is non-custodial by construction — no
              connection ever changes that.
            </li>
            <li>
              Silent scope growth. Scope, authorization mode, expiry and
              reauth state are visible on the connection at all times.
            </li>
          </ul>
        </div>
      </div>
      <p className="mt-4 text-sm leading-6 text-stone-600">
        Authorization modes a connection can use:{" "}
        <strong>delegated OAuth</strong> (you authorize on the provider&rsquo;s
        own surface), <strong>connected account</strong>,{" "}
        <strong>scoped credential</strong> (vault-referenced, rotatable,
        revocable) or <strong>browser session</strong> (the providerless
        local-rail path). Credentials never cross into PaySwap — the app sees
        only opaque references.
      </p>
    </Panel>
  );
}
