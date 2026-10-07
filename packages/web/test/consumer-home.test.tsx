import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ConsumerHome,
  ConsumerBalanceHeader,
  ConsumerTodayCard,
  ConsumerMyPayments,
  consumerPaymentHref,
} from "../src/components/consumer/consumer-home";
import type { HomeRailBalance } from "../src/components/shell/home-blocks";
import type { PaymentRecordView } from "../src/app/app/payments/_view/payment-view";
import type { PaymentsReadResult } from "../src/app/app/payments/_server/payments-plane";
import {
  PAY_TEST_FIXTURES,
  PAY_TEST_SUCCEEDED_CROSS_RAIL,
} from "../src/app/app/payments/_server/test-fixtures";

/**
 * UX-006 — the consumer home (contract 10 §3, NORMATIVE order): Balance
 * header → Today mirror → My payments → Safety card → Recommendations.
 * Honesty law under test: no fabricated balances or totals, no merchant
 * machinery (pricing/fee schedules/catalog copy), and every empty TEACHES
 * the fill path.
 */

function homeMarkup(options?: {
  readonly rails?: readonly HomeRailBalance[];
  readonly paymentsRead?: PaymentsReadResult<readonly PaymentRecordView[]>;
}): string {
  return renderToStaticMarkup(
    <ConsumerHome
      rails={options?.rails ?? []}
      paymentsRead={options?.paymentsRead ?? { status: "ok", source: "test-fixtures", data: [] }}
      safetyFacts={{ permissions: [], warnings: [] }}
    />,
  );
}

describe("consumer home: the contract-10 §3 composition order", () => {
  it("renders Balance header → Today → My payments → Safety card → Recommendations, in that order", () => {
    const html = homeMarkup();
    const order = [
      'data-testid="consumer-balance-header"',
      'data-testid="consumer-today"',
      'data-testid="consumer-my-payments"',
      'data-testid="consumer-safety-card"',
      'data-testid="consumer-recommendations"',
    ];
    let at = -1;
    for (const marker of order) {
      const index = html.indexOf(marker);
      expect(index).toBeGreaterThan(at);
      at = index;
    }
  });
});

describe("consumer home: the balance header is honest at zero and with observations", () => {
  it("zero-state: the total renders the explicit marker, never a fabricated zero or number", () => {
    const html = renderToStaticMarkup(<ConsumerBalanceHeader rails={[]} />);
    expect(html).toContain('data-testid="consumer-balance-total"');
    expect(html).toContain("No balances observed yet");
    expect(html).toContain("Nothing is simulated");
    // No invented amount anywhere.
    expect(html).not.toMatch(/\d+\.\d{2}\s*(USDC|EUR|USD)/);
  });

  it("observed rails project per-asset chips with the reported amounts only", () => {
    const html = renderToStaticMarkup(
      <ConsumerBalanceHeader
        rails={[
          { rail: "Base (USDC)", incoming: null, available: "140.00 USDC", settlement: null },
          { rail: "Stripe", incoming: null, available: null, settlement: null },
        ]}
      />,
    );
    expect(html).toContain("Base (USDC): 140.00 USDC");
    // The unobserved rail renders no chip and no invented amount.
    expect(html).not.toContain("Stripe:");
    expect(html).toContain("observations, not custody");
  });

  it("carries the three money actions, routed to the SAME W1/W2/convert surfaces", () => {
    const html = renderToStaticMarkup(<ConsumerBalanceHeader rails={[]} />);
    expect(html).toContain(">Send<");
    expect(html).toContain('href="/app/payments?start=1"');
    expect(html).toContain(">Request<");
    expect(html).toContain('href="/app/payments/link"');
    expect(html).toContain(">Convert<");
    expect(html).toContain('href="/app/convert"');
  });
});

describe("consumer home: the Today mirror teaches at zero", () => {
  it("incoming and recurring-outflow both render honest empties with the fill path", () => {
    const html = renderToStaticMarkup(<ConsumerTodayCard />);
    expect(html).toContain('data-testid="consumer-today-incoming"');
    expect(html).toContain("No incoming payments expected today");
    expect(html).toContain("never a fabricated arrival time");
    expect(html).toContain('data-testid="consumer-today-outflows"');
    expect(html).toContain("No recurring outflows scheduled");
  });
});

describe("consumer home: My payments (the recent list)", () => {
  it("renders the fixture rows with the shared list-cell vocabulary and consumer detail links", () => {
    const html = renderToStaticMarkup(
      <ConsumerMyPayments
        read={{ status: "ok", source: "test-fixtures", data: PAY_TEST_FIXTURES }}
      />,
    );
    // The test-fixtures marking renders (contract 02 §9 — stated, never implied).
    expect(html).toContain('data-testid="test-fixtures-notice"');
    // List cells: amount "X CUR", status chips, counterparty, date, failure column.
    expect(html).toContain("25 USDC");
    expect(html).toMatch(/data-state="failed"/);
    expect(html).toContain("Amara Okafor");
    expect(html).toContain("Failure reason");
    expect(html).toContain("Insufficient balance");
    // Rows drill into the payment detail in the CONSUMER projection.
    expect(html).toContain(consumerPaymentHref("pay_test_usdc_base_to_eur"));
    // The recent list is bounded; the collection holds the rest.
    expect(html).toContain('href="/app/transactions"');
    const rowLinks = html.match(/href="\/app\?payment=[^"]+"/g) ?? [];
    expect(rowLinks.length).toBeLessThanOrEqual(4);
  });

  it("empty collection: the honest empty teaches the fill path", () => {
    const html = renderToStaticMarkup(
      <ConsumerMyPayments read={{ status: "ok", source: "test-fixtures", data: [] }} />,
    );
    expect(html).toContain('data-testid="consumer-my-payments-empty"');
    expect(html).toContain("No payments yet");
    expect(html).toContain("Make your first payment");
  });

  it("unconfigured plane: the honest read state with env-var names only", () => {
    const html = renderToStaticMarkup(
      <ConsumerMyPayments read={{ status: "unconfigured" }} />,
    );
    expect(html).toContain('data-testid="payments-unconfigured-state"');
    expect(html).toContain("WEB_APP_TEST_PAYMENT_FIXTURES");
    expect(html).not.toMatch(/=[A-Za-z0-9]{8,}/); // no values, only names
  });
});

describe("consumer home: the safety card and recommendations", () => {
  it("the safety card states the honest zero-record truth and routes [Review] to the center", () => {
    const html = homeMarkup();
    expect(html).toContain('data-testid="consumer-safety-permissions"');
    expect(html).toContain("No spending permissions granted");
    expect(html).toContain('data-testid="consumer-safety-warnings"');
    expect(html).toContain("No active warnings");
    expect(html).toContain(">Review<");
    expect(html).toContain('href="/app/safety"');
  });

  it("the recommendations render the contract's activation card verbatim", () => {
    const html = homeMarkup();
    expect(html).toContain("Get paid back instantly with a payment link.");
    expect(html).toContain(">Try<");
    expect(html).toContain('href="/app/payments/link"');
  });
});

describe("consumer home: no merchant machinery leaks into the projection", () => {
  it("carries none of the merchant home's developer/reporting machinery", () => {
    const html = homeMarkup();
    expect(html).not.toContain("home-develop"); // no Develop card
    expect(html).not.toContain("home-overview"); // no Your-overview metrics
    expect(html).not.toContain("Gross volume");
    expect(html).not.toContain("API keys");
    expect(html).not.toContain("Connect your first rail");
    expect(html).not.toContain("Withdraw");
  });

  it("renders no crypto vocabulary beyond asset names", () => {
    const html = homeMarkup({
      paymentsRead: {
        status: "ok",
        source: "test-fixtures",
        data: [PAY_TEST_SUCCEEDED_CROSS_RAIL],
      },
    });
    expect(html).not.toMatch(/\bgas\b|\bABI\b|\bnonce\b|block \d|smart contract/i);
    // Asset names themselves are the consumer's vocabulary and stay.
    expect(html).toContain("USDC");
  });
});
