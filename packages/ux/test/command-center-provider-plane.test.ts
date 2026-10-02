import { describe, expect, it } from "vitest";
import type { HealthStatus } from '@payswap/connectors';
import { HONEST_COVERAGE_VERDICTS } from '@payswap/capabilities';
import { TERMINAL_STATES } from '@payswap/interfaces';

import {
  COMMAND_CENTER_DOMAINS,
  OPERATOR_ROUTE_OUTCOME_KINDS,
  OPERATOR_ROUTE_OUTCOME_STATES,
  PROVIDER_COVERAGE_UI_STATES,
  PROVIDER_HEALTH_UI_STATES,
  ViewContractError,
  aggregateInbox,
  deriveOperatorRouteOutcomeView,
  deriveProviderCoverageUiState,
  deriveProviderHealthUiState,
  deriveProviderHealthView,
  deriveProviderPlaneView,
  emptySnapshot,
  isOperatorRouteOutcomeState,
  searchCommandCenter,
} from '../src/command-center.js';
import type { ProviderHealthItemInput } from '../src/command-center.js';
import { mapTerminalStateToUi } from '@payswap/interfaces';

/**
 * The canonical vocabularies are imported DIRECTLY from their owning
 * packages: the four HealthStatus tokens (compile-time bound to
 * @payswap/connectors' union) and the honest coverage verdicts (runtime
 * bound to @payswap/capabilities' export). The ux package's boundary
 * forbids importing them in src — the derivations take passthrough tokens
 * and the battery proves the mapping is total over the canonical unions.
 */
const HEALTH_TOKENS: readonly HealthStatus[] = [
  'HEALTHY',
  'DEGRADED',
  'UNHEALTHY',
  'UNKNOWN',
];

function providerFixture(
  overrides: Partial<ProviderHealthItemInput> = {},
): ProviderHealthItemInput {
  return {
    providerName: 'stripe',
    healthStatus: 'HEALTHY',
    lastCheckedAt: '2026-10-02T12:00:00Z',
    connectedInstanceRef: 'cci-stripe-001',
    authorizationMode: 'SCOPED_API_CREDENTIAL',
    coverage: [
      { dimension: 'EUR card pay-in', verdict: 'AVAILABLE', basis: 'eligible matrix row, live probe' },
      { dimension: 'GHS pay-in', verdict: 'NOT_ELIGIBLE', basis: 'Stripe accounts in FR do not support GHS (negative probe datum)' },
      { dimension: 'USD payout', verdict: 'UNKNOWN' },
    ],
    limitations: ['test-mode credentials'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Provider health view states
// ---------------------------------------------------------------------------

describe('deriveProviderHealthUiState', () => {
  it('is TOTAL over the canonical connector HealthStatus union (drift guard)', () => {
    // compile-time: HEALTH_TOKENS is typed readonly HealthStatus[]; the
    // four canonical tokens are exactly what the derivation handles.
    for (const token of HEALTH_TOKENS) {
      expect(() => deriveProviderHealthUiState(token)).not.toThrow();
    }
    expect(HEALTH_TOKENS).toHaveLength(4);
    expect(PROVIDER_HEALTH_UI_STATES).toHaveLength(4);
  });

  it('maps the four health tokens one-to-one', () => {
    expect(deriveProviderHealthUiState('HEALTHY')).toBe('provider-healthy');
    expect(deriveProviderHealthUiState('DEGRADED')).toBe('provider-degraded');
    expect(deriveProviderHealthUiState('UNHEALTHY')).toBe('provider-failure');
    expect(deriveProviderHealthUiStatus_UNKNOWN()).toBe('provider-unknown');
  });

  it('UNKNOWN health is NEVER provider-failure (INV-X01)', () => {
    expect(deriveProviderHealthUiState('UNKNOWN')).not.toBe('provider-failure');
  });

  it('fails closed on a non-canonical token', () => {
    expect(() => deriveProviderHealthUiState('PROBABLY_FINE')).toThrow(ViewContractError);
  });
});

function deriveProviderHealthUiStatus_UNKNOWN(): string {
  return deriveProviderHealthUiState('UNKNOWN');
}

// ---------------------------------------------------------------------------
// Provider coverage view states
// ---------------------------------------------------------------------------

describe('deriveProviderCoverageUiState', () => {
  it('is TOTAL over the canonical HonestCoverageVerdict union (drift guard)', () => {
    for (const verdict of HONEST_COVERAGE_VERDICTS) {
      expect(() => deriveProviderCoverageUiState(verdict)).not.toThrow();
    }
  });

  it('keeps the operator-critical verdicts DISTINCT', () => {
    const unknown = deriveProviderCoverageUiState('UNKNOWN');
    const blocked = deriveProviderCoverageUiState('COMPLIANCE_BLOCKED');
    const noRoute = deriveProviderCoverageUiState('NO_VIABLE_ROUTE');
    const unavailable = deriveProviderCoverageUiState('UNAVAILABLE');
    expect(new Set([unknown, blocked, noRoute, unavailable]).size).toBe(4);
    expect(unknown).toBe('coverage-unknown');
    expect(blocked).toBe('coverage-compliance-blocked');
    expect(noRoute).toBe('coverage-no-viable-route');
  });

  it('fails closed on a non-canonical verdict', () => {
    expect(() => deriveProviderCoverageUiState('MAYBE')).toThrow(ViewContractError);
  });

  it('every coverage view state is reachable from the canonical union', () => {
    const reachable = new Set(
      HONEST_COVERAGE_VERDICTS.map((verdict) => deriveProviderCoverageUiState(verdict)),
    );
    for (const state of PROVIDER_COVERAGE_UI_STATES) {
      expect(reachable.has(state)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The provider health view + plane
// ---------------------------------------------------------------------------

describe('deriveProviderHealthView', () => {
  it('derives the view one-to-one with the observation (authority ref always carried)', () => {
    const view = deriveProviderHealthView(providerFixture());
    expect(view.domain).toBe('PROVIDER');
    expect(view.authorityRef).toBe('cci-stripe-001');
    expect(view.uiState).toBe('provider-healthy');
    expect(view.coverage.map((row) => row.uiState)).toEqual([
      'coverage-available',
      'coverage-not-available',
      'coverage-unknown',
    ]);
    expect(view.coverage[1]?.basis).toContain('negative probe datum');
    expect(view.actions.length).toBeGreaterThan(0);
    expect(view.actions.every((action) => action.available)).toBe(true);
  });

  it('an UNHEALTHY provider carries the rail-outage runbook action', () => {
    const view = deriveProviderHealthView(
      providerFixture({ healthStatus: 'UNHEALTHY', providerName: 'rapyd' }),
    );
    expect(view.uiState).toBe('provider-failure');
    expect(
      view.actions.some((action) => action.actionId === 'open-rail-outage-runbook'),
    ).toBe(true);
  });

  it('a NO_VIABLE_ROUTE coverage row carries the coverage-gap case action', () => {
    const view = deriveProviderHealthView(
      providerFixture({
        coverage: [{ dimension: 'XOF pay-in', verdict: 'NO_VIABLE_ROUTE' }],
      }),
    );
    expect(
      view.actions.some((action) => action.actionId === 'open-coverage-gap-case'),
    ).toBe(true);
  });
});

describe('deriveProviderPlaneView', () => {
  it('aggregates the provider plane with all-state counts', () => {
    const plane = deriveProviderPlaneView([
      providerFixture({ providerName: 'stripe', healthStatus: 'HEALTHY' }),
      providerFixture({
        providerName: 'paystack',
        healthStatus: 'UNHEALTHY',
        connectedInstanceRef: 'cci-paystack-001',
      }),
      providerFixture({
        providerName: 'flutterwave',
        healthStatus: 'UNKNOWN',
        connectedInstanceRef: 'cci-flutterwave-001',
      }),
      providerFixture({
        providerName: 'thunes',
        healthStatus: 'DEGRADED',
        connectedInstanceRef: 'cci-thunes-001',
        coverage: [],
      }),
    ]);
    expect(plane.providers).toHaveLength(4);
    expect(plane.healthCounts).toEqual({
      'provider-healthy': 1,
      'provider-degraded': 1,
      'provider-failure': 1,
      'provider-unknown': 1,
    });
    // coverage rows from the three providers with the fixture coverage set
    expect(plane.coverageCounts['coverage-available']).toBe(3);
    expect(plane.coverageCounts['coverage-not-available']).toBe(3);
    expect(plane.coverageCounts['coverage-unknown']).toBe(3);
    expect(plane.coverageCounts['coverage-compliance-blocked']).toBe(0);
    expect(plane.coverageCounts['coverage-no-viable-route']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The operator four-state distinction
// ---------------------------------------------------------------------------

describe('deriveOperatorRouteOutcomeView', () => {
  const views = OPERATOR_ROUTE_OUTCOME_STATES.map((state) =>
    deriveOperatorRouteOutcomeView(state, { providerName: 'stripe' }),
  );

  it('the four outcome states are canonical terminal states', () => {
    for (const state of OPERATOR_ROUTE_OUTCOME_STATES) {
      expect(TERMINAL_STATES).toContain(state);
    }
    expect(OPERATOR_ROUTE_OUTCOME_STATES).toHaveLength(4);
    expect(OPERATOR_ROUTE_OUTCOME_KINDS).toHaveLength(4);
  });

  it('keeps the four outcomes DISTINCT in kind, uiState, tone, headline, action and runbook', () => {
    expect(new Set(views.map((view) => view.kind)).size).toBe(4);
    expect(new Set(views.map((view) => view.uiState)).size).toBe(4);
    expect(new Set(views.map((view) => view.tone)).size).toBe(3);
    expect(new Set(views.map((view) => view.headline)).size).toBe(4);
    expect(
      new Set(views.map((view) => view.distinctOperatorAction.actionId)).size,
    ).toBe(4);
    expect(new Set(views.map((view) => view.runbookPath)).size).toBe(4);
  });

  it('the UI state is CONSUMED from the canonical terminal mapping (never re-defined)', () => {
    for (const view of views) {
      expect(view.uiState).toBe(mapTerminalStateToUi(view.terminalState));
    }
  });

  it('PROVIDER_FAILURE (FAILED): negative tone, incident action, rail-outage runbook', () => {
    const view = deriveOperatorRouteOutcomeView('FAILED');
    expect(view.kind).toBe('PROVIDER_FAILURE');
    expect(view.tone).toBe('negative');
    expect(view.uiState).toBe('failed');
    expect(view.distinctOperatorAction.actionId).toBe('view-provider-incident');
    expect(view.runbookPath).toBe('rail-outage');
    expect(view.operatorExplanation).toContain('not an unknown outcome');
  });

  it('OUTCOME_UNKNOWN (UNKNOWN): neutral reconciling — NEVER failure (INV-X01)', () => {
    const view = deriveOperatorRouteOutcomeView('UNKNOWN');
    expect(view.kind).toBe('OUTCOME_UNKNOWN');
    expect(view.tone).toBe('neutral');
    expect(view.uiState).toBe('reconciling');
    expect(view.uiState).not.toBe('failed');
    expect(view.distinctOperatorAction.actionId).toBe('open-reconciliation-case');
    expect(view.runbookPath).toBe('unknown-outcome');
  });

  it('COMPLIANCE_BLOCK (COMPLIANCE_BLOCKED): the sanctioned-market policy action', () => {
    const view = deriveOperatorRouteOutcomeView('COMPLIANCE_BLOCKED', {
      reason: 'sanctioned-market: classification SANCTIONED',
    });
    expect(view.kind).toBe('COMPLIANCE_BLOCK');
    expect(view.tone).toBe('attention');
    expect(view.uiState).toBe('compliance-blocked');
    expect(view.distinctOperatorAction.actionId).toBe('view-sanctioned-market-policy');
    expect(view.runbookPath).toBe('compliance');
  });

  it('NO_VIABLE_ROUTE: the coverage-gap case action', () => {
    const view = deriveOperatorRouteOutcomeView('NO_VIABLE_ROUTE');
    expect(view.kind).toBe('NO_VIABLE_ROUTE');
    expect(view.uiState).toBe('no-viable-route');
    expect(view.distinctOperatorAction.actionId).toBe('open-coverage-gap-case');
    expect(view.runbookPath).toBe('coverage-gap');
    expect(view.operatorExplanation).toContain('not a provider failure');
  });

  it('carries the provider and reason context honestly', () => {
    const view = deriveOperatorRouteOutcomeView('FAILED', {
      providerName: 'paystack',
      reason: 'insufficient funds on the rail account',
    });
    expect(view.operatorExplanation).toContain("provider 'paystack'");
    expect(view.operatorExplanation).toContain('insufficient funds');
  });

  it('fails closed for terminal states that carry no operator-distinct outcome', () => {
    for (const state of TERMINAL_STATES) {
      if (isOperatorRouteOutcomeState(state)) {
        continue;
      }
      expect(() => deriveOperatorRouteOutcomeView(state)).toThrow(ViewContractError);
    }
  });
});

// ---------------------------------------------------------------------------
// Command Center integration: search + inbox + the PROVIDER domain
// ---------------------------------------------------------------------------

describe('Command Center provider-plane integration', () => {
  const unhealthyProvider = providerFixture({
    providerName: 'rapyd',
    healthStatus: 'UNHEALTHY',
    connectedInstanceRef: 'cci-rapyd-001',
    coverage: [],
  });
  const unknownProvider = providerFixture({
    providerName: 'thunes',
    healthStatus: 'UNKNOWN',
    connectedInstanceRef: 'cci-thunes-001',
    coverage: [],
  });
  const degradedProvider = providerFixture({
    providerName: 'adyen',
    healthStatus: 'DEGRADED',
    connectedInstanceRef: 'cci-adyen-001',
    coverage: [],
  });

  function snapshotWith(providers: readonly ProviderHealthItemInput[]) {
    return { ...emptySnapshot({ principal: 'operator', roleLabels: ['operator'], agentRefs: [] }), providers };
  }

  it('PROVIDER is a Command Center domain', () => {
    expect(COMMAND_CENTER_DOMAINS).toContain('PROVIDER');
  });

  it('empty snapshots carry an empty provider plane (honest empty state)', () => {
    const empty = emptySnapshot({ principal: 'operator', roleLabels: [], agentRefs: [] });
    expect(empty.providers).toEqual([]);
    expect(searchCommandCenter(empty, { text: 'stripe' }).hits).toEqual([]);
  });

  it('search finds providers by name, health and coverage dimension', () => {
    const snapshot = snapshotWith([
      providerFixture(),
      unhealthyProvider,
    ]);
    const byName = searchCommandCenter(snapshot, { text: 'stripe' });
    expect(byName.hits.some((hit) => hit.domain === 'PROVIDER')).toBe(true);
    const byHealth = searchCommandCenter(snapshot, { text: 'unhealthy' });
    expect(
      byHealth.hits.some((hit) => hit.authorityRef === 'cci-rapyd-001'),
    ).toBe(true);
    const byDimension = searchCommandCenter(snapshot, { text: 'GHS' });
    expect(
      byDimension.hits.some((hit) => hit.authorityRef === 'cci-stripe-001'),
    ).toBe(true);
    const scanned = searchCommandCenter(snapshot, { text: 'stripe' }).scanned;
    expect(scanned.PROVIDER).toBe(2);
  });

  it('the inbox surfaces provider failures as ACTION_REQUIRED (distinct from UNKNOWN)', () => {
    const inbox = aggregateInbox(
      snapshotWith([unhealthyProvider, unknownProvider, degradedProvider]),
      1_766_000_000_000,
    );
    const entries = inbox.entries.filter((entry) => entry.domain === 'PROVIDER');
    expect(entries).toHaveLength(3);

    const failure = entries.find((entry) => entry.authorityRef === 'cci-rapyd-001');
    expect(failure?.urgency).toBe('ACTION_REQUIRED');
    expect(failure?.uiState).toBe('failed');
    expect(failure?.reason).toContain('distinct from UNKNOWN');

    const unknown = entries.find((entry) => entry.authorityRef === 'cci-thunes-001');
    expect(unknown?.urgency).toBe('RECONCILING');
    expect(unknown?.uiState).toBe('reconciling');
    expect(unknown?.reason).toContain('not failure');

    const degraded = entries.find((entry) => entry.authorityRef === 'cci-adyen-001');
    expect(degraded?.urgency).toBe('REVIEW');
  });

  it('a HEALTHY provider does not clutter the inbox (no dead entries)', () => {
    const inbox = aggregateInbox(
      snapshotWith([providerFixture()]),
      1_766_000_000_000,
    );
    expect(
      inbox.entries.filter((entry) => entry.domain === 'PROVIDER'),
    ).toEqual([]);
  });

  it('every provider inbox entry has an available action (no dead buttons)', () => {
    const inbox = aggregateInbox(
      snapshotWith([unhealthyProvider, unknownProvider, degradedProvider]),
      1_766_000_000_000,
    );
    for (const entry of inbox.entries) {
      expect(entry.actions.some((action) => action.available)).toBe(true);
    }
  });
});
