// @vitest-environment jsdom
/**
 * UX-004 — the payment object-detail anatomy (contract 05 §2, the exemplar)
 * + W4 refund modal + the payments collection row contract.
 *
 * The anatomy is ONE page shape: header → ActivityTimeline → context cards
 * (execution summary · money breakdown with the MANDATORY cross-rail
 * sentence · method details masked · risk honest · payout linkage) → raw
 * detail (copyable IDs) → RelatedObjects → receipts → events log. Fixtures
 * are the clearly-marked TEST records (pay_test_* ids, TEST environment);
 * invalid ids render the dedicated error page (resource + world + next hop).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  PAY_TEST_FAILED_INSUFFICIENT,
  PAY_TEST_FIXTURES,
  PAY_TEST_PARTIAL_REFUND,
  PAY_TEST_SUCCEEDED_CROSS_RAIL,
} from "../src/app/app/payments/_server/test-fixtures";
import { PaymentDetailView } from "../src/components/detail/payment-detail-view";
import { PaymentNotFound } from "../src/components/detail/payment-not-found";
import { PaymentsCollection } from "../src/app/app/payments/_view/payments-collection";

const WORLD_LABEL = "test mode (WEB_APP_TEST_PAYMENT_FIXTURES — clearly-marked test records)";

const clipboardWriteText = vi.fn().mockResolvedValue(undefined);

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWriteText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  clipboardWriteText.mockClear();
  vi.restoreAllMocks();
});

function renderDetail(payment = PAY_TEST_SUCCEEDED_CROSS_RAIL): void {
  render(<PaymentDetailView payment={payment} worldLabel={WORLD_LABEL} />);
}

/** The seven anatomy sections' headings, in contract order. */
const ANATOMY_ORDER = [
  "Activity",
  "Execution summary",
  "Money breakdown",
  "Method details",
  "Risk",
  "Payout",
  "Raw detail",
  "Related",
  "Receipts",
  "Events",
] as const;

describe("the payment detail anatomy (contract 05 §2)", () => {
  it("renders the seven sections in the contract's order (header → … → events)", () => {
    renderDetail();
    const header = document.querySelector(".ps-detail-header");
    expect(header).toBeTruthy();
    expect(header?.textContent).toContain("25 USDC");

    let previous: Element | null = header;
    for (const title of ANATOMY_ORDER) {
      const heading = screen.getByRole("heading", { name: title });
      expect(heading).toBeTruthy();
      if (previous !== null) {
        // Each section follows the previous one in document order.
        expect(
          previous.compareDocumentPosition(heading),
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      }
      previous = heading;
    }
  });

  it("the header carries the StatusChip, the human strapline and the Refund primary action", () => {
    renderDetail(PAY_TEST_PARTIAL_REFUND);
    const chip = screen.getByTestId("ps-chip-partially_refunded");
    expect(chip.querySelector(".ps-chip__label")?.textContent).toBe(
      "Partially refunded",
    );
    expect(screen.getByText("Charged to Amara Okafor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refund" })).toBeTruthy();
    // The overflow (More) carries the world + the copyable id.
    expect(screen.getByText("More")).toBeTruthy();
  });

  it("the MANDATORY cross-rail sentence renders on the cross-asset fixture (100% of them)", () => {
    renderDetail();
    expect(screen.getByTestId("cross-rail-sentence").textContent).toBe(
      "Customer paid USDC on Base (USDC); settled to you in EUR via SEPA",
    );
    // The same-rail fixture renders NO sentence (the line is for cross-rail only).
    cleanup();
    renderDetail(PAY_TEST_PARTIAL_REFUND);
    expect(screen.queryByTestId("cross-rail-sentence")).toBeNull();
    // Every cross-asset TEST fixture renders the sentence (test-enforced).
    for (const payment of PAY_TEST_FIXTURES) {
      if (payment.settlement !== undefined && payment.settlement.asset !== payment.amount.currency) {
        cleanup();
        renderDetail(payment);
        expect(screen.getByTestId("cross-rail-sentence")).toBeTruthy();
      }
    }
  });

  it("the money breakdown states amount, fees and the exact net", () => {
    renderDetail();
    const breakdown = screen.getByRole("heading", { name: "Money breakdown" })
      .closest("section");
    expect(breakdown?.textContent).toContain("Payment amount");
    expect(breakdown?.textContent).toContain("25 USDC");
    expect(breakdown?.textContent).toContain("Route/network fees");
    expect(breakdown?.textContent).toContain("0.880000 USDC");
    expect(breakdown?.textContent).toContain("Net amount");
    expect(breakdown?.textContent).toContain("24.120000 USDC");
  });

  it("method details render MASKED; the raw detail card stays masked with the full identifier on Copy only", () => {
    renderDetail();
    const method = screen.getByRole("heading", { name: "Method details" }).closest("section");
    expect(method?.textContent).toContain("Wallet 0x12…ab90");
    expect(method?.textContent).toContain("Signature verified");
    expect(method?.textContent).toContain("Allowance confirmed");
    expect(method?.textContent).toContain("Lagos, NG");
    // The raw detail card: masked by default (reveal/copy is explicit —
    // contract 05 §4); the Copy affordance carries the FULL public id.
    const raw = screen.getByRole("heading", { name: "Raw detail" }).closest("section");
    expect(raw?.textContent).toContain("Wallet 0x12…ab90");
    const methodCopy = within(raw as HTMLElement).getByTestId("copy-method-id");
    fireEvent.click(within(methodCopy).getByRole("button", { name: "Copy Method identifier" }));
    expect(clipboardWriteText).toHaveBeenCalledWith(
      "0x12ab90cd12ab90cd12ab90cd12ab90cd12ab90cd",
    );
  });

  it("copy-on-click copies the identifier and toasts a confirmation (never a secret)", async () => {
    renderDetail();
    const raw = screen.getByRole("heading", { name: "Raw detail" }).closest("section");
    const copy = within(raw as HTMLElement).getByTestId("copy-payment-id");
    fireEvent.click(within(copy).getByRole("button", { name: "Copy Payment ID" }));
    expect(clipboardWriteText).toHaveBeenCalledWith(PAY_TEST_SUCCEEDED_CROSS_RAIL.id);
    // The toast is a CONFIRMATION (contract 03 §3) — it lands after the
    // async clipboard write resolves.
    await waitFor(() => {
      expect(within(copy).getByText(/Payment ID copied/)).toBeTruthy();
    });
  });

  it("the risk section is honest in test mode — never a fabricated score", () => {
    renderDetail();
    const risk = screen.getByRole("heading", { name: "Risk" }).closest("section");
    expect(risk?.textContent).toContain(
      "Risk insights are only available for live data",
    );
  });

  it("the payout linkage shows the expected date as a link into Balances (navigable end-to-end)", () => {
    renderDetail();
    const payout = screen.getByRole("heading", { name: "Payout" }).closest("section");
    const balancesLink = within(payout as HTMLElement).getByRole("link", {
      name: /view in Balances/,
    });
    expect(balancesLink.getAttribute("href")).toBe("/app/balances");
    expect(payout?.textContent).toContain("2026-10-08");
  });

  it("the partially-refunded remaining-amount line renders (W4 §2)", () => {
    renderDetail(PAY_TEST_PARTIAL_REFUND);
    const line = screen.getByTestId("refund-remaining-line");
    expect(line.textContent).toContain("15 USDC still refundable on this payment");
    expect(line.textContent).toContain("10 USDC already returned");
  });

  it("failed payments surface the REGISTRY reason under the strapline + Retry in the header", () => {
    renderDetail(PAY_TEST_FAILED_INSUFFICIENT);
    const header = document.querySelector(".ps-detail-header");
    expect(header?.textContent).toContain("Insufficient balance — The source wallet holds less than the payment amount.");
    expect(screen.getByTestId("ps-chip-failed")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Retry as a new payment" }),
    ).toBeTruthy();
  });

  it("the events log: a human sentence per state change, latest first, raw rows expandable", () => {
    renderDetail();
    const log = screen.getByTestId("payment-events-log");
    const sentences = Array.from(log.querySelectorAll("li")).map(
      (li) => li.textContent ?? "",
    );
    expect(sentences.length).toBe(PAY_TEST_SUCCEEDED_CROSS_RAIL.events.length);
    // Latest first (reverse-chronological — terminal state at the top).
    expect(sentences[0]).toContain("Settled to you in EUR via the optimal route (SEPA)");
    expect(sentences[sentences.length - 1]).toContain("Payment started");
    // Human sentences, not bare codes; raw rows are the expandable detail.
    expect(sentences[0]).toContain("2026-10-06 09:31 UTC");
    expect(log.querySelector("details summary")?.textContent).toBe("Raw event");
    expect(log.querySelector("details pre")?.textContent).toContain(
      '"type": "payment.settled"',
    );
  });

  it("the ActivityTimeline carries [Add note] and the composer states the honest not-recorded outcome", () => {
    renderDetail();
    const addNoteButtons = screen.getAllByRole("button", { name: "Add note" });
    expect(addNoteButtons.length).toBe(PAY_TEST_SUCCEEDED_CROSS_RAIL.events.length);
    fireEvent.click(addNoteButtons[0] as HTMLButtonElement);
    const note = screen.getByLabelText(/^Note/);
    fireEvent.change(note, { target: { value: "Checked with Amara — all good." } });
    fireEvent.submit(note.closest("form") as HTMLFormElement);
    const outcome = screen.getByText(/Not recorded yet\./).closest("div");
    expect(outcome?.textContent).toContain(
      "Notes are events written by the authoritative PaySwap API",
    );
    expect(screen.getByText(/Checked with Amara — all good\./)).toBeTruthy();
  });

  it("receipts: “No receipts sent.” + the honest Send-receipt affordance", () => {
    renderDetail(PAY_TEST_PARTIAL_REFUND);
    expect(screen.getByText("No receipts sent.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send receipt" }));
    expect(screen.getByText(/no receipt-dispatch path is wired/)).toBeTruthy();
  });

  it("RelatedObjects link to real routes (refund, settlement, link, customer)", () => {
    renderDetail(PAY_TEST_SUCCEEDED_CROSS_RAIL);
    const related = screen.getByRole("heading", { name: "Related" }).closest("section");
    const hrefs = Array.from(
      (related as HTMLElement).querySelectorAll("a[href]"),
    ).map((anchor) => anchor.getAttribute("href"));
    expect(hrefs).toContain("/app/balances"); // settlement → Balances
    expect(hrefs).toContain("/app/payments/link/link_test_retainer"); // link detail
    expect(hrefs).toContain("/app/customers"); // the customer's payments
    // The partial-refund fixture carries its refund as a cross-object link.
    cleanup();
    renderDetail(PAY_TEST_PARTIAL_REFUND);
    const partialRelated = screen
      .getByRole("heading", { name: "Related" })
      .closest("section");
    expect(
      Array.from((partialRelated as HTMLElement).querySelectorAll("a[href]")).some(
        (anchor) => anchor.getAttribute("href") === "#refund-re_test_partial",
      ),
    ).toBe(true);
  });
});

describe("invalid ids render the dedicated error page (contract 07 §3.4)", () => {
  it("names the resource, the world and the single best next hop — never a bare 404", () => {
    render(
      <PaymentNotFound paymentId="pay_missing_1" worldLabel={WORLD_LABEL} />,
    );
    expect(screen.getByText("Payment not found")).toBeTruthy();
    expect(screen.getByText("pay_missing_1")).toBeTruthy();
    expect(screen.getByText(/looked up in test mode/)).toBeTruthy();
    const nextHop = screen.getByRole("link", { name: "View all payments" });
    expect(nextHop.getAttribute("href")).toBe("/app/payments");
  });
});

describe("W4 — the refund modal (contract 04 §2 W4, field-for-field)", () => {
  it("opens prefilled with the FULL remaining amount, editable for a partial refund", () => {
    renderDetail(PAY_TEST_PARTIAL_REFUND);
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Refund payment")).toBeTruthy();
    const amount = within(dialog).getByLabelText(/Amount/);
    expect((amount as HTMLInputElement).value).toBe("15");
    fireEvent.change(amount, { target: { value: "5" } });
    expect(within(dialog).getByRole("button", { name: "Refund 5 USDC" })).toBeTruthy();
  });

  it("the reason select offers the CERTIFIED registry labels (never free text)", () => {
    renderDetail(PAY_TEST_PARTIAL_REFUND);
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    const dialog = screen.getByRole("dialog");
    const options = Array.from(
      within(dialog).getAllByRole("option"),
    ).map((option) => option.textContent);
    for (const label of [
      "Insufficient balance",
      "Payment reverted",
      "Route unavailable",
      "Cancelled by user",
    ]) {
      expect(options).toContain(label);
    }
  });

  it("the explicit consequence line names the rail and the fee honesty", () => {
    renderDetail(PAY_TEST_PARTIAL_REFUND);
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    expect(screen.getByTestId("refund-consequence-line").textContent).toContain(
      "Returns to the customer on Base (USDC); fees are not returned.",
    );
  });

  it("confirm renders the honest not-submitted state — nothing is refunded silently", () => {
    renderDetail(PAY_TEST_PARTIAL_REFUND);
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    fireEvent.click(screen.getByRole("button", { name: /Refund 15 USDC/ }));
    const outcome = screen.getByTestId("refund-honest-outcome");
    expect(outcome.getAttribute("role")).toBe("alert");
    expect(outcome.textContent).toContain("Refund not submitted.");
    expect(outcome.textContent).toContain("payments.refund.create");
    expect(outcome.textContent).toContain("15 USDC");
  });

  it("over-refunding is blocked inline with the remaining-amount reason", () => {
    renderDetail(PAY_TEST_PARTIAL_REFUND);
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Amount/), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Refund 30 USDC/ }));
    expect(screen.getByRole("alert").textContent).toContain(
      "cannot exceed the remaining refundable amount — 15 USDC",
    );
  });

  it("refunds are unavailable on unrefundable payments (honest disable, stated reason)", () => {
    renderDetail(PAY_TEST_FAILED_INSUFFICIENT);
    // The failed payment's primary action is Retry, not Refund.
    expect(screen.queryByRole("button", { name: "Refund" })).toBeNull();
  });
});

describe("the payments collection rows (contract 03 §2.1 + 07 §3.1)", () => {
  it("renders the spec'd columns and the TEST-fixture source notice", () => {
    render(
      <PaymentsCollection
        read={{ status: "ok", source: "test-fixtures", data: PAY_TEST_FIXTURES }}
      />,
    );
    const headers = Array.from(screen.getAllByRole("columnheader")).map(
      (th) => th.textContent,
    );
    expect(headers).toEqual([
      "Amount",
      "Status",
      "Rail/Method",
      "Description",
      "Counterparty",
      "Date",
      "Failure reason",
    ]);
    expect(screen.getByTestId("test-fixtures-notice").textContent).toContain(
      "TEST",
    );
    // Rows drill to the detail route.
    const rowLinks = Array.from(document.querySelectorAll("a.ps-table__row-link"));
    expect(
      rowLinks.some((link) => link.getAttribute("href") === "/app/payments/pay_test_partial_refund"),
    ).toBe(true);
  });

  it("the Failure reason column: registry label on failed rows, “—” on healthy ones", () => {
    render(
      <PaymentsCollection
        read={{ status: "ok", source: "test-fixtures", data: PAY_TEST_FIXTURES }}
      />,
    );
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    const texts = rows.map((row) => row.textContent ?? "");
    expect(
      texts.some((text) => text.includes("Insufficient balance")),
    ).toBe(true);
    // Healthy rows keep the failure-reason cell present-but-empty (—),
    // never blank; the failed row carries the registry label.
    const failureCells = rows.map(
      (row) => row.querySelectorAll("td")[6]?.textContent ?? "",
    );
    expect(failureCells.filter((cell) => cell.trim() === "—")).toHaveLength(
      PAY_TEST_FIXTURES.length - 1,
    );
    expect(
      failureCells.some((cell) => cell.includes("Insufficient balance")),
    ).toBe(true);
  });
});
