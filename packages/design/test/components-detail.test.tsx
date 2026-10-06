import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ObjectDetailHeader } from "../src/components/ObjectDetailHeader.js";
import { ActivityTimeline } from "../src/components/ActivityTimeline.js";
import { RelatedObjects } from "../src/components/RelatedObjects.js";
import { RecommendationsCard } from "../src/components/RecommendationsCard.js";
import { Button } from "../src/components/Button.js";
import { ConfirmationButton } from "../src/components/ConfirmationButton.js";

/* ---------- ObjectDetailHeader (contract 03 §2.4) ---------- */

describe("ObjectDetailHeader", () => {
  it("renders display amount + StatusChip + strapline + primary action + overflow", () => {
    render(
      <ObjectDetailHeader
        amount="€25.00"
        state="succeeded"
        stateDetail="Settled in block 19200041"
        strapline="Charged to acme@example.com"
        primaryAction={<Button>Refund</Button>}
        overflowMenu={<Button variant="ghost">More</Button>}
      />,
    );
    const amount = screen.getByText("€25.00");
    expect(amount).toHaveClass("ps-detail-header__amount", "ps-num");
    expect(screen.getByTestId("ps-chip-succeeded")).toBeInTheDocument();
    expect(screen.getByText("Charged to acme@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refund" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    // the technical detail flows into the chip tooltip
    expect(screen.getByTestId("ps-chip-succeeded")).toHaveAttribute(
      "title",
      "Settled in block 19200041",
    );
  });

  it("failed objects carry the human reason line under the strapline (07 §3.2)", () => {
    render(
      <ObjectDetailHeader
        amount="€10.00"
        state="failed"
        strapline="Charged to guest@example.com"
        reason="The receiving contract reverted the transfer (reason: allowance)."
        primaryAction={<Button>Retry</Button>}
      />,
    );
    expect(screen.getByTestId("ps-chip-failed")).toBeInTheDocument();
    expect(
      screen.getByText(/receiving contract reverted the transfer/i),
    ).toHaveClass("ps-detail-header__reason");
  });

  it("state label override flows to the chip", () => {
    render(
      <ObjectDetailHeader
        amount="1 USDC"
        state="partially_refunded"
        stateLabelOverride="Partially refunded"
      />,
    );
    expect(screen.getByText("Partially refunded")).toBeInTheDocument();
  });
});

/* ---------- ActivityTimeline (contract 03 §2.5) ---------- */

describe("ActivityTimeline", () => {
  const entries = [
    { id: "e2", description: "Payment succeeded", timestamp: "12:05", actor: "System" },
    { id: "e1", description: "Payment authorized", timestamp: "12:04" },
  ];

  it("renders a reverse-chronological ordered list (consumer order preserved)", () => {
    render(<ActivityTimeline entries={entries} />);
    const list = screen.getByRole("list");
    expect(list).toHaveClass("ps-timeline");
    const items = listItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Payment succeeded");
    expect(items[1]).toHaveTextContent("Payment authorized");
    expect(screen.getByText("12:05")).toHaveClass("ps-timeline__timestamp");
    expect(screen.getByText("System")).toHaveClass("ps-timeline__actor");
  });

  it("[Add note] fires per entry when the affordance is provided", async () => {
    const user = userEvent.setup();
    const onAddNote = vi.fn();
    render(<ActivityTimeline entries={entries} onAddNote={onAddNote} />);
    const buttons = screen.getAllByRole("button", { name: "Add note" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]!);
    expect(onAddNote).toHaveBeenCalledWith("e1");
  });

  it("no onAddNote means no note buttons", () => {
    render(<ActivityTimeline entries={entries} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the empty node when there are no entries", () => {
    render(
      <ActivityTimeline entries={[]} empty={<p>No events recorded.</p>} />,
    );
    expect(screen.getByText("No events recorded.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  function listItems(): HTMLElement[] {
    return Array.from(document.querySelectorAll(".ps-timeline__item"));
  }
});

/* ---------- RelatedObjects (contract 03 §2.14) ---------- */

describe("RelatedObjects", () => {
  it("renders cross-object link groups with meta, one component everywhere", () => {
    render(
      <RelatedObjects
        groups={[
          {
            id: "settlements",
            title: "Settlements",
            links: [{ href: "/settlements/s_1", label: "s_1", meta: "€24.96" }],
          },
          {
            id: "refunds",
            title: "Refunds",
            links: [
              { href: "/refunds/r_1", label: "r_1" },
              { href: "/refunds/r_2", label: "r_2", meta: "2 refunds" },
            ],
          },
        ]}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 3, name: "Settlements" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /s_1/ })).toHaveAttribute(
      "href",
      "/settlements/s_1",
    );
    expect(screen.getByText("€24.96")).toHaveClass("ps-related__meta");
    expect(screen.getByRole("link", { name: /r_2/ })).toHaveAttribute(
      "href",
      "/refunds/r_2",
    );
  });

  it("filters empty groups and renders the empty node when nothing relates", () => {
    const { unmount } = render(
      <RelatedObjects
        groups={[
          { id: "a", title: "A", links: [] },
          { id: "b", title: "B", links: [{ href: "/b/1", label: "b1" }] },
        ]}
      />,
    );
    expect(screen.queryByRole("heading", { name: "A" })).toBeNull();
    expect(screen.getByRole("link", { name: /b1/ })).toBeInTheDocument();
    unmount();

    render(
      <RelatedObjects groups={[]} empty={<p>Nothing related.</p>} />,
    );
    expect(screen.getByText("Nothing related.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

/* ---------- RecommendationsCard (contract 03 §2.13) ---------- */

describe("RecommendationsCard", () => {
  it("pairs a one-sentence value prop with a single verb CTA (button)", async () => {
    const user = userEvent.setup();
    const onCta = vi.fn();
    render(
      <RecommendationsCard
        proposition="Accept card payments with a hosted checkout your customers finish in seconds."
        ctaLabel="Accept payments"
        onCta={onCta}
      />,
    );
    expect(
      screen.getByText(/hosted checkout your customers finish/i),
    ).toHaveClass("ps-reco__proposition");
    const cta = screen.getByRole("button", { name: "Accept payments" });
    expect(cta).toHaveClass("ps-reco__cta");
    await user.click(cta);
    expect(onCta).toHaveBeenCalledTimes(1);
  });

  it("renders the CTA as an anchor when an href is provided", () => {
    render(
      <RecommendationsCard
        proposition="Enable payouts to your bank."
        ctaLabel="Enable payouts"
        ctaHref="/settings/payouts"
      />,
    );
    expect(screen.getByRole("link", { name: "Enable payouts" })).toHaveAttribute(
      "href",
      "/settings/payouts",
    );
  });
});

/* ---------- ConfirmationButton (contract 03 §2.15) ---------- */

describe("ConfirmationButton", () => {
  it("RESTATES amount + asset in its label (accessible name)", () => {
    render(<ConfirmationButton verb="Pay" amount="25" asset="USDC" />);
    const button = screen.getByRole("button", { name: "Pay 25 USDC" });
    expect(button).toHaveClass("ps-confirm");
    // the amount is its own tabular node, never mixed with text
    expect(screen.getByText("25")).toHaveClass("ps-confirm__amount", "ps-num");
    expect(screen.getByText("USDC")).toHaveClass("ps-confirm__asset");
  });

  it("in-button Processing state: disabled, aria-busy, spinner, restated amount", () => {
    render(
      <ConfirmationButton verb="Pay" amount="25" asset="USDC" processing />,
    );
    const button = screen.getByRole("button", {
      name: /Processing 25 USDC…/,
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("data-processing", "true");
    expect(button.querySelector(".ps-spinner")).not.toBeNull();
    // never spinner-only: the amount + asset remain in the button
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("USDC…")).toBeInTheDocument();
  });

  it("idle state is enabled and carries no busy semantics", () => {
    render(<ConfirmationButton verb="Refund" amount="12.5" asset="EUR" />);
    const button = screen.getByRole("button", { name: "Refund 12.5 EUR" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).not.toHaveAttribute("data-processing");
    expect(button.querySelector(".ps-spinner")).toBeNull();
  });

  it("passes through variant/size/disabled like the Button base", () => {
    render(
      <ConfirmationButton
        verb="Pay"
        amount="1"
        asset="USDC"
        variant="danger"
        disabled
      />,
    );
    const button = screen.getByRole("button", { name: "Pay 1 USDC" });
    expect(button).toHaveClass("ps-button--danger");
    expect(button).toBeDisabled();
  });
});
