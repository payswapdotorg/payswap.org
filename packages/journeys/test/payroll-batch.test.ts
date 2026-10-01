import { describe, expect, it } from "vitest";
import { USD, fromMinorUnits } from "@payswap/protocol";
import { runPayrollBatchJourney } from "../src/journeys/payroll-batch.js";
import { expectAxesCovered, expectJourneyPasses, JOURNEY_AXES } from "./journey-helpers.js";

describe("Journey: payroll batch (W1-007)", () => {
  const outcome = runPayrollBatchJourney();

  it("passes every acceptance axis", () => {
    expectJourneyPasses(outcome.journey);
  });

  it("asserts the five journey axes", () => {
    expectAxesCovered(outcome.journey, JOURNEY_AXES);
  });

  it("preserves gross obligations through netting (INV-F07)", () => {
    expect(outcome.details.grossActivityCount).toBe(5);
    expect(outcome.details.obligationCount).toBe(5);
    expect(outcome.details.instructionCount).toBe(4);
    expect(outcome.details.totalGrossMinorUnits).toBe(1_520_000n);
    expect(outcome.details.totalNetMinorUnits).toBe(1_380_000n);
    expect(outcome.details.bilateralNetReduction).toBe(140_000n);
    const e2 = outcome.details.chain.settlements.find((s) => s.instruction.creditor === "employee:e2");
    // The netting derivation retains the FULL gross set (all 5 obligations) —
    // INV-F07 gross preservation — while the instruction carries the net.
    expect(e2?.instruction.fromNetPosition.derivation.gross).toHaveLength(5);
    expect(e2?.instruction.amount).toEqual(fromMinorUnits(USD, 350_000n));
  });

  it("respects liquidity constraints (INV-F04 on the liquidity plane)", () => {
    expect(outcome.details.liquidityAvailableBefore).toBe(2_000_000n);
    expect(outcome.details.liquidityAvailableAfterReservation).toBe(620_000n);
    expect(outcome.details.overReservationRejected).toBe(true);
  });

  it("settles the batch with exact fee accounting", () => {
    expect(outcome.details.payrollFee).toEqual(fromMinorUnits(USD, 1_000n));
    expect(outcome.details.employerBalanceAfter).toEqual(fromMinorUnits(USD, 619_000n));
  });
});
