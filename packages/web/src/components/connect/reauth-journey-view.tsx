/**
 * The Reauth journey view (P3-W1-002) — consuming the REAL W3-001
 * ReauthJourney contract from @payswap/ux.
 *
 * The five states, verbatim from the contract:
 * AUTHORIZATION_EXPIRED → CUSTOMER_ACTION_REQUIRED →
 * REAUTHORIZING_ON_TRUSTED_SURFACE → FRESH_AUTHORIZATION_RECORDED →
 * EXECUTION_RESUMED (terminal).
 *
 * The view is a pure projection: it renders the journey it is given (the
 * live app has no expired authorizations yet — the honest empty state —
 * while the contract states are exercised end-to-end in tests). The
 * lineage the reauthorization preserves (original intent, attempt,
 * command) is displayed verbatim, and the fresh authorization is shown as
 * the opaque references it is — never credential material.
 */

import { KeyValue, Panel, StatusPill } from "@payswap/design";

import type { ReauthJourney } from "@payswap/ux";

const STATE_COPY: Readonly<Record<ReauthJourney["stateName"], string>> = {
  AUTHORIZATION_EXPIRED:
    "The authorization expired (or a step-up was required). Execution is parked — it never continues quietly on a stale authorization.",
  CUSTOMER_ACTION_REQUIRED:
    "Your action is required: complete the authorization request on the trusted browser surface.",
  REAUTHORIZING_ON_TRUSTED_SURFACE:
    "Reauthorization is in progress on the trusted surface. PaySwap sees only the outcome, never the surface's credentials.",
  FRESH_AUTHORIZATION_RECORDED:
    "A fresh authorization is recorded (opaque references). Execution can now resume with the ORIGINAL lineage intact.",
  EXECUTION_RESUMED:
    "Execution resumed under the new authorization — old intent, new authorization, full lineage.",
};

const STATE_TONE: Readonly<Record<ReauthJourney["stateName"], "attention" | "ok" | "unknown">> = {
  AUTHORIZATION_EXPIRED: "attention",
  CUSTOMER_ACTION_REQUIRED: "attention",
  REAUTHORIZING_ON_TRUSTED_SURFACE: "unknown",
  FRESH_AUTHORIZATION_RECORDED: "ok",
  EXECUTION_RESUMED: "ok",
};

const STATE_STEPS: readonly ReauthJourney["stateName"][] = [
  "AUTHORIZATION_EXPIRED",
  "CUSTOMER_ACTION_REQUIRED",
  "REAUTHORIZING_ON_TRUSTED_SURFACE",
  "FRESH_AUTHORIZATION_RECORDED",
  "EXECUTION_RESUMED",
];

export function ReauthJourneyView({ journey }: { readonly journey: ReauthJourney }) {
  const currentIndex = STATE_STEPS.indexOf(journey.stateName);
  return (
    <Panel
      title={
        journey.trigger === "EXPIRED"
          ? "Reauthorization — the authorization expired"
          : "Reauthorization — a step-up is required"
      }
      description={STATE_COPY[journey.stateName]}
      headingLevel={2}
      actions={<StatusPill tone={STATE_TONE[journey.stateName]}>{journey.stateName}</StatusPill>}
    >
      <ol className="flex list-none flex-wrap gap-2 p-0">
        {STATE_STEPS.map((step, index) => (
          <li
            key={step}
            aria-current={step === journey.stateName ? "step" : undefined}
            className={
              index < currentIndex
                ? "rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-900"
                : index === currentIndex
                  ? "rounded-md border border-emerald-700 bg-emerald-700 px-2.5 py-1 text-xs font-semibold text-white"
                  : "rounded-md border border-stone-300 bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-500"
            }
          >
            {index + 1}. {step}
          </li>
        ))}
      </ol>

      <div className="mt-5">
        <KeyValue
          entries={[
            { key: "Trigger", value: journey.trigger },
            ...(journey.lineage.intentId !== undefined
              ? [{ key: "Original intent", value: journey.lineage.intentId, mono: true }]
              : []),
            ...(journey.lineage.attemptId !== undefined
              ? [{ key: "Original attempt", value: journey.lineage.attemptId, mono: true }]
              : []),
            { key: "Original command", value: journey.lineage.originalCommandType, mono: true },
            ...(journey.freshAuthorization !== undefined
              ? [
                  {
                    key: "Fresh authorization",
                    value: journey.freshAuthorization.authorizationRef,
                    mono: true,
                  },
                  {
                    key: "Authorization evidence",
                    value: journey.freshAuthorization.evidenceRef,
                    mono: true,
                  },
                ]
              : []),
            ...(journey.resumedIntentId !== undefined
              ? [{ key: "Resumed intent", value: journey.resumedIntentId, mono: true }]
              : []),
            ...(journey.approval !== undefined
              ? [{ key: "Approval request", value: journey.approval.requestHash, mono: true }]
              : []),
          ]}
        />
      </div>

      <h4 className="mt-5 text-sm font-semibold text-stone-900">Actions in this state</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-stone-700">
        {journey.actions.map((action) => (
          <li key={action.actionId}>
            <span className="font-medium">{action.label}</span>{" "}
            <span className="text-stone-500">
              ({action.kind}
              {action.available ? "" : " — not available"}).
            </span>
          </li>
        ))}
      </ul>

      {journey.error !== undefined ? (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm leading-6 text-red-900">
          The last step answered honestly with an error ({journey.error.code},{" "}
          {journey.error.category}): {journey.error.message}
        </p>
      ) : null}
    </Panel>
  );
}
