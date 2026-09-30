/**
 * Merchant PSP connector conformance harness (W3-001).
 *
 * Covered contract rules:
 * - INV-C05: a provider catalogue entry cannot be adopted as a connected
 *   capability instance (refused by the subject AND by the runtime guard);
 * - INV-C06: provider state passes through losslessly (never flattened);
 * - INV-C07: execution requires an explicit execution mode and every
 *   execution echoes its mode;
 * - INV-C09: external funds positions are freshness- and provenance-bearing
 *   observations, structurally not balances.
 */

import type { ContractTestFn } from './contract-test.js';
import {
  EXECUTION_MODES,
  isConnectedCapabilityInstance,
  isExternalFundsPositionObservation,
  isProviderCatalogueEntry,
  validateConnectorExecutionRequest,
} from '../psp-connector.js';
import type {
  ConnectedCapabilityInstance,
  ConnectorExecutionRequest,
  ConnectorExecutionResult,
  ExternalFundsLocation,
  ExternalFundsPositionObservation,
  ProviderCatalogueEntry,
  ProviderStateEnvelope,
} from '../psp-connector.js';
import type { ApiError } from '../http.js';
import { equal, ok } from './assertions.js';

export interface PspConnectorContractSubject {
  /** Attempting to treat a catalogue entry as a connected instance. MUST be refused (INV-C05). */
  adoptAsConnected(
    entry: ProviderCatalogueEntry,
  ): { ok: true; instance: ConnectedCapabilityInstance } | { ok: false; error: ApiError };
  /** Observes an external funds position at a location (INV-C09). */
  observeFundsPosition(location: ExternalFundsLocation): ExternalFundsPositionObservation;
  /** Wraps raw provider state losslessly (INV-C06). */
  preserveProviderState(rawProviderState: unknown): ProviderStateEnvelope;
  /** Executes against a connected instance with an explicit mode (INV-C07). */
  execute(request: ConnectorExecutionRequest): Promise<ConnectorExecutionResult>;
}

const CATALOGUE_ENTRY: ProviderCatalogueEntry = {
  catalogueEntryId: 'cat_conformance_1',
  providerName: 'example-psp',
  providerVersion: '2026-09',
  capabilityId: 'payments.execute', // opaque reference into the W2-003 vocabulary
  summary: 'Card payment execution, platform-wide advertisement',
  advertisedScope: {
    platformWide: true,
    advertisedGeographies: ['US', 'HK', 'DE'],
    advertisedCurrencies: ['USD', 'HKD', 'EUR'],
  },
};

export function runPspConnectorContractTests(subject: PspConnectorContractSubject, test: ContractTestFn): void {
  test('INV-C05: adopting a provider catalogue entry as a connected instance is refused', () => {
    const result = subject.adoptAsConnected(CATALOGUE_ENTRY);
    ok(result.ok === false, 'catalogue adoption must be refused');
    if (result.ok === true) {
      return;
    }
    ok(result.error.category === 'POLICY', `refusal must be POLICY, got ${result.error.category}`);
    ok(
      typeof result.error.message === 'string' && result.error.message.length > 0,
      'refusal must explain the invariant',
    );
  });

  test('INV-C05: catalogue entries fail the connected-instance runtime guard', () => {
    ok(!isConnectedCapabilityInstance(CATALOGUE_ENTRY), 'catalogue entry must not pass the connected guard');
    ok(isProviderCatalogueEntry(CATALOGUE_ENTRY), 'catalogue entry passes the catalogue guard');
  });

  test('INV-C06: provider state passes through losslessly', () => {
    const raw = {
      status: 'requires_action',
      next_action: { type: 'redirect_to_url', url: 'https://example-psp.test/3ds' },
      metadata: { order_id: '6715' },
    };
    const envelope = subject.preserveProviderState(raw);
    ok(envelope.state !== undefined, 'envelope carries provider state');
    ok(typeof envelope.state === 'object' && envelope.state !== null, 'state remains a structured object');
    equal(envelope.state, raw, 'state is preserved verbatim, never flattened');
    ok(Array.isArray(envelope.history), 'history is carried separately');
    ok(typeof envelope.provider.name === 'string' && envelope.provider.name !== '', 'provider identity preserved');
    ok(typeof envelope.object.externalId === 'string' && envelope.object.externalId !== '', 'external object identity preserved');
    ok(typeof envelope.revision === 'string' && envelope.revision !== '', 'provider revision preserved');
    ok(typeof envelope.timestamps.observedAt === 'string' && envelope.timestamps.observedAt !== '', 'observation timestamp present');
  });

  test('INV-C07: execution without an explicit mode is a contract violation', () => {
    const invalid = {
      capabilityInstanceId: 'cci_conformance_1',
      providerRequest: { amount: 1500 },
      idempotencyKey: 'ik_conformance_mode',
    } as unknown as ConnectorExecutionRequest;
    const validation = validateConnectorExecutionRequest(invalid);
    ok(validation.ok === false, 'missing executionMode must be a violation');
    if (validation.ok === true) {
      return;
    }
    ok(
      validation.violations.some((violation) => violation.includes('INV-C07')),
      'violation names the invariant',
    );
  });

  test('INV-C07: every execution echoes its explicit mode', async () => {
    for (const mode of EXECUTION_MODES) {
      const result = await subject.execute({
        executionMode: mode,
        capabilityInstanceId: 'cci_conformance_1',
        providerRequest: { amount: 1500 },
        idempotencyKey: `ik_conformance_${mode}`,
      });
      ok(result.executionMode === mode, `result must echo ${mode}`);
      ok(result.providerState !== undefined, 'result carries a provider state envelope');
    }
  });

  test('INV-C09: external funds positions are observations, not balances', () => {
    const observation = subject.observeFundsPosition({
      providerName: 'example-psp',
      accountRef: 'acct_conformance_1',
    });
    ok(typeof observation.observedAt === 'string' && observation.observedAt !== '', 'observedAt mandatory');
    ok(observation.freshness !== undefined, 'freshness mandatory');
    ok(observation.provenance !== undefined, 'provenance mandatory');
    ok(isExternalFundsPositionObservation(observation), 'observation passes its guard');

    const balanceShaped = { available: '1000', pending: '50' };
    ok(
      !isExternalFundsPositionObservation(balanceShaped),
      'a bare balance shape must fail the observation guard (INV-C09)',
    );
  });
}
