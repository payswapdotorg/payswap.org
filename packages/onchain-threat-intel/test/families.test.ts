import { describe, expect, it } from "vitest";
import {
  THREAT_FAMILIES,
  THREAT_FAMILY_DESCRIPTIONS,
  THREAT_SEVERITIES,
  advisorySeverityFor,
  familySignalClass,
  isThreatFamily,
  isThreatSeverity,
  threatSeverityRank,
} from "../src/index.js";
import { ValidationError } from "@payswap/protocol";
import { assertThreatFamilySeverity } from "../src/index.js";

describe("threat family vocabulary", () => {
  it("defines EXACTLY the 13 task-packet families, in packet order", () => {
    expect(THREAT_FAMILIES).toEqual([
      "malicious_approval_permit",
      "unexpected_spender",
      "token_impersonation",
      "honeypot_transfer_restriction",
      "proxy_admin_change",
      "oracle_manipulation",
      "bridge_compromise",
      "mev_sandwich_exposure",
      "destination_chain_confusion",
      "replay_signature_domain",
      "unexpected_balance_delta",
      "stale_changed_simulation",
      "finality_reorg_anomaly",
    ]);
  });

  it("every family has a description and a namespaced signal class", () => {
    for (const family of THREAT_FAMILIES) {
      expect(THREAT_FAMILY_DESCRIPTIONS[family].length).toBeGreaterThan(20);
      expect(familySignalClass(family)).toBe(`onchain_threat.${family}`);
    }
  });

  it("isThreatFamily rejects unknown values", () => {
    expect(isThreatFamily("malicious_approval_permit")).toBe(true);
    expect(isThreatFamily("definitely_not_a_family")).toBe(false);
    expect(isThreatFamily(42)).toBe(false);
  });

  it("severity rank is a strict total order", () => {
    const ranks = THREAT_SEVERITIES.map(threatSeverityRank);
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });

  it("advisorySeverityFor maps info→low and keeps the rest", () => {
    expect(advisorySeverityFor("info")).toBe("low");
    expect(advisorySeverityFor("low")).toBe("low");
    expect(advisorySeverityFor("medium")).toBe("medium");
    expect(advisorySeverityFor("high")).toBe("high");
    expect(advisorySeverityFor("critical")).toBe("critical");
  });

  it("assertThreatFamilySeverity fails closed on unknown vocabulary", () => {
    expect(() =>
      assertThreatFamilySeverity("not_a_family" as never, "high"),
    ).toThrow(ValidationError);
    expect(() =>
      assertThreatFamilySeverity("oracle_manipulation", "ultra" as never),
    ).toThrow(ValidationError);
    expect(() =>
      assertThreatFamilySeverity("oracle_manipulation", "high"),
    ).not.toThrow();
    expect(isThreatSeverity("low")).toBe(true);
  });
});
