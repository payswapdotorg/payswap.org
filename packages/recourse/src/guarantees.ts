/**
 * @payswap/recourse — the guarantee protection mechanism (W1-006).
 *
 * SECURITY-EVIDENCE-RECOURSE "Recourse" mechanisms include the network
 * guarantee. A guarantee is a DECLARED backing (unlike a bond, no collateral
 * is posted): a guarantor stands behind a protected party up to an exact
 * coverage cap, within a declared invocation window, subject to a proof
 * threshold.
 *
 * W1-006 acceptance discipline:
 * - GUARANTOR DECLARATION: the `GuaranteeDeclaration` is frozen at
 *   declaration and immutable afterwards — re-declaring the same guarantee id
 *   with different content throws `GuaranteeDeclarationImmutableError`
 *   (identical replay is idempotent, deterministic replay safe). There is no
 *   update API.
 * - INVOCATION WINDOWS: `invokeGuarantee` is refused before the window opens
 *   (`GuaranteeInvocationWindowError`) and after it closes; invocation is
 *   only possible while the guarantee is ACTIVE.
 * - GUARANTEE-BACKED RECOURSE OBLIGATIONS: every invocation requires a
 *   GRANTED dispute plus evidence meeting the proof threshold (INV-E04 caps)
 *   and mints a SEPARATE recourse obligation (guarantor → claimant) through
 *   the protocol obligation machinery (consumed from
 *   ./recourse-obligations.js) — the guarantor's liability becomes a protocol
 *   record, never a hidden trust assumption.
 * - INV-X04: EXHAUSTED and LAPSED are terminal with no recovery. Exact
 *   coverage arithmetic (INV-F01) enforces the cap.
 */

import { ValidationError } from '@payswap/protocol';
import { defineStateMachine } from '@payswap/protocol';
import type {
  PaySwapErrorDetails,
  IdFactory,
  Money,
  ObligationDueWindow,
  ObligationId,
  PartyId,
  ProtocolClock,
  TimestampMs,
  TransitionRecord,
} from '@payswap/protocol';
import type { StateMachine } from '@payswap/protocol';
import type { CurrencyCode } from '@payswap/protocol';
import type { EvidenceGraph, ProofLevel } from '@payswap/settlement';
import type { RecourseClaimWindow } from './policy.js';
import { evidenceMeetsThreshold, resolveEvidenceRefs } from './evidence.js';
import type { DisputeAuthority } from './disputes.js';
import {
  RecourseAmountExceedsGrantError,
  type RecourseObligationAuthority,
} from './recourse-obligations.js';

// ---------------------------------------------------------------------------
// Lifecycle (INV-X04)
// ---------------------------------------------------------------------------

export type GuaranteeState = 'ACTIVE' | 'EXHAUSTED' | 'LAPSED';

export type GuaranteeEvent = 'EXHAUST' | 'LAPSE';

/** Guard context for the guarantee machine. */
export interface GuaranteeMachineContext {
  readonly now: TimestampMs;
  readonly invocationWindow: RecourseClaimWindow;
}

/**
 * The deterministic guarantee lifecycle. EXHAUSTED fires when the coverage
 * cap is fully invoked (authority-enforced exact arithmetic); LAPSE is
 * guarded to strictly after the invocation window closed. Both terminal, no
 * recovery (INV-X04).
 */
export const guaranteeStateMachine: StateMachine<GuaranteeState, GuaranteeEvent, GuaranteeMachineContext> =
  defineStateMachine<GuaranteeState, GuaranteeEvent, GuaranteeMachineContext>({
    name: 'guarantee',
    initial: 'ACTIVE',
    states: ['ACTIVE', 'EXHAUSTED', 'LAPSED'],
    events: ['EXHAUST', 'LAPSE'],
    transitions: [
      {
        from: 'ACTIVE',
        on: 'EXHAUST',
        to: 'EXHAUSTED',
        description: 'the coverage cap is fully invoked — no further invocations are possible',
      },
      {
        from: 'ACTIVE',
        on: 'LAPSE',
        to: 'LAPSED',
        guard: (context) => context.now > context.invocationWindow.closesAt,
        description: 'an unexhausted guarantee lapses only after the invocation window closed',
      },
    ],
    terminalStates: ['EXHAUSTED', 'LAPSED'],
  });

/** One recorded guarantee transition (history is append-only). */
export interface GuaranteeTransitionRecord extends TransitionRecord<GuaranteeState, GuaranteeEvent> {
  readonly recordedAt: TimestampMs;
}

// ---------------------------------------------------------------------------
// The guarantee declaration + invocation records
// ---------------------------------------------------------------------------

/** The immutable guarantor declaration. */
export interface GuaranteeDeclaration {
  readonly guaranteeId: string;
  readonly guarantor: PartyId;
  readonly protectedParty: PartyId;
  readonly currency: CurrencyCode;
  readonly coverageCap: Money;
  readonly proofThreshold: ProofLevel;
  readonly invocationWindow: RecourseClaimWindow;
  readonly declaredAt: TimestampMs;
}

/** Draft form supplied to `declareGuarantee`. */
export interface GuaranteeDeclarationDraft {
  /** Caller-supplied id for deterministic replay; minted when omitted. */
  readonly guaranteeId?: string;
  readonly guarantor: PartyId;
  readonly protectedParty: PartyId;
  readonly currency: CurrencyCode;
  readonly coverageCap: Money;
  readonly proofThreshold: ProofLevel;
  readonly invocationWindow: RecourseClaimWindow;
}

/**
 * One append-only invocation of a guarantee: records the dispute, the exact
 * amount, the evidence and the SEPARATE recourse obligation created.
 */
export interface GuaranteeInvocation {
  readonly invocationId: string;
  readonly disputeId: string;
  readonly claimant: PartyId;
  readonly amount: Money;
  readonly evidenceRefs: readonly string[];
  readonly invokedAt: TimestampMs;
  /** The guarantee-backed recourse obligation (guarantor → claimant). */
  readonly recourseObligationId: ObligationId;
}

/** The live guarantee: the immutable declaration plus its invocation state. */
export interface Guarantee {
  readonly declaration: GuaranteeDeclaration;
  readonly state: GuaranteeState;
  readonly invocations: readonly GuaranteeInvocation[];
  readonly history: readonly GuaranteeTransitionRecord[];
  readonly lapsedAt?: TimestampMs;
}

/** Command form for invoking a guarantee. */
export interface InvokeGuaranteeCommand {
  readonly guaranteeId: string;
  readonly disputeId: string;
  readonly claimant: PartyId;
  readonly amount: Money;
  readonly evidenceRefs: readonly string[];
  /** Due window stamped on the recourse obligation the invocation creates. */
  readonly obligationDueWindow: ObligationDueWindow;
}

/** The declaration is immutable after it is made. */
export class GuaranteeDeclarationImmutableError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'GuaranteeDeclarationImmutableError';
  }
}

export class UnknownGuaranteeError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'UnknownGuaranteeError';
  }
}

/** The invocation falls outside the declared invocation window. */
export class GuaranteeInvocationWindowError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'GuaranteeInvocationWindowError';
  }
}

/** The presented evidence does not meet the guarantee's proof threshold. */
export class GuaranteeProofThresholdError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'GuaranteeProofThresholdError';
  }
}

/** The invocation would exceed the coverage cap (exact arithmetic). */
export class GuaranteeCoverageExceededError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'GuaranteeCoverageExceededError';
  }
}

function assertMoney(amount: Money, label: string): void {
  if (amount === null || typeof amount !== 'object') {
    throw new ValidationError(`${label} must be a Money object`);
  }
  if (typeof amount.value !== 'bigint') {
    throw new ValidationError(`${label}.value must be a bigint (INV-F01)`);
  }
  if (amount.value <= 0n) {
    throw new ValidationError(`${label} must be positive Money`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function freezeDeclaration(declaration: GuaranteeDeclaration): GuaranteeDeclaration {
  return Object.freeze({
    guaranteeId: declaration.guaranteeId,
    guarantor: declaration.guarantor,
    protectedParty: declaration.protectedParty,
    currency: declaration.currency,
    coverageCap: declaration.coverageCap,
    proofThreshold: declaration.proofThreshold,
    invocationWindow: Object.freeze({
      opensAt: declaration.invocationWindow.opensAt,
      closesAt: declaration.invocationWindow.closesAt,
    }),
    declaredAt: declaration.declaredAt,
  });
}

function freezeInvocation(invocation: GuaranteeInvocation): GuaranteeInvocation {
  return Object.freeze({
    invocationId: invocation.invocationId,
    disputeId: invocation.disputeId,
    claimant: invocation.claimant,
    amount: invocation.amount,
    evidenceRefs: Object.freeze([...invocation.evidenceRefs]),
    invokedAt: invocation.invokedAt,
    recourseObligationId: invocation.recourseObligationId,
  });
}

function freezeGuarantee(guarantee: Guarantee): Guarantee {
  const frozen: {
    -readonly [K in keyof Guarantee]: Guarantee[K];
  } = {
    declaration: freezeDeclaration(guarantee.declaration),
    state: guarantee.state,
    invocations: Object.freeze(guarantee.invocations.map(freezeInvocation)),
    history: Object.freeze([...guarantee.history]),
  };
  if (guarantee.lapsedAt !== undefined) frozen.lapsedAt = guarantee.lapsedAt;
  return Object.freeze(frozen);
}

/** Deterministic canonical rendering of a declaration (immutability checks). */
export function canonicalGuaranteeDeclaration(declaration: GuaranteeDeclaration): string {
  return (
    `guarantee|id:${declaration.guaranteeId}|guarantor:${declaration.guarantor}` +
    `|protected:${declaration.protectedParty}|currency:${declaration.currency}` +
    `|cap:${declaration.coverageCap.value.toString()}` +
    `|threshold:${declaration.proofThreshold}` +
    `|window:${declaration.invocationWindow.opensAt.toString()}..${declaration.invocationWindow.closesAt.toString()}` +
    `|declaredAt:${declaration.declaredAt.toString()}`
  );
}

/** Exact total already invoked under a guarantee (INV-F01: bigint only). */
export function invokedTotal(guarantee: Guarantee): bigint {
  let total = 0n;
  for (const invocation of guarantee.invocations) {
    total += invocation.amount.value;
  }
  return total;
}

// ---------------------------------------------------------------------------
// The guarantee authority
// ---------------------------------------------------------------------------

export interface GuaranteeAuthorityDeps {
  readonly disputes: DisputeAuthority;
  readonly obligations: RecourseObligationAuthority;
  readonly evidence: EvidenceGraph;
  readonly ids: IdFactory;
  readonly clock: ProtocolClock;
}

/**
 * Owns guarantee declarations (immutable once made) and their invocations
 * (window-guarded, evidence-checked, cap-bounded). Every invocation mints a
 * guarantee-backed recourse obligation through the protocol obligation
 * machinery.
 */
export class GuaranteeAuthority {
  readonly #disputes: DisputeAuthority;
  readonly #obligations: RecourseObligationAuthority;
  readonly #evidence: EvidenceGraph;
  readonly #ids: IdFactory;
  readonly #clock: ProtocolClock;
  readonly #byId = new Map<string, Guarantee>();
  readonly #order: Guarantee[] = [];

  constructor(deps: GuaranteeAuthorityDeps) {
    if (deps === null || typeof deps !== 'object') {
      throw new ValidationError('deps must be a GuaranteeAuthorityDeps object');
    }
    this.#disputes = deps.disputes;
    this.#obligations = deps.obligations;
    this.#evidence = deps.evidence;
    this.#ids = deps.ids;
    this.#clock = deps.clock;
  }

  /** One guarantee by id (frozen). */
  get(guaranteeId: string): Guarantee | undefined {
    return this.#byId.get(guaranteeId);
  }

  /** All guarantees in declaration order (audit view). */
  all(): readonly Guarantee[] {
    return Object.freeze([...this.#order]);
  }

  /**
   * Declare a guarantee: the guarantor's declaration is frozen at declaration
   * time and immutable afterwards. Re-declaring the same guarantee id with
   * IDENTICAL content is an idempotent replay; ANY difference (including the
   * declaration timestamp — it is part of the immutable content) throws
   * `GuaranteeDeclarationImmutableError`. The invocation window must not be
   * already closed at declaration.
   */
  declareGuarantee(draft: GuaranteeDeclarationDraft): Guarantee {
    if (draft === null || typeof draft !== 'object') {
      throw new ValidationError('draft must be a GuaranteeDeclarationDraft object');
    }
    if (draft.guaranteeId !== undefined && !isNonEmptyString(draft.guaranteeId)) {
      throw new ValidationError('draft.guaranteeId must be a non-empty string when supplied');
    }
    if (!isNonEmptyString(draft.guarantor) || !isNonEmptyString(draft.protectedParty)) {
      throw new ValidationError('draft.guarantor and draft.protectedParty must be non-empty PartyIds');
    }
    if (typeof draft.currency !== 'string' || draft.currency.length === 0) {
      throw new ValidationError('draft.currency must be a non-empty CurrencyCode');
    }
    assertMoney(draft.coverageCap, 'draft.coverageCap');
    if (draft.coverageCap.currency !== draft.currency) {
      throw new ValidationError('coverage cap currency differs from the declared currency');
    }
    if (
      typeof draft.proofThreshold !== 'string' ||
      !['P0', 'P1', 'P2', 'P3', 'P4', 'P5'].includes(draft.proofThreshold)
    ) {
      throw new ValidationError('draft.proofThreshold must be a declared proof level');
    }
    const window = draft.invocationWindow;
    if (
      window === null ||
      typeof window !== 'object' ||
      typeof window.opensAt !== 'bigint' ||
      typeof window.closesAt !== 'bigint'
    ) {
      throw new ValidationError('draft.invocationWindow must be a RecourseClaimWindow');
    }
    if (window.closesAt < window.opensAt) {
      throw new ValidationError('invocation window closes before it opens');
    }
    const now = this.#clock.now();
    if (window.closesAt < now) {
      throw new ValidationError(
        'invocation window must not be already closed at declaration — the guarantee would be uninvocable',
      );
    }

    const guaranteeId = draft.guaranteeId !== undefined ? draft.guaranteeId : this.#ids.mintId('gnt');
    const declaration = freezeDeclaration({
      guaranteeId,
      guarantor: draft.guarantor,
      protectedParty: draft.protectedParty,
      currency: draft.currency,
      coverageCap: draft.coverageCap,
      proofThreshold: draft.proofThreshold,
      invocationWindow: window,
      declaredAt: now,
    });

    const existing = this.#byId.get(guaranteeId);
    if (existing !== undefined) {
      if (
        canonicalGuaranteeDeclaration(existing.declaration) !==
        canonicalGuaranteeDeclaration(declaration)
      ) {
        throw new GuaranteeDeclarationImmutableError(
          `guarantee '${guaranteeId}' is already declared and immutable`,
          { guaranteeId },
        );
      }
      return existing; // idempotent replay of the identical declaration
    }

    const guarantee = freezeGuarantee({
      declaration,
      state: 'ACTIVE',
      invocations: [],
      history: [],
    });
    this.#byId.set(guaranteeId, guarantee);
    this.#order.push(guarantee);
    return guarantee;
  }

  /**
   * Invoke a guarantee. Conditions enforced, in order:
   * 1. the guarantee exists and is ACTIVE;
   * 2. the dispute exists and is GRANTED (adjudication precedes invocation);
   * 3. the invocation is inside the declared invocation window;
   * 4. the presented evidence resolves in the settlement evidence graph and
   *    its EFFECTIVE level (INV-E04 caps) meets the proof threshold;
   * 5. the exact cumulative invoked value stays within the coverage cap.
   *
   * Effect: a SEPARATE guarantee-backed recourse obligation (guarantor →
   * claimant) is minted through the protocol obligation machinery. When the
   * cap is fully invoked the guarantee becomes EXHAUSTED (terminal, INV-X04).
   */
  invokeGuarantee(cmd: InvokeGuaranteeCommand): Guarantee {
    if (cmd === null || typeof cmd !== 'object') {
      throw new ValidationError('cmd must be an InvokeGuaranteeCommand object');
    }
    if (!isNonEmptyString(cmd.guaranteeId)) {
      throw new ValidationError('cmd.guaranteeId must be a non-empty string');
    }
    const guarantee = this.#byId.get(cmd.guaranteeId);
    if (guarantee === undefined) {
      throw new UnknownGuaranteeError('no guarantee exists under the given id', {
        guaranteeId: cmd.guaranteeId,
      });
    }
    if (guarantee.state !== 'ACTIVE') {
      throw new ValidationError('invocations are only possible while the guarantee is ACTIVE', {
        guaranteeId: cmd.guaranteeId,
        state: guarantee.state,
      });
    }
    if (!isNonEmptyString(cmd.disputeId)) {
      throw new ValidationError('cmd.disputeId must be a non-empty string');
    }
    if (!isNonEmptyString(cmd.claimant)) {
      throw new ValidationError('cmd.claimant must be a non-empty PartyId');
    }
    assertMoney(cmd.amount, 'cmd.amount');
    if (cmd.amount.currency !== guarantee.declaration.currency) {
      throw new ValidationError('invocation currency differs from the declared currency');
    }
    if (!Array.isArray(cmd.evidenceRefs) || cmd.evidenceRefs.length === 0) {
      throw new ValidationError('a guarantee invocation requires at least one evidence reference');
    }

    const now = this.#clock.now();

    // 2. adjudication precedes invocation.
    const dispute = this.#disputes.require(cmd.disputeId);
    if (dispute.state !== 'GRANTED') {
      throw new ValidationError('a guarantee invocation requires a GRANTED dispute', {
        disputeId: cmd.disputeId,
        disputeState: dispute.state,
      });
    }
    // 2b. the invocation is bounded by the dispute's granted amount — checked
    // BEFORE any mutation so a refused invocation is never half-applied (the
    // recourse authority re-checks the same bound when minting).
    const grantedAmount = dispute.resolution?.grantedAmount ?? dispute.disputedAmount;
    if (cmd.amount.value > grantedAmount.value) {
      throw new RecourseAmountExceedsGrantError(
        'a guarantee invocation cannot exceed the granted amount of the dispute',
        {
          guaranteeId: cmd.guaranteeId,
          disputeId: cmd.disputeId,
          granted: grantedAmount.value.toString(),
          requested: cmd.amount.value.toString(),
        },
      );
    }

    // 3. the invocation window.
    const window = guarantee.declaration.invocationWindow;
    if (now < window.opensAt || now > window.closesAt) {
      throw new GuaranteeInvocationWindowError(
        'the guarantee invocation is outside the declared invocation window',
        {
          guaranteeId: cmd.guaranteeId,
          opensAt: window.opensAt.toString(),
          closesAt: window.closesAt.toString(),
          now: now.toString(),
        },
      );
    }

    // 4. evidence strength under INV-E04 caps.
    const evidenceNodes = resolveEvidenceRefs(this.#evidence, cmd.evidenceRefs);
    const strength = evidenceMeetsThreshold(evidenceNodes, guarantee.declaration.proofThreshold);
    if (!strength.met) {
      throw new GuaranteeProofThresholdError(
        `the presented evidence does not meet the guarantee's proof threshold '${guarantee.declaration.proofThreshold}'`,
        {
          guaranteeId: cmd.guaranteeId,
          required: guarantee.declaration.proofThreshold,
          achieved: strength.achieved ?? 'NONE',
        },
      );
    }

    // 5. exact coverage arithmetic (INV-F01).
    const totalAfter = invokedTotal(guarantee) + cmd.amount.value;
    if (totalAfter > guarantee.declaration.coverageCap.value) {
      throw new GuaranteeCoverageExceededError(
        'the invocation would exceed the guarantee coverage cap',
        {
          guaranteeId: cmd.guaranteeId,
          cap: guarantee.declaration.coverageCap.value.toString(),
          alreadyInvoked: invokedTotal(guarantee).toString(),
          requested: cmd.amount.value.toString(),
        },
      );
    }

    // The invocation creates a SEPARATE guarantee-backed recourse obligation.
    const minted = this.#obligations.grantRecourseObligations({
      dispute,
      debtor: guarantee.declaration.guarantor,
      creditor: cmd.claimant,
      amount: cmd.amount,
      mechanism: 'GUARANTEE',
      adjustmentKind: 'GUARANTEE_PAYOUT',
      dueWindow: cmd.obligationDueWindow,
    });
    const obligation = minted[0];
    if (obligation === undefined) {
      throw new ValidationError('invocation failed to mint its recourse obligation');
    }

    const invocation = freezeInvocation({
      invocationId: this.#ids.mintId('gin'),
      disputeId: cmd.disputeId,
      claimant: cmd.claimant,
      amount: cmd.amount,
      evidenceRefs: [...cmd.evidenceRefs],
      invokedAt: now,
      recourseObligationId: obligation.id,
    });

    let state: GuaranteeState = guarantee.state;
    let history = guarantee.history;
    if (totalAfter === guarantee.declaration.coverageCap.value) {
      const transition = guaranteeStateMachine.transition('ACTIVE', 'EXHAUST', {
        now,
        invocationWindow: window,
      });
      state = transition.to;
      history = [
        ...guarantee.history,
        Object.freeze({
          from: transition.from,
          on: transition.on,
          to: transition.to,
          viaRecovery: transition.viaRecovery,
          recordedAt: now,
        }) as GuaranteeTransitionRecord,
      ];
    }

    const updated = freezeGuarantee({
      ...guarantee,
      state,
      invocations: [...guarantee.invocations, invocation],
      history,
    });
    this.#byId.set(updated.declaration.guaranteeId, updated);
    const index = this.#order.findIndex(
      (candidate) => candidate.declaration.guaranteeId === updated.declaration.guaranteeId,
    );
    if (index >= 0) {
      this.#order[index] = updated;
    }
    return updated;
  }

  /**
   * Lapse an unexhausted guarantee after its invocation window closed
   * (INV-X04: LAPSED is terminal, guarded to strictly after the window).
   */
  lapseGuarantee(guaranteeId: string): Guarantee {
    const guarantee = this.#byId.get(guaranteeId);
    if (guarantee === undefined) {
      throw new UnknownGuaranteeError('no guarantee exists under the given id', { guaranteeId });
    }
    const now = this.#clock.now();
    const transition = guaranteeStateMachine.transition(guarantee.state, 'LAPSE', {
      now,
      invocationWindow: guarantee.declaration.invocationWindow,
    });
    const updated = freezeGuarantee({
      ...guarantee,
      state: transition.to,
      lapsedAt: now,
      history: [
        ...guarantee.history,
        Object.freeze({
          from: transition.from,
          on: transition.on,
          to: transition.to,
          viaRecovery: transition.viaRecovery,
          recordedAt: now,
        }) as GuaranteeTransitionRecord,
      ],
    });
    this.#byId.set(updated.declaration.guaranteeId, updated);
    const index = this.#order.findIndex(
      (candidate) => candidate.declaration.guaranteeId === updated.declaration.guaranteeId,
    );
    if (index >= 0) {
      this.#order[index] = updated;
    }
    return updated;
  }
}
