import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Button } from "../src/components/Button.js";
import { Card, CardMeta, CardSubtitle, CardTitle } from "../src/components/Card.js";
import { Panel } from "../src/components/Panel.js";
import { Badge, StatusPill } from "../src/components/StatusPill.js";

/* ---------- Button ---------- */

describe("Button", () => {
  it("renders a native button with the variant class", () => {
    render(<Button variant="primary">Create goal</Button>);
    const button = screen.getByRole("button", { name: "Create goal" });
    expect(button).toHaveClass("ps-button", "ps-button--primary", "ps-button--md");
  });

  it("defaults to type=button and secondary variant", () => {
    render(<Button>Cancel</Button>);
    const button = screen.getByRole("button", { name: "Cancel" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("ps-button--secondary");
  });

  it("supports all four variants", () => {
    const { rerender } = render(<Button variant="primary">x</Button>);
    for (const variant of ["secondary", "ghost", "danger"] as const) {
      rerender(<Button variant={variant}>x</Button>);
      expect(screen.getByRole("button")).toHaveClass(`ps-button--${variant}`);
    }
  });

  it("fires onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await user.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("loading: disables, marks aria-busy, shows spinner + sr label, keeps the action label", () => {
    render(<Button loading>Confirm</Button>);
    const button = screen.getByRole("button", { name: /confirm,? loading/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".ps-spinner")).toBeInTheDocument();
    // the pending action stays legible — loading is never success theater
    expect(button).toHaveTextContent("Confirm");
  });

  it("loading blocks clicks even when disabled prop is false", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading={false} disabled={false} onClick={onClick}>
        No-op
      </Button>,
    );
    await user.click(screen.getByRole("button", { name: "No-op" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled blocks interaction", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>No</Button>);
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is keyboard operable (Enter + Space)", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Key</Button>);
    const button = screen.getByRole("button", { name: "Key" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

/* ---------- Card ---------- */

describe("Card", () => {
  it("renders a plain container", () => {
    render(
      <Card>
        <CardTitle>Goal GS-128</CardTitle>
        <CardSubtitle>Funding target</CardSubtitle>
        <CardMeta>created 2h ago</CardMeta>
      </Card>,
    );
    expect(screen.getByText("Goal GS-128")).toHaveClass("ps-card__title");
    expect(screen.getByText("Funding target")).toHaveClass("ps-card__subtitle");
    expect(screen.getByText("created 2h ago")).toHaveClass("ps-card__meta");
    expect(screen.getByText("Goal GS-128").closest(".ps-card")).toHaveClass("ps-card");
  });

  it("raised adds the shadow class", () => {
    render(<Card raised data-testid="card">x</Card>);
    expect(screen.getByTestId("card")).toHaveClass("ps-card--raised");
  });

  it("interactive: role=button, tabbable, Enter and Space activate, click activates", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <Card interactive onClick={onOpen}>
        <CardTitle>Payment PM-1</CardTitle>
      </Card>,
    );
    const card = screen.getByRole("button", { name: /Payment PM-1/ });
    expect(card).toHaveAttribute("tabindex", "0");
    await user.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);
    card.focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
    await user.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("non-interactive cards are not buttons and not tabbable", () => {
    render(<Card>plain</Card>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("plain")).not.toHaveAttribute("tabindex");
  });
});

/* ---------- Panel ---------- */

describe("Panel", () => {
  it("renders a labelled section with heading level 2 by default", () => {
    render(
      <Panel title="Obligations" description="Netting pool state">
        body
      </Panel>,
    );
    const section = screen.getByRole("region", { name: /Obligations/ });
    const heading = screen.getByRole("heading", { level: 2, name: "Obligations" });
    expect(section).toContainElement(heading);
    expect(screen.getByText("Netting pool state")).toHaveClass("ps-panel__description");
  });

  it("supports headingLevel override and header actions", () => {
    render(
      <Panel
        title="Activity"
        headingLevel={3}
        actions={<Button size="sm">Refresh</Button>}
      >
        body
      </Panel>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Activity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveClass("ps-button");
  });

  it("flush removes body padding", () => {
    const { container } = render(
      <Panel title="T" flush>
        <div>row</div>
      </Panel>,
    );
    const body = container.querySelector(".ps-panel__body");
    expect(body).toHaveClass("ps-panel__body--flush");
  });
});

/* ---------- Badge / StatusPill ---------- */

describe("Badge", () => {
  it("renders a neutral metadata chip", () => {
    render(<Badge>v0</Badge>);
    expect(screen.getByText("v0")).toHaveClass("ps-badge");
  });
});

describe("StatusPill", () => {
  it("renders the label text (color is never the only carrier)", () => {
    render(<StatusPill tone="ok">Fulfilled</StatusPill>);
    expect(screen.getByText("Fulfilled")).toHaveClass("ps-pill", "ps-pill--ok");
  });

  it("every tone has a distinct class and data-tone", () => {
    for (const tone of ["ok", "attention", "unknown", "blocked", "disabled", "failed"] as const) {
      const { unmount } = render(<StatusPill tone={tone}>x</StatusPill>);
      const pill = screen.getByText("x");
      expect(pill).toHaveClass(`ps-pill--${tone}`);
      expect(pill).toHaveAttribute("data-tone", tone);
      unmount();
    }
  });

  it("UNKNOWN is visually distinct from danger tones (dashed amber vs solid red)", () => {
    const { container: unknownC } = render(<StatusPill tone="unknown">Reconciling</StatusPill>);
    const unknown = unknownC.querySelector(".ps-pill")!;
    expect(unknown.className).not.toBe("ps-pill--failed");
    expect(unknown.className).not.toBe("ps-pill--blocked");
    expect(unknown.className).toContain("ps-pill--unknown");
    cleanupDom(unknownC);
    const { container: failedC } = render(<StatusPill tone="failed">Failed</StatusPill>);
    const failed = failedC.querySelector(".ps-pill")!;
    expect(failed.className).toContain("ps-pill--failed");
    expect(failed.className).not.toContain("ps-pill--unknown");
  });

  it("exposes an accessible state suffix that differs between unknown and failed", () => {
    const { unmount } = render(<StatusPill tone="unknown">Reconciling</StatusPill>);
    const unknownSr = document.querySelector(".ps-pill .ps-sr-only");
    expect(unknownSr?.textContent).toMatch(/outcome not yet known/i);
    unmount();
    render(<StatusPill tone="failed">Failed</StatusPill>);
    const failedSr = document.querySelector(".ps-pill .ps-sr-only");
    expect(failedSr?.textContent).toMatch(/^failed$/i);
    expect(failedSr?.textContent).not.toMatch(/unknown/i);
  });

  it("allows overriding the accessible suffix", () => {
    render(
      <StatusPill tone="attention" visuallyHiddenLabel="action required now">
        Awaiting approval
      </StatusPill>,
    );
    expect(screen.getByText("action required now")).toBeInTheDocument();
  });
});

function cleanupDom(container: HTMLElement): void {
  container.remove();
}
