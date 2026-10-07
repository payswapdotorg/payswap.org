import type { Metadata } from "next";

import { ShellSection } from "@/components/shell/shell-section";
import { CatalogHub } from "@/components/shell/hub-blocks";

export const metadata: Metadata = {
  title: "Catalog",
};

/**
 * The Catalog hub (UX-003, contract 09 §2 Catalog): Products · Prices ·
 * Links · Coupons — one page family with honest empties. `?new=link` (the
 * Create-menu "Payment link" target) focuses the Links facet; the
 * dedicated builder surface lands with the workflows deployment (UX-004
 * W2), and nothing is simulated before it ships.
 */
export default async function CatalogPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const focusLinks = params.new === "link";
  return (
    <ShellSection
      route="/app/catalog"
      title="Catalog"
      intro="Products, prices, payment links and coupons — one page family."
    >
      <CatalogHub focusLinks={focusLinks} />
    </ShellSection>
  );
}
