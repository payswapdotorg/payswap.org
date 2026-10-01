import { describe, expect, it } from "vitest";
import {
  REPLAY_NAMESPACE,
  isReplayResult,
  recordProductionFacts,
  recordedFactsDigest,
  runCounterfactual,
  runReplay,
} from "@payswap/lab";
import type {
  RecordedProductionFacts,
  SimulationProgram,
} from "@payswap/lab";

/**
 * Replay reproducibility and counterfactual evidence (W2-004; LAB.md
 * "Simulation and replay"; INV-L02/P03; AGENTS.md rule 8 — recorded
 * production facts are never rewritten).
 */

const BASE_PROGRAM: SimulationProgram = {
  programId: "replay.base",
  programVersion: "1.0.0",
  routePreference: ["rail-a", "rail-b"],
  useNetting: false,
  useNetworkCredit: false,
  delayToleranceSteps: 0,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
};

const VARIANT_PROGRAM: SimulationProgram = {
  programId: "replay.variant",
  programVersion: "1.0.0",
  routePreference: ["rail-b", "rail-a"],
  useNetting: true,
  useNetworkCredit: true,
  delayToleranceSteps: 2,
  fraudScreening: true,
  privacyBounded: true,
  authorizationMode: "PROTOCOL_AUTHORIZED",
};

function makeFacts(): RecordedProductionFacts {
  return recordProductionFacts({
    factsId: "facts-2026-09-30",
    description: "observed production demand on a busy afternoon",
    rails: [
      {
        railId: "rail-a",
        currency: "EUR",
        latencyMs: 400,
        fixedFeeMinor: 25n,
        variableFeeBps: 10n,
      },
      {
        railId: "rail-b",
        currency: "EUR",
        latencyMs: 350,
        fixedFeeMinor: 40n,
        variableFeeBps: 8n,
      },
    ],
    pools: [
      { poolId: "pool-a", railId: "rail-a", availableMinor: 1_000_000n },
      { poolId: "pool-b", railId: "rail-b", availableMinor: 1_000_000n },
    ],
    stepLatencyMs: 250,
    demands: [
      {
        demandId: "prod-demand-1",
        observedAtMs: 0,
        amountMinor: 120_000n,
        currency: "EUR",
        direction: "OUTBOUND",
        deadlineMs: 30_000,
      },
      {
        demandId: "prod-demand-2",
        observedAtMs: 600,
        amountMinor: 80_000n,
        currency: "EUR",
        direction: "INBOUND",
        deadlineMs: 30_000,
      },
      {
        demandId: "prod-demand-3",
        observedAtMs: 1_200,
        amountMinor: 50_000n,
        currency: "EUR",
        direction: "OUTBOUND",
        deadlineMs: 30_000,
        adversarial: "FRAUD",
      },
    ],
    incidents: [],
  });
}

function snapshot(value: unknown): string {
  return JSON.stringify(value, (_, inner) =>
    typeof inner === "bigint" ? `bigint:${inner.toString()}` : inner,
  );
}

describe("recorded production facts (LAB.md: replay never rewrites them)", () => {
  it("recording digests and freezes the fact set", () => {
    const facts = makeFacts();
    expect(facts.factsDigest).toBe(recordedFactsDigest(facts));
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.demands)).toBe(true);
  });

  it("mutation attempts on a recorded fact set throw (immutable history)", () => {
    const facts = makeFacts();
    expect(() => {
      (facts as { demands: unknown }).demands = [];
    }).toThrow();
  });

  it("recomputing the digest over identical content is stable", () => {
    expect(recordedFactsDigest(makeFacts())).toBe(recordedFactsDigest(makeFacts()));
  });
});

describe("deterministic replay (INV-P03 discipline)", () => {
  it("same facts + program + seed → identical replay results", () => {
    const replayA = runReplay({
      facts: makeFacts(),
      program: BASE_PROGRAM,
      seed: "replay-seed",
      stepMs: 250,
    });
    const replayB = runReplay({
      facts: makeFacts(),
      program: BASE_PROGRAM,
      seed: "replay-seed",
      stepMs: 250,
    });
    expect(replayA).toEqual(replayB);
    expect(replayA.digest).toBe(replayB.digest);
  });

  it("replay results are namespaced Lab artifacts (INV-L01)", () => {
    const replay = runReplay({
      facts: makeFacts(),
      program: BASE_PROGRAM,
      seed: "replay-seed",
      stepMs: 250,
    });
    expect(replay.namespace).toBe(REPLAY_NAMESPACE);
    expect(isReplayResult(replay)).toBe(true);
    expect(isReplayResult({})).toBe(false);
  });

  it("replay uses the recorded facts WITHOUT rewriting them", () => {
    const facts = makeFacts();
    const before = snapshot(facts);
    runReplay({ facts, program: BASE_PROGRAM, seed: "replay-seed", stepMs: 250 });
    runCounterfactual({
      facts,
      baseProgram: BASE_PROGRAM,
      variantProgram: VARIANT_PROGRAM,
      seed: "replay-seed",
      stepMs: 250,
    });
    expect(snapshot(facts)).toBe(before);
    expect(facts.factsDigest).toBe(recordedFactsDigest(facts));
  });

  it("a tampered fact set (digest mismatch) is rejected", () => {
    const facts = makeFacts();
    const forged: RecordedProductionFacts = {
      ...facts,
      demands: [
        ...facts.demands,
        {
          demandId: "prod-demand-forged",
          observedAtMs: 5_000,
          amountMinor: 999_999n,
          currency: "EUR",
          direction: "OUTBOUND",
          deadlineMs: 30_000,
        },
      ],
    };
    expect(() =>
      runReplay({ facts: forged, program: BASE_PROGRAM, seed: "s", stepMs: 250 }),
    ).toThrow(/digest mismatch/);
  });

  it("the recorded adversarial demand is screened by the base program", () => {
    const replay = runReplay({
      facts: makeFacts(),
      program: BASE_PROGRAM,
      seed: "replay-seed",
      stepMs: 250,
    });
    expect(replay.run.metrics.blockedAdversarial).toBe(1);
    expect(replay.run.metrics.adversarialSettled).toBe(0);
  });
});

describe("counterfactual evidence (INV-L02)", () => {
  it("re-runs the SAME facts under a variant program and reports exact deltas", () => {
    const facts = makeFacts();
    const counterfactual = runCounterfactual({
      facts,
      baseProgram: BASE_PROGRAM,
      variantProgram: VARIANT_PROGRAM,
      seed: "replay-seed",
      stepMs: 250,
    });
    expect(counterfactual.base.factsDigest).toBe(counterfactual.variant.factsDigest);
    expect(counterfactual.base.factsId).toBe(counterfactual.variant.factsId);
    // Both branches are namespaced replays of the same fact set.
    expect(isReplayResult(counterfactual.base)).toBe(true);
    expect(isReplayResult(counterfactual.variant)).toBe(true);
    // The delta is an exact integer difference, not a float ratio.
    expect(typeof counterfactual.delta.feesMinor).toBe("bigint");
    expect(counterfactual.delta.externalValueMovedMinor).toBe(
      counterfactual.variant.run.metrics.externalValueMovedMinor -
        counterfactual.base.run.metrics.externalValueMovedMinor,
    );
  });

  it("the counterfactual is deterministic for identical inputs", () => {
    const run = (): ReturnType<typeof runCounterfactual> =>
      runCounterfactual({
        facts: makeFacts(),
        baseProgram: BASE_PROGRAM,
        variantProgram: VARIANT_PROGRAM,
        seed: "replay-seed",
        stepMs: 250,
      });
    expect(run()).toEqual(run());
  });

  it("a variant that changes behavior produces a non-zero delta", () => {
    const counterfactual = runCounterfactual({
      facts: makeFacts(),
      baseProgram: BASE_PROGRAM,
      variantProgram: VARIANT_PROGRAM,
      seed: "replay-seed",
      stepMs: 250,
    });
    // The variant routes rail-b first (fees differ) and nets the matching
    // flows (external movement differs).
    const deltaNonZero =
      counterfactual.delta.feesMinor !== 0n ||
      counterfactual.delta.externalValueMovedMinor !== 0n;
    expect(deltaNonZero).toBe(true);
  });
});
