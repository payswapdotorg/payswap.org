/**
 * The signed-in session status (P3-W1-002) — server-rendered truth plus the
 * real sign-out control. Shows WHO the user is to this app, when the
 * session expires, and the honest boundary: this identity is not financial
 * authority.
 */

import Link from "next/link";
import { KeyValue, Panel, StatusPill } from "@payswap/design";

import type { WebSessionView } from "@/lib/session/web-session";
import { SignOutButton } from "./sign-out-button";

export function SessionStatusPanel({
  view,
  csrfToken,
  headingLevel = 2,
}: {
  readonly view: WebSessionView;
  readonly csrfToken: string;
  readonly headingLevel?: 2 | 3;
}) {
  const expiresAt = new Date(view.expiresAt);
  const expiresLabel = Number.isFinite(expiresAt.getTime())
    ? `${expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "—";
  return (
    <Panel
      title="Your session"
      description="A real, server-issued web session — not financial authority."
      headingLevel={headingLevel}
      actions={<SignOutButton csrfToken={csrfToken} />}
    >
      <KeyValue
        entries={[
          { key: "Signed in as", value: view.displayName },
          { key: "Email", value: view.email },
          { key: "Principal", value: view.principalRef, mono: true },
          { key: "Session expires", value: expiresLabel },
          {
            key: "What this is",
            value:
              "Your identity to this web app only — balances, intents and financial authority live exclusively in the PaySwap API.",
          },
        ]}
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <StatusPill tone="ok">Session active</StatusPill>
        <Link
          href="/app"
          className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
        >
          Open the Command Center
        </Link>
      </div>
    </Panel>
  );
}
