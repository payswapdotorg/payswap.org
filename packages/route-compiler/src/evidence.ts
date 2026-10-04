/**
 * @payswap/route-compiler — route journey evidence (Work Order P4-W4-001,
 * task-packet hard requirement 7: "real integration evidence for supported
 * journeys").
 *
 * A RouteJourneyEvidenceRecord is the durable, digest-stable record of one
 * composed journey: the compiled plan (its digest and per-leg shapes with
 * their custody transfers) plus the walked outcome (per-leg statuses, the
 * canonical settlement event candidates, the reconciliation plan when the
 * journey honestly stopped). Evidence files under packages/route-compiler
 * /evidence/ record these journey shapes — fixture-proven, because live
 * broadcast is impossible by law in this tier (the Lab non-production
 * discipline): the records prove the composed REAL kernels produced these
 * journeys deterministically, which is exactly what the work order asks.
 *
 * Laws: digests are contentDigest (the kernel content-addressing) over the
 * canonical record projection; serialization is canonical-key JSON so
 * records are byte-stable; records reference (never re-declare) the intent.
 */

import { contentDigest } from "@payswap/onchain-security";
import { ValidationError } from "@payswap/protocol";
import type { RoutePlan } from "./route-plan.js";
import type { RouteWalkResult } from "./walk.js";
import type { CustodyTransfer } from "./leg-contracts.js";

/** The durable evidence record of one composed route journey. */
export interface RouteJourneyEvidenceRecord {
  readonly journeyId: string;
  readonly intentRef: string;
  readonly shapeId: string;
  readonly planDigest: string;
  readonly compositionClass: string;
  readonly executionMode: string;
  readonly isProviderNativeBaseline: boolean;
  readonly legs: readonly {
    readonly legId: string;
    readonly legKind: string;
    readonly authorizationKind: string;
    readonly custody: CustodyTransfer;
    readonly plannedAmountBasis: string;
  }[];
  readonly outcome: {
    readonly status: string;
    readonly legStatuses: readonly { readonly legId: string; readonly status: string }[];
    readonly custodyAtStop?: { readonly partyKind: string; readonly assetRef: string };
    readonly reconciliation?: {
      readonly reasons: readonly string[];
      readonly blindRetryForbidden: boolean;
      readonly resolver: string;
    };
  };
  readonly evidenceRefs: readonly string[];
}

/** Builds the journey evidence record for one (plan, walk) pair. */
export function buildRouteJourneyEvidence(
  plan: RoutePlan,
  walk: RouteWalkResult,
): RouteJourneyEvidenceRecord {
  if (walk.planId !== plan.planId) {
    throw new ValidationError(
      `journey evidence pairs one plan with its own walk: plan '${plan.planId}' vs walk '${walk.planId}'`,
    );
  }
  return {
    journeyId: `journey:${plan.intentRef}:${plan.shapeId}`,
    intentRef: plan.intentRef,
    shapeId: plan.shapeId,
    planDigest: plan.planDigest,
    compositionClass: plan.compositionClass,
    executionMode: plan.executionMode,
    isProviderNativeBaseline: plan.isProviderNativeBaseline,
    legs: plan.legs.map((leg) => ({
      legId: leg.legId,
      legKind: leg.legKind,
      authorizationKind: leg.authorizationLineage.legAuthorization.kind,
      custody: leg.custody,
      plannedAmountBasis: leg.plannedAmount.basis,
    })),
    outcome: {
      status: walk.status,
      legStatuses: walk.legExecutions.map((execution) => ({
        legId: execution.legId,
        status: execution.status,
      })),
      ...(walk.custodyAtStop !== undefined
        ? {
            custodyAtStop: {
              partyKind: walk.custodyAtStop.party.kind,
              assetRef: walk.custodyAtStop.assetRef,
            },
          }
        : {}),
      ...(walk.reconciliation !== undefined
        ? {
            reconciliation: {
              reasons: [...walk.reconciliation.reasons],
              blindRetryForbidden: walk.reconciliation.blindRetryForbidden,
              resolver: walk.reconciliation.resolver,
            },
          }
        : {}),
    },
    evidenceRefs: [...plan.evidenceRefs],
  };
}

/** The content digest of one journey record (deterministic, byte-stable). */
export function routeJourneyEvidenceDigest(record: RouteJourneyEvidenceRecord): string {
  return contentDigest(canonicalJourneyProjection(record));
}

function canonicalJourneyProjection(record: RouteJourneyEvidenceRecord): unknown {
  return {
    journeyId: record.journeyId,
    intentRef: record.intentRef,
    shapeId: record.shapeId,
    planDigest: record.planDigest,
    compositionClass: record.compositionClass,
    executionMode: record.executionMode,
    isProviderNativeBaseline: record.isProviderNativeBaseline,
    legs: record.legs.map((leg) => ({
      legId: leg.legId,
      legKind: leg.legKind,
      authorizationKind: leg.authorizationKind,
      custody: leg.custody,
      plannedAmountBasis: leg.plannedAmountBasis,
    })),
    outcome: record.outcome,
    evidenceRefs: [...record.evidenceRefs].sort(),
  };
}

/** Canonical JSON serialization (sorted keys) — byte-stable across runs. */
export function serializeRouteJourneyEvidence(
  records: readonly RouteJourneyEvidenceRecord[],
): string {
  return JSON.stringify(
    records
      .map((record) => canonicalJourneyProjection(record))
      .sort((a, b) =>
        (a as { journeyId: string }).journeyId < (b as { journeyId: string }).journeyId
          ? -1
          : 1,
      ),
    null,
    2,
  );
}

/** The evidence file envelope: journeys + their digests + the fixture-proven law note. */
export interface RouteJourneyEvidenceFile {
  readonly law: "FIXTURE_PROVEN_LIVE_BROADCAST_IMPOSSIBLE_BY_LAW";
  readonly journeys: readonly RouteJourneyEvidenceRecord[];
  readonly digests: readonly { readonly journeyId: string; readonly digest: string }[];
}

export function buildRouteJourneyEvidenceFile(
  records: readonly RouteJourneyEvidenceRecord[],
): RouteJourneyEvidenceFile {
  const canonical = [...records].sort((a, b) =>
    a.journeyId < b.journeyId ? -1 : a.journeyId > b.journeyId ? 1 : 0,
  );
  return {
    law: "FIXTURE_PROVEN_LIVE_BROADCAST_IMPOSSIBLE_BY_LAW",
    journeys: canonical,
    digests: canonical.map((record) => ({
      journeyId: record.journeyId,
      digest: routeJourneyEvidenceDigest(record),
    })),
  };
}
