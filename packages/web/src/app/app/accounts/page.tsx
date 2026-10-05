import type { Metadata } from "next";

import { universalAreaById } from "@payswap/surface";

import { UniversalSection } from "@/components/universal/universal-section";
import { ModeIndicator } from "@/components/universal/mode-indicator";
import { getConnectionPlane } from "@/app/(auth)/_server/connection-plane";
import { currentWebSessionContext } from "@/lib/session/server";

export const metadata: Metadata = { title: "Accounts" };

/**
 * The Accounts area (P4-W4-002 §3.2): balances and positions across
 * providers — every number an OBSERVATION of an external provider
 * (AGENTS rule 21: external provider balances are never PaySwap custody
 * or customer balances). With no provider balance observations recorded
 * by the connection plane, the area renders its designed honest empty
 * state — never an invented balance.
 */
export default async function AccountsPage() {
  return (
    <UniversalSection navItemId="payments">
      <AccountsArea />
    </UniversalSection>
  );
}

async function AccountsArea() {
  const context = await currentWebSessionContext();
  const connectedInstances =
    context.configured && context.session.valid
      ? getConnectionPlane().connectedInstancesFor(context.session.view.principalRef)
      : [];
  const area = universalAreaById("accounts");
  return (
    <section aria-labelledby="cc-accounts-heading" className="cc-stack">
      <div>
        <h1 id="cc-accounts-heading" className="cc-section-heading">
          Accounts
        </h1>
        <p className="cc-section-intro">{area.purpose}</p>
      </div>
      <ModeIndicator testOrLive="TEST" onchain={false} testnet={false} />
      {connectedInstances.length === 0 ? (
        <div className="ps-empty" role="status" data-area="accounts">
          <p className="ps-empty__reason">{area.emptyState.reason}</p>
          <a className="ps-empty__action" href={area.emptyState.nextAction.value}>
            Go to Connections
          </a>
        </div>
      ) : (
        <ul className="cc-accounts-list">
          {connectedInstances.map((instance) => (
            <li key={instance.instanceId} className="cc-account-row">
              <span className="cc-account-row__provider">{instance.providerId}</span>
              <span className="cc-account-row__id">{instance.instanceId}</span>
              <span className="cc-account-row__note">
                Connected instance — balance observations appear here as the
                provider records them (observations, never custody).
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
