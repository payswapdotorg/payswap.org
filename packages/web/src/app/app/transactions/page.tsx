import type { Metadata } from "next";

import { ShellSection } from "@/components/shell/shell-section";
import { TransactionsHub } from "@/components/shell/hub-blocks";

export const metadata: Metadata = {
  title: "Transactions",
};

/**
 * The Transactions hub (UX-003, contract 09 §2 Transactions): the honest
 * ListPage shell — heading, sub-tabs (Payments · Settlements · Top-ups ·
 * All activity), the spec'd columns (Amount · Status · Rail/Method ·
 * Description · Counterparty · Date · Failure reason) and the
 * integration-ladder empty state. Populated depth lands with UX-004 and
 * the §20 certification; nothing is simulated before it does.
 */
export default async function TransactionsPage() {
  return (
    <ShellSection
      route="/app/transactions"
      title="Transactions"
      intro="Every money movement — payments, settlements, top-ups, withdrawals — with its status and, when something fails, a human reason plus a retry."
    >
      <TransactionsHub />
    </ShellSection>
  );
}
