/**
 * @payswap/onchain-security — user-readable expected-state diff (Work
 * Order P4-W1-002; UMI architecture "human-readable expected-state diff").
 *
 * Before authorization the user sees exactly what the write is expected to
 * change: balance deltas, approval (allowance) changes and other state
 * changes, rendered in plain deterministic sentences. The diff is
 * content-addressed; the authorization artifact binds the diff digest, and
 * the pre-broadcast recheck compares the re-observed state against the
 * authorized diff.
 *
 * Entries derived from the write intent are deterministic. Entries derived
 * from a passing simulation are marked as OBSERVED (they inform, they do
 * not authorize). Deterministic only: pure function of (write, simulation).
 */

import { compareAmounts } from "@payswap/trust";
import { assertNoSecretMaterial } from "./secrets.js";
import { contentDigest } from "./digest.js";
import type { PreparedWrite } from "./write-intent.js";
import type { SimulationObservation } from "./simulation.js";
import type { AssetIdentity } from "./types.js";

/** Raised on malformed diff construction (fail closed). */
export class InvalidDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDiffError";
  }
}

export type ExpectedStateDiffEntry =
  | {
      readonly kind: "balance";
      readonly source: "intent" | "simulation_observed";
      readonly holder: string;
      readonly asset: AssetIdentity;
      readonly amount: { readonly currency: string; readonly minorUnits: string };
      readonly direction: "credit" | "debit";
      readonly description: string;
    }
  | {
      readonly kind: "approval";
      readonly source: "intent" | "simulation_observed";
      readonly owner: string;
      readonly spender: string;
      readonly asset: AssetIdentity;
      readonly after: { readonly currency: string; readonly minorUnits: string };
      readonly unlimited: boolean;
      readonly description: string;
    }
  | {
      readonly kind: "state";
      readonly source: "intent" | "simulation_observed";
      readonly contract: string;
      readonly key: string;
      readonly description: string;
    };

/** The user-readable expected-state diff, content-addressed. */
export interface ExpectedStateDiff {
  readonly entries: readonly ExpectedStateDiffEntry[];
  readonly diffDigest: string;
}

function describeAmount(amount: { currency: string; minorUnits: string }): string {
  return `${amount.minorUnits} minor units of ${amount.currency}`;
}

/**
 * Build the expected-state diff for a prepared write. When a SUCCEEDED
 * simulation is supplied, its observed deltas are appended as
 * `simulation_observed` entries (informational; a divergent simulation is
 * BLOCKED by the gates before the diff is ever authorized).
 */
export function buildExpectedStateDiff(
  write: PreparedWrite,
  simulation?: SimulationObservation,
): ExpectedStateDiff {
  const entries: ExpectedStateDiffEntry[] = [];

  if (write.transfer !== undefined) {
    entries.push({
      kind: "balance",
      source: "intent",
      holder: write.transfer.from,
      asset: write.transfer.asset,
      amount: write.transfer.amount,
      direction: "debit",
      description: `Send ${describeAmount(write.transfer.amount)} on ${write.transfer.asset.chain} from ${write.transfer.from} to ${write.transfer.to}`,
    });
    entries.push({
      kind: "balance",
      source: "intent",
      holder: write.transfer.to,
      asset: write.transfer.asset,
      amount: write.transfer.amount,
      direction: "credit",
      description: `Recipient ${write.transfer.to} receives ${describeAmount(write.transfer.amount)} of ${write.transfer.asset.symbol} on ${write.transfer.asset.chain}`,
    });
  }

  for (const approval of write.approvals) {
    entries.push({
      kind: "approval",
      source: "intent",
      owner: approval.owner,
      spender: approval.spender,
      asset: approval.asset,
      after: approval.amount,
      unlimited: approval.unlimited,
      description: approval.unlimited
        ? `Grant ${approval.spender} UNLIMITED permission to spend ${approval.asset.symbol} from ${approval.owner} on ${approval.asset.chain}`
        : approval.amount.minorUnits === "0"
          ? `Revoke ${approval.spender}'s permission to spend ${approval.asset.symbol} from ${approval.owner} on ${approval.asset.chain}`
          : `Allow ${approval.spender} to spend up to ${describeAmount(approval.amount)} of ${approval.owner}'s ${approval.asset.symbol} on ${approval.asset.chain}`,
    });
  }

  if (write.contractCall !== undefined) {
    entries.push({
      kind: "state",
      source: "intent",
      contract: write.contractCall.target,
      key: write.contractCall.calldataDigest,
      description: `Interact with contract ${write.contractCall.target} on ${write.chain} (payload digest ${write.contractCall.calldataDigest})`,
    });
  }

  if (simulation !== undefined && simulation.status === "SUCCEEDED") {
    for (const delta of simulation.balanceDeltas) {
      entries.push({
        kind: "balance",
        source: "simulation_observed",
        holder: delta.holder,
        asset: delta.asset,
        amount: delta.amount,
        direction: delta.direction,
        description: `Simulated ${delta.direction} of ${describeAmount(delta.amount)} for ${delta.holder} (${delta.asset.symbol} on ${delta.asset.chain})`,
      });
    }
    for (const approval of simulation.approvals) {
      entries.push({
        kind: "approval",
        source: "simulation_observed",
        owner: approval.owner,
        spender: approval.spender,
        asset: approval.asset,
        after: approval.allowance,
        unlimited: approval.unlimited,
        description: approval.unlimited
          ? `Simulated: ${approval.spender} holds UNLIMITED spend permission for ${approval.owner}'s ${approval.asset.symbol}`
          : `Simulated: ${approval.spender} may spend up to ${describeAmount(approval.allowance)} of ${approval.owner}'s ${approval.asset.symbol}`,
      });
    }
  }

  const diff: ExpectedStateDiff = {
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    diffDigest: contentDigest({ writeDigest: write.writeDigest, entries }),
  };
  assertNoSecretMaterial(diff, "expected-state diff");
  return diff;
}

/** Render the diff as deterministic plain sentences (trusted-surface display). */
export function renderExpectedStateDiff(diff: ExpectedStateDiff): readonly string[] {
  const lines = diff.entries.map((entry) => {
    const prefix = entry.source === "simulation_observed" ? "[simulated] " : "";
    return `${prefix}${entry.description}`;
  });
  if (lines.length === 0) {
    throw new InvalidDiffError("an expected-state diff must describe at least one effect");
  }
  return lines;
}

/** Exact-amount helper: are two diff amounts equal (same currency, same minor units)? */
export function diffAmountsEqual(
  a: { currency: string; minorUnits: string },
  b: { currency: string; minorUnits: string },
): boolean {
  if (a.currency !== b.currency) {
    return false;
  }
  try {
    return compareAmounts(
      { currency: a.currency, minorUnits: a.minorUnits },
      { currency: b.currency, minorUnits: b.minorUnits },
    ) === 0;
  } catch {
    return false;
  }
}
