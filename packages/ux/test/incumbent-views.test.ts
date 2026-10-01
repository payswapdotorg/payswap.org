import { describe, expect, it } from 'vitest';

import {
  assertProvenanceWithinBound,
  deriveIncumbentContextView,
  deriveProvenanceLabel,
  PROVENANCE_STRENGTH_ORDER,
  provenanceNotStrongerThan,
  provenanceRank,
  reconcileViewAgainstIncumbent,
} from '../src/incumbent-views.js';

// ---------------------------------------------------------------------------
// INV-E04: provenance strength order
// ---------------------------------------------------------------------------

describe('deriveProvenanceLabel — deterministic label derivation (INV-E04)', () => {
  it('maps every declared source to its strength', () => {
    expect(deriveProvenanceLabel({ source: 'BROWSER_LOCAL' }).strength).toBe('UNVERIFIED_BROWSER_ARTIFACT');
    expect(deriveProvenanceLabel({ source: 'USER_REPORT' }).strength).toBe('USER_REPORTED');
    expect(deriveProvenanceLabel({ source: 'CONNECTED_INSTANCE' }).strength).toBe('CONNECTOR_OBSERVED');
    expect(deriveProvenanceLabel({ source: 'PROVIDER_ENVELOPE' }).strength).toBe('AUTHENTICATED_PROVIDER_RECORD');
  });

  it('the strength order is strictly increasing (browser artifact is the weakest)', () => {
    expect(PROVENANCE_STRENGTH_ORDER[0]).toBe('UNVERIFIED_BROWSER_ARTIFACT');
    for (let index = 1; index < PROVENANCE_STRENGTH_ORDER.length; index += 1) {
      const weaker = PROVENANCE_STRENGTH_ORDER[index - 1];
      const stronger = PROVENANCE_STRENGTH_ORDER[index];
      if (weaker === undefined || stronger === undefined) {
        throw new Error('unreachable');
      }
      expect(provenanceRank(stronger)).toBeGreaterThan(provenanceRank(weaker));
    }
  });

  it('labels carry the incumbent system name and external reference when present', () => {
    const label = deriveProvenanceLabel({
      source: 'PROVIDER_ENVELOPE',
      systemName: 'psp-one',
      externalRef: 'pi_ext_42',
      observedAt: '2026-09-30T00:00:00Z',
    });
    expect(label.label).toBe('AUTHENTICATED_PROVIDER_RECORD @ psp-one');
    expect(label.systemName).toBe('psp-one');
    expect(label.externalRef).toBe('pi_ext_42');
    expect(label.note).toContain('ProviderStateEnvelope');
  });

  it('an unknown source is a contract violation (fail closed)', () => {
    expect(() => deriveProvenanceLabel({ source: 'TELEPATHY' as never })).toThrow();
  });
});

describe('provenanceNotStrongerThan / assertProvenanceWithinBound — the hard INV-E04 gate', () => {
  it('a browser artifact is never stronger than any authenticated provenance', () => {
    for (const bound of PROVENANCE_STRENGTH_ORDER) {
      expect(provenanceNotStrongerThan('UNVERIFIED_BROWSER_ARTIFACT', bound)).toBe(true);
    }
  });

  it('claiming stronger provenance than the source establishes is a violation', () => {
    expect(() =>
      assertProvenanceWithinBound('AUTHENTICATED_PROVIDER_RECORD', 'USER_REPORTED', 'test view'),
    ).toThrow(/INV-E04/);
    expect(() =>
      assertProvenanceWithinBound('CONNECTOR_OBSERVED', 'UNVERIFIED_BROWSER_ARTIFACT', 'test view'),
    ).toThrow(/INV-E04/);
    expect(() => assertProvenanceWithinBound('USER_REPORTED', 'USER_REPORTED', 'test view')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Incumbent context/action views — provenance VISIBILITY
// ---------------------------------------------------------------------------

describe('deriveIncumbentContextView — which system is authoritative for what', () => {
  it('a context-only incumbent stays the system of record with an open-in-incumbent action', () => {
    const view = deriveIncumbentContextView({
      systemName: 'acme-erp',
      authoritativeFor: ['INVOICES', 'ORDERS'],
      provenance: { source: 'PROVIDER_ENVELOPE', systemName: 'acme-erp', externalRef: 'erp-ref-1' },
      deepLink: 'https://erp.acme.example/invoices/INV-77',
    });
    expect(view.role).toBe('CONTEXT_VIEW_NOT_SYSTEM_OF_RECORD');
    expect(view.authoritativeFor).toEqual(['INVOICES', 'ORDERS']);
    expect(view.note).toContain('remains the authoritative system of record');
    const open = view.actions.find((action) => action.actionId === 'open-in-incumbent');
    expect(open?.externalOpen?.deepLink).toBe('https://erp.acme.example/invoices/INV-77');
    expect(view.actions.some((action) => action.actionId === 'view-provenance')).toBe(true);
  });

  it('a connector-backed incumbent exposes actions through the certified connector only', () => {
    const view = deriveIncumbentContextView({
      systemName: 'psp-one',
      authoritativeFor: ['DISPUTES', 'REFUNDS'],
      provenance: { source: 'CONNECTED_INSTANCE', systemName: 'psp-one' },
      connectorInstanceId: 'inst_psp_one_1',
    });
    expect(view.role).toBe('ACTIONS_THROUGH_CERTIFIED_CONNECTOR');
    expect(view.connectorInstanceId).toBe('inst_psp_one_1');
    expect(view.actions.some((action) => action.actionId === 'act-through-connector')).toBe(true);
    // No deep link was declared: the open-in-incumbent action is not offered.
    expect(view.actions.some((action) => action.actionId === 'open-in-incumbent')).toBe(false);
  });

  it('a browser-local source yields the weakest label and never an authenticated claim', () => {
    const view = deriveIncumbentContextView({
      systemName: 'operator-note',
      authoritativeFor: ['NOTES'],
      provenance: { source: 'BROWSER_LOCAL' },
    });
    expect(view.provenanceLabel.strength).toBe('UNVERIFIED_BROWSER_ARTIFACT');
    expect(view.provenanceLabel.note).toContain('never stronger');
  });

  it('declarations without authority are rejected (fail closed)', () => {
    expect(() =>
      deriveIncumbentContextView({
        systemName: '',
        authoritativeFor: ['X'],
        provenance: { source: 'USER_REPORT' },
      }),
    ).toThrow();
    expect(() =>
      deriveIncumbentContextView({
        systemName: 'x',
        authoritativeFor: [],
        provenance: { source: 'USER_REPORT' },
      }),
    ).toThrow();
  });
});

describe('reconcileViewAgainstIncumbent — the incumbent wins ties (INV-E04)', () => {
  it('an authenticated incumbent record beats a browser-local view', () => {
    const outcome = reconcileViewAgainstIncumbent({
      viewProvenance: deriveProvenanceLabel({ source: 'BROWSER_LOCAL' }),
      incumbentProvenance: deriveProvenanceLabel({ source: 'PROVIDER_ENVELOPE' }),
    });
    expect(outcome.winner).toBe('INCUMBENT');
    expect(outcome.reason).toContain('INV-E04');
  });

  it('equal strength also resolves to the incumbent (the view re-renders from authority)', () => {
    const outcome = reconcileViewAgainstIncumbent({
      viewProvenance: deriveProvenanceLabel({ source: 'USER_REPORT' }),
      incumbentProvenance: deriveProvenanceLabel({ source: 'USER_REPORT' }),
    });
    expect(outcome.winner).toBe('INCUMBENT');
  });
});
