import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import type { SettlementAttemptState, SettlementAttemptEvent } from "@payswap/settlement";
import { settlementAttemptStateMachine } from "@payswap/settlement";
import {
  onchainRailId,
  mapObservationToRailOutcome,
  settlementAttemptEventCandidate,
  mapToRailOperation,
  validateOnchainSettlementLinkage,
  observationPermitsFinalityDeclaration,
} from "../src/settlement-mapping.js";
import {
  broadcastObservation,
  confirmedObservation,
  unknownObservation,
  failedObservation,
  ETHEREUM_CHAIN_KEY,
} from "./fixtures.js";

describe("deterministic rail identity (onchain rails are rail-family members)", () => {
  it("derives the canonical onchain rail id", () => {
    expect(onchainRailId("ethereum:mainnet")).toBe("onchain.ethereum:mainnet");
    expect(onchainRailId("solana:mainnet-beta")).toBe("onchain.solana:mainnet-beta");
  });

  it("rejects non-canonical chain keys", () => {
    expect(() => onchainRailId("Ethereum")).toThrow(ValidationError);
  });
});

describe("observation → rail outcome mapping (deterministic, UNKNOWN-preserving)", () => {
  it("BROADCAST maps to a PENDING rail effect — submitted is not finality (rule 29)", () => {
    const outcome = mapObservationToRailOutcome(broadcastObservation());
    expect(outcome.kind).toBe("RAIL_EFFECT_PENDING");
    if (outcome.kind === "RAIL_EFFECT_PENDING") {
      expect(outcome.submittedNotFinal).toBe(true);
    }
    expect(outcome.evidenceRefs).toContain("evidence:broadcast:001");
  });

  it("CONFIRMED maps to an OBSERVED rail effect that is a finality CANDIDATE ONLY (INV-F06)", () => {
    const outcome = mapObservationToRailOutcome(confirmedObservation());
    expect(outcome.kind).toBe("RAIL_EFFECT_OBSERVED");
    if (outcome.kind === "RAIL_EFFECT_OBSERVED") {
      expect(outcome.finalityCandidateOnly).toBe(true);
    }
  });

  it("FAILED maps to a FAILED rail effect carrying the failure descriptor", () => {
    const outcome = mapObservationToRailOutcome(failedObservation());
    expect(outcome.kind).toBe("RAIL_EFFECT_FAILED");
    if (outcome.kind === "RAIL_EFFECT_FAILED") {
      expect(outcome.failure.failureClass).toBe("REVERTED");
    }
  });

  it("OUTCOME_UNKNOWN maps to an UNKNOWN rail effect that REQUIRES reconciliation", () => {
    const outcome = mapObservationToRailOutcome(unknownObservation());
    expect(outcome.kind).toBe("RAIL_EFFECT_UNKNOWN");
    if (outcome.kind === "RAIL_EFFECT_UNKNOWN") {
      expect(outcome.requiresReconciliation).toBe(true);
      expect(outcome.reason).toMatch(/unknown whether the operation reached the chain/);
    }
  });

  it("the mapping never converts UNKNOWN into FAILED or success (INV-X01)", () => {
    for (const observation of [
      broadcastObservation(),
      confirmedObservation(),
      unknownObservation(),
      failedObservation(),
    ]) {
      const outcome = mapObservationToRailOutcome(observation);
      if (observation.outcome === "OUTCOME_UNKNOWN") {
        expect(outcome.kind).toBe("RAIL_EFFECT_UNKNOWN");
      }
      if (observation.outcome === "FAILED") {
        expect(outcome.kind).toBe("RAIL_EFFECT_FAILED");
      }
    }
  });

  it("an invalid observation fails the mapping (fail closed)", () => {
    expect(() => mapObservationToRailOutcome({} as never)).toThrow(ValidationError);
  });
});

describe("observation → settlement attempt event candidates (canonical machine compatibility)", () => {
  it("the suggested events are events of the CANONICAL settlement attempt state machine", () => {
    for (const observation of [
      confirmedObservation(),
      failedObservation(),
      unknownObservation(),
    ]) {
      const candidate = settlementAttemptEventCandidate(observation);
      if (candidate.kind === "EVENT_CANDIDATE") {
        expect(settlementAttemptStateMachine.events).toContain(candidate.event);
      }
    }
  });

  it("BROADCAST suggests NO event: the attempt stays in flight (submitted is not finality)", () => {
    const candidate = settlementAttemptEventCandidate(broadcastObservation());
    expect(candidate).toEqual({ kind: "NO_EVENT", reason: "SUBMITTED_NOT_FINAL" });
  });

  it("CONFIRMED suggests CONFIRM_SUCCEEDED; FAILED suggests CONFIRM_FAILED; UNKNOWN suggests OUTCOME_UNKNOWN", () => {
    expect(settlementAttemptEventCandidate(confirmedObservation())).toEqual({
      kind: "EVENT_CANDIDATE",
      event: "CONFIRM_SUCCEEDED",
    });
    expect(settlementAttemptEventCandidate(failedObservation())).toEqual({
      kind: "EVENT_CANDIDATE",
      event: "CONFIRM_FAILED",
    });
    expect(settlementAttemptEventCandidate(unknownObservation())).toEqual({
      kind: "EVENT_CANDIDATE",
      event: "OUTCOME_UNKNOWN",
    });
  });

  it("the canonical machine transitions the suggested events from IN_FLIGHT (real integration of the mapping with the canonical machinery)", () => {
    // The mapping is only meaningful if the canonical settlement attempt
    // machine can actually consume the suggested events from the in-flight
    // state — this is the compiled-against proof for @payswap/settlement.
    expect(
      settlementAttemptStateMachine.transition("IN_FLIGHT", "CONFIRM_SUCCEEDED" as SettlementAttemptEvent).to,
    ).toBe("SUCCEEDED" satisfies SettlementAttemptState);
    expect(
      settlementAttemptStateMachine.transition("IN_FLIGHT", "CONFIRM_FAILED" as SettlementAttemptEvent).to,
    ).toBe("FAILED" satisfies SettlementAttemptState);
    expect(
      settlementAttemptStateMachine.transition("IN_FLIGHT", "OUTCOME_UNKNOWN" as SettlementAttemptEvent).to,
    ).toBe("OUTCOME_UNKNOWN" satisfies SettlementAttemptState);
    // And OUTCOME_UNKNOWN only exits via reconciliation resolution events
    // (INV-X03) — the onchain mapping never suggests a blind retry event.
    expect(() =>
      settlementAttemptStateMachine.transition("OUTCOME_UNKNOWN", "CONFIRM_SUCCEEDED" as SettlementAttemptEvent),
    ).toThrow();
    expect(
      settlementAttemptStateMachine.transition("OUTCOME_UNKNOWN", "RECONCILE_RESOLVED_SUCCEEDED" as SettlementAttemptEvent).to,
    ).toBe("SUCCEEDED" satisfies SettlementAttemptState);
  });
});

describe("observation → RailOperation mapping records (canonical linkage)", () => {
  it("constructs a canonical mapping record referencing the settlement machinery", () => {
    const mapping = mapToRailOperation({
      observation: unknownObservation(),
      settlementInstructionId: "settle:instruction:001",
      settlementAttemptId: "settle:attempt:001",
    });
    expect(mapping.mappingKind).toBe("OBSERVATION_TO_RAIL_OPERATION");
    expect(mapping.railId).toBe(`onchain.${ETHEREUM_CHAIN_KEY}`);
    expect(mapping.settlementInstructionId).toBe("settle:instruction:001");
    expect(mapping.settlementAttemptId).toBe("settle:attempt:001");
    expect(mapping.outcome.kind).toBe("RAIL_EFFECT_UNKNOWN");
  });

  it("requires canonical settlement references (no orphan rail operations)", () => {
    expect(() =>
      mapToRailOperation({
        observation: broadcastObservation(),
        settlementInstructionId: "",
        settlementAttemptId: "settle:attempt:001",
      }),
    ).toThrow(/settlementInstructionId is required/);
    expect(() =>
      mapToRailOperation({
        observation: broadcastObservation(),
        settlementInstructionId: "settle:instruction:001",
        settlementAttemptId: "",
      }),
    ).toThrow(/settlementAttemptId is required/);
  });
});

describe("settlement linkage validation (finality referenced, never declared)", () => {
  it("validates a canonical linkage", () => {
    const linkage = validateOnchainSettlementLinkage(
      {
        settlementInstructionId: "settle:instruction:001",
        settlementAttemptId: "settle:attempt:001",
        railId: onchainRailId(ETHEREUM_CHAIN_KEY),
      },
      ETHEREUM_CHAIN_KEY,
    );
    expect(linkage.railId).toBe("onchain.ethereum:mainnet");
  });

  it("enforces the deterministic rail id for the known chain", () => {
    expect(() =>
      validateOnchainSettlementLinkage(
        {
          settlementInstructionId: "settle:instruction:001",
          settlementAttemptId: "settle:attempt:001",
          railId: "some:other:rail",
        },
        ETHEREUM_CHAIN_KEY,
      ),
    ).toThrow(/deterministic/);
  });

  it("an observation NEVER permits finality declaration on its own (INV-F06)", () => {
    expect(observationPermitsFinalityDeclaration(confirmedObservation())).toBe(false);
    expect(observationPermitsFinalityDeclaration(broadcastObservation())).toBe(false);
  });
});
