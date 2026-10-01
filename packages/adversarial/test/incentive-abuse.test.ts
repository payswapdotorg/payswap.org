import { describe, expect, it } from "vitest";
import {
  incentiveSybilCollusionWashScenario,
  leaderboardGamingScenario,
  runScenario,
} from "../src/index.js";
import { runAndExpectScenario } from "./adversarial-helpers.js";

/**
 * W2-007 fault families — incentive Sybil/collusion/wash behavior AND
 * leaderboard gaming (two scenarios from one module; both must pass with
 * their own candidate invariants and recovery paths).
 */

const SYBIL_CANDIDATES = ["INV-P04", "INV-P01", "INV-P03", "INV-P02"] as const;
const LEADERBOARD_CANDIDATES = ["INV-P05", "INV-P06"] as const;

describe("W2-007 fault family — incentive Sybil/collusion/wash", () => {
  it("injects the farming attacks, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(
      incentiveSybilCollusionWashScenario(),
      "incentive-sybil-collusion-wash",
      SYBIL_CANDIDATES,
    );
    expect(verdict.faultId).toBe("fault:incentive-sybil-collusion-wash:1");
  });

  it("blocks finalization for BLOCK and FLAG verdicts alike (INV-P04)", async () => {
    const verdict = await runScenario(incentiveSybilCollusionWashScenario());
    const invp04 = verdict.probes.find((p) => p.invariantId === "INV-P04");
    expect(invp04?.held).toBe(true);
    expect(invp04?.proof).toContain("BLOCK (sybil)");
    expect(invp04?.proof).toContain("BLOCK (wash)");
    expect(invp04?.proof).toContain("FLAG (velocity)");
    expect(invp04?.proof).toContain("PROVISIONAL");
  });

  it("refuses the unfunded contingent promise until funded (INV-P01)", async () => {
    const verdict = await runScenario(incentiveSybilCollusionWashScenario());
    const invp01 = verdict.probes.find((p) => p.invariantId === "INV-P01");
    expect(invp01?.held).toBe(true);
    expect(invp01?.proof).toContain("UnfundedRewardFinalizationError");
    expect(invp01?.proof).toContain("CONFIRMED");
  });

  it("recovers through the honest contributor with reproducible rewards", async () => {
    const verdict = await runScenario(incentiveSybilCollusionWashScenario());
    expect(verdict.recoveryPath.length).toBe(6);
    expect(verdict.recoveryPath[5]?.description).toContain("Honest contributor");
    const invp03 = verdict.probes.find((p) => p.invariantId === "INV-P03");
    expect(invp03?.proof).toContain("reproducible=true");
  });
});

describe("W2-007 fault family — leaderboard gaming", () => {
  it("injects the gaming, holds every candidate invariant and completes the recovery path", async () => {
    const verdict = await runAndExpectScenario(
      leaderboardGamingScenario(),
      "leaderboard-gaming",
      LEADERBOARD_CANDIDATES,
    );
    expect(verdict.faultId).toBe("fault:leaderboard-gaming:1");
  });

  it("excludes fabricated records and refuses rank as authorization (INV-P05)", async () => {
    const verdict = await runScenario(leaderboardGamingScenario());
    const invp05 = verdict.probes.find((p) => p.invariantId === "INV-P05");
    expect(invp05?.held).toBe(true);
    expect(invp05?.proof).toContain("no_matching_grant");
    expect(invp05?.proof).toContain("NOT_AUTHORIZATION");
  });

  it("claws back with a SEPARATE adjustment obligation while history remains (INV-P06)", async () => {
    const verdict = await runScenario(leaderboardGamingScenario());
    const invp06 = verdict.probes.find((p) => p.invariantId === "INV-P06");
    expect(invp06?.held).toBe(true);
    expect(invp06?.proof).toContain("SEPARATE adjustment obligation");
    expect(invp06?.proof).toContain("remain intact");
  });

  it("recovers through gate enforcement and post-hoc clawback", async () => {
    const verdict = await runScenario(leaderboardGamingScenario());
    expect(verdict.recoveryPath.length).toBe(5);
    expect(verdict.recoveryPath[0]?.description).toContain("Raw-activity metric rejected");
    expect(verdict.recoveryPath[4]?.description).toContain("clawed the reward back");
  });
});
