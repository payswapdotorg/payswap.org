/**
 * @payswap/surface — the stable, versioned, React-free surface API for the
 * PaySwap universal interface (Work Order P4-W4-002 §3.6).
 *
 * Public surface (all contracts, no rendering, no DOM, no network, no
 * framework): see README.md for the versioning/stability policy and the
 * placement decision.
 */

export const PACKAGE_NAME = "@payswap/surface" as const;

export {
  SURFACE_API_VERSION,
  surfaceProvenance,
  type SurfaceContractProvenance,
  type SurfaceStability,
} from "./version.js";

export {
  formatMinorUnits,
  minorUnitsSortKey,
  resolveMinorUnitDigits,
  type MinorUnitDigitsSource,
} from "./money-view.js";

export {
  OUTCOME_REGISTRY,
  outcomeActionById,
  outcomeCapabilityBoard,
  type OutcomeAction,
  type OutcomeActionId,
  type OutcomeCapabilityState,
  type OutcomeDeploymentContext,
  type OutcomeDispatchAuthority,
} from "./outcomes.js";

export {
  UNIVERSAL_AREAS,
  UNIVERSAL_AREA_IDS,
  universalAreaById,
  type AreaEmptyStateContract,
  type UniversalArea,
  type UniversalAreaId,
} from "./areas.js";

export {
  foldGateDecision,
  modeIndicator,
  type GateDecisionView,
  type GatePresentationTone,
  type SurfaceModeIndicator,
} from "./security-vocabulary.js";

export {
  convertRequestSummary,
  foldRouteCompilation,
  type ConvertPlanView,
  type ConvertPreviewRequest,
  type ConvertPreviewView,
  type RouteCompilationDisclosureSource,
  type RoutePlanDisclosureSource,
} from "./convert-preview.js";
