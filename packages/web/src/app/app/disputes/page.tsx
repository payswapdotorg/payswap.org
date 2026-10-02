import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CcSectionNotYetAvailable } from "@/components/cc/cc-section-not-yet";

export const metadata: Metadata = {
  title: "Disputes",
};

export default async function DisputesPage() {
  return (
    <CcSection navItemId="disputes">
      <CcSectionNotYetAvailable navItemId="disputes" />
    </CcSection>
  );
}
