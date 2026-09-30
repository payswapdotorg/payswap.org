import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const required = [
  "README.md",
  "AGENTS.md",
  "docs/LLM-ARCHITECT-HANDOFF.md",
  "docs/FINAL-TL-HANDOFF-2026-09-30.md",
  "docs/ARCHITECTURE-REVIEW-2026-09-30.md",
  "spec/architecture/FROZEN-ARCHITECTURE.md",
  "spec/architecture/INVARIANTS.md",
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

const state = JSON.parse(
  fs.readFileSync(
    path.join(root, "spec/development-state/v2-work-order-state.json"),
    "utf8"
  )
);

if (state.max_concurrent_workers !== 3) {
  throw new Error("max_concurrent_workers must remain 3");
}
if (state.architecture_version !== "1.1-frozen-2026-09-30") {
  throw new Error("Unexpected architecture version");
}
if (!state.frontier || state.frontier.length !== 3) {
  throw new Error("Initial frontier must contain exactly three Work Orders");
}
if (!state.implementation_authorized) {
  throw new Error("Implementation authorization flag must be true");
}
if (state.production_deployment_authorized) {
  throw new Error("Production deployment must remain disabled at bootstrap");
}

for (const lane of ["W1", "W2", "W3"]) {
  for (let n = 1; n <= 7; n++) {
    const file = "spec/work-items/" + lane + "-00" + n + ".md";
    if (!fs.existsSync(path.join(root, file))) throw new Error("Missing Work Order: " + file);
  }
}

console.log("Repository governance verification passed.");
