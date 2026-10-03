/**
 * @payswap/onchain-adapters — THE FROZEN FAMILY-ADAPTER LIFECYCLE CONTRACT
 * (Work Order P4-W2-001, contract-first method step 1).
 *
 * Every chain family implements the adapter lifecycle EXPLICITLY:
 *
 *   observe → prepare → simulate → authorize → broadcast → observe →
 *   finality → reconcile → evidence
 *
 * Stage semantics (deterministic, vendor-neutral):
 * - observe:          read-only rail state — chain heads and external asset
 *                     positions AS OBSERVATIONS (INV-C09/rule 21: never
 *                     custody, never a balance). Unreachable rails surface
 *                     availability UNKNOWN (INV-C01/C02) — never success or
 *                     failure.
 * - prepare:          translate a validated neutral OnchainExecutionDirective
 *                     + ConnectedChainInstance + fresh chain head into (a) the
 *                     kernel-ready OnchainWriteRequest and (b) the family
 *                     execution plan. Chain-identity cross-checks run here.
 * - simulate:         family simulation as an OBSERVATION, never authority.
 *                     Families that cannot simulate (UTXO) declare the stage
 *                     unsupported and FAIL CLOSED when asked.
 * - authorize:        feed the onchain-security kernel: gates → diff →
 *                     authorization request → trusted-surface artifact →
 *                     pre-broadcast recheck → signing-request handoff. The
 *                     ADAPTER never authorizes; the kernel owns authority.
 * - broadcast:        submit the TRUSTED-SURFACE-SIGNED payload to the rail.
 *                     The result is BROADCAST (submitted ≠ finality, rule 29),
 *                     a definitive pre-chain rejection (FAILED), or
 *                     OUTCOME_UNKNOWN when it is unknown whether the operation
 *                     reached the chain (INV-X01 — never a transport failure
 *                     class).
 * - observe (result): poll the external operation → OnchainExecutionObservation
 *                     (BROADCAST | CONFIRMED | FAILED | OUTCOME_UNKNOWN).
 *                     Reorg/fork detection turns previously-observed state
 *                     into OUTCOME_UNKNOWN (ambiguity, INV-X01).
 * - finality:         compute a finality CANDIDATE with explicit family
 *                     semantics (depth/slots, reorg flags) — finality itself
 *                     stays protocol-owned (INV-F06; candidates only).
 * - reconcile:        given an OUTCOME_UNKNOWN observation, produce the
 *                     deterministic reconciliation plan. Blind retry is
 *                     structurally forbidden (INV-X02); reconciliation is the
 *                     only resolver (INV-X03).
 * - evidence:         append-only per-operation evidence log (INV-E01/E02).
 */

import type {
  AssetObservation,
  ConnectedChainInstance,
  OnchainExecutionDirective,
  OnchainExecutionObservation,
  OnchainFinalityCandidate,
} from "@payswap/onchain-domain";
import type {
  OnchainAuthorizationArtifact,
  OnchainSecurityPolicy,
  OnchainSecurityState,
  OnchainWriteRequest,
  RecheckObservation,
  SimulationObservation,
  SigningRequest,
  TrustedApprovalSurface,
} from "@payswap/onchain-security";
import type { Principal } from "@payswap/trust";
import type { ChainFamily } from "@payswap/onchain-domain";
import type { RailEnvironment, RailEnvironmentClass } from "./environment.js";
import type { FamilySemanticsProfile } from "./semantics.js";

// ---------------------------------------------------------------------------
// The lifecycle stages (frozen vocabulary)
// ---------------------------------------------------------------------------

export const ADAPTER_LIFECYCLE_STAGES = [
  "observe",
  "prepare",
  "simulate",
  "authorize",
  "broadcast",
  "observeResult",
  "finality",
  "reconcile",
  "evidence",
] as const;

export type AdapterLifecycleStage = (typeof ADAPTER_LIFECYCLE_STAGES)[number];

/** Explicit per-stage support declaration — unsupported stages fail closed. */
export type AdapterStageSupport = Readonly<Record<AdapterLifecycleStage, boolean>>;

// ---------------------------------------------------------------------------
// Provenance + observations
// ---------------------------------------------------------------------------

/** Who served an adapter observation (call-level, sanitized — never secrets). */
export interface AdapterProvenance {
  readonly transportId: string;
  readonly endpointId: string;
  readonly providerName: string;
  readonly capturedAt: string;
  readonly adapterId: string;
  readonly environmentClass: RailEnvironmentClass;
}

/** A neutral chain-head observation (read-only rail state). */
export interface ChainHeadObservation {
  readonly observationKind: "ChainHeadObservation";
  readonly chainKey: string;
  readonly environmentClass: RailEnvironmentClass;
  /** Neutral height: block number (EVM/UTXO) or slot (SOLANA). */
  readonly height: number;
  /** Opaque external head reference (block hash / blockhash). */
  readonly headHash: string;
  readonly observedAt: string;
  readonly provenance: AdapterProvenance;
  /** Declared maximum age (seconds) before this head is stale for acting. */
  readonly maxAgeSeconds: number;
}

/** INV-C02: an unreachable rail means availability UNKNOWN — never failure. */
export interface UnreachableRailObservation {
  readonly kind: "RAIL_UNREACHABLE";
  readonly availability: "UNKNOWN";
  readonly chainKey: string;
  readonly transportId: string;
  readonly attemptedEndpointIds: readonly string[];
  readonly message: string;
  readonly at: string;
}

export type ChainHeadProbe =
  | { readonly kind: "HEAD_OBSERVED"; readonly head: ChainHeadObservation }
  | UnreachableRailObservation;

export type AssetPositionProbe =
  | { readonly kind: "POSITION_OBSERVED"; readonly observation: AssetObservation }
  | {
      readonly kind: "POSITION_UNOBSERVABLE";
      readonly reason:
        | "RAIL_UNREACHABLE"
        | "PROVIDER_REJECTED_ACCOUNT"
        | "ASSET_BINDING_UNKNOWN";
      readonly message: string;
      readonly chainKey: string;
      readonly at: string;
    };

// ---------------------------------------------------------------------------
// prepare stage
// ---------------------------------------------------------------------------

/** Input to the prepare stage. */
export interface PrepareStageInput {
  readonly directive: OnchainExecutionDirective;
  /** Execution scope: a genuinely connected chain instance (INV-C05). */
  readonly instance: ConnectedChainInstance;
  /** The signing account's external on-chain address (opaque string). */
  readonly signerAccountRef: string;
  /** Fresh chain-head observation (stale heads invalidate preparation). */
  readonly head: ChainHeadObservation;
  /** Deterministic preparation instant (ms epoch). */
  readonly at: number;
  /** Requesting agent ref (labeling only — never authority). */
  readonly requestedBy: string;
  /** Optional settlement-instruction binding (INV-E01 lineage). */
  readonly settlementInstruction?: {
    readonly instructionId: string;
    readonly instructionDigest: string;
  };
}

/**
 * The prepared adapter operation: the kernel-ready neutral write request plus
 * the family-scoped execution plan (typed per family in the family modules;
 * opaque to the core contract — the family owns it).
 */
export interface PreparedAdapterOperation<FamilyPlan = unknown> {
  readonly operationKind: "PreparedAdapterOperation";
  readonly directive: OnchainExecutionDirective;
  readonly writeRequest: OnchainWriteRequest;
  /** The kernel's deterministic content digest of the write request. */
  readonly writeDigest: string;
  /** Family-scoped execution plan (adapter-owned, never core-interpreted). */
  readonly familyPlan: FamilyPlan;
  readonly preparedAt: number;
  readonly evidenceRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// authorize stage (feeds the onchain-security kernel)
// ---------------------------------------------------------------------------

/** Input to the authorize stage. */
export interface AuthorizeStageInput {
  readonly prepared: PreparedAdapterOperation;
  readonly policy: OnchainSecurityPolicy;
  readonly securityState: OnchainSecurityState;
  readonly surface: TrustedApprovalSurface;
  readonly principal: Principal;
  readonly approverRef: string;
  readonly requestId: string;
  readonly signingRequestId: string;
  readonly at: number;
  /** Authorization artifact expiry (ms epoch). */
  readonly expiresAt: number;
  /** Fresh security state for the pre-broadcast recheck (default: same state). */
  readonly recheckSecurityState?: OnchainSecurityState;
  /** Deterministic recheck instant (ms epoch; default at + 2). */
  readonly recheckAt?: number;
}

/** The ONLY output of a successful authorize stage: a kernel handoff. */
export interface AuthorizedExecutionFeed {
  readonly stageOutcome: "KERNEL_BROADCAST_HANDOFF";
  /** The kernel's terminal success state — the adapter cannot improve on it. */
  readonly pipelineState: "BROADCAST_HANDOFF";
  readonly signingRequest: SigningRequest;
  readonly authorizationRef: string;
  readonly recheckRef: string;
  readonly artifact: OnchainAuthorizationArtifact;
  readonly evidenceRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// broadcast + result observation stages
// ---------------------------------------------------------------------------

/** Input to the broadcast stage. */
export interface BroadcastStageInput {
  /** The kernel handoff produced by the authorize stage. */
  readonly handoff: SigningRequest;
  /** The payload AFTER the trusted surface signed it (opaque to the adapter). */
  readonly signedPayload: string;
  readonly at: number;
  /** The execution reference observations are keyed by (idempotency scope). */
  readonly executionRef: string;
}

export type BroadcastStageOutcome = OnchainExecutionObservation;

/** Input to the result-observation stage. */
export interface ObserveResultInput {
  readonly executionRef: string;
  readonly externalOperationRef: string;
  readonly at: number;
  /** Prior observation of the same operation (reorg/fork detection). */
  readonly prior?: OnchainExecutionObservation;
}

// ---------------------------------------------------------------------------
// finality + reconcile stages
// ---------------------------------------------------------------------------

/** The adapter's finality evaluation — a CANDIDATE plus declared guidance. */
export interface FinalityEvaluation {
  readonly operationKind: "FinalityEvaluation";
  readonly candidate: OnchainFinalityCandidate;
  /** Declared confirmation target from the family semantics profile. */
  readonly declaredTarget: number;
  /** Observed neutral confirmation depth (blocks/slots). */
  readonly observedDepth: number;
  /** Whether the observed depth meets the DECLARED guidance (never finality). */
  readonly depthSufficient: boolean;
  readonly reorgDetected: boolean;
  readonly semanticsRef: string;
}

/**
 * The deterministic reconciliation plan for an OUTCOME_UNKNOWN observation.
 * `blindRetryForbidden` is a LITERAL type: an unknown external write can never
 * be blindly retried (INV-X02) and only settlement reconciliation resolves it
 * (INV-X03). The plan is INSTRUCTIONS, never resolution.
 */
export interface ReconciliationPlan {
  readonly operationKind: "ReconciliationPlan";
  readonly executionRef: string;
  readonly observationId: string;
  readonly reasons: readonly string[];
  readonly externalChecks: readonly {
    readonly check: string;
    readonly providerNames: readonly string[];
  }[];
  readonly blindRetryForbidden: true;
  readonly resolver: "SETTLEMENT_RECONCILIATION_AUTHORITY";
}

// ---------------------------------------------------------------------------
// evidence stage
// ---------------------------------------------------------------------------

/** One append-only evidence log entry (INV-E01). */
export interface AdapterEvidenceEntry {
  readonly at: number;
  readonly stage: AdapterLifecycleStage;
  readonly adapterId: string;
  readonly environmentClass: RailEnvironmentClass;
  readonly refs: readonly string[];
}

// ---------------------------------------------------------------------------
// THE frozen family-adapter contract
// ---------------------------------------------------------------------------

/**
 * A chain-family adapter. Every family implements this interface explicitly;
 * `lifecycle` declares per-stage support and UNSUPPORTED stages fail closed
 * (UnsupportedLifecycleStageError) — never silently skipped, never approximated.
 */
export interface ChainFamilyAdapter<
  Env extends RailEnvironmentClass = RailEnvironmentClass,
  FamilyPlan = unknown,
> {
  readonly adapterId: string;
  readonly family: ChainFamily;
  readonly chainKey: string;
  readonly environment: RailEnvironment<Env>;
  /** Explicit per-stage support — the lifecycle is declared, never assumed. */
  readonly lifecycle: AdapterStageSupport;
  /** Explicit family fee/finality/reorg semantics (guidance only). */
  readonly semantics: FamilySemanticsProfile;

  // -- observe ---------------------------------------------------------------
  observeChainHead(input: {
    readonly at: string;
    readonly maxAgeSeconds?: number;
  }): Promise<ChainHeadProbe>;

  observeAssetPosition(input: {
    readonly accountRef: string;
    readonly assetId: string;
    readonly at: string;
    readonly maxAgeSeconds?: number;
  }): Promise<AssetPositionProbe>;

  // -- prepare ---------------------------------------------------------------
  prepare(input: PrepareStageInput): Promise<PreparedAdapterOperation<FamilyPlan>>;

  // -- simulate --------------------------------------------------------------
  simulate(input: {
    readonly prepared: PreparedAdapterOperation;
    readonly at: number;
  }): Promise<SimulationObservation>;

  // -- authorize (feeds the onchain-security kernel) ------------------------
  authorize(input: AuthorizeStageInput): AuthorizedExecutionFeed;

  // -- broadcast -------------------------------------------------------------
  broadcast(input: BroadcastStageInput): Promise<BroadcastStageOutcome>;

  // -- observe (result) ------------------------------------------------------
  observeOperation(input: ObserveResultInput): Promise<OnchainExecutionObservation>;

  // -- finality --------------------------------------------------------------
  evaluateFinality(input: {
    readonly observation: OnchainExecutionObservation;
    readonly head: ChainHeadObservation;
  }): FinalityEvaluation;

  // -- reconcile -------------------------------------------------------------
  reconciliationPlan(input: {
    readonly observation: OnchainExecutionObservation;
  }): ReconciliationPlan;

  // -- evidence --------------------------------------------------------------
  evidence(executionRef?: string): readonly AdapterEvidenceEntry[];
}

/** Deterministic probe: does the adapter implement every lifecycle stage? */
export function lifecycleStageDeclared(
  adapter: Pick<ChainFamilyAdapter, "lifecycle">,
  stage: AdapterLifecycleStage,
): boolean {
  return adapter.lifecycle[stage] === true;
}
