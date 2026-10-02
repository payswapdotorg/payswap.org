/**
 * @payswap/journeys — the four SHARED conformance gates (P2-W2-003).
 *
 * The work order's second acceptance: "All providers share the same PaySwap
 * authorization, evidence, reconciliation and security gates." For EVERY
 * executed (provider × scenario) pair — regardless of provider — the same
 * four gate checks run:
 *
 * 1. AUTHORIZATION (INV-NC04): the fail-closed law — no credential → the
 *    connector REFUSES the effectful operation BEFORE any provider call.
 *    Proven with an ARMED scripted transport (it would answer 200; zero
 *    recorded calls proves the refusal happened first).
 * 2. EVIDENCE (INV-C06): ProviderStateEnvelope losslessness — every envelope
 *    the scenario produced survives serialize → parse as an equal envelope
 *    with the external id and provider identity preserved.
 * 3. RECONCILIATION (INV-X03): recovery by external id — the scenario's
 *    re-fetch reproduces the same (external id, family, lifecycle step).
 * 4. SECURITY: secret hygiene — the byte-scan over every product the
 *    scenario produced (envelopes, outcomes, observations, probe results):
 *    no synthetic key material and no live-key patterns ever appear.
 */

import { parseProviderStateEnvelope, serializeProviderStateEnvelope } from "@payswap/connectors";
import type { ProviderStateEnvelope } from "@payswap/connectors";
import type { GateCheck, ScenarioArtifacts } from "./model.js";
import { answeringTransport } from "./model.js";
import type { ProviderConformanceProfile } from "./profile.js";

/** Live key patterns that must NEVER appear in any product. */
const BANNED_KEY_PATTERNS: readonly RegExp[] = [
  /sk_live_[A-Za-z0-9]{16,}/,
  /pk_live_[A-Za-z0-9]{16,}/,
  /whsec_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
];

function gate(name: GateCheck["gate"], passed: boolean, summary: string): GateCheck {
  return { gate: name, passed, summary };
}

// ---------------------------------------------------------------------------
// Gate 1 — AUTHORIZATION (INV-NC04)
// ---------------------------------------------------------------------------

/**
 * The fail-closed law: with NO credential path, the provider's connector
 * must refuse the scenario's effectful operation BEFORE any provider call.
 * The scripted transport is ARMED (it would answer 200) — zero recorded
 * calls is the proof the refusal preceded the provider.
 */
export async function runAuthorizationGate(
  profile: ProviderConformanceProfile,
  scenarioNote: string,
): Promise<GateCheck> {
  const { transport, calls } = answeringTransport({ ok: true });
  const connector = profile.sdkAuth.makeBareConnector(transport.transport);
  const call = profile.sdkAuth.effectfulCalls[0];
  if (call === undefined) {
    return gate(
      "AUTHORIZATION",
      false,
      `${profile.providerName}: no effectful SDK call declared for the fail-closed probe`,
    );
  }
  let refusal: unknown;
  try {
    await call.invoke(connector);
    refusal = undefined;
  } catch (error) {
    refusal = error;
  }
  if (refusal === undefined) {
    return gate(
      "AUTHORIZATION",
      false,
      `${profile.providerName} ${scenarioNote}: the effectful operation '${call.name}' SUCCEEDED with no credentials (INV-NC04 violation)`,
    );
  }
  const message = refusal instanceof Error ? refusal.message : String(refusal);
  const citesAuthorization =
    /not authorized|fail[- ]closed|INV-NC04|unauthorized|credential/i.test(message);
  const zeroCalls = calls.length === 0;
  if (!zeroCalls) {
    return gate(
      "AUTHORIZATION",
      false,
      `${profile.providerName} ${scenarioNote}: refusal happened but ${calls.length} provider call(s) were made first (INV-NC04 violation)`,
    );
  }
  if (!citesAuthorization) {
    return gate(
      "AUTHORIZATION",
      false,
      `${profile.providerName} ${scenarioNote}: refused before any provider call, but the refusal does not cite the authorization law: '${message}'`,
    );
  }
  return gate(
    "AUTHORIZATION",
    true,
    `${profile.providerName} ${scenarioNote}: '${call.name}' refused BEFORE any provider call (0 calls; INV-NC04)`,
  );
}

// ---------------------------------------------------------------------------
// Gate 2 — EVIDENCE (INV-C06 losslessness)
// ---------------------------------------------------------------------------

export function runEvidenceGate(
  profile: ProviderConformanceProfile,
  artifacts: ScenarioArtifacts,
): GateCheck {
  if (artifacts.envelopes.length === 0) {
    return gate(
      "EVIDENCE",
      false,
      `${profile.providerName} ${artifacts.scenarioId}: no envelopes produced — nothing to certify`,
    );
  }
  const failures: string[] = [];
  artifacts.envelopes.forEach((envelope, index) => {
    const roundTrip = evidenceRoundTrip(envelope);
    if (!roundTrip.ok) {
      failures.push(`envelope[${index}]: ${roundTrip.error}`);
    }
  });
  if (failures.length > 0) {
    return gate(
      "EVIDENCE",
      false,
      `${profile.providerName} ${artifacts.scenarioId}: ${failures.length}/${artifacts.envelopes.length} envelopes failed the lossless round-trip — ${failures.join("; ")}`,
    );
  }
  return gate(
    "EVIDENCE",
    true,
    `${profile.providerName} ${artifacts.scenarioId}: ${artifacts.envelopes.length} envelope(s) serialize → parse losslessly with external ids preserved (INV-C06)`,
  );
}

function evidenceRoundTrip(
  envelope: ProviderStateEnvelope,
): { ok: true } | { ok: false; error: string } {
  let serialized: string;
  try {
    serialized = serializeProviderStateEnvelope(envelope);
  } catch (error) {
    return { ok: false, error: `serialize failed: ${errorText(error)}` };
  }
  let parsed: ProviderStateEnvelope;
  try {
    parsed = parseProviderStateEnvelope(serialized);
  } catch (error) {
    return { ok: false, error: `parse failed: ${errorText(error)}` };
  }
  if (parsed.object.externalId !== envelope.object.externalId) {
    return {
      ok: false,
      error: `external id drift '${envelope.object.externalId}' → '${parsed.object.externalId}'`,
    };
  }
  if (parsed.provider.name !== envelope.provider.name) {
    return {
      ok: false,
      error: `provider drift '${envelope.provider.name}' → '${parsed.provider.name}'`,
    };
  }
  if (parsed.revision !== envelope.revision) {
    return {
      ok: false,
      error: `revision drift '${envelope.revision}' → '${parsed.revision}'`,
    };
  }
  if (JSON.stringify(parsed.state) !== JSON.stringify(envelope.state)) {
    return { ok: false, error: "raw provider state not preserved byte-for-byte" };
  }
  if (
    parsed.classification.family !== envelope.classification.family ||
    parsed.classification.lifecycleStep !== envelope.classification.lifecycleStep ||
    parsed.classification.isTerminal !== envelope.classification.isTerminal
  ) {
    return { ok: false, error: "classification not preserved" };
  }
  return { ok: true };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Gate 3 — RECONCILIATION (INV-X03 recovery by external id)
// ---------------------------------------------------------------------------

export function runReconciliationGate(
  profile: ProviderConformanceProfile,
  artifacts: ScenarioArtifacts,
): GateCheck {
  const refetched = artifacts.refetched ?? [];
  if (refetched.length === 0) {
    return gate(
      "RECONCILIATION",
      false,
      `${profile.providerName} ${artifacts.scenarioId}: no re-fetch produced — the webhook-loss recovery path was not exercised`,
    );
  }
  const failures: string[] = [];
  refetched.forEach((reFetched, index) => {
    // INV-X03 match key: (external id, revision). A provider object's
    // lifecycle PROGRESSES on the same external id (pending → succeeded on
    // one refund id) — matching by external id alone would pair a re-fetch
    // of the COMPLETED observation against the PENDING envelope and report
    // a false divergence. The revision (status-derived, per connector law:
    // id + status) identifies the exact observation being re-fetched; a
    // re-fetch that reproduces the same (id, revision) is the recovery
    // proof, and a revision never observed is genuine divergence.
    const match = artifacts.envelopes.find(
      (envelope) =>
        envelope.object.externalId === reFetched.object.externalId &&
        envelope.revision === reFetched.revision,
    );
    if (match === undefined) {
      const idOnly = artifacts.envelopes.find(
        (envelope) => envelope.object.externalId === reFetched.object.externalId,
      );
      failures.push(
        idOnly === undefined
          ? `re-fetch[${index}]: external id '${reFetched.object.externalId}' not among the observed states`
          : `re-fetch[${index}]: (external id '${reFetched.object.externalId}', revision '${reFetched.revision}') not among the observed states (id observed at revision(s) '${artifacts.envelopes.filter((e) => e.object.externalId === reFetched.object.externalId).map((e) => e.revision).join("', '")}')`,
      );
      return;
    }
    if (match.classification.family !== reFetched.classification.family) {
      failures.push(
        `re-fetch[${index}]: family '${match.classification.family}' → '${reFetched.classification.family}'`,
      );
    }
    if (match.classification.lifecycleStep !== reFetched.classification.lifecycleStep) {
      failures.push(
        `re-fetch[${index}]: lifecycleStep '${match.classification.lifecycleStep}' → '${reFetched.classification.lifecycleStep}'`,
      );
    }
  });
  if (failures.length > 0) {
    return gate(
      "RECONCILIATION",
      false,
      `${profile.providerName} ${artifacts.scenarioId}: recovery by external id diverged — ${failures.join("; ")}`,
    );
  }
  return gate(
    "RECONCILIATION",
    true,
    `${profile.providerName} ${artifacts.scenarioId}: ${refetched.length} re-fetch reproduction(s) of the observed states by external id (INV-X03)`,
  );
}

// ---------------------------------------------------------------------------
// Gate 4 — SECURITY (secret hygiene byte-scan)
// ---------------------------------------------------------------------------

export function runSecurityGate(
  profile: ProviderConformanceProfile,
  artifacts: ScenarioArtifacts,
): GateCheck {
  const products: string[] = [];
  for (const envelope of artifacts.envelopes) {
    products.push(JSON.stringify(envelope, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ));
  }
  if (artifacts.outcomes !== undefined) {
    products.push(JSON.stringify(artifacts.outcomes, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ));
  }
  if (artifacts.fundsObservations !== undefined) {
    products.push(JSON.stringify(artifacts.fundsObservations, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ));
  }
  if (artifacts.duplicate !== undefined) {
    products.push(JSON.stringify(artifacts.duplicate));
  }
  if (artifacts.outage !== undefined && artifacts.outage.envelope !== undefined) {
    products.push(JSON.stringify(artifacts.outage.envelope, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ));
  }
  if (artifacts.webhookLoss !== undefined) {
    products.push(JSON.stringify(artifacts.webhookLoss));
  }
  const violations: string[] = [];
  for (const marker of profile.secretMaterialMarkers) {
    for (const product of products) {
      if (product.includes(marker)) {
        violations.push(`synthetic key material '${redact(marker)}' leaked into a product`);
        break;
      }
    }
  }
  for (const pattern of BANNED_KEY_PATTERNS) {
    for (const product of products) {
      if (pattern.test(product)) {
        violations.push(`live key pattern ${pattern} matched a product`);
        break;
      }
    }
  }
  if (violations.length > 0) {
    return gate(
      "SECURITY",
      false,
      `${profile.providerName} ${artifacts.scenarioId}: ${violations.join("; ")}`,
    );
  }
  return gate(
    "SECURITY",
    true,
    `${profile.providerName} ${artifacts.scenarioId}: byte-scan over ${products.length} product(s) — zero key material (synthetic markers + live patterns)`,
  );
}

function redact(marker: string): string {
  return `${marker.slice(0, 6)}…${marker.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// All four gates for one executed pair
// ---------------------------------------------------------------------------

export async function runSharedGates(
  profile: ProviderConformanceProfile,
  artifacts: ScenarioArtifacts,
): Promise<readonly GateCheck[]> {
  const scenarioNote = `(${artifacts.scenarioId})`;
  const authorization = await runAuthorizationGate(profile, scenarioNote);
  const evidence = runEvidenceGate(profile, artifacts);
  const reconciliation = runReconciliationGate(profile, artifacts);
  const security = runSecurityGate(profile, artifacts);
  return [authorization, evidence, reconciliation, security];
}
