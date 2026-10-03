/**
 * @payswap/onchain-adapters — shared lifecycle machinery (P4-W2-001).
 *
 * `BaseChainFamilyAdapter` implements every FAMILY-NEUTRAL part of the frozen
 * adapter lifecycle contract (./contract.ts) once:
 * - structural construction law (environment from chain identity, semantics
 *   validation, lifecycle declaration completeness);
 * - the append-only per-operation evidence log (INV-E01/E02);
 * - observation factories that route EVERY adapter-produced execution
 *   observation through the onchain-domain validator (outcome couplings:
 *   BROADCAST never carries finality, UNKNOWN never carries failure — the
 *   domain validator rejects them, so adapters structurally cannot violate
 *   them);
 * - the neutral directive → kernel OnchainWriteRequest translation;
 * - the GENERIC authorize stage: it drives the real onchain-security kernel
 *   (gates → diff → authorization request → trusted-surface artifact →
 *   pre-broadcast recheck → signing-request handoff) — the ADAPTER never
 *   authorizes, the kernel owns authority (AGENTS.md rule 26);
 * - the GENERIC reconcile stage: deterministic reconciliation plans for
 *   OUTCOME_UNKNOWN observations (INV-X02/X03);
 * - freshness/staleness guards (observe-stale → invalidation).
 *
 * Families implement the family-specific stages (transport observations,
 * prepare family plans, simulation, broadcast submission, result observation
 * with reorg/fork detection, confirmation-depth computation, the
 * SignerAdapter port, asset/protocol identity resolution).
 */

import { ValidationError } from "@payswap/protocol";
import {
  assertOnchainExecutionScope,
  validateOnchainExecutionDirective,
  validateOnchainExecutionObservation,
} from "@payswap/onchain-domain";
import type {
  OnchainExecutionDirective,
  OnchainExecutionObservation,
  OnchainExecutionOutcome,
} from "@payswap/onchain-domain";
import { OnchainWritePipeline, prepareWrite } from "@payswap/onchain-security";
import { assertNoSecretMaterial } from "@payswap/onchain-security";
import { contentDigest } from "@payswap/onchain-security";
import type {
  OnchainWriteRequest,
  RecheckObservation,
  SignerAdapter,
  SigningRequest,
} from "@payswap/onchain-security";
import type { Principal } from "@payswap/trust";
import { railEnvironment } from "./environment.js";
import type { RailEnvironment, RailEnvironmentClass } from "./environment.js";
import type {
  AssetPositionProbe,
  BroadcastStageInput,
  BroadcastStageOutcome,
  ChainFamilyAdapter,
  ChainHeadProbe,
  ChainHeadObservation,
  FinalityEvaluation,
  ObserveResultInput,
  PrepareStageInput,
  PreparedAdapterOperation,
  ReconciliationPlan,
  AuthorizedExecutionFeed,
  AuthorizeStageInput,
  AdapterEvidenceEntry,
  AdapterLifecycleStage,
  AdapterStageSupport,
} from "./contract.js";
import { ADAPTER_LIFECYCLE_STAGES } from "./contract.js";
import type { SimulationObservation } from "@payswap/onchain-security";
import { StaleObservationError } from "./errors.js";
import { validateFamilySemanticsProfile } from "./semantics.js";
import type { FamilySemanticsProfile } from "./semantics.js";
import type { ServedBy } from "./transport.js";

/** The neutral asset identity a family resolves for a directive asset. */
export interface ResolvedAssetIdentity {
  /** 3-letter protocol currency symbol (AmountSpec law). */
  readonly symbol: string;
  /** The family-native asset reference (opaque to the core). */
  readonly nativeAssetRef: string;
}

// ---------------------------------------------------------------------------
// Base construction law
// ---------------------------------------------------------------------------

/**
 * Shared adapter construction law: family/semantics/lifecycle consistency and
 * STRUCTURAL environment derivation (chain identity classifies — a runtime
 * flag can never claim a different class).
 */
export interface BaseAdapterDeclaration {
  readonly adapterId: string;
  readonly chainKey: string;
  readonly family: "EVM" | "SOLANA" | "UTXO";
  readonly semantics: FamilySemanticsProfile;
  readonly lifecycle: AdapterStageSupport;
}

/** Validates that every lifecycle stage is explicitly declared true/false. */
export function validateLifecycleDeclaration(lifecycle: unknown): AdapterStageSupport {
  if (lifecycle === null || typeof lifecycle !== "object") {
    throw new ValidationError("adapter lifecycle declaration must be an object");
  }
  const record = lifecycle as Readonly<Record<string, unknown>>;
  const missing = ADAPTER_LIFECYCLE_STAGES.filter(
    (stage) => typeof record[stage] !== "boolean",
  );
  if (missing.length > 0) {
    throw new ValidationError(
      `adapter lifecycle declaration must be EXPLICIT for every stage — missing/untyped: [${missing.join(", ")}] (an undeclared stage is never guessed)`,
    );
  }
  return record as AdapterStageSupport;
}

// ---------------------------------------------------------------------------
// Staleness guards (observe-stale → invalidation)
// ---------------------------------------------------------------------------

/**
 * A chain head is fresh for acting when `at` is within its declared maximum
 * age. A stale (or regressed) head invalidates preparation/broadcast — the
 * operation is re-observed, never executed on stale state.
 */
export function assertHeadFresh(head: ChainHeadObservation, atMs: number): void {
  const observedAtMs = Date.parse(head.observedAt);
  if (!Number.isFinite(observedAtMs)) {
    throw new StaleObservationError(
      `chain-head observation '${head.headHash}' carries an unparseable observedAt '${head.observedAt}' — treated as stale (fail closed)`,
    );
  }
  const ageSeconds = (atMs - observedAtMs) / 1000;
  if (ageSeconds < -1) {
    throw new StaleObservationError(
      `chain-head observation '${head.headHash}' is dated in the future relative to the acting instant — treated as stale (fail closed)`,
    );
  }
  if (ageSeconds > head.maxAgeSeconds) {
    throw new StaleObservationError(
      `chain-head observation '${head.headHash}' is ${Math.floor(ageSeconds)}s old (max ${head.maxAgeSeconds}s) — stale observations invalidate preparation; re-observe, never execute on stale state`,
    );
  }
}

/** Deterministic freshness probe for any observation with `asOf` + maxAge. */
export function isObservationFresh(
  observation: { readonly asOf: string; readonly maxAgeSeconds: number },
  atMs: number,
): boolean {
  const asOfMs = Date.parse(observation.asOf);
  if (!Number.isFinite(asOfMs)) {
    return false;
  }
  return atMs - asOfMs <= observation.maxAgeSeconds * 1000;
}

// ---------------------------------------------------------------------------
// The base adapter
// ---------------------------------------------------------------------------

/**
 * The family-neutral lifecycle machinery. Every concrete family adapter
 * extends this class; the family implements the abstract stages.
 */
export abstract class BaseChainFamilyAdapter<
  Env extends RailEnvironmentClass = RailEnvironmentClass,
  FamilyPlan = unknown,
> implements ChainFamilyAdapter<Env, FamilyPlan> {
  readonly adapterId: string;
  readonly family: "EVM" | "SOLANA" | "UTXO";
  readonly chainKey: string;
  readonly environment: RailEnvironment<Env>;
  readonly lifecycle: AdapterStageSupport;

  #semantics: FamilySemanticsProfile;

  /** The CURRENT semantics profile (fee parameters refresh with observations). */
  get semantics(): FamilySemanticsProfile {
    return this.#semantics;
  }

  /** Append-only evidence log keyed by execution reference (INV-E01). */
  readonly #evidence = new Map<string, AdapterEvidenceEntry[]>();
  /** Remembered per-operation confirmation anchors (reorg/fork detection). */
  readonly #confirmationAnchors = new Map<
    string,
    { readonly height: number; readonly headHash: string }
  >();
  #evidenceSeq = 0;

  protected constructor(declaration: BaseAdapterDeclaration) {
    this.adapterId = declaration.adapterId;
    this.chainKey = declaration.chainKey;
    this.family = declaration.family;
    this.lifecycle = validateLifecycleDeclaration(declaration.lifecycle);
    this.#semantics = validateFamilySemanticsProfile(declaration.semantics);
    if (this.#semantics.family !== declaration.family) {
      throw new ValidationError(
        `adapter '${declaration.adapterId}' declares family '${declaration.family}' but its semantics profile carries family '${this.#semantics.family}' — family/semantics mismatch fails closed`,
      );
    }
    // STRUCTURAL environment: derived from chain identity, never declared.
    this.environment = railEnvironment<Env>(declaration.chainKey);
  }

  /**
   * Refreshes the CURRENT semantics profile (validated, frozen). Fee
   * parameters are OBSERVED state (e.g. EVM baseFee, UTXO fee estimates);
   * the declared MODELS and finality semantics stay fixed at construction.
   */
  protected refreshSemantics(profile: FamilySemanticsProfile): void {
    this.#semantics = validateFamilySemanticsProfile(profile);
  }

  // ------------------------------------------------------------------
  // evidence stage (shared)
  // ------------------------------------------------------------------

  evidence(executionRef?: string): readonly AdapterEvidenceEntry[] {
    if (executionRef !== undefined) {
      return Object.freeze([...(this.#evidence.get(executionRef) ?? [])]);
    }
    const all: AdapterEvidenceEntry[] = [];
    for (const entries of this.#evidence.values()) {
      all.push(...entries);
    }
    return Object.freeze(all);
  }

  /** Mints a deterministic evidence reference and appends a log entry. */
  protected logEvidence(
    executionRef: string,
    stage: AdapterLifecycleStage,
    at: number,
    refs: readonly string[],
  ): string {
    this.#evidenceSeq += 1;
    const evidenceRef = `evidence:${this.adapterId}:${this.#evidenceSeq}`;
    const entries = this.#evidence.get(executionRef) ?? [];
    entries.push(
      Object.freeze({
        at,
        stage,
        adapterId: this.adapterId,
        environmentClass: this.environment.environmentClass,
        refs: Object.freeze([evidenceRef, ...refs]),
      }),
    );
    this.#evidence.set(executionRef, entries);
    return evidenceRef;
  }

  /** Records (or re-reads) the confirmation anchor for reorg detection. */
  protected rememberConfirmationAnchor(
    executionRef: string,
    anchor: { readonly height: number; readonly headHash: string },
  ): void {
    this.#confirmationAnchors.set(executionRef, Object.freeze({ ...anchor }));
  }

  /** The remembered confirmation anchor, when one exists (reorg comparison). */
  protected confirmationAnchor(executionRef: string): { readonly height: number; readonly headHash: string } | undefined {
    return this.#confirmationAnchors.get(executionRef);
  }

  // ------------------------------------------------------------------
  // observation factories (shared — everything is domain-validated)
  // ------------------------------------------------------------------

  /** Builds adapter provenance from the serving endpoint + the acting instant. */
  protected buildProvenance(servedBy: ServedBy, atMs: number): {
    readonly transportId: string;
    readonly endpointId: string;
    readonly providerName: string;
    readonly capturedAt: string;
    readonly adapterId: string;
    readonly environmentClass: RailEnvironmentClass;
  } {
    return Object.freeze({
      transportId: servedBy.transportId,
      endpointId: servedBy.endpointId,
      providerName: servedBy.providerName,
      capturedAt: new Date(atMs).toISOString(),
      adapterId: this.adapterId,
      environmentClass: this.environment.environmentClass,
    });
  }

  /**
   * Builds and validates an execution observation. EVERY adapter-produced
   * observation passes the onchain-domain validator, so the outcome couplings
   * are structural: BROADCAST never carries a finality candidate (rule 29),
   * FAILED always explains itself, OUTCOME_UNKNOWN never carries a failure
   * descriptor (INV-X01) and always explains itself.
   *
   * Secret boundary (rule 25): every ADAPTER-AUTHORED field is
   * secret-scanned. The rail-sourced `externalOperationRef` is a PUBLIC
   * derived identifier (transaction hash / signature / txid) whose shape each
   * family validates where it is parsed — the frozen domain field name
   * predates the scanner's key-name whitelist, so the ref is scanned
   * separately as a value (raw key-shaped material is still rejected: the
   * ref must be a non-empty opaque string, never anything else).
   */
  protected buildExecutionObservation(input: {
    readonly executionRef: string;
    readonly observedAt: number;
    readonly outcome: OnchainExecutionOutcome;
    readonly externalOperationRef?: string;
    readonly finalityCandidate?: OnchainExecutionObservation["finalityCandidate"];
    readonly failure?: OnchainExecutionObservation["failure"];
    readonly unknownReason?: string;
    readonly evidenceRefs: readonly string[];
    readonly servedBy: ServedBy;
  }): OnchainExecutionObservation {
    const observation: OnchainExecutionObservation = {
      observationId: `exec-obs:${this.adapterId}:${input.executionRef}:${contentDigest({
        executionRef: input.executionRef,
        observedAt: input.observedAt,
        outcome: input.outcome,
        externalOperationRef: input.externalOperationRef,
        seq: this.#evidenceSeq,
      })}`,
      executionRef: input.executionRef,
      observedAt: new Date(input.observedAt).toISOString(),
      chainKey: this.chainKey,
      outcome: input.outcome,
      ...(input.externalOperationRef !== undefined
        ? { externalOperationRef: input.externalOperationRef }
        : {}),
      ...(input.finalityCandidate !== undefined
        ? { finalityCandidate: input.finalityCandidate }
        : {}),
      ...(input.failure !== undefined ? { failure: input.failure } : {}),
      ...(input.unknownReason !== undefined ? { unknownReason: input.unknownReason } : {}),
      evidenceRefs: Object.freeze([...input.evidenceRefs]),
      provenance: {
        providerName: input.servedBy.providerName,
        source: "PROVIDER_API",
        capturedAt: new Date(input.observedAt).toISOString(),
      },
    };
    // Rule 25: scan every adapter-authored field (observation minus the
    // rail-sourced public operation reference, which is separately validated
    // for shape where each family parses it).
    const { externalOperationRef: _railRef, ...adapterAuthored } = observation;
    assertNoSecretMaterial(adapterAuthored, "adapter execution observation");
    if (observation.externalOperationRef !== undefined) {
      const ref = observation.externalOperationRef;
      if (ref.length === 0 || ref.trim() !== ref || /\s/.test(ref)) {
        throw new ValidationError(
          "externalOperationRef must be a non-empty canonical public identifier (no whitespace) — never anything else",
        );
      }
    }
    return validateOnchainExecutionObservation(observation);
  }

  // ------------------------------------------------------------------
  // neutral directive → kernel write request (shared)
  // ------------------------------------------------------------------

  /** Resolves the neutral asset identity for a directive assetId (family-owned). */
  protected abstract resolveAssetIdentity(assetId: string): ResolvedAssetIdentity;

  /** The family's SignerAdapter for the kernel handoff (family-owned). */
  protected abstract signerAdapter(): SignerAdapter;

  /**
   * Builds the kernel-ready OnchainWriteRequest from the neutral directive.
   * Deterministic and fail-closed: operation support is family-declared
   * (unsupported operations throw — never approximated), asset identity is
   * resolved (never guessed), amounts stay exact, and the route hash is the
   * content digest of the validated directive.
   */
  protected buildWriteRequest(input: {
    readonly directive: OnchainExecutionDirective;
    readonly signerAccountRef: string;
    readonly at: number;
    readonly requestedBy: string;
    readonly settlementInstruction?: PrepareStageInput["settlementInstruction"];
    readonly familyNonce?: string;
  }): OnchainWriteRequest {
    const directive = validateOnchainExecutionDirective(input.directive);
    this.assertOperationSupported(directive.operation);
    if (directive.family !== this.family) {
      throw new ValidationError(
        `directive family '${directive.family}' does not match adapter family '${this.family}' for chain '${this.chainKey}' — family dispatch fails closed`,
      );
    }
    if (directive.chainKey !== this.chainKey) {
      throw new ValidationError(
        `directive chainKey '${directive.chainKey}' does not match adapter chainKey '${this.chainKey}' — chain confusion fails closed`,
      );
    }
    const expiresAtMs = Date.parse(directive.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= input.at) {
      throw new ValidationError(
        `directive expiresAt '${directive.expiresAt}' must be a future instant at prepare time — an expired write is never prepared`,
      );
    }
    const resolvedAsset =
      directive.assetId !== undefined ? this.resolveAssetIdentity(directive.assetId) : undefined;

    const writeId = `write:${contentDigest({ directive, at: input.at, adapter: this.adapterId })}`;
    const routeHash = `route:${contentDigest(directive)}`;
    const contractCall = this.buildContractCallLeg(directive);
    const writeRequest: OnchainWriteRequest = {
      writeId,
      action: directive.operation,
      chain: this.chainKey,
      ...(directive.operation === "onchain.transfer"
        ? {
            transfer: {
              asset: { chain: this.chainKey, assetId: directive.assetId as string, symbol: resolvedAsset?.symbol as string },
              amount: {
                currency: resolvedAsset?.symbol as string,
                minorUnits: directive.amount?.minorUnits as string,
              },
              from: input.signerAccountRef,
              to: directive.destination as string,
            },
          }
        : {}),
      approvals:
        directive.operation === "onchain.approval"
          ? [
              {
                asset: { chain: this.chainKey, assetId: directive.assetId as string, symbol: resolvedAsset?.symbol as string },
                owner: input.signerAccountRef,
                spender: directive.spenderRef as string,
                amount: {
                  currency: resolvedAsset?.symbol as string,
                  minorUnits: directive.amount?.minorUnits as string,
                },
                unlimited: false,
              },
            ]
          : [],
      ...(contractCall !== undefined ? { contractCall } : {}),
      route: {
        routeId: directive.routeRef ?? routeHash,
        routeHash,
      },
      expiry: expiresAtMs,
      ...(input.familyNonce !== undefined ? { nonce: input.familyNonce } : {}),
      ...(input.settlementInstruction !== undefined
        ? { settlementInstruction: input.settlementInstruction }
        : {}),
      requestedBy: input.requestedBy,
    };
    assertNoSecretMaterial(writeRequest, "prepared adapter write request");
    return writeRequest;
  }

  /** Family-declared operation support (explicit; unsupported fails closed). */
  protected abstract assertOperationSupported(operation: OnchainExecutionDirective["operation"]): void;

  /** Optional family contract-call leg from the directive's family payload. */
  protected buildContractCallLeg(
    directive: OnchainExecutionDirective,
  ): OnchainWriteRequest["contractCall"] | undefined {
    const payload = directive.familyPayload as
      | { readonly calldata?: unknown; readonly calldataDigest?: unknown; readonly target?: unknown; readonly value?: unknown }
      | undefined;
    if (directive.operation !== "onchain.contract_call" || payload === undefined) {
      return undefined;
    }
    if (
      typeof payload.calldata !== "string" ||
      typeof payload.calldataDigest !== "string" ||
      typeof payload.target !== "string" ||
      payload.calldata.length === 0 ||
      payload.calldataDigest.length === 0 ||
      payload.target.length === 0
    ) {
      throw new ValidationError(
        "a contract_call directive requires a familyPayload { target, calldata, calldataDigest } — unknown contract writes never execute silently (rule 28)",
      );
    }
    return {
      target: payload.target,
      calldata: payload.calldata,
      calldataDigest: payload.calldataDigest,
      ...(typeof payload.value === "object" && payload.value !== null
        ? { value: payload.value as { currency: string; minorUnits: string } }
        : {}),
    };
  }

  // ------------------------------------------------------------------
  // prepare-stage shared entry (families compose it with their plan)
  // ------------------------------------------------------------------

  /**
   * Shared prepare prologue: directive validation, execution-scope assertion
   * (catalogue never authorizes — INV-C05), head freshness, and the kernel
   * write request. Families append their family plan.
   */
  protected preparePrologue(input: PrepareStageInput): {
    readonly directive: OnchainExecutionDirective;
    readonly writeRequest: OnchainWriteRequest;
    readonly writeDigest: string;
    readonly evidenceRefs: readonly string[];
  } {
    const directive = validateOnchainExecutionDirective(input.directive);
    // Execution scope: a genuinely connected chain instance (INV-C05).
    assertOnchainExecutionScope(input.instance);
    if (input.instance.chainKey !== this.chainKey || input.instance.family !== this.family) {
      throw new ValidationError(
        `connected instance is scoped to chain '${input.instance.chainKey}' (family '${input.instance.family}') — the adapter operates '${this.chainKey}' (${this.family}) — scope mismatch fails closed`,
      );
    }
    assertHeadFresh(input.head, input.at);
    const writeRequest = this.buildWriteRequest({
      directive,
      signerAccountRef: input.signerAccountRef,
      at: input.at,
      requestedBy: input.requestedBy,
      ...(input.settlementInstruction !== undefined
        ? { settlementInstruction: input.settlementInstruction }
        : {}),
    });
    // The kernel's own prepare: validates, secret-scans, freezes and
    // content-addresses the write — the SAME digest the authorize-stage
    // pipeline will compute (fail early, fail closed).
    const preparedWrite = prepareWrite(writeRequest, input.at);
    const evidenceRef = this.logEvidence(
      directive.assetId ?? directive.protocolRef ?? "operation",
      "prepare",
      input.at,
      [writeRequest.writeId, preparedWrite.writeDigest],
    );
    return {
      directive,
      writeRequest,
      writeDigest: preparedWrite.writeDigest,
      evidenceRefs: Object.freeze([evidenceRef, writeRequest.writeId]),
    };
  }

  /** Freezes a prepared adapter operation (secret-scanned). */
  protected freezePrepared(
    operation: PreparedAdapterOperation<FamilyPlan>,
  ): PreparedAdapterOperation<FamilyPlan> {
    assertNoSecretMaterial(operation, "prepared adapter operation");
    return Object.freeze(operation);
  }

  // ------------------------------------------------------------------
  // authorize stage (shared — drives the REAL security kernel)
  // ------------------------------------------------------------------

  authorize(input: AuthorizeStageInput): AuthorizedExecutionFeed {
    const pipeline = new OnchainWritePipeline({
      request: input.prepared.writeRequest,
      policy: input.policy,
      trustedSurfaces: [input.surface],
      at: input.at,
    });
    const decision = pipeline.runGates(input.securityState, input.at);
    if (decision.decision !== "ALLOW") {
      // Fail closed: no handoff without a deterministic ALLOW. BLOCK is
      // terminal in the kernel; UNKNOWN requires fresh evidence.
      const why =
        decision.decision === "BLOCK"
          ? decision.reasons.map((reason) => `${reason.dimension}:${reason.code}`).join("; ")
          : decision.dimensions.map((dimension) => `${dimension.dimension}:${dimension.code}`).join("; ");
      throw new ValidationError(
        `authorize stage failed closed: deterministic gates returned '${decision.decision}' (${why}) — no signing handoff is possible (rule 27: a BLOCK can never be overridden)`,
        { decision: decision.decision },
      );
    }
    pipeline.buildExpectedDiff(input.at);
    const request = pipeline.buildAuthorizationRequest({
      requestId: input.requestId,
      principal: input.principal,
      requestedAt: input.at,
    });
    const artifact = pipeline.authorize({
      surface: input.surface,
      approverRef: input.approverRef,
      securityState: input.securityState,
      expiresAt: input.expiresAt,
      at: input.at + 1,
      ...(input.prepared.writeRequest.requestedBy !== undefined
        ? { agentRef: input.prepared.writeRequest.requestedBy }
        : {}),
    });
    const recheckAt = input.recheckAt ?? input.at + 2;
    const recheckObservation = this.buildRecheckObservation(
      input.prepared.writeRequest,
      input.prepared.writeDigest,
      input.recheckSecurityState ?? input.securityState,
      recheckAt,
    );
    const recheck = pipeline.recheck(recheckObservation, recheckAt);
    if (recheck.outcome !== "RECHECK_OK") {
      throw new StaleObservationError(
        `authorize stage failed closed: the pre-broadcast recheck VOIDED the authorization (${recheck.detail}) — the authorization must be re-requested, never auto-repaired`,
      );
    }
    const signingRequest = pipeline.handoffForBroadcast({
      requestId: input.signingRequestId,
      adapter: this.signerAdapter(),
      at: recheckAt + 1,
    });
    const feed: AuthorizedExecutionFeed = Object.freeze({
      stageOutcome: "KERNEL_BROADCAST_HANDOFF",
      pipelineState: "BROADCAST_HANDOFF",
      signingRequest,
      authorizationRef: signingRequest.authorizationRef,
      recheckRef: signingRequest.recheckRef,
      artifact,
      evidenceRefs: Object.freeze([
        ...input.prepared.evidenceRefs,
        ...recheck.evidenceRefs,
        signingRequest.requestId,
      ]),
    });
    assertNoSecretMaterial(feed, "authorized execution feed");
    this.logEvidence(
      feed.signingRequest.writeDigest,
      "authorize",
      input.at,
      [feed.authorizationRef, feed.recheckRef, feed.signingRequest.requestId],
    );
    return feed;
  }

  /** Builds the recheck observation from the prepared write (deterministic). */
  protected buildRecheckObservation(
    writeRequest: OnchainWriteRequest,
    writeDigest: string,
    securityState: AuthorizeStageInput["securityState"],
    observedAt: number,
  ): RecheckObservation {
    const observation: RecheckObservation = {
      writeId: writeRequest.writeId,
      observedAt,
      chain: writeRequest.chain,
      writeDigest,
      ...(writeRequest.transfer !== undefined
        ? {
            transfer: {
              asset: writeRequest.transfer.asset,
              amount: writeRequest.transfer.amount,
              to: writeRequest.transfer.to,
            },
          }
        : {}),
      approvals: writeRequest.approvals,
      routeHash: writeRequest.route.routeHash,
      ...(writeRequest.nonce !== undefined ? { nonce: writeRequest.nonce } : {}),
      ...(writeRequest.protocol !== undefined ? { protocol: writeRequest.protocol } : {}),
      ...(writeRequest.settlementInstruction !== undefined
        ? { settlementInstruction: writeRequest.settlementInstruction }
        : {}),
      securityState,
    };
    return observation;
  }

  // ------------------------------------------------------------------
  // finality stage (shared computation, family depth)
  // ------------------------------------------------------------------

  /**
   * Family-declared confirmation target from the semantics profile
   * (EVM/UTXO: confirmationDepthTarget; SOLANA: slotConfirmationTarget).
   */
  protected declaredConfirmationTarget(): number {
    const finality = this.semantics.finality;
    switch (finality.family) {
      case "EVM":
      case "UTXO":
        return finality.confirmationDepthTarget;
      case "SOLANA":
        return finality.slotConfirmationTarget;
    }
  }

  /** Family-specific observed confirmation depth for a CONFIRMED observation. */
  protected abstract confirmationDepth(
    observation: OnchainExecutionObservation,
    head: ChainHeadObservation,
  ): number;

  evaluateFinality(input: {
    readonly observation: OnchainExecutionObservation;
    readonly head: ChainHeadObservation;
  }): FinalityEvaluation {
    const observation = validateOnchainExecutionObservation(input.observation);
    if (observation.outcome !== "CONFIRMED" || observation.finalityCandidate === undefined) {
      throw new ValidationError(
        `finality evaluation requires a CONFIRMED observation carrying a finality candidate — outcome '${observation.outcome}' fails closed (finality is never approximated)`,
      );
    }
    if (observation.chainKey !== this.chainKey || input.head.chainKey !== this.chainKey) {
      throw new ValidationError(
        "finality evaluation requires the observation and head to be scoped to the adapter's chain — chain confusion fails closed",
      );
    }
    const declaredTarget = this.declaredConfirmationTarget();
    const observedDepth = this.confirmationDepth(observation, input.head);
    const reorgDetected = observation.finalityCandidate.reorgDetected === true;
    const evaluation: FinalityEvaluation = Object.freeze({
      operationKind: "FinalityEvaluation",
      candidate: Object.freeze({ ...observation.finalityCandidate }),
      declaredTarget,
      observedDepth,
      depthSufficient: observedDepth >= declaredTarget,
      reorgDetected,
      semanticsRef: `${this.adapterId}:semantics@${this.family}`,
    });
    return evaluation;
  }

  // ------------------------------------------------------------------
  // reconcile stage (shared — deterministic, never resolution)
  // ------------------------------------------------------------------

  reconciliationPlan(input: {
    readonly observation: OnchainExecutionObservation;
  }): ReconciliationPlan {
    const observation = validateOnchainExecutionObservation(input.observation);
    if (observation.outcome !== "OUTCOME_UNKNOWN") {
      throw new ValidationError(
        `a reconciliation plan is only constructed for OUTCOME_UNKNOWN observations (INV-X02/X03) — outcome '${observation.outcome}' is not ambiguity`,
      );
    }
    const providers = this.transportProviderNames();
    const plan: ReconciliationPlan = Object.freeze({
      operationKind: "ReconciliationPlan",
      executionRef: observation.executionRef,
      observationId: observation.observationId,
      reasons: Object.freeze([
        observation.unknownReason as string,
        `adapter '${this.adapterId}' on chain '${this.chainKey}' could not resolve the external outcome`,
      ]),
      externalChecks: Object.freeze([
        {
          check: `Re-observe the external operation ref '${observation.externalOperationRef ?? "unknown"}' on at least two independent providers`,
          providerNames: Object.freeze(providers),
        },
        {
          check:
            "Compare the observed confirmation anchor (block/slot hash + height) against the chain at that height on an independent provider",
          providerNames: Object.freeze(providers),
        },
      ]),
      blindRetryForbidden: true,
      resolver: "SETTLEMENT_RECONCILIATION_AUTHORITY",
    });
    this.logEvidence(observation.executionRef, "reconcile", Date.parse(observation.observedAt), [
      observation.observationId,
    ]);
    return plan;
  }

  /** The distinct provider names this adapter can cross-check against. */
  protected abstract transportProviderNames(): readonly string[];

  // ------------------------------------------------------------------
  // family-implemented lifecycle stages (declared abstract — the contract
  // requires every family to implement them explicitly)
  // ------------------------------------------------------------------

  abstract observeChainHead(input: {
    readonly at: string;
    readonly maxAgeSeconds?: number;
  }): Promise<ChainHeadProbe>;

  abstract observeAssetPosition(input: {
    readonly accountRef: string;
    readonly assetId: string;
    readonly at: string;
    readonly maxAgeSeconds?: number;
  }): Promise<AssetPositionProbe>;

  abstract prepare(input: PrepareStageInput): Promise<PreparedAdapterOperation<FamilyPlan>>;

  abstract simulate(input: {
    readonly prepared: PreparedAdapterOperation<FamilyPlan>;
    readonly at: number;
  }): Promise<SimulationObservation>;

  abstract broadcast(input: BroadcastStageInput): Promise<BroadcastStageOutcome>;

  abstract observeOperation(input: ObserveResultInput): Promise<OnchainExecutionObservation>;

  // ------------------------------------------------------------------
  // shared broadcast-stage guards
  // ------------------------------------------------------------------
  /**
   * Broadcast-stage shared guards: the handoff must be a kernel-minted
   * signing request for THIS chain, the deadline must not have passed, and
   * the payload must be non-empty. An expired authorization can never
   * broadcast.
   */
  protected assertBroadcastable(input: {
    readonly handoff: SigningRequest;
    readonly signedPayload: string;
    readonly at: number;
  }): void {
    if (input.handoff.chain !== this.chainKey) {
      throw new ValidationError(
        `signing request is for chain '${input.handoff.chain}' — the adapter broadcasts on '${this.chainKey}' — chain confusion fails closed`,
      );
    }
    if (input.handoff.deadline <= input.at) {
      throw new ValidationError(
        `signing request deadline ${input.handoff.deadline} has passed at ${input.at} — an expired authorization can never broadcast`,
      );
    }
    if (typeof input.signedPayload !== "string" || input.signedPayload.length === 0) {
      throw new ValidationError(
        "broadcast requires the trusted-surface-SIGNED payload — an empty payload is never submitted",
      );
    }
  }
}
