/**
 * @payswap/recourse — the bond protection mechanism (W1-006).
 *
 * SECURITY-EVIDENCE-RECOURSE "Economic accountability": an untrusted actor
 * may need an ExecutionBond defining provider, bonded amount, exposure cap,
 * proof threshold, dispute window and slash/clawback rules. The objective is
 * explicit economic liability instead of hidden trust assumptions.
 *
 * W1-006 acceptance discipline:
 * - SEPARATELY ACCOUNTED: every bond's collateral lives in its own dedicated
 *   `RESERVE:bond.<bondId>` journal account, funded by a balanced entry
 *   (INV-F03) out of the surety's operational account (INV-F04 reservation
 *   checked first), and paid out only through explicit claims/release — never
 *   merged with operational balances.
 * - FORFEITURE CONDITIONS: a claim requires (1) a GRANTED dispute, (2) the
 *   claim to be inside the declared dispute window, (3) presented evidence
 *   whose EFFECTIVE level (INV-E04 caps) meets the bond's proof threshold,
 *   and (4) the cumulative claimed value to stay within the exposure cap
 *   (exact bigint arithmetic, INV-F01).
 * - BOND CLAIMS CREATE RECOURSE OBLIGATIONS: every claim mints a SEPARATE
 *   obligation (surety → claimant) through the protocol obligation machinery
 *   (consumed from ./recourse-obligations.js) — the adjudicated liability is
 *   protocol-recorded, never a silent balance move.
 * - INV-X04: EXHAUSTED and RELEASED are terminal with no recovery; release is
 *   guarded to after the dispute window closed.
 */

import {
  ValidationError,
  accountId,
  createJournalEntry,
  fromMinorUnits,
  postJournal,
} from '@payswap/protocol';
import { activateReservation, captureReservation, reserve } from '@payswap/protocol';
import { defineStateMachine, negate } from '@payswap/protocol';
import type {
  PaySwapErrorDetails,
  AccountId,
  IdFactory,
  JournalEntryId,
  Money,
  ObligationDueWindow,
  ObligationId,
  PartyId,
  ProtocolClock,
  ReservationId,
  ReservationLedgerState,
  TimestampMs,
  TransitionRecord,
} from '@payswap/protocol';
import type { StateMachine } from '@payswap/protocol';
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

export type BondState = 'ACTIVE' | 'EXHAUSTED' | 'RELEASED';

export type BondEvent = 'EXHAUST' | 'RELEASE';

/** Guard context for the bond machine. */
export interface BondMachineContext {
  readonly now: TimestampMs;
  readonly disputeWindow: RecourseClaimWindow;
}

/**
 * The deterministic bond lifecycle. EXHAUSTED fires when the exposure cap is
 * fully claimed (authority-enforced exact arithmetic); RELEASE is guarded to
 * strictly after the dispute window closed. Both terminal, no recovery
 * (INV-X04).
 */
export const bondStateMachine: StateMachine<BondState, BondEvent, BondMachineContext> =
  defineStateMachine<BondState, BondEvent, BondMachineContext>({
    name: 'execution-bond',
    initial: 'ACTIVE',
    states: ['ACTIVE', 'EXHAUSTED', 'RELEASED'],
    events: ['EXHAUST', 'RELEASE'],
    transitions: [
      {
        from: 'ACTIVE',
        on: 'EXHAUST',
        to: 'EXHAUSTED',
        description: 'the exposure cap is fully claimed — no further claims are possible',
      },
      {
        from: 'ACTIVE',
        on: 'RELEASE',
        to: 'RELEASED',
        guard: (context) => context.now > context.disputeWindow.closesAt,
        description:
          'the remaining collateral returns to the surety only after the dispute window closed',
      },
    ],
    terminalStates: ['EXHAUSTED', 'RELEASED'],
  });

/** One recorded bond transition (history is append-only). */
export interface BondTransitionRecord extends TransitionRecord<BondState, BondEvent> {
  readonly recordedAt: TimestampMs;
}

// ---------------------------------------------------------------------------
// The execution bond record
// ---------------------------------------------------------------------------

/**
 * One successful, append-only claim against a bond. Records the dispute, the
 * exact amount, the payout entry and the SEPARATE recourse obligation the
 * claim created.
 */
export interface BondClaim {
  readonly claimId: string;
  readonly disputeId: string;
  readonly claimant: PartyId;
  readonly amount: Money;
  readonly evidenceRefs: readonly string[];
  readonly claimedAt: TimestampMs;
  readonly payoutEntryId: JournalEntryId;
  /** The separate recourse obligation created by this claim (surety → claimant). */
  readonly recourseObligationId: ObligationId;
}

/** The ExecutionBond (SECURITY-EVIDENCE-RECOURSE "Economic accountability"). */
export interface ExecutionBond {
  readonly bondId: string;
  readonly surety: PartyId;
  readonly beneficiary: PartyId;
  readonly bondedAmount: Money;
  readonly exposureCap: Money;
  readonly proofThreshold: ProofLevel;
  readonly disputeWindow: RecourseClaimWindow;
  /** The surety's operational account: collateral source and release target. */
  readonly fundingAccount: AccountId;
  /** The DEDICATED reserve account holding the collateral. */
  readonly bondAccount: AccountId;
  readonly reservationId: ReservationId;
  readonly fundingEntryId: JournalEntryId;
  readonly state: BondState;
  readonly issuedAt: TimestampMs;
  readonly claims: readonly BondClaim[];
  readonly history: readonly BondTransitionRecord[];
  readonly releasedAt?: TimestampMs;
  readonly releaseEntryId?: JournalEntryId;
}

/** Command form for issuing a bond. */
export interface IssueBondCommand {
  readonly surety: PartyId;
  readonly beneficiary: PartyId;
  readonly bondedAmount: Money;
  readonly exposureCap: Money;
  readonly proofThreshold: ProofLevel;
  readonly disputeWindow: RecourseClaimWindow;
  /** The surety's operational account the collateral is funded from. */
  readonly fundingAccount: AccountId;
}

/** Command form for claiming against a bond (a forfeiture). */
export interface ClaimBondCommand {
  readonly bondId: string;
  readonly disputeId: string;
  readonly claimant: PartyId;
  readonly amount: Money;
  readonly evidenceRefs: readonly string[];
  /** The claimant's operational account the payout lands in. */
  readonly claimantAccount: AccountId;
  /** Due window stamped on the recourse obligation the claim creates. */
  readonly obligationDueWindow: ObligationDueWindow;
}

/** A bond id was reused or is unknown. */
export class BondIdConflictError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'BondIdConflictError';
  }
}

export class UnknownBondError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'UnknownBondError';
  }
}

/** The claim falls outside the bond's declared dispute window. */
export class BondClaimWindowError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'BondClaimWindowError';
  }
}

/** The presented evidence does not meet the bond's proof threshold (INV-E04). */
export class BondProofThresholdError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'BondProofThresholdError';
  }
}

/** The claim would exceed the bond's exposure cap (exact arithmetic). */
export class BondExposureExceededError extends ValidationError {
  constructor(message: string, details?: PaySwapErrorDetails) {
    super(message, details);
    this.name = 'BondExposureExceededError';
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

function assertWindow(window: RecourseClaimWindow, label: string): void {
  if (window === null || typeof window !== 'object') {
    throw new ValidationError(`${label} must be a RecourseClaimWindow object`);
  }
  if (typeof window.opensAt !== 'bigint' || typeof window.closesAt !== 'bigint') {
    throw new ValidationError(`${label} bounds must be bigint TimestampMs`);
  }
  if (window.closesAt < window.opensAt) {
    throw new ValidationError(`${label} closes before it opens`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function freezeClaim(claim: BondClaim): BondClaim {
  return Object.freeze({
    claimId: claim.claimId,
    disputeId: claim.disputeId,
    claimant: claim.claimant,
    amount: claim.amount,
    evidenceRefs: Object.freeze([...claim.evidenceRefs]),
    claimedAt: claim.claimedAt,
    payoutEntryId: claim.payoutEntryId,
    recourseObligationId: claim.recourseObligationId,
  });
}

function freezeBond(bond: ExecutionBond): ExecutionBond {
  const frozen: {
    -readonly [K in keyof ExecutionBond]: ExecutionBond[K];
  } = {
    bondId: bond.bondId,
    surety: bond.surety,
    beneficiary: bond.beneficiary,
    bondedAmount: bond.bondedAmount,
    exposureCap: bond.exposureCap,
    proofThreshold: bond.proofThreshold,
    disputeWindow: Object.freeze({
      opensAt: bond.disputeWindow.opensAt,
      closesAt: bond.disputeWindow.closesAt,
    }),
    fundingAccount: bond.fundingAccount,
    bondAccount: bond.bondAccount,
    reservationId: bond.reservationId,
    fundingEntryId: bond.fundingEntryId,
    state: bond.state,
    issuedAt: bond.issuedAt,
    claims: Object.freeze(bond.claims.map(freezeClaim)),
    history: Object.freeze([...bond.history]),
  };
  if (bond.releasedAt !== undefined) frozen.releasedAt = bond.releasedAt;
  if (bond.releaseEntryId !== undefined) frozen.releaseEntryId = bond.releaseEntryId;
  return Object.freeze(frozen);
}

/** Exact total already claimed (INV-F01: bigint only). */
export function claimedTotal(bond: ExecutionBond): bigint {
  let total = 0n;
  for (const claim of bond.claims) {
    total += claim.amount.value;
  }
  return total;
}

/** Exact remaining collateral in the dedicated bond account. */
export function remainingCollateral(bond: ExecutionBond): bigint {
  return bond.bondedAmount.value - claimedTotal(bond);
}

// ---------------------------------------------------------------------------
// The bond authority
// ---------------------------------------------------------------------------

export interface BondAuthorityDeps {
  readonly ledger: ReservationLedgerState;
  readonly disputes: DisputeAuthority;
  readonly obligations: RecourseObligationAuthority;
  /** The settlement evidence graph claims resolve their evidence against. */
  readonly evidence: EvidenceGraph;
}

/**
 * Owns execution bonds: issuance with separately-accounted collateral,
 * forfeiture conditions enforced per claim, and release after the dispute
 * window. Bond claims always create separate recourse obligations through
 * the protocol obligation machinery.
 */
export class BondAuthority {
  readonly #ledger: ReservationLedgerState;
  readonly #disputes: DisputeAuthority;
  readonly #obligations: RecourseObligationAuthority;
  readonly #evidence: EvidenceGraph;
  readonly #byId = new Map<string, ExecutionBond>();
  readonly #order: ExecutionBond[] = [];

  constructor(deps: BondAuthorityDeps) {
    if (deps === null || typeof deps !== 'object') {
      throw new ValidationError('deps must be a BondAuthorityDeps object');
    }
    this.#ledger = deps.ledger;
    this.#disputes = deps.disputes;
    this.#obligations = deps.obligations;
    this.#evidence = deps.evidence;
  }

  /** One bond by id (frozen). */
  get(bondId: string): ExecutionBond | undefined {
    return this.#byId.get(bondId);
  }

  /** All bonds in issuance order (audit view). */
  all(): readonly ExecutionBond[] {
    return Object.freeze([...this.#order]);
  }

  /**
   * Issue an execution bond: the exact collateral moves from the surety's
   * operational account into the DEDICATED `RESERVE:bond.<id>` account
   * (balanced entry, INV-F03; INV-F04 reservation on the surety's available
   * value first) and is locked there by a protocol reservation. Exposure cap
   * must not exceed the bonded amount; the dispute window must not be closed
   * at issuance.
   */
  issueBond(cmd: IssueBondCommand): ExecutionBond {
    if (cmd === null || typeof cmd !== 'object') {
      throw new ValidationError('cmd must be an IssueBondCommand object');
    }
    if (!isNonEmptyString(cmd.surety) || !isNonEmptyString(cmd.beneficiary)) {
      throw new ValidationError('cmd.surety and cmd.beneficiary must be non-empty PartyIds');
    }
    assertMoney(cmd.bondedAmount, 'cmd.bondedAmount');
    assertMoney(cmd.exposureCap, 'cmd.exposureCap');
    if (cmd.exposureCap.currency !== cmd.bondedAmount.currency) {
      throw new ValidationError('exposure cap currency differs from the bonded amount');
    }
    if (cmd.exposureCap.value > cmd.bondedAmount.value) {
      throw new ValidationError('exposure cap cannot exceed the bonded amount', {
        bonded: cmd.bondedAmount.value.toString(),
        cap: cmd.exposureCap.value.toString(),
      });
    }
    if (
      typeof cmd.proofThreshold !== 'string' ||
      !['P0', 'P1', 'P2', 'P3', 'P4', 'P5'].includes(cmd.proofThreshold)
    ) {
      throw new ValidationError('cmd.proofThreshold must be a declared proof level');
    }
    assertWindow(cmd.disputeWindow, 'cmd.disputeWindow');
    if (typeof cmd.fundingAccount !== 'string' || cmd.fundingAccount.length === 0) {
      throw new ValidationError('cmd.fundingAccount must be a non-empty AccountId');
    }

    const { journal, ids, clock } = this.#ledger;
    const now = clock.now();
    if (cmd.disputeWindow.closesAt < now) {
      throw new ValidationError('bond dispute window must not be already closed at issuance');
    }

    const bondId = ids.mintId('bnd');
    if (this.#byId.has(bondId)) {
      throw new BondIdConflictError('bond id already exists — ids are never reused', { bondId });
    }
    const bondAccount = accountId('RESERVE', `bond.${bondId}`);

    // INV-F04: hold the surety's available value before moving it.
    const fundingHold = reserve(this.#ledger, {
      accountId: cmd.fundingAccount,
      amount: cmd.bondedAmount,
      refs: { correlationId: bondId },
    });
    activateReservation(this.#ledger, fundingHold.id);

    const fundingEntry = postJournal(
      journal,
      createJournalEntry(
        {
          lines: [
            { accountId: cmd.fundingAccount, amount: negate(cmd.bondedAmount) },
            { accountId: bondAccount, amount: cmd.bondedAmount },
          ],
          memo: `BOND_FUND:${bondId}`,
          source: { correlationId: bondId },
        },
        { ids, clock },
      ),
    );
    captureReservation(this.#ledger, fundingHold.id);

    const collateralHold = reserve(this.#ledger, {
      accountId: bondAccount,
      amount: cmd.bondedAmount,
      refs: { correlationId: bondId },
    });
    activateReservation(this.#ledger, collateralHold.id);

    const bond = freezeBond({
      bondId,
      surety: cmd.surety,
      beneficiary: cmd.beneficiary,
      bondedAmount: cmd.bondedAmount,
      exposureCap: cmd.exposureCap,
      proofThreshold: cmd.proofThreshold,
      disputeWindow: cmd.disputeWindow,
      fundingAccount: cmd.fundingAccount,
      bondAccount,
      reservationId: collateralHold.id,
      fundingEntryId: fundingEntry.entryId,
      state: 'ACTIVE',
      issuedAt: now,
      claims: [],
      history: [],
    });
    this.#byId.set(bondId, bond);
    this.#order.push(bond);
    return bond;
  }

  /**
   * Claim against a bond (forfeiture). Conditions enforced, in order:
   * 1. the bond is ACTIVE;
   * 2. the dispute exists and is GRANTED (adjudication precedes forfeiture);
   * 3. the claim is inside the declared dispute window;
   * 4. the presented evidence resolves in the settlement evidence graph and
   *    its EFFECTIVE level (INV-E04 caps) meets the bond's proof threshold;
   * 5. the exact cumulative claimed value stays within the exposure cap.
   *
   * Effects: a balanced payout entry moves the exact amount from the
   * dedicated bond account to the claimant's operational account, AND a
   * SEPARATE recourse obligation (surety → claimant) is minted through the
   * protocol obligation machinery. When the cap is fully claimed the bond
   * becomes EXHAUSTED (terminal, INV-X04).
   */
  claimBond(cmd: ClaimBondCommand): ExecutionBond {
    if (cmd === null || typeof cmd !== 'object') {
      throw new ValidationError('cmd must be a ClaimBondCommand object');
    }
    if (!isNonEmptyString(cmd.bondId)) {
      throw new ValidationError('cmd.bondId must be a non-empty string');
    }
    const bond = this.#byId.get(cmd.bondId);
    if (bond === undefined) {
      throw new UnknownBondError('no bond exists under the given id', { bondId: cmd.bondId });
    }
    if (bond.state !== 'ACTIVE') {
      throw new ValidationError('claims are only possible while the bond is ACTIVE', {
        bondId: bond.bondId,
        state: bond.state,
      });
    }
    if (!isNonEmptyString(cmd.disputeId)) {
      throw new ValidationError('cmd.disputeId must be a non-empty string');
    }
    if (!isNonEmptyString(cmd.claimant)) {
      throw new ValidationError('cmd.claimant must be a non-empty PartyId');
    }
    assertMoney(cmd.amount, 'cmd.amount');
    if (cmd.amount.currency !== bond.bondedAmount.currency) {
      throw new ValidationError('claim currency differs from the bonded amount');
    }
    if (!Array.isArray(cmd.evidenceRefs) || cmd.evidenceRefs.length === 0) {
      throw new ValidationError('a bond claim requires at least one evidence reference');
    }
    if (typeof cmd.claimantAccount !== 'string' || cmd.claimantAccount.length === 0) {
      throw new ValidationError('cmd.claimantAccount must be a non-empty AccountId');
    }

    const { journal, ids, clock } = this.#ledger;
    const now = clock.now();

    // 2. adjudication precedes forfeiture.
    const dispute = this.#disputes.require(cmd.disputeId);
    if (dispute.state !== 'GRANTED') {
      throw new ValidationError('a bond claim requires a GRANTED dispute', {
        disputeId: cmd.disputeId,
        disputeState: dispute.state,
      });
    }
    // 2b. the claim is bounded by the dispute's granted amount — checked
    // BEFORE any mutation so a refused claim is never half-applied (the
    // recourse authority re-checks the same bound when minting).
    const grantedAmount = dispute.resolution?.grantedAmount ?? dispute.disputedAmount;
    if (cmd.amount.value > grantedAmount.value) {
      throw new RecourseAmountExceedsGrantError(
        'a bond claim cannot exceed the granted amount of the dispute',
        {
          bondId: bond.bondId,
          disputeId: cmd.disputeId,
          granted: grantedAmount.value.toString(),
          requested: cmd.amount.value.toString(),
        },
      );
    }

    // 3. the claim window of the bond itself.
    if (now < bond.disputeWindow.opensAt || now > bond.disputeWindow.closesAt) {
      throw new BondClaimWindowError('the bond claim is outside the declared dispute window', {
        bondId: bond.bondId,
        opensAt: bond.disputeWindow.opensAt.toString(),
        closesAt: bond.disputeWindow.closesAt.toString(),
        now: now.toString(),
      });
    }

    // 4. evidence strength under INV-E04 caps.
    const evidenceNodes = resolveEvidenceRefs(this.#evidence, cmd.evidenceRefs);
    const strength = evidenceMeetsThreshold(evidenceNodes, bond.proofThreshold);
    if (!strength.met) {
      throw new BondProofThresholdError(
        `the presented evidence does not meet the bond's proof threshold '${bond.proofThreshold}'`,
        {
          bondId: bond.bondId,
          required: bond.proofThreshold,
          achieved: strength.achieved ?? 'NONE',
        },
      );
    }

    // 5. exact exposure arithmetic (INV-F01).
    const totalAfter = claimedTotal(bond) + cmd.amount.value;
    if (totalAfter > bond.exposureCap.value) {
      throw new BondExposureExceededError('the claim would exceed the bond exposure cap', {
        bondId: bond.bondId,
        cap: bond.exposureCap.value.toString(),
        alreadyClaimed: claimedTotal(bond).toString(),
        requested: cmd.amount.value.toString(),
      });
    }

    // Payout: exact value leaves the dedicated bond account (INV-F03).
    const payoutEntry = postJournal(
      journal,
      createJournalEntry(
        {
          lines: [
            { accountId: bond.bondAccount, amount: negate(cmd.amount) },
            { accountId: cmd.claimantAccount, amount: cmd.amount },
          ],
          memo: `BOND_CLAIM:${bond.bondId}`,
          source: { correlationId: bond.bondId },
        },
        { ids, clock },
      ),
    );

    // The claim creates a SEPARATE recourse obligation (surety → claimant).
    const minted = this.#obligations.grantRecourseObligations({
      dispute,
      debtor: bond.surety,
      creditor: cmd.claimant,
      amount: cmd.amount,
      mechanism: 'BOND',
      adjustmentKind: 'BOND_FORFEITURE',
      dueWindow: cmd.obligationDueWindow,
    });
    const obligation = minted[0];
    if (obligation === undefined) {
      throw new ValidationError('claim failed to mint its recourse obligation');
    }

    const claim: BondClaim = freezeClaim({
      claimId: ids.mintId('bcl'),
      disputeId: cmd.disputeId,
      claimant: cmd.claimant,
      amount: cmd.amount,
      evidenceRefs: [...cmd.evidenceRefs],
      claimedAt: now,
      payoutEntryId: payoutEntry.entryId,
      recourseObligationId: obligation.id,
    });

    let state: BondState = bond.state;
    let history = bond.history;
    if (totalAfter === bond.exposureCap.value) {
      const transition = bondStateMachine.transition('ACTIVE', 'EXHAUST', {
        now,
        disputeWindow: bond.disputeWindow,
      });
      state = transition.to;
      history = [
        ...bond.history,
        Object.freeze({
          from: transition.from,
          on: transition.on,
          to: transition.to,
          viaRecovery: transition.viaRecovery,
          recordedAt: now,
        }) as BondTransitionRecord,
      ];
      // The collateral lock is consumed with the exhaustion.
      captureReservation(this.#ledger, bond.reservationId);
    }

    const updated = freezeBond({
      ...bond,
      state,
      claims: [...bond.claims, claim],
      history,
    });
    this.#byId.set(updated.bondId, updated);
    const index = this.#order.findIndex((candidate) => candidate.bondId === updated.bondId);
    if (index >= 0) {
      this.#order[index] = updated;
    }
    return updated;
  }

  /**
   * Release the bond after its dispute window closed: the remaining collateral
   * returns to the surety's funding account through one balanced entry and
   * the bond becomes RELEASED (terminal, INV-X04). Refused before the window
   * closes and when the bond is not ACTIVE.
   */
  releaseBond(bondId: string): ExecutionBond {
    const bond = this.#byId.get(bondId);
    if (bond === undefined) {
      throw new UnknownBondError('no bond exists under the given id', { bondId });
    }
    const { journal, ids, clock } = this.#ledger;
    const now = clock.now();

    const transition = bondStateMachine.transition(bond.state, 'RELEASE', {
      now,
      disputeWindow: bond.disputeWindow,
    });

    // The collateral lock is consumed by the release.
    captureReservation(this.#ledger, bond.reservationId);

    const remaining = remainingCollateral(bond);
    if (remaining < 0n) {
      throw new ValidationError('bond collateral arithmetic is inconsistent (INV-F01)', {
        bondId: bond.bondId,
        remaining: remaining.toString(),
      });
    }
    let releaseEntryId: JournalEntryId | undefined;
    if (remaining > 0n) {
      const remainingMoney = fromMinorUnits(bond.bondedAmount.currency, remaining);
      const releaseEntry = postJournal(
        journal,
        createJournalEntry(
          {
            lines: [
              { accountId: bond.bondAccount, amount: negate(remainingMoney) },
              { accountId: bond.fundingAccount, amount: remainingMoney },
            ],
            memo: `BOND_RELEASE:${bond.bondId}`,
            source: { correlationId: bond.bondId },
          },
          { ids, clock },
        ),
      );
      releaseEntryId = releaseEntry.entryId;
    }

    const updated = freezeBond({
      ...bond,
      state: transition.to,
      releasedAt: now,
      ...(releaseEntryId !== undefined ? { releaseEntryId } : {}),
      history: [
        ...bond.history,
        Object.freeze({
          from: transition.from,
          on: transition.on,
          to: transition.to,
          viaRecovery: transition.viaRecovery,
          recordedAt: now,
        }) as BondTransitionRecord,
      ],
    });
    this.#byId.set(updated.bondId, updated);
    const index = this.#order.findIndex((candidate) => candidate.bondId === updated.bondId);
    if (index >= 0) {
      this.#order[index] = updated;
    }
    return updated;
  }
}
