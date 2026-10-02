/**
 * @payswap/journeys — the provider conformance profile contract (P2-W2-003).
 *
 * A profile is the DECLARED, provider-parameterized surface the shared
 * scenario scripts run against: the provider's own envelope mappers (with
 * synthetic fixtures), its webhook contract, its duplicate-submission
 * contract, its SDK fail-closed surface and its outage probe. Every piece
 * is DATA or a thin adapter over the provider's exported connector code —
 * never a re-implementation, never a mock of provider behavior.
 */

import type { HttpTransport } from "@payswap/rails";
import type { ConnectorSDK } from "@payswap/adapters";
import type { ProviderWebhookIngestor, ProviderWebhookRawEvent } from "@payswap/adapters";
import type {
  ExternalFundsPositionObservation,
  ProviderStateEnvelope,
  ProviderStateFamily,
} from "@payswap/connectors";
import type { ApplicabilityBasis, ConformanceScenarioId, OutageProbeOutcome } from "./model.js";

// ---------------------------------------------------------------------------
// Envelope mappers (the provider's OWN mapping code + synthetic fixtures)
// ---------------------------------------------------------------------------

/**
 * One provider object kind: the provider's own envelope builder wrapped with
 * a deterministic observation context, plus a synthetic fixture builder
 * parameterized by the RAW provider status (the provider's own vocabulary).
 * Profiles cast the opaque object to the provider's own type inside `build`.
 */
export interface EnvelopeMapper {
  /** Maps one synthetic provider object through the provider's OWN builder. */
  readonly build: (object: unknown) => ProviderStateEnvelope;
  /** Builds a synthetic provider object carrying the raw status. */
  readonly fixture: (status: string, overrides?: Readonly<Record<string, unknown>>) => unknown;
}

/** A status-progression fixture: raw status → expected classification. */
export interface StatusFixture {
  readonly status: string;
  readonly family: ProviderStateFamily;
  readonly overrides?: Readonly<Record<string, unknown>>;
  readonly lifecycleStep?: string;
  readonly isTerminal?: boolean;
}

// ---------------------------------------------------------------------------
// The webhook contract (where the provider has webhooks)
// ---------------------------------------------------------------------------

export interface WebhookContract {
  /** An obviously-fake synthetic signing secret (planted only in the verifier). */
  readonly syntheticSecret: string;
  /** Builds the provider's webhook ingestor (verifier + fixed clock). */
  readonly makeIngestor: (secret: string) => ProviderWebhookIngestor;
  /** Signs a synthetic payload with the provider's OWN scheme. */
  readonly sign: (secret: string, payload: unknown) => {
    readonly signature: string;
    readonly timestamp: string;
  };
  /** Builds the provider-shaped raw delivery event for the ingestor. */
  readonly rawEvent: (
    payload: unknown,
    signature: string,
    timestamp: string,
  ) => ProviderWebhookRawEvent;
  /** Maps the payload through the provider's OWN webhook event envelope. */
  readonly mapEvent: (payload: unknown) => ProviderStateEnvelope;
  /** A synthetic provider-native webhook payload (e.g. charge.succeeded). */
  readonly samplePayload: () => unknown;
  /** The external id the sampled event's object carries. */
  readonly expectedExternalId: string;
  /** The family the provider's mapping assigns the sampled event. */
  readonly expectedFamily: ProviderStateFamily;
}

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

export interface ProviderConformanceProfile {
  readonly providerName: string;
  readonly providerVersion: string;
  /**
   * The honest live-deployment datum (LIVE-verified, BLOCKED, NXDOMAIN,
   * TESTNET) — carried into every verdict's notes, never hidden.
   */
  readonly honestyNote: string;
  /** The declared applicability for every one of the 13 scenarios. */
  readonly applicability: Readonly<Record<ConformanceScenarioId, ApplicabilityBasis>>;

  // -- the primary pay-in lifecycle (payment / order / transaction / intent) --
  readonly payment: EnvelopeMapper;
  /** The customer-action fixture (raw status + the provider's action object). */
  readonly customerAction: {
    readonly fixture: StatusFixture;
    /** A dedicated mapper where the customer-action object is a DIFFERENT provider object (e.g. a hosted-checkout link). */
    readonly mapper?: EnvelopeMapper;
  };
  /** The async-processing raw status (stays non-terminal, never FAILED). */
  readonly asyncStatus: string;
  /** The terminal failed raw status (the fallback scenario's failed path). */
  readonly failedStatus: string;
  /** An UNMAPPED raw status (the UNKNOWN probe — never guessed). */
  readonly unknownStatus: string;
  /** The terminal succeeded raw status (settled-external). */
  readonly succeededStatus: string;

  // -- optional lifecycles, declared only where the provider models them --
  readonly capture?: {
    readonly authorized: StatusFixture;
    readonly captured: StatusFixture;
    readonly mapper?: EnvelopeMapper;
  };
  readonly mandate?: {
    readonly fixture: StatusFixture;
    readonly mapper: EnvelopeMapper;
  };
  readonly refund?: {
    readonly pending: StatusFixture;
    readonly completed: StatusFixture;
    readonly mapper: EnvelopeMapper;
    /** The refund amount field the provider preserves verbatim (partial-refund explicitness). */
    readonly amountField: string;
    /** A partial amount (distinct from the original payment amount). */
    readonly partialAmount: string | number;
  };
  readonly dispute?: {
    readonly fixture: StatusFixture;
    readonly mapper: EnvelopeMapper;
  };
  readonly payout?: {
    readonly pending: StatusFixture;
    readonly completed: StatusFixture;
    readonly mapper: EnvelopeMapper;
    /** INV-C09 observations of the provider-held payout position. */
    readonly fundsObservations?: () => readonly ExternalFundsPositionObservation[];
  };

  // -- duplicate submission (INV-F05: same protocol key, provider duplicate class) --
  readonly duplicate?: {
    /** The provider's idempotency-material derivation from the protocol key. */
    readonly derive: (protocolIdempotencyKey: string) => string;
    /** The provider's dedicated duplicate error class, where one exists. */
    readonly duplicateClass?: abstract new (...args: never[]) => Error;
    /**
     * The SDK-level two-submission probe: the second submission with the
     * SAME protocol key MUST raise the provider duplicate class (never a
     * silent second success).
     */
    readonly sdkProbe?: () => Promise<{ readonly errorClass: string }>;
    /** The capability-declared duplicateBehavior (never silent). */
    readonly declaredDuplicateBehavior: string;
  };

  // -- webhook contract (where the provider has webhooks) --
  readonly webhook?: WebhookContract;

  // -- the SDK-level probes --
  /** The mid-effect outage probe (dead transport, INV-X01). */
  readonly outageProbe?: () => Promise<OutageProbeOutcome>;
  /** The fail-closed surface: bare connector + effectful SDK invocations. */
  readonly sdkAuth: {
    readonly makeBareConnector: (http: HttpTransport) => ConnectorSDK;
    readonly effectfulCalls: readonly {
      readonly name: string;
      readonly invoke: (connector: ConnectorSDK) => Promise<unknown>;
    }[];
  };

  /**
   * The synthetic key material markers planted ONLY in SDK transports /
   * env fixtures — the SECURITY gate byte-scans every product for them.
   */
  readonly secretMaterialMarkers: readonly string[];
}

/** The registry of profiles in scope (Wave 1 + Wave 2 connector set). */
export interface ConformanceProfileSet {
  readonly profiles: readonly ProviderConformanceProfile[];
}
