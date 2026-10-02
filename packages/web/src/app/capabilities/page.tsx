import type { Metadata } from "next";
import { CapabilitiesPage } from "@/components/capabilities-page";

export const metadata: Metadata = {
  title: "Capabilities & provider coverage",
  description:
    "PaySwap capabilities and the honest provider/rail coverage picture — verified connections, blocked gates and connectors awaiting credentials, rendered from the recorded probe evidence with dates.",
};

export default function Page() {
  return <CapabilitiesPage />;
}
