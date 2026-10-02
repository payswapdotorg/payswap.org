import type { Metadata } from "next";

import { CcSection } from "@/components/cc/cc-section";
import { getServerCcState } from "@/lib/cc/server-state";

export const metadata: Metadata = {
  title: "Overview",
};

export default async function OverviewPage() {
  const state = await getServerCcState();
  return (
    <CcSection navItemId="overview">
      <section aria-labelledby="cc-overview-heading">
        <h1 id="cc-overview-heading" className="cc-section-heading">
          Overview
        </h1>
        <p className="cc-section-intro">
          The Command Center home — derived inbox, approvals, executions and
          the provider plane at a glance. (Section content lands with the
          next commit; the shell, navigation and honest gate are live.)
        </p>
        <p className="ps-mono">{state.session.status}</p>
      </section>
    </CcSection>
  );
}
