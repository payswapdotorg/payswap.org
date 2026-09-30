import type { Principal } from "./principal.js";
import { principalRef } from "./principal.js";

/**
 * Security epoch contracts (FROZEN-ARCHITECTURE §17, INV-A02, INV-S02).
 *
 * Raising a security epoch invalidates every credential issued at a lower
 * epoch. The epoch is checked on every sensitive delegated action; a stale
 * credential can never authorize one.
 */

/** A security epoch value with its raise metadata. */
export interface SecurityEpoch {
  readonly value: bigint;
  readonly raisedAt: number;
  readonly reason: string;
}

/** Append-only ledger record: who raised which epoch, when and why. */
export interface EpochLedgerEntry extends SecurityEpoch {
  readonly principalRef: string;
}

/** Raised when a credential's epoch is behind the current epoch (INV-A02). */
export class StaleEpochError extends Error {
  readonly principalRef: string;
  readonly credentialEpoch: bigint;
  readonly currentEpoch: bigint;

  constructor(principalRef: string, credentialEpoch: bigint, currentEpoch: bigint) {
    super(
      `Stale security epoch for ${principalRef}: credential epoch ${credentialEpoch} is behind current epoch ${currentEpoch}`,
    );
    this.name = "StaleEpochError";
    this.principalRef = principalRef;
    this.credentialEpoch = credentialEpoch;
    this.currentEpoch = currentEpoch;
  }
}

/** Raised when a raise would move an epoch backwards in time. */
export class NonMonotonicEpochError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonMonotonicEpochError";
  }
}

/**
 * Current security epoch per principal. Epoch values are monotonically
 * increasing; the raise history is append-only (AGENTS.md rule 8).
 */
export class EpochLedger {
  readonly #current = new Map<string, SecurityEpoch>();
  readonly #history: EpochLedgerEntry[] = [];

  /** Current epoch for a principal; undefined means the implicit epoch 0. */
  currentEpoch(principalRef: string): SecurityEpoch | undefined {
    return this.#current.get(principalRef);
  }

  /**
   * Raise the epoch for a principal. The new value is always strictly greater
   * than the previous one (first raise = 1, which invalidates epoch-0
   * credentials). `raisedAt` must never move backwards.
   */
  raiseEpoch(principalRef: string, reason: string, raisedAt: number): SecurityEpoch {
    if (reason.length === 0) {
      throw new NonMonotonicEpochError("epoch raise reason must not be empty");
    }
    const current = this.#current.get(principalRef);
    if (current !== undefined && raisedAt < current.raisedAt) {
      throw new NonMonotonicEpochError(
        `raisedAt ${raisedAt} is before the previous raise at ${current.raisedAt} for ${principalRef}`,
      );
    }
    const entry: SecurityEpoch = {
      value: (current?.value ?? 0n) + 1n,
      raisedAt,
      reason,
    };
    this.#current.set(principalRef, entry);
    this.#history.push({ principalRef, ...entry });
    return entry;
  }

  /** Append-only raise history, in raise order. */
  history(): readonly EpochLedgerEntry[] {
    return [...this.#history];
  }
}

/**
 * Check a principal's credential epoch against the ledger (INV-A02, INV-S02).
 * Throws StaleEpochError when the credential epoch is behind the current
 * epoch. Service principals carry no delegable credential epoch and are not
 * checked here.
 */
export function checkEpoch(principal: Principal, ledger: EpochLedger): void {
  if (principal.kind === "service") {
    return;
  }
  const ref = principalRef(principal);
  const current = ledger.currentEpoch(ref);
  if (current !== undefined && principal.securityEpoch < current.value) {
    throw new StaleEpochError(ref, principal.securityEpoch, current.value);
  }
}
