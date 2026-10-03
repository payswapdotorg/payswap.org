/**
 * @payswap/onchain-threat-intel — the immune-system bridge
 * (Work Order P4-W3-003 hard requirement 3: "quarantine/restrict/retire
 * flows integrate with SecurityAdvisory/ThreatSignature/SecurityEpoch —
 * the existing immune-system machinery (epoch authority, advisory
 * registry, quarantine ledger) is the substrate: real composition, no
 * shadow models (the W1-002 composition-test pattern is the precedent)").
 *
 * This module is the STRUCTURAL ALIGNMENT SURFACE between detected
 * threats and the immune system. It declares contract shapes that are
 * structurally assignable to the immune system's own inputs:
 *
 * - `ThreatAdvisoryProposal` ~ the advisory registry's publish input
 *   (advisoryId, title, severity, description, affected component refs
 *   with the SAME component-kind vocabulary, action, remediation,
 *   provenance). The package's boundary law (the security package's own
 *   boundary test forbids src-level imports of it) means the src layer
 *   composes through these pure-data shapes; the WIRING LAYER (and the
 *   composition tests, which drive the REAL SecurityAdvisoryRegistry /
 *   SecurityGate / QuarantineLedger / SecurityEpochAuthority machines)
 *   performs the actual publication/enforcement. That is exactly the
 *   W1-002 pattern: `OnchainSecurityState` is pure data; the wiring layer
 *   projects it from the real machinery.
 *
 * - `buildThreatSignatureForTarget` ~ the threat signature registry's
 *   register input: one registration per (family, target component) with
 *   indicators naming the family's signal class, so immune-system
 *   signature matching observes onchain threat intelligence.
 *
 * - `bridge component kinds` — the immune system's component-kind
 *   vocabulary (agent_package | agent_body | agent_instance | agent_key |
 *   extension | capability | connected_instance) re-declared as a
 *   structural local union (the onchain-security/types.ts precedent:
 *   "intentionally minimal and structurally assignable ... the Tech Lead
 *   resolves the package-level integration at merge"). NO parallel
 *   vocabulary: the literals are identical.
 *
 * Deterministic only: proposals are pure functions of (assessment,
 * policy); no clock (the assessment's analyzedAt is the instant), no
 * randomness.
 */

import { ValidationError } from "@payswap/protocol";
import type { ThreatAssessment } from "./agent.js";
import type { OnchainThreatPolicy } from "./policy.js";
import type { ThreatFamily, ThreatSeverity } from "./families.js";
import { advisorySeverityFor, familySignalClass } from "./families.js";

// ---------------------------------------------------------------------------
// Evidence refs (structural alignment with the immune system's evidence
// artifact reference: evidenceId + artifactRef + contentDigest)
// ---------------------------------------------------------------------------

/**
 * Reference to an immutable evidence artifact. Structurally identical to
 * the immune system's EvidenceRef (content-addressed artifact pointers);
 * quarantine RELEASE requires exactly these, so proposals carry them.
 */
export interface EvidenceRef {
  readonly evidenceId: string;
  readonly artifactRef: string;
  readonly contentDigest: string;
}

/**
 * Project a threat assessment onto evidence refs: one per signal (the
 * signal's own digest is the artifact content digest; the signal id is
 * the artifact ref) plus the assessment digest itself.
 */
export function evidenceRefsFromAssessment(
  assessment: ThreatAssessment,
): readonly EvidenceRef[] {
  const refs: EvidenceRef[] = [
    {
      evidenceId: `evidence:assessment:${assessment.assessmentId}`,
      artifactRef: `assessment:${assessment.assessmentId}`,
      contentDigest: assessment.assessmentId,
    },
  ];
  for (const signal of assessment.signals) {
    refs.push({
      evidenceId: `evidence:signal:${signal.signalId}`,
      artifactRef: `signal:${signal.signalId}`,
      contentDigest: signal.signalId,
    });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Structural alignment surface: the immune component-kind vocabulary
// ---------------------------------------------------------------------------

/**
 * The immune system's component kinds (structurally identical literals —
 * NO parallel vocabulary; see module doc). Used by advisory proposals so
 * the wiring layer can publish them into the advisory registry verbatim.
 */
export const IMMUNE_COMPONENT_KINDS = [
  "agent_package",
  "agent_body",
  "agent_instance",
  "agent_key",
  "extension",
  "capability",
  "connected_instance",
] as const;

export type ImmuneComponentKind = (typeof IMMUNE_COMPONENT_KINDS)[number];

export function isImmuneComponentKind(
  value: unknown,
): value is ImmuneComponentKind {
  return (
    typeof value === "string" &&
    (IMMUNE_COMPONENT_KINDS as readonly unknown[]).includes(value)
  );
}

/** One affected component of a proposal (kind + id + optional range). */
export interface ThreatAffectedComponent {
  readonly kind: ImmuneComponentKind;
  readonly id: string;
  /** Inclusive affected-version range, when known. */
  readonly versionRange?: { minVersion?: string; maxVersion?: string };
}

// ---------------------------------------------------------------------------
// Advisory proposals (quarantine/restrict/retire flows)
// ---------------------------------------------------------------------------

/**
 * A proposal to publish a SecurityAdvisory from a threat assessment.
 * Structurally assignable to the advisory registry's publish input; the
 * WIRING LAYER performs the publication (real composition happens in the
 * composition tests and the runtime wiring).
 */
export interface ThreatAdvisoryProposal {
  readonly proposalId: string;
  readonly title: string;
  /** low | medium | high | critical (the advisory severity vocabulary). */
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly description: string;
  readonly affected: readonly ThreatAffectedComponent[];
  /** restrict < quarantine < retire (the advisory action vocabulary). */
  readonly action: "restrict" | "quarantine" | "retire";
  readonly remediation: {
    readonly summary: string;
    readonly workarounds: readonly string[];
  };
  readonly declaredBy: string;
  readonly publishedAt: number;
  /** Evidence refs binding the proposal to the assessment's chains. */
  readonly evidence: readonly EvidenceRef[];
  /** Signal ids that drove the proposal (audit lineage). */
  readonly sourceSignalIds: readonly string[];
}

/** Raised on invalid proposal construction (fail closed). */
export class InvalidThreatAdvisoryProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidThreatAdvisoryProposalError";
  }
}

/** Families whose critical detections may justify retirement. */
export const RETIRE_ELIGIBLE_FAMILIES: readonly ThreatFamily[] = Object.freeze([
  "token_impersonation",
  "honeypot_transfer_restriction",
  "proxy_admin_change",
  "bridge_compromise",
]);

/**
 * Derive the advisory action for a driving signal (deterministic):
 * - critical → quarantine (component pulled from circulation pending
 *   remediation; release requires explicit remediation + closure);
 * - high → restrict (global INV-S01 restriction while investigating);
 * - retirement is proposed ONLY for retire-eligible families with
 *   critical severity AND an explicit policy opt-in
 *   (`retireCompromisedContracts: true`) — irreversible steps demand an
 *   explicit versioned decision, never a heuristic.
 */
export function advisoryActionForDrivingSignal(
  family: ThreatFamily,
  severity: ThreatSeverity,
  policy: OnchainThreatPolicy,
): "restrict" | "quarantine" | "retire" {
  if (
    policy.retireCompromisedContracts === true &&
    severity === "critical" &&
    RETIRE_ELIGIBLE_FAMILIES.includes(family)
  ) {
    return "retire";
  }
  if (severity === "critical") {
    return "quarantine";
  }
  return "restrict";
}

function targetComponentsForSignal(
  assessment: ThreatAssessment,
  signalId: string,
): readonly ThreatAffectedComponent[] {
  const signal = assessment.signals.find((s) => s.signalId === signalId);
  if (signal === undefined) {
    return [];
  }
  // Deterministic mapping: the evidence's observation refs name the
  // threatened surface; extract the concrete component id from the ref's
  // conventional `<source>:<component-id>` shape. Detectors emit refs
  // whose suffix after the LAST source tag identifies a concrete chain
  // surface (spender address, asset id, contract address, bridge id, ...
  // — see detectors.ts conventions).
  const components: ThreatAffectedComponent[] = [];
  for (const ref of signal.evidence.observationRefs) {
    const id = componentIdFromObservationRef(ref);
    if (id !== undefined) {
      components.push({ kind: "extension", id });
    }
  }
  return components;
}

/**
 * Source tags whose refs carry a CONCRETE component id directly after the
 * tag prefix (e.g. `approval:0x4444...`, `bridge:bridge:x`, `route:...`).
 * Other refs (direct observation ids like `spender-intel:drainer`, or
 * simulation-internal refs) do NOT identify a quarantinable component.
 */
const COMPONENT_REF_PREFIXES: readonly string[] = [
  "approval:",
  "registry:",
  "protocol:",
  "bridge:",
  "route:",
  "chain:",
  "token-registry:",
];

/**
 * Extract a concrete component id from a conventional observation ref:
 * - `approval:<spender address>` → the spender;
 * - `registry:<chain>:<assetId>` → the asset id (last segment);
 * - `token-registry:<observation-id>` → not a component (observation id);
 * - `protocol:<protocolId>@<contract address>` → the contract address
 *   (after the last `@`);
 * - `bridge:<bridgeId>` → the bridge id;
 * - `route:<routeId>` → not a component (transactional);
 * - `chain:<chainRef>` → not a component (a chain is not a component).
 * Direct observation ids (no recognized prefix pattern) are NOT
 * components — quarantining an observation id would quarantine nothing.
 */
function componentIdFromObservationRef(ref: string): string | undefined {
  if (ref.length === 0 || /\s/.test(ref)) {
    return undefined;
  }
  if (ref.startsWith("approval:")) {
    return ref.slice("approval:".length) || undefined;
  }
  if (ref.startsWith("registry:")) {
    const segments = ref.split(":");
    const last = segments[segments.length - 1];
    return last !== undefined && last.length > 0 ? last : undefined;
  }
  if (ref.startsWith("protocol:")) {
    const at = ref.lastIndexOf("@");
    if (at !== -1) {
      const address = ref.slice(at + 1);
      return address.length > 0 ? address : undefined;
    }
    return undefined;
  }
  if (ref.startsWith("venue:")) {
    const id = ref.slice("venue:".length);
    return id.length > 0 ? id : undefined;
  }
  if (ref.startsWith("bridge:")) {
    // bridge:<bridgeId> — bridge hop coverage refs carry the venue/bridge
    // id directly after the prefix.
    const id = ref.slice("bridge:".length);
    return id.length > 0 ? id : undefined;
  }
  // route:/chain:/token-registry:/spender-intel:/oracle:/mempool:/domain:/
  // finality:/address:/simulation-internal refs name observations, chains
  // or routes — none of them is a quarantinable component identity.
  return undefined;
}

/**
 * Propose immune-system advisories from a threat assessment.
 *
 * Rules (deterministic):
 * - only signals at/high/above `high` severity drive proposals (the
 *   policy's BLOCK/REQUIRE_CONFIRMATION-grade drivers);
 * - one proposal per driving signal family (deduplicated by family, most
 *   severe instance first);
 * - the action follows advisoryActionForDrivingSignal;
 * - evidence refs bind every proposal to the assessment's evidence
 *   chains (quarantine release later REQUIRES such evidence);
 * - zero proposals when no signal reaches the bar.
 */
export function proposeAdvisoriesFromAssessment(
  assessment: ThreatAssessment,
  policy: OnchainThreatPolicy,
): readonly ThreatAdvisoryProposal[] {
  const evidence = evidenceRefsFromAssessment(assessment);
  const proposals: ThreatAdvisoryProposal[] = [];
  const seenFamilies = new Set<ThreatFamily>();

  for (const signal of assessment.signals) {
    if (seenFamilies.has(signal.family)) {
      continue;
    }
    if (signal.severity !== "high" && signal.severity !== "critical") {
      continue;
    }
    seenFamilies.add(signal.family);
    const affected = targetComponentsForSignal(assessment, signal.signalId);
    if (affected.length === 0) {
      continue;
    }
    const action = advisoryActionForDrivingSignal(signal.family, signal.severity, policy);
    proposals.push({
      proposalId: `adv-proposal:${signal.family}:${assessment.assessmentId}`,
      title: `${signal.family} threat detected (${signal.severity})`,
      severity: advisorySeverityFor(signal.severity),
      description:
        `${signal.summary}. Detected by ${assessment.agentRef} at ${assessment.analyzedAt} ` +
        `with calibrated confidence ${signal.confidenceBps} bps; evidence chain bound to ${assessment.evidenceRefs.join(", ")}.`,
      affected: Object.freeze(affected.map((a) => Object.freeze(a))),
      action,
      remediation: {
        summary: `Investigate the ${signal.family} detection and remediate the affected component(s); release of any resulting quarantine requires verified remediation and advisory closure.`,
        workarounds: Object.freeze([
          "halt writes referencing the affected component(s)",
          "revoke outstanding approvals to the affected spender(s)",
        ]),
      },
      declaredBy: assessment.agentRef,
      publishedAt: assessment.analyzedAt,
      evidence: Object.freeze(evidence),
      sourceSignalIds: Object.freeze([signal.signalId]),
    });
  }

  return Object.freeze(proposals);
}

// ---------------------------------------------------------------------------
// Threat signature pack (the intelligence registry alignment surface)
// ---------------------------------------------------------------------------

/** The signature kind vocabulary (structurally identical literals). */
export const THREAT_SIGNATURE_KINDS = [
  "vulnerable_package",
  "vulnerable_extension",
  "malicious_behavior",
  "abuse_pattern",
  "credential_compromise",
] as const;

export type ThreatSignatureKind = (typeof THREAT_SIGNATURE_KINDS)[number];

/** Family → signature kind (deterministic mapping). */
export const FAMILY_SIGNATURE_KIND: Readonly<Record<ThreatFamily, ThreatSignatureKind>> =
  Object.freeze({
    malicious_approval_permit: "malicious_behavior",
    unexpected_spender: "malicious_behavior",
    token_impersonation: "malicious_behavior",
    honeypot_transfer_restriction: "malicious_behavior",
    proxy_admin_change: "vulnerable_extension",
    oracle_manipulation: "vulnerable_extension",
    bridge_compromise: "vulnerable_extension",
    mev_sandwich_exposure: "abuse_pattern",
    destination_chain_confusion: "malicious_behavior",
    replay_signature_domain: "credential_compromise",
    unexpected_balance_delta: "malicious_behavior",
    stale_changed_simulation: "abuse_pattern",
    finality_reorg_anomaly: "abuse_pattern",
  });

/**
 * A signature registration input, structurally assignable to the threat
 * signature registry's register input (signatureId, kind, title,
 * description, affected scope, indicators, declaredBy, publishedAt). The
 * registry computes provenance content hashes at registration time.
 */
export interface ThreatSignatureRegistration {
  readonly signatureId: string;
  readonly kind: ThreatSignatureKind;
  readonly title: string;
  readonly description: string;
  readonly affected: ThreatAffectedComponent;
  readonly indicators: readonly {
    readonly indicatorId: string;
    readonly kind: "action_pattern" | "token_family" | "signal_class";
    readonly pattern: string;
  }[];
  readonly declaredBy: string;
  readonly publishedAt: number;
}

/**
 * Build one family signature registration scoped to a concrete target
 * component (the registry's matching is identity-scoped: kind + id + range).
 * The indicator is the family's signal class, so immune-system observation
 * matching (signalClass pattern) picks up onchain threat intelligence.
 *
 * The `actionPattern` argument adds an optional trust-action indicator
 * (e.g. "onchain.approval.*") for behavioral matching.
 */
export function buildThreatSignatureForTarget(
  family: ThreatFamily,
  target: ThreatAffectedComponent,
  input: {
    declaredBy: string;
    publishedAt: number;
    actionPattern?: string;
  },
): ThreatSignatureRegistration {
  if (!isImmuneComponentKind(target.kind)) {
    throw new ValidationError(
      `unknown immune component kind '${String(target.kind)}'`,
    );
  }
  if (target.id.length === 0) {
    throw new ValidationError("signature target id must be non-empty");
  }
  if (input.declaredBy.length === 0) {
    throw new ValidationError("declaredBy must be a non-empty provenance ref");
  }
  const indicators: {
    readonly indicatorId: string;
    readonly kind: "action_pattern" | "token_family" | "signal_class";
    readonly pattern: string;
  }[] = [
    {
      indicatorId: `${family}:signal-class`,
      kind: "signal_class",
      pattern: familySignalClass(family),
    },
  ];
  if (input.actionPattern !== undefined && input.actionPattern.length > 0) {
    indicators.push({
      indicatorId: `${family}:action-pattern`,
      kind: "action_pattern",
      pattern: input.actionPattern,
    });
  }
  return {
    signatureId: `sig:${family}:${target.kind}:${target.id}`,
    kind: FAMILY_SIGNATURE_KIND[family],
    title: `${family} threat signature (${target.kind} ${target.id})`,
    description: `Onchain threat intelligence signature for family '${family}', scoped to component ${target.kind}:${target.id}. Raised from P4-W3-003 adversarial detections; match observations carrying signal class '${familySignalClass(family)}'.`,
    affected: target,
    indicators,
    declaredBy: input.declaredBy,
    publishedAt: input.publishedAt,
  };
}
