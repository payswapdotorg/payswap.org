/**
 * The Command Center connection summary (P3-W2-002).
 *
 * TRUTHFUL FRAMING (law 3): this panel renders the RECORDED network
 * evidence — which providers the PaySwap network has VERIFIED connections
 * to, which are BLOCKED, and which await credentials, with the probe dates
 * from the release record. These are NOT the viewer's connected capability
 * instances: the viewer's connected instances appear here when the
 * connection plane (the parallel work stream) ships, derived from authority
 * records — never from the provider catalogue.
 */

import { Badge, Card, CardMeta, CardSubtitle, CardTitle, KeyValue, Panel, StatusPill } from "@payswap/design";

import { coverage, formatUtcTimestamp, providerLabel } from "@/lib/coverage";
import type { ConnectedProviderRecord, NonConnectionRecord } from "@/lib/coverage";

function ConnectionCard({ record }: { readonly record: ConnectedProviderRecord }) {
  return (
    <Card raised>
      <CardTitle>{providerLabel(record.providerName)}</CardTitle>
      <CardSubtitle>{record.probeEvidence.summary}</CardSubtitle>
      <KeyValue
        dense
        entries={[
          { key: "Probe verdict", value: record.probeEvidence.verdict },
          { key: "Probed at", value: formatUtcTimestamp(record.probeEvidence.probedAt) },
          { key: "Authorization", value: record.authorizationMode },
          {
            key: "Certification",
            value: `${record.certification.passed}/${record.certification.executed} passed${
              record.certification.notApplicable > 0
                ? `, ${record.certification.notApplicable} honest N/A`
                : ""
            }`,
          },
        ]}
      />
      {record.limitations.length > 0 ? (
        <CardMeta>
          <span>Limitations: {record.limitations.join("; ")}</span>
        </CardMeta>
      ) : null}
    </Card>
  );
}

function NonConnectionRow({
  record,
  tone,
}: {
  readonly record: NonConnectionRecord;
  readonly tone: "blocked" | "disabled";
}) {
  return (
    <li className="cc-actions__item">
      <StatusPill tone={tone}>{record.status}</StatusPill>
      <span>
        <strong>{providerLabel(record.providerName)}</strong> — {record.reason}
      </span>
    </li>
  );
}

export function CcConnectionSummary() {
  return (
    <Panel
      title="Provider coverage — recorded evidence"
      description={
        <>
          The network&apos;s provider-connection truth from the release record{" "}
          <span className="ps-mono">{coverage.releaseId}</span>, live-probed{" "}
          {formatUtcTimestamp(coverage.probedAt)}. Verdicts and dates are the
          recorded evidence — never upgraded, never invented. Your connected
          capability instances render here once the connection plane ships.
        </>
      }
    >
      <div className="cc-grid">
        {coverage.connected.map((record: ConnectedProviderRecord) => (
          <ConnectionCard key={record.providerName} record={record} />
        ))}
      </div>
      {coverage.blocked.length > 0 || coverage.awaitingCredentials.length > 0 || coverage.localRail.length > 0 ? (
        <div className="cc-stack">
          <h3 className="ps-label">Not connected — honest reasons</h3>
          <ul className="cc-actions">
            {coverage.blocked.map((record: NonConnectionRecord) => (
              <NonConnectionRow key={record.providerName} record={record} tone="blocked" />
            ))}
            {coverage.awaitingCredentials.map((record: NonConnectionRecord) => (
              <NonConnectionRow key={record.providerName} record={record} tone="disabled" />
            ))}
            {coverage.localRail.map((record: NonConnectionRecord) => (
              <NonConnectionRow key={record.providerName} record={record} tone="disabled" />
            ))}
          </ul>
          <p>
            <Badge>{coverage.connected.length} connected</Badge>{" "}
            <Badge>{coverage.blocked.length} blocked</Badge>{" "}
            <Badge>
              {coverage.awaitingCredentials.length + coverage.localRail.length} not activated
            </Badge>
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
