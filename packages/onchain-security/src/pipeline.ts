/**
 * @payswap/onchain-security — the consequential-write pipeline (Work Order
 * P4-W1-002; AGENTS.md rules 26-29; UMI architecture "Wallet/signing").
 *
 * A DETERMINISTIC STATE MACHINE, not an agent judgment:
 *
 *   PREPARED → (simulate when supported) → GATED (deterministic policy/
 *   security) → DIFF_READY (readable expected-state diff) → AUTHORIZED
 *   (trusted-surface artifact only) → RECHECKED (immediate pre-broadcast
 *   recheck; drift VOIDS) → BROADCAST_HANDOFF (signing request handed to
 *   the signer adapter — the kernel never broadcasts).
 *
 * Terminal states: BLOCKED (deterministic BLOCK — no exit, no override),
 * VOIDED (stale-state invalidation — re-request, never repair) and
 * BROADCAST_HANDOFF (kernel responsibility ends at the handoff; rule 29:
 * submitted transactions are not financial finality).
 *
 * The machine is built on the protocol kernel's `defineStateMachine`
 * (terminal-state discipline, INV-X04); every transition is guarded and
 * every state change appends to an immutable evidence log (INV-E01).
 * Deterministic only: callers pass `at` for every stage.
 */

import {
  IllegalTransitionError,
  defineStateMachine,
} from "@payswap/protocol";
import type { StateMachine } from "@payswap/protocol";
import { assertNoSecretMaterial } from "./secrets.js";
import { contentDigest } from "./digest.js";
import type { ExpectedStateDiff } from "./diff.js";
import { buildExpectedStateDiff } from "./diff.js";
import type {
  AgentSecurityFlag,
  GateDecision,
  GatedEvaluation,
  OnchainSecurityPolicy,
  OnchainSecurityState,
} from "./gates.js";
import { attachAgentFlag, evaluateOnchainWriteGates } from "./gates.js";
import type { SimulationObservation } from "./simulation.js";
import { recordSimulation } from "./simulation.js";
import type { OnchainWriteRequest, PreparedWrite } from "./write-intent.js";
import { prepareWrite } from "./write-intent.js";
import type {
  OnchainAuthorizationArtifact,
  OnchainAuthorizationRequest,
  TrustedApprovalSurface,
} from "./authorization.js";
import { buildAuthorizationRequest, verifyOnchainAuthorization } from "./authorization.js";
import type { RecheckObservation, RecheckOutcome } from "./recheck.js";
import { performPreBroadcastRecheck } from "./recheck.js";
import type { SigningDelegationRegistry } from "./delegation.js";
import type { SignerAdapter, SigningRequest } from "./signers.js";
import { buildSigningRequest } from "./signers.js";

/** Pipeline lifecycle states. BLOCKED / VOIDED / BROADCAST_HANDOFF are terminal. */
export type OnchainWritePipelineState =
  | "PREPARED"
  | "SIMULATED"
  | "GATED_ALLOW"
  | "GATED_UNKNOWN"
  | "DIFF_READY"
  | "AUTHORIZED"
  | "RECHECKED"
  | "BROADCAST_HANDOFF"
  | "BLOCKED"
  | "VOIDED";

/** Raised on any illegal pipeline operation (fail closed). */
export class PipelineStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineStateError";
  }
}

/** One append-only evidence log entry (INV-E01). */
export interface PipelineEvidenceEntry {
  readonly at: number;
  readonly state: OnchainWritePipelineState;
  readonly event: string;
  readonly refs: readonly string[];
}

interface PipelineContext {
  readonly pipeline: OnchainWritePipeline;
}

const PIPELINE_MACHINE: StateMachine<OnchainWritePipelineState, string, PipelineContext> =
  defineStateMachine<OnchainWritePipelineState, string, PipelineContext>({
    name: "onchain-write-pipeline",
    initial: "PREPARED",
    states: [
      "PREPARED",
      "SIMULATED",
      "GATED_ALLOW",
      "GATED_UNKNOWN",
      "DIFF_READY",
      "AUTHORIZED",
      "RECHECKED",
      "BROADCAST_HANDOFF",
      "BLOCKED",
      "VOIDED",
    ],
    events: [
      "SIMULATE",
      "GATES_ALLOW",
      "GATES_BLOCK",
      "GATES_UNKNOWN",
      "BUILD_DIFF",
      "AUTHORIZE",
      "RECHECK_OK",
      "RECHECK_DRIFT",
      "HANDOFF",
    ],
    transitions: [
      { from: "PREPARED", on: "SIMULATE", to: "SIMULATED", description: "simulation observation recorded" },
      { from: "PREPARED", on: "GATES_BLOCK", to: "BLOCKED", description: "deterministic BLOCK (terminal)" },
      { from: "PREPARED", on: "GATES_UNKNOWN", to: "GATED_UNKNOWN", description: "unresolvable dimension" },
      { from: "PREPARED", on: "GATES_ALLOW", to: "GATED_ALLOW", description: "all dimensions pass" },
      { from: "SIMULATED", on: "GATES_BLOCK", to: "BLOCKED", description: "deterministic BLOCK (terminal)" },
      { from: "SIMULATED", on: "GATES_UNKNOWN", to: "GATED_UNKNOWN", description: "unresolvable dimension" },
      { from: "SIMULATED", on: "GATES_ALLOW", to: "GATED_ALLOW", description: "all dimensions pass" },
      { from: "GATED_ALLOW", on: "GATES_BLOCK", to: "BLOCKED", description: "re-evaluation BLOCKed (fresh state)" },
      { from: "GATED_ALLOW", on: "GATES_UNKNOWN", to: "GATED_UNKNOWN", description: "re-evaluation unknown" },
      { from: "GATED_ALLOW", on: "GATES_ALLOW", to: "GATED_ALLOW", description: "re-evaluation still allows" },
      { from: "GATED_UNKNOWN", on: "GATES_BLOCK", to: "BLOCKED", description: "new evidence BLOCKed" },
      { from: "GATED_UNKNOWN", on: "GATES_UNKNOWN", to: "GATED_UNKNOWN", description: "still unresolvable" },
      { from: "GATED_UNKNOWN", on: "GATES_ALLOW", to: "GATED_ALLOW", description: "resolved by new evidence" },
      { from: "GATED_ALLOW", on: "BUILD_DIFF", to: "DIFF_READY", description: "readable expected-state diff built" },
      { from: "DIFF_READY", on: "AUTHORIZE", to: "AUTHORIZED", description: "trusted-surface artifact minted + verified" },
      { from: "AUTHORIZED", on: "RECHECK_OK", to: "RECHECKED", description: "pre-broadcast recheck passed" },
      { from: "AUTHORIZED", on: "RECHECK_DRIFT", to: "VOIDED", description: "stale-state invalidation (terminal)" },
      { from: "RECHECKED", on: "HANDOFF", to: "BROADCAST_HANDOFF", description: "signing request handed to the adapter" },
    ],
    terminalStates: ["BLOCKED", "VOIDED", "BROADCAST_HANDOFF"],
  });

/**
 * The deterministic pipeline for one consequential onchain write. All
 * stage methods fail closed on state or validation errors and append
 * evidence. The instance is single-use per write; a VOIDED or BLOCKED
 * pipeline can never be revived (INV-X04 terminal discipline).
 */
export class OnchainWritePipeline {
  readonly #prepared: PreparedWrite;
  readonly #policy: OnchainSecurityPolicy;
  readonly #trustedSurfaces: readonly TrustedApprovalSurface[];
  readonly #delegationRegistry?: SigningDelegationRegistry;
  #state: OnchainWritePipelineState = "PREPARED";
  #simulation?: SimulationObservation;
  #gated?: GatedEvaluation;
  #diff?: ExpectedStateDiff;
  #authorizationRequest?: OnchainAuthorizationRequest;
  #artifact?: OnchainAuthorizationArtifact;
  #recheck?: RecheckOutcome;
  #signingRequest?: SigningRequest;
  readonly #evidence: PipelineEvidenceEntry[] = [];

  constructor(input: {
    readonly request: OnchainWriteRequest;
    readonly policy: OnchainSecurityPolicy;
    readonly trustedSurfaces?: readonly TrustedApprovalSurface[];
    readonly delegationRegistry?: SigningDelegationRegistry;
    readonly at: number;
  }) {
    assertNoSecretMaterial(input, "pipeline construction input");
    this.#prepared = prepareWrite(input.request, input.at);
    this.#policy = input.policy;
    this.#trustedSurfaces = input.trustedSurfaces ?? [];
    if (input.delegationRegistry !== undefined) {
      this.#delegationRegistry = input.delegationRegistry;
    }
    this.#log(input.at, "PREPARED", "PREPARE", [
      `write:${this.#prepared.writeDigest}`,
      `policy:${input.policy.policyId}@${input.policy.version}`,
    ]);
  }

  get state(): OnchainWritePipelineState {
    return this.#state;
  }

  get prepared(): PreparedWrite {
    return this.#prepared;
  }

  get gateDecision(): GateDecision | undefined {
    return this.#gated?.decision;
  }

  get agentFlags(): readonly AgentSecurityFlag[] {
    return this.#gated?.flags ?? [];
  }

  get authorizationRequest(): OnchainAuthorizationRequest | undefined {
    return this.#authorizationRequest;
  }

  get artifact(): OnchainAuthorizationArtifact | undefined {
    return this.#artifact;
  }

  get recheckOutcome(): RecheckOutcome | undefined {
    return this.#recheck;
  }

  get signingRequest(): SigningRequest | undefined {
    return this.#signingRequest;
  }

  /** Append-only evidence log (INV-E01). */
  evidence(): readonly PipelineEvidenceEntry[] {
    return [...this.#evidence];
  }

  /** simulate — record a simulation observation (an OBSERVATION, never authority). */
  simulate(observation: SimulationObservation, at: number): SimulationObservation {
    this.#requireState("PREPARED", "simulate");
    if (observation.writeId !== this.#prepared.writeId) {
      throw new PipelineStateError(
        `simulation observes write '${observation.writeId}', but this pipeline prepares '${this.#prepared.writeId}'`,
      );
    }
    const recorded = recordSimulation(observation);
    this.#transition("SIMULATE", at);
    this.#simulation = recorded;
    this.#log(at, "SIMULATED", "SIMULATE", [
      `simulation:${recorded.simulationId}`,
      `status:${recorded.status}`,
    ]);
    return recorded;
  }

  /**
   * Deterministic policy/security gates. Callable from PREPARED, SIMULATED,
   * GATED_ALLOW and GATED_UNKNOWN (re-evaluation with fresh security state
   * or a refreshed versioned policy). A BLOCK decision transitions to the
   * BLOCKED terminal state — after that, NOTHING can move the pipeline.
   */
  runGates(securityState: OnchainSecurityState, at: number): GateDecision {
    this.#requireAnyState(["PREPARED", "SIMULATED", "GATED_ALLOW", "GATED_UNKNOWN"], "runGates");
    const decision = evaluateOnchainWriteGates({
      write: this.#prepared,
      ...(this.#simulation !== undefined ? { simulation: this.#simulation } : {}),
      policy: this.#policy,
      securityState,
      at,
    });
    const event =
      decision.decision === "ALLOW" ? "GATES_ALLOW" : decision.decision === "BLOCK" ? "GATES_BLOCK" : "GATES_UNKNOWN";
    this.#transition(event, at);
    const previousFlags = this.#gated?.flags ?? [];
    this.#gated = { decision, flags: previousFlags };
    this.#log(at, this.#state, event, [...decision.evidenceRefs]);
    return decision;
  }

  /** FLAG — attach an adversarial/heuristic agent flag (advisory only; rule 27). */
  attachAgentFlag(flag: AgentSecurityFlag, at: number): void {
    if (this.#gated === undefined) {
      throw new PipelineStateError("flags attach to a gated evaluation: run the gates first");
    }
    this.#gated = attachAgentFlag(this.#gated, flag);
    this.#log(at, this.#state, "FLAG", [`flag:${flag.flagId}`, `by:${flag.flaggedBy}`]);
  }

  /** Build the user-readable expected-state diff (from GATED_ALLOW only). */
  buildExpectedDiff(at: number): ExpectedStateDiff {
    this.#requireState("GATED_ALLOW", "buildExpectedDiff");
    const diff = buildExpectedStateDiff(this.#prepared, this.#simulation);
    this.#transition("BUILD_DIFF", at);
    this.#diff = diff;
    this.#log(at, "DIFF_READY", "BUILD_DIFF", [`diff:${diff.diffDigest}`]);
    return diff;
  }

  /**
   * Build the agent-facing authorization request (the trusted surface shows
   * exactly this: write + diff + gate outcome).
   */
  buildAuthorizationRequest(input: {
    readonly requestId: string;
    readonly principal: Parameters<typeof buildAuthorizationRequest>[0]["principal"];
    readonly requestedAt: number;
  }): OnchainAuthorizationRequest {
    this.#requireState("DIFF_READY", "buildAuthorizationRequest");
    if (this.#diff === undefined) {
      throw new PipelineStateError("unreachable: DIFF_READY without a diff");
    }
    if (this.#gated === undefined) {
      throw new PipelineStateError("unreachable: DIFF_READY without a gate decision");
    }
    const request = buildAuthorizationRequest({
      requestId: input.requestId,
      principal: input.principal,
      write: this.#prepared,
      expectedDiff: this.#diff,
      gateDecision: this.#gated.decision,
      requestedAt: input.requestedAt,
    });
    this.#authorizationRequest = request;
    return request;
  }

  /**
   * authorize — mint (via the trusted surface) and verify the signed
   * authorization artifact. The surface itself re-runs the deterministic
   * gates with the CURRENT policy + security state and refuses BLOCK/
   * UNKNOWN; this method then verifies every binding again against the
   * pipeline's own request and state (defense in depth).
   */
  authorize(input: {
    readonly surface: TrustedApprovalSurface;
    readonly approverRef: string;
    readonly securityState: OnchainSecurityState;
    readonly expiresAt: number;
    readonly at: number;
    readonly agentRef?: string;
    readonly delegationId?: string;
  }): OnchainAuthorizationArtifact {
    this.#requireState("DIFF_READY", "authorize");
    const request = this.#authorizationRequest;
    if (request === undefined) {
      throw new PipelineStateError("buildAuthorizationRequest must run before authorize");
    }
    const artifact = input.surface.approve({
      request,
      policy: this.#policy,
      securityState: input.securityState,
      approverRef: input.approverRef,
      expiresAt: input.expiresAt,
      at: input.at,
      ...(input.agentRef !== undefined ? { agentRef: input.agentRef } : {}),
      ...(input.delegationId !== undefined ? { delegationId: input.delegationId } : {}),
    });
    const verification = verifyOnchainAuthorization(artifact, request, input.at, {
      securityState: input.securityState,
      ...(this.#delegationRegistry !== undefined
        ? { delegationRegistry: this.#delegationRegistry }
        : {}),
      // The surface that just minted this artifact vouches for it by
      // construction; the constructor-registered surfaces vouch for any
      // pre-registered integration surface.
      trustedSurfaces: [...this.#trustedSurfaces, input.surface],
    });
    if (!verification.valid) {
      throw new PipelineStateError(
        `the freshly minted artifact failed verification: ${verification.reason} (${verification.detail})`,
      );
    }
    this.#transition("AUTHORIZE", input.at);
    this.#artifact = artifact;
    this.#log(input.at, "AUTHORIZED", "AUTHORIZE", [...verification.evidenceRefs]);
    return artifact;
  }

  /**
   * Immediate pre-broadcast recheck. ANY drift between the authorized
   * expected state and the fresh observation VOIDS the authorization
   * (terminal VOIDED; it must be re-requested, never auto-repaired).
   */
  recheck(observation: RecheckObservation, at: number): RecheckOutcome {
    this.#requireState("AUTHORIZED", "recheck");
    const request = this.#authorizationRequest;
    const artifact = this.#artifact;
    if (request === undefined || artifact === undefined) {
      throw new PipelineStateError("unreachable: AUTHORIZED without request/artifact");
    }
    const outcome = performPreBroadcastRecheck(artifact, request, observation, at);
    if (outcome.outcome === "RECHECK_OK") {
      this.#transition("RECHECK_OK", at);
      this.#recheck = outcome;
      this.#log(at, "RECHECKED", "RECHECK_OK", [...outcome.evidenceRefs]);
    } else {
      this.#transition("RECHECK_DRIFT", at);
      this.#recheck = outcome;
      this.#log(at, "VOIDED", "RECHECK_DRIFT", [...outcome.evidenceRefs]);
    }
    return outcome;
  }

  /**
   * Broadcast handoff — the ONLY exit toward execution: a SigningRequest
   * for the signer adapter (the trusted-surface/wallet layer). The kernel
   * itself has no broadcast function; an agent can never call one.
   */
  handoffForBroadcast(input: {
    readonly requestId: string;
    readonly adapter: SignerAdapter;
    readonly at: number;
  }): SigningRequest {
    this.#requireState("RECHECKED", "handoffForBroadcast");
    const request = this.#authorizationRequest;
    const artifact = this.#artifact;
    const recheck = this.#recheck;
    if (request === undefined || artifact === undefined || recheck === undefined) {
      throw new PipelineStateError("unreachable: RECHECKED without full authorization lineage");
    }
    const signingRequest = buildSigningRequest({
      requestId: input.requestId,
      artifact,
      request,
      recheck,
      adapter: input.adapter,
      at: input.at,
    });
    this.#transition("HANDOFF", input.at);
    this.#signingRequest = signingRequest;
    this.#log(input.at, "BROADCAST_HANDOFF", "HANDOFF", [
      `signingRequest:${signingRequest.requestId}`,
      `authorization:${signingRequest.authorizationRef}`,
      `recheck:${signingRequest.recheckRef}`,
    ]);
    return signingRequest;
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  #requireState(expected: OnchainWritePipelineState, operation: string): void {
    if (this.#state !== expected) {
      throw new PipelineStateError(
        `operation '${operation}' requires state ${expected}, but the pipeline is ${this.#state}`,
      );
    }
  }

  #requireAnyState(expected: readonly OnchainWritePipelineState[], operation: string): void {
    if (!expected.includes(this.#state)) {
      throw new PipelineStateError(
        `operation '${operation}' requires one of [${expected.join(", ")}], but the pipeline is ${this.#state}`,
      );
    }
  }

  #transition(event: string, at: number): void {
    try {
      const record = PIPELINE_MACHINE.transition(this.#state, event, { pipeline: this });
      this.#state = record.to;
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        throw new PipelineStateError(
          `illegal pipeline transition ${this.#state} + ${event} at ${at}: ${error.message}`,
        );
      }
      throw error;
    }
  }

  #log(at: number, state: OnchainWritePipelineState, event: string, refs: readonly string[]): void {
    this.#evidence.push(Object.freeze({ at, state, event, refs: Object.freeze([...refs]) }));
  }
}

/** Deterministic pipeline-run digest (replay equality for the whole run). */
export function pipelineRunDigest(pipeline: OnchainWritePipeline): string {
  return contentDigest({
    writeDigest: pipeline.prepared.writeDigest,
    state: pipeline.state,
    evidence: pipeline.evidence(),
  });
}
