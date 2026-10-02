/**
 * @payswap/ux — the seven product journey contracts (P3-W3-001).
 *
 * FRONTEND-UX-DEPLOYMENT ("journeys" / "Role-sensitive navigation"): the
 * product's major user journeys — ConnectProvider, Pay, Collect, Payout,
 * Reconcile, Evidence, Reauth — as PURE state machines plus view-model
 * derivations, bound to the navigation ids of product-ia.ts.
 *
 * Every journey in this module is a PROJECTION of authority state (law 2 of
 * the work order: no new financial authority — no local ledger, no invented
 * balances, no state the protocol/API is not the source of):
 *
 * - LEGAL-TRANSITIONS-ONLY: each journey declares a frozen transition table;
 *   every fold goes through `assertProductJourneyTransition`, so an illegal
 *   transition is a thrown `JourneyContractError`, never a silent state edit;
 * - the ONLY protocol channel is the existing `JourneySession` from
 *   journeys.ts (the same @payswap/api handler programmatic clients use):
 *   `productJourneyMutationEnvelope` builds the mutation with
 *   `buildJourneyRequest` and validates it with `validateRequestEnvelope` —
 *   a product journey can never emit an unauthenticated, unversioned or
 *   keyless mutation (INV-F05), and `dispatchProductJourneyAction` routes it
 *   through the SAME `dispatchJourneyCommand` the payment journeys use;
 * - terminal/UNKNOWN projections CONSUME `mapTerminalStateToUi`
 *   (@payswap/interfaces) — the one mapping the package already mandates
 *   (INV-X01: UNKNOWN never renders as failure; it is `reconciling`);
 * - approvals fold through the trusted surface (INV-A03): an
 *   APPROVAL_REQUIRED response parks the journey in its awaiting state with a
 *   TRUSTED_SURFACE action, and the re-submission carries the artifact
 *   reference derived by `approvalArtifactRef` (trusted-approvals.ts);
 * - provenance strength for evidence CONSUMES the INV-E04 order from
 *   incumbent-views.ts (`deriveProvenanceLabel`, `provenanceRank`);
 * - CREDENTIAL MATERIAL IS UNREPRESENTABLE: connection flows see only OPAQUE
 *   BRANDED REFERENCES (`BrowserSessionRef`, `ConnectedCapabilityInstanceId`,
 *   `PayoutDestinationRef`, `EvidenceArtifactRef`, `ReauthorizationRef`,
 *   `CollectRequestRef`) whose constructors validate and brand a string — a
 *   plain string is not assignable where a branded reference is required, and
 *   no journey type carries an apiKey/secret/cookie/MFA field (law 4);
 * - the CATALOGUE never authorizes (ConnectProvider): browsing the provider
 *   catalogue derives connection OPTIONS at most — a connected capability
 *   instance id enters a journey ONLY through an authority activation record
 *   folded in the awaiting-authorization state;
 * - PAYOUTS require an EXPLICIT external destination and a WITHDRAWAL-SCOPED
 *   authorization (connection is never blanket withdrawal authority): the
 *   submit mutation is available only when both are present, the scope is
 *   structurally single-use and bound to the destination reference, and the
 *   destination is an external-funds OBSERVATION, never custody;
 * - REAUTH preserves lineage: the reauthorization journey carries the
 *   original intent/attempt/command lineage through every fold, and the
 *   resume mutation executes under the NEW authorization while referencing
 *   the old lineage.
 *
 * Deterministic by construction: pure folds + the injected API port; no DOM,
 * no network, no rendering, no ambient time, no entropy.
 */

import type { ApiRequest, ApiResponse } from '@payswap/api';
import type { UiState } from '@payswap/interfaces';
import { mapTerminalStateToUi, validateRequestEnvelope } from '@payswap/interfaces';

import type { ApiCommandSpec, ViewAction } from './command-center.js';
import type { JourneyErrorResult, JourneySession } from './journeys.js';
import {
  JourneyContractError,
  buildJourneyRequest,
  dispatchJourneyCommand,
  parseIntentSubmissionResponse,
} from './journeys.js';
import type { ProvenanceLabel, ProvenanceSourceInput } from './incumbent-views.js';
import { deriveProvenanceLabel, provenanceRank } from './incumbent-views.js';
import type { ProductNavItemId } from './product-ia.js';
import { navItemById } from './product-ia.js';
import { approvalArtifactRef } from './trusted-approvals.js';

// ---------------------------------------------------------------------------
// Opaque branded references (law 4: credential material is unrepresentable)
// ---------------------------------------------------------------------------

declare const productRefBrand: unique symbol;

/**
 * An opaque reference branded at the type level. A plain `string` is NOT
 * assignable to a branded reference — the only constructor is the matching
 * `as…` function, which validates the value. These reference AUTHORITATIVE
 * objects (a browser session, a connected instance, a destination, an
 * artifact, an authorization); they are never credentials, API keys, cookies
 * or MFA material, which have no type, field or fixture in this module.
 */
type BrandedProductRef<TBrand extends string> = string & {
  readonly [productRefBrand]: TBrand;
};

/** An opaque broker browser-session reference (ConnectProvider journey). */
export type BrowserSessionRef = BrandedProductRef<'BrowserSessionRef'>;
/** An opaque connected-capability instance id (authority-issued only). */
export type ConnectedCapabilityInstanceId = BrandedProductRef<'ConnectedCapabilityInstanceId'>;
/** An opaque external payout destination reference. */
export type PayoutDestinationRef = BrandedProductRef<'PayoutDestinationRef'>;
/** An opaque evidence artifact reference. */
export type EvidenceArtifactRef = BrandedProductRef<'EvidenceArtifactRef'>;
/** An opaque fresh-authorization reference (Reauth journey). */
export type ReauthorizationRef = BrandedProductRef<'ReauthorizationRef'>;
/** An opaque collect-request reference (Collect journey). */
export type CollectRequestRef = BrandedProductRef<'CollectRequestRef'>;

function brandProductRef<TBrand extends string>(value: string, brand: TBrand): BrandedProductRef<TBrand> {
  if (typeof value !== 'string' || value.length === 0) {
    throw new JourneyContractError(`${brand} must be a non-empty string`);
  }
  if (value.length > 256) {
    throw new JourneyContractError(`${brand} exceeds 256 characters`);
  }
  if (value.trim() !== value) {
    throw new JourneyContractError(`${brand} must not have leading or trailing whitespace`);
  }
  return value as BrandedProductRef<TBrand>;
}

/** Brand a validated string as an opaque `BrowserSessionRef`. */
export function asBrowserSessionRef(value: string): BrowserSessionRef {
  return brandProductRef(value, 'BrowserSessionRef');
}

/** Brand a validated string as an opaque `ConnectedCapabilityInstanceId`. */
export function asConnectedCapabilityInstanceId(value: string): ConnectedCapabilityInstanceId {
  return brandProductRef(value, 'ConnectedCapabilityInstanceId');
}

/** Brand a validated string as an opaque `PayoutDestinationRef`. */
export function asPayoutDestinationRef(value: string): PayoutDestinationRef {
  return brandProductRef(value, 'PayoutDestinationRef');
}

/** Brand a validated string as an opaque `EvidenceArtifactRef`. */
export function asEvidenceArtifactRef(value: string): EvidenceArtifactRef {
  return brandProductRef(value, 'EvidenceArtifactRef');
}

/** Brand a validated string as an opaque `ReauthorizationRef`. */
export function asReauthorizationRef(value: string): ReauthorizationRef {
  return brandProductRef(value, 'ReauthorizationRef');
}

/** Brand a validated string as an opaque `CollectRequestRef`. */
export function asCollectRequestRef(value: string): CollectRequestRef {
  return brandProductRef(value, 'CollectRequestRef');
}

// ---------------------------------------------------------------------------
// Shared authority inputs (journeys are PROJECTIONS of these records)
// ---------------------------------------------------------------------------

/**
 * An authority-issued record of a connected capability instance. The
 * instance id enters the product exclusively through this record — never
 * through catalogue browsing (the catalogue is not authority).
 */
export interface ConnectedCapabilityInstanceRecord {
  readonly instanceId: ConnectedCapabilityInstanceId;
  readonly providerId: string;
  /** RFC 3339 — the authority's own connection timestamp. */
  readonly connectedAt: string;
  readonly state: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

/**
 * The verbatim tracked outcome of an external financial action (Pay, Payout,
 * Reconcile journeys). These tokens are carried VERBATIM from the authority
 * attempt state — the view never reinterprets them.
 */
export type TrackedOutcome =
  | 'PENDING'
  | 'IN_FLIGHT'
  | 'AWAITING_CUSTOMER_ACTION'
  | 'OUTCOME_UNKNOWN'
  | 'SUCCEEDED'
  | 'FAILED';

/**
 * Project a tracked outcome to its canonical UI state THROUGH THE SAME
 * `mapTerminalStateToUi` consumption the package mandates (INV-X01:
 * OUTCOME_UNKNOWN is `reconciling`, never `failed`).
 */
export function trackedOutcomeUiState(outcome: TrackedOutcome): UiState {
  switch (outcome) {
    case 'SUCCEEDED':
      return mapTerminalStateToUi('FULFILLED');
    case 'FAILED':
      return mapTerminalStateToUi('FAILED');
    case 'OUTCOME_UNKNOWN':
      return mapTerminalStateToUi('UNKNOWN');
    case 'AWAITING_CUSTOMER_ACTION':
      return mapTerminalStateToUi('USER_ACTION_REQUIRED');
    case 'PENDING':
    case 'IN_FLIGHT':
      // In progress: no terminal badge for intermediate states.
      return 'reconciling';
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled tracked outcome: ${String(exhaustive)}`);
    }
  }
}

/** True iff the tracked outcome is terminal (SUCCEEDED or FAILED). */
export function isTerminalTrackedOutcome(outcome: TrackedOutcome): boolean {
  return outcome === 'SUCCEEDED' || outcome === 'FAILED';
}

// ---------------------------------------------------------------------------
// Legal-transition enforcement (the shared, pure gate)
// ---------------------------------------------------------------------------

function assertProductJourneyTransition<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
  journeyId: string,
  from: S,
  to: S,
): void {
  const legal = table[from];
  if (legal === undefined || !legal.includes(to)) {
    throw new JourneyContractError(
      `${journeyId}: the transition ${from} → ${to} is not legal (legal targets from ${from}: ${
        legal === undefined ? 'none' : legal.join(', ')
      })`,
    );
  }
}

/** Build the frozen transition-table predicate for one journey. */
function transitionPredicate<S extends string>(
  table: Readonly<Record<S, readonly S[]>>,
): (from: S, to: S) => boolean {
  return (from, to) => {
    const legal = table[from];
    return legal !== undefined && legal.includes(to);
  };
}

// ---------------------------------------------------------------------------
// The mutation machinery — validated RequestEnvelopes (INV-F05), one channel
// ---------------------------------------------------------------------------

/**
 * The validated request envelope for one product-journey mutation. Reuses
 * `buildJourneyRequest` (fresh idempotency key on every POST) and
 * `validateRequestEnvelope` from the existing journeys.ts / interfaces
 * contracts — there is no second envelope path.
 */
export function productJourneyMutationEnvelope(
  session: JourneySession,
  journey: ProductJourney,
  actionId: string,
): ApiRequest {
  const action = journey.actions.find((candidate) => candidate.actionId === actionId);
  if (action === undefined) {
    throw new JourneyContractError(
      `${journey.journeyId}: no action '${actionId}' exists in state ${journey.stateName}`,
    );
  }
  if (!action.available || action.apiCommand === undefined) {
    throw new JourneyContractError(
      `${journey.journeyId}: the mutation '${actionId}' is not available in state ${journey.stateName}` +
        (action.unavailableReason === undefined ? '' : ` (${action.unavailableReason})`),
    );
  }
  const request = buildJourneyRequest(session, action.apiCommand);
  const validation = validateRequestEnvelope(request);
  if (!validation.ok) {
    throw new JourneyContractError(
      `${journey.journeyId}: the mutation '${actionId}' violates the REST contract: ${validation.violations.join('; ')}`,
    );
  }
  return request;
}

/**
 * Dispatch one product-journey mutation through the SAME api surface the
 * payment journeys use (`dispatchJourneyCommand`): validated envelope, fresh
 * idempotency key, injected handler. No parallel transport exists.
 */
export async function dispatchProductJourneyAction(
  session: JourneySession,
  journey: ProductJourney,
  actionId: string,
): Promise<ApiResponse> {
  const action = journey.actions.find((candidate) => candidate.actionId === actionId);
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError(
      `${journey.journeyId}: the mutation '${actionId}' is not available in state ${journey.stateName}`,
    );
  }
  return dispatchJourneyCommand(session, action.apiCommand);
}

/** Fold helper: the 202 approval-request shape shared by the awaiting states. */
interface AwaitingApprovalInfo {
  readonly requestHash: string;
  readonly expiresAt: string;
  readonly deepLink?: string;
}

function foldApprovalInfo(approval: {
  readonly requestHash: string;
  readonly expiresAt: string;
  readonly deepLink?: string;
}): AwaitingApprovalInfo {
  return Object.freeze({
    requestHash: approval.requestHash,
    expiresAt: approval.expiresAt,
    ...(approval.deepLink === undefined ? {} : { deepLink: approval.deepLink }),
  });
}

function trustedSurfaceAction(
  approval: AwaitingApprovalInfo,
  label: string,
): ViewAction {
  return {
    actionId: 'open-trusted-approval-surface',
    label,
    kind: 'TRUSTED_SURFACE',
    authorityRef: approval.requestHash,
    available: true,
    trustedSurface:
      approval.deepLink === undefined
        ? { requestHash: approval.requestHash }
        : { requestHash: approval.requestHash, deepLink: approval.deepLink },
  };
}

// ---------------------------------------------------------------------------
// Journey 1 — ConnectProvider (catalogue ≠ authority)
// ---------------------------------------------------------------------------

export const CONNECT_PROVIDER_STATES = [
  'idle',
  'browsing',
  'initiating',
  'awaiting-authorization',
  'connected-capability-instance',
  'expired',
  'revoked',
] as const;

export type ConnectProviderStateName = (typeof CONNECT_PROVIDER_STATES)[number];

/**
 * Legal transitions for the ConnectProvider journey. NOTE what is absent:
 * there is NO transition from `browsing` (or `initiating`) to
 * `connected-capability-instance` — a connected capability can only be
 * reached through `awaiting-authorization` plus an authority activation
 * record. The catalogue never authorizes.
 */
export const CONNECT_PROVIDER_TRANSITIONS: Readonly<
  Record<ConnectProviderStateName, readonly ConnectProviderStateName[]>
> = Object.freeze({
  idle: Object.freeze(['browsing'] as const),
  browsing: Object.freeze(['initiating', 'idle'] as const),
  initiating: Object.freeze(['awaiting-authorization', 'idle'] as const),
  'awaiting-authorization': Object.freeze([
    'connected-capability-instance',
    'expired',
    'revoked',
    'idle',
  ] as const),
  'connected-capability-instance': Object.freeze(['expired', 'revoked'] as const),
  expired: Object.freeze([] as const),
  revoked: Object.freeze([] as const),
});

/** The terminal ConnectProvider states are carried by PRODUCT_JOURNEY_STATES below. */

export function canTransitionConnectProvider(
  from: ConnectProviderStateName,
  to: ConnectProviderStateName,
): boolean {
  return transitionPredicate(CONNECT_PROVIDER_TRANSITIONS)(from, to);
}

/** One provider as listed in the catalogue (NOT authority state). */
export interface ProviderCatalogueEntry {
  readonly providerId: string;
  readonly displayName: string;
  readonly rails: readonly string[];
  readonly catalogueAvailability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
}

/**
 * A derived connection option. `connectable` mirrors catalogue availability
 * only — it is explicitly NOT connected capability: connecting requires the
 * authorization flow, and the honest note says so on every option.
 */
export interface CatalogueConnectionOption {
  readonly providerId: string;
  readonly displayName: string;
  readonly rails: readonly string[];
  readonly connectable: boolean;
  readonly connectabilityNote: string;
}

/**
 * Derive connection options from catalogue entries. Browsing the catalogue
 * yields OPTIONS TO INITIATE at most — never a connected capability
 * instance, never an instance id, never authorization of any kind.
 */
export function deriveCatalogueOptions(
  entries: readonly ProviderCatalogueEntry[],
): readonly CatalogueConnectionOption[] {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        providerId: entry.providerId,
        displayName: entry.displayName,
        rails: Object.freeze([...entry.rails]),
        connectable: entry.catalogueAvailability === 'AVAILABLE',
        connectabilityNote:
          entry.catalogueAvailability === 'AVAILABLE'
            ? 'available in the catalogue — availability is NOT connected capability; connecting requires the explicit authorization flow'
            : entry.catalogueAvailability === 'UNAVAILABLE'
              ? 'not available in the catalogue (honest datum, not a failure)'
              : 'catalogue availability is UNKNOWN — absence of knowledge is not absence of coverage, and neither is availability',
      }),
    ),
  );
}

/** The ConnectProvider journey view (pure projection). */
export interface ConnectProviderJourney {
  readonly journeyId: 'connect-provider';
  readonly stateName: ConnectProviderStateName;
  readonly terminal: boolean;
  readonly catalogue: readonly CatalogueConnectionOption[];
  readonly chosenProviderId?: string;
  /**
   * The opaque broker browser-session reference — the ONLY session material
   * this journey ever sees. Credential material has no type here.
   */
  readonly browserSessionRef?: BrowserSessionRef;
  readonly initiationIntentId?: string;
  readonly approval?: AwaitingApprovalInfo;
  /** The authority activation record that produced the terminal state. */
  readonly connectedInstance?: ConnectedCapabilityInstanceRecord;
  readonly error?: JourneyErrorResult;
  readonly actions: readonly ViewAction[];
}

function connectProviderActions(
  journey: Omit<ConnectProviderJourney, 'actions'>,
): readonly ViewAction[] {
  const actions: ViewAction[] = [];
  const base = { authorityRef: journey.chosenProviderId ?? 'connect-provider' };
  switch (journey.stateName) {
    case 'idle':
      actions.push({
        actionId: 'browse-provider-catalogue',
        label: 'Browse the provider catalogue',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'browsing':
      for (const option of journey.catalogue) {
        actions.push({
          actionId: `choose-provider:${option.providerId}`,
          label: `Connect ${option.displayName}`,
          kind: 'NAVIGATION',
          authorityRef: option.providerId,
          available: option.connectable,
          ...(option.connectable ? {} : { unavailableReason: option.connectabilityNote }),
        });
        actions.push({
          actionId: `view-connectability:${option.providerId}`,
          label: `View whether ${option.displayName} can be connected`,
          kind: 'EVIDENCE_VIEW',
          authorityRef: option.providerId,
          available: true,
        });
      }
      actions.push({
        actionId: 'view-catalogue-honesty',
        label: 'Read what the catalogue does and does not establish',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'initiating':
      actions.push({
        actionId: 'initiate-connection',
        label: 'Initiate the provider connection',
        kind: 'API_COMMAND',
        authorityRef: journey.chosenProviderId ?? 'connect-provider',
        available: journey.chosenProviderId !== undefined,
        ...(journey.chosenProviderId === undefined
          ? { unavailableReason: 'choose a provider from the catalogue first' }
          : {}),
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: 'capabilities.connection.initiate',
            providerId: journey.chosenProviderId,
            correlationId: `connect:${journey.chosenProviderId}`,
          },
        },
      });
      actions.push({
        actionId: 'view-initiation-terms',
        label: 'View what connecting this provider authorizes (and what it does not)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'awaiting-authorization':
      if (journey.approval !== undefined) {
        actions.push(
          trustedSurfaceAction(
            journey.approval,
            'Complete the connection approval on the trusted surface',
          ),
        );
      }
      actions.push({
        actionId: 'complete-provider-authorization',
        label: 'Complete the provider authorization in the browser session',
        kind: 'EXTERNAL_OPEN',
        authorityRef: journey.browserSessionRef ?? 'provider-authorization',
        available: true,
        externalOpen: { systemName: 'provider-authorization' },
      });
      actions.push({
        actionId: 'view-authorization-evidence',
        label: 'View the authorization evidence recorded so far',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'connected-capability-instance':
      actions.push({
        actionId: 'view-connected-instance',
        label: 'View the connected capability instance (authority record)',
        kind: 'EVIDENCE_VIEW',
        authorityRef: journey.connectedInstance?.instanceId ?? 'connected-instance',
        available: true,
      });
      actions.push({
        actionId: 'open-pay-journey',
        label: 'Use this capability to pay',
        kind: 'NAVIGATION',
        authorityRef: journey.connectedInstance?.instanceId ?? 'connected-instance',
        available: true,
      });
      break;
    case 'expired':
      actions.push({
        actionId: 'view-expiry-evidence',
        label: 'View the expiry evidence (immutable history)',
        kind: 'EVIDENCE_VIEW',
        authorityRef: journey.connectedInstance?.instanceId ?? 'connection',
        available: true,
      });
      actions.push({
        actionId: 'restart-connection',
        label: 'Start a new connection (fresh authorization)',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'revoked':
      actions.push({
        actionId: 'view-revocation-evidence',
        label: 'View the revocation evidence (immutable history)',
        kind: 'EVIDENCE_VIEW',
        authorityRef: journey.connectedInstance?.instanceId ?? 'connection',
        available: true,
      });
      actions.push({
        actionId: 'view-security-note',
        label: 'Read how revocation bounds capability authority',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new JourneyContractError(`unhandled connect-provider state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishConnectProvider(
  journey: Omit<ConnectProviderJourney, 'actions'>,
): ConnectProviderJourney {
  return Object.freeze({ ...journey, actions: connectProviderActions(journey) });
}

/** Begin the ConnectProvider journey (idle; the catalogue is authority data). */
export function beginConnectProvider(input: {
  readonly catalogue: readonly ProviderCatalogueEntry[];
}): ConnectProviderJourney {
  return finishConnectProvider({
    journeyId: 'connect-provider',
    stateName: 'idle',
    terminal: false,
    catalogue: deriveCatalogueOptions(input.catalogue),
  });
}

/** Fold: enter browsing (optionally with a refreshed catalogue). */
export function browseProviderCatalogue(
  journey: ConnectProviderJourney,
  refreshedCatalogue?: readonly ProviderCatalogueEntry[],
): ConnectProviderJourney {
  assertProductJourneyTransition(
    CONNECT_PROVIDER_TRANSITIONS,
    'connect-provider',
    journey.stateName,
    'browsing',
  );
  return finishConnectProvider({
    ...journey,
    stateName: 'browsing',
    terminal: false,
    ...(refreshedCatalogue === undefined
      ? {}
      : { catalogue: deriveCatalogueOptions(refreshedCatalogue) }),
  });
}

/**
 * Fold: choose a provider from the CATALOGUE. This transitions to
 * `initiating` only — it NEVER produces a connected capability instance, an
 * instance id, or any authorization (the catalogue is not authority).
 */
export function chooseProvider(
  journey: ConnectProviderJourney,
  providerId: string,
): ConnectProviderJourney {
  if (journey.stateName !== 'browsing') {
    throw new JourneyContractError(`choose-provider is not legal in state ${journey.stateName}`);
  }
  const option = journey.catalogue.find((candidate) => candidate.providerId === providerId);
  if (option === undefined) {
    throw new JourneyContractError(`provider ${providerId} is not in the browsed catalogue`);
  }
  if (!option.connectable) {
    throw new JourneyContractError(
      `provider ${providerId} is not connectable: ${option.connectabilityNote}`,
    );
  }
  return finishConnectProvider({
    ...journey,
    stateName: 'initiating',
    terminal: false,
    chosenProviderId: providerId,
  });
}

/**
 * Fold: attach the opaque broker browser-session reference (the journey
 * stays `initiating`; the reference is opaque — credential material has no
 * representation here).
 */
export function attachBrowserSession(
  journey: ConnectProviderJourney,
  browserSessionRef: BrowserSessionRef,
): ConnectProviderJourney {
  if (journey.stateName !== 'initiating') {
    throw new JourneyContractError(
      `attach-browser-session is not legal in state ${journey.stateName}`,
    );
  }
  return finishConnectProvider({ ...journey, browserSessionRef });
}

/** Fold the connection-initiation response (pure; via parseIntentSubmissionResponse). */
export function applyConnectionInitiationResponse(
  journey: ConnectProviderJourney,
  response: ApiResponse,
): ConnectProviderJourney {
  if (journey.stateName !== 'initiating') {
    throw new JourneyContractError(
      `a connection-initiation response is not foldable in state ${journey.stateName}`,
    );
  }
  const outcome = parseIntentSubmissionResponse(response);
  switch (outcome.kind) {
    case 'GRANTED':
      assertProductJourneyTransition(
        CONNECT_PROVIDER_TRANSITIONS,
        'connect-provider',
        journey.stateName,
        'awaiting-authorization',
      );
      return finishConnectProvider({
        ...journey,
        stateName: 'awaiting-authorization',
        initiationIntentId: outcome.intentId,
      });
    case 'APPROVAL_REQUIRED':
      assertProductJourneyTransition(
        CONNECT_PROVIDER_TRANSITIONS,
        'connect-provider',
        journey.stateName,
        'awaiting-authorization',
      );
      return finishConnectProvider({
        ...journey,
        stateName: 'awaiting-authorization',
        approval: foldApprovalInfo(outcome),
      });
    case 'ERROR':
      // An initiation error is honest, recorded, and retryable in place —
      // it never fabricates a connection state.
      return finishConnectProvider({ ...journey, error: outcome });
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled connection outcome: ${String(exhaustive)}`);
    }
  }
}

/**
 * Fold: the connection approval completed on the trusted surface (the
 * artifact was minted there — see trusted-approvals.ts). The journey remains
 * in the provider-authorization phase; the approval is consumed.
 */
export function confirmConnectionApproval(journey: ConnectProviderJourney): ConnectProviderJourney {
  if (journey.stateName !== 'awaiting-authorization' || journey.approval === undefined) {
    throw new JourneyContractError('confirm-connection-approval requires an awaited connection approval');
  }
  const { approval: _consumedApproval, ...rest } = journey;
  return finishConnectProvider(rest);
}

/**
 * Fold an AUTHORITY activation record into the journey. This is the ONLY way
 * a connected capability instance id enters a ConnectProvider journey — and
 * it is legal only from `awaiting-authorization` (or, for later
 * expiry/revocation, from `connected-capability-instance`).
 */
export function applyConnectionAuthorizationOutcome(
  journey: ConnectProviderJourney,
  record: ConnectedCapabilityInstanceRecord,
): ConnectProviderJourney {
  if (journey.stateName !== 'awaiting-authorization' && journey.stateName !== 'connected-capability-instance') {
    throw new JourneyContractError(
      `an authority activation record is not foldable in state ${journey.stateName}`,
    );
  }
  if (
    journey.chosenProviderId !== undefined &&
    record.providerId !== journey.chosenProviderId
  ) {
    throw new JourneyContractError(
      `the authority activation record is for provider ${record.providerId}, but this journey connects ${journey.chosenProviderId}`,
    );
  }
  switch (record.state) {
    case 'ACTIVE':
      assertProductJourneyTransition(
        CONNECT_PROVIDER_TRANSITIONS,
        'connect-provider',
        journey.stateName,
        'connected-capability-instance',
      );
      return finishConnectProvider({
        ...journey,
        stateName: 'connected-capability-instance',
        terminal: true,
        connectedInstance: record,
      });
    case 'EXPIRED':
      assertProductJourneyTransition(
        CONNECT_PROVIDER_TRANSITIONS,
        'connect-provider',
        journey.stateName,
        'expired',
      );
      return finishConnectProvider({
        ...journey,
        stateName: 'expired',
        terminal: true,
        connectedInstance: record,
      });
    case 'REVOKED':
      assertProductJourneyTransition(
        CONNECT_PROVIDER_TRANSITIONS,
        'connect-provider',
        journey.stateName,
        'revoked',
      );
      return finishConnectProvider({
        ...journey,
        stateName: 'revoked',
        terminal: true,
        connectedInstance: record,
      });
    default: {
      const exhaustive: never = record.state;
      throw new JourneyContractError(`unhandled instance state: ${String(exhaustive)}`);
    }
  }
}

/** Dispatch `initiate-connection` through the api surface and fold the response. */
export async function dispatchInitiateConnection(
  session: JourneySession,
  journey: ConnectProviderJourney,
): Promise<{ readonly journey: ConnectProviderJourney; readonly response: ApiResponse }> {
  const response = await dispatchProductJourneyAction(session, journey, 'initiate-connection');
  return { journey: applyConnectionInitiationResponse(journey, response), response };
}

// ---------------------------------------------------------------------------
// Journey 2 — Pay (capability from connected instances only; honest routability)
// ---------------------------------------------------------------------------

export const PAY_STATES = [
  'SELECTING_CAPABILITY',
  'REVIEWING_ROUTE',
  'AWAITING_APPROVAL',
  'SUBMITTED',
  'TRACKING',
  'RECONCILING',
  'COMPLETED',
  'FAILED',
  'ABANDONED',
] as const;

export type PayStateName = (typeof PAY_STATES)[number];

export const PAY_TRANSITIONS: Readonly<Record<PayStateName, readonly PayStateName[]>> = Object.freeze({
  SELECTING_CAPABILITY: Object.freeze(['REVIEWING_ROUTE', 'ABANDONED'] as const),
  REVIEWING_ROUTE: Object.freeze(['SUBMITTED', 'AWAITING_APPROVAL', 'SELECTING_CAPABILITY', 'ABANDONED'] as const),
  AWAITING_APPROVAL: Object.freeze(['SUBMITTED', 'REVIEWING_ROUTE', 'ABANDONED'] as const),
  SUBMITTED: Object.freeze(['TRACKING', 'COMPLETED', 'FAILED', 'RECONCILING'] as const),
  TRACKING: Object.freeze(['COMPLETED', 'FAILED', 'RECONCILING', 'TRACKING'] as const),
  RECONCILING: Object.freeze(['COMPLETED', 'FAILED', 'TRACKING', 'RECONCILING'] as const),
  COMPLETED: Object.freeze([] as const),
  FAILED: Object.freeze([] as const),
  ABANDONED: Object.freeze([] as const),
});

const PAY_TERMINAL: ReadonlySet<PayStateName> = new Set(['COMPLETED', 'FAILED', 'ABANDONED']);

export function canTransitionPay(from: PayStateName, to: PayStateName): boolean {
  return transitionPredicate(PAY_TRANSITIONS)(from, to);
}

/** The payment the Pay journey executes (exact minor units, INV-F01). */
export interface PayRequest {
  readonly amount: { readonly currency: string; readonly minorUnits: string };
  readonly recipient: string;
  readonly correlationId?: string;
}

/**
 * An authority-derived routability check for one connected instance and the
 * requested currency (e.g. GHS is honestly non-routable on a Stripe
 * instance). The journey never invents routability: an instance without a
 * check is NOT routable (fail-closed honesty).
 */
export interface CurrencyRoutabilityCheck {
  readonly instanceId: ConnectedCapabilityInstanceId;
  readonly currency: string;
  readonly routable: boolean;
  readonly reason?: string;
}

/** A selectable capability option — structurally ONLY from a connected instance. */
export interface PayCapabilityOption {
  readonly instance: ConnectedCapabilityInstanceRecord;
  readonly routable: boolean;
  readonly nonRoutableReason?: string;
}

/**
 * A route candidate for review. Candidates WITHOUT `basedOnInstanceId` are
 * CATALOGUE-DERIVED comparison entries: they render in the comparison but
 * are never executable — the catalogue is not an execution surface.
 */
export interface RouteCandidate {
  readonly methodId: string;
  readonly fees: { readonly currency: string; readonly minorUnits: string };
  readonly railPath: readonly string[];
  readonly completionMs: string;
  readonly basedOnInstanceId?: ConnectedCapabilityInstanceId;
  readonly comparisonOnlyReason?: string;
}

/** True iff the candidate executes on a CONNECTED instance. */
export function routeCandidateIsExecutable(candidate: RouteCandidate): boolean {
  return candidate.basedOnInstanceId !== undefined;
}

/** The Pay journey view (pure projection). */
export interface PayJourney {
  readonly journeyId: 'pay';
  readonly stateName: PayStateName;
  readonly terminal: boolean;
  readonly request: PayRequest;
  /** Options derived from CONNECTED instances only. */
  readonly options: readonly PayCapabilityOption[];
  readonly chosenInstanceId?: ConnectedCapabilityInstanceId;
  readonly routeCandidates?: readonly RouteCandidate[];
  readonly approval?: AwaitingApprovalInfo;
  readonly submittedIntentId?: string;
  /** The verbatim last-observed outcome of the external action. */
  readonly attemptOutcome?: TrackedOutcome;
  readonly evidenceRefs: readonly EvidenceArtifactRef[];
  readonly error?: JourneyErrorResult;
  readonly actions: readonly ViewAction[];
}

function payActions(journey: Omit<PayJourney, 'actions'>): readonly ViewAction[] {
  const actions: ViewAction[] = [];
  const base = { authorityRef: journey.request.correlationId ?? `pay:${journey.request.amount.currency}` };
  switch (journey.stateName) {
    case 'SELECTING_CAPABILITY':
      for (const option of journey.options) {
        actions.push({
          actionId: `select-capability:${option.instance.instanceId}`,
          label: `Pay with ${option.instance.providerId}`,
          kind: 'NAVIGATION',
          authorityRef: option.instance.instanceId,
          available: option.routable,
          ...(option.routable
            ? {}
            : {
                unavailableReason:
                  option.nonRoutableReason ?? 'not routable for this currency on the connected instance (honest datum, not a failure)',
              }),
        });
        if (!option.routable) {
          actions.push({
            actionId: `view-why-not-routable:${option.instance.instanceId}`,
            label: `View why ${option.instance.providerId} cannot route this currency`,
            kind: 'EVIDENCE_VIEW',
            authorityRef: option.instance.instanceId,
            available: true,
          });
        }
      }
      actions.push({
        actionId: 'connect-another-capability',
        label: 'Connect another capability',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'abandon-payment',
        label: 'Cancel this payment',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'REVIEWING_ROUTE': {
      actions.push({
        actionId: 'submit-payment',
        label: 'Submit the payment',
        kind: 'API_COMMAND',
        authorityRef: journey.chosenInstanceId ?? base.authorityRef,
        available: journey.chosenInstanceId !== undefined,
        ...(journey.chosenInstanceId === undefined
          ? { unavailableReason: 'no capability is selected' }
          : {}),
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: 'payments.intent.create',
            amount: journey.request.amount,
            correlationId: journey.request.correlationId ?? `pay:${journey.chosenInstanceId}`,
            capabilityInstanceId: journey.chosenInstanceId,
            recipient: journey.request.recipient,
            ...(journey.approval === undefined
              ? {}
              : { approvalArtifactRef: approvalArtifactRef(journey.approval.requestHash) }),
          },
        },
      });
      for (const candidate of journey.routeCandidates ?? []) {
        actions.push({
          actionId: `view-route:${candidate.methodId}`,
          label: `Compare the ${candidate.methodId} route (fees, rail path, timing)`,
          kind: 'EVIDENCE_VIEW',
          authorityRef: candidate.basedOnInstanceId ?? `catalogue:${candidate.methodId}`,
          available: true,
        });
        if (!routeCandidateIsExecutable(candidate)) {
          actions.push({
            actionId: `view-comparison-only:${candidate.methodId}`,
            label: `View why ${candidate.methodId} is comparison-only`,
            kind: 'EVIDENCE_VIEW',
            authorityRef: `catalogue:${candidate.methodId}`,
            available: true,
          });
        }
      }
      actions.push({
        actionId: 'choose-different-capability',
        label: 'Choose a different capability',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'abandon-payment',
        label: 'Cancel this payment',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    }
    case 'AWAITING_APPROVAL':
      if (journey.approval !== undefined) {
        actions.push(
          trustedSurfaceAction(journey.approval, 'Complete the payment approval on the trusted surface'),
        );
        actions.push({
          actionId: 'view-approval-status',
          label: 'View approval status',
          kind: 'API_COMMAND',
          authorityRef: journey.approval.requestHash,
          available: true,
          apiCommand: { method: 'GET', path: `/v1/approvals/${journey.approval.requestHash}` },
        });
      }
      actions.push({
        actionId: 'abandon-payment',
        label: 'Cancel this payment',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'SUBMITTED':
      actions.push({
        actionId: 'view-submitted-intent',
        label: 'View the submitted intent',
        kind: 'API_COMMAND',
        authorityRef: journey.submittedIntentId ?? base.authorityRef,
        available: journey.submittedIntentId !== undefined,
        ...(journey.submittedIntentId === undefined
          ? { unavailableReason: 'no intent id recorded on this journey' }
          : {}),
        apiCommand: {
          method: 'GET',
          path: `/v1/intents/${journey.submittedIntentId ?? 'unknown'}`,
        },
      });
      actions.push({
        actionId: 'track-payment',
        label: 'Track the payment outcome',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'TRACKING':
      actions.push({
        actionId: 'view-attempt-evidence',
        label: 'View the attempt evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.evidenceRefs.length > 0,
        ...(journey.evidenceRefs.length > 0
          ? {}
          : { unavailableReason: 'no evidence references recorded yet' }),
      });
      actions.push({
        actionId: 'refresh-outcome',
        label: 'Refresh the outcome from authoritative state',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      if (journey.attemptOutcome === 'AWAITING_CUSTOMER_ACTION') {
        actions.push({
          actionId: 'complete-customer-action',
          label: 'Complete the provider-required action',
          kind: 'EXTERNAL_OPEN',
          ...base,
          available: true,
          externalOpen: { systemName: 'provider' },
        });
      }
      break;
    case 'RECONCILING':
      actions.push({
        actionId: 'open-reconciliation-journey',
        label: 'Open the reconciliation journey for this payment',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-reconciliation-evidence',
        label: 'View the evidence recorded so far',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.evidenceRefs.length > 0,
        ...(journey.evidenceRefs.length > 0
          ? {}
          : { unavailableReason: 'no evidence references recorded yet' }),
      });
      break;
    case 'COMPLETED':
      actions.push({
        actionId: 'view-completion-evidence',
        label: 'View the completion evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'FAILED':
      actions.push({
        actionId: 'view-failure-evidence',
        label: 'View the failure evidence (protocol-sourced, never inferred)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'retry-as-new-intent',
        label: 'Retry as a new intent (fresh idempotency key)',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'ABANDONED':
      actions.push({
        actionId: 'view-journey-history',
        label: 'View journey history',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new JourneyContractError(`unhandled pay state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishPay(journey: Omit<PayJourney, 'actions'>): PayJourney {
  return Object.freeze({ ...journey, actions: payActions(journey) });
}

/**
 * Begin the Pay journey. Capability options are derived by joining the
 * CONNECTED instances with the authority routability checks — an instance
 * without a check is honestly NOT routable (fail-closed; absent data is a
 * derived state, never an exception).
 */
export function beginPayJourney(input: {
  readonly request: PayRequest;
  readonly connectedInstances: readonly ConnectedCapabilityInstanceRecord[];
  readonly routabilityChecks: readonly CurrencyRoutabilityCheck[];
}): PayJourney {
  const checks = new Map(input.routabilityChecks.map((check) => [check.instanceId, check]));
  const options: PayCapabilityOption[] = input.connectedInstances.map((instance) => {
    const check = checks.get(instance.instanceId);
    const routable = check?.routable === true;
    return Object.freeze({
      instance,
      routable,
      ...(routable
        ? {}
        : {
            nonRoutableReason:
              check === undefined
                ? `routability for ${input.request.amount.currency} is not established on this instance (absence of knowledge is not routability)`
                : check.reason ??
                  `${input.request.amount.currency} is not routable on this instance (honest provider-capability datum)`,
          }),
    });
  });
  return finishPay({
    journeyId: 'pay',
    stateName: 'SELECTING_CAPABILITY',
    terminal: false,
    request: input.request,
    options: Object.freeze(options),
    evidenceRefs: Object.freeze([]),
  });
}

/**
 * Fold: select the paying capability — ONLY from the journey's connected
 * instance options, and only a ROUTABLE one (a non-routable selection is an
 * honest rejection, not an exception swallowed into a state).
 */
export function selectPayCapability(
  journey: PayJourney,
  instanceId: ConnectedCapabilityInstanceId,
  routeCandidates: readonly RouteCandidate[],
): PayJourney {
  if (journey.stateName !== 'SELECTING_CAPABILITY') {
    throw new JourneyContractError(`select-capability is not legal in state ${journey.stateName}`);
  }
  const option = journey.options.find((candidate) => candidate.instance.instanceId === instanceId);
  if (option === undefined) {
    throw new JourneyContractError(
      `capability ${instanceId} is not among this journey's CONNECTED instance options`,
    );
  }
  if (!option.routable) {
    throw new JourneyContractError(
      `capability ${instanceId} is not routable for this payment: ${option.nonRoutableReason}`,
    );
  }
  for (const candidate of routeCandidates) {
    if (
      candidate.basedOnInstanceId !== undefined &&
      candidate.basedOnInstanceId !== instanceId
    ) {
      throw new JourneyContractError(
        `route candidate ${candidate.methodId} executes on ${candidate.basedOnInstanceId}, not on the selected instance`,
      );
    }
  }
  assertProductJourneyTransition(PAY_TRANSITIONS, 'pay', journey.stateName, 'REVIEWING_ROUTE');
  return finishPay({
    ...journey,
    stateName: 'REVIEWING_ROUTE',
    routeCandidates: Object.freeze([...routeCandidates]),
    chosenInstanceId: instanceId,
  });
}

/** Fold the payment submission response (pure). */
export function applyPaymentSubmissionResponse(
  journey: PayJourney,
  response: ApiResponse,
): PayJourney {
  const outcome = parseIntentSubmissionResponse(response);
  switch (outcome.kind) {
    case 'GRANTED':
      assertProductJourneyTransition(PAY_TRANSITIONS, 'pay', journey.stateName, 'SUBMITTED');
      return finishPay({ ...journey, stateName: 'SUBMITTED', submittedIntentId: outcome.intentId });
    case 'APPROVAL_REQUIRED':
      assertProductJourneyTransition(PAY_TRANSITIONS, 'pay', journey.stateName, 'AWAITING_APPROVAL');
      return finishPay({ ...journey, stateName: 'AWAITING_APPROVAL', approval: foldApprovalInfo(outcome) });
    case 'ERROR':
      // Honest, recorded, retryable in place — never a fabricated outcome.
      return finishPay({ ...journey, error: outcome });
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled payment submission outcome: ${String(exhaustive)}`);
    }
  }
}

/**
 * Fold: the payment approval completed on the trusted surface (INV-A03).
 * The journey returns to route review; the re-submission then carries the
 * approval artifact reference.
 */
export function confirmPayApproval(journey: PayJourney): PayJourney {
  if (journey.stateName !== 'AWAITING_APPROVAL' || journey.approval === undefined) {
    throw new JourneyContractError('confirm-pay-approval requires an awaited payment approval');
  }
  assertProductJourneyTransition(PAY_TRANSITIONS, 'pay', journey.stateName, 'REVIEWING_ROUTE');
  return finishPay({ ...journey, stateName: 'REVIEWING_ROUTE' });
}

/**
 * Fold a verbatim tracked outcome into the journey. OUTCOME_UNKNOWN enters
 * RECONCILING — it is NEVER FAILED (INV-X01); intermediate outcomes stay in
 * TRACKING carrying the token verbatim.
 */
export function applyPayOutcome(
  journey: PayJourney,
  outcome: TrackedOutcome,
  evidenceRefs?: readonly EvidenceArtifactRef[],
): PayJourney {
  if (journey.stateName !== 'SUBMITTED' && journey.stateName !== 'TRACKING' && journey.stateName !== 'RECONCILING') {
    throw new JourneyContractError(`an outcome is not foldable in state ${journey.stateName}`);
  }
  const mergedEvidence = Object.freeze([...journey.evidenceRefs, ...(evidenceRefs ?? [])]);
  switch (outcome) {
    case 'PENDING':
    case 'IN_FLIGHT':
    case 'AWAITING_CUSTOMER_ACTION':
      assertProductJourneyTransition(PAY_TRANSITIONS, 'pay', journey.stateName, 'TRACKING');
      return finishPay({
        ...journey,
        stateName: 'TRACKING',
        attemptOutcome: outcome,
        evidenceRefs: mergedEvidence,
      });
    case 'OUTCOME_UNKNOWN':
      assertProductJourneyTransition(PAY_TRANSITIONS, 'pay', journey.stateName, 'RECONCILING');
      return finishPay({
        ...journey,
        stateName: 'RECONCILING',
        attemptOutcome: outcome,
        evidenceRefs: mergedEvidence,
      });
    case 'SUCCEEDED':
      assertProductJourneyTransition(PAY_TRANSITIONS, 'pay', journey.stateName, 'COMPLETED');
      return finishPay({
        ...journey,
        stateName: 'COMPLETED',
        terminal: true,
        attemptOutcome: outcome,
        evidenceRefs: mergedEvidence,
      });
    case 'FAILED':
      assertProductJourneyTransition(PAY_TRANSITIONS, 'pay', journey.stateName, 'FAILED');
      return finishPay({
        ...journey,
        stateName: 'FAILED',
        terminal: true,
        attemptOutcome: outcome,
        evidenceRefs: mergedEvidence,
      });
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled pay outcome: ${String(exhaustive)}`);
    }
  }
}

/**
 * Fold a reconciliation resolution (from the Reconcile journey / authority).
 * A resolution REQUIRES an evidence reference; STILL_UNKNOWN stays in
 * RECONCILING and records the evidence.
 */
export function applyPayReconciliationResolution(
  journey: PayJourney,
  resolution: 'RESOLVED_FULFILLED' | 'RESOLVED_FAILED' | 'STILL_UNKNOWN',
  evidenceRef: EvidenceArtifactRef,
): PayJourney {
  if (journey.stateName !== 'RECONCILING') {
    throw new JourneyContractError(
      `a reconciliation resolution is not foldable in state ${journey.stateName}`,
    );
  }
  const evidenceRefs = Object.freeze([...journey.evidenceRefs, evidenceRef]);
  switch (resolution) {
    case 'RESOLVED_FULFILLED':
      return finishPay({
        ...journey,
        stateName: 'COMPLETED',
        terminal: true,
        attemptOutcome: 'SUCCEEDED',
        evidenceRefs,
      });
    case 'RESOLVED_FAILED':
      return finishPay({
        ...journey,
        stateName: 'FAILED',
        terminal: true,
        attemptOutcome: 'FAILED',
        evidenceRefs,
      });
    case 'STILL_UNKNOWN':
      return finishPay({ ...journey, stateName: 'RECONCILING', evidenceRefs });
    default: {
      const exhaustive: never = resolution;
      throw new JourneyContractError(`unhandled reconciliation resolution: ${String(exhaustive)}`);
    }
  }
}

/** Fold: abandon the payment (only before submission — a submitted intent is authority). */
export function abandonPayJourney(journey: PayJourney): PayJourney {
  if (journey.stateName === 'SUBMITTED' || PAY_TERMINAL.has(journey.stateName)) {
    throw new JourneyContractError(
      `a payment cannot be abandoned from state ${journey.stateName} (the intent is already authority)`,
    );
  }
  assertProductJourneyTransition(PAY_TRANSITIONS, 'pay', journey.stateName, 'ABANDONED');
  return finishPay({ ...journey, stateName: 'ABANDONED', terminal: true });
}

/** Dispatch `submit-payment` through the api surface and fold the response. */
export async function dispatchPaymentSubmission(
  session: JourneySession,
  journey: PayJourney,
): Promise<{ readonly journey: PayJourney; readonly response: ApiResponse }> {
  const response = await dispatchProductJourneyAction(session, journey, 'submit-payment');
  return { journey: applyPaymentSubmissionResponse(journey, response), response };
}

// ---------------------------------------------------------------------------
// Journey 3 — Collect (receive where connected capability permits)
// ---------------------------------------------------------------------------

export const COLLECT_STATES = [
  'COMPOSING_REQUEST',
  'REQUEST_CREATED',
  'SHARED',
  'TRACKING',
  'FULFILLED',
  'EXPIRED',
  'CANCELLED',
  'ABANDONED',
] as const;

export type CollectStateName = (typeof COLLECT_STATES)[number];

export const COLLECT_TRANSITIONS: Readonly<Record<CollectStateName, readonly CollectStateName[]>> =
  Object.freeze({
    COMPOSING_REQUEST: Object.freeze(['REQUEST_CREATED', 'ABANDONED'] as const),
    REQUEST_CREATED: Object.freeze(['SHARED', 'TRACKING', 'ABANDONED'] as const),
    SHARED: Object.freeze(['TRACKING', 'ABANDONED'] as const),
    TRACKING: Object.freeze(['FULFILLED', 'EXPIRED', 'CANCELLED', 'TRACKING'] as const),
    FULFILLED: Object.freeze([] as const),
    EXPIRED: Object.freeze([] as const),
    CANCELLED: Object.freeze([] as const),
    ABANDONED: Object.freeze([] as const),
  });

const COLLECT_TERMINAL: ReadonlySet<CollectStateName> = new Set([
  'FULFILLED',
  'EXPIRED',
  'CANCELLED',
  'ABANDONED',
]);

export function canTransitionCollect(from: CollectStateName, to: CollectStateName): boolean {
  return transitionPredicate(COLLECT_TRANSITIONS)(from, to);
}

/** The verbatim fulfillment outcome of a collect request. */
export type CollectFulfillmentOutcome = 'PENDING' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED';

/**
 * Project a collect fulfillment outcome to its canonical UI state through
 * the SAME `mapTerminalStateToUi` consumption (PENDING is WAITING →
 * reconciling; never a failure badge).
 */
export function collectFulfillmentUiState(outcome: CollectFulfillmentOutcome): UiState {
  switch (outcome) {
    case 'PENDING':
      return mapTerminalStateToUi('WAITING');
    case 'FULFILLED':
      return mapTerminalStateToUi('FULFILLED');
    case 'EXPIRED':
      return mapTerminalStateToUi('EXPIRED');
    case 'CANCELLED':
      return mapTerminalStateToUi('CANCELLED');
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled collect fulfillment outcome: ${String(exhaustive)}`);
    }
  }
}

/** The Collect journey view (pure projection). */
export interface CollectJourney {
  readonly journeyId: 'collect';
  readonly stateName: CollectStateName;
  readonly terminal: boolean;
  readonly amount: { readonly currency: string; readonly minorUnits: string };
  readonly payer: string;
  /** The connected instances that permit collecting (authority records). */
  readonly collectCapableInstances: readonly ConnectedCapabilityInstanceRecord[];
  readonly chosenInstanceId?: ConnectedCapabilityInstanceId;
  readonly requestRef?: CollectRequestRef;
  readonly approval?: AwaitingApprovalInfo;
  readonly fulfillmentOutcome?: CollectFulfillmentOutcome;
  readonly error?: JourneyErrorResult;
  readonly actions: readonly ViewAction[];
}

function collectActions(journey: Omit<CollectJourney, 'actions'>): readonly ViewAction[] {
  const actions: ViewAction[] = [];
  const base = { authorityRef: journey.requestRef ?? `collect:${journey.amount.currency}` };
  switch (journey.stateName) {
    case 'COMPOSING_REQUEST':
      actions.push({
        actionId: 'create-collect-request',
        label: 'Create the payment request',
        kind: 'API_COMMAND',
        ...base,
        available: journey.collectCapableInstances.length > 0,
        ...(journey.collectCapableInstances.length > 0
          ? {}
          : {
              unavailableReason:
                'no connected capability permits collecting yet — connect a capability first (honest empty state, not an error)',
            }),
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: 'payments.collect.request',
            amount: journey.amount,
            payer: journey.payer,
            ...(journey.chosenInstanceId === undefined
              ? {}
              : { capabilityInstanceId: journey.chosenInstanceId }),
          },
        },
      });
      if (journey.collectCapableInstances.length === 0) {
        actions.push({
          actionId: 'connect-a-capability',
          label: 'Connect a capability that permits collecting',
          kind: 'NAVIGATION',
          ...base,
          available: true,
        });
      }
      actions.push({
        actionId: 'abandon-collect',
        label: 'Cancel this request',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'REQUEST_CREATED':
    case 'SHARED':
      actions.push({
        actionId: 'share-request',
        label: 'Share the payment request with the payer',
        kind: 'EXTERNAL_OPEN',
        authorityRef: journey.requestRef ?? base.authorityRef,
        available: journey.stateName === 'REQUEST_CREATED',
        ...(journey.stateName === 'REQUEST_CREATED'
          ? {}
          : { unavailableReason: 'the request is already shared' }),
        externalOpen: { systemName: 'payer' },
      });
      actions.push({
        actionId: 'view-request',
        label: 'View the request',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'track-fulfillment',
        label: 'Track fulfillment of the request',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'TRACKING':
      actions.push({
        actionId: 'refresh-fulfillment',
        label: 'Refresh the fulfillment from authoritative state',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-request-evidence',
        label: 'View the request evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'FULFILLED':
      actions.push({
        actionId: 'view-fulfillment-evidence',
        label: 'View the fulfillment evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'EXPIRED':
      actions.push({
        actionId: 'reissue-as-new-request',
        label: 'Re-issue as a new request (fresh idempotency key)',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-expiry-evidence',
        label: 'View the expiry evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'CANCELLED':
      actions.push({
        actionId: 'view-cancellation-evidence',
        label: 'View the cancellation evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'ABANDONED':
      actions.push({
        actionId: 'view-journey-history',
        label: 'View journey history',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new JourneyContractError(`unhandled collect state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishCollect(journey: Omit<CollectJourney, 'actions'>): CollectJourney {
  return Object.freeze({ ...journey, actions: collectActions(journey) });
}

/**
 * Begin the Collect journey. With NO connected capability permitting
 * collection the journey begins in an HONEST EMPTY state (the create action
 * is unavailable with guidance) — absent data is a derived state, never an
 * exception.
 */
export function beginCollectJourney(input: {
  readonly amount: { readonly currency: string; readonly minorUnits: string };
  readonly payer: string;
  readonly collectCapableInstances: readonly ConnectedCapabilityInstanceRecord[];
}): CollectJourney {
  return finishCollect({
    journeyId: 'collect',
    stateName: 'COMPOSING_REQUEST',
    terminal: false,
    amount: input.amount,
    payer: input.payer,
    collectCapableInstances: Object.freeze([...input.collectCapableInstances]),
  });
}

/** Fold the collect-request creation response (pure). */
export function applyCollectRequestResponse(
  journey: CollectJourney,
  response: ApiResponse,
): CollectJourney {
  const outcome = parseIntentSubmissionResponse(response);
  switch (outcome.kind) {
    case 'GRANTED':
      assertProductJourneyTransition(COLLECT_TRANSITIONS, 'collect', journey.stateName, 'REQUEST_CREATED');
      return finishCollect({
        ...journey,
        stateName: 'REQUEST_CREATED',
        requestRef: asCollectRequestRef(outcome.intentId),
      });
    case 'APPROVAL_REQUIRED':
      assertProductJourneyTransition(COLLECT_TRANSITIONS, 'collect', journey.stateName, 'REQUEST_CREATED');
      return finishCollect({
        ...journey,
        stateName: 'REQUEST_CREATED',
        approval: foldApprovalInfo(outcome),
      });
    case 'ERROR':
      return finishCollect({ ...journey, error: outcome });
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled collect outcome: ${String(exhaustive)}`);
    }
  }
}

/**
 * Derive the shareable form of a created request: an OPAQUE share reference
 * the payer surface binds to. Sharing is not a financial mutation — it
 * carries no envelope and no authority.
 */
export function deriveShareableRequest(
  journey: CollectJourney,
): { readonly requestRef: CollectRequestRef } | { readonly kind: 'NOT_CREATED' } {
  if (journey.requestRef === undefined) {
    return Object.freeze({ kind: 'NOT_CREATED' as const });
  }
  return Object.freeze({ requestRef: journey.requestRef });
}

/** Fold: the request was shared with the payer. */
export function markRequestShared(journey: CollectJourney): CollectJourney {
  if (journey.requestRef === undefined) {
    throw new JourneyContractError('a request can only be shared after it was created');
  }
  assertProductJourneyTransition(COLLECT_TRANSITIONS, 'collect', journey.stateName, 'SHARED');
  return finishCollect({ ...journey, stateName: 'SHARED' });
}

/** Fold: enter fulfillment tracking. */
export function beginCollectTracking(journey: CollectJourney): CollectJourney {
  assertProductJourneyTransition(COLLECT_TRANSITIONS, 'collect', journey.stateName, 'TRACKING');
  return finishCollect({ ...journey, stateName: 'TRACKING', fulfillmentOutcome: 'PENDING' });
}

/** Fold a verbatim fulfillment outcome (pure; PENDING refreshes in place). */
export function applyCollectFulfillment(
  journey: CollectJourney,
  outcome: CollectFulfillmentOutcome,
): CollectJourney {
  if (journey.stateName !== 'TRACKING') {
    throw new JourneyContractError(
      `a fulfillment outcome is not foldable in state ${journey.stateName}`,
    );
  }
  if (outcome === 'PENDING') {
    return finishCollect({ ...journey, fulfillmentOutcome: outcome });
  }
  const target: CollectStateName =
    outcome === 'FULFILLED' ? 'FULFILLED' : outcome === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED';
  assertProductJourneyTransition(COLLECT_TRANSITIONS, 'collect', journey.stateName, target);
  return finishCollect({ ...journey, stateName: target, terminal: true, fulfillmentOutcome: outcome });
}

/** Fold: abandon the collect journey (only before fulfillment completes). */
export function abandonCollectJourney(journey: CollectJourney): CollectJourney {
  if (COLLECT_TERMINAL.has(journey.stateName)) {
    throw new JourneyContractError(
      `a collect journey cannot be abandoned from terminal state ${journey.stateName}`,
    );
  }
  assertProductJourneyTransition(COLLECT_TRANSITIONS, 'collect', journey.stateName, 'ABANDONED');
  return finishCollect({ ...journey, stateName: 'ABANDONED', terminal: true });
}

/** Dispatch `create-collect-request` through the api surface and fold the response. */
export async function dispatchCollectRequest(
  session: JourneySession,
  journey: CollectJourney,
): Promise<{ readonly journey: CollectJourney; readonly response: ApiResponse }> {
  const response = await dispatchProductJourneyAction(session, journey, 'create-collect-request');
  return { journey: applyCollectRequestResponse(journey, response), response };
}

// ---------------------------------------------------------------------------
// Journey 4 — Payout (explicit destination + withdrawal-scoped authorization)
// ---------------------------------------------------------------------------

export const PAYOUT_STATES = [
  'SPECIFYING_DESTINATION',
  'CONFIRMING_SCOPE',
  'AWAITING_APPROVAL',
  'SUBMITTED',
  'TRACKING',
  'RECONCILING',
  'COMPLETED',
  'FAILED',
  'ABANDONED',
] as const;

export type PayoutStateName = (typeof PAYOUT_STATES)[number];

export const PAYOUT_TRANSITIONS: Readonly<Record<PayoutStateName, readonly PayoutStateName[]>> =
  Object.freeze({
    SPECIFYING_DESTINATION: Object.freeze(['CONFIRMING_SCOPE', 'ABANDONED'] as const),
    CONFIRMING_SCOPE: Object.freeze(['SUBMITTED', 'AWAITING_APPROVAL', 'SPECIFYING_DESTINATION', 'ABANDONED'] as const),
    AWAITING_APPROVAL: Object.freeze(['SUBMITTED', 'CONFIRMING_SCOPE', 'ABANDONED'] as const),
    SUBMITTED: Object.freeze(['TRACKING', 'COMPLETED', 'FAILED', 'RECONCILING'] as const),
    TRACKING: Object.freeze(['COMPLETED', 'FAILED', 'RECONCILING', 'TRACKING'] as const),
    RECONCILING: Object.freeze(['COMPLETED', 'FAILED', 'TRACKING', 'RECONCILING'] as const),
    COMPLETED: Object.freeze([] as const),
    FAILED: Object.freeze([] as const),
    ABANDONED: Object.freeze([] as const),
  });

const PAYOUT_TERMINAL: ReadonlySet<PayoutStateName> = new Set(['COMPLETED', 'FAILED', 'ABANDONED']);

export function canTransitionPayout(from: PayoutStateName, to: PayoutStateName): boolean {
  return transitionPredicate(PAYOUT_TRANSITIONS)(from, to);
}

/**
 * An EXPLICIT external payout destination. The destination is an
 * EXTERNAL-FUNDS OBSERVATION (a reference to where external money would
 * land) — PaySwap never takes custody, and the structural
 * `externalObservation: true` marker says so on every value.
 */
export interface PayoutDestination {
  readonly destinationRef: PayoutDestinationRef;
  readonly kind: 'BANK_ACCOUNT' | 'MOBILE_WALLET' | 'CRYPTO_ADDRESS';
  readonly currency: string;
  readonly externalObservation: true;
}

/**
 * The WITHDRAWAL-SCOPED authorization a payout executes under. The scope is
 * structurally SINGLE-USE and bound to one explicit destination reference: a
 * connection is never blanket withdrawal authority.
 */
export interface WithdrawalScope {
  readonly singleUse: true;
  readonly maxAmount: { readonly currency: string; readonly minorUnits: string };
  readonly destinationRef: PayoutDestinationRef;
}

/** The Payout journey view (pure projection). */
export interface PayoutJourney {
  readonly journeyId: 'payout';
  readonly stateName: PayoutStateName;
  readonly terminal: boolean;
  readonly amount: { readonly currency: string; readonly minorUnits: string };
  /** REQUIRED before any submission: the explicit external destination. */
  readonly destination?: PayoutDestination;
  /** REQUIRED before any submission: the withdrawal-scoped authorization. */
  readonly withdrawalScope?: WithdrawalScope;
  readonly approval?: AwaitingApprovalInfo;
  readonly submittedIntentId?: string;
  readonly attemptOutcome?: TrackedOutcome;
  readonly evidenceRefs: readonly EvidenceArtifactRef[];
  readonly error?: JourneyErrorResult;
  readonly actions: readonly ViewAction[];
}

function payoutReadyForSubmission(journey: Omit<PayoutJourney, 'actions'>): boolean {
  return journey.destination !== undefined && journey.withdrawalScope !== undefined;
}

function payoutActions(journey: Omit<PayoutJourney, 'actions'>): readonly ViewAction[] {
  const actions: ViewAction[] = [];
  const base = {
    authorityRef: journey.destination?.destinationRef ?? `payout:${journey.amount.currency}`,
  };
  switch (journey.stateName) {
    case 'SPECIFYING_DESTINATION':
      actions.push({
        actionId: 'choose-destination',
        label: 'Choose the explicit external destination',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-destination-observation-note',
        label: 'Read what a payout destination is (an external observation, never custody)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'abandon-payout',
        label: 'Cancel this payout',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'CONFIRMING_SCOPE': {
      const ready = payoutReadyForSubmission(journey);
      actions.push({
        actionId: 'submit-payout',
        label: 'Submit the payout under the withdrawal-scoped authorization',
        kind: 'API_COMMAND',
        ...base,
        available: ready,
        ...(ready
          ? {}
          : {
              unavailableReason:
                journey.destination === undefined
                  ? 'an EXPLICIT external destination is required before a payout can be submitted'
                  : 'a withdrawal-scoped authorization is required before a payout can be submitted',
            }),
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: 'payouts.payout.create',
            amount: journey.amount,
            destinationRef: journey.destination?.destinationRef,
            destinationKind: journey.destination?.kind,
            externalObservation: true,
            withdrawalScope: journey.withdrawalScope === undefined ? undefined : {
              singleUse: true,
              maxAmount: journey.withdrawalScope.maxAmount,
              destinationRef: journey.withdrawalScope.destinationRef,
            },
            ...(journey.approval === undefined
              ? {}
              : { approvalArtifactRef: approvalArtifactRef(journey.approval.requestHash) }),
          },
        },
      });
      actions.push({
        actionId: 'view-withdrawal-scope',
        label: 'View the withdrawal scope (single-use, destination-bound — a connection is never blanket withdrawal authority)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.withdrawalScope !== undefined,
        ...(journey.withdrawalScope === undefined
          ? { unavailableReason: 'no withdrawal scope confirmed yet' }
          : {}),
      });
      actions.push({
        actionId: 'change-destination',
        label: 'Change the destination (resets the confirmed scope)',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'abandon-payout',
        label: 'Cancel this payout',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    }
    case 'AWAITING_APPROVAL':
      if (journey.approval !== undefined) {
        actions.push(
          trustedSurfaceAction(journey.approval, 'Complete the payout approval on the trusted surface'),
        );
      }
      actions.push({
        actionId: 'abandon-payout',
        label: 'Cancel this payout',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'SUBMITTED':
      actions.push({
        actionId: 'view-submitted-intent',
        label: 'View the submitted payout intent',
        kind: 'API_COMMAND',
        authorityRef: journey.submittedIntentId ?? base.authorityRef,
        available: journey.submittedIntentId !== undefined,
        ...(journey.submittedIntentId === undefined
          ? { unavailableReason: 'no intent id recorded on this journey' }
          : {}),
        apiCommand: {
          method: 'GET',
          path: `/v1/intents/${journey.submittedIntentId ?? 'unknown'}`,
        },
      });
      actions.push({
        actionId: 'track-payout',
        label: 'Track the payout outcome',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'TRACKING':
      actions.push({
        actionId: 'view-attempt-evidence',
        label: 'View the payout attempt evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.evidenceRefs.length > 0,
        ...(journey.evidenceRefs.length > 0
          ? {}
          : { unavailableReason: 'no evidence references recorded yet' }),
      });
      actions.push({
        actionId: 'refresh-outcome',
        label: 'Refresh the outcome from authoritative state',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'RECONCILING':
      actions.push({
        actionId: 'open-reconciliation-journey',
        label: 'Open the reconciliation journey for this payout',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-reconciliation-evidence',
        label: 'View the evidence recorded so far',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.evidenceRefs.length > 0,
        ...(journey.evidenceRefs.length > 0
          ? {}
          : { unavailableReason: 'no evidence references recorded yet' }),
      });
      break;
    case 'COMPLETED':
      actions.push({
        actionId: 'view-completion-evidence',
        label: 'View the completion evidence (observed externally — not a PaySwap balance)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'FAILED':
      actions.push({
        actionId: 'view-failure-evidence',
        label: 'View the failure evidence (protocol-sourced, never inferred)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'retry-as-new-intent',
        label: 'Retry as a new payout (fresh idempotency key, fresh scope)',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    case 'ABANDONED':
      actions.push({
        actionId: 'view-journey-history',
        label: 'View journey history',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new JourneyContractError(`unhandled payout state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishPayout(journey: Omit<PayoutJourney, 'actions'>): PayoutJourney {
  return Object.freeze({ ...journey, actions: payoutActions(journey) });
}

/**
 * Begin the Payout journey. It starts WITHOUT a destination and WITHOUT a
 * scope: neither can be submitted around, and the submit mutation stays
 * unavailable until both are explicitly present.
 */
export function beginPayoutJourney(input: {
  readonly amount: { readonly currency: string; readonly minorUnits: string };
}): PayoutJourney {
  return finishPayout({
    journeyId: 'payout',
    stateName: 'SPECIFYING_DESTINATION',
    terminal: false,
    amount: input.amount,
    evidenceRefs: Object.freeze([]),
  });
}

/**
 * Fold: specify the EXPLICIT external destination. Legal only in
 * SPECIFYING_DESTINATION; the destination is an external-funds observation
 * (never custody) and is required before any submission.
 */
export function specifyPayoutDestination(
  journey: PayoutJourney,
  destination: PayoutDestination,
): PayoutJourney {
  if (journey.stateName !== 'SPECIFYING_DESTINATION') {
    throw new JourneyContractError(
      `specify-destination is not legal in state ${journey.stateName}`,
    );
  }
  if (destination.externalObservation !== true) {
    throw new JourneyContractError(
      'a payout destination must be an external-funds observation (externalObservation: true)',
    );
  }
  assertProductJourneyTransition(PAYOUT_TRANSITIONS, 'payout', journey.stateName, 'CONFIRMING_SCOPE');
  return finishPayout({ ...journey, stateName: 'CONFIRMING_SCOPE', destination });
}

/**
 * Fold: confirm the WITHDRAWAL-SCOPED authorization. The scope must be
 * single-use (structurally), bound to the SAME destination reference as the
 * journey's destination, and denominated in the payout's currency — a
 * connection is never blanket withdrawal authority.
 */
export function confirmWithdrawalScope(
  journey: PayoutJourney,
  scope: WithdrawalScope,
): PayoutJourney {
  if (journey.destination === undefined) {
    throw new JourneyContractError(
      'a withdrawal scope can only be confirmed after an explicit destination is specified',
    );
  }
  if (journey.stateName !== 'CONFIRMING_SCOPE') {
    throw new JourneyContractError(
      `confirm-withdrawal-scope is not legal in state ${journey.stateName}`,
    );
  }
  if (scope.singleUse !== true) {
    throw new JourneyContractError('a withdrawal scope must be single-use');
  }
  if (scope.destinationRef !== journey.destination.destinationRef) {
    throw new JourneyContractError(
      'the withdrawal scope must be bound to the explicit payout destination (connection is not blanket withdrawal authority)',
    );
  }
  if (scope.maxAmount.currency !== journey.amount.currency) {
    throw new JourneyContractError(
      `the withdrawal scope is denominated in ${scope.maxAmount.currency} but the payout is in ${journey.amount.currency}`,
    );
  }
  return finishPayout({ ...journey, withdrawalScope: scope });
}

/** Fold: re-enter destination selection (clears destination AND scope). */
export function reenterPayoutDestinationSelection(journey: PayoutJourney): PayoutJourney {
  assertProductJourneyTransition(
    PAYOUT_TRANSITIONS,
    'payout',
    journey.stateName,
    'SPECIFYING_DESTINATION',
  );
  const { destination: _clearedDestination, withdrawalScope: _clearedScope, ...rest } = journey;
  return finishPayout({ ...rest, stateName: 'SPECIFYING_DESTINATION' });
}

/** Fold the payout submission response (pure). */
export function applyPayoutSubmissionResponse(
  journey: PayoutJourney,
  response: ApiResponse,
): PayoutJourney {
  if (!payoutReadyForSubmission(journey)) {
    throw new JourneyContractError(
      'a payout submission response can only be folded after an explicit destination AND a withdrawal scope are present',
    );
  }
  const outcome = parseIntentSubmissionResponse(response);
  switch (outcome.kind) {
    case 'GRANTED':
      assertProductJourneyTransition(PAYOUT_TRANSITIONS, 'payout', journey.stateName, 'SUBMITTED');
      return finishPayout({ ...journey, stateName: 'SUBMITTED', submittedIntentId: outcome.intentId });
    case 'APPROVAL_REQUIRED':
      assertProductJourneyTransition(PAYOUT_TRANSITIONS, 'payout', journey.stateName, 'AWAITING_APPROVAL');
      return finishPayout({ ...journey, stateName: 'AWAITING_APPROVAL', approval: foldApprovalInfo(outcome) });
    case 'ERROR':
      return finishPayout({ ...journey, error: outcome });
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled payout submission outcome: ${String(exhaustive)}`);
    }
  }
}

/** Fold: the payout approval completed on the trusted surface (INV-A03). */
export function confirmPayoutApproval(journey: PayoutJourney): PayoutJourney {
  if (journey.stateName !== 'AWAITING_APPROVAL' || journey.approval === undefined) {
    throw new JourneyContractError('confirm-payout-approval requires an awaited payout approval');
  }
  assertProductJourneyTransition(PAYOUT_TRANSITIONS, 'payout', journey.stateName, 'CONFIRMING_SCOPE');
  return finishPayout({ ...journey, stateName: 'CONFIRMING_SCOPE' });
}

/**
 * Fold a verbatim tracked payout outcome. OUTCOME_UNKNOWN enters
 * RECONCILING — never FAILED (INV-X01).
 */
export function applyPayoutOutcome(
  journey: PayoutJourney,
  outcome: TrackedOutcome,
  evidenceRefs?: readonly EvidenceArtifactRef[],
): PayoutJourney {
  if (
    journey.stateName !== 'SUBMITTED' &&
    journey.stateName !== 'TRACKING' &&
    journey.stateName !== 'RECONCILING'
  ) {
    throw new JourneyContractError(`a payout outcome is not foldable in state ${journey.stateName}`);
  }
  const mergedEvidence = Object.freeze([...journey.evidenceRefs, ...(evidenceRefs ?? [])]);
  switch (outcome) {
    case 'PENDING':
    case 'IN_FLIGHT':
    case 'AWAITING_CUSTOMER_ACTION':
      assertProductJourneyTransition(PAYOUT_TRANSITIONS, 'payout', journey.stateName, 'TRACKING');
      return finishPayout({
        ...journey,
        stateName: 'TRACKING',
        attemptOutcome: outcome,
        evidenceRefs: mergedEvidence,
      });
    case 'OUTCOME_UNKNOWN':
      assertProductJourneyTransition(PAYOUT_TRANSITIONS, 'payout', journey.stateName, 'RECONCILING');
      return finishPayout({
        ...journey,
        stateName: 'RECONCILING',
        attemptOutcome: outcome,
        evidenceRefs: mergedEvidence,
      });
    case 'SUCCEEDED':
      assertProductJourneyTransition(PAYOUT_TRANSITIONS, 'payout', journey.stateName, 'COMPLETED');
      return finishPayout({
        ...journey,
        stateName: 'COMPLETED',
        terminal: true,
        attemptOutcome: outcome,
        evidenceRefs: mergedEvidence,
      });
    case 'FAILED':
      assertProductJourneyTransition(PAYOUT_TRANSITIONS, 'payout', journey.stateName, 'FAILED');
      return finishPayout({
        ...journey,
        stateName: 'FAILED',
        terminal: true,
        attemptOutcome: outcome,
        evidenceRefs: mergedEvidence,
      });
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled payout outcome: ${String(exhaustive)}`);
    }
  }
}

/** Fold a payout reconciliation resolution (requires an evidence reference). */
export function applyPayoutReconciliationResolution(
  journey: PayoutJourney,
  resolution: 'RESOLVED_FULFILLED' | 'RESOLVED_FAILED' | 'STILL_UNKNOWN',
  evidenceRef: EvidenceArtifactRef,
): PayoutJourney {
  if (journey.stateName !== 'RECONCILING') {
    throw new JourneyContractError(
      `a payout reconciliation resolution is not foldable in state ${journey.stateName}`,
    );
  }
  const evidenceRefs = Object.freeze([...journey.evidenceRefs, evidenceRef]);
  switch (resolution) {
    case 'RESOLVED_FULFILLED':
      return finishPayout({
        ...journey,
        stateName: 'COMPLETED',
        terminal: true,
        attemptOutcome: 'SUCCEEDED',
        evidenceRefs,
      });
    case 'RESOLVED_FAILED':
      return finishPayout({
        ...journey,
        stateName: 'FAILED',
        terminal: true,
        attemptOutcome: 'FAILED',
        evidenceRefs,
      });
    case 'STILL_UNKNOWN':
      return finishPayout({ ...journey, stateName: 'RECONCILING', evidenceRefs });
    default: {
      const exhaustive: never = resolution;
      throw new JourneyContractError(`unhandled payout resolution: ${String(exhaustive)}`);
    }
  }
}

/** Fold: abandon the payout (only before submission). */
export function abandonPayoutJourney(journey: PayoutJourney): PayoutJourney {
  if (journey.stateName === 'SUBMITTED' || PAYOUT_TERMINAL.has(journey.stateName)) {
    throw new JourneyContractError(
      `a payout cannot be abandoned from state ${journey.stateName} (the intent is already authority)`,
    );
  }
  assertProductJourneyTransition(PAYOUT_TRANSITIONS, 'payout', journey.stateName, 'ABANDONED');
  return finishPayout({ ...journey, stateName: 'ABANDONED', terminal: true });
}

/** Dispatch `submit-payout` through the api surface and fold the response. */
export async function dispatchPayoutSubmission(
  session: JourneySession,
  journey: PayoutJourney,
): Promise<{ readonly journey: PayoutJourney; readonly response: ApiResponse }> {
  const response = await dispatchProductJourneyAction(session, journey, 'submit-payout');
  return { journey: applyPayoutSubmissionResponse(journey, response), response };
}

// ---------------------------------------------------------------------------
// Journey 5 — Reconcile (ambiguity-first; UNKNOWN is never failure)
// ---------------------------------------------------------------------------

export const RECONCILE_STATES = [
  'TRACKING_IN_FLIGHT',
  'OUTCOME_UNKNOWN',
  'PENDING_OBSERVATION',
  'RESOLVED_FULFILLED',
  'RESOLVED_FAILED',
] as const;

export type OutcomeReconcileStateName = (typeof RECONCILE_STATES)[number];

/**
 * Legal transitions for the outcome-reconciliation journey. The lifecycle is
 * AMBIGUITY-FIRST: an ambiguous outcome must be RECORDED (with evidence,
 * INV-E02) before observation is awaited, and resolution is reachable only
 * from an ambiguity or observation state — never directly from unambiguous
 * in-flight tracking.
 */
export const RECONCILE_TRANSITIONS: Readonly<
  Record<OutcomeReconcileStateName, readonly OutcomeReconcileStateName[]>
> = Object.freeze({
  TRACKING_IN_FLIGHT: Object.freeze(['OUTCOME_UNKNOWN', 'RESOLVED_FULFILLED', 'RESOLVED_FAILED'] as const),
  OUTCOME_UNKNOWN: Object.freeze(['PENDING_OBSERVATION', 'RESOLVED_FULFILLED', 'RESOLVED_FAILED'] as const),
  PENDING_OBSERVATION: Object.freeze(['OUTCOME_UNKNOWN', 'RESOLVED_FULFILLED', 'RESOLVED_FAILED'] as const),
  RESOLVED_FULFILLED: Object.freeze([] as const),
  RESOLVED_FAILED: Object.freeze([] as const),
});

export function canTransitionReconcile(
  from: OutcomeReconcileStateName,
  to: OutcomeReconcileStateName,
): boolean {
  return transitionPredicate(RECONCILE_TRANSITIONS)(from, to);
}

/**
 * Project a reconciliation state to its canonical UI state THROUGH
 * `mapTerminalStateToUi` (the same consumption): OUTCOME_UNKNOWN and
 * PENDING_OBSERVATION are `reconciling` — NEVER `failed` (INV-X01);
 * TRACKING_IN_FLIGHT shows no terminal badge.
 */
export function reconcileJourneyUiState(stateName: OutcomeReconcileStateName): UiState {
  switch (stateName) {
    case 'TRACKING_IN_FLIGHT':
      return 'reconciling';
    case 'OUTCOME_UNKNOWN':
    case 'PENDING_OBSERVATION':
      return mapTerminalStateToUi('UNKNOWN');
    case 'RESOLVED_FULFILLED':
      return mapTerminalStateToUi('FULFILLED');
    case 'RESOLVED_FAILED':
      return mapTerminalStateToUi('FAILED');
    default: {
      const exhaustive: never = stateName;
      throw new JourneyContractError(`unhandled reconcile state: ${String(exhaustive)}`);
    }
  }
}

/** The outcome-reconciliation journey view (pure projection). */
export interface ReconcileJourney {
  readonly journeyId: 'reconcile-payment-outcome';
  readonly stateName: OutcomeReconcileStateName;
  readonly terminal: boolean;
  readonly paymentRef: string;
  readonly reconciliationCaseRef?: string;
  /** Evidence references — every ambiguity/observation/resolution fold records one. */
  readonly evidenceRefs: readonly EvidenceArtifactRef[];
  readonly attemptOutcome?: TrackedOutcome;
  readonly actions: readonly ViewAction[];
}

function reconcileActions(journey: Omit<ReconcileJourney, 'actions'>): readonly ViewAction[] {
  const actions: ViewAction[] = [];
  const base = { authorityRef: journey.paymentRef };
  switch (journey.stateName) {
    case 'TRACKING_IN_FLIGHT':
      actions.push({
        actionId: 'view-payment-record',
        label: 'View the payment being reconciled',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-attempt-evidence',
        label: 'View the in-flight attempt evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: journey.evidenceRefs.length > 0,
        ...(journey.evidenceRefs.length > 0
          ? {}
          : { unavailableReason: 'no evidence references recorded yet' }),
      });
      actions.push({
        actionId: 'view-reconciliation-case',
        label: 'View the reconciliation case',
        kind: 'EVIDENCE_VIEW',
        authorityRef: journey.reconciliationCaseRef ?? journey.paymentRef,
        available: journey.reconciliationCaseRef !== undefined,
        ...(journey.reconciliationCaseRef === undefined
          ? { unavailableReason: 'no reconciliation case opened for this payment' }
          : {}),
      });
      break;
    case 'OUTCOME_UNKNOWN':
      actions.push({
        actionId: 'view-ambiguity-evidence',
        label: 'View the ambiguity evidence (the observation itself is evidence, INV-E02)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'request-fresh-observation',
        label: 'Request a fresh external observation',
        kind: 'API_COMMAND',
        ...base,
        available: true,
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: 'payments.reconciliation.observe',
            correlationId: journey.paymentRef,
          },
        },
      });
      actions.push({
        actionId: 'view-reconciliation-case',
        label: 'View the reconciliation case',
        kind: 'EVIDENCE_VIEW',
        authorityRef: journey.reconciliationCaseRef ?? journey.paymentRef,
        available: true,
      });
      break;
    case 'PENDING_OBSERVATION':
      actions.push({
        actionId: 'view-observation-evidence',
        label: 'View the pending-observation evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'request-fresh-observation',
        label: 'Request another external observation',
        kind: 'API_COMMAND',
        ...base,
        available: true,
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: 'payments.reconciliation.observe',
            correlationId: journey.paymentRef,
          },
        },
      });
      break;
    case 'RESOLVED_FULFILLED':
    case 'RESOLVED_FAILED':
      actions.push({
        actionId: 'view-resolution-evidence',
        label: 'View the resolution evidence',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new JourneyContractError(`unhandled reconcile state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishReconcile(journey: Omit<ReconcileJourney, 'actions'>): ReconcileJourney {
  return Object.freeze({ ...journey, actions: reconcileActions(journey) });
}

/** Begin outcome reconciliation for one payment (in-flight, unambiguous). */
export function beginReconcileJourney(input: {
  readonly paymentRef: string;
  readonly reconciliationCaseRef?: string;
  readonly evidenceRefs?: readonly EvidenceArtifactRef[];
}): ReconcileJourney {
  return finishReconcile({
    journeyId: 'reconcile-payment-outcome',
    stateName: 'TRACKING_IN_FLIGHT',
    terminal: false,
    paymentRef: input.paymentRef,
    ...(input.reconciliationCaseRef === undefined
      ? {}
      : { reconciliationCaseRef: input.reconciliationCaseRef }),
    evidenceRefs: Object.freeze([...(input.evidenceRefs ?? [])]),
  });
}

/**
 * Fold: record the ambiguity. The ambiguity observation itself is evidence
 * (INV-E02) — the fold REQUIRES an evidence reference. Legal from
 * TRACKING_IN_FLIGHT or PENDING_OBSERVATION.
 */
export function recordOutcomeUnknown(
  journey: ReconcileJourney,
  evidenceRef: EvidenceArtifactRef,
): ReconcileJourney {
  assertProductJourneyTransition(
    RECONCILE_TRANSITIONS,
    'reconcile-payment-outcome',
    journey.stateName,
    'OUTCOME_UNKNOWN',
  );
  return finishReconcile({
    ...journey,
    stateName: 'OUTCOME_UNKNOWN',
    attemptOutcome: 'OUTCOME_UNKNOWN',
    evidenceRefs: Object.freeze([...journey.evidenceRefs, evidenceRef]),
  });
}

/**
 * Fold: await a further external observation. The pending-observation state
 * is surfaced WITH its evidence reference — never as a silent spinner.
 */
export function awaitFurtherObservation(
  journey: ReconcileJourney,
  evidenceRef: EvidenceArtifactRef,
): ReconcileJourney {
  assertProductJourneyTransition(
    RECONCILE_TRANSITIONS,
    'reconcile-payment-outcome',
    journey.stateName,
    'PENDING_OBSERVATION',
  );
  return finishReconcile({
    ...journey,
    stateName: 'PENDING_OBSERVATION',
    evidenceRefs: Object.freeze([...journey.evidenceRefs, evidenceRef]),
  });
}

/**
 * Fold an AUTHORITY resolution. Legal only from an ambiguity or observation
 * state; the resolution evidence reference is required.
 */
export function applyReconciliationResolution(
  journey: ReconcileJourney,
  resolution: 'RESOLVED_FULFILLED' | 'RESOLVED_FAILED',
  evidenceRef: EvidenceArtifactRef,
): ReconcileJourney {
  assertProductJourneyTransition(
    RECONCILE_TRANSITIONS,
    'reconcile-payment-outcome',
    journey.stateName,
    resolution,
  );
  return finishReconcile({
    ...journey,
    stateName: resolution,
    terminal: true,
    attemptOutcome: resolution === 'RESOLVED_FULFILLED' ? 'SUCCEEDED' : 'FAILED',
    evidenceRefs: Object.freeze([...journey.evidenceRefs, evidenceRef]),
  });
}

/** Dispatch `request-fresh-observation` through the api surface. */
export async function dispatchReconciliationObservation(
  session: JourneySession,
  journey: ReconcileJourney,
): Promise<ApiResponse> {
  return dispatchProductJourneyAction(session, journey, 'request-fresh-observation');
}

// ---------------------------------------------------------------------------
// Journey 6 — Evidence (inspection with provenance strength, INV-E04)
// ---------------------------------------------------------------------------

export const EVIDENCE_STATES = ['LISTING', 'INSPECTING_ARTIFACT'] as const;

export type EvidenceStateName = (typeof EVIDENCE_STATES)[number];

export const EVIDENCE_TRANSITIONS: Readonly<Record<EvidenceStateName, readonly EvidenceStateName[]>> =
  Object.freeze({
    LISTING: Object.freeze(['INSPECTING_ARTIFACT'] as const),
    INSPECTING_ARTIFACT: Object.freeze(['LISTING'] as const),
  });

export function canTransitionEvidence(from: EvidenceStateName, to: EvidenceStateName): boolean {
  return transitionPredicate(EVIDENCE_TRANSITIONS)(from, to);
}

/** One evidence artifact as declared by its authoritative source. */
export interface EvidenceArtifactEntry {
  readonly artifactRef: EvidenceArtifactRef;
  readonly summary: string;
  readonly provenance: ProvenanceSourceInput;
}

/** A derived evidence list entry: the artifact plus its provenance label and rank. */
export interface EvidenceListEntry {
  readonly artifactRef: EvidenceArtifactRef;
  readonly summary: string;
  readonly provenanceLabel: ProvenanceLabel;
  /** The rank in the INV-E04 strength order (consumed from incumbent-views.ts). */
  readonly rank: number;
}

/**
 * Derive the evidence list for one external financial action: every entry
 * carries its provenance label derived by the SAME `deriveProvenanceLabel`
 * consumption incumbent-views.ts mandates (a browser-local artifact renders
 * UNVERIFIED_BROWSER_ARTIFACT — never stronger than its authenticated
 * provenance, INV-E04). The list is ordered strongest-first with a
 * deterministic artifact-ref tiebreak.
 */
export function deriveEvidenceList(
  artifacts: readonly EvidenceArtifactEntry[],
): readonly EvidenceListEntry[] {
  const entries = artifacts.map((artifact) => {
    const provenanceLabel = deriveProvenanceLabel(artifact.provenance);
    return Object.freeze({
      artifactRef: artifact.artifactRef,
      summary: artifact.summary,
      provenanceLabel,
      rank: provenanceRank(provenanceLabel.strength),
    });
  });
  return Object.freeze(
    [...entries].sort((left, right) => {
      if (left.rank !== right.rank) {
        return right.rank - left.rank;
      }
      return left.artifactRef < right.artifactRef ? -1 : left.artifactRef > right.artifactRef ? 1 : 0;
    }),
  );
}

/** The strongest evidence entry (what a resolution claim may rest on), if any. */
export function strongestEvidenceEntry(
  artifacts: readonly EvidenceArtifactEntry[],
): EvidenceListEntry | undefined {
  return deriveEvidenceList(artifacts)[0];
}

/** The Evidence journey view (read-only by construction). */
export interface EvidenceJourney {
  readonly journeyId: 'evidence';
  readonly stateName: EvidenceStateName;
  readonly terminal: boolean;
  readonly actionRef: string;
  readonly entries: readonly EvidenceListEntry[];
  readonly strongest?: EvidenceListEntry;
  readonly inspectedArtifactRef?: EvidenceArtifactRef;
  readonly actions: readonly ViewAction[];
}

function evidenceActions(journey: Omit<EvidenceJourney, 'actions'>): readonly ViewAction[] {
  const actions: ViewAction[] = [];
  const base = { authorityRef: journey.actionRef };
  switch (journey.stateName) {
    case 'LISTING':
      for (const entry of journey.entries) {
        actions.push({
          actionId: `inspect-artifact:${entry.artifactRef}`,
          label: `Inspect ${entry.summary}`,
          kind: 'NAVIGATION',
          authorityRef: entry.artifactRef,
          available: true,
        });
      }
      actions.push({
        actionId: 'view-provenance-strength-order',
        label: 'View the provenance strength order (INV-E04)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'INSPECTING_ARTIFACT':
      actions.push({
        actionId: 'view-artifact',
        label: 'View the artifact in full',
        kind: 'EVIDENCE_VIEW',
        authorityRef: journey.inspectedArtifactRef ?? journey.actionRef,
        available: true,
      });
      actions.push({
        actionId: 'back-to-evidence-list',
        label: 'Back to the evidence list',
        kind: 'NAVIGATION',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new JourneyContractError(`unhandled evidence state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishEvidence(journey: Omit<EvidenceJourney, 'actions'>): EvidenceJourney {
  return Object.freeze({ ...journey, actions: evidenceActions(journey) });
}

/**
 * Begin evidence inspection for one external financial action. Inspection is
 * READ-ONLY: this journey exposes no API_COMMAND action in any state —
 * viewing evidence never mutates authority.
 */
export function beginEvidenceInspection(input: {
  readonly actionRef: string;
  readonly artifacts: readonly EvidenceArtifactEntry[];
}): EvidenceJourney {
  const entries = deriveEvidenceList(input.artifacts);
  return finishEvidence({
    journeyId: 'evidence',
    stateName: 'LISTING',
    terminal: false,
    actionRef: input.actionRef,
    entries,
    ...(entries.length === 0 ? {} : { strongest: entries[0] }),
  });
}

/** Fold: inspect one artifact (must be in the derived list). */
export function inspectEvidenceArtifact(
  journey: EvidenceJourney,
  artifactRef: EvidenceArtifactRef,
): EvidenceJourney {
  assertProductJourneyTransition(
    EVIDENCE_TRANSITIONS,
    'evidence',
    journey.stateName,
    'INSPECTING_ARTIFACT',
  );
  if (!journey.entries.some((entry) => entry.artifactRef === artifactRef)) {
    throw new JourneyContractError(
      `artifact ${artifactRef} is not among the evidence entries for ${journey.actionRef}`,
    );
  }
  return finishEvidence({ ...journey, stateName: 'INSPECTING_ARTIFACT', inspectedArtifactRef: artifactRef });
}

/** Fold: back to the evidence list. */
export function backToEvidenceList(journey: EvidenceJourney): EvidenceJourney {
  assertProductJourneyTransition(EVIDENCE_TRANSITIONS, 'evidence', journey.stateName, 'LISTING');
  return finishEvidence({ ...journey, stateName: 'LISTING' });
}

// ---------------------------------------------------------------------------
// Journey 7 — Reauth (fresh authorization, lineage intact)
// ---------------------------------------------------------------------------

export const REAUTH_STATES = [
  'AUTHORIZATION_EXPIRED',
  'CUSTOMER_ACTION_REQUIRED',
  'REAUTHORIZING_ON_TRUSTED_SURFACE',
  'FRESH_AUTHORIZATION_RECORDED',
  'EXECUTION_RESUMED',
] as const;

export type ReauthStateName = (typeof REAUTH_STATES)[number];

export const REAUTH_TRANSITIONS: Readonly<Record<ReauthStateName, readonly ReauthStateName[]>> =
  Object.freeze({
    AUTHORIZATION_EXPIRED: Object.freeze(['CUSTOMER_ACTION_REQUIRED'] as const),
    CUSTOMER_ACTION_REQUIRED: Object.freeze(['REAUTHORIZING_ON_TRUSTED_SURFACE'] as const),
    REAUTHORIZING_ON_TRUSTED_SURFACE: Object.freeze(['FRESH_AUTHORIZATION_RECORDED'] as const),
    FRESH_AUTHORIZATION_RECORDED: Object.freeze(['EXECUTION_RESUMED'] as const),
    EXECUTION_RESUMED: Object.freeze([] as const),
  });

export function canTransitionReauth(from: ReauthStateName, to: ReauthStateName): boolean {
  return transitionPredicate(REAUTH_TRANSITIONS)(from, to);
}

/**
 * The lineage a reauthorization preserves: the original intent, attempt and
 * command the expired authorization covered. Every fold carries this
 * verbatim — execution resumes under the NEW authorization with the OLD
 * lineage intact.
 */
export interface ReauthLineage {
  readonly intentId?: string;
  readonly attemptId?: string;
  readonly commandHash?: string;
  readonly originalCommandType: string;
  readonly amount?: { readonly currency: string; readonly minorUnits: string };
}

/** The fresh authorization recorded on the trusted surface (opaque refs only). */
export interface FreshAuthorizationRecord {
  readonly authorizationRef: ReauthorizationRef;
  readonly evidenceRef: EvidenceArtifactRef;
}

/** The Reauth journey view (pure projection). */
export interface ReauthJourney {
  readonly journeyId: 'reauthorize';
  readonly stateName: ReauthStateName;
  readonly terminal: boolean;
  readonly trigger: 'EXPIRED' | 'STEP_UP_REQUIRED';
  readonly lineage: ReauthLineage;
  readonly trustedSurfaceDeepLink?: string;
  readonly freshAuthorization?: FreshAuthorizationRecord;
  readonly approval?: AwaitingApprovalInfo;
  readonly resumedIntentId?: string;
  readonly error?: JourneyErrorResult;
  readonly actions: readonly ViewAction[];
}

function reauthActions(journey: Omit<ReauthJourney, 'actions'>): readonly ViewAction[] {
  const actions: ViewAction[] = [];
  const base = { authorityRef: journey.lineage.intentId ?? journey.lineage.commandHash ?? 'reauthorize' };
  switch (journey.stateName) {
    case 'AUTHORIZATION_EXPIRED':
      actions.push({
        actionId: 'begin-reauthorization-request',
        label: 'Request the fresh authorization',
        kind: 'API_COMMAND',
        ...base,
        available: true,
        apiCommand: {
          method: 'POST',
          path: '/v1/approvals',
          body: {
            scope: {
              actions: [journey.lineage.originalCommandType],
              resources: [{ type: 'intent' }],
            },
          },
        },
      });
      actions.push({
        actionId: 'view-why-reauth-needed',
        label:
          journey.trigger === 'EXPIRED'
            ? 'View why the authorization expired'
            : 'View why a step-up is required',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'CUSTOMER_ACTION_REQUIRED':
      actions.push({
        actionId: 'open-trusted-browser-surface',
        label: 'Complete the customer action on the trusted browser surface',
        kind: 'EXTERNAL_OPEN',
        ...base,
        available: true,
        externalOpen: {
          systemName: 'trusted-authorization-surface',
          ...(journey.trustedSurfaceDeepLink === undefined
            ? {}
            : { deepLink: journey.trustedSurfaceDeepLink }),
        },
      });
      actions.push({
        actionId: 'view-lineage',
        label: 'View the lineage this reauthorization preserves',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'REAUTHORIZING_ON_TRUSTED_SURFACE':
      actions.push({
        actionId: 'view-reauthorization-surface-status',
        label: 'View the trusted-surface reauthorization status',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      actions.push({
        actionId: 'view-lineage',
        label: 'View the lineage this reauthorization preserves',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    case 'FRESH_AUTHORIZATION_RECORDED':
      actions.push({
        actionId: 'resume-execution',
        label: 'Resume execution under the fresh authorization (lineage intact)',
        kind: 'API_COMMAND',
        ...base,
        available: journey.freshAuthorization !== undefined,
        ...(journey.freshAuthorization === undefined
          ? { unavailableReason: 'no fresh authorization recorded yet' }
          : {}),
        apiCommand: {
          method: 'POST',
          path: '/v1/intents',
          body: {
            commandType: journey.lineage.originalCommandType,
            ...(journey.lineage.amount === undefined ? {} : { amount: journey.lineage.amount }),
            correlationId:
              journey.lineage.intentId ??
              `reauth:${journey.lineage.commandHash ?? journey.lineage.originalCommandType}`,
            reauthorizationRef: journey.freshAuthorization?.authorizationRef,
            ...(journey.approval === undefined
              ? {}
              : { approvalArtifactRef: approvalArtifactRef(journey.approval.requestHash) }),
          },
        },
      });
      actions.push({
        actionId: 'view-fresh-authorization-evidence',
        label: 'View the fresh-authorization evidence',
        kind: 'EVIDENCE_VIEW',
        authorityRef: journey.freshAuthorization?.evidenceRef ?? base.authorityRef,
        available: journey.freshAuthorization !== undefined,
        ...(journey.freshAuthorization === undefined
          ? { unavailableReason: 'no fresh authorization recorded yet' }
          : {}),
      });
      break;
    case 'EXECUTION_RESUMED':
      actions.push({
        actionId: 'view-resumed-execution',
        label: 'View the resumed execution',
        kind: 'API_COMMAND',
        authorityRef: journey.resumedIntentId ?? base.authorityRef,
        available: journey.resumedIntentId !== undefined,
        ...(journey.resumedIntentId === undefined
          ? { unavailableReason: 'no resumed intent id recorded on this journey' }
          : {}),
        apiCommand: {
          method: 'GET',
          path: `/v1/intents/${journey.resumedIntentId ?? 'unknown'}`,
        },
      });
      actions.push({
        actionId: 'view-lineage',
        label: 'View the preserved lineage (old intent, new authorization)',
        kind: 'EVIDENCE_VIEW',
        ...base,
        available: true,
      });
      break;
    default: {
      const exhaustive: never = journey.stateName;
      throw new JourneyContractError(`unhandled reauth state: ${String(exhaustive)}`);
    }
  }
  return Object.freeze(actions);
}

function finishReauth(journey: Omit<ReauthJourney, 'actions'>): ReauthJourney {
  return Object.freeze({ ...journey, actions: reauthActions(journey) });
}

/**
 * Begin the reauthorization journey. The trigger (EXPIRED or
 * STEP_UP_REQUIRED) and the preserved lineage come from AUTHORITY state —
 * the derivation never invents an expiry.
 */
export function beginReauthorization(input: {
  readonly trigger: 'EXPIRED' | 'STEP_UP_REQUIRED';
  readonly lineage: ReauthLineage;
}): ReauthJourney {
  return finishReauth({
    journeyId: 'reauthorize',
    stateName: 'AUTHORIZATION_EXPIRED',
    terminal: false,
    trigger: input.trigger,
    lineage: Object.freeze({ ...input.lineage }),
  });
}

/**
 * Fold the fresh-authorization REQUEST response (POST /v1/approvals). A 202
 * approval request is folded through the SAME
 * `parseIntentSubmissionResponse` consumption: APPROVAL_REQUIRED becomes the
 * customer-action phase with the trusted-surface deep link.
 */
export function applyReauthorizationRequestResponse(
  journey: ReauthJourney,
  response: ApiResponse,
): ReauthJourney {
  if (journey.stateName !== 'AUTHORIZATION_EXPIRED') {
    throw new JourneyContractError(
      `a reauthorization request response is not foldable in state ${journey.stateName}`,
    );
  }
  const outcome = parseIntentSubmissionResponse(response);
  switch (outcome.kind) {
    case 'APPROVAL_REQUIRED':
      assertProductJourneyTransition(
        REAUTH_TRANSITIONS,
        'reauthorize',
        journey.stateName,
        'CUSTOMER_ACTION_REQUIRED',
      );
      return finishReauth({
        ...journey,
        stateName: 'CUSTOMER_ACTION_REQUIRED',
        approval: foldApprovalInfo(outcome),
        ...(outcome.deepLink === undefined ? {} : { trustedSurfaceDeepLink: outcome.deepLink }),
      });
    case 'ERROR':
      return finishReauth({ ...journey, error: outcome });
    case 'GRANTED':
      throw new JourneyContractError(
        'a reauthorization request is expected to produce an approval request or an error (a bare grant has no customer action to complete)',
      );
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled reauthorization outcome: ${String(exhaustive)}`);
    }
  }
}

/** Fold: the customer began the trusted-surface reauthorization. */
export function beginTrustedSurfaceReauthorization(journey: ReauthJourney): ReauthJourney {
  assertProductJourneyTransition(
    REAUTH_TRANSITIONS,
    'reauthorize',
    journey.stateName,
    'REAUTHORIZING_ON_TRUSTED_SURFACE',
  );
  return finishReauth({ ...journey, stateName: 'REAUTHORIZING_ON_TRUSTED_SURFACE' });
}

/**
 * Fold: record the FRESH authorization (opaque reference + evidence
 * reference — both required). The lineage is carried verbatim.
 *
 * The fresh authorization CONSUMES the customer-action approval folded at
 * the reauthorization request: completing authorization on the trusted
 * surface is what PRODUCES this record, so the pending approval is cleared
 * here — the resume envelope must not carry the stale authorization-request
 * artifact (the api handler rejects unknown artifacts). A resume that
 * itself requires approval parks through `applyExecutionResumedResponse`,
 * which folds a NEW approval for the resume re-dispatch.
 */
export function recordFreshAuthorization(
  journey: ReauthJourney,
  fresh: FreshAuthorizationRecord,
): ReauthJourney {
  assertProductJourneyTransition(
    REAUTH_TRANSITIONS,
    'reauthorize',
    journey.stateName,
    'FRESH_AUTHORIZATION_RECORDED',
  );
  const { approval: _consumedByFreshAuthorization, ...journeyWithoutApproval } = journey;
  return finishReauth({
    ...journeyWithoutApproval,
    stateName: 'FRESH_AUTHORIZATION_RECORDED',
    freshAuthorization: Object.freeze({ ...fresh }),
  });
}

/** Fold the execution-resume response (the new authorization executes the old lineage). */
export function applyExecutionResumedResponse(
  journey: ReauthJourney,
  response: ApiResponse,
): ReauthJourney {
  if (journey.stateName !== 'FRESH_AUTHORIZATION_RECORDED' || journey.freshAuthorization === undefined) {
    throw new JourneyContractError(
      'an execution-resume response requires a recorded fresh authorization',
    );
  }
  const outcome = parseIntentSubmissionResponse(response);
  switch (outcome.kind) {
    case 'GRANTED':
      assertProductJourneyTransition(
        REAUTH_TRANSITIONS,
        'reauthorize',
        journey.stateName,
        'EXECUTION_RESUMED',
      );
      return finishReauth({
        ...journey,
        stateName: 'EXECUTION_RESUMED',
        terminal: true,
        resumedIntentId: outcome.intentId,
      });
    case 'APPROVAL_REQUIRED':
      // The resume needs an approval: park with the approval recorded; the
      // trusted surface completes it and the resume is re-dispatched.
      return finishReauth({ ...journey, approval: foldApprovalInfo(outcome) });
    case 'ERROR':
      return finishReauth({ ...journey, error: outcome });
    default: {
      const exhaustive: never = outcome;
      throw new JourneyContractError(`unhandled resume outcome: ${String(exhaustive)}`);
    }
  }
}

/** Dispatch `begin-reauthorization-request` through the api surface and fold. */
export async function dispatchReauthorizationRequest(
  session: JourneySession,
  journey: ReauthJourney,
): Promise<{ readonly journey: ReauthJourney; readonly response: ApiResponse }> {
  const action = journey.actions.find((candidate) => candidate.actionId === 'begin-reauthorization-request');
  if (action === undefined || !action.available || action.apiCommand === undefined) {
    throw new JourneyContractError('begin-reauthorization-request is not available in this state');
  }
  const spec: ApiCommandSpec = {
    ...action.apiCommand,
    body: {
      ...(action.apiCommand.body as Readonly<Record<string, unknown>>),
      principal: session.auth.principal,
    },
  };
  const response = await dispatchJourneyCommand(session, spec);
  return { journey: applyReauthorizationRequestResponse(journey, response), response };
}

/** Dispatch `resume-execution` through the api surface and fold the response. */
export async function dispatchResumeExecution(
  session: JourneySession,
  journey: ReauthJourney,
): Promise<{ readonly journey: ReauthJourney; readonly response: ApiResponse }> {
  const response = await dispatchProductJourneyAction(session, journey, 'resume-execution');
  return { journey: applyExecutionResumedResponse(journey, response), response };
}

// ---------------------------------------------------------------------------
// The product journey registry — state table, nav bindings, no dead buttons
// ---------------------------------------------------------------------------

export type ProductJourney =
  | ConnectProviderJourney
  | PayJourney
  | CollectJourney
  | PayoutJourney
  | ReconcileJourney
  | EvidenceJourney
  | ReauthJourney;

export type ProductJourneyId = ProductJourney['journeyId'];

export const PRODUCT_JOURNEY_IDS = [
  'connect-provider',
  'pay',
  'collect',
  'payout',
  'reconcile-payment-outcome',
  'evidence',
  'reauthorize',
] as const;

export interface ProductJourneyStateSpecEntry {
  readonly stateName: string;
  readonly terminal: boolean;
}

export interface ProductJourneyStateSpec {
  readonly journeyId: ProductJourneyId;
  readonly states: readonly ProductJourneyStateSpecEntry[];
}

/**
 * The declared state table of the seven product journeys. The
 * no-dead-buttons contract cross-checks driven journeys against this table:
 * no NON-TERMINAL state has zero available actions, and the terminal flags
 * match the driven journeys exactly.
 */
export const PRODUCT_JOURNEY_STATES: readonly ProductJourneyStateSpec[] = Object.freeze([
  {
    journeyId: 'connect-provider',
    states: Object.freeze([
      { stateName: 'idle', terminal: false },
      { stateName: 'browsing', terminal: false },
      { stateName: 'initiating', terminal: false },
      { stateName: 'awaiting-authorization', terminal: false },
      { stateName: 'connected-capability-instance', terminal: true },
      { stateName: 'expired', terminal: true },
      { stateName: 'revoked', terminal: true },
    ]),
  },
  {
    journeyId: 'pay',
    states: Object.freeze([
      { stateName: 'SELECTING_CAPABILITY', terminal: false },
      { stateName: 'REVIEWING_ROUTE', terminal: false },
      { stateName: 'AWAITING_APPROVAL', terminal: false },
      { stateName: 'SUBMITTED', terminal: false },
      { stateName: 'TRACKING', terminal: false },
      { stateName: 'RECONCILING', terminal: false },
      { stateName: 'COMPLETED', terminal: true },
      { stateName: 'FAILED', terminal: true },
      { stateName: 'ABANDONED', terminal: true },
    ]),
  },
  {
    journeyId: 'collect',
    states: Object.freeze([
      { stateName: 'COMPOSING_REQUEST', terminal: false },
      { stateName: 'REQUEST_CREATED', terminal: false },
      { stateName: 'SHARED', terminal: false },
      { stateName: 'TRACKING', terminal: false },
      { stateName: 'FULFILLED', terminal: true },
      { stateName: 'EXPIRED', terminal: true },
      { stateName: 'CANCELLED', terminal: true },
      { stateName: 'ABANDONED', terminal: true },
    ]),
  },
  {
    journeyId: 'payout',
    states: Object.freeze([
      { stateName: 'SPECIFYING_DESTINATION', terminal: false },
      { stateName: 'CONFIRMING_SCOPE', terminal: false },
      { stateName: 'AWAITING_APPROVAL', terminal: false },
      { stateName: 'SUBMITTED', terminal: false },
      { stateName: 'TRACKING', terminal: false },
      { stateName: 'RECONCILING', terminal: false },
      { stateName: 'COMPLETED', terminal: true },
      { stateName: 'FAILED', terminal: true },
      { stateName: 'ABANDONED', terminal: true },
    ]),
  },
  {
    journeyId: 'reconcile-payment-outcome',
    states: Object.freeze([
      { stateName: 'TRACKING_IN_FLIGHT', terminal: false },
      { stateName: 'OUTCOME_UNKNOWN', terminal: false },
      { stateName: 'PENDING_OBSERVATION', terminal: false },
      { stateName: 'RESOLVED_FULFILLED', terminal: true },
      { stateName: 'RESOLVED_FAILED', terminal: true },
    ]),
  },
  {
    journeyId: 'evidence',
    states: Object.freeze([
      { stateName: 'LISTING', terminal: false },
      { stateName: 'INSPECTING_ARTIFACT', terminal: false },
    ]),
  },
  {
    journeyId: 'reauthorize',
    states: Object.freeze([
      { stateName: 'AUTHORIZATION_EXPIRED', terminal: false },
      { stateName: 'CUSTOMER_ACTION_REQUIRED', terminal: false },
      { stateName: 'REAUTHORIZING_ON_TRUSTED_SURFACE', terminal: false },
      { stateName: 'FRESH_AUTHORIZATION_RECORDED', terminal: false },
      { stateName: 'EXECUTION_RESUMED', terminal: true },
    ]),
  },
]);

/**
 * The no-dead-buttons check for ONE product journey state: a state must
 * declare at least one AVAILABLE action unless it is terminally complete.
 */
export function productJourneyStateHasLiveActions(journey: ProductJourney): boolean {
  return journey.actions.some((action) => action.available);
}

/**
 * The navigation binding of each product journey (consumed from
 * product-ia.ts — the Wave 2 UIs bind journey surfaces to these nav items).
 */
export const JOURNEY_NAV_BINDINGS: Readonly<Record<ProductJourneyId, ProductNavItemId>> =
  Object.freeze({
    'connect-provider': 'capabilities',
    pay: 'payments',
    collect: 'collections',
    payout: 'payouts',
    'reconcile-payment-outcome': 'payments',
    evidence: 'evidence',
    reauthorize: 'settings',
  });

/**
 * The product journeys bound to one navigation item (the derivation fails
 * closed on unknown nav ids through `navItemById`).
 */
export function journeysForNavItem(navItemId: ProductNavItemId): readonly ProductJourneyId[] {
  navItemById(navItemId);
  return Object.freeze(
    PRODUCT_JOURNEY_IDS.filter((journeyId) => JOURNEY_NAV_BINDINGS[journeyId] === navItemId),
  );
}
