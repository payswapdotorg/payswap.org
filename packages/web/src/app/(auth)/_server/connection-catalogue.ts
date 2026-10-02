/**
 * The provider connection catalogue (P3-W1-002) — REAL options derived from
 * the recorded probe/coverage evidence (src/lib/coverage.ts), never
 * invented.
 *
 * Laws honored:
 * - every provider's status is the HONEST status from the evidence:
 *   platform-verified (probe + certification), BLOCKED (MTN MoMo's
 *   rejected subscription key — with dates), not-connected (connectors
 *   merged but no credential held), or the providerless local rail;
 * - catalogue availability is NEVER connected capability: `connectable`
 *   mirrors availability only (the W3-001 contract's own note), and the
 *   UI repeats the distinction on every option;
 * - the entries feed the REAL W3-001 ConnectProviderJourney via
 *   `beginConnectProvider({ catalogue })` — this module never authorizes
 *   anything.
 */

import type { ProviderCatalogueEntry } from "@payswap/ux";

import {
  BLOCKED_STATUS,
  NO_CREDENTIAL_STATUS,
  NOT_ACTIVATED_STATUS,
  coverage,
  formatUtcTimestamp,
  providerLabel,
} from "@/lib/coverage";

/** The honest status kind of a catalogue provider (from the evidence). */
export type CatalogueStatusKind =
  | "PLATFORM_VERIFIED"
  | "BLOCKED"
  | "NOT_CONNECTED_NO_CREDENTIAL"
  | "LOCAL_RAIL";

/** The user-connection authorization mode the provider's flow would use. */
export type UserConnectionMode =
  | "DELEGATED_OAUTH"
  | "CONNECTED_ACCOUNT"
  | "SCOPED_CREDENTIAL"
  | "BROWSER_SESSION";

/** Honest display metadata for one catalogue provider. */
export interface CatalogueProviderStatus {
  readonly providerId: string;
  readonly displayName: string;
  readonly statusKind: CatalogueStatusKind;
  /** Short honest status line (never upgrades, never hides). */
  readonly statusLine: string;
  /** Evidence-backed detail (dates, certification, verbatim reasons). */
  readonly evidenceLines: readonly string[];
  /** The user-connection authorization mode for this provider's flow. */
  readonly userConnectionMode: UserConnectionMode;
  /** Platform-level authorization mode from the release record (or null). */
  readonly platformAuthorizationMode: string | null;
  /** True when the provider is the providerless local rail. */
  readonly isLocalRail: boolean;
}

const NOT_CONNECTED_MODELS: Readonly<Record<string, UserConnectionMode>> = {
  "paypal-direct": "CONNECTED_ACCOUNT",
  rapyd: "DELEGATED_OAUTH",
  dlocal: "DELEGATED_OAUTH",
  thunes: "SCOPED_CREDENTIAL",
  adyen: "DELEGATED_OAUTH",
  airwallex: "DELEGATED_OAUTH",
  ebanx: "DELEGATED_OAUTH",
};

function railsForStatus(kind: CatalogueStatusKind, providerId: string): readonly string[] {
  switch (providerId) {
    case "stripe":
      return ["Card payments", "Transfers"];
    case "paystack":
      return ["GhIPSS bank rails (GHS)", "NGN / KES / ZAR local collection"];
    case "flutterwave":
      return ["Fiat wallet collection", "Mobile money"];
    case "mtn_momo":
      return ["Mobile money (collection, disbursement, remittance)"];
    case "stellar":
      return ["Local rail (providerless)", "Stablecoin path (testnet proof on record)"];
    default:
      return kind === "NOT_CONNECTED_NO_CREDENTIAL"
        ? ["Connector merged and certified fail-closed — rails documented, unverified without credentials"]
        : [];
  }
}

function statusFor(
  kind: CatalogueStatusKind,
  providerId: string,
  displayName: string,
): CatalogueProviderStatus {
  switch (kind) {
    case "PLATFORM_VERIFIED": {
      const record = coverage.connected.find(
        (candidate) => candidate.providerName === providerId,
      );
      const evidence: string[] = [];
      if (record !== undefined) {
        evidence.push(
          `Platform probe: ${record.probeEvidence.verdict} — ${formatUtcTimestamp(record.probeEvidence.probedAt)}.`,
          `Cross-provider conformance: ${record.certification.passed}/${record.certification.executed} scenarios passed (${record.certification.certificationId ?? "certification on record"}).`,
          `Platform authorization mode: ${record.authorizationMode} (operator-held, vault-referenced — this is the PLATFORM's connection, not yours).`,
          ...record.limitations.map((limitation) => `Honest limitation: ${limitation}`),
        );
      }
      return {
        providerId,
        displayName,
        statusKind: kind,
        statusLine:
          "Verified at the platform level (probe + certification) — you are NOT connected to it.",
        evidenceLines: evidence,
        userConnectionMode: "DELEGATED_OAUTH",
        platformAuthorizationMode: record?.authorizationMode ?? null,
        isLocalRail: false,
      };
    }
    case "BLOCKED": {
      const record = coverage.blocked.find(
        (candidate) => candidate.providerName === providerId,
      );
      return {
        providerId,
        displayName,
        statusKind: kind,
        statusLine: "BLOCKED by the provider's credential gate — not connectable.",
        evidenceLines:
          record === undefined
            ? []
            : [
                `Blocked since the ${formatUtcTimestamp(coverage.probedAt)} probe: ${record.reason}`,
              ],
        userConnectionMode: "SCOPED_CREDENTIAL",
        platformAuthorizationMode: null,
        isLocalRail: false,
      };
    }
    case "NOT_CONNECTED_NO_CREDENTIAL": {
      const record = coverage.awaitingCredentials.find(
        (candidate) => candidate.providerName === providerId,
      );
      return {
        providerId,
        displayName,
        statusKind: kind,
        statusLine:
          "Not connected — the connector is merged and certified fail-closed, but no credential is held.",
        evidenceLines:
          record === undefined
            ? []
            : [`Honest datum: ${record.reason}`],
        userConnectionMode: NOT_CONNECTED_MODELS[providerId] ?? "DELEGATED_OAUTH",
        platformAuthorizationMode: null,
        isLocalRail: false,
      };
    }
    case "LOCAL_RAIL": {
      const record = coverage.localRail.find(
        (candidate) => candidate.providerName === providerId,
      );
      return {
        providerId,
        displayName,
        statusKind: kind,
        statusLine:
          "The providerless LOCAL rail — no provider API-credential model; connections run through the user-authorized browser-session path.",
        evidenceLines:
          record === undefined
            ? []
            : [
                `Record: ${record.reason}`,
                `Testnet probe ${formatUtcTimestamp(coverage.probedAt)}: ${coverage.stellarTestnet?.verdict ?? "on record"} (account-scoped keypair custody, no provider gate).`,
              ],
        userConnectionMode: "BROWSER_SESSION",
        platformAuthorizationMode: null,
        isLocalRail: true,
      };
    }
  }
}

interface CatalogueSourceRow {
  readonly providerId: string;
  readonly kind: CatalogueStatusKind;
  /** Catalogue availability — mirrors the evidence, never upgrades. */
  readonly availability: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
}

const CATALOGUE_ROWS: readonly CatalogueSourceRow[] = [
  ...coverage.connected.map((record) => ({
    providerId: record.providerName,
    kind: "PLATFORM_VERIFIED" as const,
    availability: "AVAILABLE" as const,
  })),
  ...coverage.blocked.map((record) => ({
    providerId: record.providerName,
    kind: "BLOCKED" as const,
    availability: "UNAVAILABLE" as const,
  })),
  ...coverage.awaitingCredentials.map((record) => ({
    providerId: record.providerName,
    kind: "NOT_CONNECTED_NO_CREDENTIAL" as const,
    availability: "AVAILABLE" as const,
  })),
  ...coverage.localRail.map((record) => ({
    providerId: record.providerName,
    kind: "LOCAL_RAIL" as const,
    availability: "AVAILABLE" as const,
  })),
];

/** The honest statuses of every catalogue provider (display metadata). */
export const CATALOGUE_STATUSES: readonly CatalogueProviderStatus[] =
  CATALOGUE_ROWS.map((row) =>
    statusFor(row.kind, row.providerId, providerLabel(row.providerId)),
  );

export function catalogueStatusById(
  providerId: string,
): CatalogueProviderStatus | undefined {
  return CATALOGUE_STATUSES.find((candidate) => candidate.providerId === providerId);
}

/**
 * The catalogue entries for the REAL W3-001 journey contract
 * (`beginConnectProvider`). Availability mirrors the evidence exactly; the
 * journey's own `deriveCatalogueOptions` turns availability into
 * connectability with the honest note attached.
 */
export function providerCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return CATALOGUE_ROWS.map((row) => ({
    providerId: row.providerId,
    displayName: providerLabel(row.providerId),
    rails: railsForStatus(row.kind, row.providerId),
    catalogueAvailability: row.availability,
  }));
}

/** Tone mapping for the design StatusPill (never a failure for unknowns). */
export function statusPillTone(
  kind: CatalogueStatusKind,
): "ok" | "blocked" | "attention" | "unknown" {
  switch (kind) {
    case "PLATFORM_VERIFIED":
      return "ok";
    case "BLOCKED":
      return "blocked";
    case "NOT_CONNECTED_NO_CREDENTIAL":
      return "attention";
    case "LOCAL_RAIL":
      return "ok";
  }
}
