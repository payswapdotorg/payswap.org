import { describe, expect, it } from "vitest";
import {
  BLOCKED_STATUS,
  NO_CREDENTIAL_STATUS,
  NOT_ACTIVATED_STATUS,
  coverage,
  formatUtcTimestamp,
  providerLabel,
} from "../src/lib/coverage";

/**
 * The honest-data projection laws: everything /capabilities and the home
 * page render derives from the committed probe/rollout evidence. These
 * tests pin the split so a record change (or a coding slip) cannot
 * silently upgrade a provider's status.
 */

describe("coverage: the recorded evidence projection", () => {
  it("carries the probe and release provenance with dates", () => {
    expect(coverage.probedAt).toBe("2026-10-02T06:37:38Z");
    expect(coverage.releaseId).toBe(
      "provider-rollout-20261002@2026-10-02T14:30:00Z",
    );
    expect(formatUtcTimestamp(coverage.probedAt)).toBe(
      "2026-10-02 06:37 UTC",
    );
  });

  it("projects exactly the three verified test-mode connections on record", () => {
    expect(coverage.connected.map((entry) => entry.providerName)).toEqual([
      "stripe",
      "paystack",
      "flutterwave",
    ]);
    for (const entry of coverage.connected) {
      expect(entry.probeEvidence.probedAt).toBe("2026-10-02T06:37:38Z");
      expect(entry.certification.failed).toBe(0);
      expect(entry.certification.passed).toBeGreaterThan(0);
      expect(entry.limitations.length).toBeGreaterThan(0);
    }
    const stripe = coverage.connected[0];
    expect(stripe?.probeEvidence.verdict).toBe("VERIFIED");
    expect(stripe?.certification.executed).toBe(13);
    expect(stripe?.certification.passed).toBe(13);
    expect(stripe?.limitations.join(" ")).toContain("GHS not routable");
  });

  it("keeps MTN MoMo BLOCKED — never connected, never softened", () => {
    expect(coverage.blocked.length).toBe(1);
    const blocked = coverage.blocked[0];
    expect(blocked?.providerName).toBe("mtn_momo");
    expect(blocked?.status).toBe(BLOCKED_STATUS);
    expect(blocked?.reason).toContain("subscription key rejected HTTP 401");
    expect(coverage.mtnMomo?.authentication).toBe("BLOCKED");
    expect(coverage.mtnMomo?.detail).toContain(
      "Access denied due to invalid subscription key",
    );
  });

  it("lists the seven built-but-not-connected connectors as awaiting credentials", () => {
    expect(coverage.awaitingCredentials.map((e) => e.providerName)).toEqual([
      "paypal-direct",
      "rapyd",
      "dlocal",
      "thunes",
      "adyen",
      "airwallex",
      "ebanx",
    ]);
    for (const entry of coverage.awaitingCredentials) {
      expect(entry.status).toBe(NO_CREDENTIAL_STATUS);
      expect(entry.reason).toContain("no credential exists in the vault");
    }
  });

  it("renders Stellar as the local rail, not a provider connection", () => {
    expect(coverage.localRail.length).toBe(1);
    const rail = coverage.localRail[0];
    expect(rail?.providerName).toBe("stellar");
    expect(rail?.status).toBe(NOT_ACTIVATED_STATUS);
    expect(rail?.reason).toContain("LOCAL rail");
    expect(coverage.stellarTestnet?.verdict).toContain("READY");
  });

  it("keeps supporting platform services out of the payment-rail picture", () => {
    expect(coverage.supportingServices.map((service) => service.id)).toEqual([
      "whatsapp",
      "resend",
      "opensanctions",
    ]);
    for (const service of coverage.supportingServices) {
      expect(service.note).toContain("Not a payment rail");
    }
  });

  it("maps provider identifiers to honest display labels", () => {
    expect(providerLabel("mtn_momo")).toBe("MTN MoMo");
    expect(providerLabel("stellar")).toBe("Stellar (local rail)");
    expect(providerLabel("unknown-future-provider")).toBe(
      "unknown-future-provider",
    );
  });

  it("formats timestamps deterministically (no locale dependence)", () => {
    expect(formatUtcTimestamp("2026-10-02T06:37:38Z")).toBe(
      "2026-10-02 06:37 UTC",
    );
    expect(formatUtcTimestamp("2026-10-02")).toBe("2026-10-02");
  });
});
