import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJourneyEvidenceFile,
  journeyRecordDigest,
  MERCHANT_CHECKOUT_EVIDENCE_LAW,
  verifyJourneyEvidenceFile,
} from "../src/index.js";
import { runFullJourney } from "./journey-helpers.js";

/**
 * P4-W2-003 §3.10 — the committed journey evidence file
 * (evidence/merchant-checkout-journeys.json), mirroring W4-001's
 * evidence/route-journeys.json pattern:
 *
 * - with MERCHANT_CHECKOUT_WRITE_EVIDENCE=1 the file is REGENERATED from
 *   the pinned fixtures (deterministic — same fixtures → same file);
 * - without the flag the committed file is READ and VERIFIED: deep equality
 *   with the freshly built journey, every digest re-computed, the law
 *   marker checked verbatim.
 */

const EVIDENCE_PATH = join(process.cwd(), "evidence", "merchant-checkout-journeys.json");
const JOURNEY_ID = "journey:merchant-checkout:fixture-1";

function buildFixtureFile() {
  const journey = runFullJourney();
  return buildJourneyEvidenceFile({
    journeyId: JOURNEY_ID,
    profile: journey.profile,
    activation: journey.activation,
    flow: journey.flow,
    authorization: journey.lineage,
    pipelineEvidence: journey.pipeline.evidence(),
    attempt: journey.attempt,
    inbox: journey.inbox,
    refund: journey.refund,
    settlement: journey.settlement,
  });
}

// Deterministic bigint-safe JSON serialization (sorted keys are not required
// for equality here — the digests carry the canonical content binding).
function serialize(file: ReturnType<typeof buildFixtureFile>): string {
  return JSON.stringify(file, (_key, value) => {
    if (typeof value === "bigint") {
      return { __bigint: value.toString() };
    }
    return value;
  }, 2) + "\n";
}

function deserialize(raw: string): ReturnType<typeof buildFixtureFile> {
  return JSON.parse(raw, (_key, value) => {
    if (value !== null && typeof value === "object" && "__bigint" in value) {
      return BigInt((value as { __bigint: string }).__bigint);
    }
    return value;
  }) as ReturnType<typeof buildFixtureFile>;
}

const writeMode = process.env["MERCHANT_CHECKOUT_WRITE_EVIDENCE"] === "1";

describe("journey evidence file (evidence/merchant-checkout-journeys.json)", () => {
  it(writeMode ? "regenerates the committed evidence file deterministically" : "verifies the committed evidence file against the freshly built journey", () => {
    const fresh = buildFixtureFile();
    if (writeMode) {
      writeFileSync(EVIDENCE_PATH, serialize(fresh), "utf8");
    }
    expect(existsSync(EVIDENCE_PATH)).toBe(true);
    const committed = deserialize(readFileSync(EVIDENCE_PATH, "utf8"));
    expect(committed).toEqual(fresh);
    expect(committed.lawMarker).toBe(MERCHANT_CHECKOUT_EVIDENCE_LAW);
    expect(committed.packageName).toBe("@payswap/merchant-checkout");
    expect(committed.journeyId).toBe(JOURNEY_ID);
    expect(committed.stages).toHaveLength(8);
  });

  it("every stage digest re-computes exactly (digest stability)", () => {
    const committed = deserialize(readFileSync(EVIDENCE_PATH, "utf8"));
    for (const stage of committed.stages) {
      expect(stage.digest).toBe(
        journeyRecordDigest({
          journeyId: stage.journeyId,
          stage: stage.stage,
          refs: stage.refs,
          evidenceRefs: stage.evidenceRefs,
          ...(stage.pipelineEvidence !== undefined
            ? { pipelineEvidence: stage.pipelineEvidence }
            : {}),
        }),
      );
    }
    expect(verifyJourneyEvidenceFile(committed)).toBe(true);
  });

  it("the law marker is the fixture-proven trusted-surface-signing-only law", () => {
    const committed = deserialize(readFileSync(EVIDENCE_PATH, "utf8"));
    expect(committed.lawMarker).toBe("FIXTURE_PROVEN_TRUSTED_SURFACE_SIGNING_ONLY");
  });

  it("regeneration is byte-stable (a second build is byte-identical)", () => {
    const first = serialize(buildFixtureFile());
    const second = serialize(buildFixtureFile());
    expect(first).toBe(second);
    const committed = readFileSync(EVIDENCE_PATH, "utf8");
    expect(committed).toBe(first);
  });
});
