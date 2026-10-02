import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CcSectionNotYetAvailable } from "@/components/cc/cc-section-not-yet";

export const metadata: Metadata = {
  title: "Programs",
};

export default async function ProgramsPage() {
  return (
    <CcSection navItemId="programs">
      <CcSectionNotYetAvailable navItemId="programs" />
    </CcSection>
  );
}
