import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { CcSettingsContent } from "@/components/cc/cc-settings-content";
import { getServerCcState } from "@/lib/cc/server-state";

export const metadata: Metadata = {
  title: "Settings",
};

/**
 * The Settings section (P3-W2-002): session display (sign-in state, expiry),
 * role preference, the honest deployment-scope note, and the route-string
 * links to the auth/connect flows the parallel work stream owns.
 */
export default async function SettingsPage() {
  const state = await getServerCcState();
  return (
    <CcSection navItemId="settings">
      <section aria-labelledby="cc-settings-heading" className="cc-stack">
        <div>
          <h1 id="cc-settings-heading" className="cc-section-heading">
            Settings
          </h1>
          <p className="cc-section-intro">
            Your connections, sessions, authorizations and preferences — every
            value displayed honestly, none simulated.
          </p>
        </div>
        <CcSettingsContent state={state} />
      </section>
    </CcSection>
  );
}
