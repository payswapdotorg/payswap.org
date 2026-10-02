import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const REQUIRED_ARCH = "1.5-frozen-2026-09-30";

const required = [
  "README.md",
  "AGENTS.md",
  "docs/LLM-ARCHITECT-HANDOFF.md",
  "docs/FINAL-TL-HANDOFF-2026-09-30.md",
  "docs/ARCHITECTURE-REVIEW-2026-09-30.md",
  "spec/architecture/FROZEN-ARCHITECTURE.md",
  "spec/architecture/INVARIANTS.md",
  "spec/architecture/PAYMENT-OPERATING-PLANE.md",
  "spec/architecture/LOSSLESS-CONNECTOR-CAPABILITY-MODEL.md",
  "spec/research/SIMULATION-MULTI-INDUSTRY-PAYMENTS-2026-09-30.md",
  "spec/architecture/DOMAIN-MODEL.md",
  "spec/architecture/PARTICIPATION-ENGINEERING.md",
  "spec/architecture/LAB.md",
  "spec/architecture/SECURITY-EVIDENCE-RECOURSE.md",
  "spec/architecture/INTEGRATIONS.md",
  "spec/architecture/SMART-CONTRACT-EXTENSIONS.md",
  "spec/architecture/FRONTEND-UX-DEPLOYMENT.md",
  "spec/architecture/PSP-ADAPTER-NETWORK.md",
  "spec/architecture/SERVICE-CAPABILITIES.md",
  "spec/research/STRIPE-CAPABILITY-MAP-2026-09-30.md",
  "spec/research/STRIPE-UX-PARITY-LAB.md",
  "spec/architecture/decisions/ADR-001-participation-engineering.md",
  "spec/architecture/decisions/ADR-006-lossless-connector-capability-model.md",
  "spec/research/CASE-STUDIES.md",
  "spec/dependency-graph.md",
  "spec/worker-runbook.md",
  "spec/development-state/README.md",
  "spec/development-state/v2-work-order-state.json"
];

for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) {
    throw new Error("Missing source-of-truth file: " + file);
  }
}

const state = JSON.parse(fs.readFileSync(path.join(root, "spec/development-state/v2-work-order-state.json"), "utf8"));
const frozen = fs.readFileSync(path.join(root, "spec/architecture/FROZEN-ARCHITECTURE.md"), "utf8");
const connector = fs.readFileSync(path.join(root, "spec/architecture/CONNECTOR-PLATFORM.md"), "utf8");
const w3 = fs.readFileSync(path.join(root, "spec/work-items/W3-003.md"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

if (state.max_concurrent_workers !== 3) throw new Error("max_concurrent_workers must remain 3");
if (state.architecture_version !== REQUIRED_ARCH) throw new Error("Unexpected architecture version");
if (!state.frontier || state.frontier.length !== 3) throw new Error("Initial frontier must contain exactly three Work Orders");
if (!state.implementation_authorized) throw new Error("Implementation authorization flag must be true");

// Production deployment gate (operator-exclusive; evolved 2026-10-02 from the
// bootstrap blanket prohibition, which covered the implementation phase):
// - while the roadmap is INCOMPLETE the flag must stay false (the original
//   bootstrap law: no production deploy during implementation);
// - once the roadmap is COMPLETE (21/21, every frontier item COMPLETE) the
//   flag may be true ONLY with a recorded operator authorization —
//   spec/development-state/deployment-authorization.json — carrying the
//   verbatim directive and timestamp. The verifier checks the authorization
//   lineage, not just the bit (AGENTS.md rule 2).
const roadmapComplete =
  Array.isArray(state.completed_work_orders) &&
  state.completed_work_orders.length >= 21 &&
  Array.isArray(state.frontier) &&
  state.frontier.every((wo) => wo && wo.status === "COMPLETE");
if (!roadmapComplete && state.production_deployment_authorized) {
  throw new Error("Production deployment must remain disabled while the roadmap is incomplete (bootstrap prohibition)");
}
if (state.production_deployment_authorized) {
  const authPath = path.join(root, "spec/development-state/deployment-authorization.json");
  if (!fs.existsSync(authPath)) {
    throw new Error("production_deployment_authorized=true requires spec/development-state/deployment-authorization.json (operator authorization lineage)");
  }
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  if (
    auth.authorized !== true ||
    typeof auth.operator_directive !== "string" ||
    auth.operator_directive.trim().length < 10 ||
    typeof auth.authorized_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(auth.authorized_at)
  ) {
    throw new Error("Deployment authorization record is malformed (requires authorized:true, a verbatim operator_directive, and an ISO authorized_at)");
  }
}

for (const lane of ["W1", "W2", "W3"]) {
  for (let n = 1; n <= 7; n++) {
    const file = "spec/work-items/" + lane + "-00" + n + ".md";
    if (!fs.existsSync(path.join(root, file))) throw new Error("Missing Work Order: " + file);
  }
}

for (const marker of [
  "CapabilityDefinition",
  "ProviderImplementation",
  "ConnectedCapabilityInstance",
  "CapabilityObservation",
  "ProviderStateEnvelope",
  "PASS_THROUGH_NATIVE",
  "COMPOSED_PAYSWAP",
  "OPTIMIZED_MULTI_PROVIDER",
  "ExternalFundsPositionObservation"
]) {
  if (!frozen.includes(marker) || !connector.includes(marker)) throw new Error("Connector architecture marker missing: " + marker);
}

if (!w3.includes("Depends on: W3-002, W1-002, W2-003")) {
  throw new Error("W3-003 must consume W2-003 connector capability contracts");
}
if (!readme.includes(REQUIRED_ARCH)) throw new Error("README architecture lock is stale");

console.log("Repository governance verification passed.");
