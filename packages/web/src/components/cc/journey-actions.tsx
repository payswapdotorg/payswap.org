"use client";

/**
 * The honest journey-action renderer (P3-W2-002; copy made current by
 * P3-W3-002).
 *
 * Every ViewAction from a certified journey contract renders here with the
 * W3-001 no-dead-buttons doctrine: an available action is a real control; an
 * unavailable action renders its honest reason. API_COMMAND actions now
 * dispatch through the REAL authenticated transport
 * (`/api/journeys/dispatch` → the authoritative PaySwap API, answers folded
 * verbatim) — the honest unavailable state is the marked-preview no-session
 * case and the API runtime's own session gate (its 401/403 answers render
 * verbatim, never as a fake success).
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { ViewAction } from "@payswap/ux";
import { Button } from "@payswap/design";

export const SESSION_NOT_WIRED_REASON =
  "This journey mutation dispatches through the authenticated protocol path (INV-F05) to the authoritative PaySwap API. A signed-in session is required to dispatch it — and the API runtime authenticates with its own session tokens, answering honestly until a public issuance path exists. The verbatim answer is always surfaced, never a simulated effect.";

/** Route-string links to surfaces owned by the authentication/connect plane. */
export const CONNECT_ROUTE = "/connect" as const;

export function JourneyActionControl({
  action,
  onAction,
}: {
  readonly action: ViewAction;
  /** Handles journey-driving actions (selection, folds, navigation). */
  readonly onAction: (action: ViewAction) => void;
}) {
  if (!action.available) {
    return (
      <span className="cc-actions__item">
        <Button size="sm" variant="secondary" disabled>
          {action.label}
        </Button>
        <span className="cc-actions__reason">
          {action.unavailableReason ?? SESSION_NOT_WIRED_REASON}
        </span>
      </span>
    );
  }
  switch (action.kind) {
    case "API_COMMAND":
      // Available API_COMMANDs only exist with a session; unreachable today
      // but rendered identically for the merge (defense in depth: the same
      // honest reason renders if one ever appears without a session).
      return (
        <span className="cc-actions__item">
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onAction(action);
            }}
          >
            {action.label}
          </Button>
        </span>
      );
    case "TRUSTED_SURFACE":
      return (
        <span className="cc-actions__item">
          <Link className="ps-button ps-button--sm ps-button--secondary" href={CONNECT_ROUTE}>
            {action.label}
          </Link>
          <span className="cc-actions__reason">
            The trusted approval surface is the provider&rsquo;s own surface —
            no provider broker is bound in this deployment yet, so the honest
            not-yet state renders here (credentials never cross, in either
            direction).
          </span>
        </span>
      );
    case "EXTERNAL_OPEN":
      return (
        <span className="cc-actions__item">
          <Button
            size="sm"
            variant="secondary"
            disabled
            title="Opens the external system once a session authorizes it"
          >
            {action.label}
          </Button>
          <span className="cc-actions__reason">
            Opens {action.externalOpen?.systemName ?? "the external system"} —
            available when a session authorizes the external action.
          </span>
        </span>
      );
    case "EVIDENCE_VIEW":
      return (
        <Link className="ps-button ps-button--sm ps-button--secondary" href="/app/evidence">
          {action.label}
        </Link>
      );
    case "NAVIGATION":
    case "AUTHORITY_TRANSITION":
    default:
      return (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onAction(action);
          }}
        >
          {action.label}
        </Button>
      );
  }
}

export function JourneyActionList({
  actions,
  onAction,
  heading,
}: {
  readonly actions: readonly ViewAction[];
  readonly onAction: (action: ViewAction) => void;
  readonly heading?: ReactNode;
}) {
  return (
    <div className="cc-stack">
      {heading ? <h3 className="ps-label">{heading}</h3> : null}
      <ul className="cc-actions">
        {actions.map((action) => (
          <li key={action.actionId} className="cc-actions__item">
            <JourneyActionControl action={action} onAction={onAction} />
          </li>
        ))}
      </ul>
    </div>
  );
}
