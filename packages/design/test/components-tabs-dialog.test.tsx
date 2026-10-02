import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { Tabs, type TabItem } from "../src/components/Tabs.js";
import { Dialog } from "../src/components/Dialog.js";
import { Button } from "../src/components/Button.js";

const items: TabItem[] = [
  { id: "overview", label: "Overview", content: "overview panel" },
  { id: "evidence", label: "Evidence", content: "evidence panel" },
  { id: "history", label: "History", content: "history panel" },
];

/* ---------- Tabs ---------- */

describe("Tabs", () => {
  it("renders a labelled tablist with tabs and a single visible panel", () => {
    render(<Tabs label="Result views" items={items} />);
    const tablist = screen.getByRole("tablist", { name: "Result views" });
    expect(tablist).toHaveClass("ps-tabs__list");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Evidence" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("overview panel");
  });

  it("wires tab<->panel ids both ways (aria-controls / aria-labelledby)", () => {
    render(<Tabs label="Views" items={items} />);
    // every tab's aria-controls resolves (all panels are mounted; inactive are hidden)
    for (const item of items) {
      const tab = screen.getByRole("tab", { name: item.label as string });
      const panel = document.getElementById(tab.getAttribute("aria-controls")!);
      expect(panel).not.toBeNull();
      expect(panel!.getAttribute("aria-labelledby")).toBe(tab.id);
    }
    // inactive panels are hidden from the a11y tree; only the active is visible
    expect(screen.getByRole("tabpanel")).toHaveTextContent("overview panel");
    expect(document.querySelector('[role="tabpanel"][hidden]')).not.toBeNull();
  });

  it("roving tabindex: only the selected tab is tabbable", () => {
    render(<Tabs label="Views" items={items} />);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Evidence" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("tabindex", "0");
  });

  it("ArrowRight moves focus and selects (automatic activation)", async () => {
    const user = userEvent.setup();
    render(<Tabs label="Views" items={items} />);
    const first = screen.getByRole("tab", { name: "Overview" });
    first.focus();
    await user.keyboard("{ArrowRight}");
    const second = screen.getByRole("tab", { name: "Evidence" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("evidence panel");
  });

  it("ArrowLeft wraps from the first tab to the last", async () => {
    const user = userEvent.setup();
    render(<Tabs label="Views" items={items} />);
    screen.getByRole("tab", { name: "Overview" }).focus();
    await user.keyboard("{ArrowLeft}");
    const last = screen.getByRole("tab", { name: "History" });
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute("aria-selected", "true");
  });

  it("Home and End jump to the first and last tabs", async () => {
    const user = userEvent.setup();
    render(<Tabs label="Views" items={items} />);
    screen.getByRole("tab", { name: "Overview" }).focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "History" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("skips disabled tabs while arrowing", async () => {
    const user = userEvent.setup();
    render(
      <Tabs
        label="Views"
        items={[
          { id: "a", label: "A", content: "a" },
          { id: "b", label: "B", content: "b", disabled: true },
          { id: "c", label: "C", content: "c" },
        ]}
      />,
    );
    screen.getByRole("tab", { name: "A" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "C" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "B" })).toBeDisabled();
  });

  it("click selects and fires onValueChange", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Tabs label="Views" items={items} onValueChange={onValueChange} />);
    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(onValueChange).toHaveBeenCalledWith("history");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("history panel");
  });

  it("controlled value: consumer state is the source of truth", async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [value, setValue] = useState("overview");
      return (
        <Tabs
          label="Views"
          items={items}
          value={value}
          onValueChange={setValue}
        />
      );
    }
    render(<Controlled />);
    await user.click(screen.getByRole("tab", { name: "Evidence" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("evidence panel");
    expect(screen.getByRole("tab", { name: "Evidence" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

/* ---------- Dialog ---------- */

describe("Dialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(
      <Dialog open={false} onClose={() => {}} title="Confirm" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders an aria-modal dialog labelled by its title with a Close button", () => {
    render(
      <Dialog open onClose={() => {}} title="Confirm retry" description="Try again now?">
        body text
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Confirm retry" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.getAttribute("aria-describedby")).toBe(
      screen.getByText("Try again now?").id,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(dialog).toHaveClass("ps-dialog");
  });

  it("Escape calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="T">
        body
      </Dialog>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Close button and scrim click call onClose; body clicks do not", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open onClose={onClose} title="T">
        <p>inner</p>
      </Dialog>,
    );
    await user.click(screen.getByText("inner"));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <Dialog open onClose={onClose} title="T" closeOnScrimClick>
        <p>inner</p>
      </Dialog>,
    );
    await user.click(document.querySelector(".ps-dialog-scrim")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("focus starts inside the dialog and Tab wraps within it", async () => {
    const user = userEvent.setup();
    render(
      <Dialog
        open
        onClose={() => {}}
        title="Pick"
        footer={
          <>
            <Button>Cancel</Button>
            <Button variant="primary">Confirm</Button>
          </>
        }
      >
        body
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
    const confirm = screen.getByRole("button", { name: "Confirm" });
    confirm.focus();
    await user.keyboard("{Tab}"); // wraps past the last focusable back inside
    expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
    expect(document.activeElement).not.toBe(confirm);
  });

  it("restores focus to the trigger on close", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open dialog</Button>
          <Dialog open={open} onClose={() => { setOpen(false); onClose(); }} title="T">
            body
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("locks body scroll while open and releases on close", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onClose={() => setOpen(false)} title="T">
          body
        </Dialog>
      );
    }
    render(<Harness />);
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    expect(document.body.style.overflow).toBe("");
  });
});
