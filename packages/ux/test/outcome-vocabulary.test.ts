/**
 * UX-002 — the eight-state outcome vocabulary bridge tests (contracts 02 §2,
 * 03 §2.2, 07 §5; TL-review R1 which made the set EIGHT):
 *
 * - the vocabulary is exactly `succeeded · processing · failed · refunded ·
 *   partially_refunded · disputed · blocked · dropped` (contract order);
 * - every state carries a label, a tone and guidance; ONLY `failed` renders
 *   as failure;
 * - THE LAW (INV-X01 + contract 07 §5): UNKNOWN-outcome NEVER renders as
 *   failure — it projects to `processing`/`dropped` (never `failed`) for
 *   every injected confirmation-window fact;
 * - the projections are TOTAL over UiState, ExecutionUiState and
 *   TerminalState, and bridge HonestStateView without changing its shape.
 */

import { describe, expect, it } from 'vitest';
import { TERMINAL_STATES, UI_STATES } from '@payswap/interfaces';

import { EXECUTION_UI_STATES } from '../src/command-center.js';
import {
  isOutcomeState,
  OUTCOME_STATES,
  OUTCOME_STATE_VIEWS,
  outcomeStateView,
  projectExecutionUiStateToOutcomeState,
  projectHonestViewToOutcomeState,
  projectTerminalStateToOutcomeState,
  projectUiStateToOutcomeState,
  renderTerminalHonestView,
  renderExecutionHonestView,
} from '../src/honest-states.js';
import { makeAttempt } from './fixtures.js';

// ---------------------------------------------------------------------------
// The vocabulary itself
// ---------------------------------------------------------------------------

describe('the eight-state vocabulary (TL-review R1 set)', () => {
  it('is exactly the eight contract states, in contract order', () => {
    expect(OUTCOME_STATES).toEqual([
      'succeeded',
      'processing',
      'failed',
      'refunded',
      'partially_refunded',
      'disputed',
      'blocked',
      'dropped',
    ]);
  });

  it('every state has a view with label, tone and guidance', () => {
    expect(Object.keys(OUTCOME_STATE_VIEWS).sort()).toEqual([...OUTCOME_STATES].sort());
    for (const state of OUTCOME_STATES) {
      const view = outcomeStateView(state);
      expect(view.state).toBe(state);
      expect(view.label.length).toBeGreaterThan(0);
      expect(['positive', 'neutral', 'attention', 'negative']).toContain(view.tone);
      expect(view.guidance.length).toBeGreaterThan(0);
    }
  });

  it('ONLY failed renders as failure — no state masquerades as failure (contract 07 §1/§5)', () => {
    for (const state of OUTCOME_STATES) {
      expect(outcomeStateView(state).rendersAsFailure).toBe(state === 'failed');
    }
  });

  it('dropped and processing render as "still watching" with a NEUTRAL tone (never red)', () => {
    for (const state of ['processing', 'dropped'] as const) {
      const view = outcomeStateView(state);
      expect(view.tone).toBe('neutral');
      expect(view.guidance).toContain("watching this");
      expect(view.rendersAsFailure).toBe(false);
    }
  });

  it('isOutcomeState narrows; unknown states fail closed', () => {
    expect(isOutcomeState('succeeded')).toBe(true);
    expect(isOutcomeState('pending')).toBe(false);
    expect(() => outcomeStateView('nope' as never)).toThrow(/unknown outcome state/);
  });
});

// ---------------------------------------------------------------------------
// THE LAW: UNKNOWN never renders as failure (INV-X01 + contract 07 §5)
// ---------------------------------------------------------------------------

describe('UNKNOWN-outcome projection law (contract 07 §5)', () => {
  const windowContexts = [
    undefined,
    { withinConfirmationWindow: true },
    { withinConfirmationWindow: false },
  ];

  it('UNKNOWN projects to processing/dropped for EVERY window fact — NEVER to failed', () => {
    for (const context of windowContexts) {
      const projected = projectTerminalStateToOutcomeState('UNKNOWN', context);
      expect(['processing', 'dropped']).toContain(projected);
      expect(projected).not.toBe('failed');
    }
  });

  it('the UNKNOWN projection renders as failure nowhere: view facts for both branches', () => {
    const within = projectTerminalStateToOutcomeState('UNKNOWN', { withinConfirmationWindow: true });
    const outside = projectTerminalStateToOutcomeState('UNKNOWN', { withinConfirmationWindow: false });
    expect(within).toBe('processing');
    expect(outside).toBe('dropped');
    for (const state of [within, outside]) {
      const view = outcomeStateView(state);
      expect(view.rendersAsFailure).toBe(false);
      expect(view.tone).not.toBe('negative');
    }
  });

  it('the honest UNKNOWN view bridges onto the vocabulary without becoming failure', () => {
    const view = renderTerminalHonestView('UNKNOWN');
    const projected = projectHonestViewToOutcomeState(view);
    expect(projected).toBe('processing');
    expect(outcomeStateView(projected).rendersAsFailure).toBe(false);

    const executionView = renderExecutionHonestView(makeAttempt('OUTCOME_UNKNOWN'));
    expect(projectHonestViewToOutcomeState(executionView)).toBe('processing');
  });
});

// ---------------------------------------------------------------------------
// Totality of the projections
// ---------------------------------------------------------------------------

describe('projection totality (one-to-one with the authority vocabularies)', () => {
  it('projectUiStateToOutcomeState is total over the canonical UI_STATES', () => {
    expect(UI_STATES).toHaveLength(8);
    for (const uiState of UI_STATES) {
      expect(() => projectUiStateToOutcomeState(uiState)).not.toThrow();
      expect(OUTCOME_STATES).toContain(projectUiStateToOutcomeState(uiState));
    }
  });

  it('projectExecutionUiStateToOutcomeState is total over EXECUTION_UI_STATES', () => {
    expect(EXECUTION_UI_STATES).toHaveLength(10);
    for (const view of EXECUTION_UI_STATES) {
      expect(() => projectExecutionUiStateToOutcomeState(view)).not.toThrow();
      expect(OUTCOME_STATES).toContain(projectExecutionUiStateToOutcomeState(view));
    }
  });

  it('projectTerminalStateToOutcomeState is total over TERMINAL_STATES', () => {
    expect(TERMINAL_STATES).toHaveLength(9);
    for (const state of TERMINAL_STATES) {
      expect(() => projectTerminalStateToOutcomeState(state)).not.toThrow();
      expect(OUTCOME_STATES).toContain(projectTerminalStateToOutcomeState(state));
    }
  });

  it('the canonical mappings land where the bridge documents them', () => {
    expect(projectUiStateToOutcomeState('fulfilled')).toBe('succeeded');
    expect(projectUiStateToOutcomeState('reconciling')).toBe('processing');
    expect(projectUiStateToOutcomeState('action-required')).toBe('processing');
    expect(projectUiStateToOutcomeState('no-viable-route')).toBe('failed');
    expect(projectUiStateToOutcomeState('compliance-blocked')).toBe('blocked');
    expect(projectUiStateToOutcomeState('expired')).toBe('dropped');
    expect(projectUiStateToOutcomeState('cancelled')).toBe('dropped');
    expect(projectUiStateToOutcomeState('failed')).toBe('failed');

    expect(projectExecutionUiStateToOutcomeState('compensated')).toBe('refunded');
    expect(projectExecutionUiStateToOutcomeState('recovered')).toBe('succeeded');
    expect(projectExecutionUiStateToOutcomeState('cancelled')).toBe('dropped');
    expect(projectExecutionUiStateToOutcomeState('partially-executed')).toBe('processing');

    expect(projectTerminalStateToOutcomeState('FULFILLED')).toBe('succeeded');
    expect(projectTerminalStateToOutcomeState('COMPLIANCE_BLOCKED')).toBe('blocked');
    expect(projectTerminalStateToOutcomeState('EXPIRED')).toBe('dropped');
  });

  it('every honest terminal view bridges without throwing (additive: existing shapes intact)', () => {
    for (const state of TERMINAL_STATES) {
      const view = renderTerminalHonestView(state);
      expect(OUTCOME_STATES).toContain(projectHonestViewToOutcomeState(view));
      // The HonestStateView shape is untouched by the bridge:
      expect(typeof view.headline).toBe('string');
      expect(Array.isArray(view.actions)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tone agreement: the bridge never invents a failure tone
// ---------------------------------------------------------------------------

describe('tone agreement between honest views and outcome states', () => {
  it('a negative-toned honest view always projects to a failure-rendering state (only FAILED)', () => {
    for (const state of TERMINAL_STATES) {
      const view = renderTerminalHonestView(state);
      if (view.tone === 'negative') {
        expect(projectHonestViewToOutcomeState(view)).toBe('failed');
      }
    }
    // Exactly one terminal state renders with the negative tone:
    expect(TERMINAL_STATES.filter((state) => renderTerminalHonestView(state).tone === 'negative')).toEqual([
      'FAILED',
    ]);
  });

  it('NO_VIABLE_ROUTE is the honest attention→failed case (failure reason: route-unavailable)', () => {
    const view = renderTerminalHonestView('NO_VIABLE_ROUTE');
    expect(view.tone).toBe('attention');
    expect(projectHonestViewToOutcomeState(view)).toBe('failed');
  });

  it('the still-watching states (UNKNOWN, WAITING) NEVER project to a failure-rendering state', () => {
    for (const state of ['UNKNOWN', 'WAITING'] as const) {
      const projected = projectTerminalStateToOutcomeState(state);
      expect(outcomeStateView(projected).rendersAsFailure).toBe(false);
    }
  });
});
