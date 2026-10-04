/**
 * @payswap/mixed-rail — the Reality Engineering Lab mixed-rail
 * extension (Work Order P4-W3-001).
 *
 * This package extends the Lab's Organization/Strategy/Capability search
 * and simulation model with certified onchain capabilities, proving
 * candidate organizations for fiat-only, onchain and mixed execution.
 *
 * Architecture (frozen-law conforming):
 * - src/** composes ONLY the merged Wave 1/2 kernels: lanes are discovered
 *   through the real best-execution engine (venue port, prepare/simulate/
 *   gate stages), executed by a deterministic fault-injectable walk whose
 *   observations are validated by and mapped through the canonical
 *   onchain-domain settlement vocabulary, with the onchain-adapters
 *   lifecycle law (freshness probe, lifecycle-stage vocabulary, chain
 *   environment registry) and the onchain-venues pack contract composed
 *   as-is. NO kernel surface is redefined (adversarially scanned in the
 *   test suite).
 * - The Lab runtime itself is driven from the TEST layer only (the
 *   repository-wide INV-L01 law: no other package's src/ imports the Lab
 *   package; every Lab consumer — certification, journeys, adversarial —
 *   drives it from tests, and so does the mixed-rail harness).
 * - Every result carries the STRUCTURAL non-production execution tier
 *   (simulation-tier.ts): branded, fail-closed, and always rejected for
 *   financial settlement (the TestnetNeverProduction pattern applied to
 *   the Lab tier).
 * - UNKNOWN is an honest terminal state everywhere (AGENTS.md rule 4):
 *   chain/protocol failures, unfinalized observations and external
 *   ambiguity are surfaced with their reasons, never coerced.
 * - Money is exact integer minor units everywhere (INV-F01); every instant
 *   is caller-supplied (no ambient clock, no randomness).
 */

export const PACKAGE_NAME = "@payswap/mixed-rail" as const;

export * from "./simulation-tier.js";
export * from "./onchain-lane.js";
export * from "./execution-walk.js";
export * from "./evidence.js";
