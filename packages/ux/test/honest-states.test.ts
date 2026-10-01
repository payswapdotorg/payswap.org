import { describe, expect, it } from 'vitest';

import { ERROR_CATEGORIES, TERMINAL_STATES } from '@payswap/interfaces';

import {
  providerStateDrawer,
  renderErrorActionableView,
  renderExecutionHonestView,
  renderTerminalHonestView,
} from '../src/honest-states.js';
import { makeAttempt, makeProviderEnvelope, NOW_MS } from './fixtures.js';

// ---------------------------------------------------------------------------
// INV-X01: UNKNOWN is never rendered as failure
// ---------------------------------------------------------------------------

describe('renderTerminalHonestView — honest for EVERY terminal state (total)', () => {
  it('covers all nine terminal states without throwing', () => {
    expect(TERMINAL_STATES).toHaveLength(9);
    for (const state of TERMINAL_STATES) {
      expect(() => renderTerminalHonestView(state)).not.toThrow();
    }
  });

  it('UNKNOWN renders as reconciling with a NEUTRAL tone and a reconciliation path (never failed)', () => {
    const view = renderTerminalHonestView('UNKNOWN', {
      authorityRef: 'att_1',
      reconciliationRef: 'recon_case_1',
    });
    expect(view.uiState).toBe('reconciling');
    expect(view.tone).toBe('neutral');
    expect(view.tone).not.toBe('negative');
    expect(view.reconciliationRef).toBe('recon_case_1');
    expect(view.actions.some((action) => action.actionId === 'view-reconciliation-case')).toBe(true);
    expect(view.guidance).toContain('not failure');
  });

  it('WAITING renders as reconciling too (in progress, never a failure)', () => {
    const view = renderTerminalHonestView('WAITING');
    expect(view.uiState).toBe('reconciling');
    expect(view.tone).toBe('neutral');
  });

  it('USER_ACTION_REQUIRED is attention, not a generic error, with the provider envelope path', () => {
    const view = renderTerminalHonestView('USER_ACTION_REQUIRED');
    expect(view.uiState).toBe('action-required');
    expect(view.tone).toBe('attention');
  });

  it('COMPLIANCE_BLOCKED is policy-backed, recorded, and NOT retryable from this surface', () => {
    const view = renderTerminalHonestView('COMPLIANCE_BLOCKED');
    expect(view.uiState).toBe('compliance-blocked');
    expect(view.actions.some((action) => action.actionId === 'view-policy-reason')).toBe(true);
    expect(view.guidance).toContain('not retryable');
  });

  it('FAILED offers retry only as a NEW intent with a fresh idempotency key', () => {
    const view = renderTerminalHonestView('FAILED');
    expect(view.tone).toBe('negative');
    const retry = view.actions.find((action) => action.actionId === 'retry-as-new-intent');
    expect(retry).toBeDefined();
    expect(retry?.label).toContain('new intent');
  });
});

describe('renderExecutionHonestView — one-to-one with the authority attempt state', () => {
  it('OUTCOME_UNKNOWN → reconciling, neutral, with the reconciliation case action (INV-X01/X03)', () => {
    const view = renderExecutionHonestView(makeAttempt('OUTCOME_UNKNOWN'));
    expect(view.uiState).toBe('reconciling');
    expect(view.tone).toBe('neutral');
    expect(view.actions.some((action) => action.actionId === 'view-reconciliation-case')).toBe(true);
  });

  it('AWAITING_CUSTOMER_ACTION renders the preserved provider action VERBATIM (INV-C06)', () => {
    const envelope = makeProviderEnvelope();
    const view = renderExecutionHonestView(
      makeAttempt('AWAITING_CUSTOMER_ACTION', {
        providerState: envelope,
        evidence: [
          {
            evidenceId: 'ev_awaiting',
            kind: 'STATE_OBSERVATION',
            evidenceRef: 'psp-one/obs/42',
            recordedAt: BigInt(NOW_MS),
            providerState: envelope,
            attemptId: makeAttempt('PENDING').attemptId,
          },
        ],
      }),
    );
    expect(view.uiState).toBe('action-required');
    const action = view.actions.find((candidate) => candidate.actionId === 'complete-provider-action:0');
    expect(action?.label).toBe('Complete 3DS authentication with your bank');
    expect(action?.externalOpen?.deepLink).toBe('https://psp-one.example/3ds/pi_ext_42');
  });

  it('intermediate states never render terminal badges', () => {
    for (const state of ['PENDING', 'IN_FLIGHT', 'PARTIALLY_EXECUTED'] as const) {
      const view = renderExecutionHonestView(makeAttempt(state));
      expect(view.uiState).toBe('reconciling');
      expect(view.tone).toBe('neutral');
    }
  });

  it('terminal attempt states render their terminal views with live evidence actions', () => {
    for (const state of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'COMPENSATED', 'RECOVERED'] as const) {
      const view = renderExecutionHonestView(makeAttempt(state));
      expect(view.actions.some((action) => action.available)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Actionable error categories (FRONTEND-STATE-MAPPING section 4)
// ---------------------------------------------------------------------------

describe('renderErrorActionableView — deterministic, actionable, exhaustive', () => {
  it('covers all eight REST error categories without throwing', () => {
    expect(ERROR_CATEGORIES).toHaveLength(8);
    for (const category of ERROR_CATEGORIES) {
      expect(() => renderErrorActionableView(category)).not.toThrow();
    }
  });

  it('EXTERNAL_AMBIGUITY is presented as reconciling/outcome-unknown — never a red error, never a blind retry', () => {
    const view = renderErrorActionableView('EXTERNAL_AMBIGUITY', {
      reconciliationRef: 'recon_case_9',
    });
    expect(view.uiState).toBe('reconciling');
    expect(view.tone).toBe('neutral');
    expect(view.retryAffordance).toBe(false);
    expect(view.reconciliationRef).toBe('recon_case_9');
    expect(view.actions.some((action) => action.actionId === 'view-reconciliation-case')).toBe(true);
  });

  it('POLICY has NO retry affordance (nothing user-side; appeal/contact only)', () => {
    const view = renderErrorActionableView('POLICY');
    expect(view.retryAffordance).toBe(false);
    expect(view.uiState).toBe('compliance-blocked');
    expect(view.actions.some((action) => action.actionId === 'view-policy-decision')).toBe(true);
    expect(view.actions.some((action) => action.actionId === 'retry')).toBe(false);
  });

  it('AUTHORIZATION differs from POLICY: the fix is re-authentication or a wider mandate', () => {
    const view = renderErrorActionableView('AUTHORIZATION');
    expect(view.uiState).toBe('action-required');
    expect(view.actions.some((action) => action.actionId === 're-authenticate')).toBe(true);
    expect(view.actions.some((action) => action.actionId === 'view-required-scope')).toBe(true);
  });

  it('VALIDATION keeps the form editable (fix-inputs action, no retry button)', () => {
    const view = renderErrorActionableView('VALIDATION');
    expect(view.retryAffordance).toBe(false);
    expect(view.actions.some((action) => action.actionId === 'fix-inputs')).toBe(true);
  });

  it('RATE_LIMITED and INTERNAL are the honest retryable categories', () => {
    expect(renderErrorActionableView('RATE_LIMITED').retryAffordance).toBe(true);
    expect(renderErrorActionableView('INTERNAL').retryAffordance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-C06: lossless provider state in views
// ---------------------------------------------------------------------------

describe('providerStateDrawer — the whole envelope, never a flattened status', () => {
  it('round-trips the COMPLETE ProviderStateEnvelope losslessly', () => {
    const envelope = makeProviderEnvelope({
      state: { native: 'requires_action', step: 3, nested: { challenge: '3ds' } },
    });
    const attempt = makeAttempt('AWAITING_CUSTOMER_ACTION', { providerState: envelope });
    const drawer = providerStateDrawer(attempt);
    expect(drawer.present).toBe(true);
    if (!drawer.present) {
      throw new Error('expected drawer');
    }
    // Lossless: the envelope object itself is carried through verbatim.
    expect(drawer.envelope).toEqual(envelope);
    expect(drawer.envelope.state).toEqual({ native: 'requires_action', step: 3, nested: { challenge: '3ds' } });
    expect(drawer.family).toBe('customer_action_required');
    expect(drawer.providerName).toBe('psp-one');
    expect(drawer.externalId).toBe('pi_ext_42');
    expect(drawer.observedAt).toBe('2026-09-30T00:00:00Z');
  });

  it('falls back to the last evidence-carried envelope when no latest envelope exists', () => {
    const envelope = makeProviderEnvelope({ family: 'refund' });
    const attempt = makeAttempt('OUTCOME_UNKNOWN', {
      evidence: [
        {
          evidenceId: 'ev_1',
          kind: 'STATE_OBSERVATION',
          evidenceRef: 'psp-one/obs/1',
          recordedAt: BigInt(NOW_MS),
          providerState: envelope,
          attemptId: makeAttempt('PENDING').attemptId,
        },
      ],
    });
    const drawer = providerStateDrawer(attempt);
    expect(drawer.present).toBe(true);
    if (drawer.present) {
      expect(drawer.family).toBe('refund');
    }
  });

  it('reports absent honestly when no envelope was preserved', () => {
    const drawer = providerStateDrawer(makeAttempt('IN_FLIGHT'));
    expect(drawer.present).toBe(false);
  });
});
