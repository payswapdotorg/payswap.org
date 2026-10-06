/**
 * @payswap/ux — the error-reason registry (contract 07 v1.1 §2 — UX-002).
 *
 * THE SINGLE TYPED SOURCE for failure reasons (shared with the StatusChip
 * vocabulary): every reason carries exactly one human label, one icon token,
 * one technical trigger and one next-action family. Custom errors EXTEND this
 * registry (`extendErrorReasons`); inline free-text reasons outside it are
 * forbidden — a render site that needs a reason looks it up here, fail-closed.
 *
 * This module is PURE DATA + pure derivations (package law: no DOM, no
 * network, no rendering, no ambient time, no entropy). The registry is FROZEN;
 * extension produces a NEW registry value and never mutates the certified base.
 */

import { ViewContractError } from './command-center.js';

// ---------------------------------------------------------------------------
// The certified reason vocabulary (contract 07 §2 table, exact order)
// ---------------------------------------------------------------------------

/** The eight certified reason ids (contract 07 §2, in table order). */
export const ERROR_REASON_IDS = [
  'insufficient-balance',
  'payment-reverted',
  'route-unavailable',
  'slippage-beyond-limit',
  'transaction-dropped',
  'timed-out-awaiting-confirmation',
  'blocked-by-security-policy',
  'cancelled-by-user',
] as const;

export type ErrorReasonId = (typeof ERROR_REASON_IDS)[number];

/** Narrow an unknown value to a certified ErrorReasonId. */
export function isErrorReasonId(value: unknown): value is ErrorReasonId {
  return typeof value === 'string' && (ERROR_REASON_IDS as readonly string[]).includes(value);
}

/**
 * The next-action families (contract 07 §2 column 3, typed). Custom reasons
 * REUSE one of these families — a brand-new action SHAPE is a contract change
 * (registry version + TL review), not a per-surface improvisation.
 */
export type ErrorNextActionFamily =
  /** Top up / switch rail (insufficient balance). */
  | 'top-up-or-switch-rail'
  /** Show revert reason + retry with edit (payment reverted). */
  | 'show-reason-and-retry-with-edit'
  /** Show alternatives ranked (route unavailable). */
  | 'show-ranked-alternatives'
  /** Retry with adjusted limit (slippage beyond limit). */
  | 'retry-with-adjusted-limit'
  /** Investigate (transaction dropped — status explorer link). */
  | 'investigate'
  /** Investigate / re-broadcast if safe (timed out awaiting confirmation). */
  | 'investigate-or-rebroadcast'
  /** Human explanation + appeal path (blocked by security policy). */
  | 'explanation-and-appeal'
  /** — (recorded as event; no user action to offer). */
  | 'none-recorded-as-event';

/** The icon token of a reason — exactly ONE per certified reason. */
export type ErrorReasonIcon =
  | 'wallet'
  | 'revert'
  | 'route'
  | 'slippage'
  | 'dropped'
  | 'clock'
  | 'shield'
  | 'cancel';

/** One certified or custom error reason (contract 07 §2 row). */
export interface ErrorReason {
  readonly id: string;
  /** The human label shown to people (exactly one per reason). */
  readonly label: string;
  /** The technical trigger, in human terms (contract 07 §2 column 2). */
  readonly technicalTrigger: string;
  /** The typed next-action family (contract 07 §2 column 3). */
  readonly nextActionFamily: ErrorNextActionFamily;
  /** The human phrasing of the next action. */
  readonly nextActionLabel: string;
  /** The icon token (exactly one per reason; a data token, never a DOM node). */
  readonly icon: string;
  /** True for custom (registry-extended) reasons; false for the certified eight. */
  readonly custom: boolean;
}

const CERTIFIED_REASONS: readonly ErrorReason[] = Object.freeze([
  Object.freeze({
    id: 'insufficient-balance',
    label: 'Insufficient balance',
    technicalTrigger: 'The source wallet holds less than the payment amount.',
    nextActionFamily: 'top-up-or-switch-rail',
    nextActionLabel: 'Top up the source wallet or switch to another rail.',
    icon: 'wallet',
    custom: false,
  }),
  Object.freeze({
    id: 'payment-reverted',
    label: 'Payment reverted',
    technicalTrigger: 'The counterparty or receiving contract reverted the transfer.',
    nextActionFamily: 'show-reason-and-retry-with-edit',
    nextActionLabel: 'Show the revert reason, then retry with an edit.',
    icon: 'revert',
    custom: false,
  }),
  Object.freeze({
    id: 'route-unavailable',
    label: 'Route unavailable',
    technicalTrigger: 'No live route meets the payment constraints.',
    nextActionFamily: 'show-ranked-alternatives',
    nextActionLabel: 'Show the alternative routes, ranked.',
    icon: 'route',
    custom: false,
  }),
  Object.freeze({
    id: 'slippage-beyond-limit',
    label: 'Slippage beyond limit',
    technicalTrigger: 'Execution moved the price beyond the stated tolerance.',
    nextActionFamily: 'retry-with-adjusted-limit',
    nextActionLabel: 'Retry with an adjusted slippage limit.',
    icon: 'slippage',
    custom: false,
  }),
  Object.freeze({
    id: 'transaction-dropped',
    label: 'Transaction dropped',
    technicalTrigger: 'The transaction was not confirmed before its confirmation window elapsed.',
    nextActionFamily: 'investigate',
    nextActionLabel: 'Investigate in the status explorer.',
    icon: 'dropped',
    custom: false,
  }),
  Object.freeze({
    id: 'timed-out-awaiting-confirmation',
    label: 'Timed out awaiting confirmation',
    technicalTrigger: 'The transaction stayed pending longer than its service-level window allows.',
    nextActionFamily: 'investigate-or-rebroadcast',
    nextActionLabel: 'Investigate the status, and re-broadcast only if it is safe to do so.',
    icon: 'clock',
    custom: false,
  }),
  Object.freeze({
    id: 'blocked-by-security-policy',
    label: 'Blocked by security policy',
    technicalTrigger: 'A risk or control gate stopped the execution.',
    nextActionFamily: 'explanation-and-appeal',
    nextActionLabel: 'Show the human explanation and the appeal path.',
    icon: 'shield',
    custom: false,
  }),
  Object.freeze({
    id: 'cancelled-by-user',
    label: 'Cancelled by user',
    technicalTrigger: 'The user cancelled the operation explicitly.',
    nextActionFamily: 'none-recorded-as-event',
    nextActionLabel: 'The cancellation is recorded as an event; there is no retry to offer.',
    icon: 'cancel',
    custom: false,
  }),
]);

/**
 * The certified registry: the contract 07 §2 table as the single typed source.
 * FROZEN — custom errors extend it via `extendErrorReasons` (pure), never by
 * mutating this value.
 */
export const ERROR_REASONS: readonly ErrorReason[] = CERTIFIED_REASONS;

/** Look up one reason by id (fail-closed: unknown ids throw, never free-text). */
export function errorReasonById(id: string, registry: readonly ErrorReason[] = ERROR_REASONS): ErrorReason {
  const reason = registry.find((candidate) => candidate.id === id);
  if (reason === undefined) {
    throw new ViewContractError(
      `unknown error reason '${id}' — reasons come from the registry (contract 07 §2) or a typed extension of it, never inline free-text`,
    );
  }
  return reason;
}

// ---------------------------------------------------------------------------
// Custom extension (contract 07 §2: "Custom errors MUST extend this table")
// ---------------------------------------------------------------------------

/** A custom reason row: extends the registry, reusing the typed action families. */
export interface CustomErrorReason {
  /** Kebab-case id; must not collide with the certified ids or other custom ids. */
  readonly id: string;
  readonly label: string;
  readonly technicalTrigger: string;
  /** Must be one of the typed families — a new action SHAPE is a contract change. */
  readonly nextActionFamily: ErrorNextActionFamily;
  readonly nextActionLabel: string;
  /** Icon token; conventionally kebab-case and unique per reason. */
  readonly icon: string;
}

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Extend the registry with custom reasons — PURE: returns a NEW frozen
 * registry; the base (default: the certified eight) is never mutated.
 * Validation is fail-closed: kebab-case ids, no duplicate ids, non-empty
 * label/trigger/next-action label/icon. A violation throws ViewContractError
 * rather than admitting an untyped reason.
 */
export function extendErrorReasons(
  custom: readonly CustomErrorReason[],
  base: readonly ErrorReason[] = ERROR_REASONS,
): readonly ErrorReason[] {
  const ids = new Set<string>(base.map((reason) => reason.id));
  const extended: ErrorReason[] = [...base];
  for (const entry of custom) {
    if (!KEBAB_ID.test(entry.id)) {
      throw new ViewContractError(`custom error reason id must be kebab-case: ${JSON.stringify(entry.id)}`);
    }
    if (ids.has(entry.id)) {
      throw new ViewContractError(`custom error reason id already exists in the registry: ${entry.id}`);
    }
    if (entry.label.length === 0) {
      throw new ViewContractError(`custom error reason '${entry.id}' must carry a human label`);
    }
    if (entry.technicalTrigger.length === 0) {
      throw new ViewContractError(`custom error reason '${entry.id}' must carry a technical trigger`);
    }
    if (entry.nextActionLabel.length === 0) {
      throw new ViewContractError(`custom error reason '${entry.id}' must carry a next-action label`);
    }
    if (entry.icon.length === 0) {
      throw new ViewContractError(`custom error reason '${entry.id}' must carry an icon token`);
    }
    ids.add(entry.id);
    extended.push(
      Object.freeze({
        id: entry.id,
        label: entry.label,
        technicalTrigger: entry.technicalTrigger,
        nextActionFamily: entry.nextActionFamily,
        nextActionLabel: entry.nextActionLabel,
        icon: entry.icon,
        custom: true,
      }),
    );
  }
  return Object.freeze(extended);
}

// ---------------------------------------------------------------------------
// Error message anatomy (contract 07 §4)
// ---------------------------------------------------------------------------

/**
 * Compose the normative error anatomy —
 * `[What happened] — [Why, if known, in human terms] — [What you can do now]`
 * — from ONE registry row (contract 07 §4). Raw codes never appear alone; the
 * sentence is derived from the registry fields, so no render site can invent
 * free-text. For the `none-recorded-as-event` family (cancelled-by-user) the
 * third slot honestly states the event record instead of offering an action.
 */
export function composeErrorSentence(reason: ErrorReason): string {
  const opening = `${reason.label} — ${reason.technicalTrigger}`;
  if (reason.nextActionFamily === 'none-recorded-as-event') {
    return `${opening}. ${reason.nextActionLabel}`;
  }
  return `${opening}. You can: ${reason.nextActionLabel}`;
}
