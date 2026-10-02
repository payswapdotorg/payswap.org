import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CcSectionNotYetAvailable } from "@/components/cc/cc-section-not-yet";

export const metadata: Metadata = {
  title: "Credit",
};

export default async function CreditPage() {
  return (
    <CcSection navItemId="credit">
      <CcSectionNotYetAvailable navItemId="credit" />
    </CcSection>
  );
}
