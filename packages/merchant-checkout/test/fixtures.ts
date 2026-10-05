import { registerCurrency, currencyCode, fromMinorUnits } from "@payswap/protocol";
import type { Money, TimestampMs } from "@payswap/protocol";
import {
  asPaymentMethodId,
  defineAcceptancePolicy,
  definePaymentMethod,
  defineSettlementDestination,
} from "@payswap/payment";
import type {
  MerchantSettlementDestination,
  PaymentAcceptancePolicy,
  PaymentMethod,
} from "@payswap/payment";
import type { ConnectedCapabilityInstance, ProviderCatalogueEntry } from "@payswap/connectors";
import {
  asChainId,
  defineCryptoAmount,
  defineCryptoAsset,
  defineCryptoAssetAcceptance,
  defineCryptoQuote,
  defineMerchantCryptoAcceptancePolicy,
} from "@payswap/merchant-crypto";
import type { CryptoAmount, CryptoAsset, CryptoQuote } from "@payswap/merchant-crypto";
import {
  TrustedApprovalSurface,
} from "@payswap/onchain-security";
import type {
  OnchainSecurityPolicy,
  OnchainSecurityState,
  RecheckObservation,
  SignerAdapter,
  SimulationObservation,
  TrustedSurfaceSigner,
} from "@payswap/onchain-security";
import type { Principal } from "@payswap/trust";
import type { PreparedWrite } from "@payswap/onchain-security";
import {
  activateCryptoAcceptance,
  activateMerchant,
  draftMerchant,
  submitMerchantApplication,
  verifyMerchant,
} from "../src/index.js";
import type {
  CryptoAcceptanceActivation,
  MerchantProfile,
} from "../src/index.js";
import { defineRailAssetBinding } from "../src/index.js";
import type { RailAssetBinding } from "../src/index.js";

/**
 * Shared deterministic fixtures for the merchant-checkout test battery
 * (synthetic — no real secrets, no real chain claims, no live providers).
 * The trusted-surface signer and the signer adapter are deterministic
 * DOUBLES of the kernel's own PORTS (injected dependencies — the kernel's
 * own test helpers use the same pattern); every domain record is built
 * through the REAL package functions.
 */

// The kernel 3-letter symbol for the stablecoin (AmountSpec currency law).
registerCurrency("USC", 6);

// ---------------------------------------------------------------------------
// Pinned instants (fake clock — no time-of-day dependence anywhere)
// ---------------------------------------------------------------------------

export const NOW: TimestampMs = 1_800_000_000_000n;
export const NOW_KERNEL = Number(NOW);
export const LATER: TimestampMs = NOW + 1_000n;
export const MUCH_LATER: TimestampMs = NOW + 60_000n;
export const EXPIRY: TimestampMs = NOW + 120_000n;
export const QUOTE_VALID_UNTIL: TimestampMs = NOW + 30_000n;

// ---------------------------------------------------------------------------
// Chain / asset identities (the two vocabularies, bound together)
// ---------------------------------------------------------------------------

export const CHAIN_REF = "ethereum:mainnet" as const;

/** The same chain id in the merchant-crypto branded vocabulary. */
export const CHAIN_ID = asChainId(CHAIN_REF);

/** The merchant-crypto asset vocabulary. */
export const USC_CRYPTO_ASSET: CryptoAsset = defineCryptoAsset({
  id: "asset.usc.ethereum",
  displayName: "USD Coin (test fixture)",
  symbol: "USC",
  decimals: 6,
  kind: "STABLECOIN",
});

/** The kernel-side asset identity (3-letter symbol law). */
export const USC_KERNEL_ASSET = {
  chain: CHAIN_REF,
  assetId: "0xaaaa111111111111111111111111111111111111",
  symbol: "USC",
} as const;

export const CUSTOMER_WALLET = "0x1111111111111111111111111111111111111111";
export const MERCHANT_DESTINATION = "0x2222222222222222222222222222222222222222";

/** The typed rail binding between the two vocabularies. */
export const USC_RAIL_BINDING: RailAssetBinding = defineRailAssetBinding({
  merchantAssetId: USC_CRYPTO_ASSET.id,
  merchantChainId: CHAIN_REF,
  chainRef: CHAIN_REF,
  assetIdentity: { ...USC_KERNEL_ASSET },
});

// ---------------------------------------------------------------------------
// Exact money + quotes
// ---------------------------------------------------------------------------

export const USD = currencyCode("USD");

/** The cart: 99.00 USD (9900 minor units). */
export const CART_AMOUNT: Money = fromMinorUnits(USD, 9900n);

/** The quoted crypto amount: 10000 USC minor units at ratio 99/100. */
export const QUOTED_USC: CryptoAmount = defineCryptoAmount(USC_CRYPTO_ASSET, 10000n);

export function fixtureQuote(overrides?: {
  readonly id?: string;
  readonly validUntil?: TimestampMs;
  readonly quotedAt?: TimestampMs;
}): CryptoQuote {
  return defineCryptoQuote({
    id: overrides?.id ?? "quote-1",
    assetId: USC_CRYPTO_ASSET.id,
    chainId: CHAIN_REF,
    fiatAmount: CART_AMOUNT,
    cryptoAmount: QUOTED_USC,
    ratio: { numerator: 99n, denominator: 100n },
    fees: fromMinorUnits(USD, 148n),
    quotedAt: overrides?.quotedAt ?? NOW,
    validUntil: overrides?.validUntil ?? QUOTE_VALID_UNTIL,
    sourceRef: "fixture:quote-source",
  });
}

// ---------------------------------------------------------------------------
// The base canonical acceptance policy (fiat + crypto methods)
// ---------------------------------------------------------------------------

export const CARD_METHOD: PaymentMethod = definePaymentMethod({
  id: "pm-card",
  kind: "CARD",
  displayName: "Card",
  currencies: [USD],
  credentialRequirements: [],
});

export const CRYPTO_METHOD: PaymentMethod = definePaymentMethod({
  id: "pm-stablecoin",
  kind: "STABLECOIN_CRYPTO",
  displayName: "Stablecoin",
  currencies: [USD],
  credentialRequirements: [],
});

export function settlementDestination(
  overrides?: { readonly id?: string; readonly externalRef?: string },
): MerchantSettlementDestination {
  return defineSettlementDestination({
    id: overrides?.id ?? "dest-bank-1",
    kind: "BANK_ACCOUNT",
    currency: USD,
    externalRef: overrides?.externalRef ?? "bank://external/000123",
    provenance: {
      source: "merchant-onboarding",
      reference: "onboarding-record-1",
      recordedAt: NOW,
    },
  });
}

export function baseAcceptancePolicy(): PaymentAcceptancePolicy {
  return defineAcceptancePolicy({
    id: "pap-1",
    merchantRef: "merchant-1",
    methods: ["STABLECOIN_CRYPTO", "CARD"],
    methodCatalog: [CRYPTO_METHOD, CARD_METHOD],
    currencies: [USD],
    recurring: { supported: false },
    partialPayments: { supported: false },
    refunds: { supported: true, cutoffMs: 2_592_000_000n },
    recourse: "MERCHANT_DISPUTE_WINDOW",
    customerEligibility: [],
    settlementDestination: settlementDestination(),
    timing: { maxCompletionMs: 600_000n },
    remittance: { requiredDocumentKinds: [] },
    geography: ["US"],
  });
}

// ---------------------------------------------------------------------------
// Merchant onboarding + crypto acceptance activation
// ---------------------------------------------------------------------------

export function onboardedMerchant(
  overrides?: { readonly state?: "DRAFT" | "SUBMITTED" | "VERIFIED" | "ACTIVE" },
): MerchantProfile {
  let profile = draftMerchant({
    id: "merchant-1",
    businessName: "Fixture Coffee Roasters",
    country: "US",
    pricingCurrency: "USD",
    supportContact: "support@fixture-coffee.example",
    now: NOW,
  });
  if (overrides?.state === "DRAFT") {
    return profile;
  }
  profile = submitMerchantApplication(profile, LATER);
  if (overrides?.state === "SUBMITTED") {
    return profile;
  }
  profile = verifyMerchant(profile, { verificationRef: "verify-record-1", now: LATER });
  if (overrides?.state === "VERIFIED") {
    return profile;
  }
  return activateMerchant(profile, {
    settlementDestination: settlementDestination(),
    now: LATER,
  });
}

export function cryptoPolicyInput() {
  return {
    id: "mcap-1",
    merchantRef: "merchant-1",
    basePolicyId: "pap-1",
    assets: [
      defineCryptoAssetAcceptance({
        assetId: USC_CRYPTO_ASSET.id,
        chains: [CHAIN_REF],
        minAmount: defineCryptoAmount(USC_CRYPTO_ASSET, 100n),
        maxAmount: defineCryptoAmount(USC_CRYPTO_ASSET, 100_000_000n),
        requiredConfirmations: 2n,
      }),
    ],
    quoteValidityMs: 30_000n,
  };
}

export function activeAcceptance(
  overrides?: { readonly merchant?: MerchantProfile },
): CryptoAcceptanceActivation {
  return activateCryptoAcceptance({
    id: "activation-1",
    merchant: overrides?.merchant ?? onboardedMerchant(),
    policyInput: cryptoPolicyInput(),
    basePolicy: baseAcceptancePolicy(),
    now: LATER,
  });
}

// ---------------------------------------------------------------------------
// Stripe connected instance + catalogue entry (rule-18 probes)
// ---------------------------------------------------------------------------

export function stripeConnectedInstance(
  overrides?: {
    readonly status?: "ACTIVE" | "PENDING" | "REVOKED" | "EXPIRED" | "UNKNOWN";
    readonly eligible?: boolean;
    readonly currencies?: readonly string[];
  },
): ConnectedCapabilityInstance {
  return {
    instanceId: "inst-stripe-1",
    capabilityId: "cap.merchant-crypto.stripe.native-crypto-settlement",
    implementationId: "impl-stripe-1",
    providerName: "stripe",
    providerVersion: "1.0.0",
    accountRef: "acct_stripe_fixture",
    tenantRef: "tenant-1",
    authorization: { status: overrides?.status ?? "ACTIVE" },
    credentialScope: { credentialRef: "cred-ref-1", credentialKind: "API_KEY" },
    geography: { countries: ["US"] },
    currencies: overrides?.currencies ?? ["USD"],
    permissionState: { granted: ["connectors:stripe:crypto-payments"], requested: [], missing: [] },
    eligibility: {
      eligible: overrides?.eligible ?? true,
      reasons: overrides?.eligible === false ? ["fixture-ineligible"] : [],
    },
    configuration: {},
  };
}

export const STRIPE_CATALOGUE_ENTRY: ProviderCatalogueEntry = {
  catalogueEntryId: "cat-stripe-1",
  providerName: "stripe",
  providerVersion: "1.0.0",
  capabilityId: "cap.merchant-crypto.stripe.native-crypto-settlement",
  summary: "advertisement fixture",
  advertisedScope: {
    platformWide: true,
    advertisedGeographies: ["US"],
    advertisedCurrencies: ["USD"],
  },
};

// ---------------------------------------------------------------------------
// Kernel security fixtures (policy / state / principals / trusted surface)
// ---------------------------------------------------------------------------

export function checkoutSecurityPolicy(
  overrides?: Partial<OnchainSecurityPolicy>,
): OnchainSecurityPolicy {
  return {
    policyId: "checkout-policy-1",
    version: 1,
    allowedChains: [CHAIN_REF],
    allowedAssets: [{ ...USC_KERNEL_ASSET }],
    allowedDestinations: [MERCHANT_DESTINATION],
    allowedSpenders: [],
    forbidUnlimitedApprovals: true,
    unknownContractPolicy: "block",
    unknownRoutePolicy: "escalate",
    maxSecurityStateAgeMs: 60_000,
    ...overrides,
  };
}

export function checkoutSecurityState(
  overrides?: Partial<OnchainSecurityState>,
): OnchainSecurityState {
  return {
    observedAt: NOW_KERNEL,
    networkEpoch: 0n,
    quarantinedComponents: [],
    restrictedComponents: [],
    activeAdvisoryRefs: [],
    ...overrides,
  };
}

export const CHECKOUT_SERVICE_PRINCIPAL: Principal = {
  kind: "agent",
  agentKeyFingerprint: "checkout-service-key-1",
  ownerRef: "user:checkout-operator",
  bodyRef: "body-checkout-1",
  packageVersionRef: "pkg-checkout@1.0.0",
  authorityEnvelope: [],
  securityEpoch: 0n,
};

export const CUSTOMER_APPROVER_REF = "user:customer-1";

/**
 * A deterministic trusted-surface signer double (the same pattern as the
 * kernel's own test helpers): the signature is an opaque function of the
 * payload — NOT cryptography. Real signing belongs to the trusted surface.
 */
export const TEST_SURFACE_SIGNER: TrustedSurfaceSigner = {
  surfaceId: "surface:merchant-checkout-test",
  signApprovalPayload(payload: string): string {
    let hash = 0;
    for (let i = 0; i < payload.length; i += 1) {
      hash = (hash * 31 + payload.charCodeAt(i)) | 0;
    }
    return `sig:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  },
};

export function testApprovalSurface(): TrustedApprovalSurface {
  return new TrustedApprovalSurface(TEST_SURFACE_SIGNER);
}

/** A deterministic signer-adapter double of the kernel port. */
export const TEST_SIGNER_ADAPTER: SignerAdapter = {
  adapterId: "signer:merchant-checkout-test",
  supportedChains: [CHAIN_REF],
  buildSigningPayload(input: {
    readonly artifact: unknown;
    readonly request: { readonly write: { readonly writeId: string } };
  }): string {
    return `payload:${input.request.write.writeId}:${input.artifact instanceof Object ? "artifact" : "none"}`;
  },
};

// ---------------------------------------------------------------------------
// Kernel observation builders
// ---------------------------------------------------------------------------

export function successfulSimulation(
  writeId: string,
  overrides?: { readonly debitMinorUnits?: string },
): SimulationObservation {
  return {
    simulationId: "sim-1",
    writeId,
    status: "SUCCEEDED",
    observedAt: NOW_KERNEL,
    blockRef: "block:fixture-1",
    balanceDeltas: [
      {
        holder: CUSTOMER_WALLET,
        asset: { ...USC_KERNEL_ASSET },
        amount: {
          currency: "USC",
          minorUnits: overrides?.debitMinorUnits ?? QUOTED_USC.value.toString(),
        },
        direction: "debit",
      },
      {
        holder: MERCHANT_DESTINATION,
        asset: { ...USC_KERNEL_ASSET },
        amount: {
          currency: "USC",
          minorUnits: QUOTED_USC.value.toString(),
        },
        direction: "credit",
      },
    ],
    approvals: [],
    gasEstimate: "21000",
    simulator: "simulator:fixture",
  };
}

export function recheckObservationFor(
  write: PreparedWrite,
  securityState: OnchainSecurityState,
  now: TimestampMs,
): RecheckObservation {
  return {
    writeId: write.writeId,
    observedAt: Number(now),
    chain: write.chain,
    writeDigest: write.writeDigest,
    ...(write.transfer !== undefined
      ? {
          transfer: {
            asset: write.transfer.asset,
            amount: write.transfer.amount,
            to: write.transfer.to,
          },
        }
      : {}),
    approvals: write.approvals,
    routeHash: write.route.routeHash,
    ...(write.nonce !== undefined ? { nonce: write.nonce } : {}),
    ...(write.protocol !== undefined ? { protocol: write.protocol } : {}),
    ...(write.settlementInstruction !== undefined
      ? { settlementInstruction: write.settlementInstruction }
      : {}),
    securityState,
  };
}

/** Convenience: the payment method id of the stablecoin method. */
export const STABLECOIN_METHOD_ID = asPaymentMethodId("pm-stablecoin");
