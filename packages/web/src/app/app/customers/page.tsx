import type { Metadata } from "next";

import { ShellSection } from "@/components/shell/shell-section";
import { CustomersHub } from "@/components/shell/hub-blocks";

export const metadata: Metadata = {
  title: "Customers",
};

/**
 * The Customers hub (UX-003, contract 09 §2 Customers): the directory's
 * honest shell — spec'd columns (Customer · Email/Address · Description ·
 * Country · Created) and the honest empty that teaches how guests are
 * auto-created from hosted payments. Populated depth lands with later
 * waves; no customer is ever fabricated.
 */
export default async function CustomersPage() {
  return (
    <ShellSection
      route="/app/customers"
      title="Customers"
      intro="Your customer directory — guests are auto-created from hosted payments with derived display names."
    >
      <CustomersHub />
    </ShellSection>
  );
}
