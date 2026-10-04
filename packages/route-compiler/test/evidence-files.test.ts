/**
 * Route journey evidence files (Work Order P4-W4-001 task-packet hard
 * requirement 7: "real integration evidence for supported journeys").
 *
 * This suite builds the committed evidence artifact
 * `packages/route-compiler/evidence/route-journeys.json` from the REAL
 * kernels — for each of the four representative Money Movement Intents the
 * FIRST compiled plan is walked (mixed shapes for routes 1–3; BOTH the
 * Stripe-native Mode A plan and the Stripe-external Mode B plan for route
 * 4), once on the happy path and once with an honest mid-route fault — and
 * every (plan, walk) pair becomes a RouteJourneyEvidenceRecord.
 *
 * The evidence is FIXTURE-PROVEN: live broadcast is impossible by law in
 * this tier (the Lab non-production discipline — LAB_EXECUTION_TIER), so
 * the records prove the deterministic composition of the REAL kernels
 * (uniswap venue pack + best-execution engine + mixed-rail lane execution
 * walk + kernel write pipeline + real payout gate + canonical settlement
 * destinations + provider-verified Stripe contracts) — which is exactly
 * what the work order requires.
 *
 * Behavior:
 * - with ROUTE_COMPILER_WRITE_EVIDENCE=1 the freshly built file is WRITTEN
 *   to evidence/route-journeys.json (the regeneration command in the
 *   evidence README) and the test passes;
 * - without the flag the committed file is READ and verified: deep equality
 *   with the freshly built file, every digest equals the re-computed
 *   routeJourneyEvidenceDigest of its matching record, and the law marker
 *   is exactly "FIXTURE_PROVEN_LIVE_BROADCAST_IMPOSSIBLE_BY_LAW".
 *
 * Determinism: same fixtures → same plans → same walks → same digests, so
 * the committed file never drifts.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildRouteJourneyEvidence,
  buildRouteJourneyEvidenceFile,
  routeJourneyEvidenceDigest,
  walkRoutePlan,
} from "../src/index.js";
import type {
  RouteJourneyEvidenceFile,
  RouteJourneyEvidenceRecord,
  RouteLegFault,
  RoutePlan,
} from "../src/index.js";
import {
  compileBase,
  route1Intent,
  route2Intent,
  route3Intent,
  route4Intent,
  ONCHAIN_FINALITY_MODES,
  NOW,
  NOW_ISO,
} from "./fixtures.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const EVIDENCE_DIR = join(PACKAGE_ROOT, "evidence");
const EVIDENCE_FILE = join(EVIDENCE_DIR, "route-journeys.json");
const LAW_MARKER = "FIXTURE_PROVEN_LIVE_BROADCAST_IMPOSSIBLE_BY_LAW" as const;

/** The family-appropriate OUTCOME_UNKNOWN fault for one leg kind. */
function outcomeUnknownFaultFor(legKind: RoutePlan["legs"][number]["legKind"]): RouteLegFault {
  switch (legKind) {
    case "ONCHAIN_DEX_SWAP":
    case "ONCHAIN_TRANSFER":
    case "ONCHAIN_BRIDGE":
      return {
        kind: "ONCHAIN_OUTCOME_UNKNOWN",
        reason: "injected evidence-journey fault: the receipt became ambiguous after a reorg",
      };
    case "STRIPE_CRYPTO_SETTLEMENT":
      return {
        kind: "STRIPE_OUTCOME_UNKNOWN",
        reason: "injected evidence-journey fault: the provider verification endpoint was unreachable",
      };
    default:
      return {
        kind: "FIAT_OUTCOME_UNKNOWN",
        reason: "injected evidence-journey fault: the provider API timed out mid-hop",
      };
  }
}

/**
 * The representative journeys: the FIRST plan of routes 1–3 (the mixed
 * shapes) plus BOTH route-4 plans (stripe-external Mode B and stripe-native
 * Mode A), each walked happy AND faulted (an honest OUTCOME_UNKNOWN at a
 * mid-route leg — the reconciliation evidence shape).
 */
function buildJourneyRecords(): readonly RouteJourneyEvidenceRecord[] {
  const plans: readonly { label: string; plan: RoutePlan }[] = [
    {
      label: "route-1 mixed (crypto→DEX→stablecoin→off-ramp→bank)",
      plan: compileBase(route1Intent()).plans[0]!,
    },
    {
      label: "route-2 mixed (fiat→PSP→stablecoin→chain→recipient)",
      plan: compileBase(route2Intent()).plans[0]!,
    },
    {
      label: "route-3 mixed (chainA→DEX→bridge→chainB)",
      plan: compileBase(route3Intent()).plans[0]!,
    },
    {
      label: "route-4 Mode B (stripe-external payswap route)",
      plan: compileBase(route4Intent()).plans.find(
        (plan) => plan.shapeId === "stripe-external-payswap-route",
      )!,
    },
    {
      label: "route-4 Mode A (stripe-native crypto settlement)",
      plan: compileBase(route4Intent()).plans.find(
        (plan) => plan.shapeId === "stripe-native-crypto-settlement",
      )!,
    },
  ];
  expect(plans.every((entry) => entry.plan !== undefined)).toBe(true);

  const records: RouteJourneyEvidenceRecord[] = [];
  for (const { plan } of plans) {
    // The happy walk: every hop observed to a finality CANDIDATE.
    const happyWalk = walkRoutePlan({
      plan,
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFinalityModels: ONCHAIN_FINALITY_MODES,
    });
    expect(happyWalk.status).toBe("ROUTE_COMPLETED_ALL_LEGS_OBSERVED");
    records.push(buildRouteJourneyEvidence(plan, happyWalk));

    // The faulted walk: OUTCOME_UNKNOWN at a mid-route leg (for the
    // single-leg Stripe Mode A plan, the fault is at its only leg) — the
    // honest reconciliation shape, never a blind retry.
    const faultIndex = Math.floor(plan.legs.length / 2);
    const faultedLeg = plan.legs[faultIndex]!;
    const faultedWalk = walkRoutePlan({
      plan,
      at: NOW,
      observedAtIso: NOW_ISO,
      onchainFinalityModels: ONCHAIN_FINALITY_MODES,
      faults: {
        [faultedLeg.legId]: outcomeUnknownFaultFor(faultedLeg.legKind),
      },
    });
    expect(faultedWalk.status).toBe("ROUTE_REQUIRES_RECONCILIATION");
    expect(faultedWalk.reconciliation?.blindRetryForbidden).toBe(true);
    expect(faultedWalk.reconciliation?.resolver).toBe(
      "SETTLEMENT_RECONCILIATION_AUTHORITY",
    );
    records.push(buildRouteJourneyEvidence(plan, faultedWalk));
  }
  return records;
}

describe("route journey evidence file (real integration evidence for supported journeys)", () => {
  it("builds the five representative journeys × (happy + faulted) = ten records", () => {
    const records = buildJourneyRecords();
    expect(records).toHaveLength(10);
    // Five happy completions and five honest reconciliations.
    const statuses = records.map((record) => record.outcome.status);
    expect(statuses.filter((status) => status === "ROUTE_COMPLETED_ALL_LEGS_OBSERVED")).toHaveLength(5);
    expect(statuses.filter((status) => status === "ROUTE_REQUIRES_RECONCILIATION")).toHaveLength(5);
    // Every record references its intent (never re-declares it) and every
    // plan digest is the kernel content digest of the walked plan.
    for (const record of records) {
      expect(record.intentRef).toMatch(/^intent:route-[1-4]:/);
      expect(record.planDigest).toMatch(/^fnv1a64:/);
      expect(record.evidenceRefs.length).toBeGreaterThan(0);
    }
  });

  it("the evidence file is digested, law-marked and byte-stable", () => {
    const file: RouteJourneyEvidenceFile = buildRouteJourneyEvidenceFile(
      buildJourneyRecords(),
    );
    expect(file.law).toBe(LAW_MARKER);
    expect(file.journeys).toHaveLength(10);
    expect(file.digests).toHaveLength(10);
    // Digests pair with their records (index-wise: digests are derived from
    // the same canonically-ordered journey array).
    for (let index = 0; index < file.journeys.length; index += 1) {
      const record = file.journeys[index]!;
      const digestEntry = file.digests[index]!;
      expect(digestEntry.journeyId).toBe(record.journeyId);
      expect(digestEntry.digest).toBe(routeJourneyEvidenceDigest(record));
    }
    // Rebuilding from the same fixtures is byte-stable.
    const again = buildRouteJourneyEvidenceFile(buildJourneyRecords());
    expect(JSON.stringify(again, null, 2)).toBe(JSON.stringify(file, null, 2));
  });

  it("commits / verifies evidence/route-journeys.json (ROUTE_COMPILER_WRITE_EVIDENCE switches write vs verify)", () => {
    const file: RouteJourneyEvidenceFile = buildRouteJourneyEvidenceFile(
      buildJourneyRecords(),
    );
    const serialized = `${JSON.stringify(file, null, 2)}\n`;

    if (process.env.ROUTE_COMPILER_WRITE_EVIDENCE === "1") {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      writeFileSync(EVIDENCE_FILE, serialized, "utf8");
      expect(true).toBe(true); // written — the regeneration command
      return;
    }

    // Verification mode: the committed file must deep-equal the freshly
    // built one (same fixtures → same journeys → same digests).
    const committed = JSON.parse(readFileSync(EVIDENCE_FILE, "utf8")) as unknown;
    expect(committed).toEqual(file);

    const committedFile = committed as RouteJourneyEvidenceFile;
    expect(committedFile.law).toBe(LAW_MARKER);
    expect(committedFile.journeys).toHaveLength(10);
    expect(committedFile.digests).toHaveLength(10);
    // Every digest in the committed file equals the digest of its matching
    // record — recomputed from the COMMITTED record bytes.
    for (let index = 0; index < committedFile.journeys.length; index += 1) {
      const record = committedFile.journeys[index]!;
      const digestEntry = committedFile.digests[index]!;
      expect(digestEntry.journeyId).toBe(record.journeyId);
      expect(digestEntry.digest).toBe(routeJourneyEvidenceDigest(record));
    }
    // The four representative shapes are all present (mixed journeys for
    // routes 1–3, both Stripe modes for route 4), each with its happy and
    // its faulted record.
    const shapeIds = committedFile.journeys.map((record) => record.shapeId).sort();
    expect(shapeIds).toEqual([
      "mixed-dex-bridge",
      "mixed-dex-bridge",
      "mixed-dex-offramp",
      "mixed-dex-offramp",
      "mixed-psp-onramp",
      "mixed-psp-onramp",
      "stripe-external-payswap-route",
      "stripe-external-payswap-route",
      "stripe-native-crypto-settlement",
      "stripe-native-crypto-settlement",
    ]);
    // Faulted records carry the reconciliation semantics verbatim.
    for (const record of committedFile.journeys) {
      if (record.outcome.status === "ROUTE_REQUIRES_RECONCILIATION") {
        expect(record.outcome.reconciliation?.blindRetryForbidden).toBe(true);
        expect(record.outcome.reconciliation?.resolver).toBe(
          "SETTLEMENT_RECONCILIATION_AUTHORITY",
        );
      } else {
        expect(record.outcome.reconciliation).toBeUndefined();
      }
    }
  });
});
