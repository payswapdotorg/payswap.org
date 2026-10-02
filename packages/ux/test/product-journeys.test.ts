/**
 * P3-W3-001 — contract tests for the seven product journeys.
 *
 * Batch coverage (this file grows in committed batches):
 * - the OPAQUE BRANDED REFERENCE law: plain strings are not assignable where
 *   branded references are required, and no journey type (nor any driven
 *   journey value) carries credential-material field names (law 4);
 * - ConnectProvider: catalogue-never-authorizes, authority-record-only
 *   connection, legal-transitions-only, opaque browser session, idempotent
 *   initiation, approval folding;
 * - Pay: connected-instances-only capability selection, honest
 *   non-routability, comparison-only catalogue routes, submission through the
 *   REAL api handler, approval round trip on the trusted surface, verbatim
 *   outcome tracking with UNKNOWN never FAILED (INV-X01) through the SAME
 *   mapTerminalStateToUi consumption;
 * - Collect / Payout / Reconcile / Evidence / Reauth and the cross-cutting
 *   contracts (state table, no dead buttons, idempotency on every mutation,
 *   nav bindings) in the later batches of this file.
 *
 * Every dependency is REAL and injected (fixtures.ts harness: a genuine
 * @payswap/api createApiHandler with real trust grants — the same surface
 * programmatic clients use). No mocks of authority.
 */

import { describe, expect, it } from 'vitest';

import type { ApiResponse } from '@payswap/api';
import { mapTerminalStateToUi } from '@payswap/interfaces';
import type { ErrorCategory } from '@payswap/interfaces';
import type { Mandate, PermissionGrant } from '@payswap/trust';
import { issueGrant, principalRef } from '@payswap/trust';

import type { ConnectProviderJourney, PayJourney } from '../src/product-journeys.js';
import {
  abandonPayJourney,
  applyConnectionAuthorizationOutcome,
  applyConnectionInitiationResponse,
  applyPayOutcome,
  applyPayReconciliationResolution,
  applyPaymentSubmissionResponse,
  asBrowserSessionRef,
  asConnectedCapabilityInstanceId,
  asEvidenceArtifactRef,
  attachBrowserSession,
  beginConnectProvider,
  beginPayJourney,
  browseProviderCatalogue,
  canTransitionConnectProvider,
  canTransitionPay,
  chooseProvider,
  confirmConnectionApproval,
  confirmPayApproval,
  CONNECT_PROVIDER_TRANSITIONS,
  deriveCatalogueOptions,
  dispatchInitiateConnection,
  dispatchPaymentSubmission,
  dispatchProductJourneyAction,
  PAY_TRANSITIONS,
  productJourneyMutationEnvelope,
  routeCandidateIsExecutable,
  selectPayCapability,
  trackedOutcomeUiState,
} from '../src/product-journeys.js';
import { approvalArtifactRef, completeApprovalOnTrustedSurface } from '../src/trusted-approvals.js';
import { ALICE, buildHarness, escalationHarness, NOW_MS, uxSession } from './fixtures.js';
import type { UxHarness } from './fixtures.js';

// ---------------------------------------------------------------------------
// Harnesses: real api handler + real trust grants for the product commands
// ---------------------------------------------------------------------------

const FAR_FUTURE_MS = 4_102_444_800_000;

function mandateFixture(input: {
  readonly id: string;
  readonly grantId: string;
  readonly actions: readonly string[];
  readonly perTransactionAmount?: { readonly currency: string; readonly minorUnits: string };
  readonly escalation?: 'require_approval';
}): readonly PermissionGrant[] {
  const mandate: Mandate = {
    id: input.id,
    version: 1,
    grantor: 'user:owner',
    grantee: principalRef(ALICE),
    actions: [...input.actions],
    resources: [{ type: 'intent' }],
    ...(input.perTransactionAmount === undefined
      ? {}
      : { limits: { perTransactionAmount: input.perTransactionAmount } }),
    ...(input.escalation === undefined
      ? {}
      : {
          escalation: {
            onLimitExceeded: 'require_approval' as const,
            approverRef: 'user:owner',
          },
        }),
    expiresAt: FAR_FUTURE_MS,
    proofRequirements: [],
  };
  return [issueGrant(mandate, { grantId: input.grantId, issuedAt: NOW_MS })];
}

/** The allow harness for the product-journey command types. */
function productJourneyHarness(): UxHarness {
  return buildHarness(
    mandateFixture({
      id: 'mand_ux_product_journeys',
      grantId: 'grant_ux_product_1',
      actions: [
        'capabilities.connection.initiate',
        'payments.intent.create',
        'payments.collect.request',
        'payouts.payout.create',
        'payments.reconciliation.observe',
      ],
    }),
  );
}

// Synthetic authoritative responses (for pure-fold tests; the dispatch paths
// are exercised against the REAL handler separately).

function grantedResponse(intentId: string): ApiResponse {
  return {
    kind: 'success',
    status: 200,
    envelope: {
      data: { intent: { id: intentId } },
      meta: { schemaVersion: '1.0', requestId: 'req-synthetic-1' },
    },
  };
}

function approvalRequiredResponse(input: {
  readonly requestHash: string;
  readonly expiresAt: string;
  readonly deepLink?: string;
}): ApiResponse {
  return {
    kind: 'success',
    status: 202,
    envelope: {
      data: {
        approvalRequest: { requestHash: input.requestHash, expiresAt: input.expiresAt, status: 'PENDING', channel: 'IN_APP' },
        approvalMessage:
          input.deepLink === undefined
            ? { requestHash: input.requestHash }
            : { requestHash: input.requestHash, deepLink: input.deepLink },
      },
      meta: { schemaVersion: '1.0', requestId: 'req-synthetic-2' },
    },
  };
}

function errorResponse(category: ErrorCategory, code: string, message: string): ApiResponse {
  return {
    kind: 'error',
    status: 403,
    body: {
      error: { category, code, message },
      meta: { schemaVersion: '1.0', requestId: 'req-synthetic-3' },
    },
  };
}

function expectSuccess(response: ApiResponse): Extract<ApiResponse, { readonly kind: 'success' }> {
  if (response.kind !== 'success') {
    throw new Error(`expected success, got error: ${JSON.stringify(response.body.error)}`);
  }
  return response;
}

// ---------------------------------------------------------------------------
// The opaque branded reference law (law 4: credential material unrepresentable)
// ---------------------------------------------------------------------------

/** Field names that would constitute credential material if they appeared. */
type CredentialMaterialFieldName =
  | 'apiKey'
  | 'apiToken'
  | 'accessToken'
  | 'refreshToken'
  | 'secret'
  | 'secretKey'
  | 'clientSecret'
  | 'password'
  | 'cookie'
  | 'cookies'
  | 'mfa'
  | 'mfaCode'
  | 'credential'
  | 'credentials'
  | 'privateKey';

/** Compiles to `true` only when NO forbidden field name exists on T. */
type NoCredentialFields<T> = Extract<keyof T, CredentialMaterialFieldName> extends never
  ? true
  : ['FAIL: credential material on the journey type'];

// Compile-time assertions — each is `true` exactly when the law holds; a
// violation is a type error, and the runtime assertions below re-check them.
const CONNECT_PROVIDER_HAS_NO_CREDENTIAL_FIELDS: NoCredentialFields<ConnectProviderJourney> = true;
const PAY_HAS_NO_CREDENTIAL_FIELDS: NoCredentialFields<PayJourney> = true;
const BROWSER_SESSION_REF_IS_OPAQUE: string extends import('../src/product-journeys.js').BrowserSessionRef
  ? ['FAIL: plain strings are assignable to BrowserSessionRef']
  : true = true;
const INSTANCE_ID_IS_OPAQUE: string extends import('../src/product-journeys.js').ConnectedCapabilityInstanceId
  ? ['FAIL: plain strings are assignable to ConnectedCapabilityInstanceId']
  : true = true;

const CREDENTIAL_MATERIAL_KEY_PATTERN =
  /"(api_?key|api_?token|access_?token|refresh_?token|secret|secret_?key|client_?secret|password|cookie|cookies|mfa|credential|credentials|private_?key)"\s*:/i;

describe('opaque branded references (credential material is unrepresentable)', () => {
  it('the branded-ref constructors validate and brand (fail closed on empty, whitespace, oversize)', () => {
    expect(asBrowserSessionRef('broker-session-1')).toBe('broker-session-1');
    expect(asConnectedCapabilityInstanceId('inst_1')).toBe('inst_1');
    expect(asEvidenceArtifactRef('ev_1')).toBe('ev_1');
    expect(() => asBrowserSessionRef('')).toThrow(/BrowserSessionRef must be a non-empty string/);
    expect(() => asConnectedCapabilityInstanceId('  ')).toThrow(/whitespace/);
    expect(() => asEvidenceArtifactRef('x'.repeat(257))).toThrow(/exceeds 256 characters/);
  });

  it('plain strings are NOT assignable to branded references (type-level opacity)', () => {
    expect(BROWSER_SESSION_REF_IS_OPAQUE).toBe(true);
    expect(INSTANCE_ID_IS_OPAQUE).toBe(true);
  });

  it('no product journey type carries a credential-material field name (type-level + runtime scan)', () => {
    expect(CONNECT_PROVIDER_HAS_NO_CREDENTIAL_FIELDS).toBe(true);
    expect(PAY_HAS_NO_CREDENTIAL_FIELDS).toBe(true);

    const connectJourney = beginConnectProvider({
      catalogue: [
        { providerId: 'stripe', displayName: 'Stripe', rails: ['cap.card.charge'], catalogueAvailability: 'AVAILABLE' },
      ],
    });
    const payJourney = beginPayJourney({
      request: { amount: { currency: 'USD', minorUnits: '5000' }, recipient: 'merchant:acme' },
      connectedInstances: [
        {
          instanceId: asConnectedCapabilityInstanceId('inst_stripe_1'),
          providerId: 'stripe',
          connectedAt: '2026-10-02T00:00:00Z',
          state: 'ACTIVE',
        },
      ],
      routabilityChecks: [],
    });
    for (const serialized of [JSON.stringify(connectJourney), JSON.stringify(payJourney)]) {
      expect(CREDENTIAL_MATERIAL_KEY_PATTERN.test(serialized)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Journey 1 — ConnectProvider
// ---------------------------------------------------------------------------

const CATALOGUE = [
  {
    providerId: 'stripe',
    displayName: 'Stripe',
    rails: ['cap.card.charge'],
    catalogueAvailability: 'AVAILABLE' as const,
  },
  {
    providerId: 'momo-gh',
    displayName: 'Mobile Money GH',
    rails: ['cap.mobile_money.collect'],
    catalogueAvailability: 'AVAILABLE' as const,
  },
  {
    providerId: 'legacy-psp',
    displayName: 'Legacy PSP',
    rails: ['cap.bank.pull'],
    catalogueAvailability: 'UNAVAILABLE' as const,
  },
  {
    providerId: 'thunes',
    displayName: 'Thunes',
    rails: ['cap.wallet.send'],
    catalogueAvailability: 'UNKNOWN' as const,
  },
];

describe('connect-provider journey', () => {
  it('the catalogue never authorizes: browsing yields options, never a connected capability', () => {
    const options = deriveCatalogueOptions(CATALOGUE);
    expect(options.map((option) => option.providerId)).toEqual(['stripe', 'momo-gh', 'legacy-psp', 'thunes']);
    expect(options[0]?.connectable).toBe(true);
    expect(options[2]?.connectable).toBe(false);
    expect(options[3]?.connectable).toBe(false);
    // The honest notes say availability is NOT connected capability...
    expect(options[0]?.connectabilityNote).toContain('NOT connected capability');
    // ...and UNKNOWN availability is neither coverage nor failure.
    expect(options[3]?.connectabilityNote).toContain('absence of knowledge');

    const journey = beginConnectProvider({ catalogue: CATALOGUE });
    const browsing = browseProviderCatalogue(journey);
    const initiating = chooseProvider(browsing, 'stripe');
    // Catalogue browsing never yields a connected capability: after choosing,
    // there is no instance id, no connected record, and the journey is not
    // terminal — the only path onward is the authorization flow.
    expect(initiating.stateName).toBe('initiating');
    expect(initiating.terminal).toBe(false);
    expect(initiating.connectedInstance).toBeUndefined();
    expect(JSON.stringify(initiating)).not.toContain('instanceId');
    // And the transition table has NO path from browsing (or initiating) to
    // the connected state.
    expect(CONNECT_PROVIDER_TRANSITIONS.browsing).not.toContain('connected-capability-instance');
    expect(CONNECT_PROVIDER_TRANSITIONS.initiating).not.toContain('connected-capability-instance');
  });

  it('choosing an unavailable or unknown catalogue provider is an honest rejection', () => {
    const browsing = browseProviderCatalogue(beginConnectProvider({ catalogue: CATALOGUE }));
    expect(() => chooseProvider(browsing, 'legacy-psp')).toThrow(/not connectable/);
    expect(() => chooseProvider(browsing, 'thunes')).toThrow(/not connectable/);
    expect(() => chooseProvider(browsing, 'no-such-provider')).toThrow(/not in the browsed catalogue/);
    expect(() => chooseProvider(beginConnectProvider({ catalogue: CATALOGUE }), 'stripe')).toThrow(
      /not legal in state idle/,
    );
  });

  it('happy path: initiate through the REAL api handler, then fold the AUTHORITY activation record', async () => {
    const harness = productJourneyHarness();
    const session = uxSession(harness, 'connect-test');
    const journey = attachBrowserSession(
      chooseProvider(browseProviderCatalogue(beginConnectProvider({ catalogue: CATALOGUE })), 'stripe'),
      asBrowserSessionRef('broker-session-1'),
    );
    expect(journey.stateName).toBe('initiating');
    expect(journey.browserSessionRef).toBe('broker-session-1');

    const initiated = await dispatchInitiateConnection(session, journey);
    expect(initiated.response.status).toBe(200);
    expect(initiated.journey.stateName).toBe('awaiting-authorization');
    expect(initiated.journey.initiationIntentId).toBeDefined();

    // The connected capability instance enters ONLY through the authority
    // activation record, folded in the awaiting-authorization state.
    const record = {
      instanceId: asConnectedCapabilityInstanceId('inst_stripe_1'),
      providerId: 'stripe',
      connectedAt: '2026-10-02T00:00:00Z',
      state: 'ACTIVE' as const,
    };
    const connected = applyConnectionAuthorizationOutcome(initiated.journey, record);
    expect(connected.stateName).toBe('connected-capability-instance');
    expect(connected.terminal).toBe(true);
    expect(connected.connectedInstance?.instanceId).toBe('inst_stripe_1');
    expect(connected.actions.some((action) => action.available)).toBe(true);
  });

  it('an authority activation record for a different provider is rejected (fail closed)', () => {
    const awaiting = applyConnectionInitiationResponse(
      chooseProvider(browseProviderCatalogue(beginConnectProvider({ catalogue: CATALOGUE })), 'stripe'),
      grantedResponse('intent_connect_1'),
    );
    expect(() =>
      applyConnectionAuthorizationOutcome(awaiting, {
        instanceId: asConnectedCapabilityInstanceId('inst_other'),
        providerId: 'paypal',
        connectedAt: '2026-10-02T00:00:00Z',
        state: 'ACTIVE',
      }),
    ).toThrow(/activation record is for provider paypal/);
  });

  it('expiry and revocation fold from awaiting-authorization; revocation also lands later from connected', () => {
    const awaiting = applyConnectionInitiationResponse(
      chooseProvider(browseProviderCatalogue(beginConnectProvider({ catalogue: CATALOGUE })), 'momo-gh'),
      grantedResponse('intent_connect_2'),
    );
    const expired = applyConnectionAuthorizationOutcome(awaiting, {
      instanceId: asConnectedCapabilityInstanceId('inst_momo_1'),
      providerId: 'momo-gh',
      connectedAt: '2026-10-02T00:00:00Z',
      state: 'EXPIRED',
    });
    expect(expired.stateName).toBe('expired');
    expect(expired.terminal).toBe(true);

    const connected = applyConnectionAuthorizationOutcome(awaiting, {
      instanceId: asConnectedCapabilityInstanceId('inst_momo_1'),
      providerId: 'momo-gh',
      connectedAt: '2026-10-02T00:00:00Z',
      state: 'ACTIVE',
    });
    const revoked = applyConnectionAuthorizationOutcome(connected, {
      instanceId: asConnectedCapabilityInstanceId('inst_momo_1'),
      providerId: 'momo-gh',
      connectedAt: '2026-10-02T00:00:00Z',
      state: 'REVOKED',
    });
    expect(revoked.stateName).toBe('revoked');
    expect(revoked.terminal).toBe(true);
  });

  it('illegal transitions throw (legal-transitions-only, fail closed)', () => {
    expect(canTransitionConnectProvider('idle', 'browsing')).toBe(true);
    expect(canTransitionConnectProvider('browsing', 'connected-capability-instance')).toBe(false);
    expect(canTransitionConnectProvider('initiating', 'connected-capability-instance')).toBe(false);
    expect(canTransitionConnectProvider('connected-capability-instance', 'browsing')).toBe(false);

    // Direct illegal folds throw with the honest reason.
    const browsing = browseProviderCatalogue(beginConnectProvider({ catalogue: CATALOGUE }));
    expect(() =>
      applyConnectionAuthorizationOutcome(browsing, {
        instanceId: asConnectedCapabilityInstanceId('inst_x'),
        providerId: 'stripe',
        connectedAt: '2026-10-02T00:00:00Z',
        state: 'ACTIVE',
      }),
    ).toThrow(/not foldable in state browsing/);
    expect(() => browseProviderCatalogue(browsing)).toThrow(/not legal/);
  });

  it('the initiation mutation is a validated RequestEnvelope with a fresh idempotency key (INV-F05)', () => {
    const session = uxSession(productJourneyHarness(), 'connect-envelope');
    const journey = chooseProvider(browseProviderCatalogue(beginConnectProvider({ catalogue: CATALOGUE })), 'stripe');
    const first = productJourneyMutationEnvelope(session, journey, 'initiate-connection');
    const second = productJourneyMutationEnvelope(session, journey, 'initiate-connection');
    expect(first.method).toBe('POST');
    expect(first.idempotencyKey).toBeDefined();
    expect(second.idempotencyKey).toBeDefined();
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    // Before choosing, the mutation is unavailable — and the envelope builder
    // fails closed with the honest reason (no such action exists in browsing).
    expect(() =>
      productJourneyMutationEnvelope(session, browseProviderCatalogue(beginConnectProvider({ catalogue: CATALOGUE })), 'initiate-connection'),
    ).toThrow(/initiate-connection/);
  });

  it('approval folding (INV-A03): a 202 parks the journey with the trusted-surface action; confirmation consumes it', () => {
    const initiating = chooseProvider(browseProviderCatalogue(beginConnectProvider({ catalogue: CATALOGUE })), 'stripe');
    const awaiting = applyConnectionInitiationResponse(
      initiating,
      approvalRequiredResponse({ requestHash: 'hash-connect-1', expiresAt: '2026-10-02T01:00:00Z', deepLink: 'https://trusted.example/connect' }),
    );
    expect(awaiting.stateName).toBe('awaiting-authorization');
    expect(awaiting.approval?.requestHash).toBe('hash-connect-1');
    expect(awaiting.approval?.deepLink).toBe('https://trusted.example/connect');
    const trusted = awaiting.actions.find((action) => action.actionId === 'open-trusted-approval-surface');
    expect(trusted?.kind).toBe('TRUSTED_SURFACE');
    expect(trusted?.trustedSurface?.requestHash).toBe('hash-connect-1');

    const confirmed = confirmConnectionApproval(awaiting);
    expect(confirmed.stateName).toBe('awaiting-authorization');
    expect(confirmed.approval).toBeUndefined();

    // An initiation error is honest, recorded and retryable in place.
    const errored = applyConnectionInitiationResponse(initiating, errorResponse('AUTHORIZATION', 'mandate_missing', 'no mandate'));
    expect(errored.stateName).toBe('initiating');
    expect(errored.error?.code).toBe('mandate_missing');
  });
});

// ---------------------------------------------------------------------------
// Journey 2 — Pay
// ---------------------------------------------------------------------------

const CONNECTED_INSTANCES = [
  {
    instanceId: asConnectedCapabilityInstanceId('inst_stripe_1'),
    providerId: 'stripe',
    connectedAt: '2026-10-01T00:00:00Z',
    state: 'ACTIVE' as const,
  },
  {
    instanceId: asConnectedCapabilityInstanceId('inst_momo_gh_1'),
    providerId: 'momo-gh',
    connectedAt: '2026-10-01T00:00:00Z',
    state: 'ACTIVE' as const,
  },
];

function begunPayJourney() {
  return beginPayJourney({
    request: { amount: { currency: 'GHS', minorUnits: '500000' }, recipient: 'supplier:kofi' },
    connectedInstances: CONNECTED_INSTANCES,
    routabilityChecks: [
      { instanceId: asConnectedCapabilityInstanceId('inst_stripe_1'), currency: 'GHS', routable: false, reason: 'GHS is not routable on this Stripe instance (honest provider-capability datum)' },
      { instanceId: asConnectedCapabilityInstanceId('inst_momo_gh_1'), currency: 'GHS', routable: true },
    ],
  });
}

describe('pay journey', () => {
  it('capability options come ONLY from connected instances; routability is honest and fail-closed', () => {
    const journey = begunPayJourney();
    expect(journey.options).toHaveLength(2);
    expect(journey.options.map((option) => option.instance.instanceId)).toEqual(['inst_stripe_1', 'inst_momo_gh_1']);

    const stripe = journey.options[0];
    expect(stripe?.routable).toBe(false);
    expect(stripe?.nonRoutableReason).toContain('not routable');

    // The non-routable option renders as an honest unavailable action with
    // its reason — data, not an exception.
    const selectAction = journey.actions.find((action) => action.actionId === 'select-capability:inst_stripe_1');
    expect(selectAction?.available).toBe(false);
    expect(selectAction?.unavailableReason).toContain('not routable');
    expect(journey.actions.find((action) => action.actionId === 'view-why-not-routable:inst_stripe_1')?.available).toBe(true);

    // Selecting the non-routable capability is rejected with the reason.
    expect(() =>
      selectPayCapability(journey, asConnectedCapabilityInstanceId('inst_stripe_1'), []),
    ).toThrow(/not routable for this payment/);
  });

  it('an instance without a routability check is honestly NOT routable (absent data is a derived state)', () => {
    const journey = beginPayJourney({
      request: { amount: { currency: 'USD', minorUnits: '2500' }, recipient: 'supplier:kofi' },
      connectedInstances: CONNECTED_INSTANCES,
      routabilityChecks: [
        { instanceId: asConnectedCapabilityInstanceId('inst_momo_gh_1'), currency: 'USD', routable: true },
      ],
    });
    const unchecked = journey.options.find((option) => option.instance.instanceId === 'inst_stripe_1');
    expect(unchecked?.routable).toBe(false);
    expect(unchecked?.nonRoutableReason).toContain('not established');
  });

  it('route comparison never treats catalogue-derived routes as executable', () => {
    const journey = begunPayJourney();
    const candidates = [
      {
        methodId: 'momo_gh',
        fees: { currency: 'GHS', minorUnits: '1200' },
        railPath: ['cap.mobile_money.collect'],
        completionMs: '60000',
        basedOnInstanceId: asConnectedCapabilityInstanceId('inst_momo_gh_1'),
      },
      {
        methodId: 'card_via_catalogue',
        fees: { currency: 'GHS', minorUnits: '900' },
        railPath: ['cap.card.charge'],
        completionMs: '30000',
        comparisonOnlyReason: 'derived from catalogue coverage — not executable until connected',
      },
    ];
    const reviewing = selectPayCapability(journey, asConnectedCapabilityInstanceId('inst_momo_gh_1'), candidates);
    expect(reviewing.stateName).toBe('REVIEWING_ROUTE');

    const connectedCandidate = reviewing.routeCandidates?.find((candidate) => candidate.methodId === 'momo_gh');
    const catalogueCandidate = reviewing.routeCandidates?.find(
      (candidate) => candidate.methodId === 'card_via_catalogue',
    );
    expect(connectedCandidate !== undefined && routeCandidateIsExecutable(connectedCandidate)).toBe(true);
    expect(catalogueCandidate !== undefined && routeCandidateIsExecutable(catalogueCandidate)).toBe(false);
    // The comparison-only candidate renders an honest explanation action.
    expect(
      reviewing.actions.find((action) => action.actionId === 'view-comparison-only:card_via_catalogue')?.available,
    ).toBe(true);

    // A candidate executing on a DIFFERENT connected instance is rejected.
    expect(() =>
      selectPayCapability(journey, asConnectedCapabilityInstanceId('inst_momo_gh_1'), [
        {
          methodId: 'other_instance_route',
          fees: { currency: 'GHS', minorUnits: '100' },
          railPath: ['cap.card.charge'],
          completionMs: '30000',
          basedOnInstanceId: asConnectedCapabilityInstanceId('inst_stripe_1'),
        },
      ]),
    ).toThrow(/not on the selected instance/);
  });

  it('submission through the REAL api handler: granted → SUBMITTED with a retrievable intent', async () => {
    const session = uxSession(productJourneyHarness(), 'pay-test');
    const journey = begunPayJourney();
    const reviewing = selectPayCapability(journey, asConnectedCapabilityInstanceId('inst_momo_gh_1'), [
      {
        methodId: 'momo_gh',
        fees: { currency: 'GHS', minorUnits: '1200' },
        railPath: ['cap.mobile_money.collect'],
        completionMs: '60000',
        basedOnInstanceId: asConnectedCapabilityInstanceId('inst_momo_gh_1'),
      },
    ]);
    const submitted = await dispatchPaymentSubmission(session, reviewing);
    expect(submitted.response.status).toBe(200);
    expect(submitted.journey.stateName).toBe('SUBMITTED');
    expect(submitted.journey.submittedIntentId).toBeDefined();

    // Round trip through the SAME surface.
    const view = submitted.journey.actions.find((action) => action.actionId === 'view-submitted-intent');
    expect(view?.apiCommand).toBeDefined();
    const fetched = await dispatchProductJourneyAction(session, submitted.journey, 'view-submitted-intent');
    const intent = (expectSuccess(fetched).envelope.data as { intent: { id: string } }).intent;
    expect(intent.id).toBe(submitted.journey.submittedIntentId);
  });

  it('approval round trip on the trusted surface (INV-A03): 202 → AWAITING_APPROVAL → confirm → artifact-carrying resubmit', async () => {
    // The escalation harness limits payments.intent.create to USD 100000
    // minor units with require_approval: a larger payment gets a REAL 202.
    const harness = escalationHarness();
    const session = uxSession(harness, 'pay-approval');
    const journey = beginPayJourney({
      request: { amount: { currency: 'USD', minorUnits: '500000' }, recipient: 'supplier:kofi', correlationId: 'corr-pay-1' },
      connectedInstances: CONNECTED_INSTANCES,
      routabilityChecks: [
        { instanceId: asConnectedCapabilityInstanceId('inst_momo_gh_1'), currency: 'USD', routable: true },
      ],
    });
    const reviewing = selectPayCapability(journey, asConnectedCapabilityInstanceId('inst_momo_gh_1'), []);
    const awaiting = await dispatchPaymentSubmission(session, reviewing);
    expect(awaiting.response.status).toBe(202);
    expect(awaiting.journey.stateName).toBe('AWAITING_APPROVAL');
    const requestHash = awaiting.journey.approval?.requestHash;
    expect(requestHash).toBeDefined();

    // The trusted-surface action is the completion path.
    const trusted = awaiting.journey.actions.find((action) => action.actionId === 'open-trusted-approval-surface');
    expect(trusted?.kind).toBe('TRUSTED_SURFACE');

    // The approval completes ONLY through the trusted surface.
    const completion = await completeApprovalOnTrustedSurface(harness.approvals, {
      principal: 'user:owner',
      requestHash: requestHash ?? '',
      decision: 'APPROVED',
    });
    expect(completion.outcome).toBe('ARTIFACT_ISSUED');

    const confirmed = confirmPayApproval(awaiting.journey);
    expect(confirmed.stateName).toBe('REVIEWING_ROUTE');
    // The re-submission carries the artifact reference (INV-A03).
    const envelope = productJourneyMutationEnvelope(session, confirmed, 'submit-payment');
    expect((envelope.body as Record<string, unknown>)['approvalArtifactRef']).toBe(approvalArtifactRef(requestHash ?? ''));

    const resubmitted = await dispatchPaymentSubmission(session, confirmed);
    expect(resubmitted.response.status).toBe(200);
    expect(resubmitted.journey.stateName).toBe('SUBMITTED');
  });

  it('outcome tracking is verbatim; OUTCOME_UNKNOWN is NEVER FAILED (INV-X01, same mapTerminalStateToUi consumption)', () => {
    const journey = begunPayJourney();
    const reviewing = selectPayCapability(journey, asConnectedCapabilityInstanceId('inst_momo_gh_1'), []);
    const submitted = applyPaymentSubmissionResponse(reviewing, grantedResponse('intent_pay_1'));

    const pending = applyPayOutcome(submitted, 'PENDING');
    expect(pending.stateName).toBe('TRACKING');
    expect(pending.attemptOutcome).toBe('PENDING');
    expect(trackedOutcomeUiState('PENDING')).toBe('reconciling');

    const inFlight = applyPayOutcome(pending, 'IN_FLIGHT');
    expect(inFlight.stateName).toBe('TRACKING');
    expect(inFlight.attemptOutcome).toBe('IN_FLIGHT');

    const unknown = applyPayOutcome(inFlight, 'OUTCOME_UNKNOWN');
    expect(unknown.stateName).toBe('RECONCILING');
    expect(unknown.terminal).toBe(false);
    // The projection goes through the SAME mapTerminalStateToUi consumption:
    // UNKNOWN → reconciling, never failed.
    expect(trackedOutcomeUiState('OUTCOME_UNKNOWN')).toBe(mapTerminalStateToUi('UNKNOWN'));
    expect(trackedOutcomeUiState('OUTCOME_UNKNOWN')).toBe('reconciling');
    expect(trackedOutcomeUiState('OUTCOME_UNKNOWN')).not.toBe('failed');

    const succeeded = applyPayOutcome(unknown, 'SUCCEEDED', [asEvidenceArtifactRef('ev_success_1')]);
    expect(succeeded.stateName).toBe('COMPLETED');
    expect(succeeded.terminal).toBe(true);
    expect(succeeded.evidenceRefs).toContain('ev_success_1');

    const failed = applyPayOutcome(submitted, 'FAILED');
    expect(failed.stateName).toBe('FAILED');
    expect(failed.terminal).toBe(true);
  });

  it('reconciliation resolution requires evidence; STILL_UNKNOWN stays honestly in RECONCILING', () => {
    const journey = begunPayJourney();
    const reviewing = selectPayCapability(journey, asConnectedCapabilityInstanceId('inst_momo_gh_1'), []);
    const reconciling = applyPayOutcome(
      applyPaymentSubmissionResponse(reviewing, grantedResponse('intent_pay_2')),
      'OUTCOME_UNKNOWN',
      [asEvidenceArtifactRef('ev_ambiguity_1')],
    );
    expect(reconciling.evidenceRefs).toContain('ev_ambiguity_1');

    const still = applyPayReconciliationResolution(reconciling, 'STILL_UNKNOWN', asEvidenceArtifactRef('ev_obs_2'));
    expect(still.stateName).toBe('RECONCILING');
    expect(still.attemptOutcome).toBe('OUTCOME_UNKNOWN');

    const resolved = applyPayReconciliationResolution(still, 'RESOLVED_FULFILLED', asEvidenceArtifactRef('ev_resolution_1'));
    expect(resolved.stateName).toBe('COMPLETED');
    expect(resolved.terminal).toBe(true);
    expect(resolved.evidenceRefs).toContain('ev_resolution_1');

    const resolvedFailed = applyPayReconciliationResolution(reconciling, 'RESOLVED_FAILED', asEvidenceArtifactRef('ev_resolution_2'));
    expect(resolvedFailed.stateName).toBe('FAILED');
  });

  it('illegal transitions throw; a submitted payment cannot be abandoned', () => {
    expect(canTransitionPay('SELECTING_CAPABILITY', 'SUBMITTED')).toBe(false);
    expect(canTransitionPay('REVIEWING_ROUTE', 'COMPLETED')).toBe(false);
    expect(canTransitionPay('TRACKING', 'ABANDONED')).toBe(false);

    const journey = begunPayJourney();
    expect(() => applyPaymentSubmissionResponse(journey, grantedResponse('x'))).toThrow(/not legal/);

    const reviewing = selectPayCapability(journey, asConnectedCapabilityInstanceId('inst_momo_gh_1'), []);
    const submitted = applyPaymentSubmissionResponse(reviewing, grantedResponse('intent_pay_3'));
    expect(() => abandonPayJourney(submitted)).toThrow(/cannot be abandoned/);
  });

  it('the submit mutation is a validated RequestEnvelope with a fresh idempotency key (INV-F05)', () => {
    const session = uxSession(productJourneyHarness(), 'pay-envelope');
    const reviewing = selectPayCapability(begunPayJourney(), asConnectedCapabilityInstanceId('inst_momo_gh_1'), []);
    const first = productJourneyMutationEnvelope(session, reviewing, 'submit-payment');
    const second = productJourneyMutationEnvelope(session, reviewing, 'submit-payment');
    expect(first.method).toBe('POST');
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect((first.body as Record<string, unknown>)['capabilityInstanceId']).toBe('inst_momo_gh_1');
  });
});
