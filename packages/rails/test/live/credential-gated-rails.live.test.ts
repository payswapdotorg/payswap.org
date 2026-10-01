import { describe, expect, it } from "vitest";
import { StripeShapeFiatClient } from "../../src/fiat.js";
import { MtnMomoClient } from "../../src/mobile-money.js";
import { CLOCK } from "../fixtures.js";

/**
 * LIVE network suite (run explicitly: `npm run test:live`). Contacts the
 * REAL credential-gated provider endpoints WITHOUT credentials — a pure
 * reachability probe that DOCUMENTS the blocked-rail state (INV-C01/C02:
 * availability UNKNOWN; INV-NC04: never implied routable). No credentials
 * are sent, no business outcome is attempted, no settlement effect exists.
 *
 * These probes are the machine-checked counterpart of BLOCKED-RAILS.md.
 */
describe("credential-gated rails — LIVE reachability documentation (no credentials)", () => {
  it("stripe-shaped fiat rail: endpoint answers (401), availability stays UNKNOWN, never routable", async () => {
    const client = new StripeShapeFiatClient({ clock: CLOCK, env: {} });
    const report = await client.health();
    // A 401 answer proves the ENDPOINT is reachable; the RAIL stays
    // non-serving: DEGRADED with the documented reason, or UNKNOWN if the
    // probe could not establish even endpoint reachability.
    expect(["DEGRADED", "UNKNOWN"]).toContain(report.status);
    if (report.status === "DEGRADED") {
      expect(report.degradedReasons[0]).toContain("credentials absent");
      expect(report.degradedReasons[0]).toContain("INV-C01/C02");
    }
    const observation = client.availabilityObservation({
      instanceId: "inst-rails-fiat-live-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(observation.sourceAvailability).toBe("UNKNOWN");
    expect(client.railImplication(observation.availability).routable).toBe(false);
    expect(client.railImplication(observation.availability).reason).toContain("INV-NC04");
  });

  it("mtn momo rail: sandbox endpoint answers, availability stays UNKNOWN, never routable", async () => {
    const client = new MtnMomoClient({ clock: CLOCK, env: {} });
    const report = await client.health();
    expect(["DEGRADED", "UNKNOWN"]).toContain(report.status);
    if (report.status === "DEGRADED") {
      expect(report.degradedReasons[0]).toContain("credentials absent");
    }
    const observation = client.availabilityObservation({
      instanceId: "inst-rails-momo-live-1",
      observationVersion: 1,
    });
    expect(observation.availability).toBe("UNKNOWN");
    expect(client.railImplication(observation.availability).routable).toBe(false);
  });

  it("the credential surface declares exactly the documented env vars (CREDENTIAL-ROTATION.md)", () => {
    const fiat = new StripeShapeFiatClient({ clock: CLOCK, env: {} });
    const momo = new MtnMomoClient({ clock: CLOCK, env: {} });
    expect(fiat.credentialSurface()).toEqual([
      { envVar: "PAYSWAP_RAILS_FIAT_SECRET_REF", kind: "API_KEY" },
    ]);
    expect(
      momo.credentialSurface().map((declaration) => declaration.envVar).sort(),
    ).toEqual([
      "PAYSWAP_RAILS_MOMO_API_KEY_REF",
      "PAYSWAP_RAILS_MOMO_API_USER_REF",
      "PAYSWAP_RAILS_MOMO_SUBSCRIPTION_KEY_REF",
    ]);
  });
});
