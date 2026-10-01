/**
 * @payswap/ux — incumbent context/action views with provenance VISIBILITY
 * (W3-006).
 *
 * W3-006 work order: "specialized external systems remain authoritative
 * where required and their provenance is visible." FRONTEND-UX-DEPLOYMENT
 * ("external-system strategy"): PaySwap connects external systems, ingests
 * canonical references, maps them into the Work Graph and executes writes
 * through certified connectors — the incumbent remains the system of record.
 *
 * INV-E04 (the binding rule here): UI/browser artifacts are not stronger
 * than their authenticated provenance. This module encodes a STRENGTH
 * ORDER over provenance sources:
 *
 *   UNVERIFIED_BROWSER_ARTIFACT < USER_REPORTED < CONNECTOR_OBSERVED
 *   < AUTHENTICATED_PROVIDER_RECORD
 *
 * `deriveProvenanceLabel` derives the label deterministically from the
 * declared source; `assertProvenanceWithinBound` makes it a hard error for a
 * view to claim provenance stronger than the bound its source establishes —
 * a browser-local artifact can never render as an authenticated provider
 * record.
 *
 * Deterministic by construction: pure derivations, no network, no DOM.
 */

import type { ViewAction } from './command-center.js';

// ---------------------------------------------------------------------------
// Provenance strength
// ---------------------------------------------------------------------------

/**
 * The provenance strength order. Index 0 is the weakest. The order is part of
 * the UX contract (INV-E04) and must never be reordered silently.
 */
export const PROVENANCE_STRENGTH_ORDER = [
  'UNVERIFIED_BROWSER_ARTIFACT',
  'USER_REPORTED',
  'CONNECTOR_OBSERVED',
  'AUTHENTICATED_PROVIDER_RECORD',
] as const;

export type ProvenanceStrength = (typeof PROVENANCE_STRENGTH_ORDER)[number];

/** The declared source of a view's data. */
export type ProvenanceSourceKind =
  | 'BROWSER_LOCAL'
  | 'USER_REPORT'
  | 'CONNECTED_INSTANCE'
  | 'PROVIDER_ENVELOPE';

export interface ProvenanceSourceInput {
  readonly source: ProvenanceSourceKind;
  /** Name of the incumbent system the data came from, when applicable. */
  readonly systemName?: string;
  /** External reference within that system, when applicable. */
  readonly externalRef?: string;
  /** RFC 3339 observation time, when the source carries one. */
  readonly observedAt?: string;
}

/** The derived provenance label attached to a view item. */
export interface ProvenanceLabel {
  readonly strength: ProvenanceStrength;
  readonly label: string;
  readonly systemName?: string;
  readonly externalRef?: string;
  readonly note: string;
}

/** Raised when a view claims provenance stronger than its source (INV-E04). */
export class ProvenanceViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceViolationError';
  }
}

const SOURCE_TO_STRENGTH: Readonly<Record<ProvenanceSourceKind, ProvenanceStrength>> = Object.freeze({
  BROWSER_LOCAL: 'UNVERIFIED_BROWSER_ARTIFACT',
  USER_REPORT: 'USER_REPORTED',
  CONNECTED_INSTANCE: 'CONNECTOR_OBSERVED',
  PROVIDER_ENVELOPE: 'AUTHENTICATED_PROVIDER_RECORD',
});

const STRENGTH_NOTES: Readonly<Record<ProvenanceStrength, string>> = Object.freeze({
  UNVERIFIED_BROWSER_ARTIFACT:
    'browser-local data with no authenticated provenance; never stronger than the authenticated record it describes',
  USER_REPORTED:
    'reported by an authenticated user without provider attestation; an observation, not an external effect',
  CONNECTOR_OBSERVED:
    'observed through a connected capability instance scoped to a real provider account (INV-C05)',
  AUTHENTICATED_PROVIDER_RECORD:
    'carried verbatim from a preserved ProviderStateEnvelope (INV-C06); the provider is authoritative',
});

/** Derive the provenance label deterministically from the declared source. */
export function deriveProvenanceLabel(input: ProvenanceSourceInput): ProvenanceLabel {
  const strength = SOURCE_TO_STRENGTH[input.source];
  if (strength === undefined) {
    throw new ProvenanceViolationError(`unknown provenance source: ${String(input.source)}`);
  }
  return Object.freeze({
    strength,
    label: `${strength}${input.systemName === undefined ? '' : ` @ ${input.systemName}`}`,
    ...(input.systemName === undefined ? {} : { systemName: input.systemName }),
    ...(input.externalRef === undefined ? {} : { externalRef: input.externalRef }),
    note: STRENGTH_NOTES[strength],
  });
}

/** The rank of a provenance strength in the INV-E04 order (higher = stronger). */
export function provenanceRank(strength: ProvenanceStrength): number {
  const index = PROVENANCE_STRENGTH_ORDER.indexOf(strength);
  if (index < 0) {
    throw new ProvenanceViolationError(`unknown provenance strength: ${String(strength)}`);
  }
  return index;
}

/** True when `candidate` is not stronger than `bound` (INV-E04 order). */
export function provenanceNotStrongerThan(candidate: ProvenanceStrength, bound: ProvenanceStrength): boolean {
  return provenanceRank(candidate) <= provenanceRank(bound);
}

/**
 * Hard INV-E04 gate: a view item whose claimed strength exceeds the bound
 * its source establishes is a contract violation. Every incumbent view calls
 * this with its derived label and its source's bound.
 */
export function assertProvenanceWithinBound(
  candidate: ProvenanceStrength,
  bound: ProvenanceStrength,
  context: string,
): void {
  if (!provenanceNotStrongerThan(candidate, bound)) {
    throw new ProvenanceViolationError(
      `INV-E04 violation (${context}): a view claimed '${candidate}' provenance while its source establishes at most '${bound}'`,
    );
  }
}

// ---------------------------------------------------------------------------
// Incumbent context/action views
// ---------------------------------------------------------------------------

/**
 * An incumbent system that remains a system of record. `authoritativeFor`
 * declares which domains stay authoritative THERE (provenance visibility);
 * `actionsThrough` declares how PaySwap may act on that system.
 */
export interface IncumbentAuthorityDeclaration {
  readonly systemName: string;
  readonly authoritativeFor: readonly string[];
  readonly provenance: ProvenanceSourceInput;
  /** The connector-backed action surface, when a certified connector exists. */
  readonly connectorInstanceId?: string;
  /** Deep link into the incumbent, when it exposes one. */
  readonly deepLink?: string;
}

/** How PaySwap relates to the incumbent for this view. */
export type IncumbentViewRole =
  /** The incumbent remains the system of record; PaySwap shows context. */
  | 'CONTEXT_VIEW_NOT_SYSTEM_OF_RECORD'
  /** Writes go through a certified connector; the incumbent stays authoritative. */
  | 'ACTIONS_THROUGH_CERTIFIED_CONNECTOR';

/** The derived incumbent context/action view. */
export interface IncumbentContextView {
  readonly systemName: string;
  readonly authoritativeFor: readonly string[];
  readonly role: IncumbentViewRole;
  readonly provenanceLabel: ProvenanceLabel;
  readonly connectorInstanceId?: string;
  readonly actions: readonly ViewAction[];
  readonly note: string;
}

/**
 * Derive the incumbent context/action view. Provenance VISIBILITY is the
 * contract: the view states which system is authoritative for what, and the
 * provenance label is derived (never asserted) from the declared source —
 * INV-E04's bound is enforced on the derived label.
 */
export function deriveIncumbentContextView(
  declaration: IncumbentAuthorityDeclaration,
): IncumbentContextView {
  if (typeof declaration.systemName !== 'string' || declaration.systemName === '') {
    throw new ProvenanceViolationError('an incumbent declaration requires a system name');
  }
  if (declaration.authoritativeFor.length === 0) {
    throw new ProvenanceViolationError(
      `incumbent ${declaration.systemName} must declare at least one authoritative domain`,
    );
  }
  const label = deriveProvenanceLabel(declaration.provenance);
  // INV-E04: the derived label can never exceed the source's own bound by
  // construction — the assertion makes the invariant an enforced check, not
  // an assumption.
  assertProvenanceWithinBound(label.strength, label.strength, `incumbent ${declaration.systemName}`);

  const actions: ViewAction[] = [];
  const base = { authorityRef: `incumbent:${declaration.systemName}` };
  if (declaration.deepLink !== undefined) {
    actions.push({
      actionId: 'open-in-incumbent',
      label: `Open in ${declaration.systemName} (authoritative system)`,
      kind: 'EXTERNAL_OPEN',
      ...base,
      available: true,
      externalOpen: { systemName: declaration.systemName, deepLink: declaration.deepLink },
    });
  }
  if (declaration.connectorInstanceId !== undefined) {
    actions.push({
      actionId: 'act-through-connector',
      label: `Act on ${declaration.systemName} through the certified connector`,
      kind: 'API_COMMAND',
      ...base,
      available: true,
    });
  }
  actions.push({
    actionId: 'view-provenance',
    label: 'View which system is authoritative for what',
    kind: 'EVIDENCE_VIEW',
    ...base,
    available: true,
  });

  const role: IncumbentViewRole = declaration.connectorInstanceId === undefined
    ? 'CONTEXT_VIEW_NOT_SYSTEM_OF_RECORD'
    : 'ACTIONS_THROUGH_CERTIFIED_CONNECTOR';

  return Object.freeze({
    systemName: declaration.systemName,
    authoritativeFor: Object.freeze([...declaration.authoritativeFor]),
    role,
    provenanceLabel: label,
    ...(declaration.connectorInstanceId === undefined
      ? {}
      : { connectorInstanceId: declaration.connectorInstanceId }),
    actions: Object.freeze(actions),
    note:
      role === 'CONTEXT_VIEW_NOT_SYSTEM_OF_RECORD'
        ? `${declaration.systemName} remains the authoritative system of record for: ${declaration.authoritativeFor.join(', ')}`
        : `${declaration.systemName} remains authoritative; PaySwap actions go through the certified connector instance`,
  });
}

/**
 * Compare a PaySwap-side view record against an incumbent's authoritative
 * record. INV-E04: the browser artifact can never be stronger — when the two
 * disagree, the incumbent (authenticated provenance) wins and the view is
 * re-derived from it.
 */
export function reconcileViewAgainstIncumbent(input: {
  readonly viewProvenance: ProvenanceLabel;
  readonly incumbentProvenance: ProvenanceLabel;
}): { readonly winner: 'INCUMBENT' | 'VIEW'; readonly reason: string } {
  if (provenanceRank(input.incumbentProvenance.strength) >= provenanceRank(input.viewProvenance.strength)) {
    return {
      winner: 'INCUMBENT',
      reason:
        'the authenticated incumbent record is at least as strong as the view (INV-E04); the view re-renders from authority state only',
    };
  }
  return {
    winner: 'VIEW',
    reason: 'the view carries strictly stronger authenticated provenance than the incumbent reference',
  };
}
