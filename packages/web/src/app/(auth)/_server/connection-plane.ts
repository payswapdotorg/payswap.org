/**
 * The server-side connection plane (P3-W1-002) — the provider connection
 * flows consuming the REAL W3-001 journey contracts from @payswap/ux.
 *
 * Laws honored (the heart of the work order):
 *
 * - LEGAL-TRANSITIONS-ONLY: every state change goes through the frozen
 *   folds (`beginConnectProvider` → `browseProviderCatalogue` →
 *   `chooseProvider` → `applyConnectionInitiationResponse`); this module
 *   NEVER edits journey state directly. An illegal transition throws
 *   `JourneyContractError` and surfaces honestly.
 *
 * - THE CATALOGUE NEVER AUTHORIZES: `chooseProvider` is the only path from
 *   browsing to initiating, and it refuses non-connectable providers. A
 *   connected capability instance can only EVER enter a journey through an
 *   AUTHORITY activation record (`applyConnectionAuthorizationOutcome`) —
 *   and this web app is NOT the authority, so it never mints one. No user
 *   connection is fabricated, ever.
 *
 * - CREDENTIALS NEVER CROSS: the browser-session broker pattern. The
 *   provider-hosted authorization surface is where the customer
 *   authenticates; the only value that ever comes back to this app is the
 *   opaque `BrowserSessionRef`. In THIS deployment no real provider broker
 *   is bound, so the plane reports the honest
 *   "authorization surface not yet bound to this deployment" state and
 *   mints NOTHING (the `attachBrowserSession` fold exists in the contract
 *   and is exercised by tests with obviously-fake refs).
 *
 * - THE REAL API IS THE INITIATION TARGET: `initiateConnection` POSTs the
 *   connection-initiate command to the authoritative PaySwap API through
 *   the session-aware client (web principal as context). The response is
 *   folded VERBATIM — the deployed API answers 403
 *   `auth.session_token_required` because no public session-issuance path
 *   exists yet, and the journey records that error exactly; the UI renders
 *   the honest "API session not yet wired in this deployment" state.
 *
 * HONEST LIMITATION: the journey store is in-memory and process-local
 * (documented interface — a durable store can replace it). Restarting
 * forgets in-flight journeys; nothing about a forgotten journey ever
 * becomes a connection.
 */

import type { ApiResponse } from "@payswap/api";
import { ERROR_CATEGORIES, type ErrorCategory, type ResponseEnvelope } from "@payswap/interfaces";
import {
  JourneyContractError,
  applyConnectionInitiationResponse,
  attachBrowserSession,
  beginConnectProvider,
  browseProviderCatalogue,
  chooseProvider,
  type BrowserSessionRef,
  type CatalogueConnectionOption,
  type ConnectProviderJourney,
  type ProviderCatalogueEntry,
} from "@payswap/ux";

import { paySwapApiFetch, type PaySwapApiResult, type WebPrincipalContext } from "@/lib/api-client";
import { apiRuntimeState } from "@/lib/api";

import { providerCatalogueEntries } from "./connection-catalogue.js";

/** What the honest UI needs about the authorization-surface boundary. */
export interface AuthorizationSurfaceState {
  /** False in this deployment: no real provider broker is bound. */
  readonly brokerBound: false;
  /** The honest explanation (verbatim doctrine — never "failed"). */
  readonly honestState: string;
}

export const AUTHORIZATION_SURFACE_NOT_BOUND: AuthorizationSurfaceState = {
  brokerBound: false,
  honestState:
    "Authorization surface not yet bound to this deployment — no provider broker is wired, so the browser authorization surface cannot be opened yet. This is the honest not-yet state: the connection state machine is real, but completing authorization is not possible here until a broker is bound.",
};

/** The honest record of the last real API initiation attempt. */
export type ApiAttemptRecord =
  | { readonly kind: "not-attempted" }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "network-error"; readonly message: string }
  | {
      readonly kind: "answered";
      readonly statusCode: number;
      readonly outcome: "GRANTED" | "APPROVAL_REQUIRED" | "ERROR";
      readonly verbatimError?: {
        readonly code: string;
        readonly category: string;
        readonly message: string;
      };
    };

/** One stored journey (the contract object + honest attempt metadata). */
interface StoredJourney {
  readonly journey: ConnectProviderJourney;
  readonly apiAttempt: ApiAttemptRecord;
  readonly updatedAt: number;
}

/** JSON-safe projection for pages, routes and tests. */
export interface SerializedConnectionJourney {
  readonly journeyId: "connect-provider";
  readonly providerId: string;
  readonly stateName: ConnectProviderJourney["stateName"];
  readonly terminal: boolean;
  readonly chosenProviderId?: string;
  /** The opaque broker reference (opaque by contract; never a credential). */
  readonly browserSessionRef?: string;
  readonly initiationIntentId?: string;
  readonly approval?: {
    readonly requestHash: string;
    readonly expiresAt: string;
    readonly deepLink?: string;
  };
  readonly error?: {
    readonly kind: "ERROR";
    readonly category: string;
    readonly code: string;
    readonly message: string;
    readonly reconciliationRef?: string;
  };
  readonly apiAttempt: ApiAttemptRecord;
  readonly authorizationSurface: AuthorizationSurfaceState;
  readonly updatedAt: number;
}

/** Honest outcome of a plane operation (never throws for expected failures). */
export type PlaneOperationResult =
  | { readonly status: "ok"; readonly journey: SerializedConnectionJourney }
  | { readonly status: "not-found" }
  | { readonly status: "illegal"; readonly message: string }
  | {
      readonly status: "api-unavailable";
      readonly reason: "unconfigured" | "network-error";
      readonly message: string;
      readonly journey: SerializedConnectionJourney;
    };

/** The connection plane. One instance per process (module singleton). */
export class ConnectionPlane {
  readonly #journeys = new Map<string, Map<string, StoredJourney>>();
  readonly #catalogue: readonly ProviderCatalogueEntry[];

  constructor(catalogue: readonly ProviderCatalogueEntry[] = providerCatalogueEntries()) {
    this.#catalogue = catalogue;
  }

  /**
   * Begin (or resume) a connection journey for a provider: browsing →
   * choosing. `chooseProvider` folds ONLY to `initiating` — it never
   * produces a connection (the catalogue is not authority; the W3-001
   * contract enforces this structurally).
   */
  selectProvider(principalRef: string, providerId: string): PlaneOperationResult {
    const stored = this.#storedFor(principalRef, providerId);
    let journey: ConnectProviderJourney;
    if (stored === undefined) {
      journey = browseProviderCatalogue(beginConnectProvider({ catalogue: this.#catalogue }));
    } else {
      journey = stored.journey;
      if (journey.stateName !== "idle" && journey.stateName !== "browsing") {
        // Resuming an in-flight journey is honest; re-choosing is not needed.
        return { status: "ok", journey: this.#serialize(principalRef, providerId, stored) };
      }
      if (journey.stateName === "idle") {
        journey = browseProviderCatalogue(journey);
      }
    }
    try {
      journey = chooseProvider(journey, providerId);
    } catch (error) {
      if (error instanceof JourneyContractError) {
        return { status: "illegal", message: error.message };
      }
      throw error;
    }
    const updated: StoredJourney = {
      journey,
      apiAttempt: { kind: "not-attempted" },
      updatedAt: Date.now(),
    };
    this.#store(principalRef, providerId, updated);
    return { status: "ok", journey: this.#serialize(principalRef, providerId, updated) };
  }

  /**
   * Initiate the connection against the REAL PaySwap API and fold the
   * verbatim response through the contract.
   */
  async initiateConnection(
    principalRef: string,
    providerId: string,
    principal: WebPrincipalContext,
  ): Promise<PlaneOperationResult> {
    const stored = this.#storedFor(principalRef, providerId);
    if (stored === undefined || stored.journey.stateName !== "initiating") {
      return { status: "not-found" };
    }
    if (stored.apiAttempt.kind === "answered") {
      // One authoritative attempt per journey — a fold already happened;
      // re-initiation would bypass the contract's error-recorded retry
      // semantics. The honest action is to read the recorded outcome.
      return { status: "ok", journey: this.#serialize(principalRef, providerId, stored) };
    }

    const result: PaySwapApiResult<{ data: unknown; meta: ResponseEnvelope<unknown>["meta"] }> =
      await paySwapApiFetch(principal, "/v1/intents", {
        method: "POST",
        body: {
          commandType: "capabilities.connection.initiate",
          providerId,
          correlationId: `connect:${providerId}`,
        },
      });

    if (result.status === "unconfigured") {
      const updated: StoredJourney = {
        journey: stored.journey,
        apiAttempt: { kind: "unconfigured" },
        updatedAt: Date.now(),
      };
      this.#store(principalRef, providerId, updated);
      return {
        status: "api-unavailable",
        reason: "unconfigured",
        message:
          "The PaySwap API runtime is not configured in this deployment (NEXT_PUBLIC_PAYSWAP_API_URL) — there is nothing to initiate against yet.",
        journey: this.#serialize(principalRef, providerId, updated),
      };
    }
    if (result.status === "network-error") {
      const updated: StoredJourney = {
        journey: stored.journey,
        apiAttempt: { kind: "network-error", message: result.message },
        updatedAt: Date.now(),
      };
      this.#store(principalRef, providerId, updated);
      return {
        status: "api-unavailable",
        reason: "network-error",
        message: result.message,
        journey: this.#serialize(principalRef, providerId, updated),
      };
    }

    // Fold the VERBATIM response through the contract (success or error).
    const apiResponse = toApiResponse(result);
    const folded = applyConnectionInitiationResponse(stored.journey, apiResponse);
    const attempt: ApiAttemptRecord =
      result.status === "ok"
        ? { kind: "answered", statusCode: 200, outcome: outcomeOf(folded) }
        : {
            kind: "answered",
            statusCode: result.statusCode,
            outcome: "ERROR",
            verbatimError:
              result.body?.error !== undefined
                ? {
                    code: result.body.error.code,
                    category: result.body.error.category,
                    message: result.body.error.message,
                  }
                : undefined,
          };
    const updated: StoredJourney = { journey: folded, apiAttempt: attempt, updatedAt: Date.now() };
    this.#store(principalRef, providerId, updated);
    return { status: "ok", journey: this.#serialize(principalRef, providerId, updated) };
  }

  /**
   * The browser-session broker boundary. HONEST in this deployment: no
   * provider broker is bound, so nothing is minted — the caller receives
   * the not-bound state. When a real broker IS bound (deployment wiring),
   * the broker's redirect is the ONLY thing that produces the opaque
   * `BrowserSessionRef`, folded exclusively via `attachBrowserSession`.
   * Credentials never cross this boundary in either direction.
   */
  authorizationSurface(): AuthorizationSurfaceState {
    return AUTHORIZATION_SURFACE_NOT_BOUND;
  }

  /**
   * Fold an opaque broker reference into the journey. Reached only from a
   * REAL broker callback (none bound in this deployment — tests exercise
   * it with obviously-fake refs). Requires the journey to be `initiating`
   * per the contract.
   */
  attachBrokerSessionRef(
    principalRef: string,
    providerId: string,
    browserSessionRef: BrowserSessionRef,
  ): PlaneOperationResult {
    const stored = this.#storedFor(principalRef, providerId);
    if (stored === undefined || stored.journey.stateName !== "initiating") {
      return { status: "not-found" };
    }
    try {
      const journey = attachBrowserSession(stored.journey, browserSessionRef);
      const updated: StoredJourney = {
        journey,
        apiAttempt: stored.apiAttempt,
        updatedAt: Date.now(),
      };
      this.#store(principalRef, providerId, updated);
      return { status: "ok", journey: this.#serialize(principalRef, providerId, updated) };
    } catch (error) {
      if (error instanceof JourneyContractError) {
        return { status: "illegal", message: error.message };
      }
      throw error;
    }
  }

  /** Restart after a terminal state (expired/revoked): a FRESH journey. */
  restartConnection(principalRef: string, providerId: string): PlaneOperationResult {
    const stored = this.#storedFor(principalRef, providerId);
    if (
      stored === undefined ||
      (stored.journey.stateName !== "expired" && stored.journey.stateName !== "revoked")
    ) {
      return { status: "illegal", message: "restart-connection requires a terminal connection journey" };
    }
    this.#journeys.get(principalRef)?.delete(providerId);
    return this.selectProvider(principalRef, providerId);
  }

  /** All journeys for a principal (serialized, newest first). */
  journeysFor(principalRef: string): readonly SerializedConnectionJourney[] {
    const perProvider = this.#journeys.get(principalRef);
    if (perProvider === undefined) {
      return [];
    }
    return [...perProvider.entries()]
      .map(([providerId, stored]) => this.#serialize(principalRef, providerId, stored))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** One journey for a principal (or undefined — the honest empty state). */
  journeyFor(
    principalRef: string,
    providerId: string,
  ): SerializedConnectionJourney | undefined {
    const stored = this.#storedFor(principalRef, providerId);
    return stored === undefined ? undefined : this.#serialize(principalRef, providerId, stored);
  }

  /** The chosen catalogue option for a provider (connectability note included). */
  catalogueOptionFor(providerId: string): CatalogueConnectionOption | undefined {
    return beginConnectProvider({ catalogue: this.#catalogue }).catalogue.find(
      (option) => option.providerId === providerId,
    );
  }

  /** True when the principal has ANY non-terminal journey (onboarding input). */
  hasActiveJourney(principalRef: string): boolean {
    return this.journeysFor(principalRef).some(
      (journey) => journey.stateName !== "expired" && journey.stateName !== "revoked",
    );
  }

  #storedFor(principalRef: string, providerId: string): StoredJourney | undefined {
    return this.#journeys.get(principalRef)?.get(providerId);
  }

  #store(principalRef: string, providerId: string, stored: StoredJourney): void {
    let perProvider = this.#journeys.get(principalRef);
    if (perProvider === undefined) {
      perProvider = new Map<string, StoredJourney>();
      this.#journeys.set(principalRef, perProvider);
    }
    perProvider.set(providerId, stored);
  }

  #serialize(
    _principalRef: string,
    providerId: string,
    stored: StoredJourney,
  ): SerializedConnectionJourney {
    const journey = stored.journey;
    return {
      journeyId: "connect-provider",
      providerId,
      stateName: journey.stateName,
      terminal: journey.terminal,
      ...(journey.chosenProviderId === undefined ? {} : { chosenProviderId: journey.chosenProviderId }),
      ...(journey.browserSessionRef === undefined
        ? {}
        : { browserSessionRef: journey.browserSessionRef }),
      ...(journey.initiationIntentId === undefined
        ? {}
        : { initiationIntentId: journey.initiationIntentId }),
      ...(journey.approval === undefined
        ? {}
        : {
            approval: {
              requestHash: journey.approval.requestHash,
              expiresAt: journey.approval.expiresAt,
              ...(journey.approval.deepLink === undefined
                ? {}
                : { deepLink: journey.approval.deepLink }),
            },
          }),
      ...(journey.error === undefined ? {} : { error: journey.error }),
      apiAttempt: stored.apiAttempt,
      authorizationSurface: this.authorizationSurface(),
      updatedAt: stored.updatedAt,
    };
  }
}

function outcomeOf(
  journey: ConnectProviderJourney,
): "GRANTED" | "APPROVAL_REQUIRED" | "ERROR" {
  if (journey.error !== undefined) {
    return "ERROR";
  }
  if (journey.stateName === "awaiting-authorization") {
    return journey.approval !== undefined ? "APPROVAL_REQUIRED" : "GRANTED";
  }
  return "ERROR";
}

/** Verbatim-category guard: fold only categories the contract knows. */
function asErrorCategory(value: string | undefined): ErrorCategory {
  return value !== undefined &&
    (ERROR_CATEGORIES as readonly string[]).includes(value)
    ? (value as ErrorCategory)
    : "INTERNAL";
}

/** Map a PaySwapApiResult to the contract's ApiResponse (verbatim). */
function toApiResponse(
  result:
    | { status: "ok"; data: { data: unknown; meta: ResponseEnvelope<unknown>["meta"] } }
    | {
        status: "http-error";
        statusCode: number;
        body?: { error: { code: string; category: string; message: string; reconciliationRef?: string }; meta?: { schemaVersion?: string; requestId?: string } };
      },
): ApiResponse {
  if (result.status === "ok") {
    return {
      kind: "success",
      status: 200,
      envelope: {
        data: result.data.data,
        meta: {
          schemaVersion: result.data.meta?.schemaVersion ?? "",
          requestId: result.data.meta?.requestId ?? "",
        },
      },
    };
  }
  const error = result.body?.error;
  return {
    kind: "error",
    status: result.statusCode,
    body: {
      error: {
        code: error?.code ?? "unknown",
        category: asErrorCategory(error?.category),
        message: error?.message ?? `HTTP ${result.statusCode}`,
        ...(error?.reconciliationRef === undefined ? {} : { reconciliationRef: error.reconciliationRef }),
      },
      meta: {
        schemaVersion: result.body?.meta?.schemaVersion ?? "",
        requestId: result.body?.meta?.requestId ?? "",
      },
    },
  };
}

/** Is the PaySwap API configured for initiation attempts? */
export function apiConfigured(): boolean {
  return apiRuntimeState().configured;
}

// ---------------------------------------------------------------------------
// Module singleton (process-local; tests construct their own instances)
// ---------------------------------------------------------------------------

let plane: ConnectionPlane | undefined;

export function getConnectionPlane(): ConnectionPlane {
  plane ??= new ConnectionPlane();
  return plane;
}

/** Test hook: a fresh isolated plane. */
export function buildConnectionPlaneForTests(
  catalogue?: readonly ProviderCatalogueEntry[],
): ConnectionPlane {
  return new ConnectionPlane(catalogue);
}
