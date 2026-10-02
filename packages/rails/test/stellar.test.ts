import { describe, expect, it } from "vitest";
import { createHash, createPrivateKey, createPublicKey, sign as nodeCryptoSign } from "node:crypto";
import { ValidationError } from "@payswap/protocol";
import {
  ED25519_PKCS8_PREFIX_HEX,
  STELLAR_BASE_FEE_STROOPS,
  STELLAR_CREDENTIAL_CONFIG_KEY,
  STELLAR_DEFAULT_HORIZON_BASE,
  STELLAR_PUBNET_NETWORK_PASSPHRASE,
  STELLAR_RAIL_ADAPTER_ID,
  STELLAR_STROOPS_PER_UNIT,
  STELLAR_TESTNET_NETWORK_PASSPHRASE,
  StellarConnector,
  StellarLocalRail,
  amountStringFromStroops,
  base64Decode,
  base64Encode,
  buildSignedStellarEnvelope,
  classifyStellarResultCode,
  crc16xmodem,
  decodeStellarPublicKey,
  decodeStellarSecretSeed,
  encodeStellarPublicKey,
  encodeStellarSecretSeed,
  encodeTransactionBody,
  isValidStellarStrKey,
  parseStellarAsset,
  stellarIdempotencyMemoHash,
  stellarPublicKeyFromSeed,
  stellarResultCodeTable,
  stellarTransactionHash,
  stroopsFromAmountString,
  signStellarTransactionHash,
} from "../src/stellar.js";
import type { StellarTransactionInput } from "../src/stellar.js";
import { CLOCK, ctx, makeAdapterAuthority } from "./fixtures.js";
import { ScriptedHttpTransport } from "./fixtures.js";

const AUTHORITY = makeAdapterAuthority();
const T0 = "2026-10-02T12:00:00Z";

// A SYNTHETIC seed (deterministic test fixture — never a real account):
const SYNTHETIC_SEED_BYTES = Uint8Array.from(
  createHash("sha256").update("payswap-synthetic-stellar-test-seed-0001").digest(),
);
const SYNTHETIC_SEED_STRKEY = encodeStellarSecretSeed(SYNTHETIC_SEED_BYTES);
const SYNTHETIC_PUBLIC_BYTES = stellarPublicKeyFromSeed(SYNTHETIC_SEED_BYTES);
const SYNTHETIC_PUBLIC_STRKEY = encodeStellarPublicKey(SYNTHETIC_PUBLIC_BYTES);
// A checksum-valid synthetic asset issuer (never a real account):
const SYNTHETIC_ISSUER = encodeStellarPublicKey(
  Uint8Array.from(createHash("sha256").update("payswap-synthetic-stellar-issuer-0001").digest()),
);

function jsonResponse(status: number, body: unknown): { status: number; bodyText: string } {
  return { status, bodyText: JSON.stringify(body) };
}

function accountResponse(): Record<string, unknown> {
  return {
    id: SYNTHETIC_PUBLIC_STRKEY,
    sequence: "8589934592",
    balances: [
      { asset_type: "native", balance: "9999.9999300" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", balance: "5.0000000", limit: "100.0000000" },
    ],
    thresholds: { low_threshold: 0, med_threshold: 10, high_threshold: 100 },
  };
}

describe("stellar rail vocabulary (P2-W1-003)", () => {
  it("pins the provider identity, network passphrases and the credential config key", () => {
    expect(STELLAR_DEFAULT_HORIZON_BASE).toBe("https://horizon-testnet.stellar.org");
    expect(STELLAR_TESTNET_NETWORK_PASSPHRASE).toBe("Test SDF Network ; September 2015");
    expect(STELLAR_PUBNET_NETWORK_PASSPHRASE).toBe("Public Global Stellar Network ; September 2014");
    expect(STELLAR_CREDENTIAL_CONFIG_KEY).toBe("PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF");
    expect(STELLAR_STROOPS_PER_UNIT).toBe(10_000_000n);
    expect(STELLAR_BASE_FEE_STROOPS).toBe(100n);
  });

  it("the rail adapter registers on the BaseRailAdapter framework", () => {
    const rail = new StellarLocalRail();
    expect(rail.adapterId).toBe(STELLAR_RAIL_ADAPTER_ID);
    expect(rail.implementationId).toBe("impl.rails.stellar.horizon");
  });
});

describe("StrKey codec (base32 + CRC16-XModem, the corrected wire spec)", () => {
  it("round-trips an ed25519 public key (G-prefixed, version 6 → wire 0x30)", () => {
    const round = decodeStellarPublicKey(SYNTHETIC_PUBLIC_STRKEY);
    expect(Array.from(round)).toEqual(Array.from(SYNTHETIC_PUBLIC_BYTES));
    expect(encodeStellarPublicKey(round)).toBe(SYNTHETIC_PUBLIC_STRKEY);
    expect(SYNTHETIC_PUBLIC_STRKEY).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("round-trips a secret seed (S-prefixed, version 18 → wire 0x90)", () => {
    expect(Array.from(decodeStellarSecretSeed(SYNTHETIC_SEED_STRKEY))).toEqual(Array.from(SYNTHETIC_SEED_BYTES));
    expect(encodeStellarSecretSeed(SYNTHETIC_SEED_BYTES)).toBe(SYNTHETIC_SEED_STRKEY);
    expect(SYNTHETIC_SEED_STRKEY).toMatch(/^S[A-Z2-7]{55}$/);
  });

  it("rejects checksum corruption (a single flipped character)", () => {
    const corrupted = `${SYNTHETIC_PUBLIC_STRKEY.slice(0, -2)}${SYNTHETIC_PUBLIC_STRKEY.endsWith("AA") ? "AB" : "AA"}`;
    expect(isValidStellarStrKey(corrupted, 6)).toBe(false);
    expect(() => decodeStellarPublicKey(corrupted)).toThrow(ValidationError);
  });

  it("rejects the wrong version byte (a seed where a public key is required, and vice versa)", () => {
    expect(() => decodeStellarPublicKey(SYNTHETIC_SEED_STRKEY)).toThrow(ValidationError);
    expect(() => decodeStellarSecretSeed(SYNTHETIC_PUBLIC_STRKEY)).toThrow(ValidationError);
  });

  it("rejects malformed base32 and wrong lengths", () => {
    expect(() => decodeStellarPublicKey("not-a-strkey!")).toThrow(ValidationError);
    expect(() => decodeStellarPublicKey("GABC")).toThrow(ValidationError);
    expect(isValidStellarStrKey("", 6)).toBe(false);
  });

  it("crc16xmodem matches the reference vector (123456789 → 0x31C3)", () => {
    const bytes = Uint8Array.from("123456789".split("").map((c) => c.charCodeAt(0)));
    expect(crc16xmodem(bytes)).toBe(0x31c3);
  });
});

describe("stroop conversion (exact, bigint)", () => {
  it("converts exact decimal strings to stroops and back", () => {
    expect(stroopsFromAmountString("1")).toBe(10_000_000n);
    expect(stroopsFromAmountString("0.0001")).toBe(1000n);
    expect(stroopsFromAmountString("9999.99993")).toBe(99_999_999_300n);
    expect(amountStringFromStroops(1000n)).toBe("0.0001");
    expect(amountStringFromStroops(10_000_000n)).toBe("1");
    expect(amountStringFromStroops(0n)).toBe("0");
    expect(amountStringFromStroops(123n)).toBe("0.0000123");
  });

  it("refuses more than 7 fractional digits, negatives, and non-numeric strings (honest refusal)", () => {
    expect(() => stroopsFromAmountString("0.00000001")).toThrow(ValidationError);
    expect(() => stroopsFromAmountString("-1")).toThrow(ValidationError);
    expect(() => stroopsFromAmountString("1e7")).toThrow(ValidationError);
    expect(() => stroopsFromAmountString("10.5.3")).toThrow(ValidationError);
  });

  it("refuses amounts beyond the int64 stroop range", () => {
    expect(() => stroopsFromAmountString("922337203685.4775808")).toThrow(ValidationError);
  });
});

describe("asset + memo + idempotency derivation", () => {
  it("parses native and credit assets (CODE:ISSUER, alphanum4/12 validation)", () => {
    expect(parseStellarAsset("native")).toEqual({ kind: "native" });
    const asset = parseStellarAsset(`USDC:${SYNTHETIC_ISSUER}`);
    expect(asset).toEqual({
      kind: "alphanum4",
      code: "USDC",
      issuer: SYNTHETIC_ISSUER,
    });
    expect(() => parseStellarAsset(`ALPHANUM123X:${SYNTHETIC_ISSUER}`)).not.toThrow();
    expect(() => parseStellarAsset("native:GABC")).toThrow(ValidationError);
    expect(() => parseStellarAsset("USD")).toThrow(ValidationError);
  });

  it("the idempotency memo hash is deterministic from the protocol key (INV-F05)", () => {
    const a = stellarIdempotencyMemoHash("order-123");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(stellarIdempotencyMemoHash("order-123")).toBe(a);
    expect(stellarIdempotencyMemoHash("order-124")).not.toBe(a);
  });
});

describe("transaction XDR + ed25519 signing (byte-deterministic, zero deps)", () => {
  const transaction: StellarTransactionInput = {
    sourceAccount: SYNTHETIC_PUBLIC_STRKEY,
    feeStroops: 100n,
    seqNum: 8589934593n,
    memo: { kind: "none" },
    operations: [
      {
        kind: "payment",
        destination: SYNTHETIC_PUBLIC_STRKEY,
        asset: { kind: "native" },
        amountStroops: 1000n,
      },
    ],
  };

  it("the transaction body encoding is byte-deterministic", () => {
    const a = encodeTransactionBody(transaction);
    const b = encodeTransactionBody(transaction);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it("the transaction hash binds the network passphrase (testnet ≠ pubnet)", () => {
    const body = encodeTransactionBody(transaction);
    const testnetHash = stellarTransactionHash(body, STELLAR_TESTNET_NETWORK_PASSPHRASE);
    const pubnetHash = stellarTransactionHash(body, STELLAR_PUBNET_NETWORK_PASSPHRASE);
    expect(testnetHash).toHaveLength(32);
    expect(Buffer.from(testnetHash).toString("hex")).toMatch(/^[0-9a-f]{64}$/);
    expect(pubnetHash).not.toEqual(testnetHash);
  });

  it("the ed25519 public key derivation matches an independent node:crypto computation", () => {
    // Independent path: build the same pkcs8 key and export the SPKI tail.
    const der = Buffer.from(ED25519_PKCS8_PREFIX_HEX + Buffer.from(SYNTHETIC_SEED_BYTES).toString("hex"), "hex");
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
    expect(Array.from(spki.subarray(12))).toEqual(Array.from(stellarPublicKeyFromSeed(SYNTHETIC_SEED_BYTES)));
  });

  it("the signature verifies against an independent node:crypto ed25519 verification", () => {
    const body = encodeTransactionBody(transaction);
    const txHash = stellarTransactionHash(body, STELLAR_TESTNET_NETWORK_PASSPHRASE);
    const decorated = signStellarTransactionHash(txHash, SYNTHETIC_SEED_BYTES);
    expect(decorated.signature).toHaveLength(64);
    expect(Array.from(decorated.hint)).toEqual(Array.from(SYNTHETIC_PUBLIC_BYTES.slice(28)));
    // Independent verify path:
    const der = Buffer.from(ED25519_PKCS8_PREFIX_HEX + Buffer.from(SYNTHETIC_SEED_BYTES).toString("hex"), "hex");
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const expectedSignature = nodeCryptoSign(null, Buffer.from(txHash), key);
    expect(Array.from(Uint8Array.from(expectedSignature))).toEqual(Array.from(decorated.signature));
  });

  it("a seed of the wrong length is refused", () => {
    expect(() => stellarPublicKeyFromSeed(Uint8Array.from([1, 2, 3]))).toThrow(ValidationError);
  });

  it("the signed envelope carries NO seed material (secret hygiene by construction)", () => {
    const envelope = buildSignedStellarEnvelope({
      transaction,
      secretSeed: SYNTHETIC_SEED_STRKEY,
      networkPassphrase: STELLAR_TESTNET_NETWORK_PASSPHRASE,
    });
    const serialized = JSON.stringify(envelope, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(serialized).not.toContain(SYNTHETIC_SEED_STRKEY);
    expect(envelope.txHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.envelopeBase64.length).toBeGreaterThan(0);
    // Deterministic: same inputs → the same envelope bytes.
    const again = buildSignedStellarEnvelope({
      transaction,
      secretSeed: SYNTHETIC_SEED_STRKEY,
      networkPassphrase: STELLAR_TESTNET_NETWORK_PASSPHRASE,
    });
    expect(again.envelopeBase64).toBe(envelope.envelopeBase64);
  });

  it("base64 codec round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(base64Decode(base64Encode(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("stellar result-code classification (lossless table)", () => {
  it("classifies every code in the recorded table with the exact stage", () => {
    const table = stellarResultCodeTable();
    expect(table["op_success"]?.stage).toBe("TERMINAL");
    expect(table["tx_bad_seq"]?.stage).toBe("PROCESSING");
    expect(table["tx_bad_seq"]?.retryable).toBe(true);
    expect(table["tx_insufficient_balance"]?.stage).toBe("TERMINAL");
    expect(table["op_underfunded"]?.stage).toBe("TERMINAL");
    expect(table["op_no_trust"]?.stage).toBe("TERMINAL");
    expect(table["op_line_full"]?.stage).toBe("TERMINAL");
    for (const code of Object.keys(table)) {
      const classification = classifyStellarResultCode(code);
      expect(classification.stage).toBe(table[code]?.stage);
    }
  });

  it("an unknown code classifies UNKNOWN — never guessed", () => {
    expect(classifyStellarResultCode("some_future_code").stage).toBe("UNKNOWN");
  });
});

describe("stellar connector — the read surface (PUBLIC, no credential)", () => {
  it("observes an account's PUBLIC data with explicit account id: balances are observations ONLY (INV-C09)", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, accountResponse()));
    const connector = new StellarConnector({ clock: CLOCK, http: transport.transport });
    const observation = await connector.observeAccount(SYNTHETIC_PUBLIC_STRKEY);
    expect(transport.calls[0]?.url).toBe(`${STELLAR_DEFAULT_HORIZON_BASE}/accounts/${SYNTHETIC_PUBLIC_STRKEY}`);
    expect(observation.sequence).toBe("8589934592");
    expect(observation.balances).toHaveLength(2);
    expect(observation.balances[0]).toMatchObject({ assetType: "native", balance: "9999.9999300" });
    expect(observation.balances[1]).toMatchObject({ assetCode: "USDC", balance: "5.0000000" });
    expect(observation.raw).toBeDefined(); // lossless (INV-C06)
  });

  it("observes payments losslessly (verbatim fields + raw record)", async () => {
    const transport = new ScriptedHttpTransport(() =>
      jsonResponse(200, {
        _embedded: {
          records: [
            {
              id: "1234567890",
              paging_token: "1234567890",
              type: "payment",
              asset_type: "native",
              amount: "0.0001000",
              from: SYNTHETIC_PUBLIC_STRKEY,
              to: SYNTHETIC_PUBLIC_STRKEY,
              transaction_hash: "a".repeat(64),
              created_at: T0,
              transaction_successful: true,
            },
          ],
        },
      }),
    );
    const connector = new StellarConnector({ clock: CLOCK, http: transport.transport });
    const payments = await connector.observePayments(SYNTHETIC_PUBLIC_STRKEY, 5);
    expect(transport.calls[0]?.url).toContain(`/accounts/${SYNTHETIC_PUBLIC_STRKEY}/payments`);
    expect(transport.calls[0]?.url).toContain("limit=5");
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount: "0.0001000", transactionSuccessful: true });
  });

  it("observes a transaction (fee, memo, ledger — lossless)", async () => {
    const txHash = "b".repeat(64);
    const transport = new ScriptedHttpTransport(() =>
      jsonResponse(200, {
        id: txHash,
        created_at: T0,
        fee_charged: "100",
        max_fee: "100",
        memo_type: "hash",
        successful: true,
        ledger: 4983691,
      }),
    );
    const connector = new StellarConnector({ clock: CLOCK, http: transport.transport });
    const observation = await connector.observeTransaction(txHash);
    expect(transport.calls[0]?.url).toBe(`${STELLAR_DEFAULT_HORIZON_BASE}/transactions/${txHash}`);
    expect(observation).toMatchObject({ txHash, feeCharged: "100", successful: true, ledger: 4983691 });
  });

  it("a malformed account id is refused before any network call", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, {}));
    const connector = new StellarConnector({ clock: CLOCK, http: transport.transport });
    await expect(connector.observeAccount("not-an-account")).rejects.toThrow(ValidationError);
    expect(transport.calls).toHaveLength(0);
  });

  it("SDK request routing: observe_account / observe_payments / observe_transaction through read()", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, accountResponse()));
    const connector = new StellarConnector({ clock: CLOCK, http: transport.transport });
    const result = await connector.read(
      ctx(AUTHORITY, { kind: "observe_account", accountId: SYNTHETIC_PUBLIC_STRKEY }, "idem-1"),
    );
    expect(result.providerState.object.objectType).toBe("account_balance");
  });
});

describe("stellar connector — the write surface (fail-closed + real paths)", () => {
  it("NO credential: submission refuses BEFORE any network call (INV-NC04)", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, {}));
    const connector = new StellarConnector({ clock: CLOCK, http: transport.transport });
    await expect(
      connector.submitPayment({ destination: SYNTHETIC_PUBLIC_STRKEY, amount: "0.0001" }),
    ).rejects.toThrow(/not authorized/);
    expect(transport.calls).toHaveLength(0);
  });

  it("the credential resolution state reports NOT_PROVISIONED honestly", () => {
    const connector = new StellarConnector({ clock: CLOCK, env: {} });
    expect(connector.credentialResolutionState()).toMatchObject({
      kind: "NOT_PROVISIONED",
      configKey: STELLAR_CREDENTIAL_CONFIG_KEY,
    });
  });

  it("an env seed resolves ENV_RESOLVED_MATERIAL with the DERIVED public account id", () => {
    const connector = new StellarConnector({
      clock: CLOCK,
      env: { PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF: SYNTHETIC_SEED_STRKEY },
    });
    expect(connector.credentialResolutionState()).toMatchObject({ kind: "ENV_RESOLVED_MATERIAL" });
  });

  it("submission: sequence fetch → signed envelope POST → 200 maps to async_processing (NOT success)", async () => {
    // The deterministic envelope for these exact inputs (sequence 8589934592+1,
    // fee 100, hash memo from the protocol key) — the responder echoes its
    // REAL hash so the accepted path is exercised (a different hash is the
    // honest hash_mismatch ambiguity path, covered by the table tests).
    const expectedEnvelope = buildSignedStellarEnvelope({
      transaction: {
        sourceAccount: SYNTHETIC_PUBLIC_STRKEY,
        feeStroops: 100n,
        seqNum: 8589934593n,
        memo: { kind: "hash", hashHex: stellarIdempotencyMemoHash("order-77") },
        operations: [
          {
            kind: "payment",
            destination: SYNTHETIC_PUBLIC_STRKEY,
            asset: { kind: "native" },
            amountStroops: 1000n,
          },
        ],
      },
      secretSeed: SYNTHETIC_SEED_STRKEY,
      networkPassphrase: STELLAR_TESTNET_NETWORK_PASSPHRASE,
    });
    const transport = new ScriptedHttpTransport((url, init) => {
      if (url.endsWith(`/accounts/${SYNTHETIC_PUBLIC_STRKEY}`)) {
        return jsonResponse(200, accountResponse());
      }
      if (url.endsWith("/transactions")) {
        expect(init.method).toBe("POST");
        expect(init.body).toMatch(/^tx=[A-Za-z0-9%+/=]+$/);
        return jsonResponse(200, { hash: expectedEnvelope.txHashHex, ledger: 4983692 });
      }
      return jsonResponse(404, {});
    });
    const connector = new StellarConnector({
      clock: CLOCK,
      http: transport.transport,
      env: { PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF: SYNTHETIC_SEED_STRKEY },
    });
    const result = await connector.submitPayment({
      destination: SYNTHETIC_PUBLIC_STRKEY,
      amount: "0.0001",
      protocolIdempotencyKey: "order-77",
    });
    expect(transport.calls).toHaveLength(2); // account fetch + submission
    const providerState = result.providerState;
    expect(providerState.classification.family).toBe("async_processing");
    expect(providerState.classification.isTerminal).toBe(false);
    // Secret hygiene: the seed appears NOWHERE in the result.
    const serialized = JSON.stringify(result, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(serialized).not.toContain(SYNTHETIC_SEED_STRKEY);
  });

  it("submission: a Horizon rejection maps to the honest terminal/unknown classification", async () => {
    const transport = new ScriptedHttpTransport((url) => {
      if (url.endsWith(`/accounts/${SYNTHETIC_PUBLIC_STRKEY}`)) {
        return jsonResponse(200, accountResponse());
      }
      return jsonResponse(400, {
        type: "https://stellar.org/horizon-errors/transaction_failed",
        title: "Transaction Failed",
        status: 400,
        extras: { envelope_xdr: "AAAAAA==", result_codes: { transaction: "tx_insufficient_balance" } },
      });
    });
    const connector = new StellarConnector({
      clock: CLOCK,
      http: transport.transport,
      env: { PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF: SYNTHETIC_SEED_STRKEY },
    });
    const result = await connector.submitPayment({
      destination: SYNTHETIC_PUBLIC_STRKEY,
      amount: "0.0001",
    });
    expect(result.providerState.classification.isTerminal).toBe(true);
    const state = result.providerState.state as {
      providerResponse?: { extras?: { result_codes?: { transaction?: string } } };
    };
    expect(state.providerResponse?.extras?.result_codes?.transaction).toBe("tx_insufficient_balance"); // verbatim (INV-C06)
  });

  it("a mid-submission transport failure is OUTCOME_UNKNOWN — never FAILED (INV-X01)", async () => {
    const transport = new ScriptedHttpTransport((url) => {
      if (url.endsWith(`/accounts/${SYNTHETIC_PUBLIC_STRKEY}`)) {
        return jsonResponse(200, accountResponse());
      }
      throw new Error("connection reset mid-POST");
    });
    const connector = new StellarConnector({
      clock: CLOCK,
      http: transport.transport,
      env: { PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF: SYNTHETIC_SEED_STRKEY },
    });
    const result = await connector.submitPayment({
      destination: SYNTHETIC_PUBLIC_STRKEY,
      amount: "0.0001",
    });
    expect(result.providerState.classification.lifecycleStep).toBe("submitted");
    expect(result.providerState.classification.isTerminal).toBe(false);
    expect(result.providerState.failure?.ambiguity).toBe("OUTCOME_UNKNOWN");
  });

  it("a bundle whose seed does NOT derive the declared account is refused pre-network (fail-closed)", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, {}));
    const otherSeedBytes = Uint8Array.from(
      createHash("sha256").update("payswap-synthetic-stellar-test-seed-0002").digest(),
    );
    const connector = new StellarConnector({
      clock: CLOCK,
      http: transport.transport,
      env: {
        PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF: JSON.stringify({
          secretSeed: encodeStellarSecretSeed(otherSeedBytes),
          accountPublic: SYNTHETIC_PUBLIC_STRKEY, // INCONSISTENT with the seed
          networkPassphrase: STELLAR_TESTNET_NETWORK_PASSPHRASE,
        }),
      },
    });
    await expect(
      connector.submitPayment({ destination: SYNTHETIC_PUBLIC_STRKEY, amount: "0.0001" }),
    ).rejects.toThrow(/does not derive/);
    expect(transport.calls).toHaveLength(0);
  });

  it("a wrong-network passphrase is refused pre-network (no cross-network signing)", async () => {
    const transport = new ScriptedHttpTransport(() => jsonResponse(200, {}));
    const connector = new StellarConnector({
      clock: CLOCK,
      http: transport.transport,
      env: {
        PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF: JSON.stringify({
          secretSeed: SYNTHETIC_SEED_STRKEY,
          accountPublic: SYNTHETIC_PUBLIC_STRKEY,
          networkPassphrase: STELLAR_PUBNET_NETWORK_PASSPHRASE, // the connector is TESTNET
        }),
      },
    });
    await expect(
      connector.submitPayment({ destination: SYNTHETIC_PUBLIC_STRKEY, amount: "0.0001" }),
    ).rejects.toThrow(/wrong network|does not match/);
    expect(transport.calls).toHaveLength(0);
  });

  it("submit_change_trust builds the trustline operation (the corridor's USDC leg)", async () => {
    const trustEnvelope = buildSignedStellarEnvelope({
      transaction: {
        sourceAccount: SYNTHETIC_PUBLIC_STRKEY,
        feeStroops: 100n,
        seqNum: 8589934593n,
        memo: { kind: "none" },
        operations: [
          {
            kind: "change_trust",
            asset: parseStellarAsset("USDC:" + SYNTHETIC_ISSUER),
            limitStroops: 2n ** 63n - 1n,
          },
        ],
      },
      secretSeed: SYNTHETIC_SEED_STRKEY,
      networkPassphrase: STELLAR_TESTNET_NETWORK_PASSPHRASE,
    });
    const transport = new ScriptedHttpTransport((url) => {
      if (url.endsWith(`/accounts/${SYNTHETIC_PUBLIC_STRKEY}`)) {
        return jsonResponse(200, accountResponse());
      }
      return jsonResponse(200, { hash: trustEnvelope.txHashHex });
    });
    const connector = new StellarConnector({
      clock: CLOCK,
      http: transport.transport,
      env: { PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF: SYNTHETIC_SEED_STRKEY },
    });
    const result = await connector.submitChangeTrust({
      asset: `USDC:${SYNTHETIC_ISSUER}`,
    });
    expect(result.providerState.classification.family).toBe("async_processing");
    expect(() => connector.submitChangeTrust({ asset: "native" })).rejects.toThrow(ValidationError);
  });
});
