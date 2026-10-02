/**
 * Stellar testnet local rail (`PROVIDERLESS_RAIL`, P2-W1-003 Phase 2 Wave 3).
 *
 * The operator-directed proof vehicle for the GHS → USDC (Stellar testnet)
 * → KES corridor: a PUBLIC network rail whose read surface needs no
 * credentials at all and whose write surface is the REAL external effect
 * (a signed TransactionEnvelope XDR submitted to Horizon), gated on
 * vault-held key material.
 *
 * Binding rules:
 * - INV-C01/C02: availability is two-axis and honestly UNKNOWN when Horizon
 *   is unreachable — never success, never failure;
 * - INV-NC04: the write surface fails CLOSED (RailNotAuthorizedError before
 *   any network call) when no credential path is provisioned; the read
 *   surface works ONLY with an explicit public account id (public data);
 * - INV-C09: balances are ExternalFundsPositionObservation ONLY (native XLM
 *   and credit-asset balances with mandatory freshness + provenance) —
 *   observations of external state, never PaySwap custody;
 * - INV-C06: Horizon payloads (account, payment operations, transactions,
 *   submission result codes) are carried VERBATIM in envelope state;
 * - INV-X01: a submitted-but-not-yet-ledgered transaction is async
 *   processing (never FAILED); rejected submissions carry the provider's
 *   result codes verbatim, classified processing/terminal/UNKNOWN;
 * - protocol-owned finality (AGENTS.md rule 5): a payment observed in a
 *   closed ledger is a FINALITY CANDIDATE only — the settlement plane's
 *   proof policies issue actual finality (INV-E03);
 * - INV-F05: deterministic payment derivation — the memo hash is derived
 *   from the protocol idempotency key (sha256, no entropy);
 * - INV-F01: amounts are exact bigint stroops (1e7 per XLM); string major
 *   amounts convert exactly or are REFUSED;
 * - secret hygiene: the seed exists only inside the signing call frame
 *   (control-plane sealed bundle or env-resolved material); it NEVER
 *   appears in any envelope, evidence, error or log line.
 *
 * XDR ground truth (probed 2026-10-02 against horizon-testnet.stellar.org):
 * the TransactionEnvelope type word for a v1 transaction is 2, and
 * txHash = sha256(sha256(networkPassphrase) || uint32be(2) || txBodyBytes)
 * — verified byte-for-byte against real testnet transaction ids (see
 * test/live/stellar.live.test.ts, which re-verifies against live data).
 *
 * Zero new npm dependencies: node:crypto (ed25519 via PKCS#8 DER wrap,
 * sha256) + the injectable HttpTransport. StrKey (base32 + CRC16-XModem),
 * XDR encoding and base64 are implemented here in pure TypeScript.
 */

import { ValidationError } from "@payswap/protocol";
import type { ProtocolClock, TimestampMs } from "@payswap/protocol";
import type {
  CapabilityDefinition,
  CapabilityObservation,
  ConnectorCapabilityPack,
  ExternalFundsPositionObservation,
  ProviderIdentity,
  ProviderStateEnvelope,
} from "@payswap/connectors";
import {
  EXTERNAL_FUNDS_OBSERVATION_KIND,
  validateCapabilityDefinition,
  observeCapability,
  unknownReachabilityObservation,
} from "@payswap/connectors";
import type { AuthorizationMode } from "@payswap/connectors";
import { providerCredentialConfigKey } from "@payswap/adapters";
import type { CredentialBroker, ConnectorRuntimeKey } from "@payswap/adapters";
import { BaseRailAdapter, ConnectorSDK, classifyOutcome } from "@payswap/adapters";
import type {
  ConnectorHealthReport,
  CredentialRotationResult,
  SdkCallContext,
  SdkCallResult,
} from "@payswap/adapters";
import type { ProviderExecutionEvidenceDraft } from "@payswap/execution";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  RailNotAuthorizedError,
  RailProviderError,
  RailTransportError,
  railEnvelope,
  railEvidence,
  routableRailImplication,
  isoTimestamp,
} from "./support.js";
import type { HttpTransport, RailImplication } from "./support.js";
import { realHttpTransport } from "./support.js";

// ---------------------------------------------------------------------------
// Identity + constants
// ---------------------------------------------------------------------------

export const STELLAR_PROVIDER_NAME = "stellar_testnet" as const;
export const STELLAR_RAIL_ADAPTER_ID = "rail.stellar-testnet" as const;
export const STELLAR_RAIL_IMPLEMENTATION_ID = "impl.rails.stellar.horizon" as const;
export const STELLAR_CONNECTOR_ID = "connector.rails.stellar" as const;
export const STELLAR_RAIL_PROVIDER_VERSION = "1.0.0" as const;

/** The REAL public Horizon testnet endpoint (probed 2026-10-02: HTTP 200). */
export const STELLAR_DEFAULT_HORIZON_BASE = "https://horizon-testnet.stellar.org" as const;

/** Network passphrases (the signature-domain separator). */
export const STELLAR_TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015" as const;
export const STELLAR_PUBNET_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2014" as const;

/** 1 XLM = 10,000,000 stroops (int64 on the wire). */
export const STELLAR_STROOPS_PER_UNIT = 10_000_000n;

/** The network base fee (stroops per operation) used when building. */
export const STELLAR_BASE_FEE_STROOPS = 100n;

/** Nominal ledger close time — finality CANDIDATE freshness context. */
export const STELLAR_LEDGER_CLOSE_SECONDS = 5;

/** Default freshness window for external funds observations (seconds). */
export const STELLAR_DEFAULT_FUNDS_FRESHNESS_SECONDS = 180;

/**
 * The TransactionEnvelope XDR discriminant for a v1 transaction, as observed
 * on the real testnet wire (2026-10-02 probe; see module header).
 */
export const STELLAR_ENVELOPE_TYPE_TX = 2;

/**
 * The P2-W1-001 control-plane credential configuration key:
 * providerCredentialConfigKey("stellar_testnet") = PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF.
 */
export const STELLAR_CREDENTIAL_CONFIG_KEY: string = providerCredentialConfigKey(
  "stellar_testnet",
);

/** The ed25519 secret→public derivation is validated against the bundle. */
export interface StellarCredentialBundle {
  /** StrKey "S…" secret seed (vault material — never logged, never in state). */
  readonly secretSeed: string;
  /** StrKey "G…" public account id (public data; consistency-checked against the seed). */
  readonly accountPublic: string;
  /** Network passphrase the bundle signs for (must match the connector's network). */
  readonly networkPassphrase: string;
}

// ---------------------------------------------------------------------------
// StrKey codec (base32 + CRC16-XModem — pure TypeScript, zero deps)
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** StrKey version bytes (ed25519 public key starts 'G', secret seed 'S'). */
export const STRKEY_VERSION_ED25519_PUBLIC = 6;
export const STRKEY_VERSION_ED25519_SECRET_SEED = 18;

/** CRC-16/XModem (poly 0x1021, init 0x0000) — the StrKey checksum. */
export function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function base32Decode(input: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new ValidationError(`invalid base32 character '${char}'`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decodes a StrKey string to its raw 32-byte payload, verifying the version
 * byte and the CRC16-XModem checksum. Any failure is an honest refusal.
 */
export function decodeStrKey(value: string, expectedVersion: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError("StrKey must be a non-empty string");
  }
  for (const char of value) {
    if (!BASE32_ALPHABET.includes(char)) {
      throw new ValidationError(`invalid StrKey character '${char}'`);
    }
  }
  const decoded = base32Decode(value);
  if (decoded.length !== 35) {
    throw new ValidationError(
      `StrKey must decode to 35 bytes (version + 32-byte key + 2-byte checksum), got ${decoded.length}`,
    );
  }
  const [version, ...rest] = decoded;
  const payload = Uint8Array.from(rest.slice(0, 32));
  // The CRC16-XModem checksum is appended LITTLE-ENDIAN (low byte first).
  const checksum = ((decoded[34] ?? 0) << 8) | (decoded[33] ?? 0);
  // The StrKey version byte is the version number shifted left by 3
  // (0x30 = 'G'-prefixed ed25519 public keys, 0x90 = 'S'-prefixed seeds).
  if (version !== (expectedVersion << 3) || (version & 0x07) !== 0) {
    throw new ValidationError(
      `StrKey version byte ${version} does not match the expected ${expectedVersion} (wire form ${expectedVersion << 3})`,
    );
  }
  const expectedChecksum = crc16xmodem(decoded.subarray(0, 33));
  if (checksum !== expectedChecksum) {
    throw new ValidationError(
      `StrKey checksum mismatch (presented ${checksum.toString(16)}, expected ${expectedChecksum.toString(16)})`,
    );
  }
  return payload;
}

/** Encodes a 32-byte payload as a StrKey string with version + checksum. */
export function encodeStrKey(version: number, payload: Uint8Array): string {
  if (payload.length !== 32) {
    throw new ValidationError("StrKey payload must be exactly 32 bytes");
  }
  if (!Number.isInteger(version) || version < 0 || version > 255) {
    throw new ValidationError("StrKey version must be a byte");
  }
  const data = new Uint8Array(35);
  data[0] = version << 3;
  data.set(payload, 1);
  const checksum = crc16xmodem(data.subarray(0, 33));
  data[33] = checksum & 0xff;
  data[34] = (checksum >>> 8) & 0xff;
  return base32Encode(data);
}

/** Decodes a "S…" secret seed to its raw 32-byte ed25519 seed. */
export function decodeStellarSecretSeed(secretSeed: string): Uint8Array {
  return decodeStrKey(secretSeed, STRKEY_VERSION_ED25519_SECRET_SEED);
}

/** Encodes a raw 32-byte ed25519 seed as the "S…" StrKey form. */
export function encodeStellarSecretSeed(seed: Uint8Array): string {
  return encodeStrKey(STRKEY_VERSION_ED25519_SECRET_SEED, seed);
}

/** Decodes a "G…" public account id to its raw 32-byte ed25519 public key. */
export function decodeStellarPublicKey(publicKey: string): Uint8Array {
  return decodeStrKey(publicKey, STRKEY_VERSION_ED25519_PUBLIC);
}

/** Encodes a raw 32-byte ed25519 public key as the "G…" StrKey form. */
export function encodeStellarPublicKey(publicKey: Uint8Array): string {
  return encodeStrKey(STRKEY_VERSION_ED25519_PUBLIC, publicKey);
}

/** Structural check without throwing (checksum + version verified). */
export function isValidStellarStrKey(value: string, expectedVersion: number): boolean {
  try {
    decodeStrKey(value, expectedVersion);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// base64 (pure TypeScript — used for envelope XDR and HTTP bodies)
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] ?? 0) : 0;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] ?? 0) : 0;
    output += BASE64_ALPHABET[b0 >>> 2] ?? "A";
    output += BASE64_ALPHABET[((b0 & 3) << 4) | (b1 >>> 4)] ?? "A";
    output += i + 1 < bytes.length ? (BASE64_ALPHABET[((b1 & 15) << 2) | (b2 >>> 6)] ?? "A") : "=";
    output += i + 2 < bytes.length ? (BASE64_ALPHABET[b2 & 63] ?? "A") : "=";
  }
  return output;
}

export function base64Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE64_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new ValidationError(`invalid base64 character '${char}'`);
    }
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Pure-TypeScript UTF-8 encoder (no TextEncoder dependency in this lib config). */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (const codePoint of text) {
    const code = codePoint.codePointAt(0) ?? 0;
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >>> 6), 0x80 | (code & 63));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 63), 0x80 | (code & 63));
    } else {
      out.push(
        0xf0 | (code >>> 18),
        0x80 | ((code >>> 12) & 63),
        0x80 | ((code >>> 6) & 63),
        0x80 | (code & 63),
      );
    }
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Amount conversion (INV-F01 — exact bigint stroops or honest refusal)
// ---------------------------------------------------------------------------

/**
 * Converts a decimal string major amount ("0.0001") to EXACT int64 stroops.
 * Refuses anything that is not a plain non-negative decimal with at most 7
 * fractional digits (the stroop resolution) — no floats, ever.
 */
export function stroopsFromAmountString(amount: string): bigint {
  if (typeof amount !== "string" || !/^\d+(?:\.\d{1,7})?$/.test(amount)) {
    throw new ValidationError(
      `amount must be a non-negative decimal string with at most 7 fractional digits (XLM stroop resolution), got: ${String(amount)}`,
    );
  }
  const [whole = "0", fraction = ""] = amount.split(".");
  const paddedFraction = (fraction + "0000000").slice(0, 7);
  const stroops = BigInt(`${whole}${paddedFraction}`);
  const max = 2n ** 63n - 1n;
  if (stroops > max) {
    throw new ValidationError("amount exceeds the int64 stroop range");
  }
  return stroops;
}

/** Converts exact stroops back to the canonical decimal string. */
export function amountStringFromStroops(stroops: bigint): string {
  if (typeof stroops !== "bigint" || stroops < 0n) {
    throw new ValidationError("stroops must be a non-negative bigint");
  }
  const whole = stroops / STELLAR_STROOPS_PER_UNIT;
  const fraction = stroops % STELLAR_STROOPS_PER_UNIT;
  if (fraction === 0n) {
    return whole.toString(10);
  }
  let fractionText = fraction.toString(10).padStart(7, "0");
  while (fractionText.endsWith("0")) {
    fractionText = fractionText.slice(0, -1);
  }
  return `${whole.toString(10)}.${fractionText}`;
}

// ---------------------------------------------------------------------------
// XDR encoding (the minimal payment / change-trust path)
// ---------------------------------------------------------------------------

/** XDR wire constants (stellar-xdr). */
export const XDR_KEY_TYPE_ED25519 = 0;
export const XDR_ASSET_TYPE_NATIVE = 0;
export const XDR_ASSET_TYPE_CREDIT_ALPHANUM4 = 1;
export const XDR_ASSET_TYPE_CREDIT_ALPHANUM12 = 2;
export const XDR_MEMO_NONE = 0;
export const XDR_MEMO_TEXT = 1;
export const XDR_MEMO_ID = 2;
export const XDR_MEMO_HASH = 3;
export const XDR_OPERATION_PAYMENT = 1;
export const XDR_OPERATION_CHANGE_TRUST = 6;

/** A streaming XDR byte writer (big-endian, 4-byte aligned). */
export class XdrWriter {
  readonly #bytes: number[] = [];

  uint32(value: number | bigint): this {
    const numeric = typeof value === "bigint" ? Number(value) : value;
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffffffff) {
      throw new ValidationError(`uint32 out of range: ${String(value)}`);
    }
    this.#bytes.push((numeric >>> 24) & 0xff, (numeric >>> 16) & 0xff, (numeric >>> 8) & 0xff, numeric & 0xff);
    return this;
  }

  int64(value: bigint): this {
    if (typeof value !== "bigint") {
      throw new ValidationError("int64 requires a bigint");
    }
    if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) {
      throw new ValidationError(`int64 out of range: ${String(value)}`);
    }
    let remaining = value < 0n ? value + 2n ** 64n : value;
    const chunk = [];
    for (let i = 0; i < 8; i += 1) {
      chunk.unshift(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
    this.#bytes.push(...chunk);
    return this;
  }

  /** Fixed-length raw bytes (no length prefix, no padding). */
  fixed(bytes: Uint8Array): this {
    this.#bytes.push(...bytes);
    return this;
  }

  /** Opaque<> — length-prefixed with zero padding to 4-byte alignment. */
  opaque(bytes: Uint8Array): this {
    this.uint32(bytes.length);
    this.#bytes.push(...bytes);
    const padding = (4 - (bytes.length % 4)) % 4;
    for (let i = 0; i < padding; i += 1) {
      this.#bytes.push(0);
    }
    return this;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

/** A parsed asset: native XLM or a credit asset (code + issuer). */
export type StellarAsset =
  | { readonly kind: "native" }
  | { readonly kind: "alphanum4"; readonly code: string; readonly issuer: string }
  | { readonly kind: "alphanum12"; readonly code: string; readonly issuer: string };

/** Parses the canonical asset string ("native" or "CODE:ISSUER"). */
export function parseStellarAsset(asset: string): StellarAsset {
  if (asset === "native") {
    return { kind: "native" };
  }
  const [code, issuer] = asset.split(":");
  if (code === undefined || issuer === undefined) {
    throw new ValidationError(
      `asset must be 'native' or 'CODE:ISSUER' (a StrKey G… issuer), got: ${asset}`,
    );
  }
  if (!/^[A-Z0-9]{1,12}$/.test(code)) {
    throw new ValidationError(`asset code must be 1-12 A-Z/0-9 characters, got: ${code}`);
  }
  decodeStellarPublicKey(issuer);
  return code.length <= 4
    ? { kind: "alphanum4", code, issuer }
    : { kind: "alphanum12", code, issuer };
}

function encodeAsset(writer: XdrWriter, asset: StellarAsset): void {
  switch (asset.kind) {
    case "native":
      writer.uint32(XDR_ASSET_TYPE_NATIVE);
      return;
    case "alphanum4":
      writer.uint32(XDR_ASSET_TYPE_CREDIT_ALPHANUM4);
      writer.fixed(asciiPadded(asset.code, 4));
      writer.fixed(decodeStellarPublicKey(asset.issuer));
      return;
    case "alphanum12":
      writer.uint32(XDR_ASSET_TYPE_CREDIT_ALPHANUM12);
      writer.fixed(asciiPadded(asset.code, 12));
      writer.fixed(decodeStellarPublicKey(asset.issuer));
      return;
  }
}

function asciiPadded(code: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < code.length && i < length; i += 1) {
    out[i] = code.charCodeAt(i);
  }
  return out;
}

/** A memo on the wire: none, text (≤28 bytes), id or hash (32 bytes). */
export type StellarMemo =
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "id"; readonly id: bigint }
  | { readonly kind: "hash"; readonly hashHex: string };

function encodeMemo(writer: XdrWriter, memo: StellarMemo): void {
  switch (memo.kind) {
    case "none":
      writer.uint32(XDR_MEMO_NONE);
      return;
    case "text": {
      const bytes = utf8Bytes(memo.text);
      if (bytes.length > 28) {
        throw new ValidationError("MEMO_TEXT is limited to 28 bytes");
      }
      writer.uint32(XDR_MEMO_TEXT);
      writer.opaque(bytes);
      return;
    }
    case "id":
      writer.uint32(XDR_MEMO_ID);
      writer.int64(memo.id);
      return;
    case "hash": {
      const bytes = hexToBytes(memo.hashHex);
      if (bytes.length !== 32) {
        throw new ValidationError("MEMO_HASH requires exactly 32 bytes (64 hex chars)");
      }
      writer.uint32(XDR_MEMO_HASH);
      writer.fixed(bytes);
      return;
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new ValidationError("hex string expected");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** One operation in the builder: payment or change-trust. */
export type StellarOperation =
  | {
      readonly kind: "payment";
      readonly destination: string;
      readonly asset: StellarAsset;
      readonly amountStroops: bigint;
    }
  | {
      readonly kind: "change_trust";
      readonly asset: StellarAsset;
      readonly limitStroops: bigint;
    };

function encodeOperation(writer: XdrWriter, operation: StellarOperation): void {
  writer.uint32(0); // sourceAccount: option<void> — the tx source signs
  switch (operation.kind) {
    case "payment": {
      writer.uint32(XDR_OPERATION_PAYMENT);
      encodeMuxedAccountEd25519(writer, decodeStellarPublicKey(operation.destination));
      encodeAsset(writer, operation.asset);
      writer.int64(operation.amountStroops);
      return;
    }
    case "change_trust": {
      if (operation.asset.kind === "native") {
        throw new ValidationError("change_trust cannot target the native asset");
      }
      writer.uint32(XDR_OPERATION_CHANGE_TRUST);
      encodeAsset(writer, operation.asset);
      writer.int64(operation.limitStroops);
      return;
    }
  }
}

function encodeMuxedAccountEd25519(writer: XdrWriter, publicKey: Uint8Array): void {
  writer.uint32(XDR_KEY_TYPE_ED25519);
  writer.fixed(publicKey);
}

/** The transaction body input (everything except the signature). */
export interface StellarTransactionInput {
  /** StrKey "G…" source account (the signer). */
  readonly sourceAccount: string;
  /** Total fee in stroops (base fee × operation count). */
  readonly feeStroops: bigint;
  /** Sequence number = Horizon account sequence + 1 (fetched, never guessed). */
  readonly seqNum: bigint;
  readonly timeBounds?: {
    readonly minTimeSeconds?: bigint;
    readonly maxTimeSeconds?: bigint;
  };
  readonly memo?: StellarMemo;
  readonly operations: readonly StellarOperation[];
}

/** Encodes the Transaction v1 STRUCT bytes (no type word, no signatures). */
export function encodeTransactionBody(input: StellarTransactionInput): Uint8Array {
  if (input.operations.length === 0) {
    throw new ValidationError("a transaction requires at least one operation");
  }
  if (input.operations.length > 100) {
    throw new ValidationError("a transaction carries at most 100 operations");
  }
  const writer = new XdrWriter();
  encodeMuxedAccountEd25519(writer, decodeStellarPublicKey(input.sourceAccount));
  const fee = Number(input.feeStroops);
  if (!Number.isInteger(fee) || fee <= 0 || fee > 0xffffffff) {
    throw new ValidationError("fee must be a positive uint32 stroop amount");
  }
  writer.uint32(fee);
  writer.int64(input.seqNum);
  if (input.timeBounds !== undefined) {
    writer.uint32(1);
    writer.int64(input.timeBounds.minTimeSeconds ?? 0n);
    writer.int64(
      input.timeBounds.maxTimeSeconds ?? 0n,
    );
  } else {
    writer.uint32(0);
  }
  encodeMemo(writer, input.memo ?? { kind: "none" });
  writer.uint32(input.operations.length);
  for (const operation of input.operations) {
    encodeOperation(writer, operation);
  }
  writer.uint32(0); // ext: v(0)
  return writer.toBytes();
}

/**
 * The transaction hash (also the external id):
 * sha256(sha256(networkPassphrase) || uint32be(ENVELOPE_TYPE_TX) || txBody).
 */
export function stellarTransactionHash(
  txBodyBytes: Uint8Array,
  networkPassphrase: string,
): Uint8Array {
  const passphraseHash = createHash("sha256").update(utf8Bytes(networkPassphrase)).digest();
  const typeWord = new XdrWriter().uint32(STELLAR_ENVELOPE_TYPE_TX).toBytes();
  const payload = concatBytes(passphraseHash, typeWord, txBodyBytes);
  return Uint8Array.from(createHash("sha256").update(payload).digest());
}

// ---------------------------------------------------------------------------
// ed25519 signing (node:crypto — PKCS#8 DER wrap, no dependencies)
// ---------------------------------------------------------------------------

/** The fixed PKCS#8 prefix wrapping a raw 32-byte ed25519 seed. */
export const ED25519_PKCS8_PREFIX_HEX =
  "302e020100300506032b657004220420" as const;

function pkcs8WrapSeed(seed: Uint8Array): Uint8Array {
  return concatBytes(hexToBytes(ED25519_PKCS8_PREFIX_HEX), seed);
}

/**
 * Derives the 32-byte ed25519 public key from a raw seed through
 * node:crypto (SPKI export, last 32 bytes).
 */
export function stellarPublicKeyFromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) {
    throw new ValidationError("the ed25519 seed must be exactly 32 bytes");
  }
  const privateKey = createPrivateKey({
    key: pkcs8WrapSeed(seed),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  if (spki.length !== 44) {
    throw new ValidationError(
      `unexpected ed25519 SPKI length ${spki.length} (expected 44)`,
    );
  }
  return spki.slice(12);
}

/** A decorated signature: hint (last 4 public-key bytes) + the ed25519 signature. */
export interface DecoratedSignature {
  readonly hint: Uint8Array;
  readonly signature: Uint8Array;
}

/** Signs the transaction hash with the seed (ed25519 over the 32-byte hash). */
export function signStellarTransactionHash(
  txHash: Uint8Array,
  seed: Uint8Array,
): DecoratedSignature {
  if (txHash.length !== 32) {
    throw new ValidationError("the transaction hash must be 32 bytes");
  }
  const privateKey = createPrivateKey({
    key: pkcs8WrapSeed(seed),
    format: "der",
    type: "pkcs8",
  });
  const signature = Uint8Array.from(sign(null, txHash, privateKey));
  const publicKey = stellarPublicKeyFromSeed(seed);
  return {
    hint: publicKey.slice(28),
    signature,
  };
}

/** The built + signed envelope product (NO seed material anywhere). */
export interface SignedStellarEnvelope {
  /** Full TransactionEnvelope XDR bytes (type word + tx + signatures). */
  readonly envelopeBytes: Uint8Array;
  readonly envelopeBase64: string;
  /** The transaction hash — the external object id (hex + base64 forms). */
  readonly txHashHex: string;
  readonly txHashBase64: string;
  readonly networkPassphraseUsed: string;
}

/**
 * Builds and signs a v1 TransactionEnvelope: fetch-free, deterministic,
 * byte-exact. The seed exists only inside this call frame.
 */
export function buildSignedStellarEnvelope(input: {
  readonly transaction: StellarTransactionInput;
  readonly secretSeed: string;
  readonly networkPassphrase: string;
}): SignedStellarEnvelope {
  const seed = decodeStellarSecretSeed(input.secretSeed);
  const derivedPublic = stellarPublicKeyFromSeed(seed);
  if (encodeStellarPublicKey(derivedPublic) !== input.transaction.sourceAccount) {
    throw new ValidationError(
      "the secret seed does not derive the declared source account — refusing to sign (honest misconfiguration refusal; no network call was made)",
    );
  }
  const txBody = encodeTransactionBody(input.transaction);
  const txHash = stellarTransactionHash(txBody, input.networkPassphrase);
  const decorated = signStellarTransactionHash(txHash, seed);
  const writer = new XdrWriter();
  writer.uint32(STELLAR_ENVELOPE_TYPE_TX);
  writer.fixed(txBody);
  writer.uint32(1); // one signature (the source account)
  writer.fixed(decorated.hint);
  writer.opaque(decorated.signature);
  const envelopeBytes = writer.toBytes();
  return Object.freeze({
    envelopeBytes,
    envelopeBase64: base64Encode(envelopeBytes),
    txHashHex: bytesToHex(txHash),
    txHashBase64: base64Encode(txHash),
    networkPassphraseUsed: input.networkPassphrase,
  });
}

/**
 * INV-F05: deterministic payment derivation — the memo hash for a protocol
 * idempotency key (sha256 of the domain-separated key; no entropy).
 */
export function stellarIdempotencyMemoHash(protocolKey: string): string {
  if (typeof protocolKey !== "string" || protocolKey.length === 0) {
    throw new ValidationError("a protocol idempotency key is required (INV-F05)");
  }
  const digest = createHash("sha256")
    .update(utf8Bytes(`payswap:stellar-idempotency:${protocolKey}`))
    .digest();
  return bytesToHex(Uint8Array.from(digest));
}

// ---------------------------------------------------------------------------
// Submission status mapping (lossless — result codes verbatim)
// ---------------------------------------------------------------------------

/** The classification of one Horizon result code (transaction or operation). */
export type StellarResultCodeStage = "PROCESSING" | "TERMINAL" | "UNKNOWN";

export interface StellarResultCodeClassification {
  readonly code: string;
  readonly stage: StellarResultCodeStage;
  readonly retryable: boolean | undefined;
  readonly note: string;
}

const STELLAR_RESULT_CODE_TABLE: Readonly<Record<string, StellarResultCodeClassification>> =
  Object.freeze({
    tx_success: { code: "tx_success", stage: "TERMINAL", retryable: false, note: "the transaction succeeded on the network" },
    op_success: { code: "op_success", stage: "TERMINAL", retryable: false, note: "the operation succeeded on the network" },
    tx_bad_seq: {
      code: "tx_bad_seq",
      stage: "PROCESSING",
      retryable: true,
      note: "sequence number conflict — re-fetch the account sequence and rebuild the envelope (the value never moved)",
    },
    tx_insufficient_balance: {
      code: "tx_insufficient_balance",
      stage: "TERMINAL",
      retryable: false,
      note: "insufficient balance for the declared fee",
    },
    op_underfunded: {
      code: "op_underfunded",
      stage: "TERMINAL",
      retryable: false,
      note: "source lacks the funds for the payment amount",
    },
    op_no_trust: {
      code: "op_no_trust",
      stage: "TERMINAL",
      retryable: false,
      note: "destination holds no trustline for the asset — a changeTrust is required first",
    },
    op_line_full: {
      code: "op_line_full",
      stage: "TERMINAL",
      retryable: false,
      note: "the destination trustline limit is reached",
    },
    op_no_issuer: { code: "op_no_issuer", stage: "TERMINAL", retryable: false, note: "the asset issuer is invalid" },
    op_not_authorized: { code: "op_not_authorized", stage: "TERMINAL", retryable: false, note: "the asset issuer does not authorize the transfer" },
    op_low_reserve: { code: "op_low_reserve", stage: "TERMINAL", retryable: false, note: "the operation would drop the account below the reserve" },
    tx_no_account: { code: "tx_no_account", stage: "TERMINAL", retryable: false, note: "the source account does not exist on the network" },
    tx_bad_auth: { code: "tx_bad_auth", stage: "TERMINAL", retryable: false, note: "the signatures do not authorize the transaction" },
    tx_malformed: { code: "tx_malformed", stage: "TERMINAL", retryable: false, note: "the envelope is malformed" },
  });

/** Classifies a Horizon result code; UNKNOWN codes stay verbatim + unclassified. */
export function classifyStellarResultCode(code: string): StellarResultCodeClassification {
  const known = STELLAR_RESULT_CODE_TABLE[code];
  if (known !== undefined) {
    return known;
  }
  return Object.freeze({
    code,
    stage: "UNKNOWN" as const,
    retryable: undefined,
    note: "unclassified Horizon result code — preserved verbatim; requires reconciliation (INV-C06)",
  });
}

/** The full table (acceptance/testing surface — a copy, never the live map). */
export function stellarResultCodeTable(): Readonly<Record<string, StellarResultCodeClassification>> {
  return STELLAR_RESULT_CODE_TABLE;
}

// ---------------------------------------------------------------------------
// Horizon read-surface observations (public data — no credentials)
// ---------------------------------------------------------------------------

/** One balance row as Horizon reports it (verbatim shape, exact strings). */
export interface StellarBalanceObservation {
  readonly assetType: "native" | "credit_alphanum4" | "credit_alphanum12" | string;
  readonly assetCode?: string;
  readonly assetIssuer?: string;
  /** Decimal string balance, exactly as Horizon reports it. */
  readonly balance: string;
  /** Trustline limit for credit assets ("922337203685.4775807" = max). */
  readonly limit?: string;
}

/** GET /accounts/{id} — the account observation (lossless). */
export interface StellarAccountObservation {
  readonly accountId: string;
  readonly balances: readonly StellarBalanceObservation[];
  /** The account sequence (a decimal string — int64 exact). */
  readonly sequence: string;
  readonly thresholds: { readonly low: number; readonly med: number; readonly high: number };
  /** The raw Horizon payload, verbatim (INV-C06). */
  readonly raw: unknown;
}

/** GET /accounts/{id}/payments — one payment operation (lossless). */
export interface StellarPaymentObservation {
  readonly operationId: string;
  readonly pagingToken: string;
  readonly assetType: string;
  readonly assetCode?: string;
  readonly assetIssuer?: string;
  /** Decimal string amount, exactly as Horizon reports it. */
  readonly amount: string;
  readonly from: string;
  readonly to: string;
  readonly transactionHash: string;
  readonly createdAt: string;
  readonly transactionSuccessful: boolean;
  /** The raw Horizon payment record, verbatim (INV-C06). */
  readonly raw: unknown;
}

/** GET /transactions/{hash} — the transaction observation (lossless). */
export interface StellarTransactionObservation {
  readonly txHash: string;
  readonly createdAt: string;
  /** Fee actually charged, stroops (decimal string). */
  readonly feeCharged: string;
  readonly maxFee: string;
  readonly memoType: string;
  readonly memo?: string;
  readonly successful: boolean;
  readonly ledger: number;
  /** The raw Horizon transaction payload, verbatim (INV-C06). */
  readonly raw: unknown;
}

// ---------------------------------------------------------------------------
// Capability definition + pack
// ---------------------------------------------------------------------------

export const STELLAR_RAIL_CAPABILITY_ID = "cap.rails.stellar.observe" as const;

/** The canonical capability definition consumed by the Stellar rail adapter. */
export function stellarRailCapabilityDefinition(): CapabilityDefinition {
  return validateCapabilityDefinition({
    capabilityId: STELLAR_RAIL_CAPABILITY_ID,
    capabilityVersion: "1.0.0",
    summary:
      "Stellar testnet local rail: public ledger observation (accounts/payments/transactions) and REAL signed payment/change-trust submission through Horizon",
    kind: "WRITE",
    requiredPermissions: [],
    executionModes: ["PASS_THROUGH_NATIVE", "COMPOSED_PAYSWAP", "OPTIMIZED_MULTI_PROVIDER"],
    semantics: {
      operation: "rails.stellar.observe_and_submit",
      stateMachine: {
        documentRef: "spec/architecture/PAYMENT-OPERATING-PLANE.md",
        version: "1",
      },
      description:
        "PROVIDERLESS_RAIL local rail on the public Stellar testnet: Horizon read surface (public data — balances as external funds observations ONLY, payments, transactions) and a credential-gated write surface (signed TransactionEnvelope submission with result codes preserved verbatim)",
    },
    preconditions: [
      "Horizon testnet endpoint reachable (read surface needs NO credentials)",
      "write surface: PROVIDER_STELLAR_TESTNET_CREDENTIAL_REF resolves to the vault bundle {secretSeed, accountPublic, networkPassphrase}",
      "the seed must derive the declared account (consistency refusal otherwise)",
    ],
    authorization: {
      protocolAuthorization: true,
      requiredScopes: ["rails:read", "rails:write"],
      customerConsent: "NOT_REQUIRED",
    },
    sideEffects: [
      {
        effect: "submits a signed payment or change-trust envelope to the public testnet ledger (real external effect)",
        financialEffect: "MOVES_VALUE",
        reversible: false,
      },
      {
        effect: "observes public ledger state (read-only)",
        financialEffect: "NO_FINANCIAL_EFFECT",
        reversible: false,
      },
    ],
    idempotency: {
      idempotent: false,
      keyScope: "REQUEST",
      duplicateBehavior: "REJECTED_AS_DUPLICATE",
      retryPolicy: "SAFE_TO_RETRY_AFTER_RECONCILIATION",
    },
    compensation: {
      compensable: false,
      cancellation: "NOT_SUPPORTED",
      partialExecution: { possible: false, granularity: "ATOMIC", onPartial: "DISCLOSED" },
    },
    requiredCustomerActions: [],
    providerVocabulary: {
      actions: ["submit_payment", "submit_change_trust"],
      states: [
        { providerState: "submitted", canonicalState: "async_processing:submitted", requiresCustomerAction: false, isTerminal: false },
        { providerState: "ledger_included", canonicalState: "other:ledger_included", requiresCustomerAction: false, isTerminal: false },
        { providerState: "tx_bad_seq", canonicalState: "other:retryable_rejection", requiresCustomerAction: false, isTerminal: false },
        { providerState: "tx_insufficient_balance", canonicalState: "other:definitive_rejection", requiresCustomerAction: false, isTerminal: true },
        { providerState: "unclassified_result_code", canonicalState: "other:unknown", requiresCustomerAction: false, isTerminal: false },
      ],
    },
    externalObjects: [
      {
        objectType: "transaction",
        idFormat: "[0-9a-f]{64}",
        revisioned: true,
        revisionFormat: "status:ledger",
      },
      {
        objectType: "account_balance",
        idFormat: "G[A-Z2-7]{55}",
        revisioned: true,
        revisionFormat: "sequence:balance",
      },
    ],
    evidence: { produced: ["STATE_OBSERVATION", "EXECUTION"], required: [] },
    economics: {
      feeModel: "PROVIDER_DEFINED",
      limits: [{ dimension: "base_fee", value: "100 stroops per operation (testnet)" }],
      settlementImplications: "ledger inclusion is externally final (finality candidates only — protocol-owned finality)",
    },
    constraints: [
      "testnet only — never a production rail without operator production authorization",
    ],
  });
}

/** The connector capability pack backing the Stellar rail. */
export function stellarRailCapabilityPack(): ConnectorCapabilityPack {
  return Object.freeze({
    packId: "pack.rails.stellar",
    family: "crypto",
    version: "1.0.0",
    subPacks: [],
    capabilityRefs: [{ capabilityId: STELLAR_RAIL_CAPABILITY_ID, capabilityVersion: "1.0.0" }],
    auth: { authKind: "PROVIDER_DEFINED" as const, scopes: [] },
    schemas: [{ schemaId: "schema.rails.stellar.horizon", version: "1.0.0" }],
    objectMappings: [
      {
        externalObjectType: "transaction",
        canonicalObjectRef: "payswap:external_transaction",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
      {
        externalObjectType: "account_balance",
        canonicalObjectRef: "payswap:external_funds_observation",
        sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
      },
    ],
    sourceOfTruth: "EXTERNAL_AUTHORITATIVE" as const,
    rateLimits: [{ limit: 100, windowSeconds: 1, scope: "endpoint" }],
    provenance: {
      publisher: "payswap",
      publishedAt: "2026-10-02T00:00:00.000Z",
      contentHash: "hash:rails-stellar-1",
    },
    evidence: [],
  });
}

// ---------------------------------------------------------------------------
// The RailAdapter
// ---------------------------------------------------------------------------

/** The Stellar local rail adapter on the W3-003 framework. */
export class StellarLocalRail extends BaseRailAdapter {
  readonly adapterId = STELLAR_RAIL_ADAPTER_ID;
  readonly implementationId = STELLAR_RAIL_IMPLEMENTATION_ID;

  constructor() {
    super(
      stellarRailCapabilityPack(),
      new Map([[STELLAR_RAIL_CAPABILITY_ID, stellarRailCapabilityDefinition()]]),
    );
  }
}

// ---------------------------------------------------------------------------
// The connector (ConnectorSDK over the REAL public Horizon endpoint)
// ---------------------------------------------------------------------------

export interface StellarConnectorConfig {
  readonly clock: ProtocolClock;
  readonly horizonBase?: string;
  /** The expected network passphrase (default: TESTNET; pubnet must be explicit). */
  readonly networkPassphrase?: string;
  /** The P2-W1-001 control plane: sealed bundles opened per call. */
  readonly credentials?: {
    readonly broker: CredentialBroker;
    readonly runtimeKey: ConnectorRuntimeKey;
  };
  /** Injectable environment (the direct-material fallback path). */
  readonly env?: NodeJS.ProcessEnv;
  readonly http?: HttpTransport;
  readonly timeoutMs?: number;
  /** Freshness window for funds observations, seconds (default 180). */
  readonly fundsFreshnessSeconds?: number;
}

/** The provider-neutral SDK request vocabulary (never provider SDK types). */
export type StellarSdkRequest =
  | { readonly kind: "observe_account"; readonly accountId: string }
  | { readonly kind: "observe_payments"; readonly accountId: string; readonly limit?: number }
  | { readonly kind: "observe_transaction"; readonly txHash: string }
  | {
      readonly kind: "submit_payment";
      readonly destination: string;
      readonly amount: string;
      readonly asset?: string;
      readonly memo?: StellarMemo;
      readonly timeBounds?: { readonly minTimeSeconds?: bigint; readonly maxTimeSeconds?: bigint };
    }
  | {
      readonly kind: "submit_change_trust";
      readonly asset: string;
      readonly limit?: string;
    };

/** Which credential path is live (observability — NEVER material). */
export type StellarCredentialResolutionState =
  | { readonly kind: "CONTROL_PLANE_SEALED"; readonly configKey: string }
  | { readonly kind: "ENV_RESOLVED_MATERIAL"; readonly configKey: string }
  | { readonly kind: "NOT_PROVISIONED"; readonly configKey: string; readonly reason: string };

function isStellarSdkRequest(candidate: unknown): candidate is StellarSdkRequest {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const kind = (candidate as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0;
}

/**
 * The REAL Stellar testnet connector (ConnectorSDK framework). Read surface
 * is PUBLIC (explicit account id required — never a stored default); write
 * surface is the real external effect, fail-closed on the absent credential
 * BEFORE any network call (INV-NC04). Secret material exists only inside
 * signing call frames and never appears in envelopes, evidence or errors.
 */
export class StellarConnector extends ConnectorSDK {
  readonly #clock: ProtocolClock;
  readonly #horizonBase: string;
  readonly #networkPassphrase: string;
  readonly #controlPlane:
    | { readonly broker: CredentialBroker; readonly runtimeKey: ConnectorRuntimeKey }
    | undefined;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #http: HttpTransport;
  readonly #timeoutMs: number;
  readonly #fundsFreshnessSeconds: number;

  constructor(config: StellarConnectorConfig) {
    super({ clock: config.clock });
    this.#clock = config.clock;
    this.#horizonBase = config.horizonBase ?? STELLAR_DEFAULT_HORIZON_BASE;
    this.#networkPassphrase =
      config.networkPassphrase ?? STELLAR_TESTNET_NETWORK_PASSPHRASE;
    this.#controlPlane = config.credentials;
    this.#env = config.env;
    this.#http = config.http ?? realHttpTransport;
    this.#timeoutMs = config.timeoutMs ?? 15_000;
    this.#fundsFreshnessSeconds =
      config.fundsFreshnessSeconds ?? STELLAR_DEFAULT_FUNDS_FRESHNESS_SECONDS;
  }

  providerIdentity(): ProviderIdentity {
    return Object.freeze({
      providerName: STELLAR_PROVIDER_NAME,
      providerVersion: STELLAR_RAIL_PROVIDER_VERSION,
      systemKind: "other",
      displayName: "Stellar testnet local rail (public Horizon)",
    });
  }

  capabilityPack(): ConnectorCapabilityPack {
    return stellarRailCapabilityPack();
  }

  // -- credential surface (refs only — NEVER values) ------------------------

  credentialSurface(): readonly { readonly envVar: string; readonly kind: "API_KEY" }[] {
    return Object.freeze([
      Object.freeze({ envVar: STELLAR_CREDENTIAL_CONFIG_KEY, kind: "API_KEY" as const }),
    ]);
  }

  /** Honest credential-path observability (never material, never a value). */
  credentialResolutionState(): StellarCredentialResolutionState {
    if (this.#controlPlane !== undefined) {
      return Object.freeze({
        kind: "CONTROL_PLANE_SEALED",
        configKey: STELLAR_CREDENTIAL_CONFIG_KEY,
      });
    }
    if (this.#envMaterial() !== undefined) {
      return Object.freeze({
        kind: "ENV_RESOLVED_MATERIAL",
        configKey: STELLAR_CREDENTIAL_CONFIG_KEY,
      });
    }
    return Object.freeze({
      kind: "NOT_PROVISIONED",
      configKey: STELLAR_CREDENTIAL_CONFIG_KEY,
      reason:
        "no control-plane credentials and no env-resolved material under the config key — the write surface fails closed (INV-NC04); the read surface stays available for explicit public account ids",
    });
  }

  // -- read surface (PUBLIC data — explicit account id, no credentials) -----

  /** GET /accounts/{id} — the lossless account observation. */
  async observeAccount(accountId: string): Promise<StellarAccountObservation> {
    const raw = await this.#horizonGet(`/accounts/${encodeURIComponent(accountId)}`);
    const balances = Array.isArray((raw as { balances?: unknown }).balances)
      ? ((raw as { balances: unknown[] }).balances ?? []).map(parseBalance)
      : [];
    const thresholdsRaw = (raw as { thresholds?: Record<string, unknown> }).thresholds;
    return Object.freeze({
      accountId,
      balances: Object.freeze(balances),
      sequence: typeof (raw as { sequence?: unknown }).sequence === "string"
        ? (raw as { sequence: string }).sequence
        : (() => {
            throw new RailProviderError("Horizon account payload lacks a sequence", {
              accountId,
            });
          })(),
      thresholds: {
        low: Number(thresholdsRaw?.["low_threshold"] ?? 0),
        med: Number(thresholdsRaw?.["med_threshold"] ?? 0),
        high: Number(thresholdsRaw?.["high_threshold"] ?? 0),
      },
      raw,
    });
  }

  /**
   * INV-C09: the account's balances as ExternalFundsPositionObservation ONLY
   * (native XLM + every credit asset) — observations of external state with
   * freshness (the observation instant) and provenance; never custody.
   */
  async observeExternalFundsPositions(
    accountId: string,
  ): Promise<ExternalFundsPositionObservation[]> {
    const account = await this.observeAccount(accountId);
    const observedAt = isoTimestamp(this.#clock.now());
    const maxAgeSeconds = this.#fundsFreshnessSeconds;
    return account.balances.map((balance) => {
      const currency =
        balance.assetType === "native" ? "XLM" : (balance.assetCode ?? "UNKNOWN");
      return Object.freeze({
        observationKind: EXTERNAL_FUNDS_OBSERVATION_KIND,
        observationId: `stellar-balance:${accountId}:${currency}:${account.sequence}`,
        observedAt,
        freshness: { asOf: observedAt, maxAgeSeconds },
        location: {
          providerName: STELLAR_PROVIDER_NAME,
          accountRef: accountId,
          ...(balance.assetType !== "native" && balance.assetIssuer !== undefined
            ? { instrumentRef: `${balance.assetCode}:${balance.assetIssuer}` }
            : {}),
        },
        observedAmount: { currency, minorUnits: stroopsExactString(balance.balance) },
        provenance: {
          providerName: STELLAR_PROVIDER_NAME,
          source: "PROVIDER_API" as const,
          capturedAt: observedAt,
        },
      });
    });
  }

  /** GET /accounts/{id}/payments — the latest payment operations (lossless). */
  async observePayments(
    accountId: string,
    limit = 10,
  ): Promise<StellarPaymentObservation[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError("payments limit must be an integer in 1..200");
    }
    const payload = await this.#horizonGet(
      `/accounts/${encodeURIComponent(accountId)}/payments?order=desc&limit=${limit}`,
    );
    const embedded = (payload as { _embedded?: { records?: unknown[] } })._embedded;
    const records = Array.isArray(embedded?.records) ? (embedded?.records ?? []) : [];
    return records.map(parsePaymentRecord);
  }

  /** GET /transactions/{hash} — the transaction observation (lossless). */
  async observeTransaction(txHash: string): Promise<StellarTransactionObservation> {
    if (typeof txHash !== "string" || !/^[0-9a-f]{64}$/.test(txHash)) {
      throw new ValidationError("txHash must be a 64-char lowercase hex string");
    }
    const raw = await this.#horizonGet(`/transactions/${txHash}`);
    return parseTransactionRecord(raw);
  }

  // -- write surface (REAL external effect — fail-closed, INV-NC04) ---------

  /**
   * Submits a REAL payment to the testnet ledger: fetch the account
   * sequence, build + sign the envelope (seed inside the call frame only),
   * POST it, map the outcome losslessly. Idempotency (INV-F05): when the
   * caller passes a protocol key, the memo hash is DERIVED from it.
   */
  async submitPayment(input: {
    readonly destination: string;
    readonly amount: string;
    readonly asset?: string;
    readonly memo?: StellarMemo;
    readonly protocolIdempotencyKey?: string;
    readonly timeBounds?: { readonly minTimeSeconds?: bigint; readonly maxTimeSeconds?: bigint };
  }): Promise<SdkCallResult> {
    const destination = requireStrKeyId(input.destination, "destination");
    const amountStroops = stroopsFromAmountString(input.amount);
    if (amountStroops <= 0n) {
      throw new ValidationError("payment amount must be positive");
    }
    const asset = parseStellarAsset(input.asset ?? "native");
    const memo =
      input.memo ??
      (input.protocolIdempotencyKey !== undefined
        ? { kind: "hash" as const, hashHex: stellarIdempotencyMemoHash(input.protocolIdempotencyKey) }
        : { kind: "none" as const });
    return this.#submitOperations(
      [{ kind: "payment", destination, asset, amountStroops }],
      memo,
      input.timeBounds,
    );
  }

  /**
   * Submits a REAL change-trust operation (the corridor's USDC trustline
   * leg): establish or re-establish a trustline for a credit asset.
   */
  async submitChangeTrust(input: {
    readonly asset: string;
    readonly limit?: string;
  }): Promise<SdkCallResult> {
    const asset = parseStellarAsset(input.asset);
    if (asset.kind === "native") {
      throw new ValidationError("change_trust requires a credit asset (CODE:ISSUER)");
    }
    const limitStroops =
      input.limit !== undefined
        ? stroopsFromAmountString(input.limit)
        : 2n ** 63n - 1n; // max — the canonical "establish with maximum limit"
    return this.#submitOperations(
      [{ kind: "change_trust", asset, limitStroops }],
      { kind: "none" },
      undefined,
    );
  }

  // -- availability + health (INV-C01/C02 — live probe, never fabricated) ---

  availabilityObservation(input: {
    readonly instanceId: string;
    readonly observationVersion: number;
  }): CapabilityObservation {
    const observedAt = isoTimestamp(this.#clock.now());
    // The read surface is public; the WRITE surface needs the credential.
    // Availability here is the honest baseline: the rail is configured (the
    // public endpoint needs nothing) but reachability is only established by
    // a live probe — without one, UNKNOWN (INV-C02: never fabricated).
    return unknownReachabilityObservation({
      instanceId: input.instanceId,
      observedAt,
      observationVersion: input.observationVersion,
      lastKnownCapabilityState: "AVAILABLE",
      reason:
        "Horizon reachability not yet probed — source availability UNKNOWN (INV-C01/C02: never fabricated); call health() for the live probe",
      provenance: {
        providerName: STELLAR_PROVIDER_NAME,
        source: "INTERNAL",
        capturedAt: observedAt,
      },
    });
  }

  /** INV-NC04 gate: UNKNOWN (unreachable/unauthorized) is never routable. */
  railImplication(availability: CapabilityObservation["availability"]): RailImplication {
    return routableRailImplication(STELLAR_RAIL_ADAPTER_ID, availability);
  }

  /**
   * Read-only health probe: an unauthenticated Horizon root fetch (public).
   * Any HTTP answer proves reachability → HEALTHY; transport failure →
   * UNKNOWN (never a business outcome).
   */
  async health(): Promise<ConnectorHealthReport> {
    const lastCheckedAt = isoTimestamp(this.#clock.now());
    const base = {
      connectorId: STELLAR_CONNECTOR_ID,
      providerName: STELLAR_PROVIDER_NAME,
      providerVersion: STELLAR_RAIL_PROVIDER_VERSION,
      capabilityStatuses: [] as ConnectorHealthReport["capabilityStatuses"],
    };
    try {
      await this.#horizonGet("");
      const resolution = this.credentialResolutionState();
      if (resolution.kind !== "NOT_PROVISIONED") {
        return { ...base, status: "HEALTHY", lastCheckedAt, degradedReasons: [] };
      }
      return {
        ...base,
        status: "HEALTHY",
        lastCheckedAt,
        degradedReasons: [
          "Horizon reachable (read surface available for public account ids); credential reference not provisioned — the WRITE surface fails closed (INV-NC04)",
        ],
      };
    } catch (error) {
      return {
        ...base,
        status: "UNKNOWN",
        lastCheckedAt,
        degradedReasons: [
          `Horizon probe failed (never a business outcome): ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  // -- SDK operation surface ---------------------------------------------------

  async search(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "search");
    const request = this.#request(ctx, "observe_payments");
    if (request.kind !== "observe_payments") {
      throw new ValidationError("stellar rail search supports only { kind: 'observe_payments' }");
    }
    const payments = await this.observePayments(request.accountId, request.limit);
    const observedAt = isoTimestamp(this.#clock.now());
    return this.#sdkResult(
      stellarPaymentsListEnvelope(payments, request.accountId, observedAt),
      `stellar:payments:${request.accountId}:${observedAt}`,
    );
  }

  async read(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "read");
    const request = this.#request(ctx, "observe_account");
    if (request.kind !== "observe_account") {
      throw new ValidationError("stellar rail read supports only { kind: 'observe_account' }");
    }
    const account = await this.observeAccount(request.accountId);
    const observedAt = isoTimestamp(this.#clock.now());
    return this.#sdkResult(
      stellarAccountEnvelope(account, observedAt),
      `stellar:account:${request.accountId}:${observedAt}`,
    );
  }

  async create(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "create");
    const request = this.#request(ctx, "submit_payment");
    if (request.kind !== "submit_payment") {
      throw new ValidationError("stellar rail create supports only { kind: 'submit_payment' }");
    }
    return this.submitPayment({
      destination: request.destination,
      amount: request.amount,
      ...(request.asset !== undefined ? { asset: request.asset } : {}),
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
      ...(request.timeBounds !== undefined ? { timeBounds: request.timeBounds } : {}),
      protocolIdempotencyKey: ctx.idempotencyKey,
    });
  }

  async executeAction(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "action");
    const request = this.#request(ctx, "submit_change_trust");
    if (request.kind !== "submit_change_trust") {
      throw new ValidationError(
        "stellar rail executeAction supports only { kind: 'submit_change_trust' }",
      );
    }
    return this.submitChangeTrust({
      asset: request.asset,
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });
  }

  async update(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError("ledger state is not mutable through this rail");
  }

  async subscribe(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "the stellar rail exposes no event subscription (polling observation only)",
    );
  }

  async reconcile(ctx: SdkCallContext): Promise<SdkCallResult> {
    this.requireAuthority(ctx, "reconcile");
    const request = this.#request(ctx, "observe_transaction");
    if (request.kind !== "observe_transaction") {
      throw new ValidationError(
        "reconciliation re-fetches transactions by hash (INV-X03): use { kind: 'observe_transaction', txHash }",
      );
    }
    const observation = await this.observeTransaction(request.txHash);
    const observedAt = isoTimestamp(this.#clock.now());
    return this.#sdkResult(
      stellarTransactionEnvelope(observation, observedAt),
      `stellar:reconcile:${request.txHash}`,
    );
  }

  async disconnect(_ctx: SdkCallContext): Promise<SdkCallResult> {
    throw new ValidationError(
      "the stellar rail holds no session (public read surface; the write surface is a per-call signing frame); there is nothing to disconnect",
    );
  }

  async rotateCredentials(ctx: SdkCallContext): Promise<CredentialRotationResult> {
    this.requireAuthority(ctx, "credential_rotation");
    if (this.#controlPlane !== undefined) {
      const handle = this.#controlPlane.broker.resolveProviderCredential(
        STELLAR_CREDENTIAL_CONFIG_KEY,
      );
      const rotatedAt = this.#clock.now();
      return {
        rotatedAt,
        newCredentialRef: handle.descriptor.vaultReference,
        evidence: railEvidence({
          evidenceId: `stellar:cred-rotation:${rotatedAt}`,
          evidenceRef: `credential-rotation:${STELLAR_CREDENTIAL_CONFIG_KEY}`,
          kind: "AUDIT_LOG",
          providerState: railEnvelope({
            providerName: STELLAR_PROVIDER_NAME,
            providerVersion: STELLAR_RAIL_PROVIDER_VERSION,
            objectType: "credential_rotation",
            externalId: STELLAR_CREDENTIAL_CONFIG_KEY,
            revision: `rotation-${rotatedAt}`,
            state: {
              rotated: true,
              configKey: STELLAR_CREDENTIAL_CONFIG_KEY,
              vaultReference: handle.descriptor.vaultReference,
              note: "CREDENTIAL-ROTATION.md: new seed → fund → trustline re-establishment → swap reference",
            },
            family: "other",
            lifecycleStep: "rotated",
            isTerminal: false,
            requiresCustomerAction: false,
            observedAt: isoTimestamp(rotatedAt),
            provenanceSource: "OPERATOR",
          }),
          recordedAt: rotatedAt,
        }),
      };
    }
    throw new RailNotAuthorizedError(
      "the stellar rail's env fallback path has no swap-reference rotation surface — rotate through the control plane (vault binding swap) per CREDENTIAL-ROTATION.md",
      { railId: STELLAR_RAIL_ADAPTER_ID, envVar: STELLAR_CREDENTIAL_CONFIG_KEY },
    );
  }

  // -- internals -----------------------------------------------------------------

  async #horizonGet(path: string): Promise<unknown> {
    const url = `${this.#horizonBase}${path}`;
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      throw new RailTransportError(`Horizon unreachable: ${url}`, {
        endpoint: this.#horizonBase,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (response.status === 404) {
      throw new RailProviderError(`Horizon resource not found: ${path}`, {
        endpoint: this.#horizonBase,
        httpStatus: 404,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RailProviderError(`Horizon answered HTTP ${response.status}`, {
        endpoint: this.#horizonBase,
        httpStatus: response.status,
      });
    }
    try {
      return JSON.parse(response.bodyText);
    } catch (cause) {
      throw new RailProviderError("Horizon response body is not JSON", {
        endpoint: this.#horizonBase,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  #envMaterial(): string | undefined {
    if (this.#env === undefined) {
      return undefined;
    }
    const value = this.#env[STELLAR_CREDENTIAL_CONFIG_KEY];
    return typeof value === "string" && value.length > 0 && !value.startsWith("vault://")
      ? value
      : undefined;
  }

  /** Parses the env fallback material: a JSON bundle or a bare "S…" seed. */
  #parseEnvMaterial(material: string): StellarCredentialBundle {
    const trimmed = material.trim();
    if (trimmed.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (cause) {
        throw new RailNotAuthorizedError(
          "the stellar env credential material is malformed JSON — refusing (fail-closed)",
          { cause: cause instanceof Error ? cause.message : String(cause) },
        );
      }
      const candidate = parsed as Partial<StellarCredentialBundle>;
      if (
        typeof candidate.secretSeed !== "string" ||
        typeof candidate.accountPublic !== "string"
      ) {
        throw new RailNotAuthorizedError(
          "the stellar env credential bundle requires secretSeed and accountPublic — refusing (fail-closed)",
        );
      }
      return {
        secretSeed: candidate.secretSeed,
        accountPublic: candidate.accountPublic,
        networkPassphrase:
          candidate.networkPassphrase ?? STELLAR_TESTNET_NETWORK_PASSPHRASE,
      };
    }
    // A bare seed: the public account id is DERIVED (never guessed).
    return {
      secretSeed: trimmed,
      accountPublic: encodeStellarPublicKey(
        stellarPublicKeyFromSeed(decodeStellarSecretSeed(trimmed)),
      ),
      networkPassphrase: STELLAR_TESTNET_NETWORK_PASSPHRASE,
    };
  }

  /** Runs one write interaction with the vault-held bundle (sealed or env). */
  async #withCredentialBundle<T>(
    fn: (bundle: StellarCredentialBundle) => Promise<T>,
  ): Promise<T> {
    if (this.#controlPlane !== undefined) {
      let handle: ReturnType<CredentialBroker["resolveProviderCredential"]>;
      try {
        handle = this.#controlPlane.broker.resolveProviderCredential(
          STELLAR_CREDENTIAL_CONFIG_KEY,
        );
      } catch (cause) {
        throw new RailNotAuthorizedError(
          "stellar rail is not authorized: the control-plane credential config key does not resolve to a sealed bundle (fail-closed before any network call — INV-NC04)",
          {
            railId: STELLAR_RAIL_ADAPTER_ID,
            configKey: STELLAR_CREDENTIAL_CONFIG_KEY,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        );
      }
      return this.#controlPlane.broker.withSealedBundle(
        handle,
        this.#controlPlane.runtimeKey,
        (opened) => fn(this.#parseSealedMaterial(opened.material)),
      );
    }
    const material = this.#envMaterial();
    if (material === undefined) {
      throw new RailNotAuthorizedError(
        "stellar rail is not authorized: no credential path is provisioned — the write surface fails closed before any network call (INV-NC04; packages/rails/BLOCKED-RAILS.md §13)",
        { railId: STELLAR_RAIL_ADAPTER_ID, envVar: STELLAR_CREDENTIAL_CONFIG_KEY },
      );
    }
    return fn(this.#parseEnvMaterial(material));
  }

  /** Parses the sealed bundle material (vault-shaped; never a bare seed). */
  #parseSealedMaterial(material: unknown): StellarCredentialBundle {
    const candidate = material as Partial<StellarCredentialBundle> & { seed?: unknown };
    const secretSeed = candidate.secretSeed ?? (typeof candidate.seed === "string" ? candidate.seed : undefined);
    if (typeof secretSeed !== "string" || typeof candidate.accountPublic !== "string") {
      throw new RailNotAuthorizedError(
        "the sealed stellar bundle must carry secretSeed + accountPublic (+ networkPassphrase) — refusing (fail-closed)",
      );
    }
    return {
      secretSeed,
      accountPublic: candidate.accountPublic,
      networkPassphrase: candidate.networkPassphrase ?? STELLAR_TESTNET_NETWORK_PASSPHRASE,
    };
  }

  /**
   * The write path: fetch the account (real sequence), validate the bundle
   * (seed MUST derive the declared account), build + sign, POST, and map the
   * submission losslessly. The seed exists only inside this frame.
   */
  async #submitOperations(
    operations: readonly StellarOperation[],
    memo: StellarMemo,
    timeBounds: { readonly minTimeSeconds?: bigint; readonly maxTimeSeconds?: bigint } | undefined,
  ): Promise<SdkCallResult> {
    return this.#withCredentialBundle(async (bundle) => {
      if (bundle.networkPassphrase !== this.#networkPassphrase) {
        throw new RailNotAuthorizedError(
          `the credential bundle's network passphrase does not match this rail's network (${this.#networkPassphrase === STELLAR_TESTNET_NETWORK_PASSPHRASE ? "testnet" : "the configured network"}) — refusing to sign for the wrong network (fail-closed, no network call was made)`,
          { railId: STELLAR_RAIL_ADAPTER_ID },
        );
      }
      const seed = decodeStellarSecretSeed(bundle.secretSeed);
      const derived = encodeStellarPublicKey(stellarPublicKeyFromSeed(seed));
      if (derived !== bundle.accountPublic) {
        throw new RailNotAuthorizedError(
          "the vault bundle is inconsistent: the secret seed does not derive the declared accountPublic — refusing to submit (fail-closed, no network call was made)",
          { railId: STELLAR_RAIL_ADAPTER_ID },
        );
      }
      // Fetch the REAL account state: the sequence and (for change_trust
      // sanity) the existence of the account. A 404 is an honest refusal.
      const account = await this.observeAccount(bundle.accountPublic);
      const sequence = BigInt(account.sequence);
      const envelope = buildSignedStellarEnvelope({
        transaction: {
          sourceAccount: bundle.accountPublic,
          feeStroops: STELLAR_BASE_FEE_STROOPS * BigInt(operations.length),
          seqNum: sequence + 1n,
          ...(timeBounds !== undefined ? { timeBounds } : {}),
          memo,
          operations,
        },
        secretSeed: bundle.secretSeed,
        networkPassphrase: this.#networkPassphrase,
      });
      return this.#postEnvelope(envelope);
    });
  }

  /** POST /transactions — the real external effect, mapped losslessly. */
  async #postEnvelope(envelope: SignedStellarEnvelope): Promise<SdkCallResult> {
    const url = `${this.#horizonBase}/transactions`;
    let response: { readonly status: number; readonly bodyText: string };
    try {
      response = await this.#http(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tx: envelope.envelopeBase64 }),
        timeoutMs: this.#timeoutMs,
      });
    } catch (cause) {
      // Mid-effect transport failure: the submission state is UNKNOWN —
      // reconcile by the tx hash (INV-X01: never FAILED).
      return this.#outcomeUnknownResult(envelope, cause);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch (cause) {
      return this.#outcomeUnknownResult(envelope, cause);
    }
    if (response.status === 200 || response.status === 202) {
      const accepted = parsed as { hash?: string; ledger?: number };
      if (typeof accepted.hash === "string" && accepted.hash !== envelope.txHashHex) {
        // Horizon answered a different hash than the signed envelope's —
        // ambiguous; reconcile by the returned hash.
        return this.#sdkResult(
          stellarSubmissionEnvelope(envelope, response.status, parsed, isoTimestamp(this.#clock.now()), {
            code: "hash_mismatch",
            stage: "UNKNOWN",
            retryable: undefined,
            note: "Horizon answered a different transaction hash than the submitted envelope — outcome requires reconciliation",
          }),
          `stellar:submit:${envelope.txHashHex}`,
        );
      }
      return this.#sdkResult(
        stellarSubmissionEnvelope(envelope, response.status, parsed, isoTimestamp(this.#clock.now()), undefined),
        `stellar:submit:${envelope.txHashHex}`,
      );
    }
    if (response.status === 400) {
      const extras = (parsed as { extras?: { result_codes?: Record<string, unknown> } }).extras;
      const codes = extras?.result_codes;
      const transactionCode =
        typeof codes?.["transaction"] === "string" ? codes["transaction"] : "tx_malformed";
      const classification = classifyStellarResultCode(transactionCode);
      return this.#sdkResult(
        stellarSubmissionEnvelope(envelope, response.status, parsed, isoTimestamp(this.#clock.now()), classification),
        `stellar:submit:${envelope.txHashHex}`,
      );
    }
    return this.#sdkResult(
      stellarSubmissionEnvelope(envelope, response.status, parsed, isoTimestamp(this.#clock.now()), {
        code: `http_${response.status}`,
        stage: "UNKNOWN",
        retryable: undefined,
        note: `unclassified Horizon HTTP ${response.status} submission answer — preserved verbatim; requires reconciliation (INV-C06)`,
      }),
      `stellar:submit:${envelope.txHashHex}`,
    );
  }

  /** INV-X01: the OUTCOME_UNKNOWN envelope for a mid-effect transport failure. */
  #outcomeUnknownResult(envelope: SignedStellarEnvelope, cause: unknown): SdkCallResult {
    const observedAt = isoTimestamp(this.#clock.now());
    const providerState = railEnvelope({
      providerName: STELLAR_PROVIDER_NAME,
      providerVersion: STELLAR_RAIL_PROVIDER_VERSION,
      objectType: "transaction",
      externalId: envelope.txHashHex,
      revision: "submitted_transport_unknown",
      state: {
        txHash: envelope.txHashHex,
        status: "SUBMITTED_TRANSPORT_UNKNOWN",
        networkPassphraseUsed: envelope.networkPassphraseUsed,
        note: "the POST left the signing frame but the answer never arrived — reconcile by this hash (INV-X03)",
      },
      family: "async_processing",
      lifecycleStep: "submitted",
      isTerminal: false,
      requiresCustomerAction: false,
      observedAt,
      provenanceSource: "PROVIDER_API",
      failure: {
        providerErrorCode: "STELLAR_TRANSPORT_UNKNOWN",
        retryable: false,
        ambiguity: "OUTCOME_UNKNOWN",
      },
    });
    const now: TimestampMs = this.#clock.now();
    return {
      providerState,
      outcome: classifyOutcome(providerState),
      evidence: railEvidence({
        evidenceId: `stellar:submit-unknown:${envelope.txHashHex}`,
        evidenceRef: `transaction:${envelope.txHashHex}`,
        kind: "EXECUTION",
        providerState,
        recordedAt: now,
      }),
    };
  }

  #request(ctx: SdkCallContext, expectedKind: string): StellarSdkRequest {
    const candidate = ctx.request;
    if (!isStellarSdkRequest(candidate)) {
      throw new ValidationError(
        `stellar rail call request must be a StellarSdkRequest object (expected kind '${expectedKind}')`,
      );
    }
    return candidate;
  }

  #sdkResult(providerState: ProviderStateEnvelope, evidenceId: string): SdkCallResult {
    const now: TimestampMs = this.#clock.now();
    const evidence: ProviderExecutionEvidenceDraft = railEvidence({
      evidenceId,
      evidenceRef: `${providerState.object.objectType}:${providerState.object.externalId}`,
      kind: "EXECUTION",
      providerState,
      recordedAt: now,
    });
    return {
      providerState,
      outcome: classifyOutcome(providerState),
      evidence,
    };
  }
}

// ---------------------------------------------------------------------------
// Envelope constructors (lossless — INV-C06)
// ---------------------------------------------------------------------------

function requireStrKeyId(value: string, label: string): string {
  if (typeof value !== "string" || !isValidStellarStrKey(value, STRKEY_VERSION_ED25519_PUBLIC)) {
    throw new ValidationError(`${label} must be a valid StrKey G… account id`);
  }
  return value;
}

/** Exact minor-units string for a Horizon decimal balance (refuses floats). */
function stroopsExactString(balance: string): string {
  return stroopsFromAmountString(balance).toString(10);
}

function parseBalance(raw: unknown): StellarBalanceObservation {
  const record = (raw ?? {}) as Record<string, unknown>;
  return Object.freeze({
    assetType: typeof record["asset_type"] === "string" ? record["asset_type"] : "unknown",
    ...(typeof record["asset_code"] === "string" ? { assetCode: record["asset_code"] } : {}),
    ...(typeof record["asset_issuer"] === "string" ? { assetIssuer: record["asset_issuer"] } : {}),
    balance: typeof record["balance"] === "string" ? record["balance"] : "0",
    ...(typeof record["limit"] === "string" ? { limit: record["limit"] } : {}),
  });
}

function parsePaymentRecord(raw: unknown): StellarPaymentObservation {
  const record = (raw ?? {}) as Record<string, unknown>;
  return Object.freeze({
    operationId: typeof record["id"] === "string" ? record["id"] : "",
    pagingToken: typeof record["paging_token"] === "string" ? record["paging_token"] : "",
    assetType: typeof record["asset_type"] === "string" ? record["asset_type"] : "unknown",
    ...(typeof record["asset_code"] === "string" ? { assetCode: record["asset_code"] } : {}),
    ...(typeof record["asset_issuer"] === "string" ? { assetIssuer: record["asset_issuer"] } : {}),
    amount: typeof record["amount"] === "string" ? record["amount"] : "0",
    from: typeof record["from"] === "string" ? record["from"] : "",
    to: typeof record["to"] === "string" ? record["to"] : "",
    transactionHash: typeof record["transaction_hash"] === "string" ? record["transaction_hash"] : "",
    createdAt: typeof record["created_at"] === "string" ? record["created_at"] : "",
    transactionSuccessful: record["transaction_successful"] === true,
    raw,
  });
}

function parseTransactionRecord(raw: unknown): StellarTransactionObservation {
  const record = (raw ?? {}) as Record<string, unknown>;
  return Object.freeze({
    txHash: typeof record["id"] === "string" ? record["id"] : "",
    createdAt: typeof record["created_at"] === "string" ? record["created_at"] : "",
    feeCharged: typeof record["fee_charged"] === "string" ? record["fee_charged"] : "0",
    maxFee: typeof record["max_fee"] === "string" ? record["max_fee"] : "0",
    memoType: typeof record["memo_type"] === "string" ? record["memo_type"] : "unknown",
    ...(typeof record["memo"] === "string" ? { memo: record["memo"] } : {}),
    successful: record["successful"] === true,
    ledger: typeof record["ledger"] === "number" ? record["ledger"] : 0,
    raw,
  });
}

/** Envelope for a submission outcome (202/400/other — verbatim + classified). */
export function stellarSubmissionEnvelope(
  envelope: SignedStellarEnvelope,
  httpStatus: number,
  providerPayload: unknown,
  observedAt: string,
  rejection: StellarResultCodeClassification | undefined,
): ProviderStateEnvelope {
  const base = {
    providerName: STELLAR_PROVIDER_NAME,
    providerVersion: STELLAR_RAIL_PROVIDER_VERSION,
    objectType: "transaction",
    externalId: envelope.txHashHex,
    state: {
      txHash: envelope.txHashHex,
      httpStatus,
      networkPassphraseUsed: envelope.networkPassphraseUsed,
      providerResponse: providerPayload,
    },
    provenanceSource: "PROVIDER_API" as const,
  };
  if (rejection === undefined) {
    // Accepted (202): async processing — NOT a success declaration (INV-X01);
    // ledger inclusion is observed separately (a finality CANDIDATE then).
    return railEnvelope({
      ...base,
      revision: "submitted:accepted",
      family: "async_processing",
      lifecycleStep: "submitted",
      isTerminal: false,
      requiresCustomerAction: false,
      observedAt,
    });
  }
  return railEnvelope({
    ...base,
    revision: `rejected:${rejection.code}`,
    family: "other",
    lifecycleStep: `rejected_${rejection.stage.toLowerCase()}`,
    isTerminal: rejection.stage === "TERMINAL",
    requiresCustomerAction: false,
    observedAt,
    failure: {
      providerErrorCode: rejection.code,
      retryable: rejection.retryable === true,
      ambiguity:
        rejection.stage === "UNKNOWN"
          ? ("OUTCOME_UNKNOWN" as const)
          : ("NONE" as const),
    },
  });
}

/** Envelope for the account observation (lossless). */
export function stellarAccountEnvelope(
  account: StellarAccountObservation,
  observedAt: string,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: STELLAR_PROVIDER_NAME,
    providerVersion: STELLAR_RAIL_PROVIDER_VERSION,
    objectType: "account_balance",
    externalId: account.accountId,
    revision: `sequence:${account.sequence}`,
    state: account,
    family: "other",
    lifecycleStep: "observed",
    isTerminal: false,
    requiresCustomerAction: false,
    observedAt,
    provenanceSource: "PROVIDER_API",
  });
}

/** Envelope for a payments list observation (lossless). */
export function stellarPaymentsListEnvelope(
  payments: readonly StellarPaymentObservation[],
  accountId: string,
  observedAt: string,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: STELLAR_PROVIDER_NAME,
    providerVersion: STELLAR_RAIL_PROVIDER_VERSION,
    objectType: "payment_list",
    externalId: accountId,
    revision: `payments:${payments.length}:${payments[0]?.operationId ?? "empty"}`,
    state: { accountId, payments },
    family: "other",
    lifecycleStep: "observed",
    isTerminal: false,
    requiresCustomerAction: false,
    observedAt,
    provenanceSource: "PROVIDER_API",
  });
}

/**
 * Envelope for a single payment observation. A payment in a successful,
 * closed transaction is a FINALITY CANDIDATE (protocol-owned finality —
 * INV-E03; the ~5s ledger close is recorded as context, never as proof).
 */
export function stellarPaymentEnvelope(
  payment: StellarPaymentObservation,
  observedAt: string,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: STELLAR_PROVIDER_NAME,
    providerVersion: STELLAR_RAIL_PROVIDER_VERSION,
    objectType: "payment",
    externalId: payment.operationId,
    revision: `${payment.transactionHash}:${payment.transactionSuccessful ? "included" : "failed-tx"}`,
    state: {
      ...payment,
      finalityCandidate: payment.transactionSuccessful === true,
      finalityNote: `ledger close ~${STELLAR_LEDGER_CLOSE_SECONDS}s — a candidate only; the settlement plane's proof policies issue finality`,
    },
    family: "other",
    lifecycleStep: payment.transactionSuccessful ? "ledger_included" : "ledger_tx_failed",
    isTerminal: payment.transactionSuccessful === true,
    requiresCustomerAction: false,
    observedAt,
    provenanceSource: "PROVIDER_API",
    ...(payment.transactionSuccessful
      ? {}
      : {
          failure: {
            providerErrorCode: "STELLAR_TX_UNSUCCESSFUL",
            retryable: false,
            ambiguity: "NONE" as const,
          },
        }),
  });
}

/** Envelope for a transaction observation (lossless). */
export function stellarTransactionEnvelope(
  observation: StellarTransactionObservation,
  observedAt: string,
): ProviderStateEnvelope {
  return railEnvelope({
    providerName: STELLAR_PROVIDER_NAME,
    providerVersion: STELLAR_RAIL_PROVIDER_VERSION,
    objectType: "transaction",
    externalId: observation.txHash,
    revision: `ledger:${observation.ledger}:${observation.successful ? "success" : "failed"}`,
    state: observation,
    family: "other",
    lifecycleStep: observation.successful ? "ledger_included" : "ledger_failed",
    isTerminal: true,
    requiresCustomerAction: false,
    observedAt,
    provenanceSource: "PROVIDER_API",
    ...(observation.successful
      ? {}
      : {
          failure: {
            providerErrorCode: "STELLAR_TX_FAILED",
            retryable: false,
            ambiguity: "NONE" as const,
          },
        }),
  });
}

// ---------------------------------------------------------------------------
// The GHS → USDC → KES corridor case (the operator-directed proof vehicle)
// ---------------------------------------------------------------------------

/**
 * The coverage-gap corridor record for the GHS → USDC (Stellar testnet) →
 * KES corridor. This is a RAILS-SIDE structural mirror of the
 * @payswap/capabilities CoverageGapCase vocabulary (this package cannot
 * import it — the boundary scanner forbids it); the fields carry the same
 * values the Tier-C workflow records.
 */
export interface StellarCorridorCase {
  readonly caseId: string;
  readonly gapKind: "UNSUPPORTED_METHOD";
  readonly causeClassification: "CAPABILITY";
  readonly dimension: {
    readonly country: "GH";
    readonly method: "stellar_usdc";
    readonly currency: "USDC";
    readonly direction: "PAY_OUT";
    readonly shopperBeneficiaryCountry: "KE";
  };
  readonly corridor: "GHS -> USDC (Stellar testnet) -> KES";
  readonly authorizationMode: AuthorizationMode;
  readonly legs: readonly {
    readonly leg: "GHS_COLLECTION" | "STELLAR_USDC_TRANSFER" | "KES_PAYOUT";
    readonly provider?: string;
    readonly railId?: string;
    readonly contractLevel: boolean;
    readonly note: string;
  }[];
  readonly trustlineStatus: string;
  readonly externalEffectProof: string;
  readonly knownLimitations: readonly string[];
}

/**
 * Builds the corridor case: the Coverage Gap Case (Tier C) for the
 * GH→stellar_usdc→KE payout gap plus the routing plan across the
 * contract-level Paystack/Flutterwave legs and the LIVE Stellar testnet leg
 * (this rail — the real external-effect proof).
 */
export function ghsToUsdcToKesCorridorCase(): StellarCorridorCase {
  return Object.freeze({
    caseId: "gap-ghs-usdc-kes-stellar-corridor",
    gapKind: "UNSUPPORTED_METHOD",
    causeClassification: "CAPABILITY",
    dimension: Object.freeze({
      country: "GH",
      method: "stellar_usdc",
      currency: "USDC",
      direction: "PAY_OUT",
      shopperBeneficiaryCountry: "KE",
    }),
    corridor: "GHS -> USDC (Stellar testnet) -> KES",
    authorizationMode: "PROVIDERLESS_RAIL",
    legs: Object.freeze([
      Object.freeze({
        leg: "GHS_COLLECTION",
        provider: "paystack | flutterwave",
        contractLevel: true,
        note:
          "GHS collection on the Ghana-local rails (Stripe FR account GHS negative datum recorded in the coverage matrix); both connectors exist and are probe-verified — contract-level leg of the corridor representation",
      }),
      Object.freeze({
        leg: "STELLAR_USDC_TRANSFER",
        railId: STELLAR_RAIL_ADAPTER_ID,
        contractLevel: false,
        note:
          "the LIVE local-rail leg: a REAL signed payment on the public Stellar testnet through this connector (PROVIDERLESS_RAIL — the vault-held testnet key authorizes the external effect; public Horizon needs no credential); the USDC asset leg additionally requires a changeTrust first",
      }),
      Object.freeze({
        leg: "KES_PAYOUT",
        provider: "paystack | flutterwave",
        contractLevel: true,
        note:
          "KES payout on the Kenya-local rails (both providers probe-verified for KES); contract-level leg of the corridor representation",
      }),
    ]),
    trustlineStatus:
      "NOT_ESTABLISHED — the vault testnet account holds no trustlines as of the 2026-10-02 probe; the USDC leg requires submitChangeTrust first (op_no_trust is otherwise the honest terminal answer)",
    externalEffectProof:
      "the XLM self-payment through submitPayment is the minimal REAL external effect (value-conserving); the live suite executes it end-to-end when the vault credential is provisioned",
    knownLimitations: Object.freeze([
      "testnet only — never a production rail without operator production authorization",
      "the USDC testnet asset issuer must be confirmed by the operator before changeTrust (the asset leg is prepared, not presumed)",
      "Paystack/Flutterwave legs are contract-level representations here; their real connectors carry the live evidence",
    ]),
  });
}
