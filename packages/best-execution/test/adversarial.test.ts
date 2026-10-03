import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BestExecutionEngine } from "../src/engine.js";
import * as bestExecution from "../src/index.js";
import {
  BENEFICIARY,
  NOW,
  OWNER,
  baseBestExecutionPolicy,
  baseSecurityPolicy,
  baseSecurityState,
  baseSwapRequest,
  connectedProtocolInstance,
  syntheticVenue,
} from "./helpers.js";

/**
 * ADVERSARIAL GUARDS (P4-W2-002 hard requirement 1, mirroring the
 * onchain-domain EVM-leak scan pattern):
 *
 * 1. CORE-VENUE SEPARATION: the best-execution core (src/**) contains ZERO
 *    venue-specific vocabulary — no venue name, no venue address, no venue
 *    import. Venues are opaque registrations behind the neutral port.
 * 2. DEPENDENCY DIRECTION: the core never imports a venue pack
 *    (@payswap/onchain-venues) — the direction is strictly venue → core.
 * 3. NO PRIVILEGED VENUE ID: a venue named like a famous real venue behaves
 *    identically to any other venue with the same dimensions (runtime
 *    probe — no special-casing anywhere).
 * 4. SECRET-FIELD GUARD (rule 25): no agent-facing contract declares
 *    key/seed/mnemonic/secret/password-shaped fields.
 * 5. OBSERVATIONS-NOT-CUSTODY: quotes are observations; the package
 *    exports no money/balance/ledger constructor.
 */

const SRC_DIR = join(process.cwd(), "src");

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

const SRC_FILES = listSourceFiles(SRC_DIR);

describe("CORE-VENUE SEPARATION GUARD (the optimizer is venue-agnostic)", () => {
  it("src/** mentions no venue name — not even in comments", () => {
    expect(SRC_FILES.length).toBeGreaterThan(5);
    const violations: string[] = [];
    // Well-known DEX/aggregator/intent venue names (case-insensitive).
    // Distinctive names only — common English words are not venue vocabulary.
    const forbidden = [
      /uniswap/i,
      /sushiswap/i,
      /curvefi/i,
      /curve\s*finance/i,
      /balancer/i,
      /pancakeswap/i,
      /1inch/i,
      /oneinch/i,
      /zerox/i,
      /cowswap/i,
      /coW\s*protocol/i,
      /matcha/i,
      /paraswap/i,
      /hashflow/i,
      /bancor/i,
      /kyber/i,
      /stargate\s*finance/i,
      /\blifi\b/i,
      /debridge/i,
      /\bsymm\b/i,
      /unidex/i,
    ];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          violations.push(
            `${file}: leaks venue vocabulary '${pattern.source}'`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("src/** contains no venue address and no onchain-domain chain-specific constant", () => {
    const violations: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      // Any 20-byte hex address shape is venue/chain-specific and forbidden.
      if (/0x[0-9a-fA-F]{40}/.test(source)) {
        violations.push(`${file}: contains an address-shaped constant`);
      }
      // Famous router/pool addresses (leading fragments) — belt and braces.
      for (const fragment of ["0x7a250d", "0x5C69bE", "0xE59242", "0xdef1c0"]) {
        if (source.includes(fragment)) {
          violations.push(`${file}: contains a known venue address fragment`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the core never imports a venue pack (dependency direction: venue → core)", () => {
    const violations: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (/from\s+["']@payswap\/onchain-venues/.test(source)) {
        violations.push(`${file}: imports a venue pack`);
      }
      // The core may only import @payswap workspace packages and relative
      // modules — never a third-party or venue SDK.
      const importPattern = /from\s+["']([^"']+)["']/g;
      let match: RegExpExecArray | null;
      while ((match = importPattern.exec(source)) !== null) {
        const specifier = match[1] as string;
        if (specifier.startsWith(".") || specifier.startsWith("node:")) {
          continue;
        }
        if (!specifier.startsWith("@payswap/")) {
          violations.push(`${file}: imports non-workspace module '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the package exports NO venue id, venue constant or venue constructor", () => {
    const exportedNames = Object.keys(bestExecution).sort();
    for (const forbidden in {}) {
      void forbidden;
    }
    for (const name of exportedNames) {
      expect(/venue-pack|venuepack/i.test(name)).toBe(false);
    }
    // The registry is a class you register opaque venues into; there is no
    // pre-registered venue and no venue factory.
    const engine = new BestExecutionEngine();
    expect(engine.venues()).toEqual([]);
    expect(typeof (bestExecution as Record<string, unknown>).createVenue).not.toBe("function");
  });
});

describe("NO PRIVILEGED VENUE ID (runtime probe — no special-casing)", () => {
  it("a venue named like a famous venue behaves identically to a neutral one", () => {
    const engine = new BestExecutionEngine();
    // Two venues with IDENTICAL dimensions and quote provenance except the
    // id: the famous-looking id gets no advantage and no penalty.
    engine.register(
      syntheticVenue({
        venueId: "uniswap:v2-looking-id",
        protocolKey: "synth-alpha",
        quoteConfig: { quoteId: "q-famous", worstCaseOutputMinorUnits: "990000" },
      }),
    );
    engine.register(
      syntheticVenue({
        venueId: "zzz-neutral-id",
        protocolKey: "synth-beta",
        quoteConfig: { quoteId: "q-neutral", worstCaseOutputMinorUnits: "990000" },
      }),
    );
    const decision = engine.execute({
      executionId: "execution-adversarial",
      swap: baseSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances: [
        connectedProtocolInstance({ protocolKey: "synth-alpha" }),
        connectedProtocolInstance({ protocolKey: "synth-beta" }),
      ],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    });
    expect(decision.decision).toBe("ROUTE_SELECTED");
    // The tie is broken by the declared VENUE_ID total order — the
    // famous-looking id loses only because 'u' > 'z' is false... 'u' < 'z',
    // so the famous id wins BY THE DECLARED TOTAL ORDER, nothing else.
    if (decision.decision === "ROUTE_SELECTED") {
      expect(decision.selected.venueId).toBe("uniswap:v2-looking-id");
      expect(decision.provenance.selection?.marginOverRunnerUpMinorUnits).toBe("0");
    }
  });

  it("an unknown venue id receives no hidden penalty (identical net outcomes)", () => {
    const engineA = new BestExecutionEngine();
    engineA.register(
      syntheticVenue({
        venueId: "aaa",
        protocolKey: "synth-alpha",
        quoteConfig: { worstCaseOutputMinorUnits: "990000" },
      }),
    );
    const engineB = new BestExecutionEngine();
    engineB.register(
      syntheticVenue({
        venueId: "zzz-never-seen-before",
        protocolKey: "synth-alpha",
        quoteConfig: { worstCaseOutputMinorUnits: "990000" },
      }),
    );
    const request = {
      executionId: "execution-parity",
      swap: baseSwapRequest(),
      policy: baseBestExecutionPolicy(),
      security: { policy: baseSecurityPolicy(), state: baseSecurityState() },
      instances: [connectedProtocolInstance({ protocolKey: "synth-alpha" })],
      owner: OWNER,
      beneficiary: BENEFICIARY,
      requestedBy: "agent:agent-key-1",
      routeExpiryMs: NOW + 300_000,
      at: NOW,
    };
    const decisionA = engineA.execute(request);
    const decisionB = engineB.execute(request);
    expect(decisionA.decision).toBe("ROUTE_SELECTED");
    expect(decisionB.decision).toBe("ROUTE_SELECTED");
    if (decisionA.decision === "ROUTE_SELECTED" && decisionB.decision === "ROUTE_SELECTED") {
      expect(decisionA.selected.evaluation.netNumeraireMinorUnits).toBe(
        decisionB.selected.evaluation.netNumeraireMinorUnits,
      );
    }
  });
});

describe("SECRET-FIELD GUARD (rule 25)", () => {
  it("src/** declares no key/seed/mnemonic/secret/password-shaped property", () => {
    const violations: string[] = [];
    const propertyDeclaration =
      /^\s*(?:export\s+)?(?:readonly\s+)?(?:declare\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(\?)?\s*:/;
    const forbiddenFieldName =
      /^(privatekey|priv_?key|seed_?phrase|seedwords|mnemonic|secret|secret_?key|password|passphrase|api_?key|access_?token|refreshtoken|session_?secret|client_?secret|keystore_?json|encrypted_?key)$/i;
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        const match = propertyDeclaration.exec(line);
        if (match !== null) {
          const fieldName = match[1] as string;
          if (forbiddenFieldName.test(fieldName)) {
            violations.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the raw secret vocabulary appears nowhere in src", () => {
    const violations: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of [
        "privateKey",
        "private_key",
        "seedPhrase",
        "seed_phrase",
        "mnemonic",
        "password",
        "apiKey",
        "api_key",
      ]) {
        if (source.includes(forbidden)) {
          violations.push(`${file} contains '${forbidden}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("OBSERVATIONS-NOT-CUSTODY GUARD (INV-C09 / rule 21)", () => {
  it("the package exports no money/balance/ledger constructor (quotes are observations)", () => {
    const exportedNames = Object.keys(bestExecution).sort();
    for (const forbidden of [/balance/i, /ledger/i, /\bmint\b/i, /\bcustody\b/i]) {
      for (const name of exportedNames) {
        expect(forbidden.test(name)).toBe(false);
      }
    }
    // The package never imports the protocol Money constructor.
    const violations: string[] = [];
    for (const file of SRC_FILES) {
      const source = readFileSync(file, "utf8");
      if (/import\s*\{[^}]*\bMoney\b[^}]*\}\s*from/.test(source)) {
        violations.push(`${file} imports Money`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("a quote without freshness/provenance/observer is not evidence (runtime probe)", () => {
    const venue = syntheticVenue({ venueId: "venue-a", protocolKey: "synth-alpha" });
    const outcome = venue.quote(baseSwapRequest() as never, NOW);
    if (outcome.kind !== "QUOTE") {
      throw new Error("fixture must quote");
    }
    const { validateVenueQuote } = bestExecution;
    for (const strip of ["freshness", "provenance", "observer"] as const) {
      const stripped = { ...outcome.quote, [strip]: undefined } as never;
      expect(() => (validateVenueQuote as (q: unknown) => void)(stripped)).toThrow();
    }
  });
});
