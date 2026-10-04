import { describe, expect, it } from "vitest";
import { discoverOpportunity, resolveOpportunity, resolveOpportunities } from "../src/index.js";
import {
  CHAIN,
  MAX_AGE_MS,
  NOW,
  discoveryCatalog,
  healthyArbitrageObservation,
  healthyLiquidityObservation,
  staleQuoteObservation,
} from "./fixtures.js";

/**
 * P4-W3-002 hard requirement 3 (the observation law): provenance/evidence is
 * preserved — every opportunity carries its evidence chain (which
 * venue/protocol observed, at what freshness, through which adapter), and
 * stale observations are invalidated DETERMINISTICALLY at read time.
 */
describe("P4-W3-002 the observation law (freshness, provenance, invalidation)", () => {
  it("the evidence chain is preserved verbatim: venue, protocol, chain, adapter, observer, refs", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(opportunity.provenance.observationId).toBe("obs:liq:001");
    expect(opportunity.provenance.venueId).toBe("venue:stable-pair");
    expect(opportunity.provenance.protocolKey).toBe("protocol:amm-v2");
    expect(opportunity.provenance.chainKey).toBe(CHAIN);
    expect(opportunity.provenance.adapterId).toBe("adapter:onchain:evm");
    expect(opportunity.provenance.observerId).toBe("observer:indexer:001");
    expect([...opportunity.provenance.evidenceRefs]).toEqual([
      "evidence:pool-state:001",
      "evidence:fee-tier:001",
    ]);
    expect(opportunity.evidenceFreshness).toEqual({ asOfMs: NOW, maxAgeMs: MAX_AGE_MS });
  });

  it("staleness is deterministic with an INCLUSIVE freshness bound (best-execution semantics)", () => {
    // Evidence exactly maxAgeMs old is STILL fresh at the instant.
    const exactlyAgedInput = {
      ...healthyLiquidityObservation({ observationId: "obs:liq:boundary" }),
      freshness: { asOfMs: NOW - MAX_AGE_MS, maxAgeMs: MAX_AGE_MS },
    };
    const atBoundary = discoverOpportunity(exactlyAgedInput, NOW);
    expect(resolveOpportunity(atBoundary, NOW).status).toBe("CURRENT");
    expect(atBoundary.policyEligibility.eligible).toBe(true);

    // One millisecond later it is stale — deterministic, no grace, no guess.
    expect(resolveOpportunity(atBoundary, NOW + 1).status).toBe("STALE");
  });

  it("a stale observation is INVALIDATED at read time: eligibility forced false with the reason", () => {
    const opportunity = discoverOpportunity(staleQuoteObservation(), NOW);
    const resolution = resolveOpportunity(opportunity, NOW);
    expect(resolution.status).toBe("STALE");
    if (resolution.status === "STALE") {
      expect(resolution.reason).toBe("STALE_OBSERVATION");
      expect(resolution.invalidatedAt).toBe(NOW);
      expect(resolution.policy.eligible).toBe(false);
      expect(resolution.policy.reasons).toContain("STALE_OBSERVATION");
    }
  });

  it("invalidation preserves the FULL evidence chain (which observation went stale is visible)", () => {
    const opportunity = discoverOpportunity(staleQuoteObservation(), NOW);
    const resolution = resolveOpportunity(opportunity, NOW);
    // The stale record is carried through verbatim — never dropped, never
    // repaired, never silently re-observed.
    expect(resolution.opportunity.opportunityId).toBe(opportunity.opportunityId);
    expect(resolution.opportunity.provenance.observationId).toBe("obs:liq:stale-001");
    expect(resolution.opportunity.provenance.venueId).toBe("venue:stable-pair");
    expect(resolution.opportunity.evidenceFreshness.asOfMs).toBe(NOW - (MAX_AGE_MS + 30_000));
  });

  it("a CURRENT resolution re-derives the policy from the typed fields (defense in depth)", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    const resolution = resolveOpportunity(opportunity, NOW);
    expect(resolution.status).toBe("CURRENT");
    if (resolution.status === "CURRENT") {
      expect(resolution.policy.eligible).toBe(true);
      expect(resolution.policy.evaluatedAt).toBe(NOW);
    }
  });

  it("an arbitrage leg going stale invalidates the WHOLE opportunity (one stale side voids the spread)", () => {
    const input = healthyArbitrageObservation();
    const legs = input.arbitrageLegs ?? [];
    const staleLegInput = {
      ...input,
      observationId: "obs:arb:stale-leg",
      arbitrageLegs: [
        legs[0] as typeof legs[number],
        {
          ...(legs[1] as typeof legs[number]),
          freshness: { asOfMs: NOW - (MAX_AGE_MS + 1), maxAgeMs: MAX_AGE_MS },
        },
      ],
    };
    const opportunity = discoverOpportunity(staleLegInput, NOW);
    // The opportunity's OWN evidence is fresh — but one leg is stale.
    expect(opportunity.evidenceFreshness.asOfMs).toBe(NOW);
    const resolution = resolveOpportunity(opportunity, NOW);
    expect(resolution.status).toBe("STALE");
    if (resolution.status === "STALE") {
      expect(resolution.reason).toBe("STALE_OBSERVATION");
    }
  });

  it("batch resolution is order-preserving and deterministic", () => {
    const opportunities = discoveryCatalog().map((entry) =>
      discoverOpportunity(entry.input, NOW),
    );
    const resolutions = resolveOpportunities(opportunities, NOW);
    expect(resolutions).toHaveLength(opportunities.length);
    for (let index = 0; index < opportunities.length; index += 1) {
      expect(resolutions[index]?.opportunity.opportunityId).toBe(
        opportunities[index]?.opportunityId,
      );
    }
    expect(resolveOpportunities(opportunities, NOW)).toEqual(
      resolveOpportunities(opportunities, NOW),
    );
  });

  it("the resolution instant is caller-supplied (no ambient clock)", () => {
    const opportunity = discoverOpportunity(healthyLiquidityObservation(), NOW);
    expect(() => resolveOpportunity(opportunity, -1)).toThrow(RangeError);
    expect(() => resolveOpportunity(opportunity, 1.5)).toThrow(RangeError);
  });

  it("every stale catalog entry resolves STALE; every healthy entry resolves CURRENT", () => {
    for (const entry of discoveryCatalog()) {
      const opportunity = discoverOpportunity(entry.input, NOW);
      const resolution = resolveOpportunity(opportunity, NOW);
      const expected = entry.label.includes("stale") ? "STALE" : "CURRENT";
      expect(resolution.status, entry.label).toBe(expected);
    }
  });
});
