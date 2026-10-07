"use client";

/**
 * UX-006 — the spending-permissions list (contract 10 §5: "list of granted
 * allowances with scope in human words ... revoke per row WITH simulation of
 * effect"; security contract §4.5: "destructive or irreversible flows show a
 * plain-language simulation of what WILL happen, then require explicit
 * confirm").
 *
 * Vocabulary (merchant contract §4): an approval/allowance is a "spending
 * permission" with scope + revoke — never crypto jargon on a consumer
 * surface.
 *
 * Honesty law: the rows arrive from a real permissions plane (none records
 * anything in this deployment — the list then renders its honest empty).
 * Revocation is a MUTATION with no certified dispatch command in this
 * deployment, so the confirm step renders the honest not-submitted state
 * (the W4 refund precedent): the simulation is real, the effect is not
 * claimed, and the permission is stated to remain active.
 */

import { useState } from "react";
import { EmptyState } from "@payswap/design";

import type { MoneyView } from "@/app/app/payments/_view/payment-view";
import { formatMoney } from "@/app/app/payments/_view/payment-view";

/** One granted spending permission (an allowance, in human words). */
export interface SpendingPermissionRecord {
  readonly id: string;
  /** Who the permission was granted to ("Merchant X"). */
  readonly grantee: string;
  /** The scope: a per-spend limit, or unlimited (rendered in plain words). */
  readonly scope: { readonly kind: "limited"; readonly limit: MoneyView } | { readonly kind: "unlimited" };
  /** When the permission was granted (ISO). */
  readonly grantedAt: string;
}

/**
 * The scope in HUMAN words (contract 10 §5): "Merchant X can spend up to
 * 50 USDC" — the allowance vocabulary, never an approval/allowance term.
 */
export function spendingScopeSentence(permission: SpendingPermissionRecord): string {
  const limit =
    permission.scope.kind === "limited"
      ? `up to ${formatMoney(permission.scope.limit)}`
      : "without a limit";
  return `${permission.grantee} can spend ${limit} from your account`;
}

/** The plain-language simulation of what revoking WILL do (§4.5). */
export function revokeSimulationSentence(permission: SpendingPermissionRecord): string {
  return `Revoking stops ${permission.grantee} from spending anything more from your account, starting immediately. Payments already on their way are not affected. If you ever need this permission again, you grant it fresh — revoking is not a pause.`;
}

const REVOKE_NOT_WIRED_MESSAGE =
  "Permission revocation is dispatched by the authoritative PaySwap API against the recorded permission — no revocation command is on this deployment's dispatch allowlist, so nothing was revoked and the permission remains active. This is the honest not-yet state, not a failure.";

export function SpendingPermissions({
  permissions,
}: {
  readonly permissions: readonly SpendingPermissionRecord[];
}) {
  // The single revoke flow state: which row's simulation is open. Only one
  // simulation at a time (an explicit, focused confirmation).
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmedId, setConfirmedId] = useState<string | null>(null);

  if (permissions.length === 0) {
    return (
      <EmptyState
        title="No spending permissions granted"
        description={
          <>
            When you allow a service to spend from your account on your
            behalf, the permission appears here — who can spend, and up to
            how much, in plain words — and you can revoke it at any time.
            Nothing is fabricated in the meantime.
          </>
        }
        teachingLine="Permissions you grant during a payment flow are listed here the moment the authoritative record exists."
        data-testid="safety-permissions-empty"
      />
    );
  }

  return (
    <ul className="cc-stack" data-testid="safety-permissions-list">
      {permissions.map((permission) => (
        <li key={permission.id} className="cc-card" data-testid={`safety-permission-${permission.id}`}>
          <div className="cc-card__head">
            <p className="cc-card__title">{spendingScopeSentence(permission)}</p>
            <button
              type="button"
              className="ps-button ps-button--sm ps-button--secondary"
              aria-expanded={openId === permission.id}
              onClick={() => {
                setOpenId(openId === permission.id ? null : permission.id);
                setConfirmedId(null);
              }}
            >
              Revoke
            </button>
          </div>
          <p className="cc-card__meta">Granted {permission.grantedAt.slice(0, 10)}</p>
          {openId === permission.id ? (
            <div className="cc-stack" data-testid={`safety-revoke-simulation-${permission.id}`}>
              {/* The simulation BEFORE the irreversible action (security
                  contract §4.5): plain words, then explicit confirm. */}
              <p className="cc-actions__reason" role="status">
                <strong>Before you revoke:</strong> {revokeSimulationSentence(permission)}
              </p>
              <button
                type="button"
                className="ps-button ps-button--sm ps-button--primary"
                onClick={() => {
                  setConfirmedId(permission.id);
                }}
              >
                Confirm revoke
              </button>
              {confirmedId === permission.id ? (
                <p className="cc-actions__reason" role="status" data-testid={`safety-revoke-result-${permission.id}`}>
                  {REVOKE_NOT_WIRED_MESSAGE}
                </p>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
