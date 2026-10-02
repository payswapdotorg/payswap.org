import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CcSectionNotYetAvailable } from "@/components/cc/cc-section-not-yet";

export const metadata: Metadata = {
  title: "Liquidity",
};

export default async function LiquidityPage() {
  return (
    <CcSection navItemId="liquidity">
      <CcSectionNotYetAvailable navItemId="liquidity" />
    </CcSection>
  );
}
