import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ConsumerPaymentDetail,
  whenItArrivedLine,
} from "../src/components/consumer/consumer-payment-detail";
import { MyContacts } from "../src/components/consumer/my-contacts";
import { MyRequests } from "../src/components/consumer/my-requests";
import {
  PAY_TEST_FAILED_INSUFFICIENT,
  PAY_TEST_PROCESSING,
  PAY_TEST_SUCCEEDED_CROSS_RAIL,
} from "../src/app/app/payments/_server/test-fixtures";

/**
 * UX-006 — the consumer collections and the payment detail in the CONSUMER
 * projection (contract 10 §2/§7): contacts (the customers projection),
 * requests (the catalog projection) — honest empties that teach — and the
 * detail that folds settlements into "when it arrived" with levels 0–1 only
 * (deeper routes to the collapsed "technical details" section; the
 * chain/gas/ABI spot-check battery runs against the LEVEL 0–1 body).
 */

/** Split the technical-details <details> off the level 0–1 main body. */
function mainBody(html: string): string {
  const marker = 'data-testid="consumer-payment-technical"';
  const at = html.indexOf(marker);
  if (at < 0) {
    return html;
  }
  return html.slice(0, at);
}

describe("consumer views: My contacts (the customers projection)", () => {
  it("empty: the honest empty teaches how contacts are created (hosted-payment guests)", () => {
    const html = renderToStaticMarkup(<MyContacts contacts={[]} />);
    expect(html).toContain('data-testid="my-contacts"');
    expect(html).toContain("No contacts yet");
    expect(html).toContain("hosted payment page or a payment link");
    expect(html).toContain("guests");
    expect(html).toContain("Nothing is fabricated");
    expect(html).not.toMatch(/data-testid="[^"]*row/); // no fabricated rows
  });

  it("populated (test-driven): verified and unverified entries render honestly", () => {
    const html = renderToStaticMarkup(
      <MyContacts
        contacts={[
          {
            id: "cus_test_amara",
            name: "Amara Okafor",
            verified: { kind: "email", value: "amara@example.test" },
            createdAt: "2026-10-01T09:00:00Z",
          },
          {
            id: "cus_test_guest_2",
            name: "Guest from link_test_retainer",
            verified: null,
            createdAt: "2026-10-03T12:00:00Z",
          },
        ]}
      />,
    );
    expect(html).toContain("Amara Okafor");
    expect(html).toContain("Verified (email)");
    expect(html).toContain("amara@example.test");
    expect(html).toContain("Guest from link_test_retainer");
    expect(html).toContain("Not verified yet");
  });
});

describe("consumer views: My requests (the catalog projection)", () => {
  it("empty: the honest empty teaches how requests arrive", () => {
    const html = renderToStaticMarkup(<MyRequests requests={[]} />);
    expect(html).toContain('data-testid="my-requests"');
    expect(html).toContain("No requests addressed to you yet");
    expect(html).toContain("payment request or payment link");
    expect(html).toContain("No request is ever fabricated");
  });

  it("populated (test-driven): rows track their incoming state through StatusChip", () => {
    const html = renderToStaticMarkup(
      <MyRequests
        requests={[
          {
            id: "req_test_1",
            from: "Acme Studio",
            title: "October retainer",
            amount: { minorUnits: "25000000", currency: "USDC" },
            state: "processing",
            createdAt: "2026-10-04T08:00:00Z",
          },
        ]}
      />,
    );
    expect(html).toContain("25 USDC");
    expect(html).toContain("Acme Studio");
    expect(html).toMatch(/data-state="processing"/);
  });
});

describe("consumer views: the payment detail projection (levels 0–1 only)", () => {
  it("folds the settlement into ONE 'When it arrived' section — no separate payout card", () => {
    const payment = PAY_TEST_SUCCEEDED_CROSS_RAIL;
    expect(payment.settlement).toBeDefined();
    const html = renderToStaticMarkup(
      <ConsumerPaymentDetail payment={payment} worldLabel="test mode" />,
    );
    expect(html).toContain("When it arrived");
    expect(whenItArrivedLine(payment)).toBe("Arrived in EUR via SEPA. Expected 2026-10-08.");
    expect(html).toContain(whenItArrivedLine(payment));
    // The merchant anatomy's separate payout sections are folded away.
    expect(html).not.toContain("Payout");
    expect(html).not.toContain("Settles in");
    expect(html).not.toContain("view in Balances");
  });

  it("a payment on its way says so honestly (never a failure, never an invented arrival)", () => {
    expect(whenItArrivedLine(PAY_TEST_PROCESSING)).toContain("On its way");
    expect(whenItArrivedLine(PAY_TEST_PROCESSING)).toContain("No arrival time is invented");
    // With a settlement attached, the same in-flight payment names the arrival.
    expect(
      whenItArrivedLine({
        ...PAY_TEST_PROCESSING,
        settlement: { asset: "GHS", rail: "Mobile money (MTN)", expectedDate: "2026-10-07" },
      }),
    ).toBe("On its way — expected in GHS via Mobile money (MTN). Expected 2026-10-07.");
    // A failed payment never implies money might still arrive.
    expect(whenItArrivedLine(PAY_TEST_FAILED_INSUFFICIENT)).toBe(
      "Nothing is arriving — this payment did not complete.",
    );
  });

  it("level 0: amount, status chip, people — with the registry reason for failures", () => {
    const ok = renderToStaticMarkup(
      <ConsumerPaymentDetail payment={PAY_TEST_SUCCEEDED_CROSS_RAIL} worldLabel="test mode" />,
    );
    expect(ok).toContain("25 USDC");
    expect(ok).toMatch(/data-state="succeeded"/);
    expect(ok).toContain("With Amara Okafor");
    expect(ok).toContain("This payment completed.");
    // The statement-descriptor expectation (security contract §5).
    expect(ok).toContain("PAYSWAP*ORDER1024");

    const failed = renderToStaticMarkup(
      <ConsumerPaymentDetail payment={PAY_TEST_FAILED_INSUFFICIENT} worldLabel="test mode" />,
    );
    expect(failed).toContain('data-testid="consumer-payment-reason"');
    expect(failed).toContain("Insufficient balance");
  });

  it("level 1: fees, the masked method with its checks, the arrival time", () => {
    const html = renderToStaticMarkup(
      <ConsumerPaymentDetail payment={PAY_TEST_SUCCEEDED_CROSS_RAIL} worldLabel="test mode" />,
    );
    expect(html).toContain("How it was paid");
    expect(html).toContain("Wallet 0x12…ab90");
    expect(html).toContain("Signature verified");
    expect(html).toContain("Passed");
    // The fixture's fee is 880000 minor units of USDC (exponent 6) — the
    // exact formatter renders "0.880000 USDC", never a rounded "8.80".
    expect(html).toContain("0.880000 USDC");
  });

  it("the technical details are COLLAPSED — identifiers and the event log live inside one details section", () => {
    const html = renderToStaticMarkup(
      <ConsumerPaymentDetail payment={PAY_TEST_SUCCEEDED_CROSS_RAIL} worldLabel="test mode" />,
    );
    const technical = html.slice(html.indexOf('data-testid="consumer-payment-technical"'));
    expect(html).toContain("<details");
    // The event log and the copyable id are inside the collapsed section.
    expect(technical).toContain('data-testid="consumer-payment-events"');
    expect(technical).toContain("Payment started");
    // …and NOT in the level 0–1 main body.
    expect(mainBody(html)).not.toContain("Payment started");
    expect(mainBody(html)).not.toContain("copy-payment-id");
  });

  it("'Report a problem' routes to the safety center with the payment preselected", () => {
    const html = renderToStaticMarkup(
      <ConsumerPaymentDetail payment={PAY_TEST_SUCCEEDED_CROSS_RAIL} worldLabel="test mode" />,
    );
    expect(html).toContain('data-testid="consumer-report-problem-link"');
    expect(html).toContain('href="/app/safety?payment=pay_test_usdc_base_to_eur"');
  });

  it("the level 0–1 body carries no chain/gas/ABI vocabulary beyond asset names (the spot-check battery)", () => {
    for (const payment of [
      PAY_TEST_SUCCEEDED_CROSS_RAIL,
      PAY_TEST_FAILED_INSUFFICIENT,
      PAY_TEST_PROCESSING,
    ]) {
      const html = renderToStaticMarkup(
        <ConsumerPaymentDetail payment={payment} worldLabel="test mode" />,
      );
      const body = mainBody(html);
      expect(body).not.toMatch(/\bgas\b|\bABI\b|\bnonce\b|block \d+|smart contract|\bchain\b/i);
      // Asset names are the consumer's allowed vocabulary — each fixture's
      // OWN currency renders in the level-0 amount (USDC, EUR, GHS…).
      expect(body).toMatch(new RegExp(payment.amount.currency, "i"));
    }
  });
});
