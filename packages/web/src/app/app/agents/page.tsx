import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CcSectionNotYetAvailable } from "@/components/cc/cc-section-not-yet";

export const metadata: Metadata = {
  title: "Agents",
};

export default async function AgentsPage() {
  return (
    <CcSection navItemId="agents">
      <CcSectionNotYetAvailable navItemId="agents" />
    </CcSection>
  );
}
