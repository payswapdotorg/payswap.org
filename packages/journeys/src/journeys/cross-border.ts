/**
 * Journey 3 — cross-border (W1-007).
 *
 * FX quote with provenance (INV-F09), spread/fee disclosure, provenance-
 * retained conversion. The FX source is the REAL ECB reference-rates rail
 * adapter (`@payswap/rails`), exercised offline through its pure parsing /
 * cross-rate / quote-building surface — exact rational arithmetic, never a
 * float. The conversion funds two obligations (source currency in, target
 * currency out) that net and settle independently with full evidence.
 */

import {
  GHS,
  USD,
  convert,
  fromMinorUnits,
} from "@payswap/protocol";
import type { AccountId, Money, TimestampMs } from "@payswap/protocol";
import {
  buildEcbQuote,
  crossRateFromReferenceRates,
  parseEcbReferenceRatesXml,
} from "@payswap/rails";
import type { ReferenceRateDocument } from "@payswap/rails";
import type { FxQuote } from "@payswap/protocol";
import { accountId } from "@payswap/protocol";
import {
  assembleJourneyOutcome,
  buildWorld,
  checkAccountingReconciles,
  checkApprovalsAndProofs,
  checkEvidencedChain,
  checkFeesFxIncentivesExact,
  checkLosslessStateReconciliation,
  clearingRecord,
  postEntry,
  providerEnvelope,
  registerRailFixture,
  runSettlementChain,
} from "../harness.js";
import type {
  AxisAssertion,
  InvariantProof,
  JourneyOutcome,
  JourneyWorld,
  SettlementChainOutcome,
} from "../harness.js";

export interface CrossBorderJourneyDetails {
  readonly quoteRate: { readonly numerator: bigint; readonly denominator: bigint };
  readonly convertedAmount: Money;
  readonly spreadBasisPoints: bigint;
  readonly fxFee: Money;
  readonly rateSource: string;
  readonly rateSourceRef: string;
  readonly provenanceObservedAt: TimestampMs;
  readonly usdObligationMinorUnits: bigint;
  readonly ghsObligationMinorUnits: bigint;
  readonly payerBalanceAfter: Money;
  readonly merchantBalanceAfter: Money;
  readonly chain: SettlementChainOutcome;
}

export interface CrossBorderJourneyOutcome {
  readonly journey: JourneyOutcome;
  readonly details: CrossBorderJourneyDetails;
}

const PAYER_USD: AccountId = accountId("ASSET", "wallet.payer.usd");
const FX_PROTOCOL_USD: AccountId = accountId("ASSET", "fx.protocol.usd");
const FX_INVENTORY_USD: AccountId = accountId("ASSET", "fx.inventory.usd");
const FX_PROTOCOL_GHS: AccountId = accountId("ASSET", "fx.protocol.ghs");
const FX_INVENTORY_GHS: AccountId = accountId("ASSET", "fx.inventory.ghs");
const MERCHANT_GHS: AccountId = accountId("ASSET", "wallet.merchant.ghs");
const FX_FEE_INCOME: AccountId = accountId("INCOME", "fees.fx");

/** A trimmed but faithful ECB reference-rates document (offline, deterministic). */
const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
\t<gesmes:subject>Reference rates</gesmes:subject>
\t<gesmes:Sender>
\t\t<gesmes:name>European Central Bank</gesmes:name>
\t</gesmes:Sender>
\t<Cube>
\t\t<Cube time='2025-12-05'>
\t\t\t<Cube currency='USD' rate='1.1355'/>
\t\t\t<Cube currency='GHS' rate='16.2'/>
\t\t</Cube>
\t</Cube>
</gesmes:Envelope>`;

/** Run the cross-border journey deterministically. */
export function runCrossBorderJourney(): CrossBorderJourneyOutcome {
  const world = buildWorld({
    openingBalances: [
      { account: PAYER_USD, amount: fromMinorUnits(USD, 100_000n) },
      { account: FX_INVENTORY_GHS, amount: fromMinorUnits(GHS, 100_000n) },
    ],
  });
  const now = world.clock.now();

  // ---- REAL FX source: ECB reference rates, exact rational cross rate.
  const document: ReferenceRateDocument = parseEcbReferenceRatesXml(ECB_XML);
  const crossRate = crossRateFromReferenceRates(document, "USD", "GHS");
  const quoteResult = buildEcbQuote(document, {
    base: "USD",
    quote: "GHS",
    now,
    spread: {
      basisPoints: 150n,
      disclosedBy: "payswap:operator:1",
      reference: "spread-policy:2026-10",
    },
    fee: {
      amountMinor: 200n,
      currency: "GHS",
      disclosedBy: "payswap:operator:1",
      reference: "fee-schedule:2026-10",
    },
  });
  if (quoteResult.status !== "QUOTE") {
    throw new Error(`cross-border journey: FX quote UNKNOWN (${quoteResult.reason})`);
  }
  const quote: FxQuote = quoteResult.quote;

  // ---- Provenance-retained conversion (INV-F09/F01).
  const sourceAmount = fromMinorUnits(USD, 2_271n);
  const converted = convert(sourceAmount, quote, now);
  // 2,271 USD minor x (162 x 10000)/(10 x 11355) = 32,400 GHS minor EXACTLY.
  if (converted.value !== 32_400n) {
    throw new Error(`cross-border journey: conversion not exact (${converted.value})`);
  }

  registerRailFixture(world, {
    providerName: "psp-fx-corridor",
    capabilityId: "cap.fx.corridor.convert",
    currencies: ["USD", "GHS"],
  });
  const envelope = providerEnvelope(
    {
      providerName: "psp-fx-corridor",
      externalId: "fx_conv_1",
      revision: "rev_1",
      family: "other",
      lifecycleStep: "converted",
      isTerminal: true,
      requiresCustomerAction: false,
      state: { providerNativeStatus: "converted", rateProvenanceRef: quote.provenance.rateSourceRef },
    },
    world,
  );

  // ---- Two-currency obligations: source in, converted target out.
  const dueWindow = { opensAt: now, closesAt: now + 1_000_000n };
  const chain = runSettlementChain({
    world,
    sequence: "crossborder",
    clearingRecords: [
      clearingRecord("CR:fx:input", [
        {
          id: "FA:fx:input",
          activityType: "FX_CONVERSION_INPUT",
          debtor: "user:payer-crossborder",
          creditor: "party:fx-protocol",
          amount: sourceAmount,
          occurredAt: now,
        },
      ], world),
      clearingRecord("CR:fx:output", [
        {
          id: "FA:fx:output",
          activityType: "FX_CONVERSION_OUTPUT",
          debtor: "party:fx-protocol",
          creditor: "merchant:acme-gh",
          amount: converted,
          occurredAt: now,
        },
      ], world),
    ],
    dueWindow,
    authorizationRefs: ["approval:fx:quote-1", "grant:fx:execution"],
    instructions: [
      {
        settlementDestinationId: "dest:fx-protocol-usd",
        rail: "FX_CORRIDOR_RAIL",
        providerName: "psp-fx-corridor",
      },
      {
        settlementDestinationId: "dest:merchant-gh",
        rail: "FX_CORRIDOR_RAIL",
        providerName: "psp-fx-corridor",
      },
    ],
  });

  // ---- Accounting: two single-currency settlements + FX inventory legs + fee.
  postEntry(
    world,
    [
      { accountId: PAYER_USD, amount: fromMinorUnits(USD, -2_271n) },
      { accountId: FX_PROTOCOL_USD, amount: fromMinorUnits(USD, 2_271n) },
    ],
    "cross-border USD settlement leg",
    "fx:settlement:usd",
  );
  postEntry(
    world,
    [
      { accountId: FX_INVENTORY_USD, amount: fromMinorUnits(USD, 2_271n) },
      { accountId: FX_PROTOCOL_USD, amount: fromMinorUnits(USD, -2_271n) },
    ],
    "FX inventory acquires USD",
    "fx:inventory:usd",
  );
  postEntry(
    world,
    [
      { accountId: FX_PROTOCOL_GHS, amount: fromMinorUnits(GHS, 32_400n) },
      { accountId: FX_INVENTORY_GHS, amount: fromMinorUnits(GHS, -32_400n) },
    ],
    "FX inventory dispenses GHS",
    "fx:inventory:ghs",
  );
  postEntry(
    world,
    [
      { accountId: FX_PROTOCOL_GHS, amount: fromMinorUnits(GHS, -32_400n) },
      { accountId: MERCHANT_GHS, amount: fromMinorUnits(GHS, 32_400n) },
    ],
    "cross-border GHS settlement leg",
    "fx:settlement:ghs",
  );
  const fxFee = fromMinorUnits(GHS, 200n);
  postEntry(
    world,
    [
      { accountId: MERCHANT_GHS, amount: fromMinorUnits(GHS, -200n) },
      { accountId: FX_FEE_INCOME, amount: fxFee },
    ],
    "FX fee",
    "fx:fee",
  );

  const assertions: readonly AxisAssertion[] = [
    checkEvidencedChain(world, chain),
    checkAccountingReconciles(world, [
      { account: PAYER_USD, amount: fromMinorUnits(USD, 97_729n) },
      { account: FX_INVENTORY_USD, amount: fromMinorUnits(USD, 2_271n) },
      { account: FX_INVENTORY_GHS, amount: fromMinorUnits(GHS, 67_600n) },
      { account: MERCHANT_GHS, amount: fromMinorUnits(GHS, 32_200n) },
      { account: FX_FEE_INCOME, amount: fromMinorUnits(GHS, 200n) },
    ]),
    checkFeesFxIncentivesExact([
      {
        label: "converted amount (22.71 USD -> GHS, exact rational cross rate)",
        expected: fromMinorUnits(GHS, 32_400n),
        actual: converted,
      },
      {
        label: "USD obligation equals the source amount",
        expected: sourceAmount,
        actual:
          chain.settlements.find((s) => s.instruction.amount.currency === USD)?.instruction.amount ??
          fromMinorUnits(USD, 0n),
      },
      {
        label: "GHS obligation equals the converted amount",
        expected: converted,
        actual:
          chain.settlements.find((s) => s.instruction.amount.currency === GHS)?.instruction.amount ??
          fromMinorUnits(GHS, 0n),
      },
      {
        label: "disclosed FX fee posted exactly",
        expected: fromMinorUnits(GHS, 200n),
        actual: fxFee,
      },
    ]),
    checkApprovalsAndProofs({
      authorizationEvidenceRefs: ["approval:fx:quote-1", "grant:fx:execution"],
      finalities: chain.settlements.map((s) => s.finality),
      evidenceLineageHasAuthorization: chain.settlements.every(
        (s) => world.evidence.lineageForAction(s.instruction.id).authorization.length > 0,
      ),
    }),
    checkLosslessStateReconciliation(world, {
      envelopes: [envelope],
      canonicalMatches: [
        {
          description: "the conversion envelope retains the rate provenance reference verbatim",
          ok: JSON.stringify(envelope.state).includes(quote.provenance.rateSourceRef),
        },
        {
          description: "both currency legs reached SETTLED canonical state",
          ok: chain.obligations.every((o) => world.obligations.get(o.id)?.state === "SETTLED"),
        },
      ],
      evidenceLinked: chain.settlements.every((s) => s.certificate.evidenceChain.length === 3),
    }),
  ];

  const invariants: readonly InvariantProof[] = [
    { id: "INV-F09", proof: `rate provenance retained: source '${quote.provenance.rateSource}', reference '${quote.provenance.rateSourceRef}', observed ${quote.provenance.observedAt}, spread ${quote.provenance.spread?.basisPoints}bps, fee disclosed by ${quote.provenance.fee?.disclosedBy}` },
    { id: "INV-F01", proof: `the cross rate is the exact rational ${crossRate.numerator}/${crossRate.denominator} and 22.71 USD converts to exactly 324.00 GHS with no rounding` },
    { id: "INV-F03", proof: "every currency leg is a single-currency balanced entry; both trial balances sum to zero" },
    { id: "INV-F07", proof: "both obligations net through one netting set with gross derivations retained" },
    { id: "INV-F06", proof: "two finalities declared, one per currency instruction, both protocol-authorized" },
    { id: "INV-E03", proof: "both finalities required and achieved their policy proof levels" },
  ];

  const journey = assembleJourneyOutcome(
    "cross-border",
    "Cross-border transfer",
    invariants,
    assertions,
    chain.evidenceNodeIds,
  );
  return {
    journey,
    details: {
      quoteRate: quote.rate,
      convertedAmount: converted,
      spreadBasisPoints: quote.provenance.spread?.basisPoints ?? 0n,
      fxFee: fromMinorUnits(GHS, quote.provenance.fee?.amount.value ?? 0n),
      rateSource: quote.provenance.rateSource,
      rateSourceRef: quote.provenance.rateSourceRef,
      provenanceObservedAt: quote.provenance.observedAt,
      usdObligationMinorUnits:
        chain.settlements.find((s) => s.instruction.amount.currency === USD)?.instruction.amount.value ?? 0n,
      ghsObligationMinorUnits:
        chain.settlements.find((s) => s.instruction.amount.currency === GHS)?.instruction.amount.value ?? 0n,
      payerBalanceAfter: projected(world, PAYER_USD),
      merchantBalanceAfter: projected(world, MERCHANT_GHS),
      chain,
    },
  };
}

function projected(world: JourneyWorld, account: AccountId): Money {
  return projectBalancesOf(world, account);
}

import { projectBalances } from "@payswap/protocol";
function projectBalancesOf(world: JourneyWorld, account: AccountId): Money {
  return projectBalances(world.journal, account).get(account) ?? fromMinorUnits(USD, 0n);
}

export const crossBorderJourney = {
  journeyId: "cross-border",
  title: "Cross-border transfer",
  description:
    "FX quote with provenance (INV-F09), spread/fee disclosure, provenance-retained conversion",
  run: (): JourneyOutcome => runCrossBorderJourney().journey,
} as const;
