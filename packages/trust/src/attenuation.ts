import type {
  ActionPattern,
  AmountSpec,
  CostCaps,
  EscalationPolicy,
  Mandate,
  MandateLimits,
  PermissionGrant,
  ProofRequirement,
  ResourcePattern,
  VelocityLimit,
} from "./mandate.js";
import {
  actionPatternCoveredBy,
  compareAmounts,
  proofLevelRank,
  resourcePatternCoveredBy,
  validateActionPattern,
  validateResourcePattern,
} from "./mandate.js";

/**
 * Delegation attenuation (INV-A01, AGENTS.md rule 9).
 *
 * Child delegation is always attenuated: EVERY dimension of the child mandate
 * must be a subset of (or at most as permissive as) the parent. Any widening
 * raises AttenuationViolationError naming the exact violated dimension.
 */

/** Dimensions checked by attenuate(). Part of the error contract. */
export type AttenuationDimension =
  | "actions"
  | "resources"
  | "rails"
  | "currencies"
  | "countries"
  | "beneficiaries"
  | "limits.perTransactionAmount"
  | "limits.velocity.windowMs"
  | "limits.velocity.maxCount"
  | "limits.velocity.maxAmount"
  | "costCaps.maxTotalCost"
  | "costCaps.maxFxSpreadBps"
  | "expiry"
  | "escalation"
  | "proofRequirements";

/** Raised when a child mandate would widen the parent on any dimension (INV-A01). */
export class AttenuationViolationError extends Error {
  readonly dimension: AttenuationDimension;

  constructor(dimension: AttenuationDimension, detail: string) {
    super(`Attenuation violation on dimension '${dimension}': ${detail}`);
    this.name = "AttenuationViolationError";
    this.dimension = dimension;
  }
}

function violate(dimension: AttenuationDimension, detail: string): never {
  throw new AttenuationViolationError(dimension, detail);
}

/**
 * Request for a child mandate. Omitted dimensions are inherited from the
 * parent verbatim (inheritance can never widen). A supplied dimension must be
 * attenuated relative to the parent before the child mandate is constructed.
 */
export interface ChildMandateRequest {
  readonly mandateId: string;
  readonly version: number;
  readonly grantee: string;
  readonly actions?: readonly ActionPattern[];
  readonly resources?: readonly ResourcePattern[];
  readonly rails?: readonly string[];
  readonly currencies?: readonly string[];
  readonly countries?: readonly string[];
  readonly beneficiaries?: readonly string[];
  readonly limits?: MandateLimits;
  readonly costCaps?: CostCaps;
  readonly expiresAt?: number;
  readonly escalation?: EscalationPolicy;
  readonly proofRequirements?: readonly ProofRequirement[];
}

function escalationStrength(policy: EscalationPolicy["onLimitExceeded"]): number {
  return policy === "deny" ? 2 : 1;
}

function assertAmountNotWider(
  dimension: AttenuationDimension,
  child: AmountSpec,
  parent: AmountSpec,
): void {
  if (child.currency !== parent.currency) {
    violate(
      dimension,
      `child amount currency ${child.currency} does not match parent currency ${parent.currency}: subset cannot be proven`,
    );
  }
  if (compareAmounts(child, parent) > 0) {
    violate(
      dimension,
      `child amount ${child.currency} ${child.minorUnits} exceeds parent ${parent.currency} ${parent.minorUnits}`,
    );
  }
}

function assertScopeAttenuated(
  dimension: AttenuationDimension,
  child: readonly string[] | undefined,
  parent: readonly string[] | undefined,
): readonly string[] | undefined {
  if (parent === undefined) {
    return child; // parent unrestricted: any child scope is a narrowing
  }
  if (child === undefined) {
    return parent; // inherit
  }
  for (const item of child) {
    if (!parent.includes(item)) {
      violate(dimension, `'${item}' is not permitted by the parent mandate`);
    }
  }
  return child;
}

function resolveLimits(
  parent: Mandate,
  request: ChildMandateRequest,
): MandateLimits | undefined {
  const parentLimits = parent.limits;
  const childLimits = request.limits;
  if (parentLimits === undefined) {
    return childLimits; // pure addition of restrictions
  }
  if (childLimits === undefined) {
    return parentLimits; // inherit
  }

  let perTransactionAmount = parentLimits.perTransactionAmount;
  if (childLimits.perTransactionAmount !== undefined) {
    if (parentLimits.perTransactionAmount !== undefined) {
      assertAmountNotWider(
        "limits.perTransactionAmount",
        childLimits.perTransactionAmount,
        parentLimits.perTransactionAmount,
      );
    }
    perTransactionAmount = childLimits.perTransactionAmount;
  }

  let velocity: VelocityLimit | undefined = parentLimits.velocity;
  if (childLimits.velocity !== undefined) {
    const parentVelocity = parentLimits.velocity;
    if (parentVelocity === undefined) {
      velocity = childLimits.velocity;
    } else {
      if (childLimits.velocity.windowMs < parentVelocity.windowMs) {
        violate(
          "limits.velocity.windowMs",
          `child window ${childLimits.velocity.windowMs}ms is shorter than parent window ${parentVelocity.windowMs}ms, which weakens the velocity bound`,
        );
      }
      let maxCount = parentVelocity.maxCount;
      if (childLimits.velocity.maxCount !== undefined) {
        if (
          parentVelocity.maxCount !== undefined &&
          childLimits.velocity.maxCount > parentVelocity.maxCount
        ) {
          violate(
            "limits.velocity.maxCount",
            `child maxCount ${childLimits.velocity.maxCount} exceeds parent maxCount ${parentVelocity.maxCount}`,
          );
        }
        maxCount = childLimits.velocity.maxCount;
      }
      let maxAmount = parentVelocity.maxAmount;
      if (childLimits.velocity.maxAmount !== undefined) {
        if (parentVelocity.maxAmount !== undefined) {
          assertAmountNotWider(
            "limits.velocity.maxAmount",
            childLimits.velocity.maxAmount,
            parentVelocity.maxAmount,
          );
        }
        maxAmount = childLimits.velocity.maxAmount;
      }
      velocity = {
        windowMs: childLimits.velocity.windowMs,
        ...(maxCount !== undefined ? { maxCount } : {}),
        ...(maxAmount !== undefined ? { maxAmount } : {}),
      };
    }
  }

  return {
    ...(perTransactionAmount !== undefined ? { perTransactionAmount } : {}),
    ...(velocity !== undefined ? { velocity } : {}),
  };
}

function resolveCostCaps(
  parent: Mandate,
  request: ChildMandateRequest,
): CostCaps | undefined {
  const parentCaps = parent.costCaps;
  const childCaps = request.costCaps;
  if (parentCaps === undefined) {
    return childCaps;
  }
  if (childCaps === undefined) {
    return parentCaps;
  }
  let maxTotalCost = parentCaps.maxTotalCost;
  if (childCaps.maxTotalCost !== undefined) {
    if (parentCaps.maxTotalCost !== undefined) {
      assertAmountNotWider(
        "costCaps.maxTotalCost",
        childCaps.maxTotalCost,
        parentCaps.maxTotalCost,
      );
    }
    maxTotalCost = childCaps.maxTotalCost;
  }
  let maxFxSpreadBps = parentCaps.maxFxSpreadBps;
  if (childCaps.maxFxSpreadBps !== undefined) {
    if (parentCaps.maxFxSpreadBps !== undefined) {
      if (childCaps.maxFxSpreadBps > parentCaps.maxFxSpreadBps) {
        violate(
          "costCaps.maxFxSpreadBps",
          `child spread cap ${childCaps.maxFxSpreadBps} bps exceeds parent cap ${parentCaps.maxFxSpreadBps} bps`,
        );
      }
    }
    maxFxSpreadBps = childCaps.maxFxSpreadBps;
  }
  return {
    ...(maxTotalCost !== undefined ? { maxTotalCost } : {}),
    ...(maxFxSpreadBps !== undefined ? { maxFxSpreadBps } : {}),
  };
}

/**
 * Attenuate a parent mandate into a child mandate (INV-A01).
 *
 * The child grantor is always the parent grantee. The returned mandate records
 * `parentMandate` lineage. Throws AttenuationViolationError naming the exact
 * violated dimension on any widening attempt.
 */
export function attenuate(parent: Mandate, request: ChildMandateRequest): Mandate {
  if (request.mandateId.length === 0) {
    violate("actions", "mandateId must not be empty"); // dimension irrelevant; structural guard
  }
  if (request.version < 1) {
    violate("actions", "mandate version must be >= 1"); // structural guard, see above
  }
  if (request.grantee.length === 0) {
    violate("actions", "grantee must not be empty"); // structural guard, see above
  }

  // actions
  const actions = request.actions ?? parent.actions;
  for (const pattern of actions) {
    validateActionPattern(pattern);
    const covered = parent.actions.some((parentPattern) =>
      actionPatternCoveredBy(pattern, parentPattern),
    );
    if (!covered) {
      violate(
        "actions",
        `child action pattern '${pattern}' is not covered by the parent action patterns [${parent.actions.join(", ")}]`,
      );
    }
  }

  // resources
  const resources = request.resources ?? parent.resources;
  for (const pattern of resources) {
    validateResourcePattern(pattern);
    const covered = parent.resources.some((parentPattern) =>
      resourcePatternCoveredBy(pattern, parentPattern),
    );
    if (!covered) {
      violate(
        "resources",
        `child resource pattern '${pattern.type}${pattern.resourceId === undefined ? "" : ":" + pattern.resourceId}' is not covered by the parent resource patterns`,
      );
    }
  }

  // scope dimensions (undefined = unrestricted; omission = inherit)
  const rails = assertScopeAttenuated("rails", request.rails, parent.rails);
  const currencies = assertScopeAttenuated("currencies", request.currencies, parent.currencies);
  const countries = assertScopeAttenuated("countries", request.countries, parent.countries);
  const beneficiaries = assertScopeAttenuated(
    "beneficiaries",
    request.beneficiaries,
    parent.beneficiaries,
  );

  // limits
  const limits = resolveLimits(parent, request);

  // cost caps
  const costCaps = resolveCostCaps(parent, request);

  // expiry: a child mandate can never outlive its parent
  const expiresAt = request.expiresAt ?? parent.expiresAt;
  if (expiresAt > parent.expiresAt) {
    violate(
      "expiry",
      `child expiry ${expiresAt} is later than parent expiry ${parent.expiresAt}`,
    );
  }

  // escalation: a child can only strengthen escalation, never weaken it
  const escalation = request.escalation ?? parent.escalation;
  if (parent.escalation !== undefined && escalation !== undefined) {
    if (escalationStrength(escalation.onLimitExceeded) < escalationStrength(parent.escalation.onLimitExceeded)) {
      violate(
        "escalation",
        `child policy '${escalation.onLimitExceeded}' is weaker than parent policy '${parent.escalation.onLimitExceeded}'`,
      );
    }
    if (
      escalation.onLimitExceeded === "require_approval" &&
      parent.escalation.approverRef !== undefined
    ) {
      // A 'deny' policy is strictly stronger and needs no approver; only a
      // child that still escalates must preserve the parent's approver.
      if (escalation.approverRef === undefined) {
        violate(
          "escalation",
          `child dropped the parent escalation approver '${parent.escalation.approverRef}'`,
        );
      } else if (escalation.approverRef !== parent.escalation.approverRef) {
        violate(
          "escalation",
          `child escalation approver '${escalation.approverRef}' differs from parent approver '${parent.escalation.approverRef}'`,
        );
      }
    }
  }

  // proof requirements: child must retain every parent requirement (at equal or higher level)
  const proofRequirements = request.proofRequirements ?? parent.proofRequirements;
  for (const required of parent.proofRequirements) {
    const covered = proofRequirements.some(
      (candidate) =>
        (candidate.scope ?? "") === (required.scope ?? "") &&
        proofLevelRank(candidate.proofLevel) >= proofLevelRank(required.proofLevel),
    );
    if (!covered) {
      violate(
        "proofRequirements",
        `child does not retain parent proof requirement ${required.proofLevel}${required.scope === undefined ? "" : ` for scope '${required.scope}'`}`,
      );
    }
  }

  return {
    id: request.mandateId,
    version: request.version,
    grantor: parent.grantee,
    grantee: request.grantee,
    actions,
    resources,
    ...(rails !== undefined ? { rails } : {}),
    ...(currencies !== undefined ? { currencies } : {}),
    ...(countries !== undefined ? { countries } : {}),
    ...(beneficiaries !== undefined ? { beneficiaries } : {}),
    ...(limits !== undefined ? { limits } : {}),
    ...(costCaps !== undefined ? { costCaps } : {}),
    expiresAt,
    ...(escalation !== undefined ? { escalation } : {}),
    proofRequirements,
    parentMandate: { mandateId: parent.id, version: parent.version },
  };
}

export interface AttenuateGrantParams {
  readonly grantId: string;
  readonly issuedAt: number;
}

/**
 * Attenuate through a grant: builds the child mandate and issues the child
 * PermissionGrant with full lineage back to the root grant.
 */
export function attenuateGrant(
  parentGrant: PermissionGrant,
  request: ChildMandateRequest,
  params: AttenuateGrantParams,
): PermissionGrant {
  const childMandate = attenuate(parentGrant.mandate, request);
  return {
    grantId: params.grantId,
    mandate: childMandate,
    grantorRef: parentGrant.granteeRef,
    granteeRef: request.grantee,
    issuedAt: params.issuedAt,
    lineage: {
      rootGrantId: parentGrant.lineage.rootGrantId,
      chain: [...parentGrant.lineage.chain, parentGrant.grantId],
    },
  };
}
