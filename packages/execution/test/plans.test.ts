import { describe, expect, it } from "vitest";
import { asCommandId } from "@payswap/protocol";
import { ConnectorAuthorityError } from "@payswap/connectors";
import type { ProviderCatalogueEntry } from "@payswap/connectors";
import {
  defineExecutionPlan,
  isExecutionPlan,
  planCompensationProfile,
  planPartialExecutionProfile,
} from "../src/plans.js";
import type { ExecutionPlanInput, ExecutionPlanStep } from "../src/plans.js";
import {
  makeAcceptanceContext,
  makeCapability,
  makeCatalogueEntry,
  makeInstance,
  makeSecondCapability,
  makeSecondInstance,
  NOW,
  PRINCIPAL,
} from "./fixtures.js";

const AUTH = {
  commandId: asCommandId("cmd_1"),
  principal: PRINCIPAL,
  authorizationEvidenceRef: "evidence:auth-1",
};

function step(
  order: number,
  capability: ReturnType<typeof makeCapability>,
  instance: ReturnType<typeof makeInstance>,
): ExecutionPlanStep {
  return {
    stepId: `step_${order}`,
    order,
    role: "collect",
    capability,
    instance,
    providerRequest: { amount: 10_000n },
  };
}

function baseInput(): ExecutionPlanInput {
  const { acceptance } = makeAcceptanceContext();
  return {
    planId: "plan_1",
    executionMode: "COMPOSED_PAYSWAP",
    modeDetail: { kind: "COMPOSED_PAYSWAP", composedWith: ["payswap.fx.convert"] },
    steps: [step(1, makeCapability(), makeInstance())],
    settlementDestination: acceptance.settlementDestination,
    remittance: [{ documentKind: "INVOICE", documentId: "invoice_9" }],
    protocolAuthorization: AUTH,
  };
}

describe("ExecutionPlan (W3-003)", () => {
  it("builds a valid plan with remittance and explicit settlement preserved", () => {
    const plan = defineExecutionPlan(baseInput());
    expect(plan.executionMode).toBe("COMPOSED_PAYSWAP");
    expect(plan.steps).toHaveLength(1);
    expect(plan.remittance[0]).toEqual({ documentKind: "INVOICE", documentId: "invoice_9" });
    expect(plan.settlementDestination.id).toBe("dest_bank_1");
    expect(plan.protocolAuthorization.commandId).toBe("cmd_1");
    expect(isExecutionPlan(plan)).toBe(true);
  });

  it("INV-C07: the execution mode is explicit — invalid or missing modes are rejected", () => {
    const input = baseInput();
    expect(() =>
      defineExecutionPlan({ ...input, executionMode: "AUTO" as never, modeDetail: { kind: "AUTO" } as never }),
    ).toThrow(/INV-C07/);

    // missing protocol authorization is rejected in every mode (no bypass)
    const noAuth = baseInput();
    expect(() =>
      defineExecutionPlan({ ...noAuth, protocolAuthorization: undefined as never }),
    ).toThrow(/protocolAuthorization is required/);
  });

  it("INV-C05: a provider catalogue entry can never be an execution step", () => {
    const input = baseInput();
    const catalogue: ProviderCatalogueEntry = makeCatalogueEntry();
    const catalogueStep: ExecutionPlanStep = {
      ...input.steps[0]!,
      instance: catalogue as never, // an advertisement where an instance is required
    };
    expect(() =>
      defineExecutionPlan({ ...input, steps: [catalogueStep] }),
    ).toThrow(ConnectorAuthorityError);
  });

  it("INV-C05: instances that are not authorized, eligible or fully permitted are rejected", () => {
    const input = baseInput();
    const unauthorized = makeInstance({
      authorization: { status: "REVOKED" },
    });
    expect(() =>
      defineExecutionPlan({
        ...input,
        steps: [step(1, input.steps[0]!.capability, unauthorized)],
      }),
    ).toThrow(/ACTIVE/);

    const ineligible = makeInstance({ eligibility: { eligible: false, reasons: ["geo"] } });
    expect(() =>
      defineExecutionPlan({
        ...input,
        steps: [step(1, input.steps[0]!.capability, ineligible)],
      }),
    ).toThrow(/not eligible/);

    const missingPermissions = makeInstance({
      permissionState: { granted: [], requested: ["payments:write"], missing: ["payments:write"] },
    });
    expect(() =>
      defineExecutionPlan({
        ...input,
        steps: [step(1, input.steps[0]!.capability, missingPermissions)],
      }),
    ).toThrow(/missing permissions/);
  });

  it("INV-C07: a capability that does not declare the plan's mode cannot execute in it", () => {
    const input = baseInput();
    const nativeOnly = makeCapability({ executionModes: ["PASS_THROUGH_NATIVE"] });
    expect(() =>
      defineExecutionPlan({
        ...input,
        steps: [step(1, nativeOnly, makeInstance())],
      }),
    ).toThrow(/does not declare support for execution mode 'COMPOSED_PAYSWAP'/);
  });

  it("PASS_THROUGH_NATIVE preserves exactly ONE incumbent provider step while traversing authorization + evidence", () => {
    const input = baseInput();
    const plan = defineExecutionPlan({
      ...input,
      executionMode: "PASS_THROUGH_NATIVE",
      modeDetail: { kind: "PASS_THROUGH_NATIVE", incumbentProviderName: "test-psp", preservesNativeFlow: true },
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.modeDetail.kind).toBe("PASS_THROUGH_NATIVE");
    // The incumbent provider flow is preserved semantically...
    expect(plan.steps[0]!.instance.providerName).toBe("test-psp");
    // ...while the protocol authorization + evidence boundary is still traversed.
    expect(plan.protocolAuthorization.authorizationEvidenceRef).toBe("evidence:auth-1");

    // Mismatched incumbent provider name is rejected.
    expect(() =>
      defineExecutionPlan({
        ...input,
        executionMode: "PASS_THROUGH_NATIVE",
        modeDetail: { kind: "PASS_THROUGH_NATIVE", incumbentProviderName: "someone-else", preservesNativeFlow: true },
      }),
    ).toThrow(/incumbent provider flow is preserved/);

    // More than one step is not pass-through of one incumbent flow.
    const multi: ReturnType<typeof baseInput> = {
      ...baseInput(),
      steps: [step(1, makeCapability(), makeInstance()), step(2, makeSecondCapability(), makeSecondInstance())],
    };
    expect(() =>
      defineExecutionPlan({
        ...multi,
        executionMode: "PASS_THROUGH_NATIVE",
        modeDetail: { kind: "PASS_THROUGH_NATIVE", incumbentProviderName: "test-psp", preservesNativeFlow: true },
      }),
    ).toThrow(/exactly one step/);
  });

  it("OPTIMIZED_MULTI_PROVIDER orchestrates at least two steps", () => {
    const input = baseInput();
    const plan = defineExecutionPlan({
      ...input,
      executionMode: "OPTIMIZED_MULTI_PROVIDER",
      modeDetail: { kind: "OPTIMIZED_MULTI_PROVIDER", comparedProviders: ["test-psp", "test-psp-2"] },
      steps: [step(1, makeCapability(), makeInstance()), step(2, makeSecondCapability(), makeSecondInstance())],
    });
    expect(plan.steps).toHaveLength(2);
    expect(() =>
      defineExecutionPlan({
        ...input,
        executionMode: "OPTIMIZED_MULTI_PROVIDER",
        modeDetail: { kind: "OPTIMIZED_MULTI_PROVIDER", comparedProviders: ["test-psp"] },
      }),
    ).toThrow(/at least two steps/);
  });

  it("INV-C08: provider-native optimization remains executable as a capability in PASS_THROUGH_NATIVE", () => {
    const { acceptance } = makeAcceptanceContext();
    const nativeOptimization = makeCapability({
      nativeOptimization: { optimizationKind: "ROUTING", benchmarkBaseline: true },
    });
    const plan = defineExecutionPlan({
      planId: "plan_native",
      executionMode: "PASS_THROUGH_NATIVE",
      modeDetail: { kind: "PASS_THROUGH_NATIVE", incumbentProviderName: "test-psp", preservesNativeFlow: true },
      steps: [step(1, nativeOptimization, makeInstance())],
      settlementDestination: acceptance.settlementDestination,
      protocolAuthorization: AUTH,
    });
    expect(plan.steps[0]!.capability.nativeOptimization?.benchmarkBaseline).toBe(true);
    expect(plan.executionMode).toBe("PASS_THROUGH_NATIVE");
  });

  it("derives compensation and partial-execution profiles from the consumed declarations", () => {
    const plan = defineExecutionPlan(baseInput());
    const profile = planCompensationProfile(plan);
    expect(profile.compensable).toBe(false); // fixture capability is non-compensable
    const partial = planPartialExecutionProfile(plan);
    expect(partial.possible).toBe(true);
    expect(partial.granularity).toBe("ATOMIC");
  });

  it("preserves payment-to-invoice/order/project remittance references", () => {
    const input = baseInput();
    const plan = defineExecutionPlan({
      ...input,
      remittance: [
        { documentKind: "INVOICE", documentId: "inv_1" },
        { documentKind: "ORDER", documentId: "ord_1" },
        { documentKind: "PROJECT_MILESTONE", documentId: "pm_1" },
      ],
    });
    expect(plan.remittance.map((ref) => ref.documentKind)).toEqual([
      "INVOICE",
      "ORDER",
      "PROJECT_MILESTONE",
    ]);
  });
});
