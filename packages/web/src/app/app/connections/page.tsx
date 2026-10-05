import type { Metadata } from "next";

import { universalAreaById } from "@payswap/surface";

import { UniversalSection } from "@/components/universal/universal-section";
import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { currentWebSessionContext } from "@/lib/session/server";

export const metadata: Metadata = { title: "Connections" };

/**
 * The Connections area (P4-W4-002 §3.4): the connected-instance model made
 * visible — a provider catalogue capability is NEVER a connection
 * (AGENTS rule 18); execution scopes to the ACTUAL account authorization
 * records the connection plane folded. Empty = the honest catalogue-not-
 * connection distinction, with the real connect flow as the next action.
 */
export default async function ConnectionsPage() {
  return (
    <UniversalSection navItemId="payments">
      <ConnectionsArea />
    </UniversalSection>
  );
}

async function ConnectionsArea() {
  const context = await currentWebSessionContext();
  const plane = getConnectionPlane();
  const records =
    context.configured && context.session.valid
      ? plane.authorityRecordsFor(context.session.view.principalRef)
      : [];
  const area = universalAreaById("connections");
  const active = records.filter((record) => record.state === "ACTIVE");
  return (
    <section aria-labelledby="cc-connections-heading" className="cc-stack">
      <div>
        <h1 id="cc-connections-heading" className="cc-section-heading">
          Connections
        </h1>
        <p className="cc-section-intro">
          {area.purpose} A catalogue listing is never a connection — only an
          authorized account activation is.
        </p>
      </div>
      {records.length === 0 ? (
        <div className="ps-empty" role="status" data-area="connections">
          <p className="ps-empty__reason">{area.emptyState.reason}</p>
          <a className="ps-empty__action" href={area.emptyState.nextAction.value}>
            Connect a provider
          </a>
        </div>
      ) : (
        <ul className="cc-connections-list">
          {records.map((record) => (
            <li
              key={record.instanceId}
              className="cc-connection-row"
              data-state={record.state}
            >
              <span className="cc-connection-row__provider">{record.providerId}</span>
              <span className="ps-badge" data-tone={record.state === "ACTIVE" ? "test" : "neutral"}>
                {record.state}
              </span>
              <span className="cc-connection-row__connected-at">
                connected {record.connectedAt}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="cc-connections-note">
        {active.length} active connection{active.length === 1 ? "" : "s"} — provider
        catalogue capabilities are browsable under Capabilities; nothing here
        implies a connection until an authority record exists.
      </p>
    </section>
  );
}
