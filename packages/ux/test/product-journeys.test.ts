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
import { mapTerminalStateToUi, validateRequestEnvelope } from '@payswap/interfaces';
import type { ErrorCategory } from '@payswap/interfaces';
import type { Mandate, PermissionGrant } from '@payswap/trust';
import { issueGrant, principalRef } from '@payswap/trust';

import { PAYMENT_JOURNEY_STATES } from '../src/journeys.js';
import { PROVENANCE_STRENGTH_ORDER } from '../src/incumbent-views.js';
import { navItemById } from '../src/product-ia.js';
import type { ProductNavItemId } from '../src/product-ia.js';
import type { ConnectProviderJourney, PayJourney, ProductJourney, ProductJourneyId } from '../src/product-journeys.js';
import {
  abandonCollectJourney,
  abandonPayJourney,
  abandonPayoutJourney,
  applyCollectFulfillment,
  applyCollectRequestResponse,
  applyConnectionAuthorizationOutcome,
  applyConnectionInitiationResponse,
  applyExecutionResumedResponse,
  applyReauthorizationRequestResponse,
  applyPayOutcome,
  applyPayReconciliationResolution,
  applyPaymentSubmissionResponse,
  applyPayoutOutcome,
  applyPayoutReconciliationResolution,
  applyPayoutSubmissionResponse,
  applyReconciliationResolution,
  asBrowserSessionRef,
  asConnectedCapabilityInstanceId,
  asEvidenceArtifactRef,
  asPayoutDestinationRef,
  asReauthorizationRef,
  attachBrowserSession,
  awaitFurtherObservation,
  backToEvidenceList,
  beginCollectJourney,
  beginCollectTracking,
  beginConnectProvider,
  beginEvidenceInspection,
  beginPayJourney,
  beginPayoutJourney,
  beginReauthorization,
  beginReconcileJourney,
  beginTrustedSurfaceReauthorization,
  browseProviderCatalogue,
  canTransitionCollect,
  canTransitionConnectProvider,
  canTransitionEvidence,
  canTransitionPay,
  canTransitionPayout,
  canTransitionReconcile,
  canTransitionReauth,
  chooseProvider,
  collectFulfillmentUiState,
  confirmConnectionApproval,
  confirmPayApproval,
  confirmPayoutApproval,
  confirmWithdrawalScope,
  CONNECT_PROVIDER_TRANSITIONS,
  deriveCatalogueOptions,
  deriveEvidenceList,
  deriveShareableRequest,
  dispatchCollectRequest,
  dispatchInitiateConnection,
  dispatchPaymentSubmission,
  dispatchPayoutSubmission,
  dispatchProductJourneyAction,
  dispatchReauthorizationRequest,
  dispatchReconciliationObservation,
  dispatchResumeExecution,
  inspectEvidenceArtifact,
  JOURNEY_NAV_BINDINGS,
  journeysForNavItem,
  markRequestShared,
  PAY_TRANSITIONS,
  PRODUCT_JOURNEY_IDS,
  PRODUCT_JOURNEY_STATES,
  productJourneyMutationEnvelope,
  productJourneyStateHasLiveActions,
  reenterPayoutDestinationSelection,
  reconcileJourneyUiState,
  recordFreshAuthorization,
  recordOutcomeUnknown,
  routeCandidateIsExecutable,
  selectPayCapability,
  specifyPayoutDestination,
  strongestEvidenceEntry,
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

// ---------------------------------------------------------------------------
// Journey 3 — Collect
// ---------------------------------------------------------------------------

describe('collect journey', () => {
  it('with no connected capability permitting collection, the journey begins in an HONEST EMPTY state (never an exception)', () => {
    const journey = beginCollectJourney({
      amount: { currency: 'GHS', minorUnits: '25000' },
      payer: 'customer:ama',
      collectCapableInstances: [],
    });
    expect(journey.stateName).toBe('COMPOSING_REQUEST');
    expect(journey.terminal).toBe(false);
    const create = journey.actions.find((action) => action.actionId === 'create-collect-request');
    expect(create?.available).toBe(false);
    expect(create?.unavailableReason).toContain('no connected capability permits collecting');
    expect(journey.actions.find((action) => action.actionId === 'connect-a-capability')?.available).toBe(true);
    // The mutation builder fails closed on the honest empty state.
    expect(() => productJourneyMutationEnvelope(uxSession(productJourneyHarness(), 'collect-empty'), journey, 'create-collect-request')).toThrow(
      /not available in state COMPOSING_REQUEST/,
    );
  });

  it('happy path through the REAL api handler: create, share (opaque ref), track', async () => {
    const session = uxSession(productJourneyHarness(), 'collect-test');
    const journey = beginCollectJourney({
      amount: { currency: 'GHS', minorUnits: '25000' },
      payer: 'customer:ama',
      collectCapableInstances: CONNECTED_INSTANCES,
    });
    const created = await dispatchCollectRequest(session, journey);
    expect(created.response.status).toBe(200);
    expect(created.journey.stateName).toBe('REQUEST_CREATED');
    expect(created.journey.requestRef).toBeDefined();

    // The shareable form is an OPAQUE reference (no credential material).
    const shareable = deriveShareableRequest(created.journey);
    expect('requestRef' in shareable).toBe(true);
    if ('requestRef' in shareable) {
      expect(typeof shareable.requestRef).toBe('string');
    }

    const shared = markRequestShared(created.journey);
    expect(shared.stateName).toBe('SHARED');
    const tracking = beginCollectTracking(shared);
    expect(tracking.stateName).toBe('TRACKING');
    expect(tracking.fulfillmentOutcome).toBe('PENDING');
    expect(collectFulfillmentUiState('PENDING')).toBe(mapTerminalStateToUi('WAITING'));
    expect(collectFulfillmentUiState('PENDING')).toBe('reconciling');
  });

  it('sharing before creation is honestly NOT_CREATED; the share fold fails closed', () => {
    const journey = beginCollectJourney({
      amount: { currency: 'GHS', minorUnits: '25000' },
      payer: 'customer:ama',
      collectCapableInstances: CONNECTED_INSTANCES,
    });
    expect(deriveShareableRequest(journey)).toEqual({ kind: 'NOT_CREATED' });
    expect(() => markRequestShared(journey)).toThrow(/only be shared after it was created/);
  });

  it('fulfillment outcomes fold verbatim; PENDING refreshes in place', () => {
    const journey = beginCollectJourney({
      amount: { currency: 'GHS', minorUnits: '25000' },
      payer: 'customer:ama',
      collectCapableInstances: CONNECTED_INSTANCES,
    });
    const tracking = beginCollectTracking(
      applyCollectRequestResponse(journey, grantedResponse('intent_collect_1')),
    );
    const stillPending = applyCollectFulfillment(tracking, 'PENDING');
    expect(stillPending.stateName).toBe('TRACKING');

    const fulfilled = applyCollectFulfillment(stillPending, 'FULFILLED');
    expect(fulfilled.stateName).toBe('FULFILLED');
    expect(fulfilled.terminal).toBe(true);

    const expired = applyCollectFulfillment(tracking, 'EXPIRED');
    expect(expired.stateName).toBe('EXPIRED');
    expect(expired.actions.find((action) => action.actionId === 'reissue-as-new-request')?.available).toBe(true);

    const cancelled = applyCollectFulfillment(tracking, 'CANCELLED');
    expect(cancelled.stateName).toBe('CANCELLED');
  });

  it('illegal transitions throw; terminal collect journeys cannot be abandoned', () => {
    const journey = beginCollectJourney({
      amount: { currency: 'GHS', minorUnits: '25000' },
      payer: 'customer:ama',
      collectCapableInstances: CONNECTED_INSTANCES,
    });
    expect(canTransitionCollect('COMPOSING_REQUEST', 'FULFILLED')).toBe(false);
    expect(canTransitionCollect('TRACKING', 'REQUEST_CREATED')).toBe(false);
    expect(() => applyCollectFulfillment(journey, 'FULFILLED')).toThrow(/not foldable in state COMPOSING_REQUEST/);

    const fulfilled = applyCollectFulfillment(
      beginCollectTracking(applyCollectRequestResponse(journey, grantedResponse('intent_collect_2'))),
      'FULFILLED',
    );
    expect(() => abandonCollectJourney(fulfilled)).toThrow(/cannot be abandoned from terminal state/);
  });

  it('the collect mutation carries a fresh idempotency key (INV-F05)', () => {
    const session = uxSession(productJourneyHarness(), 'collect-envelope');
    const journey = beginCollectJourney({
      amount: { currency: 'GHS', minorUnits: '25000' },
      payer: 'customer:ama',
      collectCapableInstances: CONNECTED_INSTANCES,
    });
    const first = productJourneyMutationEnvelope(session, journey, 'create-collect-request');
    const second = productJourneyMutationEnvelope(session, journey, 'create-collect-request');
    expect(first.method).toBe('POST');
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });
});

// ---------------------------------------------------------------------------
// Journey 4 — Payout
// ---------------------------------------------------------------------------

const PAYOUT_DESTINATION = {
  destinationRef: asPayoutDestinationRef('dest_bank_external_1'),
  kind: 'BANK_ACCOUNT' as const,
  currency: 'USD',
  externalObservation: true as const,
};

const WITHDRAWAL_SCOPE = {
  singleUse: true as const,
  maxAmount: { currency: 'USD', minorUnits: '500000' },
  destinationRef: asPayoutDestinationRef('dest_bank_external_1'),
};

describe('payout journey', () => {
  it('a payout requires an EXPLICIT destination before anything can be submitted (fail closed)', () => {
    const journey = beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } });
    expect(journey.stateName).toBe('SPECIFYING_DESTINATION');
    expect(journey.destination).toBeUndefined();
    expect(journey.withdrawalScope).toBeUndefined();
    // No submit action exists in the specifying state at all.
    expect(journey.actions.find((action) => action.actionId === 'submit-payout')).toBeUndefined();
    expect(() =>
      productJourneyMutationEnvelope(uxSession(productJourneyHarness(), 'payout-1'), journey, 'submit-payout'),
    ).toThrow(/no action 'submit-payout' exists in state SPECIFYING_DESTINATION/);
  });

  it('a destination alone is not enough: the withdrawal-scoped authorization is ALSO required', () => {
    const journey = specifyPayoutDestination(
      beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } }),
      PAYOUT_DESTINATION,
    );
    expect(journey.stateName).toBe('CONFIRMING_SCOPE');
    const submit = journey.actions.find((action) => action.actionId === 'submit-payout');
    expect(submit?.available).toBe(false);
    expect(submit?.unavailableReason).toContain('withdrawal-scoped authorization is required');
    expect(() =>
      productJourneyMutationEnvelope(uxSession(productJourneyHarness(), 'payout-2'), journey, 'submit-payout'),
    ).toThrow(/not available in state CONFIRMING_SCOPE/);
    // The response fold also fails closed.
    expect(() => applyPayoutSubmissionResponse(journey, grantedResponse('x'))).toThrow(
      /explicit destination AND a withdrawal scope/,
    );
  });

  it('the withdrawal scope is single-use and bound to the explicit destination (connection ≠ blanket withdrawal authority)', () => {
    const journey = specifyPayoutDestination(
      beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } }),
      PAYOUT_DESTINATION,
    );
    // A scope bound to a DIFFERENT destination is rejected.
    expect(() =>
      confirmWithdrawalScope(journey, {
        singleUse: true,
        maxAmount: { currency: 'USD', minorUnits: '500000' },
        destinationRef: asPayoutDestinationRef('dest_other_bank'),
      }),
    ).toThrow(/bound to the explicit payout destination/);
    // A mismatched currency is rejected.
    expect(() =>
      confirmWithdrawalScope(journey, {
        singleUse: true,
        maxAmount: { currency: 'GHS', minorUnits: '500000' },
        destinationRef: PAYOUT_DESTINATION.destinationRef,
      }),
    ).toThrow(/denominated in GHS/);
    // A scope cannot be confirmed before a destination exists.
    expect(() =>
      confirmWithdrawalScope(beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } }), WITHDRAWAL_SCOPE),
    ).toThrow(/only be confirmed after an explicit destination/);

    const scoped = confirmWithdrawalScope(journey, WITHDRAWAL_SCOPE);
    expect(scoped.withdrawalScope?.singleUse).toBe(true);
    const scopeView = scoped.actions.find((action) => action.actionId === 'view-withdrawal-scope');
    expect(scopeView?.available).toBe(true);
  });

  it('the destination is an external-funds observation (structural marker), never custody', () => {
    expect(() =>
      specifyPayoutDestination(beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } }), {
        ...PAYOUT_DESTINATION,
        externalObservation: false as unknown as true,
      }),
    ).toThrow(/external-funds observation/);
    const observationNote = beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } }).actions.find(
      (action) => action.actionId === 'view-destination-observation-note',
    );
    expect(observationNote?.available).toBe(true);
  });

  it('happy path through the REAL api handler: destination + scope → SUBMITTED; the envelope carries both', async () => {
    const session = uxSession(productJourneyHarness(), 'payout-test');
    const journey = confirmWithdrawalScope(
      specifyPayoutDestination(
        beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } }),
        PAYOUT_DESTINATION,
      ),
      WITHDRAWAL_SCOPE,
    );
    const envelope = productJourneyMutationEnvelope(session, journey, 'submit-payout');
    expect(envelope.method).toBe('POST');
    expect(envelope.idempotencyKey).toBeDefined();
    const body = envelope.body as Record<string, unknown>;
    expect(body['destinationRef']).toBe('dest_bank_external_1');
    expect(body['externalObservation']).toBe(true);
    const scope = body['withdrawalScope'] as Record<string, unknown>;
    expect(scope['singleUse']).toBe(true);
    expect(scope['destinationRef']).toBe('dest_bank_external_1');

    const submitted = await dispatchPayoutSubmission(session, journey);
    expect(submitted.response.status).toBe(200);
    expect(submitted.journey.stateName).toBe('SUBMITTED');
    expect(submitted.journey.submittedIntentId).toBeDefined();
  });

  it('re-entering destination selection clears BOTH destination and scope', () => {
    const journey = confirmWithdrawalScope(
      specifyPayoutDestination(
        beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } }),
        PAYOUT_DESTINATION,
      ),
      WITHDRAWAL_SCOPE,
    );
    const reset = reenterPayoutDestinationSelection(journey);
    expect(reset.stateName).toBe('SPECIFYING_DESTINATION');
    expect(reset.destination).toBeUndefined();
    expect(reset.withdrawalScope).toBeUndefined();
  });

  it('approval folding (INV-A03): 202 parks the payout; confirmation returns to scope confirmation with the artifact reference', () => {
    const journey = confirmWithdrawalScope(
      specifyPayoutDestination(
        beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } }),
        PAYOUT_DESTINATION,
      ),
      WITHDRAWAL_SCOPE,
    );
    const awaiting = applyPayoutSubmissionResponse(
      journey,
      approvalRequiredResponse({ requestHash: 'hash-payout-1', expiresAt: '2026-10-02T01:00:00Z' }),
    );
    expect(awaiting.stateName).toBe('AWAITING_APPROVAL');
    expect(awaiting.actions.find((action) => action.actionId === 'open-trusted-approval-surface')?.kind).toBe(
      'TRUSTED_SURFACE',
    );
    const confirmed = confirmPayoutApproval(awaiting);
    expect(confirmed.stateName).toBe('CONFIRMING_SCOPE');
    const envelope = productJourneyMutationEnvelope(uxSession(productJourneyHarness(), 'payout-3'), confirmed, 'submit-payout');
    expect((envelope.body as Record<string, unknown>)['approvalArtifactRef']).toBe(approvalArtifactRef('hash-payout-1'));
  });

  it('payout outcome tracking: OUTCOME_UNKNOWN is NEVER FAILED (INV-X01)', () => {
    const journey = confirmWithdrawalScope(
      specifyPayoutDestination(
        beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } }),
        PAYOUT_DESTINATION,
      ),
      WITHDRAWAL_SCOPE,
    );
    const submitted = applyPayoutSubmissionResponse(journey, grantedResponse('intent_payout_1'));
    const unknown = applyPayoutOutcome(submitted, 'OUTCOME_UNKNOWN', [asEvidenceArtifactRef('ev_payout_amb_1')]);
    expect(unknown.stateName).toBe('RECONCILING');
    expect(unknown.terminal).toBe(false);
    expect(trackedOutcomeUiState('OUTCOME_UNKNOWN')).toBe(mapTerminalStateToUi('UNKNOWN'));

    const still = applyPayoutReconciliationResolution(unknown, 'STILL_UNKNOWN', asEvidenceArtifactRef('ev_payout_obs_1'));
    expect(still.stateName).toBe('RECONCILING');
    const resolved = applyPayoutReconciliationResolution(still, 'RESOLVED_FULFILLED', asEvidenceArtifactRef('ev_payout_res_1'));
    expect(resolved.stateName).toBe('COMPLETED');
    expect(resolved.terminal).toBe(true);
  });

  it('illegal transitions throw; a submitted payout cannot be abandoned', () => {
    expect(canTransitionPayout('SPECIFYING_DESTINATION', 'SUBMITTED')).toBe(false);
    expect(canTransitionPayout('CONFIRMING_SCOPE', 'COMPLETED')).toBe(false);
    const journey = confirmWithdrawalScope(
      specifyPayoutDestination(
        beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } }),
        PAYOUT_DESTINATION,
      ),
      WITHDRAWAL_SCOPE,
    );
    const submitted = applyPayoutSubmissionResponse(journey, grantedResponse('intent_payout_2'));
    expect(() => abandonPayoutJourney(submitted)).toThrow(/cannot be abandoned/);
    expect(abandonPayoutJourney(journey).stateName).toBe('ABANDONED');
  });
});

// ---------------------------------------------------------------------------
// Journey 5 — Reconcile (payment outcome)
// ---------------------------------------------------------------------------

describe('reconcile-payment-outcome journey', () => {
  it('ambiguity-first lifecycle: observation cannot be awaited before the ambiguity is RECORDED (with evidence)', () => {
    const journey = beginReconcileJourney({ paymentRef: 'intent_pay_9', reconciliationCaseRef: 'case_1' });
    expect(journey.stateName).toBe('TRACKING_IN_FLIGHT');
    // TRACKING_IN_FLIGHT → PENDING_OBSERVATION is illegal: the ambiguity must
    // be recorded first (the observation itself is evidence, INV-E02).
    expect(canTransitionReconcile('TRACKING_IN_FLIGHT', 'PENDING_OBSERVATION')).toBe(false);
    expect(() => awaitFurtherObservation(journey, asEvidenceArtifactRef('ev_1'))).toThrow(/not legal/);
  });

  it('the full ambiguity lifecycle with its evidence chain', () => {
    const journey = beginReconcileJourney({ paymentRef: 'intent_pay_9', reconciliationCaseRef: 'case_1' });
    const ambiguous = recordOutcomeUnknown(journey, asEvidenceArtifactRef('ev_ambiguity_1'));
    expect(ambiguous.stateName).toBe('OUTCOME_UNKNOWN');
    expect(ambiguous.attemptOutcome).toBe('OUTCOME_UNKNOWN');
    expect(ambiguous.evidenceRefs).toContain('ev_ambiguity_1');

    const pending = awaitFurtherObservation(ambiguous, asEvidenceArtifactRef('ev_observation_1'));
    expect(pending.stateName).toBe('PENDING_OBSERVATION');

    const ambiguousAgain = recordOutcomeUnknown(pending, asEvidenceArtifactRef('ev_ambiguity_2'));
    expect(ambiguousAgain.stateName).toBe('OUTCOME_UNKNOWN');

    const resolved = applyReconciliationResolution(
      ambiguousAgain,
      'RESOLVED_FULFILLED',
      asEvidenceArtifactRef('ev_resolution_1'),
    );
    expect(resolved.stateName).toBe('RESOLVED_FULFILLED');
    expect(resolved.terminal).toBe(true);
    expect(resolved.evidenceRefs).toEqual([
      'ev_ambiguity_1',
      'ev_observation_1',
      'ev_ambiguity_2',
      'ev_resolution_1',
    ]);
  });

  it('UNKNOWN never renders as failure (INV-X01, same mapTerminalStateToUi consumption)', () => {
    expect(reconcileJourneyUiState('OUTCOME_UNKNOWN')).toBe(mapTerminalStateToUi('UNKNOWN'));
    expect(reconcileJourneyUiState('PENDING_OBSERVATION')).toBe('reconciling');
    expect(reconcileJourneyUiState('OUTCOME_UNKNOWN')).not.toBe('failed');
    expect(reconcileJourneyUiState('TRACKING_IN_FLIGHT')).toBe('reconciling');
    expect(reconcileJourneyUiState('RESOLVED_FULFILLED')).toBe('fulfilled');
    expect(reconcileJourneyUiState('RESOLVED_FAILED')).toBe('failed');
  });

  it('terminal reconciliation states have no outgoing transitions; in-flight resolution is legal (authority observation)', () => {
    expect(canTransitionReconcile('RESOLVED_FULFILLED', 'OUTCOME_UNKNOWN')).toBe(false);
    expect(canTransitionReconcile('RESOLVED_FAILED', 'PENDING_OBSERVATION')).toBe(false);
    // An unambiguous in-flight observation may resolve directly.
    expect(canTransitionReconcile('TRACKING_IN_FLIGHT', 'RESOLVED_FULFILLED')).toBe(true);
    const journey = beginReconcileJourney({ paymentRef: 'intent_pay_10' });
    expect(
      applyReconciliationResolution(journey, 'RESOLVED_FAILED', asEvidenceArtifactRef('ev_fail_1')).stateName,
    ).toBe('RESOLVED_FAILED');
  });

  it('the observation mutation is available exactly in the ambiguity/observation states, with a fresh key (INV-F05)', () => {
    const session = uxSession(productJourneyHarness(), 'reconcile-envelope');
    const inFlight = beginReconcileJourney({ paymentRef: 'intent_pay_11' });
    // No dead buttons: the in-flight state still shows the payment record.
    expect(inFlight.actions.find((action) => action.actionId === 'view-payment-record')?.available).toBe(true);
    expect(() => productJourneyMutationEnvelope(session, inFlight, 'request-fresh-observation')).toThrow(
      /no action 'request-fresh-observation' exists in state TRACKING_IN_FLIGHT/,
    );

    const ambiguous = recordOutcomeUnknown(inFlight, asEvidenceArtifactRef('ev_amb_1'));
    const first = productJourneyMutationEnvelope(session, ambiguous, 'request-fresh-observation');
    const second = productJourneyMutationEnvelope(session, ambiguous, 'request-fresh-observation');
    expect(first.method).toBe('POST');
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect((first.body as Record<string, unknown>)['correlationId']).toBe('intent_pay_11');

    const pending = awaitFurtherObservation(ambiguous, asEvidenceArtifactRef('ev_obs_1'));
    expect(productJourneyMutationEnvelope(session, pending, 'request-fresh-observation').method).toBe('POST');
  });

  it('the observation intent reaches the REAL api handler', async () => {
    const session = uxSession(productJourneyHarness(), 'reconcile-test');
    const ambiguous = recordOutcomeUnknown(
      beginReconcileJourney({ paymentRef: 'intent_pay_12', reconciliationCaseRef: 'case_12' }),
      asEvidenceArtifactRef('ev_amb_2'),
    );
    const response = await dispatchReconciliationObservation(session, ambiguous);
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Journey 6 — Evidence
// ---------------------------------------------------------------------------

const EVIDENCE_ARTIFACTS = [
  {
    artifactRef: asEvidenceArtifactRef('ev_browser_1'),
    summary: 'browser-local screenshot of the checkout',
    provenance: { source: 'BROWSER_LOCAL' as const },
  },
  {
    artifactRef: asEvidenceArtifactRef('ev_user_1'),
    summary: 'user-reported payment confirmation',
    provenance: { source: 'USER_REPORT' as const },
  },
  {
    artifactRef: asEvidenceArtifactRef('ev_connector_1'),
    summary: 'connector observation of the external charge',
    provenance: { source: 'CONNECTED_INSTANCE' as const, systemName: 'stripe' },
  },
  {
    artifactRef: asEvidenceArtifactRef('ev_provider_1'),
    summary: 'preserved provider state envelope',
    provenance: { source: 'PROVIDER_ENVELOPE' as const, systemName: 'psp-one' },
  },
];

describe('evidence journey', () => {
  it('provenance strength is consumed from incumbent-views (INV-E04 order); the list renders strongest-first', () => {
    const entries = deriveEvidenceList(EVIDENCE_ARTIFACTS);
    expect(entries.map((entry) => entry.artifactRef)).toEqual([
      'ev_provider_1',
      'ev_connector_1',
      'ev_user_1',
      'ev_browser_1',
    ]);
    expect(entries[0]?.provenanceLabel.strength).toBe('AUTHENTICATED_PROVIDER_RECORD');
    expect(entries[1]?.provenanceLabel.strength).toBe('CONNECTOR_OBSERVED');
    expect(entries[2]?.provenanceLabel.strength).toBe('USER_REPORTED');
    expect(entries[3]?.provenanceLabel.strength).toBe('UNVERIFIED_BROWSER_ARTIFACT');

    // The strongest entry is what a resolution claim may rest on.
    const strongest = strongestEvidenceEntry(EVIDENCE_ARTIFACTS);
    expect(strongest?.artifactRef).toBe('ev_provider_1');
  });

  it('a browser-local artifact is never stronger than its authenticated provenance (INV-E04)', () => {
    const entries = deriveEvidenceList(EVIDENCE_ARTIFACTS);
    const browser = entries.find((entry) => entry.artifactRef === 'ev_browser_1');
    const connector = entries.find((entry) => entry.artifactRef === 'ev_connector_1');
    const provider = entries.find((entry) => entry.artifactRef === 'ev_provider_1');
    expect(browser !== undefined && connector !== undefined && provider !== undefined).toBe(true);
    if (browser !== undefined && connector !== undefined && provider !== undefined) {
      expect(browser.rank).toBeLessThan(connector.rank);
      expect(connector.rank).toBeLessThan(provider.rank);
      // The INV-E04 strength order is the consumed one.
      expect(PROVENANCE_STRENGTH_ORDER.indexOf(browser.provenanceLabel.strength)).toBe(0);
      expect(PROVENANCE_STRENGTH_ORDER.indexOf(provider.provenanceLabel.strength)).toBe(
        PROVENANCE_STRENGTH_ORDER.length - 1,
      );
    }
  });

  it('the strongest entry is deterministic on rank ties (artifact-ref order)', () => {
    const tied = strongestEvidenceEntry([
      {
        artifactRef: asEvidenceArtifactRef('ev_tie_b'),
        summary: 'tied connector observation',
        provenance: { source: 'CONNECTED_INSTANCE' as const },
      },
      {
        artifactRef: asEvidenceArtifactRef('ev_tie_a'),
        summary: 'another tied connector observation',
        provenance: { source: 'CONNECTED_INSTANCE' as const },
      },
    ]);
    expect(tied?.artifactRef).toBe('ev_tie_a');
  });

  it('inspect and return; unknown artifacts fail closed; the journey is READ-ONLY (no API_COMMAND action in any state)', () => {
    const listing = beginEvidenceInspection({ actionRef: 'intent_pay_20', artifacts: EVIDENCE_ARTIFACTS });
    expect(listing.stateName).toBe('LISTING');
    expect(listing.actions.every((action) => action.kind !== 'API_COMMAND')).toBe(true);

    const inspecting = inspectEvidenceArtifact(listing, asEvidenceArtifactRef('ev_provider_1'));
    expect(inspecting.stateName).toBe('INSPECTING_ARTIFACT');
    expect(inspecting.inspectedArtifactRef).toBe('ev_provider_1');
    expect(inspecting.actions.every((action) => action.kind !== 'API_COMMAND')).toBe(true);

    const back = backToEvidenceList(inspecting);
    expect(back.stateName).toBe('LISTING');

    expect(() => inspectEvidenceArtifact(listing, asEvidenceArtifactRef('ev_unknown'))).toThrow(
      /not among the evidence entries/,
    );
    expect(canTransitionEvidence('LISTING', 'LISTING')).toBe(false);
    expect(() => backToEvidenceList(listing)).toThrow(/not legal/);
  });

  it('an empty evidence list is honest (no dead buttons, no strongest entry)', () => {
    const listing = beginEvidenceInspection({ actionRef: 'intent_pay_21', artifacts: [] });
    expect(listing.entries).toEqual([]);
    expect(listing.strongest).toBeUndefined();
    expect(listing.actions.find((action) => action.actionId === 'view-provenance-strength-order')?.available).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Journey 7 — Reauth
// ---------------------------------------------------------------------------

const REAUTH_LINEAGE = {
  intentId: 'intent_original_1',
  attemptId: 'att_original_1',
  commandHash: 'cmdhash_1',
  originalCommandType: 'payments.intent.create',
  amount: { currency: 'USD', minorUnits: '5000' },
};

function begunReauthJourney() {
  return beginReauthorization({ trigger: 'EXPIRED', lineage: REAUTH_LINEAGE });
}

describe('reauthorize journey', () => {
  it('the full cycle through the REAL api handler preserves the lineage verbatim at every step', async () => {
    const session = uxSession(productJourneyHarness(), 'reauth-test');
    const expired = begunReauthJourney();
    expect(expired.stateName).toBe('AUTHORIZATION_EXPIRED');
    expect(expired.terminal).toBe(false);
    expect(expired.lineage).toEqual(REAUTH_LINEAGE);

    // The fresh-authorization request reaches the REAL api handler.
    const requested = await dispatchReauthorizationRequest(session, expired);
    expect(requested.response.status).toBe(202);
    expect(requested.journey.stateName).toBe('CUSTOMER_ACTION_REQUIRED');
    expect(requested.journey.approval?.requestHash).toBeDefined();
    expect(requested.journey.lineage).toEqual(REAUTH_LINEAGE);

    // The trusted browser surface.
    const reauthorizing = beginTrustedSurfaceReauthorization(requested.journey);
    expect(reauthorizing.stateName).toBe('REAUTHORIZING_ON_TRUSTED_SURFACE');
    expect(reauthorizing.lineage).toEqual(REAUTH_LINEAGE);

    // The fresh authorization is recorded with BOTH opaque references.
    const fresh = recordFreshAuthorization(reauthorizing, {
      authorizationRef: asReauthorizationRef('reauth_ref_1'),
      evidenceRef: asEvidenceArtifactRef('ev_fresh_auth_1'),
    });
    expect(fresh.stateName).toBe('FRESH_AUTHORIZATION_RECORDED');
    expect(fresh.freshAuthorization?.authorizationRef).toBe('reauth_ref_1');
    expect(fresh.freshAuthorization?.evidenceRef).toBe('ev_fresh_auth_1');
    expect(fresh.lineage).toEqual(REAUTH_LINEAGE);

    // The resume mutation carries the lineage correlation + the new
    // authorization reference, and a fresh idempotency key.
    const envelope = productJourneyMutationEnvelope(session, fresh, 'resume-execution');
    expect(envelope.method).toBe('POST');
    expect(envelope.idempotencyKey).toBeDefined();
    const body = envelope.body as Record<string, unknown>;
    expect(body['commandType']).toBe('payments.intent.create');
    expect(body['correlationId']).toBe('intent_original_1');
    expect(body['reauthorizationRef']).toBe('reauth_ref_1');

    const resumed = await dispatchResumeExecution(session, fresh);
    expect(resumed.response.status).toBe(200);
    expect(resumed.journey.stateName).toBe('EXECUTION_RESUMED');
    expect(resumed.journey.terminal).toBe(true);
    expect(resumed.journey.resumedIntentId).toBeDefined();
    expect(resumed.journey.lineage).toEqual(REAUTH_LINEAGE);
    // The lineage stays inspectable after the resume (old intent, new authorization).
    expect(resumed.journey.actions.find((action) => action.actionId === 'view-lineage')?.available).toBe(true);
  });

  it('execution cannot resume before a fresh authorization is recorded (illegal at every earlier state)', async () => {
    const expired = begunReauthJourney();
    const requested = applyReauthorizationRequestResponse(
      expired,
      approvalRequiredResponse({ requestHash: 'hash-reauth-1', expiresAt: '2026-10-02T01:00:00Z' }),
    );
    const reauthorizing = beginTrustedSurfaceReauthorization(requested);
    const session = uxSession(productJourneyHarness(), 'reauth-illegal');
    for (const journey of [expired, requested, reauthorizing]) {
      expect(journey.actions.find((action) => action.actionId === 'resume-execution')).toBeUndefined();
      await expect(dispatchResumeExecution(session, journey)).rejects.toThrow(/resume-execution/);
    }
    expect(canTransitionReauth('AUTHORIZATION_EXPIRED', 'EXECUTION_RESUMED')).toBe(false);
    expect(canTransitionReauth('CUSTOMER_ACTION_REQUIRED', 'FRESH_AUTHORIZATION_RECORDED')).toBe(false);
    expect(() => applyExecutionResumedResponse(reauthorizing, grantedResponse('x'))).toThrow(
      /recorded fresh authorization/,
    );
  });

  it('the trigger is carried (EXPIRED vs STEP_UP_REQUIRED) with honest guidance', () => {
    const expired = begunReauthJourney();
    expect(expired.trigger).toBe('EXPIRED');
    const stepUp = beginReauthorization({ trigger: 'STEP_UP_REQUIRED', lineage: REAUTH_LINEAGE });
    expect(stepUp.trigger).toBe('STEP_UP_REQUIRED');
    expect(expired.actions.find((action) => action.actionId === 'view-why-reauth-needed')?.label).toContain('expired');
    expect(stepUp.actions.find((action) => action.actionId === 'view-why-reauth-needed')?.label).toContain('step-up');
  });

  it('a bare grant in response to the reauthorization request is an honest contract error; a resume approval parks with the artifact path', () => {
    const expired = begunReauthJourney();
    expect(() => applyReauthorizationRequestResponse(expired, grantedResponse('x'))).toThrow(
      /expected to produce an approval request or an error/,
    );
    const errored = applyReauthorizationRequestResponse(expired, errorResponse('AUTHORIZATION', 'session_expired', 'expired'));
    expect(errored.stateName).toBe('AUTHORIZATION_EXPIRED');
    expect(errored.error?.code).toBe('session_expired');

    const fresh = recordFreshAuthorization(
      beginTrustedSurfaceReauthorization(
        applyReauthorizationRequestResponse(
          expired,
          approvalRequiredResponse({ requestHash: 'hash-reauth-2', expiresAt: '2026-10-02T01:00:00Z' }),
        ),
      ),
      { authorizationRef: asReauthorizationRef('reauth_ref_2'), evidenceRef: asEvidenceArtifactRef('ev_2') },
    );
    const parked = applyExecutionResumedResponse(
      fresh,
      approvalRequiredResponse({ requestHash: 'hash-resume-1', expiresAt: '2026-10-02T02:00:00Z' }),
    );
    expect(parked.stateName).toBe('FRESH_AUTHORIZATION_RECORDED');
    expect(parked.approval?.requestHash).toBe('hash-resume-1');
    // The resume re-dispatch then carries the approval artifact reference.
    const envelope = productJourneyMutationEnvelope(uxSession(productJourneyHarness(), 'reauth-approval'), parked, 'resume-execution');
    expect((envelope.body as Record<string, unknown>)['approvalArtifactRef']).toBe(approvalArtifactRef('hash-resume-1'));
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting contracts — state table, no dead buttons, idempotency, nav
// ---------------------------------------------------------------------------

function drivenConnectProviderJourneys(): ProductJourney[] {
  const idle = beginConnectProvider({ catalogue: CATALOGUE });
  const browsing = browseProviderCatalogue(idle);
  const initiating = chooseProvider(browsing, 'stripe');
  const awaiting = applyConnectionInitiationResponse(initiating, grantedResponse('intent_drive_c_1'));
  const connected = applyConnectionAuthorizationOutcome(awaiting, {
    instanceId: asConnectedCapabilityInstanceId('inst_drive_1'),
    providerId: 'stripe',
    connectedAt: '2026-10-02T00:00:00Z',
    state: 'ACTIVE',
  });
  const expired = applyConnectionAuthorizationOutcome(awaiting, {
    instanceId: asConnectedCapabilityInstanceId('inst_drive_1'),
    providerId: 'stripe',
    connectedAt: '2026-10-02T00:00:00Z',
    state: 'EXPIRED',
  });
  const revoked = applyConnectionAuthorizationOutcome(connected, {
    instanceId: asConnectedCapabilityInstanceId('inst_drive_1'),
    providerId: 'stripe',
    connectedAt: '2026-10-02T00:00:00Z',
    state: 'REVOKED',
  });
  return [idle, browsing, initiating, awaiting, connected, expired, revoked];
}

function drivenPayJourneys(): ProductJourney[] {
  const selecting = begunPayJourney();
  const reviewing = selectPayCapability(selecting, asConnectedCapabilityInstanceId('inst_momo_gh_1'), []);
  const awaiting = applyPaymentSubmissionResponse(
    reviewing,
    approvalRequiredResponse({ requestHash: 'hash-drive-pay', expiresAt: '2026-10-02T01:00:00Z' }),
  );
  const submitted = applyPaymentSubmissionResponse(reviewing, grantedResponse('intent_drive_p_1'));
  const tracking = applyPayOutcome(submitted, 'IN_FLIGHT');
  const reconciling = applyPayOutcome(submitted, 'OUTCOME_UNKNOWN');
  const completed = applyPayOutcome(submitted, 'SUCCEEDED');
  const failed = applyPayOutcome(submitted, 'FAILED');
  const abandoned = abandonPayJourney(selecting);
  return [selecting, reviewing, awaiting, submitted, tracking, reconciling, completed, failed, abandoned];
}

function drivenCollectJourneys(): ProductJourney[] {
  const composing = beginCollectJourney({
    amount: { currency: 'GHS', minorUnits: '25000' },
    payer: 'customer:ama',
    collectCapableInstances: CONNECTED_INSTANCES,
  });
  const created = applyCollectRequestResponse(composing, grantedResponse('intent_drive_c_1'));
  const shared = markRequestShared(created);
  const tracking = beginCollectTracking(shared);
  const fulfilled = applyCollectFulfillment(tracking, 'FULFILLED');
  const expired = applyCollectFulfillment(tracking, 'EXPIRED');
  const cancelled = applyCollectFulfillment(tracking, 'CANCELLED');
  const abandoned = abandonCollectJourney(composing);
  return [composing, created, shared, tracking, fulfilled, expired, cancelled, abandoned];
}

function drivenPayoutJourneys(): ProductJourney[] {
  const specifying = beginPayoutJourney({ amount: { currency: 'USD', minorUnits: '250000' } });
  const confirming = confirmWithdrawalScope(
    specifyPayoutDestination(specifying, PAYOUT_DESTINATION),
    WITHDRAWAL_SCOPE,
  );
  const awaiting = applyPayoutSubmissionResponse(
    confirming,
    approvalRequiredResponse({ requestHash: 'hash-drive-payout', expiresAt: '2026-10-02T01:00:00Z' }),
  );
  const submitted = applyPayoutSubmissionResponse(confirming, grantedResponse('intent_drive_po_1'));
  const tracking = applyPayoutOutcome(submitted, 'PENDING');
  const reconciling = applyPayoutOutcome(submitted, 'OUTCOME_UNKNOWN');
  const completed = applyPayoutOutcome(submitted, 'SUCCEEDED');
  const failed = applyPayoutOutcome(submitted, 'FAILED');
  const abandoned = abandonPayoutJourney(specifying);
  return [specifying, confirming, awaiting, submitted, tracking, reconciling, completed, failed, abandoned];
}

function drivenReconcileJourneys(): ProductJourney[] {
  const inFlight = beginReconcileJourney({ paymentRef: 'intent_drive_r_1' });
  const ambiguous = recordOutcomeUnknown(inFlight, asEvidenceArtifactRef('ev_drive_1'));
  const pending = awaitFurtherObservation(ambiguous, asEvidenceArtifactRef('ev_drive_2'));
  const resolvedFulfilled = applyReconciliationResolution(ambiguous, 'RESOLVED_FULFILLED', asEvidenceArtifactRef('ev_drive_3'));
  const resolvedFailed = applyReconciliationResolution(pending, 'RESOLVED_FAILED', asEvidenceArtifactRef('ev_drive_4'));
  return [inFlight, ambiguous, pending, resolvedFulfilled, resolvedFailed];
}

function drivenEvidenceJourneys(): ProductJourney[] {
  const listing = beginEvidenceInspection({ actionRef: 'intent_drive_e_1', artifacts: EVIDENCE_ARTIFACTS });
  const inspecting = inspectEvidenceArtifact(listing, asEvidenceArtifactRef('ev_provider_1'));
  return [listing, inspecting];
}

function drivenReauthJourneys(): ProductJourney[] {
  const expired = begunReauthJourney();
  const customerAction = applyReauthorizationRequestResponse(
    expired,
    approvalRequiredResponse({ requestHash: 'hash-drive-reauth', expiresAt: '2026-10-02T01:00:00Z' }),
  );
  const reauthorizing = beginTrustedSurfaceReauthorization(customerAction);
  const fresh = recordFreshAuthorization(reauthorizing, {
    authorizationRef: asReauthorizationRef('reauth_drive_1'),
    evidenceRef: asEvidenceArtifactRef('ev_drive_reauth_1'),
  });
  const resumed = applyExecutionResumedResponse(fresh, grantedResponse('intent_drive_ra_1'));
  return [expired, customerAction, reauthorizing, fresh, resumed];
}

function allDrivenProductJourneys(): readonly ProductJourney[] {
  return [
    ...drivenConnectProviderJourneys(),
    ...drivenPayJourneys(),
    ...drivenCollectJourneys(),
    ...drivenPayoutJourneys(),
    ...drivenReconcileJourneys(),
    ...drivenEvidenceJourneys(),
    ...drivenReauthJourneys(),
  ];
}

describe('cross-cutting product journey contracts', () => {
  it('the declared state table matches the driven journeys exactly (states AND terminal flags)', () => {
    const driven = allDrivenProductJourneys();
    const seen = new Map<string, Set<string>>();
    for (const journey of driven) {
      const spec = PRODUCT_JOURNEY_STATES.find((candidate) => candidate.journeyId === journey.journeyId);
      expect(spec, `journey ${journey.journeyId} is declared in the state table`).toBeDefined();
      const entry = spec?.states.find((candidate) => candidate.stateName === journey.stateName);
      expect(
        entry,
        `state ${journey.stateName} of ${journey.journeyId} is declared in the state table`,
      ).toBeDefined();
      expect(journey.terminal).toBe(entry?.terminal);
      const states = seen.get(journey.journeyId) ?? new Set<string>();
      states.add(journey.stateName);
      seen.set(journey.journeyId, states);
    }
    // Every declared state is exercised by the drivers above.
    for (const spec of PRODUCT_JOURNEY_STATES) {
      for (const entry of spec.states) {
        expect(
          seen.get(spec.journeyId)?.has(entry.stateName),
          `${spec.journeyId}:${entry.stateName} is driven by the contract tests`,
        ).toBe(true);
      }
    }
    // The product journey ids are distinct from the payment journeys' ids
    // (consume-don't-duplicate: a second journey family, not a shadow of one).
    const paymentIds = PAYMENT_JOURNEY_STATES.map((spec) => spec.journeyId);
    for (const journeyId of PRODUCT_JOURNEY_IDS) {
      expect(paymentIds).not.toContain(journeyId);
    }
  });

  it('no dead buttons: every driven state of every product journey declares at least one available action', () => {
    for (const journey of allDrivenProductJourneys()) {
      expect(
        productJourneyStateHasLiveActions(journey),
        `${journey.journeyId}:${journey.stateName} has live actions`,
      ).toBe(true);
    }
  });

  it('every available API_COMMAND mutation in every driven state is a VALIDATED envelope with a fresh idempotency key (INV-F05)', () => {
    const session = uxSession(productJourneyHarness(), 'cross-cutting');
    let mutationsChecked = 0;
    for (const journey of allDrivenProductJourneys()) {
      for (const action of journey.actions) {
        if (action.kind !== 'API_COMMAND' || !action.available || action.apiCommand === undefined) {
          continue;
        }
        const first = productJourneyMutationEnvelope(session, journey, action.actionId);
        expect(validateRequestEnvelope(first).ok).toBe(true);
        if (action.apiCommand.method === 'POST') {
          expect(typeof first.idempotencyKey).toBe('string');
          const second = productJourneyMutationEnvelope(session, journey, action.actionId);
          expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
        } else {
          // Reads never carry a key (only mutations do).
          expect(first.idempotencyKey).toBeUndefined();
        }
        mutationsChecked += 1;
      }
    }
    // The driven corpus really exercises the mutation machinery.
    expect(mutationsChecked).toBeGreaterThan(5);
  });

  it('the journeys bind to REAL navigation items (Wave-2 binding points, consumed from product-ia)', () => {
    for (const [journeyId, navItemId] of Object.entries(JOURNEY_NAV_BINDINGS)) {
      expect(() => navItemById(navItemId as ProductNavItemId)).not.toThrow();
      expect(journeysForNavItem(navItemId as ProductNavItemId)).toContain(journeyId as ProductJourneyId);
    }
    expect(journeysForNavItem('payments')).toEqual(['pay', 'reconcile-payment-outcome']);
    expect(journeysForNavItem('capabilities')).toEqual(['connect-provider']);
    expect(journeysForNavItem('evidence')).toEqual(['evidence']);
    // Fail-closed on unknown nav ids (delegated to navItemById).
    expect(() => journeysForNavItem('no-such-item' as ProductNavItemId)).toThrow(/unknown navigation item/);
  });

  it('no driven product journey value carries credential-material field names (runtime scan, law 4)', () => {
    for (const journey of allDrivenProductJourneys()) {
      expect(CREDENTIAL_MATERIAL_KEY_PATTERN.test(JSON.stringify(journey)), `${journey.journeyId} is clean`).toBe(
        false,
      );
    }
  });
});
