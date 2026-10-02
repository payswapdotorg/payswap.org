/**
 * Honest provider-coverage view over the repository's recorded evidence.
 *
 * Law (P3-W1-001 + repo invariants): the probe/rollout JSONs under
 * spec/development-state/ are the ONLY provider-coverage truth. This module
 * imports them at BUILD time and projects them into a typed view. It never
 * invents a provider, never upgrades a status, and never renders a provider
 * as connected when the record says otherwise. MTN MoMo stays BLOCKED until
 * a fresh probe record says otherwise.
 *
 * If the evidence files drift out of the expected shape, the assertions
 * below fail the build loudly instead of silently rendering wrong truth.
 */

import probesJson from "../../../../spec/development-state/provider-probes-20261002.json";
import rolloutJson from "../../../../spec/development-state/provider-rollout-20261002.json";

// ---------------------------------------------------------------------------
// Evidence record types (the shapes this surface actually consumes)
// ---------------------------------------------------------------------------

export interface ProbeEvidence {
  readonly probedAt: string;
  readonly verdict: string;
  readonly summary: string;
}

export interface CertificationSummary {
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly notApplicable: number;
}

export interface ConnectedProviderRecord {
  readonly providerName: string;
  readonly authorizationMode: string;
  readonly configKey: string;
  readonly probeEvidence: ProbeEvidence;
  readonly certification: CertificationSummary;
  readonly limitations: readonly string[];
}

export interface NonConnectionRecord {
  readonly providerName: string;
  readonly status: string;
  readonly reason: string;
}

interface ProviderRolloutRecord {
  readonly record_type: string;
  readonly schema_version: string;
  readonly releaseId: string;
  readonly connectedProviders: readonly ConnectedProviderRecord[];
  readonly nonConnections: readonly NonConnectionRecord[];
}

interface ProviderProbesRecord {
  readonly record_type: string;
  readonly schema_version: string;
  readonly probedAt: string;
  readonly probes: {
    readonly stripe?: {
      readonly mode?: string;
      readonly authentication?: string;
      readonly capabilities_active?: readonly string[];
      readonly ghs_eligibility?: { readonly verdict?: string };
      readonly paypal_on_stripe_eligibility?: { readonly verdict?: string };
    };
    readonly paystack?: {
      readonly mode?: string;
      readonly authentication?: string;
      readonly bank_rails?: Record<string, unknown>;
      readonly verdict?: string;
    };
    readonly flutterwave?: {
      readonly mode?: string;
      readonly authentication?: string;
      readonly wallet_currencies?: number;
      readonly fiat_wallets?: readonly string[];
      readonly verdict?: string;
    };
    readonly mtn_momo?: {
      readonly mode?: string;
      readonly authentication?: string;
      readonly detail?: string;
      readonly verdict?: string;
    };
    readonly stellar_testnet?: {
      readonly mode?: string;
      readonly authentication?: string;
      readonly verdict?: string;
    };
    readonly whatsapp?: {
      readonly mode?: string;
      readonly authentication?: string;
      readonly verdict?: string;
    };
    readonly resend?: {
      readonly mode?: string;
      readonly authentication?: string;
      readonly verdict?: string;
    };
    readonly opensanctions?: {
      readonly mode?: string;
      readonly authentication?: string;
      readonly verdict?: string;
    };
  };
}

const probes = probesJson as unknown as ProviderProbesRecord;
const rollout = rolloutJson as unknown as ProviderRolloutRecord;

// Fail loudly if the evidence files are not what this surface expects.
if (probes.record_type !== "provider-probe-evidence") {
  throw new Error(
    "coverage: provider-probes-20261002.json has an unexpected record_type — refusing to render coverage",
  );
}
if (rollout.record_type !== "provider-rollout-release") {
  throw new Error(
    "coverage: provider-rollout-20261002.json has an unexpected record_type — refusing to render coverage",
  );
}
if (!Array.isArray(rollout.connectedProviders) || !Array.isArray(rollout.nonConnections)) {
  throw new Error(
    "coverage: provider-rollout-20261002.json is missing connectedProviders/nonConnections — refusing to render coverage",
  );
}

// ---------------------------------------------------------------------------
// Derived view
// ---------------------------------------------------------------------------

/** Human display labels for provider identifiers used by the records. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  stripe: "Stripe",
  paystack: "Paystack",
  flutterwave: "Flutterwave",
  mtn_momo: "MTN MoMo",
  "paypal-direct": "PayPal Direct",
  rapyd: "Rapyd",
  dlocal: "dLocal",
  thunes: "Thunes",
  adyen: "Adyen",
  airwallex: "Airwallex",
  ebanx: "EBANX",
  stellar: "Stellar (local rail)",
  stellar_testnet: "Stellar testnet (local rail)",
  whatsapp: "WhatsApp Cloud API",
  resend: "Resend",
  opensanctions: "OpenSanctions",
};

export function providerLabel(providerName: string): string {
  return PROVIDER_LABELS[providerName] ?? providerName;
}

/** "2026-10-02T06:37:38Z" -> "2026-10-02 06:37 UTC" (deterministic, no locale). */
export function formatUtcTimestamp(iso: string): string {
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return time.length === 5 ? `${date} ${time} UTC` : date;
}

export const BLOCKED_STATUS = "BLOCKED" as const;
export const NO_CREDENTIAL_STATUS = "NO_CREDENTIAL_HELD" as const;
export const NOT_ACTIVATED_STATUS = "NOT_ACTIVATED" as const;

export interface SupportingServiceRecord {
  readonly id: string;
  readonly mode: string;
  readonly authentication: string;
  readonly verdict: string;
  readonly note: string;
}

export const coverage = {
  /** When the live provider probes were executed (the evidence date). */
  probedAt: probes.probedAt,
  /** The release record the connected/non-connected split comes from. */
  releaseId: rollout.releaseId,

  connected: rollout.connectedProviders,
  blocked: rollout.nonConnections.filter(
    (entry) => entry.status === BLOCKED_STATUS,
  ),
  awaitingCredentials: rollout.nonConnections.filter(
    (entry) => entry.status === NO_CREDENTIAL_STATUS,
  ),
  localRail: rollout.nonConnections.filter(
    (entry) => entry.status === NOT_ACTIVATED_STATUS,
  ),

  stripe: probes.probes.stripe,
  paystack: probes.probes.paystack,
  flutterwave: probes.probes.flutterwave,
  mtnMomo: probes.probes.mtn_momo,
  stellarTestnet: probes.probes.stellar_testnet,

  /** Platform services probed for operational use — none is a payment rail. */
  supportingServices: [
    {
      id: "whatsapp",
      mode: probes.probes.whatsapp?.mode ?? "platform service",
      authentication: probes.probes.whatsapp?.authentication ?? "UNKNOWN",
      verdict: probes.probes.whatsapp?.verdict ?? "UNKNOWN",
      note: "Notification surface (sandbox-grade). Not a payment rail.",
    },
    {
      id: "resend",
      mode: probes.probes.resend?.mode ?? "platform service",
      authentication: probes.probes.resend?.authentication ?? "UNKNOWN",
      verdict: probes.probes.resend?.verdict ?? "UNKNOWN",
      note: "Email surface — fail-closed until the operator's verified sender domain is supplied. Not a payment rail.",
    },
    {
      id: "opensanctions",
      mode: probes.probes.opensanctions?.mode ?? "screening service",
      authentication: probes.probes.opensanctions?.authentication ?? "UNKNOWN",
      verdict: probes.probes.opensanctions?.verdict ?? "UNKNOWN",
      note: "AML/sanctions screening. Not a payment rail.",
    },
  ] as readonly SupportingServiceRecord[],
} as const;

export type Coverage = typeof coverage;
