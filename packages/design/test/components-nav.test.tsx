import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import {
  Sidebar,
  SidebarDrawer,
  SidebarSection,
  SidebarItem,
} from "../src/components/Sidebar.js";
import { Topbar } from "../src/components/Topbar.js";
import { Badge } from "../src/components/StatusPill.js";
import { Button } from "../src/components/Button.js";

const nav = (
  <>
    <SidebarItem href="/overview">Overview</SidebarItem>
    <SidebarSection label="BUILD">
      <SidebarItem href="/twins">Twins</SidebarItem>
      <SidebarItem href="/captures">Captures</SidebarItem>
    </SidebarSection>
    <SidebarSection label="TRUST">
      <SidebarItem href="/consent">Consent &amp; Provenance</SidebarItem>
    </SidebarSection>
  </>
);

/* ---------- Sidebar (static) ---------- */

describe("Sidebar", () => {
  it("renders an aside landmark with a labelled navigation", () => {
    render(<Sidebar>{nav}</Sidebar>);
    const aside = screen.getByRole("complementary");
    expect(aside).toHaveClass("ps-sidebar", "ps-sidebar--static");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("renders grouped sections with small-caps labels", () => {
    render(<Sidebar>{nav}</Sidebar>);
    expect(screen.getByText("BUILD")).toHaveClass("ps-sidebar__section-label");
    expect(screen.getByText("TRUST")).toHaveClass("ps-label");
  });

  it("items are real anchors with hrefs (deep-linkable — reference defect not adopted)", () => {
    render(<Sidebar>{nav}</Sidebar>);
    const link = screen.getByRole("link", { name: "Twins" });
    expect(link).toHaveAttribute("href", "/twins");
    expect(link).toHaveClass("ps-sidebar__item");
  });

  it("active item carries aria-current=page and the active class", () => {
    render(
      <Sidebar>
        <SidebarItem href="/twins" active>
          Twins
        </SidebarItem>
      </Sidebar>,
    );
    const link = screen.getByRole("link", { name: "Twins" });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveClass("ps-sidebar__item--active");
  });

  it("item without href renders a button and fires onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Sidebar>
        <SidebarItem onClick={onClick}>Switch view</SidebarItem>
      </Sidebar>,
    );
    const button = screen.getByRole("button", { name: "Switch view" });
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders brand header and context footer slots", () => {
    render(
      <Sidebar
        brand={<span>PS</span>}
        footer={
          <>
            <span>ops@payswap</span>
            <Badge>ENV: LOCAL</Badge>
          </>
        }
      >
        {nav}
      </Sidebar>,
    );
    expect(screen.getByText("PS").closest(".ps-sidebar__brand")).not.toBeNull();
    expect(screen.getByText("ops@payswap").closest(".ps-sidebar__footer")).not.toBeNull();
    expect(screen.getByText("ops@payswap")).toBeInTheDocument();
    expect(screen.getByText("ENV: LOCAL")).toHaveClass("ps-badge");
  });
});

/* ---------- SidebarDrawer (mobile overlay) ---------- */

describe("SidebarDrawer", () => {
  function DrawerHarness() {
    const [open, setOpen] = useState(true);
    return (
      <SidebarDrawer open={open} onClose={() => setOpen(false)}>
        {nav}
      </SidebarDrawer>
    );
  }

  it("renders a modal Navigation dialog with Close button and the same nav", () => {
    render(<DrawerHarness />);
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Primary" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Twins" })).toBeInTheDocument();
  });

  it("renders nothing while closed", () => {
    render(
      <SidebarDrawer open={false} onClose={() => {}}>
        {nav}
      </SidebarDrawer>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape and scrim close; focus starts inside and returns to the trigger", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Menu</Button>
          <SidebarDrawer open={open} onClose={() => setOpen(false)}>
            {nav}
          </SidebarDrawer>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Menu" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(document.querySelector(".ps-dialog-scrim") as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/* ---------- Topbar ---------- */

describe("Topbar", () => {
  it("renders a banner landmark with a breadcrumb trail", () => {
    render(
      <Topbar
        breadcrumbs={[
          { label: "PaySwap Studio", href: "/" },
          { label: "Overview" },
        ]}
      />,
    );
    expect(screen.getByRole("banner")).toHaveClass("ps-topbar");
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PaySwap Studio" })).toHaveAttribute("href", "/");
    expect(screen.getByText("Overview")).toHaveAttribute("aria-current", "page");
  });

  it("the current breadcrumb is not a link", () => {
    render(
      <Topbar
        breadcrumbs={[
          { label: "Workspace", href: "/" },
          { label: "Pools" },
        ]}
      />,
    );
    expect(screen.queryByRole("link", { name: "Pools" })).toBeNull();
  });

  it("search trigger: advertised shortcut, accessible name, fires onSearch", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<Topbar onSearch={onSearch} />);
    const trigger = screen.getByRole("button", { name: "Open search" });
    expect(trigger).toHaveTextContent("Search…");
    expect(trigger).toHaveTextContent("⌘K");
    expect(trigger.querySelector("kbd")).toHaveClass("ps-topbar__kbd");
    await user.click(trigger);
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("renders leading, badges and action slots", () => {
    render(
      <Topbar
        leading={<button type="button">Open navigation</button>}
        badges={<Badge>ENV: LOCAL</Badge>}
        actions={<Button variant="primary">Create goal</Button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
    expect(screen.getByText("ENV: LOCAL")).toHaveClass("ps-badge");
    expect(screen.getByRole("button", { name: "Create goal" })).toHaveClass(
      "ps-button--primary",
    );
  });

  it("omits the search trigger when no handler is given", () => {
    render(<Topbar />);
    expect(screen.queryByRole("button", { name: /search/i })).toBeNull();
  });
});
