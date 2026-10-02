import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CcSectionNotYetAvailable } from "@/components/cc/cc-section-not-yet";

export const metadata: Metadata = {
  title: "Developers",
};

export default async function DevelopersPage() {
  return (
    <CcSection navItemId="developers">
      <CcSectionNotYetAvailable navItemId="developers" />
    </CcSection>
  );
}
