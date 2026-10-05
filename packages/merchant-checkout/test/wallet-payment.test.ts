import { describe, expect, it } from "vitest";
import { ValidationError } from "@payswap/protocol";
import {
  attachCheckoutSimulation,
  authorizeCheckoutPayment,
  buildCheckoutAuthorization,
  handOffForBroadcast,
  prepareCheckoutWrite,
  recheckCheckoutPayment,
  renderPaymentSummary,
  walletPaymentAuthorizationLineage,
} from "../src/index.js";
import type { CustomerPaymentOption } from "../src/index.js";
import {
  checkoutSecurityPolicy,
  checkoutSecurityState,
  CUSTOMER_APPROVER_REF,
  CUSTOMER_WALLET,
  CHECKOUT_SERVICE_PRINCIPAL,
  EXPIRY,
  QUOTE_VALID_UNTIL,
  fixtureQuote,
  LATER,
  MERCHANT_DESTINATION,
  successfulSimulation,
  testApprovalSurface,
  TEST_SIGNER_ADAPTER,
  recheckObservationFor,
  USC_CRYPTO_ASSET,
  USC_RAIL_BINDING,
} from "./fixtures.js";
import { openFlowFixture } from "./fixtures-extra.js";

/** P4-W2-003 §3.4 — the customer wallet payment through the REAL W1-002 kernel. */

function preparedFixture() {
  const flow = openFlowFixture();
  const option: CustomerPaymentOption = {
    kind: "CRYPTO_WALLET_PAYMENT",
    optionId: `crypto:${USC_CRYPTO_ASSET.id}@${USC_RAIL_BINDING.merchantChainId}`,
    assetId: USC_CRYPTO_ASSET.id,
    chainId: USC_RAIL_BINDING.merchantChainId,
    railBinding: USC_RAIL_BINDING,
    quote: fixtureQuote(),
    displayAmount: fixtureQuote().cryptoAmount,
  };
  const { pipeline } = prepareCheckoutWrite({
    flow,
    optionId: option.optionId,
    customerWalletAddress: CUSTOMER_WALLET,
    destinationAddress: MERCHANT_DESTINATION,
    writeId: "write-1",
    requestedBy: "agent:checkout-service-key-1",
    policy: checkoutSecurityPolicy(),
    now: LATER,
  });
  return { flow, option, pipeline };
}

describe("wallet payment — prepare (the kernel write)", () => {
  it("prepares a consequential write bound to the option's exact quote", () => {
    const { pipeline } = preparedFixture();
    expect(pipeline.state).toBe("PREPARED");
    const write = pipeline.prepared;
    expect(write.action).toBe("onchain.transfer");
    expect(write.chain).toBe(USC_RAIL_BINDING.chainRef);
    expect(write.transfer?.amount.minorUnits).toBe(fixtureQuote().cryptoAmount.value.toString());
    expect(write.transfer?.from).toBe(CUSTOMER_WALLET);
    expect(write.transfer?.to).toBe(MERCHANT_DESTINATION);
    expect(write.expiry).toBe(Number(fixtureQuote().validUntil));
  });

  it("refuses to prepare against an expired option (expiry at boundary)", () => {
    const flow = openFlowFixture();
    expect(() =>
      prepareCheckoutWrite({
        flow,
        optionId: `crypto:${USC_CRYPTO_ASSET.id}@${USC_RAIL_BINDING.merchantChainId}`,
        customerWalletAddress: CUSTOMER_WALLET,
        destinationAddress: MERCHANT_DESTINATION,
        writeId: "write-late",
        requestedBy: "agent:checkout-service-key-1",
        policy: checkoutSecurityPolicy(),
        now: fixtureQuote().validUntil,
      }),
    ).toThrow(/expired/);
  });

  it("refuses to prepare a fiat fallback option", () => {
    const flow = openFlowFixture();
    expect(() =>
      prepareCheckoutWrite({
        flow,
        optionId: "fiat:pm-card",
        customerWalletAddress: CUSTOMER_WALLET,
        destinationAddress: MERCHANT_DESTINATION,
        writeId: "write-x",
        requestedBy: "agent:checkout-service-key-1",
        policy: checkoutSecurityPolicy(),
        now: LATER,
      }),
    ).toThrow(ValidationError);
  });
});

describe("wallet payment — the customer SEES what they are signing", () => {
  it("the payment summary names the merchant, both amounts, asset, chain and destination", () => {
    const { option } = preparedFixture();
    const lines = renderPaymentSummary({
      merchantName: "Fixture Coffee Roasters",
      fiatAmount: option.quote.fiatAmount,
      fees: option.quote.fees,
      option,
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: MERCHANT_DESTINATION,
    });
    const rendered = lines.join("\n");
    expect(rendered).toContain("Fixture Coffee Roasters");
    expect(rendered).toContain("9900 minor units of USD");
    expect(rendered).toContain("10000 minor units of USC");
    expect(rendered).toContain(CUSTOMER_WALLET);
    expect(rendered).toContain(MERCHANT_DESTINATION);
    expect(rendered).toContain("ethereum:mainnet");
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });

  it("the bundle carries the summary, the typed diff rendering and the gate outcome", () => {
    const { option, pipeline } = preparedFixture();
    pipeline.simulate(successfulSimulation("write-1"), Number(LATER));
    const decision = pipeline.runGates(checkoutSecurityState({ observedAt: Number(LATER) }), Number(LATER));
    expect(decision.decision).toBe("ALLOW");
    const bundle = buildCheckoutAuthorization({
      pipeline,
      requestId: "authreq-1",
      principal: CHECKOUT_SERVICE_PRINCIPAL,
      merchantName: "Fixture Coffee Roasters",
      option,
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: MERCHANT_DESTINATION,
      now: LATER,
    });
    expect(bundle.paymentSummary.length).toBeGreaterThan(0);
    expect(bundle.diffRendering.length).toBeGreaterThan(0);
    expect(bundle.request.requestHash.length).toBeGreaterThan(0);
    expect(bundle.request.write.writeDigest).toBe(pipeline.prepared.writeDigest);
    // The diff says what the simulation predicts.
    const diffText = bundle.diffRendering.join("\n");
    expect(diffText).toContain(CUSTOMER_WALLET);
    expect(diffText).toContain(MERCHANT_DESTINATION);
  });

  it("a simulation predicting a different debit amount is rejected (the customer signs what they see)", () => {
    const { option, pipeline } = preparedFixture();
    expect(() =>
      attachCheckoutSimulation(
        pipeline,
        successfulSimulation("write-1", { debitMinorUnits: "999" }),
        option,
        LATER,
      ),
    ).toThrow(ValidationError);
  });
});

describe("wallet payment — authorize (the trusted surface only)", () => {
  function gatedPipeline() {
    const prepared = preparedFixture();
    prepared.pipeline.simulate(successfulSimulation("write-1"), Number(LATER));
    const decision = prepared.pipeline.runGates(
      checkoutSecurityState({ observedAt: Number(LATER) }),
      Number(LATER),
    );
    if (decision.decision !== "ALLOW") {
      throw new Error(`fixture requires ALLOW, got ${decision.decision}`);
    }
    const bundle = buildCheckoutAuthorization({
      pipeline: prepared.pipeline,
      requestId: "authreq-1",
      principal: CHECKOUT_SERVICE_PRINCIPAL,
      merchantName: "Fixture Coffee Roasters",
      option: prepared.option,
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: MERCHANT_DESTINATION,
      now: LATER,
    });
    return { ...prepared, bundle };
  }

  it("authorizes through the injected trusted approval surface (rule 10)", () => {
    const gated = gatedPipeline();
    const artifact = authorizeCheckoutPayment(gated.pipeline, {
      surface: testApprovalSurface(),
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: checkoutSecurityState({ observedAt: Number(LATER) }),
      expiresAt: QUOTE_VALID_UNTIL,
      now: LATER,
    });
    expect(artifact.signature.length).toBeGreaterThan(0);
    expect(artifact.principal).toBe(CUSTOMER_APPROVER_REF);
    expect(gated.pipeline.state).toBe("AUTHORIZED");
  });

  it("the trusted surface refuses to mint when the gates BLOCK (destination not permitted)", () => {
    const flow = openFlowFixture();
    const { pipeline } = prepareCheckoutWrite({
      flow,
      optionId: `crypto:${USC_CRYPTO_ASSET.id}@${USC_RAIL_BINDING.merchantChainId}`,
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: "0x9999999999999999999999999999999999999999",
      writeId: "write-blocked",
      requestedBy: "agent:checkout-service-key-1",
      policy: checkoutSecurityPolicy(),
      now: LATER,
    });
    const blocked = pipeline.runGates(
      checkoutSecurityState({ observedAt: Number(LATER) }),
      Number(LATER),
    );
    expect(blocked.decision).toBe("BLOCK");
    // DIFF_READY is unreachable from BLOCKED: the diff cannot even be built.
    expect(() => pipeline.buildExpectedDiff(Number(LATER))).toThrow();
    expect(pipeline.state).toBe("BLOCKED");
  });

  it("a quarantined/restricted security state yields UNKNOWN at the gates (never silently ALLOW)", () => {
    const flow = openFlowFixture();
    const { pipeline } = prepareCheckoutWrite({
      flow,
      optionId: `crypto:${USC_CRYPTO_ASSET.id}@${USC_RAIL_BINDING.merchantChainId}`,
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: MERCHANT_DESTINATION,
      writeId: "write-3",
      requestedBy: "agent:checkout-service-key-1",
      policy: { ...checkoutSecurityPolicy(), knownRoutes: ["fnv1a64:unknown-route"] },
      now: LATER,
    });
    const decision = pipeline.runGates(
      checkoutSecurityState({ observedAt: Number(LATER) }),
      Number(LATER),
    );
    // The route is not certified and the policy escalates: UNKNOWN.
    expect(decision.decision).toBe("UNKNOWN");
    // UNKNOWN cannot be authorized: the trusted surface would refuse, and
    // the diff cannot even be built from GATED_UNKNOWN.
    expect(() => pipeline.buildExpectedDiff(Number(LATER))).toThrow();
  });
});

describe("wallet payment — recheck + broadcast handoff", () => {
  function authorizedPipeline() {
    const prepared = preparedFixture();
    prepared.pipeline.simulate(successfulSimulation("write-1"), Number(LATER));
    prepared.pipeline.runGates(checkoutSecurityState({ observedAt: Number(LATER) }), Number(LATER));
    const bundle = buildCheckoutAuthorization({
      pipeline: prepared.pipeline,
      requestId: "authreq-1",
      principal: CHECKOUT_SERVICE_PRINCIPAL,
      merchantName: "Fixture Coffee Roasters",
      option: prepared.option,
      customerWalletAddress: CUSTOMER_WALLET,
      destinationAddress: MERCHANT_DESTINATION,
      now: LATER,
    });
    authorizeCheckoutPayment(prepared.pipeline, {
      surface: testApprovalSurface(),
      approverRef: CUSTOMER_APPROVER_REF,
      securityState: checkoutSecurityState({ observedAt: Number(LATER) }),
      expiresAt: QUOTE_VALID_UNTIL,
      now: LATER,
    });
    return { ...prepared, bundle };
  }

  it("a passing recheck hands off a signing request to the injected signer adapter", () => {
    const prepared = authorizedPipeline();
    const recheck = recheckCheckoutPayment(
      prepared.pipeline,
      recheckObservationFor(prepared.pipeline.prepared, checkoutSecurityState({ observedAt: Number(LATER) }), LATER),
      LATER,
    );
    expect(recheck.outcome).toBe("RECHECK_OK");
    const signingRequest = handOffForBroadcast(prepared.pipeline, {
      requestId: "signreq-1",
      adapter: TEST_SIGNER_ADAPTER,
      now: LATER,
    });
    expect(prepared.pipeline.state).toBe("BROADCAST_HANDOFF");
    expect(signingRequest.chain).toBe(USC_RAIL_BINDING.chainRef);
    expect(signingRequest.authorizationRef).toBe(prepared.bundle.request.requestHash);
  });

  it("drift at recheck VOIDS the authorization (terminal; re-request, never repair)", () => {
    const prepared = authorizedPipeline();
    const drifted = {
      ...recheckObservationFor(
        prepared.pipeline.prepared,
        checkoutSecurityState({ observedAt: Number(LATER) }),
        LATER,
      ),
      writeDigest: "fnv1a64:drifted",
    };
    const outcome = recheckCheckoutPayment(prepared.pipeline, drifted, LATER);
    expect(outcome.outcome).toBe("AUTHORIZATION_VOIDED");
    expect(prepared.pipeline.state).toBe("VOIDED");
    // The voided pipeline can never hand off.
    expect(() =>
      handOffForBroadcast(prepared.pipeline, {
        requestId: "signreq-x",
        adapter: TEST_SIGNER_ADAPTER,
        now: LATER,
      }),
    ).toThrow();
  });

  it("the lineage binds request hash, write digest, summary digest and the submission", () => {
    const prepared = authorizedPipeline();
    recheckCheckoutPayment(
      prepared.pipeline,
      recheckObservationFor(prepared.pipeline.prepared, checkoutSecurityState({ observedAt: Number(LATER) }), LATER),
      LATER,
    );
    const signingRequest = handOffForBroadcast(prepared.pipeline, {
      requestId: "signreq-1",
      adapter: TEST_SIGNER_ADAPTER,
      now: LATER,
    });
    const lineage = walletPaymentAuthorizationLineage({
      bundle: prepared.bundle,
      signingRequest,
      handoffReceipt: {
        requestRef: signingRequest.requestId,
        submittedAt: Number(LATER),
        externalRef: "tx:fixture-1",
        evidenceRefs: ["evidence:submission-1"],
      },
      chainRef: signingRequest.chain,
    });
    expect(lineage.authorizationRequestHash).toBe(prepared.bundle.request.requestHash);
    expect(lineage.writeDigest).toBe(prepared.pipeline.prepared.writeDigest);
    expect(lineage.paymentSummaryDigest).toBe(prepared.bundle.summaryDigest);
    expect(lineage.externalSubmissionRef).toBe("tx:fixture-1");
    expect(lineage.evidenceRefs.length).toBeGreaterThan(0);
  });

  it("refuses a lineage whose signing request executes a different authorization", () => {
    const prepared = authorizedPipeline();
    recheckCheckoutPayment(
      prepared.pipeline,
      recheckObservationFor(prepared.pipeline.prepared, checkoutSecurityState({ observedAt: Number(LATER) }), LATER),
      LATER,
    );
    const signingRequest = handOffForBroadcast(prepared.pipeline, {
      requestId: "signreq-1",
      adapter: TEST_SIGNER_ADAPTER,
      now: LATER,
    });
    expect(() =>
      walletPaymentAuthorizationLineage({
        bundle: prepared.bundle,
        signingRequest: { ...signingRequest, authorizationRef: "fnv1a64:other" },
        handoffReceipt: {
          requestRef: signingRequest.requestId,
          submittedAt: Number(LATER),
          externalRef: "tx:fixture-1",
          evidenceRefs: [],
        },
        chainRef: signingRequest.chain,
      }),
    ).toThrow(ValidationError);
  });
});
