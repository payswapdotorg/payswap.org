import type { Metadata } from "next";
import { SecurityPage } from "@/components/security-page";

export const metadata: Metadata = {
  title: "Security & non-custody",
  description:
    "PaySwap never holds your funds or your provider credentials. Connections are user-authorized browser sessions, balances are external observations, and every financial action carries authorization and evidence lineage.",
};

export default function Page() {
  return <SecurityPage />;
}
