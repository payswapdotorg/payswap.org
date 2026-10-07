import { beforeEach, describe, expect, it, vi } from "vitest";

import { API_BASE_URL_ENV_VAR, type ApiRuntimeState } from "../src/lib/api";

import {
  PAY_TEST_FIXTURES,
  PAY_TEST_PARTIAL_REFUND,
} from "../src/app/app/payments/_server/test-fixtures";
import {
  TEST_FIXTURES_ENV_VAR,
  listPaymentsFor,
  paymentById,
  paymentLinkById,
  paymentViewFromApiIntent,
  paymentsPlaneInput,
  paymentsWorldLabel,
} from "../src/app/app/payments/_server/payments-plane";

/**
 * UX-004 — the honest payments data plane: the ladder (authoritative API →
 * clearly-marked TEST fixtures → honest unconfigured) is priority-ordered and
 * every rung states its source. The API rung is exercised through the REAL
 * session-aware transport module with the network mocked at its seam — the
 * plane itself never fetches and never invents a record.
 */

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  paySwapApiFetch: apiFetchMock,
}));

const CONFIGURED: ApiRuntimeState = {
  configured: true,
  baseUrl: "https://api.payswap.test",
  envVar: API_BASE_URL_ENV_VAR,
};
const UNCONFIGURED: ApiRuntimeState = {
  configured: false,
  baseUrl: null,
  envVar: API_BASE_URL_ENV_VAR,
};

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("the plane input resolves from the ambient env (names, never values)", () => {
  it("fixtures enable only on a non-empty value", () => {
    expect(paymentsPlaneInput("p_1", "1", UNCONFIGURED).fixturesEnabled).toBe(true);
    expect(paymentsPlaneInput("p_1", "  ", UNCONFIGURED).fixturesEnabled).toBe(false);
    expect(paymentsPlaneInput("p_1", undefined, UNCONFIGURED).fixturesEnabled).toBe(false);
  });

  it("the world label names which source a lookup consults", () => {
    expect(paymentsWorldLabel(paymentsPlaneInput("p_1", undefined, CONFIGURED))).toBe(
      "the connected PaySwap API runtime",
    );
    expect(paymentsWorldLabel(paymentsPlaneInput("p_1", "1", UNCONFIGURED))).toBe(
      `test mode (${TEST_FIXTURES_ENV_VAR} — clearly-marked test records)`,
    );
    expect(paymentsWorldLabel(paymentsPlaneInput("p_1", undefined, UNCONFIGURED))).toBe(
      "this deployment",
    );
  });
});

describe("rung 3 — the honest unconfigured state (no API, no fixtures)", () => {
  it("the collection and lookups report unconfigured — nothing is fabricated", async () => {
    const input = paymentsPlaneInput("p_1", undefined, UNCONFIGURED);
    expect(await listPaymentsFor(input)).toEqual({ status: "unconfigured" });
    expect(await paymentById(input, "pay_test_partial_refund")).toEqual({ status: "unconfigured" });
    expect(await paymentLinkById(input, "link_test_retainer")).toEqual({ status: "unconfigured" });
  });

  it("a configured runtime WITHOUT a session is the honest preview state", async () => {
    const input = paymentsPlaneInput(null, undefined, CONFIGURED);
    expect(await listPaymentsFor(input)).toEqual({ status: "preview-no-session" });
    expect(await paymentById(input, "pay_test_partial_refund")).toEqual({
      status: "preview-no-session",
    });
  });
});

describe("rung 2 — the clearly-marked TEST fixtures (opt-in only)", () => {
  it("serves the fixture collection with the test-fixtures source", async () => {
    const input = paymentsPlaneInput("p_1", "1", UNCONFIGURED);
    const read = await listPaymentsFor(input);
    expect(read).toEqual({
      status: "ok",
      source: "test-fixtures",
      data: PAY_TEST_FIXTURES,
    });
  });

  it("resolves a fixture payment by id; an unknown id is not-found (never invented)", async () => {
    const input = paymentsPlaneInput("p_1", "1", UNCONFIGURED);
    const read = await paymentById(input, PAY_TEST_PARTIAL_REFUND.id);
    expect(read?.status).toBe("ok");
    if (read?.status === "ok") {
      expect(read.data.id).toBe("pay_test_partial_refund");
      expect(read.data.environment).toBe("test");
      expect(read.data.source).toBe("test-fixture");
    }
    expect(await paymentById(input, "pay_test_does_not_exist")).toEqual({ status: "not-found" });
  });

  it("resolves a fixture link by id; unknown link ids are not-found", async () => {
    const input = paymentsPlaneInput("p_1", "1", UNCONFIGURED);
    const read = await paymentLinkById(input, "link_test_retainer");
    expect(read?.status).toBe("ok");
    expect(await paymentLinkById(input, "link_test_nope")).toEqual({ status: "not-found" });
  });

  it("every fixture record is OBVIOUSLY test data", () => {
    for (const payment of PAY_TEST_FIXTURES) {
      expect(payment.id.startsWith("pay_test_")).toBe(true);
      expect(payment.environment).toBe("test");
      expect(payment.source).toBe("test-fixture");
    }
  });
});

describe("rung 1 — the authoritative API (session + configured runtime)", () => {
  it("reads the collection through the REAL transport and folds only validated shapes", async () => {
    apiFetchMock.mockResolvedValue({
      status: "ok",
      data: {
        payments: [
          {
            id: "pay_live_1",
            commandType: "payments.intent.create",
            issuedAt: 1760051400000,
            payload: {
              amount: { currency: "GHS", minorUnits: "1050" },
              recipient: "dest_1",
            },
          },
          "not-a-record",
        ],
      },
    });
    const input = paymentsPlaneInput("p_1", "1", CONFIGURED);
    const read = await listPaymentsFor(input);
    // Fixtures are IGNORED when the API rung applies (priority order).
    expect(apiFetchMock).toHaveBeenCalledWith(
      { principalRef: "p_1" },
      "/v1/payments",
    );
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.source).toBe("authoritative-api");
      expect(read.data).toHaveLength(1);
      expect(read.data[0]?.id).toBe("pay_live_1");
    }
  });

  it("an intent WITHOUT an outcome folds to processing — never failed (INV-X01)", () => {
    const view = paymentViewFromApiIntent({
      id: "pay_live_2",
      payload: { amount: { currency: "EUR", minorUnits: "4500" }, recipient: "dest_2" },
      issuedAt: 1760051400000,
    });
    expect(view?.state).toBe("processing");
    expect(view?.stateDetail).toContain("outcome comes from observation and evidence");
    expect(view?.amount).toEqual({ minorUnits: "4500", currency: "EUR" });
    expect(view?.events[0]?.sentence).toBe("Payment intent recorded by the PaySwap API");
  });

  it("an envelope without an id folds to null (nothing is invented)", () => {
    expect(paymentViewFromApiIntent({ payload: {} })).toBeNull();
  });

  it("a 404 on the detail lookup is the honest not-found; other statuses are verbatim http-errors", async () => {
    apiFetchMock.mockResolvedValue({ status: "http-error", statusCode: 404 });
    const input = paymentsPlaneInput("p_1", undefined, CONFIGURED);
    expect(await paymentById(input, "pay_live_missing")).toEqual({ status: "not-found" });

    apiFetchMock.mockResolvedValue({ status: "http-error", statusCode: 500 });
    const errored = await paymentById(input, "pay_live_1");
    expect(errored.status).toBe("http-error");
    if (errored.status === "http-error") {
      expect(errored.statusCode).toBe(500);
      expect(errored.message).toContain("HTTP 500");
      expect(errored.message).toContain("nothing is fabricated");
    }
  });

  it("a network failure surfaces as network-error (never as an empty list)", async () => {
    apiFetchMock.mockResolvedValue({ status: "network-error", message: "ECONNREFUSED" });
    const input = paymentsPlaneInput("p_1", undefined, CONFIGURED);
    const read = await listPaymentsFor(input);
    expect(read).toEqual({ status: "network-error", message: "ECONNREFUSED" });
  });

  it("the API exposes no link records yet — the honest not-yet answer, never a fabricated link", async () => {
    const input = paymentsPlaneInput("p_1", undefined, CONFIGURED);
    const read = await paymentLinkById(input, "any_link_id");
    expect(read.status).toBe("http-error");
    if (read.status === "http-error") {
      expect(read.statusCode).toBe(404);
      expect(read.message).toContain("does not expose payment-link records yet");
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("a success envelope the surface cannot fold renders as an honest http-error", async () => {
    apiFetchMock.mockResolvedValue({ status: "ok", data: { payments: "not-an-array" } });
    const input = paymentsPlaneInput("p_1", undefined, CONFIGURED);
    const read = await listPaymentsFor(input);
    expect(read.status).toBe("http-error");
    if (read.status === "http-error") {
      expect(read.message).toContain("cannot fold");
    }
  });
});
