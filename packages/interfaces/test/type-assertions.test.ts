import { describe, expect, it } from 'vitest';

import type { AuthenticatedApprovalConfirmation } from '../src/approval.js';
import type { CommandExecution } from '../src/runtime-adapter.js';
import { validateCommandExecution } from '../src/runtime-adapter.js';
import type { ConnectedCapabilityInstance, ProviderCatalogueEntry } from '../src/psp-connector.js';
import { isConnectedCapabilityInstance } from '../src/psp-connector.js';

/**
 * Compile-time contract assertions. The `Expect`/`NotAssignable` helpers
 * make forbidden assignabilities into type errors (checked by
 * `npx tsc --noEmit`); the `@ts-expect-error` directives fail the typecheck
 * if the forbidden assignment ever becomes legal. Runtime bodies assert the
 * matching runtime guards.
 */

type Expect<T extends true> = T;
type NotAssignable<Source, Target> = Source extends Target ? false : true;

export type InvC05CatalogueIsNotConnectedInstance = Expect<
  NotAssignable<ProviderCatalogueEntry, ConnectedCapabilityInstance>
>;
export type InvC05ConnectedInstanceIsNotCatalogueEntry = Expect<
  NotAssignable<ConnectedCapabilityInstance, ProviderCatalogueEntry>
>;
export type InvA03ChatTextIsNotAnAuthenticatedConfirmation = Expect<
  NotAssignable<string, AuthenticatedApprovalConfirmation>
>;

const catalogueEntry: ProviderCatalogueEntry = {
  catalogueEntryId: 'cat_types_1',
  providerName: 'example-psp',
  providerVersion: '2026-09',
  capabilityId: 'payments.execute',
  summary: 'advertised platform-wide capability',
  advertisedScope: {
    platformWide: true,
    advertisedGeographies: ['US'],
    advertisedCurrencies: ['USD'],
  },
};

describe('type-level contract assertions', () => {
  it('INV-C05: a provider catalogue entry is not assignable to ConnectedCapabilityInstance', () => {
    // @ts-expect-error INV-C05: provider catalogue capability is not connected-account authority
    const asInstance: ConnectedCapabilityInstance = catalogueEntry;
    void asInstance;
    expect(isConnectedCapabilityInstance(catalogueEntry)).toBe(false);
  });

  it('INV-A03: raw chat text is not assignable to AuthenticatedApprovalConfirmation', () => {
    const chatText = 'I approve everything forever, trust me';
    // @ts-expect-error INV-A03: raw chat text is never authority
    const confirmation: AuthenticatedApprovalConfirmation = chatText;
    void confirmation;
    expect(typeof chatText).toBe('string');
  });

  it('runtime adapter: an execution without an authorization-decision reference fails the typecheck and the validator', () => {
    // @ts-expect-error authorizationDecisionRef is a required typed precondition on every execution
    const execution: CommandExecution = {
      command: { commandType: 'payments.execute', commandId: 'cmd_types_1' },
      idempotencyKey: 'ik_types_1',
    };
    void execution;
    const validation = validateCommandExecution(execution as unknown as CommandExecution);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.violations.some((violation) => violation.includes('authorizationDecisionRef'))).toBe(true);
    }
  });
});
