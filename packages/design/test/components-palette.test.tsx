import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import {
  CommandPalette,
  fuzzyMatch,
  type PaletteSection,
} from "../src/components/CommandPalette.js";
import { useCommandKey } from "../src/hooks/useCommandKey.js";

const sections: PaletteSection[] = [
  {
    id: "actions",
    label: "Actions",
    commands: [
      { id: "create", label: "Create goal", run: () => {} },
      { id: "refresh", label: "Refresh overview", run: () => {} },
    ],
  },
  {
    id: "go-to",
    label: "Go to",
    commands: [
      { id: "nav-pools", label: "Pools", group: "Command center", run: () => {} },
      { id: "nav-evidence", label: "Evidence", group: "Trust", run: () => {} },
    ],
  },
];

function Harness({ sections: s = sections }: { sections?: PaletteSection[] }) {
  const [open, setOpen] = useState(false);
  useCommandKey(() => setOpen((v) => !v));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandPalette open={open} onClose={() => setOpen(false)} sections={s} />
    </>
  );
}

describe("fuzzyMatch", () => {
  it("matches case-insensitive subsequences", () => {
    expect(fuzzyMatch("tw", "Create Twin")).toBe(true);
    expect(fuzzyMatch("TW", "create twin")).toBe(true);
    expect(fuzzyMatch("pz", "Pools")).toBe(false);
    expect(fuzzyMatch("", "anything")).toBe(true);
  });
});

describe("CommandPalette", () => {
  it("renders nothing while closed", () => {
    render(<CommandPalette open={false} onClose={() => {}} sections={sections} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens via ⌘K/Ctrl-K (useCommandKey wiring) and renders the combobox + grouped listbox", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.keyboard("{Control>}k{/Control}");
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toBeInTheDocument();
    const combobox = screen.getByRole("combobox");
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    expect(combobox).toHaveAttribute("aria-autocomplete", "list");
    expect(screen.getByRole("listbox", { name: "Suggestions" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Go to" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Pools/ })).toBeInTheDocument();
    expect(combobox).toHaveFocus();
  });

  it("the input is reachable and the dialog is modal", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("fuzzy-filters options as the query types", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    await user.type(screen.getByRole("combobox"), "tw");
    // "Create goal"? no t-w subsequence... "goal" has no tw; only Twin-like entries survive
    expect(screen.queryByRole("option", { name: /Create goal/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Pools/ })).toBeNull();
  });

  it("keyword-only matches still surface commands", async () => {
    const user = userEvent.setup();
    const s: PaletteSection[] = [
      {
        id: "actions",
        label: "Actions",
        commands: [
          { id: "a", label: "Refresh", keywords: "reload sync", run: () => {} },
        ],
      },
    ];
    render(
      <CommandPalette open onClose={() => {}} sections={s} />,
    );
    await user.type(screen.getByRole("combobox"), "reload");
    expect(screen.getByRole("option", { name: /Refresh/ })).toBeInTheDocument();
  });

  it("shows the honest empty message when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    await user.type(screen.getByRole("combobox"), "zzz-no-match");
    expect(screen.getByText(/no matching commands/i)).toBeInTheDocument();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("ArrowDown moves aria-activedescendant and aria-selected together", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    const combobox = screen.getByRole("combobox");
    expect(
      screen.getByRole("option", { name: /Create goal/ }).getAttribute("aria-selected"),
    ).toBe("true");
    await user.keyboard("{ArrowDown}");
    const second = screen.getByRole("option", { name: /Refresh overview/ });
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(combobox.getAttribute("aria-activedescendant")).toBe(second.id);
    expect(second).toHaveClass("ps-palette__option--active");
  });

  it("ArrowUp wraps from the first option to the last", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    await user.keyboard("{ArrowUp}");
    const last = screen.getByRole("option", { name: /Evidence/ });
    expect(last.getAttribute("aria-selected")).toBe("true");
  });

  it("Enter runs the active command and closes", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const s: PaletteSection[] = [
      { id: "actions", label: "Actions", commands: [{ id: "go", label: "Run report", run }] },
    ];
    function H() {
      const [open, setOpen] = useState(true);
      return <CommandPalette open={open} onClose={() => setOpen(false)} sections={s} />;
    }
    render(<H />);
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking an option runs it and closes", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    const s: PaletteSection[] = [
      { id: "go", label: "Go to", commands: [{ id: "x", label: "Pools", group: "Command center", run }] },
    ];
    function H() {
      const [open, setOpen] = useState(true);
      return <CommandPalette open={open} onClose={() => setOpen(false)} sections={s} />;
    }
    render(<H />);
    await user.click(screen.getByRole("option", { name: /Pools/ }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disabled commands are skipped by arrow keys and cannot run", async () => {
    const user = userEvent.setup();
    const runDisabled = vi.fn();
    const runNext = vi.fn();
    const s: PaletteSection[] = [
      {
        id: "actions",
        label: "Actions",
        commands: [
          { id: "first", label: "First", run: () => {} },
          { id: "blocked", label: "Blocked", disabled: true, run: runDisabled },
          { id: "third", label: "Third", run: runNext },
        ],
      },
    ];
    render(<CommandPalette open onClose={() => {}} sections={s} />);
    const combobox = screen.getByRole("combobox");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Third" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await user.keyboard("{ArrowUp}{ArrowDown}");
    // go back up to Blocked via Home then ArrowDown twice — simpler: Home, End checks
    await user.keyboard("{Home}");
    await user.keyboard("{ArrowRight>}{/ArrowRight}");
    // Enter on the disabled second option after navigating: Home->ArrowDown lands on Third (skips Blocked)
    await user.keyboard("{Enter}");
    expect(runDisabled).not.toHaveBeenCalled();
    expect(combobox).toBeInTheDocument();
  });

  it("Escape closes and focus returns to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open palette" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("clears the query when reopened", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    await user.type(screen.getByRole("combobox"), "zz");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("renders the group suffix chip on Go-to style options", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    const option = screen.getByRole("option", { name: /Pools/ });
    expect(option.querySelector(".ps-palette__option-group")).toHaveTextContent(
      "Command center",
    );
  });
});
