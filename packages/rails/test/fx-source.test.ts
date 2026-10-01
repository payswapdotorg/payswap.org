import { describe, expect, it } from "vitest";
import { convert, exactConversion, fromMinorUnits, USD } from "@payswap/protocol";
import {
  ECB_REFERENCE_RATES_URL,
  EcbReferenceFxSource,
  buildEcbQuote,
  crossRateFromReferenceRates,
  parseEcbReferenceRatesXml,
} from "../src/fx-source.js";
import type { ReferenceRateDocument } from "../src/fx-source.js";
import { CLOCK, ScriptedHttpTransport } from "./fixtures.js";

/** A trimmed but faithful ECB reference-rates XML fixture (offline). */
const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
\t<gesmes:subject>Reference rates</gesmes:subject>
\t<gesmes:Sender>
\t\t<gesmes:name>European Central Bank</gesmes:name>
\t</gesmes:Sender>
\t<Cube>
\t\t<Cube time='2026-09-30'>
\t\t\t<Cube currency='USD' rate='1.1355'/>
\t\t\t<Cube currency='JPY' rate='162.12'/>
\t\t\t<Cube currency='GBP' rate='0.8412'/>
\t\t\t<Cube currency='ZAR' rate='19.3520'/>
\t\t</Cube>
\t</Cube>
</gesmes:Envelope>`;

const DOCUMENT: ReferenceRateDocument = parseEcbReferenceRatesXml(ECB_XML);

/** Fresh evaluation time: 2026-09-30T12:00:00Z. */
const NOW = BigInt(Date.parse("2026-09-30T12:00:00.000Z"));

describe("FX source — exact parsing (INV-F01)", () => {
  it("parses the publication date and exact rational rates from decimal strings", () => {
    expect(DOCUMENT.publicationDate).toBe("2026-09-30");
    expect(DOCUMENT.publisher).toBe("European Central Bank");
    expect(DOCUMENT.endpoint).toBe(ECB_REFERENCE_RATES_URL);
    // 1.1355 = 11355/10000 exactly — never a float.
    expect(DOCUMENT.rates.get("USD")).toEqual({ numerator: 11355n, denominator: 10000n });
    expect(DOCUMENT.rates.get("JPY")).toEqual({ numerator: 16212n, denominator: 100n });
    expect(DOCUMENT.rates.get("GBP")).toEqual({ numerator: 8412n, denominator: 10000n });
  });

  it("rejects malformed documents", () => {
    expect(() => parseEcbReferenceRatesXml("")).toThrow();
    expect(() => parseEcbReferenceRatesXml("<Cube></Cube>")).toThrow();
  });

  it("computes EXACT cross rates by bigint cross-multiplication", () => {
    // USD→JPY = (EUR→JPY) / (EUR→USD) = (16212/100) / (11355/10000)
    //        = (16212 · 10000) / (100 · 11355)
    const usdJpy = crossRateFromReferenceRates(DOCUMENT, "USD", "JPY");
    expect(usdJpy.numerator).toBe(16212n * 10000n);
    expect(usdJpy.denominator).toBe(100n * 11355n);
    // EUR legs resolve directly; inverse legs invert.
    expect(crossRateFromReferenceRates(DOCUMENT, "EUR", "USD")).toEqual({
      numerator: 11355n,
      denominator: 10000n,
    });
    expect(crossRateFromReferenceRates(DOCUMENT, "USD", "EUR")).toEqual({
      numerator: 10000n,
      denominator: 11355n,
    });
  });
});

describe("FX source — quote provenance (INV-F09)", () => {
  it("builds a quote with publisher, reference and timestamp provenance", () => {
    const result = buildEcbQuote(DOCUMENT, { base: "USD", quote: "JPY", now: NOW });
    expect(result.status).toBe("QUOTE");
    if (result.status !== "QUOTE") return;
    const quote = result.quote;
    expect(quote.pair.base).toBe("USD");
    expect(quote.pair.quote).toBe("JPY");
    expect(quote.rate.numerator).toBe(16212n * 10000n);
    expect(quote.rate.denominator).toBe(100n * 11355n);
    // INV-F09: rate provenance retained — publisher, reference, timestamp.
    expect(quote.provenance.rateSource).toContain("ecb-reference-rates");
    expect(quote.provenance.rateSource).toContain("European Central Bank");
    expect(quote.provenance.rateSourceRef).toContain("ecb-daily:2026-09-30");
    expect(quote.provenance.rateSourceRef).toContain(ECB_REFERENCE_RATES_URL);
    // Conservative observation timestamp: start of the publication day.
    expect(quote.provenance.observedAt).toBe(
      BigInt(Date.parse("2026-09-30T00:00:00.000Z")),
    );
    // The quote converts EXACTLY (INV-F01): USD 113.55 (minor 11355) is
    // exactly JPY 1621200 minor units under this rate — a hand-computed
    // exact case (rounding is protocol-owned and tested there).
    const converted = convert(fromMinorUnits(USD, 11355n), quote, NOW);
    expect(converted.currency).toBe("JPY");
    expect(converted.value).toBe(1621200n);
    const exact = exactConversion(fromMinorUnits(USD, 10000n), quote);
    expect(exact.numerator).toBe(10000n * 16212n * 10000n);
    expect(exact.denominator).toBe(100n * 11355n);
  });

  it("discloses spread and fee with their own provenance (INV-F09)", () => {
    const result = buildEcbQuote(DOCUMENT, {
      base: "EUR",
      quote: "USD",
      now: NOW,
      spread: { basisPoints: 75n, disclosedBy: "payswap:operator:1", reference: "spread-policy:2026-10" },
      fee: { amountMinor: 25n, currency: "USD", disclosedBy: "payswap:operator:1", reference: "fee-schedule:2026-10" },
    });
    expect(result.status).toBe("QUOTE");
    if (result.status !== "QUOTE") return;
    expect(result.quote.provenance.spread?.basisPoints).toBe(75n);
    expect(result.quote.provenance.spread?.disclosedBy).toBe("payswap:operator:1");
    expect(result.quote.provenance.spread?.reference).toBe("spread-policy:2026-10");
    expect(result.quote.provenance.fee?.amount.value).toBe(25n);
    expect(result.quote.provenance.fee?.amount.currency).toBe("USD");
    expect(result.quote.provenance.fee?.disclosedBy).toBe("payswap:operator:1");
  });
});

describe("FX source — staleness and unreachability → UNKNOWN (provenance retained)", () => {
  it("returns UNKNOWN STALE with the observation provenance RETAINED when the reference is too old", () => {
    // 2026-10-15 is far beyond the default 96h window for a 2026-09-30
    // publication.
    const late = BigInt(Date.parse("2026-10-15T12:00:00.000Z"));
    const result = buildEcbQuote(DOCUMENT, { base: "USD", quote: "JPY", now: late });
    expect(result.status).toBe("UNKNOWN");
    if (result.status !== "UNKNOWN") return;
    expect(result.reason).toBe("STALE");
    // INV-F09: provenance retained on the refusal — never silently dropped.
    expect(result.provenance.rateSourceRef).toContain("ecb-daily:2026-09-30");
    expect(result.provenance.observedAt).toBeDefined();
    expect(result.provenance.attemptedAt).toBeDefined();
  });

  it("returns UNKNOWN PAIR_NOT_PUBLISHED with provenance when a leg is not in the reference feed", () => {
    const result = buildEcbQuote(DOCUMENT, { base: "KES", quote: "JPY", now: NOW });
    expect(result.status).toBe("UNKNOWN");
    if (result.status !== "UNKNOWN") return;
    expect(result.reason).toBe("PAIR_NOT_PUBLISHED");
    expect(result.provenance.rateSourceRef).toContain("ecb-daily:2026-09-30");
  });

  it("returns UNKNOWN REFERENCE_AHEAD_OF_CLOCK when the publication is ahead of now", () => {
    const early = BigInt(Date.parse("2026-09-29T00:00:00.000Z"));
    const result = buildEcbQuote(DOCUMENT, { base: "USD", quote: "JPY", now: early });
    expect(result.status).toBe("UNKNOWN");
    if (result.status !== "UNKNOWN") return;
    expect(result.reason).toBe("REFERENCE_AHEAD_OF_CLOCK");
  });

  it("returns UNKNOWN UNREACHABLE with attempt provenance when the feed cannot be contacted", async () => {
    const transport = new ScriptedHttpTransport(() => {
      throw new Error("network down");
    });
    const source = new EcbReferenceFxSource({ clock: CLOCK, http: transport.transport });
    const result = await source.quote({ base: "USD", quote: "JPY", now: NOW });
    expect(result.status).toBe("UNKNOWN");
    if (result.status !== "UNKNOWN") return;
    expect(result.reason).toBe("UNREACHABLE");
    expect(result.provenance.rateSource).toContain("ecb");
    expect(result.provenance.rateSourceRef).toBe(ECB_REFERENCE_RATES_URL);
    // Availability follows (INV-C01/C02) — UNKNOWN, never routable.
    const observation = await source.availabilityObservation({
      instanceId: "inst-rails-fx-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(source.railImplication(observation.availability).routable).toBe(false);
    expect((await source.health()).status).toBe("UNKNOWN");
  });

  it("quotes through the source when the feed answers, and is HEALTHY + AVAILABLE", async () => {
    const transport = new ScriptedHttpTransport((url) => {
      expect(url).toBe(ECB_REFERENCE_RATES_URL);
      return { status: 200, bodyText: ECB_XML };
    });
    const source = new EcbReferenceFxSource({ clock: CLOCK, http: transport.transport });
    const result = await source.quote({ base: "USD", quote: "JPY", now: NOW });
    expect(result.status).toBe("QUOTE");
    const observation = await source.availabilityObservation({
      instanceId: "inst-rails-fx-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("AVAILABLE");
    expect(source.railImplication(observation.availability).routable).toBe(true);
    expect((await source.health()).status).toBe("HEALTHY");
  });

  it("propagates a malformed feed as UNKNOWN MALFORMED_REFERENCE (never a fabricated quote)", async () => {
    const transport = new ScriptedHttpTransport(() => ({ status: 200, bodyText: "garbage" }));
    const source = new EcbReferenceFxSource({ clock: CLOCK, http: transport.transport });
    // A 200 with a non-document body means NO reference was obtained — the
    // quote is UNKNOWN with the attempt provenance, never a fabricated rate.
    const result = await source.quote({ base: "USD", quote: "JPY", now: NOW });
    expect(result.status).toBe("UNKNOWN");
    if (result.status !== "UNKNOWN") return;
    expect(result.reason).toBe("MALFORMED_REFERENCE");
    expect(result.provenance.rateSourceRef).toBe(ECB_REFERENCE_RATES_URL);
  });
});
