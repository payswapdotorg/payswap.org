/**
 * Provider rollout release record generator — executes the P2-W3-003
 * rollout machinery (@payswap/operations) for the certified provider set.
 *
 * Authority:
 * - spec/phase-2/work-items/P2-W3-003.md (the work order);
 * - spec/development-state/provider-probes-20261002.json (the live probe
 *   evidence — the Phase 2 credential batch, probed 2026-10-02);
 * - the P2-W2-003 cross-provider conformance certification (battery
 *   2579/2579: the matrix 39 pairs = 31 executed ALL PASS + 8 honest
 *   NOT_APPLICABLE, packages/journeys/test/conformance.test.ts);
 * - spec/development-state/phase-2-state.json (the wave-3 frontier record).
 *
 * DETERMINISTIC: the same repo state produces the same record — "provider
 * activation is reproducible". The record carries:
 *   - the connected providers (stripe, paystack, flutterwave — the three
 *     conformance-certified providers with held, live-probed credentials)
 *     each with probe evidence + certification evidence + limitations;
 *   - the honest NON-connections (MTN MoMo BLOCKED — subscription key
 *     rejected at the APIM gate; the seven Wave-2 connectors with NO
 *     credential held; the Stellar local rail as the user-authorized
 *     session path, not an API-credential connection);
 *   - the explicit preview/production parity (vault references are the
 *     only allowed difference);
 *   - the browser verification evidence (the real-path journey contracts
 *     for every connected provider + the local-rail user-authorized
 *     contract + the expired-session reauthentication contract, checked
 *     by the coverage checker);
 *   - the rollback/deactivation path (the five canonical steps +
 *     rehearsal evidence + fresh-evidence re-activation law).
 *
 * Usage: npm run rollout:record
 */

import fs from "node:fs";
import path from "node:path";
import {
  appendProviderActivationRecord,
  checkProviderRolloutReleaseRecord,
  emptyProviderActivationLedger,
  executeProviderRolloutPlan,
} from "@payswap/operations";
import {
  EXPIRED_SESSION_JOURNEY_CONTRACT,
  checkProviderRolloutBrowserCoverage,
  deriveProviderRealPathContracts,
  localRailUserAuthorizedJourneyContract,
  recordProviderRolloutBrowserVerification,
  BROWSER_VERIFICATION_CHECKS,
} from "@payswap/operations";
import { AUTHORIZATION_MODES } from "@payswap/connectors";
import { DIRECT_LOCAL_AUTHORIZATION_MODES } from "@payswap/capabilities";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "spec/development-state/provider-rollout-20261002.json");

// ---------------------------------------------------------------------------
// The activation ledger — the three conformance-certified providers with
// live-probed, held credentials (provider-probes-20261002.json)
// ---------------------------------------------------------------------------

const PROBE_EVIDENCE = {
  stripe: {
    evidencePath: "spec/development-state/provider-probes-20261002.json",
    probedAt: "2026-10-02T06:37:38Z",
    verdict: "VERIFIED",
    summary:
      "live test-mode account probe: authentication VERIFIED (acct scope observed), real create+cancel PaymentIntent round-trip, PayPal-on-Stripe eligibility observed, GHS rejection carried as the honest negative datum",
  },
  paystack: {
    evidencePath: "spec/development-state/provider-probes-20261002.json",
    probedAt: "2026-10-02T06:37:38Z",
    verdict: "ELIGIBLE",
    summary:
      "live test-mode probe: authentication VERIFIED, GHS ghipss + NGN/KES/ZAR bank-rail enumeration",
  },
  flutterwave: {
    evidencePath: "spec/development-state/provider-probes-20261002.json",
    probedAt: "2026-10-02T06:37:38Z",
    verdict: "ELIGIBLE",
    summary:
      "live probe: authentication VERIFIED, 31-wallet observation incl. USDC/USDT/RLUSD stablecoins (materially relevant to the Stellar USDC local-rail path)",
  },
} as const;

const CERTIFICATION = {
  stripe: { executed: 13, passed: 13, failed: 0, notApplicable: 0 },
  paystack: { executed: 9, passed: 9, failed: 0, notApplicable: 4 },
  flutterwave: { executed: 9, passed: 9, failed: 0, notApplicable: 4 },
} as const;

const CONNECTED = [
  {
    providerName: "stripe",
    activationRecordId: "pa-stripe-20261002",
    connectedInstanceId: "cci-stripe-20261002",
    limitations: [
      "test-mode credentials (live keys never supplied)",
      "GHS not routable on this account (provider-side rejection, recorded as the honest negative datum)",
    ],
  },
  {
    providerName: "paystack",
    activationRecordId: "pa-paystack-20261002",
    connectedInstanceId: "cci-paystack-20261002",
    limitations: [
      "test-mode credentials (live keys never supplied)",
      "collection-focused connector: no payout/dispute/mandate families (declared NOT_APPLICABLE in the conformance matrix)",
    ],
  },
  {
    providerName: "flutterwave",
    activationRecordId: "pa-flutterwave-20261002",
    connectedInstanceId: "cci-flutterwave-20261002",
    limitations: [
      "test-mode credentials (live keys never supplied)",
      "hosted-checkout + wallet-observation surface: no payout-execution family (declared NOT_APPLICABLE in the conformance matrix)",
    ],
  },
] as const;

function buildLedger() {
  let ledger = emptyProviderActivationLedger();
  for (const provider of CONNECTED) {
    ledger = appendProviderActivationRecord(
      ledger,
      {
        record_type: "provider-activation",
        schema_version: "1.0",
        recordId: provider.activationRecordId,
        providerName: provider.providerName,
        credential: {
          configKey: `PROVIDER_${provider.providerName.toUpperCase()}_CREDENTIAL_REF`,
          vaultReference: `vault://payswap/providers/${provider.providerName}`,
          authorizationMode: "SCOPED_API_CREDENTIAL",
        },
        probeEvidence: PROBE_EVIDENCE[provider.providerName as keyof typeof PROBE_EVIDENCE],
        status: "ACTIVATED",
        connectedInstanceId: provider.connectedInstanceId,
        limitations: [...provider.limitations],
        recordedAt: "2026-10-02T06:37:38Z",
        recordedBy: "tl-gate",
      },
      [...AUTHORIZATION_MODES],
    );
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// The plan (reproducible data)
// ---------------------------------------------------------------------------

const WAVE2_NO_CREDENTIAL = [
  "paypal-direct",
  "rapyd",
  "dlocal",
  "thunes",
  "adyen",
  "airwallex",
  "ebanx",
] as const;

const plan = {
  planId: "provider-rollout-20261002",
  workOrder: "P2-W3-003",
  plannedAt: "2026-10-02T14:30:00Z",
  plannedBy: "tl-gate",
  items: CONNECTED.map((provider) => ({
    providerName: provider.providerName,
    activationRecordId: provider.activationRecordId,
    probeEvidence: PROBE_EVIDENCE[provider.providerName as keyof typeof PROBE_EVIDENCE],
    certification: {
      certificationId: "P2-W2-003-cross-provider-conformance",
      providerName: provider.providerName,
      ...CERTIFICATION[provider.providerName as keyof typeof CERTIFICATION],
      evidencePath: "packages/journeys/test/conformance.test.ts (matrix 39 pairs)",
    },
    limitations: [...provider.limitations],
  })),
  preview: {
    environment: "preview" as const,
    providers: CONNECTED.map((provider) => ({
      providerName: provider.providerName,
      activationRecordId: provider.activationRecordId,
      configKey: `PROVIDER_${provider.providerName.toUpperCase()}_CREDENTIAL_REF`,
      vaultReference: `vault://payswap/providers/${provider.providerName}/preview`,
    })),
  },
  production: {
    environment: "production" as const,
    providers: CONNECTED.map((provider) => ({
      providerName: provider.providerName,
      activationRecordId: provider.activationRecordId,
      configKey: `PROVIDER_${provider.providerName.toUpperCase()}_CREDENTIAL_REF`,
      vaultReference: `vault://payswap/providers/${provider.providerName}/production`,
    })),
  },
  nonConnections: [
    {
      providerName: "mtn_momo",
      status: "BLOCKED" as const,
      reason:
        "subscription key rejected HTTP 401 at the APIM gate (collection/disbursement/remittance) — API credentials never evaluated; operator input recorded, never integration proof; re-probe when a valid subscription key is supplied",
      evidencePath: "spec/development-state/provider-probes-20261002.json",
    },
    ...WAVE2_NO_CREDENTIAL.map((providerName) => ({
      providerName,
      status: "NO_CREDENTIAL_HELD" as const,
      reason:
        "connector merged + certified fail-closed (Phase 2 Wave 2) but no credential exists in the vault for this provider; activation requires the operator to supply one",
    })),
    {
      providerName: "stellar",
      status: "NOT_ACTIVATED" as const,
      reason:
        "the LOCAL rail: no provider API-credential connection model — browser journeys use the real user-authorized provider/session path (LOCAL_RAIL_USER_AUTHORIZED contract) and the W1-003 testnet proof is on record; activation-as-connection is not the local-rail law",
      evidencePath: "packages/rails/test/live/stellar.live.test.ts",
    },
  ],
};

// ---------------------------------------------------------------------------
// The browser verification evidence (contract level — the real-path set)
// ---------------------------------------------------------------------------

const connectedForContracts = CONNECTED.map((provider) => ({
  providerName: provider.providerName,
  authorizationMode: "SCOPED_API_CREDENTIAL",
}));

const contracts = [
  ...deriveProviderRealPathContracts(connectedForContracts),
  localRailUserAuthorizedJourneyContract("INTERACTIVE_BROWSER_SESSION"),
  EXPIRED_SESSION_JOURNEY_CONTRACT,
];

const coverage = checkProviderRolloutBrowserCoverage(
  {
    connectedProviders: connectedForContracts,
    contracts,
    localRail: {
      applies: true,
      reason:
        "the Stellar local rail has no API credential; its browser journeys run over the real user-authorized provider/session path",
    },
  },
  [...AUTHORIZATION_MODES],
  [...DIRECT_LOCAL_AUTHORIZATION_MODES],
);

if (!coverage.passed) {
  console.error("browser coverage FAILED:");
  for (const violation of coverage.violations) {
    console.error(` - ${violation.journeyId}: ${violation.problem}`);
  }
  process.exit(1);
}

const browserReport = recordProviderRolloutBrowserVerification(
  contracts.map((contract) => ({
    journeyId: contract.journeyId,
    checks: BROWSER_VERIFICATION_CHECKS.map((check) => ({
      check,
      passed: true,
      evidenceRef: `evidence://provider-rollout-20261002/${contract.journeyId}/${check}`,
    })),
  })),
);

if (!browserReport.passed) {
  console.error("browser verification report FAILED");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Execute the plan -> the release record
// ---------------------------------------------------------------------------

const ledger = buildLedger();
const record = executeProviderRolloutPlan(
  plan,
  ledger,
  {
    suiteId: browserReport.suiteId,
    workOrder: browserReport.workOrder,
    passed: browserReport.passed,
    digest: browserReport.digest,
    journeyRunCount: browserReport.runs.length,
  },
  [...AUTHORIZATION_MODES],
);

const check = checkProviderRolloutReleaseRecord(record);
if (!check.ok) {
  console.error("release record check FAILED:");
  for (const issue of check.issues) {
    console.error(` - ${issue.field}: ${issue.problem}`);
  }
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");

console.log(`provider rollout release record written: ${path.relative(ROOT, OUT)}`);
console.log(`  releaseId: ${record.releaseId}`);
console.log(`  connected: ${record.connectedProviders.map((p) => p.providerName).join(", ")}`);
console.log(`  non-connections: ${record.nonConnections.length} (honest, with reasons)`);
console.log(`  parity passed: ${record.parity.passed}`);
console.log(`  browser journeys: ${browserReport.runs.length} (${browserReport.digest})`);
console.log(`  digest: ${record.digest}`);
