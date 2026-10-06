/**
 * The nine §35 acceptance journeys (A–I), registered in the handoff's
 * order. Each journey is deterministic: two runs produce byte-identical
 * outcomes (journeyDigest equality — the determinism guard in the test
 * battery proves it).
 */

import type { ProductionJourney } from "../contract.js";
import { journeyA } from "./a-simple-payment.js";
import { journeyB } from "./b-dex-optimization.js";
import { journeyC } from "./c-crypto-to-fiat.js";
import { journeyD } from "./d-merchant-crypto-payment.js";
import { journeyE } from "./e-mixed-execution.js";
import { journeyF } from "./f-security-attack.js";
import { journeyG } from "./g-agent-opportunity.js";
import { journeyH } from "./h-state-change.js";
import { journeyI } from "./i-reorg-unknown.js";

export const PRODUCTION_JOURNEYS: readonly ProductionJourney[] = Object.freeze([
  journeyA,
  journeyB,
  journeyC,
  journeyD,
  journeyE,
  journeyF,
  journeyG,
  journeyH,
  journeyI,
]);

export { journeyA, journeyB, journeyC, journeyD, journeyE, journeyF, journeyG, journeyH, journeyI };
