import { describe, expect, it } from "vitest";
import {
  ECB_REFERENCE_RATES_URL,
  EcbReferenceFxSource,
  buildEcbQuote,
} from "../../src/fx-source.js";
import { CLOCK } from "../fixtures.js";

/**
 * LIVE network suite (run explicitly: `npm run test:live`). Contacts the
 * REAL public ECB daily reference-rates feed — the reference FX source.
 * Read-only GET; no credentials; no fabricated rates: staleness and
 * unreachability both yield UNKNOWN with provenance retained (INV-F09).
 */
describe("FX source — LIVE ECB reference rates (read-only)", () => {
  const source = new EcbReferenceFxSource({ clock: CLOCK });
  const NOW = BigInt(Date.now());

  it("fetches the current reference document from the real feed", async () => {
    const document = await source.fetchReferenceRates();
    expect(document.endpoint).toBe(ECB_REFERENCE_RATES_URL);
    expect(document.publisher).toBe("European Central Bank");
    expect(document.publicationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(document.rates.size).toBeGreaterThanOrEqual(20);
    expect(document.rates.get("USD")).toBeDefined();
    // Exact rationals, not floats (INV-F01).
    expect(document.rates.get("USD")?.numerator).toBeTypeOf("bigint");
    expect(document.rates.get("USD")?.denominator).toBeTypeOf("bigint");
  });

  it("health reports HEALTHY against the real feed", async () => {
    const report = await source.health();
    expect(report.status).toBe("HEALTHY");
  });

  it("availability observation is AVAILABLE through the live probe (INV-C01/C02)", async () => {
    const observation = await source.availabilityObservation({
      instanceId: "inst-rails-fx-live-1",
      observationVersion: 1,
    });
    expect(observation.sourceAvailability).toBe("REACHABLE");
    expect(observation.availability).toBe("AVAILABLE");
  });

  it("quotes USD→JPY from the live feed with full INV-F09 provenance — or UNKNOWN with provenance retained", async () => {
    const result = await source.quote({ base: "USD", quote: "JPY", now: NOW });
    if (result.status === "QUOTE") {
      const quote = result.quote;
      expect(quote.pair.base).toBe("USD");
      expect(quote.pair.quote).toBe("JPY");
      expect(quote.rate.numerator).toBeGreaterThan(0n);
      expect(quote.rate.denominator).toBeGreaterThan(0n);
      expect(quote.provenance.rateSource).toContain("European Central Bank");
      expect(quote.provenance.rateSourceRef).toContain("ecb-daily:");
      expect(quote.provenance.rateSourceRef).toContain(ECB_REFERENCE_RATES_URL);
      expect(quote.expiresAt).toBeGreaterThan(NOW);
    } else {
      // A stale reference (weekend boundary) is UNKNOWN — never a fabricated
      // rate — and the provenance of the observation is RETAINED.
      expect(["STALE", "UNREACHABLE", "REFERENCE_AHEAD_OF_CLOCK"]).toContain(result.reason);
      expect(result.provenance.rateSource).toContain("ecb");
      expect(result.provenance.attemptedAt).toBeDefined();
    }
  });

  it("builds an exact, provenanced quote from the live document deterministically", async () => {
    const document = await source.fetchReferenceRates();
    const built = buildEcbQuote(document, {
      base: "EUR",
      quote: "USD",
      now: NOW,
      spread: {
        basisPoints: 50n,
        disclosedBy: "payswap:rails:live-test",
        reference: "live-spread-disclosure:1",
      },
    });
    if (built.status === "QUOTE") {
      expect(built.quote.provenance.spread?.basisPoints).toBe(50n);
      expect(built.quote.provenance.spread?.reference).toBe("live-spread-disclosure:1");
      // EUR→USD is the direct published rate.
      expect(built.quote.rate.numerator).toBe(document.rates.get("USD")?.numerator);
      expect(built.quote.rate.denominator).toBe(document.rates.get("USD")?.denominator);
    } else {
      expect(built.reason).toBe("STALE");
      expect(built.provenance.rateSourceRef).toContain("ecb-daily:");
    }
  });
});
