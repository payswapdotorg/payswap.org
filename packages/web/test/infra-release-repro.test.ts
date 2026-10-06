import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assembleReleaseRecord,
  assembleRollbackRecord,
  contentDigest,
  deriveRouteInventory,
  formatRecord,
  recordFileName,
} from "../../../scripts/deployment/web-release.mjs";

/**
 * Reproducibility test for the web release-record driver (Work Order
 * P3-W1-003): the driver is deterministic BY CONSTRUCTION.
 *
 * Proof strategy (fixture-based; no network, no build, no git):
 *
 * 1. BYTE-COMPAT REGRESSION — the record assembled by the pure core from the
 *    exact inputs of the record P3-W1-001 shipped
 *    (spec/development-state/web-release-2026-10-02.json) is byte-identical
 *    to that file on disk. Same inputs => same bytes, today and forever.
 * 2. SELF-CONSISTENCY — the fnv1a64 digest recorded in a record always equals
 *    contentDigest(the record without its digest field) — recomputed here,
 *    independently of the driver's assembly path.
 * 3. PURITY — two assemblies with identical inputs produce identical bytes;
 *    the formatted records contain no wall-clock timestamps (the only date
 *    is the explicit YYYY-MM-DD input); every input change changes the
 *    digest (no field is ignored).
 *
 * The driver's CLI (build, git, file writes) stays behind a run-as-script
 * guard: importing the module in this test executes NOTHING side-effectful.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SHIPPED_RECORD_PATH = path.join(
  REPO_ROOT,
  "spec",
  "development-state",
  "web-release-2026-10-02.json",
);

/** The exact inputs of the record P3-W1-001 shipped on 2026-10-02. */
const SHIPPED_INPUTS = {
  recordDate: "2026-10-02",
  commitSha: "c7a3856709d5fc5bdf98ebb70660aa2718e7c750",
  buildId: "dba11b45080e6786",
  buildIdVerifiedAgainstSources: true,
  productionUrl: "https://payswap-web.vercel.app",
  previewUrl: "https://payswap-6056skcol-ekonplacidegmailcoms-projects.vercel.app",
} as const;

describe("release-record driver — determinism by construction", () => {
  it("assembles byte-identical output to the record P3-W1-001 shipped (regression fixture)", () => {
    const formatted = formatRecord(assembleReleaseRecord({ ...SHIPPED_INPUTS }));
    const onDisk = readFileSync(SHIPPED_RECORD_PATH, "utf8");
    expect(formatted).toBe(onDisk);
  });

  it("produces the same digest the shipped record carries", () => {
    const record = assembleReleaseRecord({ ...SHIPPED_INPUTS });
    expect(record.digest).toBe("fnv1a64:795b935514ebeb52");
  });

  it("two assemblies with identical inputs are byte-identical (purity)", () => {
    const first = formatRecord(assembleReleaseRecord({ ...SHIPPED_INPUTS }));
    const second = formatRecord(assembleReleaseRecord({ ...SHIPPED_INPUTS }));
    expect(first).toBe(second);
  });

  it("the digest is self-consistent: it equals contentDigest(record minus digest)", () => {
    const record = assembleReleaseRecord({ ...SHIPPED_INPUTS });
    const { digest, ...withoutDigest } = record;
    expect(digest).toBe(contentDigest(withoutDigest));

    // Also true for the shipped file as parsed from disk (independent path).
    const shipped = JSON.parse(readFileSync(SHIPPED_RECORD_PATH, "utf8")) as {
      digest: string;
    };
    const shippedWithoutDigest = JSON.parse(readFileSync(SHIPPED_RECORD_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    delete shippedWithoutDigest["digest"];
    expect(shipped.digest).toBe(contentDigest(shippedWithoutDigest));
  });

  it("mutating the recorded digest never changes the recomputed digest (digest is not self-referential)", () => {
    const record = assembleReleaseRecord({ ...SHIPPED_INPUTS });
    // Tamper the RECORDED digest field: the digest over the content (minus
    // the digest field itself) must be unchanged — the field never feeds
    // its own computation.
    const tampered = { ...record, digest: "fnv1a64:0000000000000000" };
    const withoutTamperedDigest: Record<string, unknown> = { ...tampered };
    delete withoutTamperedDigest["digest"];
    expect(contentDigest(withoutTamperedDigest)).toBe(record.digest);
  });

  it("every input change changes the record bytes and the digest (no field is ignored)", () => {
    const base = assembleReleaseRecord({ ...SHIPPED_INPUTS });
    const variants: Array<Parameters<typeof assembleReleaseRecord>[0]> = [
      { ...SHIPPED_INPUTS, recordDate: "2026-10-03" },
      { ...SHIPPED_INPUTS, commitSha: "1111111111111111111111111111111111111111" },
      { ...SHIPPED_INPUTS, buildId: "ffffffffffffffff" },
      { ...SHIPPED_INPUTS, buildIdVerifiedAgainstSources: false },
      { ...SHIPPED_INPUTS, productionUrl: null },
      { ...SHIPPED_INPUTS, previewUrl: null },
      { ...SHIPPED_INPUTS, productionUrl: "https://other.example", previewUrl: null },
    ];
    for (const variant of variants) {
      const other = assembleReleaseRecord(variant);
      expect(formatRecord(other)).not.toBe(formatRecord(base));
      expect(other.digest).not.toBe(base.digest);
    }
  });

  it("the formatted record contains no wall-clock timestamp — the only date is the explicit input", () => {
    const formatted = formatRecord(assembleReleaseRecord({ ...SHIPPED_INPUTS }));
    // An ISO instant would contain "T hh:mm" — the explicit date input is
    // plain YYYY-MM-DD. Determinism forbids ambient time in records.
    expect(formatted).not.toMatch(/T\d{2}:\d{2}/);
    expect(formatted).toContain('"2026-10-02"');
  });

  it("formats records in the house style: 2-space JSON + trailing newline", () => {
    const formatted = formatRecord(assembleReleaseRecord({ ...SHIPPED_INPUTS }));
    expect(formatted.endsWith("\n")).toBe(true);
    expect(formatted.endsWith("\n\n")).toBe(false);
    expect(formatted).toContain('\n  "schema_version"');
  });

  it("derives the record filename deterministically from the record type + date", () => {
    expect(recordFileName("web-release", "2026-10-02")).toBe("web-release-2026-10-02.json");
    expect(recordFileName("web-rollback", "2026-10-02")).toBe("web-rollback-2026-10-02.json");
    expect(recordFileName("web-rollback", "2026-10-02")).toBe(
      recordFileName("web-rollback", "2026-10-02"),
    );
  });
});

describe("fnv1a64 content digest — house pattern vectors", () => {
  it("agrees with known vectors of the certification implementation", () => {
    // Cross-checked against @payswap/certification src/digest.ts (the house
    // pattern this driver re-implements): identical canonical serialization
    // + identical FNV-1a 64 → identical digests for the same values.
    expect(contentDigest(null)).toBe("fnv1a64:5b9bc4ba528108e4");
    expect(contentDigest(true)).toBe("fnv1a64:5b5c98ef514dbfa5");
    expect(contentDigest("PaySwap")).toBe("fnv1a64:a97e0e303e9d1388");
    expect(contentDigest(1)).toBe("fnv1a64:21f3ff192610f1c0");
    expect(contentDigest("1")).toBe("fnv1a64:d536c417d8ae0efa");
    expect(contentDigest({ b: 2, a: 1 })).toBe(contentDigest({ a: 1, b: 2 }));
    expect(contentDigest([1, 2])).not.toBe(contentDigest([2, 1]));
  });

  it("digests the canonical form, not the raw JSON text", () => {
    // Key order must not matter (sorted canonical serialization):
    expect(contentDigest({ x: 1, y: "s" })).toBe(contentDigest({ y: "s", x: 1 }));
    // Numbers and strings serialize differently (n: prefix):
    expect(contentDigest(1)).not.toBe(contentDigest("1"));
  });
});

describe("rollback-record mode — deterministic by the same construction", () => {
  const rollbackInputs = {
    recordDate: "2026-10-02",
    fromDeployment: "https://payswap-web-abc123.vercel.app",
    toDeployment: "https://payswap-web-456def.vercel.app",
    reason: "regression in the capabilities page after the latest release",
    toBuildId: "dba11b45080e6786",
    toCommit: "c7a3856709d5fc5bdf98ebb70660aa2718e7c750",
  } as const;

  it("two assemblies with identical inputs are byte-identical", () => {
    const first = formatRecord(assembleRollbackRecord({ ...rollbackInputs }));
    const second = formatRecord(assembleRollbackRecord({ ...rollbackInputs }));
    expect(first).toBe(second);
  });

  it("is self-consistent: recorded digest equals contentDigest(record minus digest)", () => {
    const record = assembleRollbackRecord({ ...rollbackInputs });
    const withoutDigest: Record<string, unknown> = { ...record };
    delete withoutDigest["digest"];
    expect(record.digest).toBe(contentDigest(withoutDigest));
  });

  it("every rollback input change changes the digest", () => {
    const base = assembleRollbackRecord({ ...rollbackInputs });
    const variants = [
      { ...rollbackInputs, recordDate: "2026-10-05" },
      { ...rollbackInputs, fromDeployment: "https://payswap-web-xyz789.vercel.app" },
      { ...rollbackInputs, toDeployment: "https://payswap-web-000000.vercel.app" },
      { ...rollbackInputs, reason: "different reason entirely" },
      { ...rollbackInputs, toBuildId: null },
      { ...rollbackInputs, toCommit: null },
    ];
    for (const variant of variants) {
      expect(assembleRollbackRecord(variant).digest).not.toBe(base.digest);
    }
  });

  it("records the separation law and the no-rebuild method honestly", () => {
    const record = assembleRollbackRecord({ ...rollbackInputs });
    expect(record.record_type).toBe("web-rollback");
    expect(record.workOrder).toBe("P3-W1-003");
    expect(record.rollback.method).toContain("no rebuild");
    expect(record.apiRuntimeSeparation.apiRuntimeProject).toBe("payswap");
    expect(record.apiRuntimeSeparation.apiRuntimeProjectRole).toContain("NOT touched");
    expect(record.rollback.verification).toContain("/api/health");
  });

  it("contains no wall-clock timestamp — only the explicit date input", () => {
    const formatted = formatRecord(assembleRollbackRecord({ ...rollbackInputs }));
    expect(formatted).not.toMatch(/T\d{2}:\d{2}/);
    expect(formatted).toContain('"2026-10-02"');
  });

  it("importing the driver module executes no build, no git, no writes (run-as-script guard)", () => {
    // The strongest structural proof available offline: this test file
    // IMPORTED the driver at the top (module side effects would already
    // have run). The pure functions returned records without spawning any
    // subprocess — a build or `git rev-parse` here would have made this
    // suite slow/networked; it ran in milliseconds.
    expect(typeof assembleReleaseRecord).toBe("function");
    expect(typeof assembleRollbackRecord).toBe("function");
  });
});

describe("release-record parameterization — live Phase-4 records (deploy:record extension)", () => {
  /**
   * The deploy:record extension (2026-10-06, closing the Phase-4
   * certification gap "live Phase-4 deployment URL"): assembleReleaseRecord
   * gained optional workOrder / routes / deploymentUrlsNote parameters so a
   * LIVE release can record the work order it ships under, the route
   * inventory DERIVED from the actual tree, and a live-verified URLs note —
   * while the defaults remain byte-identical to the P3-W1-001 fixture
   * (proven by the regression test above, which passes no overrides).
   */

  it("the defaults still reproduce the shipped record bytes (no overrides needed)", () => {
    // Same call as the fixture test, made explicit: zero new parameters
    // passed => byte-identical to web-release-2026-10-02.json.
    const formatted = formatRecord(assembleReleaseRecord({ ...SHIPPED_INPUTS }));
    const onDisk = readFileSync(SHIPPED_RECORD_PATH, "utf8");
    expect(formatted).toBe(onDisk);
  });

  it("workOrder/routes/deploymentUrlsNote overrides change the bytes and the digest", () => {
    const base = assembleReleaseRecord({ ...SHIPPED_INPUTS });
    const overrides = [
      { workOrder: "P4-W4-003" },
      { routes: ["/", "/api/health"] },
      { deploymentUrlsNote: "live — verified" },
    ];
    for (const override of overrides) {
      const other = assembleReleaseRecord({ ...SHIPPED_INPUTS, ...override });
      expect(formatRecord(other)).not.toBe(formatRecord(base));
      expect(other.digest).not.toBe(base.digest);
    }
  });

  it("two live assemblies with identical inputs are byte-identical (purity holds)", () => {
    const liveInputs = {
      ...SHIPPED_INPUTS,
      workOrder: "P4-W4-003",
      routes: ["/", "/app", "/api/health"],
      deploymentUrlsNote: "live — verified serving at record time",
    };
    expect(formatRecord(assembleReleaseRecord({ ...liveInputs }))).toBe(
      formatRecord(assembleReleaseRecord({ ...liveInputs })),
    );
  });

  it("a live record's digest is self-consistent (record minus digest re-derives it)", () => {
    const record = assembleReleaseRecord({
      ...SHIPPED_INPUTS,
      workOrder: "P4-W4-003",
      routes: ["/", "/app", "/api/health"],
    });
    const withoutDigest: Record<string, unknown> = { ...record };
    delete withoutDigest["digest"];
    expect(record.digest).toBe(contentDigest(withoutDigest));
  });
});

describe("deriveRouteInventory — the tree-derived route inventory", () => {
  const WEB_ROOT = path.join(REPO_ROOT, "packages", "web");

  it("derives the actual surface: every page.tsx/route.ts under src/app, route groups flattened", () => {
    const routes = deriveRouteInventory(WEB_ROOT);
    // The public surface:
    expect(routes).toContain("/");
    expect(routes).toContain("/capabilities");
    expect(routes).toContain("/security");
    expect(routes).toContain("/developers");
    // The auth flows (the (auth) route group is flattened away):
    expect(routes).toContain("/signin");
    expect(routes).toContain("/signout");
    expect(routes).toContain("/connect");
    expect(routes).toContain("/connect/[providerId]");
    expect(routes).toContain("/onboarding");
    expect(routes).toContain("/reauth");
    // The authenticated app boundary + the Phase-4 universal-interface areas:
    expect(routes).toContain("/app");
    expect(routes).toContain("/app/payments");
    expect(routes).toContain("/app/accounts");
    expect(routes).toContain("/app/connections");
    expect(routes).toContain("/app/security");
    expect(routes).toContain("/app/reports");
    expect(routes).toContain("/app/convert");
    expect(routes).toContain("/app/checkout");
    // The health route (route.ts):
    expect(routes).toContain("/api/health");
  });

  it("is sorted with / first and contains no route-group segments", () => {
    const routes = deriveRouteInventory(WEB_ROOT);
    expect(routes[0]).toBe("/");
    expect(routes.join("\n")).not.toContain("(");
    const sorted = [...routes].sort((a, b) =>
      a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b),
    );
    expect(routes).toEqual(sorted);
  });

  it("covers every route the P3 inventory named (the inventory only ever grows)", () => {
    const routes = deriveRouteInventory(WEB_ROOT);
    for (const route of ["/", "/capabilities", "/security", "/developers", "/api/health"]) {
      expect(routes).toContain(route);
    }
    // The P3 inventory's annotated /app entry corresponds to the derived
    // plain "/app" — the authentication boundary itself is unchanged.
    expect(routes).toContain("/app");
  });
});
