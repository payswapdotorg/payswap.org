import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CcSectionNotYetAvailable } from "@/components/cc/cc-section-not-yet";

export const metadata: Metadata = {
  title: "Billing",
};

export default async function BillingPage() {
  return (
    <CcSection navItemId="billing">
      <CcSectionNotYetAvailable navItemId="billing" />
    </CcSection>
  );
}
