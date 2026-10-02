import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../utils/cx.js";
import { Button } from "./Button.js";
import { StatusPill } from "./StatusPill.js";

/**
 * The honest-state family. Every surface renders the TRUTH of its data:
 * loading (Skeleton), empty (EmptyState), failed (ErrorState), outcome not
 * yet known (UnknownState), or authentication-gated (AuthRequiredState).
 * No state ever fabricates data, and UNKNOWN is never dressed as failure
 * (amber + dashed vs red + solid — the StatusPill contract).
 */

interface StateShellProps extends HTMLAttributes<HTMLDivElement> {
  tone: "neutral" | "unknown" | "danger";
  role?: "status" | "alert";
}

function StateShell({
  tone,
  role = "status",
  className,
  children,
  ...rest
}: StateShellProps) {
  return (
    <div
      role={role}
      className={cx("ps-state", `ps-state--${tone}`, className)}
      {...rest}
    >
      {children}
    </div>
  );
}

function StateTitle({ children }: { children: ReactNode }) {
  return <h3 className="ps-state__title">{children}</h3>;
}

/* ------------------------------ EmptyState --------------------------- */

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: ReactNode;
  /** Call-to-action for the legitimate next step (never a fake "create data"). */
  action?: ReactNode;
}

/** Nothing here — and that is the truth. No placeholder numbers, no theater. */
export function EmptyState({
  title = "Nothing here yet",
  description,
  action,
  className,
  role: _consumerRole,
  ...rest
}: EmptyStateProps) {
  return (
    <StateShell tone="neutral" className={className} {...rest}>
      <StateTitle>{title}</StateTitle>
      {description ? <p className="ps-state__description">{description}</p> : null}
      {action ? <div className="ps-state__actions">{action}</div> : null}
    </StateShell>
  );
}

/* ------------------------------ ErrorState --------------------------- */

export interface ErrorStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: string;
  /** What actually went wrong (transport-level truth, provider-agnostic). */
  description?: ReactNode;
  /** Retry re-runs the real request. Retrying is the only recovery path. */
  onRetry?: () => void;
  retryLabel?: string;
}

/**
 * A real failure occurred. role=alert announces it; the Retry button is the
 * honest recovery action. Never used for outcomes that are merely unknown.
 */
export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  retryLabel = "Retry",
  className,
  role: _consumerRole,
  ...rest
}: ErrorStateProps) {
  return (
    <StateShell tone="danger" role="alert" className={className} {...rest}>
      <StateTitle>{title}</StateTitle>
      {description ? <p className="ps-state__description">{description}</p> : null}
      {typeof onRetry === "function" ? (
        <div className="ps-state__actions">
          <Button onClick={onRetry}>{retryLabel}</Button>
        </div>
      ) : null}
    </StateShell>
  );
}

/* ------------------------------ UnknownState ------------------------- */

export interface UnknownStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: string;
  /**
   * Reconciliation language: what is pending, what will resolve it, and
   * when to check again. The word "failed" (and its styling) is banned
   * here — the outcome is NOT yet known.
   */
  description?: ReactNode;
  /** Optional follow-up (e.g. "View evidence" / "Check again later"). */
  action?: ReactNode;
}

/**
 * Outcome not yet known — reconciliation in progress. Visually amber +
 * dashed (distinct from danger by construction), announced as status, and
 * carrying an explicit UNKNOWN pill so the state is never color-alone.
 */
export function UnknownState({
  title = "Outcome not yet known",
  description,
  action,
  className,
  role: _consumerRole,
  ...rest
}: UnknownStateProps) {
  return (
    <StateShell tone="unknown" className={className} {...rest}>
      <StatusPill tone="unknown">Reconciling</StatusPill>
      <StateTitle>{title}</StateTitle>
      {description ? <p className="ps-state__description">{description}</p> : null}
      {action ? <div className="ps-state__actions">{action}</div> : null}
    </StateShell>
  );
}

/* ------------------------------ AuthRequiredState -------------------- */

export interface AuthRequiredStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: string;
  /** What is unavailable and why (default: authentication required). */
  reason?: string;
  /** Retry after authenticating — the only way data appears here. */
  onRetry?: () => void;
  retryLabel?: string;
  /** The honesty line rendered under the action (see default). */
  doctrine?: string;
}

/**
 * The honest gate: data exists behind authentication, so the surface says
 * exactly that — title, reason, Retry, and the doctrine line (the
 * reference's "renders only real backend state" pattern). No teaser data,
 * no blurred fakes, no skeleton theater.
 */
export function AuthRequiredState({
  title = "Data unavailable",
  reason = "Authentication required",
  onRetry,
  retryLabel = "Retry",
  doctrine = "Only real, verified state is rendered here — nothing is simulated.",
  className,
  role: _consumerRole,
  ...rest
}: AuthRequiredStateProps) {
  return (
    <StateShell tone="neutral" role="alert" className={className} {...rest}>
      <StateTitle>{title}</StateTitle>
      <p className="ps-state__description">{reason}</p>
      {typeof onRetry === "function" ? (
        <div className="ps-state__actions">
          <Button onClick={onRetry}>{retryLabel}</Button>
        </div>
      ) : null}
      <p className="ps-state__doctrine">{doctrine}</p>
    </StateShell>
  );
}
