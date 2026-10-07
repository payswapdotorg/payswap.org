/**
 * The persistent-row hub surfaces (UX-003, contract 09 §2): the honest
 * shells for Transactions, Customers and Catalog. Each renders the
 * component-contract ListPage anatomy (heading + subtabs + spec'd columns +
 * the collection's EmptyState) with honest empties — populated depth lands
 * with UX-004 and the §20 certification; nothing here fabricates rows.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState, ListPage, Tabs } from "@payswap/design";

/** The integration ladder (contract 09 §2 Transactions-empty), as links. */
const INTEGRATION_LADDER: ReadonlyArray<{
  readonly rung: string;
  readonly href: string;
}> = [
  { rung: "Accept via PaySwap Link (no code)", href: "/app/catalog?new=link" },
  { rung: "Embed a payment component", href: "/app/checkout" },
  { rung: "Integrate the API", href: "/app/developers" },
  { rung: "Accept in person (QR)", href: "/app/checkout" },
];

export function TransactionsHub() {
  return (
    <ListPage
      title="Transactions"
      data-testid="transactions-hub"
      create={
        <Link className="ps-button ps-button--sm ps-button--primary" href="/app/payments?start=1">
          New payment
        </Link>
      }
      subtabs={
        <Tabs
          label="Transaction facets"
          defaultValue="payments"
          items={[
            { id: "payments", label: "Payments", content: null },
            { id: "settlements", label: "Settlements", content: null },
            { id: "top-ups", label: "Top-ups", content: null },
            { id: "all-activity", label: "All activity", content: null },
          ]}
        />
      }
      columns={[
        "Amount",
        "Status",
        "Rail/Method",
        "Description",
        "Counterparty",
        "Date",
        "Failure reason",
      ]}
      rows={[]}
      empty={
        <EmptyState
          title="Start accepting to see transactions"
          description={
            <>
              Every money movement — payments, settlements, top-ups, withdrawals
              — will be listed here with its amount, status and, when something
              fails, a human reason plus a retry. Until then, pick a rung:
              <ul className="cc-ladder">
                {INTEGRATION_LADDER.map((step) => (
                  <li key={step.rung}>
                    <Link href={step.href}>{step.rung}</Link>
                  </li>
                ))}
              </ul>
            </>
          }
          action={
            <Link className="ps-button ps-button--sm ps-button--primary" href="/app/catalog?new=link">
              Create a payment link
            </Link>
          }
          teachingLine="You can walk the whole flow in test mode — test assets never touch real money."
        />
      }
    />
  );
}

export function CustomersHub() {
  return (
    <ListPage
      title="Customers"
      data-testid="customers-hub"
      columns={["Customer", "Email/Address", "Description", "Country", "Created"]}
      rows={[]}
      empty={
        <EmptyState
          title="No customers yet"
          description={
            <>
              Customers appear here automatically when someone pays through
              your hosted payment pages or payment links — guests are
              auto-created with a derived display name, and you can enrich
              their profile afterwards. No customer is ever fabricated.
            </>
          }
          action={
            <Link className="ps-button ps-button--sm ps-button--primary" href="/app/catalog?new=link">
              Create a payment link
            </Link>
          }
          teachingLine="Guests from test-mode payments are marked as test data — they never mix with live customers."
        />
      }
    />
  );
}

/** One honest catalog facet empty (the creation flows land with UX-004 W2). */
function CatalogFacetEmpty({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly action: { readonly label: string; readonly href: string };
}) {
  return (
    <EmptyState
      title={title}
      description={description}
      action={
        <Link className="ps-button ps-button--sm ps-button--primary" href={action.href}>
          {action.label}
        </Link>
      }
      teachingLine="Catalog objects are created through the link builder — the dedicated builder surface lands with the workflows deployment, and nothing is simulated before it ships."
    />
  );
}

export function CatalogHub({
  focusLinks,
}: {
  /** True when arrived via ?new=link (the Create-menu "Payment link" target). */
  readonly focusLinks: boolean;
}) {
  return (
    <section className="cc-stack" aria-labelledby="cc-catalog-heading" data-testid="catalog-hub">
      <div>
        <h1 id="cc-catalog-heading" className="cc-section-heading">
          Catalog
        </h1>
        <p className="cc-section-intro">
          Products, prices, payment links and coupons — one page family. Link
          detail carries share actions (copy, QR, embed), its payment-method
          list and the CTA wording selector (Pay · Request · Donate).
        </p>
      </div>
      <Tabs
        key={focusLinks ? "links" : "products"}
        label="Catalog facets"
        defaultValue={focusLinks ? "links" : "products"}
        items={[
          {
            id: "products",
            label: "Products",
            content: (
              <CatalogFacetEmpty
                title="No products yet"
                description="Products are created as you build payment links — add your first product there, one-off or recurring, with its pricing."
                action={{ label: "Build a payment link", href: "/app/catalog?new=link" }}
              />
            ),
          },
          {
            id: "prices",
            label: "Prices",
            content: (
              <CatalogFacetEmpty
                title="No prices yet"
                description="Prices attach to products (one-off or recurring) and are created with them in the link builder."
                action={{ label: "Build a payment link", href: "/app/catalog?new=link" }}
              />
            ),
          },
          {
            id: "links",
            label: "Links",
            content: (
              <CatalogFacetEmpty
                title={focusLinks ? "Create a payment link" : "No payment links yet"}
                description="The dedicated link builder lands with the workflows deployment — until then, start from the Pay journey; links you create will appear here with copy, QR and embed actions."
                action={{ label: "Start a test payment", href: "/app/payments?start=1" }}
              />
            ),
          },
          {
            id: "coupons",
            label: "Coupons",
            content: (
              <CatalogFacetEmpty
                title="No coupons yet"
                description="Perks and promo codes attach to payment links — create one when you build your first link."
                action={{ label: "Build a payment link", href: "/app/catalog?new=link" }}
              />
            ),
          },
        ]}
      />
    </section>
  );
}
