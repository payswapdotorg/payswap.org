/**
 * @payswap/ux — honest UNKNOWN and error states (W3-006).
 *
 * spec/experience/FRONTEND-STATE-MAPPING.md (authoritative mapping doc):
 * - INV-X01: UNKNOWN is NEVER mapped to FAILED — it renders as
 *   `reconciling` with the reconciliation/action path surfaced;
 * - section 2/3: terminal and intermediate protocol states map to canonical
 *   UI states with tone, copy and actions — consumed here from
 *   @payswap/interfaces `mapTerminalStateToUi` (never re-defined);
 * - section 4: every REST error category maps to a deterministic, ACTIONABLE
 *   UI treatment — EXTERNAL_AMBIGUITY is presented as reconciling/
 *   outcome-unknown (never a red error) and links to reconciliation;
 * - INV-C06: provider state is preserved LOSSLESSLY in views — the view
 *   renders the whole ProviderStateEnvelope (`providerStateDrawer`), never a
 *   flattened status.
 *
 * Deterministic by construction: pure derivations, no DOM, no network.
 */

import type { ExecutionAttempt, ProviderExecutionEvidence } from '@payswap/execution';
import { pendingCustomerActions } from '@payswap/execution';
import type { ErrorCategory, TerminalState, UiState } from '@payswap/interfaces';
import { ERROR_CATEGORIES, mapTerminalStateToUi } from '@payswap/interfaces';

import type { ExecutionUiState, ViewAction } from './command-center.js';
import { ViewContractError } from './command-center.js';

// ---------------------------------------------------------------------------
// The honest state view
// ---------------------------------------------------------------------------

export type HonestTone = 'positive' | 'neutral' | 'attention' | 'negative';

export interface HonestStateView {
  readonly uiState: UiState;
  readonly tone: HonestTone;
  readonly headline: string;
  readonly guidance: string;
  readonly actions: readonly ViewAction[];
  /** Reference to the reconciliation case for UNKNOWN/WAITING outcomes. */
  readonly reconciliationRef?: string;
}

/** Render ANY terminal protocol state honestly (total over TERMINAL_STATES). */
export function renderTerminalHonestView(
  state: TerminalState,
  refs?: { readonly authorityRef?: string; readonly reconciliationRef?: string },
): HonestStateView {
  const uiState = mapTerminalStateToUi(state);
  const authorityRef = refs?.authorityRef ?? `terminal:${state}`;
  const base = { authorityRef };
  const reconciliationRef = refs?.reconciliationRef;

  switch (state) {
    case 'FULFILLED':
      return {
        uiState,
        tone: 'positive',
        headline: 'Completed',
        guidance: 'Evidence links are available; recourse is bounded by the merchant policy.',
        actions: Object.freeze([
          { actionId: 'view-receipt', label: 'View receipt and evidence', kind: 'EVIDENCE_VIEW', ...base, available: true },
        ]),
      };
    case 'WAITING':
      return {
        uiState,
        tone: 'neutral',
        headline: 'Reconciling — awaiting confirmation',
        guidance: 'External settlement is pending; this is in progress, not a failure.',
        actions: Object.freeze([
          { actionId: 'refresh-status', label: 'Refresh from authoritative state', kind: 'NAVIGATION', ...base, available: true },
          ...(reconciliationRef === undefined
            ? []
            : [
                {
                  actionId: 'view-reconciliation-case',
                  label: 'View the reconciliation case',
                  kind: 'NAVIGATION' as const,
                  ...base,
                  available: true,
                },
              ]),
        ]),
        ...(reconciliationRef === undefined ? {} : { reconciliationRef }),
      };
    case 'USER_ACTION_REQUIRED':
      return {
        uiState,
        tone: 'attention',
        headline: 'Action required',
        guidance:
          'A provider-required action (e.g. customer authentication) is preserved verbatim and must be completed on the trusted surface.',
        actions: Object.freeze([
          { actionId: 'view-provider-envelope', label: 'View the provider action verbatim', kind: 'EVIDENCE_VIEW', ...base, available: true },
        ]),
      };
    case 'NO_VIABLE_ROUTE':
      return {
        uiState,
        tone: 'attention',
        headline: 'No viable route for this request',
        guidance: 'Acceptance, geography, currency or liquidity constraints exclude every route.',
        actions: Object.freeze([
          { actionId: 'adjust-constraints', label: 'Adjust constraints', kind: 'NAVIGATION', ...base, available: true },
          { actionId: 'connect-capability', label: 'Connect a capability', kind: 'NAVIGATION', ...base, available: true },
        ]),
      };
    case 'COMPLIANCE_BLOCKED':
      return {
        uiState,
        tone: 'attention',
        headline: 'Blocked by compliance policy',
        guidance: 'The block is policy/evidence backed and recorded (INV-R04). It is not retryable from this surface.',
        actions: Object.freeze([
          { actionId: 'view-policy-reason', label: 'View the recorded policy reason', kind: 'EVIDENCE_VIEW', ...base, available: true },
          { actionId: 'contact-compliance', label: 'Contact compliance', kind: 'EXTERNAL_OPEN', ...base, available: true, externalOpen: { systemName: 'compliance' } },
        ]),
      };
    case 'EXPIRED':
      return {
        uiState,
        tone: 'neutral',
        headline: 'Expired before completion',
        guidance: 'The timing window passed. Re-issue as a new intent — the expired record is immutable history.',
        actions: Object.freeze([
          { actionId: 'reissue-as-new-intent', label: 'Re-issue as a new intent', kind: 'NAVIGATION', ...base, available: true },
        ]),
      };
    case 'CANCELLED':
      return {
        uiState,
        tone: 'neutral',
        headline: 'Cancelled',
        guidance: 'Cancellation and its authorization record are preserved.',
        actions: Object.freeze([
          { actionId: 'view-history', label: 'View history', kind: 'EVIDENCE_VIEW', ...base, available: true },
        ]),
      };
    case 'FAILED':
      return {
        uiState,
        tone: 'negative',
        headline: 'Failed',
        guidance: 'The failure reason comes from protocol evidence, not inference. Retry only as a NEW intent with a fresh idempotency key.',
        actions: Object.freeze([
          { actionId: 'investigate-evidence', label: 'Investigate the evidence', kind: 'EVIDENCE_VIEW', ...base, available: true },
          { actionId: 'retry-as-new-intent', label: 'Retry as a new intent (fresh key)', kind: 'NAVIGATION', ...base, available: true },
        ]),
      };
    case 'UNKNOWN':
      // INV-X01: UNKNOWN is never FAILED. It always requires reconciliation.
      return {
        uiState,
        tone: 'neutral',
        headline: 'Outcome unknown — reconciling',
        guidance:
          'Absence of knowledge is not failure. Reconciliation is authoritative for ambiguous external effects (INV-X03); the external write is never blindly retried (INV-X02).',
        actions: Object.freeze([
          { actionId: 'wait-and-refresh', label: 'Wait and refresh from authoritative state', kind: 'NAVIGATION', ...base, available: true },
          ...(reconciliationRef === undefined
            ? []
            : [
                {
                  actionId: 'view-reconciliation-case',
                  label: 'View the reconciliation case',
                  kind: 'NAVIGATION' as const,
                  ...base,
                  available: true,
                },
              ]),
        ]),
        ...(reconciliationRef === undefined ? {} : { reconciliationRef }),
      };
    default: {
      const exhaustive: never = state;
      throw new ViewContractError(`unhandled terminal state: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Honest execution views
// ---------------------------------------------------------------------------

/** Render an execution attempt honestly (one-to-one with the authority state). */
export function renderExecutionHonestView(attempt: ExecutionAttempt): HonestStateView {
  const authorityRef = attempt.attemptId;
  const base = { authorityRef };
  switch (attempt.state) {
    case 'OUTCOME_UNKNOWN':
      return {
        uiState: 'reconciling',
        tone: 'neutral',
        headline: 'Outcome unknown — reconciling',
        guidance:
          'The external effect is ambiguous; reconciliation is authoritative and the write is never blindly retried.',
        actions: Object.freeze([
          { actionId: 'view-reconciliation-case', label: 'View the reconciliation case', kind: 'NAVIGATION', ...base, available: true },
          {
            actionId: 'view-provider-envelope',
            label: 'View the provider state envelope',
            kind: 'EVIDENCE_VIEW',
            ...base,
            available: attempt.providerState !== undefined,
            ...(attempt.providerState === undefined
              ? { unavailableReason: 'no provider state envelope preserved on this attempt yet' }
              : {}),
          },
        ]),
      };
    case 'AWAITING_CUSTOMER_ACTION': {
      const actions = pendingCustomerActions(attempt);
      const view: HonestStateView = {
        uiState: 'action-required',
        tone: 'attention',
        headline: 'Action required',
        guidance:
          actions.length > 0
            ? 'Complete the provider-required action, rendered verbatim from the preserved provider state (INV-C06).'
            : 'A customer action is required; the provider envelope details are available in evidence.',
        actions: Object.freeze([
          ...actions.map((required, index) => ({
            actionId: `complete-provider-action:${index}`,
            label: required.message,
            kind: 'EXTERNAL_OPEN' as const,
            ...base,
            available: true,
            ...(required.deepLink === undefined
              ? { externalOpen: { systemName: 'provider' } }
              : { externalOpen: { systemName: 'provider', deepLink: required.deepLink } }),
          })),
          {
            actionId: 'view-provider-envelope',
            label: 'View the provider state envelope',
            kind: 'EVIDENCE_VIEW',
            ...base,
            available: true,
          },
        ]),
      };
      return view;
    }
    case 'PENDING':
    case 'IN_FLIGHT':
    case 'PARTIALLY_EXECUTED':
      return {
        uiState: 'reconciling',
        tone: 'neutral',
        headline: 'In progress',
        guidance: 'The attempt is executing; no terminal badge is shown for intermediate states.',
        actions: Object.freeze([
          { actionId: 'view-attempt-status', label: 'View attempt status', kind: 'NAVIGATION', ...base, available: true },
        ]),
      };
    case 'SUCCEEDED':
      return renderTerminalHonestView('FULFILLED', { authorityRef });
    case 'FAILED':
      return renderTerminalHonestView('FAILED', { authorityRef });
    case 'CANCELLED':
      return renderTerminalHonestView('CANCELLED', { authorityRef });
    case 'COMPENSATED':
      return {
        uiState: 'cancelled',
        tone: 'neutral',
        headline: 'Compensated',
        guidance: 'The partial effect was compensated by the declared compensation capability.',
        actions: Object.freeze([
          { actionId: 'view-compensation-evidence', label: 'View compensation evidence', kind: 'EVIDENCE_VIEW', ...base, available: true },
        ]),
      };
    case 'RECOVERED':
      return {
        uiState: 'fulfilled',
        tone: 'positive',
        headline: 'Recovered',
        guidance: 'An explicit recovery rule resolved the attempt (INV-X04 recovery states).',
        actions: Object.freeze([
          { actionId: 'view-recovery-evidence', label: 'View recovery evidence', kind: 'EVIDENCE_VIEW', ...base, available: true },
        ]),
      };
    default: {
      const exhaustive: never = attempt.state;
      throw new ViewContractError(`unhandled execution attempt state: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Actionable error views (FRONTEND-STATE-MAPPING section 4)
// ---------------------------------------------------------------------------

export interface ErrorActionableView {
  readonly category: ErrorCategory;
  readonly uiState: UiState;
  readonly tone: HonestTone;
  readonly headline: string;
  readonly guidance: string;
  readonly retryAffordance: boolean;
  readonly reconciliationRef?: string;
  readonly actions: readonly ViewAction[];
}

/**
 * Render ANY REST error category as an honest, actionable view. The mapping is
 * exhaustive over ERROR_CATEGORIES (adding a category without a case is a
 * compile error).
 */
export function renderErrorActionableView(
  category: ErrorCategory,
  error?: {
    readonly code?: string;
    readonly message?: string;
    readonly reconciliationRef?: string;
  },
): ErrorActionableView {
  const authorityRef = `error:${category}`;
  const base = { authorityRef };
  const reconciliationRef = error?.reconciliationRef;

  if (!(ERROR_CATEGORIES as readonly string[]).includes(category)) {
    throw new ViewContractError(`unknown error category: ${String(category)}`);
  }

  switch (category) {
    case 'VALIDATION':
      return {
        category,
        uiState: 'action-required',
        tone: 'attention',
        headline: 'Fix the highlighted input',
        guidance: 'The form stays editable; the copy names the invalid input.',
        retryAffordance: false,
        actions: Object.freeze([
          { actionId: 'fix-inputs', label: 'Fix the invalid inputs', kind: 'NAVIGATION', ...base, available: true },
        ]),
      };
    case 'NOT_FOUND':
      return {
        category,
        uiState: 'action-required',
        tone: 'neutral',
        headline: 'Not found',
        guidance: 'Nothing matched this reference. This is never presented as a payment failure.',
        retryAffordance: false,
        actions: Object.freeze([
          { actionId: 'search-again', label: 'Search for the record', kind: 'NAVIGATION', ...base, available: true },
        ]),
      };
    case 'AUTHORIZATION':
      return {
        category,
        uiState: 'action-required',
        tone: 'attention',
        headline: 'Re-authentication or a wider mandate is required',
        guidance:
          'The caller lacks delegated power (fix: authenticate or get mandate scope). This is distinct from POLICY.',
        retryAffordance: false,
        actions: Object.freeze([
          { actionId: 're-authenticate', label: 'Re-authenticate', kind: 'TRUSTED_SURFACE', ...base, available: true },
          { actionId: 'view-required-scope', label: 'View the required mandate scope', kind: 'EVIDENCE_VIEW', ...base, available: true },
        ]),
      };
    case 'POLICY':
      return {
        category,
        uiState: 'compliance-blocked',
        tone: 'attention',
        headline: 'Disallowed by versioned policy',
        guidance:
          'The action itself is disallowed by hard constraints (fix: nothing user-side; appeal/contact path only). No retry affordance.',
        retryAffordance: false,
        actions: Object.freeze([
          { actionId: 'view-policy-decision', label: 'View the recorded, versioned policy reason', kind: 'EVIDENCE_VIEW', ...base, available: true },
          { actionId: 'contact-support', label: 'Contact support / appeal', kind: 'EXTERNAL_OPEN', ...base, available: true, externalOpen: { systemName: 'support' } },
        ]),
      };
    case 'CONFLICT':
      return {
        category,
        uiState: 'action-required',
        tone: 'attention',
        headline: 'State conflict',
        guidance: 'The authoritative state has moved on; the current record is shown.',
        retryAffordance: false,
        actions: Object.freeze([
          { actionId: 'view-current-state', label: 'View the current authoritative state', kind: 'EVIDENCE_VIEW', ...base, available: true },
        ]),
      };
    case 'EXTERNAL_AMBIGUITY':
      // INV-X01/INV-X03: presented as reconciling/outcome-unknown — never a
      // red error, never a blind retry (INV-X02).
      return {
        category,
        uiState: 'reconciling',
        tone: 'neutral',
        headline: 'Outcome unknown — reconciling',
        guidance:
          'The external effect is ambiguous; reconciliation owns the resolution and the write is not blindly retried.',
        retryAffordance: false,
        actions: Object.freeze([
          ...(reconciliationRef === undefined
            ? []
            : [
                {
                  actionId: 'view-reconciliation-case',
                  label: 'View the reconciliation case',
                  kind: 'NAVIGATION' as const,
                  ...base,
                  available: true,
                },
              ]),
          { actionId: 'wait-and-refresh', label: 'Wait and refresh', kind: 'NAVIGATION', ...base, available: true },
        ]),
        ...(reconciliationRef === undefined ? {} : { reconciliationRef }),
      };
    case 'RATE_LIMITED':
      return {
        category,
        uiState: 'action-required',
        tone: 'neutral',
        headline: 'Throttled',
        guidance: 'Too many requests; retry after the indicated window (queue-safe).',
        retryAffordance: true,
        actions: Object.freeze([
          { actionId: 'retry-after-window', label: 'Retry after the indicated window', kind: 'NAVIGATION', ...base, available: true },
        ]),
      };
    case 'INTERNAL':
      return {
        category,
        uiState: 'failed',
        tone: 'negative',
        headline: 'Something went wrong on our side',
        guidance: 'No financial-state claims are made from this error; retry and support paths are offered.',
        retryAffordance: true,
        actions: Object.freeze([
          { actionId: 'retry', label: 'Retry', kind: 'NAVIGATION', ...base, available: true },
          { actionId: 'contact-support', label: 'Contact support', kind: 'EXTERNAL_OPEN', ...base, available: true, externalOpen: { systemName: 'support' } },
        ]),
      };
    default: {
      const exhaustive: never = category;
      throw new ViewContractError(`unhandled error category: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Lossless provider state in views (INV-C06)
// ---------------------------------------------------------------------------

/**
 * The provider-state drawer: the view renders the WHOLE
 * ProviderStateEnvelope — raw provider state, classification, history,
 * actionRequired, timestamps and provenance — never a flattened status. The
 * canonical state controls the badge; the envelope enriches the detail view.
 */
export interface ProviderStateDrawer {
  readonly present: true;
  readonly envelope: NonNullable<ProviderExecutionEvidence['providerState']>;
  readonly family: string;
  readonly lifecycleStep: string;
  readonly providerName: string;
  readonly providerVersion: string;
  readonly externalId: string;
  readonly revision: string;
  readonly observedAt: string;
  readonly actionRequiredMessage?: string;
  readonly actionRequiredDeepLink?: string;
}

/**
 * Build the lossless provider-state drawer for an attempt. Prefers the
 * attempt's latest preserved envelope; otherwise the last evidence-carried
 * envelope. The envelope is passed through VERBATIM — the drawer output
 * still contains the complete envelope object (INV-C06 round-trip).
 */
export function providerStateDrawer(
  attempt: ExecutionAttempt,
): ProviderStateDrawer | { readonly present: false } {
  const envelope = attempt.providerState ?? lastEvidenceEnvelope(attempt);
  if (envelope === undefined) {
    return { present: false };
  }
  return {
    present: true,
    envelope,
    family: envelope.classification.family,
    lifecycleStep: envelope.classification.lifecycleStep,
    providerName: envelope.provider.name,
    providerVersion: envelope.provider.version,
    externalId: envelope.object.externalId,
    revision: envelope.revision,
    observedAt: envelope.timestamps.observedAt,
    ...(envelope.actionRequired === undefined
      ? {}
      : {
          actionRequiredMessage: envelope.actionRequired.message,
          ...(envelope.actionRequired.deepLink === undefined
            ? {}
            : { actionRequiredDeepLink: envelope.actionRequired.deepLink }),
        }),
  };
}

function lastEvidenceEnvelope(attempt: ExecutionAttempt): NonNullable<ProviderExecutionEvidence['providerState']> | undefined {
  for (let index = attempt.evidence.length - 1; index >= 0; index -= 1) {
    const evidence = attempt.evidence[index];
    if (evidence !== undefined && evidence.providerState !== undefined) {
      return evidence.providerState;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The eight-state outcome vocabulary (contract 03 §2.2 / 07 §5 — UX-002)
// ---------------------------------------------------------------------------
//
// The contract set's normative state set (TL-review R1 made it EIGHT by adding
// `partially_refunded`): the StatusChip vocabulary every money-object surface
// renders. This bridge PROJECTS the existing HonestStateView/UiState/tones
// onto it — additive: every existing export above keeps its shape.

/** The eight normative outcome states, in contract order. */
export const OUTCOME_STATES = [
  'succeeded',
  'processing',
  'failed',
  'refunded',
  'partially_refunded',
  'disputed',
  'blocked',
  'dropped',
] as const;

export type OutcomeStateId = (typeof OUTCOME_STATES)[number];

/** Narrow an unknown value to an OutcomeStateId. */
export function isOutcomeState(value: unknown): value is OutcomeStateId {
  return typeof value === 'string' && (OUTCOME_STATES as readonly string[]).includes(value);
}

/**
 * One outcome state's rendering contract: the human label, the HonestTone, and
 * the failure-rendering FACT. Only `failed` renders as failure — per contract
 * 07 §5, `dropped` and `processing` render as "We're still watching this"
 * (INV-X01: UNKNOWN never renders as failure), and `blocked` is an honest
 * attention stop, not a failure.
 */
export interface OutcomeStateView {
  readonly state: OutcomeStateId;
  readonly label: string;
  readonly tone: HonestTone;
  /** True ONLY for `failed` — no state masquerades as failure (contract 07 §1). */
  readonly rendersAsFailure: boolean;
  readonly guidance: string;
}

const OUTCOME_STATE_VIEWS_TABLE: Readonly<Record<OutcomeStateId, OutcomeStateView>> = Object.freeze({
  succeeded: Object.freeze({
    state: 'succeeded',
    label: 'Succeeded',
    tone: 'positive',
    rendersAsFailure: false,
    guidance: 'Completed with recorded evidence; recourse is bounded by the merchant policy.',
  }),
  processing: Object.freeze({
    state: 'processing',
    label: 'Processing',
    tone: 'neutral',
    rendersAsFailure: false,
    guidance: "We're still watching this — in progress, not a failure.",
  }),
  failed: Object.freeze({
    state: 'failed',
    label: 'Failed',
    tone: 'negative',
    rendersAsFailure: true,
    guidance: 'The failure reason comes from protocol evidence, not inference.',
  }),
  refunded: Object.freeze({
    state: 'refunded',
    label: 'Refunded',
    tone: 'neutral',
    rendersAsFailure: false,
    guidance: 'The full amount was returned; the refund record and its evidence are preserved.',
  }),
  partially_refunded: Object.freeze({
    state: 'partially_refunded',
    label: 'Partially refunded',
    tone: 'attention',
    rendersAsFailure: false,
    guidance: 'Part of the amount was returned; the remaining balance and refund record are shown.',
  }),
  disputed: Object.freeze({
    state: 'disputed',
    label: 'Disputed',
    tone: 'attention',
    rendersAsFailure: false,
    guidance: 'A dispute is open; the provider lifecycle state is preserved verbatim and a response may be due.',
  }),
  blocked: Object.freeze({
    state: 'blocked',
    label: 'Blocked',
    tone: 'attention',
    rendersAsFailure: false,
    guidance: 'A security or policy control stopped execution; the block is recorded, with an explanation and appeal path.',
  }),
  dropped: Object.freeze({
    state: 'dropped',
    label: 'Dropped',
    tone: 'neutral',
    rendersAsFailure: false,
    guidance: "Not confirmed within its window — we're still watching this, never rendered as failure.",
  }),
});

/** The view contract for each of the eight states (contract 03 §2.2 + 07 §5). */
export const OUTCOME_STATE_VIEWS: Readonly<Record<OutcomeStateId, OutcomeStateView>> =
  OUTCOME_STATE_VIEWS_TABLE;

/** Look up one state's rendering contract (fail-closed on unknown states). */
export function outcomeStateView(state: OutcomeStateId): OutcomeStateView {
  const view = OUTCOME_STATE_VIEWS[state];
  if (view === undefined) {
    throw new ViewContractError(`unknown outcome state: ${String(state)}`);
  }
  return view;
}

// ——— The projections (total, deterministic) ————————————————————————————

/**
 * Project the canonical `UiState` (from @payswap/interfaces) onto the
 * eight-state vocabulary. Total over UI_STATES; the mapping is one-way
 * projection, never a re-definition of the canonical states.
 *
 * - fulfilled → succeeded; failed → failed; compliance-blocked → blocked;
 * - reconciling / action-required → processing (still in flight / customer
 *   action pending — the object is not finished, and never a failure);
 * - no-viable-route → failed (failure reason: route-unavailable);
 * - expired / cancelled → dropped (did not complete; not rendered as failure).
 */
export function projectUiStateToOutcomeState(uiState: UiState): OutcomeStateId {
  switch (uiState) {
    case 'fulfilled':
      return 'succeeded';
    case 'reconciling':
      return 'processing';
    case 'action-required':
      return 'processing';
    case 'no-viable-route':
      return 'failed';
    case 'compliance-blocked':
      return 'blocked';
    case 'expired':
      return 'dropped';
    case 'cancelled':
      return 'dropped';
    case 'failed':
      return 'failed';
    default: {
      const exhaustive: never = uiState;
      throw new ViewContractError(`unhandled ui state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Project an execution view state (command-center.ts EXECUTION_UI_STATES)
 * onto the eight-state vocabulary. Total over EXECUTION_UI_STATES:
 * compensated → refunded (the partial effect was compensated — money returned);
 * recovered → succeeded; cancelled → dropped; every intermediate state →
 * processing.
 */
export function projectExecutionUiStateToOutcomeState(view: ExecutionUiState): OutcomeStateId {
  switch (view) {
    case 'not-started':
      return 'processing';
    case 'executing':
      return 'processing';
    case 'action-required':
      return 'processing';
    case 'partially-executed':
      return 'processing';
    case 'reconciling':
      return 'processing';
    case 'fulfilled':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'dropped';
    case 'compensated':
      return 'refunded';
    case 'recovered':
      return 'succeeded';
    default: {
      const exhaustive: never = view;
      throw new ViewContractError(`unhandled execution ui state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Context for the UNKNOWN-outcome projection (contract 07 §5). This is an
 * AUTHORITY FACT injected by the caller — never ambient time (package law):
 * whether the outcome is still within the confirmation watch period.
 */
export interface UnknownOutcomeProjectionContext {
  /** Default true: reconciliation is still watching the outcome. */
  readonly withinConfirmationWindow?: boolean;
}

/**
 * Project a terminal protocol state onto the eight-state vocabulary. Total
 * over TERMINAL_STATES. THE LAW (INV-X01 + contract 07 §5): UNKNOWN projects
 * to `processing` while within its confirmation window and to `dropped` once
 * the window has passed — NEVER to `failed`. Absence of knowledge is not
 * failure; rendering it red is the recorded anti-pattern.
 */
export function projectTerminalStateToOutcomeState(
  state: TerminalState,
  context?: UnknownOutcomeProjectionContext,
): OutcomeStateId {
  switch (state) {
    case 'FULFILLED':
      return 'succeeded';
    case 'WAITING':
      return 'processing';
    case 'USER_ACTION_REQUIRED':
      return 'processing';
    case 'NO_VIABLE_ROUTE':
      return 'failed';
    case 'COMPLIANCE_BLOCKED':
      return 'blocked';
    case 'EXPIRED':
      return 'dropped';
    case 'CANCELLED':
      return 'dropped';
    case 'FAILED':
      return 'failed';
    case 'UNKNOWN':
      // INV-X01 / contract 07 §5: UNKNOWN is NEVER 'failed' — it projects to
      // processing/dropped depending on the injected confirmation-window fact.
      return context?.withinConfirmationWindow === false ? 'dropped' : 'processing';
    default: {
      const exhaustive: never = state;
      throw new ViewContractError(`unhandled terminal state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Bridge an HonestStateView (this module's rendering contract) onto the
 * eight-state vocabulary: the view's canonical uiState projects onto the
 * outcome state. UNKNOWN-derived views (uiState 'reconciling') land on
 * `processing` — never `failed`.
 */
export function projectHonestViewToOutcomeState(view: HonestStateView): OutcomeStateId {
  return projectUiStateToOutcomeState(view.uiState);
}
