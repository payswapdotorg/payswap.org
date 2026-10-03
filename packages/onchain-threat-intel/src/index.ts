/**
 * @payswap/onchain-threat-intel — Adversarial onchain security + threat
 * intelligence (Work Order P4-W3-003; dependencies P4-W1-002 kernel +
 * P4-W2-002 best-execution).
 *
 * What this package owns:
 * - the 13 onchain threat families (task packet list) with deterministic
 *   detectors over (prepared write, simulation, policy, observation
 *   bundle, instant);
 * - the adversarial transaction agent: a deterministic analysis engine
 *   that outputs THREAT SIGNALS, each carrying its mandatory evidence
 *   chain (which observation, which digest, which exact delta) and an
 *   integer-bps CALIBRATED CONFIDENCE;
 * - the versioned deterministic threat policy and the four-value verdict
 *   vocabulary (ALLOW | ALLOW_WITH_CONSTRAINTS | REQUIRE_CONFIRMATION |
 *   BLOCK) — the policy is AUTHORITATIVE;
 * - the composed no-downgrade seam: composeThreatVerdict +
 *   resolveOnchainSecurityDecision implement the extended kernel law
 *   (an agent BLOCK stays BLOCK; a policy BLOCK overrides an agent ALLOW;
 *   a kernel BLOCK is terminal; a kernel UNKNOWN is never agent-allowed);
 *   attemptAgentVerdictOverride always throws — the rejection is a
 *   tested contract;
 * - the immune-system bridge: advisory proposals + threat signature
 *   registrations structurally aligned with SecurityAdvisory /
 *   ThreatSignature publication inputs, so quarantine/restrict/retire
 *   flows integrate with the REAL immune machinery at the wiring layer
 *   (the W1-002 composition pattern; test/immune-composition.test.ts
 *   drives the real SecurityAdvisoryRegistry / SecurityGate /
 *   QuarantineLedger / SecurityEpochAuthority);
 * - the kernel flag channel: threat signals project onto the kernel's
 *   advisory-only AgentSecurityFlag surface (attachThreatAssessment —
 *   flags never mutate decisions).
 *
 * Boundary law: this package's src/** imports ONLY @payswap workspace
 * packages (onchain-security, best-execution, protocol, trust) — never
 * the security immune-system package directly (its own boundary test
 * forbids src-level consumers; composition with the real machinery is
 * proven at the wiring/test layer), never a venue pack, never a vendor
 * SDK, never a live endpoint. The agent never broadcasts, never mints
 * authorization, never handles key material (the kernel secret scan runs
 * on every agent-facing artifact this package constructs).
 *
 * Deterministic only: callers pass every instant; no ambient clock, no
 * randomness, no floating point anywhere (confidence is integer bps;
 * price deviations are exact BigInt rationals).
 */

export const PACKAGE_NAME = "@payswap/onchain-threat-intel" as const;

// The 13 threat families + severity model.
export * from "./families.js";
// Mandatory evidence chains + exact deltas + rational arithmetic.
export * from "./evidence.js";
// Calibrated confidence (integer basis points).
export * from "./confidence.js";
// The threat-intelligence observation bundle.
export * from "./observations.js";
// Threat signals (evidence + confidence, content-addressed).
export * from "./signals.js";
// The versioned deterministic threat policy + verdict vocabulary.
export * from "./policy.js";
// The 13 family detectors (evidence-generating, never verdicts).
export * from "./detectors.js";
// The adversarial transaction agent + threat assessments.
export * from "./agent.js";
// The composed verdict + the no-downgrade seam + kernel flag channel.
export * from "./verdict.js";
// The immune-system bridge (advisory proposals + signature registrations).
export * from "./advisory-bridge.js";
