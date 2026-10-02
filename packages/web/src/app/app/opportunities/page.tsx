import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CcSectionNotYetAvailable } from "@/components/cc/cc-section-not-yet";

export const metadata: Metadata = {
  title: "Opportunities",
};

export default async function OpportunitiesPage() {
  return (
    <CcSection navItemId="opportunities">
      <CcSectionNotYetAvailable navItemId="opportunities" />
    </CcSection>
  );
}
