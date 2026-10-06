import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ListPage } from "../src/components/ListPage.js";
import { EmptyState } from "../src/components/States.js";
import { Button } from "../src/components/Button.js";
import { StatusChip } from "../src/components/StatusChip.js";

const componentsCss = readFileSync(
  join(process.cwd(), "src", "components.css"),
  "utf8",
);

const COLUMNS = ["Amount", "Status", "Rail/Method", "Description", "Date", "Failure reason"];

function makeRows() {
  return [
    {
      id: "pay_1",
      href: "/transactions/pay_1",
      cells: [
        "€25.00",
        <StatusChip key="s" state="succeeded" />,
        "SEPA",
        "Order #124",
        "Oct 6, 12:04",
        "—",
      ],
    },
    {
      id: "pay_2",
      href: "/transactions/pay_2",
      cells: [
        "€10.00",
        <StatusChip key="s" state="failed" />,
        "SEPA",
        "Order #125",
        "Oct 6, 12:10",
        "Insufficient balance",
      ],
      menu: <Button size="sm">Row actions</Button>,
    },
  ];
}

/* ---------- anatomy (contract 03 §2.1) ---------- */

describe("ListPage anatomy", () => {
  it("renders header (title + create + secondary), toolbar slots, table, footer", () => {
    render(
      <ListPage
        title="Transactions"
        create={<Button>Create</Button>}
        secondaryActions={<Button variant="ghost">Export</Button>}
        subtabs={<div data-testid="subtabs">tabs</div>}
        statusChips={<div data-testid="chips">chips</div>}
        filter={<div data-testid="filter">filter</div>}
        columns={COLUMNS}
        rows={makeRows()}
        pagination={{ from: 1, to: 25, total: 132 }}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Transactions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByTestId("subtabs")).toBeInTheDocument();
    expect(screen.getByTestId("chips")).toBeInTheDocument();
    expect(screen.getByTestId("filter")).toBeInTheDocument();

    const table = screen.getByRole("table");
    for (const column of COLUMNS) {
      expect(
        within(table).getByRole("columnheader", { name: column }),
      ).toBeInTheDocument();
    }
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2 data rows
    expect(screen.getByText("1–25 of 132 results")).toBeInTheDocument();
  });

  it("renders the trailing row-menu column with an SR-only header", () => {
    render(<ListPage title="T" columns={COLUMNS} rows={makeRows()} />);
    expect(
      screen.getByRole("columnheader", { name: "Row actions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Row actions" }),
    ).toBeInTheDocument();
  });

  it("rows are links drilled to detail (stretched anchor, real href)", () => {
    render(<ListPage title="T" columns={COLUMNS} rows={makeRows()} />);
    const links = document.querySelectorAll("a.ps-table__row-link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/transactions/pay_1");
    expect(links[0]).toHaveClass("ps-table__row-link");
  });

  it("rows render at the 44px minimum height and sticky header via CSS", () => {
    expect(componentsCss).toContain(".ps-table__row {");
    expect(componentsCss).toMatch(/\.ps-table__row \{[^}]*height: 44px/s);
    expect(componentsCss).toMatch(/\.ps-table__th \{[^}]*position: sticky/s);
  });
});

/* ---------- empty / loading ---------- */

describe("ListPage states", () => {
  it("renders the collection's EmptyState when there are no rows", () => {
    render(
      <ListPage
        title="Disputes"
        columns={COLUMNS}
        rows={[]}
        empty={
          <EmptyState
            title="No disputes yet"
            description="Disputes appear here when a payer contests a payment."
          />
        }
      />,
    );
    expect(
      screen.getByRole("heading", { name: "No disputes yet" }),
    ).toBeInTheDocument();
    const cell = document.querySelector(".ps-table__empty")!;
    expect(cell).toHaveAttribute("colspan", String(COLUMNS.length));
  });

  it("falls back to an honest default empty (never a bare table)", () => {
    render(<ListPage title="T" columns={COLUMNS} />);
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("loading renders skeleton rows matching the final layout, never a page-gating spinner", () => {
    render(
      <ListPage title="T" columns={COLUMNS} loading loadingRowCount={3} />,
    );
    const skeletons = document.querySelectorAll(".ps-table__skeleton");
    expect(skeletons).toHaveLength(3 * COLUMNS.length);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(document.querySelector("tbody")).toHaveAttribute("aria-busy", "true");
  });
});

/* ---------- keyboard semantics (contract 03 §3) ---------- */

describe("ListPage keyboard", () => {
  it("arrow keys traverse the row links; Enter would follow the focused anchor", async () => {
    const user = userEvent.setup();
    render(<ListPage title="T" columns={COLUMNS} rows={makeRows()} />);
    const links = document.querySelectorAll<HTMLAnchorElement>(
      "a.ps-table__row-link",
    );
    links[0]!.focus();
    expect(links[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(links[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(links[0]).toHaveFocus();
  });
});

/* ---------- footer / pagination ---------- */

describe("ListPage footer", () => {
  it("pagination buttons call through and disable without handlers", async () => {
    const user = userEvent.setup();
    const onPreviousPage = vi.fn();
    const onNextPage = vi.fn();
    const { unmount } = render(
      <ListPage
        title="T"
        columns={COLUMNS}
        rows={makeRows()}
        pagination={{ from: 26, to: 50, total: 132, onPreviousPage, onNextPage }}
      />,
    );
    expect(screen.getByText("26–50 of 132 results")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPreviousPage).toHaveBeenCalledTimes(1);
    expect(onNextPage).toHaveBeenCalledTimes(1);
    unmount();

    render(
      <ListPage
        title="T"
        columns={COLUMNS}
        rows={makeRows()}
        pagination={{ from: 1, to: 2, total: 2 }}
      />,
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("omits the footer entirely when no pagination is given", () => {
    render(<ListPage title="T" columns={COLUMNS} rows={makeRows()} />);
    expect(document.querySelector(".ps-listpage__footer")).toBeNull();
  });
});

/* ---------- EmptyState contract anatomy (03 §2.3) ---------- */

describe("EmptyState contract anatomy", () => {
  it("pairs a value proposition with a CTA, docs link and teaching line", () => {
    render(
      <EmptyState
        title="Create your first invoice"
        description="Invoices bill customers on a schedule you control."
        action={<Button>Create an invoice</Button>}
        docs={{ href: "https://docs.example.test/invoices", label: "How invoices work" }}
        teachingLine="You can simulate an invoice in test mode to see the full lifecycle."
      />,
    );
    expect(
      screen.getByRole("heading", { level: 3, name: "Create your first invoice" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create an invoice" }),
    ).toBeInTheDocument();
    const docs = screen.getByRole("link", { name: "How invoices work" });
    expect(docs).toHaveAttribute("href", "https://docs.example.test/invoices");
    expect(docs).toHaveClass("ps-state__docs");
    expect(
      screen.getByText(/simulate an invoice in test mode/i),
    ).toHaveClass("ps-state__teaching");
  });

  it("keeps the pre-existing shape: title/description/action only still works", () => {
    render(
      <EmptyState title="No evidence yet" description="Nothing attached." />,
    );
    expect(screen.getByRole("status")).toHaveClass("ps-state--neutral");
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector(".ps-state__teaching")).toBeNull();
  });
});
