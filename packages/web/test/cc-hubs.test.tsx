import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CatalogHub,
  CustomersHub,
  TransactionsHub,
} from "../src/components/shell/hub-blocks";

/**
 * UX-003 — the persistent-row hub surfaces (contract 09 §2): the honest
 * ListPage shells for Transactions, Customers and Catalog. Each renders the
 * component-contract anatomy (heading + subtabs + spec'd columns + the
 * collection's EmptyState); populated depth lands with UX-004 and the §20
 * certification — nothing here fabricates rows, and no surface renders a
 * blank or a 404.
 */

describe("transactions hub: the honest ListPage shell", () => {
  it("renders the heading, the New payment primary action and the four contract sub-tabs", () => {
    const html = renderToStaticMarkup(<TransactionsHub />);
    expect(html).toContain('data-testid="transactions-hub"');
    expect(html).toContain("Transactions");
    expect(html).toContain("New payment");
    expect(html).toContain('href="/app/payments?start=1"');
    for (const tab of ["Payments", "Settlements", "Top-ups", "All activity"]) {
      expect(html).toContain(tab);
    }
  });

  it("renders the spec'd columns — the failure-reason column exists even with zero rows", () => {
    const html = renderToStaticMarkup(<TransactionsHub />);
    for (const column of [
      "Amount",
      "Status",
      "Rail/Method",
      "Description",
      "Counterparty",
      "Date",
      "Failure reason",
    ]) {
      expect(html).toContain(column);
    }
  });

  it("empty = the integration ladder (all four contract rungs), each a real link", () => {
    const html = renderToStaticMarkup(<TransactionsHub />);
    for (const [rung, href] of [
      ["Accept via PaySwap Link (no code)", "/app/catalog?new=link"],
      ["Embed a payment component", "/app/checkout"],
      ["Integrate the API", "/app/developers"],
      ["Accept in person (QR)", "/app/checkout"],
    ] as const) {
      expect(html).toContain(rung);
      expect(html).toContain(`href="${href}"`);
    }
    // The primary CTA is test-mode-capable and the teaching line says so.
    expect(html).toContain("Create a payment link");
    expect(html).toContain("test assets never touch real money");
  });
});

describe("customers hub: the honest directory shell", () => {
  it("renders the spec'd columns (component contract 03 §2.1 Customers)", () => {
    const html = renderToStaticMarkup(<CustomersHub />);
    expect(html).toContain('data-testid="customers-hub"');
    for (const column of [
      "Customer",
      "Email/Address",
      "Description",
      "Country",
      "Created",
    ]) {
      expect(html).toContain(column);
    }
  });

  it("empty teaches how guests are auto-created from hosted payments — never a fabricated directory", () => {
    const html = renderToStaticMarkup(<CustomersHub />);
    expect(html).toContain("No customers yet");
    expect(html).toContain("automatically when someone pays");
    expect(html).toContain("auto-created with a derived display name");
    expect(html).toContain("No customer is ever fabricated");
  });
});

describe("catalog hub: Products · Prices · Links · Coupons with honest empties", () => {
  it("renders the four facets with the family description", () => {
    const html = renderToStaticMarkup(<CatalogHub focusLinks={false} />);
    expect(html).toContain('data-testid="catalog-hub"');
    for (const facet of ["Products", "Prices", "Links", "Coupons"]) {
      expect(html).toContain(facet);
    }
    expect(html).toContain("copy, QR and embed");
  });

  it("defaults to the Products facet; ?new=link focuses the Links facet (the Create-menu target)", () => {
    const products = renderToStaticMarkup(<CatalogHub focusLinks={false} />);
    expect(products).toContain("No products yet");
    expect(products).not.toContain("Create a payment link");
    const links = renderToStaticMarkup(<CatalogHub focusLinks />);
    expect(links).toContain("Create a payment link");
    // The links facet's empty points at the real Pay journey while the
    // dedicated builder is unshipped.
    expect(links).toContain('href="/app/payments?start=1"');
  });

  it("every facet empty names its honest state and its fill path — no blanks, no 404s", () => {
    const html = renderToStaticMarkup(<CatalogHub focusLinks={false} />);
    expect(html).toContain("No products yet");
    expect(html).toContain("No prices yet");
    expect(html).toContain("No coupons yet");
    expect(html).toContain("Build a payment link");
  });
});
